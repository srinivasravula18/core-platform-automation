import fs from 'fs';
import path from 'path';

for (const key of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[key];
process.env.DISABLE_POSTGRES = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'data-driven-execution-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

async function main() {
  const { createScriptMaterializer } = await import('../server/features/automation/scriptMaterializer');
  const { AutomationExecutionBatches, AutomationJobs } = await import('../server/db/repository');
  const { createLinkedTestRun, refreshExecutionBatch, syncLinkedRun } = await import('../server/features/automation/jobService');
  const { db } = await import('../server/shared/storage');
  db.automationExecutionBatches = [];
  db.automationJobs = [];
  db.runs = [];

  const script = `import { test } from '@playwright/test';
test('row', async ({ page }) => {
  await page.getByLabel('First name').fill('same');
  await page.getByLabel('Last name').fill('same');
  await page.getByLabel('Enabled').check();
  await page.getByLabel('Role').selectOption({ label: 'Guest' });
});`;
  const steps = [
    { id: 's1', ordinal: 0, locator: 'First name', metadata: { label: 'First name' }, currentOverride: null },
    { id: 's2', ordinal: 1, locator: 'Last name', metadata: { label: 'Last name' }, currentOverride: 'Override' },
    { id: 's3', ordinal: 2, locator: 'Enabled', metadata: { label: 'Enabled' }, currentOverride: null },
    { id: 's4', ordinal: 3, locator: 'Role', metadata: { label: 'Role' }, currentOverride: null },
  ];
  const columns = [
    { id: 'c1', name: 'First' }, { id: 'c2', name: 'Enabled' }, { id: 'c3', name: 'Role' },
  ];
  const mappings = [
    { stepId: 's1', datasetId: 'd1', columnId: 'c1' },
    { stepId: 's3', datasetId: 'd1', columnId: 'c2' },
    { stepId: 's4', datasetId: 'd1', columnId: 'c3' },
  ];
  const materialize = createScriptMaterializer(script, steps, mappings, columns);
  const output = materialize({ datasetId: 'd1', rowNumber: 7, values: { c1: `O'Reilly`, c2: 'false', c3: 'Admin' } });
  if (!output.includes(`fill("O'Reilly")`) || !output.includes(`fill("Override")`)) throw new Error('targeted fill materialization failed');
  if (!output.includes('.uncheck()') || !output.includes('selectOption("Admin")')) throw new Error('typed action materialization failed');
  if (!script.includes(`fill('same')`) || !script.includes(`selectOption({ label: 'Guest' })`)) throw new Error('immutable source changed');

  const batch = await AutomationExecutionBatches.upsert({
    id: 'batch-1', recordingId: 'rec-1', datasetId: 'd1', agentId: 'agent-1', status: 'queued',
    selection: [1, 2], summary: {}, ownerId: 'user-1',
  });
  await AutomationJobs.upsert({ id: 'job-1', batchId: batch.id, rowNumber: 1, status: 'done', summary: {}, ownerId: 'user-1' });
  await AutomationJobs.upsert({ id: 'job-2', batchId: batch.id, rowNumber: 2, status: 'failed', summary: {}, ownerId: 'user-1' });
  const refreshed = await refreshExecutionBatch(batch.id);
  if (refreshed.status !== 'failed' || refreshed.summary.passed !== 1 || refreshed.summary.failed !== 1) {
    throw new Error('batch progress aggregation failed');
  }
  const stored = await AutomationJobs.get('job-1');
  if (stored.batchId !== batch.id || stored.rowNumber !== 1) throw new Error('job row identity was not persisted');

  const linkedRun = await createLinkedTestRun(stored, { id: 'rec-1', name: 'Customer flow', appUrl: 'https://example.test', metadata: { caseId: 'case-1' } }, { projectId: 'project-1', appId: null, userId: 'user-1', role: '' }, {
    name: 'Customer flow · customers.xlsx · Row 1',
    triggerMeta: { automationBatchId: batch.id, datasetId: 'd1', rowNumber: 1 },
  });
  if (linkedRun.triggerMeta.automationJobId !== stored.id || linkedRun.triggerMeta.rowNumber !== 1 || linkedRun.caseIds[0] !== 'case-1') {
    throw new Error('data-driven job was not linked to a Test Run');
  }
  await syncLinkedRun(stored.id, 'done', { passed: 1, failed: 0, durationMs: 1500 });
  const completedRun = db.runs.find((run: any) => run.id === linkedRun.id);
  if (!String(completedRun?.status || '').startsWith('Completed') || completedRun?.passed !== 1) throw new Error('linked Test Run result was not synchronized');

  console.log('PASS: deterministic row materialization, durable batch aggregation, and linked Test Run results.');
}

main().catch((error) => { console.error(error); process.exit(1); });
