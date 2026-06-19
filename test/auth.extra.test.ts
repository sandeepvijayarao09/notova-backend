import { describe, it, expect } from 'vitest';
import { SignJWT, UnsecuredJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { makeTestApp, jsonBody, authHeaders, registerUser } from './helpers.js';
import { users } from '../src/db/schema.js';

/**
 * NOTE ON STATUS CODES: this backend returns HTTP 400 with
 * `{ error: { code: 'validation_error' } }` for Zod validation failures (see
 * src/middleware/error.ts). The task brief refers to these as "422"; in this
 * codebase the equivalent contract is 400 + validation_error, which we assert.
 */

interface AuthResponse {
  user: { id: string; email: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

const secret = () => new TextEncoder().encode('test-jwt-secret');

async function signCustomAccess(
  claims: Record<string, unknown>,
  opts: {
    secret?: Uint8Array;
    issuer?: string;
    audience?: string;
    exp?: string | number;
    sub?: string;
  } = {}
): Promise<string> {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt();
  jwt = jwt.setIssuer(opts.issuer ?? 'notova-backend');
  jwt = jwt.setAudience(opts.audience ?? 'notova-app');
  if (opts.sub) jwt = jwt.setSubject(opts.sub);
  jwt = jwt.setExpirationTime(opts.exp ?? '15m');
  return jwt.sign(opts.secret ?? secret());
}

describe('auth: register', () => {
  it('returns user + tokens and never echoes the password', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/register',
      jsonBody({ email: 'reg@example.com', password: 'strong-password-1' })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AuthResponse;
    expect(body.user.email).toBe('reg@example.com');
    expect(typeof body.user.id).toBe('string');
    expect(body.user.createdAt).toBeTruthy();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    // Password must never appear anywhere in the serialized response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('strong-password-1');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
  });

  it('stores only a hash; login with the raw password still works afterward', async () => {
    const app = makeTestApp();
    const password = 'never-store-me-raw-42';
    const reg = await registerUser(app.request, { email: 'hash@example.com', password });
    const login = await app.request(
      '/v1/auth/login',
      jsonBody({ email: 'hash@example.com', password })
    );
    expect(login.status).toBe(200);
    expect(reg.user.email).toBe('hash@example.com');
  });

  it('verifies the stored password is an argon2 hash (direct DB inspection)', async () => {
    // Build an isolated DB, wire it in, register through the app, then read back.
    const { request } = makeTestApp();
    const password = 'argon-please-1234';
    await registerUser(request, { email: 'inspect@example.com', password });
    // Re-import the live singleton db the app just wrote to.
    const { db: liveDb } = await import('../src/db/client.js');
    const row = liveDb().select().from(users).where(eq(users.email, 'inspect@example.com')).get();
    expect(row).toBeTruthy();
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toBe(password);
    expect(row?.passwordHash).toMatch(/^\$argon2(id|i|d)\$/);
  });

  it('rejects duplicate email with 409 + conflict envelope', async () => {
    const { request } = makeTestApp();
    const creds = { email: 'dupe@example.com', password: 'good-password-1' };
    expect((await request('/v1/auth/register', jsonBody(creds))).status).toBe(201);
    const dupe = await request('/v1/auth/register', jsonBody(creds));
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('conflict');
    expect(typeof body.error.message).toBe('string');
  });

  it('treats email as case-insensitive for duplicates and login', async () => {
    const { request } = makeTestApp();
    const password = 'case-insens-123';
    expect(
      (await request('/v1/auth/register', jsonBody({ email: 'Mixed@Example.com', password })))
        .status
    ).toBe(201);
    // Same email different case -> duplicate.
    const dupe = await request(
      '/v1/auth/register',
      jsonBody({ email: 'mixed@example.com', password })
    );
    expect(dupe.status).toBe(409);
    // Login with a different case succeeds (normalized to lowercase).
    const login = await request('/v1/auth/login', jsonBody({ email: 'MIXED@EXAMPLE.COM', password }));
    expect(login.status).toBe(200);
    const body = (await login.json()) as AuthResponse;
    expect(body.user.email).toBe('mixed@example.com');
  });

  it('rejects an invalid email with 400 validation_error', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/register',
      jsonBody({ email: 'not-an-email', password: 'good-password-1' })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('rejects a too-short / weak password with 400 validation_error', async () => {
    const { request } = makeTestApp();
    for (const pw of ['short', '1234567', '']) {
      const res = await request(
        '/v1/auth/register',
        jsonBody({ email: `pw-${pw.length}@example.com`, password: pw })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe('validation_error');
    }
  });

  it('rejects missing fields with 400 validation_error', async () => {
    const { request } = makeTestApp();
    const cases = [{ password: 'good-password-1' }, { email: 'x@example.com' }, {}];
    for (const c of cases) {
      const res = await request('/v1/auth/register', jsonBody(c));
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe('validation_error');
    }
  });

  it('accepts the maximum allowed password length (256) but rejects 257', async () => {
    const { request } = makeTestApp();
    const ok = await request(
      '/v1/auth/register',
      jsonBody({ email: 'maxpw@example.com', password: 'a'.repeat(256) })
    );
    expect(ok.status).toBe(201);
    const tooLong = await request(
      '/v1/auth/register',
      jsonBody({ email: 'toolongpw@example.com', password: 'a'.repeat(257) })
    );
    expect(tooLong.status).toBe(400);
  });
});

describe('auth: login', () => {
  it('logs in with correct credentials', async () => {
    const { request } = makeTestApp();
    const { email, password } = await registerUser(request);
    const res = await request('/v1/auth/login', jsonBody({ email, password }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthResponse;
    expect(body.user.email).toBe(email);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('rejects wrong password with 401 unauthorized', async () => {
    const { request } = makeTestApp();
    const { email } = await registerUser(request);
    const res = await request('/v1/auth/login', jsonBody({ email, password: 'wrong-password-x' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
    // Must not reveal whether the email exists.
    expect(body.error.message.toLowerCase()).toContain('invalid');
  });

  it('rejects an unknown user with 401 unauthorized (same message as wrong password)', async () => {
    const { request } = makeTestApp();
    const res = await request(
      '/v1/auth/login',
      jsonBody({ email: 'nobody@example.com', password: 'good-password-1' })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message.toLowerCase()).toContain('invalid');
  });

  it('rejects missing fields with 400 validation_error', async () => {
    const { request } = makeTestApp();
    for (const c of [{ email: 'a@b.com' }, { password: 'good-password-1' }, {}]) {
      const res = await request('/v1/auth/login', jsonBody(c));
      expect(res.status).toBe(400);
    }
  });
});

describe('auth: refresh', () => {
  it('exchanges a valid refresh token for a new access token', async () => {
    const { request } = makeTestApp();
    const { refreshToken } = await registerUser(request);
    const res = await request('/v1/auth/refresh', jsonBody({ refreshToken }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(body.accessToken).toBeTruthy();
    // The new access token must actually authenticate /me.
    const me = await request('/v1/auth/me', { headers: authHeaders(body.accessToken) });
    expect(me.status).toBe(200);
  });

  it('rejects garbage / unknown refresh tokens with 401', async () => {
    const { request } = makeTestApp();
    for (const t of ['garbage', 'not.a.token', '']) {
      const res = await request('/v1/auth/refresh', jsonBody({ refreshToken: t }));
      // empty string fails zod (.min(1)) => 400; non-empty unknown => 401.
      expect([400, 401]).toContain(res.status);
      if (res.status === 401) {
        const body = (await res.json()) as ErrorEnvelope;
        expect(body.error.code).toBe('unauthorized');
      }
    }
  });

  it('rejects an ACCESS token presented as a refresh token with 401', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/auth/refresh', jsonBody({ refreshToken: accessToken }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects a missing refreshToken field with 400 validation_error', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/auth/refresh', jsonBody({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects an expired refresh token with 401 (DB-manipulated expiry)', async () => {
    const { request } = makeTestApp();
    const { refreshToken } = await registerUser(request);
    // Backdate the stored refresh token expiry directly in the live DB.
    const { db: liveDb } = await import('../src/db/client.js');
    const { refreshTokens } = await import('../src/db/schema.js');
    liveDb()
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .run();
    const res = await request('/v1/auth/refresh', jsonBody({ refreshToken }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message.toLowerCase()).toContain('expired');
  });

  it('rejects a revoked refresh token with 401 (DB-manipulated revocation)', async () => {
    const { request } = makeTestApp();
    const { refreshToken } = await registerUser(request);
    const { db: liveDb } = await import('../src/db/client.js');
    const { refreshTokens } = await import('../src/db/schema.js');
    liveDb()
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .run();
    const res = await request('/v1/auth/refresh', jsonBody({ refreshToken }));
    expect(res.status).toBe(401);
  });
});

describe('auth: me + token security', () => {
  it('returns the user for a valid Bearer token', async () => {
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);
    const res = await request('/v1/auth/me', { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe(user.email);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/auth/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects malformed Authorization headers with 401', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const headers = [
      { Authorization: 'Bearer' }, // scheme only, no token
      { Authorization: 'Bearer ' }, // empty token
      { Authorization: `Basic ${accessToken}` }, // wrong scheme
      { Authorization: accessToken }, // no scheme
      { Authorization: `Token ${accessToken}` }, // wrong scheme word
    ];
    for (const h of headers) {
      const res = await request('/v1/auth/me', { headers: h as Record<string, string> });
      expect(res.status).toBe(401);
    }
  });

  it('rejects an expired access token with 401', async () => {
    const { request } = makeTestApp();
    const { user } = await registerUser(request);
    const expired = await signCustomAccess(
      { email: user.email, type: 'access' },
      { sub: user.id, exp: Math.floor(Date.now() / 1000) - 60 }
    );
    const res = await request('/v1/auth/me', { headers: authHeaders(expired) });
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const { request } = makeTestApp();
    const { user } = await registerUser(request);
    const forged = await signCustomAccess(
      { email: user.email, type: 'access' },
      { sub: user.id, secret: new TextEncoder().encode('totally-wrong-secret') }
    );
    const res = await request('/v1/auth/me', { headers: authHeaders(forged) });
    expect(res.status).toBe(401);
  });

  it('rejects a tampered token (modified payload byte) with 401', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const parts = accessToken.split('.');
    // Flip a character in the payload segment.
    const payload = parts[1] ?? '';
    const tampered = `${parts[0]}.${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}.${parts[2]}`;
    const res = await request('/v1/auth/me', { headers: authHeaders(tampered) });
    expect(res.status).toBe(401);
  });

  it('rejects a token with the wrong issuer / audience with 401', async () => {
    const { request } = makeTestApp();
    const { user } = await registerUser(request);
    const badIssuer = await signCustomAccess(
      { email: user.email, type: 'access' },
      { sub: user.id, issuer: 'evil-issuer' }
    );
    const badAud = await signCustomAccess(
      { email: user.email, type: 'access' },
      { sub: user.id, audience: 'evil-audience' }
    );
    expect((await request('/v1/auth/me', { headers: authHeaders(badIssuer) })).status).toBe(401);
    expect((await request('/v1/auth/me', { headers: authHeaders(badAud) })).status).toBe(401);
  });

  it('rejects a refresh-typed token used as an access token (type mismatch) with 401', async () => {
    const { request } = makeTestApp();
    const { user } = await registerUser(request);
    const wrongType = await signCustomAccess(
      { email: user.email, type: 'refresh' },
      { sub: user.id }
    );
    const res = await request('/v1/auth/me', { headers: authHeaders(wrongType) });
    expect(res.status).toBe(401);
  });

  it('rejects the JWT alg:none attack with 401', async () => {
    const { request } = makeTestApp();
    const { user } = await registerUser(request);
    const none = new UnsecuredJWT({ email: user.email, type: 'access', sub: user.id })
      .setIssuer('notova-backend')
      .setAudience('notova-app')
      .setIssuedAt()
      .setExpirationTime('15m')
      .encode();
    const res = await request('/v1/auth/me', { headers: authHeaders(none) });
    expect(res.status).toBe(401);
  });
});
