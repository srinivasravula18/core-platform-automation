import { caseBelongsToSuite, casePlanIds, caseSuiteIds, suiteParentIds, suitePlanIds } from './suiteCaseSelection';
import { normalizeTags } from './tags';

export async function readAutomationRunResponse(response: Response): Promise<any> {
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* proxy/server returned HTML or text */ }
  if (data && response.ok) return data;
  if (data?.error) throw new Error(data.error);
  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    const message = response.status >= 500
      ? `Automation service is temporarily unavailable (HTTP ${response.status}). Try again after the server finishes restarting.`
      : `Automation API returned HTML instead of JSON (HTTP ${response.status}). The backend route is unavailable.`;
    throw new Error(message);
  }
  throw new Error(text.trim().slice(0, 200) || `Could not start the automation run (HTTP ${response.status}).`);
}

export function runTagsForCases(cases: any[], caseIds: string[]): string[] {
  const selected = new Set(caseIds.map(String));
  return normalizeTags(cases.filter((testCase) => selected.has(String(testCase.id))).flatMap((testCase) => Array.isArray(testCase.tags) ? testCase.tags : []));
}

export function allCasesHaveRunTags(cases: any[], caseIds: string[]): boolean {
  const selected = new Set(caseIds.map(String));
  const matched = cases.filter((testCase) => selected.has(String(testCase.id)));
  return matched.length === selected.size && matched.every((testCase) => normalizeTags(Array.isArray(testCase.tags) ? testCase.tags : []).length > 0);
}

export function casesForPlan(cases: any[], suites: any[], planId: string): any[] {
  if (!planId) return cases;
  const suiteIds = new Set(suites.filter((suite) => suitePlanIds(suite).includes(planId)).map((suite) => suite.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const suite of suites) {
      if (!suiteIds.has(suite.id) && suiteParentIds(suite).some((id) => suiteIds.has(id))) {
        suiteIds.add(suite.id);
        changed = true;
      }
    }
  }
  return cases.filter((testCase) =>
    casePlanIds(testCase).includes(planId) || caseSuiteIds(testCase).some((id) => suiteIds.has(id)),
  );
}

export function scriptsForCases(cases: any[], scripts: any[]): any[] {
  const selected = new Map<string, any>();
  for (const testCase of cases) {
    const runId = String(testCase.agentRunId || testCase.sourceRunId || '');
    const title = String(testCase.title || '').trim().toLowerCase();
    const candidates = runId
      ? scripts.filter((script) => String(script.agentRunId || script.sourceRunId || '') === runId)
      : scripts;
    const script = scripts.find((item) => item.caseId === testCase.id)
      || (title ? candidates.find((item) => [item.title, item.test_case_title].some((value) => String(value || '').trim().toLowerCase() === title)) : null)
      || (runId && candidates.length === 1 ? candidates[0] : null);
    if (script?.code) selected.set(script.id || script.filename || `${runId}:${title}`, script);
  }
  return [...selected.values()];
}

export function runnableCases(cases: any[], scripts: any[]): any[] {
  return cases.filter((testCase) => scriptsForCases([testCase], scripts).length > 0);
}

export function casesForRun(run: any, cases: any[], suites: any[], plans: any[] = []): any[] {
  const linkedPlanIds = plans
    .filter((plan) => Array.isArray(plan?.runIds) && plan.runIds.map(String).includes(String(run?.id)))
    .map((plan) => String(plan.id));
  if ((Array.isArray(run?.caseIds) && run.caseIds.length) || linkedPlanIds.length) {
    const ids = new Set((Array.isArray(run?.caseIds) ? run.caseIds : []).map(String));
    linkedPlanIds.forEach((planId) => casesForPlan(cases, suites, planId).forEach((testCase) => ids.add(String(testCase.id))));
    return cases.filter((testCase) => ids.has(String(testCase.id)));
  }
  if (Array.isArray(run?.suiteIds) && run.suiteIds.length) {
    const ids = new Set(run.suiteIds);
    return cases.filter((testCase) => caseSuiteIds(testCase).some((id) => ids.has(id)));
  }
  const planIds = Array.isArray(run?.planIds) && run.planIds.length
    ? run.planIds
    : (run?.testPlanId ? [run.testPlanId] : []);
  if (planIds.length) {
    const ids = new Set(planIds.flatMap((planId: string) => casesForPlan(cases, suites, planId).map((testCase) => testCase.id)));
    return cases.filter((testCase) => ids.has(testCase.id));
  }
  const suite = suites.find((item) => item.name === run?.suiteName || item.id === run?.suiteId);
  const suiteCases = suite ? cases.filter((testCase) => caseBelongsToSuite(testCase, suite.id)) : [];
  if (suiteCases.length) return suiteCases;
  return run?.agentRunId ? cases.filter((testCase) => testCase.agentRunId === run.agentRunId) : [];
}

export function scriptsForRun(run: any, cases: any[], scripts: any[]): any[] {
  const linked = scriptsForCases(cases, scripts);
  if (linked.length) return linked;
  const sourceRunId = String(run?.sourceRunId || run?.agentRunId || '');
  return sourceRunId
    ? scripts.filter((script) => String(script.agentRunId || script.sourceRunId || '') === sourceRunId && script.code)
    : [];
}

export function manualRunSelection(planId: string, caseIds: string[]) {
  return {
    caseIds,
    planIds: caseIds.length || !planId ? [] : [planId],
  };
}

export function runExecutionState(run: any) {
  const running = /^(running|in progress)$/i.test(String(run?.status || ''));
  const execution = run?.triggerMeta?.manualExecution || {};
  const total = Math.max(0, Number(execution.total ?? run?.executionTotal) || 0);
  const completed = Math.min(total, Math.max(0, Number(execution.completed ?? run?.executionCompleted) || 0));
  return {
    running,
    total,
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    label: running ? String(run?.progress || `Running ${total || ''} scripts`).trim() : '',
  };
}

export function getRunStats(run: any, caseCount?: number) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const storedTotal = Number(run?.totalExecutions) || 0;
  const total = caseCount || storedTotal || steps.length || 0;
  const hasLegacyStepTotal = Boolean(caseCount && storedTotal > caseCount);
  const caseOutcomes = new Map<string, string>();
  if (hasLegacyStepTotal) {
    steps.forEach((step: any, index: number) => {
      const caseKey = String(step?.testCaseId || step?.testCaseTitle || String(step?.step || '').match(/^(\d+)\./)?.[1] || index);
      const outcome = String(step?.outcome || step?.status || '');
      const previous = caseOutcomes.get(caseKey) || '';
      if (/fail/i.test(outcome) || !previous) caseOutcomes.set(caseKey, outcome);
    });
  }
  const outcomes = hasLegacyStepTotal ? [...caseOutcomes.values()] : steps.map((step: any) => String(step?.outcome || step?.status || ''));
  const storedCount = (key: 'passed' | 'failed') => {
    const value = run?.[key];
    return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const passed = hasLegacyStepTotal ? outcomes.filter((outcome) => /pass/i.test(outcome)).length : storedCount('passed') ?? outcomes.filter((outcome) => /pass/i.test(outcome)).length;
  const failed = hasLegacyStepTotal ? outcomes.filter((outcome) => /fail/i.test(outcome)).length : storedCount('failed') ?? outcomes.filter((outcome) => /fail/i.test(outcome)).length;
  const blocked = outcomes.filter((outcome) => /block/i.test(outcome)).length;
  const skipped = outcomes.filter((outcome) => /skip/i.test(outcome)).length;
  const retest = outcomes.filter((outcome) => /retest/i.test(outcome)).length;
  const untested = Math.max(0, total - passed - failed - blocked - skipped - retest);
  const completed = total ? Math.round(((passed + failed + blocked + skipped + retest) / total) * 100) : 0;
  return { total, passed, failed, blocked, skipped, retest, untested, completed };
}
