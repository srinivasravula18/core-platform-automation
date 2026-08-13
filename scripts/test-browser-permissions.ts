import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeBrowserPermissionSettings } from '../core/shared/browserPermissions';
import { browserPermissionPrelude } from '../agent/src/browserPermissions';
import { configTemplate } from '../agent/src/runner';
import { codegenArguments, codegenProfileDir, purgeCodegenProfiles } from '../agent/src/recorder';

const settings = normalizeBrowserPermissionSettings({
  permissions: ['camera', 'geolocation', 'camera', 'unsupported'],
  geolocation: { latitude: 12.97, longitude: 77.59 },
  fakeMedia: true,
  acceptDialogs: true,
});

assert.deepEqual(settings.permissions, ['camera', 'geolocation']);
assert.deepEqual(settings.geolocation, { latitude: 12.97, longitude: 77.59 });
assert.equal(settings.fakeMedia, true);
assert.equal(settings.acceptDialogs, true);
assert.equal(normalizeBrowserPermissionSettings({ permissions: ['geolocation'], geolocation: { latitude: 91, longitude: 0 } }).geolocation, undefined);

const prelude = browserPermissionPrelude(settings, 'https://example.test/path');
assert.match(prelude, /grantPermissions/);
assert.match(prelude, /https:\/\/example\.test/);
assert.match(prelude, /dialog\.accept/);

const config = configTemplate('chromium', false, false, settings);
assert.match(config, /geolocation: \{"latitude":12\.97,"longitude":77\.59\}/);
assert.match(config, /--use-fake-device-for-media-stream/);

const args = codegenArguments('.testflow-pw/scratch', 'recording.spec.ts', 'https://example.test/path', 'chromium', settings);
assert.ok(args.includes('--user-data-dir'));
assert.deepEqual(args.slice(args.indexOf('--permissions'), args.indexOf('--permissions') + 2), ['--permissions', 'camera,geolocation']);
assert.deepEqual(args.slice(args.indexOf('--geolocation'), args.indexOf('--geolocation') + 2), ['--geolocation', '12.97,77.59']);
assert.ok(args.includes('--fake-media'));
assert.ok(args.includes('--accept-dialogs'));

// A recording must never inherit the previous session: fresh profile per recording, wiped on reuse.
const workDir = path.join('.testflow-pw', 'scratch', 'codegen-profile-isolation');
fs.rmSync(workDir, { recursive: true, force: true });
const profileOf = (recordingId: string) => {
  const launch = codegenArguments(workDir, `${recordingId}.spec.ts`, 'https://example.test/path', 'chromium', settings, undefined, recordingId);
  return launch[launch.indexOf('--user-data-dir') + 1];
};

const first = profileOf('REC-1');
const second = profileOf('REC-2');
assert.notEqual(first, second);
assert.equal(first, codegenProfileDir(workDir, 'REC-1'));

fs.writeFileSync(path.join(first, 'Cookies'), 'logged-in');
assert.equal(fs.existsSync(path.join(first, 'Cookies')), true);
profileOf('REC-1'); // re-recording the same id starts from a clean profile
assert.equal(fs.existsSync(path.join(first, 'Cookies')), false);

fs.writeFileSync(path.join(second, 'Cookies'), 'logged-in');
purgeCodegenProfiles(workDir, ['REC-1']);
assert.equal(fs.existsSync(first), true);
assert.equal(fs.existsSync(second), false);
fs.rmSync(workDir, { recursive: true, force: true });

console.log('Browser permission checks passed.');
