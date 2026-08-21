import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiEndpoint } from '../../server/features/api-intelligence/types';
import { operationPathParams, resolveApproverSetsOperation, resolveFlowOperations } from '../../server/ai/agent-runtime/flow-authoring/contract';
import { buildFlowDiagram, buildFlowStep, buildManagedStepPlans, extendFlowDiagram, isEmptyFlowDiagram, isManagedBasicFlow, isManagedFlow, isRedundantPrimaryCreateAction, isSafeFlowState } from '../../server/ai/agent-runtime/flow-authoring/planner';

const endpoint = (method: ApiEndpoint['method'], path: string): ApiEndpoint => ({
  id: `${method}:${path}`, method, path, tags: [], baseUrl: 'https://target.example',
  contract: { request: { params: [], headers: [] }, responses: {}, auth: { required: true } }, contractHash: 'hash', source: 'openapi',
});

const operations = [
  endpoint('GET', '/api/apps/{appId}/objects'), endpoint('GET', '/api/apps/{appId}/objects/{objectApiName}/describe'),
  endpoint('GET', '/admin/objects/{objectId}/forms'), endpoint('GET', '/admin/objects/{objectId}/flows'), endpoint('POST', '/admin/objects/{objectId}/flows'),
  endpoint('GET', '/admin/objects/{objectId}/flows/{flowId}'), endpoint('PATCH', '/admin/objects/{objectId}/flows/{flowId}'),
  endpoint('GET', '/admin/objects/{objectId}/flows/{flowId}/steps'), endpoint('POST', '/admin/objects/{objectId}/flows/{flowId}/steps'),
  endpoint('PATCH', '/admin/objects/{objectId}/flows/{flowId}/steps/{stepId}'),
  endpoint('GET', '/admin/approver-sets'),
];

test('resolves the documented read/create/update Flow contract without a delete operation', () => {
  const resolved = resolveFlowOperations(operations);
  assert.equal(resolved.createFlow.method, 'POST');
  assert.equal(resolved.updateFlow.method, 'PATCH');
  assert.equal(Object.values(resolved).some((operation) => operation.method === 'DELETE'), false);
  assert.deepEqual(operationPathParams(resolved.getFlow, ['object-1', 'flow-1']), { objectId: 'object-1', flowId: 'flow-1' });
  assert.equal(resolveApproverSetsOperation(operations).path, '/admin/approver-sets');
});

test('builds the Core Platform basic canvas-form create-record path', () => {
  const fields = [{ apiName: 'name', label: 'Name', type: 'text', required: true, picklistValues: [] }];
  const step = buildFlowStep({ mode: 'canvas_form', objectApiName: 'account', formName: 'New Account', fields });
  const diagram = buildFlowDiagram({ mode: 'canvas_form', objectApiName: 'account', formName: 'New Account', stepId: 'step-1', fields });
  assert.deepEqual((diagram.nodes as any[]).map((node) => node.id), ['start', 'form_canvas_1', 'action_create_record_1', 'end_complete']);
  assert.equal((step.rules_json as any).create_record_enabled, true);
  assert.deepEqual((step.rules_json as any).required_fields, ['name']);
  assert.equal(isManagedBasicFlow(diagram), true);
});

test('recognizes only Test Flow AI-managed basic diagrams as safely updateable', () => {
  assert.equal(isManagedBasicFlow({ version: 1, nodes: [{ id: 'start' }] }), false);
  assert.equal(isManagedBasicFlow({ managed_by: 'test_flow_ai', nodes: [{ id: 'start' }, { id: 'custom' }] }), false);
});

test('allows only the platform default empty diagram to receive its first authored steps', () => {
  assert.equal(isEmptyFlowDiagram({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }), true);
  assert.equal(isEmptyFlowDiagram({ version: 1, viewport: {}, nodes: [{ id: 'custom' }], edges: [] }), false);
  assert.equal(isEmptyFlowDiagram({ version: 1, viewport: {}, nodes: [], edges: [], custom: true }), false);
  assert.equal(isSafeFlowState({ version: 1, viewport: {}, nodes: [], edges: [] }, ['form_canvas_1']), true);
  assert.equal(isSafeFlowState({ version: 1, viewport: {}, nodes: [], edges: [] }, ['']), false);
});

test('requires a valid Approver Set selection before planning any approval write', () => {
  assert.throws(() => buildManagedStepPlans({ nodes: [{ type: 'approval', approverSetId: '', selectedUserIds: [], label: 'Manager Approval' }] }), /Approver Set/);
  const plans = buildManagedStepPlans({ nodes: [{ type: 'approval', approverSetId: 'aps-1', selectedUserIds: ['usr-1'], label: 'Manager Approval' }] });
  assert.deepEqual((plans[0].rules_json.canvas_binding as any).node_meta.approvalConfig.selectedUserIds, ['usr-1']);
});

test('builds create/update follow-up actions without a destructive action type', () => {
  const intent = { actions: [
    { type: 'create_record' as const, objectApiName: 'contact', values: { last_name: '{{account.name}}' } },
    { type: 'update_record' as const, objectApiName: 'account', values: { status: 'active' }, recordIdTemplate: '{{record.id}}' },
  ] };
  const plans = buildManagedStepPlans(intent);
  assert.deepEqual(plans.map((plan) => plan.nodeId), ['action_create_record_2', 'action_update_record_3']);
  assert.deepEqual(plans.map((plan) => (plan.rules_json.step_actions as any[])[0].type), ['create_record', 'update_record']);
  assert.deepEqual((plans[0].rules_json.step_action_drafts as any[])[0].mappings, [{ targetField: 'last_name', valueTemplate: '{{account.name}}' }]);
  assert.throws(() => buildManagedStepPlans({ actions: [{ type: 'update_record', objectApiName: 'account', values: {} }] }), /record_id_template/);
});

test('does not duplicate the primary create action inferred from form submission', () => {
  assert.equal(isRedundantPrimaryCreateAction({ type: 'create_record', objectApiName: 'account', label: 'Create Account', values: { name: '{{values.name}}' } }, 'account'), true);
  assert.equal(isRedundantPrimaryCreateAction({ type: 'create_record', objectApiName: 'contact', values: { account_id: '{{values.account_id}}' } }, 'account'), false);
});

test('extends a managed Flow with linear nodes and conditional routing', () => {
  const base = buildFlowDiagram({ mode: 'canvas_form', objectApiName: 'account', formName: 'Account', stepId: 'primary', fields: [] });
  const linear = { actions: [{ type: 'create_record' as const, objectApiName: 'contact', values: {} }], nodes: [{ type: 'wait' as const, duration: 1, unit: 'days' as const }] };
  const linearDiagram = extendFlowDiagram(base, linear, new Map([['action_create_record_2', 'action-step']]));
  assert.equal((linearDiagram.nodes as any[]).some((node) => node.type === 'wait'), true);
  assert.equal(isManagedFlow(linearDiagram), true);

  const routing = { routing: { fieldApiName: 'tier', branches: [{ equals: 'gold', action: { type: 'create_record' as const, objectApiName: 'task', values: {} } }], otherwise: { type: 'update_record' as const, objectApiName: 'account', values: {}, recordIdTemplate: '{{record.id}}' } } };
  const routed = extendFlowDiagram(base, routing, new Map([['action_branch_1', 'true-step'], ['action_branch_default', 'default-step']]));
  assert.equal((routed.nodes as any[]).some((node) => node.id === 'decision_1'), true);
  assert.equal((routed.nodes as any[]).find((node) => node.id === 'decision_1').data.decisionBranches[0].conditionGroup.filters[0].field, 'tier');
  assert.equal((routed.nodes as any[]).find((node) => node.id === 'action_branch_default').data.actionConfig.recordIdTemplate, '{{record.id}}');
  assert.equal((routed.edges as any[]).filter((edge) => edge.source === 'decision_1').length, 2);
  assert.throws(() => buildManagedStepPlans({ ...routing, actions: linear.actions }), /cannot be combined/);
});
