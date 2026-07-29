# Why cases get skipped into scripts — grounding + compile architecture audit & plan

Phase-0 analysis (two qualified-agent audits, code-cited). Answers: is the agent doing DOM extraction
properly, and do we need an architecture change? **Short answer: the eyes work; the FILTER and the COMPILER
are the problem. Yes — a targeted architecture change to the grounding contract + compile gate, not vision.**

---

## 1. The question

8 authored cases frequently yield only 4–5 scripts, non-deterministically. User suspected DOM extraction /
"seeing the website" is failing.

## 2. Brutal-honest findings (two audits, converging)

### 2a. Is DOM extraction working? — YES, and it is not vision.
- The inspector reads the **real DOM + accessibility tree**, not screenshots. Screenshots are saved but never
  fed back as grounding — so "seeing the website" is a DOM/a11y read, and that is the correct design.
  **Vision grounding is NOT needed.**
- Per-element capture is **deep and correct**: implicit ARIA role, aria-label, data-testid/field, name, id,
  `<select>` options, placeholder, disabled/readonly/**required**, min/max/pattern, tooltip, label text, row
  keys. (`domExplorer.ts:319-443`.) This is not where it's thin.

### 2b. The dominant root cause — captured, then THROWN AWAY (grounding gate).
- Grounding admits a control as an executable target only if it is **unique on the page**:
  `verified && confidence==='verified-live' && uniqueness===true && visibility===true`
  (`evidenceGraph.ts:99`; demotion in `grounding.ts:56`).
- On a List View, every row has "Edit"/"Delete"/checkbox → `resolveBestSelector` yields the **same**
  `role=button[name="Edit"]` for all → `count>1` → `not_unique` → demoted to non-executable "pool" and
  **excluded from the target catalog**. Row-scoping exists only for `role==='row'` with a rowKey; a bare
  per-row button is discarded, not disambiguated.
- Result: a case targeting a repeated/row-level control has **zero verified targets → cannot compile → no
  script** — while the evidence gate still returns `continue` because *other* cases' unique controls exist
  (`grounding.ts:120`). **The failure is masked as success.** The element was seen; the filter deleted it.

### 2c. The amplifier — all-or-nothing compilation (compile gate).
- `playwrightCompiler.ts:345`: `ok = diagnostics.length === 0`. **One** unresolved step of an 8-step case
  discards the **entire** case — 7 good steps thrown away. `Diagnostic` has no severity, so even a bad
  *optional assertion* nukes the case (`Compiler.ts:11-18`).
- The self-repair information is collected (`rediscoveryTargets`, `compilation.ts:93`) but only consumed when
  **zero** scripts compiled (`routeAfterCompile`, `testRunGraph.ts:182`). On the common *partial* run the
  dropped cases are abandoned, never retried.

### 2d. Why non-deterministic + silent.
- Two stochastic layers feed the zero-tolerance gate: plan-LLM names a target slightly differently
  run-to-run (`UNRESOLVED_SELECTOR`), and grid/async timing changes whether a control is unique at capture
  (`AMBIGUOUS_SELECTOR`). Either flips a case script→nothing → the 4-vs-5 swing.
- `terminalFailureReason` only narrates skip reasons when **all** scripts fail (`testRunGraph.ts:240`), so a
  partial run looks arbitrary to the user.

### 2e. Real (secondary) extraction weaknesses.
- **Weak grid-ready wait on the DEFAULT graph path.** `observePage` (`pageSession.ts:133-141`) treats the
  page as ready when `a,button,form,h1…` exist — a nav bar satisfies it instantly, so the default engine can
  read a grid **before rows arrive**. The classic path's strong positive grid-row wait
  (`inspectionService.ts:427-436`) was never ported to the graph node.
- **Only ONE form is ever opened** (`discovery.ts:160`, `.find()`), and only if its overlay matches a fixed
  vocabulary (`dialog/modal/drawer/…`, `:136`); a custom container falls back to a full-page capture where the
  600-node `sweepDom` cap (`domExplorer.ts:507`) drops fields rendered at the DOM tail.

## 3. Verdict

Architecture change — but **not** "add vision." The capture layer is largely sound. Change:
1. the **grounding contract** (stop discarding non-unique controls), and
2. the **compile gate** (stop letting one bad step delete a whole case), and
3. port the **grid-ready wait** so the default engine stops reading half-loaded grids.

## 4. Proposed architecture (prioritized by impact / low blast-radius)

**P1 — Disambiguation-first grounding (biggest recovery).** When a resolved selector matches N>1 live nodes,
do NOT demote to non-executable pool — synthesize a stable scoped locator (row-key → nearest-labeled-ancestor
→ `nth`) and promote it as a verified target. Files: `grounding.ts:56-61` (`toVerifiedSelector`),
`evidenceGraph.ts:99` (admission), `domExplorer.ts` (`candidatesFor` row/context scoping). Risk: MED (core
grounding contract) — gate behind a flag; measure catalog size + script yield before/after.

**P2 — Severity-aware, partial compilation.** Give `Diagnostic` a `severity: 'blocking' | 'skippable'`. A
case still emits a script when only *skippable* diagnostics remain (drop the optional assertion, keep the
flow); only a blocking step (the step's primary action can't ground) drops the case. `ok` = "no blocking
diagnostics". Files: `Compiler.ts:11-18`, `playwrightCompiler.ts:281-345`, `compilation.ts:96`. Risk: MED.
This is also the correct home for the `UNRESOLVED_TEMPLATE` fail-loud from the assertion-fix work (a template
leak is blocking on that step, skippable for the case).

**P3 — Per-case target-repair loop, decoupled from "everything failed".** When a case has blocking unresolved
targets, drive a *targeted* re-inspection/re-ground of those specific targets and re-resolve that case, even
when sibling scripts already compiled. Consume the already-collected `rediscoveryTargets` regardless of
`scriptCount`. Files: `compilation.ts:113`, `routeAfterCompile` (`testRunGraph.ts:182`). Risk: MED-HIGH (loop
bounds) — cap attempts; report exhaustion.

**P4 — Port the positive grid-ready wait** from `inspectionService.ts:427-436` into `observePage`
(`pageSession.ts:137`). Risk: LOW.

**P5 — Surface skip reasons on partial runs.** The per-case `{caseId, kind, target}` diagnostics exist
end-to-end; render "3 of 8 skipped: UNRESOLVED('Save'), EMPTY_PLAN(case-6)…" even when some scripts
succeeded. Risk: LOW. (Directly fixes the "looks arbitrary" complaint.)

**P6 — Validate plan targets against the catalog inside the plan node** (repair a plan that names a
non-catalog target before the compiler sees it), reducing LLM naming-variance non-determinism. Risk: LOW-MED.

## 5. Sequencing

Ship in this order, each flag-guarded + no-regression-tested + yield-measured on a real run before the next:
**P4 (low) → P5 (low, visibility) → P2 (severity) → P1 (disambiguation) → P6 → P3 (repair loop).**
P4/P5 are safe quick wins; P1+P2 are the recovery core; P3 is the highest-risk and last.

## 6. What this does NOT need
Screenshot/vision grounding; a rewrite of the inspector; abandoning LangGraph or the deterministic compiler.
The eyes read the DOM accurately — the loss is in the filter and the gate.

---

## 7. Implementation status — ALL PHASES BUILT + TESTED (2026-07-29)

Implemented, `npm run lint` clean, unit-tested; the two big correctness levers (P1/P2) and the higher-risk
ones (P3/P6) are flag-guarded and default-OFF so the live path is unchanged until enabled.

Also shipped in the same pass — the ASSERTION-fix thread (the wrong-expected-value failures, 11/14 red):
- **Fix-1 critic** — refutes assertion-vs-behavior contradictions (asserting the raw input under a
  lowercase/normalize/derive title, `{{token}}` in an assert, preserve-vs-normalize) before compile.
  `caseCritic.ts` + `test-agent-critic.ts` (23).
- **Fix-3 normalization-tolerant `expectValue`** — accepts exact OR case/whitespace-normalized so a correct
  app that lowercases/trims isn't failed. `missionRunner.template.ts`.
- **Fix-4 authoring prompts** — caseWriter + plan prompt: assert the TRANSFORMED output or a property, never
  the typed input. `systemPrompts.ts`, `authoring.ts`.

The skip/grounding architecture phases:
- [x] **P4** — ported the strong positive grid-ready wait into the default engine's `observePage`
  (`pageSession.ts`) so it stops reading half-loaded grids.
- [x] **P5** — verified already implemented: DeepRunResult's "N of M cases produced no automated script —
  why?" panel surfaces per-case skip reasons on partial runs (not just full failures).
- [x] **P2** — severity-aware partial compilation: `Diagnostic.severity` (blocking|skippable); `ok = no
  blocking diagnostics`, so a case whose only failure is an ungrounded ASSERTION still ships its script
  instead of being deleted. Home for the `UNRESOLVED_TEMPLATE` fail-loud (never emit a literal `{{token}}`).
  `Compiler.ts`, `playwrightCompiler.ts`, `state.ts`; `test-playwright-compiler.ts` (88).
- [x] **P1** — disambiguation-first grounding (flag `GROUNDING_DISAMBIGUATION_V1`): a non-unique per-row
  control is rescued with a ROW-KEY-SCOPED unique locator (`tr:has-text("<rowKey>") >> role=button[name=…]`)
  via the existing `candidatesFor`, instead of being discarded. `domExplorer.ts`; `test-dom-selector-resolution.ts` (11).
- [x] **P6** — plan-target validation (flag `PLAN_TARGET_VALIDATION_V1`): the plan node rejects a target with
  no catalog candidate so the ONE repair call re-authors it with an exact name (reuses `resolveTarget`, so it
  never false-rejects a resolvable target). `authoring.ts` + `planTargetValidationFlag.ts`.
- [x] **P3** — per-case repair loop (flag `PER_CASE_REPAIR_V1`): a partial run re-grounds to recover dropped
  cases, bounded by `MAX_REDISCOVERY_ATTEMPTS`. Opt-in because re-grounding re-authors all cases (heavy); the
  surgical targeted+additive re-inspection is the recommended follow-up. `testRunGraph.ts` + `perCaseRepairFlag.ts`.

**To enable the recovery levers live:** set `GROUNDING_DISAMBIGUATION_V1=1` and `PLAN_TARGET_VALIDATION_V1=1`
(and optionally `PER_CASE_REPAIR_V1=1`) in `.env.local` and restart the backend, then measure script yield.

Note: `scripts/test-agent-workflow-resume.ts` has 2 PRE-EXISTING failing assertions (checkpointer-replay stub
counters) unrelated to this work — confirmed present before these changes via stash.
