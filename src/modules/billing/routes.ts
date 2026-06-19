import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { users } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AppVariables } from '../../middleware/auth.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';

export const billingRoutes = new Hono<{ Variables: AppVariables }>();

const checkoutSchema = z.object({
  plan: z.enum(['pro_monthly', 'pro_yearly', 'pro']),
});

/** GET /v1/billing/subscription -> current tier + optional renewal date. */
billingRoutes.get('/subscription', requireAuth, (c) => {
  const { id: userId } = currentUser(c);
  const user = db().select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw notFound('User not found');

  return c.json(
    {
      tier: user.billingTier,
      ...(user.billingRenewsAt ? { renewsAt: user.billingRenewsAt } : {}),
    },
    200
  );
});

/**
 * POST /v1/billing/checkout -> placeholder checkout URL.
 * Stub: real implementations would create a checkout session with a payment
 * provider (Stripe / RevenueCat / App Store) and return its hosted URL.
 */
billingRoutes.post('/checkout', requireAuth, async (c) => {
  const { id: userId } = currentUser(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const { plan } = checkoutSchema.parse(body);

  const url = new URL(env().BILLING_CHECKOUT_BASE_URL);
  url.searchParams.set('plan', plan);
  url.searchParams.set('uid', userId);
  // Placeholder session token so the URL looks/behaves like a real one.
  url.searchParams.set('session', `stub_${Date.now()}`);

  return c.json({ checkoutUrl: url.toString() }, 200);
});
