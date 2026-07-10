# Evidence-Driven Context Architecture — Implementation Plan

**Status: ANALYSIS ONLY. No code has been changed. Nothing here is implemented. This is a plan awaiting explicit, separate approval (per `CLAUDE.md` / `AGENTS.md` Principal-Architect process).**

**APPROVED SCOPE (set 2026-07-10):** Implementation is scoped to **Impl-Phases A + B only** (Evidence Registry + Provenance; Declarative Gates + Fail-Safe + DOM retry + Diagnostics/Tracer + blackboard runId). **Impl-Phase C (WorkerContext + Prompt Assembly + Prompt Budget) is DEFERRED** to a future, separately-approved cycle. When C is taken up, prompt rework must be **reorder-and-label-only** (keep every existing instruction paragraph verbatim; regroup into typed labelled sections + explicit truncation markers, gated by a before/after golden-prompt diff) — do NOT consolidate the 3 caseWriter / 2 coder call sites. Note: Phase 5 (Prompt Budget) and the flat-mega-prompt issue (mission issues 6-9) therefore remain open until C is approved; this is an accepted, explicit deferral, not an oversight.

This plan responds to the "Evidence-Driven Context Architecture" mission (Evidence Registry, Provenance, Validation Gates, WorkerContext, Prompt Budget Manager, DOM Pipeline, Prompt Assembly, Runtime Diagnostics, Production Safety). It supersedes the earlier `context-evidence-pipeline-architecture-plan-2026-07-10.md` where the codebase has since moved on.

It builds on and re-verifies four prior forensic passes:
- `agent-run-incident-report-2026-07-10.md` (live run trace)
- `pipeline-runtime-forensics-2026-07-10.md` (static code trace)
- `context-evidence-pipeline-architecture-plan-2026-07-10.md` (first plan)
- `context-evidence-pipeline-change-classification-2026-07-10.md` (P0-P3)

**Every claim below was re-verified against the working tree on 2026-07-10** (commits through `c23abaa "Skip MCP DOM facts by default"`), because the code has drifted substantially since the two forensic reports were written.

---

## 0. CRITICAL FRAMING — the code is much healthier than the mission brief assumes

The mission's "Confirmed Issues" list was authored from the **incident report**, which traced a run made *before* several fixes landed. Re-verification against today's tree shows **most of the confirmed issues are already fixed or substantially mitigated.** Proceeding as if they were still broken would mean rebuilding working code and violating the "minimize disruption" directive. Faithful current state:

| # | Mission "confirmed issue" | Actual state in today's tree | Evidence |
|---|---|---|---|
| 1 | ApplicationInspector reaches the app | True, unchanged | — |
| 2 | DOMExplorer reports 0 elements as success | **FIXED.** Phase now returns `status: 'failed'` when `total_extracted === 0`, and attaches `readyState/title/bodyTextLength/htmlLength` diagnostics. | `pipelineDelta.ts:238-247`, `domExplorer.ts:467-473`, `capturePageDiagnostics` `domExplorer.ts:80-93` |
| 3 | MCP DOM extraction JSON crash | **FIXED.** Greedy `/\{[\s\S]*\}/` regex replaced by balanced-brace/`inString`-aware `tryParseEmbeddedJson()`. | `mcpDomFacts.ts:98-140` |
| 4 | SelectorRegistry mixes static + live w/o provenance | **PARTIALLY FIXED.** Each registry selector now carries `evidence_type` (`live-dom-verified` \| `inspection` \| `live-dom-pool` \| `none`) and the prompt renders `source=<evidence_type>`. | `pipelineDelta.ts:403-419, 452-467, 492-503` |
| 5 | Workers can't distinguish live vs inferred | **PARTIALLY FIXED.** Coder prompt labels source-scan map as "fallback grounding when live DOM proof is incomplete"; registry block states per-selector source. Gap: no single typed evidence contract; `verified` still admits non-live `inspection`. | `routes.ts:2441-2447`, `renderSelectorRegistryForPrompt` |
| 6/7 | One enormous flat concatenated prompt (JSON-in-markdown-in-text) | **STILL TRUE.** 3 caseWriter + 2 coder call sites each build a single flat template-literal with ~20-40 interpolated blocks incl. inline `JSON.stringify(compactInspectionContext(...))`. | `routes.ts:1932-1961, 2128-2175, 2581-2622` |
| 8 | Multiple silent truncation points | **PARTIALLY TRUE.** Many `.slice()` caps remain unmarked; page-outline is the only self-marking one. (Several cited slices still exist.) | `routes.ts` various; `renderPageOutlineForPrompt` |
| 9 | No prompt budget calculation | **STILL TRUE.** No pre-flight token estimate anywhere. `modelCaps/contextWindowFor/maxOutputFor` exist but are unused for budgeting. | `orchestrator.ts` (none); `providers/types.ts:271-281` |
| 10 | Workers have no tools | True by design (caseWriter/coder use single-shot `generateObject`, not `runToolLoop`). Mission does not require changing this. | `orchestrator.ts:193-263` |
| 11 | Workers continue when critical evidence missing | **LARGELY FIXED.** Three blocking gates now hard-stop the run (`markRunDone(run,'failed')`) before invoking the worker. | `routes.ts:1986-2018` (inspection + source gates), `routes.ts:2469-2479` + `assessScriptGrounding` `routes.ts:504-539` |
| 12/13 | Playwright generation w/o verified DOM → hallucinated selectors | **LARGELY MITIGATED.** `assessScriptGrounding` blocks when mode resolves to `'blocked'`; degraded `source-only` mode proceeds but injects explicit "do NOT claim a selector was live-verified" rules. | `routes.ts:504-566` |

**Conclusion:** the three original P0 bugs (greedy JSON, silent-zero DOM, un-provenanced "verified" selectors) are done, and ad-hoc validation gates + fail-stops already exist. What the mission is really asking for now is **formalization and hardening** of patterns that currently exist informally and inconsistently, plus **three genuinely-absent subsystems**: a typed Evidence Registry, a typed WorkerContext + clean prompt assembly, and a Prompt Budget Manager. The plan below targets exactly those, additively, without touching the orchestrator/providers/supervisor/phase order.

---

## 1. Executive Summary

The pipeline runs ~18 named phases per run, each mutating a single untyped `run` object; there is no schema between phases. Evidence lives in ad-hoc fields (`run.dom_exploration`, `run.mcp_dom_facts`, `run.selector_registry`, blackboard). Provenance now exists on selectors but nowhere else and under no shared type. Validation gates exist but are three bespoke conditionals, not a declarative per-agent contract. Worker prompts are still single flat strings assembled at 5 call sites with ~20-40 interpolated, differently-truncated blocks. No pre-flight token budgeting exists. The tracer that should give per-worker prompt/token visibility writes to `process.cwd()/.testflow-traces.jsonl` fire-and-forget and produced nothing in the traced run.

This plan introduces, **additively and behind the existing APIs**: (1) an `EvidenceRegistry` typed record keyed by evidence type with mandatory `provenance/confidence/status/tokenEstimate/validationState`; (2) a unified `Provenance` enum (`STATIC_SOURCE | LIVE_DOM | MCP | PLAYWRIGHT | API | MANUAL`) that the existing `evidence_type` values map onto, and a rule that `STATIC_SOURCE` is never surfaced as "verified"; (3) a declarative `requiredEvidence/optionalEvidence` manifest per agent, with the existing gates refactored to consume it and to emit one canonical fail-safe message; (4) a typed `WorkerContext` builder that replaces the 5 flat-string call sites with one assembler, JSON/markdown/prose kept in labelled sections; (5) a `PromptBudget` manager that estimates tokens against `contextWindowFor(model)` before every provider call and, on overflow, drops/summarizes by evidence priority **with an explicit marker** — never a silent cut; (6) a DOM retry/fallback loop so zero-element captures retry (wait-for-React / networkidle / re-navigate) before failing; (7) per-stage diagnostics enriched with `promptSize/providerTokens/validationResults`, plus a tracer path fix. **No system-prompt text is rewritten** (mission Phase 7 constraint); only assembly changes.

## 2. Existing Architecture

```
HTTP + supervisor      server/features/agent/routes.ts (~5600 lines: HTTP, phase glue, all prompt strings, gates)
Phase functions        server/features/agent/pipelineDelta.ts (metadata/context/inspection/DOM-facts/selector-registry)
Live capture           inspectionService.ts, domExplorer.ts, mcpDomFacts.ts, mcpInspector.ts, liveAuthor.ts
Static capture         selectorMap.ts (fs-only regex scan)
Grounding verdicts     verifier.ts (assessInspection), routes.ts (assessScriptGrounding, assessCasesGrounding)
Shared state           blackboard.ts (global 100-cap), the run object (untyped)
AI orchestration       server/ai/orchestrator.ts (generateObject/generateText/runToolLoop), systemPrompts.ts, tracer.ts
Providers              server/ai/providers/{openai,anthropic,gemini}.ts + types.ts (MODEL_CAPS, contextWindowFor)
Chat context           server/agent-runtime/context/goalContext.ts
```

No `Supervisor`/`executeIntent` class exists; `routes.ts` orchestrates procedurally. This is intentionally preserved.

## 3. Dependency Graph

```
routes.ts
 ├─ pipelineDelta.ts ─┬─ inspectionService.ts ─┬─ mcpInspector.ts ─ mcpClient ─ @playwright/mcp
 │                    │                         └─ playwright (classic fallback)
 │                    ├─ domExplorer.ts ─ playwright
 │                    ├─ mcpDomFacts.ts ─ mcpClient ─ @playwright/mcp
 │                    └─ blackboard.ts ─ storage
 ├─ selectorMap.ts (fs only)
 ├─ verifier.ts (assessInspection)
 ├─ orchestrator.ts ─┬─ providers/{openai,anthropic,gemini}.ts ─ providers/types.ts
 │                   ├─ systemPrompts.ts (via guardrail pipeline)
 │                   └─ tracer.ts
 └─ storage.ts
```
No circular deps. `selectorMap.ts` is correctly decoupled from live capture. The new `EvidenceRegistry`/`WorkerContext`/`PromptBudget` modules are leaves that nothing depends on until call sites opt in.

## 4. Runtime Flow (verified current)

```
POST /api/agent/start → guardrail → scope/credential/folder
 → MetadataFetch (skip if no app) → ContextBuilder → ApplicationInspector (MCP-first, classic fallback)
 → DOMExplorer (0 elements ⇒ status 'failed' + diagnostics)          [Phase 6 already partial]
 → MCPDOMFacts (skipped-by-default now; balanced-brace parse)         [Issue 3 fixed]
 → SelectorRegistry (evidence_type-tagged)                            [Issue 4 partial]
 → Blackboard write
 → CodeAnalyst → FeatureDiscovery/RequirementWriter/CoverageScout
 → [GATE 1] assessInspection: blind + no fallback ⇒ markRunDone('failed')   [Issue 11 fixed]
 → [GATE 2] no repo understanding ⇒ markRunDone('failed')
 → TestGenerationAgent (caseWriter.generateObject — one flat prompt)   [Issue 6/7 open]
 → [GATE 3] assessScriptGrounding: mode 'blocked' ⇒ markRunDone('failed')
 → PlaywrightAgent (coder.generateObject — one flat prompt, source-only mode injects anti-hallucination rules)
 → LiveAuthor → ControlResolver → SelectorVerifier → EvidenceAgent → AuthSessionAgent → verdict
```

## 5. Evidence Flow

Two producers (live: inspection→DOM→MCP-facts→blackboard; static: selectorMap) feed consumers through ~6 render functions. Provenance is present only on the selector-registry object; DOM/inspection/blackboard/metadata carry none. There is no central place that lists "what evidence exists for this run, from where, at what confidence." **This is the core gap Phase 1 (Evidence Registry) closes.**

## 6. Context Flow

Every context builder: project fields → per-array `.slice()` caps → `join('\n')` → often a whole-string `.slice(maxChars)`. Only `renderPageOutlineForPrompt` marks its cut. No token counting; char-length is the only proxy.

## 7. Prompt Flow

caseWriter (3 sites) and coder (2 sites) each build one flat template-literal mixing prose + ALL-CAPS section headers + inline `JSON.stringify`. System prompt is composed separately (`composeSystemPrompt`) and passed as the `system` field — already clean and **not to be touched**.

## 8. Current Problems (re-ranked for what's actually still open)

1. **No typed evidence contract / registry** — evidence is scattered untyped on `run.*`; "what do we know and how sure are we" is not answerable in one place. (Mission Phase 1)
2. **Provenance is partial** — only selectors carry it; no unified enum; `verified` still includes non-live `inspection`. (Phases 2)
3. **Flat mega-prompt assembly at 5 sites** — duplicated, inconsistently truncated, JSON-in-prose. (Phases 4, 7)
4. **No pre-flight prompt budget** — overflow risk grows silently; truncation is unmarked. (Phases 5, and Issue 8)
5. **Validation gates are bespoke, not declarative** — 3 hardcoded conditionals; no per-agent required/optional manifest; no single canonical fail-safe message. (Phases 3, 9)
6. **DOM zero-capture fails but does not retry** — `settle()` waits networkidle + count-stability but never re-navigates/re-waits-for-React before giving up. (Phase 6 remainder)
7. **Diagnostics incomplete + tracer blind** — per-phase records lack `promptSize/providerTokens/validationResults`; tracer writes to `process.cwd()` fire-and-forget, produced nothing in the live run. (Phase 8)
8. Silent `generateObject` bad-JSON retry (no `retried` signal). (minor, Phase 8)
9. `latestBlackboard()` global, no run scoping, 100-cap. (latent cross-run contamination)

## 9. Root Cause Analysis

The remaining failure surface is **not** "the LLM hallucinates" and **not** (any longer) "the pipeline blindly proceeds" — the gates now stop truly-blind runs. It is: (a) **no single typed source of truth for evidence + its provenance/confidence**, so each consumer re-derives trust ad hoc from loosely-typed fields; (b) **assembly, not capture** — the flat mega-prompt makes it easy for a low-confidence block to sit visually indistinguishable next to a verified one, and easy for a silent char-cut to drop the very evidence a downstream rule references; (c) **no budget**, so growth is unbounded and truncation is invisible. Making provenance and budget *first-class and mandatory*, and assembling from a *typed* WorkerContext, removes the structural room for the residual failure modes.

## 10. Proposed Architecture

Four new leaf modules + targeted edits, all additive:

**(a) `server/features/agent/evidence/registry.ts` (new)** — `EvidenceRegistry` = a per-run typed map. Each `EvidenceRecord`:
```
{ id, type: 'repository'|'metadata'|'inspection'|'dom'|'selector'|'requirement'|'coverage'|'execution',
  status: 'present'|'degraded'|'missing'|'failed',
  confidence: 'verified-live'|'verified-static'|'inferred'|'unverified',
  source: Provenance, producer: string, timestamp: string,
  dependencies: string[], tokenEstimate: number, artifactCount: number,
  validationState: 'unvalidated'|'passed'|'failed', payloadRef: <existing run.* field or inline> }
```
The registry **wraps existing `run.*` fields by reference** — it does not move or copy the payloads, so nothing downstream that reads `run.dom_exploration` breaks. Phase functions call `registry.record(...)` in addition to their current writes.

**(b) `Provenance` enum** (in `evidence/provenance.ts`, new) — `STATIC_SOURCE | LIVE_DOM | MCP | PLAYWRIGHT | API | MANUAL`. A mapping table converts existing `evidence_type` strings onto it. Rule enforced in one helper: `STATIC_SOURCE` ⇒ never `confidence: verified-live`; render label "source hint (unverified live)".

**(c) `server/features/agent/evidence/gates.ts` (new)** — declarative manifest: `AGENT_EVIDENCE = { caseWriter: {required:[...], optional:[...]}, coder:{...} }`. A single `validateEvidence(agent, registry)` returns `{ok, missing[], degraded[]}`. The **existing** `assessInspection`/`assessScriptGrounding` gates are refactored to delegate to this (same stop/downgrade behavior, same `markRunDone('failed')`), and to emit one canonical message on hard-block: `"Unable to complete request because required evidence could not be verified: <list>."` (Phase 9).

**(d) `server/features/agent/context/workerContext.ts` (new)** — a typed `WorkerContext` (Repository/Metadata/Inspection/VerifiedDOM/VerifiedSelectors/Requirements/Coverage/Conversation/EvidenceRefs/MissionState) built from the registry, and `assembleWorkerPrompt(ctx, task, opts)` that renders labelled sections with **one** truncation-with-marker policy. The 5 flat call sites are migrated to call it. System prompt path is untouched; provider still receives `system + prompt + schema` — the `prompt` is now `WorkerContext render + task`.

**(e) `server/ai/promptBudget.ts` (new)** — `estimateTokens(text)` (char/4 heuristic, no new dependency) + `planBudget({model, system, sections[], maxCompletion})` using `contextWindowFor(model)`. Returns a plan that fits by dropping/summarizing **lowest-priority evidence first**, each drop recorded as an explicit marker in the rendered prompt and in diagnostics. Wired into `assembleWorkerPrompt`.

Untouched: `orchestrator.ts` provider calls, `providers/*`, `systemPrompts.ts` text, phase order, `runToolLoop`.

### 10.1 Context Priority Policy (deterministic trimming) — design for Impl-Phase C

The Prompt Budget Manager must NOT trim heuristically. Every `WorkerContext` section is declared once, in a single ordered policy table (`context/contextPolicy.ts`, new — lands in Phase C). Each section declares eight attributes:

- **priority** (0-100, unique, higher = kept first)
- **tokenCost** (estimated at build time via `estimateTokens`)
- **required** (Yes/No — a `required` section can never be removed; if it cannot fit even after all optional sections are dropped/summarized, the budget planner raises a hard error that routes through the Phase-B validation gate → canonical fail-safe message, rather than silently cutting a required section)
- **summarizable** (may the section be compressed before removal?)
- **removable** (may the section be dropped entirely?)
- **summarizeStrategy** (deterministic reducer used when summarizing — e.g. "keep first N verified elements by interactive-score", "keep last N conversation turns", never an LLM call inside the budgeter)
- **fallbackStrategy** (what a consumer sees when this section is summarized or absent — e.g. a marker line `[metadata omitted to fit budget: 42 objects]`)
- **dependsOn** (section ids that must be present for this one to be meaningful; if a dependency is dropped, this section is downgraded/dropped too, deterministically)

**Canonical policy table (authoritative ordering):**

| Section | Priority | Required | Summarizable | Removable | Summarize strategy | Fallback marker | Depends on |
|---|---|---|---|---|---|---|---|
| Verified DOM | 100 | Yes | No | No | — | (n/a — required) | Inspection |
| Verified Selectors | 95 | Yes | No | No | — | (n/a — required) | Verified DOM |
| Requirements | 90 | Yes | Yes | No | keep title + acceptance bullets, drop prose | `[requirements summarized]` | — |
| Repository Summary | 85 | Yes | Yes | No | keep understanding head + sourceFiles≤10 | `[repo summary trimmed]` | — |
| Mission State | 80 | Yes | No | No | — | (n/a — required) | — |
| Metadata Summary | 70 | No | Yes | Yes | objects≤12, fields≤30 | `[metadata omitted to fit budget: N objects]` | — |
| Coverage | 60 | No | Yes | Yes | counts + top-N related cases | `[coverage omitted]` | — |
| Conversation History | 40 | No | Yes | Yes | keep last N non-noise turns | `[older conversation trimmed]` | — |
| Evidence References | 30 | No | No | Yes | (drop whole) | `[evidence refs omitted]` | — |
| Knowledge Packs | 20 | No | Yes | Yes | keep feature-matched packs only | `[knowledge packs trimmed]` | — |

**Deterministic algorithm** (`planBudget`): compute `total = system + Σ sections + reservedCompletion`. While `total > contextWindowFor(model) * safetyFactor`: pick the **lowest-priority section that is still removable-or-summarizable**; if `summarizable` and not yet summarized, replace it with its summarized form (recompute cost); else if `removable`, drop it and insert its `fallbackStrategy` marker; recompute `total`. If only `required` sections remain and it still overflows, **do not cut** — return `{ok:false, reason}` so the caller raises the Phase-B fail-safe. Ties are impossible (priorities are unique), so the outcome is fully deterministic for a given (model, section set, token estimates). Every summarize/drop is recorded in diagnostics AND rendered as an explicit marker in the prompt — no silent truncation, ever.

This policy is documented now (per reviewer request) but **implemented in Impl-Phase C**; Impl-Phase A/B do not touch it. The `required` sections here also become the natural source for the Phase-B declarative `AGENT_EVIDENCE.required` manifest, keeping the two consistent by construction.

## 11. Complete Refactoring Strategy

Additive-first, three phases, each ≤ one subsystem / ≤ ~6 files, independently validated:
- **Impl-Phase A — Evidence Registry + Provenance (foundation).** New leaf modules; producers *also* record into the registry; zero consumer changes; both old `run.*` reads and new registry reads work simultaneously.
- **Impl-Phase B — Declarative Gates + Fail-Safe + DOM retry + Diagnostics/Tracer.** Refactor the 3 existing gates onto the manifest (behavior-preserving), add the canonical fail-safe message, add the DOM zero-capture retry loop, enrich per-phase diagnostics and fix the tracer path.
- **Impl-Phase C — WorkerContext + Prompt Assembly + Prompt Budget.** Highest blast radius (`routes.ts` prompt sites); migrate caseWriter then coder behind before/after prompt diffs; wire the budget manager.

At no point does a call site run half-migrated: each switches atomically with a golden-prompt diff check.

## 12-14. Files that must change — why — risk

| File | Change | Why | Risk |
|---|---|---|---|
| `evidence/provenance.ts` **(new)** | `Provenance` enum + `evidence_type`→`Provenance` map + "never call static verified" helper | Phase 2 unified provenance | **Low** (leaf) |
| `evidence/registry.ts` **(new)** | `EvidenceRegistry`/`EvidenceRecord` types + `record()`/`get()`/`summary()` | Phase 1 central registry | **Low** (leaf) |
| `evidence/gates.ts` **(new)** | Declarative `AGENT_EVIDENCE` manifest + `validateEvidence()` + canonical fail-safe message | Phases 3, 9 | **Low** (leaf; wired in B) |
| `context/workerContext.ts` **(new)** | Typed `WorkerContext` + `assembleWorkerPrompt()` (single truncation-with-marker policy) | Phases 4, 7 | **Medium** (must reproduce existing prompt semantics) |
| `ai/promptBudget.ts` **(new)** | `estimateTokens` + `planBudget` over `contextWindowFor` | Phase 5 | **Low** (leaf; wired in C) |
| `pipelineDelta.ts` | Producers also `registry.record()`; DOM zero-capture retry/wait/fallback loop; enrich phase diagnostics (`promptSize` n/a here, add `validationState`, timing) | Phases 1, 6, 8 | **Medium** (touches every phase's write path) |
| `domExplorer.ts` | Add retry-on-zero: re-`settle()` / wait-for-React (`document.readyState`+framework hydration heuristic) / re-navigate up to N, before returning zero | Phase 6 remainder | **Medium** (live-timing sensitive) |
| `selectorMap.ts` | Emit `Provenance.STATIC_SOURCE` on its output so the registry can tag it correctly | Phase 2 | **Low** (metadata add) |
| `verifier.ts` | `assessInspection` delegates to `validateEvidence` (behavior-preserving) | Phase 3 | **Medium** (gate behavior) |
| `routes.ts` | Refactor 3 gates onto manifest + canonical fail-safe; migrate 5 prompt sites to `assembleWorkerPrompt`; record `promptSize`/`providerTokens`/`validationResults` per phase | Phases 3,4,7,8,9 | **High** (largest file, prompt-critical) |
| `ai/orchestrator.ts` | Return additive `retried:boolean`; accept optional pre-computed budget plan for diagnostics; surface `promptSize`/tokens to caller | Phase 8 | **Low-Medium** (additive fields) |
| `ai/tracer.ts` | Resolve trace path against a known dir (not bare `process.cwd()`); log path once at load; make the write awaited at least at one call site | Phase 8 | **Low** |
| `blackboard.ts` | Add `runId`; scope `latestBlackboard(runId)` | latent fix | **Medium** (signature) |
| `providers/types.ts` | (Maybe) export a shared `estimateTokens` if we want it co-located with caps | Phase 5 co-location | **Low** |

No changes to: `providers/{openai,anthropic,gemini}.ts` request logic, `systemPrompts.ts` text, phase order, `runToolLoop`, `mcpDomFacts.ts` parse (already fixed).

Frontend read-model verification only (no required change unless a field shape moves): `src/components/DeepRunResult.tsx`, `src/pages/AgentConsole.tsx`, `src/pages/AgentPanel.tsx`.

## 15. Backward Compatibility

- Registry **wraps** existing `run.*` fields by reference; every current reader keeps working. New fields are additive/optional.
- Gate refactor is behavior-preserving: same trigger conditions, same `markRunDone('failed')`, same downgrade-to-source-only path — only the message text is canonicalized and the decision is centralized.
- `WorkerContext` must reproduce the *content* of today's prompts; the acceptance bar is a before/after prompt diff showing only reordering into labelled sections + explicit truncation markers, no dropped instruction paragraphs.
- `latestBlackboard(runId?)` keeps an optional param so its one caller (`tracer.ts`) migrates in the same change; unscoped call still returns global-most-recent for any legacy caller.
- Persisted historical runs deserialize unchanged (new fields default safely; no backfill — historical runs are not re-run).

## 16. Migration Strategy

Phase A ships pure additions (registry populated, nothing consumes it) → validate registry contents match `run.*`. Phase B refactors gates/diagnostics/DOM-retry behind unchanged external behavior → validate gates still stop/allow identically on replay. Phase C migrates prompt assembly one worker at a time behind golden-prompt diffs → validate case/script output parity, then enable budget enforcement.

## 17. Testing Strategy

- **Unit:** `estimateTokens` monotonicity; `planBudget` drops lowest-priority first and always emits a marker; `provenance` map (`STATIC_SOURCE` never `verified-live`); `validateEvidence` required/optional matrix; `assembleWorkerPrompt` deterministic labelled output.
- **Fix/regression:** DOM retry loop — simulate a page that yields 0 elements on first pass then N after hydration; assert retry then success, and assert genuine-zero still fails with diagnostics. Keep the existing `mcpDomFacts` multi-block parse test.
- **Gate parity:** replay the blind-inspection and blocked-grounding scenarios; assert identical stop decisions + the new canonical message.
- **Integration:** re-run "Generate 2 test cases for the List View" against the live target; assert (i) DOM/MCP failures surface as `failed/degraded` not `completed`, (ii) worker prompts carry provenance labels + budget markers, (iii) no silent truncation (every cut has a marker), (iv) a genuinely-ungrounded run returns the canonical fail-safe message rather than 2 empty scripts.
- **Golden prompt:** snapshot caseWriter/coder prompts pre/post Phase C; diff must be reorder+markers only.
- Run full existing suite (`npm run eval:routing`, `benchmark-listview`, any `*.test.ts`) after each phase; fix all compile errors; verify DOM inspection, repo grounding, metadata, selector verification, case + Playwright generation still work.

## 18. Rollback Strategy

Additive-then-swap per phase = each phase revertable by reverting its commit(s). Phase A has no consumers (no-op revert). Phase B reverts to the current bespoke gates. Phase C reverts per worker (caseWriter and coder migrate independently), and the budget manager is behind a flag so it can be disabled without reverting the assembler. Never merge C before B is validated, nor B before A.

## 19. Estimated Effort

- **Phase A** (registry + provenance + selectorMap tag): small-medium — 3 new leaves + 2 light edits.
- **Phase B** (gates + fail-safe + DOM retry + diagnostics + tracer + blackboard): medium — behavior-preserving refactor + one live-timing-sensitive loop.
- **Phase C** (WorkerContext + assembly + budget): largest — highest-traffic file, prompt-critical, needs golden diffs; the real work of the mission.

## 20. Recommended Implementation Order (phase checklist)

```
Impl-Phase A — Evidence Registry + Provenance (foundation)
Files:
  server/features/agent/evidence/provenance.ts        (new)
  server/features/agent/evidence/registry.ts          (new)
  server/features/agent/selectorMap.ts                (tag STATIC_SOURCE)
  server/features/agent/pipelineDelta.ts              (producers also record())
Risk: Low-Medium   Validates: registry mirrors run.* ; zero behavior change

Impl-Phase B — Declarative Gates + Fail-Safe + DOM Retry + Diagnostics
Files:
  server/features/agent/evidence/gates.ts             (new: manifest + validateEvidence + canonical message)
  server/features/agent/verifier.ts                   (assessInspection delegates)
  server/features/agent/routes.ts                     (3 gates → manifest; canonical fail-safe; per-phase diag fields)
  server/features/agent/domExplorer.ts                (retry-on-zero loop)
  server/features/agent/pipelineDelta.ts              (retry wiring + diagnostics)
  server/ai/tracer.ts                                 (path fix + load-time log)
  server/features/agent/blackboard.ts                 (runId scoping)
Risk: Medium-High  Validates: gate parity on replay; DOM retry recovers hydration-late pages; tracer writes

Impl-Phase C — WorkerContext + Prompt Assembly + Prompt Budget
Files:
  server/features/agent/context/workerContext.ts      (new: typed context + assembleWorkerPrompt)
  server/ai/promptBudget.ts                           (new: estimateTokens + planBudget)
  server/ai/orchestrator.ts                            (retried flag; budget/promptSize surfacing)
  server/features/agent/routes.ts                     (migrate 5 prompt sites; wire budget)
  (verify) src/components/DeepRunResult.tsx, src/pages/AgentConsole.tsx, src/pages/AgentPanel.tsx
Risk: High         Validates: golden-prompt diff = reorder+markers only; case/script parity; budget markers present
```

---

## Explicitly out of scope (mission-respecting)

- No LangGraph / LlamaIndex / ADK; no orchestrator/supervisor/provider replacement; no business-logic or API redesign; no system-prompt rewrite; no phase-order change; workers remain tool-less single-shot `generateObject` callers (mission does not require giving them tools).
- Full typed-return refactor of every `pipelineDelta` phase (old P2-2) and a DAG pipeline runner (old P3-2) remain out of scope — the registry gives most of their benefit additively without the blast radius.

---

**This document is analysis and planning only. No file has been modified. Implementation must not begin until this plan is explicitly approved on a separate turn, and must then proceed one Impl-Phase at a time with validation between phases, per `CLAUDE.md` / `AGENTS.md`.**
