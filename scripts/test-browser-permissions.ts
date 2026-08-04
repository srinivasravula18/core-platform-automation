import assert from 'node:assert/strict';
import { normalizeBrowserPermissionSettings } from '../core/shared/browserPermissions';
import { browserPermissionPrelude } from '../agent/src/browserPermissions';
import { configTemplate } from '../agent/src/runner';
import { codegenArguments } from '../agent/src/recorder';

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

console.log('Browser permission checks passed.');
