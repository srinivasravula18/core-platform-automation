import type { ApiEndpoint } from '../../../features/api-intelligence/types';
import type { FlowOperations } from './types';

const method = (operation: ApiEndpoint) => String(operation.method).toUpperCase();
const matches = (operation: ApiEndpoint, verb: string, pattern: RegExp) => method(operation) === verb && pattern.test(operation.path);
const one = (operations: ApiEndpoint[], verb: string, pattern: RegExp, label: string) => {
  const operation = operations.find((item) => matches(item, verb, pattern));
  if (!operation) throw new Error(`The selected target does not expose the documented ${label} operation required for Flow authoring.`);
  return operation;
};

export function resolveFlowOperations(operations: ApiEndpoint[]): FlowOperations {
  const objectFlows = /\/admin\/objects\/\{[^}]+\}\/flows\/?$/i;
  const flowDetail = /\/admin\/objects\/\{[^}]+\}\/flows\/\{[^}]+\}\/?$/i;
  const flowSteps = /\/admin\/objects\/\{[^}]+\}\/flows\/\{[^}]+\}\/steps\/?$/i;
  const stepDetail = /\/admin\/objects\/\{[^}]+\}\/flows\/\{[^}]+\}\/steps\/\{[^}]+\}\/?$/i;
  return {
    listObjects: one(operations, 'GET', /\/api\/apps\/\{[^}]+\}\/objects\/?$/i, 'list objects'),
    describeObject: one(operations, 'GET', /\/api\/apps\/\{[^}]+\}\/objects\/\{[^}]+\}\/describe\/?$/i, 'describe object'),
    listForms: one(operations, 'GET', /\/admin\/objects\/\{[^}]+\}\/forms\/?$/i, 'list forms'),
    listFlows: one(operations, 'GET', objectFlows, 'list object flows'),
    createFlow: one(operations, 'POST', objectFlows, 'create object flow'),
    getFlow: one(operations, 'GET', flowDetail, 'get object flow'),
    updateFlow: one(operations, 'PATCH', flowDetail, 'update object flow'),
    listSteps: one(operations, 'GET', flowSteps, 'list flow steps'),
    createStep: one(operations, 'POST', flowSteps, 'create flow step'),
    updateStep: one(operations, 'PATCH', stepDetail, 'update flow step'),
  };
}

export function resolveApproverSetsOperation(operations: ApiEndpoint[]): ApiEndpoint {
  return one(operations, 'GET', /\/admin\/approver-sets\/?$/i, 'list approver sets');
}

export function operationPathParams(operation: ApiEndpoint, values: string[]): Record<string, string> {
  const names = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (names.length !== values.length) throw new Error(`Could not bind path parameters for ${operation.method} ${operation.path}.`);
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}
