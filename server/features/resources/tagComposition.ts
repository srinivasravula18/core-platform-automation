// Tag-native composition (Phase A1). A suite/plan/run can define its membership by a tag query
// (`definition.tagQuery`) instead of a hand-picked list. This module is the pure resolver + the
// review-gated drift computation: it turns a saved query into the set of matching cases and works
// out which matches the user has not yet reviewed. Membership itself (the reviewed "accepted" set)
// lives as each group's existing case links; versions live separately in `case_pins`. App-agnostic
// by construction — no product tag names appear here; everything is learned from row tags at runtime.

import { isEmptyTagQuery, matchesTagQuery, resolveTagQuery, type TagQuery } from '../../../core/shared/tagQuery';
export { isEmptyTagQuery, matchesTagQuery, resolveTagQuery, type TagQuery };

// How a suite/plan/run stores its tag-native composition inside the JSONB `definition` column.
// `dismissed` are case ids the user explicitly chose to ignore, so they stop resurfacing as drift.
export interface GroupDefinition { tagQuery?: TagQuery; dismissed?: string[] }

// Compare tags ignoring case and the leading @/# marker, so `sanity` matches a stored `@sanity`.
// Kept identical to routes.ts:tagKey and EntityLinker so matching is consistent end to end.
const tagKey = (t: any): string => String(t || '').trim().toLowerCase().replace(/^[@#]+/, '');

export function normalizeTagQuery(input: any): TagQuery {
  const arr = (v: any) => (Array.isArray(v) ? Array.from(new Set(v.map(tagKey).filter(Boolean))) : []);
  return { all: arr(input?.all), any: arr(input?.any), not: arr(input?.not) };
}

// Read+normalize the composition definition off a stored group row.
export function readGroupDefinition(group: any): GroupDefinition {
  const def = group?.definition && typeof group.definition === 'object' ? group.definition : {};
  return {
    tagQuery: normalizeTagQuery(def.tagQuery),
    dismissed: Array.isArray(def.dismissed) ? def.dismissed.map(String) : [],
  };
}

export interface DriftResult {
  matchedIds: string[];   // all cases matching the query right now
  acceptedIds: string[];  // the reviewed membership (what actually runs)
  dismissedIds: string[]; // explicitly ignored — never nags again unless un-dismissed
  newMatchIds: string[];  // matched − accepted − dismissed → the three-way notification
  staleIds: string[];     // accepted but no longer matching → optional prune prompt
}

// The review-gate: given what currently matches and what has been accepted/dismissed, work out the
// new matches the user should review. This is the single source of the notification-dot count.
export function computeDrift(opts: { matchedIds: string[]; acceptedIds: string[]; dismissedIds?: string[] }): DriftResult {
  const matched = new Set(opts.matchedIds.map(String));
  const accepted = new Set(opts.acceptedIds.map(String));
  const dismissed = new Set((opts.dismissedIds || []).map(String));
  const newMatchIds = [...matched].filter((id) => !accepted.has(id) && !dismissed.has(id));
  const staleIds = [...accepted].filter((id) => !matched.has(id));
  return { matchedIds: [...matched], acceptedIds: [...accepted], dismissedIds: [...dismissed], newMatchIds, staleIds };
}
