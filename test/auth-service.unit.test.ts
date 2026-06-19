import { beforeEach, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/db/client.js';
import { refreshTokens, users } from '../src/db/schema.js';
import {
  register,
  login,
  refreshAccessToken,
  getUserById,
  toPublicUser,
} from '../src/modules/auth/service.js';
import { resetEnvCache } from '../src/config/env.js';

function freshDb() {
  return createTestDb().db;
}

function freshDbWithConn() {
  return createTestDb();
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  resetEnvCache();
});

describe('auth/service: register + login (direct)', () => {
  it('register normalizes the email and returns tokens', async () => {
    const db = freshDb();
    const result = await register(db, '  Mixed@Example.COM ', 'good-password-1');
    expect(result.user.email).toBe('mixed@example.com');
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });

  it('register throws conflict on duplicate', async () => {
    const db = freshDb();
    await register(db, 'dup@example.com', 'good-password-1');
    await expect(register(db, 'dup@example.com', 'good-password-1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('login throws 401 for unknown user and wrong password', async () => {
    const db = freshDb();
    await register(db, 'known@example.com', 'good-password-1');
    await expect(login(db, 'unknown@example.com', 'good-password-1')).rejects.toMatchObject({
      status: 401,
    });
    await expect(login(db, 'known@example.com', 'wrong')).rejects.toMatchObject({ status: 401 });
  });

  it('getUserById + toPublicUser produce a public-safe shape (no passwordHash)', async () => {
    const db = freshDb();
    const reg = await register(db, 'pub@example.com', 'good-password-1');
    const row = getUserById(db, reg.user.id);
    expect(row).toBeTruthy();
    const pub = toPublicUser(row!);
    expect(pub).toEqual({ id: reg.user.id, email: 'pub@example.com', createdAt: expect.any(String) });
    expect(pub).not.toHaveProperty('passwordHash');
  });
});

describe('auth/service: refresh edge cases (direct)', () => {
  it('returns a new access token for a valid refresh token', async () => {
    const db = freshDb();
    const reg = await register(db, 'r@example.com', 'good-password-1');
    const { accessToken } = await refreshAccessToken(db, reg.refreshToken);
    expect(accessToken).toBeTruthy();
  });

  it('throws 401 for an unknown refresh token', async () => {
    const db = freshDb();
    await expect(refreshAccessToken(db, 'never-issued')).rejects.toMatchObject({ status: 401 });
  });

  it('throws 401 when the refresh token row points at a missing user', async () => {
    const { db, sqlite } = freshDbWithConn();
    const reg = await register(db, 'gone@example.com', 'good-password-1');
    // Repoint the token row at a non-existent user id. Toggle FK enforcement
    // off for this manipulation so we can construct the orphaned-token state.
    sqlite.pragma('foreign_keys = OFF');
    db.update(refreshTokens).set({ userId: 'no-such-user' }).run();
    sqlite.pragma('foreign_keys = ON');
    await expect(refreshAccessToken(db, reg.refreshToken)).rejects.toMatchObject({ status: 401 });
    // sanity: the original user still exists.
    expect(db.select().from(users).where(eq(users.id, reg.user.id)).get()).toBeTruthy();
  });
});
