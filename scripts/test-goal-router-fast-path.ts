import assert from 'node:assert/strict';

process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;

const { classifyGoalDeterministically, routeGoal } = await import('../server/agent-runtime/goals/router');
const ctx = { selectedApps: [{ name: 'CRM', url: 'http://localhost:5000' }] };

assert.equal(classifyGoalDeterministically('test new account creation in crm app', ctx)?.kind, 'generate_cases');
assert.equal(classifyGoalDeterministically('Generate 2 test cases for the list view', ctx)?.kind, 'generate_cases');
assert.equal(classifyGoalDeterministically('Run the tests against CRM', ctx)?.kind, 'deep_test_run');
assert.equal(classifyGoalDeterministically('What should I test on the list view?', ctx)?.kind, 'answer');
assert.equal(classifyGoalDeterministically('test failed yesterday', ctx), null);
assert.equal(classifyGoalDeterministically('same again', ctx), null);

const routed = await routeGoal({ message: 'Generate 2 test cases for the list view' }, ctx);
assert.equal(routed.route.kind, 'generate_cases');
assert.equal(routed.route.target?.url, 'http://localhost:5000');

console.log('goal router fast path: ok');
