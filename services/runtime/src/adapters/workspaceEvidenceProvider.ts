/**
 * Workspace evidence provider (Phase 4) — recorded QA domain records (cases, scripts,
 * requirements, reports) as compact scoped evidence. Recorded authority, never observed.
 */

import { Cases, Scripts, Requirements, Reports } from '../../../../server/db/repository';
import type { EvidenceItem, EvidenceKind, EvidenceRequest, EvidenceRequirement } from '../domain/types';
import type { EvidenceProviderPort } from '../ports';

const SUPPORTED: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'workspace_record', 'generated_case', 'generated_script', 'requirement', 'report',
]);

function inScope(row: any, scope: { ownerId?: string | null; projectId?: string | null; appId?: string | null }): boolean {
  if (scope.ownerId && row.ownerId && row.ownerId !== scope.ownerId) return false;
  if (scope.projectId && row.projectId && row.projectId !== scope.projectId) return false;
  if (scope.appId && row.appId && row.appId !== scope.appId) return false;
  return true;
}

function toItem(row: any, kind: EvidenceKind, entityType: string, provider: string): EvidenceItem {
  const id = `ev:ws:${entityType}:${row.id}`;
  const label = String(row.title || row.name || row.id).slice(0, 160);
  return {
    id,
    kind,
    authority: 'recorded',
    source: { provider, ref: String(row.id) },
    entityRefs: [{ type: entityType as any, id: String(row.id), label }],
    capturedAt: new Date().toISOString(),
    freshness: 'current',
    summary: `${entityType} ${row.id}: ${label}${row.status ? ` [${row.status}]` : ''}`,
    facts: [{ statement: `${entityType} "${label}" exists (${row.id})`, authority: 'recorded', evidenceId: id }],
    redactions: [],
  };
}

export const workspaceEvidenceProvider: EvidenceProviderPort = {
  supports(requirement: EvidenceRequirement): boolean {
    return SUPPORTED.has(requirement.kind);
  },
  async collect(request: EvidenceRequest): Promise<EvidenceItem[]> {
    const scope = request.scope;
    const subjectIds = new Set(request.subjectRefs.map((r) => r.id));
    const pick = (rows: any[]) => rows
      .filter((r) => r && inScope(r, scope))
      .filter((r) => subjectIds.size === 0 || subjectIds.has(String(r.id)))
      .slice(0, 25);
    switch (request.requirement.kind) {
      case 'generated_case':
      case 'workspace_record': {
        const cases = pick(await Cases.list().catch(() => []));
        return cases.map((c) => toItem(c, request.requirement.kind, 'test_case', 'workspaceEvidence'));
      }
      case 'generated_script': {
        const scripts = pick(await Scripts.list().catch(() => []));
        return scripts.map((s) => toItem(s, 'generated_script', 'script', 'workspaceEvidence'));
      }
      case 'requirement': {
        const reqs = pick(await Requirements.list().catch(() => []));
        return reqs.map((r) => toItem(r, 'requirement', 'requirement', 'workspaceEvidence'));
      }
      case 'report': {
        const reports = pick(await Reports.list().catch(() => []));
        return reports.map((r) => toItem(r, 'report', 'report', 'workspaceEvidence'));
      }
      default: return [];
    }
  },
};
