/**
 * API evidence fold-in (Phase 6) — projects API endpoints (from the api-intelligence subsystem) into the SAME
 * Evidence Graph as UI controls, as first-class `evidenceKind: 'API'` nodes. This composes api-intelligence
 * (it is not rewritten): discovered endpoints become graph nodes that can bind to metadata objects and link
 * to the UI actions that call them, so one graph carries UI + API evidence for coverage and regression.
 */
import type { ApiEndpoint } from '../../api-intelligence/types';
import type { EvidenceGraph, EvidenceNode } from './evidenceGraph';
import { indexEvidenceGraph } from './evidenceGraph';
import type { MetadataGraph } from './metadataGraph';
import { findMetadataByLabel } from './metadataGraph';

function slug(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

/** Guess the object a path targets (last non-parameter segment), for metadata binding. */
function objectFromPath(path: string): string {
  const segs = String(path || '').split('/').filter((s) => s && !s.startsWith('{') && !s.startsWith(':'));
  return segs.length ? segs[segs.length - 1] : '';
}

export interface MergeApiOpts { metadata?: MetadataGraph | null; platform?: string; application?: string | null }

/** Build API evidence nodes from endpoints (does not mutate its inputs). */
export function apiNodesFromEndpoints(endpoints: ApiEndpoint[], opts: MergeApiOpts = {}): EvidenceNode[] {
  const nodes: EvidenceNode[] = [];
  for (const ep of endpoints || []) {
    if (!ep || !ep.method || !ep.path) continue;
    const semanticName = `Api_${ep.method}_${slug(ep.path)}`;
    const obj = objectFromPath(ep.path);
    // REST paths are usually plural (/accounts); metadata objects are singular (account). Try exact, then
    // a conservative singular fallback (strip one trailing 's'). Still exact matching — never fuzzy.
    let meta = opts.metadata && obj ? findMetadataByLabel(opts.metadata, obj, ['object']) : null;
    if (!meta && opts.metadata && obj.length > 1 && obj.endsWith('s')) {
      meta = findMetadataByLabel(opts.metadata, obj.slice(0, -1), ['object']);
    }
    nodes.push({
      id: `evidence:API:${ep.method} ${ep.path}`,
      semanticName,
      evidenceKind: 'API',
      selectorRef: null,
      metadataRef: meta ? meta.id : null,
      platform: opts.platform,
      application: opts.application ?? null,
      module: null,
      page: null,
      role: null,
      label: `${ep.method} ${ep.path}`,
      selector: null,
      selectorType: null,
      confidence: 'verified-live',
      uniqueness: true,
      provenance: 'API',
      domHash: null,
      screenshotRef: null,
      lastVerified: null,
      version: 1,
      history: [],
    });
  }
  return nodes;
}

/**
 * Merge API endpoints into an existing Evidence Graph, binding API nodes to metadata objects and linking each
 * UI node that shares that object metadata to the API node with a 'calls' edge. Returns a NEW graph.
 */
export function mergeApiEvidence(graph: EvidenceGraph, endpoints: ApiEndpoint[], opts: MergeApiOpts = {}): EvidenceGraph {
  const apiNodes = apiNodesFromEndpoints(endpoints, opts);
  const nodes = [...graph.nodes, ...apiNodes];
  const edges = [...graph.edges];
  for (const api of apiNodes) {
    if (api.metadataRef) {
      // UI controls bound to the same metadata object plausibly call this endpoint.
      for (const ui of graph.nodes) {
        if (ui.evidenceKind === 'UI' && ui.metadataRef && ui.metadataRef.startsWith('object:') && ui.metadataRef === api.metadataRef) {
          edges.push({ from: ui.id, to: api.id, kind: 'calls' });
        }
      }
      edges.push({ from: api.id, to: api.metadataRef, kind: 'binds' });
    }
  }
  return indexEvidenceGraph({ nodes, edges, selectorRegistryRef: graph.selectorRegistryRef });
}
