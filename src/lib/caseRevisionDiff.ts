export interface RevisionStep {
  action?: string;
  expected?: string;
}

export interface RevisionSnapshot {
  title?: string;
  description?: string;
  preconditions?: string;
  steps?: RevisionStep[];
}

export interface RevisionDiffValue {
  value: string;
  expected?: string;
}

export interface RevisionDifference {
  label: string;
  type: 'field' | 'step';
  status: 'added' | 'removed' | 'changed';
  before: RevisionDiffValue | null;
  after: RevisionDiffValue | null;
}

export function diffCaseRevisions(before: RevisionSnapshot, after: RevisionSnapshot): RevisionDifference[] {
  const differences: RevisionDifference[] = [];
  const fields = [
    ['Title', 'title'],
    ['Description', 'description'],
    ['Preconditions', 'preconditions'],
  ] as const;

  for (const [label, key] of fields) {
    const previous = String(before[key] || '');
    const current = String(after[key] || '');
    if (previous !== current) {
      differences.push({
        label,
        type: 'field',
        status: !previous ? 'added' : !current ? 'removed' : 'changed',
        before: { value: previous },
        after: { value: current },
      });
    }
  }

  const beforeSteps = Array.isArray(before.steps) ? before.steps : [];
  const afterSteps = Array.isArray(after.steps) ? after.steps : [];
  for (let index = 0; index < Math.max(beforeSteps.length, afterSteps.length); index += 1) {
    const previous = beforeSteps[index];
    const current = afterSteps[index];
    if (String(previous?.action || '') === String(current?.action || '')
      && String(previous?.expected || '') === String(current?.expected || '')) continue;
    differences.push({
      label: `Step ${index + 1}`,
      type: 'step',
      status: !previous ? 'added' : !current ? 'removed' : 'changed',
      before: previous ? { value: String(previous.action || ''), expected: String(previous.expected || '') } : null,
      after: current ? { value: String(current.action || ''), expected: String(current.expected || '') } : null,
    });
  }

  return differences;
}
