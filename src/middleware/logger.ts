import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from './auth.js';

/**
 * Minimal structured request logger. Assigns a request id, echoes it in the
 * X-Request-Id response header, and logs method/path/status/duration. Skipped
 * when NODE_ENV=test to keep test output clean.
 */
export const requestLogger: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);

  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  if (process.env.NODE_ENV !== 'test') {
    console.log(
      JSON.stringify({
        level: 'info',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
      })
    );
  }
};
