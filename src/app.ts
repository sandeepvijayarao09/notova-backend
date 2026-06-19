import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { onError } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import type { AppVariables } from './middleware/auth.js';
import { authRoutes } from './modules/auth/routes.js';
import { integrationsRoutes } from './modules/integrations/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { billingRoutes } from './modules/billing/routes.js';

// Kept in sync with package.json; surfaced on the health endpoint.
export const APP_VERSION = '0.1.0';

export type AppType = Hono<{ Variables: AppVariables }>;

/** Build the full Hono application with middleware and all /v1 routes mounted. */
export function buildApp(): AppType {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', requestLogger);
  app.use('*', cors());
  app.onError(onError);

  const v1 = new Hono<{ Variables: AppVariables }>();

  v1.get('/health', (c) => c.json({ status: 'ok', version: APP_VERSION }, 200));

  v1.route('/auth', authRoutes);
  v1.route('/integrations', integrationsRoutes);
  v1.route('/sync', syncRoutes);
  v1.route('/billing', billingRoutes);

  app.route('/v1', v1);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  return app;
}
