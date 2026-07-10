# API Intelligence — Phase 6+ Advanced QA Intelligence (Additive Extension Plan)

**Status: ANALYSIS ONLY. No code written. Awaiting explicit, separate approval (per `CLAUDE.md` / `AGENTS.md`).**

This plan is **strictly additive to** — and does **not** modify — the approved `api-intelligence-engine-architecture-plan-2026-07-10.md` (Phases 1–5). It adds 11 strategic capabilities as **Phase 6+**. It reuses, without changing, the Orchestrator, Evidence Registry, WorkerContext design, PostgreSQL layer, and Agent Console. No framework migration. Everything below was grounded in the real DB layer (`server/db/schema.sql`, `server/db/pool.ts`) and the integration surfaces mapped for Phases 1–5.

**Feature → this-document-section map:** F1 Knowledge Graph, F2 Dependency Graph → §1,§2,§8; F3 Contract Versioning, F4 Business-Rule Validation → §2,§3,§8; F5 Risk Engine, F8 Flaky Detection → §2,§3,§8; F6 Flow Testing → §2,§3,§8; F7 Coverage Dashboard, F11 Evidence Explorer → §6,§7,§8; F9 Mission State, F10 QA Memory → §5,§2. All features appear across the 11 required output sections below.

---

## 1. Updated Architecture

Phases 1–5 give us: an API run pipeline (discover → plan → execute → validate → regression → cross-layer → evidence → report), `APIEvidence` in the Evidence Registry, and an API Intelligence console module. Phase 6+ layers **persistent QA intelligence** on top, without changing that spine:

```
                         ┌───────────────────────────────────────────┐
   API RUN PIPELINE  ───▶ │  KNOWLEDGE LAYER (PostgreSQL, normalized) │
   (Phases 1–5)          │  • API Knowledge Graph  (F1: nodes+edges) │
      each phase          │  • Dependency Graph     (F2: dep edges)   │
      emits evidence      │  • Contract Versions    (F3)              │
      + graph upserts ───▶│  • Business Rules       (F4)              │
                          │  • Risk Scores          (F5)              │
                          │  • Execution History    (F8 flaky)        │
                          │  • Flows                (F6)              │
                          └───────────────┬───────────────────────────┘
                                          │  read models
                 ┌────────────────────────┼───────────────────────────┐
                 ▼                        ▼                            ▼
        WorkerContext feeders     Coverage Dashboard (F7)     Evidence Explorer (F11)
        • Mission State (F9)      (Recharts read model)       (graph-traversal read model)
        • QA Memory (F10)  ──────▶ consumed by planning/regression, NOT chat history
```

Core principle: **the run pipeline stays procedural and unchanged; new capabilities are (a) persistent relational tables written via upsert during/after a run, and (b) read models that feed planning, the dashboard, and the explorer.** The graph is the connective tissue — every artifact the platform already produces (requirement, repo file, endpoint, DB table, DOM element, screenshot, Playwright script, execution, evidence, developer report, regression, defect) becomes a **node**, and relationships become **edges**, so F11's "navigate the entire evidence chain" is a graph traversal, not a bespoke join per view.

## 2. Database additions (PostgreSQL, normalized — appended to `server/db/schema.sql`)

All idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), scoped with `project_id/app_id/owner_id` like every existing table, applied by `migrate()` on boot. New tables only — **no existing table is altered destructively** (only additive `ADD COLUMN IF NOT EXISTS` where noted).

**F1 — Knowledge Graph (generic nodes + typed edges):**
```
api_endpoints(id, project_id, app_id, method, path, operation_id, tags[], contract_hash,
              base_url, source, first_seen, last_seen, ...)         -- endpoint node (promoted from Phase-1 discovery)
api_dtos(id, project_id, app_id, name, kind /*request|response*/, schema JSONB, hash)
graph_nodes  -- OPTIONAL registry; most node types are EXISTING tables (requirements, cases, defects,
             -- agent_runs, api_endpoints). A thin view unifies (node_type, node_id, label).
graph_edges(id, project_id, app_id, src_type, src_id, edge_type, dst_type, dst_id,
            confidence NUMERIC, evidence_run_id, weight, created_at, updated_at)
   -- edge_type ∈ {consumes_dto, produces_dto, reads_table, writes_table, implemented_in_file,
   --              covered_by_case, relates_to_requirement, in_regression_suite, has_defect,
   --              has_evidence, renders_ui_page, depends_on}
   UNIQUE(src_type, src_id, edge_type, dst_type, dst_id)   -- upsert-dedup; edges evolve via ON CONFLICT
```

**F2 — Dependency Graph** (a specialization of `graph_edges` with `edge_type='depends_on'`, plus richer metadata):
```
api_dependency_edges(id, project_id, app_id, from_endpoint_id, to_endpoint_id,
                     kind /*produces_token|requires_auth|data_dep|ordering*/, field_map JSONB,
                     confidence, evidence_run_id, created_at)
   UNIQUE(from_endpoint_id, to_endpoint_id, kind)
```

**F3 — Contract Versioning:**
```
api_contract_versions(id, project_id, app_id, endpoint_key, version INT, contract JSONB,
                      contract_hash, source_run_id, created_at)
   UNIQUE(endpoint_key, version)         -- new version only when hash changes (dedup churn)
```

**F4 — Business Rules:**
```
api_business_rules(id, project_id, app_id, endpoint_id, object_name, rule_text, severity,
                   source /*repo|requirement|knowledge|manual*/, source_ref, created_at)
   -- seeded from EXISTING requirements.business_rules JSONB + apiAnalyst + app knowledge
```

**F5 — Risk Engine:**
```
api_risk_scores(endpoint_id PK, project_id, app_id, score INT, tier /*Critical|High|Medium|Low*/,
                factors JSONB /*{auth,financial,admin,delete,mutation,prod,deps,regression}*/,
                computed_at, overridden_by)
```

**F8 — Execution History / Flaky:**
```
api_executions(id, project_id, app_id, endpoint_id, run_id, status, latency_ms, status_code,
               request JSONB, response JSONB, created_at, environment)   -- append-only history
api_flaky_flags(endpoint_id PK, project_id, app_id, is_flaky BOOL, confidence, likely_reason,
                sample_window INT, last_evaluated)
```

**F6 — Flows:**
```
api_flows(id, project_id, app_id, name, journey /*ordered step list*/ JSONB, source /*ai|manual*/,
          status, created_at)   -- steps reference endpoint_id + data mapping between steps
api_flow_runs(id, flow_id, run_id, status, step_results JSONB, created_at)
```

**F9 — Mission State:**
```
api_missions(id PK /*=run_id or mission_id*/, project_id, app_id, mission TEXT, coverage JSONB,
             risk JSONB, updated_at)
api_mission_tasks(id, mission_id, label, state /*completed|running|blocked|failed|pending*/,
                  evidence_refs JSONB, phase, updated_at)
```

**F10 — QA Memory:** no new "blob" table — QA Memory **is** the union of the above tables plus existing `agent_runs`/evidence, retrieved by a recall service. One optional lightweight index:
```
qa_memory_index(id, project_id, app_id, endpoint_key, kind /*contract|baseline|failure|flaky|report*/,
                ref_id, summary, embedding_optional, updated_at)   -- fast recall; content stays normalized
```

**F7/F11** need **no new tables** — the Coverage Dashboard and Evidence Explorer are **read models** over the above (aggregations for F7; graph traversal of `graph_edges` for F11). Optional `api_coverage_snapshots(project_id, app_id, taken_at, metrics JSONB)` only if we want historical **trend** charts without recomputing.

## 3. New agents (if required — minimized; reuse Phase 1–5 agents where possible)

Only **two genuinely new** LLM agents; everything else is deterministic code or a reuse of an existing agent (registered the same way in `systemPrompts.ts` — `AGENT_PROMPTS` + `CANONICAL_AGENTS` + `systemPromptFor`):

- **`apiFlowPlanner`** (NEW) — F6: consumes the Dependency Graph + Risk scores to synthesize ordered business journeys (register → verify → login → create → share → delete) with inter-step data mapping.
- **`apiBusinessRuleValidator`** (NEW) — F4: validates semantic business rules (withdraw ≤ balance, inactive users can't login, duplicate email rejected, deleted records not retrievable) and explains failures. (Could alternatively extend the Phase-3 `apiValidator`; kept separate for prompt clarity and independent evolution.)
- **Reused:** `apiDiscovery` also emits dependency hints (F2) and DTO nodes (F1); `apiFailureAnalyst` also produces the flaky "likely reason" (F8); `apiTestPlanner` becomes **risk- and dependency-aware** (reads F5/F2) with no new agent; `apiReporter` unchanged.
- **Deterministic (no LLM):** Dependency inference from OpenAPI security + response→request field matching (F2), Risk scoring (F5, transparent weighted factors + a tiny optional classifier for "is financial/admin?"), Flaky detection (F8, statistical over `api_executions`), Contract diffing (F3), Graph upserts (F1), Coverage aggregation (F7), Evidence-chain traversal (F11).

## 4. New evidence types (Evidence Registry `EvidenceType` union — additive)

Extend `server/features/agent/evidence/registry.ts` `EvidenceType` (already has Phase-1–5 `'api'`) with: **`'api_flow'`** (F6), **`'business_rule'`** (F4), **`'regression'`** (F3 baseline/version diff), **`'risk'`** (F5 — an assessment record referencing an endpoint). Flaky (F8) and coverage (F7) are **derived metrics that reference** existing evidence, not new evidence types, so they are recorded as analysis records pointing at `api`/`regression` evidence rather than a new type. All reuse `recordEvidence(run, {...})`, `PROVENANCE.API`/`PLAYWRIGHT`, and the `verified-live/verified-static/inferred/unverified` confidence vocabulary unchanged.

## 5. Updated WorkerContext (populate existing slots — no architecture change)

The approved evidence-driven WorkerContext already defines the slots and the deterministic Context Priority Policy (Mission State p80 required; Evidence References p30; Knowledge Packs p20). Phase 6+ adds **content producers** for existing slots — it does **not** add or reorder slots:

- **Mission State (F9)** → fills the existing `MissionState` slot (priority 80, required) with `{mission, tasks[state], coverage, risk}` from `api_missions`/`api_mission_tasks`. **API workers consume Mission State instead of conversation history** — the planner/validator read the typed mission, not the chat log. (Non-API agents keep using chat history; nothing changes for them.)
- **QA Memory (F10)** → a new **producer** for the existing lower-priority "prior knowledge" region: `recallApiMemory(endpoint/app)` assembles prior contracts, last-good baselines, known flaky flags, past failures, and prior developer reports into the `Evidence References`/`Knowledge` slots, budget-trimmed by the same policy. This is how "AI reuses knowledge in future runs" — via WorkerContext injection, not a new mechanism.
- **Risk/Dependency context (F2/F5)** → injected into the `apiTestPlanner`/`apiFlowPlanner` WorkerContext as structured fields so planning is risk- and order-aware.

Because these only *fill* already-designed slots, the WorkerContext type and budget manager are untouched.

## 6. New API endpoints (all under the Phase-5 `/api/api-intelligence/*` namespace)

Read-heavy, additive; reuse the existing auth/scope (`x-project-id` / body `projectId,appId`) and `runStatusSnapshot`-style shapes:
- **Graph (F1/F11):** `GET /graph/node/:type/:id` (node + edges), `GET /graph/chain/:type/:id` (full evidence chain traversal), `GET /graph/endpoint/:id`.
- **Dependencies (F2):** `GET /dependencies?app=`, `GET /dependencies/order?endpoints=`.
- **Contracts (F3):** `GET /contracts/:endpointKey/versions`, `GET /contracts/:endpointKey/diff?from=&to=`.
- **Business rules (F4):** `GET/POST /business-rules`, `GET /runs/:id/business-rule-results`.
- **Risk (F5):** `GET /risk?app=`, `POST /risk/:endpointId/override`.
- **Flows (F6):** `POST /flows/plan`, `GET /flows`, `POST /flows/:id/run`, `GET /flow-runs/:id`.
- **Coverage (F7):** `GET /coverage?app=`, `GET /coverage/trends?app=`.
- **Flaky (F8):** `GET /flaky?app=`.
- **Mission (F9):** `GET /runs/:id/mission` (also streamed via the existing run events).
- **Memory (F10):** `GET /memory?endpoint=` (recall payload).

## 7. UI additions (existing Vite/React/Tailwind stack — no Next.js/shadcn)

Extend the Phase-5 **API Intelligence** console module with tabs (reusing `Recharts`, `MarkdownText`, the turn-card patterns, and a small custom SVG graph renderer — **no external graph lib**, honoring "no external graph database/UI dep"):
- **Coverage Dashboard (F7):** discovered/tested/regression/critical/flow/risk coverage cards + trend lines (Recharts) + an "Untested Endpoints" table.
- **Knowledge & Dependency Graph (F1/F2):** interactive node-link view (SVG/canvas) with click-through to artifacts.
- **Contract Versions (F3):** version timeline + two-version JSON diff (reuse the Phase-5 `JsonDiff` component).
- **Flows (F6):** journey builder/viewer + step results timeline.
- **Flaky (F8):** endpoint stability list with pass/fail sparkline + AI reason.
- **Mission panel (F9):** live task board (completed/running/blocked/failed) for the active API run.
- **Unified Evidence Explorer (F11):** a single graph-driven explorer that walks Requirement → Repo → API → DB → DOM → Screenshot → Playwright → Execution → Evidence → Developer Report → Regression via `graph_edges`, letting users navigate the whole chain visually. Supersedes the narrower Phase-5 `EvidenceExplorer` component by making it graph-backed.

## 8. Execution flow (extended API run — new phases interleave with Phase 1–5)

```
POST /api/api-intelligence/start
 → APIDiscovery (P1)  ── also upserts endpoint/DTO nodes (F1) + dependency hints (F2)
 → DependencyMapping (F2)   deterministic: OpenAPI security + response→request field match + AI fallback
 → ContractVersioning (F3)  hash contract; snapshot new version only on change; diff vs prior
 → RiskScoring (F5)         weighted factors → tier; write api_risk_scores
 → APITestPlanner (P2, now risk+dep aware)   coverage weighted by risk; order by deps
 → FlowPlanning (F6)        apiFlowPlanner builds journeys from the dependency graph
 → APIExecutor (P2)         single calls AND flows (stateful token/data carry-over); append api_executions
 → AIValidation (P3) + BusinessRuleValidation (F4)   status/schema AND semantic rules + explanations
 → RegressionDiff (P3)      vs last-good baseline/version (F3)
 → FlakyDetection (F8)      statistical over api_executions + apiFailureAnalyst reason
 → CrossLayerCheck (P4)     DB (record query) + DOM (domExplorer) + repo contract
 → APIEvidence (P2)         record api / api_flow / business_rule / regression evidence
 → GraphUpsert (F1)         write nodes+edges (endpoint↔dto↔file↔table↔ui↔req↔case↔suite↔defect↔evidence)
 → CoverageUpdate (F7) + Mission update (F9) + Memory persist (F10)
 → DeveloperReport (P3)
```
Mission State (F9) is updated at **every** phase (`api_mission_tasks.state`), so the console shows a live task board and workers read the mission, not chat history. Each phase still uses `pushPhase`/`phaseSummary`/`markRunDone` unchanged.

## 9. Migration strategy

- **Schema:** append the new idempotent `CREATE TABLE/INDEX IF NOT EXISTS` blocks to `server/db/schema.sql`; `migrate()` applies them on next boot (`pool.ts:57-70`). No destructive ALTERs; no backfill (new tables start empty and populate as runs execute).
- **Dual-mode:** these knowledge features are **PostgreSQL-first** (as mandated). When `DATABASE_URL` is unset, API *runs* still work via the JSON store, but graph/versioning/coverage/memory analytics are disabled with a clear "PostgreSQL required" notice — no crash. Document this in setup.
- **Rollout order:** graph/dependency tables first (foundation), then the read models. Each phase's tables ship in that phase's commit; reverting a phase drops only its additive tables/endpoints/UI.
- **No data migration** of existing entities; the graph *links* existing rows (requirements/cases/defects/agent_runs) by id via `graph_edges`, leaving them untouched.

## 10. Risks

1. **Graph staleness / edge explosion** — mitigate with `UNIQUE` upsert-dedup, `confidence` + `evidence_run_id` on every edge, and periodic pruning of low-confidence/orphaned edges.
2. **Flow executor mutations** (register→create→delete) — this is the biggest operational risk. Reuse the Phase-1–5 **write-safety gate**: writes opt-in, target-scoped, non-prod-preferred, with created-record cleanup; flows that mutate require explicit enablement.
3. **Dependency inference false positives** → wrong flow order → cascading false failures. Gate on confidence; surface inferred edges for human confirmation before they drive destructive flows.
4. **Risk miscalibration** skewing coverage priority — keep factors transparent in `factors JSONB` and user-overridable (`POST /risk/:id/override`).
5. **Contract-version churn noise** — hash-dedup; snapshot only on real change.
6. **Mission State vs conversation history divergence** — API agents switch to Mission State; ensure non-API agents are untouched (no shared code path changed) so existing behavior can't regress.
7. **PostgreSQL dependency** — the intelligence layer assumes PG; JSON fallback is intentionally limited. Make the requirement explicit in docs and UI.
8. **Scope size** — 11 features is large; the strict phase gating below is the primary control. Flaky detection needs a minimum sample window (cold-start: mark "insufficient data," don't guess).
9. **Cross-layer verification cost/latency** (DB+DOM per endpoint) — make it sampled/opt-in for large surfaces, always-on for Critical-risk endpoints.

## 11. Recommended implementation phases (Phase 6+; each ≤ one subsystem / ~10–15 files, validated before the next)

```
Phase 6 — Knowledge Graph + Dependency Graph (FOUNDATION)  [F1, F2]
  schema.sql (+api_endpoints, api_dtos, graph_edges, api_dependency_edges);
  api-intelligence/graph.ts + dependency.ts + GraphUpsert phase; read endpoints; systemPrompts (dep hints)
  Deliver: every API run writes nodes+edges; dependency order queryable. Risk: Med (write path).

Phase 7 — Contract Versioning + Business-Rule Validation  [F3, F4]
  schema.sql (+api_contract_versions, api_business_rules); differ; apiBusinessRuleValidator agent;
  version + diff + business-rule endpoints
  Deliver: versioned contracts, any-two-version diff, semantic rule validation with explanations. Risk: Med.

Phase 8 — Risk Engine + Flaky Detection  [F5, F8]
  schema.sql (+api_risk_scores, api_executions, api_flaky_flags); deterministic scorers; flaky analyst;
  risk-aware planner input
  Deliver: per-endpoint risk tiers influencing coverage/regression priority; flaky flags + reasons. Risk: Low-Med.

Phase 9 — Flow Testing  [F6]
  schema.sql (+api_flows, api_flow_runs); apiFlowPlanner agent; stateful flow executor (write-safety gated)
  Deliver: AI-discovered business journeys executed with token/data carry-over. Risk: Med-High (mutations).

Phase 10 — Mission State + QA Memory  [F9, F10]
  schema.sql (+api_missions, api_mission_tasks, qa_memory_index); mission updater across phases;
  recallApiMemory → WorkerContext producer
  Deliver: live mission task board; workers consume mission + recalled memory instead of chat history. Risk: Med.

Phase 11 — Coverage Dashboard + Unified Evidence Explorer  [F7, F11]
  read-model/aggregation + graph-traversal endpoints; UI: Coverage tab (Recharts), graph view (SVG),
  version diff, flows, flaky, mission panel, unified Evidence Explorer
  Deliver: coverage intelligence + navigable end-to-end evidence chain. Risk: Med (largest FE surface).
```

Phases 6→11 have a hard dependency order (graph before flows/explorer; executions before flaky; versions before regression UI). Each ships its own tables/agents/endpoints/UI and is independently revertable.

---

## Explicitly out of scope / non-goals

- No external graph database or graph UI library (SVG/canvas + PostgreSQL only, as mandated).
- No change to the approved Phases 1–5, the Orchestrator, the Evidence Registry architecture, the WorkerContext architecture (only new slot *producers*), or the framework stack.
- Flow mutations remain opt-in and target-scoped (write-safety gate carried over).
- QA Memory reuses normalized tables + Evidence Registry; it is not a separate vector store (an optional embedding column in `qa_memory_index` is a future enhancement, not required).

---

**This document is analysis and planning only. No file has been modified. Implementation of Phase 6+ must not begin until approved on a separate turn, and must then proceed one phase at a time with validation between phases, per `CLAUDE.md` / `AGENTS.md`. It does not modify or invalidate the approved Phase 1–5 plan.**
