# AI QA Engineer — Implementation Report (Phases 1–6)

**Status:** All six phases implemented, validated, and **uncommitted** (per instruction). Dark by default.
**Flag:** `AIQA_COMPILER=1` enables the deterministic compiler path; unset = legacy path, unchanged.
**Date:** 2026-07-10. Plan of record: `docs/plans/ai-qa-engineer-architecture-plan.md`.

---

## What was built (composed, never replaced)

```
MissionContext(+platform,+tab) → Discovery Adapter → Metadata Graph → Evidence Graph (WRAPS Selector Registry)
   → Coverage Planner → Risk Analysis → Structured Test Plan (LLM, intent only)
   → Grounding Engine → Compiler«interface» (PlaywrightCompiler) → MissionRunner + specs → Validation Gate → Execution
   → Object Repository (versioned) → QA Knowledge Graph / Regression
```

The LLM no longer writes Playwright. It authors an abstract **Test Plan** whose `target`s must come from the verified **Evidence-Graph catalog**; the deterministic **PlaywrightCompiler** emits the code; the **MissionRunner** owns login/nav/verify/retries; the **Validation Gate** rejects any `page.goto`/`new URL`/`searchParams`/`appId`/`loginIfNeeded`/`.first()` in a compiled spec.

## Phase-by-phase (all validated: `tsc --noEmit` clean + `build:backend` + suites green)

| Phase | Subsystem | New/changed files | Tests |
|---|---|---|---|
| 1 | MissionContext `+platform/+tab`; Metadata Graph; Evidence Graph (wraps registry); Object Repository (versioned) | `mission/missionContext.ts`, `graph/metadataGraph.ts`, `graph/evidenceGraph.ts`, `graph/objectRepository.ts`, `shared/storage.ts`, `db/schema.sql` | mission 67, metadata 17, evidence 10, object-repo 15 |
| 2 | Discovery Adapter → graphs + repo (composes DOM Explorer / Selector Registry / metadata) | `graph/discoveryAdapter.ts`, `pipelineDelta.ts`, `evidence/registry.ts` | discovery-adapter 12 |
| 3 | Grounding Engine; backend-agnostic `Compiler` interface; Test Plan IR; target catalog | `graph/groundingEngine.ts`, `compiler/Compiler.ts`, `compiler/testPlan.ts`, `compiler/renderCatalogForPrompt.ts`, `shared/schemas.ts` | grounding 9, testplan 10 |
| 4 | PlaywrightCompiler; MissionRunner; Validation Gate | `compiler/playwrightCompiler.ts`, `compiler/missionRunner.template.ts`, `compiler/validateCompiledOutput.ts`, `playwright/executionService.ts` | compiler 14, mission-runner 7, gate 10 |
| 5 | Coverage Planner; Risk Analysis; flag-gated route integration | `compiler/coveragePlan.ts`, `graph/riskAnalysis.ts`, `compiler/compiledGeneration.ts`, `agent/routes.ts` | coverage 10, risk 5, compiled-gen 8 |
| 6 | API evidence fold-in; QA Knowledge Graph; versioning-driven regression | `graph/apiEvidenceAdapter.ts`, `graph/knowledgeGraph.ts`, `graph/versioning.ts` | api-evidence 8, knowledge 12, versioning 7 |

**Totals:** 232 new assertions + 127 pre-existing (evidence-registry 45, selector-registry 48, api-intelligence 34) — all passing.

## Preserved subsystems (composition, not replacement)

- **Selector Registry** (`run.selector_registry` / `VerifiedSelector`) — untouched; the Evidence Graph references it by `selectorRef` and the Grounding Engine re-reads the authoritative locator from it.
- **DOM Explorer, MissionContext, Evidence Registry** — extended/consumed, never rewritten.
- **Legacy generator + its 10 post-processors** — fully intact and default; only bypassed when `AIQA_COMPILER=1`.

## Success criteria (mechanically enforced by `validateCompiledOutput`)

Zero of: hardcoded appId, hardcoded URL (outside the MissionRunner entry), invented labels, concatenated names, `new URL()`/`searchParams.set()`, `page.goto()`, `loginIfNeeded()`. Every locator originates from a verified registry entry; every action references a semantic target; ungrounded/ambiguous targets → `UNRESOLVED_SELECTOR`/`AMBIGUOUS_SELECTOR`, never a guess. Proven by `test-playwright-compiler`, `test-validate-compiled`, `test-compiled-generation`.

## Rollout & rollback

- **Dark by default.** `AIQA_COMPILER` unset → the running system behaves exactly as before (verified: routes legacy branch unchanged; execution `emitMissionRunner` false).
- **Enable per environment** with `AIQA_COMPILER=1`; instant rollback by unsetting it. New DB table (`object_repository`) is additive/idempotent.

## Known limitations / next steps (not yet done)

1. **Live LLM path unproven end-to-end.** The deterministic compile/ground/validate path is fully unit-tested; the plan-authoring LLM call in `routes.ts` (behind the flag) has not been exercised against the live app in this environment. First live run should target **Admin List-View / Objects** and expect zero compiler diagnostics.
2. **Execution repair loop** (`routes.ts` ~3960) still regenerates via the legacy coder on failure; under the flag it should instead trigger a **targeted re-discovery** for `UNRESOLVED/AMBIGUOUS` targets. Deferred.
3. **VERIFY_* expansion** is minimal (visibility) in Phase 4; richer expansions (row counts, sort/filter effects) are additive to the compiler without IR changes.
4. **Metadata Graph** currently carries objects+fields (all `metadata_map` provides); tabs/relationships/lookup targets await richer discovery.
5. **Object Repository** persistence uses the JSON store + additive PG DDL; a live backfill will populate cross-run history/regression over time.

## How to try it

```
# dark (default) — unchanged behavior
npm run build:backend

# enable the compiler path
AIQA_COMPILER=1 <start backend>   # first run: Admin → Objects list view

# run any subsystem test
npm run test:compiler && npm run test:grounding && npm run test:compiled-generation
```
