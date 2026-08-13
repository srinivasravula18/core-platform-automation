# Codex Runtime Migration — Phase 0 Implementation Plan

**Status: ANALYSIS ONLY. No implementation, dependency installation, schema change, refactor, commit, or pull request is authorized.**

## 1. Executive Summary

Replace Gemini, Anthropic, OpenAI API, and ad-hoc CLI transports with one Codex runtime for every Agent Console agent.

The correct target is not “Codex SDK alone”:

- Use the Codex SDK for ordinary backend agent turns.
- Use Codex App Server over local `stdio` for Agent Console streaming, thread history, cancellation, structured output, and approvals.
- Expose existing scoped application tools to Codex through an internal authenticated MCP bridge.
- Keep deterministic routing, guardrails, evidence validation, LangGraph workflow state, and artifact persistence in this application.

This follows the official boundary: Codex SDK is for programmatic coding-focused threads, while App Server is intended for rich product integrations with history, approvals, and streamed events. `codex mcp-server` is instead for making Codex a specialist inside a separate Agents SDK workflow, which would introduce a second orchestrator and is not recommended here.

Official references:

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Use Codex with the Agents SDK / MCP Server](https://learn.chatgpt.com/docs/mcp-server)

## 2. Existing Architecture

Agent Console currently has four model paths:

1. Goal routing through `server/agent-runtime/goals/router.ts`.
2. Conversational supervision through `server/ai/supervisor.ts`.
3. Specialized generation through the shared `AgentOrchestrator` in `server/ai/orchestrator.ts`.
4. LangGraph authoring and research nodes that bypass the orchestrator and call provider transports directly in `server/features/agent/workflow/nodes/authoring.ts` and `server/features/agent/workflow/sourceResearchGraph.ts`.

The common provider abstraction supports Gemini, OpenAI, and Anthropic in `server/ai/providers/types.ts`. `buildProvider()` additionally supports Codex and Claude CLI account modes, but those emulate tool calling and spawn a process per call.

The UI exposes provider selection globally and per agent through:

- `src/pages/Settings.tsx`
- `src/pages/AgentConsole.tsx`
- `src/components/TopbarActions.tsx`

## 3. Dependency Graph

```text
AgentConsole
 ├─ /api/agent/goal
 │   └─ goalRouter → AgentOrchestrator → traditional provider SDK
 ├─ /api/controller/supervise/stream
 │   └─ Supervisor → custom tool loop → AgentOrchestrator
 └─ /api/agent/start
     └─ LangGraph workflow
         ├─ shared AgentOrchestrator calls
         └─ direct OpenAI Responses/provider calls

Proposed
AgentConsole
 ├─ deterministic goal router
 ├─ Codex App Server thread
 │   ├─ streamed events
 │   ├─ structured output
 │   └─ scoped internal MCP tools
 └─ existing LangGraph workflow
     └─ Codex runtime adapter for every model turn
```

## 4. Runtime Flow

Proposed console flow:

1. Receive the message and resolve user/project/application scope.
2. Run existing deterministic guards and routing safety rules.
3. Start or resume the Codex thread associated with the application conversation.
4. Start an App Server turn using:
   - read-only sandbox;
   - selected Codex model and reasoning effort;
   - role-specific developer instructions;
   - structured output schema where required;
   - scoped MCP server configuration.
5. Translate App Server notifications into the existing Agent Console SSE format.
6. Execute domain tool calls through the scoped MCP bridge.
7. Persist the final answer and Codex thread mapping.
8. Interrupt the App Server turn when the user presses Stop.

App Server already defines thread start/resume, turn start, incremental agent-message deltas, turn completion, and interruption. WebSocket mode is explicitly experimental, so the initial implementation should use local `stdio`.

## 5. Evidence Flow

Evidence collection remains application-owned:

```text
DOM / metadata / source / execution
              ↓
Existing evidence and provenance gates
              ↓
Bounded prompt or MCP tool result
              ↓
Codex agent
              ↓
Strict schema validation
              ↓
Existing compiler and execution gates
```

Codex must not become the authority for whether evidence is verified. Existing provenance rules, compiler validation, selector verification, and “verified evidence only” gates remain authoritative.

Raw evidence should continue to be stored in application artifacts rather than Codex thread history. Codex receives bounded summaries or fetches explicit artifacts through MCP.

## 6. Context Flow

- Application conversation IDs remain the public identity.
- A new mapping connects `{conversationId, canonicalAgent}` to a Codex thread ID.
- Existing `assembleConversationContext()` remains during migration for legacy history and artifact recall.
- Persistent Codex threads become the primary conversational history after cutover.
- Run-specific agents use ephemeral threads unless a workflow explicitly needs resumption.
- Context manifests remain for auditability; they record what application context was supplied independently of Codex’s internal compaction.

Codex thread data is local to the runtime unless deliberately externalized. Multi-instance deployment therefore requires worker affinity or shared Codex runtime storage before horizontal scaling.

## 7. Prompt Flow

Existing canonical role prompts remain the source of role behavior:

```text
Core guardrails
+ canonical agent prompt
+ scoped context/evidence
+ current task
+ output schema
→ Codex turn
```

Do not copy prompts into `.codex/agents` during the initial migration. Continue using `server/ai/systemPrompts.ts` and the existing prompt-version store so Settings and rollback remain functional.

For structured generation, use App Server’s documented `outputSchema`, followed by existing Zod/domain validation. Do not depend only on “return JSON” prompting.

## 8. Current Problems

- Four provider transports implement overlapping generation, streaming, structured output, retries, usage, and tool-call behavior.
- CLI account mode emulates tool calling instead of receiving native tool events.
- Tool-capable requests can silently switch to a different configured API-key provider.
- App conversation history and model thread history are separate.
- The Agent Console receives application-defined “step” events rather than native runtime events.
- LangGraph authoring bypasses the shared orchestrator.
- Provider/model settings allow combinations that will no longer be meaningful.
- Retry ownership is split across provider SDKs, orchestrator code, and graph nodes.
- Direct provider dependencies remain embedded in production paths.

## 9. Root Cause Analysis

The main cause is not individual SDK usage; it is that provider selection, model execution, tool orchestration, structured output, and console session handling evolved as separate layers.

Replacing imports at call sites would leave:

- the custom tool loop;
- direct workflow bypasses;
- duplicated retry logic;
- provider-specific settings;
- split conversation state.

The minimum root-level fix is a single Codex runtime seam at the orchestrator plus explicit migration of the two direct provider bypasses.

## 10. Proposed Architecture

Create one `CodexRuntime` with two transports:

- `CodexSdkTransport`: ordinary non-streamed backend turns.
- `CodexAppServerTransport`: streaming, structured output, persistent threads, approvals, interruption, and MCP events.

Both expose an application-facing surface equivalent to:

```ts
runText()
runStructured()
runThread()
streamThread()
interrupt()
health()
```

The existing `AgentOrchestrator` retains guardrails, prompt assembly, usage recording, tracing, and canonical agent identity. It delegates model work to `CodexRuntime`.

An internal loopback-only MCP endpoint exposes selected existing `AgentTool`s. Each session receives a random, short-lived scope token tied to user, project, app, conversation, allowed tool names, and expiry. The tool implementation continues running in the main application process, preserving current in-memory and PostgreSQL behavior.

Skipped deliberately:

- Agents SDK orchestration;
- `codex mcp-server` as another agent layer;
- WebSocket App Server transport;
- rewriting LangGraph;
- new agent registries or factories.

## 11. Complete Refactoring Strategy

1. Add the Codex runtime without routing traffic to it.
2. Add contract tests for text, structured output, streaming, cancellation, and health.
3. Add `codex` as a provider/runtime option while retaining legacy providers behind a flag.
4. Move all shared-orchestrator consumers to Codex by changing the shared boundary.
5. Integrate persistent Agent Console threads and native event streaming.
6. Add scoped MCP access for existing tools.
7. Migrate the two workflow paths that directly call provider SDKs.
8. Canary Codex per agent, then make it the default for all agents.
9. Remove traditional provider dependencies and dead provider files after the rollback window.

## 12. Every File That Must Change

| File | Planned change |
|---|---|
| `package.json` | Add `@openai/codex-sdk`; add checks; later remove traditional SDKs |
| `package-lock.json` | Lock dependency changes |
| `server/ai/providers/types.ts` | Add Codex identity/capabilities while retaining transitional compatibility |
| `server/ai/providers/codex.ts` | New adapter implementing the existing provider contract |
| `server/ai/codex/appServerClient.ts` | New stdio JSON-RPC client and event mapper |
| `server/ai/orchestrator.ts` | Route every shared agent through Codex; preserve guards, usage, traces |
| `server/shared/storage.ts` | Normalize Codex settings and legacy stored provider data |
| `server/features/settings/aiRoutes.ts` | Expose Codex health/auth/model state |
| `src/pages/Settings.tsx` | Replace three-provider configuration with Codex runtime configuration |
| `src/pages/AgentConsole.tsx` | Use Codex model/effort and native streamed events |
| `src/components/TopbarActions.tsx` | Remove provider selection; retain model/effort |
| `.env.example` | Document Codex runtime/auth/feature flags |
| `scripts/test-codex-runtime.ts` | New adapter contract check |
| `server/db/schema.sql` | Add idempotent Codex thread mapping table |
| `server/db/repository.ts` | Read/write thread mappings |
| `server/ai/codex/mcpBridge.ts` | Scoped in-process MCP bridge |
| `server/features/controller/routes.ts` | Create MCP sessions and forward native App Server events |
| `server/ai/supervisor.ts` | Replace custom provider tool loop with Codex thread execution |
| `scripts/test-codex-supervisor.ts` | Tool, scope, stream, and cancellation regression check |
| `server/features/agent/workflow/nodes/authoring.ts` | Remove direct Responses/provider branch |
| `server/features/agent/workflow/sourceResearchGraph.ts` | Remove second direct provider branch |
| `scripts/test-agent-authoring-graph.ts` | Verify strict authoring remains compatible |
| `scripts/test-agent-discovery-graph.ts` | Verify research/evidence behavior |
| `server/shared/ai.ts` | Remove Gemini construction and provider-specific operational messages |
| `server/features/resources/routes.ts` | Remove unused Vercel AI import |
| `core/llm/index.ts` | Export Codex runtime identity instead of provider selection concepts |
| `docs/AI-CLI-PROVIDER-INTEGRATION.md` | Replace obsolete CLI-provider design with Codex runtime operations |
| `docs/PLAYWRIGHT-MCP-SERVER.md` | Document Codex-managed MCP loading and scope |
| `server/ai/providers/openai.ts` | Delete after canary |
| `server/ai/providers/anthropic.ts` | Delete after canary |
| `server/ai/providers/gemini.ts` | Delete after canary |
| `server/ai/providers/cli.ts` | Delete after canary |
| `server/ai/openai/responsesClient.ts` | Delete after workflow migration |
| `server/ai/openai/promptBudget.ts` | Delete or relocate only if still required |
| `scripts/test-openai-responses.ts` | Replace with Codex structured-output coverage |
| `scripts/check-gemini-key.mjs` | Delete after migration |
| `scripts/check-gemini-rest.mjs` | Delete after migration |

No `agent/` desktop files are in scope, so its version does not need incrementing.

## 13. Why Each File Must Change

- Runtime and provider files establish the single model-execution seam.
- Settings and UI files remove provider combinations that cease to be valid.
- Database files preserve Codex thread identity across requests and restarts.
- Supervisor and controller files connect native Codex events and tools to the existing console contract.
- Workflow files remove direct provider bypasses so “all agents” is actually true.
- Tests protect routing, strict output, scoping, evidence, cancellation, and regression behavior.
- Cleanup files remove unused SDKs only after the canary and rollback window.
- Documentation files replace operational instructions that would otherwise direct operators to obsolete provider paths.

## 14. Risk Level Per File

| File/group | Risk |
|---|---:|
| `server/ai/orchestrator.ts` | Critical |
| `server/ai/codex/appServerClient.ts` | High |
| `server/ai/codex/mcpBridge.ts` | Critical |
| `server/ai/supervisor.ts` | Critical |
| `server/features/agent/workflow/nodes/authoring.ts` | Critical |
| `server/features/agent/workflow/sourceResearchGraph.ts` | High |
| `server/db/schema.sql`, `server/db/repository.ts` | High |
| Settings/storage/API normalization | High |
| Agent Console event integration | High |
| Provider-file deletion | High |
| Dependency lock changes | Medium |
| UI provider-control simplification | Medium |
| Tests and documentation | Low–Medium |

## 15. Backward Compatibility Concerns

- Preserve existing HTTP endpoints and Agent Console response/card shapes.
- Preserve canonical agent names and prompt versions.
- Preserve LangGraph checkpoints and application conversation IDs.
- Treat stored Gemini/OpenAI/Anthropic settings as legacy data; do not destroy stored keys during initial rollout.
- Add a temporary `CODEX_AGENT_RUNTIME` feature flag with `legacy`, `canary`, and `codex` modes.
- Existing runs remain attached to the engine that created them.
- Do not resume a legacy custom-tool-loop session as a Codex thread.
- Existing provider usage history remains readable.

## 16. Migration Strategy

- Dark launch Codex runtime health checks first.
- Canary informational Agent Console answers.
- Canary structured router and case generation.
- Canary read-only MCP research.
- Canary mutation tools only after scope and replay tests pass.
- Migrate graph authoring last because it is evidence and execution critical.
- Make Codex the default only after representative live runs succeed.
- Retain legacy providers for one release, then remove their code and dependencies.

## 17. Testing Strategy

Required checks:

- SDK/App Server startup and authentication failure classification.
- Text and strict structured output.
- Thread start, resume, fork isolation, and stale mapping recovery.
- SSE delta ordering and one final event.
- Stop button maps to `turn/interrupt`.
- MCP tool allowlist and cross-user/project/app denial.
- Tool errors remain visible to Codex.
- Repeated tool requests do not duplicate mutations.
- Prompt overrides and guardrails still apply.
- Usage and trace records identify agent, model, run, and thread.
- Existing routing, conversation, evidence, authoring, compiler, execution, and UI tests pass.
- Build, typecheck, no broken imports, and no circular dependencies.
- Live verification: DOM inspection, repo grounding, metadata, prompt/context assembly, validation gates, and verified-evidence-only Playwright generation.

## 18. Rollback Strategy

- Set `CODEX_AGENT_RUNTIME=legacy` for new work.
- Do not delete Codex thread mappings or application conversations.
- Existing active Codex turns may finish or be interrupted; they are never transferred into legacy provider history.
- Keep schema changes additive.
- Keep old provider settings untouched through the rollback window.
- Re-enable legacy providers without changing public APIs.
- After provider-file deletion, rollback requires deploying the preceding release rather than reversing database changes.

## 19. Estimated Implementation Effort

- Phase 1 runtime foundation: 3–5 days.
- Phase 2 console threads, streaming, and MCP bridge: 5–8 days.
- Phase 3 workflow migration: 3–5 days.
- Phase 4 canary, cleanup, and production readiness: 3–5 days plus soak.

Total: approximately 14–23 engineering days. The largest uncertainty is secure MCP configuration and Codex runtime/thread storage in the production topology.

## 20. Recommended Implementation Order

### Phase 1 — Codex runtime seam

Files: 13. Risk: High.

- [ ] Add Codex SDK and runtime adapter.
- [ ] Add App Server stdio client.
- [ ] Add `codex` settings identity.
- [ ] Add runtime health and contract check.
- [ ] Keep all production traffic legacy.
- [ ] Build and typecheck.

### Phase 2 — Agent Console and tools

Files: 8–10. Risk: Critical; one subsystem.

- [ ] Add durable thread mapping.
- [ ] Add scoped internal MCP bridge.
- [ ] Replace Supervisor custom tool loop.
- [ ] Translate App Server events to current SSE.
- [ ] Implement cancellation and restart behavior.
- [ ] Run conversation, concurrency, scope, and tool tests.

### Phase 3 — Specialized workflow agents

Files: 4–6. Risk: Critical; one subsystem.

- [ ] Migrate strict authoring.
- [ ] Migrate source research.
- [ ] Verify evidence and context are unchanged.
- [ ] Run graph, compiler, grounding, and execution regressions.
- [ ] Canary representative real application runs.

### Phase 4 — Default cutover and cleanup

Files: 10–15. Risk: High.

- [ ] Make Codex the only enabled agent runtime.
- [ ] Remove traditional SDK/provider files and dependencies.
- [ ] Remove obsolete provider controls and diagnostics.
- [ ] Update operational documentation.
- [ ] Run full build/test/live verification.
- [ ] Rehearse rollback.
- [ ] Produce the production-readiness report.

---

Implementation remains paused under the repository’s Phase 0 rule. A later-turn approval must name the phase, preferably: **“Approve Phase 1 — Codex runtime seam.”**

---

# Historical App Server-only outcome (superseded on 2026-08-12)

> This section records the first implementation pass. The current SDK-first outcome below supersedes its transport and dependency decisions.

All four phases are built, tested, and live-verified. Two decisions changed during
implementation, both forced by what the runtime actually does:

## 1. App Server is the ONLY transport — the Codex SDK was not used

The plan proposed `@openai/codex-sdk` for ordinary turns and App Server for the console.
The SDK was installed, wired, and passed a full contract check (text, structured output,
streaming, cancellation, thread resume) — but it drives `codex exec`, which **auto-cancels
every native MCP tool call** with `user cancelled MCP tool call`. A tool call raises an
approval request, and `codex exec` has no client to answer it. No config avoids this:
`approval_policy` (`never` / `on-request` / `on-failure` / granular),
`default_tools_approval_mode` (`auto` / `writes`), and per-server `apps.*` settings were all
tested and all still cancelled. The only documented `codex exec` workaround is
`--dangerously-bypass-approvals-and-sandbox`, which removes the sandbox entirely — not
acceptable for a server-side agent.

The App Server sends the approval to us as `mcpServer/elicitation/request`, which the client
answers with `{action:'accept'}`. So the SDK was removed and every turn now runs on the app
server. One transport instead of two, and one fewer dependency.

## 2. Legacy providers were deleted, not flag-gated

The plan kept Gemini/OpenAI/Anthropic behind `CODEX_AGENT_RUNTIME` for a rollback window.
On instruction, the redundant code was removed instead: `ProviderName` is now `'codex'`, the
four provider adapters, the OpenAI Responses client, the emulated `chatWithTools` protocol,
and the `@ai-sdk/google` / `@anthropic-ai/sdk` / `@google/genai` / `ai` / `openai` /
`@openai/codex-sdk` dependencies are gone. Rollback is therefore "deploy the previous
release", as Section 18 already anticipated for the post-deletion state. Stored provider
settings are not destroyed: an OpenAI key found in the legacy block is carried into the Codex
runtime's API-key mode on load.

## Deviations from the file list in Section 12

- `server/ai/codex/appServerClient.ts` grew from an introspection client into the full
  transport (threads, turns, notifications, approvals).
- `server/ai/supervisor.ts` and `server/features/controller/routes.ts` needed only the removal
  of their account-mode prompt-flattening branches. The tool loop was replaced once, inside
  `AgentOrchestrator.runToolLoop`, which upgraded every caller at a single seam.
- `server/ai/openai/promptBudget.ts` was deleted (unreferenced), not relocated.
- `docs/AI-CLI-PROVIDER-INTEGRATION.md` was replaced by `docs/CODEX-RUNTIME.md`.
- No `CODEX_AGENT_RUNTIME` flag exists, per decision 2.

## Security posture of the MCP bridge

Application tools run in-process and are exposed to Codex over a loopback-only listener.
Layers: ephemeral `127.0.0.1` port; a per-process bearer token given only to our Codex process
via env; a 32-byte random session path revoked when the turn ends; a per-session tool allowlist
and pinned user/project/app scope; a tool-call ceiling from `maxSteps`. The client approves
**only** `testflow` tool calls — sandbox escapes, shell escalation, and file writes are always
denied.

The bearer token is per-process rather than per-session because the CLI reads it from the
environment at startup; a per-session token would force a restart and kill any in-flight turn.
Per-turn secrecy is the session path instead.

# Current implementation outcome (2026-08-12)

The official `@openai/codex-sdk` `0.147.0` is now the ordinary-turn data plane behind the existing
`CodexRuntime` seam. Live compatibility passed text, structured output, streamed events, abort,
SDK resume, App Server-to-SDK resume, and strict production runtime routing. Account mode discovers
a model from App Server instead of inheriting an unsupported host-only default.

Tool-capable turns remain on App Server: the live compatibility gate reported
`sdkMcpApproval=false`, while the grounded scoped bridge loop passed through App Server. Phase 4
removal is therefore skipped by its approved condition. `CODEX_TRANSPORT=app-server` is the
immediate rollback; `auto` is the SDK-first default and `sdk` is strict compatibility testing.

## Verification

- `npm run lint` and `npm run build` pass; the CommonJS backend bundle resolves the SDK's bundled Codex binary without `import.meta` warnings.
- `test:codex-sdk-compat` passed 10/10 while the ChatGPT account session was active; it proved text, structured output, streaming, abort, resume, cross-transport resume, usage, and strict SDK routing.
- `test:codex-mcp-bridge` passed 19/19. A grounded App Server tool loop passed 8/8 before the local Codex session ended.
- Grounding, evidence, authoring, workflow-state, compiler, and structured-truncation regressions pass.
- The backend was restarted and `GET /api/health` returns `{ ok: true, service: testflowai-backend }`.
- The local Codex CLI is currently logged out. Reconnect the ChatGPT account, then rerun `npm run test:codex-tool-loop` for the final live account check.
