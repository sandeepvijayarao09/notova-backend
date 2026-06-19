import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export type DB = BetterSQLite3Database<typeof schema>;

let sqlite: Database.Database | undefined;
let dbInstance: DB | undefined;

function createSqlite(url: string): Database.Database {
  const conn = new Database(url);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  return conn;
}

/** Lazily-created singleton database used by the running server. */
export function db(): DB {
  if (!dbInstance) {
    sqlite = createSqlite(env().DATABASE_URL);
    dbInstance = drizzle(sqlite, { schema });
  }
  return dbInstance;
}

/** Raw better-sqlite3 handle (used by the migration runner). */
export function rawSqlite(): Database.Database {
  if (!sqlite) {
    sqlite = createSqlite(env().DATABASE_URL);
  }
  return sqlite;
}

/**
 * Build an isolated in-memory DB. Used by tests so each suite gets a clean,
 * network-free, credential-free database. The schema is created inline to keep
 * tests independent of generated migration files.
 */
export function createTestDb(): { db: DB; sqlite: Database.Database } {
  const conn = createSqlite(':memory:');
  applySchema(conn);
  return { db: drizzle(conn, { schema }), sqlite: conn };
}

/** Override the process-wide singleton (used to wire a test DB into the app). */
export function setDb(instance: DB, conn?: Database.Database): void {
  dbInstance = instance;
  if (conn) sqlite = conn;
}

/**
 * Create all tables from scratch on a connection. This mirrors schema.ts and is
 * used for the in-memory test DB and as a fallback when no generated migrations
 * are present.
 */
export function applySchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      billing_tier TEXT NOT NULL DEFAULT 'free',
      billing_renews_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_unique ON refresh_tokens (token_hash);
    CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT,
      scope TEXT,
      token_type TEXT,
      expires_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS integration_user_provider_unique
      ON integration_connections (user_id, provider);

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS oauth_states_user_idx ON oauth_states (user_id);

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      duration_sec REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS recordings_user_idx ON recordings (user_id);
    CREATE INDEX IF NOT EXISTS recordings_user_updated_idx ON recordings (user_id, updated_at);
  `);
}
