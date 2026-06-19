import { beforeEach, describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  encryptOptional,
  generateEncryptionKey,
  resetCryptoKeyCache,
} from '../src/modules/integrations/crypto.js';
import { resetEnvCache } from '../src/config/env.js';

function setEnv(key: string): void {
  process.env.NODE_ENV = 'test';
  process.env.TOKEN_ENCRYPTION_KEY = key;
  resetEnvCache();
  resetCryptoKeyCache();
}

// A genuinely 32-byte base64 key. (The scaffold's dev default decodes to 35
// bytes, which is invalid for AES-256 — see crypto.ts key()).
const VALID_B64_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('crypto: AES-256-GCM round-trip', () => {
  beforeEach(() => setEnv(VALID_B64_KEY));

  it('encrypts then decrypts back to the original plaintext', () => {
    const samples = ['hello', '', 'a'.repeat(5000), 'unicode 🎙️ café 会議', JSON.stringify({ a: 1 })];
    for (const s of samples) {
      const ct = encrypt(s);
      expect(decrypt(ct)).toBe(s);
    }
  });

  it('produces the iv.tag.ciphertext serialized format (3 base64 parts)', () => {
    const ct = encrypt('payload');
    const parts = ct.split('.');
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      // base64 — re-encoding the decoded bytes should match.
      expect(Buffer.from(p, 'base64').toString('base64')).toBe(p);
    }
  });

  it('is non-deterministic: same plaintext yields different ciphertext (random IV)', () => {
    const a = encrypt('same-plaintext');
    const b = encrypt('same-plaintext');
    expect(a).not.toBe(b);
    // But both decrypt back to the same value.
    expect(decrypt(a)).toBe('same-plaintext');
    expect(decrypt(b)).toBe('same-plaintext');
    // The IV segments must differ.
    expect(a.split('.')[0]).not.toBe(b.split('.')[0]);
  });

  it('encryptOptional passes through null/undefined and encrypts otherwise', () => {
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional(undefined)).toBeNull();
    const ct = encryptOptional('secret');
    expect(ct).toBeTruthy();
    expect(decrypt(ct as string)).toBe('secret');
  });
});

describe('crypto: tamper resistance', () => {
  beforeEach(() => setEnv(VALID_B64_KEY));

  it('fails to decrypt when the ciphertext is tampered', () => {
    const ct = encrypt('authentic message');
    const [iv, tag, data] = ct.split('.');
    const flipped = Buffer.from(data ?? '', 'base64');
    flipped[0] = flipped[0] === undefined ? 0 : flipped[0] ^ 0xff;
    const tampered = [iv, tag, flipped.toString('base64')].join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('fails to decrypt when the auth tag is tampered', () => {
    const ct = encrypt('authentic message');
    const [iv, tag, data] = ct.split('.');
    const flipped = Buffer.from(tag ?? '', 'base64');
    flipped[0] = flipped[0] === undefined ? 0 : flipped[0] ^ 0xff;
    const tampered = [iv, flipped.toString('base64'), data].join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on a malformed payload (wrong number of segments)', () => {
    expect(() => decrypt('only-one-part')).toThrow(/malformed/i);
    expect(() => decrypt('two.parts')).toThrow(/malformed/i);
  });
});

describe('crypto: key handling', () => {
  it('decryption fails with a different (wrong) key', () => {
    setEnv(VALID_B64_KEY);
    const ct = encrypt('cross-key message');
    // Switch to a different valid 32-byte key.
    setEnv(generateEncryptionKey());
    expect(() => decrypt(ct)).toThrow();
  });

  it('accepts a hex-encoded 32-byte key', () => {
    const hexKey = Buffer.from('b'.repeat(32)).toString('hex'); // 64 hex chars = 32 bytes
    setEnv(hexKey);
    const ct = encrypt('hex-key message');
    expect(decrypt(ct)).toBe('hex-key message');
  });

  it('throws a clear error for a key that is not 32 bytes', () => {
    setEnv('dG9vLXNob3J0'); // "too-short" -> 9 bytes
    expect(() => encrypt('x')).toThrow(/32 bytes/i);
  });

  it('generateEncryptionKey returns a base64 string decoding to 32 bytes', () => {
    const k = generateEncryptionKey();
    expect(Buffer.from(k, 'base64')).toHaveLength(32);
  });
});
