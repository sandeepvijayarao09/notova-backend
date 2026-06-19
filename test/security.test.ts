import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { makeTestApp, jsonBody, authHeaders, registerUser, putJson } from './helpers.js';

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

/** Assert the response body matches the uniform error envelope from lib/errors. */
async function expectErrorEnvelope(res: Response): Promise<ErrorEnvelope> {
  const body = (await res.json()) as ErrorEnvelope;
  expect(body).toHaveProperty('error');
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  // Must never leak Node/V8 stack traces.
  const raw = JSON.stringify(body).toLowerCase();
  expect(raw).not.toContain('at object.');
  expect(raw).not.toContain('node_modules');
  expect(raw).not.toContain('.ts:');
  expect(raw).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  return body;
}

describe('security: malformed request bodies', () => {
  it('returns 400 (not a 500 crash) for malformed JSON on register', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json',
    });
    expect(res.status).toBe(400);
    const body = await expectErrorEnvelope(res);
    expect(body.error.code).toBe('bad_request');
  });

  it('returns 400 for malformed JSON on login, refresh, checkout, and PUT recording', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const broken = '}{not json';
    const targets: Array<{ path: string; method: string; auth: boolean }> = [
      { path: '/v1/auth/login', method: 'POST', auth: false },
      { path: '/v1/auth/refresh', method: 'POST', auth: false },
      { path: '/v1/billing/checkout', method: 'POST', auth: true },
      { path: `/v1/sync/recordings/${randomUUID()}`, method: 'PUT', auth: true },
      { path: '/v1/integrations/notion/export', method: 'POST', auth: true },
    ];
    for (const t of targets) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (t.auth) Object.assign(headers, authHeaders(accessToken));
      const res = await request(t.path, { method: t.method, headers, body: broken });
      expect(res.status, `${t.method} ${t.path}`).toBe(400);
      await expectErrorEnvelope(res);
    }
  });

  it('handles a missing body / missing content-type gracefully (no 500)', async () => {
    const { request } = makeTestApp();
    // No content-type, no body.
    const res = await request('/v1/auth/register', { method: 'POST' });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expectErrorEnvelope(res);
  });

  it('accepts a valid body even with extra unexpected fields (zod strips by default)', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/register',
      jsonBody({
        email: 'extra@example.com',
        password: 'good-password-1',
        isAdmin: true,
        role: 'superuser',
        billingTier: 'pro',
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown> };
    // Privilege-escalation fields must be ignored, not reflected/applied.
    expect(body.user).not.toHaveProperty('isAdmin');
    expect(body.user).not.toHaveProperty('role');
    expect(body.user).not.toHaveProperty('billingTier');
  });

  it('rejects a very large oversized string payload with a 4xx (not a crash)', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const hugeTitle = 'x'.repeat(2_000_000); // 2MB title, far above the 500-char limit
    const res = await request(
      `/v1/sync/recordings/${randomUUID()}`,
      putJson({ title: hugeTitle, createdAt: new Date().toISOString(), durationSec: 1, source: 'mic', status: 'ready' }, accessToken)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('security: injection-style strings', () => {
  it('stores and round-trips SQL-injection-style titles safely (Drizzle parameterizes)', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const id = randomUUID();
    const nasty = "Robert'); DROP TABLE recordings;-- 1=1 OR '1'='1";
    const put = await request(
      `/v1/sync/recordings/${id}`,
      putJson(
        { title: nasty, createdAt: new Date().toISOString(), durationSec: 1, source: 'mic', status: 'ready' },
        accessToken
      )
    );
    expect(put.status).toBe(200);
    // The table must still exist and the value stored verbatim.
    const list = await request('/v1/sync/recordings', { headers: authHeaders(accessToken) });
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ id: string; title: string }>;
    expect(items.find((i) => i.id === id)?.title).toBe(nasty);
  });

  it('handles SQL-injection-style email at login without error leakage', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/login',
      jsonBody({ email: "a@b.com' OR '1'='1", password: 'good-password-1' })
    );
    // Invalid email format -> 400 validation; either way no 500 / leakage.
    expect(res.status).toBeLessThan(500);
    await expectErrorEnvelope(res);
  });

  it('an injection-style email cannot return another user\'s account', async () => {
    const { request } = makeTestApp();
    await registerUser(request, { email: 'victim@example.com', password: 'victim-password-1' });
    // Try to log in by smuggling SQL into the email field. The crafted value
    // either fails email-format validation (400) or is treated as a literal
    // unknown email (401) — never a successful login, never another user's row.
    const res = await request(
      '/v1/auth/login',
      jsonBody({ email: "victim@example.com' --", password: 'anything-1234' })
    );
    expect([400, 401]).toContain(res.status);
    expect(res.status).not.toBe(200);
    // And the legitimate credentials still work, proving the table is intact.
    const ok = await request(
      '/v1/auth/login',
      jsonBody({ email: 'victim@example.com', password: 'victim-password-1' })
    );
    expect(ok.status).toBe(200);
  });

  it('emoji/unicode emails that fail format validation are rejected cleanly', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/register',
      jsonBody({ email: '🎉@@not valid', password: 'good-password-1' })
    );
    expect(res.status).toBe(400);
    await expectErrorEnvelope(res);
  });
});

describe('security: error envelope consistency + 404', () => {
  it('uses the same envelope shape for 401, 404, 400, and 409', async () => {
    const { request } = makeTestApp();
    // 401
    await expectErrorEnvelope(await request('/v1/sync/recordings'));
    // 404 (unknown route)
    const notFound = await request('/v1/totally-unknown');
    expect(notFound.status).toBe(404);
    await expectErrorEnvelope(notFound);
    // 400 (validation)
    await expectErrorEnvelope(
      await request('/v1/auth/register', jsonBody({ email: 'x', password: 'y' }))
    );
    // 409 (duplicate)
    const creds = { email: 'envelope@example.com', password: 'good-password-1' };
    await request('/v1/auth/register', jsonBody(creds));
    const dupe = await request('/v1/auth/register', jsonBody(creds));
    expect(dupe.status).toBe(409);
    await expectErrorEnvelope(dupe);
  });

  it('does not leak stack traces or internals on any error path', async () => {
    const { request } = makeTestApp();
    const responses = await Promise.all([
      request('/v1/auth/me'),
      request('/v1/integrations'),
      request('/v1/billing/subscription'),
      request('/v1/sync/recordings'),
      request('/v1/auth/register', jsonBody({})),
    ]);
    for (const res of responses) {
      await expectErrorEnvelope(res);
    }
  });

  it('sets the X-Request-Id response header', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
