/**
 * MCP availability cache (RC-4) — makes "try MCP first" safe to enable by default.
 *
 * Without this, every inspection on a deployment that lacks a working @playwright/mcp server pays the
 * full MCP connect timeout before falling back. With it, the FIRST failed probe marks MCP unavailable
 * for a short TTL, so subsequent inspections skip the MCP attempt instantly and go straight to the
 * classic path. A success marks it available. State is process-local and self-healing (re-probes after
 * the TTL), so a deployment that provisions MCP later starts using it without a restart.
 */

type McpStatus = 'unknown' | 'available' | 'unavailable';

let state: { status: McpStatus; at: number } = { status: 'unknown', at: 0 };

/** How long an 'unavailable' verdict is trusted before we re-probe (ms). Env-tunable. */
function ttlMs(): number {
  const n = Number(process.env.MCP_UNAVAILABLE_TTL_MS || '');
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

/** Connect timeout for MCP sessions (ms). Lower than the old 30s so the first probe fails fast. Env-tunable. */
export function mcpConnectTimeoutMs(): number {
  const n = Number(process.env.MCP_CONNECT_TIMEOUT_MS || '');
  return Number.isFinite(n) && n > 0 ? n : 12_000;
}

/** True when a recent probe proved MCP unavailable and the TTL has not elapsed — skip the attempt. */
export function mcpProbeShouldSkip(): boolean {
  return state.status === 'unavailable' && (Date.now() - state.at) < ttlMs();
}

export function markMcpAvailable(): void {
  state = { status: 'available', at: Date.now() };
}

export function markMcpUnavailable(): void {
  state = { status: 'unavailable', at: Date.now() };
}

/** Current cached status (diagnostics). */
export function mcpAvailabilityStatus(): McpStatus {
  return state.status;
}
