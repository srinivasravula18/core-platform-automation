/**
 * Object Repository (Phase 1) — the persistent, VERSIONED, append-only store of enterprise UI knowledge.
 *
 * Structure: Platform → Application → Module → Object → Control. Each control keeps a `current` snapshot and
 * an append-only `history`. Evidence is NEVER overwritten: when a control's verified locator/role/label
 * changes, the prior snapshot is pushed to history and a new version is minted. This is what makes regression
 * intelligence possible (a selector that changed between runs is a signal, not a silent overwrite).
 *
 * Backed by the shared in-memory `db` (persisted to disk by the storage layer, mirrored by the
 * `object_repository` table in schema.sql). Deterministic content hashing; timestamps are injectable so
 * tests are fully offline and reproducible.
 */
import { createHash } from 'crypto';
import { db } from '../../../shared/storage';

export interface RepoControl {
  semanticName: string;
  selector: string | null;
  selectorType: string | null;
  role: string | null;
  label: string | null;
  confidence: string | null;
  domHash: string | null;
  /** Content hash of the identity-bearing fields; drives version minting. */
  contentHash: string;
  version: number;
  lastVerified: string;
}

export interface RepoObjectRecord {
  key: string;
  platform: string;
  application: string;
  module: string;
  object: string;
  control: string;
  current: RepoControl;
  history: RepoControl[];
  createdAt: string;
  updatedAt: string;
}

export interface UpsertControlInput {
  platform?: string;
  application?: string | null;
  module?: string | null;
  object?: string | null;
  control: string; // the control's semantic name (required)
  selector?: string | null;
  selectorType?: string | null;
  role?: string | null;
  label?: string | null;
  confidence?: string | null;
  domHash?: string | null;
}

function slug(s: string | null | undefined): string {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '_';
}

export function objectRepositoryKey(i: { platform?: string; application?: string | null; module?: string | null; object?: string | null; control: string }): string {
  return [slug(i.platform || 'admin'), slug(i.application || 'none'), slug(i.module || 'none'), slug(i.object || 'none'), slug(i.control)].join('/');
}

/** Identity hash: only the fields that define "same control, same shape" (not timestamps/versions). */
function contentHashOf(i: UpsertControlInput): string {
  return createHash('sha1')
    .update(JSON.stringify({ selector: i.selector || '', selectorType: i.selectorType || '', role: i.role || '', label: i.label || '' }))
    .digest('hex');
}

/** Lazily bind to the shared persisted store (created on first use). */
function store(): RepoObjectRecord[] {
  if (!Array.isArray((db as any).objectRepository)) (db as any).objectRepository = [];
  return (db as any).objectRepository as RepoObjectRecord[];
}

/**
 * Upsert a control. If the identity hash is unchanged, only `lastVerified`/`updatedAt` are touched (no new
 * version). If it changed, the prior `current` is appended to `history` and a new version is minted.
 * `ts` is injectable for deterministic tests. Returns the (mutated) record.
 */
export function upsertControl(input: UpsertControlInput, ts: string = new Date().toISOString()): RepoObjectRecord {
  const key = objectRepositoryKey(input);
  const hash = contentHashOf(input);
  const snapshot = (version: number): RepoControl => ({
    semanticName: input.control,
    selector: input.selector ?? null,
    selectorType: input.selectorType ?? null,
    role: input.role ?? null,
    label: input.label ?? null,
    confidence: input.confidence ?? null,
    domHash: input.domHash ?? null,
    contentHash: hash,
    version,
    lastVerified: ts,
  });

  const arr = store();
  const existing = arr.find((r) => r.key === key);
  if (!existing) {
    const rec: RepoObjectRecord = {
      key,
      platform: input.platform || 'Admin',
      application: input.application || 'none',
      module: input.module || 'none',
      object: input.object || 'none',
      control: input.control,
      current: snapshot(1),
      history: [],
      createdAt: ts,
      updatedAt: ts,
    };
    arr.push(rec);
    return rec;
  }

  if (existing.current.contentHash === hash) {
    // Same shape — re-verification only. Touch timestamps; do NOT mint a version.
    existing.current.lastVerified = ts;
    existing.updatedAt = ts;
    return existing;
  }

  // Shape changed — append-only: preserve the prior snapshot, mint a new version.
  existing.history.push(existing.current);
  existing.current = snapshot(existing.current.version + 1);
  existing.updatedAt = ts;
  return existing;
}

export function getControl(key: string): RepoObjectRecord | null {
  return store().find((r) => r.key === key) || null;
}

export function listControls(filter: { platform?: string; application?: string; module?: string; object?: string } = {}): RepoObjectRecord[] {
  const f = {
    platform: filter.platform ? slug(filter.platform) : undefined,
    application: filter.application ? slug(filter.application) : undefined,
    module: filter.module ? slug(filter.module) : undefined,
    object: filter.object ? slug(filter.object) : undefined,
  };
  return store().filter((r) =>
    (!f.platform || slug(r.platform) === f.platform) &&
    (!f.application || slug(r.application) === f.application) &&
    (!f.module || slug(r.module) === f.module) &&
    (!f.object || slug(r.object) === f.object));
}

/** Full version lineage (history + current), oldest → newest. */
export function controlHistory(key: string): RepoControl[] {
  const rec = getControl(key);
  return rec ? [...rec.history, rec.current] : [];
}

/** Test-only: clear the backing store. */
export function _clearObjectRepository(): void {
  (db as any).objectRepository = [];
}
