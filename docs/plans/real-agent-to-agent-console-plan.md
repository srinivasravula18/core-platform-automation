# Making the Agent Console real agent-to-agent communication — Phase-0 plan

Analysis only. No code changes until explicitly approved on a later turn. Goal: turn the Agent Console
from a **projection of a deterministic pipeline dressed as agents** into a **live window onto genuine
agent-to-agent communication** — across the whole run, not just the console chrome.

---

## 0. Design principles (how we'd build this if we were designing Claude)

These are the invariants every phase below must honor. They are the point of the redesign; the code is
downstream of them.

1. **Agents are first-class actors, not labeled stages.** An agent = (identity, a capability it owns, a
   contract for what it accepts/returns). "ScopeAgent / TestGenerationAgent" become real actors that
   *decide*, not names stamped on a `switch`.
2. **Communication is message-passing, not shared-state mutation.** Agents talk by publishing typed
   messages on the bus (HANDOFF, DELEGATE, CRITIQUE, REQUEST/RESULT, QUESTION/ANSWER) — never by mutating a
   shared `run: any` and re-rendering it into the next prompt. Every message carries `causationId`, so the
   whole run is a traceable causal graph.
3. **Shared understanding lives on the blackboard.** Facts (app.understanding, evidence, grounding
   coverage, decisions) are written once, provenance-stamped, append-only; any agent reads them. No agent
   privately re-derives what another already learned.
4. **Orchestrator + specialist sub-agents.** A router/orchestrator owns *routing and delegation*, not the
   work. Specialists (grounder, author, critic, compiler-liaison, executor-liaison, analyst) own one
   capability each and are reachable by intent through the capability registry — lookup, not hardcoded call.
5. **Verification is a peer, not a postscript.** A Critic sub-agent CRITIQUEs drafts (cases, selectors,
   scripts) *before* they're committed; disagreement is a message, not a silent pass. This is how you kill
   hallucination — the same reason Claude uses self-critique/verifier loops.
6. **Bounded autonomy with rails.** Budgets, causation-depth caps, and loop detection are already in the
   bus. Autonomy is real but never unbounded — a run can't spin forever or flood.
7. **Determinism where correctness is non-negotiable.** Agents DECIDE; deterministic code EXECUTES and
   VERIFIES. The LLM never emits raw Playwright — the compiler and executor stay deterministic. Agent-native
   ≠ "LLM does everything."
8. **Observability is the source of truth.** The console renders the ACTUAL bus + blackboard. What you see
   *is* what happened — there is no second, cosmetic representation to drift from reality. This single
   principle is what makes the console "real": we delete the projection and render the substrate.
9. **Strangle, never big-bang.** Migrate one agent at a time behind a flag, shadow-first (record without
   deciding), then hand it the decision, then delete the legacy branch. The app stays shippable every day.

---

## 1. Executive summary

The substrate for real A2A already exists and is proven end-to-end: a typed **message bus**
(`agent-core/bus/messageBus.ts`, persisted to `agent_messages`), an append-only provenance **blackboard**
(`agent-core/bus/blackboard.ts` → `agent_blackboard`), a **capability registry**, **semantic memory + gate**,
and **shadow instrumentation** that already records real stage transitions (`runInstrumentation.ts`). It is
gated OFF by `AGENT_NATIVE_V1` and consumed by nothing on the live path.

The console today shows `run.messages`, which is `chipMessages()` in `workflow/runtime.ts` — a **projection**:
a fixed roster of agent *names* + templated status lines, whose only real signal is done/skipped/failed
derived from workflow artifacts. It is honest about *outcomes* but is not agent communication.

The plan: **(a)** make every stage EMIT real typed messages to the bus as it works (not just stage
transitions), **(b)** flip the console to render the bus + blackboard instead of `chipMessages`, **(c)**
progressively convert the highest-value deterministic stages into real actors that DELEGATE and CRITIQUE
through the bus — router first, then author↔critic, then grounder. Deterministic compile/execute stay as
verified tools the agents call. Done in shadow-first strangler phases behind `AGENT_NATIVE_V1`.

---

## 2. Existing architecture (grounded in code)

- **Engine:** LangGraph runtime (`workflow/runtime.ts`, `workflow/testRunGraph.ts`, `workflow/nodes/*`).
  Stages: `validate_request → load_context → discover_and_ground → author_cases → review_cases →
  author_plans → compile_and_validate → execute_tests → investigate_failures → finalize`.
- **Console feed:** `chipMessages(state)` (runtime.ts:120-164) maps state artifacts → 9 fixed chips
  (ScopeAgent…EvidenceAgent) with hardcoded `runningLine/skipLine` and `"Done."`. Delivered via
  `runStatusSnapshot` + SSE `GET /api/agent-runs/:id/events`; consumed by `src/lib/useAgentRun.ts`,
  rendered in `AgentConsole.tsx` / `DeepRunResult.tsx` / `AgentStatusCard.tsx`.
- **Real substrate (inert):** `agent-core/bus/{messageBus,blackboard}` (typed messages + facts, budgets,
  causation), `registry/{tools,agents}`, `memory/{store,gate}`, `router/routerAgent`,
  `runInstrumentation.recordRunStageTransition` (shadow HANDOFF + `run.stage` fact, flag-gated).
- **Providers:** multi-provider tool-loop (`runToolLoop`) + strict-output (`generateStrictObject`) —
  provider-neutral; this is how agents will actually think.

## 3. Runtime / message / context flow (target)

Run start → **Orchestrator agent** reads the request + blackboard `app.understanding`, then DELEGATEs to
specialists over the bus. Each specialist: reads its inbox + blackboard, does its capability (via
runToolLoop/tools), writes results to the blackboard, and publishes a RESULT/HANDOFF. A **Critic** watches
for draft facts and publishes CRITIQUE; the author consumes the critique before HANDOFF to compile. The
deterministic **Compiler** and **Executor** are tools an agent invokes; their outputs become blackboard
facts + RESULT messages. The console SUBSCRIBES to the bus and renders the live message + fact stream.

## 4. Current problems / root cause

- The "agents" are stage labels; there is no delegation, no critique, no negotiation — so the console can
  only ever be a projection. Root cause: control lives in a deterministic graph that mutates `run`, and the
  bus/blackboard are shadow-only.
- Memory is stored but rarely gates decisions; grounding facts aren't shared as first-class facts other
  agents consume; verification is a gate, not a peer critic.

## 5. What must change — files, why, risk

| Area | Change | Risk |
|---|---|---|
| `workflow/nodes/*` + `runtime.ts` | Each node PUBLISHES typed bus messages as it works (REQUEST at entry, RESULT/blackboard-fact at exit), beyond the existing stage HANDOFF. Additive, shadow. | Low (additive, flag-gated) |
| `runInstrumentation.ts` | Extend from stage transitions to per-node REQUEST/RESULT + key blackboard facts (cases drafted, selectors verified, coverage, execution verdicts). | Low |
| `runStatusSnapshot` / SSE (`routes.ts`) | Add a `conversation` view = bus history + blackboard facts for the run (alongside the legacy chips, behind flag). | Low–Med |
| `src/lib/useAgentRun.ts` + `AgentConsole/DeepRunResult/AgentStatusCard` | Render the real message/fact stream (from/to/type/causation, expandable payloads) when flag on; keep chips as fallback. | Med (UI) |
| `router/routerAgent` + `registry/agents` | Promote the orchestrator to actually DELEGATE the first capability (routing) over the bus; specialists resolved from the registry. | Med |
| Author + **new Critic agent** | Author publishes a draft fact; Critic CRITIQUEs; author revises before HANDOFF to compile. First real decision-bearing A2A loop. | Med–High |
| Grounder | `resolveAppUnderstanding` result becomes the shared `app.understanding` fact other agents consume (already produced; wire consumption). | Med |
| Compiler / Executor | Unchanged internally; wrapped as capabilities invoked via DELEGATE, results → facts. Determinism preserved. | Low |

## 6. Backward compatibility & rollback

Everything is additive and gated by `AGENT_NATIVE_V1` (+ a UI sub-flag for the console view). Flag OFF =
today's behavior byte-for-byte (chips from `chipMessages`). Rollback = flip the flag; no schema rollback
needed (bus/blackboard tables are already live and harmless when unread). No provider, compiler, or executor
behavior changes in early phases.

## 7. Testing strategy

- Unit: each node emits the expected messages/facts (extend `scripts/test-agent-bus.ts` / `test-agent-memory`).
- Contract: causation chains well-formed, budgets/loop-guards fire (already covered; extend).
- Golden run: a real deep run with flag ON records a coherent conversation (assert message set + ordering).
- Critic loop: an intentionally-wrong draft is CRITIQUEd and revised (deterministic fixture, not LLM-noise).
- Live no-regression: flag OFF vs ON produce identical cases/scripts/evidence until an agent is given a real
  decision; then measure quality delta on the benchmark.

## 8. Rollback / risk posture

Never give an agent a decision before its shadow phase shows it would have made the right one on real runs.
Order phases by blast radius: observability (zero risk) → console view (UI only) → router delegation →
author↔critic → grounder consumption. Compile/execute stay deterministic throughout.

## 9. Effort & recommended order (phase checklist)

- [ ] **P1 — Full-fidelity instrumentation (shadow).** Every node emits REQUEST/RESULT + key facts. Files:
  `runInstrumentation.ts`, `workflow/nodes/*`, `runtime.ts`. Risk: low. ~2–3 files/node.
- [ ] **P2 — Console renders the substrate.** `conversation` view in the snapshot/SSE + UI feed with
  from→to/type/causation and expandable payloads; chips become fallback. Files: `routes.ts`,
  `useAgentRun.ts`, `AgentConsole/DeepRunResult/AgentStatusCard`. Risk: med (UI). **This is the phase that
  makes the console "real" — you now watch actual messages, not templates.**
- [ ] **P3 — Orchestrator delegates routing.** Router agent DELEGATEs the first real capability over the
  bus; specialists resolved via the registry. Files: `router/routerAgent`, `registry/agents`, start hook in
  `routes.ts`. Risk: med.
- [ ] **P4 — Author ↔ Critic loop.** New Critic agent CRITIQUEs drafts before compile; first decision-bearing
  A2A negotiation. Files: `registry/agents`, author node, new critic. Risk: med–high.
- [ ] **P5 — Shared grounding.** `app.understanding` + grounding coverage become the shared facts every
  downstream agent consumes (kills re-derivation). Files: `understandingProducer`, grounding node, memory gate.
- [ ] **P6 — Deterministic tools as capabilities.** Compiler/Executor invoked via DELEGATE; outputs → facts.
  Determinism preserved. Files: `registry/tools`, compile/execute nodes.
- [ ] **P7 — Retire the projection.** Once the substrate view is the default, delete/keep-as-fallback
  `chipMessages`. Files: `runtime.ts`, UI.

Each phase: additive, flag-gated, shadow-proven, lint + tests + live no-regression before the next.

---

## 10. Implementation status — ALL 7 PHASES BUILT (2026-07-29)

All phases implemented, typechecked (`npm run lint` clean), and unit-tested. Everything is additive and gated by
`AGENT_NATIVE_V1` (default OFF → today's behavior byte-for-byte; the full graph suite — authoring 52 / request 75 /
workflow-state 78 assertions — still passes unchanged). Turn it ON to make the console real.

- [x] **P1 — Full-fidelity instrumentation.** `bus/runInstrumentation.ts` now voices each stage as its owning
  specialist: a HANDOFF from the orchestrator on entry + a RESULT carrying the *real* artifact the prior stage
  produced (object counts, live-evidence counts, case titles, compiled counts, pass/fail verdicts) + a blackboard
  fact. `recordRunTerminal` flushes the final stage's RESULT. Driven from the pump in `workflow/runtime.ts`.
  Test: `scripts/test-agent-instrumentation.ts` (12).
- [x] **P2 — Console renders the substrate.** `routes.ts` `attachConversation()` exposes the live bus messages +
  blackboard facts on the status/events/details endpoints (flag-gated); `useAgentRun.ts` preserves it across
  refetches; `DeepRunResult.tsx` renders the real from→to/type/summary/payload transcript + shared-blackboard
  facts in the "Agent-to-agent communication" panel, chips as fallback.
- [x] **P3 — Orchestrator delegates routing.** `router/orchestrateRun.ts`: at run start the orchestrator REQUESTs a
  plan from the router, the router RESULTs a **registry-validated** plan (unknown agents dropped), and the
  orchestrator DELEGATEs each real specialist + writes a `routing.plan` fact. Wired fire-and-forget in
  `beginGraphRunFor`. One shared roster added to `registry/agents.ts`. Test: `test-agent-orchestration.ts` (12).
- [x] **P4 — Author ↔ Critic loop.** `critic/caseCritic.ts`: the CriticAgent adversarially refutes duplicate /
  empty-precondition / step-less / @blocked / **ungrounded-vs-catalog** drafts, publishes CRITIQUE traffic + a
  `critique.cases` fact; the author does exactly ONE revision (new `critique` prompt input) addressing the
  objections. Wired in `authorCasesNode`. High-precision (never refutes without proof). Test: `test-agent-critic.ts` (16).
- [x] **P5 — Shared grounding facts.** `grounding/groundingFacts.ts` publishes `evidence.catalog` +
  `grounding.coverage` once; the critic CONSUMES the shared catalog by runId alone (no re-derivation). Joins the
  already-shared `app.understanding` fact. Test: `test-agent-grounding-facts.ts` (10).
- [x] **P6 — Deterministic tools as capabilities.** compiler + executor registered as `deterministic` capabilities
  in `registry/tools.ts`; `registry/capabilities.ts` records their DELEGATE→RESULT invocation + facts (unknown
  capability refused). "Agents decide; deterministic code executes." Test: `test-agent-capabilities.ts` (13).
- [x] **P7 — Substrate is the default view.** When the live conversation exists it renders expanded and primary
  (`DeepRunResult.tsx`), no longer behind the query-logs toggle; the templated chip log is the fallback only.

**To enable live:** set `AGENT_NATIVE_V1=1` (env) and restart the backend (`tsx server.ts`, no hot-reload). The
Agent Console's "Agent-to-agent communication" panel then shows the real bus/blackboard transcript for each run.
