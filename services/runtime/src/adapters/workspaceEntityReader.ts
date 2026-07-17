/**
 * Scoped workspace entity candidate reads (Phase 2) — compact records for the resolver's
 * workspace tier. Reads go through the existing repositories; scope filtering mirrors the
 * route layer's scopeFilter semantics (empty legacy fields pass).
 */

import { Cases, Scripts, Defects, Suites, Plans, Requirements, Reports } from '../../../../server/db/repository';
import type { WorkspaceRecord } from '../domain/entityResolver';
import type { EntityType, WorkspaceScope } from '../domain/types';

const PER_TYPE_LIMIT = 100;

function inScope(row: any, scope: WorkspaceScope): boolean {
  if (scope.ownerId && row.ownerId && row.ownerId !== scope.ownerId) return false;
  if (scope.projectId && row.projectId && row.projectId !== scope.projectId) return false;
  if (scope.appId && row.appId && row.appId !== scope.appId) return false;
  return true;
}

function toRecords(rows: any[], type: EntityType, scope: WorkspaceScope, labelKey = 'title'): WorkspaceRecord[] {
  return rows
    .filter((r) => r && inScope(r, scope))
    .slice(0, PER_TYPE_LIMIT)
    .map((r) => ({
      type,
      id: String(r.id),
      label: String(r[labelKey] || r.name || r.title || r.id),
      updatedAt: String(r.updatedAt || r.createdAt || ''),
      appId: r.appId || undefined,
      projectId: r.projectId || undefined,
    }));
}

/** Load compact scoped candidates for the requested types (default: the resolver-relevant set). */
export async function readWorkspaceEntities(
  scope: WorkspaceScope,
  types?: EntityType[],
): Promise<WorkspaceRecord[]> {
  const want = (t: EntityType) => !types || types.length === 0 || types.includes(t);
  const out: WorkspaceRecord[] = [];
  // Repos are read independently; one failing source must not blind the resolver to the rest.
  const safe = async (fn: () => Promise<WorkspaceRecord[]>) => { try { return await fn(); } catch { return []; } };

  if (want('test_case')) out.push(...await safe(async () => toRecords(await Cases.list(), 'test_case', scope)));
  if (want('script')) out.push(...await safe(async () => toRecords(await Scripts.list(), 'script', scope, 'name')));
  if (want('defect')) out.push(...await safe(async () => toRecords(await Defects.list(), 'defect', scope)));
  if (want('test_suite')) out.push(...await safe(async () => toRecords(await Suites.list(), 'test_suite', scope, 'name')));
  if (want('test_plan')) out.push(...await safe(async () => toRecords(await Plans.list(), 'test_plan', scope, 'name')));
  if (want('requirement')) out.push(...await safe(async () => toRecords(await Requirements.list(), 'requirement', scope)));
  if (want('report')) out.push(...await safe(async () => toRecords(await Reports.list(), 'report', scope, 'name')));
  return out;
}
