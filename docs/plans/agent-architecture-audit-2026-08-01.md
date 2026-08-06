# Agent / Tool-Calling / Memory Architecture Audit + Scalability Plan

**Date:** 2026-08-01
**Mode:** Phase-0 analysis only (per CLAUDE.md "Principal Architect" process). No files changed. Awaiting explicit approval before any implementation.
**Method:** Three parallel deep-read passes over the real code (`server/ai/**`, `server/agent-core/**`, `server/features/agent/workflow/**`), every claim `file:line`-cited. This audits the *actual* runtime, not the idealized diagram.

---

## 0. The one finding that reframes everything

Your architecture diagram describes **Pattern B** — a message bus + blackboard where agents talk to each other. That layer is **built, typed, tested… and turned OFF.**

- `AGENT_NATIVE_V1` defaults **false** (`agent-core/agentNativeFlag.ts:6-9`). No `.env` enables it.
- The **live executor is the LangGraph staged pipeline** (`AGENT_GRAPH_V2` defaults ON — `features/agent/workflow/checkpointer.ts:20-22`), driven by `WorkflowState` mutation in `workflow/runtime.ts`.
- The bus/blackboard is attached **shadow-only**: `runInstrumentation.ts:1-16` states in its own header it "changes NO control flow and makes NO decision." It *narrates* the graph after the fact; `routes.ts:1940` fires `orchestrateRunStart` fire-and-forget (`void …catch()`), comment: "the graph remains the executor."
- `runViaBus.ts` (the actual agent-to-agent handoff) has **no live callers** — only test scripts.

**So today there are two coordination systems: one that runs the work (LangGraph) and one that describes it (bus/blackboard).** The elegant A2A design is unrealized potential, and it is *re-implementing* coordination that the graph already expresses as edges — with a hand-maintained `STAGE_AGENT` map (`runInstrumentation.ts:28-39`) that will drift from the graph. **The first strategic decision is: cut the bus over to load-bearing, or freeze it as pure observability and stop growing it.** Everything below assumes you want to cut it over (that's the scalable direction).

---

## 1. Tool-calling — findings

**Contract** (`ai/tools/types.ts:35-42`): `AgentTool = { spec, capability?, execute(args, ctx) }`; `ToolContext` (`:15-24`) is an open index signature — effectively untyped, fields set ad hoc (`supervisor.ts:602-610`).

Strengths worth preserving:
- **Post-write mutation verification** — after any `write` tool, `verifyToolMutation` re-reads the entity to prove it persisted (`orchestrator.ts:486-489`, `verification.ts:56-107`). This is the standout feature; it kills the "fake-green" failure mode.
- **Honesty gate** on empty/truncated finals (`orchestrator.ts:577-595`).
- **Structured error feedback + recovery hint** fed back to the model (`:513-514`), Reflexion critic retries (`:597-609`), loop-pathology guards (3 repeats / 5 failures — `toolProgress.ts:17-27`).
- Provider-agnostic native tool-calling; MCP schema sanitization (`mcpClient.ts:40-57`).

Weaknesses (prioritized):
1. **No per-request tool filtering — ~31 tool schemas on every turn** (`supervisor.ts:611-614`; `registry.ts:608` `coreTools()` returns all unconditionally), re-sent up to 64× per run. This is the #1 scalability ceiling and grows linearly with every tool added.
2. **Capability enforcement is name-regex inference, not declared, and never re-checked at dispatch.** Most tools omit `capability`; effect is guessed from the name (`policy.ts:6-15`). Enforcement is visibility-time only (`filterToolsByGrants`) — nothing re-authorizes at `orchestrator.ts:481`. A mutating tool with a benign name escapes both the destructive filter and write-verification.
3. **Hardcoded target URL / credentials / `/auth/login`** via `process.env.TARGET_*` in `agentTools.ts:35-37,264,338` — **violates the repo's non-negotiable no-hardcoding rule** and bypasses the `credentialsService` learned-credential layer used elsewhere (`controller.ts:1046`).
4. **Serial-only tool execution** — parallel tool calls the provider returns are run one-by-one in an `await` loop (`orchestrator.ts:471-537`); no `Promise.all` fan-out for independent reads.
5. **No tool-result caching / no per-tool call budget** — only step/token/3-repeat guards; identical expensive calls aren't deduped.
6. **Tight coupling to a 550-line intent `switch`** (`controller.ts:534-1083`): adding one capability means editing 6+ files in lockstep (`INTENT_TOOLS`, `VALID_KINDS`, `AGENT_FOR_INTENT`, `buildSideEffects`, `estimateCost`, `verification.ts`). Plus `maxSteps` silently clamped 200→64 (`toolProgress.ts:34`), stale docs referencing a non-existent `agentLoop.ts`.

---

## 2. Agent-to-agent — findings

Strengths (real, keep them):
- **Typed, causally-linked messages** (`causationId` chains, `messageBus.ts:41`) + **append-only blackboard with per-fact provenance** (`blackboard.ts:16-21`). Auditable, loop-detectable — far better than the old mutable `run: any`.
- **Loop/budget rails**: per-run message budget + causation-depth cap (`messageBus.ts:70-79`).
- **Registry-validated routing** drops unknown agents instead of dispatching them (`routerAgent.ts:84-88`) — kills declared-but-no-handler drift. Selection is **LLM-driven, not hardcoded** (`routerAgent.ts:43-66`).
- **"Agents decide, deterministic code executes"** — compiler/executor are `deterministic` capabilities the orchestrator delegates to, never LLM agents (`capabilities.ts:36-56`).
- **Memory-first app-profile discovery** (`discoverAppProfile.ts:126-169`), app-agnostic.

Weaknesses (prioritized):
1. **The substrate is inert (shadow-only).** All A2A value unrealized; the hand-maintained stage→agent map (`runInstrumentation.ts:28-39`) is a drift surface.
2. **No durable delivery or resume.** Default in-memory bus/blackboard lose everything on restart (`messageBus.ts:250`, `blackboard.ts:180`); even with Postgres the bus is a *transcript, not a work queue* — no ack, no redelivery, no replay consumer. A crash mid-run can only FAIL the run (`runStore.ts:1-12`).
3. **HANDOFF/DELEGATE transfer no real ownership** — no lock, lease, or ack (`runViaBus.ts:68-100`). "Ownership" is a label.
4. **No backpressure / timeout / dead-letter / cancellation on the bus.** Only control is a budget that *throws*; pull-only inbox means a message to an absent agent vanishes silently.
5. **O(n)-per-publish in Postgres** — `COUNT(*)` + full chain scan inside a txn per message (`messageBus.ts:196-206`). Quadratic per run; a scaling ceiling. (Note: bus seq uses `COUNT+1`, blackboard uses `MAX+1` — inconsistent; a delete reuses a bus seq.)
6. **Blackboard has no conflict detection** — append-only + `latest()` = last-writer-wins, no compare-and-set; two agents can publish contradictory `latest` for one `kind` with no reconciliation (`blackboard.ts:44-45,153-156`).

---

## 3. Memory — findings

**Six mostly-independent layers** across two package roots (`ai/memory/**` = live; `agent-core/memory/**` = newer, largely unwired): conversation ledger, summary segments, context assembler, artifact memory, run memory (selector health), and the typed semantic store + gate.

Strengths (preserve):
- **Budget-manifest audit trail** — every prompt assembly persists what was included/excluded and why (`contextBudget.ts:38-45` → `context_manifests`). Rare and excellent.
- **Deterministic ledger recomputed from source of truth** each call (`conversationState.ts:11-27`) — can't drift, can't be lost.
- **Artifact revalidation/freshness** — `fetchArtifact` re-reads source and compares hashes, flags stale evidence (`artifactMemory.ts:101-106`); content-addressed dedup; secret redaction on write (`:9,17-23`).
- **Correct scope-key discipline** in the typed store (write-key == read-key, `store.ts:58-61`) — fixes the historical "dead recall" bug.
- Graceful degradation everywhere (memory is enhancement, not dependency).

Weaknesses (prioritized):
1. **The typed memory GATE is dead code.** `gate.ts:33-101` (`isSelectorKnownBroken`, `preferredApproach`) has **zero live callers**. The live path only *pads the prompt* with flaky-selector text and hopes the LLM obeys (`routes.ts:2974-2981`) — the exact anti-pattern the gate was written to replace. Memory never *branches* control flow.
2. **Zero semantic retrieval.** All recall is substring / recency / lexical-overlap, O(n) scans (`runMemory.ts:149-181`, `artifactMemory.ts:112-124`, `store.ts:69-80`). No embeddings, no vector index.
3. **Restart amnesia (Postgres off).** `InMemoryMemoryStore` (`store.ts:87`) and the summary/manifest/artifact `db` fallbacks are RAM-only and not snapshotted — in a `tsx` backend that restarts constantly with no hot reload. Learned app profiles vanish each restart.
4. **Two parallel episodic selector-memory systems, the weaker one live** — `runMemory.ts` (substring, prompt-padding) vs `agent-core/memory` (typed, ranked, branching). The branching one is dead. ~250 lines of split-brain duplication.
5. **"Summaries" don't summarize** — `conversationSummary.ts:40-42` concatenates raw turns clipped to 800 chars (near-zero compression), kept indefinitely by default (`retention.ts:15`), then silently dropped by the budget. No LLM rollup, no second tier.
6. **No cross-conversation / cross-run knowledge graph** — ledger/summaries/artifacts are `conversationId`-siloed (`conversationState.ts:11`); learnings don't transfer between conversations. Tight budgets drop older turns with **no "N turns omitted" marker** in the actual prompt (`contextAssembler.ts:70,86`).

---

## 4. Cross-cutting themes (the real root causes)

These three recur across all subsystems and are what "not scalable" actually means here:

- **T1 — Built-but-dark.** The best-designed layers (bus/blackboard, memory gate, `runViaBus`) are flag-gated OFF or have zero callers. You are paying the maintenance cost of two systems and getting the capability of the older one. *The scalability problem is not missing design — it's un-activated design that is drifting from the live path.*
- **T2 — Everything scans, nothing indexes.** Tools: all 31 sent every turn. Memory: O(n) substring recall. Bus: O(n) COUNT per publish. Each is fine at demo scale and degrades linearly-to-quadratically with workspace/run/conversation growth.
- **T3 — "Suggest, don't enforce."** Capabilities are name-guessed not declared; memory pads prompts instead of branching; handoffs are labels not leases. The system *advises* the LLM where it should *constrain* it. This is why correctness regresses at scale — the LLM is the load-bearing enforcement point.

---

## 5. Proposed scalable target architecture

Direction, not yet a build order. Each item maps to the weaknesses above and preserves the strengths.

### 5.1 Tool-calling
- **Relevance-gated tool exposure.** Replace the static 31-tool concat with a per-turn selector: always-on core (query_workspace, search_codebase, ~5), plus a retriever that surfaces the rest by embedding/keyword match against the user message + a `search_tools` meta-tool for the long tail (the pattern already exists for the external OpenAPI surface — `platformApi.ts:71`; apply it internally). Target: ≤8–10 specs/turn.
- **Declared capabilities, enforced at dispatch.** Make `capability` required; add a dispatch-time gate in `orchestrator.ts` that re-checks effect+permissions before `execute`, not just at visibility time. Delete the name-regex fallback.
- **Parallel read fan-out** — `Promise.all` the independent tool calls in a round (`orchestrator.ts:471`); keep writes serial + verified.
- **Route all target/credential facts through the understanding + `credentialsService` layer** — remove `TARGET_*` env and the hardcoded `/auth/login` from `agentTools.ts` (no-hardcoding rule).
- **Per-tool call budget + in-run result cache** keyed on (tool, args-hash).

### 5.2 Agent-to-agent
- **Cut the bus to load-bearing behind a real decision**, or freeze it. If cutting over: derive the stage→agent identity *from the graph definition* instead of the hand-maintained `STAGE_AGENT` map (kills the drift surface). The graph stays the executor; the bus becomes the *coordination and durable-state* layer it delegates through.
- **Durable work-queue semantics** where it matters: ack + redelivery + a replay consumer so a crash mid-run resumes instead of FAILs (`runStore.ts` Phase 4/5 is the seam). Add per-message timeout + dead-letter.
- **Real handoff leases** — a short-lived ownership token so duplicate/concurrent invocation is guarded, not just labeled.
- **Fix the Postgres publish to `MAX(seq)+1` with an index**, not `COUNT(*)` + full scan — removes the quadratic.
- **Compare-and-set on blackboard `latest`** for the small set of single-writer facts (routing plan, ownership) to detect contradiction.

### 5.3 Memory
- **Wire the gate.** Make `isSelectorKnownBroken` / `preferredApproach` actual branch points in the coder/planner so memory changes control flow; retire the duplicate `runMemory.ts` episodic path onto the typed store. This is the highest-leverage, lowest-risk memory change.
- **Add semantic recall behind the existing `store.recall` interface** — pgvector where Postgres is on, keep the lexical fallback. Prior-run / prior-artifact relevance recall is the biggest quality win.
- **Persist the RAM-only fallbacks to disk** (as `runMemory.ts`/`controllerPlanStore.ts` already do) or require Postgres for memory — end restart amnesia.
- **Real LLM summary rollups + a second compaction tier** so long conversations degrade gracefully; inject an explicit "N earlier turns omitted" marker when the budget drops turns.
- **Project-scoped shared recall** so learnings cross conversations (a minimal knowledge graph linking run ↔ selector ↔ feature ↔ defect).

---

## 6. Recommended sequencing (if approved to build)

Ordered by leverage ÷ risk. Each is an independently shippable, verifiable slice (≤10–15 files, per CLAUDE.md scope cap). **No build starts until you approve scope.**

| # | Change | Subsystem | Risk | Why first |
|---|--------|-----------|------|-----------|
| P1 | Wire the memory gate to branch; retire duplicate episodic path | Memory | Low | Dead code → live value, no new infra |
| P2 | Declared capabilities + dispatch-time enforcement; delete name-regex | Tools | Low | Closes the enforcement hole |
| P3 | Remove `TARGET_*` / `/auth/login` hardcoding → understanding+creds layer | Tools | Low | Non-negotiable rule violation |
| P4 | Relevance-gated tool exposure (≤8–10 specs/turn) + `search_tools` | Tools | Med | Kills the #1 scaling ceiling |
| P5 | Parallel read fan-out + per-tool budget + in-run cache | Tools | Med | Latency + cost |
| P6 | Persist memory fallbacks / require PG; end restart amnesia | Memory | Med | Correctness on this `tsx` backend |
| P7 | Semantic recall (pgvector) behind `store.recall` | Memory | Med | Biggest quality win |
| P8 | **Decision:** cut bus over vs freeze; if cut — graph-derived stage map, leases, MAX+1 seq, resume consumer | A2A | High | Largest surface; do last, deliberately |

---

## 7. What NOT to touch

The mutation-verification, honesty gate, budget-manifest audit trail, artifact revalidation, deterministic ledger, registry-validated routing, and the "agents decide / deterministic code executes" split are genuinely strong and should survive every change above.

---

*End of Phase-0. Awaiting explicit approval (a separate turn) on scope before implementing any item.*
