export function normalizeCaseSteps(steps: any[] = []) {
  return steps
    .map((step) => ({
      action: String(step?.action || '').trim(),
      expected: String(step?.expected || '').trim(),
    }))
    .filter((step) => step.action || step.expected);
}

export function normalizeCaseTags(tags: any[] = []) {
  return tags
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => {
      const normalized = tag.replace(/^#+/, '').replace(/^@+/, '').replace(/\s+/g, '-');
      return normalized ? `@${normalized}` : '';
    })
    .filter(Boolean);
}

export function buildCaseDescription(testCase: any) {
  const baseDescription = String(testCase?.description || '').trim();
  const steps = normalizeCaseSteps(testCase?.steps);

  if (!steps.length) return baseDescription;

  const stepLines = steps.map((step, index) => {
    return `${index + 1}. ${step.action}\n   Expected: ${step.expected}`;
  });

  return [baseDescription, 'Test Steps:', ...stepLines].filter(Boolean).join('\n\n');
}

export function buildAgentExecutionSteps(run: any) {
  const evidenceByCaseIndex = new Map(
    (run.evidence_screenshots || []).map((evidence: any) => [evidence.testCaseIndex, evidence.screenshotUrl])
  );

  return (run.generated_cases || []).flatMap((testCase: any, caseIndex: number) => {
    const steps = normalizeCaseSteps(testCase.steps);
    const screenshot = evidenceByCaseIndex.get(caseIndex) || run.app_url || '';

    if (!steps.length) {
      return [{
        step: `${caseIndex + 1}`,
        action: testCase.title || `Execute generated test case ${caseIndex + 1}`,
        expected: testCase.description || 'Expected behavior is verified.',
        outcome: 'Pass',
        reason: '',
        screenshot,
      }];
    }

    return steps.map((step, stepIndex) => ({
      step: `${caseIndex + 1}.${stepIndex + 1}`,
      action: step.action,
      expected: step.expected,
      outcome: 'Pass',
      reason: '',
      screenshot,
      testCaseTitle: testCase.title,
    }));
  });
}
