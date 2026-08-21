import type { ApiEndpoint } from '../../../features/api-intelligence/types';
import { callTargetReadOperation, callTargetWriteOperation, listTargetApiOperations } from '../../tools/targetMetadata';
import type { ToolContext } from '../../tools/types';
import { operationPathParams, resolveApproverSetsOperation, resolveFlowOperations } from './contract';
import { buildFlowDiagram, buildFlowStep, buildManagedStepPlans, extendFlowDiagram, isRedundantPrimaryCreateAction, isSafeFlowState } from './planner';
import type { FlowAuthoringIntent, FlowAuthoringResult, FlowRecordAction, ResolvedFlowField } from './types';

const query = (appId: string) => ({ app_id: appId });
const read = (operation: ApiEndpoint, values: string[], queryParams: Record<string, unknown>, ctx: ToolContext) =>
  callTargetReadOperation(operation.id, operationPathParams(operation, values), queryParams, ctx);
const write = (operation: ApiEndpoint, values: string[], queryParams: Record<string, unknown>, body: unknown, ctx: ToolContext) =>
  callTargetWriteOperation(operation.id, operationPathParams(operation, values), queryParams, body, ctx);

function records(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.data?.items)) return value.data.items;
  return [];
}

const text = (value: unknown) => String(value ?? '').trim();
const sameName = (value: unknown, expected: string) => text(value).toLowerCase() === expected.trim().toLowerCase();
const findId = (value: any) => text(value?.id || value?.flow_id || value?.data?.id || value?.data?.flow_id);
const managedNodeId = (step: any) => text((step?.rules_json ?? step?.rules ?? {})?.canvas_binding?.node_id);

function fieldsFromDescribe(value: any): ResolvedFlowField[] {
  const source = Array.isArray(value?.fields) ? value.fields : Array.isArray(value?.data?.fields) ? value.data.fields : [];
  return source.flatMap((field: any) => {
    const apiName = text(field?.api_name);
    if (!apiName || field?.read_only === true || field?.computed === true) return [];
    const picklist = Array.isArray(field?.picklist_values) ? field.picklist_values : [];
    return [{
      apiName, label: text(field?.label) || apiName, type: text(field?.type) || 'text', required: field?.required === true,
      picklistValues: picklist.flatMap((item: any) => text(item?.value) ? [{ value: text(item.value), label: text(item?.label) || text(item.value) }] : []),
    }];
  });
}

export async function authorCorePlatformFlow(intent: FlowAuthoringIntent, ctx: ToolContext): Promise<FlowAuthoringResult> {
  if (!ctx.targetApps?.length) throw new Error('Select one Core Platform target before authoring a Flow.');
  if (ctx.targetApps.length !== 1) throw new Error('Select exactly one Core Platform target for Flow authoring.');
  if (!intent.appId || !intent.objectApiName || !intent.flowName || !intent.flowApiName) throw new Error('app_id, object_api_name, flow_name, and flow_api_name are required.');
  if (!/^[a-z][a-z0-9_]*$/i.test(intent.flowApiName)) throw new Error('flow_api_name must contain only letters, numbers, and underscores.');
  buildManagedStepPlans(intent);

  const apiOperations = await listTargetApiOperations(ctx) as ApiEndpoint[];
  const operations = resolveFlowOperations(apiOperations);
  const approvals = (intent.nodes || []).filter((node) => node.type === 'approval');
  if (approvals.length) {
    const approverSets = records(await read(resolveApproverSetsOperation(apiOperations), [], {}, ctx));
    for (const approval of approvals) {
      const set = approverSets.find((item) => sameName(findId(item), approval.approverSetId));
      const allowedUsers = new Set(records(set?.users).map(findId));
      if (!set || approval.selectedUserIds.some((id) => !allowedUsers.has(id))) throw new Error('The approval node references a missing Approver Set or a user outside that set. Ask the user for a valid Approver Set and selected user, then stop without writing.');
    }
  }
  const objectRows = records(await read(operations.listObjects, [intent.appId], {}, ctx));
  const object = objectRows.find((item) => sameName(item?.api_name, intent.objectApiName) || sameName(item?.label, intent.objectApiName));
  const objectId = findId(object);
  const objectApiName = text(object?.api_name) || intent.objectApiName;
  if (!objectId) throw new Error(`The object "${intent.objectApiName}" was not found in the selected application.`);

  let form: any = null;
  let selectedFields: ResolvedFlowField[] = [];
  const formName = text(intent.formName) || `${intent.flowName} Canvas Form`;
  if (intent.formMode === 'existing_form') {
    if (!intent.formName) throw new Error('form_name is required when form_mode is existing_form.');
    form = records(await read(operations.listForms, [objectId], {}, ctx)).find((item) => sameName(item?.name, intent.formName!));
    if (!form || !findId(form)) throw new Error(`The form "${intent.formName}" was not found on ${objectApiName}.`);
  } else {
    const availableFields = fieldsFromDescribe(await read(operations.describeObject, [intent.appId, objectApiName], {}, ctx));
    const requested = new Set((intent.fieldApiNames || []).map((field) => field.toLowerCase()));
    selectedFields = availableFields.filter((field) => requested.has(field.apiName.toLowerCase()));
    if (!requested.size) throw new Error('field_api_names is required when form_mode is canvas_form.');
    if (selectedFields.length !== requested.size) throw new Error('One or more requested canvas fields were missing, read-only, or computed.');
  }

  const flowRows = records(await read(operations.listFlows, [objectId], query(intent.appId), ctx));
  let flow = flowRows.find((item) => sameName(item?.api_name, intent.flowApiName) || sameName(item?.name, intent.flowName));
  let flowId = findId(flow);
  const created = !flowId;
  if (!flowId) {
    const result = await write(operations.createFlow, [objectId], query(intent.appId), {
      api_name: intent.flowApiName, name: intent.flowName, description: intent.description || null, mode: 'create',
      submit_strategy: 'main_and_actions', is_active: false, is_default: intent.isDefault ?? false, allow_cancel: intent.allowCancel ?? true,
    }, ctx);
    flowId = findId(result);
    if (!flowId) {
      flow = records(await read(operations.listFlows, [objectId], query(intent.appId), ctx)).find((item) => sameName(item?.api_name, intent.flowApiName));
      flowId = findId(flow);
    }
    if (!flowId) throw new Error('The Flow was created but its id could not be resolved.');
  }

  const detail = await read(operations.getFlow, [objectId, flowId], query(intent.appId), ctx) as any;
  const existingSteps = records(await read(operations.listSteps, [objectId, flowId], query(intent.appId), ctx));
  const diagram = detail?.diagram_json ?? detail?.data?.diagram_json;
  if (!isSafeFlowState(diagram, existingSteps.map(managedNodeId))) {
    return { status: 'blocked', message: `Flow "${intent.flowName}" already contains authored steps or canvas nodes. It was not changed because destructive replacement is disabled.`, appId: intent.appId, objectId, objectApiName, flowId, flowApiName: intent.flowApiName };
  }

  const normalizeAction = async (action: FlowRecordAction): Promise<FlowRecordAction> => {
    const targetObject = objectRows.find((item) => sameName(item?.api_name, action.objectApiName) || sameName(item?.label, action.objectApiName));
    const targetApiName = text(targetObject?.api_name);
    if (!targetApiName) throw new Error(`The action object "${action.objectApiName}" was not found in the selected application.`);
    const writable = new Set(fieldsFromDescribe(await read(operations.describeObject, [intent.appId, targetApiName], {}, ctx)).map((field) => field.apiName.toLowerCase()));
    if (Object.keys(action.values).some((field) => !writable.has(field.toLowerCase()))) throw new Error(`One or more values for ${targetApiName} target a missing, read-only, or computed field.`);
    return { ...action, objectApiName: targetApiName };
  };
  const plannedIntent: FlowAuthoringIntent = { ...intent, actions: (await Promise.all((intent.actions || []).map(normalizeAction))).filter((action) => !isRedundantPrimaryCreateAction(action, objectApiName)) };
  if (intent.routing) plannedIntent.routing = { ...intent.routing, branches: await Promise.all(intent.routing.branches.map(async (branch) => ({ ...branch, action: await normalizeAction(branch.action) }))), otherwise: await normalizeAction(intent.routing.otherwise) };
  const extraPlans = buildManagedStepPlans(plannedIntent);
  const desiredNodeIds = new Set([intent.formMode === 'canvas_form' ? 'form_canvas_1' : 'form_existing_1', ...extraPlans.map((plan) => plan.nodeId)]);
  if (existingSteps.some((step) => !managedNodeId(step) || !desiredNodeIds.has(managedNodeId(step)))) {
    return { status: 'blocked', message: `Flow "${intent.flowName}" has managed steps that this request would remove. It was not changed because destructive replacement is disabled.`, appId: intent.appId, objectId, objectApiName, flowId, flowApiName: intent.flowApiName };
  }

  const stepPlan = buildFlowStep({ mode: intent.formMode, objectApiName, formName, formDefinition: form?.definition_json, fields: selectedFields });
  const existingStep = existingSteps.find((step) => managedNodeId(step).startsWith('form_')) || existingSteps[0];
  const stepResult = existingStep
    ? await write(operations.updateStep, [objectId, flowId, findId(existingStep)], query(intent.appId), stepPlan, ctx)
    : await write(operations.createStep, [objectId, flowId], query(intent.appId), { step_order: 1, ...stepPlan }, ctx);
  const stepId = findId(stepResult) || findId(existingStep);
  if (!stepId) throw new Error('The primary Flow step could not be resolved after creation.');

  const existingByNode = new Map<string, any>(existingSteps.flatMap((step) => managedNodeId(step) ? [[managedNodeId(step), step] as [string, any]] : []));
  const stepIds = new Map<string, string>();
  for (const plan of extraPlans) {
    const existing = existingByNode.get(plan.nodeId);
    const result = existing
      ? await write(operations.updateStep, [objectId, flowId, findId(existing)], query(intent.appId), plan, ctx)
      : await write(operations.createStep, [objectId, flowId], query(intent.appId), { step_order: plan.stepOrder, label: plan.label, definition_json: plan.definition_json, rules_json: plan.rules_json }, ctx);
    const id = findId(result) || findId(existing);
    if (!id) throw new Error(`The Flow step for ${plan.label} could not be resolved.`);
    stepIds.set(plan.nodeId, id);
  }

  const rowVersion = Number(detail?.row_version ?? detail?.data?.row_version);
  if (!Number.isFinite(rowVersion) || rowVersion < 1) throw new Error('The Flow row_version is missing or invalid.');
  const baseDiagram = buildFlowDiagram({ mode: intent.formMode, objectApiName, formName, formId: findId(form), stepId, fields: selectedFields });
  const subflowIds = new Map((intent.nodes || []).flatMap((node) => node.type === 'subflow' ? [[node.flowApiName, findId(flowRows.find((flow) => sameName(flow?.api_name, node.flowApiName)))]] : []).filter(([, id]) => id) as Array<[string, string]>);
  if ((intent.nodes || []).some((node) => node.type === 'subflow' && !subflowIds.has(node.flowApiName))) throw new Error('One or more requested subflows were not found in the current object Flow scope.');
  const diagramJson = extendFlowDiagram(baseDiagram, plannedIntent, stepIds, subflowIds);
  await write(operations.updateFlow, [objectId, flowId], query(intent.appId), { row_version: rowVersion, submit_strategy: 'main_and_actions', diagram_json: diagramJson, is_active: intent.isActive ?? true }, ctx);

  const verifiedFlow = await read(operations.getFlow, [objectId, flowId], query(intent.appId), ctx);
  const verifiedSteps = await read(operations.listSteps, [objectId, flowId], query(intent.appId), ctx);
  return {
    status: created ? 'created' : 'updated',
    message: `${created ? 'Created' : 'Updated'} Flow "${intent.flowName}" in ${ctx.targetApps[0].name} with a ${intent.formMode === 'existing_form' ? `form based on "${formName}"` : 'canvas-built form'}, the backend ${objectApiName} record-creation path, and ${extraPlans.length + (intent.nodes || []).filter((node) => node.type === 'wait' || node.type === 'subflow').length} follow-up node(s).`,
    appId: intent.appId, objectId, objectApiName, flowId, flowApiName: intent.flowApiName,
    verification: { flow: verifiedFlow, steps: verifiedSteps },
  };
}
