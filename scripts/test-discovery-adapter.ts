/**
 * Discovery Adapter tests (Evidence-Graph Phase 2). Proves the adapter PROJECTS existing discovery
 * (metadata_map + selector_registry) into the Metadata/Evidence graphs and the versioned Object Repository —
 * without mutating selector_registry, and without ever throwing.
 *   npx tsx scripts/test-discovery-adapter.ts   (npm run test:discovery-adapter)
 */
import { metadataGraphFromRun, integrateGraphsIntoRun } from '../server/features/agent/graph/discoveryAdapter';
import { listControls, _clearObjectRepository } from '../server/features/agent/graph/objectRepository';
import { buildMissionContext } from '../server/features/agent/mission/missionContext';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const vs = (id: string, role: string, label: string, selector: string, selectorType: string) => ({
  id, elementType: role, role, label, selector, selectorType, verified: true, verificationStatus: 'verified',
  confidence: 'verified-live', provenance: 'LIVE_DOM', visibility: true, uniqueness: true, sourceEvidenceId: 'dom', fallbackSelector: null,
});

function makeRun(): any {
  return {
    app_url: 'https://host/admin-ui/?nav=objects',
    application_context: { app: { name: 'Admin App' } },
    metadata_map: {
      app_id: 'core', objects: [
        { api_name: 'account', label: 'Account', object_id: 'o1', fields: [
          { api_name: 'name', label: 'Name', type: 'text', required: true, readonly: false },
          { api_name: 'email', label: 'Email', type: 'email', required: false, readonly: false },
        ], list_views: [], layouts: [], forms: [] },
      ], total_fields: 2, permission_sensitive_count: 0,
    },
    selector_registry: {
      verified_selectors: [
        vs('sel_name', 'textbox', 'Name', '#name', 'css'),
        vs('sel_new', 'button', 'New', '[data-testid="new"]', 'testid'),
      ],
    },
  };
}

function main() {
  _clearObjectRepository();

  console.log('metadata graph from run');
  const mg = metadataGraphFromRun(makeRun());
  eq(mg.nodes.filter((n) => n.kind === 'object').length, 1, 'one object from metadata_map');
  eq(mg.nodes.filter((n) => n.kind === 'field').length, 2, 'two fields from metadata_map');

  console.log('integrate (dark, read-only over registry)');
  const run = makeRun();
  const before = JSON.stringify(run.selector_registry);
  const s = integrateGraphsIntoRun(run);
  eq(JSON.stringify(run.selector_registry), before, 'selector_registry NOT mutated');
  ok(!!run.metadata_graph && !!run.evidence_graph, 'graphs attached to the run');
  eq(s.evidenceNodes, 2, 'two evidence nodes (one per verified selector)');
  eq(s.boundToMetadata, 1, 'Name binds to metadata field; New does not');
  eq(s.repoUpserts, 2, 'both controls folded into the Object Repository');

  console.log('object repository received versioned controls (platform label derived from run = "Admin App")');
  eq(listControls({ platform: 'Admin App' }).length, 2, 'two persisted controls under the derived platform label');
  eq(listControls({ platform: 'Nonexistent' }).length, 0, 'scoped filter excludes other platforms');

  console.log('re-run is idempotent (same shapes → no version bump)');
  const run2 = makeRun();
  const s2 = integrateGraphsIntoRun(run2);
  eq(s2.repoVersionsBumped, 0, 'identical discovery does not mint new versions');
  eq(listControls().length, 2, 'still two controls (upsert, not duplicate)');

  console.log('never throws on a malformed run');
  const bad = integrateGraphsIntoRun({});
  eq(bad.evidenceNodes, 0, 'empty run → empty graph, no throw');

  console.log('Phase 1: sealed mission_context stamps graph lineage (precedence over stale app_url)');
  _clearObjectRepository();
  const stale = makeRun();
  stale.app_url = 'https://host/admin-ui/'; // stale bare surface (no nav) — must NOT win
  stale.mission_context = buildMissionContext({ platformType: 'ADMIN', baseUrl: 'https://host/admin-ui/', module: { id: 'objects', name: 'Objects' } });
  integrateGraphsIntoRun(stale);
  ok(stale.evidence_graph.nodes.every((n: any) => n.module === 'objects' && n.page === 'objects'), 'nodes carry module/page=objects from the sealed mission, not null from app_url');

  _clearObjectRepository();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
