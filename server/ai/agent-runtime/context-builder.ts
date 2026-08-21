import type { ToolContext } from '../tools/types';

export type SelectedTarget = { id?: string; name: string; baseUrl: string };

export function buildAgentRuntimeContext(input: {
  workspaceId?: string;
  userId?: string;
  role?: string;
  projectId?: string;
  appId?: string | null;
  userMessage: string;
  conversationId?: string;
  targets?: SelectedTarget[];
}): ToolContext {
  const targetApps = (input.targets || [])
    .filter((target) => target && typeof target.baseUrl === 'string' && target.baseUrl.trim())
    .map((target) => ({ id: String(target.id || ''), name: String(target.name || ''), baseUrl: target.baseUrl.trim() }));
  return {
    workspaceId: input.workspaceId || 'default', userId: input.userId, role: input.role, projectId: input.projectId,
    appId: input.appId || null, userMessage: input.userMessage, conversationId: input.conversationId,
    targetApps,
  };
}

export function hasSelectedTarget(ctx: ToolContext): boolean {
  return Array.isArray(ctx.targetApps) && ctx.targetApps.length > 0;
}
