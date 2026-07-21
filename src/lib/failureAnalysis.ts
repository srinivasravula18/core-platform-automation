/**
 * Deterministic Playwright failure analysis for the run-results UI (no LLM).
 * Parses the raw error text into a plain-English breakdown: what the test tried to do, on which
 * element, what was expected vs what actually happened, the likely cause, and concrete next steps.
 * The copy is deliberately jargon-free (no "DOM", "locator", "assertion", "toBeVisible", "strict
 * mode") — the technical detail stays in the "Resolved element" and "Raw error" sections of the card.
 * App-agnostic by design.
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
  /** Short badge label, e.g. "Couldn't find it". */
  label: string;
  /** Plain-English phrase for what the test tried to do (the card prefixes it with "Tried to "). */
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
 * One-line, human-readable summary of what a failed step could not do — names the actual control it
 * failed on (e.g. `Could not type into “#create-app-label” — couldn't find it`) instead of a cryptic
 * step name. Used to caption failure frames in the evidence viewer.
 */
export function failureGist(rawError: string): string {
  const a = analyzeFailure(rawError);
  return `Could not ${a.attempted} — ${a.label.toLowerCase()}`;
}

/** First regex capture group across the error text, or null. */
function cap(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Turn a raw selector into a friendly name where we can — "the “Cancel” button", "an error message". */
function humanTarget(target: string | null): string {
  if (!target) return 'the thing it needed';
  const roleName =
    target.match(/role=(\w+)\[name="([^"]+)"\]/i) ||
    target.match(/getByRole\(['"](\w+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"]/);
  if (roleName) return `the “${roleName[2]}” ${roleName[1].toLowerCase()}`;
  if (/\[role="alert"|aria-invalid|aria-errormessage/i.test(target)) return 'an error message';
  const testid = target.match(/getByTestId\(['"]([^'"]+)['"]/) || target.match(/\[data-testid="([^"]+)"\]/);
  if (testid) return `the “${testid[1]}” control`;
  return `“${target}”`;
}

/** Turn a Playwright method name into a plain-English phrase a non-technical reader understands. */
function plainAction(action: string | null, target: string | null, isAssertion: boolean): string {
  const t = humanTarget(target);
  const doVerbs: Record<string, string> = {
    click: `click ${t}`,
    dblclick: `double-click ${t}`,
    fill: `type into ${t}`,
    type: `type into ${t}`,
    press: `press a key in ${t}`,
    check: `tick ${t}`,
    uncheck: `untick ${t}`,
    selectOption: `pick an option in ${t}`,
    hover: `hover over ${t}`,
    focus: `focus ${t}`,
  };
  if (action && doVerbs[action]) return doVerbs[action];
  const checkVerbs: Record<string, string> = {
    toBeVisible: `check that ${t} is shown`,
    toBeHidden: `check that ${t} is gone`,
    toHaveValue: `check what ${t} contains`,
    toHaveText: `check the text in ${t}`,
    toContainText: `check the text in ${t}`,
    toBeEnabled: `check that ${t} can be used`,
    toBeDisabled: `check that ${t} is greyed out`,
    toBeChecked: `check that ${t} is ticked`,
    toHaveCount: `count how many ${t} there are`,
  };
  if (action && checkVerbs[action]) return checkVerbs[action];
  return isAssertion ? `check ${t}` : `use ${t}`;
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
  const waited = timeoutMs ? `${Math.round(Number(timeoutMs) / 1000)} seconds` : 'the whole wait';

  const notEnabled = /element is not enabled/i.test(e) || /<[^>]*\bdisabled\b[^>]*>/i.test(resolvedElement || '');
  const notVisible = /element is not visible|hidden/i.test(e);
  const notStable = /element is not stable|intercepts pointer events|subtree intercepts/i.test(e);
  const notFound = /element\(s\) not found|waiting for locator/.test(e) && !resolvedElement;
  const strictViolation = /strict mode violation|resolved to \d+ elements/i.test(e);
  const isAssertion = /expect\(.*\)|toBeVisible|toBeHidden|toContainText|toHaveValue|toBeEnabled|toBeChecked|toHaveText|toHaveCount/i.test(e);
  const isNavigation = /net::|ERR_|ECONNREFUSED|Navigation (failed|timeout)|page\.goto/i.test(e);

  const attempted = plainAction(action, target, isAssertion);
  const doWord = action && !isAssertion ? plainAction(action, null, false).replace(/ the thing it needed$/, '') : 'use';

  // --- classification, most specific first ------------------------------------------------

  // Typed into something that can't be typed into (a dropdown, checkbox, button…). Very common when a
  // test uses "type text" on a <select>; the raw error is unreadable, so name the real control + fix.
  if (/not an <input>|not an <textarea>|not an input|contenteditable/i.test(e)) {
    const tag = cap(resolvedElement || '', /^<(\w+)/)?.toLowerCase() ?? '';
    const kindWord = tag === 'select' ? 'a dropdown' : tag === 'button' ? 'a button' : tag ? `a <${tag}> (not a text box)` : 'something you cannot type into';
    return {
      kind: 'unknown', label: 'Wrong kind of control', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} accepts typed text.`,
      actual: `The test tried to type into ${humanTarget(target)}, but it is ${kindWord} — you cannot type text into it.`,
      likelyCause: 'The test used "type text" on the wrong kind of control. A dropdown needs to be opened and an option picked; a checkbox needs to be ticked; a button needs to be clicked.',
      suggestedFixes: [
        tag === 'select'
          ? 'For a dropdown: open it and pick an option instead of typing.'
          : 'Use the action that matches this control (open a dropdown, tick a checkbox, click a button) instead of typing.',
        'The test generator should choose the action from the control type — this is a test bug, not a product bug.',
      ],
    };
  }

  if (isNavigation) {
    return {
      kind: 'navigation', label: "Page didn't open", attempted, target, resolvedElement,
      expected: 'The page opens and the test reaches the screen it needs to check.',
      actual: `The page didn't open. ${e.split('\n')[0].slice(0, 160)}`,
      likelyCause: "The web address couldn't be opened, or the test wasn't logged in yet. This is usually an environment or login problem — not a problem with the feature itself.",
      suggestedFixes: [
        "Make sure the app's web address is up and reachable from where the test runs.",
        'Make sure the login step worked before this test started.',
      ],
    };
  }

  if (notEnabled) {
    return {
      kind: 'control-disabled', label: 'Button was greyed out', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} is ready to use so the test can ${doWord} it.`,
      actual: `It was on the screen but stayed greyed out (switched off) for ${waited}, so nothing happened when the test tried to use it.`,
      likelyCause: 'The app keeps this switched off until you do something first — like pick an item, choose a filter, or wait for data to load. The test skipped that step.',
      suggestedFixes: [
        'Open the same screen yourself and notice what you have to do before this turns on.',
        'Add that missing step to the test, right before this action.',
        "If it should already be on at this point, that's a real product bug — save a picture of it and report it.",
        'Check whether an earlier test left the screen in a different state that carried over.',
      ],
    };
  }

  if (notVisible || (notStable && resolvedElement)) {
    return {
      kind: notStable ? 'element-unstable' : 'element-hidden',
      label: notStable ? 'Something was in the way' : 'It was hidden',
      attempted, target, resolvedElement,
      expected: `${humanTarget(target)} is visible so the test can ${doWord} it.`,
      actual: notStable
        ? `It was there, but something else was on top of it (or it was still moving) for ${waited}, so the test couldn't reach it.`
        : `It was there but not visible on screen for ${waited}.`,
      likelyCause: notStable
        ? 'A popup, pop-up message, or sticky header was covering it, or it was still sliding into place.'
        : "It only shows when you hover or click near it, or it's inside a section that's closed or scrolled off screen.",
      suggestedFixes: notStable
        ? [
            'Wait for popups and animations to finish (or close them) before this step.',
            'Scroll it into view before clicking.',
          ]
        : [
            'Hover or click the area around it first — some things only appear when you hover.',
            'Open or scroll to the section that holds it before this step.',
          ],
    };
  }

  if (strictViolation) {
    return {
      kind: 'ambiguous-locator', label: 'Too many matches', attempted, target, resolvedElement,
      expected: `The name ${humanTarget(target)} should point to exactly one thing on the screen.`,
      actual: 'It matched more than one thing, so the test stopped instead of guessing which one to use.',
      likelyCause: "Several things on this screen share the same name or label, so the test couldn't tell them apart.",
      suggestedFixes: [
        'Point the test at the specific area (the popup, the row, the section) that holds the one you want.',
        'Give that one a clearer, more exact name or a test id.',
      ],
    };
  }

  if (isAssertion && notFound) {
    return {
      kind: 'element-not-found', label: "Expected thing wasn't there", attempted, target, resolvedElement,
      expected: `${humanTarget(target)} shows up on screen after the steps run.`,
      actual: `It never showed up, even after waiting ${waited}.`,
      likelyCause: "Either the test didn't get to the right screen, or it's looking for something that lives on a DIFFERENT screen or popup than the one it actually opened.",
      suggestedFixes: [
        'Do the steps yourself and see which screen you end up on.',
        "Make sure the thing you're checking really belongs to that screen. If it's from another popup or page, check for something on the correct screen instead.",
        "If it truly should be there and isn't, that's a real product bug — report it with a picture of the final screen.",
      ],
    };
  }

  if (isAssertion) {
    const expectation = cap(e, /Expected:?\s*([^\n]+)/) ?? 'the right result';
    return {
      kind: 'assertion-failed', label: 'Wrong result', attempted, target, resolvedElement,
      expected: `${humanTarget(target)} should be: ${expectation}`.slice(0, 200),
      actual: (cap(e, /Received:?\s*([^\n]+)/) ?? `It still wasn't right after ${waited}.`).slice(0, 200),
      likelyCause: 'After the steps, the app showed something different from what the test expected — either the feature behaved differently, or the test was expecting the wrong thing for this case.',
      suggestedFixes: [
        'Do the steps yourself and compare what really happens with what the test expected.',
        "If what the app does is actually correct, fix the test's expectation. If it's wrong, that's a product bug.",
      ],
    };
  }

  if (notFound) {
    return {
      kind: 'element-not-found', label: "Couldn't find it", attempted, target, resolvedElement,
      expected: `${humanTarget(target)} is on the screen so the test can ${doWord} it.`,
      actual: `Nothing matching ${humanTarget(target)} showed up within ${waited}.`,
      likelyCause: "Either the name doesn't match anymore (the screen changed), or the test never got to the screen that has it.",
      suggestedFixes: [
        'Open the screen yourself and find it — update the name in the test if the screen changed.',
        'Check that the earlier steps really took the test to the right place.',
      ],
    };
  }

  if (/Timeout|timed out/i.test(e)) {
    return {
      kind: 'timeout', label: 'Took too long', attempted, target, resolvedElement,
      expected: 'The step finishes in time.',
      actual: `The step still wasn't done after ${waited}.`,
      likelyCause: 'The app was slow or stuck, a loading spinner never finished, or the test was waiting for something that can never happen.',
      suggestedFixes: [
        'Check the screenshots or video to see if the app was really slow or stuck here.',
        'If the test was waiting for something that can never happen in this flow, fix the test.',
      ],
    };
  }

  return {
    kind: 'unknown', label: 'Something went wrong', attempted, target, resolvedElement,
    expected: 'The step finishes without an error.',
    actual: e.split('\n')[0].slice(0, 200) || 'Unknown problem.',
    likelyCause: "This one doesn't match a common pattern — open the full error below to see the details.",
    suggestedFixes: ['Open the full error and the step screenshots for this test.'],
  };
}
