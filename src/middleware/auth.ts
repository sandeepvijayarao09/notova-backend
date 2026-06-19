import type { Context, MiddlewareHandler } from 'hono';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

export interface AuthUser {
  id: string;
  email: string;
}

/**
 * Variables added to the Hono context by middleware. Routes read the
 * authenticated user via c.get('user').
 */
export type AppVariables = {
  user: AuthUser;
  requestId: string;
};

/** Require a valid Bearer access token. Populates c.get('user'). */
export const requireAuth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice(7).trim();
  if (!token) {
    throw unauthorized('Missing bearer token');
  }
  const claims = await verifyAccessToken(token);
  c.set('user', { id: claims.sub, email: claims.email });
  await next();
};

/** Convenience accessor with a non-null guarantee for routes behind requireAuth. */
export function currentUser(c: Context<{ Variables: AppVariables }>): AuthUser {
  return c.get('user');
}
