import { describe, it, expect } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /v1/health', () => {
  it('returns ok with a version', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown routes', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/does-not-exist');
    expect(res.status).toBe(404);
  });
});
