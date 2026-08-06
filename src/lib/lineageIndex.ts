/** Reverse-lookup maps (case↔suite↔plan↔run) built once per fetch from the already-loaded arrays. */
export type LineageIndex = {
  caseSuites: Map<string, string[]>;
  casePlans: Map<string, string[]>;
  caseRuns: Map<string, string[]>;
  suitePlans: Map<string, string[]>;
  suiteCases: Map<string, string[]>;
  suiteRuns: Map<string, string[]>;
  planSuites: Map<string, string[]>;
  planCases: Map<string, string[]>;
  planRuns: Map<string, string[]>;
};

function addTo(map: Map<string, string[]>, key: string, value: string) {
  if (!key || !value) return;
  const list = map.get(key);
  if (list) { if (!list.includes(value)) list.push(value); }
  else map.set(key, [value]);
}

function idsOf(entity: any, pluralKey: string, singularKey: string): string[] {
  const plural = Array.isArray(entity?.[pluralKey]) ? entity[pluralKey].map(String).filter(Boolean) : [];
  if (plural.length) return plural;
  const singular = entity?.[singularKey];
  return singular ? [String(singular)] : [];
}

export function buildLineageIndex(cases: any[], suites: any[], plans: any[], runs: any[]): LineageIndex {
  const index: LineageIndex = {
    caseSuites: new Map(), casePlans: new Map(), caseRuns: new Map(),
    suitePlans: new Map(), suiteCases: new Map(), suiteRuns: new Map(),
    planSuites: new Map(), planCases: new Map(), planRuns: new Map(),
  };

  for (const testCase of cases || []) {
    const caseId = String(testCase?.id || '');
    if (!caseId) continue;
    idsOf(testCase, 'testSuiteIds', 'testSuiteId').forEach((suiteId) => { addTo(index.caseSuites, caseId, suiteId); addTo(index.suiteCases, suiteId, caseId); });
    idsOf(testCase, 'testPlanIds', 'testPlanId').forEach((planId) => { addTo(index.casePlans, caseId, planId); addTo(index.planCases, planId, caseId); });
  }

  for (const suite of suites || []) {
    const suiteId = String(suite?.id || '');
    if (!suiteId) continue;
    idsOf(suite, 'testPlanIds', 'testPlanId').forEach((planId) => { addTo(index.suitePlans, suiteId, planId); addTo(index.planSuites, planId, suiteId); });
  }

  for (const run of runs || []) {
    const runId = String(run?.id || '');
    if (!runId) continue;
    const caseIds = [...(Array.isArray(run.caseIds) ? run.caseIds : []), run.testCaseId].filter(Boolean).map(String);
    const suiteIds = [...(Array.isArray(run.suiteIds) ? run.suiteIds : []), run.suiteId].filter(Boolean).map(String);
    const planIds = [...(Array.isArray(run.planIds) ? run.planIds : []), run.testPlanId].filter(Boolean).map(String);
    caseIds.forEach((caseId) => addTo(index.caseRuns, caseId, runId));
    suiteIds.forEach((suiteId) => addTo(index.suiteRuns, suiteId, runId));
    planIds.forEach((planId) => addTo(index.planRuns, planId, runId));
  }

  return index;
}
