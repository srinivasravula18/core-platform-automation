export function normalizeCaseSteps(steps: any[] = []) {
  return steps
    .map((step) => {
      const normalized: { action: string; expected: string; group?: string; groupIndex?: number } = {
        action: String(step?.action || '').trim(),
        expected: String(step?.expected || '').trim(),
      };
      // Preserve optional recorder grouping metadata (see stepGrouping.ts) when present — additive,
      // so callers that only read {action, expected} are unaffected.
      const group = String(step?.group || '').trim();
      if (group) normalized.group = group;
      if (Number.isInteger(step?.groupIndex)) normalized.groupIndex = step.groupIndex;
      return normalized;
    })
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
  // The description is a short summary only. Steps are stored/shown separately (the steps column and
  // the UI's Steps section), so appending them here would duplicate every step in the description.
  return String(testCase?.description || '').trim();
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
    // No real verdict was recorded (no evidence row, or only a base-URL fallback
    // screenshot). This is NOT a pass — claiming "Pass" here is the false-green bug.
    // Report it honestly as Not Executed so it never counts as a verified success.
    if (!status) return { outcome: 'Not Executed', reason: 'No execution verdict was recorded for this case.' };
    if (/pass/i.test(status)) return { outcome: 'Pass', reason: '' };
    if (/(fail|timedout|interrupted)/i.test(status)) return { outcome: 'Fail', reason: ev?.reason || '' };
    if (/not_executed|blocked/i.test(status)) return { outcome: 'Blocked', reason: ev?.reason || '' };
    if (/skip/i.test(status)) return { outcome: 'Skipped', reason: ev?.reason || '' };
    // Unknown non-empty status: do not assume success.
    return { outcome: 'Not Executed', reason: `Unrecognized execution status: ${status}` };
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
