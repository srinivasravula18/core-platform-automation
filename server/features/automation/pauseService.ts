import { AutomationJobPauses, AutomationJobs } from '../../db/repository';
import { uid, isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { normalizePauseRequest, type PauseAnswer, type PauseOutcome } from '../../../core/shared/pause';
import { dispatchToAgent } from './agentGateway';
import { emitEvent } from './eventsService';
import { isPauseResumeEnabled } from './flag';

type LocalResolver = (answer: PauseAnswer) => boolean;
const localResolvers = new Map<string, LocalResolver>();

function persist(reason: string): void {
  if (!isPostgresEnabled()) persistDataInBackground(reason);
}

export function registerLocalPauseResolver(jobId: string, resolver: LocalResolver): () => void {
  localResolvers.set(jobId, resolver);
  return () => localResolvers.delete(jobId);
}

export async function recordPause(agentId: string, payload: any): Promise<any | null> {
  if (!isPauseResumeEnabled()) return null;
  const jobId = String(payload?.jobId || '');
  const job = jobId ? await AutomationJobs.get(jobId) : null;
  if (!job || (job.agentId && job.agentId !== agentId)) return null;
  const request = normalizePauseRequest(payload.request || {});
  const attempt = Math.max(1, Number(payload.attempt) || 1);
  const existing = await AutomationJobPauses.getAttempt(jobId, request.id, attempt);
  if (existing) return existing;
  const openedAt = validDate(payload.openedAt) || new Date().toISOString();
  const expiresAt = validDate(payload.expiresAt) || new Date(Date.parse(openedAt) + request.timeoutMs).toISOString();
  const pause = await AutomationJobPauses.upsert({
    id: uid('PAUSE'), jobId, pauseId: request.id, attempt, kind: request.kind, prompt: request.prompt,
    hint: request.hint || '', masked: request.masked, requiresHeaded: request.requiresHeaded,
    timeoutMs: request.timeoutMs, onTimeout: request.onTimeout, outcome: 'open', openedAt, expiresAt,
    projectId: job.projectId, appId: job.appId, ownerId: job.ownerId,
  });
  persist('job pause opened');
  await emitEvent({ scopeType: 'job', scopeId: jobId, type: 'job.paused', ownerId: job.ownerId, data: { pause } });
  return pause;
}

export async function listJobPauses(jobId: string): Promise<any[]> {
  return AutomationJobPauses.listByJob(jobId);
}

export async function resolvePause(
  jobId: string,
  pauseId: string,
  input: { attempt?: number; outcome: 'resolved' | 'skipped'; value?: unknown },
  resolvedBy: string,
): Promise<{ pause?: any; error?: string; status?: number }> {
  const open = (await AutomationJobPauses.listOpen(jobId))
    .filter((pause) => pause.pauseId === pauseId && (!input.attempt || pause.attempt === input.attempt))
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (!open) return { error: 'Open pause not found.', status: 404 };
  if (Date.parse(open.expiresAt) <= Date.now()) {
    await finishPause(open, 'expired', 'timeout');
    return { error: 'Pause has expired.', status: 410 };
  }
  const value = input.value == null ? undefined : String(input.value);
  if (open.kind === 'input' && input.outcome === 'resolved' && value == null) return { error: 'value is required for an input pause.', status: 400 };
  const job = await AutomationJobs.get(jobId);
  if (!job) return { error: 'Job not found.', status: 404 };
  const answer: PauseAnswer = { pauseId, attempt: open.attempt, outcome: input.outcome, ...(value != null ? { value } : {}), resolvedBy };
  const delivered = job.agentId
    ? dispatchToAgent(job.agentId, { type: 'pause.resume', payload: { jobId, ...answer } })
    : localResolvers.get(jobId)?.(answer) === true;
  if (!delivered) return { error: 'The runner is not connected.', status: 409 };
  const pause = await finishPause(open, input.outcome, resolvedBy, value?.length);
  await emitEvent({ scopeType: 'job', scopeId: jobId, type: 'job.resumed', ownerId: job.ownerId, data: { pause } });
  return { pause };
}

export async function closeOpenPausesForJob(jobId: string, outcome: Exclude<PauseOutcome, 'resolved' | 'skipped'> = 'aborted'): Promise<void> {
  for (const pause of await AutomationJobPauses.listOpen(jobId)) {
    const finalOutcome = Date.parse(pause.expiresAt) <= Date.now() ? 'expired' : outcome;
    await finishPause(pause, finalOutcome, finalOutcome === 'expired' ? 'timeout' : 'runner');
  }
}

async function finishPause(pause: any, outcome: PauseOutcome, resolvedBy: string, valueLength?: number): Promise<any> {
  const saved = await AutomationJobPauses.upsert({
    ...pause, outcome, resolvedAt: new Date().toISOString(), resolvedBy,
    ...(typeof valueLength === 'number' ? { valueLength } : {}),
  });
  persist('job pause resolved');
  return saved;
}

function validDate(value: unknown): string | null {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
