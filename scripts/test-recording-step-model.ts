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

const MISSION_SCRIPT = `test('agent profile', async ({ page }) => {
  const runner = new MissionRunner(page, MISSION);
  await runner.fill({"selector":"#email","selectorType":"css","role":"textbox","label":"Email Address"}, "john@example.com");
  await runner.select({"selector":"#role","selectorType":"css","role":"combobox","label":"Role"}, "Admin");
  await runner.check({"selector":"#enabled","selectorType":"css","role":"checkbox","label":"Enabled"});
});`;

async function main() {
  const service = await import('../server/features/automation/recordingService');
  const { createScriptMaterializer } = await import('../server/features/automation/scriptMaterializer');
  const { Scripts } = await import('../server/db/repository');
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
  let editedStep = (await service.listRecordingSteps(recording.id))[0];
  assert.strictEqual(editedStep.currentOverride, 'alice@example.com');
  assert.strictEqual(editedStep.canUndo, true);
  assert.strictEqual(editedStep.canRedo, false);
  assert.strictEqual((await service.getRecording(recording.id)).script, source.script, 'override never changes immutable source script');
  assert.strictEqual(await service.undoRecordingStepOverride(recording.id, steps[0].id), true);
  editedStep = (await service.listRecordingSteps(recording.id))[0];
  assert.strictEqual(editedStep.currentOverride, null, 'undo restores the original value');
  assert.strictEqual(editedStep.canUndo, false);
  assert.strictEqual(editedStep.canRedo, true);
  assert.strictEqual(await service.redoRecordingStepOverride(recording.id, steps[0].id), true);
  editedStep = (await service.listRecordingSteps(recording.id))[0];
  assert.strictEqual(editedStep.currentOverride, 'alice@example.com', 'redo restores the override');
  assert.strictEqual(editedStep.canUndo, true);
  assert.strictEqual(editedStep.canRedo, false);
  const invalid = await service.overrideRecordingStep(recording.id, steps[0].id, 'not-an-email');
  assert.ok('error' in invalid && invalid.status === 400, 'field-type validation rejects invalid email');

  await Scripts.upsert({
    id: 'SCR-AGENT-1', name: 'Agent profile', filename: 'agent-profile.spec.ts', code: MISSION_SCRIPT,
    projectId: scope.projectId, appId: scope.appId, ownerId: scope.userId,
  });
  const repositoryRecording = await service.recordingForScript('SCR-AGENT-1', scope);
  assert.ok(repositoryRecording, 'repository script is exposed as a recording');
  const missionSteps = await service.listRecordingSteps(repositoryRecording.id);
  assert.strictEqual(missionSteps.length, 3, 'repository MissionRunner inputs are lazily backfilled');
  assert.deepStrictEqual(missionSteps.map((step) => step.type), ['fill', 'select', 'check']);
  await service.overrideRecordingStep(repositoryRecording.id, missionSteps[0].id, 'alice@example.com');
  const editedMissionSteps = await service.listRecordingSteps(repositoryRecording.id);
  const materialized = createScriptMaterializer(MISSION_SCRIPT, editedMissionSteps, [], [])({ values: {} });
  assert.ok(materialized.includes('"alice@example.com"'), 'MissionRunner value override is materialized');
  // An empty recording must not become a test case: the only step it could carry is the generic
  // "Run the recorded Playwright script", which reads like a real case but describes nothing.
  const EMPTY_SCRIPT = `import { test } from '@playwright/test';
test('empty', async ({ page }) => {
});`;
  assert.strictEqual(service.recordingHasInteractions(EMPTY_SCRIPT), false, 'boilerplate-only script has no interactions');
  assert.strictEqual(service.recordingHasInteractions(''), false, 'empty script has no interactions');
  assert.strictEqual(service.recordingHasInteractions(SCRIPT), true, 'a real recording has interactions');
  assert.strictEqual(
    service.scriptToSteps(SCRIPT).some((step: any) => /Run the recorded Playwright script/i.test(step.action)),
    false,
    'a parseable recording never falls back to the generic run-the-script step',
  );

  console.log('PASS: recording step derivation, immutable overrides, undo/redo, and empty-recording guard.');
}

main().catch((error) => { console.error(error); process.exit(1); });
