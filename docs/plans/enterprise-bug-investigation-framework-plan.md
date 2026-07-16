# Enterprise Bug Investigation, Validation & Reporting Framework — Phase-0 Implementation Plan (v2)

**Status:** ANALYSIS — awaiting explicit approval before any implementation.
**Date:** 2026-07-15 (v2 — incorporates review feedback: business-rule validation, intent-outcome validation, data consistency, cross-page validation, visual regression, per-observation confidence, defect clustering, regression detection, flakiness learning, risk scoring, and the Autonomous QA Analyst / release-intelligence layer)
**Scope:** The 10-phase "Enterprise AI QA Engineer" framework, extended per review into an **Autonomous QA Analyst**: after every run the platform answers not just "did assertions pass" but "did the app accomplish the intent, is the data consistent everywhere, what regressed, what's suspicious, and should this release ship."

---

## 1. Executive Summary

The platform executes compiled Playwright missions and records pass/fail, but it **stops at the first assertion verdict**. There is no investigation, no multi-source validation, no business-rule verification, no recovery, no classification, and the auto-filed defect carries a title and three log lines.

The motivating incident (2026-07-15, deployed): a create-account case ran with `appId=__all_apps__`, created the record **in App1**, the record was invisible to list-view search yet findable via **global search**, and the run reported **PASSED**. This incident exercises nearly every capability below: mission-scope validation, intent-outcome validation (the run "passed" without accomplishing the scoped intent), data-consistency validation (visible in one source, absent in another), investigation, classification, and professional reporting.

Four deep repository analyses (execution/orchestration, validation/DOM, evidence/reporting, context/AI) show the framework is **mostly an assembly problem**: the tool loop, error taxonomy, evidence pipeline, defect store, recovery taxonomy, episodic run memory, prior-run history, object schema access, and a proven investigate→repair→rerun scaffold all exist. The genuinely new surfaces: per-step before/after evidence, console/network capture, an investigation node, a failure-classification schema, business-rule/record validation, consistency sweeps, visual baselines, defect clustering, regression flags, risk scoring, and a per-run analyst report.

Eight phases, each ≤ 10–15 files, each independently shippable. Phases 1–2 are deterministic (no LLM) and default-on; LLM-bearing phases are flag-gated with bounded budgets.

---

## 2. Existing Architecture (verified, file:line-cited)

| Layer | Component | Location | Key facts |
|---|---|---|---|
| Execution primitive | `executePlaywrightScripts` | `server/features/playwright/executionService.ts:146` | Isolated temp project, JSON reporter, quarantine, `TestResult{…, stepScreenshotPaths[], tracePath}`; trace retained but never read; fixture-injection seam `autoScreenshotFixtureSource` (`:80`) |
| Emitted runtime | `MISSION_RUNNER_SOURCE` | `server/features/agent/compiler/missionRunner.template.ts` | ONLY sanctioned navigator/verifier; `verify()` context guard (`:59-81`); `reveal()` pre-action chokepoint (`:95`); no per-step captures |
| Workflow graph | `buildTestRunGraph` | `workflow/testRunGraph.ts:515-548` | `… → execute_tests → finalize`; `TEST_ASSERTION_FAILURE` informational (`nodes/execution.ts:159-167`) — failures skip straight to finalize |
| Error taxonomy | `WORKFLOW_ERROR_CLASSES` + retry table | `workflow/errors.ts:15-92` | 10 classes; infra-vs-assertion split; exp-jitter backoff |
| Assert vocabulary | `PLAN_ASSERTS` → `emitAssert` → runner | `compiler/testPlan.ts:13-17`, `playwrightCompiler.ts:66-89` | 8 element-scoped predicates; all 8 `VERIFY_*` intents collapse to `expectVisible`; single-target `AssertStep` |
| Compiled-output gate | `validateCompiledOutput` | `compiler/validateCompiledOutput.ts:9-32` | URL/network logic banned in specs → must live in MissionRunner |
| DOM intelligence | `captureSemanticSnapshot` + verify | `domExplorer.ts:496-514, 831-869` | aria + shadow-piercing sweep, scoped overlay capture, fieldMeta (required/pattern), live uniqueness+visibility |
| Object schema (API truth) | `fetchObjectSchema` / metadata map | `ai/tools/corePlatformData.ts:775, 560` | fields, types, required, picklists, unique flags, sample records — the business-rule substrate |
| Data tools | `query_records/count_records/aggregate_records/describe_app_schema/get_object_fields` | `ai/tools/corePlatformData.ts:174-259`, `corePlatformMeta.ts:118-419` | Access-enforced App-Service reads — record read-back, duplicates, relationships |
| API validation substrate | `api-intelligence/validation.ts:51-114` | | status/shape/null/**regression** diffing — ready-made, unwired to the agent path |
| Evidence | step-shot channel + `publishEvidenceShots` + `/evidence` | `executionService.ts:394-451`, `nodes/execution.ts:67-88` | `step-N` channel fully built, ONE producer; console/network capture entirely absent |
| Timeline | `agent_run_events` + `pageSession.actionsTaken` | `repository.ts:1434-1474`, `pageSession.ts:195-205` | Append-only per-run audit |
| Run history | `AgentRuns.list` + `run.execution_result`/aggregate per case title | `repository.ts:411-474` | Prior-run verdicts per case — the regression-detection substrate |
| Defect/report stores | `Defects`/`Reports` repos | `repository.ts:892-1002`, `schema.sql:127-193` | `steps_to_reproduce/expected/actual/evidence JSONB/severity/tags[]/source_run_id` already exist |
| Defect UI | `src/pages/Defects.tsx` | `:239-291` | Renders title-only; rich step+evidence renderer exists in `Reports.tsx:596-756` (reusable) |
| AI loop | `runToolLoop` + Reflexion + accept critic | `orchestrator.ts:375-568` | Honesty gate; grounded critic retries |
| Structured output | `generateStrictObject` one-repair loop | `workflow/nodes/authoring.ts:272-308` | Strict Zod → ONE repair call → typed error |
| Self-repair precedent | ExecutionRepair | `routes.ts:4033-4138` | investigate→repair→rerun, bounded; disabled on compiled path |
| Recovery taxonomy | `classifyFailure`/`withRecovery` | `ai/recovery.ts:69-228` | retry\|repair\|degrade\|escalate — unwired |
| Memory | `runMemory` + `objectRepository` | `ai/memory/runMemory.ts:31-190`, `graph/objectRepository.ts:83-130` | stable/flaky/broken + failureCause; versioned control history (drift signal) |
| Case-similarity precedent | `rankReuseCandidates` | `caseReuse.ts` | IDF-weighted similarity ranking — the clustering precedent |

## 3. Dependency Graph (relevant slice)

```
testRunGraph.executeTests
  └─ nodes/execution.runExecutionNode ─ executePlaywrightScripts ─ missionRunner template
       └─ TestResult{stepShots, trace, (NEW) console, network} → publishEvidenceShots → evidence/
  └─ (NEW) investigate_failures ─ pre-analysis (console/network/drift/flake/regression/record read-back)
       └─ LLM investigator (runToolLoop + tools) → failureClassificationSchema
       └─ (NEW) intent-outcome judge (also on suspicious passes)
       └─ (NEW) recovery ladder → recoveryAttempts
  └─ (NEW) defectReporter ─ cluster → regression flag → risk block → Defects.upsert (+ UI render)
  └─ (NEW) analyst node ─ run deltas + consistency + visual diffs → AnalystReport (Reports.upsert)
  └─ finalize (unchanged contract)
```

## 4–7. Runtime / Evidence / Context / Prompt Flows (today)

- **Runtime:** goal → mission → discovery → gate → author (goal+understanding+catalog) → plans → deterministic compile → execute (single session, shots 'on', trace retained) → finalize. On assertion failure: aggregate records it, run finalizes. Nothing investigates; nothing validates business outcome; passes are trusted blindly.
- **Evidence:** final screenshots via one fixture producer; `step-N` parser ready; traces unread; console/network not captured; timeline not attached to failures.
- **Context:** understanding → case author; evidence graph + stash → compile; runMemory feeds legacy script-gen only; nothing assembles a "why did this fail / what does the record actually contain" context.
- **Prompt:** canonical identities + per-agent routing; `analyze_run` is a schema-less JSON dump into `reportNarrator` (`controller.ts:971-987`) — no tools, no classification, no confidence.

## 8. Current Problems

1. Single-assertion verdicts; timeout errors carry no context.
2. **False positives** — weak/collapsed assertions let wrong-app creation pass; no intent-outcome check (create "passes" even if the record lands in Draft instead of Active, or in the wrong app).
3. Mission scope hole — `appId=__all_apps__` executes literally.
4. No multi-level validation — no URL/status/empty-state asserts, no list-vs-global cross-check, no record-via-API, no a11y.
5. **No business-rule validation** — required/unique/picklist/derived fields, status transitions, approvals, relationships, duplicate prevention are never checked against the API truth despite the schema being fetchable.
6. **No data-consistency validation** — a record can exist in global search but not the list (case study) and nothing compares sources; no cross-page (list/details/related/audit) verification.
7. Evidence gaps — no before/after per step, no console/pageerror, no network, traces unread.
8. No investigation/recovery on the compiled path; recovery taxonomy unwired.
9. No classification/root cause/confidence; no per-observation confidence.
10. Defects hollow (title-only UI; steps/expected/actual empty); **no clustering** (20 tests hitting one bug would file 20 defects); **no regression flags**; **no risk scoring**.
11. No flakiness statistics (single execution; runMemory not consulted/updated on the graph path).
12. **No visual regression** — layout breakage, clipped/overlapping/missing elements are invisible to assertions.
13. No release intelligence — nobody answers "what changed, what's suspicious, should this ship."

## 9. Root Cause Analysis

The pipeline was built to prove **grounded execution** (deterministic compile, honest verdicts); everything downstream of the verdict was explicitly deferred (`playwrightCompiler.ts:69-70`; informational `TEST_ASSERTION_FAILURE`). Evidence capture served the Evidence tab, not reproducibility. The IR is a closed vocabulary by design and nobody extended it past element predicates. The defect writer predates the graph path; its UI displayed nothing, so nobody enriched it. Business-rule/record validation was never wired because the API substrate (`api-intelligence`, data tools) grew in a parallel feature and no bridge was built. `__all_apps__` leaked because mission verify string-compares the URL param instead of requiring a concrete tenant app for mutations.

## 10. Proposed Architecture

All layers composed from existing parts; generic/app-agnostic (rules come from the app's own schema/metadata/history — never hardcoded); provider/model-agnostic (orchestrator routing); flag-gated LLM stages with bounded budgets; state carries refs/digests only.

### 10.1 Evidence Foundation (deterministic)
Instrumented fixture (console/pageerror/request-failed/response-summary collectors per context → per-test `console.json`/`network.json` artifacts through the existing attachment channel) + MissionRunner per-step before/after screenshots and step log (via `test.info().attach('step-N')` in every helper; bounded). `TestResult += consoleLogPath, networkLogPath`. Mission-scope hardening lands here too (`__all_apps__` mutation guard; `reserved`-style placeholder leads).

### 10.2 Professional Defect Reports + Clustering + Regression + Risk (deterministic)
`defectReporter` builds ONE professional defect per **failure signature** (not per test):
- **Duplicate clustering:** signature = normalized(error class + failing step target + bounded message). N tests sharing a signature → ONE defect listing all affected tests (`frequency: N`); cross-run dedup by signature tag (`@sig:<hash>`) — an existing open auto-defect with the same signature gets an occurrence update, not a duplicate. (Similarity precedent: `caseReuse.rankReuseCandidates`.)
- **Regression detection:** look up the most recent prior run containing the same case title with a passing verdict (`AgentRuns` history) → `regression: true, lastPassedRun/date` in the defect + `@regression` tag.
- **Risk block (deterministic inputs):** frequency (from clustering), regression flag, mission criticality (mutation vs read-only), blast radius (module), confidence — embedded as a structured Risk section; finalized scoring in the analyst phase.
- Full report fields: steps-to-reproduce (from the case), expected/actual (failing step + error), preconditions, environment (URL/app/run/browser/viewport/engine/build), test data used (resolved fill values), investigation performed + recovery attempts (from later phases), evidence gallery (before/after per step, console errors, network summary, trace link, timeline). Defects UI upgraded by reusing the `Reports.tsx` step+evidence renderer.

### 10.3 Investigation, Classification & Intent-Outcome Judge (LLM, flag `AGENT_INVESTIGATE`)
Graph node `investigate_failures` between `execute_tests` and `finalize`:
- **Deterministic pre-analysis:** map error → case step; read console/network artifacts; selector-drift check (`objectRepository` history); flake history (`runMemory` + prior-run stats); optional single re-run of the failing spec (flake probe); **record read-back** via data tools when the flow mutated data.
- **LLM investigator** (`failureInvestigator` identity; `runToolLoop`): tools = `get_failed_run_bundle` (NEW), page session seeded at the failing URL with run auth (NEW opener), `query_records/describe_app_schema`, `search_codebase/read_code_file`. Output via strict schema.
- **`failureClassificationSchema` (zod):** `classification` (functional | ui | ux | validation | data | search | filter | sorting | synchronization | state | permission | auth | api | performance | a11y | workflow | regression | automation_issue | environment | unknown), `rootCauseArea` + `confidence (0–1)`, `observations[] { statement, confidence, verifiedBy[] }` (**per-observation confidence with the verification methods that support it**), severity/priority, suggested investigation areas. Never fabricated certainty: every observation must cite its verification refs.
- **Intent-outcome judge (AI reasoning validation):** for mutation flows — including **suspicious PASSes** (bounded: mutation cases only) — compare the user's intent + case expectations against the post-action truth (API record read-back + final UI state): "customer created but status=Draft" → intent NOT satisfied → observation + defect draft even though assertions passed. This is the direct fix for the case-study false PASS.

### 10.4 Multi-Level UI/Search/Navigation Validation (IR + runtime)
`PLAN_ASSERTS += URL_MATCHES, HAS_STATUS (toast/alert/status region), EMPTY_STATE, ERROR_STATE, ROW_IN_LIST, FOUND_IN_GLOBAL_SEARCH`; optional second target/scope on `AssertStep` for cross-checks; real expansions for `VERIFY_TABLE/FILTER/SORT/VALIDATION/ERROR`; MissionRunner gains `expectUrl/expectStatusRegion/expectEmptyState/searchListFor/searchGlobalFor` (the sanctioned side-effect owner).

### 10.5 Business Rule & Data-Consistency Validation (the review's top priority)
A dedicated validation layer, sourced entirely from the app's own truth (schema/metadata/API/history — zero hardcoding):
- **Record validation (API acceptance ⇄ persistence):** after a mutation, read the record back (`query_records`) and verify: submitted values persisted verbatim; required/derived/default fields populated; picklist values within domain; unique constraints honored (**duplicate prevention**: attempted duplicate → rejected); parent/child relationships exist (`RELATED_RECORD_EXISTS`); reference integrity.
- **Status transitions / workflows:** record state before vs after an action; assert legal transition (`RECORD_STATE_IS`, transition observations against the object's status field domain); approval-gated flows verified by role (existing credentials store roles).
- **Calculations / derived fields:** derived-field read-back compared against inputs (formula results, totals, counters) — verified via API, flagged as observations with confidence when the derivation rule is unknown.
- **N-source consistency sweep (data consistency + cross-page):** after create/update, verify the record across ALL available sources: object list view, **global search**, details page (row-click navigation), related-object lists, API record, and (when present) recent-activity/audit regions. Any source disagreement → **consistency/synchronization bug** with per-source evidence. Bounded and generic (sources discovered from the live UI + schema, not hardcoded). This is the App1 incident, systematized.
- IR: `RECORD_VIA_API, RECORD_FIELD_EQUALS, RECORD_STATE_IS, NO_DUPLICATE_CREATED, RELATED_RECORD_EXISTS, CONSISTENT_ACROSS_SOURCES`; composes `api-intelligence/validation.ts` for shape/null/status checks.

### 10.6 Recovery Ladder (bounded, recorded)
Refresh / re-navigate / re-ground + alternate verified locator / single retry — each attempt recorded in `state.execution.recoveryAttempts` and the defect's "Recovery Attempts" section; outcomes fed to `runMemory`.

### 10.7 Visual Regression Investigation (deterministic diff + optional LLM description)
Per case-step baseline screenshots (stored under `evidence/baselines/<caseSignature>/<step>`), pixel+layout diff on subsequent runs (dimension shifts, missing/clipped/overlapping regions via bounding-box comparison from the semantic snapshot — reusing `captureSemanticSnapshot` geometry). Differences are **observations** (report-only initially, never hard failures): "button clipped", "region missing", with diff images attached. Optional LLM description of the diff, flag-gated.

### 10.8 Autonomous QA Analyst — Release Intelligence (capstone, flag `AGENT_ANALYST`)
A per-run analyst that consumes everything above plus run history and answers, with per-answer confidence: What changed vs the last run (pass-rate delta, duration deltas as a performance signal, visual diffs, selector drift)? What looks suspicious (intent-outcome mismatches on passes, consistency warnings, near-threshold timings)? What business rules were violated? Likely regressions? Flakiness vs product-bug split? **Release risk score (0–100)** with rationale (weighted: blocking defects, regressions, consistency failures, risk blocks, flake noise) and a **ship / ship-with-caution / block recommendation**. Output = `AnalystReport` (strict schema) stored via the existing `Reports` repo and rendered on the Reports page; summary line surfaced in run messages. Deterministic feature extraction feeds one bounded LLM synthesis — the numbers come from data, the LLM writes the judgment and rationale.

## 11. Complete Refactoring Strategy

Additive-first: every phase adds modules/fields behind existing seams; nothing existing is removed. Semantic changes are limited to: `VERIFY_*` real expansions (old plans compile identically), `__all_apps__` mutation rejection (correct-by-definition), and defect filing becoming per-signature (the old coarse whole-run defect remains). All LLM stages: strict schemas + one repair call + typed errors; flag-gated; budget-bounded (per-run caps on investigator/judge/analyst calls). State stays refs/digests; bundles live in the stash/evidence dir.

## 12–14. Files That Must Change — What / Why / Risk (per phase)

### Phase 1 — Evidence Foundation + Scope Hardening (deterministic, default-on)
| File | Why | Risk |
|---|---|---|
| `server/features/playwright/executionService.ts` | Instrumented fixture (console/pageerror/network collectors → per-test artifacts); parse into `TestResult.consoleLogPath/networkLogPath` | **Medium** |
| `server/features/agent/compiler/missionRunner.template.ts` | Per-step before/after screenshots + step log via `test.info().attach` (bounded); reject placeholder appIds in `verify()` for RUNTIME missions | **Medium** |
| `server/features/agent/workflow/nodes/execution.ts` | Publish console/network artifacts; extend refs/EvidenceShot | Low |
| `server/features/agent/routes.ts` | Legacy/re-run evidence parity; `__all_apps__` mutation-intent guard at run start (actionable rejection) | Medium |
| `server/features/agent/mission/missionContext.ts` | Concrete-app requirement for mutation-intent RUNTIME missions | Medium |
| `server/features/agent/testdata/engine.ts` | `reserved`-style placeholder leads | Low |
| `scripts/test-playwright-execution-evidence.ts` (NEW) | Fixture emits step shots + console/network through the parser | — |

### Phase 2 — Professional Defect Reports + Clustering + Regression + Risk block
| File | Why | Risk |
|---|---|---|
| `server/features/agent/workflow/defectReporter.ts` (NEW) | Signature clustering, cross-run dedup, regression lookup (AgentRuns history), risk block, full professional report per failure signature; idempotent ids | Low-Medium |
| `server/features/agent/workflow/testRunGraph.ts` | Wire reporter into `executeTests` (cases + evidence at hand) | Medium |
| `server/features/agent/routes.ts` | Enrich the coarse auto-defect via the same builder | Low |
| `src/pages/Defects.tsx` + `src/pages/Reports.tsx` | Render full reports (extract shared step/evidence renderer) | Low |
| `scripts/test-defect-reporter.ts` (NEW) | Draft shape, clustering (N failures → 1 defect), regression flag, idempotency, pass=no-defect | — |

### Phase 3 — Investigation, Classification & Intent-Outcome Judge (flag `AGENT_INVESTIGATE`)
| File | Why | Risk |
|---|---|---|
| `server/features/agent/workflow/nodes/investigation.ts` (NEW) | Pre-analysis (error→step, console/network, drift, flake, record read-back, single re-run probe) → investigator loop → strict classification; intent-outcome judge incl. bounded suspicious-pass checks; never blocks finalize | **High** |
| `server/shared/schemas.ts` | `failureClassificationSchema` + `observationSchema { statement, confidence, verifiedBy[] }` + `intentOutcomeSchema` | Low |
| `server/ai/systemPrompts.ts` | `failureInvestigator` identity + methodology prompt (reproduce→cross-check→classify; cite verification for every observation) | Low |
| `server/ai/tools/agentTools.ts` | `get_failed_run_bundle`, `rerun_failed_spec` (bounded) | Medium |
| `server/features/agent/pageSession.ts` | Opener seeded at failing URL + run auth | Medium |
| `server/features/agent/workflow/state.ts` | `execution.investigation` summary + `recoveryAttempts` channel | Medium |
| `server/features/agent/workflow/testRunGraph.ts` | Topology: conditional `investigate_failures` edge | **High** |
| `server/features/agent/workflow/runtime.ts` | Project investigation/judge summaries into messages/chips | Low |
| `server/ai/memory/runMemory.ts` | Graph-path consultation + outcome write-back (flakiness learning) | Low |
| `scripts/test-agent-investigation.ts` (NEW) | Stubbed provider/tools; schema round-trips; flag-off no-op; never-throws | — |

### Phase 4 — Multi-Level UI/Search/Navigation Validation
| File | Why | Risk |
|---|---|---|
| `compiler/testPlan.ts` | New assert kinds + optional `target2/scope`; strict parser | **High** (IR) |
| `compiler/playwrightCompiler.ts` | Emit new kinds; real `VERIFY_*` expansions; ground `target2` | Medium |
| `compiler/missionRunner.template.ts` | `expectUrl/expectStatusRegion/expectEmptyState/searchListFor/searchGlobalFor` | Medium |
| `compiler/semanticPlanner.ts` + `workflow/nodes/authoring.ts` | Map reviewed language + teach the vocabulary | Low |
| `scripts/test-playwright-compiler.ts` | New kinds + old-plan byte-compat | — |

### Phase 5 — Business Rule & Data-Consistency Validation
| File | Why | Risk |
|---|---|---|
| `server/features/agent/validation/businessRules.ts` (NEW) | Record read-back checks (persisted-verbatim, required/derived/defaults, picklist domain, unique/duplicate-prevention, relationships, state transitions) — sourced from `fetchObjectSchema` + data tools + `api-intelligence/validation.ts` | Medium |
| `server/features/agent/validation/consistencySweep.ts` (NEW) | N-source sweep (list, global search, details page, related lists, API, audit/activity regions) with per-source evidence; source discovery is live-UI/schema-driven | **Medium-High** |
| `compiler/testPlan.ts` + `playwrightCompiler.ts` + `missionRunner.template.ts` | `RECORD_VIA_API/RECORD_FIELD_EQUALS/RECORD_STATE_IS/NO_DUPLICATE_CREATED/RELATED_RECORD_EXISTS/CONSISTENT_ACROSS_SOURCES` + runner API helper | Medium |
| `workflow/nodes/investigation.ts` | Business-rule + consistency findings feed observations/classification | Low |
| `scripts/test-business-rules.ts` (NEW) | Schema-driven rule checks against fixture schemas; sweep result shapes | — |

### Phase 6 — Recovery Ladder
| File | Why | Risk |
|---|---|---|
| `workflow/nodes/investigation.ts` + `workflow/errors.ts` + `graph/groundingEngine.ts` (`alternateCandidatesFor`) + `ai/memory/runMemory.ts` | Bounded refresh/re-navigate/re-ground/alternate-locator/single-retry; recorded + learned | Medium |

### Phase 7 — Visual Regression
| File | Why | Risk |
|---|---|---|
| `server/features/agent/validation/visualBaseline.ts` (NEW) | Baseline store per case-step; pixel + bounding-box diff (semantic-snapshot geometry); diff artifacts; observation feed (report-only) | Medium |
| `workflow/nodes/execution.ts` + `defectReporter.ts` + `src/pages/Defects.tsx` | Wire diffs into evidence + reports | Low |
| `scripts/test-visual-baseline.ts` (NEW) | Diff determinism, baseline lifecycle | — |

### Phase 8 — Autonomous QA Analyst (flag `AGENT_ANALYST`)
| File | Why | Risk |
|---|---|---|
| `server/features/agent/workflow/analyst.ts` (NEW) | Deterministic feature extraction (deltas vs prior runs, duration/perf signals, defect/risk rollup, flake stats, consistency + visual findings) → ONE bounded LLM synthesis → `AnalystReport` schema (observations w/ confidence, regressions, business-rule violations, release risk 0-100 + rationale, ship/block recommendation) | Medium |
| `workflow/testRunGraph.ts` + `runtime.ts` | Analyst node before finalize (flag-gated); summary into messages | Medium |
| `server/db/repository.ts` (Reports usage only) + `src/pages/Reports.tsx` | Store/render the analyst report (existing Reports store — no schema change) | Low |
| `scripts/test-analyst.ts` (NEW) | Deterministic features; schema round-trip; flag-off no-op | — |

## 15. Backward Compatibility

All additions additive; old plans compile byte-identically (new IR kinds are additive enums); the coarse whole-run defect keeps its id space; per-signature defects use `DEF-AUTO-…`; investigation/judge/analyst are flag-gated (`AGENT_INVESTIGATE`, `AGENT_ANALYST`) with flag-off = exact current behavior; `__all_apps__` rejection applies only to mutation-intent RUNTIME runs; Defects/Reports schema untouched (fields already exist; analyst report uses the existing Reports store).

## 16. Migration Strategy

Ship phase-by-phase on `langchain_version`; each phase: lint → suites → live repro (`.testflow-pw/scratch`) → backend restart → user verification before the next. Deployment picks phases up via redeploy; new env flags only for LLM stages. No data migration.

## 17. Testing Strategy

Extend owning suites per seam (compiler 47, resume 103, engine 61, discovery 55) + new offline suites per phase (execution-evidence, defect-reporter incl. clustering/regression, investigation incl. flag-off no-op + never-throws, business-rules, visual-baseline, analyst). Live proofs per phase against the deployed surfaces — including the case-study replay: wrong-app run → loud rejection; create → consistency sweep catches list-vs-global divergence; intent judge catches a "passed" create that didn't satisfy intent. Verifier extended with `assessDefectReports` (every failure signature has a complete defect) to preserve the no-false-green philosophy.

## 18. Rollback Strategy

Per-phase commit sets → revert the phase. LLM stages additionally roll back instantly via flags. Evidence/baseline artifacts are additive files.

## 19. Estimated Implementation Effort

| Phase | Content | Est. |
|---|---|---|
| 1 | Evidence foundation + scope hardening | 1 day |
| 2 | Professional defects + clustering + regression + risk block | 1–1.5 days |
| 3 | Investigation + classification + intent-outcome judge | 2 days |
| 4 | Multi-level UI/search/URL validation | 1.5 days |
| 5 | Business rules + consistency sweeps | 1.5–2 days |
| 6 | Recovery ladder | 0.5–1 day |
| 7 | Visual regression | 1 day |
| 8 | Autonomous QA Analyst / release intelligence | 1–1.5 days |

## 20. Recommended Implementation Order — Phase Checklist

- [ ] **Phase 1 — Evidence Foundation + Scope Hardening** (7 files, Risk: Medium) — before/after step evidence, console/network capture, `__all_apps__` guard, placeholder leads. *Everything later consumes this; closes the wrong-app hole immediately.*
- [ ] **Phase 2 — Professional Defect Reports + Clustering + Regression + Risk** (6 files, Risk: Low-Medium) — per-signature professional defects with full fields and evidence, duplicate clustering, regression flags, deterministic risk block, Defects UI renders it all. *Deterministic; delivers "proper bug reporting every single time."*
- [ ] **Phase 3 — Investigation, Classification & Intent-Outcome Judge** (10 files, Risk: High) — the investigator node, per-observation confidence, flake probe/learning, suspicious-pass intent validation.
- [ ] **Phase 4 — Multi-Level Validation** (5 files, Risk: Medium-High) — URL/status/empty-state/search cross-check asserts; real `VERIFY_*` expansions.
- [ ] **Phase 5 — Business Rule & Data-Consistency Validation** (6 files, Risk: Medium-High) — record read-back rules, transitions, duplicate prevention, relationships, N-source consistency sweeps (the review's top priority; depends on 3+4 seams).
- [ ] **Phase 6 — Recovery Ladder** (4 files, Risk: Medium).
- [ ] **Phase 7 — Visual Regression** (4 files, Risk: Medium) — baselines, diffs, report-only observations.
- [ ] **Phase 8 — Autonomous QA Analyst** (4 files, Risk: Medium) — per-run release-intelligence report with risk score and ship/block recommendation.

Each phase ends with: build passes, suites green, no broken imports, live verification, per-phase report, before the next begins.

---

**Awaiting approval.** Reply with the scope to proceed (e.g. "approved: phases 1–2", "approved: 1–3", or "approved: all, one at a time") and implementation follows this plan exactly, one validated phase at a time.
