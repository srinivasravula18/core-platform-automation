import assert from 'node:assert/strict';
import test from 'node:test';
import { finalAnalysisState, mergeRerunEvidence } from '../../src/components/DeepRunResult';

test('fresh rerun screenshots replace only their matching saved evidence', () => {
  const evidence = mergeRerunEvidence(
    [{ title: 'rerun', screenshotUrl: '/evidence/old.png' }, { title: 'untouched', screenshotUrl: '/evidence/keep.png' }],
    [{ title: 'rerun', screenshotUrl: '/evidence/new.png', evidenceUrls: ['/evidence/step.png', '/evidence/new.png'] }],
  );
  assert.deepEqual(evidence.map((item) => item.screenshotUrl), ['/evidence/new.png', '/evidence/keep.png']);
  assert.deepEqual(evidence[0].stepScreenshots, ['/evidence/step.png', '/evidence/new.png']);
});

test('final analysis remains visible until the workflow reaches a terminal state', () => {
  assert.equal(finalAnalysisState('running'), 'pending');
  assert.equal(finalAnalysisState('completed'), 'completed');
  assert.equal(finalAnalysisState('failed'), 'skipped');
  assert.equal(finalAnalysisState('cancelled'), 'skipped');
});
