export function relatedCasesForSuite(cases: any[], folderId: string, parentSuiteId: string): any[] {
  if (!folderId) return [];
  return cases.filter((testCase) => {
    if (testCase.folderId !== folderId) return false;
    if (!parentSuiteId) return true;
    return testCase.testSuiteId === parentSuiteId
      || (Array.isArray(testCase.testSuiteIds) && testCase.testSuiteIds.includes(parentSuiteId));
  });
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
