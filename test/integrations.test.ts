import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { makeTestApp, authHeaders, registerUser } from './helpers.js';
import { oauthStates, integrationConnections } from '../src/db/schema.js';

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

interface ProviderStatus {
  provider: string;
  connected: boolean;
}

const PROVIDER_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'NOTION_CLIENT_ID',
  'NOTION_CLIENT_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
];

afterEach(() => {
  // Ensure no provider creds leak between tests.
  for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('integrations: list', () => {
  it('requires auth (401 without a token)', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations');
    expect(res.status).toBe(401);
  });

  it('lists all four providers, all disconnected initially', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations', { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderStatus[];
    expect(body).toHaveLength(4);
    const ids = body.map((p) => p.provider).sort();
    expect(ids).toEqual(['google', 'notion', 'salesforce', 'slack']);
    for (const p of body) expect(p.connected).toBe(false);
  });
});

describe('integrations: connect', () => {
  it('returns 404 for an unknown provider', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/dropbox/connect', {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('not_found');
  });

  it('requires auth', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/google/connect');
    expect(res.status).toBe(401);
  });

  it('returns a dev-safe 400 with a clear message when creds are not configured', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    for (const provider of ['google', 'notion', 'slack', 'salesforce']) {
      const res = await request(`/v1/integrations/${provider}/connect`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe('bad_request');
      expect(body.error.message.toLowerCase()).toContain('not configured');
    }
  });

  it('builds a correct PKCE authorize URL for google when creds are set, and persists state', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);

    const res = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string; state: string };
    expect(body.state).toBeTruthy();

    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(url.searchParams.get('redirect_uri')).toContain('/v1/integrations/google/callback');
    expect(url.searchParams.get('state')).toBe(body.state);
    // PKCE
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Google extra params
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('openid');

    // The state + verifier must be persisted in the DB for the callback.
    const { db: liveDb } = await import('../src/db/client.js');
    const row = liveDb()
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.state, body.state))
      .get();
    expect(row).toBeTruthy();
    expect(row?.userId).toBe(user.id);
    expect(row?.provider).toBe('google');
    expect(row?.codeVerifier).toBeTruthy();
    expect(row?.codeVerifier.length).toBeGreaterThan(10);
    // The persisted verifier must hash (S256) to the challenge in the URL.
    const { createHash } = await import('node:crypto');
    const expectedChallenge = createHash('sha256')
      .update(row?.codeVerifier ?? '')
      .digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
  });

  it('does not include PKCE params for notion (usesPkce=false) and stores empty verifier', async () => {
    process.env.NOTION_CLIENT_ID = 'test-notion-id';
    process.env.NOTION_CLIENT_SECRET = 'test-notion-secret';
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/notion/connect', {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string; state: string };
    const url = new URL(body.authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
    expect(url.searchParams.get('owner')).toBe('user');

    const { db: liveDb } = await import('../src/db/client.js');
    const row = liveDb().select().from(oauthStates).where(eq(oauthStates.state, body.state)).get();
    expect(row?.codeVerifier).toBe('');
  });

  it('targets the configured salesforce login URL', async () => {
    process.env.SALESFORCE_CLIENT_ID = 'sf-id';
    process.env.SALESFORCE_CLIENT_SECRET = 'sf-secret';
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/salesforce/connect', {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string };
    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe(
      'https://login.salesforce.com/services/oauth2/authorize'
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('integrations: callback', () => {
  it('returns 400 for an unknown / missing state', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/google/callback?code=abc&state=does-not-exist');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message.toLowerCase()).toContain('state');
  });

  it('returns 400 when code or state is missing', async () => {
    const { request } = makeTestApp();
    const onlyState = await request('/v1/integrations/google/callback?state=x');
    expect(onlyState.status).toBe(400);
    const onlyCode = await request('/v1/integrations/google/callback?code=x');
    expect(onlyCode.status).toBe(400);
  });

  it('returns 404 for a callback on an unknown provider', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/dropbox/callback?code=a&state=b');
    expect(res.status).toBe(404);
  });

  it('redirects back into the app with status=error when the provider returns an error', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/google/callback?error=access_denied', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('notova://oauth/google')).toBe(true);
    expect(location).toContain('status=error');
    expect(location).toContain('reason=access_denied');
  });

  it('returns 400 for a state whose provider does not match the path', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    // Create a real google state row.
    const connect = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    const { state } = (await connect.json()) as { state: string };
    // Use the google state on the notion callback path -> provider mismatch -> 400.
    const res = await request(`/v1/integrations/notion/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an expired state and consumes it (one-time use)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const connect = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    const { state } = (await connect.json()) as { state: string };
    // Backdate the state expiry.
    const { db: liveDb } = await import('../src/db/client.js');
    liveDb()
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthStates.state, state))
      .run();
    const res = await request(`/v1/integrations/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.message.toLowerCase()).toContain('expired');
    // State row should now be deleted (one-time use), so a retry is "unknown state".
    const retry = await request(`/v1/integrations/google/callback?code=abc&state=${state}`);
    expect(retry.status).toBe(400);
    const retryBody = (await retry.json()) as ErrorEnvelope;
    expect(retryBody.error.message.toLowerCase()).toContain('unknown');
  });

  it('completes the full connect -> callback flow (fetch stubbed) and persists an encrypted connection', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);

    const connect = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    const { state } = (await connect.json()) as { state: string };

    // Stub the provider token endpoint — no real network.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'real-access',
              refresh_token: 'real-refresh',
              scope: 'openid',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    const callback = await request(
      `/v1/integrations/google/callback?code=auth-code&state=${state}`,
      { redirect: 'manual' }
    );
    expect(callback.status).toBe(302);
    const location = callback.headers.get('location') ?? '';
    expect(location.startsWith('notova://oauth/google')).toBe(true);
    expect(location).toContain('status=connected');

    // The connection is stored, and the access token is encrypted at rest.
    const { db: liveDb } = await import('../src/db/client.js');
    const { decrypt } = await import('../src/modules/integrations/crypto.js');
    const row = liveDb()
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.userId, user.id),
          eq(integrationConnections.provider, 'google')
        )
      )
      .get();
    expect(row).toBeTruthy();
    expect(row?.accessTokenEnc).toBeTruthy();
    expect(row?.accessTokenEnc).not.toContain('real-access'); // encrypted, not plaintext
    expect(decrypt(row?.accessTokenEnc as string)).toBe('real-access');
    expect(decrypt(row?.refreshTokenEnc as string)).toBe('real-refresh');

    // The list now shows google connected.
    const list = (await (
      await request('/v1/integrations', { headers: authHeaders(accessToken) })
    ).json()) as ProviderStatus[];
    expect(list.find((p) => p.provider === 'google')?.connected).toBe(true);

    // The state row was consumed (one-time use).
    const stateRow = liveDb().select().from(oauthStates).where(eq(oauthStates.state, state)).get();
    expect(stateRow).toBeUndefined();
  });

  it('re-connecting updates the existing connection row (no duplicate)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);

    const tokenResponse = (access: string) =>
      new Response(
        JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    // First connect.
    let connect = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    let state = ((await connect.json()) as { state: string }).state;
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse('first-access')));
    await request(`/v1/integrations/google/callback?code=a&state=${state}`, { redirect: 'manual' });

    // Second connect (re-auth).
    connect = await request('/v1/integrations/google/connect', {
      headers: authHeaders(accessToken),
    });
    state = ((await connect.json()) as { state: string }).state;
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse('second-access')));
    await request(`/v1/integrations/google/callback?code=b&state=${state}`, { redirect: 'manual' });

    const { db: liveDb } = await import('../src/db/client.js');
    const { decrypt } = await import('../src/modules/integrations/crypto.js');
    const rows = liveDb()
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.userId, user.id),
          eq(integrationConnections.provider, 'google')
        )
      )
      .all();
    expect(rows).toHaveLength(1); // updated, not duplicated
    expect(decrypt(rows[0]?.accessTokenEnc as string)).toBe('second-access');
  });
});

describe('integrations: export', () => {
  const exportPayload = () => ({
    recording: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Export note',
      createdAt: new Date().toISOString(),
      durationSec: 10,
      source: 'mic',
      status: 'ready',
    },
    summary: { text: 'A summary', bullets: ['one', 'two'] },
    transcript: { text: 'Hello world transcript' },
  });

  it('requires auth', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/google/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportPayload()),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown provider', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/dropbox/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify(exportPayload()),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 with a clear message when the provider is not connected', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/notion/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify(exportPayload()),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message.toLowerCase()).toContain('not connected');
  });

  it('returns 400 validation_error for a malformed export payload', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/integrations/notion/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify({ recording: { title: 'x' } }), // missing required fields
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('validation_error');
  });

  it('exports to a connected notion workspace (fetch stubbed end-to-end)', async () => {
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);

    // Seed a connected notion row with a databaseId in metadata.
    const { db: liveDb } = await import('../src/db/client.js');
    const { encrypt } = await import('../src/modules/integrations/crypto.js');
    const { randomUUID } = await import('node:crypto');
    liveDb()
      .insert(integrationConnections)
      .values({
        id: randomUUID(),
        userId: user.id,
        provider: 'notion',
        accessTokenEnc: encrypt('notion-secret-token'),
        refreshTokenEnc: null,
        scope: null,
        tokenType: 'bearer',
        metadata: JSON.stringify({ databaseId: 'db-1' }),
      })
      .run();

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.notion.com/v1/pages');
      // The decrypted token must reach the provider as a Bearer token.
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer notion-secret-token'
      );
      return new Response(JSON.stringify({ id: 'page-9', url: 'https://notion.so/page-9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request('/v1/integrations/notion/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify(exportPayload()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { externalId: string; url: string; status: string };
    expect(body).toEqual({
      externalId: 'page-9',
      url: 'https://notion.so/page-9',
      status: 'exported',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('integrations: disconnect', () => {
  it('requires auth', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/integrations/google', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('returns {disconnected:true} and flips list to connected=false', async () => {
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);

    // Seed a fake connection row directly (no network needed).
    const { db: liveDb } = await import('../src/db/client.js');
    const { encrypt } = await import('../src/modules/integrations/crypto.js');
    const { randomUUID } = await import('node:crypto');
    liveDb()
      .insert(integrationConnections)
      .values({
        id: randomUUID(),
        userId: user.id,
        provider: 'slack',
        accessTokenEnc: encrypt('fake-access-token'),
        refreshTokenEnc: null,
        scope: 'chat:write',
        tokenType: 'bearer',
        expiresAt: null,
        metadata: null,
      })
      .run();

    // List shows slack connected.
    const before = (await (
      await request('/v1/integrations', { headers: authHeaders(accessToken) })
    ).json()) as ProviderStatus[];
    expect(before.find((p) => p.provider === 'slack')?.connected).toBe(true);

    // Disconnect.
    const del = await request('/v1/integrations/slack', {
      method: 'DELETE',
      headers: authHeaders(accessToken),
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as { disconnected: boolean }).toEqual({ disconnected: true });

    // List now shows slack disconnected.
    const after = (await (
      await request('/v1/integrations', { headers: authHeaders(accessToken) })
    ).json()) as ProviderStatus[];
    expect(after.find((p) => p.provider === 'slack')?.connected).toBe(false);
  });

  it('disconnect is idempotent (still 200 when nothing connected) and 404 for unknown provider', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const ok = await request('/v1/integrations/google', {
      method: 'DELETE',
      headers: authHeaders(accessToken),
    });
    expect(ok.status).toBe(200);
    const bad = await request('/v1/integrations/dropbox', {
      method: 'DELETE',
      headers: authHeaders(accessToken),
    });
    expect(bad.status).toBe(404);
  });

  it('isolates connections across users (A connecting does not show for B)', async () => {
    const { request } = makeTestApp();
    const userA = await registerUser(request);
    const userB = await registerUser(request);

    const { db: liveDb } = await import('../src/db/client.js');
    const { encrypt } = await import('../src/modules/integrations/crypto.js');
    const { randomUUID } = await import('node:crypto');
    liveDb()
      .insert(integrationConnections)
      .values({
        id: randomUUID(),
        userId: userA.user.id,
        provider: 'google',
        accessTokenEnc: encrypt('a-token'),
      })
      .run();

    const listB = (await (
      await request('/v1/integrations', { headers: authHeaders(userB.accessToken) })
    ).json()) as ProviderStatus[];
    expect(listB.every((p) => p.connected === false)).toBe(true);
  });
});
