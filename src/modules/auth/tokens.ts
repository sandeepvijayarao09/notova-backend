import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email: string;
  type: 'access';
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET);
}

/** Sign a short-lived access JWT for a user. */
export async function signAccessToken(userId: string, email: string): Promise<string> {
  const e = env();
  return new SignJWT({ email, type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(e.JWT_ISSUER)
    .setAudience(e.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(e.ACCESS_TOKEN_TTL)
    .sign(secretKey());
}

/** Verify an access JWT and return its claims, or throw 401. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const e = env();
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
    });
    if (payload.type !== 'access' || typeof payload.sub !== 'string') {
      throw unauthorized('Invalid token type');
    }
    return payload as AccessTokenClaims;
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err) throw err;
    throw unauthorized('Invalid or expired access token');
  }
}

/**
 * Refresh tokens are opaque random strings, NOT JWTs, so they can be revoked
 * server-side. We persist only the SHA-256 hash.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry(now = new Date()): Date {
  const days = env().REFRESH_TOKEN_TTL_DAYS;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
