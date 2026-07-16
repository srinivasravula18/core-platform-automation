/**
 * REMOTE_AGENT_V1 — dark-launch flag for the Record & Play local desktop agent module.
 *
 * Unset or 0 = the feature is fully inert: no agent routes register behavior, no WS
 * gateway attaches, no scheduler ticks, and the frontend renders no Automation-agent UI.
 * The existing app (including the legacy cloud-side /api/playwright/codegen recorder) is
 * byte-for-byte unchanged. Follows the AGENT_GRAPH_V2 / isWorkflowGraphEnabled() pattern.
 */
export function isRemoteAgentEnabled(): boolean {
  const raw = String(process.env.REMOTE_AGENT_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
