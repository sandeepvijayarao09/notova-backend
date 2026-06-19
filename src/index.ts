import { serve } from '@hono/node-server';
import { buildApp, APP_VERSION } from './app.js';
import { env } from './config/env.js';
import { applySchema, rawSqlite } from './db/client.js';

function main(): void {
  const e = env();

  // Ensure the database schema exists before accepting traffic. This is
  // idempotent (CREATE TABLE IF NOT EXISTS) and keeps local/dev frictionless;
  // production deployments should run `npm run db:migrate` explicitly.
  applySchema(rawSqlite());

  const app = buildApp();

  serve({ fetch: app.fetch, port: e.PORT }, (info) => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'notova-backend listening',
        version: APP_VERSION,
        port: info.port,
        env: e.NODE_ENV,
      })
    );
  });
}

main();
