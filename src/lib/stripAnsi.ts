/**
 * Strip ANSI escape / SGR color codes from text.
 *
 * Playwright's error messages are terminal-formatted — e.g. `expect(locator).toBeVisible()`
 * arrives wrapped in dim/red codes (ESC[2m … ESC[31m …). Rendered as-is in the browser those
 * codes leak as unreadable noise like `[2mexpect[22m[31mlocator…`. Strip them so the run-results
 * UI shows plain, QA-readable text.
 */
// Pattern is built from string escapes so this source file stays pure ASCII (no raw ESC bytes).
// Matches a CSI sequence: introducer (ESC-[ or 8-bit CSI), optional numeric/`?` params, single
// letter terminator — covers the SGR color codes Playwright emits plus cursor moves.
const ANSI_PATTERN = new RegExp('[\\u001B\\u009B]\\[[0-9;?]*[A-Za-z]', 'g');

export function stripAnsi(input: unknown): string {
  return String(input ?? '').replace(ANSI_PATTERN, '');
}
