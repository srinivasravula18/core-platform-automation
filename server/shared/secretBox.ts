/**
 * Symmetric secret encryption for values stored at rest (e.g. private-repo
 * access tokens). AES-256-GCM with a key derived from `CRED_ENC_KEY`.
 *
 * The key is derived lazily, on first encrypt/decrypt — NOT at module load.
 * `server.ts` calls `dotenv.config()` after its imports are evaluated, so a
 * module-load-time read of `process.env.CRED_ENC_KEY` would miss `.env.local`
 * and silently fall back to the dev key. First use happens at request time,
 * after env is loaded, so the real key is picked up.
 *
 * If `CRED_ENC_KEY` is unset we fall back to a well-known dev key and warn once.
 * Anything encrypted with that fallback is, in practice, plaintext —
 * `isDevEncryptionKey()` lets callers surface that.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const LEGACY_REPO_DEV_KEY = 'testflowai-dev-key-do-not-use-in-prod';
const LEGACY_CREDENTIAL_DEV_KEY = '680c8f5b27b19f4d01e18065bffb2b365bf90e95cc4051ba6c168f41cf64ad10';
const VERSION = 'v2';

let cachedCanonicalKey: Buffer | null = null;
let cachedRepoLegacyKey: Buffer | null = null;
let usingDevKey = false;

function canonicalKey(): Buffer {
  if (cachedCanonicalKey) return cachedCanonicalKey;
  usingDevKey = !process.env.CRED_ENC_KEY;
  if (usingDevKey && !process.env.CRED_DEV_KEY_WARNING_SHOWN) {
    console.warn('[secretBox] CRED_ENC_KEY is not set — using a derived dev key. Stored secrets are NOT secure.');
    process.env.CRED_DEV_KEY_WARNING_SHOWN = '1';
  }
  cachedCanonicalKey = scryptSync(
    process.env.CRED_ENC_KEY || LEGACY_CREDENTIAL_DEV_KEY,
    process.env.CRED_ENC_SALT || '',
    32,
  );
  return cachedCanonicalKey;
}

function repoLegacyKey(): Buffer {
  if (!cachedRepoLegacyKey) {
    cachedRepoLegacyKey = scryptSync(
      process.env.CRED_ENC_KEY || LEGACY_REPO_DEV_KEY,
      'testflowai-salt',
      32,
    );
  }
  return cachedRepoLegacyKey;
}

/** True when no real key is configured — stored secrets are effectively plaintext. */
export function isDevEncryptionKey(): boolean {
  canonicalKey();
  return usingDevKey;
}

/** Encrypt a UTF-8 string into a versioned `v2.iv.cipher.tag` payload. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', canonicalKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

function decryptWithKey(parts: string[], key: Buffer): string {
  const [ivB64, encB64, tagB64] = parts;
  if (!ivB64 || !encB64 || !tagB64) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Reverse of {@link encryptSecret}; also reads both historical unversioned formats. */
export function decryptSecret(payload: string): string {
  const parts = String(payload || '').split('.');
  if (parts[0] === VERSION) {
    if (parts.length !== 4) throw new Error('Invalid encrypted payload');
    return decryptWithKey(parts.slice(1), canonicalKey());
  }
  if (parts.length !== 3) throw new Error('Invalid encrypted payload');
  for (const key of [canonicalKey(), repoLegacyKey()]) {
    try { return decryptWithKey(parts, key); } catch { /* try the other legacy derivation */ }
  }
  throw new Error('Secret could not be decrypted with the configured key');
}
