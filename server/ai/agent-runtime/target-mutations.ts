import type { ToolContext } from '../tools/types';
import { callTargetReadOperation, callTargetWriteOperation, listTargetApiOperations } from '../tools/targetMetadata';

type TargetMutation = {
  ctx: ToolContext;
  operationId: string;
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  verifyOperationId: string;
  verifyPathParams: Record<string, unknown>;
  verifyQuery: Record<string, unknown>;
};

export async function executeTargetMutation(input: TargetMutation): Promise<{ summary: string; result: unknown; verification: unknown }> {
  const operations = await listTargetApiOperations(input.ctx);
  const write = operations.find((item: any) => item.id === input.operationId);
  const verify = operations.find((item: any) => item.id === input.verifyOperationId);
  if (!write) throw new Error('The write operation is no longer present in the target OpenAPI document.');
  if (!verify || String(verify.method).toUpperCase() !== 'GET') throw new Error('A live documented GET operation is required to verify this write.');
  const summary = `${String(write.method).toUpperCase()} ${String(write.path)}; verify with GET ${String(verify.path)}`;
  await callTargetReadOperation(input.verifyOperationId, input.verifyPathParams, input.verifyQuery, input.ctx);
  const result = await callTargetWriteOperation(input.operationId, input.pathParams, input.query, input.body, input.ctx);
  const verification = await callTargetReadOperation(input.verifyOperationId, input.verifyPathParams, input.verifyQuery, input.ctx);
  return { summary, result, verification };
}
