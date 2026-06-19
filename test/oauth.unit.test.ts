import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  generatePkce,
  generateState,
  buildRedirectUri,
  buildAuthorizeUrl,
} from '../src/modules/integrations/oauth.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { getProvider, isProviderId, PROVIDER_IDS } from '../src/modules/integrations/providers/index.js';

function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv);
}

describe('oauth: PKCE generation (RFC 7636, S256)', () => {
  it('produces a verifier and an S256 challenge that hashes correctly', () => {
    const pkce = generatePkce();
    expect(pkce.method).toBe('S256');
    expect(pkce.verifier).toBeTruthy();
    expect(pkce.challenge).toBeTruthy();
    // challenge == base64url(sha256(verifier))
    const expected = createHash('sha256').update(pkce.verifier).digest('base64url');
    expect(pkce.challenge).toBe(expected);
    // verifier length within RFC bounds (43-128 chars for base64url of 32 bytes ~ 43).
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.verifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet only.
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique verifiers/challenges each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('oauth: state generation', () => {
  it('generates non-empty, unique, url-safe state values', () => {
    const states = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const s = generateState();
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      states.add(s);
    }
    expect(states.size).toBe(50);
  });
});

describe('oauth: redirect URI builder', () => {
  it('builds a per-provider callback URI under PUBLIC_BASE_URL', () => {
    const env = envWith({ PUBLIC_BASE_URL: 'https://api.notova.app' });
    expect(buildRedirectUri(env, 'google')).toBe(
      'https://api.notova.app/v1/integrations/google/callback'
    );
  });

  it('trims trailing slashes from PUBLIC_BASE_URL', () => {
    const env = envWith({ PUBLIC_BASE_URL: 'https://api.notova.app///' });
    expect(buildRedirectUri(env, 'slack')).toBe(
      'https://api.notova.app/v1/integrations/slack/callback'
    );
  });
});

describe('oauth: authorize URL builder', () => {
  it('throws a clear 400 when credentials are missing', () => {
    const env = envWith();
    const provider = getProvider('google');
    expect(() =>
      buildAuthorizeUrl({
        provider,
        env,
        state: 's',
        redirectUri: 'https://api/callback',
        pkce: generatePkce(),
      })
    ).toThrowError(/not configured/i);
  });

  it('builds a complete PKCE authorize URL when creds are present', () => {
    const env = envWith({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
    const provider = getProvider('google');
    const pkce = generatePkce();
    const redirectUri = 'https://api.notova.app/v1/integrations/google/callback';
    const url = new URL(
      buildAuthorizeUrl({ provider, env, state: 'state-xyz', redirectUri, pkce })
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('drive.file');
    // Google extra params.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('omits PKCE params when the provider does not use PKCE (notion)', () => {
    const env = envWith({ NOTION_CLIENT_ID: 'cid', NOTION_CLIENT_SECRET: 'sec' });
    const provider = getProvider('notion');
    const url = new URL(
      buildAuthorizeUrl({
        provider,
        env,
        state: 's',
        redirectUri: 'https://api/callback',
        // even if a pkce is passed, notion.usesPkce is false -> not appended
        pkce: generatePkce(),
      })
    );
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
    expect(url.searchParams.get('owner')).toBe('user');
    // notion has no scopes -> no scope param.
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('drops empty extra-authorize params (slack user_scope="")', () => {
    const env = envWith({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
    const provider = getProvider('slack');
    const url = new URL(
      buildAuthorizeUrl({
        provider,
        env,
        state: 's',
        redirectUri: 'https://api/callback',
        pkce: generatePkce(),
      })
    );
    // user_scope is '' so it should be omitted.
    expect(url.searchParams.has('user_scope')).toBe(false);
    expect(url.searchParams.get('scope')).toContain('chat:write');
  });

  it('uses the configured Salesforce login URL for the authorize endpoint', () => {
    const env = envWith({
      SALESFORCE_CLIENT_ID: 'cid',
      SALESFORCE_CLIENT_SECRET: 'sec',
      SALESFORCE_LOGIN_URL: 'https://test.salesforce.com',
    });
    const provider = getProvider('salesforce');
    const url = new URL(
      buildAuthorizeUrl({
        provider,
        env,
        state: 's',
        redirectUri: 'https://api/callback',
        pkce: generatePkce(),
      })
    );
    expect(url.origin + url.pathname).toBe('https://test.salesforce.com/services/oauth2/authorize');
  });
});

describe('oauth: provider registry', () => {
  it('isProviderId recognizes exactly the four known providers', () => {
    expect(PROVIDER_IDS).toEqual(['google', 'notion', 'slack', 'salesforce']);
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
    for (const bad of ['dropbox', 'github', '', 'GOOGLE']) expect(isProviderId(bad)).toBe(false);
  });

  it('each provider exposes a consistent shape', () => {
    for (const id of PROVIDER_IDS) {
      const p = getProvider(id);
      expect(p.id).toBe(id);
      expect(typeof p.label).toBe('string');
      expect(typeof p.usesPkce).toBe('boolean');
      expect(Array.isArray(p.scopes)).toBe(true);
      expect(typeof p.authorizeEndpoint(envWith())).toBe('string');
      expect(typeof p.tokenEndpoint(envWith())).toBe('string');
    }
  });
});
