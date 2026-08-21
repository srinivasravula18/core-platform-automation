import type { AgentTool } from '../tools/types';
import { callTargetReadOperation, listTargetApiOperations } from '../tools/targetMetadata';
import { executeTargetMutation } from './target-mutations';
import { allowsTargetMutation } from './policy';
import type { ApiEndpoint } from '../../features/api-intelligence/types';

export function discoverableTargetOperations(operations: ApiEndpoint[]) {
  return operations.filter((operation) => operation.method === 'GET' || allowsTargetMutation(operation.method, operation.path)).map((operation) => ({
    id: operation.id, method: operation.method, path: operation.path, summary: operation.summary, tags: operation.tags,
    parameters: operation.contract.request.params, bodySchema: operation.contract.request.bodySchema,
  }));
}

export const openApiReadTools: AgentTool[] = [
  {
    spec: { name: 'search_api_operations', description: 'Search the selected target\'s live OpenAPI operations. Use this when no curated tool matches a requested read or target mutation; results include GET operations and only safely stageable POST or PATCH operations.', parameters: { type: 'object', properties: {} } },
    async execute(_args, ctx) {
      const operations = await listTargetApiOperations(ctx);
      return { operations: discoverableTargetOperations(operations) };
    },
  },
  {
    spec: { name: 'call_platform_api', description: 'Execute one GET operation returned by search_api_operations. The operation and parameters are revalidated against the target OpenAPI document at call time.', parameters: { type: 'object', properties: { operation_id: { type: 'string' }, path_params: { type: 'object' }, query: { type: 'object' } }, required: ['operation_id'] } },
    async execute(args, ctx) {
      return callTargetReadOperation(String(args.operation_id || ''), (args.path_params || {}) as Record<string, unknown>, (args.query || {}) as Record<string, unknown>, ctx);
    },
  },
  {
    spec: { name: 'execute_platform_api_write', description: 'Execute a documented safe POST or PATCH operation using the signed-in user credentials, then verify it through a documented GET operation. Available only to administrators.', parameters: { type: 'object', properties: { operation_id: { type: 'string' }, path_params: { type: 'object' }, query: { type: 'object' }, body: {}, verify_operation_id: { type: 'string' }, verify_path_params: { type: 'object' }, verify_query: { type: 'object' } }, required: ['operation_id', 'verify_operation_id'] } },
    async execute(args, ctx) {
      return executeTargetMutation({
        ctx,
        operationId: String(args.operation_id || ''),
        pathParams: (args.path_params || {}) as Record<string, unknown>,
        query: (args.query || {}) as Record<string, unknown>,
        body: args.body,
        verifyOperationId: String(args.verify_operation_id || ''),
        verifyPathParams: (args.verify_path_params || {}) as Record<string, unknown>,
        verifyQuery: (args.verify_query || {}) as Record<string, unknown>,
      });
    },
  },
];
