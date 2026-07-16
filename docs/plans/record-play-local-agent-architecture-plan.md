# Record & Play via Local Desktop Agent — Implementation Plan (Phase 0)

**Status:** ANALYSIS ONLY — no code has been changed. Awaiting explicit approval before any implementation phase.
**Branch:** `langchain_version` · **Date:** 2026-07-16
**Scope:** Move all browser recording/execution off the cloud server onto a downloadable TestFlow Desktop Agent, orchestrated from the cloud UI at `https://ops.acchindra.com/automation`.

---

## 1. Executive Summary

TestFlow AI today records and executes Playwright entirely **inside the backend process** (`server/features/playwright/`). Codegen is already guarded to "local desktop only" (`routes.ts:106-112` refuses on deployed hosts) — proof that the current design cannot work for cloud customers. This plan introduces a **TestFlow Desktop Agent**: a Node-based local service (localhost:2424) that the user downloads, which registers with the cloud, maintains an outbound WebSocket, runs `playwright codegen` and `npx playwright test` locally, and uploads scripts/reports/artifacts back. The cloud never launches a browser.

Key design decisions (each justified in §10):
- **Agent connects outbound** (HTTPS + WebSocket to the cloud). The cloud UI never needs to reach `localhost:2424` for core flows — this sidesteps mixed-content/Private-Network-Access blocking from an `https://` page. The localhost REST API exists for local diagnostics and optional fast local detection only.
- **Net-new infrastructure required on the backend:** a WebSocket endpoint (`ws` package — none exists today; streaming is SSE-only per `server/features/controller/routes.ts:42`), a scheduler loop (none exists today), and binary artifact upload (`express.raw` — the app is JSON-only, `express.json({limit:'5mb'})` at `apps/api/src/server.ts:96`).
- **Everything is flag-gated** behind `REMOTE_AGENT_V1` following the `AGENT_GRAPH_V2` pattern, so the existing app is untouched when the flag is off.
- The existing `RecordPlay.tsx` page and `/api/playwright/codegen/*` routes remain working (backward compat) and become the "local dev mode" fallback; the new Automation section supersedes them in the UI.

Estimated effort: **6 implementation phases, ~55-65 files total, each phase ≤15 files** (per CLAUDE.md scope cap), roughly 2 phases backend, 1 phase agent core, 1 phase agent packaging, 2 phases UI.

---

## 2. Existing Architecture (as verified in code)

- **Backend:** Express app assembled in `apps/api/src/server.ts:55` (`createExpressApp`), launched by root `server.ts` via `startExpressServer()` on port 3001. Feature-first layout: `server/features/<name>/{routes.ts, *Service.ts, types.ts}`, exposed through one-line facades in `services/<name>/index.ts`, registered as `register<Name>Routes(app)` at `apps/api/src/server.ts:117-134`.
- **Middleware chain (order):** `express.json` → `authContextMiddleware` → `apiAuthGate` → `scopeMiddleware` → `/evidence` static (`apps/api/src/server.ts:96-100`).
- **Auth:** opaque in-memory bearer tokens minted at login (`server/features/auth/routes.ts:99`, `sessions Map` at `:26`); scrypt password hashes; roles `admin`/`tester`; SSE gets `?token=` query-param fallback (`:28`). Tokens die on backend restart.
- **Scoping:** every row stamped with `ownerId/projectId/appId` via `scopeStamp` and filtered via `scopeFilter` (`server/shared/scope.ts:60,79`); scope arrives as `X-Project-Id`/`X-App-Id` headers auto-injected by the frontend fetch patch (`src/lib/base-path.ts:35-48`).
- **Persistence:** dual-mode — Postgres when `DATABASE_URL` set, else in-memory `db` object persisted to `.testflow-data.json` (`server/shared/storage.ts:44`, atomic temp-file writes `:180-199`). Schema is one idempotent `server/db/schema.sql` applied by `migrate()` (`server/db/pool.ts:62`). Per-entity repos in `server/db/repository.ts` branch on `isPgEnabled()`.
- **Streaming:** SSE only (no `ws`/socket.io anywhere). Canonical helpers: `prepareStreamingResponse` + 4KB anti-proxy-buffer pad (`server/features/controller/routes.ts:40-59`). Durable event log pattern: `agent_run_events` table (`schema.sql:506`) + projector (`server/features/agent/workflow/events.ts`).
- **Playwright:** launches via `server/shared/browser.ts` (semaphore, server-safe flags); execution writes specs under `.testflow-pw/` and runs them (`server/features/playwright/executionService.ts`), returning screenshots/trace paths copied into `/evidence`. **Codegen recorder already exists** at `server/features/playwright/routes.ts:106-161` (spawn `npx playwright codegen`, poll spec file, kill tree) with in-memory `codegenRuns Map`.
- **Frontend:** Vite + React 19 SPA, react-router v7 flat routes in `src/App.tsx:374-402`, Zustand stores, plain `fetch` on mount, SSE via `EventSource` (`src/lib/useAgentRun.ts`), **no WebSocket client**. Custom Tailwind-v4 design system on CSS variables (`--bg-card`, `--accent`, …) with dark mode via `data-theme` (`src/index.css:10-41`); lucide-react icons; shared `Modal`, `showToast/showAlert/showConfirm` (`src/lib/dialog.tsx`). Sidebar `navGroups` hardcoded in `src/App.tsx:33-67` — an `Automation` group already exists containing **Record & Play** (`src/pages/RecordPlay.tsx`, route `/record-play`), which drives the cloud-side codegen routes.
- **No scheduler, no job queue, no multipart uploads** anywhere in `server/`.

## 3. Dependency Graph (current, relevant slice)

```
server.ts ──► apps/api/src/server.ts (createExpressApp)
                  ├─► services/execution ──► server/features/playwright/routes.ts
                  │        └─► executionService.ts ──► server/shared/browser.ts ──► playwright
                  ├─► services/auth ──► server/features/auth/{routes,userStore}.ts
                  ├─► server/shared/scope.ts ◄── every feature's routes
                  └─► server/db/{pool,repository}.ts ◄─► server/shared/storage.ts (.testflow-data.json)
src/App.tsx ──► src/pages/RecordPlay.tsx ──► /api/playwright/codegen/* (fetch, headers via src/lib/base-path.ts)
```

## 4. Runtime Flow (current Record & Play)

1. User opens `/record-play`; page fetches `/api/app-config` + `/api/credentials/websites` (`RecordPlay.tsx:19-74`).
2. `POST /api/playwright/codegen/start` spawns `npx playwright codegen <url> --output .testflow-pw/codegen/<id>.spec.ts` **on the server machine** (`playwright/routes.ts:114+`). Refused unless localhost or `ALLOW_REMOTE_CODEGEN=true`.
3. UI polls `GET /api/playwright/codegen/:id` for the growing spec file; `POST .../stop` kills the process tree.
4. Execution: `POST /api/playwright/run` writes specs to `.testflow-pw/run-*/`, runs Playwright in-process host, copies screenshots to `evidence/`.

## 5. Evidence Flow (current)

Playwright run dir (`.testflow-pw/run-*`) → `executionService.ts` parses results, collects `screenshotPath`/`stepScreenshotPaths`/`tracePath` → files copied to `<cwd>/evidence/` → served statically at `/evidence` → UI renders URLs. Traces retained on failure (`trace: 'retain-on-failure'`, `executionService.ts:339`).

## 6. Context Flow (current)

Scope (project/app/user) travels as headers → `scopeMiddleware` → `req.scope` → `scopeStamp`/`scopeFilter` on every entity. The frontend remounts all pages on `scopeKey` change (`App.tsx:354`), so pages only fetch on mount. New Record & Play entities must ride this exact mechanism.

## 7. Prompt Flow

Not applicable to this module's core (recording/execution is deterministic). The "Generate AI Assertions / Test Data" summary-screen actions will call the existing agent pipeline (`server/features/agent/`) with the recorded script as input — reusing current prompt assembly, adding none.

## 8. Current Problems

1. **Browser runs in the cloud process** — impossible for deployed customers (already hard-guarded off in prod, `playwright/routes.ts:108-112`); headed codegen fundamentally can't run on a server.
2. Codegen state is an in-memory `Map` — lost on restart; no recording entity, no history, no artifacts.
3. No scheduler — `schedule`/`trigger_type` columns exist as dead metadata (`schema.sql:376-377`).
4. No machine identity/registration concept; auth tokens are in-memory and die on restart — unusable for a long-lived agent.
5. No binary upload path (JSON-only, 5 MB cap) — videos/trace.zip can't be ingested.
6. No push channel to an external process — SSE is server→browser only.
7. UI has a single recorder page; no executions/schedules/reports/agent-management surfaces.

## 9. Root Cause Analysis

The platform was built local-first: one machine ran UI, API, and browsers, so "execution environment" was never modeled as a separate entity. Everything downstream (in-process spawn, in-memory codegen map, JSON-only transport, no scheduler) follows from that single assumption. The fix is to introduce an **execution-environment boundary** (the Agent) with its own identity, transport, and artifact pipeline — not to patch the existing routes.

---

## 10. Proposed Architecture

```
┌────────────────────────────── Cloud (ops.acchindra.com/automation) ─────────────────────────────┐
│  React SPA ── /api/automation/* (HTTPS) ── Express :3001                                        │
│      │ SSE (existing pattern)                │                                                  │
│      ▼                                       ▼                                                  │
│  Live status  ◄── AgentGateway (ws, path /api/automation/agent-ws) ── Scheduler loop            │
│                       ▲            ▲                 │                                          │
└───────────────────────┼────────────┼─────────────────┼──────────────────────────────────────────┘
             outbound WSS│   HTTPS up/down│      job dispatch│(over the same WS)
┌───────────────────────┴────────────┴─────────────────┴──────────────┐
│ TestFlow Desktop Agent (Node/Fastify, localhost:2424)               │
│  ConnectionManager (WS, backoff reconnect, heartbeat 15s)           │
│  RecorderService  → playwright codegen (headed, user's browser)     │
│  RunnerService    → npx playwright test (local workspace)           │
│  ArtifactUploader → chunked HTTPS PUT (trace.zip, video, HTML rpt)  │
│  Local REST (localhost only) → /status /health /logs (diagnostics)  │
└─────────────────────────────────────────────────────────────────────┘
```

### Direction of connections (the load-bearing decision)
- **Agent → Cloud, always outbound.** Registration, heartbeat, uploads over HTTPS; live control (start/stop recording, run job, cancel, log streaming) over one persistent WebSocket the agent opens. Works through corporate NAT/firewalls; no inbound ports.
- **Browser → Cloud only.** The UI learns agent status from the cloud (heartbeat freshness), streamed to the page via the **existing SSE pattern** — no new browser-side WS client needed, matching current conventions (`useAgentRun.ts`).
- **Browser → localhost:2424 is optional sugar** (instant "agent detected" check before registration). It must degrade gracefully: an `https://` page fetching `http://localhost` is blocked by mixed content in most browsers, so the primary detection path is cloud heartbeat. The local API still fully serves the user's own machine diagnostics and the prompt-mandated endpoint surface.

### Cloud-side module: `server/features/automation/`
```
server/features/automation/
  routes.ts            # register + REST endpoints (all /api/automation/*)
  agentGateway.ts      # ws server, connection registry, message protocol, dispatch
  agentService.ts      # register/heartbeat/token lifecycle, fingerprint checks
  recordingService.ts  # recording entities, script ingestion
  jobService.ts        # job lifecycle: queued→dispatched→running→uploading→done/failed
  schedulerService.ts  # 30s tick loop; cron eval (cron-parser); enqueues jobs
  artifactService.ts   # chunked binary ingest → automation-artifacts/<jobId>/
  types.ts             # shared TS types (also consumed by agent + frontend via copy)
```
Facade `services/automation/index.ts`; one `registerAutomationRoutes(app, httpServer)` call in `createExpressApp` (WS needs the raw `http.Server`, so `startExpressServer` passes it — the only touch outside the feature dir besides schema/storage/env).

**Agent protocol (WS, JSON frames):** `{type, agentId, seq, payload}` with types `hello|heartbeat|record.start|record.status|record.chunk|record.done|job.dispatch|job.progress|job.log|job.done|cancel|error`. All frames persisted to a new `automation_events` append-only table (mirrors the proven `agent_run_events` pattern, `schema.sql:506`) so the UI's SSE projector replays state after refresh and the scheduler recovers orphaned jobs on restart.

**Agent auth:** pairing flow — user clicks "Download Agent" → cloud issues a one-time **pairing token** (10-min TTL) baked into `config.json` in the generated ZIP → agent calls `POST /api/automation/agents/register` with pairing token + machine fingerprint (hostname + OS + stable machineId hash) → cloud returns a **durable agent token** (random 256-bit, stored scrypt-hashed in `agents` table — deliberately NOT the in-memory session Map, which dies on restart) + refresh token. Agent tokens authenticate a dedicated `agentAuthMiddleware`; they are scoped to the owning user (`ownerId`) and org, never grant human-API access, and are revocable from the UI. Multiple agents per user/org supported (list keyed by agentId).

### Desktop agent repo layout: `agent/` (new top-level dir, own package.json, excluded from the app build)
```
agent/
  src/
    index.ts             # entry: load config, start local API + connection
    config.ts            # config.json load/validate; secure token storage (DPAPI via keytar-fallback-to-file-ACL)
    localApi.ts          # Fastify on 127.0.0.1:2424 — the PART-1 endpoint surface
    connection.ts        # WS client, exponential backoff (1s→60s cap), heartbeat, resume
    recorder.ts          # spawn playwright codegen; tail --output file; kill tree (taskkill /t /f on win, same as playwright/routes.ts:22)
    runner.ts            # materialize job workspace; npx playwright test; parse junit+json reporters
    artifacts.ts         # collect video/trace/screenshots/html-report; chunked upload with retry
    logger.ts            # pino, rotating file logs/agent-YYYY-MM-DD.log
    updater.ts           # version check against /api/automation/agent/latest; self-download
  scripts/
    install.bat          # bundles: check node runtime (ships pkg'd exe so none needed), npx playwright install
    start.bat / stop.bat
  pkg config → agent.exe (Node SEA or pkg), ZIP assembled by scripts/build-agent.mjs
```
Local REST API (127.0.0.1 bind only, rejects non-loopback): `GET /status /health /version /logs /report`, `POST /record/start /record/stop /run /cancel /browser/open /browser/close` — matching the required surface. These call the same services the WS commands call; WS is the cloud's path, REST is the local/diagnostic path.

### UI: extend the existing `Automation` nav group (`App.tsx:60-66`)
Pages in `src/pages/automation/`: `AutomationDashboard.tsx`, `RecordTest.tsx` (evolved from `RecordPlay.tsx` patterns: recorder form, agent status card, live recording screen, summary screen with Save/AI-Assertions/Run-Now/Schedule), `Executions.tsx`, `Schedules.tsx`, `AutomationReports.tsx` (timeline, steps, screenshots, video, trace download), `LocalAgent.tsx` (status, machine, browsers, CPU/mem from heartbeat payload, restart/logs/update actions relayed over WS). All using existing tokens/`Modal`/`showToast`/table conventions; live views use `EventSource` on `/api/automation/events?token=` (existing SSE auth pattern, `auth/routes.ts:28`). No-agent state renders the mandated "Local TestFlow Agent is not running" card with Download / Install Guide / Retry.

### Database schema (added to `server/db/schema.sql`, idempotent; mirrored in `storage.ts` JSON mode)
```sql
agents(id, owner_id, project_id, app_id, name, machine_name, os, fingerprint,
       token_hash, refresh_hash, version, playwright_version, browsers jsonb,
       cpu, memory, status, last_heartbeat_at, created_at, revoked_at)
recordings(id, owner_id, project_id, app_id, agent_id, name, app_url, browser,
           environment, status, script text, metadata jsonb, stats jsonb,
           started_at, completed_at)
automation_jobs(id, owner_id, project_id, app_id, recording_id, agent_id, schedule_id,
                trigger, status, queued_at, started_at, finished_at, exit_code,
                summary jsonb, error text)
automation_schedules(id, owner_id, project_id, app_id, recording_id, agent_id,
                     kind, cron, timezone, webhook_token_hash, enabled, next_run_at, last_run_at)
automation_artifacts(id, job_id, kind, filename, size, path, created_at)
automation_events(id, seq, scope_type, scope_id, type, payload jsonb, created_at)  -- append-only
```

### Scheduler
In-process 30-second tick in `schedulerService.ts` (matches single-process deployment; no queue dependency): evaluate `next_run_at`, enqueue `automation_jobs`, dispatch to the target agent's live WS (or mark `queued` until it reconnects — agent pulls pending jobs on connect). Webhook trigger: `POST /api/automation/hooks/:token` (public-prefix route with hashed token, same style as existing public prefixes). Cron parsing via `cron-parser` (new dep, tiny, no native code).

### Security summary
Pairing-token bootstrap; durable hashed agent tokens + refresh; machine fingerprint bound at registration and re-verified per connection; TLS terminates at the existing HTTPS front (`wss://`); agent-token middleware entirely separate from human sessions; all entities `scopeStamp`ed; artifact downloads authorized through scoped routes (not blanket static); localhost API bound to 127.0.0.1 and requiring an `X-Agent-Local-Key` from `config.json` to prevent drive-by localhost CSRF; secrets never logged.

---

## 11. Complete Refactoring Strategy

Strangler-fig, flag-gated (`REMOTE_AGENT_V1`, read via `isRemoteAgentEnabled()` in `server/shared/env.ts` style, surfaced in `/api/app-config` like `graphEngine`):
1. Build the cloud module additively — zero edits to existing playwright feature.
2. Build the agent as an isolated `agent/` workspace — its only coupling is the wire protocol (`types.ts` copied at build).
3. UI: new pages added alongside; the sidebar swaps `Record & Play` → new `Record Test` only when app-config reports the flag; old page keeps its route.
4. Execution reuse: the agent's `runner.ts` reuses the *spec-materialization contract* of `executionService.ts` (same reporters, same artifact names) so `Reports` semantics stay uniform — but runs it locally.
5. Once stable, the old cloud-side codegen routes become deprecated (kept working; flagged in UI as "local dev mode").

## 12–14. Files that must change — with reason and risk

**Net-new (no regression risk to existing app):**

| File(s) | Why | Risk |
|---|---|---|
| `server/features/automation/*` (8 files, §10) | The entire cloud module | Low (additive) |
| `services/automation/index.ts` | Facade per convention | Low |
| `agent/**` (~14 files) | Desktop agent | Low (separate workspace) |
| `scripts/build-agent.mjs` | ZIP/exe assembly | Low |
| `src/pages/automation/*` (6 pages) + `src/components/AgentStatusCard.tsx`, `src/lib/useAgentEvents.ts` | UI | Low (additive) |
| `docs/automation/*.md` (install guide, ops runbook) | Production docs | None |

**Modified existing files:**

| File | Why | Risk |
|---|---|---|
| `apps/api/src/server.ts` | Register routes; pass `http.Server` to gateway for WS upgrade; app-config flag | **Medium** — touches bootstrap; guarded by flag, WS attach is no-op when off |
| `server/db/schema.sql` | 6 new tables (idempotent DDL appended) | Low — `CREATE TABLE IF NOT EXISTS` pattern already proven |
| `server/shared/storage.ts` | Add arrays to `db`, snapshot, loader (`:44,:97,:130`) | Low-Medium — central file; additive keys only |
| `server/db/repository.ts` | New repos (Agents, Recordings, Jobs, Schedules, Artifacts, AutomationEvents) | Low — additive objects |
| `server/features/auth/routes.ts` | Add `/api/automation/agents/register` + `/hooks/` to `PUBLIC_API_PREFIXES` (`:72`) | **Medium** — auth surface; register requires pairing token, hooks require hashed token |
| `src/App.tsx` | Nav items + routes in `Automation` group | Low — data-only edits |
| `package.json` / `.env.example` | deps (`ws`, `cron-parser`), flag docs | Low |

Total: ~35 new + 7 modified in the main repo, ~15 in `agent/`.

## 15. Backward Compatibility Concerns

- Existing `/api/playwright/*` routes, `RecordPlay.tsx`, `.testflow-pw` execution, evidence serving: **untouched**.
- With `REMOTE_AGENT_V1` unset, no WS server attaches, no scheduler ticks, no new nav items render — the app is byte-for-byte behaviorally identical.
- JSON-store users: new arrays default to `[]`; old `.testflow-data.json` files load unchanged (loader treats missing keys as empty, matching current `loadPersistedData` style).
- The 5 MB JSON limit is untouched; binary uploads go through a new `express.raw`-scoped route only under `/api/automation/artifacts`.

## 16. Migration Strategy

No data migration needed (all entities are new). Idempotent DDL auto-applies via existing `migrate()`. Users of the old cloud-codegen flow migrate by downloading the agent; their previously generated scripts remain importable into `recordings` via a one-click "import existing script" action (reads `db.scripts`).

## 17. Testing Strategy

- **Unit:** schedulerService cron-eval/next-run math; agentService token lifecycle (pair→register→refresh→revoke, fingerprint mismatch); protocol frame validation; artifact chunk reassembly. Follows existing test layout/runner.
- **Integration (cloud):** spin `createExpressApp` in-process, fake agent WS client exercising hello→heartbeat→job.dispatch→job.done→artifact upload; SSE projector replay after simulated restart; orphaned-job recovery.
- **Integration (agent):** recorder spawn/kill-tree against a stub codegen; runner against a trivial local spec; reconnect storm (kill WS 20×, assert backoff + resume + no duplicate job execution — dedupe on job id).
- **E2E (manual + benchmark script):** real agent on this Windows machine against core-platform (:5002/:5003), record a List View flow, schedule it, verify report/video/trace in UI. Verify `npm run lint` (tsc) clean at every phase; backend restarted before any live verification (no hot reload — CLAUDE.md).

## 18. Rollback Strategy

- Per-phase: everything gated by `REMOTE_AGENT_V1` — unset the flag, restart backend, feature disappears; new tables are inert.
- Schema: additive-only DDL, never dropped on rollback (safe to leave).
- Agent side: agents failing auth after a rollback simply retry with backoff and show "disconnected" — no data loss (jobs stay `queued`).
- Git: each phase is an independently revertible commit series (no commits until explicitly told — standing rule).

## 19. Estimated Implementation Effort

| Phase | Content | Size |
|---|---|---|
| 1 | Cloud data layer + agent identity (schema, storage, repos, agentService, register/heartbeat REST, flag) | ~12 files |
| 2 | Gateway + jobs + scheduler + artifacts + SSE projector (WS server, protocol, jobService, schedulerService, artifactService, events) | ~9 files |
| 3 | Agent core (`agent/src/*`: connection, recorder, runner, artifacts, local API, logger, config) | ~11 files |
| 4 | Agent packaging + install UX (exe build, install/start/stop.bat, ZIP endpoint with baked pairing token, updater, install guide doc) | ~8 files |
| 5 | UI part 1 — Record Test + Local Agent + no-agent UX (pages, AgentStatusCard, useAgentEvents, nav/routes) | ~8 files |
| 6 | UI part 2 — Dashboard, Executions, Schedules, Reports (timeline/video/trace) + production docs + readiness report | ~10 files |

Each phase independently verified (lint, tests, backend restart, live check) before the next. Elapsed estimate: phases 1–2 ≈ 2–3 focused sessions, 3–4 ≈ 2–3, 5–6 ≈ 2–3.

## 20. Recommended Implementation Order — Phase Checklist

- [ ] **Phase 1 — Agent identity & data layer** · Files: `schema.sql`, `storage.ts`, `repository.ts`, `server/features/automation/{types,agentService,routes(partial)}.ts`, `services/automation/index.ts`, `apps/api/src/server.ts`, `auth/routes.ts` (public prefixes), `.env.example`, tests ·  **Risk: Medium** (bootstrap + auth touches)
- [ ] **Phase 2 — Gateway, jobs, scheduler, artifacts** · Files: `agentGateway.ts`, `jobService.ts`, `schedulerService.ts`, `artifactService.ts`, `recordingService.ts`, `routes.ts` (complete), events wiring, tests · **Risk: Medium** (new WS surface; flag-gated)
- [ ] **Phase 3 — Desktop agent core** · Files: `agent/src/*`, `agent/package.json`, integration tests · **Risk: Low** (isolated workspace)
- [ ] **Phase 4 — Packaging & install experience** · Files: `agent/scripts/*`, `scripts/build-agent.mjs`, download/ZIP endpoint, updater, `docs/automation/install-guide.md` · **Risk: Low**
- [ ] **Phase 5 — UI: Record Test + Local Agent** · Files: `src/pages/automation/{RecordTest,LocalAgent}.tsx`, `AgentStatusCard.tsx`, `useAgentEvents.ts`, `App.tsx` · **Risk: Low-Medium** (App.tsx nav/routes)
- [ ] **Phase 6 — UI: Dashboard/Executions/Schedules/Reports + docs + readiness report** · Files: remaining pages, `docs/automation/operations.md`, final production-readiness report · **Risk: Low**

## Future Extension Points

Linux/macOS agent builds (all code is cross-platform Node; only `.bat`/kill-tree/DPAPI branches are Windows-specific and already isolated); agent pools with capability-based job routing; parallel sharded execution across multiple agents; CI/CD trigger tokens per pipeline; artifact retention policies + S3 offload behind `artifactService`; AI self-healing of failing selectors by feeding trace.zip into the existing agent pipeline.

---

**Next step:** awaiting your explicit approval (and any scope corrections) before starting Phase 1. Nothing has been modified.
