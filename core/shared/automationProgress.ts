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

/** A compiler-emitted test.step() boundary — `id` is the real authored-step id (case:N / step:N), not
 * a synthetic per-event id like ExecutionStepProgress.id, so it can be matched directly, not positionally. */
export interface CaseStepProgress {
  id: string;
  title: string;
  status: 'Running' | 'Passed' | 'Failed' | 'Skipped';
  startedAt: number;
  durationMs: number;
  error?: string;
}

/**
 * Matches authored steps to real execution outcomes by id when available (case:N from the deterministic
 * planner, or step:N from the universal compiler fallback — see testPlan.ts stampStepIds), falling back
 * to positional matching against the raw action stream only when no `caseSteps` data exists at all (a
 * hand-edited/recorded script never passes through the compiler, so it has no test.step() ids to report).
 */
/** Combines every matched raw step a humanized authored step groups (humanizeSteps.ts sourceStepIds)
 *  into one outcome: any failure wins, else any still-running, else passed only once all are done. */
function aggregateCaseSteps(matched: CaseStepProgress[]): { status: CaseStepProgress['status']; durationMs: number; error: string } {
  const status = matched.some((m) => m.status === 'Failed') ? 'Failed'
    : matched.some((m) => m.status === 'Running') ? 'Running'
    : matched.every((m) => m.status === 'Passed') ? 'Passed'
    : 'Skipped';
  return {
    status,
    durationMs: matched.reduce((sum, m) => sum + (m.durationMs || 0), 0),
    error: matched.find((m) => m.status === 'Failed')?.error || '',
  };
}

export function applyExecutionProgress<T extends Record<string, any>>(
  authoredSteps: T[],
  executionSteps: ExecutionStepProgress[],
  caseSteps: CaseStepProgress[] = [],
): T[] {
  if (caseSteps.length) {
    const byId = new Map(caseSteps.map((step) => [step.id, step]));
    return authoredSteps.map((step, index) => {
      const sourceIds: string[] | undefined = (step as any).sourceStepIds;
      if (sourceIds?.length) {
        const matched = sourceIds.map((id) => byId.get(id)).filter((m): m is CaseStepProgress => !!m);
        if (!matched.length) return step;
        const agg = aggregateCaseSteps(matched);
        return { ...step, outcome: agg.status, durationMs: agg.durationMs, ...(agg.error ? { error: agg.error } : {}) };
      }
      const matched = byId.get(String((step as any).id || '')) ?? byId.get(`case:${index}`) ?? byId.get(`step:${index}`);
      return matched ? { ...step, outcome: matched.status, durationMs: matched.durationMs, ...(matched.error ? { error: matched.error } : {}) } : step;
    });
  }
  const executedByIndex = new Map(executionSteps.map((step) => [step.index - 1, step]));
  return authoredSteps.map((step, index) => {
    const executed = executedByIndex.get(index);
    return executed ? { ...step, outcome: executed.status, durationMs: executed.durationMs } : step;
  });
}

function mergeCaseStepProgress(prior: Record<string, any>, detail: Record<string, any>): Record<string, any> {
  const next = { ...prior, ...detail };
  const id = String(detail.caseStepId || '');
  if (!id) return next;
  const steps: CaseStepProgress[] = Array.isArray(prior.caseSteps) ? prior.caseSteps.map((step: any) => ({ ...step })) : [];
  const existing = steps.findIndex((step) => step.id === id);
  const failed = Boolean(detail.caseStepError);
  const step: CaseStepProgress = {
    ...(existing >= 0 ? steps[existing] : {} as CaseStepProgress),
    id,
    title: String(detail.caseStepTitle || (existing >= 0 ? steps[existing].title : '') || id),
    status: detail.event === 'case_step_started' ? 'Running' : failed ? 'Failed' : 'Passed',
    startedAt: Number(detail.caseStepStartedAt) || (existing >= 0 ? steps[existing].startedAt : Date.now()),
    durationMs: detail.event === 'case_step_finished' ? Math.max(0, Number(detail.caseStepDurationMs) || 0) : 0,
    ...(failed ? { error: String(detail.caseStepError) } : {}),
  };
  if (existing >= 0) steps[existing] = step; else steps.push(step);
  next.caseSteps = steps;
  return next;
}

export function mergeExecutionProgress(prior: Record<string, any>, detail: Record<string, any>): Record<string, any> {
  if (detail.event === 'case_step_started' || detail.event === 'case_step_finished') return mergeCaseStepProgress(prior, detail);
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
  const hasRunningSteps = Array.isArray(prior.executionSteps) && prior.executionSteps.some((step: any) => step.status === 'Running');
  const hasRunningCaseSteps = Array.isArray(prior.caseSteps) && prior.caseSteps.some((step: any) => step.status === 'Running');
  if (!hasRunningSteps && !hasRunningCaseSteps) return prior;
  const status: ExecutionStepProgress['status'] = phase === 'done' ? 'Passed' : phase === 'failed' ? 'Failed' : 'Skipped';
  const closeOut = (step: { status: string; durationMs: number; startedAt: number; error?: string }) => step.status !== 'Running' ? step : {
    ...step,
    status,
    durationMs: Math.max(Number(step.durationMs) || 0, finishedAt - Number(step.startedAt || finishedAt)),
    ...(status === 'Failed' && error && !step.error ? { error } : {}),
  };
  return {
    ...prior,
    ...(hasRunningSteps ? { executionSteps: prior.executionSteps.map(closeOut) } : {}),
    ...(hasRunningCaseSteps ? { caseSteps: prior.caseSteps.map(closeOut) } : {}),
  };
}
