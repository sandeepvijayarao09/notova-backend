import type { Env } from '../../../config/env.js';
import type { IntegrationExport, IntegrationExportResult } from '../../../lib/types.js';

export type ProviderId = 'google' | 'notion' | 'slack' | 'salesforce';

export const PROVIDER_IDS: ProviderId[] = ['google', 'notion', 'slack', 'salesforce'];

/** Decrypted connection passed to a provider's export function. */
export interface ProviderConnection {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  tokenType: string | null;
  metadata: Record<string, unknown> | null;
}

/** Resolved OAuth client credentials for a provider, read from env at use time. */
export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** Whether PKCE is used and how to read creds out of env. */
export interface OAuthProvider {
  id: ProviderId;
  /** Human label for messages. */
  label: string;
  /** Base authorize endpoint URL (may be overridden per-env, e.g. Salesforce). */
  authorizeEndpoint(env: Env): string;
  /** Token exchange endpoint URL. */
  tokenEndpoint(env: Env): string;
  /** Default scopes requested. */
  scopes: string[];
  /** Whether the provider supports/needs PKCE (S256). */
  usesPkce: boolean;
  /** Extra params appended to the authorize URL (provider-specific). */
  extraAuthorizeParams?(env: Env): Record<string, string>;
  /** Read client id/secret from env, or undefined if not configured. */
  credentials(env: Env): ProviderCredentials | undefined;
  /**
   * Forward a Notova recording/summary/transcript into the third party.
   * Network-gated by design; never called in tests.
   */
  export(
    connection: ProviderConnection,
    payload: IntegrationExport,
    env: Env
  ): Promise<IntegrationExportResult>;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

// Registry. Imported lazily-free here because provider modules only import
// types from this file, avoiding a circular value dependency.
import { google } from './google.js';
import { notion } from './notion.js';
import { slack } from './slack.js';
import { salesforce } from './salesforce.js';

export const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  google,
  notion,
  slack,
  salesforce,
};

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}
