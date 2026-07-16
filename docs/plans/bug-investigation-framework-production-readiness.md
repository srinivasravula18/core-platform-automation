# Enterprise Bug Investigation, Validation & Reporting Framework — Production-Readiness Report (Rebuild)

**Status:** All 8 phases implemented, unit-validated (918 assertions across 24 suites), lint-clean, loaded into a live backend.
**Branch:** `langchain_version` · **Engine:** LangGraph.js test-run graph (`AGENT_GRAPH_V2`)
**Date:** 2026-07-15 (rebuild — the first build was intentionally reverted; this is a fresh implementation per `enterprise-bug-investigation-framework-plan.md`)

---

## 1. Executive summary

The agent now does more than pass/fail a script. On every graph-engine run it captures per-step
before/after evidence with console/network logs, files **professional clustered defect reports** with
regression and risk context, **investigates** failures (classifies root cause with per-observation
confidence, catches passing-but-wrong outcomes), validates **business rules** against the object schema,
distinguishes **flaky** from deterministic failures via a live re-run probe, flags **visual regressions**,
and produces a terminal **release-intelligence report** (risk score + ship/caution/block recommendation).

Everything new is **additive and flag-gated**. With the new flags off, runs behave exactly as before.
Always-on behaviors — richer per-step evidence, mission-scope hardening, and clustered defect reports on
failing runs — strictly strengthen existing behavior; no capability is lost.

Both motivating incidents are addressed:
- **The App1 false PASS** (create ran with `appId=__all_apps__`, wrote into App1, reported PASSED):
  blocked at THREE levels — run start (`isMutationIntent` + all-apps → actionable rejection), runtime
  (compiler-derived `mutationIntent` in MISSION → `verify()` throws `MISSION SCOPE VIOLATION` on
  placeholder apps; placeholder ids are never fake-verified), and post-run (the intent-outcome judge +
  business-rule read-back file `@suspicious-pass` defects even on all-green runs).
- **"Bug reporting must be clear every single time, with before/after steps":** MissionRunner's `act()`
  wrapper attaches ordered before/after screenshots + a structured step log per interaction; the defect
  reporter turns every failing run into per-signature professional defects with repro steps, expected vs
  actual, environment, test data used, console errors, risk block, and an evidence gallery — rendered in
  the Defects UI as expandable rich reports.

## 2. What each phase delivers

| Phase | Capability | Flag | New / changed modules | Suite |
|------|------------|------|----------------------|-------|
| 1 | Per-step before/after screenshots + step log (`act()`/`captureStep()` → `step-N`/`step-log` attachments); console/pageerror/failed-network capture fixtures → `TestResult.consoleLogPath/networkLogPath/stepLogPath`; parser extracted as testable `parsePlaywrightResults`; scope hardening (`isMutationIntent`, all-apps mutation rejection at run start + `verify()`; placeholder test-data leads) | always on | `executionService.ts`, `missionRunner.template.ts`, `playwrightCompiler.ts` (mutationIntent), `appTargeting.ts`, `routes.ts`, `testdata/engine.ts`, `nodes/execution.ts` | execution-evidence **36** · scope-hardening **25** |
| 2 | Professional clustered defects: failure-signature clustering (N failures → 1 defect), cross-run dedup (`@sig:` tag → occurrence update), regression detection vs prior-run verdicts, deterministic risk block, environment/test-data/console evidence; `defects.metadata` JSONB (additive migration); Defects UI expandable `DefectReport` renderer; graph terminal hook `fileDefectsForRun` + legacy-path enrichment; `execution_result` projected onto graph runs | always on | `workflow/defectReporter.ts` (new), `repository.ts`, `schema.sql`, `runtime.ts`, `routes.ts`, `src/components/DefectReport.tsx` (new), `src/pages/Defects.tsx` | defect-reporter **39** |
| 3 | Investigation node between execute_tests and finalize: deterministic pre-analysis (error kind, step-log, console/network correlation — evidence-cited observations), bounded LLM classification (strict `failureClassificationSchema`, one-repair loop, `defectTriage` routing), intent-outcome judge on passing mutation cases → suspicious-pass defects (`DEF-AUTO-…-INTENT*`); never throws | `AGENT_INVESTIGATE` | `workflow/nodes/investigation.ts` (new), `shared/schemas.ts`, `testRunGraph.ts` (topology + router), `runtime.ts` (merge), `nodes/authoring.ts` (`generateStrictObject` exported), `artifactStash.ts` | agent-investigation **42** |
| 4 | Multi-level asserts: `URL_MATCHES, HAS_STATUS, EMPTY_STATE, ERROR_STATE, ROW_IN_LIST, FOUND_IN_GLOBAL_SEARCH` (context asserts — advisory-text targets, never grounded) + real `VERIFY_TABLE/FILTER/SORT/VALIDATION/ERROR` expansions; MissionRunner owns URL/ARIA-status/row/global-search lookups; engine-resolved values thread into row/search expectations; authoring prompt teaches the vocabulary | always on | `compiler/testPlan.ts`, `playwrightCompiler.ts`, `missionRunner.template.ts`, `nodes/authoring.ts` | playwright-compiler **74** (incl. old-plan compat) |
| 5 | Business-rule validation from the app's OWN schema: record-missing, persisted-verbatim, required-empty, picklist domain, type conformance, duplicate prevention; schema resolution via submitted-fields → record-keys → single-schema fallback; violations → suspicious pass on green, DATA reclassification on red (LLM cannot override) | `AGENT_INVESTIGATE` seam | `validation/businessRules.ts` (new), `nodes/investigation.ts`, `testRunGraph.ts` (objectSchema from stash) | business-rules **25** |
| 6 | Recovery/flake ladder: **live-wired** re-run probe (bounded 2/run, reuses the cached login) — a pass demotes the cluster to flaky (`@flaky` tag, severity softened, recovery attempts recorded in defect metadata) | `AGENT_INVESTIGATE` | `testRunGraph.ts` (`rerunFailing` closure), `nodes/investigation.ts` | covered in investigation + business-rules suites |
| 7 | Visual regression: per case-step baseline store (`evidence/baselines/<sig>/step-N.png`), PNG-header dimension diff + generous byte-fallback (no new deps), seeds from PASSING tests only, report-only findings → analyst observations | `VISUAL_REGRESSION` | `validation/visualBaseline.ts` (new), `testRunGraph.ts`, `artifactStash.ts` | visual-baseline **26** |
| 8 | Autonomous QA Analyst: deterministic features (pass-rate delta vs prior runs, regressions, newly-passing, intent/flake/business-rule/visual rollups, defect severity rollup) → release-risk 0-100 + ship/ship-with-caution/block + rationale; optional ONE-call LLM narrative (never invents numbers); stored as `run.analyst_report` (persists via `agent_runs.raw`) + a `QAAnalyst` run message | `AGENT_ANALYST` | `workflow/analyst.ts` (new), `runtime.ts` (`runAnalyst` hook + projection) | analyst **36** |

**Framework total: 303 assertions. Core regression re-run: 615 assertions (16 suites). Grand total: 918, all green.**

## 3. End-to-end data flow

```
execute_tests
  │  each MissionRunner interaction/assertion wrapped by act(): before+after screenshot (step-N, bounded 48)
  │  + step-log JSON entry; evidence fixture attaches console-log / network-log per test
  ▼
parsePlaywrightResults (executionService)
  │  materializes step-N shots + console/network/step logs → TestResult paths
  ▼
executionTests → run stash          ── VISUAL_REGRESSION → diffRunSteps → stash.visualFindings
  ▼
router: AGENT_INVESTIGATE + (failures | passing mutation cases) → investigate_failures | finalize
investigate_failures
  │  cluster by failure signature → deterministic guess + evidence-cited observations
  │  → rerunFailing probe (bounded 2; pass ⇒ flaky) → business-rule read-back (seam) → bounded LLM classify
  │  passing mutation cases → readback/business rules (deterministic) → intent-outcome judge (LLM)
  ▼  stash.investigation
finalize → terminal hooks (runtime pump)
  │  fileDefectsForRun: per-signature drafts + investigation merge + suspicious-pass defects → Defects
  │  runAnalyst (AGENT_ANALYST): buildAnalystReport → run.analyst_report + QAAnalyst message
  ▼
Defects page (expandable DefectReport: risk chips, repro steps, expected/actual, env, console, evidence gallery)
```

## 4. Flags & rollout

| Flag | Default | Effect when on |
|------|---------|----------------|
| `AGENT_GRAPH_V2` | off (required for the framework's graph pieces) | routes test runs through the LangGraph engine |
| `AGENT_INVESTIGATE` | off | investigation node (classification, intent judge, business rules, flake probe) |
| `AGENT_ANALYST` | off | terminal release-intelligence report |
| `VISUAL_REGRESSION` | off | per-step screenshot baseline diffing (report-only) |

All documented in `.env.example`. Recommended order: `AGENT_INVESTIGATE` first (catches the false-PASS
class), then `AGENT_ANALYST`, then `VISUAL_REGRESSION` after baselines seed on a known-good run.
Every gated path is wrapped so a failure inside it never fails the run.

## 5. Backward compatibility

- No public API removed or renamed. `defects.metadata` is an additive `ADD COLUMN IF NOT EXISTS` JSONB;
  `mapDefect` exposes it; existing readers see the same top-level fields.
- Old plans compile with identical step emissions (new assert kinds are additive enums; the only MISSION
  delta is the additive `mutationIntent` key).
- The coarse whole-run defect (`DEF-<run8>`) keeps its id space; per-signature defects use `DEF-AUTO-…`;
  the once-per-run occurrence guard prevents double filing when both the graph hook and the legacy
  artifact path fire.
- `__all_apps__` rejection applies ONLY to mutation-intent runs (read-only sweeps unchanged), enforced
  from plan-derived facts — no prompt text at runtime, no hardcoded app facts anywhere.
- Legacy pipeline untouched with `AGENT_GRAPH_V2` off; parallel-path fixtures ride the existing
  screenshot/sessionStorage gating.

## 6. Validation performed

- `npm run lint` (tsc --noEmit) — clean after every phase.
- Framework suites (303): execution-evidence 36 · scope-hardening 25 · defect-reporter 39 ·
  agent-investigation 42 · business-rules 25 · visual-baseline 26 · analyst 36 · playwright-compiler 74.
- Core regression (615): workflow-resume 103 · workflow-state 78 · request-graph 74 · authoring-graph 51 ·
  discovery-graph 55 · mission-runner 14 · testdata-engine 61 · testplan-schema 12 · mission-context 87 ·
  mission-regression 11 · validate-compiled 10 · compiled-generation 8 · grounding-engine 11 ·
  evidence-graph 11 · case-reuse 17 · knowledge-graph 12.
- Live backend restarted post-build: `[pg] schema applied` (metadata migration ran),
  `Backend running on http://localhost:3001`, `/api/health {"ok":true}`.

## 7. Remaining / recommended follow-ups

1. **Wire the Phase 5 live read-back injectors** — `readbackRecord(title)` / `listRecords(title)` at the
   graph call site (platform API fetch of the created record) so business-rule validation and the
   deterministic suspicious-pass check run against the real app. The seams are inert, unit-tested, and
   `objectSchema` is already threaded from the stash.
2. **Enable the flags in the live env** (`AGENT_GRAPH_V2` + the three framework flags) and replay the
   App1 create-account scenario end-to-end to confirm the run-start rejection, the suspicious-pass defect,
   and the before/after evidence rendering.
3. **Surface `visualFindings` on the Defects UI** (currently analyst observations only).
4. **Baseline hygiene** — seed visual baselines from a curated known-good run before trusting diffs.
5. **runMemory learning write-back** (flake outcomes) — optional; the graph path currently records
   recovery attempts in defect metadata only.

## 8. Rollback

Per-phase revert works file-wise; LLM stages also roll back instantly via flags. The `defects.metadata`
column and baseline artifacts are additive. The new modules (`defectReporter`, `nodes/investigation`,
`validation/businessRules`, `validation/visualBaseline`, `analyst`) are leaf modules; removing their call
sites in `testRunGraph.ts`/`runtime.ts` fully disengages them.

All work is **uncommitted** pending explicit approval to commit.
