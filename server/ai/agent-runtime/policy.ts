import type { AgentTool } from '../tools/types';

/** Tool visibility is policy-driven; request text never grants target-data authority. */
export function isTargetDataWrite(toolName: string): boolean {
  return toolName === 'create_record';
}

export function allowSupervisorTool(tool: AgentTool, role?: string): boolean {
  // Phase 1 is read-only for connected target data. QA artifact creation retains its existing flow.
  if (isTargetDataWrite(tool.spec.name)) return false;
  if (tool.spec.name === 'execute_platform_api_write' || tool.spec.name === 'author_core_platform_flow') return String(role).toLowerCase() === 'admin';
  return true;
}

/** Target mutations remain narrow even when an OpenAPI document advertises more routes. */
export function allowsTargetMutation(method: string, path: string): boolean {
  if (!['POST', 'PATCH'].includes(String(method).toUpperCase())) return false;
  const reserved = new Set(['auth', 'agent', 'agents', 'recycle-bin', 'recyclebin']);
  return !String(path).split('/').some((segment) => reserved.has(segment.toLowerCase()));
}
