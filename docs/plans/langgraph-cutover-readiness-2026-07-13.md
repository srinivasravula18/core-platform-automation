# LangGraph Migration — Phase 7 Cutover Readiness (2026-07-13)

Status: Phases 1–6 of `docs/diagnostics/openai-langgraph-architecture-migration-plan-2026-07-13.md` are **built, tested, and dark** on branch `langchain_version`. This document is the Phase 7 deliverable: what exists, how to turn it on, how to roll it back, and what may be deleted only after the canary gates pass. Phase 7's deletions are intentionally NOT performed — the plan itself gates them behind a canary + one-release rollback window that cannot happen inside a build session.

## 1. What is built (all additive, all behind `AGENT_GRAPH_V2`, default OFF)

| Layer | Files | Proof |
|---|---|---|
| Durable foundation | `server/features/agent/workflow/{state,errors,events,checkpointer}.ts`, `agent_run_events` table, `AgentRunEvents` repo, `services/orchestration` boundary, server startup/shutdown wiring | `test:agent-workflow-state` — 78 asserts incl. real Postgres checkpoint restart-survival |
| Model boundary (provider-neutral) | `server/ai/openai/{responsesClient,promptBudget}.ts`; Anthropic/Gemini use their existing adapters via `resolveProviderForAgent` | `test:openai-responses` — 43 asserts, offline |
| Discovery/grounding subgraph | `workflow/nodes/{context,discovery,grounding}.ts`, `workflow/graphs/discoveryGraph.ts`, additive `withPageSession`/`captureVerifiedElementsForOpenPage` | `test:agent-discovery-graph` — 55 asserts incl. real-browser E2E; ONE authenticated session replaces the legacy two |
| Authoring/compiler subgraph | `workflow/nodes/{authoring,compilation}.ts`, `workflow/graphs/testAuthoringGraph.ts`, `workflow/artifactStash.ts`, strict `parseTestPlanStrict` (+`TEST_PLAN_SCHEMA_VERSION=2`) | `test:agent-authoring-graph` — 51 asserts; proves invalid plan steps can no longer be silently dropped |
| Full TestRunGraph + runtime | `workflow/testRunGraph.ts`, `workflow/runtime.ts`, `workflow/nodes/{review,execution}.ts`, flag-gated branches in `routes.ts` (`/api/agent/start`, `/continue`, `/cancel`) | `test:agent-workflow-resume` — 90 asserts incl. durable interrupt/resume, crash-resume, duplicate-execution skip, stale-review rejection |
| Request/research consolidation | `workflow/{requestGraph,sourceResearchGraph}.ts`, `server/ai/outputSanitizer.ts` | `test:agent-request-graph` — 74 asserts incl. bounded iterations and path-redaction |

Legacy behavior with the flag off: byte-for-byte unchanged (verified by the full pre-existing suite plus live backend boots with and without the flag).

## 2. How to enable (canary procedure, from plan §16.1)

1. Production preconditions: `DATABASE_URL` set (the checkpointer **fails closed** in production without Postgres) and backend restarted after any change.
2. Set `AGENT_GRAPH_V2=1` on the backend, restart. Startup must log `[workflow] graph runtime checkpointer initialized`.
3. Run controlled canary deep runs (target: Admin → Objects list view first). A graph run's record carries `engine: 'langgraph'`; legacy runs are untouched and continue/resume only through their original engine.
4. Compare against legacy baselines: evidence counts, wrong-surface actions (must be 0), hallucinated selectors (must be 0), duplicate side effects (must be 0), % reaching real execution (target ≥90% per plan §20), tokens/latency.
5. Expand cohort → make the flag default → keep an emergency `AGENT_GRAPH_V2=0` release for one cycle.

## 3. Rollback

Set `AGENT_GRAPH_V2=0` and restart — the legacy pipeline is intact and untouched. Checkpoint/event tables are additive; leave them (no schema rollback needed). Do not attempt to transfer an in-flight graph thread to the legacy engine — cancel and restart the run instead.

## 4. Deletions allowed ONLY after §2 completes + one-release soak (plan §12.4)

`mcpInspector.ts`, `toolLoopInspector.ts`, `supervisor.ts` (after chat/research consumers migrate to `sourceResearchGraph`/`requestGraph`), `tracer.ts`, `recovery.ts`, `services/event-bus/**`, `services/observability/**`, `configs/agents.yaml`, `configs/models.yaml`. Before each deletion: repo-wide import/config-reader audit; if a file gained a consumer, retain it.

## 5. Deliberately deferred (documented scope cuts, in dependency order)

- **Consumer migration for P6** — `controller.ts` / `chat routes` / `agent-runtime` still call the supervisor tool-loop; `requestGraph.routeRequest` is the single place to move them through when migrating (per-route, flag-gated, one at a time).
- **Review-edit passthrough** — the graph's `/api/agent/continue` approves the pending review as-is; carrying UI-edited cases into the resume payload is a small follow-up (`resumeGraphRun` already accepts a full resolution object).
- **Durable artifact store** — full plans/compiled sources live in the in-process `artifactStash` (state carries digests). A process restart mid-run routes back through rediscovery explicitly (never silently). A Postgres/disk artifact store can replace the stash without changing any node contract.
- **Retry-policy declaration on nodes** — the taxonomy (`getRetryPolicy`) is enforced inside nodes (bounded rediscovery, one repair call, no assertion retries); attaching LangGraph per-node `retryPolicy` objects for transient classes is a config-level follow-up.
- **`agent_run_events` UI surfacing** — events are written; a timeline view over `AgentRunEvents.list(runId)` is frontend work.
