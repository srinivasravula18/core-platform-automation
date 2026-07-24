/**
 * Lifecycle metadata model — the canonical "who/when" envelope for every persisted entity.
 *
 * The RECORD stores the LATEST lifecycle metadata (created/updated/deleted by+at, version) so the
 * UI can render "Last updated by John" without querying the audit log; the audit log (Phase 4)
 * remains the historical source of truth. Storage is flat columns / flat JSON fields; the API
 * contract exposes a nested `metadata` object composed by the repository mappers.
 *
 * Actors are DENORMALIZED (id + cached display name + kind) so "by Jane" / "by AI Agent" still
 * renders after a rename or user deletion, and non-human writes have first-class actors.
 */

export type ActorKind = 'user' | 'agent' | 'system';

export interface Actor {
  /** App user id, or the synthetic ids 'agent' / 'system'. */
  id: string;
  /** Cached display name at write time (rename/deletion-resilient). */
  name: string;
  kind: ActorKind;
}

/** Writes with no human request context (background jobs, schema seed). */
export const SYSTEM_ACTOR: Actor = { id: 'system', name: 'System', kind: 'system' };
/** Writes performed by the AI agent runtime on a user's behalf. */
export const AGENT_ACTOR: Actor = { id: 'agent', name: 'AI Agent', kind: 'agent' };

/** Build an Actor from a stored (id, name) pair; undefined when neither is present. */
export function actorFrom(id?: string | null, name?: string | null): Actor | undefined {
  const key = String(id || '').trim();
  const label = String(name || '').trim();
  if (!key && !label) return undefined;
  const kind: ActorKind = key === 'agent' ? 'agent' : key === 'system' ? 'system' : 'user';
  // Do NOT fall back to the raw id as a display name — a legacy row with no stored name should
  // render as just a timestamp (no "by <id>"), not an ugly user id. Agent/System keep their labels.
  return { id: key, name: label || (kind === 'agent' ? 'AI Agent' : kind === 'system' ? 'System' : ''), kind };
}

/**
 * The nested lifecycle envelope exposed on API responses. Future lifecycle fields
 * (approvedAt/By, archivedAt/By, reviewedAt/By, publishedAt/By, restoredAt/By) slot in here
 * with no schema redesign.
 */
export interface Metadata {
  createdAt?: string | null;
  createdBy?: Actor;
  updatedAt?: string | null;
  updatedBy?: Actor;
  deletedAt?: string | null;
  deletedBy?: Actor;
  version?: number;
}

/**
 * Compose the nested `metadata` object from a mapped row's flat fields. `row` is expected to carry
 * createdAt/updatedAt/deletedAt plus createdBy/createdByName/updatedBy/updatedByName/... and version.
 */
export function composeMetadata(row: any): Metadata {
  return {
    createdAt: row.createdAt ?? null,
    createdBy: actorFrom(row.createdBy, row.createdByName),
    updatedAt: row.updatedAt ?? null,
    updatedBy: actorFrom(row.updatedBy, row.updatedByName),
    deletedAt: row.deletedAt ?? null,
    deletedBy: actorFrom(row.deletedBy, row.deletedByName),
    version: typeof row.version === 'number' ? row.version : Number(row.version) || 1,
  };
}
