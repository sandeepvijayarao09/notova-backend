# notova-backend

Backend for **Notova**, an app-only, on-device AI voice-notes product. Notova
captures audio (phone mic, Bluetooth mic, other devices, or an imported file)
and **transcribes and summarizes it entirely on-device**.

This service exists **only** for the things that must be server-side. It does
**no** AI or transcription compute and **never receives audio**.

## What this backend is

- **User accounts** — registration, login, JWT access + refresh tokens.
- **OAuth token broker** — connects third-party integrations (Google, Notion,
  Slack, Salesforce) via OAuth2 Authorization Code + PKCE, and stores the
  resulting tokens **encrypted at rest** (AES-256-GCM). The device asks the
  backend to forward a note to a connected service.
- **Lightweight metadata sync** — cross-device sync of _recording metadata only_
  (title, duration, source, status, timestamps). No audio, no transcripts, no
  summaries are stored at rest.
- **Billing** — subscription tier lookup and a checkout stub.

## What this backend is NOT

- It is **not** a transcription or summarization service. All AI runs on-device.
- It **never** receives, stores, or proxies audio.
- It does **not** persist transcripts or summaries. They may transit the export
  endpoints (device → backend → third party) but are forwarded, not stored.

## Architecture

```
src/
  index.ts                 server bootstrap (@hono/node-server)
  app.ts                   build Hono app, mount /v1 routes, middleware
  config/env.ts            zod-validated environment (.env.example lists all keys)
  lib/
    errors.ts              typed HTTP errors + uniform JSON error body
    types.ts               zod schemas for the shared domain model
  middleware/
    auth.ts                verify Bearer JWT, populate c.get('user')
    error.ts               central onError handler
    logger.ts              structured request logging + X-Request-Id
  db/
    schema.ts              Drizzle schema (users, refresh_tokens,
                           integration_connections, recordings, oauth_states)
    client.ts              better-sqlite3 + Drizzle singleton; test DB factory
    migrate.ts             migration runner (drizzle/ if present, else schema.ts)
  modules/
    auth/                  routes, service, tokens (JWT), password hashing
    integrations/          routes, oauth (PKCE + authorize URL + token exchange),
                           crypto (AES-256-GCM), providers/{notion,google,slack,salesforce}
    sync/                  routes + service (recording-metadata upsert/list)
    billing/               routes (subscription + checkout stub)
test/                      vitest: health, auth, sync (in-memory DB, no network)
```

**Stack:** Node 22+ (tested on Node 26), TypeScript (ESM), Hono +
`@hono/node-server`, Drizzle ORM on `better-sqlite3`, `zod`, `jose` (JWT),
`argon2` (password hashing), `node:crypto` AES-256-GCM (token encryption),
Vitest, ESLint (flat config) + Prettier.

### Security model

- Passwords are hashed with **argon2id**; only the hash is stored.
- Refresh tokens are opaque random strings; only a **SHA-256 hash** is stored,
  so they can be revoked server-side. Access tokens are short-lived JWTs.
- Third-party OAuth access/refresh tokens are **AES-256-GCM encrypted** before
  being written to the database (`integration_connections`).
- OAuth flows use **PKCE (S256)** where the provider supports it, with a
  one-time, short-lived `state` row binding the flow to a user.

## Environment setup

```bash
cp .env.example .env
# Generate strong production secrets:
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

Every variable has a dev-safe default **except** the ones you should override in
production (`JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`). Third-party OAuth credentials
are **optional**: when a provider's client ID/secret are missing, its
`connect` endpoint returns a clear `400` instead of failing, so the build and
tests never need real secrets. See [`.env.example`](./.env.example) for the
full list.

## Run / test commands

```bash
npm install        # install deps (builds better-sqlite3 + argon2 native addons)
npm run dev        # tsx watch dev server (http://localhost:8787)
npm run build      # tsc -> dist/
npm start          # run the built server (node dist/index.js)

npm test           # vitest run (in-memory DB, no network, no real creds)
npm run test:watch # vitest in watch mode
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier -w .

npm run db:generate  # drizzle-kit generate (writes SQL migrations to drizzle/)
npm run db:migrate   # apply migrations (or create schema from schema.ts if none)
```

### Docker

```bash
docker compose up --build   # builds the image and serves on :8787 with a persisted volume
```

## API contract

Base path: `/v1`. JSON request/response. Protected routes require an
`Authorization: Bearer <accessToken>` header. Errors use a uniform shape:
`{ "error": { "code", "message", "details?" } }`.

| Method | Path                                             | Auth   | Body                                 | Response                                                        |
| ------ | ------------------------------------------------ | ------ | ------------------------------------ | --------------------------------------------------------------- |
| GET    | `/v1/health`                                     | —      | —                                    | `{ status: "ok", version }`                                     |
| POST   | `/v1/auth/register`                              | —      | `{ email, password }`                | `201 { user, accessToken, refreshToken }`                       |
| POST   | `/v1/auth/login`                                 | —      | `{ email, password }`                | `{ user, accessToken, refreshToken }`                           |
| POST   | `/v1/auth/refresh`                               | —      | `{ refreshToken }`                   | `{ accessToken }`                                               |
| GET    | `/v1/auth/me`                                    | Bearer | —                                    | `{ user }`                                                      |
| GET    | `/v1/integrations`                               | Bearer | —                                    | `[{ provider, connected }]` (google, notion, slack, salesforce) |
| GET    | `/v1/integrations/:provider/connect`             | Bearer | —                                    | `{ authorizeUrl, state }` (stores state + PKCE verifier)        |
| GET    | `/v1/integrations/:provider/callback?code&state` | —      | —                                    | `302` redirect to `notova://oauth/:provider?status=connected`   |
| POST   | `/v1/integrations/:provider/export`              | Bearer | `{ recording, summary, transcript }` | `{ externalId, url, status }`                                   |
| DELETE | `/v1/integrations/:provider`                     | Bearer | —                                    | `{ disconnected: true }`                                        |
| GET    | `/v1/sync/recordings?since=ISO`                  | Bearer | —                                    | `[recording metadata...]`                                       |
| PUT    | `/v1/sync/recordings/:id`                        | Bearer | `{ ...recording metadata }`          | `{ ok: true }`                                                  |
| GET    | `/v1/billing/subscription`                       | Bearer | —                                    | `{ tier: "free" \| "pro", renewsAt? }`                          |
| POST   | `/v1/billing/checkout`                           | Bearer | `{ plan }`                           | `{ checkoutUrl }` (placeholder)                                 |

### Domain model

```ts
Recording {
  id: uuid
  title: string
  createdAt: ISO-8601
  durationSec: number
  source: "mic" | "bluetooth" | "file" | "other"
  status: "recording" | "processing" | "ready" | "failed"
}
```

`Summary`, `Transcript`, and `ActionItem` are defined as zod schemas in
[`src/lib/types.ts`](./src/lib/types.ts) and are used as the request body for the
integration `export` endpoint (`IntegrationExport`). They are forwarded to the
selected third party and are **not** persisted server-side.

### Integration providers

Each provider in `src/modules/integrations/providers/` exposes a uniform
interface (authorize endpoint, token endpoint, scopes, PKCE flag, and an
`export(...)` function):

- **Notion** — implements a real _create a page_ export (network-gated,
  untested by CI). Requires a `databaseId` or `pageId` in the connection
  metadata to choose the parent.
- **Google / Slack / Salesforce** — connect/disconnect work; their `export(...)`
  returns `501 Not Implemented` with a clear message while keeping the shared
  interface.

OAuth `connect`/`callback` build authorize URLs from env-provided client IDs and
tolerate missing credentials in dev by returning a clear `400`, so the app
build and tests never require real secrets or network access.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
