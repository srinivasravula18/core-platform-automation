import type { AgentTool, ToolContext } from '../tools/types';
import { allowSupervisorTool } from './policy';

/** One policy-filtered registry for each scoped Codex/MCP turn. */
export function selectSupervisorTools(tools: AgentTool[], ctx: ToolContext): AgentTool[] {
  return tools.filter((tool) => allowSupervisorTool(tool, ctx.role));
}
