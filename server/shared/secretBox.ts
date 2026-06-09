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

const DEV_KEY = 'testflowai-dev-key-do-not-use-in-prod';

let cachedKey: Buffer | null = null;
let usingDevKey = false;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  usingDevKey = !process.env.CRED_ENC_KEY;
  if (usingDevKey && !process.env.CRED_DEV_KEY_WARNING_SHOWN) {
    console.warn('[secretBox] CRED_ENC_KEY is not set — using a derived dev key. Stored secrets are NOT secure.');
    process.env.CRED_DEV_KEY_WARNING_SHOWN = '1';
  }
  cachedKey = scryptSync(process.env.CRED_ENC_KEY || DEV_KEY, 'testflowai-salt', 32);
  return cachedKey;
}

/** True when no real key is configured — stored secrets are effectively plaintext. */
export function isDevEncryptionKey(): boolean {
  getKey();
  return usingDevKey;
}

/** Encrypt a UTF-8 string into a self-describing `iv.cipher.tag` (base64) payload. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

/** Reverse of {@link encryptSecret}. Throws on a malformed or tampered payload. */
export function decryptSecret(payload: string): string {
  const [ivB64, encB64, tagB64] = String(payload || '').split('.');
  if (!ivB64 || !encB64 || !tagB64) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
