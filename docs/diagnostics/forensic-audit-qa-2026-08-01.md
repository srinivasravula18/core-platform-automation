# Forensic Audit — Complete Q&A (Sets 1–4)

**Date:** 2026-08-01
**Method:** Every answer is traced against the real code (multiple parallel deep-read passes), cited `file:line`. Unanswerable/broken items are flagged **DEFECT**. This document is **findings only — no solutions/remediation** (by request).

**Runtime baseline referenced throughout:** single process `tsx server.ts`; no job-queue library installed; LangGraph engine `AGENT_GRAPH_V2` default ON; agent-native bus/blackboard `AGENT_NATIVE_V1` default OFF; memory gate dead code; Postgres optional (in-memory fallback when off).

---

# SET 1 — Architecture Audit (22)

## 1. Execution topology

**Q1.1 Does a single agentic run ever span more than one process or machine mid-flight? Trace one full run end to end and show where execution context changes.**
No — a run is process-bound. Trace: `POST` builds `newRun` → pushes to in-memory `db.agentRuns` (`routes.ts:5911`) → responds `res.json({task_id})` *before* work starts (`routes.ts:5915`) → `beginGraphRunFor` unawaited (`routes.ts:5965`) → `startGraphRun` registers an in-memory `RunRegistryEntry` (`runtime.ts:744`) → `void pump(...)` fire-and-forget onto the event loop (`runtime.ts:747`) → `pump` drives `graph.stream` with `thread_id=runId` (`runtime.ts:608,617`), persisting each state (`runtime.ts:625`). Context changes: (a) HTTP response before compute; (b) the `void pump` async handoff; (c) LangGraph node boundaries checkpoint to Postgres — but heavy artifacts (evidenceGraph/plans/compiledSources) live only in this process's in-memory stash; checkpoints hold refs, not payloads (`runtime.ts:838-843`).

**Q1.2 Are agents invoked synchronously in a call stack, or dispatched async via queue/event/webhook? Show the actual dispatch code.**
Async, bare fire-and-forget — not a queue/event/webhook. The kick-off is a `void`'d Promise on the same event loop: `void pump(runId, entry, …).catch(() => undefined)` (`runtime.ts:747`); the route dispatch is also unawaited (`routes.ts:5965`).

**Q1.3 Can more than one instance of the same agent run concurrently against the same shared state? Where is that prevented or allowed?**
Allowed with only weak protection. Same-run double-start is guarded solely by content-equality dedup (same conversation + target + prompt → attach) at `routes.ts:5800-5806` — not a lock; it reads `db.agentRuns` with no transaction, so two near-simultaneous POSTs can race through. Resume double-pump is guarded (`if (entry.pumping) throw`, `runtime.ts:768`) but only within one process. **DEFECT:** no run-level lock/lease/advisory-lock exists (the only `pg_advisory_xact_lock`/`FOR UPDATE` guard session and case-save rows, `repository.ts:2027,3320,3535`, not runs).

**Q1.4 Is there a job queue (BullMQ, Redis, etc.) actually installed and used, or is it all in-process / single-worker?**
All in-process, single-worker. `package.json` has no bullmq/bull/bee-queue/ioredis/pg-boss/graphile-worker/worker_threads. Dispatch is `void pump` directly on the event loop (`runtime.ts:747`); the only `setInterval`s are memory retention, SSE heartbeats, and the flag-gated automation scheduler.

## 2. Memory — inventory and conflicts

**Q2.1 List every place agent/tool state is stored; for each, its scope (per-message/run/cross-run) and whether it survives a crash.**
Per-run, in-memory, lost on crash: `messages[]`/`toolResults[]`/`steps[]` (`orchestrator.ts:426,490`), `registry` Map `RunRegistryEntry` (`runtime.ts:83`), `artifactStash` heavy artifacts (`runtime.ts:838`). Per-run, durable: `agent_runs` table via upsert (`repository.ts:643`), LangGraph checkpoint (`checkpointer.ts:33`, Postgres when configured; `MemorySaver` RAM in dev). Per-conversation: ledger recomputed (`conversationState.ts:11`, durable), `chat_summary_segments`/`context_manifests`/`conversation_artifacts` (PG durable / RAM fallback). Cross-run: `run_memories` (`runMemory.ts:96`, PG or JSON file), `agent_memory` (`store.ts:143`, PG durable, RAM-only if PG off). Provenanced but only written under `AGENT_NATIVE_V1`: `agent_messages`/`agent_blackboard`. Global in-memory, lost: legacy `db.blackboard` (`features/agent/blackboard.ts:25`). Global flat file: `.testflow-traces.jsonl` (`tracer.ts:7`).

**Q2.2 Is there a single canonical source of truth per fact, or does the same info exist in more than one store? Show a concrete example where it could disagree.**
No single canonical source. Example 1: selector stability/run verdict written independently to `run_memories` (`runMemory.ts:96-103`) and `agent_memory` (`store.ts:143-147`), keyed differently, no cross-write, separate recall paths → a selector `stable` in one and `fail` in the other silently disagree. Example 2: run artifacts exist canonically in `agent_runs.raw` (`repository.ts:651`) and are re-projected into `agent_blackboard` by best-effort instrumentation that swallows errors (`runInstrumentation.ts:119-135`) → shadow copy diverges. **DEFECT.**

**Q2.3 When two writers touch the same key/fact, what actually happens — overwritten, versioned, rejected? Show the write path.**
(i) A2A blackboard: append-only, versioned, `seq=MAX(seq)+1` under row lock, `latest()` = last-writer-wins on read, history kept (`blackboard.ts:133-156`). (ii) `agent_memory`: plain `INSERT`, silent accumulation of contradictory rows (`store.ts:141-147`); `run_memories` `ON CONFLICT (id)` is dead code (ids always unique, `runMemory.ts:93`). (iii) `agent_runs`: whole-row last-writer-wins, no lock/version/seq (`repository.ts:643-651`); concurrent `saveAgentRunState`/`saveAgentRunStateSoon` (`routes.ts:1429-1437`) clobber each other's phases — lost update. **DEFECT.**

**Q2.4 What state gets lost if the process crashes mid-run? Is that acceptable?**
Lost: the entire in-memory chain — `artifactStash` (evidenceGraph/plans/compiledSources), `messages/toolResults/steps`, the `registry` entry. Because the checkpoint holds only refs to those dead artifacts, the run is unrecoverable and marked `failed`, never resumed (`runtime.ts:882-895`). Acceptable for a low-value UX run; not acceptable given unbounded concurrency (Q5) and that the durable checkpointer exists but isn't used for crash-resume. **DEFECT.**

## 3. Tool calling

**Q3.1 Is there a validation step between the model choosing a tool and it executing (schema check, allowed-tool check)? Show it, or confirm missing.**
Allowed-tool check: yes (`toolByName.get(call.name)`; unknown → error, `orchestrator.ts:473,478-479`). Argument-schema validation: **MISSING** — `call.arguments` go straight into `tool.execute` (`orchestrator.ts:482`) with no check against `tool.spec.parameters`; each tool re-validates ad hoc. **DEFECT.**

**Q3.2 What happens if the model hallucinates a tool name or malformed arguments? Trace the failure path.**
Unknown name → `inv.error = 'Unknown tool "X".'` (`orchestrator.ts:479`), fed back as a structured tool message with a recovery hint (`:513-514`). Malformed args → no pre-check, so they throw inside `execute` (caught `:501-502`, same recovery feedback) or get silently coerced. Loop-pathology guards stop after 3 identical calls / 5 consecutive failures (`toolProgress.ts:19-27`).

**Q3.3 For every "write"/"destructive" tool: how is success verified — deterministic re-read or trusting the tool's return?**
Deterministic re-read of the real system — after any `effect==='write'` tool, `verifyToolMutation` re-reads the entity (repository re-read / filtered list query / paired GET) and feeds the verdict back (`orchestrator.ts:486-489`, `verification.ts:56-107`). Gap: gated on `effect==='write'` which is inferred from the tool name (`policy.ts:6-15`), so a mis-named mutating tool is treated as read and never verified; destructive tools are dropped at visibility time but not re-checked at dispatch. **DEFECT.**

**Q3.4 How many tools can a single agent call at once? Is the full catalog sent every call, or filtered/retrieved per step?**
The model may return multiple tool calls per round; they execute serially in an `await` loop (`orchestrator.ts:471-537`), bounded by ≤64 rounds. The full catalog is sent every call — `coreTools()` returns all tools unconditionally (`registry.ts:608`), supervisor concatenates ~31 specs (`supervisor.ts:611-614`); the only filter is RBAC (`policy.ts:27`), not relevance. **DEFECT.**

## 4. Agent-to-agent coordination

**Q4.1 List every agent pair that can loop; for each, the max iteration count before something outside intervenes. Show the cap or confirm none.**
model↔tool: ≤64 (`orchestrator.ts:433`, clamp `toolProgress.ts:34`) + 3-repeat/5-fail/budget/abort sub-caps. author↔critic Reflexion (`accept()`): cap 2 (`orchestrator.ts:597-610`) — **DEAD CODE, no production caller passes `accept`**. empty/truncated retry: cap 2, live (`:579-595`). caseCritic revise: exactly 1, never re-critiqued (`testRunGraph.ts:418-430`), gated by `AGENT_NATIVE_V1`. review→revise: `MAX_REVIEW_REVISE=1` (`testRunGraph.ts:67,175`). rediscovery: `MAX_REDISCOVERY_ATTEMPTS=2` (`grounding.ts:24`). per-error discovery `for(;;)`: bounded by per-class `maxAttempts` (`testRunGraph.ts:322-324`). flake probe: 2 (`:671`). provider retry: 4 (`orchestrator.ts:651`). Router delegation: single-shot, non-recursive, decorative (`orchestrateRun.ts:63-68`). No uncapped `while(true)` found.

**Q4.2 What's the fallback when a loop hits its cap — human escalation, accept-with-warning, hard fail? Show it or confirm undefined.**
model↔tool → `safety_ceiling`, one tools-disabled wrap-up, `accepted:false` (`orchestrator.ts:616-643`); empty/truncated → hard honest fail (`:593`); caseCritic → keep original if revision empty (`:427`); review-revise → accept-with-warning, proceeds (`testRunGraph.ts:482-484`); rediscovery → hard fail `finalize` (`:233-241`); router error → silent no-op `null` (`orchestrateRun.ts:72-75`). No cap escalates to a human.

**Q4.3 Does one agent ever read another agent's raw output directly, or is it always reformatted/mediated first? Show both patterns if both exist.**
Both. Raw: sub-worker `finalText` string-concatenated into merge prompt (`supervisor.ts:390`); critic `feedback` appended raw to author prompt (`orchestrator.ts:604`, `testRunGraph.ts:425`); bus RESULT carries raw `finalText.slice(0,500)` (`runViaBus.ts:98`). Mediated: grounding published as typed `evidence.catalog` fact read back structurally (`caseCritic.ts:216`); router output validated against registry, unknown agents dropped (`routerAgent.ts:84-88`); tool results wrapped as `safeJson` (`orchestrator.ts:509-516`); human resume validated (`nodes/review.ts:39-77`).

## 5. Concurrency and scale

**Q5.1 At current expected load, how many runs execute simultaneously? Do any share state?**
Run concurrency is **UNBOUNDED** — no semaphore/pool/max-concurrent cap; every accepted POST fires `void pump` (`runtime.ts:744-747`), so N users = N graph streams + N headless Chromium on one event loop. **DEFECT.** The exact expected concurrent-run count is a product/ops fact not derivable from code — and the absence of any metric/limit to answer it is itself the gap. Runs share state: `db.agentRuns`, the memory stores, and (flag-on) the global blackboard are process-global.

**Q5.2 Is horizontal scaling (multiple instances) planned in the next 6–12 months, or single-instance for now?**
Not determinable from code (roadmap decision). Evidence: dormant horizontal-resume infrastructure exists (`runStore.ts`, `runStoreMirror.ts`) but is gated OFF behind `AGENT_NATIVE_V1` (`runStoreMirror.ts:13`) — intended but not active. **Flagged as needs product confirmation.**

**Q5.3 If scaled to multiple instances today, what breaks first? Be specific.**
1. Boot orphan-reconciler cross-kills healthy runs — `reconcileOrphanedRunsOnStartup` marks every non-terminal langgraph run in shared Postgres `failed`, no ownership check, no staleness grace (`runtime.ts:882-895`, `server.ts:101`); instance B booting fails instance A's live runs. 2. Per-process `registry` Map (`runtime.ts:83`) — cancel becomes a no-op, resume starts a second concurrent pump on the same `thread_id` when a request lands on a non-owning instance (`:786-792,751-766`); cross-instance `isGraphRunActive` always false → orphan false-positives. 3. Per-instance `db.agentRuns` array → divergent copies, dedup blind across instances → duplicate runs. 4. Automation scheduler `setInterval` no leader election → jobs fire once per instance (`schedulerService.ts:79`). **DEFECT (each).**

## 6. Observability and traceability

**Q6.1 For a given wrong output, can you reconstruct the full chain of tool calls, facts, and agent decisions? Try it on one real past run and show what's missing.**
No — partial, with a broken join key. Durable data gives the phase-level story (`agent_runs.messages` JSONB: agent/status/output/order, `routes.ts:1382-1389`) and final artifacts. Not recoverable: the model's tool-call/tool-result sequence (only in in-memory `steps[]`/the JSONL), the actual assembled prompt (only `"[prompt metadata] systemChars=…"` is stored, `tracer.ts:82-85`), and a run-linked trace — because `logExecutionTrace` writes a global `.testflow-traces.jsonl` keyed by `runId=pipeline.requestId=randomUUID()` per LLM call (`guardrails.ts:258`, `tracer.ts:33`), **not `agent_runs.id`**. Trace steps can't be joined to a run or to each other; the embedded blackboard snapshot is global-latest, not run-scoped (`tracer.ts:44`). **DEFECT.**

**Q6.2 Does every stored fact/message record who produced it and what caused it (producer, timestamp, causation)? Show the schema or confirm absent.**
Only `agent_messages` and `agent_blackboard` carry the full triple (`schema.sql:1386-1396,1371-1381`) — and both are written only under shadow, error-swallowing instrumentation gated by `AGENT_NATIVE_V1` (default OFF) (`runInstrumentation.ts:114,133-135`). Default-live stores fall short: `context_manifests` no producer/run link (`schema.sql:528-539`); `agent_memory` no producer/causation (`:1405-1415`); `run_memories`/`conversation_artifacts` no producing agent (`:588-600,562-574`); `agent_runs` producer is a string buried in JSONB, no causation. **DEFECT.**

**Q6.3 Is there any human-in-the-loop checkpoint, or is the pipeline fully autonomous end to end?**
Exactly one blocking gate — `review_cases`, only under `reviewPolicy==='manual'`: calls LangGraph `interrupt()` (`nodes/review.ts:34`), pump projects `review_required` and returns, resuming only on `resumeGraphRun` (`runtime.ts:641-651,751-781`). Under the default `auto` policy the pipeline is fully autonomous end-to-end — live-app execution, including mutating actions, runs with no human approval (`routeAfterAuthorCases:168`); script-level review was removed (`testRunGraph.ts:180-181`). **DEFECT (design).**

## 7. Summary

**Q7.1 Rank all defects by (a) silent wrong output, (b) runaway cost/loop, (c) data loss on crash. Top 5 to fix first.**
(a) Silent wrong output: 1) broken trace correlation key + prompt never persisted (`tracer.ts:33,82`); 2) no arg-schema validation + name-inferred write-verification (`orchestrator.ts:482`, `policy.ts:6-15`); 3) dual canonical stores that disagree (`runMemory.ts:96` vs `store.ts:143`). (b) Runaway cost/loop: 4) unbounded run concurrency + full ~31-tool catalog re-sent up to 64×/run (`runtime.ts:744`, `registry.ts:608`). (c) Data loss: 5) mid-run crash unrecoverable + lost-update on `agent_runs` + multi-instance orphan cross-kill (`runtime.ts:838-843,882-895`, `repository.ts:643`). **Top 5:** ① run-scope the trace + persist the prompt; ② pre-dispatch arg validation + declared-capability dispatch check; ③ cap concurrent runs + relevance-filter the catalog; ④ lock/version `agent_runs` + gate the reconciler on ownership+staleness; ⑤ collapse the dual selector-memory stores.

---

# SET 2 — System Prompt Audit (33)

## 1. Inventory and ownership

**Q2.1.1 List every distinct system prompt — file, line range, agent/node. Any agents sharing a prompt that shouldn't, or duplicated/drifted prompts?**
Registry personas (in the composed stack): 19 in `AGENT_PROMPTS` (`systemPrompts.ts:172-500`) + 6 shared blocks (`:33-137`), assembled by `systemPromptFor` (`:542-570`). Standalone prompts outside the registry: `SUPERVISOR_SYSTEM` (`supervisor.ts:115-132`), `ADAPTIVE_CODE_EXPLORER_SYSTEM` (`:292-306`), `INTENT_DRIVEN_ANSWER_RULES` (`:218-230`), `INVESTIGATOR_ADDENDUM`/`JUDGE_ADDENDUM` (`investigation.ts:150-172`), analyst narrative (`analyst.ts:190`), `renderBehaviorForPrompt` (`behaviorOracle.ts:89-95`), edgeFinder/featureCoverage prompts (`edgeFinder.ts:104-118`, `featureCoverage.ts:238-248`), inline `controller.ts` strings. Sharing that shouldn't: `CriticAgent` uses `caseWriter`'s prompt (`agents.ts:103`). Drift: seven personas are dead-but-defined (aliased away, see Q7c). **DEFECT.**

**Q2.1.2 Are prompts versioned constants/files or built ad hoc via string concat? Show one full assembly path.**
Both. Registry personas are versioned constants (`AGENT_PROMPTS`) with DB overrides (`promptStore.ts:23-90`); the standalone drivers are ad-hoc template literals. Full path: `systemPromptFor('caseWriter')` → `composeSystemPrompt` (`:565`) → joins `CORE_IDENTITY + SCOPE_POLICY + SAFETY_POLICY + GROUNDING_POLICY + '--- AGENT ---' + role + persona + OUTPUT_FORMAT + INJECTION_DEFENSE` with `\n\n` (`:152-164`).

**Q2.1.3 Is there a single prompt registry/index, or must you grep the whole repo?**
No single registry. `systemPrompts.ts` is the registry for 19 personas, but the two most powerful runtime drivers (`SUPERVISOR_SYSTEM`, `ADAPTIVE_CODE_EXPLORER_SYSTEM`) and many node/addendum prompts live in code files — you must grep to find them all. **DEFECT.**

## 2. Role and scope definition

**Q2.2.1 For each agent: does the prompt state what it is NOT allowed to do, or only what it should do?**
Negative scoping exists but is uneven: shared `SCOPE_POLICY` (off-topic/refusal/injection, `:45-87`), `GROUNDING_POLICY #3` "Stay in your lane" (`:108`), per-persona negatives (caseWriter "Never invent…", `:233`; "Do NOT prefix titles", `:212`). But the two supervisor drivers omit `SCOPE_POLICY` entirely (see Q9).

**Q2.2.2 Does any agent's prompt contradict its actual tool permissions?**
Yes. `CORE_IDENTITY` tells every agent "you do not silently mutate production data… the human decides" (`:40-42`), yet the Supervisor holds `run_headless`/write-intents and is told "you do it… Prefer doing the work over narrating it" (`supervisor.ts:117,132`) with no human gate under `auto`. `CriticAgent` is given `verify_selectors`/`list_api_endpoints` tools (`agents.ts:103`) but a prompt (caseWriter's) that never mentions critique. **DEFECT.**

**Q2.2.3 Is the scope boundary re-stated near the end of long prompts, or only once at the top?**
Front-loaded only. Composed order puts the four policy blocks at the top; only `OUTPUT_FORMAT`+`INJECTION_DEFENSE` sit at the end (`:152-164`). For long personas (caseWriter ~48 lines, playwrightCoder ~20) the scope boundary is not restated at the end — lost-in-the-middle risk. **DEFECT (mild).**

## 3. Tool-use instructions

**Q2.3.1 For each tool, does the prompt/description explain when to use it vs not, or just what it does?**
Split and partial. Supervisor when-to-use lives in the system prompt (`supervisor.ts:123-128`) and thinly in `tool.spec.description` (`:88-102`). Deep-run authoring nodes have no tools, so no guidance needed there.

**Q2.3.2 Is there explicit instruction for what to do when a tool call fails, returns empty, or returns an unexpected shape?**
Only for hard errors — one generic recovery string (`orchestrator.ts:513-514`) + `supervisor.ts:130`. No guidance for empty results or unexpected-but-non-error shapes; an empty `query_workspace` is passed through raw (`:515`). **DEFECT.**

**Q2.3.3 Does the prompt tell the model how many tool calls are reasonable, or does it free-run to the hard cap?**
Free-runs. No budget signal in any prompt; the prompt only says "STOP when done" (`supervisor.ts:131`). Caps are code-side only (`maxSteps` 200/`maxTotalTokens` 120–250k, `supervisor.ts:459-460,641`). **DEFECT.**

**Q2.3.4 If tool results get truncated/summarized before re-entering context, does the prompt disclose it?**
No. `safeJson` hard-cuts tool results at 8000 chars with no marker (`orchestrator.ts:670-677`); authoring `.slice()` caps clip silently (`authoring.ts:371,377`). The tracer's `informationTruncated` flags model-output only, never reaches the model. **DEFECT (significant).**

## 4. Grounding and anti-hallucination

**Q2.4.1 Does every claim-producing agent have explicit "cite only what you observed, do not infer" language, or is it assumed?**
Explicit for every LLM claim-producer: `GROUNDING_POLICY` (`:104`), caseWriter (`:233`), playwrightCoder selectors (`:290,293,296`), appInspector (`:309,313`), featureAnalyst (`:400`), investigator (`investigation.ts:156-157`). Deterministic modules (caseCritic/verifier) enforce grounding in code, so carry no such prose.

**Q2.4.2 Is there a prompt distinction between "verified via live DOM" vs "assumed from static source," and is the model told to label which in output?**
Distinction exists as conflict-priority guidance (caseWriter `:234`, playwrightCoder `:297`) but no agent is instructed to LABEL provenance in output; only the case `Type` field hints. **DEFECT.**

**Q2.4.3 Bug-report generation: does the prompt require each claim grounded in a specific evidence item, or can it write unconstrained?**
Required only via `INVESTIGATOR_ADDENDUM` `verifiedBy` tags (`investigation.ts:156-157`); the base `defectTriage` prompt omits per-claim citation (`systemPrompts.ts:265-273`), and `verifiedBy` is a self-selected enum with no runtime validation the cited artifact supports the claim. **DEFECT.**

## 5. Output format enforcement

**Q2.5.1 Is required output a strict schema in the prompt, or a loose example?**
Strict where it matters: deep-run authoring uses constrained decoding (`zodTextFormat`, `responsesClient.ts:68`) / `generateObject({schema})` (`authoring.ts:247`); classification uses Zod `intentSchema` (`controller.ts:283-289`). `OUTPUT_FORMAT` prose (`systemPrompts.ts:116-124`) is a belt, not authority; free-text answer paths (`supervisor.ts:520,585`) are prose-governed only.

**Q2.5.2 What happens downstream when output doesn't match — repair/retry or throw?**
Repair-then-honest-fail. Deep-run: one quoted-issue repair call → typed `SCHEMA_INVALID_OUTPUT`, never a silent throw (`authoring.ts:272-326`). Chat `generateObject`: one retry, then throws on non-schema errors (`orchestrator.ts:242-249`).

**Q2.5.3 Do format instructions conflict between handoff agents — does writer's expected input match planner's actual output, structurally?**
Structurally the author↔planner schemas are Zod-validated, so shapes match. The risk is semantic, not structural: agent terminology is not unified (see Q2.7.1), so a receiving agent can mismap named content even when the JSON shape validates.

## 6. Context injection and window management

**Q2.6.1 What exactly gets injected into each prompt at runtime? Show the assembly code.**
Deep-run authoring (`authoring.ts:362-401`): goal + counts + bounded `understanding.slice(0,6000)` + `metadata(4000)` + `behavior(2500)` + `critique(3000)` + catalog (≤200 nodes) — no history/memory/blackboard. Chat (`supervisor.ts:617-631`): `assembleConversationContext` → history/summary/ledger block + apps block + page block + current message.

**Q2.6.2 Is there a token-budget check before sending, or can it silently overflow and get provider-truncated?**
Only the chat path is budgeted (`assemblePromptBudget`, `contextBudget.ts:24-46`). The deep-run authoring prompt uses fixed char caps with no model-aware token budget and no overflow guard (`authoring.ts:362-432`) — can silently exceed the window and be provider-truncated with nothing detecting it. **DEFECT.**

**Q2.6.3 When memory/blackboard facts are injected, are they deduplicated and recency-ordered, or can stale facts sit alongside their replacements?**
Priority-ordered but not supersession-deduped — a summary segment and the verbatim turns it summarizes can both be injected (`contextAssembler.ts:63-66`); a stale turn sits beside its correction, mitigated only by a "background, not authoritative" wrapper (`:91-92`). **DEFECT (mild).**

**Q2.6.4 If multiple memory sources feed one prompt, does assembly pick one canonical version per fact, or can contradictory facts both get injected?**
No canonical-version resolver. ledger + segments + turns (contextAssembler) and client-history + workspace-snapshot (`controller.ts:130-144`, which falls back between them) can co-inject contradictory facts. **DEFECT.**

## 7. Consistency across the pipeline

**Q2.7.1 Do handoff agents use consistent terminology, or does each prompt name things differently?**
Not unified — three naming schemes for the same actors: canonical prompt keys (`appInspector`/`caseWriter`/`playwrightCoder`/`defectTriage`), registry/bus names (`ApplicationInspector`/`TestGenerationAgent`/`PlaywrightAgent`/`CriticAgent`, `agents.ts:100-104`), and caseWriter's producer list (`FeatureAnalyst`/`FeatureDiscoveryAgent`/`E2EFlowAgent`, `systemPrompts.ts:203`). "Evidence" also splits (critic's `evidence.catalog` vs verifier's "inspection" tokens). **DEFECT.**

**Q2.7.2 Is there one shared house-style, or did prompts evolve inconsistently?**
Mostly shared — all `composeSystemPrompt` agents inherit the four policy blocks; inline exploration prompts inherit via `getOrchestrator('featureAnalyst')`. Minor JSON-boilerplate drift (edgeFinder vs investigation wording).

**Q2.7.3 Are there leftover/dead prompt variants that could get wired back in?**
Yes — seven personas (`caseReworker, stepExpander, runNamer, namingAgent, gitWatcher, folderOrganizer, reportNarrator`) are shadowed by `AGENT_ALIASES` (`systemPrompts.ts:523-535`) yet fully defined in `AGENT_PROMPTS`+`roleMap`; a direct `systemPromptFor(name)` or one alias-line change resurrects stale text. `searchAgent` is a live-but-un-canonical orphan; `explainer` appears unused at runtime. Confusable twins `verifier.ts` vs `verification.ts`. No commented-out blocks. **DEFECT.**

## 8. Error and edge-case instructions

**Q2.8.1 Does the prompt tell the model what to do when it has insufficient info — say so, or guess?**
Consistently "say so": `GROUNDING_POLICY` (`:104`), `SAFETY_POLICY` (`:99`), appInspector (`:312`), featureDiscoveryAgent (`:436`), JUDGE_ADDENDUM (`investigation.ts:171`).

**Q2.8.2 Is there instruction for handling a tool result that contradicts an earlier one (stale selector, changed DOM)?**
Absent. Only static-source-vs-live-browser priority is covered (caseWriter `:234`, playwrightCoder `:297`); nothing addresses reconciling two live observations at different times or a now-failing verified selector. **DEFECT.**

**Q2.8.3 For critic/reviewer agents: concrete rejection criteria, or left to model judgment?**
The live critic is deterministic code with concrete codes (`caseCritic.ts:228-244`), not a prompt rubric — and the model-facing `CriticAgent` prompt (borrowed caseWriter) plays no part. Review quality is code-defined; the "critic agent" prompt is a name-only shell.

## 9. Safety and permission boundaries

**Q2.9.1 Does any prompt instruct action on live/production systems, and is there explicit confirm/flag language before destructive actions independent of code gating?**
Prompts do instruct live action (`goalRouter` "deep_test_run… actually RUN tests", `:338`; Supervisor "you do it", `supervisor.ts:117`). Confirmation is 100% code-gated (`policy.ts:17-24`, `platformApi.ts:6`); the action-driving prompts contain no "confirm before write/irreversible" instruction — if a filter regex misses a name, the prompt gives no backstop. **DEFECT.**

**Q2.9.2 Are any secrets/credentials/internal URLs/PII interpolated directly into a prompt string? Show the interpolation points.**
Secrets: disciplined — no raw password/token/cookie/storageState is interpolated. Credentials flow by reference (`hasStoredCredentials` boolean `authoring.ts:354-360`, `credentialRef`, per-run resolver, leak-guard `state.ts:624-639`, output redaction `guardrails.ts:319-348`). Internal base URLs ARE interpolated (`controller.ts:111-112,873`) and full run records dumped via `JSON.stringify(run)` (`controller.ts:919,1032`) — references, legitimate for the task. Soft surface: `resolve_credentials` returns plaintext to `step.result` on the static-plan path (`controller.ts:1046-1055`), but is excluded from the LLM tool set.

**Q2.9.3 Any prompt-injection exposure — untrusted DOM/page/tool text concatenated into the prompt without sanitization/delimiting?**
Yes, strong cluster. `INJECTION_DEFENSE` names only the user message (`systemPrompts.ts:128`). Untrusted content injected as trusted: repo file contents (`supervisor.ts:567,584`; `registry.ts:352-359`), DB artifact text / user-authored case descriptions via `JSON.stringify` (`controller.ts:73-91,208-210,771-773,955,986`), DOM labels (`authoring.ts:387-391`). Worse: `SUPERVISOR_SYSTEM`/`ADAPTIVE_CODE_EXPLORER_SYSTEM` are passed as `opts.system` (`supervisor.ts:638,453`), bypassing `assembleSystem` — so `INJECTION_DEFENSE`/`SAFETY_POLICY`/`SCOPE_POLICY` never reach the very loops reading untrusted repo/DB/DOM and calling live tools. **DEFECT (critical).**

## 10. Testability and drift control

**Q2.10.1 Are prompts covered by any eval/test with fixed inputs and expected behavior, or is editing vibes-based?**
Largely vibes-based. Advertised evals point at missing files — `eval:agents`, `eval:routing`, `eval:coercion`, `benchmark:agents`, `benchmark:behavior` reference non-existent scripts (`package.json:99-104`); `npm run eval:routing` fails. What exists is deterministic code tests (`eval-prioritization.ts`, `test-router-agent.ts`). No golden-set behavioral eval for any prompt body, including the injection/secret regexes. **DEFECT.**

**Q2.10.2 When a prompt is edited, is there a changelog / git history readable in isolation, or buried in large files?**
Buried. `systemPrompts.ts` is a 573-line monolith with all personas in one object literal; `SUPERVISOR_SYSTEM`/addenda are inline in code files. `promptStore` versions only Settings-panel overrides (`promptStore.ts:23-90`), never the code defaults actually used in production. **DEFECT.**

**Q2.10.3 Is there A/B or staged rollout, or does every edit go straight to 100%?**
100%, immediate, all-or-nothing. `savePromptVersion` flips `isActive` globally (`promptStore.ts:75-88`); `getActivePrompt` has no cohorting (`orchestrator.ts:208`); code-default edits go live on restart. Additionally, a Settings override REPLACES the composed stack (`orchestrator.ts:207-213`) — returning only `override.body` + a request-id line, silently dropping `SAFETY_POLICY`/`INJECTION_DEFENSE`/`SCOPE_POLICY`/`GROUNDING_POLICY` for that agent. **DEFECT (critical).**

## 11. Summary

**Q2.11.1 Rank defects by (a) hallucinated/ungrounded output to user, (b) handoff misinterpretation, (c) context/token overflow, (d) prompt injection. Top 5.**
Top 5: 1) (d) Settings override deletes the safety/injection/scope stack (`orchestrator.ts:207-213`); 2) (d) the two live tool-loop drivers bypass `INJECTION_DEFENSE`/`SAFETY_POLICY` (`supervisor.ts:638,453`); 3) (d) untrusted repo/DB/DOM content injected as trusted (`supervisor.ts:567`, `controller.ts:208`, `authoring.ts:387`); 4) (a) ungrounded escape hatches — self-disabling grounding gate (`caseCritic.ts:191`), unvalidated `verifiedBy` (`investigation.ts:156`), no provenance labeling; 5) (c) no token budget on the deep-run authoring prompt (`authoring.ts:362-432`) + silent 8000-char tool-result truncation (`orchestrator.ts:670-677`). (b) handoff: three naming schemes (`agents.ts:100-104`). Cosmetic: garbled char in caseWriter prompt (`systemPrompts.ts:218`).

---

# SET 3 — Workspace/Session Memory Audit (27)

## 1. What actually gets persisted as "memory"

**Q3.1.1 List every memory store meant to survive across sessions (not per-run/per-conversation). For each: what triggers a write?**
Cross-session: `agent_memory` (`schema.sql:1405-1416`, subjects only `app.understanding`/`app.profile`) — write triggered by machine learning from the connected repo (`understandingProducer.ts:168`), background/sync-awaited; `run_memories` (`schema.sql:588-601`) — write triggered by executed-script outcomes (`execution.ts:154`), background. NOT cross-session (thread-bound): `conversation_artifacts` (every evidentiary tool call), `chat_summary_segments` (every 10 turns past 60), ledger (read-time). No write is "every message" or an explicit user save.

**Q3.1.2 Is there a defined boundary between conversation history (raw transcript) and memory (extracted durable facts), or is memory just the transcript re-read?**
Partial boundary. `agent_memory`/`run_memories` are extracted durable facts (cross-session). But `chat_summary_segments` "memory" is raw transcript re-chunked, not distilled (`conversationSummary.ts:40-42`), and the ledger is recomputed raw run records — so the session tier is effectively a longer context window, not extracted facts. **DEFECT (boundary blurred).**

**Q3.1.3 Show the actual extraction step: does something distill a conversation into facts before storing, or is raw text stored as-is?**
No conversation-to-fact extraction exists. Grep for `promote|distill|extractFact|worthRemember|consolidate` → only unrelated hits. `chat_summary_segments` slices raw text (`conversationSummary.ts:40-42`); the only "extraction" anywhere is machine-learning app facts from the repo (`understandingProducer.ts:140-168`), not from the conversation. **DEFECT.**

## 2. Save trigger

**Q3.2.1 If I state a fact today, what is the exact code path from that message to a persisted row? Trace it.**
For a user-stated fact: **there is no path** — no writer captures "I prefer X"/"the selector is #email" (grep of all semantic writers yields only `app.understanding`/`app.profile`). The one live durable write is machine-learned: `routes.ts:5495 → resolveAppUnderstanding →` grep repo → `await memory.write(...)` (`understandingProducer.ts:168`). **DEFECT.**

**Q3.2.2 Is saving synchronous or async/background? If background, is the fact lost if the process dies before the write?**
The understanding write is awaited (sync) but wrapped `.catch(()=>{})` inside a best-effort try/catch (`understandingProducer.ts:168`, `routes.ts:5507`) — a DB failure is silently swallowed and the fact lost with no signal. **DEFECT.**

**Q3.2.3 Is there filtering on what's worth saving, or is everything stored indiscriminately?**
`app.understanding` is filtered — written only if `learned` (repo auth keys OR nav modules OR API base, `understandingProducer.ts:163`); a pure-URL app is never remembered. `run_memories` is indiscriminate (every executed selector outcome). No relevance/worth gate. Both extremes present.

**Q3.2.4 Can the same fact get saved multiple times, creating duplicates instead of updating one canonical record?**
Yes. `PostgresMemoryStore.write` always inserts a fresh `uid('mem')` — never updates (`store.ts:141-147`); `run_memories` `ON CONFLICT (id)` never fires (random id, `runMemory.ts:93`). Both are insert-only → unbounded duplicates. **DEFECT.**

## 3. Recall trigger

**Q3.3.1 When I ask a new question later, what decides whether stored memory is retrieved — every request, keyword/semantic match, or only when explicitly asked?**
Unconditional on two specific pipelines: `app.understanding` recall on every deep-run/answer request (`routes.ts:5495`); `run_memories` recall on every coder-prompt build (`routes.ts:2974`). Not keyword/on-demand for those. No general personal-memory pre-fetch exists.

**Q3.3.2 Is retrieval semantic (embeddings), exact-match, or a dump of everything in scope regardless of relevance?**
Substring + recency, no embeddings. `agent_memory`: exact `scope_key`, `ORDER BY created_at DESC LIMIT 200`, then in-process `score = weight + recency + 2×lexical-includes` (`store.ts:70-79,157-158`). `run_memories`: `ILIKE %..%`, recency sort (`runMemory.ts:149-157`).

**Q3.3.3 Is there recency/relevance ranking, or could an old superseded fact outrank a newer contradicting one?**
Ranking hazard exists — lexical overlap is weighted ×2 vs sub-1 recency (`store.ts:79`), so a text-query recall can rank an older contradicting row above the correction. Masked for the live `app.understanding` recall only because it passes no text and `limit:1` (newest wins, `understandingProducer.ts:127`). **DEFECT.**

**Q3.3.4 If nothing relevant is found, does the system say so, or silently proceed?**
Silently proceeds — recall-miss falls through to fresh learning (`understandingProducer.ts:126-133`) or an empty prompt block (`routes.ts:2982`). No "no memory" signal; the user cannot tell recall-failed from nothing-stored. **DEFECT.**

## 4. Update and contradiction handling

**Q3.4.1 If I contradict a fact tomorrow, what happens to the old fact — overwritten, versioned, or both coexist?**
Both coexist. Insert-only, no overwrite/version (`store.ts:141-147`); the new row sits beside the stale one. For the live `limit:1`/no-text recall, newest-by-recency usually wins, but the stale row is never deleted and can win a future text-query recall. **DEFECT.**

**Q3.4.2 Is there any mechanism to detect that two stored facts conflict, or does conflicting memory silently coexist?**
No conflict detection anywhere. `run_memories` renders ALL contradictory `stable`/`broken` rows into the prompt via `summarizeMemoriesForPrompt` (`runMemory.ts:189-224`) with no reconciliation. **DEFECT.**

**Q3.4.3 Show one concrete trace: same fact saved twice with different values, then recalled — what does recall return?**
`agent_memory`: two writes for same `(scope,subject)` → two rows (`store.ts:141-147`); recall pulls both in the 200-row window ranked by `score` (`store.ts:161-163`) — for `limit:1`/no-text the newest wins; for a text query the higher lexical-overlap row (possibly the stale one) wins. `run_memories`: both rows returned and both rendered into the prompt (`runMemory.ts:189-224`).

## 5. Scope and permission boundaries

**Q3.5.1 What's the actual scoping key — per-user, per-workspace, per-project, or global? Show the column.**
`agent_memory`: single `scope_key` = `project::app::owner` (`store.ts:59-61`, `schema.sql:1407`). `run_memories`: `project_id, app_id, owner_id` (`schema.sql:596-598`). No `workspaceId` in either key. `conversation_artifacts`: `conversation_id` only, no owner column (`schema.sql:562`).

**Q3.5.2 Can memory leak across scope boundaries — User A's fact into User B's session — via a missing WHERE clause or shared cache key? Check every read path.**
Yes, multiple. `run_memories` OR-NULL filter `(owner_id IS NULL OR owner_id = ?)` (`runMemory.ts:151-153`) → any null-owner row (common: `execution.ts:162`) recalled into every user's coder prompt — **CRITICAL leak**. `loadRunMemories()` unscoped `SELECT *` (`runMemory.ts:227`) embedded in traces (`tracer.ts:51`) — **CRITICAL**. `searchConversationMemory`/`fetchArtifact` filter by `conversation_id` only, no owner check (`artifactMemory.ts:91,120`; `repository.ts:1981`) — **IDOR/HIGH**. `agent_memory` `'*'` empty-owner fallback → global bucket (`store.ts:60`) — MEDIUM. **DEFECT (each).**

**Q3.5.3 If a user belongs to multiple workspaces/projects, is memory partitioned per workspace or accidentally global to the user?**
Inconsistent. `agent_memory` is strict-partitioned by project+app+owner (`store.ts:60,153`) — a project-less fact stays keyed `*::*::owner`. `run_memories` OR-NULL bleeds a project-less fact across all of that user's projects (`runMemory.ts:151`). The two stores give opposite answers. **DEFECT.**

**Q3.5.4 Are there different memory tiers with different permissions (personal vs shared/team)? Enforced at query level or assumed?**
None exist. No visibility/tier column in schema or code. Every record is single-tier keyed by owner (or global when owner null/`*`). Sharing happens only accidentally via the null/`*` fallthrough — a leak, not a designed tier. **DEFECT.**

**Q3.5.5 Can an admin, another agent, or a different feature read raw memory rows outside the normal recall path?**
Yes. `loadRunMemories()` unscoped `SELECT * FROM run_memories` (`runMemory.ts:227`) is live-wired into `tracer.ts:51`; `clearRunMemories()` global `DELETE` (`:235`). Scoped `clearScope` (`store.ts:117-120`) and `retention.ts` crons are intended admin paths. No API route dumps `agent_memory`/`run_memories` (grep: none). **DEFECT (the trace bypass).**

## 6. Time-based recall

**Q3.6.1 Trace: ask today, saved; new session tomorrow, same/related question, zero reference — does it retrieve the earlier fact or start from zero?**
For a machine-learned app fact: retrieved. `routes.ts:5495 → resolveAppUnderstanding → memory.recall({scope,subject})` hits by `project::app::owner` with no conversationId (`understandingProducer.ts:127`), plus `run_memories` at `routes.ts:2974`. For a user-stated fact: starts from zero — no such fact was ever written. **DEFECT (for user facts).**

**Q3.6.2 Is memory tied to a specific conversation/thread ID, or decoupled so any new session for that user/workspace can recall it?**
Decoupled for the cross-session stores — neither `agent_memory` nor `run_memories` has a `conversation_id` column (`schema.sql:588-601,1405-1415`); recall keys purely on `project::app::owner`. Thread-bound stores (`conversation_artifacts`, segments, ledger) are not recallable cross-session.

**Q3.6.3 Is there any expiry/TTL on stored facts? Appropriate per type, or a blanket expiry?**
Inconsistent. `agent_memory`: no expiry, never touched by retention → lives forever (staleness risk). `run_memories`: 180-day purge (`retention.ts:13,34-36`) → a still-valid selector lesson older than that is silently dropped. `conversation_artifacts` 30d, segments indefinite. No per-fact-type justification. **DEFECT.**

## 7. Failure and silent-gap behavior

**Q3.7.1 If the memory store is down/slow, does the request fail loudly or silently proceed without memory?**
Silently proceeds — all live recall paths swallow errors to empty (`routes.ts:2968-2982`, `understandingProducer.ts:127`, `runMemory.ts:56-67`, `tracer.ts:50-55`). Good for availability, but no loud failure and no audit. **DEFECT (no signal).**

**Q3.7.2 Is there any user-facing signal ("using saved preference"), or is injected memory invisible?**
Invisible. Recalled memory is spliced into the prompt as text (`routes.ts:2981,3174`) with no UI signal. **DEFECT.**

**Q3.7.3 Can a user/admin see what's stored about them and delete/correct it, or is memory a write-only black box?**
Write-only black box. No memory-management route exists (grep: none). Only global `clearRunMemories()` (test util), programmatic `clearScope()`, and the retention cron. A poisoned learned `app.profile`/`app.understanding` recalls forever until manual `clearScope` (`discoverAppProfile.ts:127`). **DEFECT.**

## 8. Summary

**Q3.8.1 Rank defects by (a) cross-user/workspace leak, (b) contradictory memory corrupting an answer, (c) memory failing silently, (d) unbounded growth with no dedup/expiry.**
(a) `run_memories` OR-NULL leak (`runMemory.ts:153`) + `loadRunMemories()` in traces (`:227→tracer.ts:51`) + artifact IDOR (`artifactMemory.ts:91`) + `'*'` bucket (`store.ts:60`). (b) insert-only + no versioning + lexical-×2 ranking (`store.ts:70-79`, `runMemory.ts:189-224`). (c) universal silent degrade (`routes.ts:2982`), no signal, no user control. (d) insert-only duplicates + `InMemoryMemoryStore` no cap (`store.ts:87`) + inconsistent TTL (`retention.ts:13`).

**Q3.8.2 Confirm explicitly: does the system support save-today / recall-tomorrow / new session / zero reference — yes or no, with the proving code path?**
For a general user-stated fact: **NO** — no write path captures it (the only durable subjects are machine-learned `app.understanding`/`app.profile`, `understandingProducer.ts:168`; `run_memories` from executed scripts, `execution.ts:154`). For a machine-learned app fact: **YES** — proven: `memory.write({scope,subject:'app.understanding::<surface>'})` today (`understandingProducer.ts:168`) → new session tomorrow → `memory.recall({scope,subject})` hits by `project::app::owner`, no conversationId, no TTL (`store.ts:151-163`). The substrate for Claude-style recall exists; the user-fact capture layer is absent.

---

# SET 4 — Tiered Memory Design Audit (16)

## 1. Tier separation

**Q4.1.1 Is there a genuine distinction between session memory and long-term memory (different tables/triggers), or is "long-term" just the conversation-history table with longer lookback? Show the schema for each.**
Genuine store separation. Session/thread-bound: `conversation_artifacts` (`schema.sql:562`, key `conversation_id`), `chat_summary_segments` (`schema.sql:542`), ledger (`conversationState.ts:11`). Long-term/cross-session: `agent_memory` (`schema.sql:1405-1416`, key `scope_key`), `run_memories` (`schema.sql:588-601`, key project/app/owner). Different tables, different write triggers — not one table with longer lookback. But long-term holds only machine-learned app facts, and conversation facts never reach it (no promotion, Q4.1.2).

**Q4.1.2 Is there an explicit promotion step from a live session into long-term, or does long-term only get populated by a separate disconnected process that might miss same-day facts?**
No promotion step at all. Grep `promote|distill|consolidate` → only unrelated hits. Long-term is populated exclusively by two disconnected machine-learning writers (`understandingProducer.ts:168`, `execution.ts:154`), neither reading session content. A session fact is never promoted. **DEFECT.**

**Q4.1.3 If promotion happens via an LLM "is this worth remembering" call, show the prompt and its trigger cadence.**
No such LLM promotion prompt exists anywhere. **DEFECT (the mechanism is absent).**

## 2. Recall entry point for a brand-new session

**Q4.2.1 Zero prior messages in the thread — before the first response, is there a code path that queries long-term memory for that user/workspace and injects it, or is long-term consulted only on semantic match?**
For app facts: a code path queries long-term on the deep-run/answer pipeline (`resolveAppUnderstanding` `routes.ts:5495`; `retrieveRunMemories` `routes.ts:2974`), keyed by user/project, not gated on semantic match. But there is no general "fetch this user's long-term memory before the first response" path because no general user memory exists. **DEFECT (no personal-memory pre-fetch).**

**Q4.2.2 Is that pre-response fetch unconditional or heuristic? If heuristic, what's the failure mode when it guesses wrong?**
Unconditional on those two pipelines (not heuristic). Failure mode: recall-miss is silent — falls to fresh learning or empty block (`understandingProducer.ts:126-133`, `routes.ts:2982`), so a miss is indistinguishable from an empty store. **DEFECT.**

## 3. Scoping and leak boundaries (Tier 3 vs Tier 4)

**Q4.3.1 Is there a column distinguishing "personal, only this user's sessions recall" from "shared, any teammate recalls," or is scope inferred?**
Inferred, not explicit — no visibility/tier column (`schema.sql:1405-1416,588-601`). Owner-in-key is the only isolation; there is no personal-vs-shared distinction. **DEFECT.**

**Q4.3.2 Trace one read query per tier — does the WHERE enforce user_id/workspace_id at the query level, or is filtering done in app code after a broader fetch?**
`agent_memory`: query-level exact `scope_key = $1` (`store.ts:153`). `run_memories`: query-level but OR-NULL (`runMemory.ts:151-153`) — leaks null-owner rows. `conversation_artifacts`: query-level `conversation_id = $1` with no owner (`artifactMemory.ts:91`). `agent_memory` in-memory path filters in app code after loading (`store.ts:106-109`). Mixed; two paths leak. **DEFECT.**

**Q4.3.3 If a user is removed from a workspace, is their shared memory revoked from teammates' recall, or does it persist indefinitely?**
Persists indefinitely — no revocation mechanism/route exists (grep: none); the only deletion is the time-based `retention.ts` cron or programmatic `clearScope`. Whatever is shared (via null-owner leak) is never revoked on permission change. **DEFECT.**

## 4. Update and versioning across tiers

**Q4.4.1 A fact captured in session, promoted to long-term, then contradicted later — does the later promotion overwrite, version, or duplicate the long-term record?**
N/A for the promotion framing (no promotion exists). Directly in long-term: contradiction duplicates — insert-only, no overwrite/version (`store.ts:141-147`; `run_memories` random-id defeats `ON CONFLICT`, `runMemory.ts:93`). **DEFECT.**

**Q4.4.2 Can session and long-term disagree at the same moment — a mid-session correction not yet propagated, while a concurrent session recalls the stale long-term version?**
Yes. Session context (thread-bound) and long-term (cross-session) are separate stores with no sync; a correction in session A's context is not in long-term until a machine-learning write occurs (if ever), so a concurrent session B recalls the stale long-term row. Insert-only means both versions then coexist. **DEFECT.**

## 5. Time-boundary behavior

**Q4.5.1 Trace literally: fact at time T in session A; new session B at T+hours, same user, no reference — does B's first response reflect A's fact? Walk the path or show where it breaks.**
For a machine-learned app fact: reflected — `understandingProducer.ts:168` write at T → `routes.ts:5495 → memory.recall({scope,subject})` in session B hits by `project::app::owner`, no conversationId, no TTL (`store.ts:151-163`). For a user-stated fact: breaks at the write step — nothing captured A's fact, so B recalls nothing (Q3.2.1). **DEFECT (user facts).**

**Q4.5.2 Is there any delay between promotion and recall-availability (async batch every N hours) that would make same-day recall fail?**
No — the machine-learned write is synchronous same-request (`understandingProducer.ts:168`) and recall reads the live table, so same-day recall of an app fact is immediate. There is no promotion batch; the failure mode is the absence of user-fact capture, not latency.

## 6. Retrieval quality within long-term memory

**Q4.6.1 When long-term memory is queried, is it relevance-ranked (semantic/recency) or a dump of all facts for that scope regardless of relevance?**
Ranked but shallow — `agent_memory` pulls newest 200 by scope then re-ranks `weight + recency + 2×lexical-includes` (`store.ts:70-79,157-158`); `run_memories` is `ILIKE` + recency (`runMemory.ts:149-157`). No semantic/embedding search; lexical overlap can misrank.

**Q4.6.2 Is there a cap on how much long-term memory is injected per request? What happens once facts exceed the cap — oldest dropped, least-relevant dropped, or silent truncation?**
`agent_memory` caps the candidate window at 200 rows by recency (`store.ts:157`) — anything older is silently dropped before ranking (so a relevant old fact outside the newest 200 is never seen). `run_memories` prompt render caps at 2000 chars with a `…(truncated)` marker (`runMemory.ts:216-222`). `InMemoryMemoryStore` has no cap and grows unbounded (`store.ts:87`). Mix of oldest-dropped and silent truncation. **DEFECT.**

## 7. Summary

**Q4.7.1 State plainly per tier whether it exists, with file:line.**
Tier 1 (session memory): ✅ `conversation_artifacts`/`chat_summary_segments`/ledger (`schema.sql:562,542`, `conversationState.ts:11`). Tier 2 (long-term cross-session recall): ⚠️ PARTIAL — exists and proven but only for machine-learned app facts (`understandingProducer.ts:168`, `execution.ts:154`), never user-stated facts, no promotion. Tier 3 (personal long-term): ❌ as a designed tier — incidental owner-keying only (`store.ts:60`), no user-fact store. Tier 4 (shared/team long-term): ❌ — no shared tier; only accidental via null-owner leak (`runMemory.ts:153`).

**Q4.7.2 Rank defects by (a) Tier 3 doesn't exist / faked by Tier 1-2, (b) cross-user leak in Tier 4, (c) stale/contradicting facts winning at recall, (d) same-day recall failing due to async promotion delay.**
(a) No user-fact store, no promotion, no tier column — Tier 3 is faked by owner-keyed Tier-2 app-fact caching + Tier-1 context (`understandingProducer.ts:168`, `§4.1`). (b) `run_memories` null-owner (`runMemory.ts:153`) + `loadRunMemories` in traces (`:227→tracer.ts:51`) + artifact IDOR (`artifactMemory.ts:91`) + `'*'` bucket (`store.ts:60`). (c) insert-only + lexical-×2 ranking (`store.ts:70-79`, `runMemory.ts:189-224`). (d) Not applicable — recall is synchronous; the real failure is absent user-fact capture, plus 200-row/180-day silent drops (`store.ts:157`, `retention.ts:13`).

---

## Cross-cutting through-line (all four sets)
The strongest machinery is consistently absent, dead, or flag-gated OFF, so the live system runs on a weaker substrate: the agent-native bus/blackboard and `runViaBus` (`AGENT_NATIVE_V1` OFF), the typed memory gate (`gate.ts`, zero live callers), the Reflexion critic loop (`orchestrator.ts:597-610`, no caller), horizontal-resume `runStore` (OFF), and any user-fact/semantic memory (absent). Enforcement is repeatedly by prompt/name-inference rather than by schema/lock/scope, which is why correctness, provenance, and isolation degrade under load.

*End of document — findings only.*
