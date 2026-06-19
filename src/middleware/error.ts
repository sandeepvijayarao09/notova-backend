import type { Context } from 'hono';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Central error handler registered via app.onError. Serializes errors uniformly. */
export function onError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    const body: ErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    return c.json(body, err.status);
  }

  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues,
      },
    };
    return c.json(body, 400);
  }

  // Unknown error: log and return a generic 500 (never leak internals).
  console.error('[unhandled]', err);
  const body: ErrorBody = {
    error: { code: 'internal_error', message: 'Internal server error' },
  };
  return c.json(body, 500);
}
