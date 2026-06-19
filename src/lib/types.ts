import { z } from 'zod';

/**
 * Shared domain schemas. These mirror the on-device product model so the
 * backend speaks the same field names as the app. The backend stores only
 * lightweight metadata — never audio, transcripts, or AI output at rest
 * (those live on-device). Transcript/summary may transit the export endpoints
 * but are forwarded to third parties, not persisted.
 */

export const recordingSourceSchema = z.enum(['mic', 'bluetooth', 'file', 'other']);
export type RecordingSource = z.infer<typeof recordingSourceSchema>;

export const recordingStatusSchema = z.enum(['recording', 'processing', 'ready', 'failed']);
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

export const recordingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(500),
  createdAt: z.string().datetime({ offset: true }),
  durationSec: z.number().nonnegative(),
  source: recordingSourceSchema,
  status: recordingStatusSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

export const actionItemSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().min(1),
  done: z.boolean().default(false),
  dueAt: z.string().datetime({ offset: true }).optional(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const summarySchema = z.object({
  text: z.string(),
  bullets: z.array(z.string()).optional(),
  actionItems: z.array(actionItemSchema).optional(),
});
export type Summary = z.infer<typeof summarySchema>;

export const transcriptSegmentSchema = z.object({
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().nonnegative().optional(),
  speaker: z.string().optional(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptSchema = z.object({
  text: z.string(),
  segments: z.array(transcriptSegmentSchema).optional(),
  language: z.string().optional(),
});
export type Transcript = z.infer<typeof transcriptSchema>;

/**
 * Request body for POST /v1/integrations/:provider/export.
 * The transcript/summary are provided by the device at export time and
 * forwarded to the third party; they are not stored server-side.
 */
export const integrationExportSchema = z.object({
  recording: recordingSchema,
  summary: summarySchema,
  transcript: transcriptSchema,
});
export type IntegrationExport = z.infer<typeof integrationExportSchema>;

export const integrationExportResultSchema = z.object({
  externalId: z.string(),
  url: z.string().nullable(),
  status: z.enum(['exported', 'queued', 'skipped']),
});
export type IntegrationExportResult = z.infer<typeof integrationExportResultSchema>;

// ---- User (public-safe shape returned to clients) ----
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PublicUser = z.infer<typeof publicUserSchema>;
