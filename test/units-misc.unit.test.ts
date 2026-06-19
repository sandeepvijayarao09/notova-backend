import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  notImplemented,
  internal,
} from '../src/lib/errors.js';
import { recordingSchema, integrationExportSchema } from '../src/lib/types.js';

describe('config/env: loadEnv', () => {
  it('applies defaults for a minimal environment', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8787);
    expect(env.JWT_ISSUER).toBe('notova-backend');
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('coerces numeric env values', () => {
    const env = loadEnv({ PORT: '3000', REFRESH_TOKEN_TTL_DAYS: '14' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3000);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(14);
  });

  it('throws a descriptive error for an invalid NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrowError(
      /Invalid environment configuration/
    );
  });

  it('throws for a non-positive port', () => {
    expect(() => loadEnv({ PORT: '-5' } as NodeJS.ProcessEnv)).toThrowError(
      /Invalid environment configuration/
    );
  });
});

describe('auth/password', () => {
  it('hashes and verifies a password (argon2id)', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('returns false (never throws) for a malformed/garbage hash', async () => {
    await expect(verifyPassword('not-a-real-argon2-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });

  it('produces distinct hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});

describe('lib/errors', () => {
  it('each helper carries the right status and code', () => {
    const cases: Array<[HttpError, number, string]> = [
      [badRequest('x'), 400, 'bad_request'],
      [unauthorized(), 401, 'unauthorized'],
      [forbidden(), 403, 'forbidden'],
      [notFound(), 404, 'not_found'],
      [conflict('x'), 409, 'conflict'],
      [notImplemented(), 501, 'not_implemented'],
      [internal(), 500, 'internal_error'],
    ];
    for (const [err, status, code] of cases) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(typeof err.message).toBe('string');
    }
  });

  it('carries optional details', () => {
    const err = badRequest('bad', { field: 'email' });
    expect(err.details).toEqual({ field: 'email' });
  });
});

describe('lib/types: schema validation', () => {
  it('accepts a valid recording', () => {
    const ok = recordingSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Note',
      createdAt: '2026-01-01T00:00:00.000Z',
      durationSec: 0,
      source: 'mic',
      status: 'ready',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a recording with a non-uuid id and a bad source', () => {
    expect(
      recordingSchema.safeParse({
        id: 'nope',
        title: 'x',
        createdAt: '2026-01-01T00:00:00.000Z',
        durationSec: 1,
        source: 'telepathy',
        status: 'ready',
      }).success
    ).toBe(false);
  });

  it('integrationExportSchema requires recording + summary + transcript', () => {
    expect(integrationExportSchema.safeParse({}).success).toBe(false);
  });

  it('actionItem defaults done to false', () => {
    const parsed = integrationExportSchema.safeParse({
      recording: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'x',
        createdAt: '2026-01-01T00:00:00.000Z',
        durationSec: 1,
        source: 'mic',
        status: 'ready',
      },
      summary: { text: 's', actionItems: [{ text: 'todo' }] },
      transcript: { text: 't' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.summary.actionItems?.[0]?.done).toBe(false);
    }
  });
});
