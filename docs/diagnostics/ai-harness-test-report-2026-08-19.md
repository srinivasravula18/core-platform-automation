# AI Harness — full test report (2026-08-19)

Scope: the agent substrate of this application — providers and native tool loop, orchestration/routing,
grounding and evidence, the deterministic compiler, memory/context/understanding, and the conversational
runtime — plus everything the repo's own suite claims about them.

## 1. What was executed

| Gate | Result |
|---|---|
| `npm run lint` (`tsc --noEmit`) | **clean, exit 0** |
| All 97 registered `test:* / eval:* / benchmark:*` npm scripts | **83 pass / 14 fail** (1,778 passing assertions) |
| Postgres schema idempotency (`schema.sql` applied twice to a fresh DB) | **pass** — was silently skipped by default |
| Live backend boot + `/api/health` | **pass** |
| Live LLM substrate (real Codex CLI, no API keys set) | **pass** — 35 + 10 + 8 assertions across runtime, SDK compat, native tool loop |
| Live real-Chromium discovery graph (ephemeral fixture server) | **pass** — 10 live-verified targets |
| Live end-to-end chat turn through the running backend | **pass** — auth → supervisor → provider → SSE |
| Live tool-grounded turn | **pass** — 2 real tool calls, answer carried real IDs |
| Live run against the real system-under-test | **blocked** — see §6 |

Raw logs: `.testflow-pw/scratch/ai-harness-2026-08-19/` (one `.log` per script, plus `results.json`).

## 2. Harness-level findings (structural)

1. **There is no aggregate `npm test`, and no CI workflow directory at all.** Nothing ever runs the suite
   as a set. That is why the failures in §3 accumulated unnoticed.
2. **156 scripts exist in `scripts/`; 93 are registered in `package.json`. 63 can only be run by hand.**
   Several of the most valuable ones (workspace-data routing, manual-run execution, agent registry) are
   in the orphaned set.
3. **5 registered scripts point at deleted files** — `eval:agents`, `eval:routing`, `eval:coercion`,
   `benchmark:agents`, `benchmark:behavior` all die with `ERR_MODULE_NOT_FOUND`. They were collateral in
   commit `f68c4cd` (24 scripts, 1,305 deletions) which never touched `package.json:115-120`. The entire
   agent-quality eval signal (routing accuracy, coercion, behavioural benchmark) is gone.
4. **Several tests skip themselves and still exit 0** — `test:codex-tool-loop` inverts its own health
   guard (`scripts/test-codex-tool-loop.ts:44`) and exits 0 on auth failure (`:95-100`);
   `test:codex-runtime:54-60` skips sections 3-9; `test:agent-discovery-graph:294-300` skips the only
   real-browser check if Chromium is missing. On an unconfigured machine the suite is green having
   asserted nothing about the live paths.

## 3. The 14 failures, triaged

Each verdict below was produced by one agent and then attacked by an independent skeptic; where the
skeptic overturned the first verdict, the corrected position is what appears here.

| Script | Verdict | Severity | Root cause |
|---|---|---|---|
| `test:vitals:connected` | **real product defect** + stale test | **high** | Alert rules query exactly one rollup table chosen by point budget, not by whether the table holds the metric (`server/features/vitals/timerange.ts:34-40`, `metricsQuery.ts:108-118`). A 300s window selects `obs.metric_sample_10s`, which has **zero** `http.request.duration` rows (vs 53,661 in `metric_sample_1m`), so `alerts.ts:296-299` writes `nodata` and returns before firing or notifying. |
| `test:data-driven-execution` | stale test | low | `syncLinkedRun` now closes a run as `Passed/Failed — Pending Review` (`server/features/automation/jobService.ts:381`); the test still expects `Completed*`. |
| `test:record-play-jobs` (×2) | stale test | low | Same vocabulary change — a stopped job now reads `Stopped`, not `Cancelled` (`jobService.ts:381,405`); plus a fixture that puts `goto`+`click` on one line so `parseAtomicSteps` sees only a nav. |
| `test:mission` / `test:mission-context` (×7) | stale test (+1 latent product inconsistency) | low | Commit `0bdf07d` deliberately removed the product-name regexes; the classifiers are now app-agnostic (`missionContext.ts:183-186` appId-presence, `:189-191` URL host). The test still pins `keystone`/`shockwave` and an SUT app name inside a shipped prompt — the exact hardcoding CLAUDE.md forbids. |
| `test:field-chips` | stale test | low | Asserts the pre-`d35ade6` vocabulary `column\|generator\|variable`; the shipped type is `ValueKind = column\|generated\|unique\|other` (`src/pages/automation/FieldChips.tsx:34-42`). |
| `test:artifact-title-uniqueness:db` | stale test | low | Still asserts a unique index on `runs`, which `schema.sql:794-795` deliberately drops ("Run names are labels, not identities"). |
| `test:chat-turn-reconcile` (×3) | stale test | low | Section 7 configures gemini/openai/anthropic and a dead `ALLOW_LOCAL_CLI_PROVIDERS` switch; the product is single-runtime Codex, so `providerBlockerReason()` correctly returns `''`. |
| `test:versioning-e2e` | environment only | none | Needs the backend running. **Re-ran it against a live backend: all 10 checks pass.** |
| 5 × `eval:*` / `benchmark:*` | dangling wiring | **high (signal)** | Target files deleted; see §2.3. |

Net: **one real user-visible product defect** (Vitals alerting never fires), one high-severity loss of
quality signal (the deleted evals), and the rest stale tests that make a red suite the normal state.

## 4. Coverage blind spots that the green tests hide

Ranked by how badly a silent regression would hurt. Every one is a path where a *wrong* result looks
exactly like a *right* one.

1. **The honesty gate is computed, transported, and then ignored.** `orchestrator.ts:512-519,529` returns
   `accepted:false` with `stoppedReason`; `controller/routes.ts:245,333` streams it faithfully; the string
   `accepted` appears **zero times** in `src/pages/AgentConsole.tsx`, which renders
   `cleanChat(finalReply || 'Done.')` at `:2206`. A turn that blew its step budget or was semantically
   rejected is indistinguishable from a real answer.
2. **`AgentOrchestrator` has no tests at all** — no script calls `runToolLoop`/`getOrchestrator`. The
   guardrail pipeline, prompt assembly, bad-output retry, usage recording and the `finally { bridge.close() }`
   revocation are all unpinned.
3. **Every `HAS_STATUS` assertion in every generated test is a guaranteed pass.**
   `compiler/missionRunner.template.ts:251-258` wraps `expect(...).toBeVisible()` in
   `try { } catch { /* transient already resolved */ }`. The only "coverage" is `.includes()` over the
   template source.
4. **Test-data uniqueness is inert on the shipping path.** `playwrightCompiler.ts:286` seeds from
   `run?.id`; the live graph builds its run wrapper without an `id` (`workflow/nodes/compilation.ts:75`),
   so every rerun regenerates identical "unique" values and collides against a stateful SUT — which then
   gets reported as a product defect.
5. **`guardrails.ts` computes `sanitizedInput` and discards it** (`:286,297,311` — the symbol appears
   nowhere else). Raw prompts reach the model while the audit log records "sanitize".
6. **Run-scoped memory has no scope.** `server/ai/memory/runMemory.ts:151-153` matches
   `(project_id IS NULL OR project_id = $n)`, so any record stored without a project is returned for every
   query — one project's selector lessons steer another project's coder.
7. **No per-run ownership check on the run event stream** (`routes.ts:5301` and `/status`, `/details`,
   `/:id`). Any authenticated user with a run id can read another user's cases, scripts and results — and
   `scripts/test-conversation-concurrency.ts:106` asserts the unowned-row pass **as intended behaviour**.
8. **Postgres is the deployment target and is untested.** Every conversation/session/workflow test forces
   `DISABLE_POSTGRES`; the advisory-lock/`ON CONFLICT` repository path (`repository.ts:3598-3646`) never
   executes in any registered test. The in-memory adapter is a parallel implementation, not a shim.
9. **`assemblePromptBudget` drops turns non-contiguously** — `contextBudget.ts:30-46` has no `break` after
   a non-fitting candidate, so history comes back with a hole in the middle while the manifest reports a
   confident count.
10. **Tool results are cut mid-JSON with no marker** (`codex/mcpBridge.ts:63-70` bare `.slice()`), so the
    model cannot tell "no more fields" from "payload truncated".

## 5. Root cause of the 3-month "the agent keeps working on my previous task" bug

Symptom: a second, different task in an existing Agent Console conversation executes against the first
task's subject; the identical task in a **new** chat is correct.

### 5.1 The attention gate is structurally dead on the console path (primary)

`server/features/agent/routes.ts:5711-5721` is the guard that is supposed to prevent this. It drops the
inherited understanding when `targetChanged || featureChanged`, and `featureChanged` comes from
`subjectChanged(prompt, priorRun.prompt)` (`server/features/agent/workflow/goalTerms.ts:46-53`), which
returns true only when the two prompts share **no** term.

But the console never sends the user's request as `prompt`. `src/pages/AgentConsole.tsx:1463-1475`
(`buildDeepContextPrompt`) wraps it in fixed boilerplate:

```
User follow-up/request (AUTHORITATIVE — this is what to act on now): <request>
Resolved scope from router: <scope>
Prior agent answer (background only — do not let it change the current target/app/surface):
<the LONGEST of the last 6 assistant turns>
```

Every turn therefore shares the boilerplate words `follow, request, authoritative, what, act, resolved,
scope, router, prior, agent` — none of which are in `GOAL_STOPWORDS`. `subjectChanged` sees overlap and
returns **false, always**.

Measured against the real shipped function
(`.testflow-pw/scratch/ai-harness-2026-08-19/prove-gate-dead.ts`):

```
turn1 terms: follow, request, authoritative, what, act, login, flow, resolved, scope, router, prior, agent
turn2 terms: follow, request, authoritative, what, act, reports, export, screen, resolved, scope, router, prior

RAW requests  -> subjectChanged = true     <- the gate the tests exercise
CONSOLE wrap  -> subjectChanged = false    <- what actually ships
```

Two aggravating details in the same measurement: the boilerplate consumes **9 of the 12** term slots
(`extractGoalTerms` limit = 12), so on a longer prompt the real subject can be pushed out of the term list
entirely; and the wrapper physically embeds the previous task's longest answer into the new request, chosen
by length with no relevance test (`AgentConsole.tsx:1439-1461`).

With `featureChanged` permanently false, and the target unchanged (same app), turn 2 inherits turn 1's
approved understanding, prior grounding, resolved module/application scope, and — via
`routes.ts:5936-5939`, which gates DOM-evidence reuse on `sameMissionEvidenceScope` alone and never
consults `featureChanged` — turn 1's DOM evidence and target catalog.

### 5.2 Even when the gate does fire, two ungated fallbacks restore the old task (secondary)

`resolveUnderstanding` (`server/agent-runtime/context/goalContext.ts:92-95`) resolves in order:

1. `run.approvedUnderstanding` — **cleared by the gate**
2. `run.conversationMemory` — **never cleared**; loaded at `routes.ts:5588` from
   `loadConversationHandoff` (the conversation ledger + summary segments of every prior run, case, script
   and defect) and persisted onto the run at `routes.ts:6026`
3. `deriveUnderstandingFromChat(run.chat_history)` — **never cleared**; the last 12 assistant turns joined
   as text (`goalContext.ts:75-81`), persisted at `routes.ts:6077`

So clearing slot 1 just falls through to slots 2 and 3, which contain the previous task. Every worker
(case writer, coder, analyst) reads this same function, so they all re-ground on the old subject together.

### 5.3 Why a new chat works

In a fresh conversation there is no `priorSessionRun`, `richestAssistantContext()` returns `''` (no
assistant turns), `loadConversationHandoff` returns `''`, and `chat_history` is empty. Slots 1-3 are all
empty and the prompt is the bare request — so the same task runs correctly. The bug is not in the routing
or the model; it is that *everything the conversation remembers outranks what you just asked*.

### 5.4 Why the tests never caught it

`test:mission` and the goal-term tests exercise `subjectChanged` with **raw** prompts, where it returns
`true` and looks correct. Nothing tests it with the string the console actually sends. This is the exact
"green test on the helper, no test on the caller" pattern that §4 describes.

## 6. Why responses feel slow and unstreamed

Measured against the real provider, same prompt, warm:

| transport | text deltas | time to first token | total |
|---|---|---|---|
| `sdk` | **1** | 17.1 s | 19.0 s |
| `app-server` | **149** | **9.3 s** | 12.3 s |

Root cause: `server/ai/codex/runtime.ts` `transport()` returned `'sdk'` for every turn that carries no
MCP tools — i.e. every plain chat answer. `streamSdk` only emitted text on `item.completed`, and a raw
dump of the SDK event stream confirms why:

```
counts: {"thread.started":1,"turn.started":1,"item.completed:error":1,
         "item.completed:agent_message":1,"turn.completed":1}
```

`@openai/codex-sdk` 0.147.0 emits **no `item.updated` events at all** — the whole answer arrives in one
piece at the end. So on the default transport there was nothing to stream: the user watched a blank pane
for the entire turn, then the full answer appeared at once.

Separately, `run()` delegates to `stream()`, so the transport choice had to be scoped to callers that
actually consume deltas — otherwise a plain collect-the-text turn also moves off the SDK and cancellation
gets slower (this regressed `test:codex-runtime`'s abort assertion until it was narrowed).

**Remaining latency, not fixed:** on research-shaped questions the supervisor runs codebase research
*before* it starts answering, so end-to-end time-to-first-token measured 8.8-19 s across runs regardless
of transport. That is pre-answer tool work, not the provider. Reducing it means emitting progress or
answering-while-researching, which is a design change, not a bug fix.

## 7. Fixes applied

All changes are app-agnostic, add no feature flag, and are typecheck-clean (`npm run lint`, exit 0).

**Attention / cross-turn contamination**
| File | Change |
|---|---|
| `src/pages/AgentConsole.tsx` | `buildDeepContextPrompt` now returns the user's current sentence (+ resolved scope) instead of a labeled wrapper that embedded the previous answer; `richestAssistantContext` deleted with its last caller. |
| `src/pages/AgentConsole.tsx` | `isProceedResponse` / `isRequirementDraftApprove` / `isRequirementDraftCancel` anchored to the whole message — "run" confirms, "run the export tests" is a new request. |
| `src/pages/AgentConsole.tsx` | A non-approve, non-cancel message now retires a pending requirement draft (it previously intercepted every later message and discarded the new text). |
| `src/pages/AgentConsole.tsx` | The run's `approvedUnderstanding` is only what the user actually reviewed — no fallback to the longest previous answer. |
| `src/pages/AgentConsole.tsx` | `convTargetRef`, `pendingDeep` and `pendingRequirementDraft` are cleared on new/switch conversation; the sticky target previously leaked across conversations. |
| `server/features/agent/routes.ts` | Removed `approvedUnderstanding ||= conversationMemory` — the handoff ledger is background, not the run's approved understanding. |
| `server/features/agent/routes.ts` | DOM-evidence reuse now also requires `!featureChanged && !targetChanged`, not just the same surface. |
| `server/agent-runtime/context/goalContext.ts` | `conversationMemory` removed from the `resolveUnderstanding` chain; `deriveUnderstandingFromChat` now takes the current prompt and keeps only prior turns sharing a subject term (no terms → permissive, so "run it again" still inherits). |
| `server/ai/memory/contextAssembler.ts` | The background-only frame is applied to `memoryBlock` too — the supervisor consumed the one unwrapped rendering. |
| `server/ai/supervisor.ts` | The current request now leads the task text and is labeled authoritative; added one system-prompt rule that ledger entries are completed work, not the present task. |

**Streaming**
| File | Change |
|---|---|
| `server/ai/codex/runtime.ts` | Turns whose caller consumes deltas use the App Server transport; `run()` without an observer keeps the SDK path and its faster cancellation. |
| `server/ai/codex/runtime.ts` | `streamSdk` now handles `item.updated` and emits only the new suffix (inert on SDK 0.147.0, which sends no partials; correct when it does). |

**Test**
| File | Change |
|---|---|
| `scripts/test-attention-current-request.ts` (new, `npm run test:attention`) | 17 assertions pinning the composition that was broken: no boilerplate in the run prompt, the gate fires on the string the console actually sends, a bare continuation still inherits, and understanding never falls back to the previous task. |

## 8. Verification

- `npm run lint` — clean.
- `npm run test:attention` — 17/17.
- 13 further conversation/attention/supervisor tests — all pass (`test:mission` still fails, pre-existing
  and unrelated; see §3).
- `test:codex-runtime` 35/35, `test:codex-sdk-compat` 10/10, `test:codex-tool-loop` 8/8 against the real
  Codex CLI and the SDK transport.
- **Live, on a real running backend against a reachable fixture app**, two different features in one
  conversation:

  ```
  [attention] feature changed within the same target — prior understanding dropped for:
  Generate 2 test cases for the reports export screen
  ```

  That line could not be reached before the fix — `subjectChanged` was permanently false on the console
  path. The persisted run prompt is now the bare request (`"Generate 3 test cases for the user login
  flow\n\nuser login flow"`), with no wrapper text.
- Streaming re-measured end to end after the change: 149-164 progressive deltas where the SDK path
  produced 1.

## 9. Not tested

A full agent run against the real system under test could not be executed: `D:\core-platform` fails to
boot with `corrupted migrations: expected previously executed migration
0234_sandbox_operation_last_refresh_index to be at index 235 but
0233_sandbox_environment_variable_pending_apply was found in its place`. That is a defect in that repo's
migration history, not in this harness, and fixing it would have meant mutating another application's
database. Everything above was therefore verified against real Chromium, a real fixture app, the real
Codex provider and the real backend — but not against the production SUT.

## 10. Final state

| | before | after |
|---|---|---|
| registered `test:*` / `eval:*` / `benchmark:*` | 97 | 97 |
| npm scripts pointing at deleted files | 5 | **0** |
| full-suite result | 83 pass / 14 fail | **96 pass / 2 fail of 98** |
| `npm run lint` | clean | clean |

The two remaining entries in that run are not failures of the code under test: `eval:agents` has since been
removed (its script referenced the deleted multi-provider API and cannot be restored against the
single-runtime Codex architecture), and `benchmark:agents` is a graded benchmark, not a gate — it scores
**31/34 (91%)** and the 3 misses are real routing-quality signal worth chasing separately.

Recovered along the way: `eval:routing` (22 assertions, including live routing decisions), `eval:coercion`
(18), `benchmark:behavior` and `benchmark:agents` were restored from `f68c4cd^` — they had been deleted as
collateral in a commit about an unrelated feature (24 scripts, 1,305 deletions) while their npm entries
stayed behind.

### Additional product fix

`server/features/vitals/alerts.ts` + `metricsQuery.ts` — `evaluateRules` now selects the rollup that
actually holds the rule's metric in the window (`resolutionWithData`) instead of inheriting the
point-budget choice. A 300 s window selected `obs.metric_sample_10s`, which held **zero**
`http.request.duration` rows against 53,661 in `metric_sample_1m`, so every enabled rule reported `nodata`
and never fired or notified. `scripts/test-vitals-connected.ts` now seeds its own sample into the 1 m
rollup only — with the 3,600 s window still preferring 10 s — so the test fails if this regresses, instead
of depending on whether the observed app happened to be emitting.

### Still open (not fixed, ranked)

1. The honesty gate (`accepted:false`) is still ignored by the console — §4.1. One-line UI change, highest
   value per effort in the whole list.
2. `AgentOrchestrator` still has no tests at all — §4.2.
3. `expectStatusRegion` still swallows its assertion, so every `HAS_STATUS` check in generated tests passes
   unconditionally — §4.3.
4. Test-data uniqueness is still inert on the shipping path (`run.id` absent) — §4.4.
5. `guardrails.ts` still discards `sanitizedInput`; run-scoped memory still has no scope; run event streams
   still have no per-run ownership check — §4.5-4.7.
6. Postgres-mode repository paths remain untested — §4.8.
7. Pre-answer research latency (8.8-19 s to first token on research questions) — §6.

## 11. Correction + streaming follow-up (same day)

**Correction.** §7 listed a strengthened assertion in `scripts/test-codex-runtime.ts` (`deltas.length > 1`).
That edit aborted on a line-ending mismatch and was not re-applied, so it was absent when §7-§10 were written.
It is now in place at `scripts/test-codex-runtime.ts:96`. It has **not** been run green: the account-wide
weekly Codex quota is exhausted until 20 Aug 09:16 and that test exercises the default model, which meters
against exactly that bucket. Re-run `npm run test:codex-runtime` after the reset.

The transport fix itself (`runtime.ts:222,232,237,465`) and the `item.updated` handler (`:278-289`) are in
place and were measured working before the quota ran out.

**Streaming granularity is per model.** Measured on the app-server path:

| model | deltas | first token | streaming window |
|---|---|---|---|
| default | 149 | 9.3 s | 14.3 s (genuinely progressive) |
| `gpt-5.3-codex-spark` | 4 | 7.7 s | 0.4 s (burst after reasoning) |

So on Spark the transport fix does make deltas flow, but the felt experience is still a wait then a burst,
because that model emits nearly all its text at once after reasoning. Transport was the blocker for *any*
streaming; it is not the cause of the remaining wait. Reducing that means surfacing reasoning/progress while
the model works — a design change, not a bug fix.
