import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { recordingSchema } from '../../lib/types.js';
import type { AppVariables } from '../../middleware/auth.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { listRecordings, upsertRecording } from './service.js';

export const syncRoutes = new Hono<{ Variables: AppVariables }>();

const sinceSchema = z.string().datetime({ offset: true }).optional();

// Body for PUT: full recording metadata but `id` is taken from the path.
const putBodySchema = recordingSchema.omit({ id: true });

/** GET /v1/sync/recordings?since=ISO -> recording metadata list. */
syncRoutes.get('/recordings', requireAuth, (c) => {
  const { id: userId } = currentUser(c);
  const sinceRaw = c.req.query('since');
  const parsed = sinceSchema.safeParse(sinceRaw);
  if (!parsed.success) {
    throw badRequest('`since` must be an ISO-8601 datetime with offset');
  }
  const result = listRecordings(db(), userId, parsed.data);
  return c.json(result, 200);
});

/** PUT /v1/sync/recordings/:id -> upsert recording metadata. */
syncRoutes.put('/recordings/:id', requireAuth, async (c) => {
  const { id: userId } = currentUser(c);
  const id = c.req.param('id');

  if (!z.string().uuid().safeParse(id).success) {
    throw badRequest('Recording id must be a UUID');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const fields = putBodySchema.parse(body);

  upsertRecording(db(), userId, { id, ...fields });
  return c.json({ ok: true }, 200);
});
