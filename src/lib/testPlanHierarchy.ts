export interface TestPlanHierarchyRow<T> {
  plan: T;
  depth: number;
  hasChildren: boolean;
}

export function buildTestPlanHierarchy<T extends { id: string; parentPlanId?: string | null }>(
  plans: T[],
  collapsedIds: ReadonlySet<string> = new Set(),
): TestPlanHierarchyRow<T>[] {
  const byId = new Map(plans.map((plan) => [String(plan.id), plan]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const plan of plans) {
    const parentId = String(plan.parentPlanId || '');
    if (parentId && byId.has(parentId) && parentId !== String(plan.id)) {
      children.set(parentId, [...(children.get(parentId) || []), plan]);
    } else {
      roots.push(plan);
    }
  }

  const rows: TestPlanHierarchyRow<T>[] = [];
  const visited = new Set<string>();
  const append = (plan: T, depth: number) => {
    const id = String(plan.id);
    if (visited.has(id)) return;
    visited.add(id);
    const descendants = children.get(id) || [];
    rows.push({ plan, depth, hasChildren: descendants.length > 0 });
    if (!collapsedIds.has(id)) descendants.forEach((child) => append(child, depth + 1));
  };

  roots.forEach((plan) => append(plan, 0));
  plans.forEach((plan) => {
    let parentId = String(plan.parentPlanId || '');
    const ancestors = new Set<string>();
    while (parentId && byId.has(parentId) && !ancestors.has(parentId)) {
      if (visited.has(parentId)) return;
      ancestors.add(parentId);
      parentId = String(byId.get(parentId)?.parentPlanId || '');
    }
    append(plan, 0);
  });
  return rows;
}
