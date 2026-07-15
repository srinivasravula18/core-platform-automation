/**
 * Discovery node — second node of the discovery/grounding subgraph (Phase 3).
 *
 * Consolidates the legacy TWO-browser-session discovery (inspectApplicationFlow +
 * exploreAndVerifyPage, each authenticating independently) into exactly ONE session via
 * `withPageSession`. Owns only its own bounded result — writing into `WorkflowState.evidence`
 * is grounding.ts's job (built next), not this node's.
 *
 * Retries happen at exactly one layer (the graph's node policy, per workflow/errors.ts) — this
 * node never retries itself, it only classifies and returns a WorkflowError for the caller to act on.
 */
import { withPageSession, sessionArtifacts } from '../../pageSession';
import { collectPageContext } from '../../inspectionService';
import { captureVerifiedElementsForOpenPage, type VerifiedElement } from '../../domExplorer';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { MissionRef } from '../state';

export interface RunDiscoveryNodeInput {
  mission: MissionRef | null;
  /** Mirrors pageSession.ts's `credentials?: any` passthrough — only username/password are actually read (performLoginIfCredentialsProvided), token is carried for parity with other nodes' credential shape. */
  credential?: { username?: string; password?: string; token?: string };
  runId: string;
  maxElements?: number;
  /** Run-scoped pre-authenticated state (workflow/authSession) — the in-session login then no-ops, so
   * rediscovery attempts never repeat a real login. */
  auth?: { storageStatePath?: string; sessionStorageState?: { origin: string; items: Record<string, string> } };
}

export interface DiscoveryPageSummary {
  url: string;
  title: string;
  headingCount: number;
  tableCount: number;
  formCount: number;
  bodyTextExcerpt: string;
}

export interface RunDiscoveryNodeResult {
  /** Primary evidence: live-verified, deduped, ranked — captureVerifiedElementsForOpenPage's output is already bounded/typed. */
  elements: VerifiedElement[];
  pageSummary: DiscoveryPageSummary;
  screenshotRef: string | null;
  errors: WorkflowError[];
}

const EMPTY_PAGE_SUMMARY: DiscoveryPageSummary = { url: '', title: '', headingCount: 0, tableCount: 0, formCount: 0, bodyTextExcerpt: '' };

function emptyResult(errors: WorkflowError[]): RunDiscoveryNodeResult {
  return { elements: [], pageSummary: EMPTY_PAGE_SUMMARY, screenshotRef: null, errors };
}

/** Bounded summary from the richer collectPageContext blob — counts/excerpt only, never the full actions/forms/tables lists. */
function summarizePageContext(ctx: any): DiscoveryPageSummary {
  return {
    url: String(ctx?.url || ''),
    title: String(ctx?.title || ''),
    headingCount: Array.isArray(ctx?.headings) ? ctx.headings.length : 0,
    tableCount: Array.isArray(ctx?.tables) ? ctx.tables.length : 0,
    formCount: Array.isArray(ctx?.forms) ? ctx.forms.length : 0,
    bodyTextExcerpt: String(ctx?.bodyText || '').slice(0, 600),
  };
}

/** Bounded, secret-free head of a raw error for diagnostics — enough to tell 429/net::ERR/goto apart.
 * Strips ANSI codes and Playwright's multi-line "Call log:" tail so the reason renders cleanly in the UI. */
function boundedReason(message: string): { reason: string } {
  const clean = message
    .replace(/\[[0-9;]*m/g, '')
    .split(/\r?\n\s*Call log:/i)[0]
    .replace(/\s+/g, ' ')
    .replace(/password[^\s]*/gi, '[redacted]')
    .trim();
  return { reason: clean.slice(0, 160) };
}

/** Generic MENU/overflow disclosure verbs (app-agnostic). Create/edit FORM openers are handled separately by
 * exploreFormState (which is navigation-aware and captures form fields), so they're excluded here to avoid
 * two functions fighting over the same "New" button. */
const DISCLOSURE_LABEL = /^(actions|.*actions|export options|settings|more|menu|filter|filters|columns|options)$/i;
const MAX_DISCLOSURES = 4;

/**
 * The base capture only sees what's visible at rest — form fields and menu items behind "New"/"Actions"
 * never enter the catalog, so any authored case about them degenerates into clicking the opener repeatedly
 * (the exact failure class this closes). Same principle as the legacy inspector's revealHiddenControls:
 * open each disclosure control, capture the newly revealed verified elements, then Escape to restore state.
 */
async function revealAndCaptureDisclosedControls(page: any, elements: VerifiedElement[], maxElements?: number): Promise<void> {
  const seen = new Set(elements.map((e) => e.resolved_selector).filter(Boolean));
  const openers = elements
    .filter((e) => e.status === 'verified' && e.interactive && e.resolved_selector && DISCLOSURE_LABEL.test(String(e.name || '').trim()))
    .slice(0, MAX_DISCLOSURES);
  for (const opener of openers) {
    try {
      await page.locator(opener.resolved_selector as string).first().click({ timeout: 4000 });
      await page.waitForTimeout(900);
      const revealed = await captureVerifiedElementsForOpenPage(page, { maxElements: Math.min(60, maxElements ?? 60) });
      for (const el of revealed) {
        if (el.status !== 'verified' || !el.resolved_selector || seen.has(el.resolved_selector)) continue;
        seen.add(el.resolved_selector);
        elements.push(el);
      }
    } catch { /* opener not clickable right now — skip, never fail discovery over enrichment */ }
    // Escape twice restores grids/modals to the resting state before the next opener (legacy-proven idiom).
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);
  }
}

/** Generic create/edit openers (app-agnostic verbs) whose target is a FORM, often on a separate route. */
const FORM_OPENER_LABEL = /^(new|create|add|edit|\+ ?new|\+ ?add)\b/i;

/** Generic overlay-container vocabulary (universal UI patterns, NOT app-specific class names). A create
 * form on a data-heavy page renders as a portal modal/drawer at the very END of the DOM — past the base
 * capture's element budget — so we mark the open overlay and capture scoped to it. Returns a stable scope
 * selector when an open form overlay is found, else null (inline form → caller uses the full-page capture). */
async function markOpenFormOverlay(page: any): Promise<string | null> {
  const found = await page.evaluate(`(() => {
    const sels = ['[role="dialog"]','[aria-modal="true"]','dialog[open]','[class*="modal" i]','[class*="drawer" i]','[class*="dialog" i]','[class*="flyout" i]','[class*="sheet" i]','[class*="offcanvas" i]','[class*="side-panel" i]','[class*="sidepanel" i]','[class*="popover" i]'];
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const fillable = (el) => el.querySelector('input:not([type=hidden]):not([type=search]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable="true"]');
    const prev = document.querySelector('[data-tf-form-scope]'); if (prev) prev.removeAttribute('data-tf-form-scope');
    for (const sel of sels) {
      for (const n of document.querySelectorAll(sel)) { // FIRST in document order = OUTERMOST overlay (keeps its footer Save/Cancel in scope)
        if (visible(n) && fillable(n)) { n.setAttribute('data-tf-form-scope', '1'); return true; }
      }
    }
    return false;
  })()`).catch(() => false);
  return found ? '[data-tf-form-scope="1"]' : null;
}

/**
 * Open the create/edit FORM and fold its fields + Save/Cancel controls into the catalog. The base capture
 * (and the inline disclosure sweep) only see the list at rest; on apps where "New" navigates to a full-page
 * form, the form's inputs and its Save button are otherwise undiscovered — so create/submit cases can never
 * ground and never actually submit. This clicks one create opener, captures the form wherever it lands
 * (inline panel OR new route), then RESTORES the list state (re-navigates if the URL changed) so the rest of
 * the catalog stays valid. Read-mostly: it never clicks Save/Delete — the real submit happens at execution.
 */
async function exploreFormState(page: any, elements: VerifiedElement[], targetUrl: string, maxElements?: number): Promise<void> {
  const seen = new Set(elements.map((e) => e.resolved_selector).filter(Boolean));
  const opener = elements.find((e) => e.status === 'verified' && e.interactive && e.resolved_selector
    && ['button', 'link', 'menuitem'].includes(String(e.role || ''))
    && FORM_OPENER_LABEL.test(String(e.name || '').trim()));
  if (!opener) return;
  const beforeUrl = String(page.url?.() || '');
  try {
    await page.locator(opener.resolved_selector as string).first().click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
    // Wait for a REAL form field (not the list's search/checkbox) to render — the form/drawer animates in,
    // so a fixed short pause captured a half-rendered dialog and missed every field.
    await page.waitForSelector(
      'input:not([type="search"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]',
      { timeout: 6000, state: 'visible' },
    ).catch(() => undefined);
    await page.waitForTimeout(700);
    // A portal modal/drawer renders at the very END of a data-heavy DOM (measured: form fields at doc index
    // ~23.9k of ~24k), far past the whole-document capture's 600-element budget — so a full-page capture
    // NEVER sees them no matter how high the cap. Mark the open overlay and capture SCOPED to it, so its
    // handful of fields + Save/Cancel are read directly. Inline forms (no overlay) fall back to full capture.
    const scope = await markOpenFormOverlay(page);
    const formEls = scope
      ? await captureVerifiedElementsForOpenPage(page, { within: scope, maxElements: 120 })
      : await captureVerifiedElementsForOpenPage(page, { maxElements: 400 });
    for (const el of formEls) {
      if (el.status !== 'verified' || !el.resolved_selector || seen.has(el.resolved_selector)) continue;
      seen.add(el.resolved_selector);
      elements.push(el);
    }
    if (scope) await page.evaluate(`(() => { const n = document.querySelector('[data-tf-form-scope]'); if (n) n.removeAttribute('data-tf-form-scope'); })()`).catch(() => undefined);
  } catch { /* opener not clickable / form didn't open — enrichment only, never fail discovery */ }
  // Restore the resting list state: re-navigate if we left the page, else Escape an inline panel.
  if (String(page.url?.() || '') !== beforeUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  } else {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

/** Session open/navigation/login failures all surface here (withPageSession guarantees cleanup regardless of where inside it the throw came from). */
function classifyDiscoveryError(err: unknown, loginAttempted: boolean): WorkflowRuntimeError {
  if (err instanceof WorkflowRuntimeError) return err;
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown discovery failure.');
  const lower = message.toLowerCase();

  // A login was attempted this session and the message itself talks about auth/credentials — treat as auth, not generic infra.
  if (loginAttempted && /login|credential|auth|password|username|rate.?limit|too many/.test(lower)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.AUTH_FAILURE, 'Authentication failed while opening the discovery session.', boundedReason(message), 'discovery');
  }
  if (/timeout|timed out|econnreset|econnrefused|enotfound|net::err/.test(lower)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT, 'Network timeout while opening the discovery session.', boundedReason(message), 'discovery');
  }
  return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.EXECUTION_INFRA_FAILURE, 'Browser session failed during discovery.', boundedReason(message), 'discovery');
}

/** LangGraph node: opens exactly ONE authenticated page session and returns bounded evidence + summary. */
export async function runDiscoveryNode(input: RunDiscoveryNodeInput): Promise<RunDiscoveryNodeResult> {
  const targetUrl = String(input.mission?.targetUrl || '').trim();
  if (!targetUrl) {
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      'Discovery node requires a resolved mission with targetUrl.',
      undefined,
      'discovery',
    );
    return emptyResult([err.toWorkflowError()]);
  }

  // Tracked outside the try so the catch below can tell an auth-flavored throw from a generic infra one.
  let loginAttempted = false;

  try {
    return await withPageSession(
      { targetUrl, credentials: input.credential, runId: input.runId, storageStatePath: input.auth?.storageStatePath, sessionStorageState: input.auth?.sessionStorageState },
      async ({ sessionId, page, login }) => {
        loginAttempted = Boolean(login?.attempted);

        // Sequential by design: both reads hit the same live page, and Playwright reads against
        // one page are not meant to run concurrently from two call sites at once.
        const ctx = await collectPageContext(page);
        const elements = await captureVerifiedElementsForOpenPage(page, { maxElements: input.maxElements });
        await revealAndCaptureDisclosedControls(page, elements, input.maxElements);
        // Fold the create/edit form's fields + Save button into the catalog so fill→submit cases can ground.
        await exploreFormState(page, elements, targetUrl, input.maxElements);

        // Must read screenshots before the callback returns — withPageSession closes the session right after.
        const artifacts = sessionArtifacts(sessionId);
        const screenshots = artifacts?.screenshots || [];
        const screenshotRef = screenshots.length ? screenshots[screenshots.length - 1] : null;

        return {
          elements,
          pageSummary: summarizePageContext(ctx),
          screenshotRef,
          errors: [],
        };
      },
    );
  } catch (error) {
    return emptyResult([classifyDiscoveryError(error, loginAttempted).toWorkflowError()]);
  }
}
