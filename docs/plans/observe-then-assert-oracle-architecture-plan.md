# Observe‑Then‑Assert Oracle — Architecture Plan (Phase 0, analysis only)

Date: 2026‑07‑29. Author mode: Principal Architect (Phase 0 — no code changes in this pass).
Problem owner memory: [[project-assertion-and-skip-fixes]] (create/validation flows are LLM‑authoring‑limited,
1/6↔5/6 variance on identical input). This plan proposes the one lever a compiler/critic patch cannot pull.

## 0. The single root cause (restated)

Our author writes **assertions (claims about dynamic behavior)** from a **static snapshot of controls** plus the
model's prior about "how apps usually work." For read flows the prior is right → 10/10. For create/validation/
transform flows the prior is app‑specific and wrong → the variance. Every deterministic fix we shipped corrects
*how* a claim is written; none can know *whether the claim is true of this app*, because the author never watched
the app do the thing. This is **assert‑from‑guess**. The fix is **assert‑from‑observation**.

## 1. Executive summary

The wider field has already converged on one answer to this exact failure, from three independent directions:

1. **Agentic browser automation — the Validator loop.** Skyvern 2.0's **Planner → Actor → Validator** cycle took
   WebVoyager from ~45% (v1) to **85.85%** (v2). The single change that produced most of that jump was adding a
   **Validator** that *observes the real post‑action state* and either confirms the goal or reports the delta back
   for self‑correction — at runtime, against reality, not against a guess. Skyvern is also the field's best
   form‑filling agent, which is precisely our weak class.
2. **Classic test generation — capture‑and‑assert.** EvoSuite / Randoop / Pynguin never *guess* an expected value.
   They **execute first**, capture the observed return/state, then **instantiate assertion templates from what was
   observed**. Assertions are derived from a real run, so they pass on correct software by construction.
3. **LLM‑assertion research.** One‑shot LLM assertions are 11–48% correct; wrapping them in a **rectification loop
   that uses captured runtime values as ground truth** (and regenerating the assertion from the observed value) is
   what moves the needle. Fresh‑entity ground truth must **resolve at runtime** via token replacement — which we
   already do with `{{unique.*}}` / `{{faker.*}}`.

Conclusion: adopt the **observe‑then‑assert loop** as a first‑class pipeline stage. Build it **in‑house on our
existing Playwright/`pageSession` substrate** so it stays deterministic and keeps our core invariant (*the LLM
authors an abstract plan; it never emits raw Playwright, and now it never invents an expected value either*).

## 2. Tool / MCP / Skill survey — can we buy this instead of build it?

Researched the current (2026) field for a drop‑in. Verdict per candidate against our hard constraints
(deterministic compiler, LLM‑never‑emits‑code, no hardcoding, app‑agnostic, self‑hosted headless Ubuntu):

| Candidate | What it gives | Why it does / doesn't fit |
|---|---|---|
| **Skyvern** (MCP + agent) | Planner‑Actor‑**Validator**; SOTA form‑filling | **Pattern: adopt. Runtime: reject.** It's a vision‑LLM agent that decides actions at runtime — non‑deterministic, would replace our compiler and break "LLM never emits code." We take its *Validator* idea, not its runtime. |
| **Playwright MCP** (Microsoft) | Accessibility‑tree snapshot + ARIA‑snapshot assertions | We **already** extract the accessibility tree (`domExplorer` + `ariaSnapshot`); prior research confirmed ours is best‑practice. Adds little. Its ARIA‑snapshot assertion style is worth mirroring in our oracle. |
| **Stagehand v3** | `observe()` / `act()` / `extract()`, self‑heal | Explicitly **not a test framework — no assertions, no pass/fail**. Gives an observe primitive we already have. No oracle. |
| **browser‑use** | 89% WebVoyager autonomous agent | Same problem as Skyvern: LLM‑at‑runtime agent, not a deterministic compiler target. |
| **Midscene.js `aiAssert()`** | NL/vision assertion that *observes rendered page* and throws if false | **Closest reusable primitive.** But: adds a vision‑LLM **runtime** dependency, and it only *wins* for purely‑visual conditions (color/highlight/layout). **Our failing class (validation shown, value transformed, field required) is fully observable in the DOM/ARIA we already capture** → no vision model needed. Keep as an **optional flag‑gated fallback oracle** for visual‑only asserts; not the primary mechanism. |
| Chrome DevTools MCP / Selenium MCP / BrowserStack MCP | Inspection / grid / device cloud | Orthogonal to the oracle problem. |

**Decision:** No off‑the‑shelf tool drops in without breaking the deterministic guarantee. The reusable *assets* are
(a) Skyvern's **Validator loop**, (b) EvoSuite's **capture‑and‑assert**, (c) Playwright's **ARIA‑snapshot**
assertion resilience, (d) Midscene's `aiAssert` as an **optional** visual‑only fallback. Build the oracle in‑house
on `pageSession`; wire Midscene behind a flag for the residual visual class only.

### 2.1 Licensing constraint — permissive / MIT only (required by owner)

Verified licenses (2026‑07). Only MIT‑style / permissive dependencies may enter the codebase; AGPL is excluded.

| Tool | License | Use here |
|---|---|---|
| **Playwright** (`@playwright/test`) | **Apache‑2.0** | Already a core dependency — the whole in‑house oracle runs on it. No new obligation. |
| **Midscene.js** (`web-infra-dev/midscene`, ByteDance) | **MIT** ✅ | Safe as the optional visual‑only fallback (`VISUAL_ORACLE_V1`). |
| **Stagehand** | **MIT** ✅ | Not needed (no assertions) but license‑clean if ever wanted. |
| **browser‑use** | **MIT** ✅ | Not adopted (LLM‑at‑runtime) but license‑clean. |
| **Playwright MCP** | Apache‑2.0 | Not needed (we already have accessibility‑tree extraction). |
| **Skyvern** | **AGPL‑3.0** ❌ | **Do NOT vendor or import its code.** AGPL's network clause is incompatible with a commercial product. We adopt only its *Validator design pattern* (ideas aren't licensed); zero Skyvern code enters the repo. |

Net effect: the primary build adds **no new external dependency** (it's in‑house on our existing Apache‑2.0
Playwright). The only optional new dependency is **Midscene (MIT)**. Fully compatible with an MIT/permissive‑only
policy.

## 3. Existing architecture (as‑is, code‑cited)

LangGraph (`AGENT_GRAPH_V2`, on): `validate_request → load_context → discover_and_ground → author_cases →
review_cases → author_plans → compile_and_validate → execute_tests → investigate_failures → finalize`
(`server/features/agent/workflow/testRunGraph.ts`).

- Observe substrate already exists: `server/features/agent/pageSession.ts` (`observePage`, grid‑ready wait) and
  `server/features/agent/domExplorer.ts` (`VerifiedElement`, `exploreFormState`, `stateTag`).
- Evidence: `discovery.ts` → `grounding.ts` (`toVerifiedSelector`) → `graph/evidenceGraph.ts` (`EvidenceNode`,
  `stateTag`, `isDataInstance`) → `compiler/renderCatalogForPrompt.ts` (what the author sees).
- Author: `workflow/nodes/authoring.ts` (`buildPlanPrompt`) emits an abstract `TestPlan`
  (`compiler/testPlan.ts`, verbs from `PLAN_ACTIONS`/`PLAN_ASSERTS`).
- Compile: `compiler/playwrightCompiler.ts` grounds targets (`resolveTarget`), emits MissionRunner Playwright;
  runtime asserts in `compiler/missionRunner.template.ts` (`expectValidation`, `expectChecked`, `expectValue`).
- Critic: `server/agent-core/critic/caseCritic.ts` (P4, pre‑compile; `assert-sequencing` et al.).

**The gap, precisely:** everything from `discover_and_ground` onward describes *structure*. Nothing ever performs
the candidate interaction and records the app's *behavioral response* before the author commits an expected value.
`investigate_failures` runs *after* execution but only explains failures; it does not feed a corrected, observed
expected value back into authoring.

## 4. Proposed architecture (to‑be)

Two new deterministic stages that reuse `pageSession`; the LLM's job shrinks (it stops inventing expected values).

### 4.1 New node — `probe_behavior` (the capture‑and‑assert oracle), before `author_cases`

For the mission's target flow(s), drive the real app in a **throwaway probe session** and record the observed
behavior as **BehaviorOracle** facts on the `EvidenceGraph`. App‑agnostic probes (all derived from the learned
understanding + discovered form controls, no hardcoded field names):

- **Required/validation probe:** open the create form, submit with fields empty, capture *what actually happens* —
  ARIA alert / `aria-invalid` / inline error text / button stays disabled / nothing. Record per‑field:
  `validationMechanism ∈ {alert, aria-invalid, inline-text, button-disabled, none}` and the grounded error locator.
- **Transform probe:** fill one representative value, submit (or blur), read the persisted value back — record
  `transform ∈ {verbatim, lowercased, trimmed, derived-from<field>, truncated@N}` from observed input→output.
- **Auto‑derive probe:** detect fields that populate themselves when another is filled (our "API name auto‑derives"
  class) → record `autoDerived: true` so the author never asserts "required" on them.

Oracle facts become first‑class `EvidenceNode`s. `renderCatalogForPrompt` surfaces them so the author asserts
**from observation** ("API Name shows a validation *alert* when empty"; "Prefix is *truncated to 3*"), and the
compiler picks the assertion *mechanism the app actually uses* instead of a guessed one.

### 4.2 New node — `validate_outcome` (Skyvern's Validator), replacing/among `investigate_failures`

After `execute_tests`, for each failed assertion classify **app‑defect vs assertion‑defect** by comparing the
asserted expectation against the **observed** post‑action state (already captured by MissionRunner):

- observed state ⟂ a plausible correct behavior recorded by the oracle → **assertion‑defect** → emit a corrected
  expected value *from the observation* and route back to a **bounded** re‑author of only that case (reuse
  `routeAfterCompile` / `PER_CASE_REPAIR_V1` machinery; cap at `MAX_REDISCOVERY_ATTEMPTS`).
- observed state contradicts the oracle's recorded correct behavior → **genuine product defect** → surface as a bug
  (feeds the existing bug‑investigation framework), do **not** rewrite the assertion to make it pass.

This is the loop that took Skyvern 45%→85.85%: observe reality, correct the *claim* when the claim was wrong, flag
the *app* when the app was wrong — and never confuse the two.

### 4.3 Optional fallback — Midscene `aiAssert` (flag `VISUAL_ORACLE_V1`, default OFF)

Only for residual *visual‑only* conditions the DOM/ARIA can't answer (color, highlight, layout). Wrapped so a
visual assert compiles to a single `aiAssert(<observed NL condition>)` call. Keeps the vision‑LLM dependency
opt‑in and off the critical path; our own oracle handles the value/state/validation classes with zero runtime LLM.

## 5. Why this converges where patches didn't

Each prior patch relocated the failure because it corrected the *form* of a guess. The oracle removes the guess:
the expected value is *read from the running app*, so "assert validation on a field I just filled," "assert
required on an auto‑deriving field," and "assert the raw typed value under a transform title" become **impossible
to author** — the oracle facts contradict them before the compiler runs, and the Validator catches any that slip
through with a correction sourced from observation, not from a second LLM guess (the thing that made
critic+one‑revision itself a source of variance).

## 6. Files that must change (est.), with risk

| File | Change | Risk |
|---|---|---|
| `server/features/agent/pageSession.ts` | Add app‑agnostic probe helpers (submit‑empty, read‑back, derive‑detect) reusing existing observe/wait | Med |
| `server/features/agent/probeBehavior.ts` (new) | The probe orchestration → BehaviorOracle facts | Med |
| `server/features/agent/graph/evidenceGraph.ts` | `BehaviorOracle` node kind + accessors | Low |
| `server/features/agent/workflow/nodes/*` + `testRunGraph.ts` | Insert `probe_behavior`; add `validate_outcome`; wire bounded re‑author | High |
| `server/features/agent/compiler/renderCatalogForPrompt.ts` | Render oracle facts to the author | Low |
| `server/features/agent/workflow/nodes/authoring.ts` (`buildPlanPrompt`) | "Assert from the observed behavior facts; never invent an expected value" | Med |
| `server/features/agent/compiler/playwrightCompiler.ts` | Choose assertion mechanism from oracle `validationMechanism`/`transform` | Med |
| `server/features/agent/compiler/missionRunner.template.ts` | Capture post‑action observed state for the Validator | Low |
| `server/agent-core/critic/caseCritic.ts` | Cross‑check drafts against oracle facts (replaces heuristic guesses) | Low |
| `compiler/visualOracle.ts` (new, flagged) + Midscene dep | Optional `aiAssert` fallback | Low |

Scope note (CLAUDE.md cap 10–15 files / one subsystem): this is **two subsystems** (probe/oracle; validator loop).
Split into two phases; do not implement both in one pass.

## 7. Flags, compatibility, rollback

- `BEHAVIOR_ORACLE_V1` (probe + oracle authoring), `VALIDATE_OUTCOME_V1` (validator loop), `VISUAL_ORACLE_V1`
  (Midscene fallback) — all default **OFF**; live path unchanged until enabled. Rollback = clear the flag.
- Backward compatible: oracle facts are additive `EvidenceNode`s; when absent, authoring/compile behave as today.
- Cost/latency: one extra throwaway probe session per mission target (bounded, reuses warm browser).

## 8. Testing strategy

- Unit: probe classifiers (validation‑mechanism, transform, auto‑derive) against fixture pages; oracle → catalog
  rendering; Validator classification (app‑defect vs assertion‑defect) on synthetic observed states.
- Live E2E on the SUT: the create/validation flows that swing 1/6↔5/6 today — target **stable ≥5/6 across repeats**
  (kill the variance, not just the mean). List‑view flows must stay 10/10 (no regression).
- Honesty gate: report the *distribution across repeated runs*, not a single lucky run.

## 9. Recommended order (phase checklist)

- **Phase A — Behavior Oracle** (`probe_behavior`, `probeBehavior.ts`, `pageSession` probes, `evidenceGraph`,
  catalog render, authoring prompt, compiler mechanism selection). Flag `BEHAVIOR_ORACLE_V1`. Risk: High. ~8 files.
- **Phase B — Validator loop** (`validate_outcome`, MissionRunner observed‑state capture, bounded re‑author,
  app‑defect routing to bug framework). Flag `VALIDATE_OUTCOME_V1`. Risk: High. ~5 files.
- **Phase C — Visual fallback** (Midscene `aiAssert`, flagged). Risk: Low. ~2 files. Optional.

Build A, measure the variance kill, *then* B. Do not start B until A is validated live.

## 10. Sources

- Skyvern 2.0 Planner‑Actor‑Validator, 45%→85.85% WebVoyager; best form‑filling agent.
- EvoSuite/Randoop/Pynguin capture‑and‑assert (execute → capture observed state → instantiate assertions).
- LLM‑assertion research: one‑shot 11–48%; rectification loop w/ runtime‑captured ground truth; runtime‑resolved
  fresh‑entity ground truth via token replacement.
- Playwright MCP accessibility‑tree / ARIA‑snapshot assertions; Stagehand observe/act/extract (no assertions);
  browser‑use; Midscene.js `aiAssert` (vision assertion).
