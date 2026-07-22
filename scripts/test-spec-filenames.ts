/**
 * Generated Playwright spec files are named after the case TITLE (deduped), not the internal case id.
 * Verifies the slug helper and the real legacy-run projection the UI/File System reads.
 *   npx tsx scripts/test-spec-filenames.ts   (npm run test:spec-filenames)
 */
import '../server/shared/env';
import { specFilenameFromTitle } from '../server/features/agent/workflow/specFilename';
import { projectStateToLegacyRun } from '../server/features/agent/workflow/runtime';
import { stashArtifacts, clearArtifacts } from '../server/features/agent/workflow/artifactStash';
import { createInitialWorkflowState } from '../server/features/agent/workflow/state';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  console.log('slug helper');
  ok(specFilenameFromTitle('admin - verify Create an app with valid required values', 'case-1') === 'admin-verify-create-an-app-with-valid-required-values.spec.ts', 'title → kebab-case .spec.ts');
  ok(specFilenameFromTitle('', 'case-3') === 'case-3.spec.ts', 'empty title falls back to the case id');
  ok(specFilenameFromTitle('!!!', 'case-4') === 'case-4.spec.ts', 'unsluggable title falls back to the case id');
  const used = new Set<string>();
  ok(specFilenameFromTitle('Same Title', 'case-1', used) === 'same-title.spec.ts', 'first of a collision keeps the clean name');
  ok(specFilenameFromTitle('Same Title', 'case-2', used) === 'same-title-2.spec.ts', 'second of a collision is suffixed -2');
  ok(specFilenameFromTitle('Same Title', 'case-5', used) === 'same-title-3.spec.ts', 'third of a collision is suffixed -3');

  console.log('real projection (projectStateToLegacyRun) uses title-based filenames');
  const runId = 'run-spec-names-1';
  clearArtifacts(runId);
  stashArtifacts(runId, { compiledSources: { 'case-1': 'code-1', 'case-2': 'code-2' } });
  const state: any = createInitialWorkflowState({
    runId, threadId: `t-${runId}`, requestId: `r-${runId}`,
    tenantId: 't', workspaceId: 'w', projectId: 'p', applicationId: 'app9', requestedBy: 'u',
    request: { goal: 'x', requestedCaseCount: 2, reviewPolicy: 'auto', executionPolicy: 'skip' },
    mission: null, credentialRef: null,
  });
  state.cases = [
    { id: 'case-1', title: 'admin - verify Create an app with valid required values' },
    { id: 'case-2', title: 'admin - verify Label is required' },
  ];
  state.compilation = {
    scripts: [
      { caseId: 'case-1', scriptRef: 'a'.repeat(40), digest: 'a'.repeat(40), ok: true },
      { caseId: 'case-2', scriptRef: 'b'.repeat(40), digest: 'b'.repeat(40), ok: true },
    ],
    diagnostics: [], compilerVersion: 'test',
  };
  const run = projectStateToLegacyRun(state);
  const names = (run.playwright_scripts || []).map((s: any) => s.filename);
  console.log('    filenames:', JSON.stringify(names));
  ok(names[0] === 'admin-verify-create-an-app-with-valid-required-values.spec.ts', 'case 1 filename comes from its title');
  ok(names[1] === 'admin-verify-label-is-required.spec.ts', 'case 2 filename comes from its title');
  ok(run.playwright_scripts[0].test_case_title === 'admin - verify Create an app with valid required values', 'the human title is still carried');
  ok(!names.some((n: string) => /^case-\d+\.spec\.ts$/.test(n)), 'no filename is the bare internal case id anymore');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
