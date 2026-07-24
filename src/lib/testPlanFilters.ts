export type TestPlanFilters = {
  statuses: string[];
  owners: string[];
  tags: string[];
  folders: string[];
  startFrom: string;
  endTo: string;
  environments: string;
  roles: string;
  runIds: string[];
  notYetExecuted: boolean;
};

export const emptyTestPlanFilters = (): TestPlanFilters => ({
  statuses: [],
  owners: [],
  tags: [],
  folders: [],
  startFrom: '',
  endTo: '',
  environments: '',
  roles: '',
  runIds: [],
  notYetExecuted: false,
});

export function linkedRunsForPlan(plan: any, runs: any[]): any[] {
  const linkedRunIds = new Set((Array.isArray(plan?.runIds) ? plan.runIds : []).map(String));
  return runs.filter((run) =>
    linkedRunIds.has(String(run.id))
    || run.testPlanId === plan?.id
    || (Array.isArray(run.planIds) && run.planIds.includes(plan?.id))
    || (plan?.agentRunId && run.agentRunId === plan.agentRunId)
    || (plan?.name && run.planName === plan.name)
  );
}

export function matchesTestPlanFilters(
  plan: any,
  runs: any[],
  filters: TestPlanFilters,
  matchMode: 'all' | 'any',
): boolean {
  const conditions: boolean[] = [];
  const linkedRuns = linkedRunsForPlan(plan, runs);
  const tags = Array.isArray(plan.tags) ? plan.tags.map(String) : [];

  if (filters.statuses.length) conditions.push(filters.statuses.includes(plan.status || 'Draft'));
  if (filters.owners.length) conditions.push(filters.owners.includes(String(plan.owner || '')));
  if (filters.tags.length) conditions.push(filters.tags.some((tag) => tags.includes(tag)));
  if (filters.folders.length) conditions.push(filters.folders.includes(String(plan.folderId || '')));
  if (filters.startFrom || filters.endTo) {
    const start = String(plan.startDate || '').slice(0, 10);
    const end = String(plan.endDate || '').slice(0, 10);
    conditions.push(
      (!filters.startFrom || Boolean(start && start >= filters.startFrom))
      && (!filters.endTo || Boolean(end && end <= filters.endTo)),
    );
  }
  if (filters.environments.trim()) conditions.push(String(plan.environments || '').toLowerCase().includes(filters.environments.trim().toLowerCase()));
  if (filters.roles.trim()) conditions.push(String(plan.roles || '').toLowerCase().includes(filters.roles.trim().toLowerCase()));
  if (filters.runIds.length) conditions.push(linkedRuns.some((run) => filters.runIds.includes(String(run.id))));
  if (filters.notYetExecuted) {
    conditions.push(!linkedRuns.some((run) => {
      const executionState = `${run.status || ''} ${run.state || ''} ${run.progress || ''}`.trim();
      return executionState && !/not started|draft|pending|scheduled|untested/i.test(executionState);
    }));
  }

  if (!conditions.length) return true;
  return matchMode === 'all' ? conditions.every(Boolean) : conditions.some(Boolean);
}
