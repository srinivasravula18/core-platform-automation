import type { ProviderConfig } from "./types.ts";
import type { ProviderName } from "./registry.ts";

/**
 * Resolve the active provider from env.
 *  - Production: set LLM_PROVIDER=anthropic|openai|google and the matching API key.
 *  - Local dev/testing: LLM_PROVIDER=local-claude or local-codex — uses your authenticated CLI,
 *    no API key required.
 * Default is local-claude so a fresh checkout works against your local Claude auth.
 */
export function providerFromEnv(): ProviderConfig {
  const provider = (process.env.LLM_PROVIDER as ProviderName) ?? "local-claude";
  const keyByProvider: Partial<Record<ProviderName, string | undefined>> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
  };
  return {
    provider,
    model: process.env.LLM_MODEL,
    apiKey: keyByProvider[provider],
    command: process.env.LLM_LOCAL_COMMAND,
  };
}
