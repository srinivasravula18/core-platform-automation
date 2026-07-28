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

/** Build the querystring for the server-side list search endpoints (Phase 2). */
export function buildListQuery(opts: { q?: string; tags?: string[]; folderId?: string; tagMatch?: 'any' | 'all' }): string {
  const params = new URLSearchParams();
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  if (opts.tags?.length) params.set('tags', opts.tags.join(','));
  if (opts.tagMatch) params.set('tagMatch', opts.tagMatch);
  if (opts.folderId) params.set('folderId', opts.folderId);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Bulk link/unlink cases to a suite in one request (server keeps dual fields in sync). */
export async function linkSuiteCases(suiteId: string, add: string[], remove: string[]): Promise<number> {
  if (!add.length && !remove.length) return 0;
  const res = await fetch(`/api/suites/${suiteId}/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add, remove }),
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
