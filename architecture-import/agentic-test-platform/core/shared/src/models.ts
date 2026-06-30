/**
 * Model-tier router. Opus for hard reasoning (plan / replan), Sonnet for codegen/mid,
 * Haiku for cheap extraction/classification. Per Anthropic guidance, route by value×volume.
 * Model ids are current as of the platform's lineup; override via env if they change.
 */

export const MODELS = {
  opus: process.env.ATP_MODEL_OPUS ?? "claude-opus-4-8",
  sonnet: process.env.ATP_MODEL_SONNET ?? "claude-sonnet-4-6",
  haiku: process.env.ATP_MODEL_HAIKU ?? "claude-haiku-4-5-20251001",
} as const;

export type ModelTier = keyof typeof MODELS;

/** Agent roles → default tier. The orchestrator may escalate a role to a higher tier. */
export const ROLE_TIER: Record<string, ModelTier> = {
  orchestrator: "sonnet", // front door; escalate to opus for complex planning
  "analyst-planner": "opus",
  "case-designer": "sonnet",
  "script-engineer": "sonnet",
  "api-test": "sonnet",
  reporter: "haiku",
};

export function modelForRole(role: string, escalate = false): string {
  const tier = ROLE_TIER[role] ?? "sonnet";
  if (escalate && tier !== "opus") return MODELS.opus;
  return MODELS[tier];
}
