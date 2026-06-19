import { sql } from 'drizzle-orm';
import { sqliteTable, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** User accounts. Passwords stored only as a hash. */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // Billing tier kept on the user row for the lightweight billing module.
    billingTier: text('billing_tier', { enum: ['free', 'pro'] })
      .notNull()
      .default('free'),
    billingRenewsAt: text('billing_renews_at'),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)]
);

/** Refresh tokens (rotating). Stored as a hash; the raw token is never persisted. */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ]
);

/**
 * Encrypted OAuth tokens per (user, provider). The access/refresh tokens are
 * AES-256-GCM encrypted blobs (see modules/integrations/crypto.ts) so they are
 * never readable at rest.
 */
export const integrationConnections = sqliteTable(
  'integration_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', {
      enum: ['google', 'notion', 'slack', 'salesforce'],
    }).notNull(),
    // Encrypted token blobs (ciphertext payloads produced by crypto.ts).
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    scope: text('scope'),
    tokenType: text('token_type'),
    expiresAt: text('expires_at'),
    // Provider-specific metadata (e.g. Notion workspace id, Slack team id).
    metadata: text('metadata'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex('integration_user_provider_unique').on(t.userId, t.provider)]
);

/**
 * Short-lived OAuth2 state + PKCE verifier rows created at the start of an
 * authorization-code flow and consumed once at the callback.
 */
export const oauthStates = sqliteTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', {
      enum: ['google', 'notion', 'slack', 'salesforce'],
    }).notNull(),
    codeVerifier: text('code_verifier').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('oauth_states_user_idx').on(t.userId)]
);

/** Lightweight recording metadata for cross-device sync. No audio, no AI output. */
export const recordings = sqliteTable(
  'recordings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: text('created_at').notNull(),
    durationSec: real('duration_sec').notNull().default(0),
    source: text('source', { enum: ['mic', 'bluetooth', 'file', 'other'] }).notNull(),
    status: text('status', {
      enum: ['recording', 'processing', 'ready', 'failed'],
    }).notNull(),
    // Server-side bookkeeping for incremental sync.
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('recordings_user_idx').on(t.userId),
    index('recordings_user_updated_idx').on(t.userId, t.updatedAt),
  ]
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type OauthStateRow = typeof oauthStates.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type NewRecordingRow = typeof recordings.$inferInsert;
