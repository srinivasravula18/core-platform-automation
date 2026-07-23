import { caseBelongsToSuite, caseSuiteIds, suiteParentIds, suitePlanIds } from './suiteCaseSelection';

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
    testCase.testPlanId === planId || caseSuiteIds(testCase).some((id) => suiteIds.has(id)),
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
      || candidates.find((item) => [item.title, item.test_case_title].some((value) => String(value || '').trim().toLowerCase() === title))
      || (runId && candidates.length === 1 ? candidates[0] : null);
    if (script?.code) selected.set(script.id || script.filename || `${runId}:${title}`, script);
  }
  return [...selected.values()];
}

export function casesForRun(run: any, cases: any[], suites: any[]): any[] {
  if (Array.isArray(run?.caseIds) && run.caseIds.length) {
    const ids = new Set(run.caseIds);
    return cases.filter((testCase) => ids.has(testCase.id));
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

export function executionRunUpdate(result: any) {
  const tests = Array.isArray(result?.tests) ? result.tests : [];
  return {
    status: result?.ok ? 'Completed' : 'Failed',
    state: result?.ok ? 'Completed' : 'Blocked',
    totalExecutions: Number(result?.total) || tests.length,
    passed: Number(result?.passed) || 0,
    failed: Number(result?.failed) || 0,
    progress: `${Number(result?.passed) || 0} passed`,
    executionTime: result?.durationMs ? `${Math.round(Number(result.durationMs) / 1000)}s` : '',
    completedAt: new Date().toISOString(),
    evidence: Array.isArray(result?.screenshotUrls) ? result.screenshotUrls : [],
    steps: tests.map((test: any, index: number) => ({
      step: String(index + 1),
      action: test.title || `Playwright test ${index + 1}`,
      expected: 'Playwright script completes successfully.',
      outcome: /pass/i.test(test.status || '') ? 'Passed' : /skip/i.test(test.status || '') ? 'Skipped' : 'Failed',
      reason: test.error || '',
      screenshot: result?.screenshotUrls?.[index] || '',
    })),
  };
}
