import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * AES-256-GCM encryption for OAuth tokens at rest. The serialized format is:
 *   base64(iv) "." base64(authTag) "." base64(ciphertext)
 * The key comes from TOKEN_ENCRYPTION_KEY (32 bytes, base64 or hex).
 */
const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env().TOKEN_ENCRYPTION_KEY;
  let buf: Buffer;
  // Try base64 first, then hex.
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) {
    buf = b64;
  } else {
    const hex = Buffer.from(raw, 'hex');
    if (hex.length === 32) {
      buf = hex;
    } else {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex). ' +
          `Got ${b64.length} bytes from base64 / ${hex.length} from hex.`
      );
    }
  }
  cachedKey = buf;
  return buf;
}

/** Encrypt a UTF-8 string. Returns the serialized "iv.tag.ciphertext" form. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypt the serialized "iv.tag.ciphertext" form back to a UTF-8 string. */
export function decrypt(serialized: string): string {
  const parts = serialized.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Encrypt only when a value is present; pass through null/undefined. */
export function encryptOptional(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  return encrypt(plaintext);
}

/** Reset the cached key (used by tests that swap TOKEN_ENCRYPTION_KEY). */
export function resetCryptoKeyCache(): void {
  cachedKey = undefined;
}

/** Generate a fresh 32-byte key as base64 (handy for ops / .env bootstrapping). */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}
