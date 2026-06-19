import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireAuth, currentUser, type AppVariables } from '../src/middleware/auth.js';
import { onError } from '../src/middleware/error.js';
import { signAccessToken } from '../src/modules/auth/tokens.js';
import { resetEnvCache } from '../src/config/env.js';

function makeMiniApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(onError);
  app.get('/protected', requireAuth, (c) => c.json({ user: currentUser(c) }, 200));
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test.local${path}`, init));
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  resetEnvCache();
});

describe('middleware/auth: requireAuth (direct)', () => {
  it('passes a valid token through and populates currentUser', async () => {
    const request = makeMiniApp();
    const token = await signAccessToken('uid-1', 'a@example.com');
    const res = await request('/protected', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user).toEqual({ id: 'uid-1', email: 'a@example.com' });
  });

  it('rejects a missing header (401)', async () => {
    const request = makeMiniApp();
    expect((await request('/protected')).status).toBe(401);
  });

  it('rejects a non-bearer scheme (401)', async () => {
    const request = makeMiniApp();
    const res = await request('/protected', { headers: { Authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
  });

  it('rejects a bearer header with no token (401)', async () => {
    const request = makeMiniApp();
    // NOTE: the fetch/Request layer normalizes (trims) header values, so a
    // "Bearer" with only trailing whitespace collapses to "Bearer" and is
    // rejected by the malformed-header branch. Either way the result is 401.
    const res = await request('/protected', { headers: { Authorization: 'Bearer' } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepts a lowercase "authorization" header name', async () => {
    const request = makeMiniApp();
    const token = await signAccessToken('uid-2', 'b@example.com');
    const res = await request('/protected', { headers: { authorization: `bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it('throws "Missing bearer token" when the scheme is present but the token is empty', async () => {
    // The HTTP layer trims header whitespace, so this branch is only reachable
    // by invoking the middleware directly with a "Bearer " (trailing space) header.
    let thrown: unknown;
    const fakeCtx = {
      req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer ' : undefined) },
      set: () => {},
    } as unknown as Parameters<typeof requireAuth>[0];
    try {
      await requireAuth(fakeCtx, async () => {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ status: 401, message: 'Missing bearer token' });
  });
});
