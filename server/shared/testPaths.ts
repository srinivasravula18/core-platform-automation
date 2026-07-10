/**
 * Test-file exclusion for agent repo grounding.
 *
 * The agent must NEVER read or ground on the target repo's tests, test scripts, fixtures, mocks, or
 * snapshots — grounding on tests teaches the agent the test's expectations instead of the app's real
 * behavior. This is the single source of truth for "is this a test path?", applied at every place the
 * agent walks/greps/reads the repo (code search, file reads, selector scanning).
 */

/** Directory names that indicate test/spec/fixture territory (matched case-insensitively, any depth). */
export const TEST_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', '__mocks__', '__snapshots__', 'spec', 'specs',
  'e2e', 'cypress', 'playwright', '.playwright', 'playwright-report', 'test-results',
  'coverage', 'fixtures', 'testdata', 'test-data', 'mocks', 'stub', 'stubs',
  // Scripts folders are tooling/automation, not app behavior — excluded from agent grounding too.
  'scripts', 'script',
]);

/** File basenames that indicate a test/spec/story/mock/fixture file. */
const TEST_FILE_RE = /(?:^|[._-])(?:tests?|specs?|e2e|stories|story|mocks?|fixtures?|conftest)(?:[._-]|$)|\.(?:test|spec|e2e|stories|cy)\.[cm]?[jt]sx?$/i;

/** True if a repo-relative path lives in, or is itself, a test/spec/fixture artifact. */
export function isTestPath(pathValue: string | null | undefined): boolean {
  const norm = String(pathValue || '').replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '');
  if (!norm) return false;
  const segments = norm.split('/');
  // any directory segment (not the final basename) is a test dir
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (TEST_DIR_NAMES.has(segments[i])) return true;
  }
  const base = segments[segments.length - 1] || '';
  if (TEST_DIR_NAMES.has(base)) return true; // e.g. a bare "test" file/dir at the tail
  return TEST_FILE_RE.test(base);
}

/** Is a single directory name a test directory (for tree walkers that recurse dir-by-dir)? */
export function isTestDirName(name: string): boolean {
  return TEST_DIR_NAMES.has(String(name || '').toLowerCase());
}

/** git pathspecs that exclude test artifacts from `git grep` / `git ls-files`. */
export const GIT_TEST_EXCLUDES: string[] = [
  ':(exclude)**/*.test.*', ':(exclude)**/*.spec.*', ':(exclude)**/*.e2e.*',
  ':(exclude)**/*.stories.*', ':(exclude)**/*.cy.*',
  ':(exclude)**/test/**', ':(exclude)**/tests/**', ':(exclude)**/__tests__/**',
  ':(exclude)**/__mocks__/**', ':(exclude)**/__snapshots__/**', ':(exclude)**/spec/**',
  ':(exclude)**/e2e/**', ':(exclude)**/cypress/**', ':(exclude)**/playwright/**',
  ':(exclude)**/test-results/**', ':(exclude)**/coverage/**', ':(exclude)**/fixtures/**',
  ':(exclude)**/scripts/**', ':(exclude)scripts/**',
];
