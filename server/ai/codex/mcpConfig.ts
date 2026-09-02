export type CodexMcpServerConfig = {
  url: string;
  bearerTokenEnvVar?: string;
  allowedTools?: string[];
};

/** Build the shared `mcp_servers.<name>` table consumed by both Codex transports. */
export function codexMcpServers(servers?: Record<string, CodexMcpServerConfig>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers || {})) {
    out[name] = {
      url: server.url,
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      ...(server.allowedTools?.length ? { enabled_tools: server.allowedTools } : {}),
      startup_timeout_sec: 30,
      tool_timeout_sec: 300,
    };
  }
  return out;
}
