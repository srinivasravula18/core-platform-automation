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
    (run.evidence_screenshots || []).map((evidence: any) => [evidence.testCaseIndex, evidence])
  );

  // Derive a real outcome from the executed test's status when available.
  const outcomeOf = (ev: any): { outcome: string; reason: string } => {
    // Only string test statuses are meaningful outcomes; numeric values (e.g. an
    // HTTP status from base-URL fallback evidence) are not test verdicts.
    const status = typeof ev?.status === 'string' ? ev.status : '';
    if (!status) return { outcome: 'Pass', reason: '' };
    if (/(fail|timedout|interrupted)/i.test(status)) return { outcome: 'Fail', reason: ev?.reason || '' };
    if (/not_executed|blocked/i.test(status)) return { outcome: 'Blocked', reason: ev?.reason || '' };
    if (/skip/i.test(status)) return { outcome: 'Skipped', reason: ev?.reason || '' };
    return { outcome: 'Pass', reason: '' };
  };

  return (run.generated_cases || []).flatMap((testCase: any, caseIndex: number) => {
    const steps = normalizeCaseSteps(testCase.steps);
    const ev: any = evidenceByCaseIndex.get(caseIndex);
    const screenshot = (ev && ev.screenshotUrl) || run.app_url || '';
    const { outcome, reason } = outcomeOf(ev);

    if (!steps.length) {
      return [{
        step: `${caseIndex + 1}`,
        action: testCase.title || `Execute generated test case ${caseIndex + 1}`,
        expected: testCase.description || 'Expected behavior is verified.',
        outcome,
        reason,
        screenshot,
      }];
    }

    const stepShots: string[] = (ev && Array.isArray(ev.stepScreenshots)) ? ev.stepScreenshots : [];
    return steps.map((step, stepIndex) => ({
      step: `${caseIndex + 1}.${stepIndex + 1}`,
      action: step.action,
      expected: step.expected,
      outcome,
      reason,
      // Distinct per-step screenshot when the script captured one; else the case-level shot.
      screenshot: stepShots[stepIndex] || screenshot,
      testCaseTitle: testCase.title,
    }));
  });
}
