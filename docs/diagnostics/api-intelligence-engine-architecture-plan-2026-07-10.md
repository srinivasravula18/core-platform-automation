# API Intelligence Engine — Architecture & Implementation Plan

**Status: ANALYSIS ONLY. No code has been written. Nothing here is implemented. This is a plan awaiting explicit, separate approval (per `CLAUDE.md` / `AGENTS.md` Principal-Architect process).**

Goal: introduce a first-class, AI-powered **API Testing subsystem** ("API Intelligence Engine") that integrates into the existing Agent Console and Evidence architecture — an *AI QA Engineer for APIs*, not a Postman clone. Every claim below was verified against the current working tree (through `0b0ae15`).

---

## 0. Framework reconciliation (read first)

The brief asks for **Next.js + shadcn/ui**. The repo's frontend is **Vite 6 + React 19 + Tailwind 4 + Zustand + React Router 7**, with **no shadcn/ui and no Radix** (`package.json`, `vite.config.ts`, `src/App.tsx`). The brief also says, explicitly and with higher priority: *"Preserve the existing architecture. Do NOT migrate frameworks."*

**Decision (deviation with rationale):** we do **not** introduce Next.js or shadcn/ui. Migrating a working SPA to Next.js is exactly the disruption the constraint forbids and would touch the entire app for zero functional gain. We build the API Intelligence UI in the **existing stack** — matching the Agent Console's turn-card pattern, styling with the existing Tailwind theme tokens, using **Recharts** (already installed) for latency charts, and a small custom **JSON-diff** component. This delivers the requested UX (execution timeline, response viewer, JSON diff, latency charts, evidence explorer) without a framework migration. If Next.js is a hard requirement, that is a separate, much larger project and should be its own plan — flag it now if so.

---

## 1. Executive Summary

The platform already runs an agentic **UI** testing pipeline (repo analysis → feature discovery → DOM inspection → case generation → Playwright generation → evidence) as a fixed sequence of phases over a mutable `run` object (`server/features/agent/routes.ts`, `pipelineDelta.ts`), with a provider-agnostic orchestrator (`server/ai/orchestrator.ts`), a typed Evidence Registry (`server/features/agent/evidence/`), and a Vite/React Agent Console.

Crucially, **the API layer is not greenfield**. The repo already has: OpenAPI/Swagger auto-probing and contract derivation (`corePlatformData.ts:fetchSwaggerSpec`/`fetchCorePlatformObjectCatalog`), git-grep route discovery (`corePlatformMeta.ts:getApiRoutesTool`, MCP `get_api_routes`), an **existing structured API-contract agent** (`server/features/requirements/apiAnalystService.ts`), a generic authenticated executor (`call_api`, `agentTools.apiReadTool`), record CRUD tools (`corePlatformData.ts`), and the multi-tenant credential model (`credentialsService.ts:resolveCredentials`). HTTP is native `fetch` + Bearer everywhere; there is **no Postman handling** and **no axios**.

So the engine is mostly: **new agents** (planner, validator, failure-analyst, reporter) + **a new evidence type** (`APIEvidence`) + **a small execution/regression/cross-check core** + **a UI module** — all reusing the orchestrator, phase model, run object, Evidence Registry, and credential resolution unchanged. The unique differentiator (the "AI QA Engineer") is **cross-layer validation**: after an API response, the AI verifies the *effect* — repository contract cross-check, database state (via existing record-query tools), and DOM reflection (via the existing DOMExplorer) — not just the status code.

---

## 2. Existing Architecture (integration surface, with citations)

| Layer | Where | What we reuse |
|---|---|---|
| Agent registry | `server/ai/systemPrompts.ts` — `AGENT_PROMPTS` (l.172), `CANONICAL_AGENTS` (l.504), `systemPromptFor` (l.538), `composeSystemPrompt` (l.145) | Add new agent keys here |
| Orchestrator | `server/ai/orchestrator.ts` — `getOrchestrator` (l.630), `generateObject` (l.193), `runToolLoop` (l.375), `resolveProviderForAgent` (l.118) | Invoke new agents; no change |
| Phase model | `pipelineDelta.ts` phase-fn pattern + `phaseSummary` (l.49); `routes.ts` `pushPhase` (l.1079), `/api/agent/start` sequencing (l.4612), `markRunDone` (l.1120), `runStatusSnapshot` (l.576), `loadAgentRun` (l.1138) | New phases follow the same `{run,onPhase}` shape |
| Evidence Registry | `server/features/agent/evidence/registry.ts` (`EvidenceType` l.25-33, `recordEvidence` l.220), `provenance.ts` (`PROVENANCE.API` l.24) | Add `'api'` to `EvidenceType`; reuse `recordEvidence` |
| Evidence artifacts | `evidenceService.ts` (screenshots/storageState); run fields `evidence_screenshots`, `execution_result`; APIs `/api/agent-runs/:id/details` (full) & `/status` (counts) | Store `api_evidence[]` on the run; auto-surfaced |
| Persistence | `server/shared/storage.ts` `db.*` collections (l.44-82, schemaless), `persistDataInBackground` | Add `db.apiRuns`, `db.apiBaselines` |
| **API discovery** | `corePlatformData.ts:fetchSwaggerSpec` (l.340), object catalog from OpenAPI (l.374), `fetchCorePlatformMetadataMap` (l.559); `corePlatformMeta.ts:getApiRoutesTool` (l.338); MCP `get_api_routes` (l.197) | Discovery sources, mostly done |
| **API contracts** | `server/features/requirements/apiAnalystService.ts` — produces `{endpoint, method, path, auth, params, request/response examples}` (schema l.31-45) | Basis for the API Discovery Agent |
| **API execution** | MCP `call_api` (l.133, all verbs), `agentTools.apiReadTool`, native `fetch`+Bearer | Basis for API Executor |
| **DB/DOM cross-check** | record CRUD/query tools in `corePlatformData.ts` (`queryRecordsTool`, `countRecordsTool`, `createRecordTool`); `domExplorer.ts` (live DOM) | Cross-layer validation |
| Credentials | `credentialsService.ts:resolveCredentials` (l.342), Websites/WebsiteUsers (AES-256-GCM) | Target base URL + auth per run |
| Frontend | Vite/React/Tailwind/Zustand; `App.tsx` routes (l.354-383); `AgentConsole` `Turn` union (l.323-334); `useAgentRun` hook; components `DeepRunResult`, `GeneratedCases`, `MarkdownText`; Recharts installed | New route + turn-card + components |

No circular dependencies introduced — the new subsystem is a leaf that depends on existing services, not vice versa.

## 3. Dependency Graph (proposed, textual)

```
server/features/api-intelligence/            (NEW subsystem dir)
 ├─ pipeline.ts  (sequences phases; mirrors pipelineDelta)
 │    ├─ discovery.ts ── reuse: corePlatformData(fetchSwaggerSpec), corePlatformMeta(getApiRoutesTool),
 │    │                        apiAnalystService, + NEW postman importer
 │    ├─ planner.ts   ── orchestrator getOrchestrator('apiTestPlanner')
 │    ├─ executor.ts  ── native fetch + credentialsService.resolveCredentials  (NO LLM)
 │    ├─ validator.ts ── orchestrator('apiValidator') + deterministic diff
 │    ├─ regression.ts── db.apiBaselines diff (deterministic) + validator for semantics
 │    ├─ crossCheck.ts── corePlatformData(query/count records) + domExplorer  ← the differentiator
 │    ├─ failureAnalyst.ts ── orchestrator('apiFailureAnalyst')
 │    └─ reporter.ts  ── orchestrator('apiReporter') / template
 ├─ evidence.ts (build APIEvidence → recordEvidence(run,{type:'api',...}))
 ├─ store.ts    (db.apiRuns / db.apiBaselines CRUD + persist)
 ├─ types.ts    (ApiEndpoint, ApiContract, ApiTestCase, ApiExecution, ApiEvidence, ApiBaseline, ApiRun)
 └─ routes.ts   (/api/api-intelligence/*)
server/ai/systemPrompts.ts        (+ new agent prompts)
server/features/agent/evidence/registry.ts   (+ 'api' EvidenceType)
server/shared/storage.ts          (+ db.apiRuns, db.apiBaselines)
src/pages/ApiIntelligence.tsx + src/components/api/*   (frontend)
```

## 4. Runtime Flow (proposed)

```
POST /api/api-intelligence/start  (mirrors /api/agent/start: scope, folder, credentials, target)
 → APIDiscovery      : OpenAPI? → parse; else Postman? → import; else git-grep routes → apiAnalyst contracts
 → ContractUnderstanding : infer request/response schema, auth, dependencies (order endpoints by dep graph)
 → APITestPlanner    : positive / negative / boundary / security / authz / validation / regression / contract / perf-smoke scenarios
 → APIExecutor       : execute (GET/POST/PUT/PATCH/DELETE); collect status/headers/body/cookies/latency
 → AIValidation      : compare expected vs actual (fields/types/business-logic/nulls/authz), not just status
 → RegressionDiff    : diff vs last successful baseline (new/removed fields, type/value change, latency delta)
 → CrossLayerCheck   : DB state (query records) + DOM reflection (domExplorer) + repo contract   ← differentiator
 → FailureAnalyst    : on failure → root-cause class (breaking change / schema drift / authz / validation / db / dependency / timeout)
 → APIEvidence       : record per endpoint (request/response/expected/actual/diff/latency/confidence/env)
 → DeveloperReport   : API, request, response, expected/actual, diff, probable cause, confidence, suggested fix, related repo files, related test cases
 → baseline upsert (successful runs become regression evidence)
```

Reuses `pushPhase`/`phaseSummary`/`markRunDone`/`runStatusSnapshot`/`loadAgentRun` verbatim — the console's existing `useAgentRun` polling/streaming works unchanged for API runs.

## 5. Evidence Flow

New `APIEvidence` record (stored on `run.api_evidence[]`, tracked in the Evidence Registry as `type:'api'`, `source:PROVENANCE.API`):
```
APIEvidence {
  endpoint, method, request{headers,body,query}, response{status,headers,body,cookies},
  status, latencyMs, expected, actual, differences[], timestamp, environment, confidence,
  crossLayer?: { dbVerified: bool, domVerified: bool, notes }, sourceEvidenceId
}
```
`confidence`/`provenance` reuse the Phase-A vocabulary (`verified-live` for a real executed call). Regression baselines live in `db.apiBaselines` keyed by `{websiteId|host}+method+path+env`.

## 6. Context Flow

API agents receive a **typed context** (not a flat mega-prompt — we apply the WorkerContext discipline from the evidence plan proactively here since it's greenfield): `{ contract, endpoint, priorBaseline?, credentials(masked), relatedRepoFiles?, dbSchema? }` assembled immediately before each provider call, with explicit truncation markers. The executor itself takes **no** LLM input (pure HTTP), which keeps execution deterministic and cheap.

## 7. Prompt Flow

New agents get `composeSystemPrompt`-built system prompts (identity+scope+safety+grounding+agent instructions+output format), same as existing agents. Only `apiTestPlanner`, `apiValidator`, `apiFailureAnalyst`, `apiReporter` (and a light `apiDiscovery` reasoning step) call the model; each with a strict output schema via `generateObject`. `apiExecutor` and `regressionDiff` are deterministic code.

## 8. Current Problems this addresses

The platform tests UI thoroughly but has **no API testing at all** — no endpoint discovery, no contract-aware request/response validation, no regression baselining for APIs, no cross-layer "did the effect actually happen" verification. Everything needed to build it (discovery, execution, credentials, evidence, orchestration) exists in fragments but is **not composed into an API testing pipeline** or surfaced in the console.

## 9. Root Cause Analysis (why now, why this shape)

The absence is a missing *composition*, not missing primitives. Building API testing as a parallel pipeline that reuses the run/phase/evidence/orchestrator spine (rather than a separate tool) means it inherits the console UX, evidence trail, provider routing, and scope/credential model for free — and the differentiator (cross-layer effect verification) is only possible *because* the same platform already owns DOM inspection and DB query tools. A standalone API tester couldn't do that; this integrated one can.

## 10. Proposed Architecture

A new `server/features/api-intelligence/` subsystem + minimal edits to 3 existing files (systemPrompts, evidence registry, storage) + a frontend module. New agents registered by name; new phases follow the existing `{run,onPhase}` contract; new evidence via `recordEvidence`. **No change** to the orchestrator, provider adapters, existing agent pipeline, phase order of UI runs, or the existing Evidence/credential services.

### New agents (registered in `systemPrompts.ts`)
- `apiDiscovery` — discover endpoints; infer request/response schema, auth, dependencies (prefer OpenAPI; else Postman; else source).
- `apiTestPlanner` — generate positive/negative/boundary/security/authz/validation/regression/contract/perf-smoke scenarios.
- `apiValidator` — compare expected vs actual (missing/extra fields, wrong types, business-logic, nulls, authz).
- `apiFailureAnalyst` — root-cause classification + explanation.
- `apiReporter` — developer report (probable cause, confidence, suggested fix, related files/cases).
- `apiExecutor` is **not** an LLM agent — deterministic HTTP.

## 11. Complete Refactoring Strategy

Additive-first. All new code lives under `server/features/api-intelligence/` and `src/components/api/`. The only edits to existing files are additive: 3 agent-prompt keys, 1 `EvidenceType` member, 2 `db` collections, 1 sidebar route, 1 console turn-kind. No existing behavior changes; UI test runs are untouched.

## 12-14. Files that change — why — risk

| File | New/Edit | Why | Risk |
|---|---|---|---|
| `server/features/api-intelligence/types.ts` | new | Domain model | Low |
| `.../discovery.ts` | new | Compose OpenAPI + Postman + git-grep + apiAnalyst | Low-Med (reuses tested code) |
| `.../planner.ts` | new | apiTestPlanner phase | Low |
| `.../executor.ts` | new | Deterministic HTTP exec + latency/headers/cookies | Med (outbound calls; must be sandboxed to the run's target + honor read/write flags) |
| `.../validator.ts` `.../regression.ts` | new | AI compare + baseline diff | Med |
| `.../crossCheck.ts` | new | DB/DOM/repo effect verification (differentiator) | Med (touches DOMExplorer + record tools) |
| `.../failureAnalyst.ts` `.../reporter.ts` | new | Analysis + dev report | Low |
| `.../store.ts` `.../routes.ts` `.../pipeline.ts` | new | Persistence, endpoints, sequencing | Med |
| `.../evidence.ts` | new | Build APIEvidence → recordEvidence | Low |
| `server/ai/systemPrompts.ts` | edit (additive) | Register new agents | Low |
| `server/features/agent/evidence/registry.ts` | edit (1 line) | `'api'` EvidenceType | Low |
| `server/shared/storage.ts` | edit (additive) | `db.apiRuns`, `db.apiBaselines` | Low |
| `src/pages/ApiIntelligence.tsx` | new | Console module | Med |
| `src/components/api/{ApiRunResult,JsonDiff,LatencyChart,ContractViewer,EvidenceExplorer}.tsx` | new | UI | Med |
| `src/App.tsx` | edit (1 route + sidebar item) | Mount module | Low |
| `src/pages/AgentConsole.tsx` | edit (optional turn-kind) | Trigger API runs from chat | Med (largest FE file) |

**Write-safety note (critical):** the executor can mutate the target (POST/PUT/DELETE). It must default to **read-only** unless the run explicitly opts into writes, must be scoped to the run's resolved target only, and should prefer a non-prod environment / cleanup of created records (reuse `createRecordTool` semantics). This is called out as a required design gate, not an afterthought.

## 15. Backward Compatibility

Entirely additive: new endpoints under `/api/api-intelligence/*`, new `db` collections, new evidence type, new UI route. Existing runs/APIs/console flows are untouched. `EvidenceType` gains a member (existing switch/consumers already have `default` handling). Persisted data is forward-compatible (schemaless `db`).

## 16. Migration Strategy

No data migration. Baselines accumulate from first run forward. If OpenAPI/Postman absent, discovery degrades gracefully to source scan (already the apiAnalyst behavior).

## 17. Testing Strategy

- Unit (tsx scripts, repo convention): discovery parsers (OpenAPI/Postman/route-grep) against fixtures; validator diff (missing/extra/type/null/business); regression differ; APIEvidence shaping; executor against a local mock server.
- Integration: end-to-end API run against the deployed target's real endpoints (reuse the `adminacc` creds path), asserting registry populates, evidence records, and a dev report renders.
- Cross-layer: `POST` a record → assert DB query confirms creation → assert DOM reflects it → APIEvidence `crossLayer.dbVerified/domVerified`.
- Regression: run twice; second run diffs against baseline; introduce a synthetic schema drift and confirm it's flagged.

## 18. Rollback Strategy

Each impl-phase is a bounded, revertable commit; the subsystem is a leaf dir plus additive edits, so reverting removes it cleanly. The frontend module is behind its own route; the console turn-kind is optional and flag-guardable.

## 19. Estimated Effort

Medium-large overall, but front-loaded reuse keeps it tractable. Discovery/execution/credentials are ~60% existing. The genuinely new work is the planner/validator/failure/report agents, the regression baseline store, the cross-layer checker, and the UI.

## 20. Recommended Implementation Order (phase checklist — each ≤ one subsystem / ~10-15 files)

```
Impl-Phase 1 — Domain + Discovery (backend, no UI)
  api-intelligence/{types,store,discovery}.ts; storage.ts (db.apiRuns/apiBaselines);
  systemPrompts.ts (apiDiscovery); evidence registry ('api' type)
  Deliver: given a target, discover endpoints + contracts (OpenAPI→Postman→source). Risk: Low-Med.

Impl-Phase 2 — Planner + Executor + APIEvidence
  api-intelligence/{planner,executor,evidence,pipeline,routes}.ts; systemPrompts.ts (apiTestPlanner)
  Deliver: generate scenarios, execute (read-only default), record APIEvidence; /api/api-intelligence/start + status. Risk: Med.

Impl-Phase 3 — AI Validation + Regression + Failure + Dev Report
  api-intelligence/{validator,regression,failureAnalyst,reporter}.ts; systemPrompts.ts (apiValidator, apiFailureAnalyst, apiReporter)
  Deliver: expected-vs-actual semantic diff, baseline regression, root-cause, developer report. Risk: Med.

Impl-Phase 4 — Cross-Layer Validation (the differentiator)
  api-intelligence/crossCheck.ts (record-query + domExplorer + repo contract)
  Deliver: "was the effect real?" DB + DOM + repo verification into APIEvidence. Risk: Med.

Impl-Phase 5 — Frontend API Intelligence module (Vite/React/Tailwind, Recharts)
  src/pages/ApiIntelligence.tsx; src/components/api/{ApiRunResult,JsonDiff,LatencyChart,ContractViewer,EvidenceExplorer}.tsx;
  src/App.tsx route+sidebar; optional AgentConsole turn-kind
  Deliver: Discover/Generate/Execute/Review Evidence/History/Regression/Compare + timeline/response-viewer/JSON-diff/latency/evidence-explorer. Risk: Med.
```

Each impl-phase gets validated (build + tests + no regressions) before the next, and a fresh detailed sub-plan if it would exceed the file cap.

---

## Explicitly out of scope / non-goals

- No Next.js or shadcn/ui migration (see §0). No axios (native `fetch` stays). No Postman *clone* UX.
- No change to the UI-test pipeline's phase order, the orchestrator/provider adapters, or existing Evidence/credential services.
- Executor writes are opt-in and target-scoped by design (§12-14 write-safety gate).

---

**This document is analysis and planning only. No file has been modified as part of producing it. Implementation must not begin until this plan is approved on a separate turn, and must then proceed one impl-phase at a time with validation between phases, per `CLAUDE.md` / `AGENTS.md`.**
