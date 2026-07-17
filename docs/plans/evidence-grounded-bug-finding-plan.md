# Evidence-Grounded Bug Finding — Implementation Plan (Phase 0)

**Status:** ANALYSIS ONLY — no code changed. Awaiting explicit approval before implementation.
**Branch:** `agrnts_memory_enhancements` · **Date:** 2026-07-17
**Goal:** Stop the agent from *guessing* assertions. Author test cases with industry-standard QA
technique and ground every oracle in observed DOM state + requirements, so runs report real defects
instead of false failures.

---

## 1. Executive Summary

A live run of *"create test cases to create a new app"* reported 5 failures that were **not product
bugs** — they were wrong assumptions baked into the generated tests:

- `Create button blocked when Label is empty` → `toBeDisabled() failed — Received: enabled`. The app
  never disables Create; it validates on submit. The test assumed a disabled-button pattern.
- `Create button blocked when API Name is empty` → `toHaveValue("") — Received: "testapp"`. The field
  was never cleared; its "empty" precondition was false.
- `New App form opens with all fields empty` → `toHaveValue("") — Received: "1.0.0"`. The Version field
  legitimately defaults to `1.0.0`.

**Root cause (grounded):** the pipeline *captures* the exact truth needed to avoid all three — every
element's observed `disabled`/`readonly`/`required` state, current `value`, and each option's `selected`
flag are read live during discovery (`domExplorer.ts:655-689`, `:737-748`) — but that state is **dropped
at one projection point** (`grounding.ts::toVerifiedSelector`, `:57-94`, which carries only `required`).
Downstream, the LLM picks the assertion verb from case text and the compiler maps it 1:1 to a Playwright
call (`playwrightCompiler.ts::emitAssert`, `:66-89`) **without ever checking whether the grounded element
was actually observed disabled / actually held that value.** There is no precondition verification and no
formal test-design technique; positive-vs-negative is decided by prompt prose and a title regex
(`playwrightCompiler.ts:22-24`).

**Fix (strangler-fig, additive):** (1) stop discarding observed state and thread it through to the author
and compiler; (2) ground the oracle — cross-check observed state before emitting `DISABLED`/`ENABLED`/
`HAS_VALUE`, and show observed state to the author; (3) add a real test-design step (equivalence
partitioning + boundary-value analysis) that emits an explicit positive/negative case matrix; (4) verify
preconditions before asserting; (5) add a pre-execution assertion validator as defense-in-depth; (6) fix
the mislabel that reports a wrong assertion as a `functional` product bug.

All changes are additive and flag-gated (`EVIDENCE_ORACLE_V1`) so current behavior is the exact default.

---

## 2. Existing Architecture (verified)

- **Authoring** (`workflow/nodes/authoring.ts`): `authorTestCases` (`:415`) is a single LLM round-trip +
  one repair (`:273-309`), validated for schema shape only (`validateCases`, `:396-403`). Grounding
  inputs (`buildCasesPrompt`, `:344-369`): `goal`, `understanding` (LLM-authored code analysis — the
  de-facto oracle, `:353-356`), and the evidence-graph catalog (vocabulary of legal target names only).
  Positive/negative is prompt prose (`:367`).
- **Abstract plan → asserts**: closed verb set `PLAN_ASSERTS` (`testPlan.ts:13-20`); the model emits one
  per step (`authorAbstractPlan`, `:439`; `buildPlanPrompt`, `:371-390`).
- **Compiler** (`compiler/playwrightCompiler.ts`): `resolveTarget` (`groundingEngine.ts:58`) grounds the
  *locator* rigorously; `emitAssert` (`:66-89`) maps the verb 1:1 (`DISABLED→expectDisabled` `:82`,
  `HAS_VALUE→expectValue` `:85`). Only value intelligence: threading the Test-Data-Engine fill value into
  a later `HAS_VALUE` (`:242-249`). `isNegativeCase` (`:22-24`) is a **title regex**.
- **Runner** (`missionRunner.template.ts`): executes verbs literally (`expectDisabled→toBeDisabled()`
  `:178`, `expectValue→toHaveValue()` `:181`).
- **Observed state captured, then discarded**: `VerifiedElement` (`domExplorer.ts:655-689`) has
  `value`, `options[].{selected,disabled}`, `state.{disabled,readonly,required}`. `grounding.ts:78-92`
  copies only `required`. `FieldMeta` (`pipelineDelta.ts:424-438`), `VerifiedSelector` (`:440-457`),
  `EvidenceNode` (`evidenceGraph.ts:20-51`), and `GroundResult` (`groundingEngine.ts:15-23`) have no
  slots for observed disabled/value/selected.
- **Validation gates are all post-hoc**: compiled-output gate bans structure only
  (`validateCompiledOutput.ts:9-32`); business rules validate the persisted record vs schema
  (`businessRules.ts:96-194`); investigation/intent-judge explain failures post-execution
  (`investigation.ts:248-449`) and map `assertion→functional@0.5` (`:137-148`) — i.e. a wrong assertion
  is currently mislabeled a product bug.
- **No test-design technique**: no EP/BVA anywhere; `coveragePlan.ts:9-57` is a post-hoc keyword
  classifier for risk weighting, not case design. `min/max/maxLength/pattern` exist in `FieldMeta`
  (`:430-437`) but are unused for design.

## 3. Dependency Graph (relevant slice)

```
discovery.ts ─► domExplorer.toVerifiedElement (observed state) ─► grounding.toVerifiedSelector ─►[DROPS state]
                                                                     │
             evidenceGraph.EvidenceNode ◄────────────────────────────┘  (state absent)
                     │
 authoring.buildCasesPrompt ──► LLM cases ──► authorAbstractPlan ──► PlaywrightCompiler.emitAssert ──► runner verbs
                     ▲ (sees only names + required)          ▲ (verb trusted 1:1, no state check)
```

## 4–7. Runtime / Evidence / Context / Prompt Flow

Discovery opens create/edit forms + disclosure menus and reads live state (`discovery.ts:104-198`) →
`toVerifiedElement` records it → **grounding projection strips it** → evidence graph + catalog expose
only names and `(required)` → author prompt (`renderCatalogForPrompt.ts:23-36`) can't see that Create is
enabled or that Version defaults to `1.0.0` → LLM invents the assertion → compiler emits it verbatim →
runner asserts it → mismatch = false failure → investigation mislabels it `functional`.

## 8. Current Problems

1. Observed element state is captured then discarded (`grounding.ts:78-92`) — the single root cause.
2. Assertion verb is LLM-guessed from text, never cross-checked against observed state
   (`playwrightCompiler.ts:66-89`).
3. No precondition verification (asserting "empty" without clearing/confirming).
4. Positive/negative decided by a title regex (`:22-24`), not structured intent.
5. No test-design technique (EP/BVA) — captured constraints (`min/max/maxLength/pattern`) unused.
6. No pre-execution oracle validation; wrong assertions reach the runner.
7. Wrong assertions are reported as product `functional` bugs (`investigation.ts:144`).

## 9. Root Cause Analysis

The platform was built DOM-first and correctly captures ground truth, but the **grounding projection was
designed to yield locators, not behavioral state** — so the author and compiler operate on names without
state. Every downstream symptom (guessed verbs, no preconditions, title-regex intent, mislabeled defects)
follows from that single lossy projection plus the absence of a design step that would turn captured
field constraints into deliberate positive/negative cases.

## 10. Proposed Architecture

**A. Carry observed state end-to-end (the enabler).**
Extend `FieldMeta` / `VerifiedSelector` / `EvidenceNode` / `GroundResult` with an `observed` block:
`{ disabled, readonly, valueSnapshot, selectedOptions, present }`. Populate it in
`grounding.toVerifiedSelector` from `el.state`/`el.value`/`el.options` (stop dropping it) and surface it
on the evidence node and ground result.

**B. Evidence-grounded oracle in the compiler.**
`emitAssert` consults the grounded node's `observed` state before emitting a state assertion:
- If the plan says `DISABLED` but the element was observed `enabled` (and no prior step changes it) →
  **do not emit a passing-shaped lie**. Instead emit a diagnostic (`ORACLE_CONTRADICTION`) that either
  (a) rewrites the check to the app's real validation channel (inline error / on-submit rejection), or
  (b) drops the assertion and records why. Symmetric for `ENABLED`/`HAS_VALUE`.
- `HAS_VALUE ""` requires a verified-empty precondition (see D).

**C. Test-design step (EP/BVA) before authoring.**
New pre-authoring module `compiler/testDesign.ts`: from each field's `FieldMeta`
(`type/required/min/max/maxLength/pattern/options`) derive equivalence classes + boundary values and a
structured **case matrix** with explicit `intent: 'positive' | 'negative'` and the concrete
data/precondition per case. Feed the matrix into `authorTestCases` as a first-class input; the author
writes prose/steps for each matrix row rather than inventing the set. Replaces the title-regex
`isNegativeCase` with the matrix's `intent` flag.

**D. Precondition verification in the runner.**
Add `MissionRunner.ensureEmpty(spec)` / `ensureState(...)` helpers: before an "empty/blocked" assertion,
clear the field and assert it is empty (or read + branch), so a defaulted field (`1.0.0`) makes the
*precondition* fail loudly (a test-setup issue) instead of masquerading as a product failure. The
compiler emits the precondition from the matrix row.

**E. Pre-execution assertion validator (defense in depth).**
New `validation/assertionOracle.ts` (sibling to `businessRules.ts`): given compiled asserts + the
evidence graph, reject/flag any `DISABLED/ENABLED/HAS_VALUE` whose grounded node's observed state
contradicts it and which no prior step mutates. Turns today's post-hoc mislabel into an authoring-time
block.

**F. Correct defect attribution.**
In `investigation.ts` (`:137-148`), an assertion failure whose oracle was contradicted by observed
evidence is classified `test-authoring` (not `functional`), so it never ships as a product defect.

All gated by `EVIDENCE_ORACLE_V1`; off = today's behavior exactly.

## 11. Refactoring Strategy

Strangler-fig, bottom-up so each layer is independently verifiable:
1. Data carry-through (A) — inert until consumed.
2. Compiler oracle (B) + validator (E) — consume the new state.
3. Test-design (C) + preconditions (D) — change what's authored.
4. Attribution (F) — reporting only.

## 12–14. Files to change · why · risk

| File | Change | Risk |
|---|---|---|
| `graph/grounding.ts` (`toVerifiedSelector` :78-92) | stop dropping state; populate `observed` | **Med** (central projection) |
| `pipelineDelta.ts` (`FieldMeta` :424, `VerifiedSelector` :440) | add `observed` fields | Low (additive types) |
| `graph/evidenceGraph.ts` (`EvidenceNode` :20, build :98-130) | surface `observed` on node | Low |
| `graph/groundingEngine.ts` (`GroundResult` :15, `resolveTarget` :58) | return observed state with locator | Med |
| `compiler/playwrightCompiler.ts` (`emitAssert` :66, assert branch :240, `isNegativeCase` :22) | oracle cross-check; matrix intent | **High** (core codegen) |
| `compiler/testDesign.ts` (NEW) | EP/BVA → case matrix | Med (new, isolated) |
| `compiler/renderCatalogForPrompt.ts` (:23-36) | expose observed state + defaults to author | Low |
| `workflow/nodes/authoring.ts` (`buildCasesPrompt` :344, `buildPlanPrompt` :371, input :35) | thread matrix; evidence-keyed instructions | Med |
| `ai/systemPrompts.ts` (`caseWriter` :192-239) | advice → hard evidence-keyed rules | Low |
| `compiler/missionRunner.template.ts` | `ensureEmpty/ensureState` precondition helpers | Med (template; per-run compiled) |
| `validation/assertionOracle.ts` (NEW) | pre-exec contradiction gate | Low (new) |
| `workflow/nodes/investigation.ts` (:137-148) | reclassify contradicted asserts as `test-authoring` | Low |
| `shared/env.ts` + `.env.example` + `/api/app-config` | `EVIDENCE_ORACLE_V1` flag | Low |

## 15. Backward Compatibility

Flag off → grounding still drops nothing extra it uses, compiler emits verbs 1:1, title-regex intent,
no design step — byte-for-byte current behavior. New type fields are optional. Existing runs/tests
unaffected.

## 16. Migration

No data migration. New `observed` fields default absent → oracle treats "unknown" as "don't block"
(fail-open) so partial evidence never over-rejects.

## 17. Testing Strategy

- Unit: `testDesign` EP/BVA from representative `FieldMeta`; `assertionOracle` contradiction cases
  (observed-enabled vs `DISABLED`; defaulted value vs `HAS_VALUE ""`); grounding carry-through.
- Regression: `test:compiler`, `test:mission-runner`, `test:validate-compiled`, `test:grounding`,
  `test:compiled-generation` stay green with flag off; new expectations with flag on.
- E2E: re-run the "create a new app" mission with flag on — assert the 3 known false failures are either
  correctly reframed (real validation channel) or blocked as `test-authoring`, and true positives (Cancel
  dismisses form) still pass. Verify against the live app; restart backend before judging.

## 18. Rollback

Unset `EVIDENCE_ORACLE_V1`, restart backend. Additive types + new modules are inert.

## 19. Effort

~4 phases, each ≤10 files, independently verified.

## 20. Phase Checklist

- [ ] **Phase 1 — Carry observed state** · `grounding.ts`, `pipelineDelta.ts`, `evidenceGraph.ts`,
  `groundingEngine.ts`, `renderCatalogForPrompt.ts`, flag + tests · **Risk: Med**
- [ ] **Phase 2 — Evidence-grounded oracle + validator** · `playwrightCompiler.ts` (`emitAssert`),
  `validation/assertionOracle.ts`, `investigation.ts` reclassify · **Risk: High**
- [ ] **Phase 3 — Test-design (EP/BVA) + preconditions** · `compiler/testDesign.ts`, `authoring.ts`,
  `systemPrompts.ts`, `missionRunner.template.ts` (`ensureEmpty/ensureState`), `isNegativeCase`→matrix
  intent · **Risk: Med-High**
- [ ] **Phase 4 — Verify + docs** · live re-run of the failing mission, regression sweep, readiness
  report · **Risk: Low**

## Future Extension Points

Feed real requirements/ACs (`requirementService`, `knowledgeService`) into the design matrix as the
authoritative oracle; learn per-app validation channel (disabled vs inline vs on-submit) into the object
repository so the oracle improves per app; expand BVA to date/number/format domains.

---

**Next step:** approve (or adjust scope), then I implement Phase 1. Nothing changed yet.
