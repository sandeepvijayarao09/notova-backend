import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { makeTestApp, jsonBody, authHeaders } from './helpers.js';

async function registerUser(request: ReturnType<typeof makeTestApp>['request']) {
  const res = await request(
    '/v1/auth/register',
    jsonBody({ email: `u-${randomUUID()}@example.com`, password: 'good-password-123' })
  );
  return (await res.json()) as { accessToken: string; user: { id: string } };
}

function recording(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Team standup',
    createdAt: new Date().toISOString(),
    durationSec: 123.4,
    source: 'mic',
    status: 'ready',
    ...overrides,
  };
}

describe('sync recordings (auth-protected)', () => {
  it('requires auth for list and upsert', async () => {
    const { request } = makeTestApp();
    expect((await request('/v1/sync/recordings')).status).toBe(401);
    const putRes = await request(`/v1/sync/recordings/${randomUUID()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recording()),
    });
    expect(putRes.status).toBe(401);
  });

  it('upserts then lists recordings for the owner', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const id = randomUUID();

    const put = await request(`/v1/sync/recordings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify(recording({ title: 'First note' })),
    });
    expect(put.status).toBe(200);
    expect((await put.json()) as { ok: boolean }).toEqual({ ok: true });

    const list = await request('/v1/sync/recordings', { headers: authHeaders(accessToken) });
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(id);
    expect(items[0]?.title).toBe('First note');
  });

  it('updates an existing recording on repeated PUT', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const id = randomUUID();
    const headers = { 'Content-Type': 'application/json', ...authHeaders(accessToken) };

    await request(`/v1/sync/recordings/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(recording({ title: 'v1', status: 'processing' })),
    });
    await request(`/v1/sync/recordings/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(recording({ title: 'v2', status: 'ready' })),
    });

    const list = await request('/v1/sync/recordings', { headers: authHeaders(accessToken) });
    const items = (await list.json()) as Array<{ id: string; title: string; status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('v2');
    expect(items[0]?.status).toBe('ready');
  });

  it('does not leak recordings across users', async () => {
    const { request } = makeTestApp();
    const userA = await registerUser(request);
    const userB = await registerUser(request);

    await request(`/v1/sync/recordings/${randomUUID()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(userA.accessToken) },
      body: JSON.stringify(recording()),
    });

    const listB = await request('/v1/sync/recordings', {
      headers: authHeaders(userB.accessToken),
    });
    const items = (await listB.json()) as unknown[];
    expect(items).toHaveLength(0);
  });

  it('rejects invalid recording metadata', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request(`/v1/sync/recordings/${randomUUID()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify(recording({ source: 'telepathy' })),
    });
    expect(res.status).toBe(400);
  });
});
