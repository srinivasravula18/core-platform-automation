export function relatedCasesForSuite(cases: any[], folderId: string, parentSuiteIds: string | string[]): any[] {
  const parentIds = Array.isArray(parentSuiteIds) ? parentSuiteIds : (parentSuiteIds ? [parentSuiteIds] : []);
  if (!folderId && !parentIds.length) return [];
  return cases.filter((testCase) => {
    if (parentIds.length) {
      return caseSuiteIds(testCase).some((id) => parentIds.includes(id));
    }
    return testCase.folderId === folderId;
  });
}

export function caseSuiteIds(testCase: any): string[] {
  return Array.isArray(testCase?.testSuiteIds) && testCase.testSuiteIds.length
    ? testCase.testSuiteIds
    : (testCase?.testSuiteId ? [testCase.testSuiteId] : []);
}

export function caseBelongsToSuite(testCase: any, suiteId: string): boolean {
  return caseSuiteIds(testCase).includes(suiteId);
}

export function caseSuiteAssignment(testCase: any, suiteId: string) {
  return {
    testSuiteId: suiteId,
    testSuiteIds: Array.from(new Set([
      ...(Array.isArray(testCase.testSuiteIds) ? testCase.testSuiteIds : []),
      ...(testCase.testSuiteId ? [testCase.testSuiteId] : []),
      suiteId,
    ])),
    folderId: testCase.folderId,
  };
}

export function caseSuiteMembershipUpdate(testCase: any, suiteId: string, selected: boolean) {
  const currentIds = Array.from(new Set([
    ...(Array.isArray(testCase.testSuiteIds) ? testCase.testSuiteIds : []),
    ...(testCase.testSuiteId ? [testCase.testSuiteId] : []),
  ]));
  const testSuiteIds = selected
    ? Array.from(new Set([...currentIds, suiteId]))
    : currentIds.filter((id) => id !== suiteId);
  return {
    testSuiteId: testCase.testSuiteId === suiteId
      ? (testSuiteIds[0] || '')
      : (testCase.testSuiteId || (selected ? suiteId : '')),
    testSuiteIds,
    folderId: testCase.folderId,
  };
}

export function suiteModuleName(suite: any, folders: any[]): string {
  const stored = String(suite?.module || '').trim();
  if (stored && stored !== 'QA Assistant') return stored;
  return String(folders.find((folder) => folder.id === suite?.folderId)?.name || stored);
}

export function suitePlanIds(suite: any): string[] {
  return Array.isArray(suite?.testPlanIds) && suite.testPlanIds.length
    ? suite.testPlanIds
    : (suite?.testPlanId ? [suite.testPlanId] : []);
}

export function suiteParentIds(suite: any): string[] {
  return Array.isArray(suite?.parentSuiteIds) && suite.parentSuiteIds.length
    ? suite.parentSuiteIds
    : (suite?.parentSuite ? [suite.parentSuite] : []);
}

function suiteParent(suite: any, suites: any[]) {
  const parentRef = suiteParentIds(suite)[0];
  return parentRef ? suites.find((item) => item.id === parentRef || item.name === parentRef) : undefined;
}

export function suiteHierarchyDepth(suite: any, suites: any[]): number {
  let depth = 0;
  let current = suite;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current = suiteParent(current, suites);
    if (current) depth += 1;
  }
  return depth;
}

export function orderSuitesByHierarchy(visibleSuites: any[], allSuites = visibleSuites): any[] {
  const visibleIds = new Set(visibleSuites.map((suite) => suite.id));
  const children = new Map<string, any[]>();
  const roots: any[] = [];

  for (const suite of visibleSuites) {
    const parent = suiteParent(suite, allSuites);
    if (!parent || !visibleIds.has(parent.id)) roots.push(suite);
    else children.set(parent.id, [...(children.get(parent.id) || []), suite]);
  }

  const ordered: any[] = [];
  const visited = new Set<string>();
  const append = (suite: any) => {
    if (visited.has(suite.id)) return;
    visited.add(suite.id);
    ordered.push(suite);
    for (const child of children.get(suite.id) || []) append(child);
  };
  roots.forEach(append);
  visibleSuites.forEach(append);
  return ordered;
}
