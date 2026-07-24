export interface AIReworkStep {
  action?: string;
  expected?: string;
}

export interface AIReworkCase {
  title?: string;
  description?: string;
  preconditions?: string;
  priority?: string;
  type?: string;
  tags?: string[];
  steps?: AIReworkStep[];
}

export interface AIReworkProposalItem<T extends AIReworkCase = AIReworkCase> {
  key: string;
  kind: 'updated' | 'new';
  sourceIndex?: number;
  before: T | null;
  after: T;
  baselineSignature?: string;
}

export interface AIReworkProposal<T extends AIReworkCase = AIReworkCase> {
  id: string;
  note?: string;
  items: AIReworkProposalItem<T>[];
}

export function aiReworkCaseSignature(value: AIReworkCase | undefined): string {
  return JSON.stringify({
    title: value?.title || '',
    description: value?.description || '',
    preconditions: value?.preconditions || '',
    priority: value?.priority || '',
    type: value?.type || '',
    tags: value?.tags || [],
    steps: (value?.steps || []).map((step) => ({
      action: step.action || '',
      expected: step.expected || '',
    })),
  });
}

export function singleCaseProposal<T extends AIReworkCase>(
  before: T,
  after: T,
  sourceIndex = 0,
  note = '',
): AIReworkProposal<T> {
  return {
    id: `single-${Date.now()}`,
    note,
    items: [{
      key: `updated-${sourceIndex}`,
      kind: 'updated',
      sourceIndex,
      before,
      after,
      baselineSignature: aiReworkCaseSignature(before),
    }],
  };
}

export function suiteCaseProposal<T extends AIReworkCase>(
  cases: T[],
  response: {
    updatedCases?: Array<{ index: number; testCase: T }>;
    newCases?: T[];
    note?: string;
  },
): AIReworkProposal<T> {
  const updated = (response.updatedCases || [])
    .filter(({ index, testCase }) => Number.isInteger(index) && index >= 0 && index < cases.length && testCase)
    .map(({ index, testCase }) => ({
      key: `updated-${index}`,
      kind: 'updated' as const,
      sourceIndex: index,
      before: cases[index],
      after: testCase,
      baselineSignature: aiReworkCaseSignature(cases[index]),
    }));
  const added = (response.newCases || []).map((testCase, index) => ({
    key: `new-${index}`,
    kind: 'new' as const,
    before: null,
    after: testCase,
  }));
  return {
    id: `suite-${Date.now()}`,
    note: response.note,
    items: [...updated, ...added],
  };
}

export function isAIReworkProposalStale<T extends AIReworkCase>(
  cases: T[],
  proposal: AIReworkProposal<T>,
): boolean {
  return proposal.items.some((item) => item.kind === 'updated'
    && (item.sourceIndex == null
      || aiReworkCaseSignature(cases[item.sourceIndex]) !== item.baselineSignature));
}

export function applyAIReworkProposal<T extends AIReworkCase>(
  cases: T[],
  proposal: AIReworkProposal<T>,
  selectedKeys: ReadonlySet<string>,
): { cases: T[]; appliedCount: number } {
  if (isAIReworkProposalStale(cases, proposal)) {
    throw new Error('These cases changed after the preview was generated. Preview the request again before applying it.');
  }
  const chosen = proposal.items.filter((item) => selectedKeys.has(item.key));
  const updates = new Map(chosen
    .filter((item) => item.kind === 'updated' && item.sourceIndex != null)
    .map((item) => [item.sourceIndex!, item.after]));
  const added = chosen.filter((item) => item.kind === 'new').map((item) => item.after);
  return {
    cases: [...cases.map((testCase, index) => updates.get(index) || testCase), ...added],
    appliedCount: chosen.length,
  };
}
