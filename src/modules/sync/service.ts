import { and, eq, gt } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { recordings, type RecordingRow } from '../../db/schema.js';
import { conflict } from '../../lib/errors.js';
import type { Recording } from '../../lib/types.js';

/** Convert a stored row into the shared Recording metadata shape. */
export function rowToRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    durationSec: row.durationSec,
    source: row.source,
    status: row.status,
  };
}

/**
 * List a user's recording metadata, optionally only those updated after
 * `since` (ISO string), ordered by update time. Soft-deleted rows are skipped.
 */
export function listRecordings(db: DB, userId: string, since?: string): Recording[] {
  const rows = db
    .select()
    .from(recordings)
    .where(
      since
        ? and(eq(recordings.userId, userId), gt(recordings.updatedAt, since))
        : eq(recordings.userId, userId)
    )
    .all();

  return rows
    .filter((r) => r.deletedAt == null)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map(rowToRecording);
}

/**
 * Upsert recording metadata for a user. The `id` comes from the path; the body
 * provides the rest of the fields. Returns nothing — callers report { ok: true }.
 */
export function upsertRecording(db: DB, userId: string, recording: Recording): void {
  const now = new Date().toISOString();
  // `recordings.id` is a global primary key, so look the row up by id alone and
  // then enforce ownership. This turns a cross-user id collision into a clean
  // 409 instead of an unhandled SQLite PRIMARY KEY error (500).
  const existing = db
    .select()
    .from(recordings)
    .where(eq(recordings.id, recording.id))
    .get();

  if (existing && existing.userId !== userId) {
    throw conflict('A recording with this id already exists');
  }

  if (existing) {
    db.update(recordings)
      .set({
        title: recording.title,
        createdAt: recording.createdAt,
        durationSec: recording.durationSec,
        source: recording.source,
        status: recording.status,
        updatedAt: now,
        deletedAt: null,
      })
      .where(and(eq(recordings.id, recording.id), eq(recordings.userId, userId)))
      .run();
  } else {
    db.insert(recordings)
      .values({
        id: recording.id,
        userId,
        title: recording.title,
        createdAt: recording.createdAt,
        durationSec: recording.durationSec,
        source: recording.source,
        status: recording.status,
        updatedAt: now,
      })
      .run();
  }
}
