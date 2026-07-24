export interface RunEvidenceItem {
  url: string;
  caseId: string;
  caseTitle: string;
  caseIndex: number;
  stepIndex: number | null;
  stepLabel: string;
  action: string;
  outcome: string;
}

function caseFor(cases: any[], index: number, title = '') {
  return cases.find((testCase) => title && String(testCase.title || '').trim() === title.trim()) || cases[index] || {};
}

export function collectRunEvidence(run: any, cases: any[] = []): RunEvidenceItem[] {
  const items: RunEvidenceItem[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, meta: Omit<RunEvidenceItem, 'url'>) => {
    const value = String(url || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    items.push({ url: value, ...meta });
  };

  for (const [index, step] of (Array.isArray(run?.steps) ? run.steps : []).entries()) {
    const match = String(step?.step || '').match(/^(\d+)(?:\.(\d+))?/);
    const caseIndex = Math.max(0, Number(match?.[1] || index + 1) - 1);
    const stepIndex = match?.[2] ? Number(match[2]) : null;
    const testCase = caseFor(cases, caseIndex, String(step?.testCaseTitle || (stepIndex ? '' : step?.action) || ''));
    const meta = {
      caseId: String(testCase.id || ''),
      caseTitle: String(testCase.title || step?.testCaseTitle || step?.action || `Test case ${caseIndex + 1}`),
      caseIndex,
      stepIndex,
      stepLabel: stepIndex ? `Step ${stepIndex}` : 'Case evidence',
      action: String(step?.action || ''),
      outcome: String(step?.outcome || step?.status || ''),
    };
    for (const url of [...(Array.isArray(step?.screenshots) ? step.screenshots : []), step?.screenshot]) add(url, meta);
  }

  for (const [index, evidence] of (Array.isArray(run?.evidence) ? run.evidence : []).entries()) {
    if (typeof evidence === 'string') {
      const testCase = caseFor(cases, index);
      add(evidence, {
        caseId: String(testCase.id || ''),
        caseTitle: String(testCase.title || `Test case ${index + 1}`),
        caseIndex: index,
        stepIndex: null,
        stepLabel: 'Case evidence',
        action: '',
        outcome: '',
      });
      continue;
    }
    const caseIndex = Math.max(0, Number(evidence?.testCaseIndex ?? index));
    const testCase = caseFor(cases, caseIndex, String(evidence?.title || ''));
    const base = {
      caseId: String(testCase.id || ''),
      caseTitle: String(testCase.title || evidence?.title || `Test case ${caseIndex + 1}`),
      caseIndex,
      action: '',
      outcome: String(evidence?.status || ''),
    };
    for (const [stepIndex, url] of (Array.isArray(evidence?.stepScreenshots) ? evidence.stepScreenshots : []).entries()) {
      add(url, { ...base, stepIndex: stepIndex + 1, stepLabel: `Step ${stepIndex + 1}` });
    }
    add(evidence?.screenshotUrl, { ...base, stepIndex: null, stepLabel: 'Final screenshot' });
  }

  return items;
}

export function evidenceDownloadName(runId: string, item: RunEvidenceItem) {
  const safe = (value: string) => value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const ext = String(item.url).match(/\.(png|jpe?g|webp)(?:$|\?)/i)?.[1] || 'png';
  return `${safe(runId) || 'run'}-${safe(item.caseId || item.caseTitle) || `case-${item.caseIndex + 1}`}-${item.stepIndex ? `step-${item.stepIndex}` : 'final'}.${ext}`;
}
