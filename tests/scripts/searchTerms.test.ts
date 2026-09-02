import assert from 'node:assert/strict';
import test from 'node:test';
import { featureIntentTerms } from '../../server/ai/research/searchTerms';

test('research and supervisor share QA feature expansions', () => {
  const terms = featureIntentTerms(['test', 'list']);
  assert.ok(terms.includes('validation'));
  assert.ok(terms.includes('row actions'));
  assert.equal(featureIntentTerms(['list']).includes('empty state'), false);
  assert.equal(featureIntentTerms(['list'], true).includes('empty state'), true);
});
