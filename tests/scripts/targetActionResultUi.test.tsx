import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectTargetActionResult, TargetActionResult } from '../../src/components/TargetActionResult';

test('renders verified create/update/read data returned by target tools', () => {
  const result = selectTargetActionResult([{ tool: 'execute_platform_api_write', result: {
    summary: 'PATCH /accounts/1; verify with GET /accounts/1',
    verification: { id: 'account-1', name: 'Acme', evidence: { subject: 'Account', scope: { label: 'Core Platform' }, source: { method: 'GET', operation: '/accounts/1' } } },
  } }]);
  assert.ok(result);
  const html = renderToStaticMarkup(<TargetActionResult result={result} />);
  assert.match(html, /Verified data/);
  assert.match(html, /Core Platform/);
  assert.match(html, /account-1/);
  assert.doesNotMatch(html, /&quot;evidence&quot;/);
});

test('renders the verified Flow identity after curated authoring', () => {
  const result = selectTargetActionResult([{ tool: 'author_core_platform_flow', result: { status: 'created', flowId: 'flow-1', flowApiName: 'new_account', objectApiName: 'account', verification: { flow: { id: 'flow-1' }, steps: [] } } }]);
  assert.equal(result?.method, 'POST');
  assert.equal(result?.title, 'Created Core Platform Flow');
});
