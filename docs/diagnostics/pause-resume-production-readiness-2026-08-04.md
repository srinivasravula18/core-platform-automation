# Pause/Resume Human-in-the-Loop — Production Readiness

Date: 2026-08-04  
Source plan: `docs/plans/pause-resume-human-in-the-loop-architecture-plan.md`

## Executive status

All implementation phases (A–E) are complete. The feature is ready for a controlled internal rollout behind the code-level `PAUSE_RESUME_V1` flag after one live headed UI smoke test. Broad production enablement is not recommended until that smoke test is recorded.

The feature flag is enabled by default in code. Setting it to `0` and redeploying is the immediate rollback: recorder proposals stop, accepted authoring markers remain inert during materialization, and existing pause-free jobs follow their previous path.

## Phase completion

### Phase A — Contract and runtime primitive

Status: Complete. Risk: Medium.

- Added the canonical pause request/answer contract, normalization, defaults, and stable attempt key.
- Added the feature flag, loopback pause control server, injected `tf.pause()` prelude, and contract checks.
- Kept bare Playwright execution backward compatible when the control environment is absent.

Primary files: `core/shared/pause.ts`, `server/features/automation/types.ts`, `server/features/automation/flag.ts`, `agent/src/pauseControl.ts`, `agent/src/preludeSource.ts`, `scripts/test-pause-contract.ts`.

### Phase B — Agent execution path

Status: Complete. Risk: High.

- Wired pause control into agent dispatch, resume, skip/cancel, reconnect advertisement, and local API handling.
- Preserved Playwright trace/video continuity and removed the ordinary test timeout for pause-bearing specs.
- Added real Playwright agent and server-runner pause/resume integration coverage.

Primary files: `agent/src/runner.ts`, `agent/src/connection.ts`, `agent/src/localApi.ts`, compiled `agent/dist/*`, `scripts/test-agent-pause-runner.ts`.

### Phase C — Cloud lifecycle and persistence

Status: Complete. Risk: High.

- Added idempotent pause persistence and JSON fallback storage without storing supplied values.
- Added `awaiting_user`, pause events, resume/skip routes, cancellation/expiry cleanup, reconnect behavior, concurrency limits, linked-run projection, and headless server execution.
- Added the minimum compatible agent guard (`1.0.1`) for pause-bearing dispatches.

Primary files: `server/db/schema.sql`, `server/db/repository.ts`, `server/shared/storage.ts`, `server/features/automation/pauseService.ts`, `server/features/automation/jobService.ts`, `server/features/automation/routes.ts`, `server/features/automation/serverRunner.ts`, `server/features/auth/permissions.ts`, `core/shared/testRunStatus.ts`.

Database setup was run twice successfully, confirming the authoritative schema remains idempotent for an existing database.

### Phase D — Run UI

Status: Complete. Risk: Medium.

- Added `Waiting for you` status presentation and SSE-aware pause loading.
- Added an accessible action-required card with countdown, masked input reveal, Resume, Skip, and confirmed Abort.
- Added pause outcomes, resolver identity, and duration to run history.

Primary files: `src/lib/useAutomation.ts`, `src/components/RunPausePrompt.tsx`, `src/pages/TestRuns.tsx`, `src/components/AutomationRunArtifacts.tsx`.

### Phase E — Authoring and detection

Status: Complete. Risk: Medium.

- Added review-only proposals for one-time-code semantics, cross-origin transitions, and observed idle gaps. No provider, hostname, or application field is hardcoded.
- Added accept, dismiss, add, edit, and remove controls in the existing recording/data-binding editor.
- Persisted accepted pauses in recording-step metadata and materialized input pauses as action values or manual pauses before actions.
- Counted `tf.pause()` as one atomic execution step; pause-free totals remain unchanged.

Primary files: `server/features/automation/pauseDetection.ts`, `server/features/automation/scriptMaterializer.ts`, `server/features/automation/stepGrouping.ts`, `server/features/automation/recordingService.ts`, `server/db/repository.ts`, `server/features/automation/routes.ts`, `src/pages/automation/DataBindings.tsx`, `scripts/test-recording-step-model.ts`, `scripts/test-step-grouping.ts`.

## Validation evidence

| Check | Result |
|---|---|
| Root TypeScript (`tsc --noEmit`) | Pass |
| Root production frontend + backend build | Pass; existing Vite chunk-size warning only |
| Agent TypeScript lint and build | Pass |
| Pause contract | Pass |
| Real Playwright agent/server pause runner | Pass |
| Recording/job lifecycle | 47 passed, 0 failed |
| Recording-step authoring/detection/materialization | Pass |
| Step grouping | 13 passed, 0 failed |
| Data-driven materialization | Pass |
| RBAC route resolution | Pass |
| Database setup, repeated | Pass twice |
| Pause/resume diff whitespace check | Pass; line-ending warnings only |

An unrelated existing `test:mission-context` baseline remains at 80 passed / 7 failed; none of its implementation files were changed for pause/resume.

The overall worktree whitespace check also reports trailing spaces in the concurrently modified, out-of-scope `src/components/CodegenPanel.tsx`; that user-owned change was left untouched.

## Security and privacy

- Resume values are carried only to the waiting local control process.
- Persistence records only `valueLength` and masked metadata; supplied values are not written to the database or event payloads.
- Control endpoints bind to loopback and require a per-job random key.
- Human routes are scoped and protected by `automation:read`, `automation:update`, or `automation:execute` as appropriate.
- Older desktop agents receive an actionable failure instead of a pause-bearing script they cannot execute.

## Remaining rollout gate

The plan's live headed UI gate was not executable in this session because the in-app Browser runtime reported `Browser is not available: iab` after retry. Before enabling the flag beyond an internal cohort, run one end-to-end headed OTP scenario through the rendered Test Runs page and verify:

1. the run displays `Waiting for you` and the countdown;
2. a masked value resumes the same browser/spec process;
3. the value does not appear in logs, events, persistence, screenshots, or history;
4. refresh/reconnect restores the open prompt;
5. Abort and expiry close the pause and produce the expected terminal state.

## Rollback

Set the code-level `PAUSE_RESUME_V1` flag to `0` and redeploy. The new table is additive and can remain in place. Existing recording-step pause metadata is retained but is inert, allowing rollback without destructive data migration.
