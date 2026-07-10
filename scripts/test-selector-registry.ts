/**
 * Integration + regression tests for the Selector Registry promotion fix.
 * Proves the lineage: verified DOM elements → Selector Registry records → typed verified_selectors
 * → prompt block, and that the registry is NEVER empty when verified DOM exists.
 *   npx tsx scripts/test-selector-registry.ts    (or: npm run test:selectors)
 * Pure — no browser/network/DB.
 */
import { runSelectorRegistryPhase, renderSelectorRegistryForPrompt } from '../server/features/agent/pipelineDelta';
import { getRunRegistry } from '../server/features/agent/evidence/registry';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** Build a VerifiedElement-shaped DOM record (mirrors domExplorer.VerifiedElement). */
function vEl(i: number, status: 'verified' | 'not_unique' | 'broken' = 'verified') {
  return {
    id: `el_${i}_button`, tag: 'button', role: 'button',
    name: `Action ${i}`, text: `Action ${i}`, aria_label: `Action ${i}`,
    placeholder: null, input_name: null, data_field: null, element_id: null,
    type: null, value: null, options: [], href: null, tooltip: null, interactive: true,
    resolved_selector: `button[aria-label="Action ${i}"]`,
    selector_strategy: 'aria-label',
    fallback_selector: `text="Action ${i}"`,
    unique: status === 'verified', visible: true, status,
    state: { disabled: false, readonly: false, required: false },
  };
}

// ---------------------------------------------------------------------------
console.log('DOM → Selector Registry promotion (metadata SKIPPED — the confirmed loss case)');
{
  const elements = [
    ...Array.from({ length: 158 }, (_, i) => vEl(i, 'verified')),
    vEl(900, 'not_unique'), // ambiguous → kept for diagnostics, withheld from workers
    vEl(901, 'broken'),     // broken → excluded entirely
  ];
  const run: any = { id: 'run-A', dom_exploration: { url: 'http://x', elements }, inspection_contexts: [] };
  const registry = runSelectorRegistryPhase({ run, onPhase: () => {} });

  ok(registry.coverage.total_elements >= 158, `registry not empty: total_elements=${registry.coverage.total_elements} (>=158)`);
  ok(registry.coverage.verified >= 158, `verified count promoted: ${registry.coverage.verified} (>=158)`);
  // promoted_from_dom = all DOM-sourced records = 158 verified + 1 not_unique (diagnostics); broken excluded.
  eq(registry.coverage.promoted_from_dom, 159, 'promoted_from_dom == 159 (158 verified + 1 not_unique diagnostics)');
  ok(!!run.selector_registry, 'run.selector_registry assigned');
  ok(Array.isArray(registry.verified_selectors), 'typed verified_selectors array exists');

  // Structured internal contract: every required canonical field present.
  const sample = registry.verified_selectors.find((s: any) => s.verified);
  const required = ['id','elementType','role','label','selector','selectorType','verified','verificationStatus','confidence','provenance','visibility','uniqueness','sourceEvidenceId'];
  ok(!!sample, 'a verified structured selector exists');
  for (const f of required) ok(sample && f in sample, `structured selector has field: ${f}`);
  eq(sample?.provenance, 'LIVE_DOM', 'promoted selector provenance = LIVE_DOM');
  eq(sample?.confidence, 'verified-live', 'promoted selector confidence = verified-live');
  eq(sample?.sourceEvidenceId, 'dom', 'promoted selector sourceEvidenceId = dom');
  eq(sample?.elementType, 'button', 'elementType carried from DOM tag');
  eq(sample?.uniqueness, true, 'uniqueness carried from DOM');

  // not_unique kept as diagnostics, clearly marked, NOT verified.
  const amb = registry.verified_selectors.find((s: any) => s.verificationStatus === 'not_unique');
  ok(!!amb, 'not_unique selector retained for diagnostics');
  eq(amb?.verified, false, 'not_unique selector is NOT verified (withheld from workers)');
  // broken never promoted.
  ok(!registry.verified_selectors.some((s: any) => s.verificationStatus === 'broken'), 'broken selector excluded entirely');

  // Backward compatibility: legacy `selectors` map + fields still present.
  const legacy = Object.values(registry.selectors)[0] as any;
  for (const f of ['proof_id','primary_selector','fallback_selector','verified','evidence_type','confidence']) ok(f in legacy, `legacy record retains field: ${f}`);

  // Evidence Registry (Phase A) received the selectors.
  const ev = getRunRegistry(run).get('selector_registry');
  eq(ev?.status, 'present', 'Evidence Registry: selector_registry status present');
  ok((ev?.artifactCount ?? 0) >= 158, `Evidence Registry artifactCount=${ev?.artifactCount} (>=158)`);

  // Prompt block: structured, non-empty, prefers verified, marks withheld.
  const block = renderSelectorRegistryForPrompt(registry);
  ok(block.includes('VERIFIED SELECTORS'), 'prompt renders a Verified Selectors block');
  ok(block.includes('button[aria-label="Action 0"]'), 'prompt block contains a real verified selector');
  ok(block.includes('Confidence: verified-live'), 'prompt block shows confidence');
  ok(block.includes('Provenance: LIVE_DOM'), 'prompt block shows provenance');
  ok(/PREFER these EXACT selectors/.test(block), 'prompt instructs workers to prefer verified selectors over guessing');
  ok(block.includes('diagnostics only'), 'prompt notes withheld unverified selectors');
  ok(!block.includes('Action 900'), 'not_unique (ambiguous) selector is NOT exposed in the prompt');
}

// ---------------------------------------------------------------------------
console.log('Regression: registry is NEVER empty when verified DOM exists');
{
  const run: any = { id: 'run-B', dom_exploration: { url: 'http://x', elements: [vEl(1, 'verified')] }, inspection_contexts: [] };
  const registry = runSelectorRegistryPhase({ run, onPhase: () => {} });
  ok(registry.coverage.total_elements > 0, 'single verified DOM element yields a non-empty registry');
  ok(renderSelectorRegistryForPrompt(registry).length > 0, 'non-empty prompt block for a single verified element');
}

// ---------------------------------------------------------------------------
console.log('Backward compatibility: metadata path still produces field records');
{
  // A metadata field with no DOM match must still mint its record (existing behavior), and dom
  // promotion must not disturb it.
  const run: any = {
    id: 'run-C',
    metadata_map: { objects: [{ api_name: 'Account', fields: [{ api_name: 'Industry', label: 'Industry', readonly: false, required: false }] }] },
    dom_exploration: { url: 'http://x', elements: [vEl(5, 'verified')] },
    inspection_contexts: [],
  };
  const registry = runSelectorRegistryPhase({ run, onPhase: () => {} });
  ok('Industry_field' in registry.selectors, 'metadata field record still created (backward compatible)');
  ok(registry.coverage.total_elements >= 2, 'registry holds both the metadata field AND the promoted DOM selector');
  ok(registry.unresolvable.some((u: any) => u.metadata_api_name === 'Industry'), 'unmatched metadata field still reported as unresolvable');
}

// ---------------------------------------------------------------------------
console.log('Dedup: a DOM element already represented by a metadata selector is not double-added');
{
  // Metadata field whose domMatch resolves to the SAME selector as a DOM element → single record.
  const shared = vEl(7, 'verified');
  const run: any = {
    id: 'run-D',
    metadata_map: { objects: [{ api_name: 'X', fields: [{ api_name: 'Action 7', label: 'Action 7', readonly: false, required: false }] }] },
    dom_exploration: { url: 'http://x', elements: [shared] },
    inspection_contexts: [],
  };
  const registry = runSelectorRegistryPhase({ run, onPhase: () => {} });
  const withSel = registry.verified_selectors.filter((s: any) => s.selector === shared.resolved_selector);
  ok(withSel.length === 1, `selector ${shared.resolved_selector} represented exactly once (got ${withSel.length})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
