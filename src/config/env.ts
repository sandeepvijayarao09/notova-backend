import { z } from 'zod';

/**
 * A TOKEN_ENCRYPTION_KEY is valid only if it decodes to exactly 32 bytes
 * (base64 or hex) — the AES-256-GCM key size used by modules/integrations/crypto.ts.
 * Validating here makes a misconfigured key fail fast at boot with a clear
 * message, instead of throwing only on the first token encryption.
 */
function decodesTo32Bytes(raw: string): boolean {
  return Buffer.from(raw, 'base64').length === 32 || Buffer.from(raw, 'hex').length === 32;
}

/**
 * Environment schema. All third-party OAuth credentials are OPTIONAL so the
 * app boots, builds, and tests without any real secrets. Missing creds are
 * surfaced as a clear 400 at the point of use (see integrations routes).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),

  // Database
  DATABASE_URL: z.string().default('./notova.sqlite'),

  // JWT signing. Defaults are dev-only; production MUST override.
  JWT_SECRET: z.string().min(1).default('dev-insecure-jwt-secret-change-me'),
  JWT_ISSUER: z.string().default('notova-backend'),
  JWT_AUDIENCE: z.string().default('notova-app'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // AES-256-GCM key for encrypting stored OAuth tokens at rest.
  // Must decode to exactly 32 bytes (base64 or hex). The dev default below is a
  // real 32-byte key; production MUST override it. Validated at boot.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .default('jOYijXsBm7sqEIKLyz36u4FJd2gIAs69kcHRnANrN9E=')
    .refine(decodesTo32Bytes, {
      message: 'must decode to exactly 32 bytes (base64 or hex) for AES-256-GCM',
    }),

  // Public base URL of THIS backend, used to build OAuth redirect URIs.
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),

  // Deep-link scheme the mobile app listens on after OAuth completes.
  APP_OAUTH_REDIRECT_SCHEME: z.string().default('notova://oauth'),

  // ---- Third-party OAuth credentials (all optional) ----
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),

  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),

  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_LOGIN_URL: z.string().default('https://login.salesforce.com'),

  // ---- Billing (stub) ----
  BILLING_CHECKOUT_BASE_URL: z.string().default('https://billing.notova.app/checkout'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Singleton accessor used across the app. */
export function env(): Env {
  if (!cached) {
    cached = loadEnv();
  }
  return cached;
}

/** Test helper to reset the cached env after mutating process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
