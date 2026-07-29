/**
 * AGENT_NATIVE_V1 — master dark-launch flag for the agent-native re-architecture (bus/blackboard,
 * registry, memory gate, run store, router). OFF (default) = today's behavior byte-for-byte; ON = cut-over
 * phases route through the new substrate. Gates CONSUMPTION, not the mere existence of the primitives.
 */
export function isAgentNativeEnabled(): boolean {
  const raw = String(process.env.AGENT_NATIVE_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
