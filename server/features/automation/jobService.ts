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

import { AutomationJobs, Recordings } from '../../db/repository';
import { uid, isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import type { Scope } from '../../shared/scope';
import { scopeStamp } from '../../shared/scope';
import { emitEvent } from './eventsService';
import { onAgentFrame, onAgentConnected, dispatchToAgent, isAgentConnected } from './agentGateway';
import type { AgentFrame, JobStatus, JobTrigger } from './types';

function persist(reason: string) {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

async function setStatus(jobId: string, status: JobStatus, patch: Record<string, any> = {}) {
  const job = await AutomationJobs.get(jobId);
  if (!job) return null;
  const saved = await AutomationJobs.upsert({ ...job, status, ...patch });
  persist('job status');
  await emitEvent({ scopeType: 'job', scopeId: jobId, type: `job.${status}`, ownerId: job.ownerId, data: { job: saved } });
  return saved;
}

/** Push a queued job to its agent if connected; returns true if dispatched. */
async function tryDispatch(jobId: string): Promise<boolean> {
  const job = await AutomationJobs.get(jobId);
  if (!job || job.status !== 'queued') return false;
  if (!job.agentId || !isAgentConnected(job.agentId)) return false;
  const rec = job.recordingId ? await Recordings.get(job.recordingId) : null;
  const ok = dispatchToAgent(job.agentId, {
    type: 'job.dispatch',
    payload: {
      jobId: job.id,
      recordingId: job.recordingId,
      script: rec?.script || '',
      browser: rec?.browser || 'chromium',
      environment: rec?.environment || 'QA',
      appUrl: rec?.appUrl || '',
    },
  });
  if (ok) await setStatus(jobId, 'dispatched');
  return ok;
}

export async function createJob(input: { recordingId: string; agentId: string; trigger?: JobTrigger; scheduleId?: string }, scope: Scope) {
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
    ...scopeStamp(scope),
  };
  const saved = await AutomationJobs.upsert(job);
  persist('job created');
  await emitEvent({ scopeType: 'job', scopeId: saved.id, type: 'job.queued', ownerId: job.ownerId || '', data: { job: saved } });
  await tryDispatch(saved.id);
  return saved;
}

export async function cancelJob(jobId: string) {
  const job = await AutomationJobs.get(jobId);
  if (!job) return { error: 'Job not found.', status: 404 };
  if (['done', 'failed', 'cancelled'].includes(job.status)) return { ok: true };
  if (job.agentId && isAgentConnected(job.agentId)) dispatchToAgent(job.agentId, { type: 'cancel', payload: { jobId } });
  await setStatus(jobId, 'cancelled', { finishedAt: new Date().toISOString() });
  return { ok: true };
}

export async function listJobs() { return AutomationJobs.list(); }
export async function getJob(id: string) { return AutomationJobs.get(id); }

/**
 * Reconcile jobs left in a non-terminal state by a previous process. Their agents' in-memory dispatch
 * state died with that process, so mark them failed rather than leaving the UI spinning forever.
 */
export async function recoverOrphanedJobs(): Promise<number> {
  const jobs = await AutomationJobs.list();
  let n = 0;
  for (const job of jobs) {
    if (['queued', 'dispatched', 'running', 'uploading'].includes(job.status) && !isAgentConnected(job.agentId)) {
      // Leave still-queued jobs for a connected agent alone; only fail ones that were mid-flight.
      if (job.status === 'queued') continue;
      await setStatus(job.id, 'failed', { error: 'Interrupted by a server restart.', finishedAt: new Date().toISOString() });
      n++;
    }
  }
  return n;
}

/* ---------- wiring: flush queued jobs on (re)connect + result frame handlers ---------- */

onAgentConnected((agentId) => {
  void (async () => {
    const jobs = await AutomationJobs.list();
    for (const job of jobs) {
      if (job.agentId === agentId && job.status === 'queued') await tryDispatch(job.id);
    }
  })();
});

onAgentFrame('job.progress', async (_agentId, frame: AgentFrame) => {
  const { jobId, phase } = frame.payload || {};
  if (!jobId) return;
  const status: JobStatus = phase === 'uploading' ? 'uploading' : 'running';
  await setStatus(jobId, status, status === 'running' ? { startedAt: new Date().toISOString() } : {});
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
  const status: JobStatus = Number(exitCode) === 0 ? 'done' : 'failed';
  await setStatus(jobId, status, { exitCode: Number(exitCode) || 0, summary: summary || {}, error: error || '', finishedAt: new Date().toISOString() });
});
