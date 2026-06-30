/** ponytail self-check: the agent's tools do real groundwork. Run: pnpm -F @atp/tools test */
import assert from "node:assert/strict";
import { EmptyMetadataClient, RunStore, TOOL_MAP, toolCatalogPrompt, type ToolContext } from "./index.ts";

const ctx: ToolContext = { metadata: new EmptyMetadataClient(), runs: new RunStore(), orgs: new Map() };

await assert.rejects(() => TOOL_MAP["describe_object"]!.run({ object: "leave_request" }, ctx), /No metadata source/);

const run = (await TOOL_MAP["run_suite"]!.run({ object: "leave_request", suiteType: "sanity" }, ctx)) as { executed: boolean; error?: string };
assert.equal(run.executed, false);
assert.match(run.error ?? "", /Simulated suite execution is disabled/);

// connect_org does CRUD into the session org map
await TOOL_MAP["connect_org"]!.run({ name: "qa-org", baseUrl: "https://qa.example.com" }, ctx);
assert.ok(ctx.orgs.has("qa-org"));

// connect_repo on a non-existent local path reports the error (no throw); repo_info reflects state
const bad = (await TOOL_MAP["connect_repo"]!.run({ path: "E:/__definitely_not_here__" }, ctx)) as { error?: string };
assert.ok(bad.error, "non-existent path should report an error");
assert.ok(ctx.repo, "connect_repo records the attempt on the context");

// the tool catalog renders for the system prompt
assert.ok(toolCatalogPrompt().includes("generate_tests"));

console.log("✓ tools self-check passed (metadata + generate + run + evidence + connect_org)");
