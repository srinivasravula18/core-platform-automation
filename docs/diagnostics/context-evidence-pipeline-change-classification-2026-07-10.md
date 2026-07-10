# Context & Evidence Pipeline — Change Classification (P0-P3)

**Status: ANALYSIS ONLY. No code changed.** This classifies every change proposed in `context-evidence-pipeline-architecture-plan-2026-07-10.md` against the confirmed findings in `agent-run-incident-report-2026-07-10.md` and `pipeline-runtime-forensics-2026-07-10.md`.

Legend:
- **P0** — required to fix a confirmed production issue (something that actually failed in the live-traced run).
- **P1** — strongly recommended, improves reliability, low risk.
- **P2** — nice to have, not required for production.
- **P3** — future architectural improvement, out of scope for the current fix cycle.

---

## P0 — Required to fix confirmed production issues

### P0-1. Fix the greedy JSON regex in `evaluateJson()`

- **Why needed**: This is not a theoretical risk — it threw during the traced live run ("Unexpected non-whitespace character after JSON at position 7215"), which caused MCPDOMFacts to be skipped, which removed one of the two live-evidence sources feeding the coder prompt.
- **Confirmed issue it fixes**: Incident report Finding C; forensics Part 13 (raw→stored→injected→received trace of this exact failure).
- **Files that will change**: `server/features/agent/mcpDomFacts.ts` (`evaluateJson`, lines 74-79).
- **Risk level**: Medium — touches the one code path that talks to an external MCP subprocess; a wrong fix could turn a loud failure into a silent wrong-data success, which is worse. Needs a synthetic multi-block-response test before landing.
- **Estimated effort**: Small (a few hours) — replace the greedy match with either a bounded/balanced-brace parse or an explicit single-content-block request to the MCP tool call.
- **Expected impact on production reliability**: High — directly restores one of the two live-DOM evidence sources that is currently silently unavailable on any run where the MCP response has more than one text block (which, per the trace, is not a rare edge case — it fired on the very first real run tested).

### P0-2. Make a zero-element DOM Explorer result a hard failure signal, not `status: completed`

- **Why needed**: In the traced run, DOMExplorer captured 0 live elements and the phase was marked `completed` — nothing downstream was told grounding had actually failed, so TestGenerationAgent and PlaywrightAgent proceeded as if evidence existed.
- **Confirmed issue it fixes**: Incident report Finding B; forensics module review of `domExplorer.ts`/`exploreAndVerifyPage`.
- **Files that will change**: `server/features/agent/domExplorer.ts` (`exploreAndVerifyPage` return/coverage handling), `server/features/agent/pipelineDelta.ts` (the phase-status line that currently reports `completed` regardless of `coverage.total_extracted`).
- **Risk level**: Medium — changes a status semantic that other code may branch on (e.g. anything checking `phase.status === 'completed'` today would need to also check the new degraded flag).
- **Estimated effort**: Small-medium — logic-only change (a conditional on `coverage.total_extracted === 0` or `verified === 0`), no new data structures required to land this specific fix in isolation from the larger `EvidenceBundle` proposal.
- **Expected impact on production reliability**: High — this is the earliest point in the traced failure chain where the run could have been stopped or flagged instead of continuing for another 14 minutes into a 0/2 execution result.

### P0-3. Stop labeling static source-scan selectors as `verified` in the same field static live-DOM selectors use

- **Why needed**: This is the exact mechanism that let the pipeline hand the case-writer and coder "83 verified selectors" that were, in fact, a 5ms static regex scan produced immediately after both live capture paths (DOMExplorer, MCPDOMFacts) returned nothing — directly causing the 0/2 live-replay failure.
- **Confirmed issue it fixes**: Incident report Finding A/E; forensics Part 10 finding #3, and the selectorMap.ts/pipelineDelta.ts module review.
- **Files that will change**: `server/features/agent/selectorMap.ts` (tag output with its true source), `server/features/agent/pipelineDelta.ts` (the selector-registry phase that currently sets `verified: true` uniformly), `server/features/agent/routes.ts` (`renderSelectorRegistryForPrompt`'s filter and rendered text, so the prompt itself states provenance).
- **Risk level**: High — this is the change with the widest blast radius of the three P0 items, since `renderSelectorRegistryForPrompt` is consumed by both caseWriter and coder prompts across multiple call sites; a mislabeled migration could make the prompt language inconsistent between call sites if not applied uniformly.
- **Estimated effort**: Medium — requires the minimum viable version of the provenance tag (a single `source` field is enough to fix this specific issue; the full `EvidenceBundle` type from the architecture plan is not required to land just this fix, though it is the cleaner long-term home for it — see P1-1).
- **Expected impact on production reliability**: High — this is the single highest-leverage fix: it doesn't just stop one bug, it removes the entire class of "stale/static data looks identical to live-verified data" failures that made the other two P0 issues consequential instead of harmless.

---

## P1 — Strongly recommended, low risk, improves reliability

### P1-1. Introduce the `EvidenceBundle` type + shared `assemblePromptBlock()` renderer

- **Why needed**: Generalizes the provenance fix (P0-3) into a reusable pattern so the next new evidence source doesn't reintroduce the same ambiguity, and consolidates ~5 independently-maintained render functions that currently apply inconsistent truncation behavior (only one self-reports truncation today).
- **Confirmed issue it fixes**: Forensics Part 10 findings #2 and #4 (silent truncation with no marker; duplicated/inconsistent render logic).
- **Files that will change**: `server/features/agent/evidenceBundle.ts` (new file only, in Phase 1 nothing else changes).
- **Risk level**: Low — purely additive; zero existing call sites are touched until a later phase deliberately migrates to it.
- **Estimated effort**: Small — one new, self-contained file with a narrow interface.
- **Expected impact on production reliability**: Medium-High over time (compounds with P0-3 and future evidence sources), Low immediate impact by itself since nothing consumes it yet.

### P1-2. Add `runId` to `BlackboardEntry` and filter `latestBlackboard()` by it

- **Why needed**: `latestBlackboard()` currently returns the single most-recently-created entry across ALL runs in a globally-capped 100-entry store, with no run-scoping. In any environment running more than one agent concurrently, a later phase of run A can silently read run B's blackboard snapshot.
- **Confirmed issue it fixes**: Not observed as a live failure in the single traced run (which had no concurrent runs), but is a directly confirmed design gap from the forensics module review of `blackboard.ts`, and is the kind of gap that would explain an intermittent, hard-to-reproduce grounding failure in a busier environment.
- **Files that will change**: `server/features/agent/blackboard.ts` (`BlackboardEntry` shape, `writeBlackboard`, `latestBlackboard`), `server/ai/tracer.ts` (its one call site, to pass the current `runId`).
- **Risk level**: Medium — changes a public function's signature/behavior; needs both call sites updated in the same change.
- **Estimated effort**: Small — two files, mechanical addition of a filter parameter.
- **Expected impact on production reliability**: Medium — protects against a cross-run contamination failure mode that has not yet been observed but is structurally possible today.

### P1-3. Add a one-line diagnostic to resolve the tracer's silent-no-output gap

- **Why needed**: `.testflow-traces.jsonl` was never created during the traced live run despite its instrumented call path executing twice with no error logged — meaning there is currently zero visibility into the actual prompts/tokens for the two agents (caseWriter, coder) that matter most for grounding quality.
- **Confirmed issue it fixes**: Incident report Finding D.
- **Files that will change**: `server/ai/tracer.ts` (one `console.log(TRACE_FILE_PATH)` at module load).
- **Risk level**: Low — a log line cannot change runtime behavior.
- **Estimated effort**: Trivial (minutes).
- **Expected impact on production reliability**: Low direct impact (it's a diagnostic, not a fix), but High investigative value — it's the prerequisite to knowing whether any further tracer work is worth doing at all, and today that's an open question rather than a known fact.

### P1-4. Surface `generateObject`'s bad-JSON retry as a distinct, visible outcome

- **Why needed**: Today a first-attempt success and a retry-after-malformed-JSON success are indistinguishable to the caller and to the trace log. A model that consistently needs the retry is a quieter signal of prompt/schema drift that currently has no way to surface in aggregate.
- **Confirmed issue it fixes**: Forensics Part 10 finding #7 (not a live-run failure, but a visibility gap identified in the static trace).
- **Files that will change**: `server/ai/orchestrator.ts` (`generateObject`'s return value gets an additive field, e.g. `retried: boolean`).
- **Risk level**: Low — additive field only, no removal or behavior change to existing consumers that ignore the new field.
- **Estimated effort**: Trivial-small.
- **Expected impact on production reliability**: Low-Medium — doesn't fix anything by itself, but is a cheap early-warning signal for schema/prompt drift before it becomes a P0-class failure.

---

## P2 — Nice to have, not required for production

### P2-1. Deduplicate the two near-duplicate caseWriter/coder prompt-assembly call sites

- **Why needed**: `routes.ts` maintains a "per-feature" and a "full-run" variant of both the caseWriter and coder prompts independently; a change to shared instructions in one does not propagate to the other, which is a maintenance risk, not a currently-observed production failure.
- **Confirmed issue it fixes**: Forensics Part 10 finding #8 — a design smell, not something that fired in the traced run.
- **Files that will change**: `server/features/agent/routes.ts` (consolidate the 4 call sites around 2 shared builder functions, one per agent).
- **Risk level**: Medium — touches the highest-traffic file's most business-critical prompt strings; any accidental wording change here shifts case/script output quality in ways that are hard to detect without a before/after prompt diff and possibly a golden-output regression check.
- **Estimated effort**: Medium — mechanical extraction, but requires careful manual review of every literal instruction paragraph to confirm nothing is dropped or altered in the merge.
- **Expected impact on production reliability**: Low-Medium — reduces future drift risk between the two variants; does not fix anything currently broken.

### P2-2. Give `pipelineDelta.ts` phase functions a lightweight typed return instead of side-effecting `run` mutation only

- **Why needed**: Phase functions currently mutate `input.run` in place and return only small status-summary objects; callers read the real evidence back off ad hoc `run.*` fields with no compile-time contract. This is the root shape that made P0-2's silent-completed-with-zero-elements bug possible to write in the first place.
- **Confirmed issue it fixes**: Not itself a confirmed live-run failure — it is the structural precondition that made the P0 issues possible, so fixing it is preventive rather than curative.
- **Files that will change**: `server/features/agent/pipelineDelta.ts` (every phase function's return type), `server/features/agent/routes.ts` (every call site reading the results).
- **Risk level**: High — touches every phase's output contract simultaneously; this is explicitly the Phase 3 item flagged as highest-risk in the architecture plan.
- **Estimated effort**: Large.
- **Expected impact on production reliability**: Medium-High long-term (prevents an entire class of future silent-mutation bugs), but zero immediate impact on the specific issues already found, since P0-1/P0-2/P0-3 can each be fixed locally without this larger refactor.

---

## P3 — Future architectural improvement (explicitly out of scope now)

### P3-1. Pre-flight token/context-window budget checks before every provider call

- **Why needed**: No provider file or orchestrator method computes a token estimate before sending — budget is only known after the fact via `result.usage`. This is a real gap but was not the cause of anything observed in the traced run (no truncation-by-provider or context-overflow was seen).
- **Confirmed issue it fixes**: None of the confirmed live-run findings; this is speculative hardening against a class of failure (prompt exceeds context window) not yet observed in this codebase.
- **Files that would change**: `server/ai/orchestrator.ts`, all three `server/ai/providers/*.ts` files.
- **Risk level**: Medium-High — would need a token-counting dependency and careful integration with three different providers' actual limits.
- **Estimated effort**: Large.
- **Expected impact on production reliability**: Unknown/speculative — valuable as the codebase and prompts grow, but not justified by anything confirmed today.

### P3-2. Full replacement of the ad hoc phase-sequencing in `routes.ts` with a typed pipeline/DAG runner

- **Why needed**: `routes.ts` is a ~5600-line file mixing HTTP handling, orchestration, and prompt construction. A typed pipeline runner would make phase dependencies and failure propagation explicit.
- **Confirmed issue it fixes**: None directly — the architecture plan explicitly recommends against this scope of change (see Section 10: "This proposal explicitly does NOT touch... the phase-sequencing order").
- **Files that would change**: Effectively the entire `server/features/agent/` directory.
- **Risk level**: High.
- **Estimated effort**: Very large — a multi-week rewrite, not a phase.
- **Expected impact on production reliability**: Unclear net-positive without a much longer validation cycle than any of the confirmed fixes require; the confirmed production issues (P0-1/2/3) do not need this to be fixed.

---

## Summary table

| ID | Title | Priority | Risk | Effort | Files |
|---|---|---|---|---|---|
| P0-1 | Fix greedy JSON regex in `evaluateJson()` | P0 | Medium | Small | 1 |
| P0-2 | Zero-element DOM Explorer → hard failure signal | P0 | Medium | Small-Medium | 2 |
| P0-3 | Stop conflating static-scan and live-verified selectors | P0 | High | Medium | 3 |
| P1-1 | `EvidenceBundle` type + shared renderer (additive only) | P1 | Low | Small | 1 |
| P1-2 | `runId`-scoped blackboard reads | P1 | Medium | Small | 2 |
| P1-3 | Tracer diagnostic log line | P1 | Low | Trivial | 1 |
| P1-4 | Surface `generateObject` retry outcome | P1 | Low | Trivial-Small | 1 |
| P2-1 | Deduplicate caseWriter/coder prompt call sites | P2 | Medium | Medium | 1 |
| P2-2 | Typed phase-function returns | P2 | High | Large | 2 |
| P3-1 | Pre-flight token/context budgeting | P3 | Medium-High | Large | 4 |
| P3-2 | Full pipeline/DAG runner rewrite | P3 | High | Very large | entire subsystem |

**Recommended fix-cycle scope, respecting the 10-15-files-or-one-subsystem cap already agreed:** P0-1, P0-2, P0-3, and P1-3 together touch 6 distinct files and form one coherent subsystem (live-evidence capture + its provenance labeling) — this is the natural first implementation phase once approved. P1-1, P1-2, P1-4 are a reasonable second phase (3 files, mechanical/additive). P2 and P3 items are not recommended for the current fix cycle.

**Nothing in this document has been implemented.**
