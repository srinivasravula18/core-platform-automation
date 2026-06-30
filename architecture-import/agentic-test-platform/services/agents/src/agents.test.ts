/** ponytail self-check: the conversational agent calls tools then finalizes (mock LLM, no network).
 *  Run: pnpm -F @atp/agents test */
import assert from "node:assert/strict";
import { MockProvider, type LLMRequest } from "@atp/llm";
import { EmptyMetadataClient, RunStore } from "@atp/tools";
import { runOrchestrator, parseAction, type AgentEvent } from "./index.ts";

// a scripted "model": repo inspection -> final, based on observations seen so far
const responder = (req: LLMRequest): string => {
  const obs = req.messages.filter((m) => m.content.startsWith("OBSERVATION")).length;
  if (obs === 0) return '```json\n{"thought":"inspect","tool":"repo_info","input":{}}\n```';
  return '```json\n{"thought":"done","final":"No fixture metadata was used.","artifacts":[]}\n```';
};

// parseAction handles fenced + bare JSON, and protocol violations
assert.equal(parseAction('```json\n{"tool":"x","input":{}}\n```').tool, "x");
assert.equal(parseAction("not json").raw, "not json");

const events: AgentEvent[] = [];
const result = await runOrchestrator({
  provider: new MockProvider(responder),
  ctx: { metadata: new EmptyMetadataClient(), runs: new RunStore(), orgs: new Map() },
  userMessage: "inspect the connected repo",
  onEvent: (e) => events.push(e),
});

const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool);
assert.deepEqual(toolCalls, ["repo_info"]);
assert.ok(events.some((e) => e.type === "tool_result" && !(e as { isError: boolean }).isError));
assert.ok(result.final.includes("No fixture metadata"));

console.log("✓ agents self-check passed (tool-loop: describe -> generate -> final)");
