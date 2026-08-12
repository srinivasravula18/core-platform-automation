/**
 * Deletion closure — what a cascade delete would actually touch.
 *
 * Every parent/child link in this schema is many-to-many: a case can belong to several plans AND
 * several suites, and a suite can belong to several plans and several parent suites (a DAG, not a
 * tree). So "delete the plan and everything under it" must not destroy a case another live plan is
 * still using.
 *
 * The rule: cascade only descendants the deleted set EXCLUSIVELY owns. Anything still referenced by
 * a surviving parent is detached (the dead link is dropped) and kept. Callers preview the result
 * before anything is written.
 */

import { Cases, Plans, Suites } from '../../db/repository';

export type DeletableType = 'plans' | 'suites' | 'cases';

export interface ClosureNode {
  type: DeletableType;
  id: string;
  label: string;
}

export interface DetachedLink {
  /** The surviving row that loses a link. */
  type: DeletableType;
  id: string;
  label: string;
  /** Which array the dead id is removed from. */
  field: 'testPlanIds' | 'testSuiteIds' | 'parentSuiteIds';
  removedId: string;
}

export interface DeletionClosure {
  root: ClosureNode;
  willDelete: ClosureNode[];
  willDetach: DetachedLink[];
}

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry || '')).filter(Boolean) : [];

/**
 * Resolve everything a delete of `rootType:rootId` should touch.
 * `scopedRows` are the caller's already scope-filtered live rows, so this never reaches across users.
 */
export function resolveDeletionClosure(
  rootType: DeletableType,
  rootId: string,
  scopedRows: { plans: any[]; suites: any[]; cases: any[] },
): DeletionClosure | null {
  const plans = scopedRows.plans || [];
  const suites = scopedRows.suites || [];
  const cases = scopedRows.cases || [];

  const find = (type: DeletableType, id: string) =>
    (type === 'plans' ? plans : type === 'suites' ? suites : cases).find((row: any) => String(row.id) === String(id));
  const labelOf = (type: DeletableType, row: any) => String((type === 'cases' ? row?.title : row?.name) || row?.id || '');

  const rootRow = find(rootType, rootId);
  if (!rootRow) return null;

  const key = (type: DeletableType, id: string) => `${type}:${id}`;
  const doomed = new Set<string>([key(rootType, rootId)]);
  const willDelete: ClosureNode[] = [];
  const detached = new Map<string, DetachedLink>();

  // BFS over the DAG. `doomed` doubles as the visited set, so a parent_suite_ids cycle terminates.
  const queue: ClosureNode[] = [{ type: rootType, id: String(rootId), label: labelOf(rootType, rootRow) }];
  while (queue.length) {
    const node = queue.shift()!;
    if (node.type !== rootType || node.id !== String(rootId)) willDelete.push(node);

    // A child dies only if every parent link it holds points into the doomed set (or is already gone).
    const consider = (childType: DeletableType, child: any, field: DetachedLink['field'], parents: string[]) => {
      const live = parents.filter((parentId) => {
        const parentType: DeletableType = field === 'testPlanIds' ? 'plans' : 'suites';
        return Boolean(find(parentType, parentId)); // rows already deleted are absent from scopedRows
      });
      const survivesElsewhere = live.some((parentId) => {
        const parentType: DeletableType = field === 'testPlanIds' ? 'plans' : 'suites';
        return !doomed.has(key(parentType, parentId));
      });
      if (survivesElsewhere) {
        const detachKey = `${childType}:${child.id}:${field}:${node.id}`;
        detached.set(detachKey, { type: childType, id: String(child.id), label: labelOf(childType, child), field, removedId: node.id });
        return;
      }
      const childKey = key(childType, String(child.id));
      if (doomed.has(childKey)) return;
      doomed.add(childKey);
      queue.push({ type: childType, id: String(child.id), label: labelOf(childType, child) });
    };

    if (node.type === 'plans') {
      for (const plan of plans) {
        if (String(plan.parentPlanId || '') !== node.id) continue;
        const childKey = key('plans', String(plan.id));
        if (doomed.has(childKey)) continue;
        doomed.add(childKey);
        queue.push({ type: 'plans', id: String(plan.id), label: labelOf('plans', plan) });
      }
      for (const suite of suites) {
        const parents = idsOf(suite.testPlanIds);
        if (parents.includes(node.id)) consider('suites', suite, 'testPlanIds', parents);
      }
      for (const testCase of cases) {
        const parents = idsOf(testCase.testPlanIds);
        if (parents.includes(node.id)) consider('cases', testCase, 'testPlanIds', parents);
      }
    }

    if (node.type === 'suites') {
      for (const suite of suites) {
        const parents = idsOf(suite.parentSuiteIds);
        if (parents.includes(node.id)) consider('suites', suite, 'parentSuiteIds', parents);
      }
      for (const testCase of cases) {
        const parents = idsOf(testCase.testSuiteIds);
        if (parents.includes(node.id)) consider('cases', testCase, 'testSuiteIds', parents);
      }
    }
  }

  // A row that ends up deleted must not also appear as merely detached.
  const willDetach = [...detached.values()].filter((link) => !doomed.has(key(link.type, link.id)));

  return {
    root: { type: rootType, id: String(rootId), label: labelOf(rootType, rootRow) },
    willDelete,
    willDetach,
  };
}

/** Remove the dead parent id from a surviving row's link arrays, keeping the singular column in sync. */
export function applyDetach(row: any, link: DetachedLink): any {
  const next = { ...row };
  const remaining = idsOf(next[link.field]).filter((id) => id !== link.removedId);
  next[link.field] = remaining;
  if (link.field === 'testPlanIds') next.testPlanId = remaining[0] || '';
  if (link.field === 'testSuiteIds') next.testSuiteId = remaining[0] || '';
  return next;
}

/** Persist a resolved closure: soft-delete the doomed rows, detach the survivors. Returns counts. */
export async function executeDeletionClosure(closure: DeletionClosure, batchId: string, stamp: (type: string, ids: string[], batchId: string) => Promise<void>) {
  const byType: Record<string, string[]> = {};
  for (const node of [...closure.willDelete]) (byType[node.type] ||= []).push(node.id);

  for (const link of closure.willDetach) {
    const repo = link.type === 'cases' ? Cases : link.type === 'suites' ? Suites : Plans;
    const row = await repo.get(link.id);
    if (row) await repo.upsert(applyDetach(row, link));
  }

  for (const [type, ids] of Object.entries(byType)) {
    const repo = type === 'cases' ? Cases : type === 'suites' ? Suites : Plans;
    for (const id of ids) await repo.remove(id);
    await stamp(type, ids, batchId);
  }

  return { deleted: closure.willDelete.length, detached: closure.willDetach.length };
}
