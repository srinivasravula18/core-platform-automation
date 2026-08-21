import type { FlowAuthoringIntent, FlowFollowUpNode, FlowFormMode, FlowRecordAction, ResolvedFlowField } from './types';

const bindingKey = (objectApiName: string, fieldApiName: string) => `__object_field__:${objectApiName}:${fieldApiName}`;
const title = (value: string) => value.split(/[_\s-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');

export function buildFlowStep(input: { mode: FlowFormMode; objectApiName: string; formName: string; formDefinition?: unknown; fields: ResolvedFlowField[] }) {
  const nodeId = input.mode === 'canvas_form' ? 'form_canvas_1' : 'form_existing_1';
  if (input.mode === 'existing_form') {
    return { label: input.formName, definition_json: input.formDefinition || { fields: [] }, rules_json: { create_record_enabled: true, canvas_binding: { managed_by_canvas: true, node_id: nodeId, node_type: 'form', managed_by: 'test_flow_ai' } } };
  }
  const fields = input.fields.map((field) => ({
    api_name: field.apiName, label: field.label, type: field.type, source_object_api_name: input.objectApiName,
    required: field.required, binding_key: bindingKey(input.objectApiName, field.apiName),
    ...(field.picklistValues.length ? { picklist_values: field.picklistValues.map((entry) => ({ ...entry, active: true })), restrict_picklist_to_values: true } : {}),
  }));
  return {
    label: input.formName,
    definition_json: { fields, sections: [{ id: 'canvas_main', label: 'Step Fields', width: 12, columns: 2, fields, field_spans: Object.fromEntries(fields.map((field) => [field.binding_key, 6])) }] },
    rules_json: { create_record_enabled: true, ...(fields.some((field) => field.required) ? { required_fields: fields.filter((field) => field.required).map((field) => field.api_name) } : {}), canvas_binding: { managed_by_canvas: true, node_id: nodeId, node_type: 'form', managed_by: 'test_flow_ai', node_meta: { objectApiName: input.objectApiName, formMode: input.mode } } },
  };
}

export function buildFlowDiagram(input: { mode: FlowFormMode; objectApiName: string; formName: string; formId?: string; stepId: string; fields: ResolvedFlowField[] }) {
  const formNodeId = input.mode === 'canvas_form' ? 'form_canvas_1' : 'form_existing_1';
  const formFields = input.fields.map((field) => ({ apiName: field.apiName, label: field.label, bindingKey: bindingKey(input.objectApiName, field.apiName), sourceKind: 'object', sourceObjectApiName: input.objectApiName, type: field.type, required: field.required || undefined, ...(field.picklistValues.length ? { picklistValues: field.picklistValues.map((entry) => ({ ...entry, active: true })) } : {}) }));
  return {
    version: 1, managed_by: 'test_flow_ai', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
      { id: formNodeId, type: 'form', position: { x: 220, y: 0 }, data: { label: input.formName, stepId: input.stepId, stepOrder: 1, objectApiName: input.objectApiName, formMode: input.mode, ...(input.mode === 'existing_form' ? { existingFormId: input.formId, existingFormName: input.formName } : { formFields }) } },
      { id: 'action_create_record_1', type: 'action', position: { x: 460, y: 0 }, data: { label: `Create ${title(input.objectApiName)} Record`, stepId: input.stepId, stepOrder: 1, actionType: 'step_actions', objectApiName: input.objectApiName } },
      { id: 'end_complete', type: 'end', position: { x: 700, y: 0 }, data: { label: 'Done', outcome: 'complete' } },
    ],
    edges: [
      { id: 'edge_start_form', source: 'start', target: formNodeId },
      { id: 'edge_form_action', source: formNodeId, target: 'action_create_record_1' },
      { id: 'edge_action_end', source: 'action_create_record_1', target: 'end_complete' },
    ],
  };
}

export function isManagedBasicFlow(diagram: unknown): boolean {
  if (!diagram || typeof diagram !== 'object' || Array.isArray(diagram)) return false;
  const value = diagram as any;
  return value.managed_by === 'test_flow_ai' && Array.isArray(value.nodes) && value.nodes.every((node: any) => ['start', 'form_canvas_1', 'form_existing_1', 'action_create_record_1', 'end_complete'].includes(String(node?.id)));
}

export type ManagedStepPlan = { nodeId: string; stepOrder: number; label: string; definition_json: {}; rules_json: Record<string, unknown> };

const actionNodeId = (action: FlowRecordAction, order: number) => `action_${action.type}_${order}`;
const actionLabel = (action: FlowRecordAction) => action.label || `${action.type === 'create_record' ? 'Create' : 'Update'} ${title(action.objectApiName)} Record`;

export function isRedundantPrimaryCreateAction(action: FlowRecordAction, primaryObjectApiName: string): boolean {
  const values = Object.entries(action.values);
  return action.type === 'create_record' && action.objectApiName.toLowerCase() === primaryObjectApiName.toLowerCase()
    && (!action.label || action.label.toLowerCase() === `create ${primaryObjectApiName.toLowerCase()}` || action.label.toLowerCase() === `create ${primaryObjectApiName.toLowerCase()} record`)
    && values.length > 0 && values.every(([field, value]) => value === `{{values.${field}}}`);
}

function actionStep(action: FlowRecordAction, nodeId: string, stepOrder: number): ManagedStepPlan {
  if (!action.objectApiName.trim()) throw new Error('object_api_name is required for every record action.');
  if (action.type === 'update_record' && !action.recordIdTemplate?.trim()) throw new Error('record_id_template is required for every update_record action.');
  const mappings = Object.entries(action.values).map(([targetField, value]) => ({ targetField, valueTemplate: typeof value === 'string' ? value : JSON.stringify(value) }));
  return {
    nodeId, stepOrder, label: actionLabel(action), definition_json: {},
    rules_json: {
      canvas_binding: { managed_by_canvas: true, node_id: nodeId, node_type: 'action', managed_by: 'test_flow_ai', node_meta: { objectApiName: action.objectApiName } },
      step_actions: [{ type: action.type, object_api_name: action.objectApiName, ...(action.type === 'update_record' ? { record_id: action.recordIdTemplate } : {}), values: action.values, managed_by_diagram: true, diagram_node_id: nodeId }],
      step_action_drafts: [{ type: action.type, objectApiName: action.objectApiName, outputIdField: '', outputBindingKey: '', recordIdTemplate: action.recordIdTemplate || '', restApiId: '', restApiApiName: '', method: 'POST', urlTemplate: '', bodyTemplate: '', headersJson: '{}', mappings, filters: { logic: 'AND', filters: [], groups: [] }, managed_by_diagram: true, diagram_node_id: nodeId }],
    },
  };
}

export function buildManagedStepPlans(intent: Pick<FlowAuthoringIntent, 'actions' | 'nodes' | 'routing'>): ManagedStepPlan[] {
  if (intent.routing && ((intent.actions?.length || 0) + (intent.nodes?.length || 0) > 0)) throw new Error('Conditional routing cannot be combined with linear actions or nodes in one request.');
  if (intent.routing && (!intent.routing.fieldApiName.trim() || !intent.routing.branches.length)) throw new Error('Conditional routing requires field_api_name and at least one branch.');
  for (const node of intent.nodes || []) {
    if (node.type === 'wait' && (!Number.isFinite(node.duration) || node.duration <= 0)) throw new Error('Wait duration must be greater than zero.');
    if (node.type === 'manual_task' && !node.assignee.trim()) throw new Error('assignee is required for manual_task.');
    if (node.type === 'approval' && (!node.approverSetId.trim() || !node.selectedUserIds.length)) throw new Error('Approval nodes require an existing approver_set_id and at least one selected_user_id. Ask the user for an Approver Set, then stop without writing.');
    if (node.type === 'subflow' && !node.flowApiName.trim()) throw new Error('flow_api_name is required for subflow nodes.');
  }
  if (intent.routing) return [...intent.routing.branches.map((branch, index) => actionStep(branch.action, `action_branch_${index + 1}`, index + 2)), actionStep(intent.routing.otherwise, 'action_branch_default', intent.routing.branches.length + 2)];
  const plans = (intent.actions || []).map((action, index) => actionStep(action, actionNodeId(action, index + 2), index + 2));
  let stepOrder = plans.length + 2;
  for (const [index, node] of (intent.nodes || []).entries()) {
    if (node.type !== 'manual_task' && node.type !== 'approval') continue;
    const nodeId = `${node.type}_${index + 1}`;
    const nodeMeta = node.type === 'approval' ? { approvalConfig: { approverSetId: node.approverSetId, selectedUserIds: node.selectedUserIds, approvalPolicy: node.approvalPolicy || 'any', outcomes: [{ key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }] } } : undefined;
    plans.push({ nodeId, stepOrder: stepOrder++, label: node.label || (node.type === 'approval' ? 'Approval' : 'Manual Task'), definition_json: {}, rules_json: { canvas_binding: { managed_by_canvas: true, node_id: nodeId, node_type: node.type, managed_by: 'test_flow_ai', ...(nodeMeta ? { node_meta: nodeMeta } : {}) } } });
  }
  return plans;
}

function appendLinearNode(diagram: any, node: FlowRecordAction | FlowFollowUpNode, nodeId: string, previousId: string, step?: ManagedStepPlan, subflowId?: string) {
  const type = 'objectApiName' in node ? 'action' : node.type;
  const data = type === 'action'
    ? (() => { const action = node as FlowRecordAction; return { label: actionLabel(action), stepId: step?.nodeId, stepOrder: step?.stepOrder, actionType: action.type, objectApiName: action.objectApiName, actionConfig: { type: action.type, objectApiName: action.objectApiName, ...(action.recordIdTemplate ? { recordIdTemplate: action.recordIdTemplate } : {}), mappings: Object.entries(action.values).map(([targetField, value]) => ({ targetField, valueTemplate: typeof value === 'string' ? value : JSON.stringify(value) })) } }; })()
    : node.type === 'wait' ? { label: node.label || `Wait ${node.duration} ${node.unit}`, waitConfig: { mode: 'relative', duration: node.duration, unit: node.unit } }
    : node.type === 'subflow' ? { label: node.label || `Run ${node.flowApiName}`, subflowConfig: { flowId: subflowId, flowApiName: node.flowApiName, waitForCompletion: node.waitForCompletion ?? true } }
    : node.type === 'approval' ? { label: node.label || 'Approval', stepId: step?.nodeId, stepOrder: step?.stepOrder, approvalConfig: { approverSetId: node.approverSetId, selectedUserIds: node.selectedUserIds, approvalPolicy: node.approvalPolicy || 'any', outcomes: [{ key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }] } }
    : { label: node.label || 'Manual Task', stepId: step?.nodeId, stepOrder: step?.stepOrder, manualTaskConfig: { assigneeType: 'role', assigneeValue: (node as Extract<FlowFollowUpNode, { type: 'manual_task' }>).assignee, instructions: (node as Extract<FlowFollowUpNode, { type: 'manual_task' }>).instructions || '' } };
  diagram.nodes.splice(diagram.nodes.length - 1, 0, { id: nodeId, type, position: { x: 700 + (diagram.nodes.length - 3) * 240, y: 0 }, data });
  const edge = diagram.edges.find((item: any) => item.source === previousId && item.target === 'end_complete');
  if (edge) Object.assign(edge, { id: `edge_${previousId}_${nodeId}`, target: nodeId });
  diagram.edges.push({ id: `edge_${nodeId}_end`, source: nodeId, target: 'end_complete' });
}

export function extendFlowDiagram(base: any, intent: Pick<FlowAuthoringIntent, 'actions' | 'nodes' | 'routing'>, stepIds: Map<string, string>, subflowIds = new Map<string, string>()) {
  const diagram = structuredClone(base);
  if (intent.routing) {
    const decisionId = 'decision_1';
    const edge = diagram.edges.find((item: any) => item.id === 'edge_action_end');
    Object.assign(edge, { id: 'edge_action_decision', target: decisionId });
    const branchKey = (value: unknown, fallback: string) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || fallback;
    const configuredBranches = intent.routing.branches.map((branch, index) => ({ ...branch, nodeId: `action_branch_${index + 1}`, id: `branch_${index + 1}`, key: branchKey(branch.equals, `branch_${index + 1}`), isDefault: false }));
    diagram.nodes.splice(diagram.nodes.length - 1, 0, { id: decisionId, type: 'decision', position: { x: 700, y: 0 }, data: { label: `${intent.routing.fieldApiName} Routing`, decisionBranches: [...configuredBranches.map((branch) => ({ id: branch.id, label: branch.label || `${intent.routing!.fieldApiName} is ${String(branch.equals)}`, branchKey: branch.key, conditionGroup: { logic: 'AND', filters: [{ field: intent.routing!.fieldApiName, op: 'eq', value: branch.equals }], groups: [] } })), { id: 'branch_default', label: 'Otherwise', branchKey: 'default', isDefault: true }] } });
    const branches = [...configuredBranches, { action: intent.routing.otherwise, nodeId: 'action_branch_default', id: 'branch_default', key: 'default', isDefault: true }];
    branches.forEach((branch, index) => {
      const step = buildManagedStepPlans(intent).find((item) => item.nodeId === branch.nodeId)!;
      diagram.nodes.splice(diagram.nodes.length - 1, 0, { id: branch.nodeId, type: 'action', position: { x: 940, y: (index - (branches.length - 1) / 2) * 160 }, data: { label: actionLabel(branch.action), stepId: stepIds.get(branch.nodeId), stepOrder: step.stepOrder, actionType: branch.action.type, objectApiName: branch.action.objectApiName, actionConfig: { type: branch.action.type, objectApiName: branch.action.objectApiName, ...(branch.action.recordIdTemplate ? { recordIdTemplate: branch.action.recordIdTemplate } : {}), mappings: Object.entries(branch.action.values).map(([targetField, value]) => ({ targetField, valueTemplate: typeof value === 'string' ? value : JSON.stringify(value) })) } } });
      diagram.edges.push({ id: `edge_decision_${branch.nodeId}`, source: decisionId, target: branch.nodeId, data: { branchId: branch.id, branchKey: branch.key, ...(branch.isDefault ? { isDefault: true } : {}) } }, { id: `edge_${branch.nodeId}_end`, source: branch.nodeId, target: 'end_complete' });
    });
    return diagram;
  }
  const plans = buildManagedStepPlans(intent);
  let previousId = 'action_create_record_1';
  for (const [index, action] of (intent.actions || []).entries()) {
    const plan = plans[index];
    appendLinearNode(diagram, action, plan.nodeId, previousId, { ...plan, nodeId: stepIds.get(plan.nodeId) || plan.nodeId });
    previousId = plan.nodeId;
  }
  for (const [index, node] of (intent.nodes || []).entries()) {
    const nodeId = `${node.type}_${index + 1}`;
    const plan = plans.find((item) => item.nodeId === nodeId);
    appendLinearNode(diagram, node, nodeId, previousId, plan && { ...plan, nodeId: stepIds.get(nodeId) || nodeId }, node.type === 'subflow' ? subflowIds.get(node.flowApiName) : undefined);
    previousId = nodeId;
  }
  return diagram;
}

export function isManagedFlow(diagram: unknown): boolean {
  if (!diagram || typeof diagram !== 'object' || Array.isArray(diagram)) return false;
  const value = diagram as any;
  return value.managed_by === 'test_flow_ai' && Array.isArray(value.nodes) && value.nodes.every((node: any) => /^(start|form_(canvas|existing)_1|action_(create_record_1|create_record_\d+|update_record_\d+|branch_(\d+|default))|decision_1|wait_\d+|manual_task_\d+|approval_\d+|subflow_\d+|end_complete)$/.test(String(node?.id)));
}

export function isEmptyFlowDiagram(diagram: unknown): boolean {
  if (!diagram || typeof diagram !== 'object' || Array.isArray(diagram)) return false;
  const value = diagram as any;
  return Array.isArray(value.nodes) && value.nodes.length === 0
    && Array.isArray(value.edges) && value.edges.length === 0
    && Object.keys(value).every((key) => ['version', 'viewport', 'nodes', 'edges'].includes(key));
}

export function isSafeFlowState(diagram: unknown, stepNodeIds: string[]): boolean {
  return stepNodeIds.every(Boolean) && (!diagram || isEmptyFlowDiagram(diagram) || isManagedFlow(diagram));
}
