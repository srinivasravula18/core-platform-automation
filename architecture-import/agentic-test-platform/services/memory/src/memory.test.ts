/** ponytail self-check: chat memory compaction + per-agent recall isolation. Run: pnpm -F @atp/memory test */
import assert from "node:assert/strict";
import { InMemoryStore } from "./store.ts";
import { ConversationMemory } from "./conversation.ts";
import { AgentMemory } from "./agent-memory.ts";

// --- conversation memory: compaction folds old turns into a summary, keeps recent ---
{
  const store = new InMemoryStore();
  const chat = new ConversationMemory(store, "session-1");
  for (let i = 0; i < 10; i++) chat.add(i % 2 ? "assistant" : "user", `turn ${i} `.repeat(20));
  assert.equal(chat.history().length, 10);

  const compacted = await chat.compactIfNeeded(50, 3, async (prior, dropped) =>
    `${prior ?? ""}[${dropped.length} earlier turns]`.trim(),
  );
  assert.equal(compacted, true);
  assert.equal(chat.history().length, 3, "keeps the last 3 turns");
  assert.ok(chat.summary()!.includes("7 earlier turns"), "older turns folded into summary");
  // toContext prepends the summary as a system note
  assert.equal(chat.toContext()[0]!.role, "system");
}

// --- per-agent memory: facts are isolated per agent, recall is relevance-ranked ---
{
  const store = new InMemoryStore();
  const planner = new AgentMemory(store, "analyst-planner");
  const script = new AgentMemory(store, "script-engineer");

  planner.remember("The HR app's leave_request requires start_date and end_date", ["hr", "leave_request"]);
  script.remember("leave_type renders as a combobox; getByRole combobox name 'Leave Type'", ["locator", "leave_request"]);
  script.remember("status field is sometimes slow to render; prefer auto-wait", ["flaky", "status"]);

  // isolation: planner cannot see the script engineer's memory
  assert.equal(planner.recall("locator combobox").length, 0);
  assert.equal(script.recall("locator").length, 1);

  // relevance: query about flaky status returns the flaky note first
  const r = script.recall("status flaky render");
  assert.ok(r[0]!.text.includes("slow to render"));

  // working notes are separate from durable facts and clearable
  script.note("currently editing TC-LEAVE_REQUEST-CREATE");
  assert.equal(script.notes().length, 1);
  script.clearNotes();
  assert.equal(script.notes().length, 0);
  assert.equal(script.recall("leave_type").length, 1, "clearing notes leaves facts intact");
}

console.log("✓ memory self-check passed (chat compaction + per-agent recall isolation)");
