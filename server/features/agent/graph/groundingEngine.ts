/**
 * Grounding Engine (Phase 3) — the single, backend-agnostic resolver from a semantic target to a VERIFIED
 * locator. Every Compiler uses this; none resolves selectors on its own. It reads the Evidence Graph to find
 * the node, then re-reads the AUTHORITATIVE locator from the preserved Selector Registry (via selectorRef),
 * so the registry stays the source of truth and nothing is duplicated.
 *
 * It never infers, concatenates, or guesses. If a target is missing → UNRESOLVED_SELECTOR. If it is present
 * but not uniquely verified → AMBIGUOUS_SELECTOR. The compiler turns either into an explicit diagnostic
 * (and the orchestrator can request a targeted re-discovery) instead of emitting a `.first()` guess.
 */
import type { EvidenceGraph, EvidenceNode } from './evidenceGraph';

export type GroundStatus = 'RESOLVED' | 'AMBIGUOUS_SELECTOR' | 'UNRESOLVED_SELECTOR';

export interface GroundResult {
  status: GroundStatus;
  target: string;
  node: EvidenceNode | null;
  /** Authoritative locator (re-read from the Selector Registry when available). */
  selector: string | null;
  selectorType: string | null;
  reason?: string;
}

/** Re-read the authoritative locator for a selectorRef from the preserved Selector Registry. */
function registrySelector(run: any, selectorRef: string | null): { selector: string | null; selectorType: string | null; trusted: boolean } | null {
  if (!selectorRef || !Array.isArray(run?.selector_registry?.verified_selectors)) return null;
  const vs = run.selector_registry.verified_selectors.find((s: any) => s?.id === selectorRef);
  if (!vs) return null;
  return {
    selector: vs.selector ?? null,
    selectorType: vs.selectorType ?? null,
    trusted: vs.verified === true && vs.confidence === 'verified-live' && vs.provenance === 'LIVE_DOM'
      && vs.uniqueness === true && vs.visibility === true,
  };
}

/**
 * Find candidate evidence nodes for a target, most-specific first: exact semanticName → node id →
 * selectorRef → exact label. Label match is a convenience for plans that reference a control by its visible
 * label; it is still EXACT (never fuzzy) and multiple label matches surface as AMBIGUOUS.
 */
function candidates(graph: EvidenceGraph, target: string): EvidenceNode[] {
  const q = String(target || '').trim().toLowerCase();
  if (!q) return [];
  const byName = graph.nodes.filter((n) => n.semanticName.toLowerCase() === q);
  if (byName.length) return byName;
  const byId = graph.nodes.filter((n) => n.id.toLowerCase() === q);
  if (byId.length) return byId;
  const byRef = graph.nodes.filter((n) => (n.selectorRef || '').toLowerCase() === q);
  if (byRef.length) return byRef;
  return graph.nodes.filter((n) => (n.label || '').trim().toLowerCase() === q);
}

/**
 * Resolve a semantic target against the Evidence Graph + Selector Registry. Deterministic; never guesses.
 */
export function resolveTarget(target: string, graph: EvidenceGraph, run?: any): GroundResult {
  const found = candidates(graph, target);
  if (found.length === 0) {
    return { status: 'UNRESOLVED_SELECTOR', target, node: null, selector: null, selectorType: null,
      reason: 'No verified evidence node matches this semantic target.' };
  }
  if (found.length > 1) {
    return { status: 'AMBIGUOUS_SELECTOR', target, node: null, selector: null, selectorType: null,
      reason: `Semantic target matched ${found.length} evidence nodes.` };
  }
  const node = found[0];
  // A node whose registry entry is not uniquely verified is ambiguous — never emit a positional guess.
  if (node.uniqueness !== true) {
    return { status: 'AMBIGUOUS_SELECTOR', target, node, selector: null, selectorType: null,
      reason: 'Matched a control whose selector was not proven unique in the live DOM.' };
  }
  if (node.confidence !== 'verified-live' || node.provenance !== 'LIVE_DOM') {
    return { status: 'UNRESOLVED_SELECTOR', target, node, selector: null, selectorType: null,
      reason: 'Matched evidence is not trusted live DOM proof.' };
  }
  const reg = registrySelector(run, node.selectorRef);
  if (reg && !reg.trusted) {
    return { status: 'UNRESOLVED_SELECTOR', target, node, selector: null, selectorType: null,
      reason: 'The authoritative selector registry no longer marks this control as verified, visible, and unique.' };
  }
  const selector = reg?.selector ?? node.selector ?? null;
  const selectorType = reg?.selectorType ?? node.selectorType ?? null;
  if (!selector) {
    return { status: 'UNRESOLVED_SELECTOR', target, node, selector: null, selectorType: null,
      reason: 'Evidence node has no concrete verified locator.' };
  }
  return { status: 'RESOLVED', target, node, selector, selectorType };
}
