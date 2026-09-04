import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverageGapList, ScenarioStepGrid } from '../../src/components/CoverageDetails';
import { BulkDeleteButton } from '../../src/components/BulkDeleteButton';
import { SortableHeaders } from '../../src/components/DataTable/sortable';
import { SpeechInputButton } from '../../src/components/SpeechInputButton';
import { MetricTiles } from '../../src/components/vitals/ui';
import { COVERAGE_BADGE } from '../../src/lib/coverageBadge';
import { casesForPlan, casesForSuite } from '../../src/lib/manualTestRun';
import { fetchRequirementsList } from '../../src/lib/requirementsApi';

test('plan and suite selection include descendant suites through one traversal', () => {
  const suites = [
    { id: 'root', testPlanIds: ['plan-1'] },
    { id: 'child', parentSuiteIds: ['root'] },
    { id: 'grandchild', parentSuiteIds: ['child'] },
  ];
  const cases = [
    { id: 'root-case', testSuiteIds: ['root'] },
    { id: 'deep-case', testSuiteIds: ['grandchild'] },
  ];

  assert.deepEqual(casesForPlan(cases, suites, 'plan-1').map((item) => item.id), ['root-case', 'deep-case']);
  assert.deepEqual(casesForSuite(cases, suites, 'root').map((item) => item.id), ['root-case', 'deep-case']);
});

test('shared coverage details preserve gap and scenario content', () => {
  const html = renderToStaticMarkup(<>
    <CoverageGapList gaps={['Missing permission case']} />
    <ScenarioStepGrid steps={[{ action: 'Open account', expected: 'Account is visible' }]} />
  </>);

  assert.match(html, /Missing permission case/);
  assert.match(html, /1\. Open account/);
  assert.match(html, /Account is visible/);
});

test('shared list primitives preserve metrics, headers, and coverage labels', () => {
  const html = renderToStaticMarkup(<>
    <MetricTiles items={[{ label: 'Healthy', value: 3, color: 'green' }]} />
    <table><thead><tr><SortableHeaders columns={[{ label: 'Updated', column: 'updated' }]} sort={null} onSort={() => {}} /></tr></thead></table>
    <BulkDeleteButton count={2} busy={false} onDelete={() => {}} />
    <SpeechInputButton listening={false} supported disabled={false} onToggle={() => {}} />
  </>);

  assert.match(html, /Healthy/);
  assert.match(html, />3</);
  assert.match(html, /Updated/);
  assert.match(html, /Delete Selected \(2\)/);
  assert.match(html, /Start voice input/);
  assert.equal(COVERAGE_BADGE.none.label, 'No Coverage');
});

test('requirements list loader normalizes non-array API responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ requirements: [] }), { headers: { 'Content-Type': 'application/json' } });
  try {
    assert.deepEqual(await fetchRequirementsList(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
