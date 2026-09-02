import assert from 'node:assert/strict';
import test from 'node:test';
import { missionContextFromRef } from '../../server/features/agent/workflow/missionContext';

test('workflow graphs rehydrate one immutable mission context shape', () => {
  const mission = missionContextFromRef({
    platform: 'core',
    platformType: 'admin',
    runtimeSurface: 'list',
    applicationId: 'app-1',
    moduleId: null,
    tabId: 'tab-1',
    targetUrl: 'https://example.test',
    executionScope: 'selected',
  });

  assert.equal(Object.isFrozen(mission), true);
  assert.deepEqual(mission.application, { id: 'app-1', name: 'app-1' });
  assert.equal(missionContextFromRef(null), null);
});
