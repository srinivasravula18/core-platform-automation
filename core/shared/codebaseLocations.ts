/**
 * Repo locations are internal grounding, never reader-facing: agent output must not display codebase
 * file paths, filenames, line numbers, or repo directories. Raw css/test selectors are internals for
 * the same reason. One definition shared by every boundary that enforces it (the Agent Console answer
 * sanitizer and the requirements/SRS renderer), so they can never drift apart.
 */

/** A rooted path — `apps/service/src/auth/routes.ts`, `./src/x.tsx:12-20`, `C:\repo\file.ts`. */
export const CODEBASE_PATH_REF =
  /(?:^|[\s(;])(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]?(?:apps|server|src|tests?|docs|seeds|packages|api|lib|components|hooks|pages|shared|client|services|e2e|unit|features|db|scripts)[\\/])[\w./\\@-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;

/** A bare filename — `routes.ts`, `schema.sql:120-140`. */
export const BARE_FILE_REF =
  /(?:^|[\s(;])[\w.-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;

/**
 * A raw selector — `#create-app-parent`, `.admin-app-detail-section`, `[data-testid=…]`. The class form
 * requires a hyphen: requirements legitimately discuss extensions (".png, .pdf"), and a bare `.word`
 * cannot be told from prose, so only the hyphenated convention counts as a selector.
 */
export const RAW_SELECTOR_REF = /(?:^|[\s(["'])(?:#[a-z][\w-]*|\.[a-z][\w]*-[\w-]+)\b|\[(?:data|aria)-[\w-]+/gi;

/**
 * Does this text name a repo location (or, with `selectors`, a raw selector)? Used to DROP a whole
 * citation or line, where rewriting the sentence around the token would leave nonsense.
 * Matchers are rebuilt per call — the exported ones are global, and `/g` makes `.test()` stateful.
 */
export function namesCodebaseLocation(text: string, opts: { selectors?: boolean } = {}): boolean {
  const value = String(text || '');
  const once = (re: RegExp) => new RegExp(re.source, re.flags.replace('g', ''));
  if (once(CODEBASE_PATH_REF).test(value) || once(BARE_FILE_REF).test(value)) return true;
  return Boolean(opts.selectors) && once(RAW_SELECTOR_REF).test(value);
}
