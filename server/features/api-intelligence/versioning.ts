/**
 * Contract versioning (Phase C) — DETERMINISTIC. Snapshots a new contract version only when the
 * contract hash changes (dedup churn), and diffs any two versions (added/removed fields, type/validation
 * changes). Stored in the graph's contractVersions collection.
 */
import { db, persistDataInBackground } from '../../shared/storage';
import { endpointRowId } from './graph';
import { shapeOf, diffShape } from './validation';
import type { ApiEndpoint, ApiRun } from './types';

const g = () => db.apiGraph as Record<string, any[]>;

/** Snapshot each endpoint's contract as a new version iff its hash changed since the last version. */
export function snapshotContractVersions(run: ApiRun): number {
  let created = 0;
  for (const ep of run.endpoints) {
    const rowId = endpointRowId(run.projectId, run.appId, ep.method, ep.path);
    const versions = g().contractVersions.filter((v) => v.endpointRowId === rowId).sort((a, b) => a.version - b.version);
    const last = versions[versions.length - 1];
    if (last && last.contractHash === ep.contractHash) continue; // unchanged → no churn
    g().contractVersions.push({
      endpointRowId: rowId,
      version: (last?.version || 0) + 1,
      contract: ep.contract,
      contractHash: ep.contractHash,
      sourceRunId: run.id,
      createdAt: new Date().toISOString(),
    });
    created += 1;
  }
  if (created) persistDataInBackground('api contract versions snapshotted');
  return created;
}

export function listVersions(endpointRowIdVal: string): any[] {
  return g().contractVersions.filter((v) => v.endpointRowId === endpointRowIdVal).sort((a, b) => a.version - b.version);
}

/** Diff two contract versions → human-readable field/type changes. */
export function diffVersions(endpointRowIdVal: string, fromVersion: number, toVersion: number): { from: number; to: number; changes: string[] } {
  const all = listVersions(endpointRowIdVal);
  const a = all.find((v) => v.version === fromVersion);
  const b = all.find((v) => v.version === toVersion);
  if (!a || !b) return { from: fromVersion, to: toVersion, changes: ['One or both versions not found.'] };
  const changes: string[] = [];
  // request body shape drift
  changes.push(...diffShape(shapeOf(a.contract?.request?.bodySchema), shapeOf(b.contract?.request?.bodySchema)).map((c) => `request ${c}`));
  // response shape drift per status
  const codes = new Set([...Object.keys(a.contract?.responses || {}), ...Object.keys(b.contract?.responses || {})]);
  for (const code of codes) {
    const as = a.contract?.responses?.[code]?.schema;
    const bs = b.contract?.responses?.[code]?.schema;
    if (!as && bs) changes.push(`response ${code} added`);
    else if (as && !bs) changes.push(`response ${code} removed`);
    else changes.push(...diffShape(shapeOf(as), shapeOf(bs)).map((c) => `response ${code} ${c}`));
  }
  // auth change
  if (Boolean(a.contract?.auth?.required) !== Boolean(b.contract?.auth?.required)) {
    changes.push(`auth requirement changed: ${a.contract?.auth?.required} → ${b.contract?.auth?.required}`);
  }
  return { from: fromVersion, to: toVersion, changes: changes.filter(Boolean) };
}
