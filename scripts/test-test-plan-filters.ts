import assert from 'node:assert/strict';
import { emptyTestPlanFilters, matchesTestPlanFilters } from '../src/lib/testPlanFilters';

const plan = {
  id: 'PLAN-1',
  status: 'Draft',
  owner: 'Sam',
  tags: ['Regression'],
  folderId: 'FOLDER-1',
  startDate: '2026-08-01',
  endDate: '2026-08-15',
  environments: 'Staging, UAT',
  roles: 'QA Lead',
  runIds: ['RUN-1'],
};
const runs = [{ id: 'RUN-1', status: 'Not Started' }];

assert.equal(matchesTestPlanFilters(plan, runs, { ...emptyTestPlanFilters(), owners: ['Sam'], tags: ['Regression'] }, 'all'), true);
assert.equal(matchesTestPlanFilters(plan, runs, { ...emptyTestPlanFilters(), owners: ['Nobody'], tags: ['Regression'] }, 'all'), false);
assert.equal(matchesTestPlanFilters(plan, runs, { ...emptyTestPlanFilters(), owners: ['Nobody'], tags: ['Regression'] }, 'any'), true);
assert.equal(matchesTestPlanFilters(plan, runs, { ...emptyTestPlanFilters(), startFrom: '2026-08-02' }, 'all'), false);
assert.equal(matchesTestPlanFilters(plan, runs, { ...emptyTestPlanFilters(), notYetExecuted: true }, 'all'), true);
assert.equal(matchesTestPlanFilters(plan, [{ ...runs[0], status: 'Completed' }], { ...emptyTestPlanFilters(), notYetExecuted: true }, 'all'), false);

console.log('test-plan filters: ok');
