export type RunSourceChange = {
  kind: 'Plan' | 'Suite' | 'Case';
  id: string;
  name: string;
  versionText: string;
  fields: string[];
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', title: 'Title', description: 'Description', preconditions: 'Preconditions',
  status: 'Status', riskLevel: 'Risk', priority: 'Priority', module: 'Module', tags: 'Tags',
  objectives: 'Objectives', steps: 'Steps',
};

const FIELDS = {
  plans: ['name', 'description', 'status', 'riskLevel', 'tags', 'objectives'],
  suites: ['name', 'description', 'status', 'priority', 'module', 'tags'],
  cases: ['title', 'description', 'preconditions', 'status', 'priority', 'tags', 'steps'],
} as const;

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const version = (item: any) => Number(item?.metadata?.version || item?.version || 1);
export function runSourceVersionChanges(run: any, current: { plans: any[]; suites: any[]; cases: any[] }): RunSourceChange[] {
  const captured = run?.triggerMeta?.sourceVersions;
  const groups = [
    { key: 'plans' as const, kind: 'Plan' as const, items: current.plans },
    { key: 'suites' as const, kind: 'Suite' as const, items: current.suites },
    { key: 'cases' as const, kind: 'Case' as const, items: current.cases },
  ];

  if (captured) return groups.flatMap(({ key, kind, items }) => (captured[key] || []).flatMap((baseline: any) => {
    const item = items.find((candidate) => String(candidate.id) === String(baseline.id));
    if (!item) return [{ kind, id: baseline.id, name: baseline.name || baseline.id, versionText: 'Source removed', fields: ['Removed'] }];
    const fields = FIELDS[key].filter((field) => !same(baseline.snapshot?.[field], item[field])).map((field) => FIELD_LABELS[field]);
    const currentVersion = version(item);
    const revisionChanged = key === 'cases' && baseline.revision != null && item.currentRevision != null && Number(baseline.revision) !== Number(item.currentRevision);
    if (!fields.length && currentVersion === Number(baseline.version) && !revisionChanged) return [];
    const versionText = revisionChanged
      ? `@v${baseline.revision} → @v${item.currentRevision}`
      : `v${baseline.version} → v${currentVersion}`;
    return [{ kind, id: baseline.id, name: item.name || item.title || baseline.name || baseline.id, versionText, fields }];
  }));

  // Legacy runs have no baseline to compare. Timestamps change for links and other operational
  // writes, so treating them as version drift produces false warnings.
  return [];
}
