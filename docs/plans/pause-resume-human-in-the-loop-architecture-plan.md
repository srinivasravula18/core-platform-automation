# Pause & Resume — Human-in-the-Loop Execution for Record & Play

**Status:** Phase 0 — analysis only. No files changed. Awaiting explicit approval on a later turn before any implementation.
**Date:** 2026-08-04
**Scope:** Record & Play script execution (local agent + server runner), not the LangGraph agent runtime.

---

## 1. Executive Summary

Recorded scripts fail at any step that a machine cannot complete alone: OTP codes, authenticator apps, SSO push approvals, email/SMS verification links, captcha, device trust prompts. Today the whole run fails at that step and every downstream assertion is lost.

This plan introduces a **pause point** as a first-class, compiled step in the script:

```ts
const otp = await tf.pause({ id: 'mfa-otp', kind: 'input', prompt: 'Enter the OTP sent to your phone' });
await page.getByLabel('One-time code').fill(otp);
```

`tf.pause()` blocks *inside the running Playwright process* until a resolver answers. The browser context, page state, cookies and in-memory auth token stay exactly as they were — so "resume where it stopped" is free, with no checkpointing or replay.

Two pause flavors, one contract:

| Flavor | `kind` | Who acts | Headed | Headless |
|---|---|---|---|---|
| Act in the live browser | `manual_action` | user, in the real window | yes | **no** (fails fast) |
| Supply a value | `input` | user, in the TestFlow UI | yes | yes |

`kind: 'input'` is the priority: it is the only flavor that survives headless, scheduled, and CI runs, and it is the migration path to full automation — later, a non-human **resolver** (TOTP seed, mail-inbox poller, test-account bypass) answers the same request with no script change.

**Key architectural constraint discovered in the code:** the agent does not run the script in-process. `agent/src/runner.ts:130` spawns `playwright test` as a **child process**; the WebSocket to the cloud lives in the parent (`agent/src/connection.ts`). A pause therefore needs a parent↔child control channel. The plan uses a loopback HTTP long-poll from the spec to the agent parent, which is the minimal addition that works identically on Windows/macOS/Linux and for both the local agent and the server runner.

**Effort:** ~5 phases, ~26 files, roughly 4–6 focused working days.

---

## 2. Existing Architecture

### Cloud (server/features/automation/)
- `types.ts` — single source of truth for the wire contract: `JobStatus`, `AgentFrameType`, `AgentFrame`.
- `agentGateway.ts` — one WebSocket per agent; `onAgentFrame(type, handler)` fan-out, `dispatchToAgent(agentId, frame)` cloud→agent.
- `jobService.ts` — job lifecycle `queued → dispatched → running → uploading → done|failed|cancelled`; `setJobStatus`, `tryDispatch` (one active job per agent, `jobService.ts:81`), `syncLinkedRunProgress`, orphan recovery.
- `serverRunner.ts` — headless execution on the server when no agent is available (scheduler path).
- `scriptMaterializer.ts` / `variableEngine.ts` / `placeholderRegistry.ts` — placeholder substitution (`{{unique.*}}`, dataset columns) at dispatch time.
- `scriptHardening.ts` — post-codegen transforms (login double-submit collapse, `goto`→`waitForURL`).
- `stepGrouping.ts` — `parseAtomicSteps(script)` derives `stepTotal` for progress.
- `eventsService.ts` — `emitEvent` → SSE/poll surface for the UI.

### Agent (agent/src/)
- `connection.ts` — one outbound WS, 15s heartbeat, frame router (`record.start/stop`, `job.dispatch`, `cancel`).
- `runner.ts` — writes a throwaway workspace (`playwright.config.ts`, `progress-reporter.cjs`, `tests/recording.spec.ts`), spawns `playwright test` as a child, parses stdout for `@@TESTFLOW_PROGRESS@@` lines, uploads artifacts, sends `job.done`.
- `localApi.ts` — loopback-only express API on `127.0.0.1:LOCAL_PORT`, guarded by `X-Agent-Local-Key`.

### UI (src/)
- `lib/useAutomation.ts` — job polling/subscription hooks.
- `pages/TestRuns.tsx`, `components/AutomationRunArtifacts.tsx` — run detail, progress, artifacts.

---

## 3. Dependency Graph

```
UI (useAutomation → TestRuns)
      │  REST + events
      ▼
routes.ts ── jobService ── agentGateway ══WS══ agent/connection
      │           │                                  │
      │           └── serverRunner (headless, local)  ├── runner ──spawn──► playwright test (child)
      │                                               │                         │
      └── eventsService (SSE)                         └── localApi              └── recording.spec.ts
```

New edges introduced by this plan (and nothing else):

```
recording.spec.ts ──HTTP long-poll──► agent control server (in runner)
agent control server ──WS frames──► agentGateway ──► pauseService ──► events ──► UI
UI "Resume" ──REST──► pauseService ──► dispatchToAgent ──► runner ──► control server ──► spec unblocks
```

---

## 4. Runtime Flow (proposed, headed local agent, `kind: 'input'`)

1. `tryDispatch` sends `job.dispatch` with the materialized script (unchanged).
2. `runner.run` starts an ephemeral **control server** on `127.0.0.1:<ephemeral>` scoped to this job, and injects `TESTFLOW_CONTROL_URL` + `TESTFLOW_CONTROL_KEY` + `TESTFLOW_JOB_ID` into the child env.
3. The spec's prelude (`tf`) reads those env vars. `tf.pause(req)` POSTs `/pause/open` and then **long-polls** `/pause/wait?token=…` (30s poll, loop) until answered.
4. Control server → `runner` → `send('job.paused', {...})` → gateway → `pauseService` persists a `automation_job_pauses` row and sets job status `awaiting_user`; `emitEvent('job.paused')`.
5. UI shows an "Action required" card on the run: prompt text, masked/plain input, Resume, Skip, Abort, and a live countdown to `expiresAt`.
6. User submits → `POST /api/automation/jobs/:id/pauses/:pauseId/resume {value|ack}` → `pauseService` validates (open, not expired, RBAC) → `dispatchToAgent('pause.resume', {...})`.
7. Runner hands the answer to the control server → the pending long-poll resolves → `tf.pause()` returns the string → script continues at the next line.
8. Job status returns to `running`; pause duration accumulates into `summary.pausedMs`; run is flagged `assisted`.

`kind: 'manual_action'` is identical except the resolve payload is a bare acknowledgement and the user acts in the real browser window before clicking Resume.

**Timeout path:** control server enforces `expiresAt` locally (authoritative, survives a cloud disconnect). On expiry `tf.pause()` throws `PauseExpiredError` → the step fails with a precise message → normal failure handling. `onTimeout: 'fail' | 'skip'` is per-pause.

**Disconnect path:** the cloud WS dropping does **not** kill the pause — the control server is local. On reconnect, the runner re-advertises every open pause (`job.paused` is idempotent by `pauseId`), so the UI's Resume button comes back. Same for a backend restart: `pauseService` re-hydrates open pauses from the DB.

---

## 5. Evidence Flow

- Pauses are recorded as timeline entries alongside steps: `pauseId`, `kind`, `prompt`, `openedAt`, `resolvedAt`, `resolvedBy` (userId or `resolver:<name>`), `outcome` (`resolved|skipped|expired|aborted`).
- **Supplied values are never persisted or logged.** Only `valueLength` and a `masked: true` flag. The existing progress reporter already masks `.fill(`/`.type(` titles (`runner.ts:48`); the same masking covers the fill that follows a pause.
- Video and trace are continuous across the pause (Playwright keeps recording), so the artifact shows exactly what the human did — valuable evidence, and a reason to keep `trace: 'on'`.
- `summary` gains `pausedMs`, `pauseCount`, `assisted: true`. `automationProgress` treats paused time as neither pass nor fail duration.

---

## 6. Context Flow

- The **pause definition** travels with the script (compiled step), not as runner configuration, so it survives copy, versioning, and dataset-driven fan-out.
- The **pause answer** travels out-of-band and is never written into the script or the DB.
- Data-driven batches: each row is a separate job, so each gets its own pause. A `scope: 'batch'` option (answer once, reuse for the whole batch, in-memory, batch-lifetime only) is designed but deferred to a later phase — noted here so the contract has room for it (`pauseScope` field reserved).

---

## 7. Prompt Flow

No LLM prompt changes. Pause detection during recording is a **heuristic + user review**, not a model call, and must stay app-agnostic:
- signal A: the field's accessible name / autocomplete attribute indicates a one-time code (`autocomplete="one-time-code"`, name/label matching a learned OTP-ish pattern);
- signal B: the recorded step crosses to a different origin than the app origin already derived in `scriptHardening.ts:89` (identity-provider redirect);
- signal C: recorder observed a long human idle gap at that step.

These are proposals surfaced in the recording review UI. Nothing is auto-inserted, and **no provider names, hostnames, or field names are hardcoded** — the app origin is learned from the recording, per the repo's no-hardcoding rule.

---

## 8. Current Problems

1. Any MFA/OTP/captcha step fails the run outright; the remaining coverage is never exercised.
2. `runner.ts` has no way to talk to the running spec — the child is a black box except for stdout progress lines.
3. `JobStatus` has no non-terminal "waiting on a human" state, so a paused job would look hung or be reaped.
4. `tryDispatch` allows **one active job per agent** (`jobService.ts:81`); a paused job would block that agent's entire queue indefinitely.
5. Orphan recovery (`recoverOrphanedJobs`) would mark a legitimately paused job `failed` after a backend restart.
6. `runner.ts:73` sets `timeout: 60000` per test — a pause of any length trips it.
7. `stepGrouping.parseAtomicSteps` derives `stepTotal` by pattern-matching the script; an unrecognized `tf.pause()` line would skew progress.
8. No UI affordance exists for "the run needs you"; the user would have to be watching logs.

---

## 9. Root Cause Analysis

The runner is designed as **fire-and-forget batch execution**: dispatch a script, read stdout, collect a verdict. Every problem above follows from that single assumption — there is no inbound control path to a running test, and no lifecycle state between "running" and "finished".

The fix is not to make the runner smarter about MFA. It is to add **one generic inbound channel and one non-terminal state**, and let the script itself declare where it needs help. That keeps MFA knowledge out of the platform entirely: MFA is just the first consumer of a generic "ask a resolver" primitive.

---

## 10. Proposed Architecture

### 10.1 The pause contract (`core/shared/pause.ts` — new, shared by cloud, agent, UI)

```ts
export type PauseKind = 'input' | 'manual_action';
export type PauseOutcome = 'resolved' | 'skipped' | 'expired' | 'aborted';

export interface PauseRequest {
  id: string;                 // stable, author-defined; unique within a script
  kind: PauseKind;
  prompt: string;
  hint?: string;
  masked?: boolean;           // default true for kind:'input'
  timeoutMs?: number;         // default PAUSE_DEFAULT_TIMEOUT_MS (300_000)
  onTimeout?: 'fail' | 'skip';// default 'fail'
  requiresHeaded?: boolean;   // implied true for 'manual_action'
}

export interface PauseAnswer {
  pauseId: string;
  attempt: number;            // resume idempotency: (jobId,pauseId,attempt)
  outcome: PauseOutcome;
  value?: string;             // 'input' only; never persisted
  resolvedBy: string;
}
```

### 10.2 Runtime helper (`tf`), injected into the spec by the runner

A small prelude prepended to `recording.spec.ts` (alongside the existing `bundledTestRuntime` transform):
- `tf.pause(req): Promise<string>` — returns the supplied value, or `''` for `manual_action`/`skipped`.
- Reads `TESTFLOW_CONTROL_URL`/`_KEY` from env. **If unset, `tf.pause` resolves immediately with `''` and logs a warning** — so a script with pauses still runs in a plain `npx playwright test` outside the platform.
- Wraps the wait in `test.step('pause: <prompt>')` so it shows in trace and progress.

### 10.3 Agent control server (`agent/src/pauseControl.ts` — new)

- `http.createServer` bound to `127.0.0.1`, **ephemeral port**, per-job random key, closed when the job process exits. Same loopback+shared-key posture as `localApi.ts:26`.
- Routes: `POST /pause/open`, `GET /pause/wait` (long-poll ≤30s), and an internal `resolve(pauseId, answer)` called by the runner on a `pause.resume` frame.
- Owns the authoritative expiry timer per pause.

### 10.4 Cloud (`server/features/automation/pauseService.ts` — new)

- Persists pauses, exposes list/resume/skip/abort, re-hydrates on boot, re-advertises on agent reconnect, and emits `job.paused` / `job.resumed` events.
- Enforces RBAC on resume via the existing `rbacGate` (a resume is a run-execute action).

### 10.5 Job status + scheduling

- New `JobStatus` value `awaiting_user` (non-terminal). Added to every existing status list in `jobService.ts` (`setJobStatus` guard `:33`, `tryDispatch` active filter `:82`, orphan recovery, `syncLinkedRunProgress`).
- **Concurrency:** a job in `awaiting_user` no longer counts as "active" for dispatch purposes, but a new `maxPausedPerAgent` cap (default 3) prevents unbounded browser windows. This is the change that makes pause safe under parallel execution.
- **Orphan recovery** skips `awaiting_user` jobs whose agent is connected; it reaps them only when the agent has been gone past a grace window.

### 10.6 Playwright config

`timeout` becomes `0` for tests containing pauses (or, preferred, the prelude calls `test.setTimeout(0)` on entry to a pause and restores a computed budget after) — so only the pause's own `expiresAt` governs.

### 10.7 Server runner (headless)

`serverRunner.ts` gets the same control server. `manual_action` pauses are rejected up front with a clear "this script needs a headed run" error rather than hanging; `input` pauses work identically, which is what makes scheduled MFA runs possible.

---

## 11. Complete Refactoring Strategy

Additive throughout. No existing function signature changes; `JobStatus` gains a member (a union widening — every `switch` over it is audited in Phase 2). Everything sits behind the flag `PAUSE_RESUME_V1` (default **off**), consistent with `REMOTE_AGENT_V1` in `flag.ts`. With the flag off, no prelude is injected, no control server starts, and `tf.pause` never appears in a compiled script.

---

## 12–14. Files That Must Change (with reason + risk)

### Phase A — Contract & runtime primitive (6 files)

| File | Why | Risk |
|---|---|---|
| `core/shared/pause.ts` *(new)* | Single source of truth for `PauseRequest`/`PauseAnswer`/defaults, shared cloud+agent+UI | **Low** |
| `server/features/automation/types.ts` | Add `awaiting_user` to `JobStatus`; add `job.paused`/`pause.resume`/`pause.cancel` to `AgentFrameType` | **Medium** — union widening ripples through switches |
| `server/features/automation/flag.ts` | Add `PAUSE_RESUME_V1` | **Low** |
| `agent/src/pauseControl.ts` *(new)* | Loopback control server + pending-pause registry + expiry | **Medium** — new listening socket; must bind loopback only |
| `agent/src/preludeSource.ts` *(new)* | The `tf` helper source injected into the spec | **Medium** — runs inside the user's test process |
| `scripts/test-pause-contract.ts` *(new)* | Unit coverage for contract defaults + expiry + idempotency | **Low** |

### Phase B — Agent execution path (4 files)

| File | Why | Risk |
|---|---|---|
| `agent/src/runner.ts` | Start/stop control server per job, inject env + prelude, forward `job.paused`, apply `pause.resume`, re-advertise open pauses, exclude paused time from the failure heuristic | **High** — core execution path |
| `agent/src/connection.ts` | Route `pause.resume`/`pause.cancel` frames to the runner; report `awaiting_user` in the heartbeat instead of `busy` | **Medium** |
| `agent/src/localApi.ts` | Local `GET /pauses` + `POST /pauses/:id/resolve` for offline/local-only use | **Low** |
| `scripts/test-agent-pause-runner.ts` *(new)* | Spawn a real spec with a pause, resolve it, assert the run completes | **Medium** |

### Phase C — Cloud lifecycle (7 files)

| File | Why | Risk |
|---|---|---|
| `server/db/schema.sql` | `automation_job_pauses` table (idempotent `CREATE TABLE IF NOT EXISTS` + additive `ALTER`s), per repo schema rule | **Medium** — must verify `scripts/setup-db.bat` |
| `server/db/repository.ts` | `AutomationJobPauses` accessor | **Low** |
| `server/features/automation/pauseService.ts` *(new)* | Open/resolve/expire/re-hydrate/re-advertise + events | **Medium** |
| `server/features/automation/jobService.ts` | `awaiting_user` in status guards, dispatch-active filter, orphan recovery, linked-run progress; `pausedMs`/`assisted` in summary | **High** — status machine |
| `server/features/automation/routes.ts` | `GET /jobs/:id/pauses`, `POST /jobs/:id/pauses/:pauseId/resume|skip`, RBAC-gated | **Medium** |
| `server/features/automation/serverRunner.ts` | Same control server headless; reject `manual_action` up front | **Medium** |
| `core/shared/testRunStatus.ts` | `awaiting_user` is active-not-closed; label "Waiting for you" | **Low** |

### Phase D — UI (5 files)

| File | Why | Risk |
|---|---|---|
| `src/lib/useAutomation.ts` | Subscribe to `job.paused`/`job.resumed`; expose open pauses | **Low** |
| `src/components/RunPausePrompt.tsx` *(new)* | Action-required card: prompt, masked input, Resume/Skip/Abort, countdown | **Low** |
| `src/pages/TestRuns.tsx` | Render the card; `Waiting for you` status chip | **Medium** |
| `src/components/AutomationRunArtifacts.tsx` | Show pause entries + durations in the timeline | **Low** |
| `src/pages/Recordings*.tsx` (pause authoring) | Insert/edit pause steps; accept/dismiss recorder-proposed pauses | **Medium** |

### Phase E — Authoring & detection (4 files)

| File | Why | Risk |
|---|---|---|
| `server/features/automation/pauseDetection.ts` *(new)* | Heuristic proposals (autocomplete attr, cross-origin hop, idle gap) — learned, never hardcoded | **Medium** — false positives must be dismissible |
| `server/features/automation/scriptMaterializer.ts` | Emit `tf.pause()` for pause steps at materialize time | **Medium** |
| `server/features/automation/stepGrouping.ts` | Count a pause as one atomic step so `stepTotal` stays correct | **Low** |
| `server/features/automation/recordingService.ts` | Persist pause markers on recording steps | **Medium** |

**Total: 26 files (10 new).** Phase A+B = 10, C = 7, D = 5, E = 4 — every phase within the 10–15 file cap.

---

## 15. Backward Compatibility

- Flag default off ⇒ zero behavior change for existing recordings, jobs, schedules, and agents.
- **Agent version skew is the real risk:** a cloud with pauses enabled dispatching to an old agent produces a script whose `tf` is undefined. Mitigation: the prelude is injected by the *agent*, not the cloud, and the cloud refuses to dispatch a pause-bearing script to an agent below `MIN_PAUSE_AGENT_VERSION` (clear, actionable error). Agents already report `version` in telemetry (`system.ts`).
- Existing `JobStatus` consumers treat unknown statuses as non-terminal today; the audit in Phase C makes that explicit rather than incidental.
- A script authored with pauses still runs under bare `npx playwright test` (prelude no-ops without env).

---

## 16. Migration Strategy

1. Ship Phases A–C with the flag off; run existing suites to prove no regression.
2. Enable for one internal recording with a manual pause step; verify headed resume end-to-end.
3. Enable `kind: 'input'` on a headless scheduled run; verify the UI prompt path.
4. Turn on recorder proposals (Phase E) last — it is the only piece that touches recordings users already own.
5. No data migration; the pause table starts empty. Existing jobs are untouched.

---

## 17. Testing Strategy

- **Unit:** contract defaults, expiry arithmetic, resume idempotency `(jobId,pauseId,attempt)`, redaction (assert the value never reaches logs/DB/events).
- **Agent integration:** real `playwright test` child with a pause → resolve via control server → run completes; plus expiry→fail, expiry→skip, cancel-while-paused (must kill the child cleanly), agent-restart-while-paused.
- **Cloud integration:** status transitions incl. `awaiting_user`, dispatch not blocked by a paused job, `maxPausedPerAgent` enforcement, orphan recovery skips paused jobs, re-advertise after backend restart.
- **UI:** card appears/disappears on events, countdown, double-click Resume does not double-advance.
- **Regression gate:** `npm run lint` (tsc --noEmit) + existing `scripts/test-record-play-jobs.ts`, `test-automation-progress.ts`, `test-manual-test-run.ts` must stay green. Backend restart required before any live verification (no hot-reload).

---

## 18. Rollback Strategy

- **Level 1:** set `PAUSE_RESUME_V1=false` and restart the backend — no pauses compiled, no control server, no new statuses emitted. Instant.
- **Level 2:** if paused jobs are stuck, `POST /jobs/:id/pauses/:pauseId/skip` or cancel the job; both paths already terminate the child process.
- **Level 3:** revert Phases E→A in order. The pause table can be dropped independently (no FK from jobs; the join is by `job_id` only, deliberately).

---

## 19. Estimated Effort

| Phase | Files | Effort |
|---|---|---|
| A — contract & primitive | 6 | ~0.5 day |
| B — agent execution | 4 | ~1 day |
| C — cloud lifecycle | 7 | ~1.5 days |
| D — UI | 5 | ~1 day |
| E — authoring & detection | 4 | ~1 day |
| **Total** | **26** | **~5 days** |

---

## 20. Recommended Implementation Order

- [ ] **Phase A — Contract & runtime primitive.** `core/shared/pause.ts`, `types.ts`, `flag.ts`, `agent/src/pauseControl.ts`, `agent/src/preludeSource.ts`, `scripts/test-pause-contract.ts`. *Risk: Medium.* Gate: lint clean, contract tests pass.
- [ ] **Phase B — Agent execution path.** `agent/src/runner.ts`, `connection.ts`, `localApi.ts`, `scripts/test-agent-pause-runner.ts`. *Risk: High.* Gate: a real paused spec resumes end-to-end on the local agent; existing job tests green.
- [ ] **Phase C — Cloud lifecycle.** `schema.sql`, `repository.ts`, `pauseService.ts`, `jobService.ts`, `routes.ts`, `serverRunner.ts`, `testRunStatus.ts`. *Risk: High.* Gate: `setup-db.bat` verified idempotent, status-machine tests green, backend restarted before live checks.
- [ ] **Phase D — UI.** `useAutomation.ts`, `RunPausePrompt.tsx`, `TestRuns.tsx`, `AutomationRunArtifacts.tsx`, recording editor. *Risk: Medium.* Gate: headed OTP run resumed from the UI.
- [ ] **Phase E — Authoring & detection.** `pauseDetection.ts`, `scriptMaterializer.ts`, `stepGrouping.ts`, `recordingService.ts`. *Risk: Medium.* Gate: proposals reviewable and dismissible; `stepTotal` unchanged for pause-free scripts.

**Deferred by design (not in this plan):** non-human resolvers (TOTP seed, mail-inbox poller) — the `resolvedBy` field and the resolver-shaped contract exist so they slot in without a redesign; `pauseScope: 'batch'` for data-driven fan-out.

---

## Open decisions for the approval turn

1. Default `PAUSE_DEFAULT_TIMEOUT_MS` — proposed **5 minutes**.
2. `maxPausedPerAgent` — proposed **3**.
3. Whether `assisted` runs count toward pass-rate dashboards — proposed **excluded from unattended pass-rate**, shown separately.
