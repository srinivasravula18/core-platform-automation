/**
 * Deterministic Playwright failure analysis for the run-results UI (no LLM).
 * Parses the raw error text into a developer-actionable breakdown: what the test
 * attempted, on which element, what was expected vs what actually happened, the
 * likely cause class, and concrete next steps. App-agnostic by design.
 */

import { stripAnsi } from './stripAnsi';

export interface FailureAnalysis {
  kind:
    | 'control-disabled'
    | 'element-hidden'
    | 'element-not-found'
    | 'element-unstable'
    | 'assertion-failed'
    | 'ambiguous-locator'
    | 'navigation'
    | 'timeout'
    | 'unknown';
  /** Short badge label, e.g. "Control disabled". */
  label: string;
  /** The action the script attempted (click / check / fill / assertion name). */
  attempted: string;
  /** The locator/selector the script targeted, if extractable. */
  target: string | null;
  /** The DOM element the locator resolved to, if Playwright reported one. */
  resolvedElement: string | null;
  expected: string;
  actual: string;
  likelyCause: string;
  suggestedFixes: string[];
}

/**
 * One-line, human-readable summary of what a failed step could not do — names the actual selector/
 * label it failed on (e.g. `Could not fill “#create-app-label” — element not found`) instead of a
 * cryptic `expectValidation Label…` step name. Used to caption failure frames in the evidence viewer.
 */
export function failureGist(rawError: string): string {
  const a = analyzeFailure(rawError);
  const attempted = a.attempted.replace(/^interact with/, 'reach');
  return `Could not ${attempted} — ${a.label.toLowerCase()}`;
}

/** First regex capture group across the error text, or null. */
function cap(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

function humanTarget(target: string | null): string {
  return target ? `“${target}”` : 'the target element';
}

export function analyzeFailure(rawError: string): FailureAnalysis {
  // Playwright errors carry ANSI color codes; strip first so both parsing and every derived
  // field (expected/actual/target) are clean plain text.
  const e = stripAnsi(rawError);

  // --- shared extractions -----------------------------------------------------------------
  const target =
    cap(e, /waiting for locator\('([^']+)'\)/) ??
    cap(e, /Locator:\s*locator\('([^']+)'\)/) ??
    cap(e, /locator\('([^']+)'\)/);
  const resolvedElement = cap(e, /locator resolved to (<[^\n]+)/)?.trim() ?? null;
  const action =
    cap(e, /locator\.(\w+):/) ??
    cap(e, /expect\(locator\)\.(\w+)\(\)/) ??
    null;
  const timeoutMs = cap(e, /Timeout:?\s*(\d+)ms/i) ?? cap(e, /Timeout (\d+)ms exceeded/i);
  const waited = timeoutMs ? `${Math.round(Number(timeoutMs) / 1000)}s` : 'the full wait window';

  const notEnabled = /element is not enabled/i.test(e) || /<[^>]*\bdisabled\b[^>]*>/i.test(resolvedElement || '');
  const notVisible = /element is not visible|hidden/i.test(e);
  const notStable = /element is not stable|intercepts pointer events|subtree intercepts/i.test(e);
  const notFound = /element\(s\) not found|waiting for locator/.test(e) && !resolvedElement;
  const strictViolation = /strict mode violation|resolved to \d+ elements/i.test(e);
  const isAssertion = /expect\(.*\)|toBeVisible|toBeHidden|toContainText|toHaveValue|toBeEnabled|toBeChecked|toHaveText|toHaveCount/i.test(e);
  const isNavigation = /net::|ERR_|ECONNREFUSED|Navigation (failed|timeout)|page\.goto/i.test(e);

  const attempted = action
    ? isAssertion && !/click|check|fill|hover|press|selectOption|type/.test(action)
      ? `assert ${action} on ${humanTarget(target)}`
      : `${action} ${humanTarget(target)}`
    : `interact with ${humanTarget(target)}`;

  // --- classification, most specific first ------------------------------------------------
  if (isNavigation) {
    return {
      kind: 'navigation', label: 'Navigation error', attempted, target, resolvedElement,
      expected: 'The page loads and the flow reaches the screen under test.',
      actual: `Navigation failed: ${e.split('\n')[0].slice(0, 160)}`,
      likelyCause: 'The target URL was unreachable, redirected, or timed out — environment or auth issue rather than a UI defect.',
      suggestedFixes: [
        'Verify the target app URL is up and reachable from the runner.',
        'Check that the login/session step succeeded before this test.',
      ],
    };
  }

  if (notEnabled) {
    return {
      kind: 'control-disabled', label: 'Control disabled', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} is enabled so the script can ${action || 'interact with'} it.`,
      actual: `The element exists on the page but stayed disabled for ${waited}, so the action never landed.`,
      likelyCause: 'The app disables this control until a precondition is met (a selection, an applied filter, a specific view mode, or loaded data). The test most likely skipped the setup step that enables it.',
      suggestedFixes: [
        'Reproduce manually: open the same screen and note what you must do before this control becomes enabled.',
        'Add that missing setup step to the test before this action.',
        'If the control should have been enabled at this point, this is a product bug — file it with the disabled state as evidence.',
        'Check whether an earlier test changed shared state (view mode, filters) that this test inherited.',
      ],
    };
  }

  if (notVisible || (notStable && resolvedElement)) {
    return {
      kind: notStable ? 'element-unstable' : 'element-hidden', label: notStable ? 'Element unstable/covered' : 'Element hidden', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} is visible and receives the ${action || 'pointer'} action.`,
      actual: `The element is in the DOM but was ${notStable ? 'moving or covered by another element' : 'not visible'} for ${waited}.`,
      likelyCause: notStable
        ? 'Another element (overlay, sticky header, toast) intercepts the pointer, or the element is animating.'
        : 'The control is revealed only on hover/focus, or it sits inside a collapsed/scrolled-out region.',
      suggestedFixes: notStable
        ? [
            'Wait for animations/overlays to settle before the action, or dismiss the covering element.',
            'Scroll the element into view explicitly before clicking.',
          ]
        : [
            'Hover or focus the parent element first (hover-revealed controls need a hover step before the click).',
            'Scroll the element into view or expand its collapsed container before the action.',
          ],
    };
  }

  if (strictViolation) {
    return {
      kind: 'ambiguous-locator', label: 'Ambiguous locator', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} matches exactly one element.`,
      actual: 'The locator matched multiple elements, so Playwright refused to act (strict mode).',
      likelyCause: 'The selector is not specific enough for this screen — several elements share the same label/role.',
      suggestedFixes: [
        'Scope the locator to its container (dialog, row, section) or add .first()/nth() deliberately.',
        'Prefer a more specific accessible name or test id.',
      ],
    };
  }

  if (isAssertion && notFound) {
    return {
      kind: 'element-not-found', label: 'Expected element missing', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} appears on screen after the steps run (${action || 'assertion'}).`,
      actual: `The element never appeared in the DOM within ${waited}.`,
      likelyCause: 'Either the flow did not reach the expected state, or the assertion targets an element from a different screen/dialog than the one this test actually opens (wrong-screen assertion).',
      suggestedFixes: [
        'Reproduce manually and check which screen the flow actually ends on.',
        'Verify the asserted element genuinely belongs to that screen — if it belongs to another dialog/page, replace the assertion with one from the correct screen.',
        'If the element should be there and is not, this is a product bug — file it with a screenshot of the end state.',
      ],
    };
  }

  if (isAssertion) {
    const expectation = cap(e, /Expected:?\s*([^\n]+)/) ?? 'the asserted condition holds';
    return {
      kind: 'assertion-failed', label: 'Assertion failed', attempted, target, resolvedElement,
      expected: `${humanTarget(target)}: ${expectation}`.slice(0, 200),
      actual: (cap(e, /Received:?\s*([^\n]+)/) ?? `The condition was still false after ${waited}.`).slice(0, 200),
      likelyCause: 'The app state after the steps differs from what the test expects — either the feature misbehaved or the expectation is wrong for this flow.',
      suggestedFixes: [
        'Replay the steps manually and compare the real outcome against the expectation.',
        'If the real outcome is correct, fix the test expectation; if not, this is a product bug.',
      ],
    };
  }

  if (notFound) {
    return {
      kind: 'element-not-found', label: 'Element not found', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} exists so the script can ${action || 'interact with'} it.`,
      actual: `No matching element appeared within ${waited}.`,
      likelyCause: 'The selector no longer matches (UI changed), or the flow did not reach the screen that contains it.',
      suggestedFixes: [
        'Open the screen manually and locate the control — update the selector if the UI changed.',
        'Check the previous steps actually navigated to the right place.',
      ],
    };
  }

  if (/Timeout|timed out/i.test(e)) {
    return {
      kind: 'timeout', label: 'Timeout', attempted, target, resolvedElement,
      expected: 'The step completes within its time budget.',
      actual: `The step was still incomplete after ${waited}.`,
      likelyCause: 'Slow environment, a spinner that never resolved, or a wait on a condition that can never become true.',
      suggestedFixes: [
        'Check whether the app was genuinely slow/stuck at this point (screenshots/video).',
        'If the wait condition is impossible in this flow, fix the test logic.',
      ],
    };
  }

  return {
    kind: 'unknown', label: 'Failure', attempted, target, resolvedElement,
    expected: 'The step completes successfully.',
    actual: e.split('\n')[0].slice(0, 200) || 'Unknown failure.',
    likelyCause: 'Unclassified failure — read the raw error below.',
    suggestedFixes: ['Inspect the raw error and the step screenshots for this test.'],
  };
}
