import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { integrationConnections, oauthStates } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { integrationExportSchema } from '../../lib/types.js';
import type { AppVariables } from '../../middleware/auth.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { decrypt, encrypt, encryptOptional } from './crypto.js';
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
} from './oauth.js';
import {
  PROVIDER_IDS,
  getProvider,
  isProviderId,
  type ProviderConnection,
} from './providers/index.js';

export const integrationsRoutes = new Hono<{ Variables: AppVariables }>();

// State rows live for 10 minutes.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function requireProviderId(raw: string) {
  if (!isProviderId(raw)) {
    throw notFound(`Unknown integration provider "${raw}"`);
  }
  return raw;
}

/** GET /v1/integrations -> connection status for every known provider. */
integrationsRoutes.get('/', requireAuth, (c) => {
  const { id: userId } = currentUser(c);
  const rows = db()
    .select({ provider: integrationConnections.provider })
    .from(integrationConnections)
    .where(eq(integrationConnections.userId, userId))
    .all();
  const connected = new Set(rows.map((r) => r.provider));
  const result = PROVIDER_IDS.map((provider) => ({
    provider,
    connected: connected.has(provider),
  }));
  return c.json(result, 200);
});

/** GET /v1/integrations/:provider/connect -> authorize URL + state (PKCE stored). */
integrationsRoutes.get('/:provider/connect', requireAuth, (c) => {
  const providerId = requireProviderId(c.req.param('provider'));
  const { id: userId } = currentUser(c);
  const provider = getProvider(providerId);
  const e = env();

  const state = generateState();
  const redirectUri = buildRedirectUri(e, providerId);
  const pkce = provider.usesPkce ? generatePkce() : undefined;

  // buildAuthorizeUrl throws a clear 400 if creds are missing (dev-safe).
  const authorizeUrl = buildAuthorizeUrl({ provider, env: e, state, redirectUri, pkce });

  db()
    .insert(oauthStates)
    .values({
      state,
      userId,
      provider: providerId,
      // Store a non-empty placeholder when PKCE is unused to satisfy NOT NULL.
      codeVerifier: pkce?.verifier ?? '',
      redirectUri,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    })
    .run();

  return c.json({ authorizeUrl, state }, 200);
});

/**
 * GET /v1/integrations/:provider/callback?code&state
 * Public (no Bearer): the provider redirects the browser here. We look the user
 * up from the stored state row, exchange the code, store encrypted tokens, and
 * 302 back into the app via the deep link.
 */
integrationsRoutes.get('/:provider/callback', async (c) => {
  const providerId = requireProviderId(c.req.param('provider'));
  const provider = getProvider(providerId);
  const e = env();

  const code = c.req.query('code');
  const state = c.req.query('state');
  const oauthError = c.req.query('error');

  const appRedirect = (status: string, extra?: Record<string, string>) => {
    const url = new URL(`${e.APP_OAUTH_REDIRECT_SCHEME}/${providerId}`);
    url.searchParams.set('status', status);
    for (const [k, v] of Object.entries(extra ?? {})) url.searchParams.set(k, v);
    return c.redirect(url.toString(), 302);
  };

  if (oauthError) {
    return appRedirect('error', { reason: oauthError });
  }
  if (!code || !state) {
    throw badRequest('Missing code or state in OAuth callback');
  }

  const stateRow = db().select().from(oauthStates).where(eq(oauthStates.state, state)).get();
  if (!stateRow || stateRow.provider !== providerId) {
    throw badRequest('Invalid or unknown OAuth state');
  }
  // One-time use.
  db().delete(oauthStates).where(eq(oauthStates.state, state)).run();
  if (new Date(stateRow.expiresAt).getTime() <= Date.now()) {
    throw badRequest('OAuth state expired; please retry the connection');
  }

  const tokens = await exchangeCodeForTokens({
    provider,
    env: e,
    code,
    redirectUri: stateRow.redirectUri,
    codeVerifier: stateRow.codeVerifier,
  });

  upsertConnection(stateRow.userId, providerId, tokens);

  return appRedirect('connected');
});

/** POST /v1/integrations/:provider/export -> forward to the third party. */
integrationsRoutes.post('/:provider/export', requireAuth, async (c) => {
  const providerId = requireProviderId(c.req.param('provider'));
  const { id: userId } = currentUser(c);
  const provider = getProvider(providerId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const payload = integrationExportSchema.parse(body);

  const row = db()
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.userId, userId),
        eq(integrationConnections.provider, providerId)
      )
    )
    .get();
  if (!row) {
    throw badRequest(`${provider.label} is not connected. Connect it before exporting.`);
  }

  const connection: ProviderConnection = {
    accessToken: decrypt(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : null,
    scope: row.scope,
    tokenType: row.tokenType,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };

  const result = await provider.export(connection, payload, env());
  return c.json(result, 200);
});

/** DELETE /v1/integrations/:provider -> disconnect (drop stored tokens). */
integrationsRoutes.delete('/:provider', requireAuth, (c) => {
  const providerId = requireProviderId(c.req.param('provider'));
  const { id: userId } = currentUser(c);
  db()
    .delete(integrationConnections)
    .where(
      and(
        eq(integrationConnections.userId, userId),
        eq(integrationConnections.provider, providerId)
      )
    )
    .run();
  return c.json({ disconnected: true }, 200);
});

function upsertConnection(
  userId: string,
  providerId: (typeof PROVIDER_IDS)[number],
  tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>
): void {
  const accessTokenEnc = encrypt(tokens.accessToken);
  const refreshTokenEnc = encryptOptional(tokens.refreshToken);
  const metadata = tokens.metadata ? JSON.stringify(tokens.metadata) : null;
  const now = new Date().toISOString();

  const existing = db()
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.userId, userId),
        eq(integrationConnections.provider, providerId)
      )
    )
    .get();

  if (existing) {
    db()
      .update(integrationConnections)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        scope: tokens.scope,
        tokenType: tokens.tokenType,
        expiresAt: tokens.expiresAt,
        metadata,
        updatedAt: now,
      })
      .where(eq(integrationConnections.id, existing.id))
      .run();
  } else {
    db()
      .insert(integrationConnections)
      .values({
        id: randomUUID(),
        userId,
        provider: providerId,
        accessTokenEnc,
        refreshTokenEnc,
        scope: tokens.scope,
        tokenType: tokens.tokenType,
        expiresAt: tokens.expiresAt,
        metadata,
      })
      .run();
  }
}
