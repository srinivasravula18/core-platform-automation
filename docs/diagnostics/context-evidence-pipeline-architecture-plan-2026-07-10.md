# Context & Evidence Pipeline — Architecture Review & Implementation Plan

**Status: ANALYSIS ONLY. No code has been changed. Nothing in this document has been implemented. Do not treat any statement here as "done" — it is a plan awaiting explicit approval.**

This builds directly on two prior forensic passes in this repo:
- `docs/diagnostics/agent-run-incident-report-2026-07-10.md` — live end-to-end run trace (real API call, real target app, real timestamps) of "Generate 2 test cases for the List View".
- `docs/diagnostics/pipeline-runtime-forensics-2026-07-10.md` — static code trace of the same pipeline with file:line citations for every context builder, prompt assembly point, and truncation site.

Everything below is grounded in those two documents plus targeted re-reads; where something was not directly re-verified in this pass, it is marked "per prior trace" rather than asserted as freshly confirmed.

---

## 1. Executive Summary

The platform runs a fixed sequence of ~18 named phases per agent run (`server/features/agent/routes.ts` + `server/features/agent/pipelineDelta.ts`), from metadata fetch through live evidence capture. Each phase writes results onto a single mutable `run` object; there is no schema or contract enforced between phases beyond convention (field names like `run.dom_exploration`, `run.mcp_dom_facts`, `run.selector_registry`). Two independent code paths produce "selector" data — a live-DOM verifier (`domExplorer.ts`) and a static source-code regex scanner (`selectorMap.ts`) — and both are surfaced to LLM prompts under the same `verified` vocabulary, with no field distinguishing provenance. A live-run trace showed this is not theoretical: DOM Explorer returned 0 live elements, an MCP DOM-facts call crashed on a JSON-parsing bug, and the pipeline nonetheless proceeded to hand the case-writer and script-author agents a selector set labeled "verified" that was in fact a static source-code scan — leading to a run that produced 2 test cases and 2 scripts, replayed them against the live app, and got 0/2 successful executions.

The core problems are not "the LLM hallucinates" — the traced run shows the LLM (caseWriter) faithfully honored an exact case-count instruction. The problems are architectural: (1) no shared, typed evidence contract between phases, (2) no provenance/confidence tagging that survives into the prompt layer, (3) silent truncation at nearly every context-assembly function with no marker (one exception: the page-outline renderer), (4) failure states (MCP crash, 0-element DOM capture) are logged as phase status but not propagated as a hard signal that downstream consumers can act on, and (5) an instrumentation layer (`server/ai/tracer.ts`) exists in the tree but produced zero output during the traced live run despite its instrumented call sites executing — meaning today there is no way to inspect the actual prompts/tokens for the two agents that matter most (caseWriter, coder) without adding new logging.

This document proposes an incremental, additive redesign: introduce a single typed `EvidenceBundle` with mandatory provenance/confidence fields, route every context-builder through it, make truncation always self-report, and fix the two concrete bugs (greedy JSON regex, unmarked DOM Explorer zero-result). It explicitly does NOT propose replacing the orchestrator, the provider abstraction, or the phase-sequencing model — those are sound; the disease is in the data contract between phases, not the phase runner itself.

---

## 2. Existing Architecture

### 2.1 High-level layers

```
HTTP layer            server/features/agent/routes.ts (~5600 lines — supervisor + all phase glue)
Phase functions        server/features/agent/pipelineDelta.ts (metadata/context/inspection/DOM-facts/selector-registry phases)
Live-app capture       server/features/agent/inspectionService.ts, domExplorer.ts, mcpDomFacts.ts, mcpInspector.ts, liveAuthor.ts
Static-code capture     server/features/agent/selectorMap.ts
Shared run-state       server/features/agent/blackboard.ts (bounded history), the `run` object itself (unbounded, in-memory + persisted)
AI orchestration       server/ai/orchestrator.ts (AgentOrchestrator: generateObject/generateText/runToolLoop), server/ai/systemPrompts.ts, server/ai/tracer.ts
Provider abstraction    server/ai/providers/{openai,anthropic,gemini}.ts
Chat-context threading  server/agent-runtime/context/goalContext.ts (deriveUnderstandingFromChat, resolveUnderstanding, isNoiseTurn)
```

There is no `Supervisor` class or `executeIntent()` function under those literal names (per prior forensic pass, confirmed absent). `routes.ts` plays the supervisor role procedurally: it resolves scope/credentials/folder, then calls phase functions in a fixed order inline in the request handler, threading state through the shared `run` object.

### 2.2 Module-by-module

#### `server/features/agent/routes.ts`
- **Purpose**: HTTP API surface for the entire agent subsystem + inline phase orchestration for run-starting endpoints.
- **Responsibilities**: request validation/scope resolution, credential resolution, folder gating, invoking phase functions in order, building every LLM prompt string (caseWriter, coder), persisting run state, serving run status/events to the frontend.
- **Dependencies**: `pipelineDelta.ts`, `inspectionService.ts`, `domExplorer.ts`, `mcpDomFacts.ts`, `selectorMap.ts`, `blackboard.ts`, `server/ai/orchestrator.ts` (via `getOrchestrator`), `server/agent-runtime/context/goalContext.ts`, storage layer.
- **Who calls it**: Express router (HTTP), indirectly the frontend (`AgentConsole.tsx`, `AgentPanel.tsx`).
- **What it returns**: JSON run state, SSE-style status/event streams, `{task_id}` for async starts.
- **Risks**: single ~5600-line file mixing HTTP handling, business orchestration, and prompt-string construction — the highest-blast-radius file in the codebase; any structural change here risks every phase.
- **Limitations**: no phase-to-phase contract enforcement; prompt strings are built ad hoc per call site (at least 2 near-duplicate caseWriter call sites, 2 near-duplicate coder call sites per prior trace).

#### `server/features/agent/pipelineDelta.ts`
- **Purpose**: home for the "phase" functions that are more structured/reusable than the inline logic in routes.ts — metadata fetch, context builder, multi-context inspection, DOM-facts, selector-registry rendering.
- **Dependencies**: `inspectionService.ts` (`inspectApplicationFlow`), `domExplorer.ts` (`exploreAndVerifyPage`), `mcpDomFacts.ts` (`collectMcpDomFacts`), `blackboard.ts` (`writeBlackboard`).
- **Who calls it**: `routes.ts` phase-sequencing code.
- **What it returns**: mutates `input.run` in place (side-effecting) and returns small summary objects for phase-status logging; does not return the actual evidence objects to its caller — callers read them back off `run.*` fields.
- **Risks**: side-effect-only mutation of a shared object is exactly the pattern that let a failed MCP call (caught, logged, `run.mcp_dom_facts` left `undefined`) become invisible to every downstream consumer that doesn't explicitly check for `undefined`.
- **Limitations**: no schema/type on what a phase is allowed to write onto `run`; new fields get added ad hoc by whichever phase needs them.

#### `server/features/agent/inspectionService.ts` (`inspectApplicationFlow`)
- **Purpose**: drive a real browser (via MCP or classic Playwright fallback) through login + navigation to reach the target feature.
- **Dependencies**: `mcpInspector.ts` (tried first if `INSPECTOR_MCP` flag set), Playwright directly for the classic fallback path.
- **Who calls it**: `pipelineDelta.ts:runMultiContextInspectionPhase`.
- **What it returns**: `{goalStatus, warnings, actionsTaken, observedPages, screenshots, currentUrl, pageSummary, visibleNavigation, visibleTables, visibleForms, assertionTargets}`.
- **Risks**: MCP path failure is caught and silently falls back (`console.warn` only) — per the live-run trace this fired on every run observed; the classic fallback then takes minutes (3m37s in the traced run) with no intermediate status.
- **Limitations**: no timeout budget visible to the caller; a hang here is indistinguishable from "still working" up the call stack.

#### `server/features/agent/domExplorer.ts` (`exploreAndVerifyPage`, `exploreAppElements`)
- **Purpose**: extract and *live-verify* real DOM elements against the actual rendered page — the closest thing to ground truth in the whole pipeline.
- **Dependencies**: Playwright directly.
- **Who calls it**: `pipelineDelta.ts` (DOMExplorer phase).
- **What it returns**: `VerifiedPage {url, outline, opened, elements[], coverage{total_extracted, verified, not_unique, unresolvable, broken, loggedIn}, warnings}`. Element status is one of `verified|not_unique|broken|unresolvable`, assigned by literally checking selector match count on the live page.
- **Risks**: **a phase returning `coverage.total_extracted === 0` is still logged as `status: completed`** (confirmed in the live-run trace: "Captured 0 elements... 0 verified, 0 not unique, 0 broken, 0 unresolvable" was NOT flagged as a failure). This is the single highest-value fix candidate in the whole system.
- **Limitations**: `maxElements` cap (default 200 per prior trace) with a re-sort by interactive+visible score before cutting — reasonable, but the cap and re-sort are invisible to the prompt layer; the LLM never knows elements were dropped.

#### `server/features/agent/mcpDomFacts.ts` (`collectMcpDomFacts`, `evaluateJson`, `textFromMcp`)
- **Purpose**: a second, MCP-protocol-based live DOM capture (parallel/independent of `domExplorer.ts`), meant to give the script-authoring coder richer "actionables/assertions/tables" data.
- **Dependencies**: `server/ai/tools/mcpClient.ts` (`startMcpSession`), the `@playwright/mcp` server process.
- **Who calls it**: `pipelineDelta.ts` (MCPDOMFacts phase), result consumed by `renderMcpDomFactsForPrompt()` in the coder prompt.
- **What it returns**: `McpDomFacts {source, page, intentTerms, missingIntentTerms, actionables[], assertions[], tables[], accessibilitySnapshot, coverage}` — or throws.
- **Risks — CONFIRMED BUG**: `evaluateJson()` (lines 74-79) does `textFromMcp(res).match(/\{[\s\S]*\}/)` — a greedy regex that spans from the first `{` to the LAST `}` in the ENTIRE joined multi-block MCP response, then `JSON.parse`s it. This throws whenever the MCP tool response contains more than one JSON-shaped text block. **This is the exact failure observed in the live-run trace** ("Unexpected non-whitespace character after JSON at position 7215").
- **Limitations**: on failure, the entire phase is skipped and `run.mcp_dom_facts` stays `undefined` — no partial-result salvage, no retry, no distinct "MCP unavailable this run" signal reaching the LLM prompt (the rendered block is simply absent, indistinguishable from "not applicable").

#### `server/features/agent/selectorMap.ts` (`extractSelectorMap`, `methodFor`)
- **Purpose**: static, source-code regex scan (up to 4000 files, 11 distinct regex patterns) to build a fallback selector map independent of any live page.
- **Dependencies**: filesystem only — no browser, no network.
- **Who calls it**: the "SelectorRegistry" phase in routes.ts/pipelineDelta.ts, and directly by the coder prompt assembly (`renderSelectorMap(codeMap)`).
- **What it returns**: `SelectorMap {ariaLabels, testIds, cssIds, cssClasses, placeholders, labels, fieldIds, roleNames, uiHooks, fileCount}`.
- **Risks — CONFIRMED DESIGN GAP**: this static map's consumer phase reports its own `verified: true`/count in the SAME vocabulary domExplorer.ts uses for LIVE verification, and `renderSelectorRegistryForPrompt()` filters on `value?.verified` with no field distinguishing "verified against the live DOM this run" from "matched a regex over `.tsx` source". In the traced run, this phase ran in 5ms (structurally incapable of touching a browser) and reported "83 verified" immediately after both live capture paths returned nothing — and downstream agents could not tell the difference.
- **Limitations**: exact case-insensitive string match only (`methodFor`) — no fuzzy matching, so any label drift between source and rendered DOM (dynamic labels, i18n, computed text) silently fails to resolve.

#### `server/features/agent/blackboard.ts`
- **Purpose**: a small persisted history of page-inspection snapshots, read back by later phases and by the tracer for diagnostic snapshots.
- **Dependencies**: `server/shared/storage.ts` (`db.blackboard`, `persistDataInBackground`).
- **Who calls it**: `pipelineDelta.ts` (`writeBlackboard`), `routes.ts` (`renderBlackboardForPrompt`), `server/ai/tracer.ts` (`latestBlackboard`).
- **What it returns**: `BlackboardEntry {id, sessionId?, baseUrl, route, opened?, elements[], coverage, createdAt}`.
- **Risks — CONFIRMED DESIGN GAP**: `latestBlackboard()` returns the single most-recently-created entry across the ENTIRE `db.blackboard` array with no run-id filter, and the array is globally capped at 100 entries (`blackboard.ts:29`). A busy multi-run environment can have one run's blackboard entry evicted or shadowed by a concurrent/later run before a later phase of the SAME run reads it back.
- **Limitations**: no schema versioning; `elements: any[]` is untyped at the boundary.

#### `server/ai/orchestrator.ts` (`AgentOrchestrator`)
- **Purpose**: single point of contact between application code and the three LLM providers; wraps guardrails, system-prompt assembly, usage recording, and (for tool-calling agents) the agentic tool loop.
- **Dependencies**: `server/ai/providers/*`, `server/ai/systemPrompts.ts` (`composeSystemPrompt` via the guardrail pipeline), `server/ai/tracer.ts`, `server/ai/promptStore` (`getActivePrompt`), cost tracker (`recordUsage`).
- **Who calls it**: every agent call site in `routes.ts` (`getOrchestrator('caseWriter'|'coder'|..., opts)`), chat-facing tool-loop agents.
- **What it returns**: `generateObject` → `{object, usage, model, latencyMs, provider}`; `generateText` → `{text, ...}`; `runToolLoop` → `AgentRunResult {finalText, steps, accepted, stoppedReason, toolResults, totalUsage}`.
- **Risks**: `generateObject`'s single silent retry-on-bad-JSON (mutates the system prompt, retries once, `orchestrator.ts:224-227`) is not distinguished from a first-attempt success anywhere visible to the caller or the trace log — a caller cannot tell "the model got it right first try" from "the model needed a stern reminder."
- **Limitations**: no pre-flight token/context-window budget check anywhere in this layer (confirmed — token counts are only known from `result.usage` AFTER the provider responds); `safeJson()`'s 8000-char tool-result truncation inside `runToolLoop` is silent (no marker, and not reflected in `informationTruncated` in the trace, which only checks provider-side `stopReason === 'length'`).

#### `server/ai/systemPrompts.ts`
- **Purpose**: static policy text (`CORE_IDENTITY`, `SCOPE_POLICY`, `SAFETY_POLICY`, `GROUNDING_POLICY`, `OUTPUT_FORMAT`, `INJECTION_DEFENSE`) plus per-agent instruction blocks (`caseWriter`, etc.), composed by `composeSystemPrompt()`.
- **Who calls it**: the guardrail pipeline (invoked inside `orchestrator.ts` methods), which produces the `systemPrompt` field `assembleSystem()` reads.
- **Risks**: none structural — this is static text, safe to read/extend. Risk is only in keeping the per-agent blocks in sync with what the app-specific context builders actually inject (a prompt instruction referencing "the selector registry" is meaningless if the registry block silently came back empty).

#### `server/ai/tracer.ts`
- **Purpose**: append-only JSONL execution trace (`logExecutionTrace`) meant to capture per-step prompt/tool/context data for offline debugging.
- **Who calls it**: 4 call sites in `orchestrator.ts` (`generateObject`, `generateText`, and twice inside `runToolLoop`).
- **Risks — CONFIRMED GAP**: in the live-run trace, `.testflow-traces.jsonl` was never created anywhere findable, despite the exact instrumented call path (`caseWriter.generateObject`) executing twice with no error logged (the tracer's own `catch` block would `console.error` on a write failure, and none appeared). Root mechanism unconfirmed (cwd resolution vs. dropped fire-and-forget promise vs. something else) — this needs a one-line diagnostic before any further conclusion, not more speculation.
- **Limitations**: fire-and-forget (`.catch(console.error)`, never awaited) — by design this can't block the agent loop, but it also means a silent failure has zero operational signal today.

#### `server/ai/providers/{openai,anthropic,gemini}.ts`
- **Purpose**: translate the orchestrator's provider-agnostic call shape into each SDK's literal request object.
- **Risks**: none structural found in this pass — these files are thin, mechanical adapters; they forward whatever string/object they're handed without their own truncation logic (all truncation happens upstream, in routes.ts/pipelineDelta.ts/orchestrator.ts).
- **Limitations**: no provider computes or exposes a context-window-usage percentage; this would need to be added here or in `orchestrator.ts` if pre-flight budgeting is wanted.

#### `server/agent-runtime/context/goalContext.ts`
- **Purpose**: single source of truth for deriving "the understanding" from chat history (`deriveUnderstandingFromChat`, `resolveUnderstanding`) and filtering noise turns (`isNoiseTurn`).
- **Risks**: none structural — small, focused, already centralizes logic that used to be duplicated (per project memory). Good example of the shape the rest of the context-assembly layer should move toward.

---

## 3. Dependency Graph (textual)

```
routes.ts
 ├─ pipelineDelta.ts
 │   ├─ inspectionService.ts ──┬─ mcpInspector.ts ──> server/ai/tools/mcpClient.ts ──> @playwright/mcp
 │   │                          └─ (classic fallback) ──> playwright (direct)
 │   ├─ domExplorer.ts ──> playwright (direct)
 │   ├─ mcpDomFacts.ts ──> server/ai/tools/mcpClient.ts ──> @playwright/mcp
 │   └─ blackboard.ts ──> server/shared/storage.ts
 ├─ selectorMap.ts (fs only, no deps on the above)
 ├─ server/agent-runtime/context/goalContext.ts
 ├─ server/ai/orchestrator.ts (getOrchestrator)
 │   ├─ server/ai/providers/{openai,anthropic,gemini}.ts
 │   ├─ server/ai/systemPrompts.ts (via guardrail pipeline)
 │   ├─ server/ai/tracer.ts
 │   └─ cost tracker (recordUsage)
 └─ server/shared/storage.ts (run persistence)
```

**No circular dependencies were found in this pass.** `selectorMap.ts` is notably decoupled from every live-capture module — this is architecturally correct (a pure static analyzer should not depend on browser state) but is exactly why its output can silently masquerade as live data once both are rendered into the same prompt vocabulary.

---

## 4. Runtime Flow

(Confirmed twice: once via a live API-triggered run, once via static code trace. See the two source documents for full stage tables.)

```
POST /api/agent/start
 → guardrail short-circuit/reject check
 → scope/credential/folder resolution
 → MetadataFetch (skipped if no app resolved)
 → ContextBuilder (permission-context matrix)
 → ApplicationInspector (MCP-first, classic-Playwright-fallback)
 → DOMExplorer (live element extraction + verification)
 → MCPDOMFacts (independent live capture; can silently fail — confirmed bug)
 → SelectorRegistry (static source scan; independent of the two live steps above)
 → Blackboard write
 → CodeAnalyst (git-agent step)
 → FeatureDiscoveryAgent / RequirementWriter / CoverageScout
 → TestGenerationAgent (caseWriter.generateObject — single-shot LLM call)
 → PlaywrightAgent (coder.generateObject — single-shot LLM call, batch then per-case fallback)
 → LiveAuthor (replay-record against the real app)
 → ControlResolver
 → SelectorVerifier (cross-check scripts vs selector registry)
 → EvidenceAgent → AuthSessionAgent (real login for evidence capture)
 → final run verdict
```

---

## 5. Evidence Flow

Two structurally independent evidence producers feed the same downstream consumers:

1. **Live evidence**: `inspectApplicationFlow` → `exploreAndVerifyPage` → `collectMcpDomFacts` → `writeBlackboard`. Each step can degrade (fallback, zero-result, exception) without a hard-stop signal reaching the next step.
2. **Static evidence**: `extractSelectorMap` (pure source scan, always succeeds, always fast, never reflects the actual rendered page).

Both are rendered into prompts through separate functions (`renderSelectorRegistryForPrompt`, `renderBlackboardForPrompt`, `renderPageOutlineForPrompt`, `renderVerifiedElementsForPrompt` for live; `renderSelectorMap` for static) that use overlapping vocabulary ("verified", selector strings) with no shared type distinguishing them. This is the single biggest architectural gap identified across both forensic passes.

---

## 6. Context Flow

Every context-builder function follows the same shape (confirmed across ~10 functions in the forensics doc): project relevant fields out of a loosely-typed object → apply 1-2 array-length caps → join into a string → (usually) apply one more whole-string `.slice()` cap. Only one function (`renderPageOutlineForPrompt`) marks its own truncation (`... (outline truncated)`); every other truncation is silent. No function in this layer computes a token count — character-length slicing is the only budget proxy in use anywhere in the codebase.

---

## 7. Prompt Flow

CaseWriter and PlaywrightCoder each receive one flat, JS-template-literal-built prompt string per call, mixing: plain instructional prose, ALL-CAPS section headers as ad hoc delimiters, and raw `JSON.stringify(...)` output inlined mid-string (e.g. `compactInspectionContext(inspectionContext)`). There are at least 2 near-duplicate call sites for each agent (a "per-feature" variant and a "full-run" variant) with independently maintained prompt text — a change to one does not propagate to the other today.

---

## 8. Current Problems (ranked, from the two forensic passes)

1. Static and live selector data are rendered under identical "verified" vocabulary with no provenance field (`pipelineDelta.ts` selector-registry phase + `selectorMap.ts`).
2. `mcpDomFacts.ts:74-79` greedy JSON regex — confirmed live crash.
3. `domExplorer.ts` / DOMExplorer phase reports a 0-element live capture as `status: completed`, not failed.
4. Silent truncation is the default across nearly every context builder; only one function self-reports.
5. `latestBlackboard()` has no run-id filter against a globally-capped 100-entry store.
6. The tracer (`server/ai/tracer.ts`) produced no output during a live run despite its instrumented call sites executing — current blind spot on the two agents that matter most.
7. No pre-flight token/context-window budgeting anywhere in the call chain — only after-the-fact `result.usage`.
8. Duplicate, independently-maintained prompt-assembly call sites for the same agent (per-feature vs full-run variants).
9. Phase functions mutate a single untyped shared `run` object with no schema — new fields are added ad hoc, and a phase silently failing to set a field (rather than throwing) is indistinguishable from that field being N/A.
10. `generateObject`'s bad-JSON retry is invisible to the caller and the trace.

---

## 9. Root Cause Analysis

The traced live-run failure chain (0 tests executed) was NOT caused by LLM hallucination in the generative sense — the model honored an exact case count and produced schema-valid output both times it was called. It was caused by the absence of a **evidence contract**: nothing in the type system, the prompt-building functions, or the phase-sequencing code distinguishes "I have live, current, verified proof this control exists on screen right now" from "I found a string that looks like this in the source code at some point." Once that distinction is lost, every downstream stage — case writing, script authoring, live replay — inherits false confidence, and the failure only becomes visible when the browser tries to click something that isn't really there. The fix is not a smarter LLM or better prompt wording; it's making provenance and confidence first-class, mandatory fields that survive from capture through to the final prompt string, plus making every degraded/zero/failed capture step a hard, typed signal instead of a caught-and-logged warning.

---

## 10. Proposed Architecture

Introduce one new shared type, `EvidenceBundle`, used everywhere `dom_exploration` / `mcp_dom_facts` / `selector_registry` / blackboard entries are currently passed around ad hoc:

```
EvidenceBundle {
  source: 'live-dom' | 'live-mcp' | 'static-source-scan' | 'blackboard-cache'
  capturedAt: string
  confidence: 'verified-live' | 'verified-static' | 'unverified'
  targetUrl: string | null
  elements: EvidenceElement[]   // same shape as today's VerifiedElement, unchanged
  degraded: boolean             // true if this bundle is a fallback / partial result
  degradedReason: string | null // e.g. "MCP JSON parse failed", "0 elements captured"
}
```

Every render function (`renderSelectorRegistryForPrompt`, `renderBlackboardForPrompt`, `renderMcpDomFactsForPrompt`, `renderSelectorMap`) is updated to accept `EvidenceBundle[]` and to prefix its rendered block with the bundle's `source`/`confidence`/`degraded` state in plain language the LLM can act on (e.g. "the following selectors come from static source-code scanning only; no live page confirmed them this run"). This requires NO change to how elements themselves are shaped — only how they are tagged and rendered.

Phase functions that currently catch-and-log a failure (MCPDOMFacts, DOMExplorer zero-result) instead always produce an `EvidenceBundle` — even the failure case — with `degraded: true` and a reason, rather than leaving a `run.*` field `undefined`. This makes "no live evidence available" a first-class, always-present signal instead of an absence a caller has to remember to check for.

A single shared `assemblePromptBlock(bundles: EvidenceBundle[], opts)` helper replaces the ~5 independently-maintained render functions, applying one consistent truncation-with-marker policy everywhere (fixing problem #4 globally instead of function-by-function).

`server/ai/tracer.ts` gets one diagnostic line (`console.log('[Tracer] path=', TRACE_FILE_PATH)` at import) added purely to resolve the open question in problem #6 before any further tracer work is trusted.

This proposal explicitly does NOT touch: the orchestrator's provider abstraction, the tool-loop mechanics, the phase-sequencing order, or the system-prompt policy text. Those layers are sound.

---

## 11. Complete Refactoring Strategy

Additive-first: introduce `EvidenceBundle` and the shared render helper alongside the existing functions, migrate call sites one at a time, delete the old per-function renderers only after every call site is migrated and validated. At no point does the pipeline run with a mix of "old shape expected, new shape provided" — each call site switches atomically.

---

## 12-14. Files that must change, why, and risk level

| File | Why it must change | Risk |
|---|---|---|
| `server/features/agent/evidenceBundle.ts` (new) | Define the `EvidenceBundle` type + `assemblePromptBlock()` shared renderer | Low (new file, nothing depends on it yet) |
| `server/features/agent/mcpDomFacts.ts` | Fix the greedy-regex JSON bug (`evaluateJson`); wrap success/failure into `EvidenceBundle` | Medium (touches a live-failure-prone external MCP integration) |
| `server/features/agent/domExplorer.ts` | Wrap `exploreAndVerifyPage` result into `EvidenceBundle`; flag zero-element captures as `degraded: true` instead of `status: completed` | Medium (changes a status semantic other code may branch on) |
| `server/features/agent/selectorMap.ts` | Tag static-scan output with `source: 'static-source-scan'`, `confidence: 'verified-static'` | Low (pure addition of metadata, no logic change) |
| `server/features/agent/blackboard.ts` | Add `runId` to `BlackboardEntry`; filter `latestBlackboard()` by `runId` | Medium (changes a public read function's signature/behavior) |
| `server/features/agent/pipelineDelta.ts` | Route MetadataFetch/ContextBuilder/Inspection/DOMFacts/SelectorRegistry phases through `EvidenceBundle` construction instead of ad hoc `run.*` field writes | High (touches every phase's output contract at once) |
| `server/features/agent/routes.ts` | Replace the ~5 independent render-function calls (both caseWriter call sites, both coder call sites) with `assemblePromptBlock()` | High (largest file, most call sites, highest blast radius) |
| `server/ai/tracer.ts` | Add one diagnostic log line to resolve the "trace file never written" open question | Low (pure addition, no behavior change) |
| `server/ai/orchestrator.ts` | Optional: surface the bad-JSON retry as a distinct field in `generateObject`'s return value, for trace visibility | Low (additive field, no removal) |

No changes are proposed to: `server/ai/providers/*`, `server/ai/systemPrompts.ts`, `server/agent-runtime/context/goalContext.ts`, or the phase-sequencing order itself.

---

## 15. Backward Compatibility Concerns

- `run.dom_exploration` / `run.mcp_dom_facts` / `run.selector_registry` field shapes change (they become/contain `EvidenceBundle`). Anything reading these fields directly (frontend components, e.g. `DeepRunResult.tsx`, `AgentConsole.tsx` per git status showing them modified this session) must be checked for direct field access that assumes the old shape.
- `latestBlackboard()`'s signature changing to require/accept a `runId` is a breaking change to its one internal caller (`server/ai/tracer.ts`) — low risk since it's a single call site, but must be updated in the same commit.
- Persisted run records (DB/JSON storage) written under the old shape must still deserialize — new optional fields should default safely rather than requiring a migration of historical rows.

## 16. Migration Strategy

Introduce `EvidenceBundle` and `assemblePromptBlock()` as pure additions first (Phase 1, no existing call site touched). Migrate producers (`domExplorer.ts`, `mcpDomFacts.ts`, `selectorMap.ts`, `blackboard.ts`) to emit the new shape in Phase 2, with `pipelineDelta.ts` and `routes.ts` still reading old-style fields via a thin compatibility accessor. Migrate consumers (`pipelineDelta.ts`, `routes.ts` prompt assembly) in Phase 3, at which point the compatibility accessor is deleted. Historical persisted runs are read-only after migration — no backfill needed since they are not re-run.

## 17. Testing Strategy

- Unit-level: `evidenceBundle.ts`'s `assemblePromptBlock()` given a fixed set of live/static/degraded bundles produces deterministic, self-labeled output — this is newly testable in a way the old ad hoc functions were not.
- Fix verification for `mcpDomFacts.ts`: feed `evaluateJson()` a synthetic multi-block MCP response (reproducing the exact "position 7215" class of failure) and confirm correct parsing.
- Integration: re-run the exact live trace ("Generate 2 test cases for the List View" against the same target) and confirm the run's own status log now shows DOMExplorer/MCPDOMFacts failures as `degraded`/`failed` rather than `completed`, and that the caseWriter/coder prompts visibly carry provenance language.
- Regression: existing agent-console and run-status frontend rendering (`DeepRunResult.tsx`, `AgentConsole.tsx`) against both an old-shape persisted run and a new-shape live run.

## 18. Rollback Strategy

Because the migration is additive-then-swap per phase, each phase is independently revertable by reverting its commit(s) — Phase 1 has zero consumers so it's a no-op revert; Phases 2-3 each touch a bounded, named file list (above) and can be reverted file-by-file without needing to unwind the others, as long as Phase 3 (consumer migration) is not merged before Phase 2 (producer migration) is validated.

## 19. Estimated Implementation Effort

- Phase 1 (type + shared renderer, tracer diagnostic): small — new file plus one log line.
- Phase 2 (producer migration: domExplorer, mcpDomFacts, selectorMap, blackboard): medium — four files, each independently testable, includes the one confirmed bug fix.
- Phase 3 (consumer migration: pipelineDelta.ts, routes.ts prompt assembly): largest — touches the highest-traffic file in the repo across multiple call sites; needs careful before/after prompt-diffing to avoid silently changing case/script output quality.

## 20. Recommended Implementation Order / Phase Checklist

```
Phase 1
Files:
  server/features/agent/evidenceBundle.ts (new)
  server/ai/tracer.ts (diagnostic log line only)
Risk:
  Low

Phase 2
Files:
  server/features/agent/mcpDomFacts.ts
  server/features/agent/domExplorer.ts
  server/features/agent/selectorMap.ts
  server/features/agent/blackboard.ts
Risk:
  Medium

Phase 3
Files:
  server/features/agent/pipelineDelta.ts
  server/features/agent/routes.ts
  (verify) src/components/DeepRunResult.tsx
  (verify) src/pages/AgentConsole.tsx
  (verify) src/pages/AgentPanel.tsx
Risk:
  High
```

---

**This document is analysis and planning only. No file has been modified as part of producing it. Implementation should not begin until this plan is explicitly approved on a separate turn, and even then should proceed one phase at a time with validation between phases, per the process now recorded in `CLAUDE.md`.**
