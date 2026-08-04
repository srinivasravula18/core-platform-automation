export function automationProgressPercent(phase: string, completed = 0, total = 0, event = ''): number {
  if (phase === 'queued') return 5;
  if (phase === 'dispatched') return 10;
  if (phase === 'uploading') return 90;
  if (phase === 'done' || phase === 'failed') return 100;
  if (phase !== 'running' && phase !== 'cancelled') return 0;
  const testProgress = total ? Math.round((Math.min(completed, total) / total) * 60) : 0;
  return Math.min(85, Math.max(event === 'test_started' || event === 'step_started' ? 25 : 20, 20 + testProgress));
}

export interface ExecutionStepProgress {
  id: string;
  index: number;
  title: string;
  status: 'Running' | 'Passed' | 'Failed' | 'Skipped';
  startedAt: number;
  durationMs: number;
  error?: string;
}

export function mergeExecutionProgress(prior: Record<string, any>, detail: Record<string, any>): Record<string, any> {
  const next = { ...prior, ...detail };
  if (detail.event !== 'step_started' && detail.event !== 'step_finished') return next;
  const id = String(detail.stepId || `step-${detail.stepIndex || 0}`);
  const steps: ExecutionStepProgress[] = Array.isArray(prior.executionSteps) ? prior.executionSteps.map((step: any) => ({ ...step })) : [];
  const existing = steps.findIndex((step) => step.id === id);
  const failed = Boolean(detail.stepError);
  const step: ExecutionStepProgress = {
    ...(existing >= 0 ? steps[existing] : {} as ExecutionStepProgress),
    id,
    index: Number(detail.stepIndex) || existing + 1,
    title: String(detail.stepTitle || (existing >= 0 ? steps[existing].title : '') || `Step ${Number(detail.stepIndex) || steps.length + 1}`),
    status: detail.event === 'step_started' ? 'Running' : failed ? 'Failed' : 'Passed',
    startedAt: Number(detail.stepStartedAt) || (existing >= 0 ? steps[existing].startedAt : Date.now()),
    durationMs: detail.event === 'step_finished' ? Math.max(0, Number(detail.stepDurationMs) || 0) : 0,
    ...(failed ? { error: String(detail.stepError) } : {}),
  };
  if (existing >= 0) steps[existing] = step; else steps.push(step);
  next.executionSteps = steps.sort((a, b) => a.index - b.index);
  return next;
}

export function finalizeExecutionProgress(
  prior: Record<string, any>,
  phase: 'done' | 'failed' | 'cancelled',
  error = '',
  finishedAt = Date.now(),
): Record<string, any> {
  if (!Array.isArray(prior.executionSteps) || !prior.executionSteps.some((step: any) => step.status === 'Running')) return prior;
  const status: ExecutionStepProgress['status'] = phase === 'done' ? 'Passed' : phase === 'failed' ? 'Failed' : 'Skipped';
  return {
    ...prior,
    executionSteps: prior.executionSteps.map((step: ExecutionStepProgress) => step.status !== 'Running' ? step : {
      ...step,
      status,
      durationMs: Math.max(Number(step.durationMs) || 0, finishedAt - Number(step.startedAt || finishedAt)),
      ...(status === 'Failed' && error && !step.error ? { error } : {}),
    }),
  };
}
