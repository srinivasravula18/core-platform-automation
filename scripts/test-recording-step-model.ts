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
  const { proposeRecordingPauses } = await import('../server/features/automation/pauseDetection');
  const { setPauseResumeV1 } = await import('../server/features/automation/flag');
  setPauseResumeV1(1);
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
  assert.ok(!('error' in invalid), 'email-like fields still accept usernames');

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

  const otpScript = `test('verify', async ({ page }) => {\n  await page.getByLabel('Verification Code').fill('123456');\n});`;
  const otpRecording = await service.createRecording({ name: 'Verify', appUrl: 'https://example.test' }, scope);
  await service.finalizeRecording(otpRecording.id, { script: otpScript });
  let otpStep = (await service.listRecordingSteps(otpRecording.id))[0];
  assert.strictEqual(otpStep.metadata.pauseProposal.kind, 'input', 'one-time code fields get a review-only proposal');
  assert.strictEqual(otpStep.metadata.pause, undefined, 'proposals do not change execution before acceptance');
  const accepted = await service.updateRecordingStepPause(otpRecording.id, otpStep.id, 'accept');
  assert.ok(!('error' in accepted), 'a proposed pause can be accepted');
  otpStep = (await service.listRecordingSteps(otpRecording.id))[0];
  const pausedScript = createScriptMaterializer(otpScript, [otpStep], [], [])({ values: {} });
  assert.ok(pausedScript.includes('fill(await tf.pause('), 'accepted input pause supplies the recorded action value');
  assert.ok(!pausedScript.includes('123456'), 'recorded one-time value is removed from the runtime script');
  const manualScript = createScriptMaterializer(otpScript, [{ ...otpStep, metadata: { ...otpStep.metadata, pause: { ...otpStep.metadata.pause, kind: 'manual_action' } } }], [], [])({ values: {} });
  assert.ok(manualScript.includes('await tf.pause(') && manualScript.includes("fill('123456')"), 'manual pauses run before the recorded action');
  setPauseResumeV1(0);
  assert.ok(createScriptMaterializer(otpScript, [otpStep], [], [])({ values: {} }).includes("fill('123456')"), 'flag off leaves accepted markers inert');
  setPauseResumeV1(1);

  const draft = (label: string, metadata: Record<string, unknown> = {}) => ({ ordinal: 0, type: 'fill' as const, locator: label, locatorStrategy: 'label' as const, fieldKind: 'text' as const, originalValue: null, readOnly: true, metadata: { label, ...metadata } });
  const external = proposeRecordingPauses("await page.goto('https://login.example.net');\nawait page.getByLabel('Account').fill('x');", [draft('Account')], 'https://example.test');
  assert.strictEqual((external[0].metadata.pauseProposal as any).reason, 'cross-origin', 'cross-origin fields get a manual-action proposal');
  const idle = proposeRecordingPauses("await page.getByLabel('Approval').fill('x');", [draft('Approval')], 'https://example.test', { 0: { idleMs: 20_000 } });
  assert.strictEqual((idle[0].metadata.pauseProposal as any).reason, 'idle-gap', 'observed idle gaps get a manual-action proposal');
  const dismissedRecording = await service.createRecording({ name: 'Dismiss', appUrl: 'https://example.test' }, scope);
  await service.finalizeRecording(dismissedRecording.id, { script: otpScript });
  const dismissedStep = (await service.listRecordingSteps(dismissedRecording.id))[0];
  await service.updateRecordingStepPause(dismissedRecording.id, dismissedStep.id, 'dismiss');
  const afterDismiss = (await service.listRecordingSteps(dismissedRecording.id))[0];
  assert.strictEqual(afterDismiss.metadata.pauseProposal, undefined, 'a proposal can be dismissed');
  assert.strictEqual(afterDismiss.metadata.pauseProposalDismissed, true, 'dismissal is persisted');

  console.log('PASS: recording step derivation, overrides, pause proposals/authoring, and empty-recording guard.');
}

main().catch((error) => { console.error(error); process.exit(1); });
