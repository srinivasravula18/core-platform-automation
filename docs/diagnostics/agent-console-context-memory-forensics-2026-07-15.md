# Agent Console Long-Conversation Forensics — Conversation, Context & Memory Architecture

**Date:** 2026-07-15 · **Branch:** `langchain_version` · **Mode:** Phase-0 investigation (read-only; no code was modified)

**Question under investigation:** the Agent Console performs well in short conversations, but in long ones the agent forgets previous discussion, repeats work, loses decisions, and behaves as though earlier context disappeared — while ChatGPT maintains continuity across much longer threads. Why?

**Method:** direct code inspection of the working tree plus five parallel read-only code investigations (chat lifecycle, context construction, tool-output/runtime-state persistence, LangGraph layer, memory/retrieval sweep). Builds on and does not re-derive:
- `docs/diagnostics/agent-run-incident-report-2026-07-10.md` (live-run trace)
- `docs/diagnostics/pipeline-runtime-forensics-2026-07-10.md` (deep-run pipeline truncation census)

Every load-bearing claim is cited `file:line` against the current tree. The two most consequential single-source claims (`slice(-6)`/700 default path; client `slice(-16)`/2400) were independently re-verified in the working tree.

---

## 1. Executive Summary

**The agent does not "run out" of context. It throws context away by design, at fixed turn counts, while using well under 2% of the model's context window.**

Five structural facts produce every symptom reported:

1. **The stored conversation is never shown to the model.** Every conversation is fully and durably persisted (`chat_conversations.turns` JSONB, unbounded — `server/db/schema.sql:362-370`), but that store is read only to repaint the UI after reload/switch. No server code path ever reads it back to build an LLM prompt. What the model sees is a *client-sent snapshot*: `buildHistory()` in the browser caps it to the **last 16 turns** with assistant turns clipped to **2,400 chars** (`src/pages/AgentConsole.tsx:1025,1077`).

2. **The default answer path then re-caps that snapshot to the last 6 turns × 700 chars (~1,000 tokens).** Any message not matching an "action verb" regex takes the fast git-grounded path, whose only conversational memory is `withConversationContext()` — `turns.slice(-6)`, 700 chars per turn (`server/features/controller/routes.ts:9,17,20`). Against configured model windows of 400K–1M tokens (`server/ai/providers/types.ts:243-288`), the system discards history at **~0.1–1.5% window utilization**. Forgetting begins at the **4th user message** on this path (7th turn pushes turn 1 out of the window), and at the 9th exchange on the 16-turn paths.

3. **Nothing bridges the cut.** There is no conversation summarization, no rolling digest, no compression, no embeddings, no vector store, no retrieval over older turns — verified as definitive negatives across `server/` (§4). Turns that fall out of the window are simply gone. A token-aware context assembler was actually built for exactly this problem (`server/ai/openai/promptBudget.ts`) — it has **zero importers**.

4. **Work products are forgotten even *inside* the window.** Assistant "work" turns are lossily serialized before entering history: an entire deep run becomes the single line "Started a deep test-generation run (task X)"; generated cases become bare titles; reviews become 600-char summaries (`AgentConsole.tsx:1056,1061,1065,1071`). Tool outputs are never persisted or replayed: each turn's tool loop starts as `messages = [{role:'user', content: task}]` (`server/ai/orchestrator.ts:400`) — one synthetic user message; prior tool results, reasoning steps, and structured assistant turns are discarded at turn end (`server/features/chat/routes.ts:111-116`). The next turn therefore *re-runs* codebase research (up to a 200-step exploration loop per question — `server/ai/supervisor.ts:388`), re-inspects pages, and re-derives decisions.

5. **There is no cross-turn state ledger.** Nothing durable records the current objective, plan, decisions made, or work completed at conversation scope. The only structured plan/state record (`WorkflowState`) is keyed `thread_id = runId` — per deep run, invisible to chat and to subsequent runs (`server/features/agent/workflow/runtime.ts:373-376`). The one cross-request buffer (`controllerMemory`) is a module-global 20-entry ring shared across *all users and conversations*, lost on restart (`server/ai/controller.ts:41-49`).

ChatGPT's continuity advantage is not model magic: it reconstructs conversations server-side from authoritative storage, fills the window before dropping anything, compacts older content instead of deleting it, persists tool outputs inside the thread state, and retrieves long-term memory. This codebase has the storage, the checkpointer, the budgeter, and an episodic memory store **already built** — they are simply not wired into the request path. The fix is dominantly *wiring*, not invention.

A secondary, inverse defect: while cross-turn context is starved, **within-turn** context can explode — the tool loop is append-only with no pruning, no `maxTotalTokens` (the budget stop is dead code on the chat path — `orchestrator.ts:409`), and a 200-step ceiling; a worst-case adaptive exploration can accumulate ~425K tokens in a single turn, the only place genuine window exhaustion is possible (§6.4).

---

## 2. Complete Architecture Diagram

```
┌─────────────────────────────────────── BROWSER (src/pages/AgentConsole.tsx) ───────────────────────────────────────┐
│ turnsRef (full transcript, in React state)                                                                         │
│   ├── buildHistory(): serialize work-turns lossily (runs→1 line, cases→titles, reviews→600c)                       │
│   │      assistant turns .slice(0,2400) → out.slice(-16)                          [1023-1078]  ◄── CUT #1          │
│   ├── conversationId = client UUID, keyed per project+app scope (`proj::app`)     [456-470, 567-575]               │
│   │      scope switch → REMOUNT → different/new conversation                      [547-549]    ◄── FORK            │
│   └── debounced 700ms PUT full turns → /api/chat/conversations/:id                [779-798]                        │
└──────────┬──────────────────────────────────────────────────────────────────────────────────────────────┬─────────┘
           │ POST {message, history(≤16), apps, pageContext}                                               │ UI-only
           ▼                                                                                               ▼
┌── /api/agent/goal ─────────────┐                                                    ┌────────────────────────────┐
│ routeGoal() classifier          │  history.slice(-12) @600c   [router.ts:352-355]   │ Postgres                   │
│ returns {kind} only             │                                                   │  chat_conversations        │
└──────────┬─────────────────────┘                                                    │   turns JSONB (unbounded)  │
           │ dispatch on kind [AgentConsole.tsx:1854]                                 │   [schema.sql:362-370]     │
           │                                                                          │  ⚠ NEVER read into any     │
   ┌───────┴────────────┬──────────────────────────────┐                              │    LLM prompt — UI repaint │
   ▼                    ▼                              ▼                              │    only                    │
questions (default)   actions (ACTION_RE match)     deep runs                         └────────────────────────────┘
   │                    │                              │
   ▼                    ▼                              ▼
/api/controller/supervise/stream                 /api/agent/start [agent/routes.ts:4858]
[controller/routes.ts:191]                             │ history.slice(-16) @1200c [4515]
   │                    │                              │ deriveUnderstandingFromChat: last-6 assistant,
   │ withConversation-  │ historyBlock =               │   keep single LONGEST      [goalContext.ts:75-81] ◄── CUT #4
   │ Context():         │ history.slice(-16)           │ buildGoalContext: slice(-12) @2400/600 [goalContext.ts:106-107]
   │ slice(-6) @700c    │ (no char cap)                │ priorEvidenceRun seeding (legacy only; same convo+scope)
   │ [ctrl routes:17,20]│ [supervisor.ts:538]          │   [routes.ts:5051,5135-5137]
   │   ◄── CUT #2       │   ◄── CUT #3                 ▼
   ▼                    ▼                        ┌─ legacy pipeline (default) ──┐  ┌─ LangGraph (AGENT_GRAPH_V2, OFF) ─┐
answerAppQuestionFromCode()              runSupervisor()                        │  │ thread_id = runId (per-run)       │
[supervisor.ts:336]                      [supervisor.ts:516]                    │  │ no messages channel, no Store     │
   │ 3 engines, recomputed EVERY turn:      │ ~31 tools (~12-18K chars schemas) │  │ artifactStash = RAM Map (heavy    │
   │  1. adaptive loop maxSteps=200         │ maxSteps=60, no token budget      │  │  payloads; dies with process)     │
   │  2. deepParallelResearch (no cache)    │                                   │  │ checkpoints → Postgres (refs      │
   │  3. deterministic grep                 │                                   │  │  only, no TTL) [checkpointer.ts]  │
   └──────────┬─────────────────────────────┴───────────┬─────────────────────-┘  └───────────────────────────────────┘
              ▼                                         ▼
        runToolLoop()  [orchestrator.ts:375-568]  — SHARED SUBSTRATE
        messages = [{role:'user', content: task}]          [orchestrator.ts:400]  ◄── history flattened INTO one
        loop: +assistant(toolCalls) +tool(safeJson≤8000c)  [445, 464-471, 597]        synthetic user message; no
        append-only; never pruned; budget stop dead code   [409]                      structured replay of past turns
              │
              ▼
        providers: OpenAI chat.completions [openai.ts:114] · Anthropic messages.create [anthropic.ts:144]
                   Gemini generateContent [gemini.ts:81] · CLI spawn (codex/claude) [cli.ts:63]
                   (graph nodes only: OpenAI responses.parse, store:false, no previous_response_id [responsesClient.ts:72,75])
              │
              ▼
        finalText → SSE → UI appends turn → client PUTs full turns (storage loop closes ABOVE the model, not through it)
        tool results / steps / research notes → DISCARDED at turn end   [chat/routes.ts:111-116]

  DURABLE STORES (who reads them back?)                     RAM-ONLY (lost on restart)
  ─────────────────────────────────────                     ──────────────────────────
  chat_conversations.turns → UI only                        controllerMemory (global, 20) [controller.ts:41]
  agent_runs.raw (inspection, selectors, scripts)           artifactStash per-run Map [artifactStash.ts:23]
    → legacy priorEvidenceRun seeding only                  inspection/understanding/auth caches (TTL 15m)
  object_repository (versioned controls)                      [agent/routes.ts:1214-1219]
    → versioning + risk only; never re-grounding, never chat pageSession (TTL 10m) · exploreCache (TTL 5m)
  blackboard (.testflow-data.json, global ≤100, URL-keyed)  planPlans Map [controller.ts:40]
    → NOT in the chat toolset [supervisor.ts:535]
  .testflow-run-memory.json (episodic; WRITE PATH UNWIRED)
  LangGraph checkpoints (refs only, no TTL)
```

---

## 3. Conversation Lifecycle

### 3.1 Where conversations begin
- A conversation is born **in the browser**: `makeConversationId()` = `crypto.randomUUID()` (`AgentConsole.tsx:462-470`), chosen at mount from URL `:chatId` → `localStorage[convKey]` → fresh UUID (`567-575`).
- Identity is **scoped per project+app**: `scopeWorkspaceId(projectId, appId)` = `` `${projectId||'none'}::${appId||'all'}` `` (`456-457`). Switching project or app remounts the console subtree (`547-549`) and loads a *different* conversation — earlier discussion does not carry across scopes. This is deliberate isolation, but it is also a silent context fork.

### 3.2 Where they are stored
- `chat_conversations` — one row per conversation, entire transcript in a single `turns` JSONB array; Postgres when enabled, else in-memory array + JSON snapshot (`schema.sql:362-370`, `repository.ts:1196-1249`). Durable across restarts under Postgres.
- **Persistence is client-driven**: a debounced (700 ms) effect PUTs the *full* turn list on every change (`AgentConsole.tsx:779-798`); the server `upsert` overwrites `turns` wholesale (`repository.ts:1230-1236`). The only server-side turn append lives on `POST /api/chat` (`chat/routes.ts:109-117`) — an endpoint the console does not call.

### 3.3 How history is retrieved
- **For the UI**: GET `/api/chat/conversations/:id` on reload/switch (`AgentConsole.tsx:699-714`). Full fidelity.
- **For the model**: never from the DB. The model receives whatever `history` array the client posts — `buildHistory()`'s 16-turn, 2,400-char-assistant snapshot with lossy work-turn serialization (`1023-1078`) — then each server path re-cuts it (§5). The design comment above `buildHistory` states the intent explicitly: *"request carries conversation memory (ChatGPT/Claude-style continuity)"* (`AgentConsole.tsx:1022`) — i.e., client-carried memory was the chosen architecture. ChatGPT does the opposite (server-side reconstruction; §8.1).

### 3.4 Sessions, threads, IDs
- No server-side session or thread object exists for chat. `POST /api/controller/supervise/stream` is called with hardcoded `workspaceId: 'default'` and **no conversationId** (`AgentConsole.tsx:1520`) — the two answer paths cannot even look a conversation up. Only the deep-run path threads `conversationId` (`1102`), where it powers `latestRunForConversation()` prior-evidence seeding (`agent/routes.ts:237-241, 5051`).
- Conversation IDs are stable within a scope (localStorage + URL mirror). New conversations are silently created on: scope switch with no stored id, explicit "+", or missing localStorage.
- **Agent state does not survive requests.** Every request rebuilds system prompt, tool set, grounding, and history block from scratch (§5). Module-global leftovers (`controllerMemory` ring of 20, `planPlans`, TTL caches) are process-scoped, conversation-blind, and restart-lost (`controller.ts:40-49`; `agent/routes.ts:1214-1219`).

### 3.5 Where conversations end
- Never, structurally: no TTL, no archival, no compaction, no cap on `turns` growth. `LIMIT 100` (`repository.ts:1205`) and `slice(0,50)` (`chat/routes.ts:133`) are sidebar display caps only. Deletion is user-initiated only (`chat/routes.ts:173`). The JSONB array grows unbounded with full-array rewrite on every turn (write amplification; §9.7).

**Verdict (user's Area 1):** conversations begin client-side, persist durably, and are retrieved for display only. Sessions/threads are not recreated because they never exist server-side; the conversation ID never reaches the answer paths; no agent state survives requests.

---

## 4. Memory Lifecycle

### 4.1 What exists (exhaustive sweep — verdicts)

| Category | Verdict | Evidence |
|---|---|---|
| Embeddings / vector store / semantic search | **Does not exist** | No embedding/cosine/pgvector/faiss/chroma/pinecone/qdrant code or deps; `caseReuse.ts:4` explicitly: *"Deliberately LEXICAL (no embeddings/vector DB)"* |
| RAG / retrieval over conversation history | **Does not exist** | No code path searches past turns beyond the slice windows |
| Conversation summarization / rolling digest / compaction | **Does not exist** | Every `summar*` hit is a deterministic formatter or report narrative, not conversation memory (`runMemory.ts:155` is a string formatter; `controller.ts:112-118` is raw truncation) |
| Long-term memory | **Partial, dormant** | `runMemory` (`server/ai/memory/runMemory.ts`): file-backed episodic store (`.testflow-run-memory.json`, MAX 5000 records, retrieve 20 by substring, 2000-char summary — `:20,23,26,29,119,155`). **Write path unwired**: `recordRunMemory` has no production callers — the store never learns |
| Short-term / session memory | **Ring buffer, wrong scope** | `controllerMemory`: module-global, 20 entries, shared across all users/conversations, restart-lost; fallback-only (`controller.ts:41-49,86-88,229-231`) |
| Working memory (within one turn) | **Exists** | The intra-turn tool-loop transcript (`orchestrator.ts:445,464-471`) — discarded at turn end |
| Structured domain memory | **Exists, not consulted for continuity** | `object_repository`: persistent versioned control history (`objectRepository.ts:61-63,126-127`; `schema.sql:489`) — consumed only by `versioning.ts`/`riskAnalysis.ts` and the investigation node; never to skip rediscovery, never by chat. Blackboard: global ≤100 URL-keyed verified selectors, durable, **absent from the chat toolset** (`supervisor.ts:535`) |
| Knowledge grounding | **Gutted / keyword-only** | `getFeatureGrounding()` is a no-op returning `''` (`knowledge/index.ts:15-21`); surviving selection is keyword section-ranking of a markdown pack (`knowledgeService.ts:272-322`), classify/explain path only, 2000 chars |
| LangGraph memory (Store / cross-thread) | **Not used** | No `Store` anywhere; `thread_id = runId`; no `messages` channel (§4.3) |

### 4.2 What survives between requests — the definitive table

| Artifact | Stored where | Keyed by | Survives restart? | Read by a LATER chat turn or run? |
|---|---|---|---|---|
| Full transcript | `chat_conversations.turns` | conversationId | Yes (PG) | **UI only — never the model** |
| Chat tool outputs (search/read/query results) | nowhere | — | — | **No — discarded at turn end** (`chat/routes.ts:111-116`) |
| Research notes (`deepParallelResearch`) | nowhere | — | — | **No — recomputed every turn** (`supervisor.ts:413-450`) |
| Deep-run evidence (inspection_context, dom_exploration, selector_registry) | `agent_runs.raw` JSONB | runId | Yes | **Legacy: yes** — `priorEvidenceRun` seeding, same conversationId + same mission scope (`routes.ts:5051,5135-5137`) + 15-min caches (`:1214-1217,5343`). **Graph path: no** — rediscovers every run (`nodes/discovery.ts:201-242`) |
| Heavy graph artifacts (evidence graph, plans, compiled sources, screenshots) | `artifactStash` RAM Map | runId | **No** | No — same-run only; restart ⇒ orphan-failed, "start it again" (`artifactStash.ts:23`, `runtime.ts:583-642`) |
| Auth/browser state | RAM cache + `.testflow-pw/${runId}-auth.json` | **runId**, TTL 15 min | No (per-run files) | **No — every new run logs in again** (`authSession.ts:19-33`; `routes.ts:1218-1223`) |
| Objective / plan / completed tasks | `WorkflowState` (PG checkpoint) | `thread_id = runId` | Yes (PG) | **No** — same-thread resume only; `getGraphRunState` has zero production callers |
| Selector stability lessons | `.testflow-run-memory.json` | feature/selector/project | Yes | Read at script-gen + investigation — **but the write path is unwired, so it reads an empty well** |
| Verified selectors | blackboard (`.testflow-data.json`) | URL (global, ≤100) | Yes | Only if a tool re-queries it; chat loop has no such tool |

**Verdict (Areas 5, 8):** between requests, the *only* things the model can ever see again are (a) the truncated plain-text history snapshot and (b) whatever a tool happens to re-fetch from the workspace DB or repo. Objective, plan, decisions, completed work, login state, browser state, DOM state, and all tool evidence are per-request or per-run. Work repetition is therefore structural, not a model failure: the agent re-runs `search_codebase`/`read_code_file`, re-executes up-to-200-step explorations, re-inspects pages, and re-logs-in because nothing tells it that it already did.

### 4.3 The LangGraph layer changes none of this (yet)
- Dark-launched: `AGENT_GRAPH_V2` default OFF (`.env.example:51-62`); flag-off runs the legacy pipeline byte-for-byte (`agent/routes.ts:5222-5259`).
- Well-engineered *per-run* durability: Postgres checkpointer with fail-closed production guard (`checkpointer.ts:33-49`), refs/digests-only state with bounded reducers (`state.ts:5-9,250`), redacted event stream (`events.ts`), deterministic review-interrupt resume.
- But: `thread_id = runId` (per-run threads), no `messages` channel, no cross-thread `Store`, heavy payloads RAM-only, mid-run restart ⇒ deliberate orphan-fail, checkpoints never pruned, and the graph path **loses** the legacy path's prior-run evidence seeding — under the flag, cross-run reuse *regresses*.
- The only conversation carryover into a graph run is `request.understanding` — one string, capped at 6,000 chars in the authoring prompt (`state.ts:52-54`; `nodes/authoring.ts:352-354`).

---

## 5. Context Lifecycle

### 5.1 Assembly flow (stored rows → provider messages)

```
chat_conversations.turns ({role,text})                        [authoritative, unread by model]
   │ client snapshot: buildHistory() — lossy serialize; assistant.slice(0,2400); out.slice(-16)
   ▼
history[] in POST body
   ├─ /api/agent/goal      → buildRouterPrompt: slice(-12) @600c            [router.ts:352-355]
   ├─ questions (default)  → withConversationContext: slice(-6) @700c       [controller/routes.ts:14-27]
   ├─ actions              → historyBlock: slice(-16), no char cap          [supervisor.ts:537-539]
   ├─ classify/explain     → formatHistory: slice(-16) @1200c               [controller.ts:112-119]
   └─ deep runs            → slice(-16) @1200c [agent/routes.ts:4515]; buildGoalContext slice(-12) @2400/600
                             [goalContext.ts:106-107]; deriveUnderstandingFromChat last-6-assistant → keep longest [:75-81]
   ▼
task = "User request: <msg><pageBlock><appsBlock>\n\nRECENT CONVERSATION (oldest first):\n<role: content lines>"
   ▼
runToolLoop: messages = [{role:'user', content: task}]                      [orchestrator.ts:400]
   — ONE synthetic user message. No role:'assistant' replay. No role:'tool' replay. No multi-message history.
   ▼
intra-turn only: +{role:'assistant',toolCalls} +{role:'tool', content: safeJson(result).slice(0,8000)}  [445,464-471,597]
   ▼
finalText persisted as text; loop transcript discarded                      [chat/routes.ts:111-116]
```

### 5.2 Answers to the specific Area-2 questions
- **How many previous messages?** 6 (default question path) / 16 (action, classify, explain, `/api/chat`) / 12 (router, deep-run goal context) — always the client's ≤16 snapshot upstream.
- **Truncated?** Twice: turn-count slice + per-turn char caps (700 / 1200 / 2400-assistant / 600-user depending on path). Cuts are silent — no truncation markers.
- **Only recent messages?** Yes, strictly recency-windowed. No salience, no pinning, no retrieval of older turns.
- **Assistant messages removed?** Included as flattened `assistant: <text>` lines inside the window — but *work* turns were already collapsed client-side to one-liners/titles, and past-window turns vanish.
- **Tool outputs removed?** Entirely, every turn (§4.2).
- **System prompts regenerated?** Yes, deterministically identical per request (`systemPrompts.ts:141,145-165`; DB override possible via `getActivePrompt` — `orchestrator.ts:186-190`). No growth, no drift — this part is healthy.
- **Context compression?** None anywhere.

### 5.3 Prompt engineering findings (Area 10)
- System prompts are static and reasonable in size: `SUPERVISOR_SYSTEM` ≈ 2,853 chars; `ADAPTIVE_CODE_EXPLORER_SYSTEM` ≈ 1,932; composed `chatAssistant` ≈ 9,900 (~2.5K tokens, synthesis calls only). No duplication or unbounded growth of instructions. Injection defense exists (`INJECTION_DEFENSE` block + guardrail pipeline).
- **Guardrail blind spot:** `runGuardrailPipeline` analyzes a copy of the task normalized to `MAX_INPUT_LENGTH = 8000` chars (`guardrails.ts:68,96-113`), but the *raw untruncated* task is what's sent to the model (`orchestrator.ts:400`). Content beyond 8K — e.g. injected inside a long pasted history — escapes policy analysis. Side finding, not a continuity cause.
- Deep-run prompts remain the flat-string concatenation with ~20 silent caps censused in the 2026-07-10 forensics (unchanged; see that doc's Part 6 table).
- History is injected as an unstructured text block rather than provider-native message turns — this measurably weakens the model's ability to attribute statements to speakers and honor prior instructions, independent of the truncation.

### 5.4 `deriveUnderstandingFromChat` (the chat→run bridge)
Assistant-only turns, noise-filtered (`isNoiseTurn` drops greetings/errors/capability blurbs — `goalContext.ts:54-63`), last 6, then **keeps only the single longest turn** (`:75-81`). A 30-turn design discussion collapses to one assistant message at handoff — decisions distributed across several turns are structurally lost at the exact moment the user says "now build it."

---

## 6. Token Flow

### 6.1 Per-request budget — question path (the default), step 0

| Component | ~Chars | ~Tokens (÷4) |
|---|---|---|
| System (`ADAPTIVE_CODE_EXPLORER_SYSTEM`) | 1,932 | ~480 |
| Tool schemas (3 code tools) | ~2,300 | ~575 |
| Task preamble + answer rules + apps block | ~1,700 | ~425 |
| **Conversation history (6 × 700 max)** | **≤4,200** | **≤1,050** |
| Current question | ~300 | ~75 |
| **Total step-0 input** | **~10,400** | **~2,600** |

**Window utilization: ~0.26% of a 1M-token model. History's share: ~1,050 tokens.**

### 6.2 Per-request budget — action path (`runSupervisor`), step 0

| Component | ~Chars | ~Tokens |
|---|---|---|
| System (`SUPERVISOR_SYSTEM`) | 2,853 | ~713 |
| Tool schemas (~31 tools) | 12,000–18,000 | 3,000–4,500 |
| History (16 turns; client-capped) | 8,000–38,400 | 2,000–9,600 |
| Message + page/apps blocks | ~1,000 | ~250 |
| **Total step-0 input** | **~24K–60K** | **~6K–15K** |

**Window utilization: 0.6–1.5%.** Note tool schemas typically cost **3–4× more than the entire conversation memory** — resent on every step of every turn.

### 6.3 When does history disappear?
**At fixed turn counts, not token pressure.**
- Question path: window = 6 turns ⇒ the **4th user message** can no longer see the 1st (turn 7 evicts turn 1). Users lose an "exchange-3 decision" on exchange 4 — matching the reported feel of near-immediate amnesia.
- Action/classify/explain/`/api/chat`: 16 turns ⇒ the 9th exchange loses the 1st.
- Client ceiling: 16 turns regardless of server path; work products degrade to one-liners even sooner.
- Deep-run inheritance: last 6 assistant turns considered; one survives.

A 100-turn conversation at ~500 chars/turn is ~50K chars ≈ 12.5K tokens ≈ **1.25% of the configured window**. The models could carry the *entire* conversation for hundreds of turns before any trimming was needed.

### 6.4 The inverse defect: within-turn context explosion
The tool loop appends `{role:'tool'}` results capped at 8,000 chars each (`orchestrator.ts:597`), never prunes, and chat callers never set `maxTotalTokens` — the budget break at `orchestrator.ts:409` is dead code on this path. Ceilings are step counts alone: 60 (supervisor), 200 (adaptive explorer — `supervisor.ts:388,553`).
- Worst case per step ≈ 8.5K chars ⇒ 60 steps ≈ 510K chars ≈ **~128K tokens**; 200 steps ≈ 1.7M chars ≈ **~425K tokens** — exceeds a 400K window and approaches half of 1M, with no graceful degradation (provider 400 / silent truncation at the API). `read_code_file` returns whole files unbounded (`registry.ts:136-143`); only the loop feedback cap contains it.
- So the architecture simultaneously starves cross-turn memory (~1K tokens) and permits within-turn blowups (~100–400K tokens) — the exact inverse of a budgeted memory hierarchy.

### 6.5 Other Area-3/Area-12 items
- **Images/screenshots:** never inlined (path/URL references only — `inspectionService.ts:272-279`; grep-verified no base64 into prompts). Zero token cost; also zero visual memory.
- **DOM dumps:** bounded text excerpts (dehydrated element index; bodyText ≤1,800; MCP snapshot ≤12,000 — `pageSession.ts:56-72`, `mcpDomFacts.ts:98`). Deep-run block census unchanged from the 07-10 forensics (§Part 3/6 there).
- **Reasoning tokens:** effort flags are passed (`reasoning_effort`/`reasoning.effort`) but reasoning/output token growth is not budgeted per-loop either.
- **No pre-flight token counting anywhere on the chat path** — no tiktoken/estimator invoked; `assemblePromptBudget` (the purpose-built, loss-aware, window-aware assembler — `promptBudget.ts:53`) has **zero callers**. Token counts are known only *after* each call from provider usage, for cost tracking (`recordUsage`).
- **Repetition cost:** every question re-runs research (≤200-step loop, or a multi-facet fan-out reading 80 hits × 3,500 bytes — `deepResearch.ts:213-266`), and every new deep run re-logs-in and (graph path) re-discovers. This is the dominant latency/cost bottleneck in long sessions, and it is a *memory* defect, not a compute one.

---

## 7. Root Causes (ranked)

| # | Root cause | Mechanism | Evidence | Confidence |
|---|---|---|---|---|
| 1 | **Model never sees stored history** — client-snapshot architecture | DB transcript is UI-only; prompts built from client `history` ≤16 turns | `AgentConsole.tsx:1022-1078,1521,1829`; no DB→prompt read path (3 independent traces) | 100% |
| 2 | **Default path compresses memory to ~1K tokens** | `ACTION_RE` routes plain questions to `withConversationContext` slice(-6)@700 | `controller/routes.ts:9,14-27` (re-verified) | 100% |
| 3 | **No summarization/compaction bridges the cut** | Older turns hard-dropped; nothing condenses them | Exhaustive negative sweep (§4.1) | 100% |
| 4 | **Tool outputs & structured turns never replayed** | Loop seeded with one synthetic user message; text-only persistence | `orchestrator.ts:400`; `chat/routes.ts:111-116` | 100% |
| 5 | **Lossy work-turn serialization inside the window** | Runs→1 line; cases→titles; reviews→600c | `AgentConsole.tsx:1056-1071` | 100% |
| 6 | **No conversation-scoped state ledger** (objective/plan/decisions) | Only `WorkflowState`, keyed runId; chat stateless; `controllerMemory` global/20 | `runtime.ts:373-376`; `controller.ts:41-49` | 100% |
| 7 | **Chat→run bridge keeps one assistant turn** | `deriveUnderstandingFromChat` last-6 → longest | `goalContext.ts:75-81` | 100% |
| 8 | **Scope switch forks the conversation** | remount on `scopeKey` change → different conversation | `AgentConsole.tsx:456-460,547-549` | 100% |
| 9 | **No retrieval over history** (semantic or lexical) | Nothing searches older turns | §4.1 | 100% |
| 10 | **Token budgeting absent; the built budgeter unwired** | Fixed caps calibrated to nothing; 0.1–1.5% window use | `promptBudget.ts` zero importers | 100% |
| 11 | **Graph path regresses cross-run reuse** | `priorEvidenceRun`/caches don't run under `AGENT_GRAPH_V2` | `routes.ts:5225` early return; `nodes/discovery.ts:201-242` | 95% |
| 12 | **Per-run auth/browser state** ⇒ relogin churn | caches keyed runId, TTL 15m | `authSession.ts:19-33`; `routes.ts:1218-1223` | 100% |
| 13 | **Learning loop severed** — `recordRunMemory` unwired | episodic store never written in prod | grep: no production callers | 95% |
| 14 | **Conversation ID absent from answer paths** | `workspaceId:'default'`, no conversationId on supervise | `AgentConsole.tsx:1520` | 100% |

Secondary/adjacent (not continuity causes, worth tracking): within-turn explosion (§6.4); guardrail 8K analysis gap (§5.3); `controllerMemory` cross-user bleed; unbounded `turns` JSONB with full-array rewrites; checkpoints without TTL; `.testflow-traces.jsonl` tracer still unverified (07-10 Finding D).

---

## 8. Missing Components — and how ChatGPT solves each (Area 13)

| Capability | ChatGPT (public behavior/APIs) | This codebase |
|---|---|---|
| Conversation reconstruction | Server-side authoritative thread store; every request rebuilds context from it | Client-sent snapshot; DB transcript never read into prompts |
| Window management | Fill the window (~128K–200K effective), then trim oldest / compact | Fixed 6/16-turn caps at ≤1.5% utilization |
| Compression | Rolling summarization/compaction of older spans (also exposed in Agents SDK as session compaction; Claude Code auto-compact is the same pattern) | None |
| Long-term memory | Persistent user memories + "reference chat history" retrieval across conversations | None (episodic store exists, write-orphaned) |
| Tool orchestration | Tool calls & outputs are part of thread state; later turns reference them | Discarded at turn end; loop reseeded from scratch |
| Structured multi-turn replay | Native role-typed messages incl. assistant/tool turns (`previous_response_id` / conversation objects in the Responses API) | One synthetic user message with flattened text |
| Retrieval | File search / embeddings over uploads and memory | None (lexical repo grep only, recomputed per turn) |
| State management | Hidden orchestration keeps plan/goal continuity within a thread | No conversation-scoped ledger |
| Token accounting | Window-aware assembly server-side | None on live paths; budgeter built but unwired |

**Missing components, concretely:** (1) server-side history reconstruction keyed by conversationId; (2) token-budgeted context assembly (wire `promptBudget.ts`); (3) rolling conversation summary persisted with the conversation; (4) structured message replay into `runToolLoop`; (5) durable conversation state ledger (decisions/objective/artifact index); (6) conversation-scoped tool-result/artifact reuse (chat) and restoration of prior-run seeding under the graph; (7) history retrieval tool (lexical first); (8) memory write path (`recordRunMemory`) + cross-run store; (9) conversation/checkpoint retention policies; (10) loop token budgets (`maxTotalTokens`).

**Why this is encouraging:** items 1–8 all have existing foundations in-tree — the store (`chat_conversations`), the budgeter (`promptBudget.ts`), the estimator (`estimateTokens`), the checkpointer, `agent_runs` evidence, blackboard, `runMemory`, and a bounded research graph (`sourceResearchGraph.ts`, also currently unwired). This is a wiring program, not a rebuild.

---

## 9. Architectural Weaknesses

1. **Split-brain conversation ownership.** The client owns what the model remembers; the server owns what the user sees. They diverge by design (`buildHistory` vs `turns`), so "the app shows the whole chat, the agent forgets it" is guaranteed UX dissonance.
2. **Memory inversely proportional to intelligence path.** The *default* Q&A path gets 6×700; the heavyweight action path gets 16 turns. The path users talk to most remembers least.
3. **Three overlapping engines** (legacy procedural pipeline; `server/agent-runtime` strangler-fig router; LangGraph workflow) each with their own history caps and no shared memory substrate — continuity fixes must currently be made 3×.
4. **Dead infrastructure:** `assemblePromptBudget` (0 callers), `sourceResearchGraph` (not wired), `knowledgeGraph.ts` (no callers), `appendWorkflowEvents` reducer (unused), `recordRunMemory` (write-orphaned), `getGraphRunState` (no callers), `getFeatureGrounding` (no-op). Each was built to solve part of this problem.
5. **SDK usage (Area 7):** no OpenAI Agents SDK / Assistants; Chat Completions with hand-rolled loop (fine, but forgoes `previous_response_id`/conversation state); the one Responses-API path is deliberately `store:false` single-shot; Anthropic path uses no context-management/memory betas; CLI provider emulates tools via prompting. Nothing is *incorrect*; the gap is that no provider-side or SDK-side conversation-state capability is used anywhere, so all continuity burden falls on the (absent) app layer. The Vercel `ai` dependency lingers only inside the Gemini adapter.
6. **Scale hazards:** module-global mutable state (`controllerMemory`, caches, `artifactStash`) assumes a single process — horizontal scaling would fork memories; unbounded JSONB rewrites per turn; checkpoints and conversations never pruned; SSE 4KB pad per event.
7. **Provenance-free context** (deep runs): static-scan vs live-verified selectors still indistinguishable downstream (07-10 Findings A/E) — unchanged.

---

## 10. Recommended Improvements (each: why · files · functions · impact · risks · savings)

> Analysis-only proposals. No code has been changed. Per-phase detail sufficient for approval; a fresh implementation plan per phase will precede any code.

### R1 — Server-side conversation reconstruction (kill the client-snapshot architecture)
- **Why:** Root causes #1, #2, #14. The authoritative transcript exists; use it.
- **Files:** `src/pages/AgentConsole.tsx` (send `conversationId` on all three POSTs; keep `history` as fallback), `server/features/controller/routes.ts`, `server/features/chat/routes.ts`, `server/ai/supervisor.ts`, `server/db/repository.ts` (add `ChatConversations.get` read on the answer paths).
- **Functions:** `send()/runViaSupervisor()`; `withConversationContext()`; `runSupervisor()` task assembly; new `loadConversationForModel(conversationId, budgetTokens)`.
- **Impact:** the model sees the real conversation, server-controlled; window raised from 6/16 turns to budgeted thousands.
- **Risks:** low-medium — request-shape change; fallback to client history preserves back-compat; per-endpoint rollout.
- **Token cost:** +5–30K input tokens/request typical (still <5% window); prompt-cache-friendly if history is a stable prefix.
- **Memory/scalability:** removes client as memory owner; enables multi-device continuity.

### R2 — Wire `assemblePromptBudget` into history/context assembly
- **Why:** Root cause #10; replaces blind char caps with window-aware, loss-recorded inclusion.
- **Files:** `server/ai/openai/promptBudget.ts` (move/rename to provider-neutral `server/ai/contextBudget.ts` — it is already pure), `supervisor.ts`, `controller/routes.ts`, `controller.ts`, `agent-runtime/context/goalContext.ts`.
- **Functions:** `assemblePromptBudget()` consuming candidates: mission > pinned decisions > recent turns > summary > tool digests; log excluded-entry reasons.
- **Impact:** every truncation becomes observable ("why wasn't X in the prompt" answerable); caps scale with model.
- **Risks:** low — additive; deterministic; already unit-shaped for tests.
- **Token savings:** net *savings* on action path (tool schemas can be budgeted too); bounded growth elsewhere.

### R3 — Rolling conversation summary (compaction, ChatGPT-style)
- **Why:** Root cause #3; bounded prompts need a bridge to unbounded transcripts.
- **Files:** new `server/ai/memory/conversationSummary.ts`; `chat_conversations` gains `summary` + `summary_turn_index` (schema + `repository.ts`); update hooks in `chat/routes.ts` / turn-persist path; injection in `supervisor.ts`/`controller/routes.ts`.
- **Functions:** `updateConversationSummary(conversationId)` — cheap model, fires when un-summarized span exceeds N turns/tokens; assembly injects `CONVERSATION SUMMARY (older context)` + recent verbatim turns.
- **Impact:** decisions from turn 1 survive turn 100 at ~500-token cost.
- **Risks:** medium — summary drift/staleness; mitigate: append-only summaries, keep last K turns verbatim, regenerate on divergence; extra model calls (cheap tier).
- **Token cost:** ~+300–800 input/request; one small summarize call per few turns.

### R4 — Structured replay into the tool loop
- **Why:** Root cause #4 (partly), #5; speaker attribution and instruction-following degrade in flattened blocks.
- **Files:** `server/ai/orchestrator.ts` (`runToolLoop` accepts optional `seedMessages: ChatMessage[]`), `supervisor.ts` callers.
- **Impact:** provider-native multi-turn; enables provider prompt caching of stable history prefix; removes "RECENT CONVERSATION" pseudo-format.
- **Risks:** medium — touches the shared loop substrate; gate per-caller; verify all 4 providers map roles correctly (CLI provider keeps flattened fallback).
- **Token cost:** neutral; cache hit-rate improves.

### R5 — Conversation state ledger (decisions/objective/artifacts)
- **Why:** Root causes #6, #7; repeats-work symptom.
- **Files:** new `server/features/chat/conversationState.ts`; schema table `conversation_state` (or JSONB column); `chat/routes.ts` end-of-turn extraction; assembly injection; `goalContext.ts` (`resolveUnderstanding` prefers ledger over longest-turn heuristic).
- **Functions:** `appendConversationFacts()` (cheap extraction: decisions, constraints, artifacts produced with run ids, open questions); `renderStateBlock()` (~≤1,500 tokens, pinned above history).
- **Impact:** decisions/deliverables survive any window; deep runs inherit *decisions*, not the longest paragraph.
- **Risks:** medium — extraction quality; keep entries as quoted user/assistant lines with turn refs to avoid hallucinated "facts."
- **Memory improvement:** this is the direct fix for "loses decisions."

### R6 — Tool-result & evidence reuse
- **Why:** Root cause #4, #11, #12; the repeats-work cost center.
- **Files:** `chat/routes.ts` (persist compact tool-result digests per turn — name, args, ≤1K digest, artifact refs); optional `search_prior_results` tool in `ai/tools/registry.ts`; restore prior-run seeding under the graph (`workflow/nodes/discovery.ts` consult `agent_runs` evidence for same conversation+scope; or port `priorEvidenceRun` into `beginGraphRunFor`); conversation-scoped auth-state key option (`authSession.ts`).
- **Impact:** later turns cite earlier findings instead of re-deriving; graph path stops regressing legacy reuse; fewer logins (rate-limit incidents like 07-10 Finding F recede).
- **Risks:** medium — staleness of reused evidence; mitigate with the existing scope-match (`sameMissionEvidenceScope`) + TTL; digests must exclude secrets (reuse `events.ts` redaction discipline).
- **Token/cost savings:** largest of all — eliminates most repeated 200-step explorations/re-inspections.

### R7 — History retrieval tool (lexical first)
- **Why:** Root cause #9; summary + window can't hold everything; retrieval closes the tail.
- **Files:** `ai/tools/registry.ts` (new `search_conversation` tool: substring/keyword over `chat_conversations.turns` + state ledger), wired into both chat tool lists.
- **Impact:** "as we discussed earlier…" becomes answerable at any depth; no vector infra needed (embeddings optional later behind the same tool interface).
- **Risks:** low.

### R8 — Hygiene & guardrails batch
- `maxTotalTokens` on chat loops (kills §6.4 explosion); analyze full task in guardrails or mark truncated-analysis; scope `controllerMemory` per conversation or delete post-R1; wire `recordRunMemory` at execution/investigation outcomes (aligns with the approved bug-investigation plan); retention: checkpoint TTL + conversation compaction; remove/absorb dead code (`knowledgeGraph`, unused reducer) — **Files:** `orchestrator.ts`, `guardrails.ts`, `controller.ts`, `workflow/runtime.ts` or `nodes/execution.ts`, `checkpointer.ts`, migrations. **Risk:** low, itemized.

---

## 11. Priority Ranking

| Priority | Item | Rationale |
|---|---|---|
| P0 | R1 + R2 (reconstruction + budgeter) | Removes causes #1/#2/#10/#14 in one stroke; everything else builds on it |
| P0 | R8a (`maxTotalTokens`) | One-line-per-caller; closes the only real window-exhaustion risk |
| P1 | R3 (rolling summary) | The ChatGPT-parity feature; needs R1's server-side assembly |
| P1 | R5 (state ledger) | Direct fix for "loses decisions" + chat→run handoff |
| P2 | R6 (tool/evidence reuse) | Biggest cost/latency win; fixes "repeats work" |
| P2 | R4 (structured replay) | Quality + cache efficiency; riskier (shared substrate) |
| P3 | R7 (retrieval tool) | Completes the memory hierarchy |
| P3 | R8b-f (hygiene) | Correctness/scale debt |

## 12. Risk Assessment

**Of the current state (doing nothing):** guaranteed continuity failure past 3–8 exchanges (deterministic, not probabilistic); compounding compute cost from per-turn recomputation (200-step loops, re-inspections, re-logins — the 07-10 auth-rate-limit incident is one downstream effect); cross-user bleed via global `controllerMemory` (privacy-adjacent); unbounded `turns`/checkpoint growth; a single long tool-loop turn can hard-fail on window overflow with no graceful degradation; guardrail analysis blind past 8K chars.

**Of the proposed changes:** R1/R2 low-medium (additive, fallback preserved, per-endpoint rollout); R3/R5 medium (LLM-generated summaries/facts can drift — mitigations specified); R4 medium (shared loop substrate — needs per-provider verification, CLI fallback); R6 medium (stale-evidence reuse — scope-match + TTL already exist to govern it); R7/R8 low. Nothing proposed touches the deep-run generation contracts, evidence gating, or Playwright-verification invariants; all changes are upstream context plumbing. Rollback per phase = flag-off/revert; no data migrations are destructive (new columns/tables only).

## 13. Production Readiness Score

| Area | Score /10 | Basis |
|---|---|---|
| Conversation Management | **3** | Durable store exists and UI lifecycle is solid, but the model never reads it; ID never reaches answer paths; scope forks |
| Memory Architecture | **2** | No summarization/retrieval/long-term memory; episodic store write-orphaned; global ring buffer mis-scoped |
| State Management | **5** | LangGraph per-run state is genuinely well-designed (refs-only, bounded reducers, fail-closed durability); nothing at conversation scope |
| Token Efficiency | **2** | ≤1.5% window used while forgetting; schemas outweigh memory 3–4×; budgeter unwired; within-turn unbounded |
| Prompt Design | **4** | Clean static system prompts + injection defense; but flat-string history, silent cuts, JSON-in-prose (deep runs) |
| SDK Usage | **4** | Solid multi-provider abstraction and native tool loop; zero use of any conversation-state/caching/compaction capability; dead `ai` dep remnant |
| Persistence | **5** | Postgres+JSONB durable and recoverable; unbounded growth, write amplification, no retention |
| Retrieval | **3** | Good deterministic repo research — recomputed every turn; nothing over conversation history |
| Scalability | **3** | Module-global state, RAM stashes, single-process assumptions |
| Maintainability | **4** | Three engines × per-path history logic; substantial dead code; 5,000+-line routes.ts |
| **Overall (long-conversation continuity)** | **3.2 / 10** | Excellent per-run engineering; conversation-scope memory effectively absent |

## 14. Action Plan (phase checklist — CLAUDE.md format; each phase ≤ 10–15 files)

- [ ] **Phase 1 — Server-side history + budget (P0).** Files: `AgentConsole.tsx`, `controller/routes.ts`, `chat/routes.ts`, `supervisor.ts`, `repository.ts`, `contextBudget.ts` (moved `promptBudget.ts`), `orchestrator.ts` (maxTotalTokens), `guardrails.ts` (analysis note). ~8 files. **Risk: Low-Med.** Verify: long-thread eval — decision at turn 2 recalled at turn 30; token logs show budgeted assembly.
- [ ] **Phase 2 — Rolling summary + state ledger (P1).** Files: `conversationSummary.ts` (new), `conversationState.ts` (new), `schema.sql` + `repository.ts`, `chat/routes.ts`, `supervisor.ts`, `controller/routes.ts`, `goalContext.ts`. ~7 files. **Risk: Med.** Verify: 100-turn synthetic conversation retains objective/decisions; chat→deep-run handoff carries ledger not longest-turn.
- [ ] **Phase 3 — Evidence & tool-result reuse (P2).** Files: `chat/routes.ts`, `registry.ts` (tools), `nodes/discovery.ts` or `routes.ts` graph-begin seeding, `authSession.ts`. ~5 files. **Risk: Med.** Verify: second run in a conversation skips rediscovery (log proof); repeated question answered from prior digest without a new 200-step loop.
- [ ] **Phase 4 — Structured replay + retrieval tool (P2/P3).** Files: `orchestrator.ts`, `supervisor.ts`, `registry.ts`. ~3 files. **Risk: Med** (loop substrate). Verify: provider-native multi-turn on all 4 providers; cache-read tokens rise on OpenAI/Anthropic.
- [ ] **Phase 5 — Hygiene (P3).** `controllerMemory` scoping/removal, `recordRunMemory` wiring, retention TTLs, dead-code removal. ~6 files. **Risk: Low.** Verify: lint/tests; restart-survival checks.

Each phase: `npm run lint` → targeted tests → backend restart → live verification against the running console (per CLAUDE.md), with a per-phase report before proceeding.

---

### Appendix A — Investigation-area → section map
1 Conversation Lifecycle→§3 · 2 Context Construction→§5 · 3 Token Budget→§6 · 4 Summarization→§4.1 · 5 Persistent Memory→§4 · 6 Tool Output Handling→§4.2, §6.5 · 7 SDK→§9.5, §8 · 8 Runtime State→§4.2-4.3 · 9 Retrieval→§4.1, §8 · 10 Prompt Engineering→§5.3 · 11 Storage→§3.2, §2 · 12 Bottlenecks→§6.4-6.5, §9.6 · 13 ChatGPT comparison→§8 · 14 Scores→§13.

### Appendix B — Key numeric constants (single reference table)
| Cap | Value | Where |
|---|---|---|
| Client history window / assistant chars | 16 turns / 2,400 | `AgentConsole.tsx:1077,1025` |
| Default question path | 6 turns / 700 chars | `controller/routes.ts:17,20` |
| Supervisor history | 16 turns / uncapped | `supervisor.ts:538` |
| Router / classify-explain | 12 @600 / 16 @1200 | `router.ts:352-355`; `controller.ts:115-116` |
| Deep-run history / goal context | 16 @1200 / 12 @2400-600 | `agent/routes.ts:4515`; `goalContext.ts:106-107` |
| Understanding bridge | last 6 assistant → longest 1 | `goalContext.ts:75-81` |
| Tool-result loop cap | 8,000 chars | `orchestrator.ts:597` |
| maxSteps | 60 supervisor / 200 explorer / 12 default | `supervisor.ts:553,388`; `orchestrator.ts:397` |
| maxTotalTokens (chat) | never set (dead code) | `orchestrator.ts:409` |
| controllerMemory | 20 global entries | `controller.ts:42` |
| Guardrail analyzed input | 8,000 chars (analysis copy only) | `guardrails.ts:68` |
| Model windows | 400K–1.05M tokens | `providers/types.ts:243-288` |
| Graph understanding carryover | 6,000 chars | `nodes/authoring.ts:352-354` |
| runMemory | 5,000 records / retrieve 20 / 2,000-char summary | `runMemory.ts:23-29` |
| Blackboard | 100 global entries / list 50 | `blackboard.ts:29,46` |
| Auth/page/inspect caches | 15m / 10m / 15m TTL | `authSession.ts:19`; `pageSession.ts:44`; `agent/routes.ts:1214` |
