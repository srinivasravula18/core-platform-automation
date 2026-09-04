/**
 * Shared helpers for the unified EntityLinker — the one flow used to map existing
 * cases/suites/plans/runs together and to assemble new groupings from tags/search.
 *
 * Membership stays denormalized on the child rows (testSuiteIds[], caseIds[], …); these
 * helpers compute the add/remove diff and persist it, keeping the dual singular/plural
 * fields in sync (mirrors src/lib/suiteCaseSelection.ts + the server normalization).
 */

export type EntityKind = 'cases' | 'suites' | 'plans' | 'runs';

export interface TagCatalogEntry {
  id: string;
  name: string;
  color: string;
  count: number;
}

/** Diff a desired selection against the initial membership. */
export function diffSelection(initial: string[], next: string[]): { add: string[]; remove: string[] } {
  const initialSet = new Set(initial);
  const nextSet = new Set(next);
  return {
    add: next.filter((id) => !initialSet.has(id)),
    remove: initial.filter((id) => !nextSet.has(id)),
  };
}

import type { TagQuery } from '../../core/shared/tagQuery';
export { isEmptyTagQuery, matchesTagQuery, resolveTagQuery, type TagQuery } from '../../core/shared/tagQuery';

/** One case as returned in a drift payload's preview list. */
export interface TagDriftCase { id: string; title: string; tags: string[]; priority: string; status: string }
/** An accepted case whose pinned version is behind the latest (content drift). */
export interface OutdatedPin { caseId: string; title: string; pinnedRevisionNo: number; headRevisionNo: number }
/** Review-gated drift for a tag-defined suite/plan/run (the notification-dot payload). */
export interface TagDrift {
  tagQuery: TagQuery;
  matchedCount: number;
  acceptedCount: number;
  newMatchCount: number;
  newMatches: TagDriftCase[];
  staleIds: string[];
  dismissedIds: string[];
  outdatedPins: OutdatedPin[];
  outdatedCount: number;
}

const jsonPost = (url: string, body: any) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Fetch the drift (new tag matches to review) for a tag-defined group. */
export async function fetchTagDrift(target: EntityKind, id: string): Promise<TagDrift | null> {
  const res = await fetch(`/api/${target}/${id}/tag-drift`);
  return res.ok ? res.json() : null;
}
/** Accept new tag matches into the group (empty ids = accept all current new matches). */
export async function acceptTagMatches(target: EntityKind, id: string, caseIds: string[] = []): Promise<TagDrift | null> {
  const res = await jsonPost(`/api/${target}/${id}/tag-accept`, { caseIds });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not add tag matches (${res.status}).`);
  return data;
}
/** Dismiss tag matches so they stop resurfacing as drift. */
export async function dismissTagMatches(target: EntityKind, id: string, caseIds: string[]): Promise<TagDrift | null> {
  const res = await jsonPost(`/api/${target}/${id}/tag-dismiss`, { caseIds });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not dismiss tag matches (${res.status}).`);
  return data;
}

/** A version node from a case's revision graph. */
export interface CaseRevision { revisionNo: number; revisionId?: string; changeSummary?: string; changeKind?: string; createdAt?: string }
/** Fetch a case's version history (newest-first list + which revision is current/HEAD). */
export async function fetchCaseRevisions(caseId: string): Promise<{ revisions: CaseRevision[]; currentRevision: number | null }> {
  const res = await fetch(`/api/cases/${caseId}/revisions`);
  return res.ok ? res.json() : { revisions: [], currentRevision: null };
}
/** Pin a case in a run/suite to a version (@vN), or pass null to follow latest. */
export async function setCasePin(target: 'runs' | 'suites' | 'plans', id: string, caseId: string, revisionNo: number | null): Promise<boolean> {
  const res = await jsonPost(`/api/${target}/${id}/case-pin`, { caseId, revisionNo });
  return res.ok;
}

/** One frozen revision snapshot (fields the diff compares). */
export interface RevisionSnapshot { revisionNo: number; title?: string; description?: string; preconditions?: string; steps?: Array<{ action?: string; expected?: string }> }
/** Fetch two case revisions to diff (a = older/pinned, b = newer/current). */
export async function fetchCaseDiff(caseId: string, aNo: number, bNo: number): Promise<{ a: RevisionSnapshot; b: RevisionSnapshot } | null> {
  const res = await fetch(`/api/cases/${caseId}/revisions/${aNo}/diff/${bNo}`);
  return res.ok ? res.json() : null;
}

/** Build the querystring for the server-side list search endpoints (text + tag include/exclude). */
export function buildListQuery(opts: { q?: string; tags?: string[]; notTags?: string[]; folderId?: string; tagMatch?: 'any' | 'all' }): string {
  const params = new URLSearchParams();
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  if (opts.tags?.length) params.set('tags', opts.tags.join(','));
  if (opts.notTags?.length) params.set('notTags', opts.notTags.join(','));
  if (opts.tagMatch) params.set('tagMatch', opts.tagMatch);
  if (opts.folderId) params.set('folderId', opts.folderId);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Bulk link/unlink cases to a suite in one request (server keeps dual fields in sync). When a
 *  tagQuery is given it is also persisted on the suite (definition.tagQuery) for drift detection. */
export async function linkSuiteCases(suiteId: string, add: string[], remove: string[], tagQuery?: TagQuery): Promise<number> {
  if (!add.length && !remove.length && !tagQuery) return 0;
  const res = await fetch(`/api/suites/${suiteId}/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add, remove, ...(tagQuery ? { tagQuery } : {}) }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to link cases.');
  return (await res.json()).changed || 0;
}

/** Fetch the shared tag catalog (name + color + usage count), newest/most-used first. */
export async function fetchTagCatalog(): Promise<TagCatalogEntry[]> {
  const res = await fetch('/api/tags');
  if (!res.ok) return [];
  return res.json();
}
