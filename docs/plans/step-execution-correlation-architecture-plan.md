# Step Execution Correlation — Architecture Plan

Status: **Phase 0 — analysis only, awaiting approval.** No code changed by this document.

## 1. Executive Summary

The "Cases in this run" Steps table (per-case authored steps with Expected Result) never reflects live execution progress accurately, and often stays "Not Run" for the whole run even after the live-refresh bugs fixed earlier this session. Root cause: `applyExecutionProgress()` (`core/shared/automationProgress.ts:21-27`) matches raw Playwright execution events to authored case steps **by array position**, and the final sync (`syncLinkedRun`, `server/features/automation/jobService.ts:366-398`) collapses all authored steps into one row per Playwright `test()` block. Neither has any real identity linking a raw action back to the authored step it belongs to, because no such identity is ever generated or carried through the pipeline.

Fixing this for real requires stamping a stable step ID onto each authored step at compile time, threading it through the emitted script as a `test.step()` label, and reading it back out of the agent's progress-reporter events. This is feasible **only for compiler-generated scripts** (AI-authored cases compiled via `PlaywrightCompiler`). It does **not** apply to hand-recorded or hand-edited scripts (the Salesforce/Nodify script currently being tested) — those never pass through the compiler and have no step model compatible with this fix.

## 2. Existing Architecture

Three independent script-origin paths feed the same generic local-agent runner and the same generic progress reporter:

- **Compiler path**: authored Case steps → LLM `TestPlan` (`server/features/agent/compiler/testPlan.ts:33-35`, steps are `{action|assert, target, value}`, no id) → `PlaywrightCompiler.compile()` (`server/features/agent/compiler/playwrightCompiler.ts:251-511`) → flat `body: string[]` of `await runner.click(...)` lines, no step boundaries → `server/features/agent/workflow/nodes/compilation.ts:89`.
- **Recorder path**: `server/features/automation/recordingService.ts` + `stepGrouping.ts` — a wholly separate step model (`parseAtomicSteps`), never touches `PlaywrightCompiler`.
- **Hand-edited/pasted script path**: whatever script text is saved onto the Test Case/recording — no step model at all, just raw script text.

All three, once dispatched to the local agent, run under the same generic reporter: `agent/src/runner.ts:37-50` (`progressReporterSource`), whose `tracked(step)` gate is `step.category === 'pw:api' || step.category === 'expect'` — Playwright's own per-raw-action instrumentation, firing one event per locator/assertion call regardless of any `test.step()` wrapping. `test.step()` calls themselves report as `category === 'test.step'`, currently excluded by `tracked()`.

## 3. Dependency Graph

```
authored Case.steps (server/shared/testCases.ts normalizeCaseSteps — no id)
        │
        ▼ (compiler path only)
semanticPlanner.ts → TestPlan.steps (testPlan.ts:33-35 — no id; sourceIndex/mappedSourceSteps exist but positional only)
        │
        ▼
PlaywrightCompiler.compile() (playwrightCompiler.ts:365 forEach) → flat script body, no step boundary markers
        │
        ▼ (agent/src/runner.ts spawns `playwright test`)
Playwright's own instrumentation → pw:api / expect step events (raw actions, unrelated to authored-step boundaries)
        │
        ▼
progressReporterSource onStepBegin/onStepEnd → job.progress WS frames {stepId, stepIndex, stepTitle,...}
        │
        ▼
jobService.ts:273-289 mergeExecutionProgress → job.summary.executionSteps[] (raw, positionally indexed)
        │
        ▼
core/shared/automationProgress.ts:21-27 applyExecutionProgress(authoredSteps, executionSteps) — BROKEN: matches by array position
        │
        ▼
AutomatedRunWorkspace.tsx renders per-case Steps table — wrong/stuck outcomes
```

Terminal path (separate, also broken for this purpose):
```
job.done → summary.tests[] (one entry PER test() block, not per authored step)
        │
        ▼
syncLinkedRun (jobService.ts:366-398) → run.steps = summary.tests.map(...) — collapses N authored steps to 1 row per test()
```

## 4. Runtime Flow

See diagram above — this IS the runtime flow (there is no separate "runtime flow" beyond the dependency chain, since this is a straight-line pipeline, not a branching agent).

## 5. Evidence Flow

Raw per-action evidence (Playwright step title/status/duration) already flows correctly end-to-end (already fixed this session — polling/SSE/visibility-refresh). The gap is purely correlation: WHICH authored step a given raw evidence event belongs to. No evidence is lost; it's misattributed or dropped by the positional match.

## 6. Context Flow / 7. Prompt Flow

Not applicable — this is a deterministic pipeline bug, no LLM call is involved in the broken path itself (the LLM authors the TestPlan upstream, but the compiler and the runtime correlation are both non-LLM/deterministic).

## 8. Current Problems

1. `applyExecutionProgress` matches `executionSteps[i]` to `authoredSteps[i]` by raw array position (`automationProgress.ts:22-25`). Wrong whenever the compiled script has setup actions (launch browser/create context/create page/navigate) before the first authored action, or when one authored step compiles to multiple raw actions — i.e. almost always.
2. `syncLinkedRun`'s terminal sync (`jobService.ts:375-379`) maps `summary.tests[]` (one entry per Playwright `test()` block) onto `run.steps`. A case authored as N steps inside ONE `test()` block collapses to exactly ONE outcome row at completion, regardless of N.
3. No step carries a stable identity anywhere in the data model: `Case.steps` has none (`testCases.ts` `normalizeCaseSteps`), `TestPlan.steps` has none (`testPlan.ts:33-35`), only positional `sourceIndex`/`mappedSourceSteps` exist and are used only for coverage-completeness checks (`compiledGeneration.ts:84-86`), never threaded into emitted script text.
4. `test.step()` is not used by the compiler at all (confirmed zero matches in `server/features/agent/compiler/**`). Two unrelated generators use it (git-agent script builder, an LLM system-prompt suggestion) — neither is in this pipeline.
5. Hand-recorded/hand-edited scripts (the case actually being tested this session) have no step model of any kind that a correlation mechanism could hook into.

## 9. Root Cause Analysis

The step-authoring and step-execution layers were built independently, at different times, by different subsystems (compiler vs. recorder vs. reporter), with no shared step-identity contract designed in from the start. `sourceIndex`/`mappedSourceSteps` exist for a *different* purpose (LLM coverage-completeness checking, not runtime correlation) and were never repurposed. The reporter and `applyExecutionProgress` were built generically (agent-side has to work for ANY script, compiler-generated or not), so they fell back to positional matching as the only universally-available signal — which is a fundamentally weak signal.

## 10. Proposed Architecture

**For compiler-generated scripts (the only feasible path):**
- Add a stable `id` field to `TestPlan.steps` (`testPlan.ts:33-35`), stamped deterministically by `semanticPlanner.ts` (which already computes `sourceIndex` per step) as e.g. `case:${caseId}:step:${sourceIndex}`.
- `PlaywrightCompiler.compile()` wraps each authored step's emitted line(s) in `test.step('[${id}] ${label}', async () => { ...existing lines... })` at the insertion point `playwrightCompiler.ts:365-495`. Synthetic/injected lines (required-field completion at line 349-359, opener injection at 410-415) get a distinct non-authored marker (e.g. `[synthetic]`) so they never collide with a real id, and dropped-validation paths (368-372, 388-407, 457-492) simply emit no `test.step()` at all for that iteration.
- `agent/src/runner.ts:52` `tracked()` gate extended to also accept `category === 'test.step'`; the reporter parses the `[id]` prefix back out of `step.title` (Playwright doesn't support arbitrary metadata on steps, so the id must live in the label string and be parsed back out — confirmed via research, this is the only viable channel).
- `job.progress` frames carry the real `stepId` through to `job.summary.executionSteps[]` (already structurally capable of carrying an id — `ExecutionStepProgress.id` already exists, currently just a synthetic per-event id).
- `applyExecutionProgress` rewritten to match by `executed.id`'s embedded case-step-id instead of position, falling back to positional best-effort only when no id is present (e.g. mid-migration, or synthetic steps).
- `syncLinkedRun`'s terminal sync stops discarding this and instead reuses the SAME id-matched `executionSteps` (already accumulated in `job.summary` throughout the run) to build the final `run.steps`, instead of the coarse `summary.tests[]` mapping.

**For hand-recorded/hand-edited scripts:** out of scope for a real per-step fix (no compiler pass exists to stamp an id). Recommended interim treatment: leave these on best-effort positional matching (current behavior), OR (larger, separate effort) require `test.step()` calls at recording/save time via `recordingService.ts`/`stepGrouping.ts`, which is a distinct feature with its own design questions (this doc does not plan that part — flag as future work only).

## 11. Complete Refactoring Strategy

Phased, compiler-path only (see §12 files):
1. Add `id` to `TestPlan.steps` + stamp it in `semanticPlanner.ts`.
2. Wrap compiler-emitted step lines in `test.step()` with the id embedded, excluding synthetic/dropped steps.
3. Extend the agent reporter to track `test.step()` events and parse the id back out.
4. Rewrite `applyExecutionProgress` to match by id with positional fallback.
5. Rewrite `syncLinkedRun`'s terminal step-sync to reuse the accumulated id-matched `executionSteps` instead of `summary.tests[]`.
6. Rebuild + version-bump the agent (per standing rule), redeploy.

## 12. Every File That Must Change

| File | Why | Risk |
|---|---|---|
| `server/features/agent/compiler/testPlan.ts` | add `id` to step type | Low |
| `server/features/agent/compiler/semanticPlanner.ts` | stamp deterministic id per step | Low-Med (touches LLM-plan post-processing) |
| `server/features/agent/compiler/playwrightCompiler.ts` | wrap emitted lines in `test.step(id, ...)`, exclude synthetic/dropped steps | Med-High (central codegen path, many branches per research §5) |
| `agent/src/runner.ts` | extend `tracked()` to `test.step`, parse id from title | Low-Med (agent bundle, needs version bump + redeploy) |
| `core/shared/automationProgress.ts` | `applyExecutionProgress` match-by-id + positional fallback | Low |
| `server/features/automation/jobService.ts` | `syncLinkedRun` reuse id-matched executionSteps instead of `summary.tests[]` for step rows | Med (touches the authoritative final-result writer) |
| `agent/package.json`, `agent/src/version.ts` | version bump per standing rule | Low |

## 13. Risk Level Per File

Highest risk: `playwrightCompiler.ts` (central codegen, many conditional emission paths that must each correctly attribute or exclude a step) and `jobService.ts`'s `syncLinkedRun` (the authoritative pass/fail writer — a regression here corrupts real run results, not just a progress display).

## 14. Backward Compatibility Concerns

- `executionSteps` entries from scripts compiled BEFORE this change (or hand-edited scripts) will have no embedded id — `applyExecutionProgress` must keep its positional fallback so old/non-compiler runs don't regress to showing nothing.
- In-flight runs at deploy time (compiled before, executing after) must not crash the reporter — id-parsing must tolerate titles with no `[id]` prefix.
- `run.steps`'s shape must stay compatible with every existing reader (`AutomatedRunWorkspace.tsx`, exports, reports) — this plan changes WHERE the data comes from, not its shape.

## 15. Migration Strategy

No data migration needed — this only affects newly-compiled scripts going forward. Existing persisted `run.steps` rows are untouched (read-only historical data).

## 16. Testing Strategy

- Unit: `semanticPlanner.ts` id-stamping (deterministic, stable across re-compiles of the same case).
- Unit: `playwrightCompiler.ts` — assert every authored step's line(s) land inside a correctly-labeled `test.step()`, synthetic/dropped steps excluded.
- Unit: `applyExecutionProgress` — id-match cases + positional-fallback cases.
- Integration: compile a real multi-step case, run headed via a test agent instance, confirm `executionSteps` carry real ids and the per-case Steps table updates row-by-row live.
- Regression: run a hand-edited/recorded script (no ids) and confirm positional fallback still behaves exactly as today (no crash, no worse than current).

## 17. Rollback Strategy

Every change is additive/isolated (`id` field is optional, fallback paths preserved) — rollback is a plain revert of the phase's commits; no schema/data migration to unwind.

## 18. Estimated Implementation Effort

Compiler-path fix (§10, all 6 steps): roughly one architect-mode phase (10-15 files is not reached — this is ~7 files), but `playwrightCompiler.ts` itself is a large, branch-heavy file (per research: required-field completion, opener injection, validation-drop paths all interact with step emission) — expect the compiler change alone to be the majority of the effort and the majority of the review risk.

## 19. Recommended Implementation Order (Phase Checklist)

- [x] **Phase 1 — data model + stamping.** Files: `testPlan.ts`, `semanticPlanner.ts`. Risk: Low. Acceptance: every compiled `TestPlan.steps[i]` has a stable, deterministic `id`. **DONE, uncommitted.**
  - Correction found mid-implementation: `semanticPlanFromCase` (the deterministic planner) is a SECONDARY path, only reached when `AIQA_COMPILER` is enabled (`server/features/agent/routes.ts:3026-3053`) and even then only as a first attempt before falling back to an inline LLM call. The PRIMARY live path (`testRunGraph.ts` → `authorPlansNode` → `authorAbstractPlan`, `server/features/agent/workflow/nodes/authoring.ts:503`) authors plans directly via LLM + `parseTestPlanStrict` and never touches `semanticPlanner.ts` — so stamping ids only there would not have covered the actual runs being tested.
  - Resolved by adding a universal fallback instead of relying solely on source-attributed ids: `testPlan.ts` now exports `stampStepIds(plan)`, which assigns a positional `step:${index}` id to any step that doesn't already have one — sufficient for runtime correlation (only needs uniqueness within one compiled script's own execution, not durable cross-run identity). `semanticPlanFromCase` additionally stamps precise, source-case-attributed ids (`case:${sourceIndex}`) per step where that planner runs, since it already tracks per-step provenance.
  - `stampStepIds` is not yet CALLED from the LLM-authored paths — that invocation belongs in Phase 2 at the compiler's single shared entry point (`PlaywrightCompiler.compile()`), so every plan gets an id regardless of which planner produced it, without touching each producer individually.
- [x] **Phase 2 — compiler emission.** Files: `playwrightCompiler.ts`. Risk: Med-High. Acceptance: compiled script wraps every authored step in `test.step([id] label, ...)`; synthetic/dropped steps never collide with a real id; existing compiler test suite still green. **DONE, uncommitted.** `stampStepIds(plan)` called at the top of `compile()` so every plan gets ids regardless of origin. Each `plan.steps.forEach` iteration's emitted lines are captured by boundary (`body.length` before/after) and wrapped via `wrapEmittedLines()` — the existing step-emission logic (many early-return branches: dropped validations, unresolved targets, role coercion, opener/required-field injection) was left untouched, just extracted into a named `runStep()` function so wrapping happens around it, not inside it. Fixed one test (`test-playwright-compiler.ts`) whose assertion did a raw `indexOf` on target text, which the new wrapper labels (which also mention the target name) made an unreliable check — updated it to check real `runner.click(`/`runner.expectVisible(` call order instead. **124/124 compiler tests pass.**
- [x] **Phase 3 — agent reporter + progress plumbing.** Files: `agent/src/runner.ts`, `core/shared/automationProgress.ts`, `AutomatedRunWorkspace.tsx`. Risk: Low-Med. Acceptance: `job.summary` carries real ids for compiler-generated runs; `applyExecutionProgress` matches by id with positional fallback intact for non-id runs. Agent version bumped to 1.0.10 + rebuilt. **DONE, uncommitted.**
  - Design change from the original plan text: rather than folding case-step ids into the existing `executionSteps` stream (which the raw "Playwright Step" panel already renders correctly and unmodified), `test.step()` boundaries are reported on a **separate** event stream (`case_step_started`/`case_step_finished` → `job.summary.caseSteps[]`) so this change carries zero risk to the already-working raw panel.
  - `applyExecutionProgress` gained a third `caseSteps` param; matches by `authoredStep.id ?? case:${index} ?? step:${index}` against `caseSteps` when present, else falls back to the original positional match against `executionSteps` (hand-edited/recorded scripts, which have no ids).
  - New unit coverage added to `scripts/test-automation-progress.ts`: id-match-over-position, and an authored step with no matching caseStep entry yet correctly stays "Not Run" instead of being misattributed. **All pass.**
- [x] **Phase 4 — terminal sync correctness.** Files: `jobService.ts` (`syncLinkedRun` + its two call sites), `serverRunner.ts` (same bug, same fix, second call site). Risk: Med. Acceptance: a multi-step compiler-generated case's per-step outcomes survive to completion instead of collapsing to 1 row; hand-edited/recorded runs unaffected. **DONE, uncommitted.**
  - Found and fixed a bug beyond the plan's original scope: both `syncLinkedRun` call sites (`jobService.ts`'s `job.done` handler, `serverRunner.ts`'s scheduled-run finish path) were passing the raw per-process Playwright summary (`parseSummary(runDir)` / the agent's `job.done` payload) — which never contains the accumulated `executionSteps`/`caseSteps` at all, since those only ever lived in the backend's own merged `AutomationJobs.summary`. Fixed both to use `setJobStatus`'s return value (the real finalized+persisted summary) instead.
  - `syncLinkedRun` no longer overwrites `run.steps` with a collapsed one-row-per-`test()` mapping when `summary.caseSteps` has real data — it leaves `run.steps` alone and lets `AutomatedRunWorkspace.tsx`'s own live fetch (already reading `job.summary.caseSteps` directly) render the real per-step detail via `applyExecutionProgress`. The coarse `summary.tests[]` collapse is now only used as a fallback when a script has no `caseSteps` (hand-edited/recorded).
- [ ] **Phase 5 — verification pass.** Live-run a real multi-step compiler-generated case headed, confirm the per-case Steps table updates row-by-row during execution and matches reality at completion. **NOT DONE — needs a live run against a real app; handed to the user, see chat.**

## 20. Final Production-Readiness Report

To be produced after Phase 5, per this repo's standard end-of-phases process — not written now (Phase 0 only).

---

**Explicitly out of scope for this plan:** correlating hand-recorded/hand-edited scripts (including the Salesforce/Nodify script currently under test) — flagged in §10 as a distinct, separate future effort with its own design questions.
