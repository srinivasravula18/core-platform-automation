import { containsPrivateFileActivity, hasPrivateResearchToolCall } from '../src/lib/userFacingAgentActivity';

const privateSamples = [
  'Reading src/features/apps.ts',
  'searched 64 related files, read 10 ranked files',
  'Source: src/features/apps.ts',
  '64 related files found',
  { toolCalls: [{ name: 'read_code_file', arguments: { path: 'secret.ts' } }] },
  { toolCalls: [{ name: 'follow_imports', arguments: { path: 'feature.tsx' } }] },
];

for (const sample of privateSamples) console.assert(containsPrivateFileActivity(sample), `expected private: ${JSON.stringify(sample)}`);
console.assert(!containsPrivateFileActivity('Generating test cases'), 'normal progress remains visible');
console.assert(hasPrivateResearchToolCall({ toolCalls: [{ name: 'search_codebase' }] }), 'research tool gets a generic label');
console.log('user-facing agent activity privacy checks passed');
