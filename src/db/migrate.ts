import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { rawSqlite } from './client.js';
import { applySchema } from './client.js';

/**
 * Apply database migrations. If a generated `drizzle/` folder exists (produced
 * by `npm run db:generate`), it is applied via the Drizzle migrator. Otherwise
 * the schema is created directly from schema.ts via applySchema — this keeps
 * `db:migrate` useful even before any migrations have been generated.
 */
function run(): void {
  const conn = rawSqlite();
  const migrationsFolder = resolve(process.cwd(), 'drizzle');

  if (existsSync(migrationsFolder)) {
    const d = drizzle(conn);
    migrate(d, { migrationsFolder });
    console.log(`Applied migrations from ${migrationsFolder}`);
  } else {
    applySchema(conn);
    console.log('No drizzle/ migrations found; created schema directly from schema.ts');
  }
}

run();
