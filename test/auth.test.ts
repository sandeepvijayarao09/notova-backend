import { describe, it, expect } from 'vitest';
import { makeTestApp, jsonBody, authHeaders } from './helpers.js';

interface AuthResponse {
  user: { id: string; email: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
}

describe('auth flow', () => {
  it('register -> login -> refresh -> me happy path', async () => {
    const { request } = makeTestApp();
    const email = 'alice@example.com';
    const password = 'sup3r-secret-pw';

    // register
    const regRes = await request('/v1/auth/register', jsonBody({ email, password }));
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as AuthResponse;
    expect(reg.user.email).toBe(email);
    expect(reg.accessToken).toBeTruthy();
    expect(reg.refreshToken).toBeTruthy();

    // login
    const loginRes = await request('/v1/auth/login', jsonBody({ email, password }));
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as AuthResponse;
    expect(login.user.id).toBe(reg.user.id);
    expect(login.accessToken).toBeTruthy();

    // refresh
    const refreshRes = await request(
      '/v1/auth/refresh',
      jsonBody({ refreshToken: login.refreshToken })
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { accessToken: string };
    expect(refreshed.accessToken).toBeTruthy();

    // me (with the refreshed access token)
    const meRes = await request('/v1/auth/me', { headers: authHeaders(refreshed.accessToken) });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { id: string; email: string } };
    expect(me.user.id).toBe(reg.user.id);
    expect(me.user.email).toBe(email);
  });

  it('rejects login with a bad password', async () => {
    const { request } = makeTestApp();
    const email = 'bob@example.com';
    const password = 'correct-horse-battery';

    const regRes = await request('/v1/auth/register', jsonBody({ email, password }));
    expect(regRes.status).toBe(201);

    const badRes = await request('/v1/auth/login', jsonBody({ email, password: 'wrong-password' }));
    expect(badRes.status).toBe(401);
    const body = (await badRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects duplicate registration', async () => {
    const { request } = makeTestApp();
    const creds = { email: 'carol@example.com', password: 'another-good-pw' };
    expect((await request('/v1/auth/register', jsonBody(creds))).status).toBe(201);
    const dupe = await request('/v1/auth/register', jsonBody(creds));
    expect(dupe.status).toBe(409);
  });

  it('rejects /me without a token', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('validates email and password length on register', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/register',
      jsonBody({ email: 'not-an-email', password: 'short' })
    );
    expect(res.status).toBe(400);
  });
});
