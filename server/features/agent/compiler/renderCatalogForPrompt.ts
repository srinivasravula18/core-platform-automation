/**
 * Target Catalog rendering (Phase 3) — the ONLY vocabulary of `target` names the plan LLM is allowed to use.
 * Built from the Evidence Graph, it lists verified-unique controls by their stable semanticName. The LLM
 * picks targets from this closed list; anything it invents will fail grounding (UNRESOLVED_SELECTOR), which
 * is the point — invention becomes an explicit error, never a silent hallucinated locator.
 */
import { isRequiredFieldNode, type EvidenceGraph } from '../graph/evidenceGraph';

export interface RenderCatalogOpts {
  /** Max entries to render (keeps the prompt bounded). */
  limit?: number;
}

/** Render the enumerated semantic-target catalog. Only verified-unique, locatable controls are offered. */
export function renderTargetCatalogForPrompt(graph: EvidenceGraph | null | undefined, opts: RenderCatalogOpts = {}): string {
  const limit = opts.limit ?? 200;
  const usable = (graph?.nodes || []).filter((n) => n.selector && n.uniqueness === true
    && n.confidence === 'verified-live' && n.provenance === 'LIVE_DOM');
  if (!usable.length) {
    return 'SEMANTIC TARGET CATALOG: (none available — discovery produced no verified-unique controls; do not invent targets).';
  }
  const shown = usable.slice(0, limit);
  const lines = shown.map((n) => {
    const role = n.role ? ` [${n.role}]` : '';
    const label = n.label ? ` "${n.label}"` : '';
    const meta = n.metadataRef ? ` (metadata: ${n.metadataRef})` : '';
    // Flag mandatory fields so the author fills EVERY required field of a create/submit flow, not a subset.
    const required = isRequiredFieldNode(n) ? ' (required)' : '';
    return `- ${n.semanticName}${role}${label}${required}${meta}`;
  });
  const omitted = usable.length - shown.length;
  const note = omitted > 0 ? `\n(+${omitted} more verified controls not shown; ask for a targeted re-discovery if you need one.)` : '';
  const requiredNote = shown.some((n) => isRequiredFieldNode(n))
    ? '\nFor a create/submit flow, FILL every field marked (required) before the save/create step — a partially filled form is rejected.'
    : '';
  return `SEMANTIC TARGET CATALOG (use ONLY these target names — never invent selectors, labels, roles, or URLs):\n${lines.join('\n')}${note}${requiredNote}`;
}
