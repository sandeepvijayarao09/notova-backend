import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { refreshTokens, users, type UserRow } from '../../db/schema.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import type { PublicUser } from '../../lib/types.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from './tokens.js';

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: normalizeIso(row.createdAt),
  };
}

/** SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" (UTC). Make it ISO-8601. */
function normalizeIso(value: string): string {
  if (value.includes('T')) return value;
  return value.replace(' ', 'T') + 'Z';
}

async function issueTokens(db: DB, user: UserRow): Promise<AuthResult> {
  const accessToken = await signAccessToken(user.id, user.email);
  const { token: refreshToken, hash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash: hash,
    expiresAt: refreshTokenExpiry().toISOString(),
  });
  return { user: toPublicUser(user), accessToken, refreshToken };
}

export async function register(db: DB, email: string, password: string): Promise<AuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.select().from(users).where(eq(users.email, normalizedEmail)).get();
  if (existing) {
    throw conflict('An account with that email already exists');
  }
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  db.insert(users).values({ id, email: normalizedEmail, passwordHash }).run();
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw badRequest('Failed to create user');
  return issueTokens(db, user);
}

export async function login(db: DB, email: string, password: string): Promise<AuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = db.select().from(users).where(eq(users.email, normalizedEmail)).get();
  // Constant-ish failure path: still verify against a dummy when user missing
  // would be ideal, but a clear invalid-credentials error is sufficient here.
  if (!user) {
    throw unauthorized('Invalid email or password');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    throw unauthorized('Invalid email or password');
  }
  return issueTokens(db, user);
}

/** Exchange a valid, non-revoked, non-expired refresh token for a new access token. */
export async function refreshAccessToken(
  db: DB,
  refreshToken: string
): Promise<{ accessToken: string }> {
  const hash = hashRefreshToken(refreshToken);
  const row = db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
    .get();
  if (!row) {
    throw unauthorized('Invalid refresh token');
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    throw unauthorized('Refresh token expired');
  }
  const user = db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user) {
    throw unauthorized('Invalid refresh token');
  }
  const accessToken = await signAccessToken(user.id, user.email);
  return { accessToken };
}

export function getUserById(db: DB, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}
