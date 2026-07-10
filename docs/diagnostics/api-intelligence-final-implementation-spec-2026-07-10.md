# API Intelligence Engine — FINAL Implementation Specification (Source of Truth)

**Status: SPECIFICATION. No code written. This is the authoritative design.** It supersedes and consolidates:
- `api-intelligence-engine-architecture-plan-2026-07-10.md` (core Phases 1–5)
- `api-intelligence-phase6plus-qa-intelligence-plan-2026-07-10.md` (advanced Phases 6+)
- `api-intelligence-phase6plus-design-review-2026-07-10.md` (Principal-Engineer review)

Where those documents disagree, **this document wins.** It applies every review decision: typed link tables (no polymorphic edges), a mandatory redaction layer, a single rules-capable validator, bounded cross-layer checks, bounded (ego-graph) UI, a self-contained API context (no dependency on the deferred general WorkerContext), and vertical-slice-first sequencing. Design goal: **elegance** — the fewest moving parts that deliver an AI QA Engineer for APIs.

Non-negotiable constraints carried through: reuse the Orchestrator, Evidence Registry, PostgreSQL layer (`server/db/schema.sql` idempotent DDL applied by `migrate()`), credential model (`resolveCredentials`), and Agent Console. No framework migration (Vite/React/Tailwind/Zustand/Recharts). Additive only.

---

## 0. Design principles (the rules this spec obeys)

1. **One representation per fact.** Endpoints/DTOs are relational (PostgreSQL) and are the source of truth; run objects hold *evidence payloads* only and reference endpoints by id. No dual JSON/relational copies that can drift.
2. **Typed, FK'd relationships.** The Knowledge Graph is a set of narrow typed link tables (the proven `requirement_case_links` pattern) with `ON DELETE CASCADE`. No polymorphic edge table. Integrity and cleanup are automatic.
3. **Redaction is mandatory and central.** Nothing with credentials/PII is persisted or displayed unredacted. One `redact()` boundary sits in front of all execution/evidence writes.
4. **Deterministic where possible; agents only for judgment.** HTTP execution, dependency inference, risk scoring, flaky detection, contract diffing, graph upserts, coverage, and redaction are code. Agents are used only for planning, semantic validation, failure reasoning, and reporting.
5. **Bounded by default.** DOM cross-check is opt-in/sampled/Critical-only. Graph traversal and its UI are ego-graph (N-hop) with lazy expansion. Executions have retention + rollups.
6. **Self-contained context.** API agents consume one typed `ApiRunContext`, assembled just before each provider call — decoupled from the deferred general WorkerContext, so nothing here is blocked on unbuilt scaffolding.
7. **Write-safety is structural.** Mutating execution is opt-in, target-scoped, hard-blocked against production, and paired with compensating teardown.

---

## 1. Final Architecture

```
                     ┌──────────────────────────────────────────────────────┐
 POST /start ──▶  API RUN PIPELINE (procedural, reuses agent-run spine)      │
                  discover→deps→version→risk→rules→plan→execute→validate→     │
                  regress→flaky→cross-layer→evidence→graph-upsert→report      │
                     │            │                    │                      │
        deterministic│      agents (5)          redact() boundary            │
                     ▼            ▼                    ▼                      │
   ┌─────────────────────────────────────────────────────────────────────┐  │
   │  PostgreSQL (normalized, FK'd, project/app/owner scoped)             │  │
   │  Facts:   api_endpoints · api_dtos · api_contract_versions           │  │
   │  Graph:   typed link tables (endpoint↔dto/file/table/req/case/ui/    │  │
   │           evidence/defect) + api_dependencies                        │  │
   │  History: api_executions (redacted) → api_execution_daily (rollup)   │  │
   │  Signals: api_business_rules · api_flaky_flags · api_flows/flow_runs  │  │
   │  State:   api_missions (run-scoped)                                   │  │
   └─────────────────────────────────────────────────────────────────────┘  │
                     │ read models (cached)                                   │
     ┌───────────────┼───────────────────────────┬────────────────────────┐  │
     ▼               ▼                            ▼                        ▼  │
 ApiRunContext   Coverage Dashboard        Ego-Graph + Evidence      Mission │
 (feeds agents)  (Recharts, on-read+cache)  Explorer (lazy, N-hop)   panel   │
   └──────────────────────────────────────────────────────────────────────┘─┘
   Run evidence payloads (redacted) live on the run object; Evidence Registry
   metadata points at them (payloadRef unchanged). PG holds derived intelligence.
```

The pipeline reuses `pushPhase`/`phaseSummary`/`markRunDone`/`runStatusSnapshot`/`loadAgentRun` and the console's existing `useAgentRun` polling. API runs are a distinct run kind stored in `db.apiRuns` (JSON store) / `agent_runs`-style persistence for the *run envelope*; all **intelligence** lives in the normalized tables above.

## 2. Final Database Schema (appended idempotently to `server/db/schema.sql`)

All tables: `CREATE TABLE IF NOT EXISTS`, indexed, scoped by `project_id/app_id/owner_id`, applied by `migrate()`. **Typed FKs with CASCADE — no polymorphic table.**

**Facts**
```sql
api_endpoints(
  id TEXT PK, project_id TEXT, app_id TEXT, owner_id TEXT,
  method TEXT, path TEXT, operation_id TEXT, summary TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}', base_url TEXT DEFAULT '',
  contract_hash TEXT, risk_score INT DEFAULT 0, risk_tier TEXT DEFAULT 'Low',
  risk_factors JSONB DEFAULT '{}', risk_overridden_by TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now());
UNIQUE(project_id, app_id, method, path);   -- endpoint identity
api_dtos(id TEXT PK, project_id, app_id, name TEXT, kind TEXT /*request|response*/,
         schema JSONB, hash TEXT, created_at TIMESTAMPTZ DEFAULT now());
api_contract_versions(id TEXT PK, endpoint_id TEXT REFERENCES api_endpoints(id) ON DELETE CASCADE,
         version INT, contract JSONB, contract_hash TEXT, source_run_id TEXT,
         created_at TIMESTAMPTZ DEFAULT now());  UNIQUE(endpoint_id, version);
```

**Knowledge Graph — typed link tables** (each: FK + `ON DELETE CASCADE`, `UNIQUE`, indexed on both sides)
```sql
api_endpoint_dtos(endpoint_id →api_endpoints CASCADE, dto_id →api_dtos CASCADE,
                  direction TEXT /*request|response*/);  UNIQUE(endpoint_id,dto_id,direction);
api_endpoint_files(endpoint_id →api_endpoints CASCADE, repo TEXT, file_path TEXT, confidence NUMERIC);
api_endpoint_tables(endpoint_id →api_endpoints CASCADE, table_name TEXT, access TEXT /*read|write*/, confidence NUMERIC);
api_endpoint_requirements(endpoint_id →api_endpoints CASCADE, requirement_id →requirements CASCADE);
api_endpoint_cases(endpoint_id →api_endpoints CASCADE, case_id →cases CASCADE);
api_endpoint_ui(endpoint_id →api_endpoints CASCADE, ui_page TEXT, ui_ref TEXT);
api_endpoint_defects(endpoint_id →api_endpoints CASCADE, defect_id →defects CASCADE);
api_evidence_links(endpoint_id →api_endpoints CASCADE, run_id TEXT, evidence_id TEXT, kind TEXT);
api_dependencies(id TEXT PK, from_endpoint_id →api_endpoints CASCADE, to_endpoint_id →api_endpoints CASCADE,
                 kind TEXT /*produces_token|requires_auth|data_dep|ordering*/, field_map JSONB,
                 confidence NUMERIC, created_at TIMESTAMPTZ DEFAULT now());  UNIQUE(from_endpoint_id,to_endpoint_id,kind);
```
The "graph" is the union of these tables. Traversal = join an endpoint's link tables one hop (ego-graph). Deleting a case/requirement/defect/endpoint cleans its edges automatically.

**History (redacted) + rollups**
```sql
api_executions(id TEXT PK, endpoint_id →api_endpoints CASCADE, run_id TEXT, flow_run_id TEXT,
   status TEXT, status_code INT, latency_ms INT,
   request_redacted JSONB, response_redacted JSONB, environment TEXT,
   created_at TIMESTAMPTZ DEFAULT now());                     -- retention: prune > N days (config)
api_execution_daily(endpoint_id →api_endpoints CASCADE, day DATE, runs INT, passes INT, fails INT,
   p50_latency INT, p95_latency INT);  UNIQUE(endpoint_id, day);   -- rollup for coverage/flaky/trends
```

**Signals**
```sql
api_business_rules(id TEXT PK, endpoint_id →api_endpoints CASCADE, project_id, rule_text TEXT,
   severity TEXT, source TEXT /*repo|requirement|knowledge|manual*/, source_ref TEXT, created_at);
api_flaky_flags(endpoint_id →api_endpoints CASCADE PK, is_flaky BOOL, confidence NUMERIC,
   likely_reason TEXT, sample_window INT, last_evaluated TIMESTAMPTZ);
api_flows(id TEXT PK, project_id, app_id, name TEXT, journey JSONB /*ordered steps + data map*/,
   source TEXT /*ai|manual*/, status TEXT, created_at);
api_flow_runs(id TEXT PK, flow_id →api_flows CASCADE, run_id TEXT, status TEXT,
   step_results_redacted JSONB, created_at);
```

**State (one table, run-scoped)**
```sql
api_missions(run_id TEXT PK, project_id, app_id, mission TEXT,
   tasks JSONB /*[{id,label,phase,state,evidenceRefs}]*/, coverage JSONB, risk JSONB, updated_at);
```

**Cut from earlier drafts (do not create):** generic `graph_edges`, `graph_nodes` registry, `qa_memory_index` (+embedding), `api_coverage_snapshots` (coverage computed on-read + cached; add a rollup table only if a trend-perf problem is proven), `api_mission_tasks` (tasks are JSONB on `api_missions`).

**Degraded mode:** when `DATABASE_URL` is unset, runs still execute and produce evidence on the run blob; the intelligence tables are skipped and analytics UIs show "PostgreSQL required." A PG outage mid-run never fails the run — graph/rollup writes are deferred/retried.

## 3. Final Execution Flow

`POST /api/api-intelligence/start { scope, targetUrl, credentialsRef, mode: 'single'|'flow', writeEnabled=false }`
```
1. ApiDiscovery (agent+deterministic) — OpenAPI(fetch+parse) → else Postman(import) → else source scan
      (reuse corePlatformData.fetchSwaggerSpec, corePlatformMeta.getApiRoutesTool, apiAnalystService)
      → upsert api_endpoints, api_dtos, api_endpoint_dtos, api_endpoint_files
2. DependencyInference (deterministic) — OpenAPI security + response→request field match + light AI fallback
      → upsert api_dependencies
3. ContractVersioning (deterministic) — hash contract; snapshot new api_contract_versions only on change; diff vs prior
4. RiskScoring (deterministic) — weighted factors {auth,financial,admin,delete,mutation,prod,deps,regression}
      → api_endpoints.risk_*  (transparent factors, user-overridable)
5. BusinessRuleHarvest (deterministic) — from requirements.business_rules + apiAnalyst + app knowledge
      → upsert api_business_rules
6. ApiTestPlanner (agent) — risk+dependency+rule aware. Produces scenarios
      (positive/negative/boundary/security/authz/validation/contract/perf-smoke) AND, when mode='flow',
      ordered business journeys from the dependency graph.
7. ApiExecutor (deterministic HTTP) — execute singles/flows with token+data carry-over;
      REDACT before persist; append api_executions (+ api_flow_runs); update api_execution_daily.
      Writes only if writeEnabled AND environment≠production; flows include compensating teardown.
8. ApiValidator (agent, rules-capable) — status/schema/type/null/authz AND business-rule semantic diff + explanations.
9. RegressionDiff (deterministic) — vs last-good contract version + last-good response baseline.
10. FlakyEval (deterministic + ApiFailureAnalyst for the reason) — over api_execution_daily.
11. CrossLayer (BOUNDED) — DB record-query (broad, cheap) + DOM reflection (opt-in, sampled, Critical mutations only).
12. Evidence — record 'api'|'api_flow'|'business_rule'|'regression' (payloads REDACTED on the run blob).
13. GraphUpsert — write typed link tables (endpoint↔req/case/ui/table/evidence/defect).
14. Mission update (every phase) + Coverage recompute (cached).
15. ApiReporter (agent) — developer report (probable cause, confidence, fix, related files/cases).
```
`ApiRunContext` is assembled immediately before each agent call (steps 6, 8, 15). Mission State is updated at every step so the console shows a live task board.

## 4. Final API Contracts (`/api/api-intelligence/*`, body/`x-project-id` scoped, redacted responses)

| Method | Path | Purpose |
|---|---|---|
| POST | `/start` | Begin a run → `{ taskId }` |
| GET | `/runs/:id/status` | Snapshot (phases, counts, mission summary) |
| GET | `/runs/:id` | Full run (redacted evidence) |
| GET | `/runs/:id/mission` | Mission State (also streamed via existing run events) |
| GET | `/endpoints?app=` | List endpoints (method/path/risk/coverage) |
| GET | `/endpoints/:id` | Endpoint + **one-hop** typed links (ego node) |
| GET | `/endpoints/:id/graph?depth=2` | **Bounded** ego-graph (default 1, max 3), paginated |
| GET | `/endpoints/:id/versions` · `/diff?from=&to=` | Contract versions + any-two diff |
| GET | `/dependencies?app=` | Dependency edges / topological order |
| GET/POST | `/business-rules` | List / add rules |
| GET | `/risk?app=` · POST `/endpoints/:id/risk/override` | Risk scores / manual override |
| POST | `/flows/plan` · GET `/flows` · POST `/flows/:id/run` | Plan/list/run flows (**run is write-gated + prod-blocked + confirmed**) |
| GET | `/coverage?app=` | Coverage read model (cached) |
| GET | `/flaky?app=` | Flaky endpoints + reasons |
| GET | `/memory?endpoint=` | QA-memory recall payload |

Traversal/chain endpoints enforce depth limits + pagination; no whole-graph responses.

## 5. Final Agent Responsibilities (exactly 5 agents; registered in `systemPrompts.ts`)

| Agent | Judgment it provides | Input (ApiRunContext slice) | Output (schema via `generateObject`) |
|---|---|---|---|
| `apiDiscovery` | Reconcile OpenAPI/Postman/source into a clean contract; infer auth + dependency hints | raw spec/routes, app knowledge | endpoints[] + contracts + dep hints |
| `apiTestPlanner` | Scenario + flow design, weighted by risk, ordered by dependencies | contract, risk, deps, rules, memory | test scenarios[] + flows[] |
| `apiValidator` | Semantic expected-vs-actual: fields/types/nulls/authz **and business rules** (one validator) | expected, actual(redacted), rules | findings[] {kind, severity, explanation} |
| `apiFailureAnalyst` | Root-cause class + the flaky "likely reason" | failure, history, contract diff | {rootCause, class, confidence, reason} |
| `apiReporter` | Developer-ready report | validated findings, evidence refs, graph links | report {cause, confidence, fix, relatedFiles, relatedCases} |

**Deterministic (no agent):** dependency inference, risk scoring, flaky statistics, contract diff, graph upserts, coverage, redaction. **Merged/removed vs prior drafts:** the second "business-rule validator" is folded into `apiValidator`; `apiFlowPlanner` is folded into `apiTestPlanner` (flow mode). Net agents: **5**.

## 6. Final WorkerContext contract — `ApiRunContext` (self-contained)

One typed object assembled just before each API agent call; decoupled from the deferred general WorkerContext; budget-trimmed by `estimateTokens` (already in the Evidence Registry) using a fixed priority order.

```
ApiRunContext {
  mission: MissionState,                 // priority 100 (required) — replaces chat history for API agents
  endpoint: { method, path, summary, tags },        // 95 required
  contract: { request, response, auth },            // 95 required
  dependencyOrder: string[],             // 80 — endpoints in exec order
  risk: { tier, score, factors },        // 75
  priorBaseline?: { contractVersion, lastGoodResponseShape },   // 70 (from QA Memory)
  businessRules: { text, severity }[],   // 65
  recalledMemory?: { flakyFlags, recentFailures, priorReportSummaries },  // 40 summarizable/removable
  credentials: { masked: true, ref }     // never the secret; the executor holds the real token in memory only
}
```
Assembly is deterministic; every drop/summarize emits an explicit marker (no silent truncation). Credentials are **always masked** in context; only the deterministic executor ever holds the real token, in memory, never persisted.

## 7. Final Evidence Registry contract (registry unchanged except one additive line)

- `EvidenceType` gains: `'api'`, `'api_flow'`, `'business_rule'`, `'regression'`. (**`'risk'` is NOT an evidence type** — it's a derived score.)
- Records created via existing `recordEvidence(run, {...})`; `payloadRef` points at a **run-blob** field (e.g. `run.api_evidence`), so the registry's metadata-only/payload-on-run contract is preserved unchanged.
- Payloads on the run blob are **already redacted**. `source` = `PROVENANCE.API` (or `PLAYWRIGHT` for cross-layer DOM). Confidence vocabulary (`verified-live/verified-static/inferred/unverified`) unchanged; a real executed call is `verified-live`.
- `sourceEvidenceId` links evidence into the graph via `api_evidence_links` for the Evidence Explorer.

## 8. Final Mission State

Run-scoped, one `api_missions` row (tasks as JSONB). The single source of "what is this run doing and did it work," consumed by agents (via `ApiRunContext.mission`) instead of conversation history, and rendered live in the console.
```
MissionState {
  runId, mission: string,
  tasks: [{ id, label, phase, state: 'pending|running|completed|blocked|failed', evidenceRefs: string[] }],
  coverage: { discovered, tested, regression, criticalTested, flowTested },
  risk: { critical, high, medium, low }
}
```
Updated at every pipeline step. Non-API agents are untouched (no shared history code changed).

## 9. Final QA Memory

Not a store — a **recall service** over the normalized tables: `recallApiMemory({projectId, appId, endpointId})` →
```
{ latestContract, contractVersions[], lastGoodBaseline, flakyFlags, recentFailures[], priorReportSummaries[] }
```
assembled from `api_contract_versions`, `api_execution_daily`, `api_flaky_flags`, and prior reports, then injected into `ApiRunContext.priorBaseline/recalledMemory` (budget-trimmed). This is how "AI reuses knowledge in future runs" — no vector index, no new blob table; add embeddings only if a proven recall-perf problem appears.

## 10. Final Knowledge Graph

The union of the typed link tables in §2 (`api_endpoint_*`, `api_dependencies`), with existing entities (`requirements`, `cases`, `defects`, `api_endpoints`, evidence) as nodes — **no node registry, no polymorphic edges.** Access via a single service:
```
graphAround(node, depth≤3) → { nodes, edges }   // ego-graph, one entity's typed links expanded N hops, bounded+paginated
evidenceChain(endpointId)  → ordered path: requirement → repo file → endpoint → db table → dom → screenshot →
                             playwright → execution → evidence → report → regression   (lazy, hop-by-hop)
```
Integrity is automatic (FK CASCADE); multi-tenant isolation is default (every table is project-scoped + FK'd).

## 11. Final UI Modules (Vite/React/Tailwind/Recharts — no Next.js, no external graph lib)

A single **API Intelligence** console module (new route + sidebar item; optional AgentConsole turn-kind to launch runs from chat), with tabs:
- **Runs** — live pipeline (reuse `useAgentRun`, phase cards) + **Mission panel** (task board).
- **Coverage** — cards + trend lines (Recharts) over the cached read model + "Untested Endpoints" table.
- **Endpoints & Graph** — endpoint list; **ego-graph** view (bounded SVG, click-to-expand a node's typed links; never the whole graph).
- **Contracts** — version timeline + two-version JSON diff (reuse `JsonDiff`).
- **Flows** — journey viewer + step results (redacted).
- **Flaky** — stability list with pass/fail sparkline + AI reason.
- **Evidence Explorer** — lazy, hop-by-hop chain navigation (requirement→…→regression) driven by `graphAround`/`evidenceChain`.

All payloads shown are redacted. Graph and chain views are bounded/lazy by contract (§4).

## 12. Cross-cutting: Redaction & Write-Safety (built in Phase A, enforced everywhere)

- **`redact(obj, policy)`** — masks headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, …) and body/query fields matching a configurable sensitive-key list (`password`, `token`, `secret`, `apikey`, plus configurable PII paths). Applied before **any** write to `api_executions`, `api_flow_runs`, run-blob evidence, and before **any** UI serialization.
- **Write-safety gate** — mutating verbs execute only when `writeEnabled=true` AND resolved `environment≠production`; each mutating flow declares compensating teardown + idempotency keys; `/flows/:id/run` requires explicit confirmation.

## 13. Final Implementation Phases (vertical-slice first; each ≤ one subsystem / ~10–15 files; validate before next)

```
Phase A — VERTICAL SLICE (earns trust before the intelligence layer)
  api-intelligence/{types,store,discovery,executor,validator,evidence,pipeline,routes}.ts
  + redact() + write-safety gate; storage.ts (db.apiRuns); evidence registry ('api','regression');
  systemPrompts (apiDiscovery, apiTestPlanner, apiValidator, apiFailureAnalyst, apiReporter);
  minimal console Runs tab.
  Deliver: discover → plan → execute(read-only) → validate → 1 regression baseline → evidence → report. Risk: Med.

Phase B — Knowledge Graph + Dependencies (typed tables)
  schema.sql (api_endpoints, api_dtos, api_contract_versions, api_endpoint_* link tables, api_dependencies);
  graph.ts (upsert + graphAround/evidenceChain); ego endpoints; Endpoints&Graph UI.
  Deliver: every run populates typed graph; ego-graph browsable. Risk: Med.

Phase C — Contract Versioning + Business Rules
  schema.sql (versions already in B; api_business_rules); differ; rules folded into apiValidator;
  Contracts UI (version diff). Deliver: versioned contracts + semantic rule validation. Risk: Low-Med.

Phase D — Risk + Flaky
  schema.sql (api_executions, api_execution_daily, api_flaky_flags) + retention/rollup;
  deterministic risk scorer + flaky eval + failure-analyst reason; risk feeds planner.
  Deliver: risk tiers drive coverage/regression priority; flaky flags. Risk: Low-Med.

Phase E — Flow Testing (gated on §12 being in place)
  schema.sql (api_flows, api_flow_runs); flow mode in apiTestPlanner; stateful executor w/ teardown;
  Flows UI. Deliver: AI business journeys, write-gated + prod-blocked + redacted. Risk: Med-High.

Phase F — Mission State + QA Memory + Coverage + Evidence Explorer
  schema.sql (api_missions); mission updater; recallApiMemory → ApiRunContext; coverage read model + cache;
  Coverage + Evidence Explorer UI (lazy). Deliver: live mission, memory reuse, coverage intelligence,
  navigable evidence chain. Risk: Med.
```
Hard order: A→B→(C,D can parallelize)→E→F. `ApiRunContext` and `MissionState` types are introduced minimally in Phase A and enriched in F; nothing depends on the deferred general WorkerContext.

---

## Summary of what changed from the prior plans (dedup / merge / simplify)

- **Removed:** polymorphic `graph_edges`, `graph_nodes`, `qa_memory_index`(+embedding), `api_coverage_snapshots`, `api_mission_tasks`, the `'risk'` evidence type, and the second validator agent.
- **Merged:** business-rule validation into `apiValidator`; flow planning into `apiTestPlanner`; Mission State + QA Memory into the single `ApiRunContext`.
- **Added (as first-class, not footnotes):** the `redact()` boundary, the write-safety/prod-block gate, bounded ego-graph + lazy chains, execution retention + daily rollups, and a self-contained `ApiRunContext`.
- **Resequenced:** a trustworthy vertical slice ships first; the intelligence layer builds on it.

**This is the source of truth. No code has been written. Implementation begins at Phase A on approval, one phase at a time with validation between phases, per `CLAUDE.md` / `AGENTS.md`.**
