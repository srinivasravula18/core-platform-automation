/**
 * Grounding Engine tests (Phase 3). Proves deterministic resolution: unique verified control → RESOLVED with
 * the AUTHORITATIVE registry locator (re-read, never copied); non-unique → AMBIGUOUS_SELECTOR; missing →
 * UNRESOLVED_SELECTOR. Also proves the target catalog only offers verified-unique controls.
 *   npx tsx scripts/test-grounding-engine.ts   (npm run test:grounding)
 */
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { resolveTarget } from '../server/features/agent/graph/groundingEngine';
import { renderTargetCatalogForPrompt } from '../server/features/agent/compiler/renderCatalogForPrompt';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const vs = (id: string, role: string, label: string, selector: string, selectorType: string, uniqueness: boolean) => ({
  id, elementType: role, role, label, selector, selectorType, verified: uniqueness,
  verificationStatus: uniqueness ? 'verified' : 'not_unique', confidence: 'verified-live',
  provenance: 'LIVE_DOM', visibility: true, uniqueness, sourceEvidenceId: 'dom', fallbackSelector: null,
});

function main() {
  const run: any = {
    selector_registry: {
      verified_selectors: [
        vs('sel_new', 'button', 'New', '[data-testid="new"]', 'testid', true),
        vs('sel_name', 'textbox', 'Name', '#name', 'css', true),
        vs('sel_apps', 'button', 'Apps', 'getByRole(button,Apps)', 'role', false), // not unique (4 matches)
        { ...vs('sel_observed', 'button', 'Observed', '#observed', 'css', true), verified: false, confidence: 'inferred', uniqueness: null, sourceEvidenceId: 'inspection' },
        { ...vs('sel_static', 'button', 'Static', '#static', 'css', true), confidence: 'verified-static', provenance: 'STATIC_SOURCE' },
      ],
    },
  };
  const graph = buildEvidenceGraphFromRun(run, { platform: 'Admin' });

  console.log('RESOLVED (unique) + authoritative registry re-read');
  const r = resolveTarget('New', graph, run);
  eq(r.status, 'RESOLVED', 'unique control resolves');
  eq(r.selector, '[data-testid="new"]', 'returns the verified locator');
  // Mutate the AUTHORITATIVE registry; grounding must re-read it (not the graph node copy).
  run.selector_registry.verified_selectors[0].selector = '[data-testid="new-v2"]';
  eq(resolveTarget('New', graph, run).selector, '[data-testid="new-v2"]', 'grounding re-reads the registry (source of truth)');

  console.log('Non-unique controls are excluded before resolution — never a positional guess');
  const a = resolveTarget('Apps', graph, run);
  eq(a.status, 'UNRESOLVED_SELECTOR', 'non-unique control is withheld from the graph');
  eq(a.selector, null, 'non-unique control yields NO selector (no .first())');

  console.log('UNRESOLVED (missing)');
  const u = resolveTarget('DoesNotExist', graph, run);
  eq(u.status, 'UNRESOLVED_SELECTOR', 'missing target → UNRESOLVED');

  console.log('resolve by node id / selectorRef too');
  eq(resolveTarget('sel_name', graph, run).status, 'RESOLVED', 'resolves by selectorRef');

  console.log('catalog offers only verified-unique controls');
  const cat = renderTargetCatalogForPrompt(graph);
  ok(cat.includes('New') && cat.includes('Name'), 'catalog lists unique controls');
  ok(!cat.includes('Apps'), 'catalog EXCLUDES the non-unique "Apps" control');
  ok(!cat.includes('Observed') && !cat.includes('Static'), 'catalog EXCLUDES inferred and static controls');
  eq(resolveTarget('Observed', graph, run).status, 'UNRESOLVED_SELECTOR', 'inferred inspector control cannot resolve');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
