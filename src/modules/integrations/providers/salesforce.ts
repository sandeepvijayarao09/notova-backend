import type { Env } from '../../../config/env.js';
import { notImplemented } from '../../../lib/errors.js';
import type { OAuthProvider } from './index.js';

/**
 * Salesforce integration. OAuth2 authorization code + PKCE against the
 * configured login URL (production or a sandbox). Export (e.g. creating a Note
 * or Task record) is not implemented yet but keeps the uniform shape.
 */
export const salesforce: OAuthProvider = {
  id: 'salesforce',
  label: 'Salesforce',
  scopes: ['api', 'refresh_token'],
  usesPkce: true,
  authorizeEndpoint: (env: Env) =>
    `${trimSlash(env.SALESFORCE_LOGIN_URL)}/services/oauth2/authorize`,
  tokenEndpoint: (env: Env) => `${trimSlash(env.SALESFORCE_LOGIN_URL)}/services/oauth2/token`,
  credentials(env: Env) {
    if (!env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_CLIENT_SECRET) return undefined;
    return { clientId: env.SALESFORCE_CLIENT_ID, clientSecret: env.SALESFORCE_CLIENT_SECRET };
  },
  async export() {
    throw notImplemented(
      'Salesforce export is not implemented yet. The Salesforce integration supports connect/disconnect; record creation is planned.'
    );
  },
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
