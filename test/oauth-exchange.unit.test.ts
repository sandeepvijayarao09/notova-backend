import { afterEach, describe, it, expect, vi } from 'vitest';
import { exchangeCodeForTokens } from '../src/modules/integrations/oauth.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { getProvider } from '../src/modules/integrations/providers/index.js';

/**
 * These tests exercise the OAuth token-exchange and provider export logic with
 * `fetch` STUBBED — no real network, no real credentials. This is the only way
 * to cover the post-callback code path offline.
 */

function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv);
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exchangeCodeForTokens (fetch stubbed)', () => {
  it('throws a 400 when the provider is not configured', async () => {
    const env = envWith(); // no creds
    await expect(
      exchangeCodeForTokens({
        provider: getProvider('google'),
        env,
        code: 'c',
        redirectUri: 'https://api/cb',
        codeVerifier: 'v',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('exchanges a code for tokens and normalizes the response (google + PKCE)', async () => {
    const env = envWith({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      // PKCE verifier must be forwarded, plus client creds in the body.
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=the-code');
      expect(body).toContain('code_verifier=the-verifier');
      expect(body).toContain('client_id=cid');
      expect(body).toContain('client_secret=sec');
      return jsonResponse({
        access_token: 'ya29.access',
        refresh_token: 'refresh-123',
        scope: 'openid email',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await exchangeCodeForTokens({
      provider: getProvider('google'),
      env,
      code: 'the-code',
      redirectUri: 'https://api/cb',
      codeVerifier: 'the-verifier',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens.accessToken).toBe('ya29.access');
    expect(tokens.refreshToken).toBe('refresh-123');
    expect(tokens.scope).toBe('openid email');
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresAt).toBeTruthy();
    expect(new Date(tokens.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses HTTP Basic auth and no PKCE for notion, capturing workspace metadata', async () => {
    const env = envWith({ NOTION_CLIENT_ID: 'ncid', NOTION_CLIENT_SECRET: 'nsec' });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(headers.Authorization.slice(6), 'base64').toString();
      expect(decoded).toBe('ncid:nsec');
      // No PKCE verifier for notion.
      expect(String(init.body)).not.toContain('code_verifier');
      return jsonResponse({
        access_token: 'notion-token',
        workspace_id: 'ws-1',
        workspace_name: 'My WS',
        bot_id: 'bot-1',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await exchangeCodeForTokens({
      provider: getProvider('notion'),
      env,
      code: 'c',
      redirectUri: 'https://api/cb',
      codeVerifier: '',
    });
    expect(tokens.accessToken).toBe('notion-token');
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.metadata).toMatchObject({
      workspaceId: 'ws-1',
      workspaceName: 'My WS',
      botId: 'bot-1',
    });
  });

  it('captures slack team metadata', async () => {
    const env = envWith({ SLACK_CLIENT_ID: 'scid', SLACK_CLIENT_SECRET: 'ssec' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          access_token: 'xoxb-token',
          team: { id: 'T1', name: 'Acme' },
          authed_user: { id: 'U1' },
        })
      )
    );
    const tokens = await exchangeCodeForTokens({
      provider: getProvider('slack'),
      env,
      code: 'c',
      redirectUri: 'https://api/cb',
      codeVerifier: 'v',
    });
    expect(tokens.accessToken).toBe('xoxb-token');
    expect(tokens.metadata).toMatchObject({ team: { id: 'T1', name: 'Acme' }, authedUser: { id: 'U1' } });
  });

  it('captures salesforce instance metadata', async () => {
    const env = envWith({ SALESFORCE_CLIENT_ID: 'sf', SALESFORCE_CLIENT_SECRET: 'sfs' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          access_token: 'sf-token',
          instance_url: 'https://na1.salesforce.com',
          id: 'https://login.salesforce.com/id/00D/005',
        })
      )
    );
    const tokens = await exchangeCodeForTokens({
      provider: getProvider('salesforce'),
      env,
      code: 'c',
      redirectUri: 'https://api/cb',
      codeVerifier: 'v',
    });
    expect(tokens.metadata).toMatchObject({
      instanceUrl: 'https://na1.salesforce.com',
      identityUrl: 'https://login.salesforce.com/id/00D/005',
    });
  });

  it('throws 500 when the token endpoint returns non-JSON', async () => {
    const env = envWith({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 502 }))
    );
    await expect(
      exchangeCodeForTokens({
        provider: getProvider('google'),
        env,
        code: 'c',
        redirectUri: 'https://api/cb',
        codeVerifier: 'v',
      })
    ).rejects.toMatchObject({ status: 500 });
  });

  it('throws 500 when the provider reports an OAuth error (error field)', async () => {
    const env = envWith({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
    );
    await expect(
      exchangeCodeForTokens({
        provider: getProvider('google'),
        env,
        code: 'c',
        redirectUri: 'https://api/cb',
        codeVerifier: 'v',
      })
    ).rejects.toMatchObject({ status: 500 });
  });

  it('throws 500 for slack ok:false even with HTTP 200', async () => {
    const env = envWith({ SLACK_CLIENT_ID: 'scid', SLACK_CLIENT_SECRET: 'ssec' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: 'invalid_code' }))
    );
    await expect(
      exchangeCodeForTokens({
        provider: getProvider('slack'),
        env,
        code: 'c',
        redirectUri: 'https://api/cb',
        codeVerifier: 'v',
      })
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('provider export functions', () => {
  const env = envWith();
  const connection = {
    accessToken: 'tok',
    refreshToken: null,
    scope: null,
    tokenType: null,
    metadata: null as Record<string, unknown> | null,
  };
  const payload = {
    recording: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Note',
      createdAt: new Date().toISOString(),
      durationSec: 1,
      source: 'mic' as const,
      status: 'ready' as const,
    },
    summary: { text: 'sum', bullets: ['a'], actionItems: [{ text: 'do it', done: false }] },
    transcript: { text: 'hello' },
  };

  it('google/slack/salesforce export throw 501 not_implemented', async () => {
    for (const id of ['google', 'slack', 'salesforce'] as const) {
      await expect(getProvider(id).export(connection, payload, env)).rejects.toMatchObject({
        status: 501,
      });
    }
  });

  it('notion export requires a parent (databaseId/pageId) -> 400 when absent', async () => {
    await expect(getProvider('notion').export(connection, payload, env)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('notion export posts a page and returns the external id/url (fetch stubbed)', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.notion.com/v1/pages');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['Notion-Version']).toBeTruthy();
      const body = JSON.parse(String(init.body));
      expect(body.parent).toMatchObject({ type: 'database_id', database_id: 'db-1' });
      // Title + summary + action items + transcript blocks present.
      expect(Array.isArray(body.children)).toBe(true);
      expect(body.children.length).toBeGreaterThan(0);
      return jsonResponse({ id: 'page-123', url: 'https://notion.so/page-123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getProvider('notion').export(
      { ...connection, metadata: { databaseId: 'db-1' } },
      payload,
      env
    );
    expect(result).toEqual({
      externalId: 'page-123',
      url: 'https://notion.so/page-123',
      status: 'exported',
    });
  });

  it('notion export supports a page_id parent and chunks long transcripts', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.parent).toMatchObject({ type: 'page_id', page_id: 'pg-1' });
      return jsonResponse({ id: 'p2', url: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const longPayload = { ...payload, transcript: { text: 'x'.repeat(5000) } };
    const result = await getProvider('notion').export(
      { ...connection, metadata: { pageId: 'pg-1' } },
      longPayload,
      env
    );
    expect(result.externalId).toBe('p2');
    expect(result.url).toBeNull();
  });

  it('notion export surfaces a 500 on a non-OK Notion API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 }))
    );
    await expect(
      getProvider('notion').export({ ...connection, metadata: { databaseId: 'db-1' } }, payload, env)
    ).rejects.toMatchObject({ status: 500 });
  });
});
