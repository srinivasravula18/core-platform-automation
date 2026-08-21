import type { ApiEndpoint } from '../../../features/api-intelligence/types';

export type FlowFormMode = 'existing_form' | 'canvas_form';
export type FlowRecordAction = {
  type: 'create_record' | 'update_record';
  objectApiName: string;
  values: Record<string, unknown>;
  recordIdTemplate?: string;
  label?: string;
};
export type FlowFollowUpNode =
  | { type: 'wait'; duration: number; unit: 'minutes' | 'hours' | 'days'; label?: string }
  | { type: 'manual_task'; assignee: string; instructions?: string; label?: string }
  | { type: 'approval'; approverSetId: string; selectedUserIds: string[]; approvalPolicy?: 'any' | 'all'; label?: string }
  | { type: 'subflow'; flowApiName: string; waitForCompletion?: boolean; label?: string };
export interface FlowConditionalRouting {
  fieldApiName: string;
  branches: Array<{ equals: unknown; action: FlowRecordAction; label?: string }>;
  otherwise: FlowRecordAction;
}

export interface FlowAuthoringIntent {
  appId: string;
  objectApiName: string;
  flowName: string;
  flowApiName: string;
  formMode: FlowFormMode;
  formName?: string;
  fieldApiNames?: string[];
  description?: string;
  isActive?: boolean;
  isDefault?: boolean;
  allowCancel?: boolean;
  actions?: FlowRecordAction[];
  nodes?: FlowFollowUpNode[];
  routing?: FlowConditionalRouting;
}

export interface FlowOperations {
  listObjects: ApiEndpoint;
  describeObject: ApiEndpoint;
  listForms: ApiEndpoint;
  listFlows: ApiEndpoint;
  createFlow: ApiEndpoint;
  getFlow: ApiEndpoint;
  updateFlow: ApiEndpoint;
  listSteps: ApiEndpoint;
  createStep: ApiEndpoint;
  updateStep: ApiEndpoint;
}

export interface ResolvedFlowField {
  apiName: string;
  label: string;
  type: string;
  required: boolean;
  picklistValues: Array<{ value: string; label: string }>;
}

export interface FlowAuthoringResult {
  status: 'created' | 'updated' | 'blocked';
  message: string;
  appId: string;
  objectId?: string;
  objectApiName: string;
  flowId?: string;
  flowApiName: string;
  verification?: { flow: unknown; steps: unknown };
}
