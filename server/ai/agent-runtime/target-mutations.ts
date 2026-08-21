import type { ToolContext } from '../tools/types';
import { callTargetReadOperation, callTargetWriteOperation, listTargetApiOperations } from '../tools/targetMetadata';
import { beginOperationReceipt, completeOperationReceipt, failOperationReceipt } from './operationReceipts';
import { buildAgentScopeHash, invalidateCompletedAgentResults } from './responseCache';

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

export async function executeTargetMutation(input: TargetMutation): Promise<{ summary: string; result: unknown; verification: unknown; idempotency: { reused: boolean; resourceId?: string; receipt: string } }> {
  const operations = await listTargetApiOperations(input.ctx);
  const write = operations.find((item: any) => item.id === input.operationId);
  const verify = operations.find((item: any) => item.id === input.verifyOperationId);
  if (!write) throw new Error('The write operation is no longer present in the target OpenAPI document.');
  if (!verify || String(verify.method).toUpperCase() !== 'GET') throw new Error('A live documented GET operation is required to verify this write.');
  const summary = `${String(write.method).toUpperCase()} ${String(write.path)}; verify with GET ${String(verify.path)}`;
  await callTargetReadOperation(input.verifyOperationId, input.verifyPathParams, input.verifyQuery, input.ctx);
  const started = await beginOperationReceipt({
    ctx: input.ctx, operationId: input.operationId, method: String(write.method), targetType: String(write.path),
    pathParams: input.pathParams, query: input.query, body: input.body,
  });
  if (!started.acquired) {
    if (started.receipt.status === 'completed') {
      return {
        summary, result: started.receipt.response, verification: started.receipt.verification,
        idempotency: { reused: true, resourceId: started.receipt.resourceId, receipt: started.receipt.idempotencyKey },
      };
    }
    if (started.receipt.status === 'running') throw new Error('An identical create/update operation is already running. It was not started again.');
    throw new Error(`This create/update was previously attempted and has an uncertain failed outcome, so it was not replayed automatically. ${started.receipt.error || ''}`.trim());
  }
  try {
    const result = await callTargetWriteOperation(input.operationId, input.pathParams, input.query, input.body, input.ctx);
    const verification = await callTargetReadOperation(input.verifyOperationId, input.verifyPathParams, input.verifyQuery, input.ctx);
    const receipt = await completeOperationReceipt(started.receipt.idempotencyKey, result, verification);
    await invalidateCompletedAgentResults(buildAgentScopeHash({
      workspaceId: String(input.ctx.workspaceId || 'default'), userId: input.ctx.userId ? String(input.ctx.userId) : '', role: input.ctx.role ? String(input.ctx.role) : '',
      projectId: input.ctx.projectId ? String(input.ctx.projectId) : '', appId: input.ctx.appId ? String(input.ctx.appId) : '',
      targets: (input.ctx.targetApps || []).map((target) => ({ id: target.id, name: target.name, baseUrl: target.baseUrl })),
    })).catch(() => undefined);
    return { summary, result, verification, idempotency: { reused: false, resourceId: receipt.resourceId, receipt: receipt.idempotencyKey } };
  } catch (error) {
    await failOperationReceipt(started.receipt.idempotencyKey, error).catch(() => undefined);
    throw error;
  }
}
