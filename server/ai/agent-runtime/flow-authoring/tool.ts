import type { AgentTool } from '../../tools/types';
import { withEvidence } from '../../tools/evidenceEnvelope';
import { authorCorePlatformFlow } from './executor';

const str = { type: 'string' };
const action = {
  type: 'object',
  properties: { type: { type: 'string', enum: ['create_record', 'update_record'] }, object_api_name: str, values: { type: 'object', additionalProperties: true }, record_id_template: str, label: str },
  required: ['type', 'object_api_name', 'values'], additionalProperties: false,
};

export const authorCorePlatformFlowTool: AgentTool = {
  spec: {
    name: 'author_core_platform_flow',
    description: 'Create or safely update a Core Platform object Flow using live metadata. Supports create/update record actions, conditional branches, waits, manual tasks, approvals, and subflows, then re-reads the Flow and steps. Never performs deletion or destructive replacement. Administrator only.',
    parameters: {
      type: 'object',
      properties: {
        app_id: str, object_api_name: str, flow_name: str, flow_api_name: str,
        form_mode: { type: 'string', enum: ['existing_form', 'canvas_form'] }, form_name: str,
        field_api_names: { type: 'array', items: str }, description: str,
        is_active: { type: 'boolean' }, is_default: { type: 'boolean' }, allow_cancel: { type: 'boolean' },
        actions: { type: 'array', description: 'Additional record actions after the primary form submission. Do not add the primary object create action; it is built in automatically.', items: action },
        nodes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['wait', 'manual_task', 'approval', 'subflow'] }, duration: { type: 'number' }, unit: { type: 'string', enum: ['minutes', 'hours', 'days'] }, assignee: str, approver_set_id: { type: 'string', description: 'Existing Approver Set ID; direct users or roles are not valid for approval nodes.' }, selected_user_ids: { type: 'array', items: str, description: 'Active user IDs selected from that Approver Set.' }, approval_policy: { type: 'string', enum: ['any', 'all'] }, instructions: str, flow_api_name: str, wait_for_completion: { type: 'boolean' }, label: str }, required: ['type'], additionalProperties: false } },
        routing: { type: 'object', properties: { field_api_name: str, branches: { type: 'array', items: { type: 'object', properties: { equals: {}, label: str, action }, required: ['equals', 'action'], additionalProperties: false } }, otherwise: action }, required: ['field_api_name', 'branches', 'otherwise'], additionalProperties: false },
      },
      required: ['app_id', 'object_api_name', 'flow_name', 'flow_api_name', 'form_mode'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const result = await authorCorePlatformFlow({
      appId: String(args.app_id || ''), objectApiName: String(args.object_api_name || ''), flowName: String(args.flow_name || ''), flowApiName: String(args.flow_api_name || ''),
      formMode: args.form_mode === 'canvas_form' ? 'canvas_form' : 'existing_form', formName: typeof args.form_name === 'string' ? args.form_name : undefined,
      fieldApiNames: Array.isArray(args.field_api_names) ? args.field_api_names.map(String) : undefined, description: typeof args.description === 'string' ? args.description : undefined,
      isActive: typeof args.is_active === 'boolean' ? args.is_active : undefined, isDefault: typeof args.is_default === 'boolean' ? args.is_default : undefined, allowCancel: typeof args.allow_cancel === 'boolean' ? args.allow_cancel : undefined,
      actions: Array.isArray(args.actions) ? args.actions.map((item: any) => ({ type: item.type === 'update_record' ? 'update_record' : 'create_record', objectApiName: String(item.object_api_name || ''), values: item.values && typeof item.values === 'object' ? item.values : {}, recordIdTemplate: typeof item.record_id_template === 'string' ? item.record_id_template : undefined, label: typeof item.label === 'string' ? item.label : undefined })) : undefined,
      nodes: Array.isArray(args.nodes) ? args.nodes.map((item: any) => item.type === 'wait'
        ? { type: 'wait' as const, duration: Number(item.duration), unit: item.unit === 'hours' || item.unit === 'days' ? item.unit : 'minutes', label: item.label }
        : item.type === 'subflow' ? { type: 'subflow' as const, flowApiName: String(item.flow_api_name || ''), waitForCompletion: item.wait_for_completion, label: item.label }
        : item.type === 'approval' ? { type: 'approval' as const, approverSetId: String(item.approver_set_id || ''), selectedUserIds: Array.isArray(item.selected_user_ids) ? item.selected_user_ids.map(String) : [], approvalPolicy: item.approval_policy === 'all' ? 'all' as const : 'any' as const, label: item.label }
        : { type: 'manual_task' as const, assignee: String(item.assignee || ''), instructions: item.instructions, label: item.label }) : undefined,
      routing: args.routing && typeof args.routing === 'object' ? {
        fieldApiName: String((args.routing as any).field_api_name || ''),
        branches: Array.isArray((args.routing as any).branches) ? (args.routing as any).branches.map((branch: any) => ({ equals: branch.equals, label: branch.label, action: { type: branch.action?.type === 'update_record' ? 'update_record' as const : 'create_record' as const, objectApiName: String(branch.action?.object_api_name || ''), values: branch.action?.values || {}, recordIdTemplate: branch.action?.record_id_template, label: branch.action?.label } })) : [],
        otherwise: { type: (args.routing as any).otherwise?.type === 'update_record' ? 'update_record' : 'create_record', objectApiName: String((args.routing as any).otherwise?.object_api_name || ''), values: (args.routing as any).otherwise?.values || {}, recordIdTemplate: (args.routing as any).otherwise?.record_id_template, label: (args.routing as any).otherwise?.label },
      } : undefined,
    }, ctx);
    return withEvidence({ ...result }, { subject: 'Core Platform Flow', scope: { kind: 'application', id: result.appId, label: ctx.targetApps?.[0]?.name }, method: result.status === 'created' ? 'POST' : result.status === 'updated' ? 'PATCH' : 'GET', operation: 'curated Core Platform Flow authoring', complete: result.status !== 'blocked', returned: result.flowId ? 1 : 0, total: result.flowId ? 1 : 0 });
  },
};
