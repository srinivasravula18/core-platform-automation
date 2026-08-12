import { AutomationJobs, AutomationScheduleExecutions, AutomationScheduleItems, Recordings, Scripts } from '../../db/repository';
import type { Scope } from '../../shared/scope';
import { createLinkedTestRun, createServerJob, setJobStatus } from './jobService';
import { runJobOnServer } from './serverRunner';

const activePumps = new Set<string>();
const terminal = new Set(['done', 'failed', 'cancelled']);

function summaryFor(jobs: any[]) {
  const count = (status: string) => jobs.filter((job) => job.status === status).length;
  return { total: jobs.length, queued: count('queued'), running: jobs.filter((job) => !terminal.has(job.status)).length - count('queued'), passed: count('done'), failed: count('failed'), cancelled: count('cancelled') };
}

async function refresh(executionId: string) {
  const execution = await AutomationScheduleExecutions.get(executionId);
  if (!execution) return null;
  const jobs = (await AutomationJobs.list()).filter((job) => job.scheduleExecutionId === executionId);
  const summary = summaryFor(jobs);
  const finished = jobs.length > 0 && summary.passed + summary.failed + summary.cancelled === jobs.length;
  const status = finished ? (summary.failed ? 'failed' : summary.cancelled === jobs.length ? 'cancelled' : 'done') : jobs.some((job) => job.status !== 'queued') ? 'running' : 'queued';
  return AutomationScheduleExecutions.upsert({ ...execution, status, summary, startedAt: execution.startedAt || (status === 'running' ? new Date().toISOString() : null), finishedAt: finished ? execution.finishedAt || new Date().toISOString() : null });
}

async function cancelPending(executionId: string) {
  for (const job of await AutomationJobs.list()) {
    if (job.scheduleExecutionId === executionId && job.status === 'queued') await setJobStatus(job.id, 'cancelled', { finishedAt: new Date().toISOString(), error: 'Skipped because an earlier scheduled stage failed.' });
  }
}

async function run(job: any) {
  try { await runJobOnServer(job.id); }
  catch (error: any) { await setJobStatus(job.id, 'failed', { error: error?.message || 'Scheduled execution failed.', finishedAt: new Date().toISOString() }); }
}

export async function pumpScheduleExecution(executionId: string): Promise<void> {
  if (activePumps.has(executionId)) return;
  activePumps.add(executionId);
  try {
    const execution = await AutomationScheduleExecutions.get(executionId);
    if (!execution || terminal.has(execution.status)) return;
    const jobs = () => AutomationJobs.list().then((rows) => rows.filter((job) => job.scheduleExecutionId === executionId).sort((a, b) => Number(a.stageNo || 1) - Number(b.stageNo || 1) || Number(a.position || 0) - Number(b.position || 0)));
    if (execution.executionMode === 'sequential') {
      while (true) {
        const rows = await jobs();
        const next = rows.find((job) => job.status === 'queued');
        if (!next) break;
        const earlierFailed = rows.some((job) => Number(job.position || 0) < Number(next.position || 0) && job.status === 'failed');
        if (earlierFailed && execution.failurePolicy === 'stop') { await cancelPending(executionId); break; }
        await run(next);
        if ((await AutomationJobs.get(next.id))?.status === 'failed' && execution.failurePolicy === 'stop') { await cancelPending(executionId); break; }
      }
    } else {
      const limit = Math.max(1, Number(execution.maxConcurrency) || 3);
      while (true) {
        const queued = (await jobs()).filter((job) => job.status === 'queued');
        if (!queued.length) break;
        await Promise.all(queued.slice(0, limit).map(run));
      }
    }
    await refresh(executionId);
  } finally {
    activePumps.delete(executionId);
  }
}

export async function startScheduleExecution(schedule: any, scheduledFor: string, scope: Scope): Promise<{ execution: any; created: boolean }> {
  const created = await AutomationScheduleExecutions.createOrGet({
    scheduleId: schedule.id, scheduledFor, executionMode: schedule.executionMode || 'parallel', failurePolicy: schedule.failurePolicy || 'continue', maxConcurrency: Math.max(1, Number(schedule.maxConcurrency) || 3),
  });
  if (!created.created) return created;
  const configured = await AutomationScheduleItems.listForSchedule(schedule.id);
  const items = configured.length ? configured : [{ id: `legacy:${schedule.id}`, stageNo: 1, position: 1, runnableType: 'recording', runnableId: schedule.recordingId, recordingId: schedule.recordingId, enabled: true }];
  for (const item of items.filter((entry: any) => entry.enabled !== false)) {
    // Load the backing recording for BOTH runnable kinds: a script item is resolved to a recording at
    // schedule time, and that recording carries the test-case link. Skipping it for scripts left the
    // scheduled Test Run with no caseIds, which is why Test Runs showed no executed cases.
    const recording = item.recordingId ? await Recordings.get(item.recordingId) : null;
    const script = item.runnableType === 'script'
      ? await Scripts.get(item.runnableId)
      : null;
    const recordingId = recording?.id || item.recordingId;
    const source = String(script?.code || recording?.script || '').trim();
    const job = await createServerJob({ recordingId, scheduleId: schedule.id, trigger: 'schedule', script: source, scheduleExecutionId: created.execution.id, scheduleItemId: item.id, stageNo: item.stageNo, position: item.position }, scope);
    const caseId = String(script?.caseId || recording?.metadata?.caseId || '');
    await createLinkedTestRun(job, recording || { name: script?.name || item.runnableId, appUrl: script?.targetUrl || '', metadata: { caseId } }, scope, {
      name: script?.name || recording?.name || item.runnableId || 'Scheduled test', caseId,
      triggerMeta: { scheduleId: schedule.id, scheduleTitle: schedule.title || '', scheduleExecutionId: created.execution.id, scheduleItemId: item.id, stageNo: item.stageNo, position: item.position },
    });
  }
  void pumpScheduleExecution(created.execution.id);
  return created;
}

export async function resumeScheduleExecutions(): Promise<void> {
  for (const execution of await AutomationScheduleExecutions.listActive()) void pumpScheduleExecution(execution.id);
}
