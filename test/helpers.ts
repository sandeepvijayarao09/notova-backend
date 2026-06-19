import { buildApp, type AppType } from '../src/app.js';
import { createTestDb, setDb } from '../src/db/client.js';
import { resetEnvCache } from '../src/config/env.js';
import { resetCryptoKeyCache } from '../src/modules/integrations/crypto.js';

/** A valid 32-byte AES key (base64) for tests that exercise token encryption. */
export const TEST_ENCRYPTION_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef'
).toString('base64');

/**
 * Build an app wired to a fresh in-memory database. No network, no real
 * credentials. Returns the app plus a `request` convenience that calls the
 * Hono fetch handler directly (no socket).
 */
export function makeTestApp(): {
  app: AppType;
  request: (path: string, init?: RequestInit) => Promise<Response>;
} {
  // Force a deterministic, dev-default test environment.
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  // A genuinely 32-byte base64 key. NOTE: the scaffold's dev default
  // (ZGV2LW9ubHktMzItYnl0ZS1lbmNyeXB0aW9uLWtleSEhMTI=) actually decodes to 35
  // bytes and would make crypto.encrypt() throw, so tests pin a valid key.
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  resetEnvCache();
  resetCryptoKeyCache();

  const { db, sqlite } = createTestDb();
  setDb(db, sqlite);

  const app = buildApp();
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test.local${path}`, init));

  return { app, request };
}

export function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** A PUT request init with a JSON body (used by sync recordings tests). */
export function putJson(body: unknown, token?: string): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: 'PUT', headers, body: JSON.stringify(body) };
}

interface RegisteredUser {
  user: { id: string; email: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
  email: string;
  password: string;
}

let userCounter = 0;

/**
 * Register a fresh, unique user against the given app and return the auth
 * payload plus the credentials used. Asserts a 201 so callers fail fast.
 */
export async function registerUser(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  overrides: { email?: string; password?: string } = {}
): Promise<RegisteredUser> {
  userCounter += 1;
  const email = overrides.email ?? `user-${userCounter}-${Date.now()}@example.com`;
  const password = overrides.password ?? 'good-password-123';
  const res = await request('/v1/auth/register', jsonBody({ email, password }));
  if (res.status !== 201) {
    throw new Error(`registerUser expected 201, got ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as Omit<RegisteredUser, 'email' | 'password'>;
  return { ...body, email, password };
}
