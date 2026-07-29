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
  const renderLine = (n: typeof shown[number]) => {
    const role = n.role ? ` [${n.role}]` : '';
    const label = n.label ? ` "${n.label}"` : '';
    const meta = n.metadataRef ? ` (metadata: ${n.metadataRef})` : '';
    const required = isRequiredFieldNode(n) ? ' (required)' : '';
    // Observed live value/checked helps the author pick the right assert (and its expected value) — state-model.
    const observed = (n.fieldMeta as any)?.observed;
    const obs = observed && (observed.value != null || observed.checked != null)
      ? ` (observed: ${observed.checked != null ? `checked=${observed.checked}` : `value=${JSON.stringify(String(observed.value)).slice(0, 40)}`})` : '';
    const dataRow = n.isDataInstance ? ' [DATA ROW — ephemeral; do NOT assert this specific value unless THIS test created it]' : '';
    return `- ${n.semanticName}${role}${label}${required}${obs}${meta}${dataRow}`;
  };
  // State-model: page/list controls exist at rest; form controls only exist AFTER the create/edit opener is
  // clicked. Grouping them stops the author from asserting a modal field/heading on the list (a top failure).
  const pageNodes = shown.filter((n) => (n.stateTag ?? 'page') !== 'form');
  const formNodes = shown.filter((n) => n.stateTag === 'form');
  const sections: string[] = [];
  sections.push(`PAGE / LIST CONTROLS (present at rest, before opening any form):\n${pageNodes.map(renderLine).join('\n') || '- (none)'}`);
  if (formNodes.length) {
    sections.push(`CONTROLS INSIDE THE CREATE/EDIT FORM (these EXIST ONLY AFTER you click the New/Add/Create opener — a step targeting one of these MUST come after opening the form; never assert them on the list):\n${formNodes.map(renderLine).join('\n')}`);
  }
  const omitted = usable.length - shown.length;
  const note = omitted > 0 ? `\n(+${omitted} more verified controls not shown; ask for a targeted re-discovery if you need one.)` : '';
  const requiredNote = shown.some((n) => isRequiredFieldNode(n))
    ? '\nFor a create/submit flow, FILL every field marked (required) before the save/create step — a partially filled form is rejected.'
    : '';
  return `SEMANTIC TARGET CATALOG (use ONLY these target names — never invent selectors, labels, roles, or URLs):\n${sections.join('\n\n')}${note}${requiredNote}`;
}
