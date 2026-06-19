import argon2 from 'argon2';

/**
 * Password hashing isolated behind a tiny interface. We use argon2id. If a
 * deployment cannot build argon2's native addon, swap the two functions below
 * for a bcryptjs implementation — the rest of the codebase is agnostic.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
