import type { Env } from '../../../config/env.js';
import { notImplemented } from '../../../lib/errors.js';
import type { OAuthProvider } from './index.js';

/**
 * Slack integration. OAuth2 v2 authorization code + PKCE. Export (e.g. posting
 * a summary message to a channel) is not implemented yet but keeps the uniform
 * shape.
 */
export const slack: OAuthProvider = {
  id: 'slack',
  label: 'Slack',
  scopes: ['chat:write', 'channels:read'],
  usesPkce: true,
  authorizeEndpoint: () => 'https://slack.com/oauth/v2/authorize',
  tokenEndpoint: () => 'https://slack.com/api/oauth.v2.access',
  // Slack uses `user_scope` for user tokens; bot scopes go in the standard `scope`.
  extraAuthorizeParams: () => ({ user_scope: '' }),
  credentials(env: Env) {
    if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return undefined;
    return { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET };
  },
  async export() {
    throw notImplemented(
      'Slack export is not implemented yet. The Slack integration supports connect/disconnect; channel posting is planned.'
    );
  },
};
