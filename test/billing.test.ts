import { describe, it, expect } from 'vitest';
import { makeTestApp, jsonBody, authHeaders, registerUser } from './helpers.js';

interface ErrorEnvelope {
  error: { code: string; message: string };
}

describe('billing: subscription', () => {
  it('requires auth', async () => {
    const { request } = makeTestApp();
    expect((await request('/v1/billing/subscription')).status).toBe(401);
  });

  it('defaults to the free tier with no renewal date', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/billing/subscription', { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tier: string; renewsAt?: string };
    expect(body.tier).toBe('free');
    expect(body.renewsAt).toBeUndefined();
  });

  it('reflects a pro tier + renewal date when set in the DB', async () => {
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);
    const { db: liveDb } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const renewsAt = '2099-01-01T00:00:00.000Z';
    liveDb()
      .update(users)
      .set({ billingTier: 'pro', billingRenewsAt: renewsAt })
      .where(eq(users.id, user.id))
      .run();
    const res = await request('/v1/billing/subscription', { headers: authHeaders(accessToken) });
    const body = (await res.json()) as { tier: string; renewsAt?: string };
    expect(body.tier).toBe('pro');
    expect(body.renewsAt).toBe(renewsAt);
  });
});

describe('billing: checkout', () => {
  it('requires auth', async () => {
    const { request } = makeTestApp();
    const res = await request('/v1/billing/checkout', jsonBody({ plan: 'pro' }));
    expect(res.status).toBe(401);
  });

  it('returns a checkoutUrl carrying the plan and user id', async () => {
    const { request } = makeTestApp();
    const { accessToken, user } = await registerUser(request);
    for (const plan of ['pro', 'pro_monthly', 'pro_yearly']) {
      const res = await request('/v1/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
        body: JSON.stringify({ plan }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checkoutUrl: string };
      expect(body.checkoutUrl).toBeTruthy();
      const url = new URL(body.checkoutUrl);
      expect(url.searchParams.get('plan')).toBe(plan);
      expect(url.searchParams.get('uid')).toBe(user.id);
      expect(url.searchParams.get('session')).toContain('stub_');
    }
  });

  it('rejects an unknown plan with 400 validation_error', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify({ plan: 'enterprise' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects a missing plan field with 400', async () => {
    const { request } = makeTestApp();
    const { accessToken } = await registerUser(request);
    const res = await request('/v1/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
