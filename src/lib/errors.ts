import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Typed HTTP error. Carries a machine-readable `code`, an HTTP `status`, and an
 * optional `details` payload. The error middleware serializes these uniformly.
 */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);

export const notImplemented = (message = 'Not implemented') =>
  new HttpError(501, 'not_implemented', message);

export const internal = (message = 'Internal server error') =>
  new HttpError(500, 'internal_error', message);
