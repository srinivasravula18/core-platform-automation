# Agent Console Navigation-Persistent Session Architecture Plan

**Date:** 2026-07-28  
**Mode:** Phase 0 — analysis only  
**Scope:** Decouple Agent Console session/execution transport from the routed React page.

## 1. Executive Summary

The browser Agent Console is currently both the view and the owner of conversational and transport state. Route changes unmount it because `App.tsx` renders it only for `/`, `/agent`, and chat routes. On unmount, component-owned request controllers, transient turns, busy state, and run-event subscriptions are lost. A best-effort snapshot mitigates loss for durable deep runs, but it cannot keep general streamed work alive or provide one authoritative cross-route session lifecycle.

Deep test-generation runs are already materially detached on the server: `POST /api/agent/start` stores a running record, returns `{ task_id }`, and continues work after the response (`server/features/agent/routes.ts:5681-5685`). Their browser stream is SSE, not a browser WebSocket (`src/lib/useAgentRun.ts:95`; `routes.ts:5033-5072`). The desktop automation agent uses the only WebSocket gateway (`server/features/automation/agentGateway.ts:92-155`), and it is unrelated to console chat.

The solution is an application-lifetime `AgentSessionManager` backed by a persisted Zustand store and a transport registry. It owns session/conversation/execution metadata, subscriptions, reconnect/backoff, and background status. `AgentConsole` becomes an attach/detach view. Server work remains independent of client transport and exposes idempotent rehydration endpoints keyed by existing conversation and run IDs.

## 2. Existing Architecture

- React Router swaps route elements inside `Shell`; all non-console navigation unmounts `AgentConsole` (`src/App.tsx`, routes near `App()`), while the scoped content wrapper is also keyed by project/app (`Shell`, `scopeKey`).
- `AgentConsole` owns `turns`, `busy`, `conversationId`, `AbortController`, thinking-turn identity, request dispatch, and persistence (`src/pages/AgentConsole.tsx:758-865, 1047-1095, 2090-2138`).
- A 700 ms client-side full-conversation PUT and unmount/pagehide flush save rich turns to `chat_conversations` (`AgentConsole.tsx:1054-1095`). This preserves completed state but is not a session runtime.
- `DeepRunResult` mounts `useAgentRun(taskId)` (`src/components/DeepRunResult.tsx:288-334`). That hook opens an SSE status stream, falls back to polling, and closes the EventSource in effect cleanup (`src/lib/useAgentRun.ts:86-115`).
- `/api/agent/start` records the run first and executes it asynchronously; cancellation is explicit via `/api/agent/cancel` (`server/features/agent/routes.ts:6381-6395`).
- Existing deep-run startup already supplies `conversationId`, and server startup reloads durable conversation turns where present (`server/features/agent/routes.ts:5259-5277`).

## 3. Dependency Graph

```text
App / Shell / Routes
  └─ AgentConsole (route-owned today)
       ├─ local turns, busy, AbortController, conversation ID
       ├─ conversation REST persistence
       ├─ DeepRunResult
       │    └─ useAgentRun ── SSE /api/agent-runs/:id/events
       └─ dispatch APIs (/goal, /controller streams, /agent/start)

Server /api/agent/start ──> durable agent run ──> detached pipeline / graph
                                      └─ run details/status/SSE endpoints

Proposed App AgentSessionProvider
  └─ AgentSessionManager (single transport registry per tab)
       ├─ persisted session metadata + conversation projection
       ├─ durable run rehydration
       ├─ SSE subscription/polling lifecycle
       └─ UI subscribers: AgentConsole, global activity indicator
```

## 4. Runtime Flow

Today: submit creates a page-local `AbortController` (`AgentConsole.tsx:2103-2111`); deep start sends it to `/api/agent/start` (`1473-1526`); server persists and starts the run after responding. A page navigation removes the card and `useAgentRun` cleanup closes its SSE client. General console paths also retain their controller and streaming results only in the unmounted component.

Proposed: the manager accepts a command with an idempotency key, records an execution record before dispatch, and owns its controller/subscription. The view only invokes the command and subscribes to the record. Navigation removes the view subscription, never calls manager cancellation. Explicit Stop routes through the manager to the relevant cancellation endpoint; explicit End/Delete first cancels active executions, then removes the durable and local metadata.

## 5. Evidence Flow

Deep-run evidence is associated with durable `agentRuns`, status projections, and persisted conversation turns. The SSE endpoint repeatedly reloads the run and emits a signature-changing snapshot (`server/features/agent/routes.ts:5033-5072`), so reconnecting by task ID is supported today. The plan will make task IDs first-class session execution metadata and rehydrate every non-terminal task on application startup.

## 6. Context Flow

Conversation identity is currently browser-generated and scope-local; it is stored per project/app and synced to the URL (`AgentConsole.tsx:762, 867-895`). The deep-run route can reload `ChatConversations.get(conversationId)` (`routes.ts:5265-5277`). The new session record will retain the scope, conversation ID, active execution IDs, selected session, and last known server revision. Durable conversation remains server-authoritative; browser persistence is a recovery cache, not the sole source of truth.

## 7. Prompt Flow

The console builds client history and sends it with deep-start requests (`AgentConsole.tsx:1521-1524`); server prefers stored conversation turns when a conversation ID is present (`routes.ts:5267-5274`). This work must remain behaviorally compatible. Session-manager extraction moves the request orchestration, not prompt construction; a later hardening may move prompt assembly fully server-side without coupling it to navigation persistence.

## 8. Current Problems

1. Route and scope remount destroy the component that owns live session state.
2. `useAgentRun` intentionally closes SSE on UI unmount, so monitoring stops although the server run continues.
3. General streamed/chat and understanding jobs have page-owned abort controllers and no durable execution projection.
4. Snapshot persistence is delayed and full-document overwrite based; it is a recovery mechanism, not a concurrency-safe session manager.
5. There is no global activity model, idempotency key, ownership policy for multiple tabs, or unified reconnect strategy.
6. Existing comments call persistence a safety net (`AgentConsole.tsx:1047-1051`), confirming the current workaround does not separate lifecycles.

## 9. Root Cause Analysis

The primary cause is ownership inversion: session resources are allocated inside a route element rather than at the application/session layer. The server does not terminate deep work when SSE closes—the SSE route only clears its interval on `req.close` (`routes.ts:5067-5071`)—but the UI interprets its own unmount as loss of the active session. Browser WebSocket is not a contributing mechanism because this console has no browser WebSocket; treating the existing SSE stream as a reconnectable execution transport prevents an unnecessary protocol rewrite.

## 10. Proposed Architecture

Introduce `AgentSessionProvider` immediately beneath `BrowserRouter` and an `agentSession` Zustand store with persisted, versioned metadata (not secrets):

- `sessions[sessionId]`: session/conversation/scope IDs, active execution IDs, status, timestamps, revision.
- `executions[executionId]`: kind, server run/job ID, status, progress snapshot, last event sequence/signature, reconnect attempt, error.
- an in-memory transport registry keyed by execution ID: one EventSource/poll timer/AbortController per execution per tab.
- view attach counts and selectors; zero listeners does not close a non-terminal transport.
- `localStorage` only for the active-session index and small metadata, IndexedDB for bounded conversation/progress cache, and server APIs as durable authority.
- a `BroadcastChannel` plus storage-event fallback: each tab may render state; a short renewable leader lease permits one tab to maintain a particular SSE subscription. Followers receive projected updates. Lease loss/reconnect is idempotent.
- exponential jittered reconnect, online/offline handling, stale-session reconciliation, and a maximum retry policy that preserves the record and exposes retry rather than silently creating a chat.

The manager owns SSE today behind a `RunTransport` interface. A future actual browser WebSocket implements the same interface without changing the UI or session model.

## 11. Complete Refactoring Strategy

1. Extract types, persisted store, and a testable manager/transport layer without changing backend contracts.
2. Mount the provider globally and add a small shell indicator driven by active non-terminal executions.
3. Replace `useAgentRun`'s resource ownership with a selector/adaptor to the manager; migrate deep-run cards first.
4. Migrate console command/stream ownership so route cleanup detaches UI only. Preserve the existing UI turn shape and API payloads.
5. Add server discovery/reconciliation and idempotency support for session reattachment, then test route, reload, duplicate-tab, and failure scenarios.

## 12–14. Files That Must Change, Why, and Risk

| File | Change / reason | Risk |
|---|---|---|
| `src/lib/agentSession/types.ts` (new) | Explicit session/execution/transport contracts. | Low |
| `src/lib/agentSession/persistence.ts` (new) | Versioned local/IndexedDB metadata cache and migration. | Medium |
| `src/store/agentSession.ts` (new) | Persisted Zustand session projection and selector API. | Medium |
| `src/lib/agentSession/AgentSessionManager.ts` (new) | Single-tab transport lifecycle, attach/detach, reconnect, idempotency. | High |
| `src/lib/agentSession/AgentSessionProvider.tsx` (new) | Application-lifetime manager ownership and startup rehydration. | High |
| `src/lib/useAgentRun.ts` | Convert to manager-backed UI subscription; remove component-owned EventSource lifecycle. | Medium |
| `src/pages/AgentConsole.tsx` | Replace local session/controller ownership with manager commands/selectors; retain presentation and prompt assembly. | High |
| `src/components/DeepRunResult.tsx` | Read shared run projection and invoke explicit cancel/retry only. | Medium |
| `src/App.tsx` | Mount provider outside routed content and render activity indicator in Shell. | Medium |
| `src/components/AgentActivityIndicator.tsx` (new) | Lightweight navigation-persistent running-task indicator. | Low |
| `server/features/agent/routes.ts` | Add authenticated conversation/session active-run discovery and idempotent start/reconciliation response fields; retain current start/SSE APIs. | High |
| `server/db/schema.sql` | Only if an idempotency/session binding cannot be represented from existing run fields; additive, idempotent schema/index migration plus setup verification. | Medium/conditional |
| `scripts/test-agent-console-session-persistence.ts` (new) | Integration regression coverage for persistence/reconnect semantics. | Medium |
| frontend test files adjacent to manager/console (new) | Unit/component tests for cleanup, dedupe, and navigation. | Medium |

## 15. Backward Compatibility Concerns

Existing URLs, `conversationId`, `task_id`, `/api/agent/start`, SSE status payloads, and explicit `/api/agent/cancel` behavior stay valid. Old local-storage conversation keys are read once and migrated. The provider must tolerate old server versions by falling back to status/details endpoints for known task IDs. No credentials, tokens, raw prompts requiring special protection, or EventSource objects are persisted.

## 16. Migration Strategy

Ship behind an `AGENT_SESSION_MANAGER_V1` frontend-safe rollout flag initially. On startup, hydrate local metadata, validate it against server run details, then subscribe only to non-terminal executions. Keep existing conversation snapshot writes during the first rollout. Instrument duplicate-start suppression and reconnection outcomes. After telemetry/test confidence, make manager ownership default and remove legacy component-only stream ownership in a separate phase.

## 17. Testing Strategy

- Unit: session reducer, schema migration, idempotency key reuse, leader lease, backoff, terminal cleanup, and no listener/transport duplication.
- Component: mount console, start a mocked run, unmount/remount, assert same conversation/task and no cancel request; Stop sends exactly one cancel.
- Integration: start real durable run, navigate among routes rapidly, return while running and after completion; reload; simulate SSE drop/offline; open two tabs; delete/end session.
- Server: active-run discovery is scope/user-authorized, excludes terminal runs, is stable under repeated attach, and start idempotency creates one run.
- Regression: run `npm run lint`, relevant existing `test:conversation-persistence`, `test:session-context`, `test:conversational-runtime`, `test:run-session-projection`, `test:conversation-concurrency`, and agent-workflow resume tests; validate browser DOM grounding and verified-evidence Playwright generation remain unchanged.

## 18. Rollback Strategy

The provider flag returns ownership to current UI hooks without data migration loss. New server fields/endpoints are additive; existing clients ignore them. Keep browser cache versioned and discard only manager metadata on corruption—never delete durable conversations/runs. Disable the global indicator independently if required.

## 19. Estimated Implementation Effort

Three implementation phases, approximately 5–8 engineer-days including integration and browser regression testing. Highest uncertainty is the number of non-deep console command paths that need a durable execution adapter; that will be enumerated before Phase 3 starts.

## 20. Recommended Implementation Order

- [x] **Phase 1 — Durable client session foundation (8 files, high subsystem risk):** new session types/persistence/store/manager/provider; `App.tsx`; indicator; manager unit tests. Type-check and production frontend build passed.
- [x] **Phase 2 — Deep-run migration (3 files, medium risk):** `useAgentRun.ts` and `AgentConsole.tsx` deep-run paths. The existing `DeepRunResult.tsx` now consumes the manager-backed hook without a component-local EventSource. Type-check, production frontend build, and session/conversation regression checks passed.
- [ ] **Phase 3 — General console execution and server reconciliation (up to 6 files, high risk):** `AgentConsole.tsx`, `routes.ts`, conditional `schema.sql`/`setup-db.bat`, integration tests. Move page-owned streamed commands into manager, add active-session discovery/idempotency, multi-tab/offline coverage.

Each phase is below the 10–15-file cap and must be compiled and regression-tested before the next begins.
