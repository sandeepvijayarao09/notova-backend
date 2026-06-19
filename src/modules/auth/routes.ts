import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AppVariables } from '../../middleware/auth.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { getUserById, login, refreshAccessToken, register, toPublicUser } from './service.js';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(256),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

export const authRoutes = new Hono<{ Variables: AppVariables }>();

authRoutes.post('/register', async (c) => {
  const body = credentialsSchema.parse(await parseJson(c));
  const result = await register(db(), body.email, body.password);
  return c.json(result, 201);
});

authRoutes.post('/login', async (c) => {
  const body = credentialsSchema.parse(await parseJson(c));
  const result = await login(db(), body.email, body.password);
  return c.json(result, 200);
});

authRoutes.post('/refresh', async (c) => {
  const body = refreshSchema.parse(await parseJson(c));
  const result = await refreshAccessToken(db(), body.refreshToken);
  return c.json(result, 200);
});

authRoutes.get('/me', requireAuth, (c) => {
  const { id } = currentUser(c);
  const user = getUserById(db(), id);
  if (!user) throw notFound('User not found');
  return c.json({ user: toPublicUser(user) }, 200);
});
