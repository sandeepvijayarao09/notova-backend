import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { makeTestApp, authHeaders, registerUser, putJson } from './helpers.js';

interface ErrorEnvelope {
  error: { code: string; message: string };
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

describe('sync: since filter', () => {
  it('returns only recordings updated after `since`', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const id1 = randomUUID();
    const id2 = randomUUID();

    await request(`/v1/sync/recordings/${id1}`, putJson(recording({ title: 'old' }), accessToken));
    // Capture a cutoff strictly after the first write.
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    await request(`/v1/sync/recordings/${id2}`, putJson(recording({ title: 'new' }), accessToken));

    const res = await request(`/v1/sync/recordings?since=${encodeURIComponent(cutoff)}`, {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(id2);
    expect(items[0]?.title).toBe('new');
  });

  it('rejects a malformed `since` value with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/sync/recordings?since=not-a-date', {
      headers: authHeaders(accessToken),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});

describe('sync: validation', () => {
  it('rejects a non-UUID recording id with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/sync/recordings/not-a-uuid', putJson(recording(), accessToken));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message.toLowerCase()).toContain('uuid');
  });

  it('rejects an invalid source enum with 400 validation_error', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request(
      `/v1/sync/recordings/${randomUUID()}`,
      putJson(recording({ source: 'telepathy' }), accessToken)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects an invalid status enum with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request(
      `/v1/sync/recordings/${randomUUID()}`,
      putJson(recording({ status: 'banana' }), accessToken)
    );
    expect(res.status).toBe(400);
  });

  it('rejects a negative duration and an empty title with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    expect(
      (
        await request(
          `/v1/sync/recordings/${randomUUID()}`,
          putJson(recording({ durationSec: -1 }), accessToken)
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          `/v1/sync/recordings/${randomUUID()}`,
          putJson(recording({ title: '' }), accessToken)
        )
      ).status
    ).toBe(400);
  });

  it('rejects an over-long title (>500 chars) with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request(
      `/v1/sync/recordings/${randomUUID()}`,
      putJson(recording({ title: 'a'.repeat(501) }), accessToken)
    );
    expect(res.status).toBe(400);
  });

  it('accepts unicode / emoji titles and round-trips them intact', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const id = randomUUID();
    const title = '会議メモ 🎙️ — café résumé';
    const put = await request(
      `/v1/sync/recordings/${id}`,
      putJson(recording({ title }), accessToken)
    );
    expect(put.status).toBe(200);
    const list = await request('/v1/sync/recordings', { headers: authHeaders(accessToken) });
    const items = (await list.json()) as Array<{ id: string; title: string }>;
    expect(items.find((i) => i.id === id)?.title).toBe(title);
  });
});

describe('sync: CROSS-USER ISOLATION (security-critical)', () => {
  it("user A's recordings are never visible to user B", async () => {
    const { request } = makeTestApp();
    const userA = await registerUser(request);
    const userB = await registerUser(request);

    const idA = randomUUID();
    await request(
      `/v1/sync/recordings/${idA}`,
      putJson(recording({ title: 'A-secret' }), userA.accessToken)
    );

    const listB = await request('/v1/sync/recordings', {
      headers: authHeaders(userB.accessToken),
    });
    const itemsB = (await listB.json()) as unknown[];
    expect(itemsB).toHaveLength(0);

    // And A still sees their own.
    const listA = await request('/v1/sync/recordings', {
      headers: authHeaders(userA.accessToken),
    });
    const itemsA = (await listA.json()) as Array<{ id: string }>;
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]?.id).toBe(idA);
  });

  it("user B cannot overwrite or hijack user A's recording by reusing its id", async () => {
    const { request } = makeTestApp();
    const userA = await registerUser(request);
    const userB = await registerUser(request);

    const sharedId = randomUUID();
    // A creates the recording.
    const aPut = await request(
      `/v1/sync/recordings/${sharedId}`,
      putJson(recording({ title: 'A-original' }), userA.accessToken)
    );
    expect(aPut.status).toBe(200);

    // B PUTs to the SAME id. The `recordings.id` column is a global primary key,
    // so the upsert looks the row up by id and enforces ownership: a different
    // owner is rejected with a clean 409 conflict (never an unhandled 500), and
    // B's write cannot update A's row. The SECURITY-CRITICAL guarantee is that
    // A's data is neither overwritten nor exposed to B.
    const bPut = await request(
      `/v1/sync/recordings/${sharedId}`,
      putJson(recording({ title: 'B-hijack' }), userB.accessToken)
    );
    expect(bPut.status).toBe(409);
    const bBody = (await bPut.json()) as { error?: { code?: string } };
    expect(bBody.error?.code).toBe('conflict');

    // A's recording is completely unchanged.
    const listA = await request('/v1/sync/recordings', {
      headers: authHeaders(userA.accessToken),
    });
    const itemsA = (await listA.json()) as Array<{ id: string; title: string }>;
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]?.id).toBe(sharedId);
    expect(itemsA[0]?.title).toBe('A-original');

    // B cannot see A's recording at all.
    const listB = await request('/v1/sync/recordings', {
      headers: authHeaders(userB.accessToken),
    });
    const itemsB = (await listB.json()) as Array<{ id: string; title: string }>;
    expect(itemsB.find((i) => i.id === sharedId)?.title).not.toBe('A-original');
  });

  it('a since filter never leaks another user\'s rows', async () => {
    const { request } = makeTestApp();
    const userA = await registerUser(request);
    const userB = await registerUser(request);
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    await request(
      `/v1/sync/recordings/${randomUUID()}`,
      putJson(recording(), userA.accessToken)
    );
    const listB = await request(`/v1/sync/recordings?since=${encodeURIComponent(cutoff)}`, {
      headers: authHeaders(userB.accessToken),
    });
    expect((await listB.json()) as unknown[]).toHaveLength(0);
  });
});
