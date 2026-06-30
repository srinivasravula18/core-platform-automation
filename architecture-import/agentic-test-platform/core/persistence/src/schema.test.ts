/** ponytail smoke check: the schema imports and the key tables/columns exist (no live DB needed).
 *  Run: pnpm -F @atp/db test */
import assert from "node:assert/strict";
import * as s from "./schema.ts";

// core data model present
for (const t of ["orgs", "projects", "metadataSnapshot", "mdObject", "mdField", "elementCatalog", "runs", "runResults", "evidence", "jobs", "rtm"] as const) {
  assert.ok(s[t], `missing table: ${t}`);
}

// the agent-comms + memory tables the new emphasis added
assert.ok(s.chatSessions.summary, "chat memory: sessions need a rolling summary column");
assert.ok(s.chatMessages.seq, "chat messages need a seq column");
assert.ok(s.agentMemory.scope, "per-agent memory needs a scope (fact|note)");
assert.ok(s.agentMessages.correlationId, "A2A transcript needs a correlationId");
assert.ok(s.agentMessages.fromAgent && s.agentMessages.toAgent, "A2A transcript needs from/to agents");

// run pins a metadata snapshot + carries the OTel trace_id join key
assert.ok(s.runs.snapshotId && s.runs.traceId, "runs must pin snapshot + carry trace_id");

console.log("✓ db schema smoke check passed (core model + chat/memory/A2A tables)");
