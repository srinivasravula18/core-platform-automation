# Codebase-Grounded Test Generation — Architecture Plan (Phase 0, Analysis Only)

Status: **awaiting approval** — no code has been changed. Do not implement from this document without
explicit sign-off on a later turn, per CLAUDE.md's Principal Architect process.

## 1. Executive Summary

The Agent Console's script-generation pipeline (`discover_and_ground → author_cases → author_plans →
compile_and_validate`) grounds every case and every selector **exclusively in a single, static, live
DOM crawl** of the target app. It never reads source code, even for apps that have one connected. Two
bugs traced live against Keystone (wrong "click search result" selector; generic `openModule()` stubs
instead of real fill/click actions) both trace to this: discovery never re-probes after a search fires
(no result-row evidence ever exists), and there is no way to disambiguate two similarly-labeled controls
from label text alone.

Separately, and more importantly: the connected repo for the "Core Platform" project
(`D:\core-platform`, `repoPath` already registered on the project) contains a **mature, hand-maintained
Playwright E2E suite** — 25 spec files, 4 Page Object classes (`LauncherPage`, `LoginPage`, `ObjectPage`,
`RecordPage`), including `tests/e2e/account-creation.spec.ts`, which does the *exact* scenario this
session tested (CRM account creation) correctly, with real selectors, real Page Objects, and a real API
contract assertion (`waitForResponse` on `/objects/account/records`). The agent pipeline has full
filesystem access to this repo (`getProjectRepoPath`, used elsewhere in `server/features/agent/routes.ts`)
and never reads a single line of it during case authoring or compilation.

This plan proposes making the connected repository the **primary source of truth** for grounding —
mirroring how a coding agent (Claude Code, Codex) is asked "write a test for X" and reads the actual
frontend source instead of opening a browser — with live-DOM discovery demoted to a **fallback and
verification** step, not the origin of grounding. This fixes the class of bug root-caused this session,
not just the two instances found, and applies to every app with a connected repo (not a Keystone patch).

## 2. Existing Architecture

Case generation is one LangGraph workflow (`server/features/agent/workflow/testRunGraph.ts`), stage
order (`testRunGraph.ts` `STAGE_ORDER`, `runtime.ts:113`):

```
validate_request → load_context → discover_and_ground → author_cases → author_plans
  → compile_and_validate → execute_tests → investigate_failures → finalize
```

- **discover_and_ground** (`testRunGraph.ts:304`, node `discoverAndGround`) — `runDiscoveryNode`
  (`workflow/nodes/discovery.ts:293`) drives a **headless Playwright session** against the live target
  URL, does a `page.goto` + a handful of generic exploratory interactions, then ONE
  `captureSemanticSnapshot` (`domExplorer.ts:596`). `runGroundingNode` (`workflow/nodes/grounding.ts:180`)
  projects that single snapshot into an `EvidenceGraph` (`graph/evidenceGraph.ts`).
- **author_cases** (`workflow/nodes/authoring.ts:479`) — an LLM call (`generateStrictObject`,
  `authoring.ts:291` → `callOpenAIResponsesStructured`) producing free-text `{action, expected}` steps.
  Input context is the mission/goal plus a **catalog rendered from the EvidenceGraph only**
  (`renderCatalogForPrompt.ts:14-22`, capped at 200 unique/verified/live nodes).
- **author_plans** (`authoring.ts:503`, `authorAbstractPlan`) — a second LLM call mapping free text into
  typed `PlanStep[]` (`compiler/testPlan.ts:11`: `OPEN_MODULE/CLICK/FILL/SELECT/CHECK/UNCHECK/HOVER/
  PRESS/CLEAR`), against the **same** DOM-only catalog.
- **compile_and_validate** (`workflow/nodes/compilation.ts:64`) — `playwrightCompiler.ts` resolves each
  plan step's `target` string against the EvidenceGraph via exact-match `resolveTarget`
  (`graph/groundingEngine.ts:87`, confirmed exact-match only, no fuzzy logic) and emits a runner call.

No stage in this chain ever opens, greps, or reads a file from the connected project's repository.
`getProjectRepoPath` exists and is used at case-generation-request time (`routes.ts` around
`/api/agent/start`) only to register learned **auth storage keys**, not to ground selectors, page
objects, or API contracts.

## 3. Dependency Graph

```
Agent Console UI (CodegenPanel/Agent chat)
  → /api/agent/start (routes.ts)
    → testRunGraph.ts (LangGraph StateGraph)
        discover_and_ground → nodes/discovery.ts → domExplorer.ts (Playwright live crawl)
                              → nodes/grounding.ts → graph/evidenceGraph.ts, graph/groundingEngine.ts
        author_cases        → nodes/authoring.ts → server/ai/openai/responsesClient.ts
        author_plans        → nodes/authoring.ts (authorAbstractPlan) → compiler/testPlan.ts
        compile_and_validate→ compiler/playwrightCompiler.ts, compiler/validateCompiledOutput.ts
        execute_tests       → server/features/automation/serverRunner.ts | agent/src/runner.ts
    → artifactStash.ts (in-process Map; Postgres mirror DEAD — see §9)
```

The connected repo (`D:\core-platform`, or any project's `repoPath`) sits entirely OUTSIDE this graph.
It is reachable (`getProjectRepoPath(projectId)`) but nothing in `discover_and_ground`/`author_cases`/
`author_plans`/`compile_and_validate` imports or calls it.

## 4. Runtime Flow

One Agent Console run = one pass through the graph above, single live browser session for discovery,
two sequential LLM calls (author_cases, author_plans) each against the identical static DOM catalog, one
deterministic compile pass, one Playwright execution pass. Verified end-to-end this session
(`ce4f7552-b871-4e2b-81fa-6d1877d9248f`): 10 stages, ~8 minutes wall clock, 2 cases, 2 scripts, both
executed and both failed for reasons traced to steps 2 and 3 above.

## 5. Evidence Flow

`EvidenceGraph` + `VerifiedSelector[]` are the only evidence type in this pipeline. Produced once, in
`discover_and_ground`, from one static snapshot. Passed to `author_cases`/`author_plans` as a **rendered
text catalog** (`renderCatalogForPrompt.ts`, same function called twice, `authoring.ts:481,505`), and to
`compile_and_validate` as the full in-memory object via `artifactStash.ts` (`stashArtifacts`/
`readArtifacts`, confirmed NOT flattened, full `TestPlan` reaches the compiler this session). There is no
second evidence type (no "read this file," no "this Page Object exists," no "this API contract exists").

## 6. Context Flow

`state.context` carries mission/goal/target metadata only (`workflow/state.ts`). A `context.budget` field
exists in the schema (`state.ts:393-408`) but has **no producer** anywhere in this graph — confirmed dead.
The one real token-budget module in the codebase, `server/ai/contextBudget.ts:25` (`assemblePromptBudget`),
is wired only into chat-memory assembly (`server/ai/memory/contextAssembler.ts:68`) — never into this
pipeline. Confirmed this session: **no context-window loss is happening in this pipeline** — the exclusion
of ambiguous/ non-unique DOM nodes at `renderCatalogForPrompt.ts:17-22` is a hard filter, not truncation.

## 7. Prompt Flow

Two LLM calls per run (author_cases, author_plans), each: system prompt (`server/ai/systemPrompts.ts:538,
542`) + mission/goal + the DOM-only catalog string. Neither prompt ever includes repository content, an
existing Page Object's method signatures, or an existing spec file's selectors — there is no code-context
assembly step comparable to `contextAssembler.ts` for source files.

## 8. Current Problems

1. **Discovery is single-shot and static.** `domExplorer.ts:549-638` never fills a search box and
   re-captures — dynamic content (search results, post-submit validation banners) that only exists after
   an interaction is invisible to grounding by construction.
2. **No semantic disambiguation between similarly-labeled controls.** `evidenceGraph.ts:74-82` names a
   node from its own label/placeholder text with no role-aware distinction between "an input used to
   search" and "a results container."
3. **OPEN_MODULE is an unvalidated escape hatch.** `authoring.ts:460` exempts `OPEN_MODULE` targets from
   the one semantic gate that exists (`catalogTargetIssues`), making it the path of least resistance for
   any instruction the model can't map cleanly to FILL/CLICK.
4. **Zero codebase grounding, even when a repo is connected.** The connected repo for Core Platform
   already contains the correct answer for the exact case tested this session
   (`D:\core-platform\tests\e2e\account-creation.spec.ts`) and the pipeline never looks at it.
5. **No persisted per-run debugging surface.** `agentNativeFlag.ts` — `isAgentNativeEnabled()` is
   hardcoded `return false` ("permanently off, no env toggle"). The `AGENT_NATIVE_V1` Postgres mirror for
   `agent_run_artifacts` (compiled plans, selectors, metadata) never fires; confirmed via direct query
   this session (0 rows for a completed run). Rich intermediate state is process-memory-only and
   unrecoverable after any restart — a debuggability gap, not a correctness bug, but it slowed this exact
   investigation.

## 9. Root Cause Analysis

Traced this session via a 6-agent parallel investigation (311K tokens) plus live Playwright verification
against Keystone and a direct Postgres query of `agent_run_artifacts`:

- **Bug A (wrong selector)**: discovery never performs the search action → no evidence node for a real
  result row ever exists → the only catalog entry matching the phrase "search results" is an unrelated
  list-filter input, which resolves "correctly" (exact match, by design) to the wrong element.
- **Bug B (OPEN_MODULE stubs)**: `authoring.ts:426`'s "never merge/drop behavior" instruction is
  unenforced prose; `authoring.ts:460` exempts OPEN_MODULE from the one gate that could catch a
  multi-clause instruction wrongly collapsed into one step.
- **Meta-root-cause**: both are instances of the SAME underlying design gap — **grounding has exactly one
  source (a single live DOM snapshot) and no fallback/cross-check against anything else**, including a
  connected repository that, when present, is authoritative and already correct.

## 10. Proposed Architecture

Add a **second, higher-priority grounding source** — the connected repository — consulted BEFORE live
discovery, not instead of it:

```
load_context
  → discover_repo_grounding (NEW)     — only runs if project.repoPath is set
      · locate existing Playwright/Cypress/e2e specs + Page Objects for the target app/module
      · locate the relevant frontend component source (form fields, button labels, list views)
      · locate the relevant backend route/API contract (for waitForResponse-style assertions)
      · produce a RepoGroundingCatalog: verified selectors/Page-Object methods/API paths, each
        tagged with its source file:line (so it's auditable, same spirit as EvidenceGraph provenance)
  → discover_and_ground (EXISTING, demoted to fallback/verification)
      · runs always (repo-less apps like Keystone still need it — it's their ONLY source)
      · when repo grounding exists for a target, live discovery is used to VERIFY the repo-derived
        selectors still resolve on the live page (catches drift), not to originate new ones
  → author_cases / author_plans
      · catalog passed to the LLM prefers RepoGroundingCatalog entries; falls back to
        EvidenceGraph-only entries exactly as today when no repo grounding exists for that target
  → compile_and_validate
      · when a plan step resolves against a RepoGroundingCatalog entry that names an existing Page
        Object method (e.g. LauncherPage.selectApp), the compiler EMITS A CALL INTO THAT PAGE OBJECT
        instead of re-deriving a raw selector — reuses the maintained abstraction directly
      · falls back to today's EvidenceGraph-selector compilation otherwise
```

Key properties:
- **Additive, not a replacement.** Apps without a connected repo (Keystone) are completely unaffected —
  they keep exactly today's pipeline.
- **App-agnostic.** Discovery of "what Page Objects/specs exist" is structural (file/AST search for
  Playwright/Cypress patterns, exported classes, `page.locator`/`getByRole` calls), never a hardcoded
  app name — consistent with CLAUDE.md's no-hardcoding rule.
- **Auditable.** Every RepoGroundingCatalog entry carries file:line provenance, same as EvidenceGraph
  nodes carry DOM provenance today — no loss of traceability.

## 11. Complete Refactoring Strategy

Three additive pieces, each independently testable:
1. A repo-grounding discovery module (new) that, given a `repoPath` + target app/module label, returns a
   `RepoGroundingCatalog`.
2. A catalog-merge step in `renderCatalogForPrompt.ts` that prefers repo-grounded entries over DOM-only
   ones for the same semantic target, with no change to callers.
3. A compiler branch in `playwrightCompiler.ts` that, when `resolveTarget` resolves against a
   repo-grounded Page-Object-method entry, imports and calls that method rather than emitting a raw
   selector object.

## 12. Every File That Must Change

| File | Change |
|---|---|
| `server/features/agent/workflow/nodes/discovery.ts` | Add repo-grounding call before/alongside live discovery; gate on `repoPath` presence |
| NEW: `server/features/agent/workflow/nodes/repoGrounding.ts` | Locate + parse existing Playwright specs/Page Objects/API routes in the connected repo |
| `server/features/agent/compiler/renderCatalogForPrompt.ts` | Merge repo-grounded entries ahead of DOM-only entries; preserve existing shape/limit for repo-less apps |
| `server/features/agent/compiler/playwrightCompiler.ts` | New branch: emit a Page-Object method call when the resolved target names one; existing selector-emission path unchanged as fallback |
| `server/features/agent/workflow/graphs/testAuthoringGraph.ts` / `testRunGraph.ts` | Wire the new discovery step into the graph (node registration + edges) |
| `server/features/agent/workflow/artifactStash.ts` | Add `repoGroundingCatalog` to `RunArtifacts` (mirrors existing pattern) |
| `docs/diagnostics/` | New forensic report documenting this session's live-verified findings (already substantially captured in this conversation; formalize on approval) |

Not touched: `execute_tests`, `investigate_failures`, `finalize`, the defect-classification work done
earlier this session, RecordPlay/CodegenPanel UI, agent bundle/runner.

## 13. Why Each File Must Change

Covered inline in §12 — each change is the minimal insertion point for "prefer repo truth, fall back to
DOM truth," at the exact place each existing stage already reads its grounding source.

## 14. Risk Level Per File

| File | Risk |
|---|---|
| `repoGrounding.ts` (new) | Low — new, additive, no existing callers to break |
| `discovery.ts` | Medium — must not slow down or block repo-less runs; gate carefully |
| `renderCatalogForPrompt.ts` | Medium — shared by author_cases AND author_plans; a bug here affects both |
| `playwrightCompiler.ts` | High — core compile path; the Page-Object-call branch must be provably inert when no repo grounding exists, verified by the existing 47-test defect-reporter-style suite pattern this repo already uses |
| Graph wiring | Medium — LangGraph node/edge changes are easy to get subtly wrong (verified this session: STAGE_ORDER, checkpointer) |

## 15. Backward Compatibility Concerns

Every repo-less app (external SaaS like Keystone, or any project without `repoPath`) must produce
byte-identical behavior to today — the new stage is a no-op for them. Existing compiled scripts / saved
recordings are unaffected (this only touches case authoring for NEW Agent Console runs).

## 16. Migration Strategy

None required — no data migration. Purely additive pipeline stage + compiler branch, flag-gated for
staged rollout (see below).

## 17. Testing Strategy

- Unit: repo-grounding discovery against `D:\core-platform`'s real `tests/e2e/` — assert it finds
  `account-creation.spec.ts`'s Page Objects and surfaces them with correct file:line provenance.
- Integration: re-run the exact prompt from this session ("test account creation in the crm using only 2
  test cases", Keystone... no wait, this needs a project WITH a repo — use "Core Platform" / Admin, or a
  Keystone-equivalent object under Core Platform, so repo grounding actually engages) and diff the
  compiled script against `account-creation.spec.ts` — success criterion is "uses real selectors/Page
  Objects, not a DOM guess."
- Regression: existing 47 defect-reporter tests + agent-workflow-state tests must stay green.

## 18. Rollback Strategy

Flag-gate the new discovery stage and compiler branch (one flag, e.g. `REPO_GROUNDING_V1`, default OFF).
Disabling the flag reverts to exactly today's pipeline with zero code reverts needed.

## 19. Estimated Implementation Effort

Medium — one focused phase, roughly 6-7 files, fits within CLAUDE.md's 10-15 file / one-subsystem scope
cap as a single phase.

## 20. Recommended Implementation Order (Phase Checklist)

**Phase 1 — Repo-grounding discovery (read-only, additive)**
Files: `repoGrounding.ts` (new), `artifactStash.ts`. Risk: Low.
Exit gate: given `D:\core-platform`, correctly enumerates `tests/e2e/**` Page Objects/specs with
file:line provenance; zero effect on any existing run (not wired into the graph yet).

**Phase 2 — Wire into discovery + catalog rendering**
Files: `discovery.ts`, `renderCatalogForPrompt.ts`, graph wiring. Risk: Medium.
Exit gate: for a repo-connected project, the author_cases/author_plans prompt's catalog includes
repo-grounded entries; for a repo-less project (Keystone), catalog is byte-identical to today.

**Phase 3 — Compiler Page-Object-call emission**
Files: `playwrightCompiler.ts`. Risk: High.
Exit gate: re-running this session's exact scenario against a repo-connected equivalent produces a
script that reuses `LauncherPage`/`ObjectPage`-shaped calls instead of raw DOM-derived selectors;
existing repo-less compilation path unchanged (regression suite green).

---

*No code changes were made in the production of this document. Await explicit approval before starting
Phase 1.*
