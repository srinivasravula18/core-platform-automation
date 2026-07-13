# Implementation Plan — AI QA Engineer (Deterministic Compilation Architecture)

**Status:** Phase 0 (analysis only — no code changed). Awaiting explicit approval on a later turn before any implementation. Each phase below also stops for approval per `CLAUDE.md`.
**Author:** Principal Architect mode.
**Date:** 2026-07-10.
**Supersedes:** `docs/plans/playwright-compiler-refactor-plan.md` (that doc is the Playwright-compiler slice; this is the program it lives inside).

**Thesis:** Build an enterprise **AI QA Engineer** for metadata-driven platforms (Admin / Shockwave / Keystone), where **LLMs never emit executable code**. LLMs reason (coverage + risk + QA intent); everything executable is **compiled deterministically from verified runtime evidence**. Playwright becomes one backend among many (API, contract, a11y, performance, visual, DB) on a shared foundation: **MissionContext · Metadata Graph · Evidence Graph · Grounding Engine · QA Knowledge Graph**.

### Design amendments (authoritative — compose, never replace)

1. **Do NOT replace the Selector Registry.** The Evidence Graph **wraps** it: `VerifiedSelector`/`run.selector_registry` remain the selector store; graph nodes reference/compose registry entries. `renderSelectorRegistryForPrompt` and `runSelectorRegistryPhase` are preserved.
2. **Metadata Graph sits between Discovery and Evidence.** Discovery → **Metadata Graph** (objects/fields/tabs/relationships/lookups/permissions) → **Evidence Graph** (UI/API/DB evidence bound to metadata nodes).
3. **Compiler is an interface, not a Playwright class.** Define a backend-agnostic `Compiler` contract; `PlaywrightCompiler` is the first `implements`. Future backends (Cypress/API/perf/a11y) implement the same interface + reuse the Grounding Engine.
4. **Risk Analysis runs before the Structured Test Plan.** Pipeline: Coverage Planner → **Risk Analysis** → Structured Test Plan. Risk prioritizes/weights coverage items (change impact, history, blast radius) before intent is emitted.
5. **Metadata Objects are first-class entities** — objects/fields/tabs/relationships are nodes in the Metadata Graph, linked to UI evidence, API endpoints, coverage, and regression.
6. **Preserve existing subsystems:** DOM Explorer, Selector Registry, MissionContext, Evidence Registry all stay and are composed in — not rewritten.
7. **Refactor incrementally.** Never replace a working subsystem that can be composed. Each phase wraps/extends; legacy stays reachable.

---

## 1. Executive Summary

Today the LLM authors Playwright *source text* (`playwrightScriptsSchema.code` is an opaque string, `server/shared/schemas.ts:46-68`), so it hallucinates selectors, labels, URLs, `appId`s, navigation, waits, and login; ~10 regex post-processors then try to repair the text. That is structurally unfixable.

The target architecture is a deterministic pipeline:

```
MissionContext → Discovery Agent (UI+API+Metadata) → Metadata Graph → Evidence Graph (wraps Selector Registry)
   → Coverage Planner → Risk Analysis → Structured Test Plan (QA intent only)
   → Grounding Engine → Compiler (interface; Playwright backend first) → Execution → Evidence → Regression Suite
```

The LLM's authority ends at **Structured Test Plan** (semantic `VERIFY_*` / action intents referencing enumerated semantic targets). The **Grounding Engine** resolves each semantic target to a verified Evidence-Graph node; the **Compiler** emits code that can only reference resolved evidence; the **MissionRunner** owns auth/nav/verify/retries. A **validation gate** mechanically rejects any emitted artifact containing a forbidden construct.

This is delivered **incrementally, one subsystem per phase, flag-gated, backward-compatible**, each phase independently shippable and reversible.

---

## 2. Existing Architecture (code-cited)

- **Generation:** `runPostCaseAgentFlow()` `routes.ts:2436`; case writer `generateCasesForRun()` `routes.ts:1986-2182` (`testCasesSchema` `schemas.ts:31-44`, English steps); coder LLM writes code `routes.ts:2634-2676` / per-case `2708-2744`; output `playwrightScriptsSchema` `schemas.ts:46-68`.
- **Post-processing (to be retired):** `ensureExecutableLogin` `3355-3406`, `applyRoleSelectorSafetyGuards` `3234-3253`, `injectRuntimeFallbacks` `3268-3290`, `normalizeSelectorsFromInspection` `2406-2427`, `correctSelectorMethods` `selectorMap.ts:286-305`, `collapseDoubledLabels` `mission/missionContext.ts:219`, `guardLoginInteractions`/`neutralizeLoginAssertions` `3306-3353`, `sanitize/repairTestCode` `executionService.ts:66-127`.
- **Mission:** `MissionContext` `mission/missionContext.ts:22-35` (platformType, runtimeSurface, application, module, targetUrl, executionScope); verification snippet `buildMissionVerificationSnippet:164` (now surface-path based).
- **Evidence/selectors:** `VerifiedElement` `domExplorer.ts:551-577` (`unique`, `status`); `VerifiedSelector` `pipelineDelta.ts:418-433`; `runSelectorRegistryPhase` `:474`; `renderSelectorRegistryForPrompt` `:681` (withholds `not_unique`). Evidence registry `evidence/registry.ts:45-65`; provenance invariants `evidence/provenance.ts:14-54`.
- **API intelligence (branch `api-intelligence`):** `server/features/api-intelligence/*` — discovery→plan→execute→validate→regression→evidence→graph→coverage; typed link tables; write-safety gate. Already aligned with "API as first-class evidence."
- **Execution:** `runScriptsAndCollectEvidence` `routes.ts:3664-3870`; `createAuthStorageState` `evidence/evidenceService.ts:224-291` (pre-auth via storageState); `executePlaywrightScripts` `executionService.ts:145` (spawns `npx playwright test`). **No `MissionRunner`.**

---

## 3. Dependency Graph (target)

```
MissionContext ─▶ DiscoveryAgent ─▶ MetadataGraph ─▶ EvidenceGraph(wraps SelectorRegistry) ─▶ ObjectRepository (persistent, versioned)
       │                                                        │  ▲
       │                                                        ▼  │
       │                                                 GroundingEngine ◀── semantic targets
       ▼                                                        │
CoveragePlanner(LLM) ─▶ RiskAnalysis ─▶ StructuredTestPlan(LLM) ─▶ Compiler«interface»
                                   │                                    └─ PlaywrightCompiler ─▶ MissionRunner+specs ─▶ Execution ─▶ Evidence
                                   └──────────────────── QA Knowledge Graph (Requirement→…→Regression) ◀────────────────────────────┘
```
Every subsystem consumes **MissionContext**; nothing infers navigation independently. The **Metadata Graph** carries first-class objects/fields/tabs/relationships; the **Evidence Graph wraps** (does not replace) the Selector Registry. The **Grounding Engine** is the single resolver reused by every `Compiler` implementation.

---

## 4. Runtime Flow (target)

1. UI selection builds **MissionContext** (authoritative; prompt advisory only).
2. **Discovery Agent** inspects UI + API + metadata → **Metadata Graph** (first-class objects/fields/tabs/relationships/lookups/permissions).
3. **Evidence Graph** binds verified UI/API/DB evidence to metadata nodes, **wrapping the existing Selector Registry** (`VerifiedSelector` composed in, not replaced); persisted/versioned in the **Object Repository**.
4. **Coverage Planner** (LLM) emits a **Coverage Plan** (enumerated QA scenario types).
5. **Risk Analysis** weights/prioritizes coverage items (change impact, history, blast radius) **before** intent is emitted.
6. **Test Plan** (LLM) emits **QA intent only** (`VERIFY_TABLE`, `CLICK`→semanticTarget, …).
7. **Grounding Engine** resolves each semantic target → verified graph node (or `AMBIGUOUS`/`UNRESOLVED` → targeted re-discovery).
8. A `Compiler` implementation (**PlaywrightCompiler** first) emits code referencing only resolved evidence; entry/nav/login via **MissionRunner**.
9. **Execution** produces **Evidence**; deltas feed **Regression** + the **QA Knowledge Graph**.

---

## 5. Evidence Flow

Discovery records nodes with provenance/confidence (extending `recordEvidence`, `evidence/registry.ts`), preserving the invariant that `STATIC_SOURCE` can never be `verified-live` (`provenance.ts:51`). Evidence is **append-only/versioned** (never overwritten): each node keeps DOM-hash, screenshot ref, `lastVerified`, `version`, and `history`. UI evidence and **API evidence** (from `api-intelligence`) share one graph.

---

## 6. Context Flow

**MissionContext** is extended to the authoritative shape and becomes the sole navigation source:
```
platform · platformType · runtimeSurface · application · module · tab · targetUrl · executionScope
```
Admin: `application` selection not required; `appId` in `admin-ui/?nav=…&appId=…` is **legitimate** (Admin managing an app) and must not be rejected — consistent with the surface-path verification already landed. Shockwave/Keystone: `application` **and** module/tab required before generation; `runtimeSurface` distinguishes the two same-type deployments.

---

## 7. Prompt Flow

Two constrained LLM roles only, each fed the **enumerated** vocabulary so it cannot invent:
- **Coverage Planner** → Coverage Plan (closed enum of scenario kinds).
- **Test Plan author** → steps referencing only semantic-target names from the Grounding catalog + closed `action`/`assert` enums.
No LLM ever sees or emits selectors/URLs/roles/waits/login.

---

## 8. Current Problems

Ambiguous `getByRole('Apps')` (4 matches, fires before mission check); invented `getByTestId('button_all_appsall_metadata_action')`; re-derived `new URL()/searchParams.set('nav',…)/page.goto`; guessed `expect(page).toHaveURL(...)`; LLM-authored login despite pre-auth; `not_unique` hidden then reinvented; 10 fragile post-processors. Additionally: no persistent cross-run UI knowledge, no evidence versioning, no requirement→regression traceability, API evidence siloed on a branch.

---

## 9. Root Cause Analysis

**One decision** — letting the model emit executable code — produces every UI-selector defect. **Two structural gaps** — no persistent versioned Evidence Graph, and no single Grounding resolver — prevent the platform from becoming an extensible QA engine. Fix: remove code-authorship from the LLM, and make the Evidence Graph + Grounding Engine the permanent substrate all backends compile against.

---

## 10. Proposed Architecture (subsystems)

1. **MissionContext (extended, preserved)** — `+ platform, tab` on the existing type; single navigation source; prompt never overrides UI. Not rewritten.
2. **Discovery Agent** — inspects UI + API + metadata + relationships/lookups/permissions; composes the **existing DOM Explorer** and discovery, emitting into the Metadata + Evidence graphs.
3. **Metadata Graph (new layer, between Discovery and Evidence)** — first-class **Metadata Objects**: `object, field, tab, relationship, lookup, permission` nodes with edges (object→fields, object→tabs, object↔relationship, field→lookup). Built from platform metadata/API; the semantic backbone the Evidence Graph binds to.
4. **Evidence Graph (wraps the Selector Registry — does NOT replace it)** — a node layer over the **preserved** `run.selector_registry`/`VerifiedSelector`. Node: `id, semanticName, metadataRef, platform, application, module, page, evidenceKind(UI|API|DB|…), selectorRef→registry, confidence, uniqueness, provenance, domHash, screenshotRef, lastVerified, version, history`. Composes `renderSelectorRegistryForPrompt`/`runSelectorRegistryPhase`; extensible to API/DB/perf/a11y/logs.
5. **Coverage Planner** — LLM → enumerated Coverage Plan → deterministic Case Specifications.
6. **Risk Analysis (new, before Test Plan)** — deterministic-first weighting of coverage items by change impact / evidence history / blast radius (reuses `api-intelligence/risk.ts` scoring model); orders and prioritizes intent before it is emitted.
7. **Structured Test Plan (IR)** — LLM → `VERIFY_*`/action intents + semantic targets only.
8. **Grounding Engine** — `resolve(semanticTarget) → verified node | AMBIGUOUS_SELECTOR | UNRESOLVED_SELECTOR`; strategy order testid→aria→role→css→xpath taken from the node/registry, never inferred; shared by **every** `Compiler`.
9. **Compiler interface (backend-agnostic)** — `interface Compiler { compile(MissionContext, TestPlan, EvidenceGraph) → {code, diagnostics} }`. **`PlaywrightCompiler implements Compiler`** is the first backend; Cypress/API/perf/a11y implement the same contract and reuse the Grounding Engine.
10. **MissionRunner** — owns auth, platform/surface/application/module/tab selection+verification, retries, navigation. Owns nothing else (no assertions/coverage/compiler/business logic).
11. **API Testing (fold in `api-intelligence`)** — API endpoints as first-class evidence linked to metadata objects/UI/coverage; schema-diff → regression impact.
12. **Object Repository** — persistent Platform→Application→Module→Object→Controls knowledge; grows each run.
13. **Versioning** — append-only evidence/selector/DOM/app/object history → regression intelligence.
14. **QA Knowledge Graph** — Requirement→BusinessRule→Coverage→Case→Script→Evidence→Bug→Regression traceability + explanations.
15. **Validation gate** — rejects any emitted artifact with `page.goto` (outside MissionRunner), `new URL(`, `searchParams.set`, literal `appId`, `loginIfNeeded`, or an unresolved locator.

---

## 11. Complete Refactoring Strategy

Additive, flag-gated (`AIQA_COMPILER`), one subsystem per phase; legacy coder path stays default until the compiler proves parity on the **Admin List-View / Objects** slice (the current failing surface). Build the substrate (MissionContext extension, Metadata Graph, Evidence Graph **wrapping** the preserved Selector Registry, Grounding Engine) before the compiler, insert **Risk Analysis** ahead of the Test Plan, define the **`Compiler` interface** before writing the Playwright backend, then fold API evidence and knowledge-graph traceability on top. Every step **composes** existing subsystems (DOM Explorer, Selector Registry, MissionContext, Evidence Registry). No big-bang rewrite.

---

## 12. Every File That Must Change (by phase; ≤10–15/phase)

**Phase 1 — MissionContext extension + Metadata Graph + Evidence Graph core (wraps Selector Registry) + Object Repository**
- `mission/missionContext.ts` (add `platform`, `tab`; keep invariants — preserved, not rewritten) — Modified
- `server/features/agent/graph/metadataGraph.ts` (first-class object/field/tab/relationship/lookup/permission nodes+edges) — New
- `server/features/agent/graph/evidenceGraph.ts` (node/edge types that **reference** `VerifiedSelector` via `selectorRef`; store API) — New
- `server/features/agent/graph/objectRepository.ts` (persistent, versioned store) — New
- `server/db/schema.sql` (metadata_graph / evidence_graph / object_repository tables, append-only) — Modified
- `scripts/test-mission-context.ts` (extend), `scripts/test-metadata-graph.ts`, `scripts/test-evidence-graph.ts`, `package.json` — Modified/New

**Phase 2 — Discovery Agent → Metadata + Evidence graphs (adapter composing existing DOM Explorer / Selector Registry / api-intelligence)**
- `graph/discoveryAdapter.ts` (map metadata → Metadata Graph; `VerifiedElement`/`VerifiedSelector`/api endpoints → Evidence Graph nodes bound to metadata) — New
- `pipelineDelta.ts` (emit into graphs **alongside** the preserved legacy registry) — Modified
- `evidence/registry.ts` (link evidence records to graph node ids; registry untouched otherwise) — Modified
- `scripts/test-discovery-adapter.ts`, `package.json` — New/Modified

**Phase 3 — Grounding Engine + Compiler interface + Structured Test Plan IR**
- `graph/groundingEngine.ts` (`resolve` over Evidence Graph + preserved registry; AMBIGUOUS/UNRESOLVED) — New
- `compiler/Compiler.ts` (backend-agnostic `Compiler` interface + diagnostics types) — New
- `compiler/testPlan.ts` (IR types + `testPlanSchema`, closed enums) — New
- `shared/schemas.ts` (export IR; deprecate direct `playwrightScriptsSchema` behind flag) — Modified
- `compiler/renderCatalogForPrompt.ts` (enumerated targets for the plan LLM) — New
- `scripts/test-grounding-engine.ts`, `scripts/test-testplan-schema.ts`, `package.json` — New/Modified

**Phase 4 — PlaywrightCompiler (implements Compiler) + MissionRunner + validation gate (flag-gated, dark)**
- `compiler/playwrightCompiler.ts` (`implements Compiler`) — New
- `compiler/missionRunner.template.ts` — New
- `compiler/validateCompiledOutput.ts` (validation gate) — New
- `executionService.ts` (emit `mission-runner.ts`; sanitize/repair → no-op net) — Modified
- `scripts/test-playwright-compiler.ts`, `scripts/test-mission-runner.ts`, `scripts/test-validate-compiled.ts`, `package.json` — New/Modified

**Phase 5 — Coverage Planner + Risk Analysis + route integration; retire post-processors**
- `routes.ts` (coverage→**risk**→plan→compile path; remove regex stack from hot path; diagnostics→re-discovery) — Modified (**High**)
- `compiler/coveragePlan.ts` (enumerated coverage types + case specs) — New
- `graph/riskAnalysis.ts` (weight/prioritize coverage before Test Plan; reuse `api-intelligence/risk.ts` model) — New
- `selectorMap.ts` (drop `correctSelectorMethods` from hot path; function preserved for legacy path) — Modified
- `scripts/test-coverage-plan.ts`, `scripts/test-risk-analysis.ts`, `package.json` — New/Modified

**Phase 6 — API evidence fold-in + QA Knowledge Graph + versioning-driven regression**
- merge `api-intelligence` graph into `evidenceGraph` (shared nodes/edges) — Modified
- `graph/knowledgeGraph.ts` (Requirement→…→Regression traceability) — New
- `graph/versioning.ts` (history/diff → regression impact) — New
- `scripts/test-knowledge-graph.ts`, `scripts/test-versioning.ts`, `package.json` — New/Modified

---

## 13. Why Each File Must Change

Substrate first (Phases 1-3) so the compiler has a verified graph + a single resolver to compile against; compiler + runner (Phase 4) make code a deterministic artifact; route integration (Phase 5) removes LLM code-authorship and the regex stack; Phase 6 unifies API evidence and adds traceability/versioning so the platform is extensible and explains itself. Tests per phase per project convention.

---

## 14. Risk Level Per File

Low: graph/repository types, grounding engine, IR schema, catalog renderer, validators, all test scripts. Medium: `pipelineDelta.ts`/`evidence/registry.ts` wiring, `executionService.ts` runner emission, `missionRunner.template.ts`, `schema.sql`, api-intelligence merge. **High:** `routes.ts` generation path (Phase 5) — flag-gated, done last, legacy retained.

---

## 15. Backward Compatibility Concerns

Storage shapes unchanged (`run.playwright_scripts` still `{title,filename,code}`; `generated_cases`, `agent_runs`, `Scripts` untouched); execution APIs unchanged; legacy path preserved behind `AIQA_COMPILER` until parity; mission verification semantics preserved (moved into MissionRunner using the landed surface-path logic); Evidence Graph is additive alongside the existing registry until Phase 5 cutover. New DB tables are additive and append-only.

---

## 16. Migration Strategy

Land Phases 1-4 dark (flag off, no behavior change). Enable `AIQA_COMPILER=1` on a dev Admin List-View run; compare compiled output to legacy for identical cases; iterate grounding/compiler until zero diagnostics + green. Flip default; keep legacy reachable one release; remove legacy path + post-processors in a follow-up once proven. Backfill the Object Repository from live runs (versioned) so cross-run knowledge accrues.

---

## 17. Testing Strategy

Standalone `tsx` scripts (no jest): mission-context (extended), evidence-graph, discovery-adapter, grounding (unique→node; dup→AMBIGUOUS; missing→UNRESOLVED), testplan-schema, playwright-compiler (golden plan→golden code; zero forbidden constructs; every locator traces to a node), mission-runner (nav only from `targetUrl`; verification = existing impossible-matrix), validate-compiled (rejects planted violations), coverage-plan, knowledge-graph, versioning. Full regression each phase: `tsc --noEmit` + all `test:*` + `build:backend`. Live proof at Phase 5: real Admin List-View run, green, zero ambiguous/hallucinated selectors.

---

## 18. Rollback Strategy

Single lever `AIQA_COMPILER=0` restores the legacy path instantly (identical storage shape, no data migration). Phases 1-4 are additive/dark → zero rollback risk. New DB tables are additive (drop-safe). Git rollback = revert compiler/graph modules + the flag check.

---

## 19. Estimated Implementation Effort

P1 ~1d · P2 ~1d · P3 ~1–1.5d · P4 ~1.5–2d · P5 ~2d (high-risk core) · P6 ~1.5–2d. Total ≈ 8–10 focused days, each phase independently shippable and reversible. (The narrower Playwright-only slice, if you want value sooner, is P3+P4+P5 ≈ 4–5d.)

---

## 20. Recommended Implementation Order (phase checklist — stop for approval after each)

- **Phase 1 — MissionContext extension + Metadata Graph + Evidence Graph core (wraps preserved Selector Registry) + Object Repository (versioned).** *Risk: Low.* Exit: types + stores + append-only tables; mission/metadata/evidence-graph tests green; registry untouched; `tsc` clean; no behavior change.
- **Phase 2 — Discovery Agent adapter → Metadata + Evidence graphs (composing existing DOM Explorer / Selector Registry / api-intelligence).** *Risk: Medium.* Exit: live discovery populates both graphs in parallel with the legacy registry; adapter tests green.
- **Phase 3 — Grounding Engine + backend-agnostic Compiler interface + Structured Test Plan IR + target catalog.** *Risk: Low.* Exit: resolver + IR schema tests green (unique/AMBIGUOUS/UNRESOLVED); `Compiler` interface defined; no runtime change.
- **Phase 4 — PlaywrightCompiler (implements Compiler) + MissionRunner + validation gate (flag-gated, dark).** *Risk: Medium.* Exit: golden plan→code compiles with zero forbidden constructs; gate rejects violations; `build:backend` clean; flag off.
- **Phase 5 — Coverage Planner + Risk Analysis + route integration; retire regex post-processors.** *Risk: High.* Exit: `AIQA_COMPILER=1` runs coverage→risk→plan→compile on Admin List-View zero-diagnostic and passes live; legacy intact with flag off; full regression green.
- **Phase 6 — API evidence fold-in + QA Knowledge Graph + versioning-driven regression.** *Risk: Medium.* Exit: unified metadata+UI+API graph; Requirement→…→Regression traceability queryable; schema-diff → regression impact; tests green.

---

## Strict Requirements (enforced by the validation gate, §10.13)

Generated artifacts must contain **zero**: `page.goto()` (outside MissionRunner), `new URL()`, `searchParams.set()`, hardcoded `appId`, hardcoded selectors, invented labels, invented role names, `loginIfNeeded()`. Every locator must originate from a verified Evidence-Graph node; every action must reference a semantic target/`nodeId`, not free text; unresolved/ambiguous → explicit `UNRESOLVED_SELECTOR`/`AMBIGUOUS_SELECTOR` with targeted re-discovery, never a guess.

## Final Objective

An extensible **AI QA Engineer** — UI, API, contract, accessibility, performance, DB, visual, cross-browser — where the Playwright compiler is one backend, and **MissionContext, Evidence Graph, Grounding Engine, and QA Knowledge Graph** are the permanent foundation.
