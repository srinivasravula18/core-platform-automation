/**
 * Record & Play — codegen login hardening.
 *
 * `playwright codegen` records raw actions with no wait for the post-login redirect, and often records
 * the login submit TWICE (a password `press('Enter')` AND a click on the "Sign in" button — both submit
 * the same form). On replay this breaks two ways:
 *
 *   1. Double submit: `press('Enter')` submits and the app leaves the login screen, so the following
 *      redundant `getByRole('button', { name: 'Sign in' }).click()` waits 60s for a button that's gone.
 *   2. Redirect race: `.click()` only *dispatches*; the next `page.goto(appUrl)` does a full reload
 *      before the auth cookie is set, so the app boots unauthenticated and bounces back to the login
 *      page — every later step then times out (the Executions incident).
 *
 * The app under test is a client-guarded SPA with an httpOnly session cookie: the URL does NOT change
 * on login (an unauthenticated deep link still renders the login form), so `waitForURL` is useless here
 * and `waitForLoadState('networkidle')` is officially discouraged (it hangs on apps that never idle).
 * The reliable, app-agnostic "login is done" signal is therefore: the login form has disappeared.
 *
 * This transform runs once at recording finalization. It collapses the double submit and inserts a
 * single wait for the submit control (or password field) to become hidden before the script continues.
 * It is idempotent — re-hardening a hardened script is a no-op.
 */

// Accessible-name fragments that mark a login submit control.
const LOGIN_SUBMIT_NAME = /\b(sign\s*in|log\s*in|login|log\s*on|sign\s*on|submit)\b/i;

const CLICK_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.click\(\s*\)\s*;?\s*$/;
const ENTER_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.press\(\s*['"`]Enter['"`]\s*\)\s*;?\s*$/;
const ACTION_ON_RE = /^\s*await\s+(page\.[\s\S]*?)\.(?:fill|press|click|type)\(/;

// Extract the accessible name / label / text from a locator expression, if it carries one.
function locatorName(expr: string): string {
  const m = expr.match(/name:\s*['"`]([^'"`]*)['"`]/) || expr.match(/getByText\(\s*['"`]([^'"`]*)['"`]/) || expr.match(/getByLabel\(\s*['"`]([^'"`]*)['"`]/);
  return m ? m[1] : '';
}

function isPasswordExpr(expr: string): boolean {
  return /password/i.test(locatorName(expr)) || /input\[[^\]]*type=['"`]?password/i.test(expr) || /getByLabel\(\s*['"`][^'"`]*password/i.test(expr);
}

function isWait(line: string): boolean {
  return /\.waitFor\(|waitForURL\(|waitForLoadState\(/.test(line);
}

// Index of the next non-blank line at or after i, or -1.
function nextMeaningful(lines: string[], i: number): number {
  for (let j = i; j < lines.length; j++) if (lines[j].trim()) return j;
  return -1;
}

/**
 * Collapse a codegen login double-submit and insert a single "wait until the login form is gone"
 * guard before the script proceeds. Returns the script unchanged when there is no login to harden.
 */
export function hardenRecordedScript(script: string): string {
  if (!script || typeof script !== 'string') return script;
  const lines = script.split('\n');

  // The password locator (used as the fallback "form gone" anchor when there's no submit button click).
  let passwordExpr = '';
  for (const l of lines) {
    const m = l.match(ACTION_ON_RE);
    if (m && isPasswordExpr(m[1])) { passwordExpr = m[1]; break; }
  }

  // Locate the first login-submit action (button click preferred; else a password Enter).
  let clickIdx = -1, clickIndent = '', clickExpr = '';
  let enterIdx = -1, enterIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].match(CLICK_RE);
    if (c && LOGIN_SUBMIT_NAME.test(locatorName(c[2]))) { clickIdx = i; clickIndent = c[1]; clickExpr = c[2]; break; }
    const e = lines[i].match(ENTER_RE);
    if (e && isPasswordExpr(e[2]) && enterIdx === -1) { enterIdx = i; enterIndent = e[1]; }
  }
  // A password Enter that appears just before the button click is the redundant one — drop it.
  if (clickIdx === -1 && enterIdx === -1) return script; // no login submit → nothing to harden

  const out: string[] = [];
  let guardInserted = false;

  for (let i = 0; i < lines.length; i++) {
    // Drop a redundant password `press('Enter')` that sits adjacent to the login-button click.
    if (clickIdx !== -1) {
      const e = lines[i].match(ENTER_RE);
      if (e && isPasswordExpr(e[2])) {
        const nxt = nextMeaningful(lines, i + 1);
        const prv = out.length ? out[out.length - 1] : '';
        const adjacentToClick = (nxt !== -1 && CLICK_RE.test(lines[nxt]) && LOGIN_SUBMIT_NAME.test(locatorName(lines[nxt].match(CLICK_RE)![2]))) ||
                                (CLICK_RE.test(prv) && LOGIN_SUBMIT_NAME.test(locatorName((prv.match(CLICK_RE) || [,''])[2] || '')));
        if (adjacentToClick) continue; // redundant with the explicit Sign in click → remove
      }
    }

    out.push(lines[i]);

    // After the canonical submit, insert one guard that waits for the login form to disappear.
    if (!guardInserted) {
      const isCanonicalClick = clickIdx !== -1 && i === clickIdx;
      const isCanonicalEnter = clickIdx === -1 && i === enterIdx;
      if (isCanonicalClick || isCanonicalEnter) {
        const nxt = nextMeaningful(lines, i + 1);
        // Only guard when a real action follows (that's what would race the login); a trailing
        // submit with nothing after it needs no wait.
        if (nxt !== -1 && /^\s*await\s/.test(lines[nxt]) && !isWait(lines[nxt])) {
          const indent = isCanonicalClick ? clickIndent : enterIndent;
          const anchor = isCanonicalClick ? clickExpr : (passwordExpr || clickExpr);
          if (anchor) {
            out.push(`${indent}await ${anchor}.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {}); // wait for login to complete before continuing`);
          }
        }
        guardInserted = true;
      }
    }
  }

  return out.join('\n');
}
