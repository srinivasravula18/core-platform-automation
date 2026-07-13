/**
 * Evidence Registry (Impl-Phase A of the Evidence-Driven Context Architecture).
 *
 * A single, typed, per-run record of WHAT evidence exists, from WHERE, at what CONFIDENCE, and in
 * what STATE. Before this, evidence lived scattered across ad-hoc, loosely-typed `run.*` fields
 * (`run.dom_exploration`, `run.mcp_dom_facts`, `run.selector_registry`, ...) with no shared
 * contract — so "what do we actually know, and how sure are we?" could not be answered in one
 * place, and each downstream consumer re-derived trust informally.
 *
 * DESIGN — additive and non-destructive:
 *  - The registry stores METADATA about evidence, never the payloads. Producers keep writing their
 *    existing `run.*` fields exactly as before; the registry records a `payloadRef` (the name of
 *    that field) plus derived counts/estimates. Nothing that reads `run.*` today is affected.
 *  - The registry is persisted as a plain snapshot on `run.evidence_registry` (a serializable
 *    object, not a live class), so JSON persistence of the run is unaffected.
 *  - Recording is best-effort at the call site: a failure to record must never break the pipeline.
 *
 * This is a leaf module: it imports only `./provenance`. Nothing imports it until a call site
 * opts in (pipelineDelta.ts producers in Phase A; gates/WorkerContext in later phases).
 */

import { PROVENANCE, normalizeConfidence, type Provenance, type EvidenceConfidence } from './provenance';

/** The kinds of evidence the pipeline produces. */
export type EvidenceType =
  | 'repository'
  | 'metadata'
  | 'inspection'
  | 'dom'
  | 'selector'
  | 'requirement'
  | 'coverage'
  | 'execution'
  // API Intelligence (Phase A+): a real executed API call ('api') and a diff vs a stored baseline
  // ('regression'). Payloads are stored REDACTED on the run object; this remains metadata-only.
  | 'api'
  | 'regression'
  // Evidence-Graph Phase 2: the Metadata + Evidence graph views built over existing discovery (metadata-only
  // reference; the graphs live on run.metadata_graph / run.evidence_graph and wrap the Selector Registry).
  | 'graph';

/** Lifecycle state of an evidence record. */
export type EvidenceStatus = 'present' | 'degraded' | 'missing' | 'failed';

/** Whether the evidence has passed a validation gate yet (Phase B consumes this). */
export type ValidationState = 'unvalidated' | 'passed' | 'failed';

export interface EvidenceRecord {
  /** Stable id within a run (also the upsert key). Conventionally equals the payload field role. */
  id: string;
  type: EvidenceType;
  status: EvidenceStatus;
  confidence: EvidenceConfidence;
  source: Provenance;
  /** Which phase/agent produced this. */
  producer: string;
  /** ISO timestamp of the most recent record()/update. */
  timestamp: string;
  /** Ids of other evidence records this one depends on (e.g. dom depends on inspection). */
  dependencies: string[];
  /** Rough token cost of the underlying payload, for the Phase-C budget manager. */
  tokenEstimate: number;
  /** How many artifacts the payload contains (elements, objects, selectors, ...). */
  artifactCount: number;
  validationState: ValidationState;
  /** Name of the `run.*` field holding the actual payload — a reference, never a copy. */
  payloadRef: string;
}

export interface EvidenceRegistrySnapshot {
  version: string;
  records: EvidenceRecord[];
}

/** Fields a caller supplies to record(); the rest are defaulted/derived. */
export interface EvidenceInput {
  id: string;
  type: EvidenceType;
  status: EvidenceStatus;
  source: Provenance;
  confidence: EvidenceConfidence;
  producer: string;
  /** The actual payload — used ONLY to derive tokenEstimate/artifactCount; never stored. */
  payload?: unknown;
  /** Explicit artifact count; if omitted, derived from payload shape. */
  artifactCount?: number;
  /** Explicit token estimate; if omitted, derived from payload. */
  tokenEstimate?: number;
  dependencies?: string[];
  validationState?: ValidationState;
  /** Name of the run.* field holding the payload; defaults to `id`. */
  payloadRef?: string;
}

const SNAPSHOT_VERSION = '1';

/**
 * Cheap, dependency-free token estimator (~4 chars/token heuristic). Deterministic and safe on
 * circular/huge objects. Centralized here so the Phase-C PromptBudget manager can reuse it.
 */
export function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) || '';
    } catch {
      text = String(value);
    }
  }
  return Math.ceil(text.length / 4);
}

/** Best-effort artifact count from common payload shapes. */
function deriveArtifactCount(payload: unknown): number {
  if (payload == null) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['elements', 'objects', 'selectors', 'actionables', 'items', 'records']) {
      const v = obj[key];
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
    }
    return Object.keys(obj).length;
  }
  return 1;
}

/**
 * Typed view over a run's evidence snapshot. Construct with an existing snapshot (from
 * `run.evidence_registry`) or empty. Query methods are what Phase B/C consumers will use.
 */
export class EvidenceRegistry {
  private records = new Map<string, EvidenceRecord>();

  constructor(snapshot?: EvidenceRegistrySnapshot | null) {
    if (snapshot?.records?.length) {
      for (const rec of snapshot.records) {
        if (rec && typeof rec.id === 'string') this.records.set(rec.id, rec);
      }
    }
  }

  /** Upsert an evidence record by id. Enforces the static-never-verified-live invariant. */
  record(input: EvidenceInput): EvidenceRecord {
    const confidence = normalizeConfidence(input.source, input.confidence);
    const rec: EvidenceRecord = {
      id: input.id,
      type: input.type,
      status: input.status,
      confidence,
      source: input.source,
      producer: input.producer,
      timestamp: new Date().toISOString(),
      dependencies: input.dependencies ? [...input.dependencies] : [],
      tokenEstimate: input.tokenEstimate ?? estimateTokens(input.payload),
      artifactCount: input.artifactCount ?? deriveArtifactCount(input.payload),
      validationState: input.validationState ?? 'unvalidated',
      payloadRef: input.payloadRef ?? input.id,
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.get(id);
  }

  getByType(type: EvidenceType): EvidenceRecord[] {
    return this.all().filter((r) => r.type === type);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()];
  }

  /** A compact per-run summary for diagnostics/logging. */
  summary(): {
    total: number;
    present: number;
    degraded: number;
    missing: number;
    failed: number;
    liveSources: number;
    staticSources: number;
    totalTokenEstimate: number;
  } {
    const all = this.all();
    return {
      total: all.length,
      present: all.filter((r) => r.status === 'present').length,
      degraded: all.filter((r) => r.status === 'degraded').length,
      missing: all.filter((r) => r.status === 'missing').length,
      failed: all.filter((r) => r.status === 'failed').length,
      liveSources: all.filter((r) => r.source !== PROVENANCE.STATIC_SOURCE).length,
      staticSources: all.filter((r) => r.source === PROVENANCE.STATIC_SOURCE).length,
      totalTokenEstimate: all.reduce((sum, r) => sum + (r.tokenEstimate || 0), 0),
    };
  }

  /** Plain, JSON-serializable snapshot for persistence on `run.evidence_registry`. */
  toJSON(): EvidenceRegistrySnapshot {
    return { version: SNAPSHOT_VERSION, records: this.all() };
  }
}

/**
 * Hydrate a run's registry from its snapshot (or empty). Read-only helper for consumers.
 * Mutations must be written back via `recordEvidence` (which persists the snapshot).
 */
export function getRunRegistry(run: any): EvidenceRegistry {
  return new EvidenceRegistry(run?.evidence_registry ?? null);
}

/**
 * The one-line integration point for producers: hydrate → record → persist snapshot back onto the
 * run. Best-effort by contract — callers should still guard, but this never throws for normal
 * inputs. Returns the created record (or null if something unexpected went wrong).
 */
export function recordEvidence(run: any, input: EvidenceInput): EvidenceRecord | null {
  try {
    if (!run || typeof run !== 'object') return null;
    const registry = getRunRegistry(run);
    const rec = registry.record(input);
    run.evidence_registry = registry.toJSON();
    return rec;
  } catch {
    return null;
  }
}
