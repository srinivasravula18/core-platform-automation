/**
 * API evidence fold-in tests (Phase 6). Proves api-intelligence endpoints project into the SAME Evidence
 * Graph as first-class API nodes, bind to metadata objects, and link to UI controls that share the object.
 *   npx tsx scripts/test-api-evidence-adapter.ts   (npm run test:api-evidence)
 */
import { buildMetadataGraph } from '../server/features/agent/graph/metadataGraph';
import { buildEvidenceGraphFromRun } from '../server/features/agent/graph/evidenceGraph';
import { mergeApiEvidence, apiNodesFromEndpoints } from '../server/features/agent/graph/apiEvidenceAdapter';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const ep = (method: string, path: string): any => ({ id: `${method} ${path}`, method, path, summary: '', tags: [], baseUrl: '', contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: false } }, contractHash: 'h', source: 'openapi' });

function main() {
  const metadata = buildMetadataGraph({ objects: [{ apiName: 'account', label: 'Account', fields: [{ apiName: 'name', label: 'Name' }] }] });

  // A UI node bound to object:account (label 'Account' → object).
  const run: any = { selector_registry: { verified_selectors: [
    { id: 'sel_acc', elementType: 'button', role: 'button', label: 'Account', selector: '#acc', selectorType: 'css', verified: true, verificationStatus: 'verified', confidence: 'verified-live', provenance: 'LIVE_DOM', visibility: true, uniqueness: true, sourceEvidenceId: 'dom', fallbackSelector: null },
  ] } };
  const ui = buildEvidenceGraphFromRun(run, { metadata, platform: 'Admin' });

  console.log('api nodes');
  const apis = apiNodesFromEndpoints([ep('GET', '/accounts'), ep('POST', '/accounts')], { metadata });
  eq(apis.length, 2, 'two API evidence nodes');
  eq(apis[0].evidenceKind, 'API', 'evidenceKind API');
  eq(apis[0].metadataRef, 'object:account', 'API node binds to metadata object by path');
  ok(apis[0].selector === null && apis[0].selectorRef === null, 'API node carries no UI selector');

  console.log('merge into the same graph');
  const merged = mergeApiEvidence(ui, [ep('GET', '/accounts')], { metadata });
  eq(merged.nodes.filter((n) => n.evidenceKind === 'API').length, 1, 'API node added to the UI graph');
  eq(merged.nodes.filter((n) => n.evidenceKind === 'UI').length, 1, 'UI node preserved');
  ok(merged.edges.some((e) => e.kind === 'calls'), 'UI control bound to the same object links to the API (calls)');
  ok(merged.edges.some((e) => e.kind === 'binds' && e.to === 'object:account'), 'API node binds to metadata');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
