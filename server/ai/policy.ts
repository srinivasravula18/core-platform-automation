import { getUserById } from '../features/auth/userStore';
import { effectiveGrantsForUser, type EffectiveGrants } from '../features/auth/groupStore';
import { permits, toPermSet } from '../features/auth/permissions';
import type { AgentTool, ToolCapability } from './tools/types';

const DESTRUCTIVE_TOOL = /^(delete|remove|reset|deactivate|disable|archive|purge|destroy|revoke|terminate|recycle|trash|erase|wipe|drop|empty_trash)/;
const WRITE_TOOL = /^(create|update|move|rework|expand|generate|run|execute|call_platform_api)/;

export function capabilityFor(tool: AgentTool): ToolCapability {
  if (tool.capability) return tool.capability;
  const name = String(tool.spec.name || '').toLowerCase();
  if (DESTRUCTIVE_TOOL.test(name)) return { effect: 'destructive' };
  if (WRITE_TOOL.test(name)) return { effect: 'write', permissions: ['agent:execute'] };
  return { effect: 'read', permissions: ['agent:read'] };
}

export function filterToolsByGrants(tools: AgentTool[], grants: EffectiveGrants): AgentTool[] {
  const permissions = toPermSet(grants);
  return tools.filter((tool) => {
    const capability = capabilityFor(tool);
    if (capability.effect === 'destructive') return false;
    return (capability.permissions || []).every((permission) => permits(permissions, permission));
  });
}

/** Resolve grants from the authenticated server identity; client-supplied roles are never trusted. */
export function toolsForUser(tools: AgentTool[], userId?: string): AgentTool[] {
  return filterToolsByGrants(tools, effectiveGrantsForUser(getUserById(String(userId || ''))));
}
