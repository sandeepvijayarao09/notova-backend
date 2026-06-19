import { beforeEach, describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} from '../src/modules/auth/tokens.js';
import { resetEnvCache } from '../src/config/env.js';

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  delete process.env.ACCESS_TOKEN_TTL;
  delete process.env.REFRESH_TOKEN_TTL_DAYS;
  resetEnvCache();
});

describe('tokens: access JWT', () => {
  it('signs a token whose claims verify back to the original sub/email', async () => {
    const token = await signAccessToken('user-123', 'a@example.com');
    expect(token.split('.')).toHaveLength(3);
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('a@example.com');
    expect(claims.type).toBe('access');
    expect(claims.iss).toBe('notova-backend');
    expect(claims.aud).toBe('notova-app');
  });

  it('uses the HS256 algorithm and sets iat/exp', async () => {
    const token = await signAccessToken('u', 'e@x.com');
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
    expect(header.alg).toBe('HS256');
    const payload = decodeJwt(token);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp ?? 0) > (payload.iat ?? 0)).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken('u', 'e@x.com');
    const parts = token.split('.');
    const payload = parts[1] ?? '';
    const tampered = `${parts[0]}.${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}.${parts[2]}`;
    await expect(verifyAccessToken(tampered)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed under a different secret', async () => {
    const token = await signAccessToken('u', 'e@x.com');
    // Re-load env with a different secret; the old token must fail to verify.
    process.env.JWT_SECRET = 'a-completely-different-secret';
    resetEnvCache();
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('honors expiry: an expired token is rejected', async () => {
    process.env.ACCESS_TOKEN_TTL = '1s';
    resetEnvCache();
    const token = await signAccessToken('u', 'e@x.com');
    // Expired tokens carry a small clock-tolerance; wait it out deterministically.
    await new Promise((r) => setTimeout(r, 1200));
    // jose default clock tolerance is 0, but to be safe under slow CI, retry.
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a non-access token type', async () => {
    // Forge a token with type=refresh using jose directly.
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode('test-jwt-secret');
    const token = await new SignJWT({ email: 'e@x.com', type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u')
      .setIssuer('notova-backend')
      .setAudience('notova-app')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects garbage strings', async () => {
    await expect(verifyAccessToken('not-a-jwt')).rejects.toMatchObject({ status: 401 });
    await expect(verifyAccessToken('a.b.c')).rejects.toMatchObject({ status: 401 });
  });
});

describe('tokens: refresh tokens', () => {
  it('generates an opaque token with a matching SHA-256 hash', () => {
    const { token, hash } = generateRefreshToken();
    expect(token).toBeTruthy();
    expect(token.split('.')).toHaveLength(1); // opaque, not a JWT
    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // hex sha256
  });

  it('hashRefreshToken is deterministic and collision-distinct', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });

  it('generates unique tokens each call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(generateRefreshToken().token);
    expect(seen.size).toBe(50);
  });

  it('refreshTokenExpiry honors REFRESH_TOKEN_TTL_DAYS', () => {
    process.env.REFRESH_TOKEN_TTL_DAYS = '7';
    resetEnvCache();
    const now = new Date('2020-01-01T00:00:00.000Z');
    const exp = refreshTokenExpiry(now);
    const diffDays = (exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });
});
