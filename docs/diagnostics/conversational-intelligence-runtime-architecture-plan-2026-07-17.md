# Conversational Intelligence Runtime — Enterprise Architecture and Implementation Plan

**Date:** 2026-07-17  
**Status:** Phase 0 — analysis and design only  
**Implementation status:** Not approved; no production code changed  
**Scope:** TestFlow AI conversational intelligence layer  
**Decision gate:** Implementation may begin only after explicit approval on a later turn, one roadmap phase at a time.

---

## 1. Executive Summary

The reported answer failure is confirmed, but it is not the architecture to preserve and patch.
The current platform has a capable per-request LLM/tool loop and a capable per-run LangGraph
workflow, but it has no first-class conversational runtime connecting them. Conversation,
workspace, execution, artifacts, and repository knowledge are separate data islands. The current
router classifies the latest text into a broad route, and every pure question is forced to
answer. The controller then reclassifies answer by action-word regex and sends non-actions to
an application-code-only explorer. That path cannot read conversation-linked AgentRun outcomes.

The failure is therefore deterministic:

~~~text
"Why did the test cases fail?"
  -> goal route: answer
  -> controller: non-action
  -> application-code explorer
  -> code-only evidence contract
  -> no AgentRun result capability
  -> source-code answer or "no failure output"
~~~

The target architecture makes the platform stateful and the LLM stateless:

1. A Session Context Manager owns a durable, versioned engineering-session snapshot.
2. An Entity Resolver binds explicit and implicit references to concrete scoped entities before
   routing.
3. A deterministic Capability Router selects a capability from the request, resolved entities,
   session state, workspace state, and latest execution.
4. A capability-specific Evidence Aggregator retrieves and normalizes platform evidence. Raw
   infrastructure tools are not exposed to the answering model.
5. A priority-aware Context Assembly Engine gives observed runtime evidence precedence over
   artifacts, knowledge, and source analysis without increasing the current model context limit.
6. A deterministic Capability Planner describes the permitted steps, evidence requirements, and
   action boundaries.
7. Existing provider adapters receive a provider-neutral PreparedInvocation. Business routing,
   resolution, evidence policy, and planning do not vary by provider.
8. Every resolution, route, evidence item, omission, plan step, and state transition is recorded
   for explainability and audit.

This is a strangler migration, not a replacement of TestFlow AI. It retains:

- Vite and Express;
- the current OpenAI, Anthropic, Gemini, and CLI/local provider abstraction;
- the current AgentRun and QA artifact records;
- LangGraph per-run workflow state and checkpointing;
- conversation reconstruction, context budgeting, summary segments, artifact digests, and tool
  result retention already implemented;
- current public routes until the UI has migrated.

It replaces the fragmented decision path and dual conversational authority with a single
conversation-turn runtime. It does not add prompt hacks, isolated failure regexes, a larger
context window, or an LLM-based pronoun guesser.

### Architectural decisions

| Decision | Outcome |
|---|---|
| System of record for ordered conversation | Append-only chat_messages; chat_conversations.turns becomes migration-only compatibility storage |
| Working-state system of record | Versioned conversation_sessions snapshot plus append-only conversation_session_events |
| Rich generated outputs | Structured chat message payload plus durable domain/artifact references; large bodies remain content-addressed |
| Reference resolution | Deterministic candidate generation and lexicographic ranking; unresolved ambiguity returns clarification |
| Routing | Pure capability decision over request facts, resolved entities, state, and capability preconditions |
| Evidence | Capability-specific providers behind EvidenceAggregator; observed evidence outranks inferred evidence |
| LLM role | Synthesis and bounded reasoning over a prepared plan/context; never state authority or reference authority |
| Concurrency | Conversation-scoped transaction, optimistic version, idempotency key, and row/advisory lock |
| Scale | Stateless API nodes over PostgreSQL; local JSON/in-memory mode remains a single-process development adapter |
| Provider portability | Existing AIProvider boundary remains; no business rule enters provider adapters |

---

## 2. Existing Architecture

### 2.1 Verified current component view

~~~mermaid
flowchart TD
    UI[AgentConsole React turns] -->|PUT rich snapshot| CC[(chat_conversations.turns)]
    UI -->|POST message + client history| GR[/api/agent/goal]
    GR --> GLLM[Goal Router LLM]
    GLLM --> DR[Pure decideRoute]
    DR -->|all pure questions| ANSWER[answer]
    ANSWER --> STREAM[/api/controller/supervise/stream]
    STREAM --> AR{ACTION_RE}
    AR -->|non-action| CODE[answerAppQuestionFromCode]
    AR -->|action| SUP[runSupervisor]

    CODE --> CA[Conversation Context Assembler]
    CA --> MSG[(chat_messages)]
    CA --> SUM[(chat_summary_segments)]
    CA --> LEDGER[Shallow AgentRun ledger]
    CODE --> CTOOLS[conversation artifact + repository tools]

    SUP --> WTOOLS[workspace, source, domain action tools]
    UI -->|deep generation/run| RUN[Legacy or LangGraph Agent Workflow]
    RUN --> AG[(agent_runs)]
    RUN --> QA[(cases/scripts/runs/reports/defects)]
    RUN --> EV[files: screenshots/traces/logs]

    AG -. not available to code answer .-> CODE
~~~

### 2.2 Existing responsibilities

| Component | Current responsibility | Architectural issue |
|---|---|---|
| AgentConsole.buildHistory | Converts rich UI turns to at most 60 text turns | Cases become IDs/titles; deep runs become one sentence; rich payload is lost to routing |
| /api/agent/goal | Unified initial dispatch | Request body drops conversationId; uses client history rather than authoritative session |
| goal router | LLM proposal plus pure safety decision | Taxonomy has no diagnostic/review capabilities; all questions become answer |
| controller routes | Re-decides answer vs action | ACTION_RE is a second router and sends every non-action to code exploration |
| answerAppQuestionFromCode | Application repository analysis | Its contract explicitly prioritizes only source code; no execution evidence provider |
| runSupervisor | General action tool loop | Exposes a broad mixed tool set and makes the model select infrastructure tools |
| contextAssembler | Reconstructs stored conversation and applies token budget | Rich turns normalize only content/text/summary; ledger is shallow; session/entities/evidence absent |
| conversationState | Renders AgentRun/case/script/defect lines | Lists IDs/titles but not execution outcomes, selected entities, decisions, or active state |
| conversationSummary | Extractive old-turn segments | Reads chat_messages while primary reconstruction may prefer turns snapshot |
| artifactMemory | Stores bounded tool-result bodies/digests | Does not represent every generated output or active entity; lexical retrieval is not reference binding |
| AgentRuns | Persists full deep-run envelope | conversationId and execution_result are inside raw rather than first-class indexed columns |
| workflow state | Strong run-scoped state | thread_id equals runId; state does not survive as conversation working state |
| provider adapters | Common text/object/tool interface | This boundary is sound and should remain free of business logic |

### 2.3 What already works and must not be rebuilt

- Server-side conversation reconstruction exists.
- Token-aware context budgeting exists.
- Context manifests exist.
- Recent turns and extractive summary segments exist.
- Conversation activity ledger injection exists.
- Tool-result artifact storage, redaction, and freshness checks exist.
- Conversation search and artifact fetch tools exist.
- Tool loops have step and total-token backstops.
- AgentRun persists generated cases, scripts, execution_result, screenshots, and raw run state.
- Playwright execution captures per-test result, error, screenshot, trace, console, network, and step
  log paths.
- LangGraph state is typed, checkpointed, and contains bounded references rather than heavy data.
- Provider-native and CLI/local adapters share an AIProvider contract.

These are foundations. The target runtime composes them behind new domain boundaries.

---

## 3. Existing Dependency Graph

~~~mermaid
graph LR
    AgentConsole --> AgentRuntimeRoutes
    AgentRuntimeRoutes --> GoalRouter
    GoalRouter --> Orchestrator
    AgentRuntimeRoutes --> Controller
    AgentConsole --> ControllerRoutes
    ControllerRoutes --> Supervisor
    ControllerRoutes --> ContextAssembler
    Supervisor --> ContextAssembler
    ContextAssembler --> ConversationState
    ContextAssembler --> ConversationSummary
    ContextAssembler --> ContextBudget
    ConversationState --> Repository
    ConversationSummary --> Repository
    Supervisor --> ToolRegistry
    ToolRegistry --> Repository
    ToolRegistry --> GitAgent
    Orchestrator --> Providers
    Orchestrator --> ArtifactMemory
    AgentRoutes --> AgentRuns
    WorkflowRuntime --> AgentRuns
    WorkflowRuntime --> WorkflowState
    WorkflowState --> LangGraph
~~~

Current dependency problems:

1. Routing exists in AgentConsole dispatch, AgentRuntime route logic, decideRoute, and ACTION_RE.
2. Conversation context is assembled after initial route selection, so the router cannot use the
   authoritative conversation.
3. AgentRun data is queried by full collection scans and filtered in application code.
4. The code explorer owns both evidence retrieval and reasoning, making source-code policy inseparable
   from generic answers.
5. Infrastructure tools and capability intent tools share one supervisor tool list.
6. The conversation and run aggregates have no durable relationship projector.
7. Rich message payloads have two writers and two transcript shapes.

---

## 4. Current Runtime Flow

### 4.1 Failing question flow

1. AgentConsole appends the user turn to React state.
2. buildHistory serializes up to 60 turns, clipping assistant content to 4,000 characters and
   collapsing rich outputs.
3. The browser posts message, conversationId, history, apps, and page context to /api/agent/goal.
4. GoalRequestBody does not declare conversationId and the route does not forward it.
5. buildRouterPrompt uses only the final 12 client turns, each clipped to 600 characters.
6. decideRoute forces any pure question to answer.
7. AgentConsole dispatches answer to /api/controller/supervise/stream.
8. quickWorkspaceAnswer handles only simple counts/lists.
9. ACTION_RE does not match the diagnostic question.
10. answerAppQuestionFromCode is invoked with the code explorer system contract.
11. assembleConversationContext supplies recent messages, summary segments, and the shallow ledger.
12. Available tools are search_conversation, fetch_artifact, search_codebase, read_code_file, and
    follow_imports.
13. No execution result is loaded. The LLM obeys the code-only contract.
14. The answer is persisted as plain text in chat_messages while the UI independently PUTs its rich
    turns snapshot.

### 4.2 Deep-run flow

1. Goal routing selects generate_cases or deep_test_run.
2. The frontend invokes /api/agent/start and supplies conversationId.
3. The legacy pipeline or LangGraph workflow resolves mission, context, evidence, cases, scripts,
   and execution.
4. Full run data is projected into AgentRun and related QA tables.
5. The run UI can retrieve /api/agent-runs/:id/details.
6. No durable conversation-session projector makes that run the conversation's current execution,
   active artifact set, or failure collection.

### 4.3 Planner/reasoner reality

The current answering path has no durable planner. runToolLoop lets the provider perform transient
planning within one request. Tool-call messages remain in that request only. The next question
reconstructs text and digests, not a persistent engineering plan, resolved entity set, or current
goal state.

---

## 5. Current Evidence Flow

### 5.1 Evidence that exists

| Evidence class | Current store |
|---|---|
| Run aggregate | agent_runs.raw.execution_result and workflow projection |
| Per-test verdict/error/duration | execution_result.tests |
| Generated cases | agent_runs.generated_cases and cases |
| Generated scripts | agent_runs.playwright_scripts and scripts |
| Screenshots | evidence_screenshots and evidence file paths |
| Step screenshots | per-test paths and published evidence URLs |
| Trace | Playwright tracePath |
| Console/network/step logs | per-test evidence paths |
| Defects | defects with sourceRunId and linked case/run |
| Reports | reports |
| Source code | scoped repository services |
| Knowledge | knowledge service and graphs |
| Prior tool evidence | conversation_artifacts plus artifact_blobs |

### 5.2 Where evidence disconnects

The run details endpoint and run UI can read execution results, but the generic answer capability
cannot. get_run exists only in the workflow agent tool set and reads the first-class Runs record,
not the complete conversation-linked AgentRun envelope. query_workspace returns compact metadata,
not execution evidence. The shallow ledger is insufficient to bridge this gap.

### 5.3 Evidence quality defects

- Runtime, source, knowledge, and historical observations have no common evidence contract.
- There is no explicit observed/inferred precedence in generic answering.
- Evidence file paths are local-disk references, which are not safe for multi-instance deployment.
- Evidence retrieval is not scoped by a resolved capability and entity set.
- Context manifests record included text candidates but not route decision, bindings, evidence
  provenance, contradictions, or freshness.
- AgentRuns.list loads all rows and filters conversation scope in memory.

---

## 6. Current Context Flow

assembleConversationContext currently builds:

1. current message;
2. one ledger string candidate;
3. summary segment candidates;
4. recent normalized text turns.

The current message receives the highest priority, followed by the ledger, summaries, and turns.
This is useful but incomplete. It does not include a session snapshot, resolved entities, execution
evidence, current workspace selection, recent decisions, capability, or plan.

Important correctness issues:

- normalize ignores rich turn payloads unless they also have content, text, or summary.
- chat_conversations.turns and chat_messages are competing authorities.
- ChatConversations.get returns whichever representation has more entries, not a merged,
  sequence-correct transcript.
- summary compaction always reads chat_messages, so its sequence can diverge from the transcript
  selected by ChatConversations.get.
- the ledger is one indivisible budget candidate. As it grows, the entire ledger can be excluded
  rather than selecting recent relevant records.
- ledger runs are rendered oldest first, while reference resolution requires active/latest first.

---

## 7. Current Prompt and Provider Flow

For API-key providers, the code-answer path sends:

~~~text
system:
  ADAPTIVE_CODE_EXPLORER_SYSTEM
  source-code-only behavior contract

messages:
  budgeted recent user/assistant turns

current task:
  shallow ledger + summary segments
  "Answer this question about THIS application,
   grounded ONLY in its REAL source code"
  user question

tools:
  conversation search, artifact fetch, repository search/read/import traversal
~~~

CLI/account providers receive an equivalent flattened prompt. Provider mapping differs, but the
business defect is upstream and provider-independent.

The target design must preserve this provider neutrality while changing the business input from
an untyped question plus broad tools to a PreparedInvocation:

~~~text
capability + resolved entities + evidence bundle + session snapshot
+ context manifest + permitted plan
-> provider-neutral messages/instructions
-> provider adapter
~~~

No provider receives authority to mutate session state or choose an evidence source outside the
capability plan.

---

## 8. Current Problems

| ID | Problem | Severity | Confirmed basis |
|---|---|---:|---|
| P1 | Pure questions collapse into one answer route | Critical | RouteKind and decideRoute |
| P2 | Non-action answer is re-routed to code-only explorer | Critical | Controller ACTION_RE path |
| P3 | Generic answer cannot retrieve conversation-linked AgentRun outcomes | Critical | Code explorer tool list |
| P4 | No conversation-wide structured working state | Critical | No session aggregate outside run state |
| P5 | No deterministic reference resolution | Critical | Regex/prompt/lexical search only |
| P6 | Rich outputs collapse to text/titles | High | buildHistory and context normalizer |
| P7 | Transcript has two competing authorities | High | turns snapshot and chat_messages |
| P8 | Router does not receive authoritative conversationId/session | High | GoalRequestBody and routeGoal input |
| P9 | Evidence classes have no shared provenance/priority contract | High | Ad hoc tool results and prompt blocks |
| P10 | Capability and infrastructure tool concerns are mixed | High | General supervisor tool list |
| P11 | Conversation/run relationship is not projected into active state | High | AgentRun completion paths |
| P12 | Session reads cannot be safely concurrent across instances | High | No versioned session record |
| P13 | Conversation and run queries scan/filter too broadly | High at scale | AgentRuns.list and unscoped get patterns |
| P14 | Local evidence files are not multi-instance durable | High at scale | evidence directory paths |
| P15 | Explainability ends at text inclusion | Medium | Context manifest lacks route/resolution/evidence trace |
| P16 | Current page/app/module/branch are not one coherent state | High | UI state, request fields, and run mission separated |

---

## 9. Root Cause Analysis

### 9.1 Primary root cause

TestFlow AI has two strong but disconnected state models:

- conversation text memory;
- run-scoped workflow state.

There is no conversation-scoped engineering-session aggregate between them. Routing therefore has
no durable active objects, and evidence retrieval begins only after a coarse text classification.

### 9.2 Structural root causes

1. **Text-first control flow.** The latest utterance is classified before authoritative state and
   entity resolution are loaded.
2. **Route equals UI workflow.** RouteKind mixes interaction form with business capability.
   answer says nothing about whether the answer concerns a run, code, defect, API, or architecture.
3. **LLM/tool loop as application layer.** The model is asked to choose low-level retrieval tools
   instead of receiving capability-owned evidence.
4. **No conversational aggregate.** Current run, selection, goal, decisions, and artifacts do not
   have a single versioned owner.
5. **No entity graph.** Pronouns, plural collections, ordinals, and ellipsis cannot bind to the
   workspace graph deterministically.
6. **Persistence by representation.** The browser snapshot and server append stream both store
   conversation representations, rather than commands against one ordered message log.
7. **Execution outcome is opaque storage.** conversationId and execution_result are embedded in
   AgentRun raw JSON, making reliable indexed lookup harder than UI hydration.

### 9.3 Why prompt changes are rejected

A prompt saying "the scripts means the latest scripts" would still lack a deterministic run
binding, tenant-scoped query, ambiguity result, and audit trail. Adding run data to every prompt
would waste context and still conflate capabilities. Increasing context length would preserve more
text but would not connect "they" to an execution entity or make runtime evidence available.

---

## 10. Proposed Architecture

### 10.1 Component diagram

~~~mermaid
flowchart TD
    U[User / AgentConsole] --> API[Conversation Turn API]
    API --> SCM[Session Context Manager]
    SCM --> CS[(Conversation + Session Stores)]
    SCM --> WS[Workspace Snapshot Reader]
    SCM --> ER[Entity Resolver]
    ER --> EI[(Entity Reference Index)]
    SCM --> CR[Capability Router]
    CR --> CD[Capability Definitions]
    CR --> EA[Evidence Aggregator]

    EA --> RP[Run Diagnostics Provider]
    EA --> WP[Workspace Evidence Provider]
    EA --> DP[Defect/Report Provider]
    EA --> AP[API/Automation Provider]
    EA --> KP[Knowledge Provider]
    EA --> SP[Source Provider]

    RP --> AG[(AgentRun + Execution)]
    WP --> QA[(Plans/Suites/Cases/Scripts/Runs)]
    DP --> DEF[(Defects/Reports)]
    AP --> APISTORE[(API Runs/Automation)]
    KP --> KNOW[(Knowledge/Graphs)]
    SP --> REPO[Scoped Repository]

    EA --> EB[Evidence Bundle]
    EB --> CA[Context Assembly Engine]
    SCM --> CA
    ER --> CA
    CS --> CA
    CA --> CP[Capability Planner]
    CP --> PI[Prepared Invocation]
    PI --> LLM[Provider-neutral LLM Gateway]
    LLM --> OAI[OpenAI]
    LLM --> ANT[Anthropic]
    LLM --> GEM[Gemini]
    LLM --> LOC[CLI / Local Model]
    LLM --> SCM

    SCM --> TRACE[(Session Events + Context Manifests)]
~~~

### 10.2 Bounded contexts

| Bounded context | Owns | Does not own |
|---|---|---|
| Conversational Runtime | Session snapshot, entity bindings, capability decision, turn orchestration | QA domain records, run execution, provider SDKs |
| Conversation Memory | Ordered messages, summary segments, rich message payloads, artifact refs | Active session truth |
| Workspace | Projects, apps, plans, suites, cases, scripts, reports, defects | Conversation routing |
| Execution | AgentRun, Playwright outcome, evidence artifacts, run workflow | Pronoun resolution |
| Knowledge/Grounding | Repository, metadata, live DOM, knowledge graphs | Capability selection |
| LLM Gateway | Provider-neutral generation/tool protocol and usage | Domain policy, state, evidence priority |

### 10.3 Dependency direction

~~~mermaid
graph TD
    APIAdapter --> Application
    Application --> Domain
    Application --> Ports
    Infrastructure --> Ports
    Infrastructure --> ExistingServices
    Application --> LLMPort
    ProviderAdapters --> LLMPort
    Domain -. no dependency .-> ProviderAdapters
    Domain -. no dependency .-> Express
    Domain -. no dependency .-> PostgreSQL
~~~

The domain layer is pure TypeScript. It contains types, reference ranking, capability definitions,
and route decisions. Application services coordinate ports. Existing server modules initially
implement infrastructure ports and can be migrated later without changing business logic.

---

## 11. Session Context Model

### 11.1 Aggregate

SessionContext is a conversation-scoped aggregate, not prompt memory.

~~~typescript
interface SessionContext {
  schemaVersion: 1;
  conversationId: string;
  workspaceId: string;
  ownerId: string;
  projectId: string | null;

  currentApp: EntityRef | null;
  currentModule: EntityRef | null;
  currentPage: PageRef | null;
  currentObject: EntityRef | null;
  currentRecord: EntityRef | null;
  currentExecution: EntityRef | null;
  currentTestSuite: EntityRef | null;
  currentDefect: EntityRef | null;
  currentBranch: BranchRef | null;
  currentArtifactSet: ArtifactSetRef | null;

  currentGoal: GoalState | null;
  currentIntent: CapabilityIntent | null;
  currentSelectedEntity: EntityRef | null;

  latestRun: EntityRef | null;
  latestReview: EntityRef | null;
  latestScripts: EntityCollectionRef | null;
  latestTestCases: EntityCollectionRef | null;
  generatedOutputs: GeneratedOutputRef[];
  recentDecisions: DecisionRecord[];

  activeEntities: EntityRef[];
  version: number;
  updatedAt: string;
}
~~~

Current Conversation is represented by conversationId and the canonical ordered message log.
Current Workspace and Current Project are explicit scope fields. Current Artifact Set groups the
latest coherent outputs from one operation rather than treating unrelated recent records as one
collection.

### 11.2 Invariants

- ownerId, workspaceId, projectId, and conversationId are immutable scope authority.
- Entity references must either match the session scope or carry an explicit cross-scope approval.
- Only one currentSelectedEntity exists.
- latestRun must be the latest eligible run linked to this conversation and scope, not the latest
  global run.
- currentExecution can point to a running execution while latestRun remains the most recent terminal
  run; callers must choose the field required by capability.
- Generated output references are append-only history; latest pointers are projections.
- Decisions record source message/event and may be superseded, never silently overwritten.
- Every update increments version and appends an event.
- No secrets, raw screenshots, full source files, or large generated bodies are stored in the
  snapshot. It stores references and compact metadata.

### 11.3 State transitions

| Event | Projection |
|---|---|
| ConversationStarted | Initialize scope and empty pointers |
| ScopeSelected | Set project/app/page and clear incompatible lower-level selections |
| EntitySelected | Set selected entity and matching current pointer |
| GoalAccepted | Set currentGoal |
| CapabilityRouted | Set currentIntent and route trace |
| ArtifactGenerated | Append generated output; update artifact set/latest type pointer |
| RunStarted | Set currentExecution and active run |
| RunCompleted | Set latestRun, currentExecution, failure collection, evidence artifact set |
| ReviewCompleted | Set latestReview |
| DecisionRecorded | Append bounded recent decision |
| EntityInvalidated | Clear stale pointer and record reason |
| ConversationArchived | Freeze further commands except restore |

### 11.4 Session manager commands and queries

Commands:

- StartSession
- MergeRequestScope
- AppendMessage
- SelectEntity
- RecordGoal
- RecordDecision
- LinkGeneratedOutput
- ProjectRunLifecycle
- ClearStaleEntity
- ArchiveSession

Queries:

- GetSessionSnapshot
- GetActiveEntities
- GetRecentDecisions
- GetArtifactSet
- GetSessionAtVersion
- ReconcileSession

Commands use expectedVersion and idempotencyKey. Queries are side-effect free except explicit
ReconcileSession, which emits an audited correction event.

---

## 12. Conversation and Rich Output Model

### 12.1 Canonical message

~~~typescript
interface ConversationMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: "user" | "assistant";
  kind: MessageKind;
  content: string;
  payload: StructuredPayload;
  entityRefs: EntityRef[];
  artifactRefs: ArtifactRef[];
  correlationId: string;
  causationId?: string;
  createdAt: string;
}
~~~

The message payload preserves generated test cases, scripts, defects, reviews, plans, flows, APIs,
and documents as structured references and bounded display data. Full bodies use their existing
domain record or content-addressed artifact body. Titles are presentation data, not memory.

### 12.2 Authority and idempotency

- chat_messages becomes the only ordered transcript.
- The browser sends a clientMessageId; repeated network delivery returns the original result.
- Server-generated assistant messages are appended in the same conversation command flow.
- chat_conversations.turns remains read-only compatibility data until all legacy records are
  backfilled and verified.
- Summary segments compact only canonical message sequence numbers.
- Rich UI hydration uses payload and artifact references from chat_messages.

### 12.3 Artifact retention

Existing artifact_blobs remains the content-addressed body store. conversation_artifacts is
generalized from only tool results to any conversation artifact by adding artifactKind,
producerKind, entityRefs, metadata, and schemaVersion. Existing toolName, digest, validity,
expiresAt, and body behavior remain backward compatible.

Durable domain records remain authoritative:

- generated cases -> cases or AgentRun generated_cases;
- scripts -> scripts or AgentRun playwright_scripts;
- defects -> defects;
- reviews/plans/flows/API documents -> their domain store where one exists, otherwise a typed
  conversation artifact body;
- screenshots/traces/logs -> ArtifactStore reference.

---

## 13. Entity Resolution Model

### 13.1 Resolution contract

~~~typescript
interface ResolutionRequest {
  utterance: string;
  session: SessionContext;
  recentMessages: ConversationMessage[];
  workspaceScope: WorkspaceScope;
  explicitSelections: EntityRef[];
}

interface ReferenceBinding {
  expression: string;
  expressionKind:
    | "explicit_id"
    | "explicit_name"
    | "pronoun"
    | "collection"
    | "ordinal"
    | "recency"
    | "ellipsis";
  expectedTypes: EntityType[];
  resolved: EntityRef[];
  status: "resolved" | "ambiguous" | "unresolved";
  provenance: ResolutionProvenance[];
  candidatesConsidered: CandidateTrace[];
}
~~~

### 13.2 Deterministic stages

1. Extract explicit IDs, known URLs, branch names, and exact entity names.
2. Identify reference expressions using a versioned domain lexicon and grammar:
   it, them, those, previous one, last execution, scripts, cases, defects, run again, fix them.
3. Infer only the expected entity type from grammatical head and requested operation. This is not
   entity selection.
4. Generate candidates from:
   - currentSelectedEntity;
   - current entity pointer for expected type;
   - current/latest artifact set;
   - latest run and its entity graph;
   - recent message entity references;
   - scoped workspace records;
   - repository entities only when all higher tiers are empty and capability allows repository
     discovery.
5. Remove candidates failing tenant/workspace/project/app/type constraints.
6. Rank lexicographically, not by an opaque learned score:
   priority tier, explicit match, type compatibility, artifact/run relationship, conversation
   recency, workspace recency, stable ID.
7. Resolve only a unique top candidate or a coherent collection. If top candidates tie on all
   meaningful dimensions, return ambiguous.
8. Persist the binding and candidate trace.

### 13.3 Reference priority

~~~text
1. Current Selected Entity
2. Current/Latest Active Artifact Set
3. Latest Relevant Run or Current Execution
4. Conversation Entity Recency
5. Scoped Workspace Records
6. Repository Discovery
~~~

Repository search is never an earlier fallback.

### 13.4 Artifact and execution graphs

Each run produces deterministic edges:

~~~text
Conversation -> Run
Run -> Generated Case[]
Run -> Generated Script[]
Run -> Execution Result
Execution Result -> Test Verdict[]
Test Verdict -> Case / Script
Test Verdict -> Screenshot / Trace / Console / Network / Step Log
Test Verdict -> Defect[]
Run -> Report / Review
~~~

The resolver traverses these edges to interpret collection references:

- "the cases" after a run -> cases generated/used by latest relevant run;
- "the scripts" -> scripts compiled for that run;
- "them" after discussing failed cases -> the failed case collection, not every case;
- "run again" -> execution target and artifact set of the resolved prior run;
- "fix them" -> failed scripts/cases/defects according to the selected capability and prior focus.

### 13.5 Clarification policy

The resolver never asks if one deterministic candidate exists. It asks one concise clarification
when:

- two same-priority runs are active;
- "them" can mean two different current collections;
- the requested action would mutate/delete and the binding is not explicit;
- the candidate is outside the current app/project;
- the referenced entity has been deleted or invalidated.

---

## 14. Capability Router Design

### 14.1 Capability is not route presentation

Interaction mode and business capability are separate:

~~~typescript
interface CapabilityDecision {
  capability: CapabilityId;
  interaction: "answer" | "action" | "review" | "clarify";
  resolvedEntities: EntityRef[];
  requiredEvidence: EvidenceRequirement[];
  missing: MissingRequirement[];
  confidence: "deterministic" | "ambiguous";
  reasonCodes: string[];
}
~~~

### 14.2 Capability catalog

Initial catalog:

| Capability | Primary entities | Required evidence |
|---|---|---|
| run_diagnostics | run, execution, failed cases/scripts | AgentRun results, per-test errors, evidence refs |
| execution_review | run/execution | aggregate, verdicts, timing, retries, quarantine |
| code_review | branch, diff, files, review | scoped diff/source and prior review |
| test_generation | app/module/page/requirement | grounding, requirements, relevant existing cases |
| api_testing | API spec/endpoint/run | API definition, API evidence, prior API runs |
| automation | suite/cases/scripts/schedule | selected artifact graph and execution target |
| requirement_review | requirement/module | requirement record, links, code/knowledge evidence |
| defect_analysis | defect/run/case | defect record, linked outcome, evidence, relevant source |
| flow_analysis | app/module/page/flow | live/metadata/knowledge flow evidence |
| architecture_review | repository/subsystem/plan | scoped source/dependency evidence |
| documentation | entities/artifacts | selected authoritative records |
| workspace_action | workspace artifacts | resolved entities and authorization |
| app_knowledge | app/module/page/object | scoped knowledge/source/runtime as policy requires |
| conversation_recall | conversation artifacts/decisions | canonical messages, decisions, artifact refs |

Clarify is an interaction outcome, not a business capability.

### 14.3 Deterministic selection

The router consumes structured facts:

- request speech act: ask, create, run, modify, review, explain, compare;
- resolved entity types and relationships;
- session current goal and intent;
- latest/current execution state;
- workspace selection;
- capability preconditions.

Selection rules are capability metadata plus pure predicates. Examples:

~~~text
ask/explain + resolved run/execution/failure entity -> run_diagnostics
ask/review + selected diff/branch/files -> code_review
create/generate + app/module/requirement + test artifact noun -> test_generation
run/re-run + resolved suite/cases/scripts/run -> automation
ask/analyze + resolved defect -> defect_analysis
~~~

The existing goal-router LLM may remain temporarily as a proposal source for the speech act and
topic, but its output cannot select entities, override a capability precondition, or bypass
clarification. The end state removes it from authoritative routing. Unknown natural language is
mapped to app_knowledge or conversation_recall only when their predicates are satisfied; otherwise
the runtime clarifies.

### 14.4 Capability definition

Each capability declares:

- accepted speech acts;
- accepted and required entity types;
- evidence policy and precedence;
- action permissions;
- handler/planner identifier;
- whether source evidence is allowed;
- whether observed evidence is mandatory;
- cache/freshness policy;
- response contract;
- safe fallback behavior.

This is configuration-as-code, versioned and unit tested. It is not a prompt catalog.

---

## 15. Evidence Aggregator Design

### 15.1 Common evidence contract

~~~typescript
interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  authority: "observed" | "recorded" | "derived" | "inferred";
  source: EvidenceSource;
  entityRefs: EntityRef[];
  occurredAt?: string;
  capturedAt: string;
  freshness: "current" | "stale" | "unknown";
  integrity?: { algorithm: "sha256"; digest: string };
  summary: string;
  payloadRef?: ArtifactRef;
  facts: EvidenceFact[];
  redactions: string[];
}

interface EvidenceBundle {
  id: string;
  capability: CapabilityId;
  subjectRefs: EntityRef[];
  items: EvidenceItem[];
  observedFacts: EvidenceFact[];
  derivedFacts: EvidenceFact[];
  contradictions: EvidenceConflict[];
  gaps: EvidenceGap[];
  manifest: EvidenceManifest;
}
~~~

### 15.2 Authority order

1. Observed current execution, live DOM, network, console, trace, and screenshot evidence.
2. Recorded platform outcomes and domain records.
3. Validated artifacts and knowledge.
4. Scoped source-code analysis explaining an observation.
5. Inference, explicitly labeled and never used to overwrite observed fact.

Contradictory evidence is retained. The aggregator does not let the model silently choose one.
For example, a source path that appears correct does not convert an observed timeout into a pass.

### 15.3 Capability-specific aggregation

For run_diagnostics:

1. Resolve one run or a coherent run set.
2. Load scoped AgentRun by ID/conversation, never global list-and-filter.
3. Load aggregate execution_result and per-test verdicts.
4. Map test titles/case IDs/script IDs using the run artifact graph.
5. Load bounded error/failing-step and stderr data.
6. Attach screenshot, trace, console, network, and step-log references.
7. Load linked defects and report/review records.
8. Only then obtain narrowly relevant source evidence if the question asks why and observed failure
   needs implementation explanation.
9. Emit gaps when an expected evidence record is absent or inaccessible.

For test_generation, the provider set is different: requirements, selected app/module/page,
grounding registry, metadata, relevant existing cases, and source only under the existing
grounding rules.

### 15.4 Tool abstraction

Evidence providers are platform services, not model tools:

~~~typescript
interface EvidenceProvider {
  supports(requirement: EvidenceRequirement): boolean;
  collect(request: EvidenceRequest): Promise<EvidenceItem[]>;
}
~~~

The LLM receives an EvidenceBundle. It does not receive dozens of read tools. Action capabilities
may expose a very small set of high-level capability commands after planning, such as
ExecuteSelectedSuite or PersistDefectDraft. Low-level repository reads remain internal.

### 15.5 Redaction and artifact storage

- Reuse artifactMemory secret-key redaction.
- Evidence bodies are size-bounded and content-addressed.
- Context receives facts and refs, not binary bodies.
- ArtifactStore has a local filesystem adapter for current development and an object-storage
  adapter for production. The port is introduced before changing storage; object storage rollout
  is a separate operational phase.
- Signed/authorized retrieval occurs through the API, never by exposing absolute filesystem paths.

---

## 16. Context Assembly Redesign

### 16.1 Input contract

~~~typescript
interface ContextAssemblyRequest {
  requestId: string;
  message: ConversationMessage;
  session: SessionContext;
  capability: CapabilityDecision;
  bindings: ReferenceBinding[];
  evidence: EvidenceBundle;
  recentDecisions: DecisionRecord[];
  relevantArtifacts: ArtifactRef[];
  summaries: ConversationSummarySegment[];
  recentMessages: ConversationMessage[];
  knowledge: EvidenceItem[];
  source: EvidenceItem[];
  model: string;
}
~~~

### 16.2 Priority policy

The current model-specific budget is retained. No context limit is increased.

~~~text
Pinned:
  Current request
  Capability and permitted plan
  Session scope/version
  Resolved entity bindings
  Observed runtime evidence

High:
  Recorded execution/domain evidence
  Relevant artifact facts
  Recent decisions

Medium:
  Conversation summaries
  Relevant recent turns
  Workspace records
  Validated knowledge

Low:
  Narrow source excerpts
  Explicitly labeled inference
~~~

Observed evidence is selected item-by-item, not concatenated into one all-or-nothing block.
Each candidate carries token estimate, priority, dependency, and omission reason.

### 16.3 Output

~~~typescript
interface PreparedContext {
  systemContract: string;
  nativeMessages: ChatMessage[];
  task: string;
  capabilityPlan: CapabilityPlan;
  manifest: ContextManifest;
}
~~~

The manifest records:

- conversationId and session version;
- request/correlation IDs;
- capability decision and rule version;
- reference bindings and candidates;
- evidence bundle/item IDs, authority, freshness, and gaps;
- every included and excluded context item with reason;
- model and token estimates;
- plan version;
- provider invocation/usage correlation;
- final response evidence citations.

### 16.4 Source-code policy

Source code is not globally "the single source of truth." It is authoritative for implementation
behavior, but observed runtime evidence is authoritative for what occurred in a run. Capability
policy decides which source is primary:

- run diagnostics: observed execution first, source explains;
- code review/architecture review: scoped source/diff first;
- test generation: verified live/metadata grounding before source inference;
- conversation recall: canonical message/artifact records first.

---

## 17. Planner and Provider Boundary

### 17.1 Capability planner

The planner creates a bounded, auditable CapabilityPlan before provider invocation:

~~~typescript
interface CapabilityPlan {
  id: string;
  capability: CapabilityId;
  subjectRefs: EntityRef[];
  steps: PlanStep[];
  evidenceRequirements: EvidenceRequirement[];
  permittedCommands: CapabilityCommand[];
  responseSchema: string;
  blockers: PlanBlocker[];
  version: number;
}
~~~

Most read-only plans are deterministic templates:

~~~text
run_diagnostics:
  1. establish observed outcome
  2. identify failing cases/scripts
  3. correlate error with trace/log/screenshot
  4. explain likely cause, distinguishing observed from inferred
  5. list evidence gaps and next action
~~~

The LLM may synthesize prose and compare evidence, but it cannot add a data source, change entity
scope, or execute a command not present in permittedCommands.

### 17.2 Provider-neutral invocation

The existing AIProvider interface remains the only provider dependency. Conversational Runtime
calls the existing orchestrator/gateway with PreparedContext. OpenAI, Anthropic, Gemini, and
CLI/local adapters map the same messages and capability contract.

No provider file receives:

- capability routing rules;
- reference resolution;
- workspace queries;
- evidence precedence;
- session mutations;
- domain-specific fallback logic.

Provider-specific behavior is limited to protocol mapping, tool-call encoding where still used,
streaming, usage, error normalization, and model capability metadata.

---

## 18. Sequence Diagrams

### 18.1 Generate, run, then ask why

~~~mermaid
sequenceDiagram
    participant U as User
    participant API as Turn API
    participant S as Session Manager
    participant R as Entity Resolver
    participant C as Capability Router
    participant E as Evidence Aggregator
    participant X as Execution Store
    participant A as Context Assembler
    participant P as Planner
    participant L as LLM Gateway

    U->>API: Generate tests
    API->>S: load + merge request scope
    S->>R: resolve app/module/page
    R-->>S: concrete scope bindings
    S->>C: request + session + bindings
    C-->>S: test_generation
    S->>E: collect generation evidence
    E-->>S: grounding evidence bundle
    S->>A: assemble prepared context
    A->>P: create permitted plan
    P->>L: prepared invocation
    L-->>S: generated cases + refs
    S->>S: append message/artifact events

    U->>API: Run tests
    API->>S: load latest artifact set
    S->>R: bind "tests"
    R-->>S: generated case/script collection
    S->>C: automation
    C-->>X: existing workflow executes
    X-->>S: RunCompleted projection
    S->>S: latestRun/currentExecution/failures updated

    U->>API: Why did they fail?
    API->>S: load versioned session
    S->>R: resolve "they"
    R-->>S: failed cases from latest relevant run
    S->>C: request + failed case/run bindings
    C-->>S: run_diagnostics
    S->>E: collect run diagnostic evidence
    E->>X: results/log/trace/screenshots/defects
    X-->>E: observed evidence
    E-->>S: evidence bundle
    S->>A: evidence-first assembly
    A->>P: diagnostic plan
    P->>L: no raw tools; prepared facts/refs
    L-->>S: grounded explanation
    S-->>U: answer with evidence refs
~~~

### 18.2 Ambiguous reference

~~~mermaid
sequenceDiagram
    participant U as User
    participant S as Session Manager
    participant R as Entity Resolver
    participant C as Capability Router

    U->>S: Fix them
    S->>R: session + recent entity graph
    R->>R: two equal-priority collections found
    R-->>S: ambiguous binding + candidates
    S->>C: missing unique mutation target
    C-->>S: clarify
    S-->>U: Did you mean failed scripts from RUN-245 or defects from the security review?
~~~

### 18.3 Concurrent turns

~~~mermaid
sequenceDiagram
    participant A as API node A
    participant B as API node B
    participant DB as PostgreSQL

    A->>DB: begin; lock conversation; idempotency K1
    B->>DB: begin; lock same conversation; idempotency K2
    DB-->>A: session version 18
    A->>DB: append events/messages; version 19; commit
    DB-->>B: lock acquired; session version 19
    B->>DB: resolve against version 19; append; version 20; commit
~~~

---

## 19. Data Flow and CQRS

### 19.1 Command flow

~~~text
HTTP command
-> authenticate and derive scope server-side
-> acquire conversation lock / verify idempotency
-> append canonical user message
-> load/reconcile SessionContext
-> resolve references
-> decide capability
-> collect evidence
-> assemble context and plan
-> invoke provider or existing workflow
-> append assistant message and artifact refs
-> append session events and update snapshot
-> commit/version
-> stream response events
~~~

Long-running executions do not hold the conversation transaction. The turn records the accepted
RunStarted command and run reference. Workflow completion later projects an idempotent RunCompleted
event into the session.

### 19.2 Query flow

~~~text
Get session/query
-> scope authorization
-> read conversation_sessions snapshot
-> optionally read entity refs / message range / evidence manifest
-> return versioned DTO
~~~

Query handlers never call an LLM.

### 19.3 Consistency

- Message append, session event append, and session snapshot update use one transaction.
- Run execution remains its own aggregate and transaction boundary.
- Run-to-session projection is idempotent by source event key.
- Session load checks whether the indexed latest conversation run is newer than the projected
  pointer. If so, it performs an audited reconciliation.
- At-least-once projection is safe; duplicate source event keys are ignored.
- Read-your-writes is guaranteed for the conversation turn API.

---

## 20. Database Changes

All changes are additive first. No destructive migration occurs until compatibility reads have
been retired and audited.

### 20.1 conversation_sessions

| Column | Purpose |
|---|---|
| conversation_id PK/FK | Session identity |
| owner_id, workspace_id, project_id | Scope and authorization |
| state JSONB | Versioned typed SessionContext snapshot |
| version BIGINT | Optimistic concurrency |
| schema_version INT | State migration |
| last_event_seq BIGINT | Projection checkpoint |
| created_at, updated_at | Lifecycle |

Indexes: owner/workspace/updated, project/updated. A check ensures version and last_event_seq are
non-negative.

### 20.2 conversation_session_events

| Column | Purpose |
|---|---|
| conversation_id, seq PK | Ordered event stream |
| event_id unique | Global trace ID |
| event_type | State transition type |
| payload JSONB | Bounded event data/refs |
| source_key unique per conversation | Idempotent projection |
| correlation_id, causation_id | Trace |
| actor_id | User/system |
| created_at | Audit |

### 20.3 conversation_entity_refs

Stores the deterministic recency index:

- conversation_id;
- entity_type and entity_id;
- relation: selected/current/latest/generated/mentioned/failed/linked;
- source_message_id/source_event_seq/source_run_id;
- scope fields;
- salience tier;
- first_seen_at/last_seen_at;
- metadata JSONB.

Unique key: conversation, entity type, entity ID, relation, source run. Indexes support selected,
type/recency, run traversal, and scope.

### 20.4 chat_messages

Add:

- message_id unique;
- client_message_id with unique conversation constraint;
- entity_refs JSONB;
- artifact_refs JSONB;
- correlation_id and causation_id;
- schema_version.

Keep sequence primary key. Backfill message_id deterministically from conversation and sequence.

### 20.5 chat_conversations

Add owner_id, project_id, app_id, archive status, and canonicalized_at. All get/list/update/delete
operations become scope-aware. turns stays until the migration completion gate.

### 20.6 agent_runs

Add first-class:

- conversation_id;
- execution_result JSONB;
- completed_at;
- artifact_set_id.

Backfill from raw conversationId/execution_result/completed_at. Add indexes on
owner/project/app/conversation/created_at and conversation/status/created_at. Repository methods
become getScoped, listByConversation, and latestByConversation.

### 20.7 conversation_artifacts and artifact_blobs

Add artifact_kind, producer_kind, entity_refs, metadata, schema_version, and retention_class.
Existing tool-result rows map to producer_kind=tool and keep current validity/expiry behavior.

### 20.8 context_manifests

Add:

- request_id/correlation_id;
- session_version;
- capability and capability_version;
- resolution_trace JSONB;
- evidence_manifest JSONB;
- plan_manifest JSONB;
- response_evidence_refs JSONB.

### 20.9 Local development store

server/shared/storage.ts receives equivalent arrays/maps. It is documented as single-process only.
Production concurrency guarantees require PostgreSQL.

---

## 21. APIs

### 21.1 Primary turn API

POST /api/conversations/:conversationId/turns/stream

Request:

~~~json
{
  "clientMessageId": "uuid",
  "message": "Why did they fail?",
  "expectedSessionVersion": 18,
  "requestContext": {
    "projectId": "project-id",
    "appId": "app-id",
    "pagePath": "/runs/RUN-245",
    "selectedEntity": {"type": "run", "id": "RUN-245"}
  }
}
~~~

Scope authority comes from authenticated middleware and server-side project/app validation.
Client scope is a selection hint, never authorization.

SSE events:

- session_loaded;
- references_resolved;
- capability_selected;
- evidence_collected;
- plan_ready;
- answer_delta;
- action_status;
- final;
- conflict;
- error.

The final event includes sessionVersion, messageId, capability, resolved entities, evidence refs,
and context manifest ID.

### 21.2 Session queries/commands

- GET /api/conversations/:id/session
- GET /api/conversations/:id/entities?type=&relation=
- POST /api/conversations/:id/entities/select
- GET /api/conversations/:id/messages?before=&limit=
- GET /api/conversations/:id/context-manifests/:requestId
- POST /api/conversations/:id/reconcile for privileged diagnostics only

### 21.3 Evidence query

GET /api/conversations/:id/runs/:runId/evidence

Returns a scoped, redacted EvidenceBundle DTO or selected evidence item refs. It does not expose
absolute filesystem paths or credentials.

### 21.4 Compatibility APIs

During migration:

- /api/agent/goal delegates to session load, entity resolution, and capability routing, then maps
  CapabilityDecision to the existing RouteKind response.
- /api/controller/supervise and /stream delegate to the prepared capability execution when a
  decision token is supplied; legacy behavior remains behind a feature flag for rollback.
- /api/chat/conversations endpoints read canonical messages first and can still hydrate old turns.
- /api/agent/start remains the execution entry point but publishes run lifecycle projections.

No existing endpoint is removed before AgentConsole uses the primary turn API and rollback
telemetry is clean.

---

## 22. Complete Refactoring Strategy

### 22.1 Strangler approach

1. Add persistence and pure domain contracts with no call-site change.
2. Build Session Context Manager and deterministic resolver against existing repositories.
3. Add capability catalog/router and shadow decisions beside current routing.
4. Add evidence aggregation, starting with run diagnostics.
5. Add new context/planner/runtime and primary turn API.
6. Project legacy and graph run lifecycle into session state.
7. Migrate AgentConsole and rich messages.
8. Retire dual routing and transcript authority only after parity gates pass.

### 22.2 Feature flags

- CONVERSATIONAL_RUNTIME_V1: enables the primary runtime.
- CONVERSATIONAL_ROUTER_SHADOW: records new decisions without affecting responses.
- CANONICAL_CHAT_MESSAGES_V1: reads/writes canonical message flow.
- SESSION_RUN_PROJECTION_V1: projects run events.
- OBJECT_ARTIFACT_STORE_V1: later production storage adapter.

Flags are temporary migration controls with documented retirement criteria, not permanent
behavior configuration.

### 22.3 Shadow validation

For each current request, shadow mode records:

- old route;
- new capability;
- reference bindings;
- evidence requirements;
- whether the old answer path lacked required evidence.

It does not make a second LLM call. This keeps shadow cost low and evaluates deterministic logic.

---

## 23. File-by-File Implementation Plan

The paths below are the complete expected implementation surface. A phase may discover a required
test fixture within the same subsystem, but production scope may not expand without a revised plan.

### Phase 1 — Persistence foundation

| File | Change | Why | Risk |
|---|---|---|---|
| server/db/schema.sql | Add session/events/entity refs and additive columns/indexes/backfills | Durable state and indexed joins | High |
| server/db/repository.ts | Add scoped conversation/run queries and canonical message/idempotency operations | Remove list/filter and dual authority | High |
| server/shared/storage.ts | Add local adapter structures | Preserve no-Postgres development | Medium |
| core/persistence/index.ts | Export new persistence operations through boundary | Prevent new service importing route internals | Low |
| services/runtime/src/domain/types.ts (new) | Session, entity, capability, evidence, plan contracts | Shared domain language | Medium |
| services/runtime/src/ports.ts (new) | Repository/evidence/LLM/artifact ports | Dependency inversion | Low |
| services/runtime/src/adapters/sessionRepository.ts (new) | PostgreSQL/local persistence adapter | Isolate infrastructure | High |
| scripts/test-conversation-persistence.ts (new) | Backfill, idempotency, scope, concurrency checks | Migration safety | Medium |
| package.json | Add targeted test script | Runnable validation | Low |

Phase risk: High because schema and repository authority change. It remains additive and has no
runtime consumer yet.

### Phase 2 — Session Context Manager and Entity Resolver

| File | Change | Why | Risk |
|---|---|---|---|
| services/runtime/src/domain/session.ts (new) | Aggregate invariants and pure projections | First-class structured session | Medium |
| services/runtime/src/domain/entityResolver.ts (new) | Deterministic expression/candidate/ranking logic | Remove LLM guessing | High |
| services/runtime/src/application/sessionContextManager.ts (new) | Commands, queries, versioning, reconciliation | Single state owner | High |
| services/runtime/src/application/sessionProjector.ts (new) | Project messages/artifacts/runs into snapshot/index | Durable working state | High |
| services/runtime/src/adapters/workspaceEntityReader.ts (new) | Scoped entity candidate reads | Workspace candidate source | Medium |
| services/runtime/src/index.ts (new) | Internal runtime exports | Stable service boundary | Low |
| services/runtime/index.ts | Export new runtime while retaining legacy registration | Strangler boundary | Low |
| scripts/test-session-context.ts (new) | Aggregate/event/restart tests | State correctness | Medium |
| scripts/test-entity-resolution.ts (new) | Exact pronoun/collection/recency matrix | Deterministic binding | High |
| package.json | Add tests | Validation | Low |

Phase risk: High. No production route changes.

### Phase 3 — Capability Catalog and Router

| File | Change | Why | Risk |
|---|---|---|---|
| services/runtime/src/domain/capabilities.ts (new) | Capability definitions/preconditions/evidence policy | Capability architecture | Medium |
| services/runtime/src/domain/capabilityRouter.ts (new) | Pure deterministic selection | Replace text-only route authority | High |
| services/runtime/src/application/requestAnalyzer.ts (new) | Normalize speech act/topic without entity authority | Structured router input | Medium |
| services/runtime/src/application/routeTurn.ts (new) | Load session, resolve, route, persist decision | Correct ordering | High |
| server/agent-runtime/goals/types.ts | Add compatibility mapping types; deprecate broad answer authority | Old API mapping | Medium |
| server/agent-runtime/goals/router.ts | Delegate authoritative decision or run shadow comparison | Migrate current router | High |
| server/agent-runtime/routes.ts | Accept conversationId and session decision token | Connect authoritative state | High |
| scripts/eval-routing.ts | Add capability/state/reference cases | Regression coverage | Medium |
| scripts/test-capability-routing.ts (new) | Full capability predicate matrix | Determinism | High |
| server/ai/systemPrompts.ts | Remove goal taxonomy as authority after cutover; retain temporary proposal contract | Avoid conflicting route vocabulary | Medium |

Phase risk: High. Initially shadow-only.

### Phase 4 — Evidence Aggregation and Run Diagnostics

| File | Change | Why | Risk |
|---|---|---|---|
| services/runtime/src/application/evidenceAggregator.ts (new) | Resolve requirements, parallel collection, precedence/conflicts/gaps | Evidence-first core | High |
| services/runtime/src/adapters/runEvidenceProvider.ts (new) | AgentRun results/errors/evidence/defect graph | Run diagnostics | High |
| services/runtime/src/adapters/workspaceEvidenceProvider.ts (new) | Plans/suites/cases/scripts/reports | Workspace evidence | Medium |
| services/runtime/src/adapters/knowledgeEvidenceProvider.ts (new) | Knowledge/metadata evidence | Reuse current knowledge | Medium |
| services/runtime/src/adapters/sourceEvidenceProvider.ts (new) | Narrow scoped source evidence | Source as explanation | Medium |
| services/runtime/src/adapters/artifactStore.ts (new) | Current local artifact adapter behind port | Remove absolute-path leakage | Medium |
| server/ai/memory/artifactMemory.ts | Reuse generalized artifact metadata/redaction contract | Rich artifact retention | Medium |
| server/ai/tools/agentTools.ts | Delegate get_run compatibility to run evidence query | One run truth | Medium |
| server/ai/tools/registry.ts | Export compatibility evidence facade; no new broad raw-tool exposure | Legacy supervisor bridge | Medium |
| scripts/test-evidence-aggregation.ts (new) | Precedence, gaps, redaction, scope tests | Evidence correctness | High |
| package.json | Add test | Validation | Low |

Phase risk: High because incorrect evidence correlation would produce confidently wrong answers.

### Phase 5 — Context, Planner, and Conversational Runtime

| File | Change | Why | Risk |
|---|---|---|---|
| services/runtime/src/application/contextAssembler.ts (new) | Evidence-first, item-level budgeted prepared context | Correct prompt inputs | High |
| services/runtime/src/application/capabilityPlanner.ts (new) | Deterministic plans/allowed commands | Planner boundary | High |
| services/runtime/src/application/conversationalRuntime.ts (new) | End-to-end turn coordinator | Single runtime | High |
| services/runtime/src/application/responseRecorder.ts (new) | Persist answer refs/decisions/output events | Close state loop | Medium |
| services/runtime/src/api/routes.ts (new) | Primary turn/session/entity/evidence APIs and SSE | New entry point | High |
| services/runtime/index.ts | Export route registration | Composition | Low |
| apps/api/src/server.ts | Register runtime routes | Activate behind flag | Medium |
| server/ai/memory/contextAssembler.ts | Compatibility adapter to prepared context; retain old callers | Avoid duplicate assembly | High |
| server/ai/orchestrator.ts | Accept prepared invocation metadata/citations; no routing logic | Trace correlation | Medium |
| server/ai/providers/types.ts | Add provider-neutral response evidence metadata if needed | Common contract | Low |
| scripts/test-conversational-runtime.ts (new) | Full in-memory turn sequence | End-to-end correctness | High |
| package.json | Add test | Validation | Low |

No OpenAI/Anthropic/Gemini business logic changes are expected. Provider contract tests verify that.

### Phase 6 — Run Projection, Canonical Messages, and UI Migration

| File | Change | Why | Risk |
|---|---|---|---|
| server/features/agent/routes.ts | Publish legacy run lifecycle/artifact projection | Keep session current | High |
| server/features/agent/workflow/runtime.ts | Publish LangGraph lifecycle/artifact projection | Same semantics for both engines | High |
| server/features/chat/routes.ts | Canonical message APIs/read compatibility | End dual authority | High |
| server/features/controller/routes.ts | Delegate old answer/supervisor routes to decision token/runtime | Remove second router | High |
| server/ai/supervisor.ts | Split code analysis handler from generic answer; consume prepared capability input | Retire code-only default | High |
| server/ai/memory/conversationState.ts | Become compatibility ledger view over session/evidence records | Preserve old prompt callers | Medium |
| server/ai/memory/conversationSummary.ts | Compact only canonical message sequence | Fix transcript mismatch | High |
| src/pages/AgentConsole.tsx | Use primary turn stream, clientMessageId, session version, structured messages | UI cutover | High |
| src/components/DeepRunResult.tsx | Hydrate evidence/artifact refs through authorized APIs | Rich output recovery | Medium |
| src/components/GeneratedCases.tsx | Consume canonical structured payload/refs | Preserve full cases | Medium |
| scripts/test-conversation-memory.ts | Update assertions to canonical authority/session state | Regression | Medium |
| scripts/test-run-session-projection.ts (new) | Legacy+graph projection parity/restart | Working-state guarantee | High |
| package.json | Add tests | Validation | Low |

Phase risk: Highest. It changes the live conversation path and both run engines but stays within one
architectural subsystem: session integration.

### Phase 7 — Security, Scale, Cleanup, and Flag Retirement

| File | Change | Why | Risk |
|---|---|---|---|
| server/features/chat/routes.ts | Enforce scoped get/update/delete everywhere | Tenant isolation | High |
| server/db/repository.ts | Remove global/unscoped compatibility methods after callers migrate | Scale/security | High |
| server/agent-runtime/routes.ts | Retire legacy client-history routing path | Single router | Medium |
| server/agent-runtime/goals/router.ts | Remove LLM route authority or retain only non-authoritative analyzer | Deterministic routing | Medium |
| server/features/controller/routes.ts | Remove ACTION_RE branch | Single runtime | Medium |
| server/ai/supervisor.ts | Remove generic code-answer entry point after capability handlers own it | Separation of concerns | Medium |
| src/pages/AgentConsole.tsx | Stop PUT of turns snapshot | Canonical transcript | High |
| server/db/schema.sql | Mark turns deprecated; destructive drop deferred to a later separately approved migration | Cleanup gate | Low now |
| scripts/test-conversation-concurrency.ts (new) | Multi-client/version/idempotency/load checks | Thread safety | High |
| scripts/agent-evals.ts | Exact multi-turn enterprise eval suite | Production gate | Medium |
| package.json | Add tests/evals | Validation | Low |

Dropping chat_conversations.turns is explicitly not part of this roadmap. It requires a later data
retention approval after a production audit confirms canonicalization.

---

## 24. Backward Compatibility

### Public APIs

- Existing route shapes remain until AgentConsole migration is complete.
- /api/agent/goal returns old RouteKind mapped from CapabilityDecision.
- /api/controller/supervise/stream accepts old requests and constructs/loads a session decision.
- /api/agent/start is unchanged externally.
- AgentRun details/status payloads remain compatible.

### Data

- Existing chat_conversations.turns remains readable.
- Existing chat_messages rows receive deterministic IDs and empty ref arrays.
- Existing AgentRun raw fields remain readable; first-class columns are dual-written.
- Existing conversation_artifacts tool rows remain valid.
- Historical sessions are lazily initialized and reconciled from conversation messages and indexed
  runs.

### Providers

- AIProvider behavior remains unchanged.
- CLI/local mode continues to flatten prepared context if native message replay is unavailable.
- Provider outputs are normalized to the same PreparedResponse contract.

### Agent workflows

- Legacy and LangGraph engines continue to execute unchanged.
- Session projection observes their durable outputs; it does not modify generation/execution logic.

---

## 25. Migration Strategy

### Data migration

1. Apply additive schema.
2. Backfill chat message IDs and conversation scope.
3. Backfill AgentRun conversation_id, execution_result, and completed_at from raw.
4. Create session snapshots lazily, with an optional bounded background backfill.
5. Backfill entity refs from canonical messages and AgentRun artifact graphs.
6. Validate counts, hashes, and latest-run pointers.
7. Enable dual writes.
8. Enable canonical reads for internal runtime.
9. Migrate UI.
10. Stop legacy snapshot writes.

### Runtime migration

- Shadow capability router first.
- Run diagnostics capability first because it exercises the complete state/entity/evidence chain
  without mutating workspace data.
- Add read-only capabilities before mutation capabilities.
- Require explicit resolved entities and optimistic version for actions.
- Remove old routing only after parity and rollback windows.

### Historical reconciliation

When opening an old conversation:

1. load canonical messages if present, otherwise backfill from turns;
2. find scoped AgentRuns by conversation;
3. select latest eligible records deterministically;
4. build artifact graph and session snapshot;
5. append SessionReconciled with source hashes.

No LLM participates.

---

## 26. Performance Considerations

### Database

- Replace AgentRuns.list/filter with indexed listByConversation/latestByConversation.
- Select bounded columns for routing/session loads; load heavy raw/evidence only after capability
  selection.
- Keep SessionContext as one row for the common read.
- Store entity recency in indexed rows rather than scanning message JSON.
- Paginate messages and events by sequence.
- Use content hashes to deduplicate evidence bodies.

### Aggregation

- Collect independent evidence providers in parallel.
- Preserve deterministic final ordering after parallel collection.
- Stop provider fan-out when required evidence is satisfied.
- Cache immutable evidence by source version/hash; revalidate mutable evidence by run status,
  repository revision, or TTL.
- Do not cache authorization decisions.

### Context

- Retain the existing model-aware budget.
- Budget evidence items individually.
- Never load binary evidence into the prompt.
- Use bounded excerpts for logs/errors and refs for full bodies.
- Record truncation/omission explicitly.

### LLM cost

- Deterministic routing and resolution require no model call.
- Run diagnostics should usually require one synthesis call after platform aggregation.
- Source exploration occurs only if observed evidence needs explanation.
- Shadow routing makes no additional LLM request.

Expected result: fewer tool-loop turns, lower latency, and lower token usage than the current
code-explorer path.

---

## 27. Thread Safety and Concurrency

### Conversation commands

- Acquire pg_advisory_xact_lock(hash(conversationId)) or SELECT the session row FOR UPDATE.
- Validate expectedSessionVersion.
- Enforce unique clientMessageId.
- Allocate sequence numbers inside the lock.
- Append message, events, entity refs, and snapshot in one transaction.
- Return 409 conflict with latest version for stale mutation commands; read-only questions may be
  automatically retried once against the new version.

### Run projections

- Use source_key such as runId:projectionVersion:status.
- Duplicate completion delivery is ignored.
- Out-of-order delivery is retained as an event but cannot regress terminal state.
- currentExecution and latestRun have independent semantics.

### Multi-process behavior

- No module-global session state.
- In-process caches are hints keyed by conversation/version, never authority.
- SSE handlers can run on any API node.
- PostgreSQL is required for production concurrency.
- The local JSON adapter explicitly supports only one process and serializes writes with a
  per-conversation mutex.

### Cancellation

- Provider/aggregation cancellation propagates AbortSignal.
- An aborted turn records TurnAborted without inventing an assistant answer.
- Already committed user messages remain; retry uses a new request ID and may reuse the same
  clientMessageId only if the original did not commit.

---

## 28. Scaling Strategy

### Horizontal API scale

- Stateless Express instances.
- PostgreSQL for session/message/event/query authority.
- Connection pool sized per instance with database-wide limits.
- No sticky sessions required.

### Evidence scale

- ArtifactStore port separates references from bytes.
- Local filesystem remains development only.
- Production adapter uses shared object storage with tenant-prefixed keys, integrity hashes,
  retention policy, and authorized signed retrieval.
- Evidence bundle contains refs and facts, not bytes.

### Workload isolation

- Read-only conversation diagnostics can run on API workers.
- Long executions remain in the existing workflow/automation workers.
- Evidence aggregation has per-provider timeout and concurrency limits.
- LLM calls retain existing provider rate/cost controls.

### Future scale triggers, not immediate dependencies

- Add Redis only if measured session snapshot read pressure or distributed short-lived locks exceed
  PostgreSQL capacity.
- Add a dedicated search index only if conversation/entity/artifact lookup exceeds PostgreSQL
  full-text/indexed query targets.
- Add asynchronous outbox consumers only when run projection volume or cross-service deployment
  requires it. The event schema and source keys already permit that evolution.

---

## 29. Explainability, Traceability, and Security

Every response can answer:

- Which session version was used?
- What did each reference resolve to?
- Which capability was selected and why?
- Which evidence was observed, recorded, derived, inferred, stale, or missing?
- What was omitted from context and why?
- What plan and permitted commands were used?
- Which evidence refs support the final statements?
- Which provider/model generated the prose?

Security requirements:

- All conversation/session/run/artifact reads require owner and workspace scope.
- Entity candidates outside scope are discarded before ranking.
- Client-supplied project/app/entity values are selection hints only.
- Evidence redaction occurs before persistence and again before provider assembly.
- Artifact retrieval never exposes local absolute paths.
- Session/events never contain credentials, cookies, storage state, or raw secrets.
- Mutation plans require resolved concrete targets and existing authorization gates.

---

## 30. Testing Strategy

### Unit tests

- Session aggregate invariants and event projections.
- Reference expression parsing.
- Candidate filtering and lexicographic ordering.
- Singular/plural/ordinal/ellipsis resolution.
- Capability predicate matrix.
- Evidence authority ordering, conflict retention, gaps, redaction, and freshness.
- Context item priority and manifest omissions.
- Deterministic capability plans.

### Repository and migration tests

- Schema applies twice.
- Backfill is idempotent.
- Rich message payload round trip.
- AgentRun first-class fields match raw fields.
- Scope-aware reads cannot cross owners/projects/apps.
- Message idempotency and sequence allocation.
- Session optimistic conflict behavior.

### Integration tests

Exact required sequence:

1. Generate tests.
2. Run tests.
3. Seed mixed passed/failed outcomes, errors, screenshots, trace, console/network logs, and defect.
4. Ask "Why did they fail?"
5. Assert:
   - they binds to failed cases from the latest relevant run;
   - capability is run_diagnostics;
   - AgentRun evidence is loaded before source;
   - answer cites real case/script IDs and stored error evidence;
   - source is used only for explanation;
   - context manifest records binding/evidence/priority.

Additional sequences:

- "the scripts" never binds to package.json after a generated run;
- "what have we tested before" returns conversation/workspace execution history;
- "run again" resolves prior artifact set and target;
- "fix them" with two collections clarifies;
- switching app invalidates incompatible current entities;
- restart preserves session and latest run;
- graph and legacy runs project identical session semantics.

### Provider contract tests

Run the same PreparedInvocation through OpenAI, Anthropic, Gemini, and CLI/local test adapters.
Assert identical capability, binding, evidence, plan, and response schema inputs. Only protocol
serialization may differ.

### Concurrency tests

- Two simultaneous messages on one conversation.
- Duplicate clientMessageId.
- Run completion racing with a question.
- Selection change racing with a mutation.
- Out-of-order and duplicate run projections.
- Multi-instance simulation over PostgreSQL.

### Security tests

- Guessing another conversation ID.
- Cross-owner run ID in explicit message.
- Cross-project selected entity.
- Evidence artifact ref from another conversation.
- Secret fields in logs/tool bodies.

### Performance tests

Targets to establish before production:

- p95 session load and entity resolution;
- p95 routing without LLM;
- evidence query count and bytes;
- p95 diagnostic aggregation before LLM;
- context tokens by section;
- reduction in tool-loop steps and total tokens versus current path.

### Regression suite

- npm run lint and build.
- Existing agent workflow, resume, execution evidence, defect reporter, grounding, API intelligence,
  routing, and conversation memory tests.
- DOM inspection and metadata/repository grounding remain unchanged.
- Playwright generation continues to use verified evidence only.

---

## 31. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|---|---:|---:|---|
| Wrong deterministic binding | Medium | Critical | Unique-top rule, type/scope filters, candidate trace, clarification |
| Session projection becomes stale | Medium | High | Idempotent source keys, indexed reconciliation on load |
| Dual-write divergence | Medium | High | Hash/count audit, canonicalization flag, rollback reads |
| Capability router over-classifies | Medium | High | Pure predicate matrix, shadow comparison, no action on ambiguity |
| Evidence correlated to wrong test/script | Medium | Critical | Explicit run artifact graph and stable IDs; title only as fallback with gap |
| Rich payload increases DB size | Medium | Medium | Domain refs/content-addressed bodies, bounded message payload |
| Context still crowds out evidence | Low | High | Pinned observed items and item-level budget tests |
| Cross-tenant leakage | Low but existing exposure | Critical | Scoped repository methods, scope filtering before candidate generation |
| Concurrent turns overwrite state | Medium | High | Lock, expected version, idempotency |
| Run completion races with question | Medium | High | independent current/latest semantics and reconciliation |
| Local artifact refs fail after scale-out | High at scale | High | ArtifactStore port and shared storage before horizontal production |
| Provider output differs | Medium | Medium | PreparedInvocation contract and cross-provider tests |
| Legacy/UI cutover regression | Medium | High | compatibility adapters, feature flags, phased UI cutover |
| Over-abstracted runtime slows delivery | Medium | Medium | One runtime bounded context, reuse existing services, no new broker/cache initially |

### Highest-risk files

- server/db/schema.sql and server/db/repository.ts;
- entityResolver.ts and capabilityRouter.ts;
- evidenceAggregator.ts and runEvidenceProvider.ts;
- conversationalRuntime.ts;
- server/features/controller/routes.ts and server/ai/supervisor.ts cutover;
- AgentConsole.tsx canonical-message migration;
- legacy/graph run projection integration.

---

## 32. Rollback Strategy

### Per-phase rollback

- Phase 1: new tables/columns remain unused; revert code. Additive schema can stay.
- Phase 2: disable Session Manager consumers; no public behavior changed.
- Phase 3: disable shadow/new router flag; old route remains.
- Phase 4: disable evidence providers; no execution storage change.
- Phase 5: disable CONVERSATIONAL_RUNTIME_V1; old APIs remain.
- Phase 6: switch AgentConsole to old goal/supervisor flow; dual-written messages and AgentRuns
  remain compatible.
- Phase 7: do not retire flags until rollback window is closed.

### Data rollback

- Never delete legacy turns during this roadmap.
- Never remove AgentRun raw fields.
- New session/events/entity tables can be ignored without data loss.
- If canonical message writes fail, stop cutover rather than fall back to two active authorities.
- A rollback tool can reconstruct the UI snapshot from canonical messages, but is not required for
  runtime rollback because old turns remain.

### Operational triggers

Automatically disable new response routing if:

- session conflict/error rate crosses threshold;
- unresolved/ambiguous rate changes sharply;
- run-diagnostics evidence gap rate exceeds baseline;
- scope authorization failures indicate migration mismatch;
- provider invocation errors rise relative to old path.

---

## 33. Estimated Implementation Effort

Assuming two senior backend engineers, one frontend engineer for Phase 6, and QA support:

| Phase | Effort | Calendar estimate | Dominant work |
|---|---:|---:|---|
| 1 Persistence | 8–12 engineer-days | 1–2 weeks | Schema, backfill, scoped repos, concurrency |
| 2 Session/resolution | 10–15 engineer-days | 2 weeks | Aggregate, graph, resolver matrix |
| 3 Capability routing | 7–10 engineer-days | 1–2 weeks | Catalog, predicates, shadow eval |
| 4 Evidence | 10–15 engineer-days | 2–3 weeks | Run correlation, provenance, redaction |
| 5 Runtime/context/planner | 10–15 engineer-days | 2–3 weeks | Turn coordinator, APIs, manifests |
| 6 Integration/UI | 12–18 engineer-days | 2–3 weeks | Both run engines, canonical messages, UI |
| 7 Hardening/cleanup | 8–12 engineer-days | 1–2 weeks | Scale, security, concurrency, flag retirement |

Total: approximately 65–97 engineer-days, or 10–15 calendar weeks with parallel staffing and
phase validation. Object-storage production rollout, if required immediately, adds roughly
5–8 engineer-days and operational setup.

---

## 34. Final Implementation Roadmap

### Phase 1 — Persistence foundation

- [ ] Add additive schema and backfills.
- [ ] Add scoped/idempotent repository methods.
- [ ] Add domain and persistence ports.
- [ ] Validate migration twice and in-memory compatibility.
- [ ] Run lint/build/repository tests.
- [ ] Produce phase report; stop for approval of Phase 2.

Files: 9. Risk: High.

### Phase 2 — Session Context and Entity Resolution

- [ ] Implement aggregate/event projection.
- [ ] Implement deterministic candidate graph and ranking.
- [ ] Implement reconciliation.
- [ ] Cover all required references and ambiguity cases.
- [ ] Run restart and state-invariant tests.
- [ ] Produce phase report; stop.

Files: 10. Risk: High.

### Phase 3 — Capability Router

- [ ] Add capability catalog and pure router.
- [ ] Connect authoritative conversation/session to goal routing.
- [ ] Enable shadow decisions only.
- [ ] Compare against production request corpus and exact forensic sequence.
- [ ] No mutation capability cutover.
- [ ] Produce phase report; stop.

Files: 10. Risk: High.

### Phase 4 — Evidence Aggregation

- [ ] Add EvidenceItem/Bundle behavior.
- [ ] Implement run diagnostics provider first.
- [ ] Add workspace/knowledge/source adapters.
- [ ] Verify observed-over-inferred precedence and redaction.
- [ ] Verify no global AgentRun scans.
- [ ] Produce phase report; stop.

Files: 11. Risk: High.

### Phase 5 — Context, Planner, Runtime API

- [ ] Add item-level evidence-first assembly.
- [ ] Add deterministic plans.
- [ ] Add primary turn/session/entity/evidence APIs.
- [ ] Preserve provider-neutral gateway.
- [ ] Run exact multi-turn sequence in-memory and PostgreSQL.
- [ ] Enable read-only run_diagnostics behind flag.
- [ ] Produce phase report; stop.

Files: 12. Risk: High.

### Phase 6 — Run Projection and UI Cutover

- [ ] Project legacy and graph run lifecycle.
- [ ] Make chat_messages canonical.
- [ ] Migrate AgentConsole to the primary stream.
- [ ] Preserve rich cases/scripts/evidence after reload.
- [ ] Delegate compatibility routes.
- [ ] Run full existing and new regression suites.
- [ ] Live-verify exact forensic sequence after backend restart.
- [ ] Produce phase report; stop.

Files: 13. Risk: Very High.

### Phase 7 — Hardening and Retirement

- [ ] Enforce scope on all conversation/session/artifact reads.
- [ ] Run concurrency, security, load, and provider parity tests.
- [ ] Retire ACTION_RE and legacy route authority.
- [ ] Stop browser turns snapshot writes.
- [ ] Keep legacy columns/data for rollback window.
- [ ] Publish production-readiness report.

Files: 11. Risk: High.

---

## 35. Production Readiness Gates

The redesign is production-ready only when all are true:

- Exact reported follow-up questions resolve to real conversation-linked run evidence.
- No reference binding depends on LLM guessing.
- Every action has a concrete scoped entity target.
- Observed evidence is always ranked above source inference for diagnostic capabilities.
- Conversation state survives restart and concurrent requests.
- Rich generated output is recoverable after reload.
- Legacy and LangGraph executions project equivalent session state.
- Context manifests explain route, binding, evidence, omissions, and plan.
- OpenAI, Anthropic, Gemini, and CLI/local paths pass the same behavioral contract.
- Existing APIs, agents, DOM inspection, repository grounding, metadata, prompt assembly,
  validation gates, and verified-evidence Playwright generation regressions are clean.
- Production uses shared artifact storage before horizontal scaling of evidence-serving nodes.
- Rollback flags and old data remain available through the agreed observation window.

---

## 36. Final Recommendation

Approve only Phase 1 first. The architecture should not be implemented as one large rewrite.
Phase 1 creates the durable and scoped substrate while changing no conversational behavior.
Subsequent phases must be approved and validated separately under the repository's 10–15-file or
one-subsystem cap.

The first user-visible capability to cut over should be read-only run_diagnostics. It proves the
entire session -> resolution -> capability -> evidence -> context -> planner -> provider chain
against the exact production failure while leaving mutation and test execution behavior unchanged.

No implementation should begin from this document until explicit approval is provided on a later
turn.
