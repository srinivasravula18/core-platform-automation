import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

for (const key of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[key];
process.env.DISABLE_POSTGRES = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'recording-step-model-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

const SCRIPT = `import { test } from '@playwright/test';
test('profile', async ({ page }) => {
  await page.getByLabel('Email Address').fill('john@example.com');
  await page.getByLabel('Start Date').fill('2026-07-27');
  await page.getByRole('checkbox', { name: 'Subscribe' }).check();
  await page.getByLabel('Password').fill('not-exposed');
  await page.getByLabel('Calculated field').fill(makeValue());
});`;

async function main() {
  const service = await import('../server/features/automation/recordingService');
  const { db } = await import('../server/shared/storage');
  db.recordings = []; db.recordingSteps = []; db.recordingStepOverrides = [];
  const scope = { projectId: 'p1', appId: 'a1', userId: 'u1', role: '' } as any;
  const recording = await service.createRecording({ name: 'Profile', appUrl: 'https://example.test' }, scope);
  await service.finalizeRecording(recording.id, { script: SCRIPT });

  const source = await service.getRecording(recording.id);
  const steps = await service.listRecordingSteps(recording.id);
  assert.strictEqual(steps.length, 5, 'all supported actions, including read-only dynamic input, are derived');
  assert.strictEqual(steps[0].fieldKind, 'email');
  assert.strictEqual(steps[1].fieldKind, 'date');
  assert.strictEqual(steps[2].originalValue, true);
  assert.strictEqual(steps[3].originalValue, null, 'secret source values are never copied to the structured model');
  assert.strictEqual(steps[4].readOnly, true, 'dynamic expressions are not editable');

  const changed = await service.overrideRecordingStep(recording.id, steps[0].id, 'alice@example.com');
  assert.ok(!('error' in changed), 'valid inline override is accepted');
  assert.strictEqual((await service.listRecordingSteps(recording.id))[0].currentOverride, 'alice@example.com');
  assert.strictEqual((await service.getRecording(recording.id)).script, source.script, 'override never changes immutable source script');
  assert.strictEqual(await service.undoRecordingStepOverride(recording.id, steps[0].id), true);
  assert.strictEqual((await service.listRecordingSteps(recording.id))[0].currentOverride, null, 'undo restores the original value');
  assert.strictEqual(await service.redoRecordingStepOverride(recording.id, steps[0].id), true);
  assert.strictEqual((await service.listRecordingSteps(recording.id))[0].currentOverride, 'alice@example.com', 'redo restores the override');
  const invalid = await service.overrideRecordingStep(recording.id, steps[0].id, 'not-an-email');
  assert.ok('error' in invalid && invalid.status === 400, 'field-type validation rejects invalid email');
  console.log('PASS: recording step derivation, immutable overrides, and undo/redo.');
}

main().catch((error) => { console.error(error); process.exit(1); });
