import assert from 'node:assert/strict';
import test from 'node:test';
import { unionObservedActions, waitForPageContent } from '../../server/features/agent/inspectionHelpers';

test('inspection helpers wait for content and keep newest unique actions first', async () => {
  let waited = 0;
  await waitForPageContent({
    waitForFunction: async (_fn: unknown, options: any) => { assert.equal(options.timeout, 20000); },
    waitForTimeout: async (ms: number) => { waited = ms; },
  });
  assert.equal(waited, 700);

  const newest = { role: 'button', text: 'Save', dom: { testId: 'save' } };
  const actions = unionObservedActions([newest], [
    { actions: [{ role: 'button', text: 'Old save', dom: { testId: 'save' } }, { role: 'link', text: 'Home' }] },
    { actions: [{ role: 'button', text: 'Cancel', dom: { id: 'cancel' } }] },
  ]);
  assert.deepEqual(actions, [newest, { role: 'button', text: 'Cancel', dom: { id: 'cancel' } }, { role: 'link', text: 'Home' }]);
});
