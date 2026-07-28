# Agent-Native Re-Architecture — Implementation Plan (Phase 0, Analysis Only)

**Date:** 2026-07-28
**Mode:** Principal Architect / Phase-0 (analysis only — no code changed)
**Source of truth:** the current codebase only (this plan does not rely on prior docs)
**Predecessor audit:** the code-only brutal audit (17-agent fan-out) that scored the current system **3/10** as an "agent platform" (0/10 agent-to-agent, 2/10 memory) and **6/10** as a deterministic test-compiler.

> **This document requires explicit approval on a later turn before ANY implementation begins.** Per `CLAUDE.md`, each phase caps at 10–15 files or one subsystem, whichever is smaller.

---

## 1. Executive Summary

The system today is a **competent deterministic test-compiler mislabeled as a multi-agent platform.** Behavior is decided by hand-written regexes and `switch` tables, not by agents reasoning over memory and prompts. There is **no agent-to-agent communication**, and the memory subsystem persists data but never lets it change a decision.

This plan describes how to convert it into a **genuinely agent-native, memory-grounded, horizontally-scalable system** *without throwing away the parts that are actually good* (the provider abstraction, the deterministic `Compiler` seam, schema-derived `businessRules.ts`, the versioned object repository).

The core move is to introduce **four missing substrates** and route the existing capabilities through them:

1. **A message-passing / blackboard substrate** — typed inter-agent messages over a persisted, shared run state, replacing the mutable `run: any` object that agents currently patch and re-render into prompts.
2. **A capability & agent registry** — declarative `agent → prompt → tools → schema → cost`, replacing the ~20-case dispatch `switch` and the six parallel drifted intent tables.
3. **A semantic memory layer with a *read path that gates decisions*** — embeddings + relevance retrieval that can *change a branch* (skip a known-flaky selector, prefer a proven approach), not just concatenate into a prompt inside a `try/catch`.
4. **A shared, process-independent run store** — heavy artifacts (evidence graph, plans, compiled sources) in a shared store keyed by run, so a second worker can pick up a run. Today they live only in one process's in-memory `Map`.

**Design stance:** this is a *strangler-fig migration behind feature flags*, not a rewrite. Every phase leaves the app shippable. The deterministic compiler remains the execution backend; agents become the *decision layer* on top of it.

---

## 2. Existing Architecture (as the code actually is)

Two parallel "brains" that do not share a spine:

- **`server/ai/*`** — the chat/controller brain. `controller.ts` (1,175 LOC, ~184 conditionals), `orchestrator.ts` (`runToolLoop`), `supervisor.ts`, `systemPrompts.ts` (static prompt strings), `guardrails.ts` (pre-LLM canned replies), `intents.ts`, `providers/*` (clean), `tools/*`, `memory/*`.
- **`server/features/agent/*`** — the deep-run brain. `routes.ts` (**6,794 LOC**, ~1,126 conditionals, routes don't register until line 4641), `workflow/*` (LangGraph FSM: `runtime.ts`, `state.ts`, `graphs/`, `nodes/`), `compiler/*` (deterministic, genuinely good), `graph/*` (evidence/metadata/objectRepository), `knowledge/*`, `validation/*`, `testdata/*`.

**How "agents" work today:** a request is classified by regex (`controller/routes.ts:13 ACTION_RE`), clamped to a 20-string allow-list (`controller.ts:187 VALID_KINDS`), and dispatched by a hand-written `switch(kind)` (`controller.ts:539-1081`) to an orchestrator selected by hardcoded name (`getOrchestrator('playwrightCoder')`). The LangGraph layer is a real checkpointed FSM but **every edge is a hardcoded conditional** — the LLM makes zero routing decisions.

**How "agents communicate" today:** they mutate a shared `run: any` object (69 `run.x =` assignments) and re-render its fields into the next prompt. A comment at `routes.ts:2850-2854` admits two agents "diverged" and needs a `resolveUnderstanding(run)` shim to reconcile them.

**What is genuinely good (keep it):**
- `AIProvider` interface + generic `runToolLoop` native tool-calling (`providers/*`, `orchestrator.ts`).
- The `Compiler` seam and deterministic Playwright compilation (`compiler/*`).
- `validation/businessRules.ts` — derives 100% from live `ObjectSchema`, no app labels.
- `graph/objectRepository.ts` — real append-only, content-hash-versioned cross-run store.

---

## 3. Dependency Graph (current, simplified)

```
HTTP (controller/routes.ts, features/agent/routes.ts)
  → controller.ts  ──switch(kind)──► getOrchestrator(name) ──► supervisor.ts / orchestrator.runToolLoop
                                                                     │
                                                                     ▼
                                                              providers/* (clean)
  features/agent/routes.ts (god object)
    ├─ legacy deep-run pipeline (inline)     ─┐
    ├─ AIQA_COMPILER path (compiler/*)        ├─ 3 runtimes, flag-selected, interleaved
    └─ AGENT_GRAPH_V2 path (workflow/runtime) ─┘
         workflow/state.ts ──► artifactStash (in-proc Map) ──► checkpointer (refs only)
    knowledge/* + validation/* + testdata/*  (rule tables, regexes)
    graph/objectRepository (versioned)  ──(mis-keyed)──►  riskAnalysis (rarely fires)
  memory/* (write path real; read path decorative)
```

**The problem the graph shows:** there is no node called "blackboard," "message bus," "agent registry," or "memory-gate." Every arrow that *should* be an agent decision is a code branch.

---

## 4. Runtime Flow (current)

1. Request hits `controller/routes.ts` → `ACTION_RE` regex fork (question vs. action) — **deterministic, no LLM**.
2. Action → `controller.ts` classify → clamp to `VALID_KINDS` → `switch(kind)` → named orchestrator.
3. Deep runs → `features/agent/routes.ts /api/agent/start` (~944-line handler) selects one of three runtimes by env flag.
4. Graph runtime pumps a fixed FSM; nodes call the compiler; artifacts land in an in-process `Map`; checkpoint stores refs.
5. On restart, `reconcileOrphanedRunsOnStartup` (`runtime.ts:817-864`) **fails every in-flight run** because the artifacts are gone — proof the run is process-bound.

---

## 5. Evidence Flow (current)

- Evidence is captured (DOM facts, screenshots, selector maps) into an evidence graph (`graph/evidenceGraph.ts`) held in `artifactStash` (in-proc `Map`).
- The compiler consumes verified evidence to emit Playwright — this part is sound.
- **Gap:** evidence never becomes durable, queryable memory. A selector proven flaky in run N is not reliably available to run N+1 (see §6, memory loop is inverted).

---

## 6. Context Flow (current)

- Context is assembled by `memory/contextAssembler.ts` using **hardcoded priority constants** (900000/800000/…), not relevance.
- `conversationSummary.ts` does **no summarization** — truncates each turn to 800 chars and concatenates verbatim.
- No embeddings, vectors, cosine, or semantic retrieval anywhere in `server/ai/memory` (grep returns zero hits).
- Net effect: context is "most-recent-substring-match," which becomes noise at scale.

---

## 7. Prompt Flow (current)

- System prompts are **static template strings** (`systemPrompts.ts`), explicitly "do not depend on the user message" (`:142`).
- Memory, when read at all, is string-concatenated into the prompt inside a `try/catch` — "an enhancement, never a hard dependency" (`routes.ts:2874`).
- The LLM's job is slot-filling inside a box the code already drew.

---

## 8. Current Problems (verified in the audit)

| # | Problem | Evidence | Severity |
|---|---------|----------|----------|
| P1 | God-object `routes.ts` fuses HTTP/orchestration/business/prompts/3 runtimes | 6,794 LOC, routes register at 4641 | BLOCKER |
| P2 | No agent-to-agent substrate — shared `run: any` + prompt re-render | 69 `run.x=`, `resolveUnderstanding` shim `routes.ts:2850` | CRITICAL |
| P3 | Memory can't gate a decision; flagship recall loop inverted/dead | store `feature=script.title` vs query `run.prompt.slice(0,80)`; `runMemory.ts:169` | CRITICAL |
| P4 | No relevance retrieval anywhere | grep embed/vector/semantic = 0 hits | MAJOR |
| P5 | App identity welded into types & "generic" layers | closed unions, `TARGET_*` globals, boot-time hardcoded hosts `knowledgeService.ts:72-73` | MAJOR |
| P6 | Routing/dispatch is regex + switch, not agent reasoning | `ACTION_RE`, `switch(kind)`, `VALID_KINDS` clamp | MAJOR |
| P7 | Runs are process-bound (no horizontal scale, no cross-process resume) | `artifactStash` Map, orphan reconcile fails | MAJOR |
| P8 | Six parallel intent tables have already drifted | `discover_requirement` declared but no handler → coerced to `unknown` | MAJOR |

---

## 9. Root Cause Analysis

There is **one root cause** with two faces:

**Root cause: the system was built decision-first in code, then had LLM calls inserted as sub-steps — instead of being built agent-first, with code as the tools agents call.**

- Face A — **control inversion.** In an agent-native system, the *agent* decides and the *code* executes tools. Here the *code* decides (regex/switch) and the *LLM* fills slots. Every "sin" flows from this.
- Face B — **no shared reasoning surface.** Because there was never a blackboard/message bus, state had to be smuggled through a mutable `run` object and re-rendered into prompts, which forced reconciliation shims and made memory impossible to wire into decisions.

Everything else (god-object, dead memory loop, app-coupling) is a *symptom* of building without these two substrates.

---

## 10. Proposed Architecture (target state)

**Principle: the LLM/agent owns decisions; deterministic code owns execution and verification.** Keep the compiler as the trustworthy backend; put an agent decision-layer on top of a real substrate.

### 10.1 Four new substrates

**(A) Blackboard + Message Bus** — `server/agent-core/bus/`
- A per-run **Blackboard**: a typed, persisted, append-only shared state (facts, evidence refs, decisions, open questions). Agents read/write *typed entries*, never a raw `any`.
- A **Message Bus**: typed `AgentMessage { from, to|broadcast, type, payload, causationId }`. Handoff and delegation are first-class message types (`HANDOFF`, `DELEGATE`, `REQUEST`, `RESULT`, `CRITIQUE`).
- Replaces the `run: any` mutation pattern and the `resolveUnderstanding` shim. Two agents needing the same fact read **one** blackboard key.

**(B) Agent & Capability Registry** — `server/agent-core/registry/`
- One declarative source: `defineAgent({ name, systemPrompt, tools[], outputSchema, model, effort, cost })` and `defineTool({ name, schema, handler, cost })`.
- Dispatch becomes a **registry lookup**, not a `switch`. Adding an agent/tool is a registration, not an edit to six tables.
- Collapses `VALID_KINDS`, `INTENT_LABELS`, `AGENT_FOR_INTENT`, the dispatch switch, the cost switch, and `INTENT_TOOLS` into one registry (kills P8 drift, including the orphaned `discover_requirement`).

**(C) Semantic Memory with a decision-gating read path** — `server/agent-core/memory/`
- **Store:** episodic (run outcomes, selector stability, verdicts), semantic (learned facts about a target app), and procedural (proven approaches). Backed by Postgres + a vector column (pgvector) or an embedding index.
- **Write path:** structured records with an embedding, correctly keyed (fixes P3 inversion; fixes the assertion-vs-selector misattribution at `execution.ts:154`).
- **Read path that *gates*:** `recall(query, k)` returns ranked relevant memories, and a **MemoryGate** can *change control flow* — e.g. `if (memory.selectorKnownBroken(sel)) choose alternative`. Memory stops being prompt padding and becomes a branch input.
- Wraps and preserves the good `objectRepository` versioning; fixes its mis-keyed consumer (`riskAnalysis.ts:40`).

**(D) Shared Run Store** — `server/agent-core/runstore/`
- Heavy artifacts (evidence graph, plans, compiled sources) move from the in-proc `Map` to a shared store (Postgres/object storage) keyed by `runId`.
- The checkpoint already stores refs; now the refs resolve from a shared store, so a **second worker can resume a run** (kills P7). Orphan reconciliation becomes "re-hydrate from store," not "fail."

### 10.2 The agent decision-layer

- Replace the regex fork + `switch` with a thin **Router Agent** whose *only* job is: read the request + blackboard + memory, then emit a typed plan (which agents, in what order). Deterministic guardrails stay as *safety rails around* the agent, not as the decider.
- Existing named orchestrators (`suiteDesigner`, `playwrightCoder`, `caseWriter`, etc.) become **registered agents** with distinct prompts + tool sets + output schemas — real actors that communicate via the bus, not switch branches.
- The deterministic compiler stays as a **tool** the authoring agent calls. LLM never emits raw code; agents decide *what* to compile, the compiler decides *how* — preserving the current safety property.

### 10.3 App-agnosticism

- Replace closed unions (`'ADMIN'|'RUNTIME'`, `'shockwave'|'keystone'`) and `TARGET_*` process globals with a **per-run `AppProfile`** (surfaces, auth, routing model, metadata endpoint, storage-key namespace) carried on the blackboard.
- Move the leaked domain normalizers (`normalizeScriptPayload`/`normalizeTestCasePayload`) out of `providers/*` into the authoring agent's output handling.
- Delete the boot-time hardcoded host/name seed (`knowledgeService.ts:72-73`); knowledge about a target app becomes memory records, not source literals.

### 10.4 Target dependency graph

```
HTTP (thin) ─► Router Agent ─► Message Bus ◄─► [registered agents]
                                   │                 │ tools
                                   ▼                 ▼
                               Blackboard        Tool Registry ─► Compiler / DOM / providers
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼               ▼
              Semantic Memory   Run Store     AppProfile
              (gates branches)  (shared)      (per-run, data not types)
```

---

## 11. Complete Refactoring Strategy (strangler-fig, flag-gated)

1. **Build the substrates alongside the current code**, behind a master flag `AGENT_NATIVE_V1` (default OFF). Nothing existing breaks.
2. **Adapt, don't rip out.** Wrap `objectRepository`, the compiler, and providers — they stay. The new layer *calls* them.
3. **Migrate one capability end-to-end first** (recommend: `playwrightCoder` authoring) to prove the substrate before moving the rest.
4. **Move dispatch to the registry** once ≥2 agents are registered, so the `switch` and intent tables can be deleted table-by-table.
5. **Decompose `routes.ts` last**, after the new layer owns orchestration — the god-object shrinks to thin HTTP handlers that post messages to the bus.
6. Each phase ends shippable, lint-clean, tested, backend restarted (per `CLAUDE.md`).

---

## 12–14. Files That Must Change (with reason + risk)

> New files live under a new `server/agent-core/` root to avoid disturbing the two existing brains until cutover.

### New (low risk — additive, flag-gated)
| File | Why | Risk |
|------|-----|------|
| `server/agent-core/bus/messageBus.ts` | typed inter-agent messages | Low |
| `server/agent-core/bus/blackboard.ts` | persisted shared run state | Low |
| `server/agent-core/registry/agents.ts` | declarative agent defs | Low |
| `server/agent-core/registry/tools.ts` | declarative tool defs | Low |
| `server/agent-core/memory/store.ts` | episodic/semantic/procedural store + embeddings | Med |
| `server/agent-core/memory/gate.ts` | decision-gating recall API | Med |
| `server/agent-core/runstore/runStore.ts` | shared artifact store | Med |
| `server/agent-core/appProfile.ts` | per-run app identity (replaces unions/globals) | Low |
| `server/agent-core/router/routerAgent.ts` | LLM router replacing regex/switch | Med |
| `server/db/schema.sql` (additions) | memory + runstore + bus tables (idempotent, update `scripts/setup-db.bat`) | Med |

### Modified (higher risk — touch existing behavior; do behind flag)
| File | Why | Risk |
|------|-----|------|
| `server/ai/controller.ts` | route dispatch through registry instead of `switch(kind)` | **High** |
| `server/features/agent/routes.ts` | shrink handlers to post-to-bus; remove inline orchestration | **High** |
| `server/features/agent/workflow/runtime.ts` | resolve artifacts from run store, not in-proc Map | **High** |
| `server/features/agent/workflow/nodes/execution.ts` | fix memory write key + assertion-vs-selector misattribution | Med |
| `server/ai/providers/{anthropic,openai,cli}.ts` | remove leaked domain normalizers | Med |
| `server/features/agent/graph/riskAnalysis*` / consumer | fix mis-keyed memory consumer | Med |
| `server/features/knowledge/knowledgeService.ts` | delete hardcoded host/name seed | Low |
| `server/ai/memory/contextAssembler.ts` | relevance-ranked assembly, not priority constants | Med |

---

## 15. Backward Compatibility Concerns

- **Existing APIs preserved.** New layer is flag-gated; with `AGENT_NATIVE_V1=OFF` the app behaves exactly as today.
- **Agent Console / UI:** the cosmetic status chips (`runtime.ts:118`) must keep emitting the same event shape; the bus adapter maps real agent messages to the existing UI event contract.
- **DB:** all schema changes idempotent for new + existing databases; `scripts/setup-db.bat` updated in the same change (per `CLAUDE.md`).
- **Providers/compiler/objectRepository:** wrapped, not changed in signature.

## 16. Migration Strategy

- Dual-run window: new substrate populated in shadow mode (writes memory + blackboard) while the old path still decides, so we can compare before flipping decisions.
- Cut one capability at a time; keep the old `switch` branch until its agent is registered and validated.
- Data migration: backfill `objectRepository` + existing `run_memories` into the new memory store with embeddings (one-off script, idempotent).

## 17. Testing Strategy

- **Unit:** bus message routing, blackboard read/write typing, registry lookup, memory gate branch decisions, app-profile resolution.
- **Contract:** old UI event shape unchanged; provider signatures unchanged; compiler output unchanged for a fixed input corpus (golden tests).
- **Integration:** one full deep run (author → compile → execute) on the new substrate vs. the old, artifacts compared.
- **Regression gates (per `CLAUDE.md`):** build succeeds, existing tests pass, no new circular deps, DOM inspection still works, repo grounding still works, no silent truncation, validation gates intact, compiler uses verified evidence only.
- **Scale test:** two worker processes resuming the same run from the shared store (proves P7 fixed).

## 18. Rollback Strategy

- Master flag `AGENT_NATIVE_V1=OFF` instantly reverts to current behavior at every phase.
- Each modified file keeps the old code path behind the flag until its phase is validated; no old branch is deleted until its replacement is green in production.
- Schema additions are additive-only (no destructive migrations), so a rollback needs no DB downgrade.

## 19. Estimated Implementation Effort

| Phase | Scope | Rough effort |
|-------|-------|--------------|
| 1 | Substrate primitives (bus + blackboard + schema) | ~1 subsystem |
| 2 | Registry + one migrated agent | ~1 subsystem |
| 3 | Semantic memory + decision gate + fix inverted loop | ~1 subsystem |
| 4 | Shared run store + cross-process resume | ~1 subsystem |
| 5 | Router agent replaces regex/switch | ~1 subsystem |
| 6 | App-profile; de-hardcode; remove leaked normalizers | ~10–12 files |
| 7 | Decompose `routes.ts` into thin handlers | ~1 subsystem (largest) |

Each phase is independently shippable and validated before the next.

---

## 20. Recommended Implementation Order (phase checklist)

- [ ] **Phase 1 — Substrate primitives.** `bus/messageBus.ts`, `bus/blackboard.ts`, `schema.sql` (bus/blackboard tables) + `setup-db.bat`. **Risk: Low.** Additive, flag-gated, no existing path touched. Exit: unit tests green, backend restarts clean.
- [ ] **Phase 2 — Registry + first real agent.** `registry/agents.ts`, `registry/tools.ts`; register `playwrightCoder` as a real agent; run it via the bus in shadow mode. **Risk: Med.** Exit: one authoring run produces identical compiler output through the new path.
- [ ] **Phase 3 — Semantic memory + decision gate.** `memory/store.ts`, `memory/gate.ts`; **fix the inverted recall loop** (`execution.ts` key + `runMemory.ts:169`) and the assertion-vs-selector misattribution; wire the gate so a known-broken selector changes a branch. **Risk: Med.** Exit: a selector proven flaky in run N provably alters run N+1.
- [ ] **Phase 4 — Shared run store.** `runstore/runStore.ts`; `runtime.ts` resolves artifacts from it; orphan reconcile re-hydrates. **Risk: High.** Exit: two processes resume one run.
- [ ] **Phase 5 — Router agent.** `router/routerAgent.ts` replaces `ACTION_RE` + `switch(kind)`; guardrails become rails, not decider; delete intent tables as agents register. **Risk: High.** Exit: routing decisions made by the agent, regex fork removed, `discover_requirement` orphan resolved.
- [ ] **Phase 6 — App-agnosticism.** `appProfile.ts`; remove `TARGET_*` globals, closed unions, boot-time host seed; move domain normalizers out of `providers/*`. **Risk: Med.** Exit: a second target app onboarded via config/data only, zero union/regex edits.
- [ ] **Phase 7 — Decompose `routes.ts`.** Split into thin HTTP handlers that post to the bus; orchestration/business/prompt modules separated; one runtime selected at the edge. **Risk: High (largest).** Exit: `routes.ts` under a sane size, no inline orchestration, all three old runtimes collapsed to one.

**Two cheap high-leverage fixes can ship immediately, independent of the big migration** (recommend doing these first, in isolation): the run-memory key inversion (Phase 3 core) and the `riskAnalysis` dimension mismatch. Both resurrect systems you already built and paid for.

---

### Approval gate
This is analysis only. **No files were modified.** On approval, I will implement **Phase 1 only**, validate it (lint, tests, backend restart), report back, and stop — then wait for approval before Phase 2.
