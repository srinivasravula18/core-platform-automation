/**
 * Shared credential type used by the agent flow.
 *
 * The agent service expects credentials in this shape; the credentials service
 * produces it via `resolveCredentials`. Keeping the type here avoids a circular
 * import between `agent/` and `credentials/`.
 */

export interface AgentRunCredentials {
  username: string;
  password: string;
  siteName: string;
  baseUrl: string;
  environment: string;
}
