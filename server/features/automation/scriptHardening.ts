/**
 * Record & Play — codegen login hardening.
 *
 * The app under test holds its auth as an in-memory `Bearer` token (verified in the app bundle: the
 * token is a JS variable passed to `Authorization: Bearer ...` — it is NOT in a cookie, localStorage or
 * sessionStorage). Two consequences drive this transform:
 *
 *   1. A full-page `page.goto()` AFTER login WIPES the in-memory token (fresh JS heap), so the app boots
 *      unauthenticated and falls back to the login page — even though login just succeeded. `codegen`
 *      records the URL the user visits as a literal `page.goto(...)`, which is exactly this footgun, and
 *      it does so for EVERY navigation, not just the first. The app itself client-side-navigates between
 *      its routes, so we convert every post-login same-origin `page.goto(url)` into `page.waitForURL(url)`
 *      — sync to the app's own SPA navigation instead of reloading, keeping the token alive. (Cross-origin
 *      gotos are genuine navigations and are left alone.)
 *
 *   2. `codegen` often records the login submit twice (a password `press('Enter')` AND a "Sign in"
 *      click — both submit the same form). On replay the second waits 60s for a control that's gone. We
 *      collapse it to a single submit.
 *
 * When there is no post-login goto to sync on, we instead wait for the login form to disappear before
 * the next action (a URL-stable, cookie-free SPA has no reliable `waitForURL` target otherwise). We
 * never emit `waitForLoadState('networkidle')` — it is officially discouraged and hangs. Idempotent.
 */

const LOGIN_SUBMIT_NAME = /\b(sign\s*in|log\s*in|login|log\s*on|sign\s*on|submit)\b/i;

const CLICK_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.click\(\s*\)\s*;?\s*$/;
const ENTER_RE = /^(\s*)await\s+(page\.[\s\S]*?)\.press\(\s*['"`]Enter['"`]\s*\)\s*;?\s*$/;
const GOTO_RE = /^(\s*)await\s+page\.goto\(\s*(['"`])([^'"`]+)\2\s*\)\s*;?\s*$/;
const ACTION_ON_RE = /^\s*await\s+(page\.[\s\S]*?)\.(?:fill|press|click|type)\(/;

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

function nextMeaningful(lines: string[], i: number): number {
  for (let j = i; j < lines.length; j++) if (lines[j].trim()) return j;
  return -1;
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Collapse a codegen login double-submit, and make every post-login navigation safe for an
 * in-memory-token SPA: convert each same-origin `page.goto` after login into `waitForURL`, or (if there
 * is none) wait for the login form to disappear before the next action. Unchanged when there's no login.
 */
export function hardenRecordedScript(script: string): string {
  if (!script || typeof script !== 'string') return script;
  const lines = script.split('\n');

  // Fallback "form gone" anchor when there's no submit button click.
  let passwordExpr = '';
  for (const l of lines) {
    const m = l.match(ACTION_ON_RE);
    if (m && isPasswordExpr(m[1])) { passwordExpr = m[1]; break; }
  }

  // First login-submit action: prefer a "Sign in" button click, else a password Enter.
  let clickIdx = -1, clickIndent = '', clickExpr = '';
  let enterIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].match(CLICK_RE);
    if (c && LOGIN_SUBMIT_NAME.test(locatorName(c[2]))) { clickIdx = i; clickIndent = c[1]; clickExpr = c[2]; break; }
    const e = lines[i].match(ENTER_RE);
    if (e && isPasswordExpr(e[2]) && enterIdx === -1) enterIdx = i;
  }
  if (clickIdx === -1 && enterIdx === -1) return script; // no login → nothing to harden

  const canonicalIdx = clickIdx !== -1 ? clickIdx : enterIdx;
  const canonicalIndent = clickIdx !== -1 ? clickIndent : (lines[enterIdx].match(ENTER_RE)?.[1] || '');
  // Redundant password Enter to drop (the Enter that sits right before the explicit Sign in click).
  let dropIdx = -1;
  if (clickIdx !== -1 && enterIdx !== -1 && enterIdx < clickIdx && nextMeaningful(lines, enterIdx + 1) === clickIdx) dropIdx = enterIdx;

  // The app origin is the first goto's origin (the pre-login entry load, or the first in-app navigation
  // if the recording started already on the login screen); only same-origin gotos route in-app.
  let appOrigin: string | null = null;
  for (const l of lines) {
    const g = l.match(GOTO_RE);
    if (g) { appOrigin = originOf(g[3]); break; }
  }

  // Every post-login same-origin goto becomes a waitForURL (a hard reload would drop the token).
  const convertIdx = new Set<number>();
  for (let i = canonicalIdx + 1; i < lines.length; i++) {
    const g = lines[i].match(GOTO_RE);
    if (g && appOrigin && originOf(g[3]) === appOrigin) convertIdx.add(i);
  }

  // Guard only when the first post-login step is a plain action (not a goto we already convert to a wait).
  const afterIdx = nextMeaningful(lines, canonicalIdx + 1);
  const guardAnchor = clickIdx !== -1 ? clickExpr : passwordExpr;
  const guardNeeded = afterIdx !== -1 && /^\s*await\s/.test(lines[afterIdx]) && !isWait(lines[afterIdx]) && !convertIdx.has(afterIdx) && !!guardAnchor;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === dropIdx) continue; // redundant Enter — the explicit Sign in click submits

    if (convertIdx.has(i)) {
      const g = lines[i].match(GOTO_RE)!;
      out.push(`${g[1]}await page.waitForURL(${g[2]}${g[3]}${g[2]}); // app routes here client-side; a hard goto would drop the in-memory auth token`);
      continue;
    }

    out.push(lines[i]);

    if (guardNeeded && i === canonicalIdx) {
      out.push(`${canonicalIndent}await ${guardAnchor}.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {}); // wait for login to complete before continuing`);
    }
  }

  return out.join('\n');
}
