/**
 * Evidence Graph tests (Phase 1). Proves the graph WRAPS the preserved Selector Registry: nodes reference
 * registry entries by selectorRef (never copy them as the source of truth), bind to metadata, and never
 * mutate run.selector_registry.
 *   npx tsx scripts/test-evidence-graph.ts   (npm run test:evidence-graph)
 */
import { buildMetadataGraph } from '../server/features/agent/graph/metadataGraph';
import {
  buildEvidenceGraphFromRun, getEvidenceNode, evidenceBySelectorRef, evidenceForMetadata, evidenceBySemanticName,
} from '../server/features/agent/graph/evidenceGraph';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const metadata = buildMetadataGraph({ objects: [{ apiName: 'account', label: 'Account', fields: [{ apiName: 'name', label: 'Name' }] }] });

// Minimal VerifiedSelector-shaped registry entries (as runSelectorRegistryPhase would produce).
const vs = (id: string, role: string, label: string, selector: string, selectorType: string, uniqueness: boolean) => ({
  id, elementType: role, role, label, selector, selectorType, verified: true,
  verificationStatus: uniqueness ? 'verified' : 'not_unique', confidence: 'verified-live',
  provenance: 'LIVE_DOM', visibility: true, uniqueness, sourceEvidenceId: 'dom', fallbackSelector: null,
});

const run: any = {
  selector_registry: {
    verified_selectors: [
      vs('sel_new', 'button', 'New', '[data-testid="new_btn"]', 'testid', true),
      vs('sel_name', 'textbox', 'Name', '#name', 'css', true),
      vs('sel_objects', 'button', 'Objects', 'getByRole(button,Objects)', 'role', true),
      { ...vs('sel_observed', 'button', 'Observed', '#observed', 'css', true), verified: false, confidence: 'inferred', uniqueness: null, sourceEvidenceId: 'inspection' },
      { ...vs('sel_static', 'button', 'Static', '#static', 'css', true), confidence: 'verified-static', provenance: 'STATIC_SOURCE' },
    ],
  },
};

function main() {
  const before = JSON.stringify(run.selector_registry);
  const g = buildEvidenceGraphFromRun(run, { metadata, platform: 'Admin', module: 'objects' });

  console.log('wrap, not replace');
  eq(g.selectorRegistryRef, 'selector_registry', 'graph points back at the registry as source of truth');
  eq(JSON.stringify(run.selector_registry), before, 'building the graph does NOT mutate selector_registry');
  eq(g.nodes.length, 3, 'one node per verified selector');
  ok(!evidenceBySelectorRef(g, 'sel_observed') && !evidenceBySelectorRef(g, 'sel_static'), 'graph excludes inferred and static selectors');

  console.log('reference by selectorRef (never own the locator)');
  const n = evidenceBySelectorRef(g, 'sel_new');
  ok(!!n && n.selectorRef === 'sel_new', 'node references registry entry by id');
  eq(n?.semanticName, 'New', 'semantic name derived from label');
  ok(!!getEvidenceNode(g, 'evidence:UI:sel_new'), 'stable evidence node id');

  console.log('bind to metadata (exact only)');
  const nameNode = evidenceBySelectorRef(g, 'sel_name');
  eq(nameNode?.metadataRef, 'field:account.name', 'Name control binds to field:account.name');
  eq(evidenceForMetadata(g, 'field:account.name').length, 1, 'reverse lookup evidence→metadata');
  const newNode = evidenceBySelectorRef(g, 'sel_new');
  eq(newNode?.metadataRef, null, '"New" has no metadata match → null (no fuzzy binding)');

  console.log('semantic lookup');
  eq(evidenceBySemanticName(g, 'Objects').length, 1, 'lookup by semantic name');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
