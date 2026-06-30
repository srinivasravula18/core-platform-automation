/** ponytail self-check: provider registry + factory + mock completion (no network). Run: pnpm -F @atp/llm test */
import assert from "node:assert/strict";
import { createProvider, MODEL_REGISTRY, defaultModel, PROVIDER_LABELS } from "./index.ts";

// registry exposes the three API providers + two local CLI providers with latest models
assert.ok(MODEL_REGISTRY.anthropic.some((m) => m.id === "claude-opus-4-8"));
assert.ok(MODEL_REGISTRY.openai.some((m) => m.id.startsWith("gpt-5")));
assert.ok(MODEL_REGISTRY.google.some((m) => m.id.startsWith("gemini")));
assert.equal(defaultModel("anthropic"), "claude-opus-4-8");
assert.ok(PROVIDER_LABELS["local-claude"].includes("no API key"));
assert.ok(PROVIDER_LABELS["local-codex"].includes("no API key"));

// factory wires each provider without instantiating SDKs/spawning CLIs
for (const p of ["anthropic", "openai", "google", "local-claude", "local-codex"] as const) {
  const prov = createProvider({ provider: p });
  assert.equal(prov.name, p);
  assert.ok(prov.model.length > 0);
}

// mock provider completes deterministically (used by the rest of the suite)
const mock = createProvider({ provider: "mock" });
const res = await mock.complete({ messages: [{ role: "user", content: "ping" }] });
assert.equal(res.text, "MOCK(ping)");

console.log("✓ llm self-check passed (multi-provider registry + factory + mock)");
