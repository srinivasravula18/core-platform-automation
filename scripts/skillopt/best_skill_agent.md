# QA case/script authoring skill

Guidance injected into the case-writer and Playwright-coder agents. The SkillOpt loop edits this
file (bounded add/delete/replace) and keeps an edit only when it strictly improves the held-out
validation score (case quality + script action-completion + test-data + EVIDENCE pass rate).
App-agnostic: general QA-authoring craft only, never app-specific selectors or facts.

## Cases
- Cover every distinct rule, branch, role/permission difference, and negative/edge case the feature reveals; do not pad with trivial duplicates.
- Each step is ONE concrete user/system action naming the REAL on-screen element, with a matching observable expected result. No vague steps.

## Scripts (must PERFORM, not just look)
- The primary goal action must actually run and be asserted by its real OUTCOME (download event / persisted state change / row created-changed-removed) — never substitute a visibility check.
- The primary action + its assertion are UN-guarded so a miss fails (the repair step then fixes the selector).
- Discover every selector from inspection/source — never hardcode.

## Test data
- Use real, schema-valid values (correct field api_names, valid picklist options, required fields). Generate unique values to avoid collisions. Never leave create/edit data as empty placeholders.

## Script robustness (so it actually PASSES on the live DOM)
- Strict-mode safety: when a label/text may appear more than once, scope it — use `.first()` or query within a specific container. Never let a getByText/getByRole/getByLabel resolve to multiple elements (that throws a strict-mode violation and fails the run).
- Never assert on long concatenated text blobs or full exact strings (e.g. a whole toolbar's text run together). They are brittle and break on any layout change. Assert a SHORT, stable substring, a specific role+name, or a single landmark.
- Do not assert `toBeVisible` on an element that may be hidden behind another or rendered off-screen. Prefer asserting concrete content/state, a row/element COUNT, a value (`toHaveValue`/`toContainText` on a precise locator), or a URL change.
- The app loads asynchronously: wait for the relevant region/row/state to appear before acting or asserting; rely on web-first auto-waiting assertions with sensible timeouts rather than asserting immediately after a click.
- Prefer stable locators (role + accessible name, label, test id) over deep CSS or text that includes volatile counts/ids.
- Establish an action's PRECONDITION before clicking it. Many controls are disabled until a precondition is met (e.g. a bulk/row action requires selecting a row first; a save requires a dirty form; a confirm appears only after the primary click). Perform the precondition, then wait for the control to be enabled/actionable (`await expect(btn).toBeEnabled()`) before clicking. If a click times out, the control was almost certainly disabled — set up its precondition rather than clicking a not-ready control.
- For destructive/confirm flows, expect a confirmation dialog/modal after the first click and act on it (e.g. confirm the delete) before asserting the outcome.

## Assert OUTCOMES, not guessed text; use EXACT real selectors
- NEVER assert a specific message/status string you are guessing (e.g. expect(getByText(/^Required$/)).toBeVisible(), or a guessed "created successfully" toast). You do not know the exact wording — guessing it fails. Only assert message text when that exact text appears in the REAL SELECTORS / source provided.
- Assert the outcome BEHAVIORALLY:
  · a BLOCKED action (validation/permission denied): assert the change did NOT happen — the form/dialog stays open, NO new row appears, or the list/record count is unchanged. Do not assert a specific error string.
  · a SUCCESSFUL create/edit: assert the DATA you entered is now visible (the new value / a row containing it), not a guessed success message.
- Use the EXACT selector name from the provided real selectors — e.g. getByRole('button', { name: 'New' }) — NOT a regex of guesses like /create|add|new record/i. If a real selector exists for the control, use its exact string.
