export function normalizeTestCaseTypes(testCase: { testingTypes?: unknown; testingType?: unknown } = {}) {
  const values = Array.isArray(testCase.testingTypes) && testCase.testingTypes.length
    ? testCase.testingTypes
    : [testCase.testingType || 'Functional'];
  return [...new Set(values.flatMap((value) => String(value || '').split(',')).map((value) => value.trim()).filter(Boolean))];
}

export function testCaseTypeFields(testingTypes: unknown, testingType?: unknown) {
  const normalized = normalizeTestCaseTypes({ testingTypes, testingType });
  return { testingTypes: normalized, testingType: normalized[0] || 'Functional' };
}
