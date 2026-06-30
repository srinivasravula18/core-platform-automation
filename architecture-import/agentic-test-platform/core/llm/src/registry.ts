/**
 * Provider + model registry.
 *
 * The model lists are the latest known ids as of this build and are CONFIGURABLE — override per
 * provider with env (e.g. ATP_MODELS_OPENAI="gpt-5.1,gpt-5-mini"). Provider ids change often; this
 * is a tuning knob, not a hardcoded fact (ponytail: leave the calibration knob).
 */
export type ProviderName = "anthropic" | "openai" | "google" | "local-claude" | "local-codex" | "mock";

export interface ModelInfo {
  id: string;
  label: string;
  /** suggested role tier this model fits: reasoning | balanced | fast */
  tier: "reasoning" | "balanced" | "fast";
}

function fromEnv(envKey: string, fallback: ModelInfo[]): ModelInfo[] {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  return raw.split(",").map((id) => ({ id: id.trim(), label: id.trim(), tier: "balanced" as const }));
}

export const MODEL_REGISTRY: Record<Exclude<ProviderName, "mock">, ModelInfo[]> = {
  anthropic: fromEnv("ATP_MODELS_ANTHROPIC", [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", tier: "reasoning" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "balanced" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "fast" },
    { id: "claude-fable-5", label: "Claude Fable 5", tier: "balanced" },
  ]),
  openai: fromEnv("ATP_MODELS_OPENAI", [
    { id: "gpt-5.1", label: "GPT-5.1", tier: "reasoning" },
    { id: "gpt-5", label: "GPT-5", tier: "reasoning" },
    { id: "gpt-5-mini", label: "GPT-5 mini", tier: "balanced" },
    { id: "o4-mini", label: "o4-mini", tier: "fast" },
  ]),
  google: fromEnv("ATP_MODELS_GOOGLE", [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "reasoning" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "balanced" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tier: "fast" },
  ]),
  // local CLI providers use whatever model the authenticated CLI is configured with;
  // an optional model can still be passed through.
  "local-claude": fromEnv("ATP_MODELS_LOCAL_CLAUDE", [{ id: "default", label: "Claude CLI (local auth)", tier: "balanced" }]),
  "local-codex": fromEnv("ATP_MODELS_LOCAL_CODEX", [{ id: "default", label: "Codex CLI (local auth)", tier: "balanced" }]),
};

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
  "local-claude": "Local — Claude CLI (no API key)",
  "local-codex": "Local — Codex CLI (no API key)",
  mock: "Mock (tests)",
};

/** Default model for a provider (first in its list). */
export function defaultModel(provider: ProviderName): string {
  if (provider === "mock") return "mock";
  return MODEL_REGISTRY[provider][0]?.id ?? "default";
}
