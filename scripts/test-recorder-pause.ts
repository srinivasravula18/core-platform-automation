/**
 * Pausing a recording must not disable Playwright's recorder.
 *
 * It used to call _disableRecorder(), which removed the codegen toolbar and left recording switched
 * OFF after resume — everything the user did next was lost. The recorder now stays on and the agent
 * drops whatever it wrote while paused, so this checks that dropping against the real file shape:
 * the recorder rewrites the WHOLE script on every action, so a pause-window action must stay out of
 * later reads too, not just the one taken at resume.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from '../agent/src/recorder';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pause-'));
const log = { info: () => {}, warn: () => {}, error: () => {} };  // pino ships with the agent, not the root package
const frames: Array<{ type: string; payload: any }> = [];
const recorder = new Recorder(log as any, work, (type, payload) => frames.push({ type, payload }), {} as any);

// Drive the recorder's own state machine without launching a browser: register a live recording whose
// output file we write by hand, exactly as codegen would.
const outputPath = path.join(work, 'REC-1.spec.ts');
const state: any = {
  child: { stdin: { destroyed: true, write: () => true }, once: () => {} },
  outputPath, profileDir: path.join(work, 'p'), videoDir: path.join(work, 'v'), videoJobId: '',
  poll: setInterval(() => {}, 1_000_000), lastScript: '', paused: false, pausedLines: null, dropped: [],
};
(recorder as any).active.set('REC-1', state);
clearInterval(state.poll);

const line = (n: string) => `  await page.getByRole('button', { name: '${n}' }).click();\n`;
const script = (...names: string[]) => `import { test } from '@playwright/test';\ntest('t', async ({ page }) => {\n${names.map(line).join('')}});\n`;
const tick = () => { (recorder as any).tick('REC-1'); return state.lastScript as string; };

// Recorded before the pause.
fs.writeFileSync(outputPath, script('Alpha'));
assert.match(tick(), /Alpha/);

recorder.pause('REC-1');
// The recorder keeps writing while paused — the user is doing something they do not want recorded.
fs.writeFileSync(outputPath, script('Alpha', 'Secret'));
const whilePaused = tick();
assert.match(whilePaused, /Alpha/);
assert.doesNotMatch(whilePaused, /Secret/, 'actions recorded while paused must not be shown');

recorder.resume('REC-1');
// A later action rewrites the WHOLE file, pause-window action included; it must still be dropped.
fs.writeFileSync(outputPath, script('Alpha', 'Secret', 'Beta'));
const afterResume = tick();
assert.match(afterResume, /Alpha/);
assert.match(afterResume, /Beta/, 'actions after resume must be recorded again');
assert.doesNotMatch(afterResume, /Secret/, 'the pause window stays dropped on every later read');

// A second pause drops its own window and leaves the first drop in place.
recorder.pause('REC-1');
fs.writeFileSync(outputPath, script('Alpha', 'Secret', 'Beta', 'Private'));
assert.doesNotMatch(tick(), /Private/);
recorder.resume('REC-1');
fs.writeFileSync(outputPath, script('Alpha', 'Secret', 'Beta', 'Private', 'Gamma'));
const final = tick();
for (const kept of ['Alpha', 'Beta', 'Gamma']) assert.match(final, new RegExp(kept));
for (const dropped of ['Secret', 'Private']) assert.doesNotMatch(final, new RegExp(dropped));

// Pausing with nothing recorded in the window changes nothing.
recorder.pause('REC-1');
recorder.resume('REC-1');
assert.equal(tick(), final);

const paused = frames.filter((f) => f.type === 'record.status' && f.payload.state === 'paused').length;
assert.ok(paused >= 3, 'each pause reports its state to the cloud');

fs.rmSync(work, { recursive: true, force: true });
console.log('Recorder pause/resume checks passed.');
