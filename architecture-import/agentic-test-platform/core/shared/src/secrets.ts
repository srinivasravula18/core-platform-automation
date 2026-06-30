/**
 * Secret-handle resolver + redactor.
 *
 * The LLM and generated scripts NEVER see real secrets — they reference creds by handle
 * (`${CRED_LOGIN_USER}`). The worker resolves handles to real values at execution time only,
 * and redacts those values out of any evidence/logs before they are persisted.
 *
 * ponytail: a regex substitution + a value-blacklist redactor. No vault SDK until a real
 * KMS is wired (envelope encryption lives in packages/db; this is the runtime substitution).
 */

const HANDLE_RE = /\$\{(CRED_[A-Z0-9_]+)\}/g;

/** Replace `${CRED_X}` handles with real values. Throws if a referenced handle is missing. */
export function resolveHandles(input: string, secrets: Record<string, string>): string {
  return input.replace(HANDLE_RE, (_m, name: string) => {
    const v = secrets[name];
    if (v === undefined) throw new Error(`Unresolved secret handle: ${name}`);
    return v;
  });
}

/** True if the text still contains an unresolved handle (use to assert pre-persist safety). */
export function hasUnresolvedHandle(input: string): boolean {
  HANDLE_RE.lastIndex = 0;
  return HANDLE_RE.test(input);
}

const DEFAULT_HEADER_KEYS = ["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"];

/**
 * Redact real secret values + sensitive header values from a string before persisting it.
 * Pass the actual secret values (the resolved ones) so we never leak them into evidence.
 */
export function redact(
  input: string,
  secretValues: string[] = [],
  headerKeys: string[] = DEFAULT_HEADER_KEYS,
): string {
  let out = input;
  // 1) blacklist the literal secret values (longest first so substrings don't escape).
  for (const v of [...secretValues].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join("***REDACTED***");
  }
  // 2) header-style `Key: value` lines for known sensitive headers.
  for (const key of headerKeys) {
    const re = new RegExp(`(^|\\n)(\\s*${key}\\s*:\\s*)([^\\n]+)`, "gi");
    out = out.replace(re, (_m, pre, label) => `${pre}${label}***REDACTED***`);
  }
  return out;
}
