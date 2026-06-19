import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';
import { badRequest, internal } from '../../lib/errors.js';
import type { OAuthProvider, ProviderId } from './providers/index.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Generate a PKCE code_verifier + S256 code_challenge pair (RFC 7636). */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Opaque CSRF state value. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/** Build the per-provider OAuth callback redirect URI hosted by this backend. */
export function buildRedirectUri(env: Env, provider: ProviderId): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v1/integrations/${provider}/callback`;
}

export interface AuthorizeUrlInput {
  provider: OAuthProvider;
  env: Env;
  state: string;
  redirectUri: string;
  pkce?: PkcePair;
}

/**
 * Build the provider authorize URL. Throws a clear 400 when client credentials
 * are not configured (so dev/test never need real secrets).
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const { provider, env, state, redirectUri, pkce } = input;
  const creds = provider.credentials(env);
  if (!creds) {
    throw badRequest(
      `${provider.label} is not configured on this server. Set ${provider.id.toUpperCase()}_CLIENT_ID and ${provider.id.toUpperCase()}_CLIENT_SECRET to enable it.`
    );
  }

  const url = new URL(provider.authorizeEndpoint(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (provider.scopes.length > 0) {
    url.searchParams.set('scope', provider.scopes.join(' '));
  }
  if (provider.usesPkce && pkce) {
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
  }
  for (const [k, v] of Object.entries(provider.extraAuthorizeParams?.(env) ?? {})) {
    if (v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  tokenType: string | null;
  expiresAt: string | null;
  /** Provider-specific extras to persist as JSON metadata. */
  metadata: Record<string, unknown> | null;
}

export interface ExchangeInput {
  provider: OAuthProvider;
  env: Env;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/**
 * Generic OAuth2 authorization-code token exchange. Performs a live network
 * call to the provider's token endpoint; never invoked in tests. Notion
 * requires HTTP Basic auth; others use client_secret in the body.
 */
export async function exchangeCodeForTokens(input: ExchangeInput): Promise<TokenResponse> {
  const { provider, env, code, redirectUri, codeVerifier } = input;
  const creds = provider.credentials(env);
  if (!creds) {
    throw badRequest(`${provider.label} is not configured on this server.`);
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', redirectUri);
  if (provider.usesPkce) {
    params.set('code_verifier', codeVerifier);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (provider.id === 'notion') {
    // Notion: HTTP Basic auth with client id/secret; PKCE not used.
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set('client_id', creds.clientId);
    params.set('client_secret', creds.clientSecret);
  }

  const res = await fetch(provider.tokenEndpoint(env), {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw internal(`${provider.label} token endpoint returned non-JSON (${res.status})`);
  }

  // Slack returns 200 with { ok: false } on errors.
  if (!res.ok || json.ok === false || typeof json.access_token !== 'string') {
    const message =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.error_description === 'string' && json.error_description) ||
      `status ${res.status}`;
    throw internal(`${provider.label} token exchange failed: ${message}`);
  }

  return normalizeTokenResponse(provider.id, json);
}

function normalizeTokenResponse(
  providerId: ProviderId,
  json: Record<string, unknown>
): TokenResponse {
  const accessToken = json.access_token as string;
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null;
  const scope = typeof json.scope === 'string' ? json.scope : null;
  const tokenType = typeof json.token_type === 'string' ? json.token_type : null;

  let expiresAt: string | null = null;
  if (typeof json.expires_in === 'number') {
    expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  }

  // Capture provider-specific identifiers useful for export targeting.
  const metadata: Record<string, unknown> = {};
  if (providerId === 'notion') {
    if (json.workspace_id) metadata.workspaceId = json.workspace_id;
    if (json.workspace_name) metadata.workspaceName = json.workspace_name;
    if (json.bot_id) metadata.botId = json.bot_id;
  } else if (providerId === 'slack') {
    if (json.team && typeof json.team === 'object') metadata.team = json.team;
    if (json.authed_user) metadata.authedUser = json.authed_user;
  } else if (providerId === 'salesforce') {
    if (json.instance_url) metadata.instanceUrl = json.instance_url;
    if (json.id) metadata.identityUrl = json.id;
  }

  return {
    accessToken,
    refreshToken,
    scope,
    tokenType,
    expiresAt,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}
