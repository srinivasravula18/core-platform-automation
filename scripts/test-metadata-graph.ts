/**
 * Metadata Graph tests (Evidence-Graph Phase 1). Proves first-class metadata objects (objects/fields/tabs/
 * relationships/lookups/permissions) build deterministically with stable ids + edges.
 *   npx tsx scripts/test-metadata-graph.ts   (npm run test:metadata-graph)
 */
import {
  buildMetadataGraph, getMetadataNode, metadataNodesOfKind, metadataNeighbors, findMetadataByLabel,
} from '../server/features/agent/graph/metadataGraph';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const INPUT = {
  objects: [
    {
      apiName: 'account', label: 'Account', prefix: 'acc',
      fields: [
        { apiName: 'name', label: 'Name', type: 'text', required: true },
        { apiName: 'owner', label: 'Owner', type: 'lookup', lookupTo: 'user' },
      ],
      tabs: [{ apiName: 'account', label: 'Account' }],
      relationships: [{ apiName: 'contacts', label: 'Contacts', targetObject: 'contact', type: 'child' }],
      permissions: ['read', 'create', 'delete'],
    },
    { apiName: 'contact', label: 'Contact', fields: [{ apiName: 'email', label: 'Email', type: 'email' }] },
  ],
};

function main() {
  const g = buildMetadataGraph(INPUT);

  console.log('nodes');
  eq(metadataNodesOfKind(g, 'object').length, 2, 'two objects');
  eq(metadataNodesOfKind(g, 'field').length, 3, 'three fields');
  eq(metadataNodesOfKind(g, 'tab').length, 1, 'one tab');
  eq(metadataNodesOfKind(g, 'relationship').length, 1, 'one relationship');
  eq(metadataNodesOfKind(g, 'lookup').length, 1, 'one lookup (owner→user)');
  eq(metadataNodesOfKind(g, 'permission').length, 3, 'three permissions');

  console.log('stable ids');
  ok(!!getMetadataNode(g, 'object:account'), 'object id stable: object:account');
  ok(!!getMetadataNode(g, 'field:account.name'), 'field id stable: field:account.name');
  ok(!!getMetadataNode(g, 'lookup:account.owner'), 'lookup id stable: lookup:account.owner');

  console.log('edges + neighbors');
  const fields = metadataNeighbors(g, 'object:account', 'object_field');
  eq(fields.length, 2, 'account → 2 fields');
  const rel = metadataNeighbors(g, 'object:account', 'object_relationship')[0];
  ok(!!rel, 'account has relationship');
  const target = metadataNeighbors(g, rel.id, 'relationship_target')[0];
  eq(target?.id, 'object:contact', 'relationship targets contact object');
  const lookup = metadataNeighbors(g, 'field:account.owner', 'field_lookup')[0];
  eq((lookup?.attrs as any)?.targetObject, 'user', 'owner field → lookup to user');

  console.log('determinism');
  eq(JSON.stringify(buildMetadataGraph(INPUT).nodes), JSON.stringify(g.nodes), 'same input → identical nodes');

  console.log('label match (exact, never fuzzy)');
  eq(findMetadataByLabel(g, 'Account', ['object'])?.id, 'object:account', 'match object by label');
  eq(findMetadataByLabel(g, 'Email', ['field'])?.id, 'field:contact.email', 'match field by label');
  eq(findMetadataByLabel(g, 'Nonexistent'), null, 'no fuzzy match → null');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
