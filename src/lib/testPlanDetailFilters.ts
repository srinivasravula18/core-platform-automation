import { casePlanIds, caseSuiteIds } from './suiteCaseSelection';

export type TestPlanCaseFilters = {
  folderIds: string[];
  runIds: string[];
  suiteIds: string[];
  subPlanIds: string[];
  resultStatuses: string[];
  states: string[];
  priorities: string[];
};

export const emptyTestPlanCaseFilters = (): TestPlanCaseFilters => ({
  folderIds: [],
  runIds: [],
  suiteIds: [],
  subPlanIds: [],
  resultStatuses: [],
  states: [],
  priorities: [],
});

export function runsForTestCase(testCase: any, runs: any[], planId: string): any[] {
  return runs.filter((run) => {
    const caseIds = Array.isArray(run.caseIds) ? run.caseIds.map(String) : [];
    return caseIds.includes(String(testCase.id)) || (!caseIds.length && run.testPlanId === planId);
  });
}

export function resultStatusesForTestCase(testCase: any, runs: any[], planId: string): string[] {
  const statuses = new Set<string>();
  for (const run of runsForTestCase(testCase, runs, planId)) {
    const records = [run.testResults, run.tests, run.results, run.steps].flatMap((value) => Array.isArray(value) ? value : []);
    const matchingRecords = records.filter((record: any) =>
      String(record.caseId || record.testCaseId || '') === String(testCase.id),
    );
    for (const record of matchingRecords) {
      const status = String(record.status || record.outcome || record.state || '').trim();
      if (status) statuses.add(status);
    }
    if (!matchingRecords.length) {
      const status = String(run.resultStatus || run.status || run.state || '').trim();
      if (status) statuses.add(status);
    }
  }
  return [...statuses];
}

export function matchesTestPlanCaseFilters(
  testCase: any,
  planId: string,
  runs: any[],
  suites: any[],
  filters: TestPlanCaseFilters,
): boolean {
  const suiteIds = caseSuiteIds(testCase);
  const folderIds = new Set([
    String(testCase.folderId || ''),
    ...suites.filter((suite) => suiteIds.includes(String(suite.id))).map((suite) => String(suite.folderId || '')),
  ]);
  const runIds = runsForTestCase(testCase, runs, planId).map((run) => String(run.id));
  const subPlanIds = casePlanIds(testCase).filter((id) => id !== planId);
  const resultStatuses = resultStatusesForTestCase(testCase, runs, planId);
  const state = String(testCase.state || testCase.status || 'Draft');
  const priority = String(testCase.priority || 'Medium');

  return (!filters.folderIds.length || filters.folderIds.some((id) => folderIds.has(id)))
    && (!filters.runIds.length || filters.runIds.some((id) => runIds.includes(id)))
    && (!filters.suiteIds.length || filters.suiteIds.some((id) => suiteIds.includes(id)))
    && (!filters.subPlanIds.length || filters.subPlanIds.some((id) => subPlanIds.includes(id)))
    && (!filters.resultStatuses.length || filters.resultStatuses.some((status) => resultStatuses.includes(status)))
    && (!filters.states.length || filters.states.includes(state))
    && (!filters.priorities.length || filters.priorities.includes(priority));
}
