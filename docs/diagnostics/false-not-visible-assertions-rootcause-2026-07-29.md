# False "not visible / not found / wrong result" bugs — end-to-end root cause

**Date:** 2026-07-29
**Run analyzed:** `43aff9e7-bf0f-4e3e-9765-7a67c7e209e1` — "test app creation flow", Admin app creation, provider `gpt-5.6-terra`.
**Symptom (user-reported, ~2 months):** A step reports the element is *not visible / not found*, or the value is *wrong*, but in the live UI the element **is** visible and the field **is** correctly filled. Suspicion was that the Script-writer agent "stops execution in the middle."

## Verdict

**The script does NOT stop mid-execution.** It runs to completion. The failures are **false assertions authored by the LLM plan-author and not caught by the compiler's safety nets** — the app under test behaved correctly in every one of the 6 "bugs". Playwright's own log proves it: e.g. `34 × locator resolved to <input … value="smoke_test_verification" … >` — the element was found and visible on every poll; the assertion simply demanded the opposite for the full 15s timeout, then failed.

## The pipeline (where bugs come from)

Natural-language **case steps** → **LLM plan-author** emits typed asserts (`authorAbstractPlan`, agent `playwrightCoder`=`gpt-5.6-terra`, `server/features/agent/workflow/nodes/authoring.ts:501`) → **deterministic compiler** renders each typed step to a `MissionRunner` call (`server/features/agent/compiler/playwrightCompiler.ts`, `emitAssert` :152) → **execution** → each failed assertion is turned into a **bug** by `server/features/agent/workflow/defectReporter.ts` (`classifyErrorKind` :165, humanized to the "It was hidden / Wrong result" cards).

So **bugs are generated from script-execution failures, not from the steps directly.** A mis-compiled step yields a false assertion → a false bug, even when the app is correct.

## Evidence: 6 "bugs", cross-referenced

| Case | Script assertion | App actually did | Playwright error | Class |
|---|---|---|---|---|
| API Name derived from Label | `expectValue('#create-app-api', "")` (expects **empty**) | derived `"smoke_test_verification"` (correct) | `toHaveValue` expected `""` received `"smoke_test_verification"` | **B** |
| API Name required | `expectHidden('#create-app-label')` | label is a **visible empty input** | `toBeHidden` expected hidden, received visible | **A** |
| Label required | `expectHidden('#create-app-label')` | visible empty input | `toBeHidden` received visible | **A** |
| Prefix required | `expectHidden('#create-app-label')` then `fill('#create-app-label', …)` the same field | visible empty input | `toBeHidden` received visible | **A** |
| New app default Version | types label `"Default Version App [unique]"`; `expectHidden('New App')` after Create | `[unique]` placeholder never substituted; create blocked → modal stays open | `toBeHidden` on heading received visible | **A + C** |
| Specified Version retained | `expectRowInList('Version Retained App 2025')` | row not found in 57s | `toBeVisible` element not found | (list/search — separate) |
| **Parent App required** | (no bogus `expectHidden` on a visible field) | — | **PASSED** ✅ | — |

The tell: **the only negative case with no spurious `expectHidden` on a visible field is the only one that passed.** And in "Prefix required" the compiler emits `expectHidden('#create-app-label')` immediately followed by `fill('#create-app-label', …)` — a self-contradiction proving the assertion is authored wrong, not a real product state.

## Root causes

### Class A — false `NOT_VISIBLE` on visible form controls (the dominant "not visible/not found")
In a **negative/validation** case the create is *rejected*, so the modal stays open and its fields remain visible. The LLM plan-author nonetheless emits `NOT_VISIBLE` asserts on those fields (intending "modal closed after submit" / "no error shown"), grounded to the field's own selector. `NOT_VISIBLE → runner.expectHidden` (`playwrightCompiler.ts:166`) → `toBeHidden` waits the full 15s on a visible input → false "not visible" bug.

A safety net already exists — `invalidValidationSteps` drops these — but **only when `node.stateTag === 'form'`**:
```
// playwrightCompiler.ts:49-51
if (negative) plan.steps.forEach((s, i) => {
  if (isAssertStep(s) && s.assert === 'NOT_VISIBLE' && resolved[i].node?.stateTag === 'form') drops.add(i);
});
```
`stateTag` is `'form'` only if discovery's `exploreFormState` (`discovery.ts:162`) opened the modal AND captured that field AND it wasn't already in `seen` (`discovery.ts:189`, tag applied at :193). When the portal capture misses a field (timing, dedup vs. base capture, inline form, opener-label mismatch), it stays `'page'` (default at `evidenceGraph.ts:127`, `grounding.ts:81`) and the net silently misses it. **This is why commit `b0df793` did not stop the failures** — it depends on a discovery tag that is not reliably present.

### Class B — `HAS_VALUE ""` on an auto-derived field (the "wrong result" screenshot)
For "API Name is derived from Label" the case expects the API Name to be auto-populated with a **non-empty** value. The LLM emitted `HAS_VALUE` with an **empty** expected value. The compiler deliberately preserves empty-value expectations:
```
// playwrightCompiler.ts:392-393
// Deliberate empty-value expectations ("field stays blank") are never rewritten.
```
→ `expectValue('#create-app-api', "")` → fails on the correctly-derived `smoke_test_verification`. The prompt's TRANSFORMED FIELDS rule (`authoring.ts:428`) tells the model to use `VERIFY_VALIDATION` when the output is unknown, but never forbids the *inverted* `HAS_VALUE ""`, and nothing downstream flags "assert-empty on a field the case declares non-empty/derived." This case is not classified negative, so the negative-case `HAS_VALUE → expectValidation` rewrite (`playwrightCompiler.ts:386`) does not apply.

### Class C — unsubstituted test-data placeholder
The case author wrote the literal `[unique]` ("Default Version App [unique]"). The Test Data Engine token syntax is `{{…}}` (compiler guards only `/\{\{[^}]+\}\}/`, `playwrightCompiler.ts:410`). `[unique]` is never substituted, so the literal string is typed into the field and searched for in the list.

## Proposed fix (Phase-0 — analysis only; no code changed yet)

1. **Class A (highest impact) — make the negative-case `NOT_VISIBLE` drop not depend solely on `stateTag`.**
   In `invalidValidationSteps` (`playwrightCompiler.ts:47-51`), in a negative case also drop `NOT_VISIBLE` asserts whose grounded target is an **input/combobox field** (role-based) OR is a field the same plan `FILL`/`SELECT`/`CLEAR`s OR `isRequiredFieldNode(node)` — because a rejected-submit modal never closes, so a hidden-assert on any of its live controls is provably wrong regardless of discovery tagging. Keep `stateTag==='form'` as one signal among several.
   *Secondary:* strengthen `exploreFormState` tagging so modal fields captured by the base sweep still get `stateTag:'form'` (don't let the `seen` dedup at :189 drop the tag).

2. **Class B — stop shipping `expectValue(field, "")` when the field is not deliberately blank.**
   In the compiler's HAS_VALUE branch (`playwrightCompiler.ts:386-397`): if the expected value is empty AND (the behavior-oracle marks the field auto-derived, OR the same plan never `CLEAR`s it), do not emit `expectValue("")`; convert to a non-empty check (or `VERIFY_VALIDATION`) or drop as skippable. Tighten the plan prompt (`authoring.ts:428`) to explicitly forbid `HAS_VALUE` with an empty value for "auto-populated/derived/non-empty" expectations.

3. **Class C — kill stray bracket placeholders.**
   Teach the case/plan prompt the real `{{unique.*}}`/`{{faker.*}}` token syntax and forbid `[...]` placeholders; and/or have the Test Data Engine recognize/strip `[unique]`-style brackets so a literal placeholder can never be typed or asserted.

4. **Backstop — a compile-time contradiction gate.** Reject/drop any script that asserts a control hidden/blank and also interacts with it (the "expectHidden then fill same selector" pattern) so a self-contradicting assertion can never ship.

## Validation strategy (after approval)
- Unit-test the compiler on this run's 7 plans: cases 2/3/5 (required-field) must lose the field-level `expectHidden`; case 1 must not assert `expectValue("")`; case 4 must substitute the unique token. Target: the 5 false failures clear, case 6 (real pass) unaffected, case 7 (list/search) triaged separately.
- Re-run the same prompt against the live Admin app; expect 0 false "not visible/wrong result" bugs.
- `npm run lint` + compiler tests; restart backend before any live re-verification (no hot-reload).

## Implemented (2026-07-29)

- **Class A** — `playwrightCompiler.ts` `invalidValidationSteps`: the negative-case `NOT_VISIBLE` drop no longer depends solely on `stateTag==='form'`. It now also drops when the grounded target is an editable/toggle role (`FORM_CONTROL_ROLES`), `isRequiredFieldNode`, or a selector the plan itself fills/selects/clears. Gated by the existing behavior-oracle flag (on in the analyzed run).
- **Class B** — `playwrightCompiler.ts` assert path: a `HAS_VALUE` with an empty expected value is dropped (skippable) unless the plan deliberately `CLEAR`ed that selector (`clearedSelectors`), so `expectValue(field,"")` can never fail a correctly auto-derived/defaulted field. Plan prompt (`authoring.ts`) updated to forbid empty `HAS_VALUE` for "auto-populated/derived".
- **Class C** — `testdata/engine.ts` `resolveInlineTokens`: now also resolves `[unique]`-style bracket placeholders to a run-seeded value (same path as `{{…}}`), so the literal never gets typed or asserted; the threaded row-assert gets the resolved value. Plan prompt forbids `[bracket]` placeholders.

**Tests:** `npm run test:compiler` 118 passed (6 new A/B/C assertions), `test:validate-compiled` 10 passed, `test:testplan` 12 passed, `npm run lint` clean.

### Class D (case 7) — post-create verification assumed a list

"Specified Version retained" created the app correctly (screenshot: App Details shows Version 2.4.6) but the app **navigated to the record's details page**, not back to a list. `expectRowInList` (`missionRunner.template.ts`) only searched for a `role=row` and reloaded the list URL — navigating away from the details page — so the row was "not found" for 57s. `expectTable` had the same list-only assumption.

**Fix:** added a shared `recordShown(want)` helper (matches the record text as a list **row**, or on its own page: **cell/heading/tab/detail text**). `expectRowInList` now polls the current page first (details view passes immediately) then reloads the list for cache lag, and fails with a record-named message. `expectTable` confirms the value on the record page when the grid control isn't present. A create that lands on the new record is now "created & shown", not a false miss.

**To see it live:** these are backend (`server/**`) changes. The deployed instance (`ops.acchindra.com/automation-test`) must be **redeployed** to pick them up; a local backend restart only affects a local run.

## Note on "run it locally"
The run's persisted `execution_result.tests` **is** the local Playwright result. It already proves the script completes and the element is visible/filled (`34 × locator resolved to <input … visible>`). A fresh headed re-run needs the **SUT** (`admin-ui`) login — the dump's SUT password is masked (`ad****26`); the `adminacc` credential is for Test Flow AI itself, not the app under test. Provide the admin-ui login to watch a headed repro live.
