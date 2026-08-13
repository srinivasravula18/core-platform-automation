# Codex SDK + MCP + A2A Runtime — Phase 0 Implementation Plan

**Status: ANALYSIS ONLY.** No implementation, dependency install, schema change, refactor, commit, or PR
is authorized by this document. Approval must name a phase on a later turn.

**Decision taken:** the transport is `@openai/codex-sdk`. Agents reach application capability through
MCP. Orchestration becomes agent-to-agent. This document plans that, and states plainly what it costs.

## 1. Executive Summary

Move every agent turn onto the Codex SDK, keep the scoped MCP bridge as the tool surface, and replace
the LangGraph run pipeline with specialized agents that hand off to each other.

Three facts, all measured against the real binary rather than inferred from docs, govern the plan:

**(a) The SDK can call MCP tools — but only outside a restricted sandbox.**

| `codex exec` configuration (what the SDK drives) | Nested MCP tool call |
|---|---|
| `--sandbox read-only` + `approval_policy="never"` | ❌ `user cancelled MCP tool call` |
| `--sandbox read-only` + `tools.shell=false` | ❌ cancelled |
| **`--sandbox danger-full-access` + `approval_policy="never"`** | ✅ **executes** |
| `--dangerously-bypass-approvals-and-sandbox` | ✅ executes |

The trigger is the sandbox, not the approval policy. `sandboxMode: 'danger-full-access'` is a
first-class `ThreadOptions` field, so this is pure SDK.

**(b) Codex's built-in shell cannot be disabled.** `tools.shell=false` and
`shell_environment_policy.inherit=none` were both tested; the shell stayed fully available in every
case. Under `danger-full-access` it runs unsandboxed on whatever host the SDK process is on.

**(c) That makes the deployment topology a correctness requirement, not an ops detail.** This
application inspects third-party web pages and feeds their DOM into prompts, so prompt injection is a
live threat model. The backend host holds `DATABASE_URL`, `OPENAI_API_KEY`, encrypted repo PATs, and
stored site credentials. An unsandboxed shell on that host, driven by injected page content, is a
direct exfiltration path. **The Codex worker must therefore not run on the backend host.**

The plan is consequently ordered so that isolation lands *before* the transport swap.

## 2. Existing Architecture

**Codex runtime (live).** `server/ai/codex/` — `appServerClient.ts` (stdio JSON-RPC transport,
approval answering, auth/model introspection, device login), `runtime.ts` (`CodexRuntime`: threads,
turns, streaming, structured output, cancellation, health), `mcpBridge.ts` (loopback MCP server
exposing scoped `AgentTool`s), `login.ts` (device-code sign-in). Every turn runs through
`turn/start` on the app server today.

**LangGraph (live, default engine).** `workflow/testRunGraph.ts` fuses nine nodes:
`load_context → discover_and_ground → author_cases → review_cases → author_plans →
compile_and_validate → execute_tests → investigate_failures → finalize`, with deterministic
`addConditionalEdges` routing, per-node `PostgresSaver` checkpoints, and `interrupt()` review gates.
Three nodes are LLM calls; the rest are Playwright, a deterministic compiler, execution, and a human
gate.

**agent-core (dark, `AGENT_NATIVE_V1`).** Already contains the A2A primitives: `bus/messageBus.ts`,
`bus/blackboard.ts`, `registry/agents.ts`, `registry/tools.ts`, `registry/runViaBus.ts`,
`router/routerAgent.ts`, `critic/caseCritic.ts`.

## 3. Dependency Graph

```text
Today (single host)
  backend process
    ├─ MCP bridge (127.0.0.1, ephemeral port)
    ├─ app-server child process ── Codex turns (read-only sandbox)
    └─ secrets: DATABASE_URL, OPENAI_API_KEY, PATs, site credentials

Proposed (two isolation domains)
  backend container (holds secrets)          codex-worker container (NO secrets)
    ├─ MCP bridge → binds private network      ├─ @openai/codex-sdk
    ├─ app-server child (auth/models/login)    ├─ sandboxMode: danger-full-access
    └─ MissionCoordinator ── dispatch ────────►└─ agent turns + built-in shell
                                                    └─ MCP tools ──► bridge (bearer token)
```

## 4. Runtime Flow (proposed)

1. Resolve scope, guardrails, mission context (unchanged).
2. `MissionCoordinator` loads or creates a durable mission record.
3. It selects the next agent — deterministically by phase contract.
4. The worker runs one Codex thread via the SDK, with an MCP tool set scoped to that role.
5. Results are published to the blackboard; the handoff is recorded on the bus.
6. Deterministic work (compile, execute, inspect) is invoked as a **tool**, never as an agent decision.
7. At a review point the mission is persisted and suspends; a decision resumes it.
8. Finalize, persist artifacts, emit console events.

## 5. Evidence Flow

Unchanged in authority. The EvidenceGraph, provenance gates, selector verification, and
"verified evidence only" compilation remain the gate. Agents receive bounded rendered evidence or
fetch artifacts through MCP. **Codex must not become the authority on whether evidence is verified.**

New risk: today `discover_and_ground → author_cases` is enforced by a graph edge. Under A2A an agent
could author before grounding completes. Mitigated by the Section 10 phase contract.

## 6. Context Flow

Application conversation ids remain the public identity. `codex_threads` already maps
`{conversationId, agent}` → thread id, so each A2A role gets its own durable thread. Blackboard facts
become cross-agent context, replacing graph state channels.

**SDK-specific:** threads persist under `$CODEX_HOME` on the *worker*. That directory must be a
mounted volume, or thread history is lost on redeploy and every conversation restarts cold.

## 7. Prompt Flow

Unchanged: `systemPrompts.ts` canonical roles + the DB-backed prompt store remain the source of role
behavior. Registry agent identities must map onto `CANONICAL_AGENTS` so Settings overrides, per-agent
model/effort routing, and usage attribution keep working.

## 8. Current Problems

- Two orchestration layers exist (LangGraph live, agent-core dark); neither is being retired.
- Agent specialization is implicit (a node calls a prompt) rather than a registered role.
- Author↔critic negotiation exists only in agent-core and is unreachable from the live pipeline.
- The app server's approval-answering exists only because the sandbox is restricted; under the SDK
  that machinery becomes unnecessary for turns (still needed for account operations).

## 9. Root Cause Analysis

The pipeline was designed when the model could not call tools natively, so the application sequenced
every step. Codex now iterates internally, which makes fine-grained LLM nodes unnecessary.

But the *deterministic* nodes are not model work. They exist because the plan of record is "the LLM
never emits code": Playwright comes out of a compiler, and compilation must follow grounding and
precede execution. **That ordering is the product guarantee.** Any A2A design must keep it enforced
outside the model.

## 10. Proposed Architecture

**Transport.** `CodexRuntime` swaps its turn execution to the SDK: `startThread`/`resumeThread`,
`run`/`runStreamed`, `outputSchema`, `AbortSignal`, `usage`. The SDK's `ThreadEvent` stream already
carries `mcp_tool_call` items, so tool-call tracing and console steps survive the swap.

`appServerClient.ts` is **retained but demoted** to account operations only — `getAuthStatus`,
`model/list`, and the device-code login flow have no SDK equivalent and must keep working.

**Isolation.** A `codex-worker` container runs the SDK with `sandboxMode: 'danger-full-access'`, under
`--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, no host bind mounts except the
`CODEX_HOME` volume, and egress restricted to the OpenAI API plus the bridge. It receives **no
application secrets** — not `DATABASE_URL`, not `OPENAI_API_KEY` unless API-key mode is chosen, not
repo PATs.

**Bridge binding changes.** The bridge is loopback-only today. With the worker in a separate
container, it must bind the private container network instead. The bearer token becomes the sole
boundary, so it stays mandatory and the session path stays unguessable. A new `CODEX_MCP_BIND` is
required; defaulting to `127.0.0.1` preserves single-host development.

**Agents as registered roles** (extend `agent-core/registry/agents.ts`): `Grounder`, `CaseWriter`,
`Critic`, `PlanAuthor`, `Investigator`, each declaring a tool allowlist the bridge already enforces
per session.

**Deterministic capabilities become tools**: `compile_plan`, `execute_scripts`, `inspect_surface`,
`resolve_target`. An agent may *call* the compiler; it may not *replace* it. A compile failure returns
as a tool error the agent can react to.

**Handoffs over the existing bus.** `runViaBus` already records typed A2A messages and blackboard
facts. Author↔critic becomes a real bounded negotiation on separate threads.

### Deliberately NOT proposed

- Removing the deterministic compiler, or letting an agent choose phase order.
- Running the SDK worker on the backend host (Section 1c).
- `codex mcp-server` + Agents SDK: two orchestrators, discards the scoped bridge, and moves billing to
  per-token API keys. A live probe also hung 7 minutes and timed out with the bridge never invoked.

## 11. Complete Refactoring Strategy

1. Stand up the isolated worker + bridge binding; prove the boundary before granting full access.
2. Swap `CodexRuntime` turn execution to the SDK behind a flag; prove parity on the existing suites.
3. Add durable mission state with resume — this replaces the checkpointer and must exist and be tested
   BEFORE any graph node is removed.
4. Add review suspend/resume with the digest validation `nodes/review.ts` performs today.
5. Extend the registry with roles + capability tools.
6. Build `MissionCoordinator` running existing node functions; shadow-compare against the graph.
7. Convert grounding/authoring to true A2A agents; canary on real runs.
8. Cut over `/api/agent/start`; keep the graph one release; then remove graph + checkpointer + deps.

## 12. Every File That Must Change

| File | Planned change |
|---|---|
| `package.json` / lock | Re-add `@openai/codex-sdk`; later drop `@langchain/*` |
| `docker-compose.yml` / deploy manifests | New hardened `codex-worker` service |
| `server/ai/codex/runtime.ts` | Turn execution → SDK; keep the normalized `CodexEvent` surface |
| `server/ai/codex/appServerClient.ts` | Demote to account ops (auth, models, device login) |
| `server/ai/codex/mcpBridge.ts` | `CODEX_MCP_BIND`; advertise a worker-reachable URL |
| `server/ai/codex/workerClient.ts` | New — dispatch a turn to the worker, stream events back |
| `server/ai/orchestrator.ts` | Per-role tool allowlist passthrough |
| `server/agent-core/registry/agents.ts` | Five A2A roles + allowlists |
| `server/agent-core/registry/tools.ts` | compile/execute/inspect as capability tools |
| `server/agent-core/mission/coordinator.ts` | New — phase advance, handoff, termination |
| `server/agent-core/mission/state.ts` | New — mission record, phase, artifacts, review status |
| `server/agent-core/mission/review.ts` | New — suspend/resume, digest-validated decisions |
| `server/db/schema.sql` | New `agent_missions` table (idempotent) |
| `server/db/repository.ts` | Mission read/write/resume |
| `server/features/agent/routes.ts` | Route `/api/agent/start` to the coordinator behind the flag |
| `server/features/agent/workflow/nodes/*` | Re-exposed as capabilities; logic preserved |
| `.env.example`, `docs/CODEX-RUNTIME.md` | Worker topology, bind address, hardening flags |
| `scripts/test-codex-worker-isolation.ts` | New — worker cannot read secrets or reach the DB |
| `scripts/test-agent-mission.ts` | New — phase order, resume, review validation |
| `scripts/test-agent-a2a.ts` | New — handoff, allowlist isolation, critic negotiation |
| `server/features/agent/workflow/testRunGraph.ts`, `graphs/*`, `checkpointer.ts` | Delete after canary |

## 13. Why Each File Must Change

Container and bridge-binding changes make `danger-full-access` survivable — they are the plan's
load-bearing security work, not deployment polish. Runtime files move the transport while preserving
the event surface every consumer already reads. Mission files replace exactly what the checkpointer
and `interrupt()` provide, the only reason LangGraph is hard to remove. Registry files make roles
first-class. Node files are preserved as capabilities so business logic is reused, not rewritten.

## 14. Risk Level Per File

| File/group | Risk |
|---|---|
| Worker container + bridge binding | **Critical — security boundary** |
| `mission/state.ts` + schema + repository | Critical |
| `mission/review.ts` (suspend/resume) | Critical |
| `mission/coordinator.ts` | Critical |
| `features/agent/routes.ts` cutover | Critical |
| `runtime.ts` transport swap | High |
| `workerClient.ts` | High |
| Registry + tool allowlists | High |
| Graph deletion | High |
| `appServerClient.ts` demotion | Medium |
| Dependency changes | Medium |
| Tests/docs | Low–Medium |

## 15. Backward Compatibility Concerns

- Preserve `/api/agent/start` and every Agent Console event/card shape.
- Preserve canonical agent names, prompt versions, per-agent model/effort routing.
- Device-code sign-in and Settings → AI Runtime must keep working (app server retained for these).
- **In-flight LangGraph runs cannot be migrated** — a checkpointed thread has no mission equivalent.
  Existing runs finish on the engine that created them; review gates must be drained before removal.
- `codex_threads` mappings stay valid, but thread history lives on the worker: `CODEX_HOME` must be a
  volume or history is lost at cutover.
- Single-host development must keep working with the worker in-process and `CODEX_MCP_BIND=127.0.0.1`.

## 16. Migration Strategy

Harden and prove isolation → swap transport behind a flag and run the full suite on both → dark-launch
the coordinator in shadow → canary per project → default for new runs, graph for in-flight → remove the
graph after the review-gate drain window.

## 17. Testing Strategy

**Isolation (new, gating):**
- The worker cannot read `.env.local`, reach `DATABASE_URL`, or resolve non-allowlisted hosts.
- A prompt-injection fixture (hostile DOM text instructing exfiltration) cannot reach a secret.
- The bridge rejects an unauthenticated or wrong-token request from the worker network.

**Transport parity:** text, structured output, streaming deltas, cancellation, thread resume, usage,
tool-call tracing — the existing `test:codex-runtime` suite must pass unchanged on the SDK.

**Workflow:** phase order cannot be reordered by model output; compile always follows grounding;
execution always follows a clean compile; mission resume after simulated restart; review gate accepts a
correct decision and aborts on a stale digest; per-role allowlist isolation; critic negotiation
terminates within bound.

**Parity:** case counts, compile rate, execution outcomes vs the graph on identical inputs.

**Regression:** compiler, grounding, evidence, authoring, investigation suites stay green; build,
typecheck, no circular deps; live run against the real application.

## 18. Rollback Strategy

`AGENT_NATIVE_V1=0` returns runs to LangGraph while both engines coexist; a transport flag returns
turns to the app server while both transports coexist. Mission tables are additive and retained. After
graph deletion, rollback means deploying the previous release. **The worker container is not
rollback-optional** — reverting to an unisolated worker reintroduces the Section 1c exposure.

## 19. Estimated Implementation Effort

- Worker container, bridge binding, isolation tests: 4–6 days.
- SDK transport swap + parity: 3–5 days.
- Durable mission state + resume: 4–6 days.
- Review suspend/resume with digest validation: 2–3 days.
- Registry + capability tools: 2–3 days.
- Coordinator + node-as-capability conversion: 5–8 days.
- A2A conversion + critic negotiation: 4–6 days.
- Canary, parity, cutover, deletion: 4–6 days plus soak.

**Total ≈ 28–43 engineering days.** The dominant costs are (1) rebuilding durability and human-gate
semantics that `PostgresSaver` + `interrupt()` provide today, and (2) the isolation work that
`danger-full-access` makes mandatory.

## 20. Recommended Implementation Order

### Phase 1 — Isolation boundary (must land first)
Files: 5–7. Risk: Critical (security). See Section 21 for the actual target topology.
- [ ] `codex-worker` container definition with hardening flags.
- [ ] `CODEX_MCP_BIND` + worker-reachable bridge URL; token still mandatory.
- [ ] Worker holds no application secrets.
- [ ] Postgres requires a password and `pg_hba.conf` refuses the worker's network.
- [ ] `test:codex-worker-isolation` — secrets unreachable, DB unreachable, bridge auth enforced.
- [ ] No production traffic; app server still executes every turn.

### Phase 2 — SDK transport swap
Files: 4–5. Risk: High.
- [ ] Re-add `@openai/codex-sdk`; `workerClient.ts` dispatch.
- [ ] `CodexRuntime` turns → SDK with `sandboxMode: 'danger-full-access'`.
- [ ] `appServerClient` demoted to account ops.
- [ ] `test:codex-runtime` + `test:codex-tool-loop` pass unchanged.

### Phase 3 — Durability foundation
Files: 4–5. Risk: Critical.
- [ ] `agent_missions` schema + repository (idempotent).
- [ ] Mission state model + phase contract; resume-after-restart test.

### Phase 4 — Review gates
Files: 3–4. Risk: Critical.
- [ ] Suspend/resume on mission state; digest-validated decisions.
- [ ] Console pending-review contract unchanged.

### Phase 5 — Registry + capabilities
Files: 5–6. Risk: High.
- [ ] Five roles with tool allowlists; compile/execute/inspect registered as tools.

### Phase 6 — Coordinator in shadow
Files: 4–6. Risk: Critical.
- [ ] Coordinator runs existing node functions; shadow-compare against the graph.

### Phase 7 — True A2A + cutover
Files: 6–10. Risk: Critical.
- [ ] Agents as roles; canary, parity, cutover.

### Phase 8 — Removal
Files: 10–15. Risk: High.
- [ ] Delete graph/checkpointer, drop `@langchain/*`; production-readiness report.

---

**Measurement note.** Every transport claim in Section 1 was established by running the real binary
against a live scoped bridge, not inferred from documentation. Probe scripts were removed after use;
the four `codex exec` combinations and the three lockdown attempts are reproducible from the tables
above. If a future Codex release lets a restricted sandbox approve MCP tool calls non-interactively
(openai/codex#24135), Phase 1's isolation requirement relaxes and `sandboxMode` should return to
`read-only`.

## 21. Target deployment topology (AWS, as it exists today)

The repo has no Dockerfile — `docker-compose.yml` provisions Postgres for local development only.
Production is a **bare EC2 Ubuntu host** (`ops.acchindra.com`) with nginx in front, the Node backend
run directly, and Postgres on `localhost:5432`. nginx location blocks for `/automation-dev` and
`/automation-test` show **multiple environments sharing one instance**.

That topology raises the cost of `danger-full-access` above the generic case, for three reasons:

1. `.env.local` sits on the host with `DATABASE_URL` and `OPENAI_API_KEY`, readable by the app user.
2. Postgres is reachable on `localhost`. The dev compose file uses
   `POSTGRES_HOST_AUTH_METHOD: trust`; **if production mirrors it, any local process reaches the
   database with no credential at all** — an unsandboxed shell would not even need to read the secrets.
   Verifying and, if needed, fixing this is a Phase 1 gate, not a follow-up.
3. Environments share the host, so one compromised agent turn reaches the others' data.

The host also already runs headless Chromium against third-party sites, so it processes untrusted
content today. Adding an unsandboxed agent shell to the same user compounds an existing exposure
rather than introducing an isolated new one.

### Options for the worker on this host

**Option A — Docker container on the same EC2 instance (recommended).** Install Docker; run the worker
as a hardened container. Strong filesystem and network isolation, no new instance to pay for or manage.

```
docker run --rm \
  --name codex-worker \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 --memory=2g \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  -v codex-home:/home/worker/.codex \
  --network codex-net \
  -e CODEX_HOME=/home/worker/.codex \
  codex-worker:latest
```

The bridge then binds the `codex-net` gateway rather than loopback (`CODEX_MCP_BIND`), with the bearer
token as the boundary. Postgres must NOT be reachable from `codex-net`.

**Option B — systemd-hardened unprivileged user (no Docker).** A dedicated `codex-worker` user plus
`ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, and `ReadWritePaths`
limited to `CODEX_HOME`. Lighter to adopt, but filesystem-only: it does **not** stop the worker opening
a local TCP connection to Postgres, so item 2 above must be fixed for this option to be meaningful.

**Option C — separate EC2 instance.** Cleanest isolation and the only one that survives a container
escape, at the cost of another instance and another deploy target.

Recommendation: **Option A**, with the Postgres authentication check treated as a blocking prerequisite.

### Consequences for the plan

- Phase 1 gains a deployment work item: install Docker on the host, add a `Dockerfile.worker`, and add
  the worker to the deploy process (which is currently a bare-host deploy, not a container rollout).
- `CODEX_HOME` must be a named volume; otherwise thread history is lost on every redeploy.
- `AGENT_BUNDLE_CACHE_DIR`'s existing "keep it outside the deploy tree" rule applies to `CODEX_HOME`
  for the same reason.
- Local development keeps the worker in-process with `CODEX_MCP_BIND=127.0.0.1`; only production runs
  the container.
