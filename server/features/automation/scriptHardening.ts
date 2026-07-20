/**
 * Record & Play — codegen script hardening.
 *
 * `playwright codegen` emits click-without-wait plus literal `page.goto(...)` calls. After a login
 * submit this races the app's own post-login redirect: the click only *dispatches*, then the next
 * `goto` (or post-login action) fires before the auth cookie/token is set, so the app bounces back to
 * the sign-in page and every later step times out. See the Executions incident (job bounced to the
 * "Sign in" page, `New` button never appeared → 60s timeout).
 *
 * This transform runs once when a recording is finalized. For each login-submit action it inserts a
 * settle wait so authentication completes before the script moves on. It is app-agnostic (it reuses
 * whatever locator codegen produced) and idempotent (re-hardening a hardened script is a no-op).
 */

// Accessible-name fragments that mark a login submit control (button click).
const LOGIN_SUBMIT_NAME = /\b(sign\s*in|log\s*in|login|log\s*on|sign\s*on|submit)\b/i;

// A codegen click line: `  await page.getByRole('button', { name: 'Sign in' }).click();`
const CLICK_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.click\(\s*\)\s*;?\s*$/;
// A codegen Enter-submit line: `  await page.getByRole('textbox', { name: 'Password' }).press('Enter');`
const ENTER_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.press\(\s*['"`]Enter['"`]\s*\)\s*;?\s*$/;

// Extract the accessible name from a locator expression, if it carries one.
function locatorName(expr: string): string | null {
  const m = expr.match(/name:\s*['"`]([^'"`]*)['"`]/) || expr.match(/getByText\(\s*['"`]([^'"`]*)['"`]/) || expr.match(/getByLabel\(\s*['"`]([^'"`]*)['"`]/);
  return m ? m[1] : null;
}

// Already a wait line we (or the user) may have inserted — used to keep the transform idempotent.
function isWait(line: string): boolean {
  return /\.waitFor\(|waitForURL\(|waitForLoadState\(/.test(line);
}

/**
 * Insert a post-login settle wait after each login-submit action that is immediately followed by
 * another statement. Returns the script unchanged when there is nothing to harden.
 */
export function hardenRecordedScript(script: string): string {
  if (!script || typeof script !== 'string') return script;
  const lines = script.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    // The next meaningful (non-blank) line and whether a following action exists.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = j < lines.length ? lines[j] : '';
    const hasFollowingAction = /^\s*await\s+page\./.test(next);
    if (!hasFollowingAction || isWait(next)) continue; // nothing to guard, or already guarded

    const click = line.match(CLICK_RE);
    if (click && LOGIN_SUBMIT_NAME.test(locatorName(click[2]) || '')) {
      // Wait for the submit control to detach — the login form is gone once auth completed.
      out.push(`${click[1]}await ${click[2]}.waitFor({ state: 'detached' }).catch(() => {}); // wait for login to complete before continuing`);
      continue;
    }

    const enter = line.match(ENTER_RE);
    if (enter && /password/i.test(locatorName(enter[2]) || '')) {
      // No button locator to detach on; let the login request + redirect settle instead.
      out.push(`${enter[1]}await page.waitForLoadState('networkidle').catch(() => {}); // let login settle before continuing`);
      continue;
    }
  }

  return out.join('\n');
}
