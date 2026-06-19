import type { Env } from '../../../config/env.js';
import { notImplemented } from '../../../lib/errors.js';
import type { OAuthProvider } from './index.js';

/**
 * Google integration. OAuth2 authorization code + PKCE. Export (e.g. creating a
 * Google Doc / Drive file) is not implemented yet but keeps the uniform shape.
 */
export const google: OAuthProvider = {
  id: 'google',
  label: 'Google',
  scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/documents',
  ],
  usesPkce: true,
  authorizeEndpoint: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: () => 'https://oauth2.googleapis.com/token',
  // access_type=offline + prompt=consent ensures a refresh token is returned.
  extraAuthorizeParams: () => ({ access_type: 'offline', prompt: 'consent' }),
  credentials(env: Env) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return undefined;
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  },
  async export() {
    throw notImplemented(
      'Google export is not implemented yet. The Google integration supports connect/disconnect; document export is planned.'
    );
  },
};
