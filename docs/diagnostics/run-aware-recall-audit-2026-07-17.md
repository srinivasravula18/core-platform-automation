# Run-Aware Recall Audit — why post-run questions get code-lecture answers (2026-07-17)

## 1. The observed behavior (user report, live session)

After completing a deep run in the Agent Console, three follow-up questions all produced
source-code essays instead of answers grounded in the run the user just executed:

| Question | What the agent answered | What it should have answered |
|---|---|---|
| "why the test cases are failed..?" | "I cannot determine which test cases actually failed... no failing test output was provided", then a 10-point critique of the target app's source vs its own earlier proposed cases | The per-case results of THIS conversation's run: which cases failed, at which step, with which error |
| "why the scripts are failed on running" | An analysis of the target repo's **npm scripts** (`npm run check`, seed chains, `npm.cmd` portability) | The Playwright scripts of this conversation's run: per-script pass/fail, stderr tail, quarantined cases |
| "what we have tested before" | An inventory of the target repo's **own automated test suites**, plus "the codebase does not contain a stored pass/fail history" | This workspace's history: the runs, cases, results and defects stored in the platform DB |

The agent's statements were not hallucinations — they were **true for the path the question was
routed to, and false for the system**. The platform DB stores exactly the data it claimed not to
have.

## 2. Root cause chain (all verified in code)

### RC-A — Routing: diagnostic questions land in the code-explorer path
`server/ai/supervisor.ts` (answer path, ~line 388) sends the question into a tool loop whose task
prompt is:

> "Answer this question about THIS application, grounded ONLY in its REAL source code"

with `ADAPTIVE_CODE_EXPLORER_SYSTEM` as the system prompt. For app-behavior questions this
contract is correct. For "why did MY run fail" it is actively wrong: the prompt **forbids** the
only grounding that could answer the question. Hence answer #1's "no failing test output was
provided" and #3's "no stored pass/fail history" — the model obeyed its contract.

### RC-B — Tool gap: no tool can read run execution results
The explorer loop's tool set (`supervisor.ts:393`) is:
`search_conversation, fetch_artifact, search_codebase, read_code_file, follow_imports`.

- No tool reads `agent_runs` execution data. Even `query_workspace` (not in this set) returns only
  `{id, title, status, date}` — never per-case outcomes, error messages, stderr tails, screenshots,
  or linked defects.
- Yet the DB has all of it: the execution node persists per-script results
  (`workflow/nodes/execution.ts:181` — runId, total, quarantined, stderrTail), the execution
  service parses per-test pass/fail (`features/playwright/executionService.ts`), defects are
  linked via `sourceRunId`, and `/api/agent-runs/:id/details` serves the whole record to the UI.
- Net effect: the UI can show the failure; the agent answering questions about it cannot see it.

### RC-C — Ledger too shallow to carry outcomes
`server/ai/memory/conversationState.ts` (`loadConversationLedger`) emits:

```
run <id>: <status> - <prompt ≤300c>
case <id>: <title>
script <id>: <title>
defect <id>: <status> - <title>
```

No pass/fail counts, no per-case verdicts, no failure reasons. So even though the ledger IS
injected into every prompt (highest priority in `contextAssembler.ts`), it cannot answer
"why did case X fail" — it doesn't know case X failed at all.

### RC-D — Reference binding: "scripts" / "test cases" never bind to the conversation's artifacts
In a conversation that just executed a deep run, "the scripts" must resolve to that run's
Playwright scripts (recency anaphora — the way ChatGPT resolves "it"/"those"). Nothing implements
this: the code-explorer greps the repo for "scripts" and finds `package.json`. Answer #2 is this
failure verbatim.

### RC-E — Router vocabulary: failure questions don't trigger workspace context
`controller.ts` `needsHistory()` (HISTORY_RE) matches "the cases you created", "previous",
"re-run" etc., but NOT "why the test cases are failed" / "why the scripts are failed" — no
failure/results vocabulary, and no signal from conversation state (a completed run exists in this
conversation) is consulted at routing time.

## 3. What already works (do not rebuild)

Verified live this session: with an EMPTY client history, `POST /api/controller/explain` correctly
reconstructed a whole conversation from the DB (ledger + summary segments + budgeted turns) and
answered "what have we done so far" with the real generated cases and correct "nothing persisted
yet" status. The R1–R8 memory stack (server-side assembly, budgeter, summaries, ledger, artifact
digests, `search_conversation`/`fetch_artifact`, conversation-scoped auth, graph-path prior-element
seeding) is all implemented and wired. The remaining gap is precisely: **run execution outcomes are
the one evidence class that never reaches the answering model.**

## 4. Industry-standard solution (how ChatGPT/Claude-class products handle this)

Principle: **observed results outrank derived analysis.** A question about an execution must be
answered from the execution record first; source code is consulted only to *explain* the observed
failure, never to substitute for it. Concretely, four changes:

### S1 — Route on conversation state + failure vocabulary (fixes RC-A, RC-E)
At routing time, load the conversation ledger (already cheap). If the conversation has runs AND the
question matches results vocabulary (`failed|failing|failure|error|passed|results|why.*(fail|error)|
what.*(tested|ran|executed)`), classify as `run_diagnostics` and use a **diagnostic contract**
system prompt instead of the code-explorer contract:

> Primary evidence: the run records of this conversation (get_run_results). Lead with the observed
> outcome (case, step, error, screenshot ref). Use the codebase only to explain observed failures.
> Only if the DB truly has no execution data may you ask the user for logs.

### S2 — `get_run_results` read-only tool (fixes RC-B)
New tool in `ai/tools/` (registered into the explain/supervisor tool sets):

- Input: optional `runId` (default: latest runs of `ctx.conversationId`, fall back to latest in
  scope), optional `caseId`/`scriptId` filter.
- Output (bounded, redacted — reuse artifactMemory's sanitize discipline): per-script and per-case
  verdicts, failing step, assertion/error message, stderr tail (≤1K), quarantined list, screenshot
  refs, linked defect ids, run timing/status.
- Scoped by `ownerId` like `query_workspace`.

### S3 — Outcome-enriched ledger (fixes RC-C, and answers "what have we tested" with zero tools)
Extend `loadConversationLedger` lines with results already in the run record:

```
run RUN-x: completed - 5 passed / 2 failed - <prompt>
case TC-y: FAILED at step 3 - TimeoutError: locator('role=button[name="Save"]') (≤200c digest)
script S-z: 1 passed / 1 failed
defect DEF-w: New - <title> (from TC-y)
```

Deterministic, no LLM, no new storage — a render-time enrichment.

### S4 — Recency reference binding (fixes RC-D)
In the diagnostic contract (S1) state explicitly: in this conversation, "the scripts", "the test
cases", "the run" refer to this conversation's artifacts (most recent first, from the ledger) —
never to files or npm scripts found in the repo — unless the user names something else.

## 5. Implementation plan (single small phase, ≤6 files)

| # | File | Change | Risk |
|---|---|---|---|
| 1 | `server/ai/tools/runResults.ts` (new) | `get_run_results` tool | Low (read-only) |
| 2 | `server/ai/tools/registry.ts` | export + register the tool | Low |
| 3 | `server/ai/memory/conversationState.ts` | outcome-enriched ledger lines | Low (render-only) |
| 4 | `server/ai/supervisor.ts` | diagnostic-contract system prompt variant + add tool to the answer loop's tool set; select contract when ledger has runs & failure vocabulary | Medium (touches answer path) |
| 5 | `server/ai/controller.ts` | extend `needsHistory` vocabulary; pass run-awareness into explain paths | Low |
| 6 | tests | ledger rendering unit test + tool unit test + a routing eval case ("why did the cases fail" with a seeded failed run) | Low |

Rollback: all changes are additive; the diagnostic contract is selected by a condition that can be
reverted to the current behavior in one line.

Validation: seed a conversation with a failed run → ask the three exact user questions via
`/api/controller/explain` → each answer must cite the real case/script ids and stored error text,
not source-code analysis. Then restart the backend and re-verify live in the console.
