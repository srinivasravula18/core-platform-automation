/**
 * Locks the sizing of every browser the user actually sees.
 *
 * A fixed viewport clips the app under test — it only fits when the user zooms out. It has been
 * introduced twice (27df206 fixed runs, ae716c1 re-pinned recording, 6fe106d fixed recording) so
 * both launch paths are asserted here: recording (codegenSizing) and headed runs (configTemplate).
 */

import assert from 'node:assert/strict';
import { codegenSizing, parseRecordSize, DEFAULT_VIDEO_CANVAS } from '../agent/src/codegenOptions';
import { configTemplate } from '../agent/src/runner';

// Recording: nothing pinned unless a caller explicitly asks.
const live = codegenSizing('');
assert.equal(live.viewport, null, 'recording viewport must follow the window, never a fixed size');
assert.deepEqual(live.windowArgs, ['--start-maximized'], 'recording window must open maximized');
// Left unset, Playwright records at 800x600 and pads the 16:9 page into 4:3 — the grey band bug.
assert.deepEqual(live.videoSize, DEFAULT_VIDEO_CANVAS, 'video canvas must always be set explicitly');

// Once a window has been measured, the canvas matches it exactly and the page fills the frame.
const measured = codegenSizing('', '1536,872');
assert.equal(measured.viewport, null, 'measuring the window must not pin the page');
assert.deepEqual(measured.videoSize, { width: 1536, height: 872 });
assert.deepEqual(codegenSizing('', 'nonsense').videoSize, DEFAULT_VIDEO_CANVAS);

for (const junk of ['0,0', '1280', 'abc', '-100,-100', ' ']) {
  assert.equal(codegenSizing(junk).viewport, null, `unusable --viewport ${JSON.stringify(junk)} must fall back to the window`);
}

// An explicit request still pins page, window and video together.
const pinned = codegenSizing('800,600');
assert.deepEqual(pinned.viewport, { width: 800, height: 600 });
assert.deepEqual(pinned.windowArgs, ['--window-size=800,740']);
assert.deepEqual(pinned.videoSize, { width: 800, height: 600 });
assert.deepEqual(parseRecordSize('1024,768'), { width: 1024, height: 768 });

// Headed runs: the same rule, enforced through the generated Playwright config.
const headed = configTemplate('chromium', true);
assert.match(headed, /viewport: null/, 'headed runs must let the page fill the window');
assert.match(headed, /--start-maximized/, 'headed runs must open maximized');
assert.doesNotMatch(headed, /viewport: \{/, 'headed runs must not pin a viewport');

// Headless runs are server-side and keep Playwright's own defaults.
const headless = configTemplate('chromium', false);
assert.doesNotMatch(headless, /--start-maximized/);
assert.doesNotMatch(headless, /viewport: null/);

console.log('Recorder + headed-run viewport checks passed.');
