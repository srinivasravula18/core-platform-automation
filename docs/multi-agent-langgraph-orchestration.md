# Multi-Agent and LangGraph Orchestration

This document describes the current implementation as of 2026-08-13.

## The short version

LangGraph is the live default workflow engine. It deterministically moves one shared `WorkflowState` through context loading, application discovery, evidence grounding, case authoring, compilation, execution, investigation, and finalization.

The agent-native router, message bus, and blackboard are a separate, `AGENT_NATIVE_V1`-gated coordination layer. They publish routing plans, handoffs, results, and shared facts, but the LangGraph graph remains the authority that decides which stage executes next. In other words: the application has specialist-agent behavior and agent-to-agent telemetry, but it is not yet a free-form swarm.

Codex is the single model-execution runtime behind model-backed agents and graph nodes. Ordinary text, structured-output, streaming, cancellation, and resumable turns use the official TypeScript Codex SDK. Turns that need application tools use Codex App Server because the current SDK path cannot answer MCP approval requests. This application does **not** use the OpenAI Agents SDK as a second orchestrator; LangGraph remains the orchestrator.

## 1. Whole-system view

```mermaid
flowchart TB
    User[User / Agent Console] --> API[Agent routes<br/>validate request and resolve mission]
    API --> Coverage{Manual mode and<br/>related cases exist?}
    Coverage -->|yes| Choice[Coverage options<br/>reuse / gaps / fresh]
    Choice --> API
    Coverage -->|no| Runtime[Workflow runtime]

    subgraph LG[Live execution authority: LangGraph]
        Runtime --> Pump[Background stream pump]
        Pump --> TestRun[TestRunGraph]
        TestRun <--> State[(Checkpointed WorkflowState)]
        TestRun <--> Stash[(Run artifact stash)]
        TestRun -->|model-backed nodes| AgentOrchestrator[AgentOrchestrator]
        State --> Saver{Checkpointer}
        Saver -->|production| PGCP[(PostgreSQL checkpoints)]
        Saver -->|development / test| Memory[(MemorySaver)]
    end

    subgraph Codex[Model execution plane: Codex]
        AgentOrchestrator --> Provider[CodexProvider]
        Provider --> CodexRuntime[CodexRuntime]
        CodexRuntime -->|ordinary and structured turns| SDK[Codex SDK]
        CodexRuntime -->|MCP tool turns and approvals| AppServer[Codex App Server]
        AppServer <--> MCP[Loopback-only scoped MCP bridge]
        MCP --> AppTools[Application tools]
        CodexRuntime <--> Threads[(Codex thread mappings)]
    end

    Pump --> Projection[Legacy run projection]
    Projection --> RunDB[(Agent run store)]
    RunDB --> SSE[SSE / polling status]
    SSE --> User
    Pump --> FinalArtifacts[Plan, suite, cases,<br/>run, report, defects]

    subgraph Native[Optional agent-native coordination: AGENT_NATIVE_V1]
        API -.->|start notification| Orchestrator[Orchestrator]
        Orchestrator -.->|request| Router[Router agent]
        Router -.->|validates names| Registry[Agent registry]
        Router -.->|routing plan| Orchestrator
        Orchestrator -.->|delegates| Specialists[Registered specialists]
        Orchestrator -.->|routing.plan| Blackboard[(Blackboard)]
        Pump -.->|stage handoffs and results| Bus[(Message bus)]
        Pump -.->|stage facts| Blackboard
    end

    NativeNote[The coordination layer observes and announces work;<br/>it does not choose LangGraph edges.]:::note
    NativeNote -.-> Native

    classDef note fill:#fff8dc,stroke:#b8860b,color:#333;
```

## 2. The live `TestRunGraph`

```mermaid
flowchart TD
    Start((START)) --> Context[load_context<br/>MetadataFetch]
    Context --> Discover[discover_and_ground<br/>ApplicationInspector]

    Discover --> Gate{Evidence gate}
    Gate -->|continue| Cases[author_cases<br/>TestGenerationAgent]
    Gate -->|targeted_retry<br/>bounded| Discover
    Gate -->|blocked| Finalize[finalize<br/>QAAnalyst]

    Cases --> CasesRoute{Cases produced?}
    CasesRoute -->|none| Finalize
    CasesRoute -->|auto review policy| Plans[author_plans<br/>PlaywrightAgent]
    CasesRoute -->|manual review policy| Review[review_cases<br/>ReviewAgent interrupt]

    Review --> ReviewRoute{Human decision}
    ReviewRoute -->|rejected| Finalize
    ReviewRoute -->|revised and retry available| Cases
    ReviewRoute -->|approved or retry exhausted| Plans

    Plans --> Compile[compile_and_validate<br/>SelectorVerifier]
    Compile --> CompileRoute{Compilation result}
    CompileRoute -->|unresolved targets and<br/>rediscovery available| Discover
    CompileRoute -->|no runnable scripts| Finalize
    CompileRoute -->|runnable scripts| Execute[execute_tests<br/>EvidenceAgent]

    Execute --> ExecRoute{Investigation enabled and<br/>failure or mutation pass?}
    ExecRoute -->|yes| Investigate[investigate_failures<br/>InvestigatorAgent]
    ExecRoute -->|no| Finalize
    Investigate --> Finalize
    Finalize --> End((END))

    classDef human fill:#fff2cc,stroke:#b8860b,color:#333;
    class Review human;
```

Important details:

- Rediscovery is bounded by `MAX_REDISCOVERY_ATTEMPTS`; the graph cannot loop forever.
- Per-case plans are authored with bounded concurrency, then merged into state by case ID.
- Compilation is deterministic and only emits runnable scripts when selectors pass validation.
- Script review is not a node in the compiled graph. The current source header still mentions `review_scripts`, but the actual `StateGraph` does not register it.
- Failure investigation is conditional on its feature flag and the execution outcome.

## 3. Agent ownership versus actual execution

```mermaid
flowchart LR
    subgraph GraphStages[LangGraph stages]
        S1[load_context]
        S2[discover_and_ground]
        S3[author_cases]
        S4[review_cases]
        S5[author_plans]
        S6[compile_and_validate]
        S7[execute_tests]
        S8[investigate_failures]
        S9[finalize]
    end

    subgraph Owners[Agent identity shown on bus / console]
        A1[MetadataFetch]
        A2[ApplicationInspector]
        A3[TestGenerationAgent]
        A4[ReviewAgent]
        A5[PlaywrightAgent]
        A6[SelectorVerifier]
        A7[EvidenceAgent]
        A8[InvestigatorAgent]
        A9[QAAnalyst]
    end

    S1 --> A1
    S2 --> A2
    S3 --> A3
    S4 --> A4
    S5 --> A5
    S6 --> A6
    S7 --> A7
    S8 --> A8
    S9 --> A9

    Owners --> Meaning[These identities voice stage ownership and results.<br/>The graph node still owns sequencing.]
```

The registry also contains callable roles such as `caseWriter`, `testPlanner`, `chatAssistant`, `CriticAgent`, and `playwrightCoder`. `runRegisteredAgent()` can execute a registered role through the existing model tool loop, but that seam is currently described and wired as shadow-mode coordination rather than the authority for the live deep-run graph.

## 4. How the orchestrator and agents communicate

There are three different communication paths. They should not be treated as one mechanism:

1. **Control path:** LangGraph passes checkpointed `WorkflowState` between nodes and evaluates conditional edges. This is what actually advances or stops a run.
2. **Coordination path:** the message bus records addressed agent messages; the blackboard stores shared, append-only facts. This path is active only when `AGENT_NATIVE_V1` is enabled and is currently mostly delegation and observability.
3. **Execution path:** a model-backed specialist calls Codex. If tools are required, Codex calls only the allowed backend tools through the scoped MCP bridge.

```mermaid
sequenceDiagram
    actor User
    participant API as Agent routes
    participant Orch as Orchestrator
    participant Router as Router agent
    participant Bus as Message bus
    participant BB as Blackboard
    participant Graph as LangGraph runtime
    participant Agent as Stage specialist
    participant Codex as Codex runtime
    participant Tools as Scoped application tools

    User->>API: Start run with goal
    API->>Orch: orchestrateRunStart(runId, goal)
    Orch->>Bus: REQUEST to Router
    Orch->>Router: Ask for minimum routing plan
    Router->>Router: Classify goal and validate agent names against registry
    Router->>Bus: RESULT to Orchestrator, linked to REQUEST
    Router-->>Orch: Validated routing plan
    loop Each planned specialist
        Orch->>Bus: DELEGATE task to specialist
    end
    Orch->>BB: Write routing.plan with provenance

    Note over Orch,BB: The routing exchange is flag-gated and does not choose graph edges
    API->>Graph: startGraphRun(...)

    loop Every LangGraph stage transition
        Graph->>Graph: Node updates WorkflowState
        Graph->>Bus: HANDOFF from Orchestrator to stage specialist
        Graph->>BB: Append run.stage fact
        opt Model-backed work
            Graph->>Agent: Invoke specialist behavior
            Agent->>Codex: Prompt / structured turn
            opt Allowed tools required
                Codex->>Tools: MCP tool call
                Tools-->>Codex: Scoped result or visible error
            end
            Codex-->>Agent: Text or schema-valid result
            Agent-->>Graph: Node state update
        end
        Graph->>Bus: RESULT from completed specialist to Orchestrator
        Graph->>BB: Append stage.result fact
    end

    opt Critic refutes authored cases
        Agent->>Bus: CRITIQUE directly to author
        Agent->>BB: Append critic verdicts
    end

    Graph-->>API: Final projected run state
    API-->>User: completed / failed / cancelled
```

### Message contract

| Message | Meaning | Current use |
|---|---|---|
| `REQUEST` | Ask another agent for a decision or result | Orchestrator asks Router for a routing plan |
| `RESULT` | Return a result, normally linked by `causationId` | Router, stage specialists, critic, grounding, and deterministic capabilities report outcomes |
| `DELEGATE` | Ask a specialist or deterministic capability for a bounded sub-result | Orchestrator announces planned specialists and delegates compile/execute capabilities |
| `HANDOFF` | Transfer ownership of the current unit of work | Orchestrator hands each graph stage to its displayed specialist; `runRegisteredAgent()` also uses it |
| `CRITIQUE` | Refute or request correction of another agent's draft | `CriticAgent` sends case feedback directly to the author |
| `QUESTION` / `ANSWER` | Contract for clarification exchanges | Defined and persisted by the bus, but no current production publisher uses them |

Every bus message contains `runId`, per-run `seq`, `from`, `to`, `type`, `payload`, timestamp, and optional `causationId`. `to: null` is a broadcast. The bus enforces a per-run message budget and maximum causation depth to prevent runaway agent chatter.

The blackboard is not another chat channel. It is the shared fact store: agents append facts such as `routing.plan`, `run.stage`, `stage.result.*`, grounding evidence, critic verdicts, and capability results. Each fact records who wrote it, when, and which message caused it. PostgreSQL backs both channels when configured; development and tests use in-memory implementations.

### Current authority boundary

```mermaid
flowchart LR
    Router[Router agent plan] -.->|advisory delegation| Bus[(Message bus)]
    Bus -.->|observable handoffs| Agents[Specialist identities]
    Agents -.->|results and critique| BB[(Blackboard facts)]

    LG[LangGraph conditional edges] --> Decision[Actual next-stage decision]
    WS[(WorkflowState)] --> LG
    Decision --> Node[Next graph node]

    Codex[Codex reasoning inside a turn] --> Output[Proposed cases / plans / analysis]
    Output --> Gates[Application validation and evidence gates]
    Gates --> WS

    Truth[Authority today:<br/>LangGraph + deterministic gates]:::truth
    Truth --> LG
    classDef truth fill:#e2f0d9,stroke:#548235,color:#333;
```

This means a bus `DELEGATE` or `HANDOFF` does not itself execute or advance the workflow. The corresponding LangGraph node does. Likewise, a Codex answer is proposed content until the node's schema, evidence, selector, compiler, or execution gate accepts it.

## 5. Codex SDK and App Server execution

```mermaid
flowchart TD
    Node[LangGraph node or registered agent] --> Orch[AgentOrchestrator<br/>guardrails, prompts, usage, tracing]
    Orch --> Provider[CodexProvider<br/>existing AIProvider contract]
    Provider --> Runtime[CodexRuntime]

    Runtime --> ToolCheck{Scoped application<br/>tools required?}
    ToolCheck -->|no| SDK[Official TypeScript Codex SDK]
    SDK --> SDKTurn[Text / structured output / streaming<br/>abort / start or resume thread]

    ToolCheck -->|yes| AppServer[Codex App Server over stdio]
    AppServer --> Approval[MCP approval handling]
    Approval --> Bridge[Loopback MCP bridge<br/>token + secret path + allowlist]
    Bridge --> Tools[Backend application tools]
    Tools --> Bridge
    Bridge --> AppServer

    SDKTurn --> Result[Normalized Codex events and result]
    AppServer --> Result
    Result --> Orch
    Orch --> Node

    Runtime <--> ThreadMap[(codex_threads<br/>conversationId + agent to threadId)]
```

The transport selector defaults to `CODEX_TRANSPORT=auto`:

- No MCP servers: use `@openai/codex-sdk`.
- Scoped MCP tools present: use App Server so tool approvals can be answered.
- SDK thread-store conflict before any event is emitted: fall back to App Server.
- `CODEX_TRANSPORT=sdk` or `app-server`: force a transport for testing or rollback.

Codex decides how to reason within an individual model turn and, for MCP turns, which allowed tool to call. It does not own workflow routing, evidence verification, selector acceptance, compilation gates, or final run status; those remain application and LangGraph responsibilities. The official [Codex SDK documentation](https://developers.openai.com/codex/sdk/) describes the SDK as the server-side TypeScript interface for starting, continuing, and resuming coding-focused threads.

## 6. Start, interrupt, and resume sequence

```mermaid
sequenceDiagram
    actor User
    participant API as Agent routes
    participant Runtime as Workflow runtime
    participant Graph as TestRunGraph
    participant CP as Checkpointer
    participant Store as Agent run store
    participant UI as SSE / Console

    User->>API: Start test-generation run
    API->>API: Resolve target, mission, credentials, quota
    API-->>User: task_id
    API->>Runtime: startGraphRun(...)
    Runtime->>CP: Create thread using runId
    Runtime->>Graph: stream(initial state)

    loop After each emitted state
        Graph->>CP: Save checkpoint
        Graph-->>Runtime: WorkflowState value
        Runtime->>Store: Project and persist legacy-compatible run
        Store-->>UI: Status becomes visible
    end

    alt Manual case review
        Graph->>CP: interrupt(pending review)
        Runtime->>Store: status = review_required
        UI-->>User: Review cases
        User->>API: Approve, revise, or reject
        API->>Runtime: resumeGraphRun(runId, resolution)
        Runtime->>Graph: Command({ resume: resolution })
        Graph->>CP: Continue same thread
    else Automatic review policy
        Graph->>Graph: Continue directly to author_plans
    end

    Graph-->>Runtime: Final state
    Runtime->>Store: Persist final projection and QA artifacts
    Store-->>UI: completed / failed / cancelled
    UI-->>User: Final result
```

## 7. What travels through the graph

```mermaid
flowchart TB
    Request[Request<br/>goal, understanding, review policy] --> WS[(WorkflowState)]
    Mission[Mission reference<br/>target URL, app, module] --> WS

    WS --> Context[Context summary]
    WS --> Evidence[Bounded evidence and gate]
    WS --> Cases[Test cases]
    WS --> Plans[Per-case plan results]
    WS --> Compilation[Script refs and diagnostics]
    WS --> Execution[Attempts, aggregate, evidence refs]
    WS --> Review[Interrupt correlation and decision]
    WS --> Diagnostics[Errors, usage, output]

    Secret[Resolved credential] -.->|just in time only| Nodes[Graph nodes]
    Secret -.->|never checkpointed| NoSecret[No secret in WorkflowState]:::safe

    Raw[Large or sensitive runtime artifacts<br/>raw DOM elements, evidence graph,<br/>metadata map, full plans, source code] --> Stash[(Run artifact stash)]
    Nodes <--> Stash
    Stash -.->|refs and digests only| WS

    classDef safe fill:#e2f0d9,stroke:#548235,color:#333;
```

This split is intentional: checkpointed state stays bounded and resumable, while large artifacts remain outside the LangGraph state. The tradeoff is that the in-process stash may need rediscovery after a process restart; the agent-native run-store mirror is the incremental path toward making those shared artifacts durable.

## Source map

- Live graph topology and routers: `server/features/agent/workflow/testRunGraph.ts`
- Workflow state and reducers: `server/features/agent/workflow/state.ts`
- Start/resume/cancel and stream pump: `server/features/agent/workflow/runtime.ts`
- PostgreSQL/MemorySaver selection: `server/features/agent/workflow/checkpointer.ts`
- API cutover and coverage gate: `server/features/agent/routes.ts`
- Router decision and registry validation: `server/agent-core/router/routerAgent.ts`
- Start-of-run delegation: `server/agent-core/router/orchestrateRun.ts`
- Agent registry: `server/agent-core/registry/agents.ts`
- Stage-to-agent projection: `server/agent-core/bus/runInstrumentation.ts`
- Typed agent message contract and persistence: `server/agent-core/bus/messageBus.ts`
- Shared fact/provenance store: `server/agent-core/bus/blackboard.ts`
- Deterministic capability delegation: `server/agent-core/registry/capabilities.ts`
- Critic-to-author communication: `server/agent-core/critic/caseCritic.ts`
- Registered-agent execution seam: `server/agent-core/registry/runViaBus.ts`
- Codex runtime and transport selection: `server/ai/codex/runtime.ts`
- Official Codex SDK adapter: `server/ai/codex/sdkClient.ts`
- Approval-capable App Server client: `server/ai/codex/appServerClient.ts`
- Scoped application-tool bridge: `server/ai/codex/mcpBridge.ts`
- Codex provider adapter: `server/ai/providers/codex.ts`
- Prompt, guardrail, tracing, and tool-loop boundary: `server/ai/orchestrator.ts`
- Runtime operations guide: `docs/CODEX-RUNTIME.md`
