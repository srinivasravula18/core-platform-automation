# Implementation Plan — Playwright Generation as Deterministic Compilation

**Status:** Phase 0 (analysis only — no code changed). Awaiting explicit approval on a later turn before any implementation.
**Author:** Principal Architect mode, per `CLAUDE.md`.
**Date:** 2026-07-10.
**Scope:** Redesign the CaseWriter → Playwright generation pipeline so every generated script is a deterministic **compilation artifact** built from verified runtime evidence, not LLM-authored code.

---

## 1. Executive Summary

Today the LLM writes Playwright **source text**. Because the model authors selectors, labels, URLs, `appId`s, navigation, waits, and login inline, it hallucinates them — `getByRole('button',{name:'Apps'})` (ambiguous, 4 matches), `getByTestId('button_all_appsall_metadata_action')` (invented + doubled label), `new URL(...); searchParams.set('nav','objects')` (re-deriving MissionContext), `expect(page).toHaveURL(...)` (asserting a URL the model guessed). A stack of ~10 regex post-processors then tries to repair the text after the fact. This is structurally unfixable: **you cannot reliably lint hallucination out of free-form code.**

The redesign inverts control:

- The LLM is **demoted** from code-author to **test-plan author**. It emits an abstract, typed **Test Plan IR** — a list of semantic steps (`{action, target}` / `{assert, target}`) that reference **only** enumerated semantic targets drawn from the Selector Registry. It emits no selectors, URLs, roles, labels, waits, or login.
- A new **deterministic Playwright Compiler** turns `(MissionContext, TestPlan, SelectorRegistry, EvidenceRegistry)` into Playwright code. Every locator originates from a verified registry entry resolved by `selectorId`. Navigation, login, waits, retries, and verification are delegated to a new runtime helper, **MissionRunner**.
- If a target cannot be resolved to a **unique verified** selector, the compiler emits an explicit `UNRESOLVED_SELECTOR` / `AMBIGUOUS_SELECTOR` diagnostic and triggers a **targeted re-inspection**, instead of guessing.

Net effect: the ten post-processors disappear; correctness becomes a **property of the compiler**, enforced by a validation gate that rejects any emitted file containing a forbidden construct (raw `page.goto`, `new URL`, `searchParams.set`, literal `appId`, `loginIfNeeded`, or a locator not traceable to a registry entry).

---

## 2. Existing Architecture

### 2.1 Generation pipeline (LLM authors code)
- `runPostCaseAgentFlow()` — `server/features/agent/routes.ts:2436` — orchestrates case → script → post-process → execute.
- Case writer — `generateCasesForRun()` — `routes.ts:1986-2182` — LLM emits `test_cases[]` via `testCasesSchema` (`server/shared/schemas.ts:31-44`): `{title, description, preconditions, tags, priority, type, steps:[{action, expected}]}`. **Steps are free-English prose.**
- Coder (batch) — `routes.ts:2634-2676` — one LLM call, `schema: playwrightScriptsSchema`; prompt injects mission context (`renderMissionContextForPrompt`), understanding, selector registry (`renderSelectorRegistryForPrompt`), DOM facts, and a hand-written `loginIfNeeded()` pattern (`routes.ts:2644-2659`).
- Coder (per-case fallback) — `routes.ts:2708-2744` — one LLM call per case via `alignScriptsToCases`.
- **Output schema** — `playwrightScriptsSchema` — `server/shared/schemas.ts:46-68` — `scripts:[{test_case_title, filename, code}]`. **`code` is raw model text.**

### 2.2 Post-processing (regex repair of model text)
All in `server/features/agent/routes.ts` unless noted:
- `sanitizeTestCode` / `repairTestCode` — `playwright/executionService.ts:66-127` — fix signatures / truncation.
- `normalizeScriptForCase` — `3255-3266`.
- `ensureExecutableLogin` — `3355-3406` — injects mission-verify snippet (`buildMissionVerificationSnippet`, `mission/missionContext.ts:164`), `collapseDoubledLabels`, login guards, credential constants.
- `applyRoleSelectorSafetyGuards` — `3234-3253` — bolts `.first()`/`{exact:true}` onto ambiguous roles.
- `injectRuntimeFallbacks` — `3268-3290`.
- `normalizeSelectorsFromInspection` — `2406-2427`.
- `correctSelectorMethods` — `selectorMap.ts:286-305`.
- `guardLoginInteractions` — `3306-3325`; `neutralizeLoginAssertions` — `3337-3353`.

### 2.3 Evidence & selectors (already verified — just not authoritative)
- `VerifiedElement` — `domExplorer.ts:551-577` — `resolved_selector`, `selector_strategy`, `fallback_selector`, `unique`, `status: verified|not_unique|broken|unresolvable`.
- `VerifiedSelector` — `pipelineDelta.ts:418-433` — `id`, `role`, `label`, `selector`, `selectorType`, `verified`, `verificationStatus`, `confidence`, `provenance`, `uniqueness`, `fallbackSelector`.
- `runSelectorRegistryPhase()` — `pipelineDelta.ts:474` — builds `run.selector_registry.{selectors, verified_selectors, unresolvable, coverage}`.
- `renderSelectorRegistryForPrompt()` — `pipelineDelta.ts:681` — top 160 `verified && (selector||fallback)`; **withholds `not_unique`** (diagnostics only).
- Evidence registry — `evidence/registry.ts:45-65`, provenance/confidence invariants — `evidence/provenance.ts:14-54` (`STATIC_SOURCE` can never be `verified-live`).

### 2.4 Execution (unchanged target)
- `runScriptsAndCollectEvidence()` — `routes.ts:3664-3870` — `createAuthStorageState()` (`evidence/evidenceService.ts:224-291`) pre-authenticates once; per-case loop calls `executePlaywrightScripts` with shared `storageState`.
- `executePlaywrightScripts()` — `playwright/executionService.ts:145` — writes specs to `.testflow-pw/{runId}/tests/`, generates `playwright.config.ts` (`288-311`), spawns `npx playwright test`.
- **No `MissionRunner` exists** (confirmed).

---

## 3. Dependency Graph

```
prompt ─▶ generateCasesForRun ──▶ test_cases[] (free English steps)
                                      │
              ┌───────────────────────┘
              ▼
   runPostCaseAgentFlow ─▶ coder.generateObject (LLM writes CODE)
              │                     │
              │           playwrightScriptsSchema.code (raw text)
              ▼                     ▼
   [10 regex post-processors] ─▶ run.playwright_scripts[{title,filename,code}]
              │
              ▼
   runScriptsAndCollectEvidence ─▶ createAuthStorageState ─▶ executePlaywrightScripts ─▶ npx playwright test

   Evidence side (already exists, under-used):
     domExplorer(VerifiedElement) ─▶ runSelectorRegistryPhase(VerifiedSelector[]) ─▶ renderSelectorRegistryForPrompt (text only)
     MissionContext (targetUrl authoritative) ─▶ renderMissionContextForPrompt (text only)
```

The registry and mission context feed the model only as **advisory prose**. Nothing structurally binds emitted code to verified evidence.

---

## 4. Runtime Flow (today)

1. Cases generated (English steps).
2. Coder LLM emits code guessing selectors/URLs/login from prose + advisory registry text.
3. Regex passes rewrite the text (`.first()`, credential injection, mission-verify snippet, label collapsing).
4. Scripts written to disk; `playwright.config.ts` generated; `npx playwright test` spawned with pre-auth `storageState`.
5. On failure, a repair cycle re-grounds DOM and **re-generates code** (`routes.ts:3884-4021`).

Failure surface observed in production: ambiguous `getByRole('Apps')` (strict-mode, 4 matches) fires *before* the mission snippet; invented `getByTestId(...)`; guessed column labels; `expect(page).toHaveURL(...)` on a guessed URL.

---

## 5. Evidence Flow

`inspection → dom (LIVE_DOM) → selector_registry (LIVE_DOM|STATIC_SOURCE)`, recorded via `recordEvidence` with provenance/confidence (`pipelineDelta.ts:97,271,659`). Uniqueness is **known** at `domExplorer.ts:625` and preserved as `VerifiedSelector.uniqueness`. **Gap:** this ground truth is rendered to text and then ignored by a model that free-writes locators.

---

## 6. Context Flow

`MissionContext` (`mission/missionContext.ts:22-35`) is the authoritative navigation source (`targetUrl`, `platformType`, `application`, `module`, `executionScope`). Today it is injected as prose (`renderMissionContextForPrompt`) and the model re-derives URLs anyway (`new URL(...).searchParams.set('nav', ...)`). **Gap:** MissionContext is not the *only* navigation source at runtime; generated code performs its own `page.goto`.

---

## 7. Prompt Flow

Coder prompt (`routes.ts:2634`) concatenates: target URL, mission block, understanding, feature inventory, memory, test data, DOM facts, selector map, **selector registry (160 verified)**, blackboard, feature grounding, learned skill, plus an inline `loginIfNeeded()` recipe and an "ACTION COMPLETION CONTRACT". Output constrained only to *shape* (`scripts[].code` is an opaque string) — not to *content*. The model is free to write any locator.

---

## 8. Current Problems

1. **Hallucinated locators** — `getByRole('button',{name:'Apps'})` matches 4; the model can't see uniqueness at author time.
2. **Invented test-ids / doubled labels** — `getByTestId('button_all_appsall_metadata_action')`; core-platform has zero test-ids.
3. **Re-derived navigation** — `new URL(...)`, `searchParams.set('nav','objects')`, `page.goto(...)` duplicate MissionContext and drift from it.
4. **Guessed assertions** — `expect(page).toHaveURL(/nav=objects&appId=/)` asserts a URL shape the model invented.
5. **LLM-authored login** — `loginIfNeeded`/`logoutIfAlreadySignedIn` in every script, though `storageState` already authenticates.
6. **Ambiguity hidden, not resolved** — `not_unique` selectors withheld from the model, which then reinvents them; `.first()` is bolted on post-hoc (a guess, not a resolution).
7. **Ten regex post-processors** — fragile, order-dependent, and unable to guarantee any of the success criteria.

---

## 9. Root Cause Analysis

**The generation contract lets the model produce free-form code.** Every downstream defect is a symptom of this single decision. The verified evidence needed to prevent each defect *already exists* (`VerifiedSelector.uniqueness`, `MissionContext.targetUrl`, `storageState` auth) but is offered as suggestion rather than enforced as the sole source. The fix is not more post-processing; it is to **remove the model's authority to write code** and give that authority to a deterministic compiler that can only reference verified evidence.

---

## 10. Proposed Architecture

### 10.1 Test Plan IR (new)
A typed, discriminated-union step list the LLM emits instead of code:
```jsonc
{
  "mission": "ADMIN",                 // echoed from MissionContext; not authored
  "module": "Objects",
  "steps": [
    { "action": "OPEN_MODULE", "target": "ObjectsNavigation" },
    { "assert": "VISIBLE",      "target": "ObjectsHeading" },
    { "action": "CLICK",        "target": "NewButton" },
    { "action": "FILL",         "target": "SearchResultsInput", "value": "zzzz" },
    { "assert": "NOT_VISIBLE",  "target": "AccessRecordRow" }
  ]
}
```
Rules enforced by schema + resolver: `target` MUST be a name/`selectorId` from the **Semantic Target Catalog**; no selectors, URLs, roles, aria, css, xpath, waits, login, goto, appId. `action`/`assert` are closed enums.

### 10.2 Semantic Target Catalog + Resolver (new)
- **Catalog**: derived from `run.selector_registry.verified_selectors`, exposing each verified-unique control as `{ semanticName, selectorId, label, role }`. This is the *only* vocabulary of targets the plan LLM sees.
- **Resolver** `resolveTarget(name|selectorId) → VerifiedSelector | AMBIGUOUS_SELECTOR | UNRESOLVED_SELECTOR`. Uniqueness is read from `VerifiedSelector.uniqueness`/`verificationStatus`. No inference, no concatenation, no `.first()`.

### 10.3 Playwright Compiler (new, deterministic)
`compile(MissionContext, TestPlan, SelectorRegistry, EvidenceRegistry) → { code, diagnostics }`:
- Emits `import` + `test.describe/test` scaffold.
- Entry navigation is **only** `MissionRunner.startMission(mission)` — never `page.goto`.
- Each step resolves `target` → verified locator via the resolver, using the **locator strategy order**: (1) verified `data-testid`, (2) verified `aria-label`, (3) verified role+accessible-name, (4) verified css, (5) verified xpath. The strategy is taken from `VerifiedSelector.selectorType`, never re-chosen by heuristic.
- Assertions prefer `expect(locator).toBeVisible()`; `toHaveURL` only if `MissionContext` explicitly defines that URL.
- Ambiguous/unresolved target → **do not emit a guess**; record `AMBIGUOUS_SELECTOR`/`UNRESOLVED_SELECTOR` diagnostic and signal the orchestrator to request a targeted re-inspection.

### 10.4 MissionRunner (new runtime helper)
Emitted once per run into the test project (e.g. `.testflow-pw/{runId}/mission-runner.ts`) and imported by every spec. Owns: login (via injected `storageState`, fallback credential fill), platform/runtime-surface selection, application/module navigation (built from `MissionContext.targetUrl` only), retries, and the surface/app/module **verification** currently inlined by `buildMissionVerificationSnippet`. Generated specs never call `page.goto`, `new URL`, or login helpers.

### 10.5 Validation gate (new)
A compiled-output linter that fails the build if an emitted file contains: `page.goto` (outside MissionRunner), `new URL(`, `searchParams.set`, a literal `appId`, `loginIfNeeded`/`logoutIfAlreadySignedIn`, or a locator string not present in the registry. This mechanically enforces §19 success criteria.

---

## 11. Complete Refactoring Strategy

Introduce the new pipeline **additively behind a feature flag** (`PW_COMPILER=1`), keeping the legacy coder path intact until the compiler reaches parity. Order: (1) IR + resolver + catalog (pure, additive); (2) compiler + MissionRunner (deterministic, golden-file tested, flag-gated); (3) PlanCompiler LLM step + route integration + retire post-processors; (4) MissionRunner owns login/nav end-to-end + validation gate on by default. Each phase is independently verifiable; the flag lets us A/B against the legacy path and roll back instantly.

---

## 12. Every File That Must Change

| # | File | Change | New/Modified |
|---|------|--------|--------------|
| 1 | `server/features/agent/compiler/testPlan.ts` | Test Plan IR types + zod `testPlanSchema` + step enums | New |
| 2 | `server/shared/schemas.ts` | Export `testPlanSchema`; keep `testCasesSchema`; deprecate direct use of `playwrightScriptsSchema` behind flag | Modified |
| 3 | `server/features/agent/compiler/selectorResolver.ts` | Semantic Target Catalog + `resolveTarget` (+ AMBIGUOUS/UNRESOLVED results) | New |
| 4 | `server/features/agent/compiler/playwrightCompiler.ts` | Deterministic `compile(...)` → `{code, diagnostics}` | New |
| 5 | `server/features/agent/compiler/missionRunner.template.ts` | MissionRunner source emitted into the run dir | New |
| 6 | `server/features/agent/compiler/renderCatalogForPrompt.ts` | Render the enumerated target catalog for the plan LLM | New |
| 7 | `server/features/agent/routes.ts` | Replace coder code-path (`2628-2764`) with plan→compile; retire regex post-processors (`2406-2427`, `3234-3406`); route diagnostics to re-inspection | Modified |
| 8 | `server/features/playwright/executionService.ts` | Emit `mission-runner.ts` into `tests/`; make `sanitize/repair` a no-op safety net | Modified |
| 9 | `server/features/agent/compiler/validateCompiledOutput.ts` | Success-criteria linter (validation gate) | New |
| 10 | `server/features/agent/selectorMap.ts` | Retire `correctSelectorMethods` from the hot path (compiler owns strategy) | Modified |
| 11 | `scripts/test-playwright-compiler.ts` | Golden-plan → golden-code compiler tests | New |
| 12 | `scripts/test-selector-resolver.ts` | Resolver: unique→locator, dup→AMBIGUOUS, missing→UNRESOLVED | New |
| 13 | `scripts/test-mission-runner.ts` | MissionRunner nav/verify unit tests | New |
| 14 | `package.json` | `test:compiler`, `test:resolver`, `test:mission-runner` scripts | Modified |
| 15 | `docs/plans/playwright-compiler-refactor-plan.md` | This document | New |

`renderSelectorRegistryForPrompt` (`pipelineDelta.ts:681`) stays for the plan-LLM catalog rendering but is no longer the locator source of truth.

---

## 13. Why Each File Must Change

Concise rationale per row above: (1-3) create the typed IR and the only legal target vocabulary; (4-6) make code a compilation artifact and centralize navigation/login; (7-8,10) remove the model's code-authority and the regex repair stack, wiring the deterministic path in; (9) mechanically guarantee the success criteria; (11-14) prove each layer in isolation per project testing convention; (15) the approved plan of record.

---

## 14. Risk Level Per File

| File | Risk | Why |
|------|------|-----|
| `compiler/testPlan.ts`, `schemas.ts` | Low | Additive types/schema. |
| `compiler/selectorResolver.ts`, `renderCatalogForPrompt.ts` | Low | Pure functions over existing registry. |
| `compiler/playwrightCompiler.ts` | Medium | New codegen; golden-file tested, flag-gated. |
| `compiler/missionRunner.template.ts` | Medium | Runtime behavior (login/nav); mirrors existing verified logic. |
| `compiler/validateCompiledOutput.ts` | Low | Read-only linter. |
| `executionService.ts` | Medium | Emits an extra file + import rewrite; execution path touched. |
| `routes.ts` | **High** | Core generation path; retires 10 post-processors. Flag-gated, last. |
| `selectorMap.ts` | Low | Removing a call from the hot path only. |
| test scripts / `package.json` | Low | Additive. |

---

## 15. Backward Compatibility Concerns

- **Storage shape unchanged:** `run.playwright_scripts` still stores `{test_case_title, filename, code}`; `code` is now compiler output. `generated_cases`, `agent_runs` schema, and `Scripts` table are untouched.
- **APIs unchanged:** `executePlaywrightScripts`, `runScriptsAndCollectEvidence`, and the HTTP routes keep their signatures.
- **Legacy path preserved** behind `PW_COMPILER` until parity; default stays legacy until Phase 4 flips it.
- **Mission verification** semantics preserved — moved from injected snippet into MissionRunner (same surface/app/module checks, using the already-corrected `surfacePath` logic).

---

## 16. Migration Strategy

1. Land Phases 1-2 dark (flag off) — no runtime behavior change.
2. Enable `PW_COMPILER=1` in a dev run against core-platform Admin/List View; compare compiled output to legacy for the same cases.
3. Iterate resolver/compiler until the Admin List-View suite compiles with **zero** diagnostics and passes.
4. Flip default to compiler; keep legacy reachable via `PW_COMPILER=0` for one release.
5. Remove legacy coder path and the ten post-processors in a follow-up cleanup once the compiler is proven in production.

---

## 17. Testing Strategy

Per project convention (standalone `tsx` scripts, no jest):
- `test:resolver` — unique target → exact verified locator; duplicate → `AMBIGUOUS_SELECTOR`; missing → `UNRESOLVED_SELECTOR`; never emits `.first()`/inferred names.
- `test:compiler` — golden `TestPlan` → golden Playwright; assert **zero** forbidden constructs (goto/newURL/appId/login/invented labels); assert every locator traces to a registry `selectorId`.
- `test:mission-runner` — `startMission` builds nav only from `MissionContext.targetUrl`; surface/app/module verification matches the existing impossible-matrix regression.
- `test:validate-compiled` — the validation gate rejects planted violations.
- Full regression: `tsc --noEmit` + all `test:*` + `build:backend` (esbuild).
- Live proof: one real Admin List-View run with `PW_COMPILER=1`, expecting a green suite with no ambiguous/hallucinated selectors.

---

## 18. Rollback Strategy

Single lever: `PW_COMPILER=0` restores the legacy coder path instantly (no data migration, storage shape identical). Because Phases 1-2 are additive and dark, they carry no rollback risk. Phase 3/4 changes to `routes.ts` are gated by the same flag; reverting the flag fully restores prior behavior. Git-level rollback is a clean revert of the compiler modules + the flag check.

---

## 19. Estimated Implementation Effort

| Phase | Files | Effort |
|-------|-------|--------|
| 1 — IR + Resolver + Catalog | 5 | ~0.5 day |
| 2 — Compiler + MissionRunner | 5 | ~1-1.5 days |
| 3 — PlanCompiler LLM + route integration + retire post-processors | 5-7 | ~1.5-2 days |
| 4 — MissionRunner owns login/nav + validation gate default-on + cleanup | 4-6 | ~1 day |

Total ≈ 4-5 focused days, each phase independently shippable and reversible.

---

## 20. Recommended Implementation Order (phase checklist)

**Phase 1 — Test Plan IR + Semantic Resolver + Catalog** *(Risk: Low)*
- Files: `compiler/testPlan.ts`, `shared/schemas.ts`, `compiler/selectorResolver.ts`, `compiler/renderCatalogForPrompt.ts`, `scripts/test-selector-resolver.ts`, `package.json`.
- Exit: resolver unit tests green; `tsc` clean; no runtime behavior change.

**Phase 2 — Deterministic Compiler + MissionRunner (flag-gated, dark)** *(Risk: Medium)*
- Files: `compiler/playwrightCompiler.ts`, `compiler/missionRunner.template.ts`, `compiler/validateCompiledOutput.ts`, `executionService.ts` (emit runner), `scripts/test-playwright-compiler.ts`, `scripts/test-mission-runner.ts`.
- Exit: golden-plan→golden-code tests green; validation gate rejects violations; `build:backend` clean; flag still off.

**Phase 3 — PlanCompiler LLM step + route integration** *(Risk: High)*
- Files: `routes.ts` (plan→compile path, retire `normalizeSelectorsFromInspection`/`applyRoleSelectorSafetyGuards`/`ensureExecutableLogin` login injection/`collapseDoubledLabels`/`correctSelectorMethods` from hot path), `renderCatalogForPrompt` wiring, diagnostics→re-inspection loop, `selectorMap.ts`.
- Exit: with `PW_COMPILER=1`, Admin List-View compiles zero-diagnostic; legacy path intact with flag off; full regression green.

**Phase 4 — MissionRunner owns login/nav + validation gate default-on + cleanup** *(Risk: Medium)*
- Files: `missionRunner.template.ts` (login lifted from scripts), `routes.ts` (remove in-script login), `executionService.ts` (import rewrite), validation gate default-on, `package.json`.
- Exit: generated specs contain zero `page.goto`/`new URL`/`loginIfNeeded`/literal `appId`; success criteria §ref enforced in CI; live Admin run green.

---

## Success Criteria (acceptance gate for the whole effort)

A generated Playwright file must satisfy **all**:
1. Zero hardcoded `appId`s.
2. Zero hardcoded URLs except the MissionRunner entry.
3. Zero invented labels.
4. Zero concatenated names (e.g. `App1app1`).
5. Zero `new URL()` / `searchParams.set()` in generated tests.
6. Zero `page.goto()` outside MissionRunner.
7. Zero `loginIfNeeded()` inside generated tests.
8. Every locator originates from a verified Selector Registry entry.
9. Every action references a `selectorId`/semantic target, not free-form text.
10. Unresolvable/ambiguous target → explicit `AMBIGUOUS_SELECTOR` / `UNRESOLVED_SELECTOR`, never a guess.

These are enforced mechanically by `compiler/validateCompiledOutput.ts` (§10.5) and proven by `scripts/test-*` (§17).
