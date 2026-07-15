/**
 * Evidence Graph (Phase 1) — a graph VIEW that WRAPS the existing Selector Registry; it does NOT replace it.
 *
 * The Selector Registry (`run.selector_registry.verified_selectors`, produced by runSelectorRegistryPhase and
 * still the source of truth for locators) is preserved untouched. Each verified selector becomes an Evidence
 * Graph node that REFERENCES the registry entry by `selectorRef` (the VerifiedSelector.id) and binds to a
 * Metadata Graph node via `metadataRef`. Downstream, the Grounding Engine (Phase 3) resolves semantic targets
 * against this graph but always reads the actual locator back from the registry — so the registry stays
 * authoritative and nothing is duplicated as a second source of truth.
 *
 * Extensible: `evidenceKind` allows UI (Phase 1), plus API/DB/PERF/A11Y/LOG nodes in later phases, all on one
 * graph. Pure/read-only over the run — building the graph never mutates `run.selector_registry`.
 */
import type { FieldMeta, VerifiedSelector } from '../pipelineDelta';
import type { MetadataGraph } from './metadataGraph';
import { findMetadataByLabel } from './metadataGraph';

export type EvidenceKind = 'UI' | 'API' | 'DB' | 'PERF' | 'A11Y' | 'LOG';

export interface EvidenceNode {
  /** Stable deterministic id, e.g. 'evidence:UI:<selectorRef>'. */
  id: string;
  /** Stable semantic handle used by plans/grounding (e.g. 'ObjectsNavigation', 'NewButton'). */
  semanticName: string;
  evidenceKind: EvidenceKind;
  /** Reference INTO the preserved Selector Registry (VerifiedSelector.id). Never the locator's owner. */
  selectorRef: string | null;
  /** Reference into the Metadata Graph (object/field/tab), when a binding was found. */
  metadataRef: string | null;
  // Denormalized display/scope fields (copied for convenience; registry remains source of truth).
  platform?: string;
  application?: string | null;
  module?: string | null;
  page?: string | null;
  role?: string | null;
  label?: string | null;
  /** Mirror of the registry locator for display only (grounding re-reads the registry at resolve time). */
  selector?: string | null;
  selectorType?: string | null;
  confidence?: string | null;
  uniqueness?: boolean | null;
  provenance?: string | null;
  /** Input-field semantics carried from the registry for the Test Data Engine (fillable controls only). */
  fieldMeta?: FieldMeta | null;
  // Versioning/provenance fields (populated by the Object Repository as evidence accrues).
  domHash?: string | null;
  screenshotRef?: string | null;
  lastVerified?: string | null;
  version?: number;
  history?: unknown[];
}

export interface EvidenceEdge {
  from: string;
  to: string;
  /** 'binds' evidence→metadata; 'covers' evidence→coverage; 'calls' UI→API; 'derives' node→node. */
  kind: 'binds' | 'covers' | 'calls' | 'derives';
}

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  /** Name of the run.* field that remains the authoritative selector store. */
  selectorRegistryRef: 'selector_registry';
  index?: Record<string, EvidenceNode>;
}

/** PascalCase semantic handle from a human label; stable + deterministic. Falls back to role+ref. */
function semanticNameFrom(label: string | null | undefined, role: string | null | undefined, ref: string): string {
  const base = String(label || '').trim();
  if (base) {
    const pascal = base.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    if (pascal) return pascal;
  }
  const r = String(role || 'control').replace(/[^a-zA-Z0-9]+/g, '');
  return `${r.charAt(0).toUpperCase()}${r.slice(1)}_${ref}`;
}

export interface BuildEvidenceGraphOpts {
  metadata?: MetadataGraph | null;
  platform?: string;
  application?: string | null;
  module?: string | null;
}

/**
 * Build the Evidence Graph from a run by wrapping its verified selectors. Read-only: does not touch
 * `run.selector_registry`. Binds each UI node to a metadata node when a name match exists (never fuzzy).
 */
export function buildEvidenceGraphFromRun(run: any, opts: BuildEvidenceGraphOpts = {}): EvidenceGraph {
  const verified: VerifiedSelector[] = Array.isArray(run?.selector_registry?.verified_selectors)
    ? run.selector_registry.verified_selectors
    : [];
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const seen = new Set<string>();

  for (const vs of verified) {
    if (!vs || !vs.id || !vs.verified || !vs.selector || vs.confidence !== 'verified-live'
      || vs.provenance !== 'LIVE_DOM' || vs.uniqueness !== true || vs.visibility !== true) continue;
    const id = `evidence:UI:${vs.id}`;
    const semanticName = uniqueSemantic(seen, semanticNameFrom(vs.label, vs.role, vs.id));
    const metaNode = opts.metadata ? findMetadataByLabel(opts.metadata, vs.label || '', ['field', 'tab', 'object']) : null;
    const node: EvidenceNode = {
      id,
      semanticName,
      evidenceKind: 'UI',
      selectorRef: vs.id,
      metadataRef: metaNode ? metaNode.id : null,
      platform: opts.platform,
      application: opts.application ?? null,
      module: opts.module ?? null,
      page: opts.module ?? null,
      role: vs.role ?? null,
      label: vs.label ?? null,
      selector: vs.selector ?? null,
      selectorType: vs.selectorType ?? null,
      confidence: (vs.confidence as any) ?? null,
      uniqueness: vs.uniqueness ?? null,
      provenance: (vs.provenance as any) ?? null,
      fieldMeta: vs.fieldMeta ?? null,
      domHash: null,
      screenshotRef: null,
      lastVerified: null,
      version: 1,
      history: [],
    };
    nodes.push(node);
    if (metaNode) edges.push({ from: id, to: metaNode.id, kind: 'binds' });
  }

  return indexEvidenceGraph({ nodes, edges, selectorRegistryRef: 'selector_registry' });
}

/** Ensure semantic names are unique within a graph (append -2, -3, … on collision). */
function uniqueSemantic(seen: Set<string>, name: string): string {
  if (!seen.has(name)) { seen.add(name); return name; }
  let i = 2;
  while (seen.has(`${name}_${i}`)) i += 1;
  const out = `${name}_${i}`;
  seen.add(out);
  return out;
}

export function indexEvidenceGraph(g: EvidenceGraph): EvidenceGraph {
  const index: Record<string, EvidenceNode> = {};
  for (const n of g.nodes) index[n.id] = n;
  return { ...g, index };
}

export function getEvidenceNode(g: EvidenceGraph, id: string): EvidenceNode | null {
  return (g.index || indexEvidenceGraph(g).index!)[id] || null;
}

export function evidenceBySemanticName(g: EvidenceGraph, name: string): EvidenceNode[] {
  const q = String(name || '').trim().toLowerCase();
  return g.nodes.filter((n) => n.semanticName.toLowerCase() === q);
}

export function evidenceBySelectorRef(g: EvidenceGraph, selectorRef: string): EvidenceNode | null {
  return g.nodes.find((n) => n.selectorRef === selectorRef) || null;
}

export function evidenceForMetadata(g: EvidenceGraph, metadataRef: string): EvidenceNode[] {
  return g.nodes.filter((n) => n.metadataRef === metadataRef);
}
