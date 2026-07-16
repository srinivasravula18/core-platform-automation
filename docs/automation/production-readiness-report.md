# Record & Play (Local Desktop Agent) — Production Readiness Report

**Date:** 2026-07-16 · **Branch:** `langchain_version` · **Flag:** `REMOTE_AGENT_V1` (default off)
**Plan of record:** [../plans/record-play-local-agent-architecture-plan.md](../plans/record-play-local-agent-architecture-plan.md)

Browser recording and execution now run on a downloadable **TestFlow Desktop Agent** that connects
outbound to the cloud. The cloud never launches a browser. Implemented in six verified phases, all
behind `REMOTE_AGENT_V1` so the existing app is byte-for-byte unchanged when the flag is off.

## What shipped, by phase

1. **Agent identity & data layer** — 6 idempotent tables (`agents`, `recordings`, `automation_jobs`,
   `automation_schedules`, `automation_artifacts`, `automation_events`), JSON-store mirrors, repositories,
   `agentService` (pairing → register → durable scrypt-hashed tokens → refresh → revoke), agent/human
   auth split, `/api/app-config` flag.
2. **Gateway, jobs, scheduler, artifacts** — outbound WebSocket gateway (auth on upgrade, 15s ping,
   frame routing), job lifecycle with restart orphan-recovery, 30s cron/interval scheduler, binary
   artifact ingest (raw `PUT`, 250 MB) with path-traversal guard, durable event log + SSE projector,
   webhook trigger. 28 automation routes total.
3. **Desktop agent core** — separate `agent/` Node workspace: outbound connection manager (backoff
   reconnect, heartbeat, token refresh), `playwright codegen` recorder with live streaming, local test
   runner (JUnit/JSON/HTML/trace/video), chunked artifact uploader, 127.0.0.1 REST API (the mandated
   endpoint surface, key-guarded), pino logging, updater.
4. **Packaging & install** — `install.bat`/`start.bat`/`stop.bat`, streaming ZIP download endpoint with a
   per-download single-use pairing token baked into `config.json`, version/updater endpoint, install guide.
5. **UI — Record Test + Local Agent** — native pages (setup → live recording → summary; agent management),
   reusable `AgentStatusCard`, the mandated "agent not running" download/guide/retry state, live SSE hook,
   flag-gated sidebar.
6. **UI — Dashboard / Executions / Schedules / Reports + docs** — overview metrics, run table with live
   logs + cancel, schedule management, execution report with screenshots/video/trace/downloads,
   operations runbook, this report.

## Verification

| Check | Result |
| --- | --- |
| Root typecheck (`npm run lint`, tsc) | ✅ clean |
| Agent typecheck (`agent/`, tsc) | ✅ clean |
| Frontend production build (`vite build`) | ✅ 2405 modules, no errors |
| `test:record-play` (agent identity lifecycle) | ✅ 21/21 |
| `test:record-play-jobs` (recordings, jobs, scheduler, artifacts, events) | ✅ 26/26 |
| `test:record-play-ws` (live WebSocket auth + dispatch, real socket) | ✅ 7/7 |
| Schema DDL applied to real Postgres | ✅ idempotent, clean |
| Agent boots + local API responds (`/health`, key-guarded `/status`) | ✅ verified |
| Agent bundle ZIP structure (config injected, node_modules excluded) | ✅ verified |
| Existing regression (`test:object-repository`, storage-backed) | ✅ 15/15 |

## Security posture

- Agents connect **outbound only**; no inbound ports on user machines.
- Durable agent tokens `<agentId>.<secret>` — only the scrypt hash is stored; they authenticate solely
  the `/api/automation/agents/**` ingest surface, never the human API; revocable instantly.
- One-time pairing tokens (10-min TTL); machine fingerprint bound at registration.
- Every entity is scope-stamped/filtered per project + owner (tenant isolation).
- Artifact downloads are scope-authorized (not blanket static); stored paths are traversal-guarded.
- Localhost API bound to `127.0.0.1` and requires `X-Agent-Local-Key`.
- Webhook triggers authenticate by a hashed per-schedule token.

## Backward compatibility

With `REMOTE_AGENT_V1` off: no routes register, no gateway attaches, no scheduler ticks, no UI appears;
the legacy `/api/playwright/codegen/*` recorder and `RecordPlay.tsx` are untouched. New tables are
additive; the 5 MB JSON body limit is unchanged (binary upload uses a scoped raw route only).

## Operational notes / go-live checklist

- [ ] Set `REMOTE_AGENT_V1=1` in the backend env and **restart the backend** (no hot reload). The
      running dev backend was intentionally **not** restarted during implementation — with the flag off
      its behavior is unchanged; a restart is required to serve the flag-on paths live.
- [ ] Ensure `DATABASE_URL` (Postgres) is set in production for durable agent identity across restarts.
- [ ] Ensure the `agent/` directory ships with the deployment (the download endpoint reads it).
- [ ] Confirm `GET /api/app-config` returns `"remoteAgent": true` after restart.
- [ ] Run **one** backend process as scheduler owner (do not run multiple against one DB).
- [ ] End-to-end smoke: download agent → install.bat → start.bat → record a flow → schedule → verify
      report/video/trace in the UI.

## Known limitations / future extension points

- **Single-binary `agent.exe`** is not yet produced; the pragmatic path ships source + `install.bat`
  (requires Node 18+). Node SEA/`pkg` packaging is the follow-up for a zero-Node install.
- **AI Assertions / Test Data** buttons on the summary screen are present but disabled — they hand off to
  the existing agent pipeline and are the next wiring step.
- **Artifact retention/offload** (S3, TTL) is manual today.
- **Cross-platform agent** (macOS/Linux) — the code is cross-platform; only `.bat`/kill-tree/DPAPI
  branches are Windows-specific and already isolated.
- **HTML report** upload is the single-file index; full asset bundling is a follow-up.
- **Pause/Resume recording** is not exposed (Playwright codegen has no pause); Stop/Discard are provided.

## Files

New: `server/features/automation/*` (11), `services/automation/index.ts`, `agent/**` (~18 incl. scripts),
`src/pages/automation/*` (6), `src/components/{AgentStatusCard,NoAgentState}.tsx`, `src/lib/useAutomation.ts`,
`scripts/test-record-play*.ts` (3), `docs/automation/*` (3). Modified: `server/db/{schema.sql,repository.ts}`,
`server/shared/storage.ts`, `server/features/auth/routes.ts`, `apps/api/src/server.ts`, `src/App.tsx`,
`.env.example`, `.gitignore`, `tsconfig.json`, `package.json`.
