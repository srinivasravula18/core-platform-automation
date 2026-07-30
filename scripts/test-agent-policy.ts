import assert from 'node:assert/strict';
import { filterToolsByGrants } from '../server/ai/policy';
import type { AgentTool } from '../server/ai/tools/types';

const tool = (name: string, effect?: 'read' | 'write' | 'destructive', permissions?: string[]): AgentTool => ({
  spec: { name, description: name, parameters: { type: 'object', properties: {} } },
  ...(effect ? { capability: { effect, permissions } } : {}),
  async execute() { return null; },
});

const catalog = [
  tool('query_workspace'),
  tool('create_case', 'write', ['cases:create']),
  tool('delete_case', 'destructive', ['cases:delete']),
];

const readOnly = { features: ['agent-console'], projects: [], websites: [], providers: [], actions: [] };
assert.deepEqual(filterToolsByGrants(catalog, readOnly).map((entry) => entry.spec.name), ['query_workspace']);

const editor = { ...readOnly, actions: ['cases:create'] };
assert.deepEqual(filterToolsByGrants(catalog, editor).map((entry) => entry.spec.name), ['query_workspace', 'create_case']);

assert.deepEqual(filterToolsByGrants(catalog, 'UNRESTRICTED').map((entry) => entry.spec.name), ['query_workspace', 'create_case']);

const denied = { ...editor, denies: ['cases:create'] };
assert.deepEqual(filterToolsByGrants(catalog, denied).map((entry) => entry.spec.name), ['query_workspace']);
assert.equal(filterToolsByGrants([tool('archive_record')], 'UNRESTRICTED').length, 0);

console.log('agent policy checks passed');
