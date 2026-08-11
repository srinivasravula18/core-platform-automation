/**
 * Record & Play — job lifecycle.
 *
 * A job is one execution of a recording on an agent. Lifecycle:
 *   queued → dispatched → running → uploading → done | failed | cancelled
 * If the target agent is online the job is pushed immediately; otherwise it stays queued and is
 * flushed when the agent (re)connects. On process restart, in-flight jobs whose in-memory dispatch
 * state died are reconciled to `failed` (they can be re-run) — the same orphan-recovery principle the
 * LangGraph runtime uses for agent runs.
 */

import { Agents, AutomationExecutionBatches, AutomationJobPauses, AutomationJobs, Cases, Recordings, Runs } from '../../db/repository';
import { uid, isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import type { Scope } from '../../shared/scope';
import { scopeStamp } from '../../shared/scope';
import { applyExecutionProgress, automationProgressPercent, finalizeExecutionProgress, mergeExecutionProgress } from '../../../core/shared/automationProgress';
import { normalizeCaseSteps } from '../../shared/testCases';
import { emitEvent } from './eventsService';
import { onAgentFrame, onAgentConnected, dispatchToAgent, isAgentConnected } from './agentGateway';
import { cancelServerJob } from './serverRunner';
import { runTeardown } from './teardownService';
import type { AgentFrame, JobStatus, JobTrigger } from './types';
import { parseAtomicSteps, wrapRecordedScriptSteps } from './stepGrouping';
import { closeOpenPausesForJob, recordPause } from './pauseService';
import { isPauseResumeEnabled } from './flag';
import { injectAuthChallengePauses } from './pauseDetection';

const MAX_PAUSED_PER_AGENT = 3;
export const MIN_PAUSE_AGENT_VERSION = '1.0.2';

export function agentSupportsPauseResume(version: string): boolean {
  const parts = (value: string) => String(value || '').split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const current = parts(version); const minimum = parts(MIN_PAUSE_AGENT_VERSION);
  for (let index = 0; index < 3; index += 1) if (current[index] !== minimum[index]) return current[index] > minimum[index];
  return true;
}

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

export async function setJobStatus(jobId: string, status: JobStatus, patch: Record<string, any> = {}) {
  const job = await AutomationJobs.get(jobId);
  if (!job) return null;
  if (['done', 'failed', 'cancelled'].includes(job.status) && ['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(status)) return job;
  const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
  const summary = terminal
    ? finalizeExecutionProgress(patch.summary || job.summary || {}, status, String(patch.error || job.error || ''), Date.parse(String(patch.finishedAt || '')) || Date.now())
    : patch.summary;
  const saved = await AutomationJobs.upsert({ ...job, status, ...patch, ...(summary ? { summary } : {}) });
  persist('job status');
  await emitEvent({ scopeType: 'job', scopeId: jobId, type: `job.${status}`, ownerId: job.ownerId, data: { job: saved } });
  if (saved.batchId) await refreshExecutionBatch(saved.batchId);
  if (['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(status)) await syncLinkedRunProgress(jobId, status, saved.summary || {});
  return saved;
}
const setStatus = setJobStatus;

/**
 * Create a job that will execute on the SERVER (headless), not on a local agent. Used by the
 * scheduler so scheduled runs fire even when the user's agent is offline. The caller then invokes
 * the server runner. No agent dispatch happens here.
 */
export async function createServerJob(input: { recordingId: string; scheduleId?: string; trigger?: JobTrigger; script?: string; scheduleExecutionId?: string; scheduleItemId?: string; stageNo?: number; position?: number }, scope: Scope) {
  const now = new Date().toISOString();
  const job = await AutomationJobs.upsert({
    id: uid('JOB'),
    recordingId: input.recordingId,
    agentId: '',
    scheduleId: input.scheduleId || null,
    trigger: input.trigger || 'schedule',
    status: 'queued' as JobStatus,
    queuedAt: now,
    summary: {},
    error: '',
    script: input.script || '',
    scheduleExecutionId: input.scheduleExecutionId || '',
    scheduleItemId: input.scheduleItemId || '',
    stageNo: input.stageNo,
    position: input.position,
    ...scopeStamp(scope),
  });
  persist('server job created');
  await emitEvent({ scopeType: 'job', scopeId: job.id, type: 'job.queued', ownerId: job.ownerId || '', data: { job } });
  return job;
}

// Manual-run options fast path (no DB column of their own). In-memory only, so it can be lost on a
// server restart — but tryDispatch falls back to `trigger === 'manual'` for `headed`, which IS
// persisted, so a re-flushed job still runs headed. This map is just an override hook for the future.
const jobRunOptions = new Map<string, { headed: boolean }>();

/** Push a queued job to its agent if connected; returns true if dispatched. */
export async function tryDispatch(jobId: string): Promise<boolean> {
  const job = await AutomationJobs.get(jobId);
  if (!job || job.status !== 'queued') return false;
  if (!job.agentId || !isAgentConnected(job.agentId)) return false;
  const active = (await AutomationJobs.list()).some((item) =>
    item.id !== job.id && item.agentId === job.agentId && ['dispatched', 'running', 'uploading'].includes(item.status));
  if (active) return false;
  const paused = (await AutomationJobs.list()).filter((item) => item.agentId === job.agentId && item.status === 'awaiting_user').length;
  if (paused >= MAX_PAUSED_PER_AGENT) return false;
  const rec = job.recordingId ? await Recordings.get(job.recordingId) : null;
  const authored = (job as any).script || rec?.script || '';
  // Gate OTP/MFA fills on the dispatched copy only. Catches hand-edited and agent-authored scripts
  // that never went through recording-step detection; the stored script is left untouched.
  // Dispatched copy only, same as the pause-injection above — labels each recorded step for live
  // per-step correlation on the agent side without touching the stored/editable script.
  const script = wrapRecordedScriptSteps(isPauseResumeEnabled() ? injectAuthChallengePauses(authored) : authored);
  if (isPauseResumeEnabled() && /\btf\.pause\s*\(/.test(script)) {
    const agent = await Agents.get(job.agentId);
    if (!agentSupportsPauseResume(String(agent?.version || ''))) {
      await setStatus(jobId, 'failed', { error: `This run requires desktop agent ${MIN_PAUSE_AGENT_VERSION} or newer. Update the agent and retry.`, finishedAt: new Date().toISOString() });
      return false;
    }
  }
  const ok = dispatchToAgent(job.agentId, {
    type: 'job.dispatch',
    payload: {
      jobId: job.id,
      recordingId: job.recordingId,
      script,
      stepTotal: parseAtomicSteps(script).length,
      browser: rec?.browser || 'chromium',
      environment: rec?.environment || 'QA',
      appUrl: rec?.appUrl || '',
      browserPermissions: rec?.metadata?.browserPermissions || {},
      // Manual runs are always headed (a window opens on the agent so the user can watch). Derive it
      // from the persisted trigger so the flag survives a server restart or a re-dispatch on reconnect
      // — the in-memory jobRunOptions below is only a same-process fast path, not the source of truth.
      // A gate the user must satisfy in the browser is unanswerable headless, whatever triggered the run.
      headed: jobRunOptions.get(job.id)?.headed ?? (job.trigger === 'manual' || /"requiresHeaded":\s*true/.test(script)),
      pauseResume: isPauseResumeEnabled(),
    },
  });
  if (ok) {
    jobRunOptions.delete(job.id);
    await setStatus(jobId, 'dispatched');
  }
  return ok;
}

async function dispatchNextForAgent(agentId: string): Promise<void> {
  const next = (await AutomationJobs.list())
    .filter((job) => job.agentId === agentId && job.status === 'queued')
    .sort((a, b) => new Date(a.queuedAt || 0).getTime() - new Date(b.queuedAt || 0).getTime())[0];
  if (next) await tryDispatch(next.id);
}

export async function refreshExecutionBatch(batchId: string): Promise<any> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch) return null;
  const jobs = (await AutomationJobs.list()).filter((job) => job.batchId === batchId);
  const count = (status: string) => jobs.filter((job) => job.status === status).length;
  const summary = {
    total: jobs.length,
    queued: count('queued'),
    running: count('dispatched') + count('running') + count('awaiting_user') + count('uploading'),
    passed: count('done'),
    failed: count('failed'),
    cancelled: count('cancelled'),
  };
  const terminal = summary.passed + summary.failed + summary.cancelled;
  const status = jobs.length > 0 && terminal === jobs.length
    ? (summary.failed > 0 ? 'failed' : summary.cancelled === jobs.length ? 'cancelled' : 'done')
    : summary.running > 0 || terminal > 0 ? 'running' : 'queued';
  await AutomationExecutionBatches.upsert({ ...batch, status, summary });
  persist('execution batch status');
  await emitEvent({ scopeType: 'batch', scopeId: batchId, type: `batch.${status}`, ownerId: batch.ownerId, data: { batch: { ...batch, status, summary } } });
  // Ephemeral policy: once every row is terminal, clean up the data this batch wrote (idempotent).
  if (terminal === jobs.length && jobs.length > 0 && batch.dataPolicy === 'ephemeral') void runTeardown(batchId);
  return { ...batch, status, summary };
}

export async function createJob(input: { recordingId: string; agentId: string; trigger?: JobTrigger; scheduleId?: string; headed?: boolean; script?: string; batchId?: string; datasetRowId?: string; rowNumber?: number; dispatch?: boolean }, scope: Scope) {
  const now = new Date().toISOString();
  const job = {
    id: uid('JOB'),
    recordingId: input.recordingId,
    agentId: input.agentId,
    scheduleId: input.scheduleId || null,
    trigger: input.trigger || 'manual',
    status: 'queued' as JobStatus,
    queuedAt: now,
    summary: {},
    error: '',
    script: input.script || '', batchId: input.batchId || '', datasetRowId: input.datasetRowId || '', rowNumber: input.rowNumber || null,
    ...scopeStamp(scope),
  };
  const saved = await AutomationJobs.upsert(job);
  persist('job created');
  if (input.headed) jobRunOptions.set(saved.id, { headed: true });
  await emitEvent({ scopeType: 'job', scopeId: saved.id, type: 'job.queued', ownerId: job.ownerId || '', data: { job: saved } });
  if (input.dispatch !== false) await tryDispatch(saved.id);
  return saved;
}

/** Create the durable Test Run that exposes an automation job's status and evidence. */
export async function createLinkedTestRun(job: any, recording: any, scope: Scope, input: { id?: string; name?: string; caseId?: string; requestedBy?: string; folderId?: string; progress?: string; triggerMeta?: Record<string, any> } = {}) {
  const id = input.id || uid('RUN');
  const caseId = input.caseId || recording?.metadata?.caseId || '';
  const run = await Runs.upsert({
    ...scopeStamp(scope),
    id,
    name: `${input.name || recording?.name || 'Automation run'} - ${id}`,
    mode: 'automated',
    caseIds: caseId ? [caseId] : [],
    requestedBy: input.requestedBy || '',
    status: 'Running',
    progress: input.progress || 'Running on server',
    targetUrl: recording?.appUrl || '',
    folderId: input.folderId || '',
    triggerType: 'automation',
    triggerMeta: { automationJobId: job.id, agentId: job.agentId || '', automationExecution: { completed: 0, total: 0, percent: 5, phase: 'queued' }, ...(input.triggerMeta || {}) },
    startedAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
  });
  persist('automation run created');
  return run;
}

export async function cancelJob(jobId: string) {
  const job = await AutomationJobs.get(jobId);
  if (!job) return { error: 'Job not found.', status: 404 };
  if (['done', 'failed', 'cancelled'].includes(job.status)) return { ok: true };
  jobRunOptions.delete(jobId);
  if (job.agentId && isAgentConnected(job.agentId)) dispatchToAgent(job.agentId, { type: 'cancel', payload: { jobId } });
  else cancelServerJob(jobId); // server-side run (scheduled): kill the local playwright process
  await setStatus(jobId, 'cancelled', { finishedAt: new Date().toISOString() });
  await closeOpenPausesForJob(jobId);
  await syncLinkedRun(jobId, 'cancelled', {});
  if (job.agentId) await dispatchNextForAgent(job.agentId);
  return { ok: true };
}

export async function listJobs() { return AutomationJobs.list(); }
export async function getJob(id: string) {
  const job = await AutomationJobs.get(id);
  if (!job || !['done', 'failed', 'cancelled'].includes(job.status)) return job;
  const summary = finalizeExecutionProgress(job.summary || {}, job.status, String(job.error || ''), Date.parse(String(job.finishedAt || '')) || Date.now());
  if (summary === job.summary) return job;
  const repaired = await AutomationJobs.upsert({ ...job, summary });
  persist('terminal job progress repaired');
  return repaired;
}

/**
 * Reconcile jobs left in a non-terminal state by a previous process. Their agents' in-memory dispatch
 * state died with that process, so mark them failed rather than leaving the UI spinning forever.
 */
export async function recoverOrphanedJobs(): Promise<number> {
  const jobs = await AutomationJobs.list();
  let n = 0;
  for (const job of jobs) {
    if (['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(job.status) && !isAgentConnected(job.agentId)) {
      // Leave still-queued jobs for a connected agent alone; only fail ones that were mid-flight.
      if (job.status === 'queued') continue;
      if (job.status === 'awaiting_user') {
        const open = await AutomationJobPauses.listOpen(job.id);
        if (open.some((pause: any) => Date.parse(pause.expiresAt) > Date.now())) continue;
      }
      await setStatus(job.id, 'failed', { error: 'Interrupted by a server restart.', finishedAt: new Date().toISOString() });
      n++;
    }
  }
  return n;
}

/* ---------- wiring: flush queued jobs on (re)connect + result frame handlers ---------- */

onAgentConnected((agentId) => {
  void dispatchNextForAgent(agentId);
});

onAgentFrame('job.progress', async (_agentId, frame: AgentFrame) => {
  const { jobId, phase, ...detail } = frame.payload || {};
  if (!jobId) return;
  const status: JobStatus = phase === 'uploading' ? 'uploading' : 'running';
  const current = await AutomationJobs.get(jobId);
  const prior = current?.summary || {};
  const merged = mergeExecutionProgress(prior, detail);
  await setStatus(jobId, status, {
    ...(status === 'running' && !current?.startedAt ? { startedAt: new Date().toISOString() } : {}),
    summary: {
      ...merged,
      completed: detail.completed == null ? Number(prior.completed) || 0 : Number(detail.completed) || 0,
      total: detail.total == null ? Number(prior.total) || 0 : Number(detail.total) || 0,
      currentTest: detail.currentTest == null ? String(prior.currentTest || '') : String(detail.currentTest || ''),
      event: detail.event == null ? String(prior.event || '') : String(detail.event || ''),
    },
  });
});

onAgentFrame('job.paused', async (agentId, frame: AgentFrame) => {
  const pause = await recordPause(agentId, frame.payload);
  if (!pause) return;
  const job = await AutomationJobs.get(pause.jobId);
  const prior = job?.summary || {};
  await setStatus(pause.jobId, 'awaiting_user', {
    summary: { ...prior, pauseCount: (await AutomationJobPauses.listByJob(pause.jobId)).length, assisted: true },
  });
  await dispatchNextForAgent(agentId);
});

onAgentFrame('job.log', async (_agentId, frame: AgentFrame) => {
  const { jobId, line } = frame.payload || {};
  if (!jobId) return;
  const job = await AutomationJobs.get(jobId);
  if (!job) return;
  await emitEvent({ scopeType: 'job', scopeId: jobId, type: 'job.log', ownerId: job.ownerId, data: { line: String(line || '') } });
});

onAgentFrame('job.done', async (_agentId, frame: AgentFrame) => {
  const { jobId, exitCode, summary, error } = frame.payload || {};
  if (!jobId) return;
  const current = await AutomationJobs.get(jobId);
  if (current?.status === 'cancelled') return; // late process-exit frame must not turn a user stop into a failure
  const status: JobStatus = Number(exitCode) === 0 ? 'done' : 'failed';
  const finalSummary = { ...(current?.summary || {}), ...(summary || {}) };
  // setStatus finalizes (closes out any still-"Running" step) and persists the real summary — use ITS
  // return value, not the raw agent-reported `summary`, which has no accumulated executionSteps/caseSteps
  // at all (those only ever lived in the backend's merged job summary, built up over job.progress frames).
  const saved = await setStatus(jobId, status, { exitCode: Number(exitCode) || 0, summary: finalSummary, error: error || '', finishedAt: new Date().toISOString() });
  await closeOpenPausesForJob(jobId);
  await syncLinkedRun(jobId, status, saved?.summary || finalSummary);
  const job = await AutomationJobs.get(jobId);
  // Result gate: on a failed row in a stop-on-failure batch, cancel the rest so no more bad data is written.
  if (status === 'failed' && job?.batchId) await enforceStopOnFailure(job.batchId);
  if (job?.agentId) await dispatchNextForAgent(job.agentId);
});

/** Cancel a batch's still-pending rows once one has failed (only when the batch opted into stop-on-failure). */
async function enforceStopOnFailure(batchId: string): Promise<void> {
  const batch = await AutomationExecutionBatches.get(batchId);
  if (!batch?.stopOnFailure) return;
  const pending = (await AutomationJobs.list()).filter((job) => job.batchId === batchId && ['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(job.status));
  for (const job of pending) await cancelJob(job.id);
}

export async function syncLinkedRunProgress(jobId: string, phase: string, detail: any = {}) {
  const run = (await Runs.list()).find((r: any) => r.triggerMeta?.automationJobId === jobId);
  if (!run) return;
  const completed = Math.max(0, Number(detail.stepCompleted ?? detail.completed) || 0);
  const total = Math.max(0, Number(detail.stepTotal ?? detail.total) || 0);
  const event = String(detail.event || '');
  const percent = phase === 'awaiting_user'
    ? Number(run.triggerMeta?.automationExecution?.percent || 20)
    : automationProgressPercent(phase, completed, total, event);
  const currentTest = String(detail.stepTitle || detail.currentTest || '').trim();
  const label = phase === 'uploading'
    ? 'Uploading execution evidence'
      : phase === 'awaiting_user'
        ? 'Waiting for your input'
      : phase === 'dispatched'
      ? 'Starting on local agent'
      : phase === 'queued'
        ? 'Queued for execution'
        : event === 'step_started'
          ? `Step ${Math.min(completed + 1, total || completed + 1)} of ${total || '?'} · ${currentTest}`
          : `${completed}/${total || '?'} steps completed${currentTest ? ` · ${currentTest}` : ''}`;
  await Runs.upsert({
    ...run,
    progress: label,
    triggerMeta: { ...run.triggerMeta, automationExecution: { completed, total, percent, phase, currentTest } },
  });
  persist('automation run progress');
}

// A Test Run started via POST /api/automation/runs is linked to this job by trigger_meta. When the
// job finishes, mirror its real pass/fail/duration onto the run so the Test Runs list shows it.
export async function syncLinkedRun(jobId: string, status: JobStatus, summary: any) {
  const run = (await Runs.list()).find((r: any) => r.triggerMeta?.automationJobId === jobId);
  if (!run) return;
  const passed = Number(summary.passed || 0);
  const failed = Number(summary.failed || 0);
  const skipped = Number(summary.skipped || 0);
  const cancelled = status === 'cancelled';
  const runStatus = cancelled ? 'Cancelled' : `${failed > 0 || status === 'failed' ? 'Failed' : 'Passed'} — Pending Review`;
  const onlyCaseId = Array.isArray(run.caseIds) && run.caseIds.length === 1 ? run.caseIds[0] : '';
  // Persist the run's own QA-grade step record (Reports, exports, CSV all read run.steps directly, not
  // the live job summary) — the case's real authored action/expected text with the real per-step outcome,
  // not a collapsed one-row-per-Playwright-test() summary. Mirrors AutomatedRunWorkspace's live rendering
  // (applyExecutionProgress against summary.caseSteps/executionSteps) so both views agree.
  const caseForRun = onlyCaseId ? await Cases.get(onlyCaseId) : null;
  const authoredCaseSteps = caseForRun ? normalizeCaseSteps(caseForRun.steps) : [];
  const steps = authoredCaseSteps.length
    ? applyExecutionProgress(authoredCaseSteps, summary.executionSteps || [], summary.caseSteps || [])
      .map((step: any, index: number) => ({
        step: String(index + 1), action: step.action, expected: step.expected,
        testCaseId: onlyCaseId, testCaseTitle: caseForRun?.title || '',
        outcome: step.outcome || 'Not Run', durationMs: Number(step.durationMs) || 0,
        reason: step.outcome === 'Failed' ? String(step.error || '') : '', actual: step.outcome === 'Failed' ? String(step.error || '') : '',
      }))
    : Array.isArray(summary.tests) ? summary.tests.map((test: any, index: number) => ({
      step: String(index + 1), action: test.title || `Playwright test ${index + 1}`, testCaseId: onlyCaseId, testCaseTitle: caseForRun?.title || test.title || '',
      expected: 'Playwright script completes successfully.', outcome: /pass/i.test(String(test.status)) ? 'Passed' : /skip/i.test(String(test.status)) ? 'Skipped' : 'Failed',
      reason: test.error || '', actual: test.error || '', durationMs: Number(test.durationMs) || 0,
    })) : run.steps || [];
  await Runs.upsert({
    ...run,
    status: runStatus,
    state: cancelled ? 'Cancelled' : 'Pending Review',
    approvalState: cancelled ? '' : 'pending_review',
    passed,
    failed,
    totalExecutions: passed + failed + skipped,
    progress: cancelled ? 'Stopped by user' : `${passed} passed`,
    triggerMeta: {
      ...run.triggerMeta,
      automationExecution: { completed: passed + failed + skipped, total: passed + failed + skipped, percent: cancelled ? Number(run.triggerMeta?.automationExecution?.percent || 0) : 100, phase: status },
    },
    executionTime: summary.durationMs ? `${Math.round(Number(summary.durationMs) / 1000)}s` : run.executionTime,
    completedAt: new Date().toISOString(),
    steps,
  });
  persist('automation run synced');
}
