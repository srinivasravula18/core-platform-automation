/**
 * Per-project private-repo access tokens, encrypted at rest.
 *
 * Tokens are kept in `db.repoSecrets` (projectId -> ciphertext) — deliberately
 * NOT on the Project record, which is serialized to the API. Nothing here is ever
 * returned to the client; callers that need to reach the repo ask for the
 * decrypted token at the point of use (e.g. a `git` invocation) and discard it.
 */

import { db, persistDataInBackground } from '../../shared/storage';
import { encryptSecret, decryptSecret } from '../../shared/secretBox';

function store(): Record<string, string> {
  if (!db.repoSecrets || typeof db.repoSecrets !== 'object') db.repoSecrets = {};
  return db.repoSecrets as Record<string, string>;
}

/** Store (or replace) a project's repo access token. Empty token clears it. */
export function setRepoToken(projectId: string, token: string): void {
  const t = String(token || '').trim();
  if (!t) return clearRepoToken(projectId);
  store()[projectId] = encryptSecret(t);
  persistDataInBackground('set repo token');
}

/** Decrypt and return a project's token, or null if none is stored / undecryptable. */
export function getRepoToken(projectId: string): string | null {
  const enc = store()[projectId];
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    // Wrong/rotated key, or corrupted payload — treat as no usable token.
    return null;
  }
}

/** Whether a token is on file for the project (without decrypting it). */
export function hasRepoToken(projectId: string): boolean {
  return Boolean(store()[projectId]);
}

/** Remove a project's stored token (e.g. on delete or explicit clear). */
export function clearRepoToken(projectId: string): void {
  if (!store()[projectId]) return;
  delete store()[projectId];
  persistDataInBackground('clear repo token');
}
