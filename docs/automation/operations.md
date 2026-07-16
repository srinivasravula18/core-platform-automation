# Record & Play — Operations Runbook

Operational reference for the Record & Play (local desktop agent) subsystem. For the end-user setup
flow see [install-guide.md](./install-guide.md); for the architecture see
[../plans/record-play-local-agent-architecture-plan.md](../plans/record-play-local-agent-architecture-plan.md).

## Enabling the feature

The whole subsystem is gated by the `REMOTE_AGENT_V1` environment variable (same pattern as
`AGENT_GRAPH_V2`). With it unset/`0`:

- no agent routes register, no WebSocket gateway attaches, no scheduler ticks;
- the frontend renders no agent UI (the legacy `/record-play` codegen page is unchanged);
- the new tables exist but stay empty.

To enable: set `REMOTE_AGENT_V1=1` in the backend environment and **restart the backend** (`tsx server.ts`
has no hot reload). Confirm it reached the process: `GET /api/app-config` returns `"remoteAgent": true`.

Recommended with `DATABASE_URL` set (Postgres) so agent identity survives restarts. JSON-file mode
works for local dev.

## Moving parts

| Component | Where | Notes |
| --- | --- | --- |
| REST + gateway wiring | `apps/api/src/server.ts` | wraps the app in `http.Server`; attaches gateway + scheduler when the flag is on |
| Agent identity | `server/features/automation/agentService.ts` | pairing → register → durable scrypt-hashed tokens |
| WebSocket gateway | `server/features/automation/agentGateway.ts` | in-memory `agentId→socket`, 15s ping, frame routing |
| Jobs | `server/features/automation/jobService.ts` | lifecycle + orphan recovery |
| Scheduler | `server/features/automation/schedulerService.ts` | 30s in-process tick |
| Artifacts | `server/features/automation/artifactService.ts` | `automation-artifacts/<jobId>/` on the host |
| Events / SSE | `server/features/automation/eventsService.ts` | durable append + live fan-out to the UI |
| Desktop agent | `agent/` | separate Node workspace; bundled + downloaded per user |

## Health checks

- Backend: `GET /api/health` → `{ ok: true }`; `GET /api/app-config` → `remoteAgent` flag.
- Agent version endpoint: `GET /api/automation/agent/latest` → `{ version, downloadUrl }`.
- A user's agents: `GET /api/automation/agents` (authenticated) — check `status` and `lastHeartbeatAt`.
- On the agent machine: `GET http://localhost:2424/status` (needs `X-Agent-Local-Key`).

## Common operations

**Agent shows offline but the process is running.** The gateway marks an agent offline after ~45s
without a heartbeat. Check the agent console/log (`logs/agent-YYYY-MM-DD.log`), confirm outbound WSS to
the cloud is allowed, and that the token wasn't revoked. The agent auto-reconnects with backoff.

**Revoke a compromised/retired agent.** Automation → Local Agent → Revoke (or
`POST /api/automation/agents/:id/revoke`). Its tokens stop working immediately; it must be re-paired.

**Jobs stuck "running" after a backend restart.** Expected: `recoverOrphanedJobs()` runs at startup and
fails jobs whose in-flight state died with the previous process. Re-run them from Executions.

**Scheduler didn't fire.** The tick is every 30s; a schedule fires when `next_run_at <= now` and
`enabled`. Check the schedule row and that the backend process (which owns the ticker) is running.
Only one backend process should own the scheduler — do not run multiple schedulers against one DB.

## Storage & retention

Artifacts live under `automation-artifacts/<jobId>/` on the backend host and are served only through the
scope-authorized download route. There is no automatic retention yet — prune old job directories on a
schedule if disk pressure is a concern (see Future Extension Points in the architecture plan for the
S3-offload path).

## Security posture

- Agents connect **outbound only**; no inbound ports on user machines.
- Agent tokens are `<agentId>.<secret>` with only the scrypt hash stored; they authenticate solely the
  `/api/automation/agents/**` ingest surface, never the human API.
- Machine fingerprint is bound at registration.
- The localhost API is bound to `127.0.0.1` and requires `X-Agent-Local-Key`.
- Webhook triggers authenticate by a hashed per-schedule token.

## Rollback

Unset `REMOTE_AGENT_V1`, restart the backend. The gateway detaches, the scheduler stops, and the UI
hides the agent pages. New tables are additive and safe to leave in place.
