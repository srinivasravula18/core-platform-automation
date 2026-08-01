# Master Remediation Plan — From Estimated ~75% to Measured, Defended Accuracy

**Date:** 2026-08-01
**Author mode:** Principal-architect Phase-0 plan of record. Analysis + sequenced execution plan. **No code is written until a phase is explicitly approved on a later turn** (per `CLAUDE.md` architect process).
**Evidence base:** eight forensic audit sets — architecture, prompts, cross-session memory, tiered memory, behavior/eval/economics/security/production, model-risk/compliance/trust/deployment/org, the live within-session continuity bug, and **one real run replayed out of Postgres with literal payloads at every stage boundary** (`docs/diagnostics/pipeline-stage-handoff-forensics-2026-08-01.md`). Every item below cites `file:line`.

**Companion documents:**
- `docs/diagnostics/forensic-audit-qa-2026-08-01.md` — question→answer record (Sets 1–4)
- `docs/diagnostics/pipeline-stage-handoff-forensics-2026-08-01.md` — single-run stage-handoff trace, 11 ranked defects, all folded into P0/P3.3 below

---

## 0. Read this first — the honest framing

**Three facts that shape the entire plan:**

1. **The "75%" is not measured.** Every eval entry point is a dead script (`package.json:99-104`); `npm run eval:routing` fails. Quality today is spot-checked. **You cannot move a number you cannot see.** Phase 1 exists to create that number before we optimize anything.
2. **100% is not an achievable target** for an LLM pipeline, and chasing it produces overfitting to a test set. The correct goal: **measured accuracy in the mid-90s on a golden set, with every residual failure either (a) caught by a gate and surfaced honestly, or (b) attributable to a specific evidence gap.** "Wrong but confident" is the failure mode we are eliminating — not the existence of failure.
3. **Your accuracy loss is not one bug — it is six loss buckets**, each independently measurable. The phases below are ordered by *accuracy points per unit of risk*, not by architectural elegance.

### The accuracy model (where the missing ~25% actually goes)

| # | Loss bucket | Mechanism (cited) | Phase |
|---|---|---|---|
| L1 | **Agent "forgets" the request** — turn 1 dropped from turn 2's prompt | dual-writer divergence `repository.ts:1979`; fallback gated on empty `contextAssembler.ts:50` | P0 |
| L2 | **Ungrounded/hallucinated output ships** | grounding gate self-disables `caseCritic.ts:191`; no provenance labeling; `verifiedBy` unvalidated `investigation.ts:156` | P3 |
| L3 | **Fake-green / self-declared success** | `accepted:true` on any non-empty text `orchestrator.ts:612-613`; write-verification doesn't gate acceptance `orchestrator.ts:487-515` | P3 |
| L4 | **Cases → scripts attrition** (work silently dropped) | all-or-nothing compile; uniqueness-gated grounding; single-shot critic never re-verified `testRunGraph.ts:425-427` | P3 |
| L5 | **System repeats known-broken approaches** — memory never branches | typed gate is dead code, zero live callers `gate.ts:33-101`; recall only pads the prompt `routes.ts:2974-2981` | P4 |
| L6 | **Injection / stale-context corruption** | two live loop drivers bypass the safety stack `supervisor.ts:638,453`; override replaces it `orchestrator.ts:207-213` | P2 |
| **L7** | **The agent never reaches the target UI — everything downstream grounds on the wrong screen** | `navigateToGoalObject` self-disables when any create opener exists on the landing page `discovery.ts:186`; conditionally-rendered UI reachable only via hardcoded verb regexes `discovery.ts:102`; no iframe/closed-shadow/animation settle `domExplorer.ts:490-527` | **P3.3** |
| **L8** | **Compiler emits provably impossible asserts; post-action truth never re-checked** | submit-guard bails with no submit click `playwrightCompiler.ts:79`; uniqueness verified once on the resting page `domExplorer.ts:861-870`; test-logic defects mis-classified `infra`/`unknown` | **P3.3** |

> **L7 is the highest-value discovery of the whole audit programme.** Proven end-to-end in `docs/diagnostics/pipeline-stage-handoff-forensics-2026-08-01.md`: a run scored 0/2 not because authoring hallucinated but because discovery captured the **New App** form instead of the **Tab** form, and authoring then reasoned correctly about the wrong screen (it even self-reported `@evidence-gap`). **No amount of prompt or critic work fixes a run whose evidence is of the wrong page.** L7 therefore precedes L2/L4 in execution order.

---

## Phase sequencing (why this order)

```
P0  Stop the bleeding        → live bug + data leaks        (days)   ── unblocks trust
P1  Build the ruler          → eval harness + baseline      (days)   ── unblocks every later claim
P2  Enforce, don't suggest   → safety stack + capabilities  (1 wk)   ── removes silent corruption
P3  Accuracy engine          → grounding/verify/critic      (2 wks)  ── the big accuracy jump
P4  Memory that decides      → gate + user facts + recall   (2 wks)  ── compounding accuracy
P5  Cost & reliability       → caps, limits, fallback       (1 wk)   ── unit economics
P6  Governance               → deletion, audit, egress      (1 wk)   ── enterprise sale
P7  Architecture consolidation → the bus decision           (2 wks)  ── debt retirement
```

**Rule for every phase:** ≤10–15 files or one subsystem, flag-gated, shadow-first where behavior changes, then `npm run lint` → tests → **restart the backend** (no hot reload, `CLAUDE.md`) → verify live. No phase starts until the prior one is validated.

---

# PHASE 0 — Stop the bleeding
**Goal:** kill the live context bug and the cross-user data exposure. Nothing else matters while these are open.
**Risk:** Low. **Est. accuracy impact:** +5–10 pts directly (L1). **Scope:** ~6 files.

### P0.1 — Within-session context continuity (the live bug)
- [ ] Add the confirmation log at `server/ai/orchestrator.ts:424` (`messages` = exactly what the model receives) and at `contextAssembler.ts:48-49` (`turns` = what the store returned). **Reproduce and confirm before changing storage logic.**
- [ ] Fix the dual-writer divergence at `server/db/repository.ts:1979` — `get()` currently returns whichever of `chat_messages` (server-written) vs the `turns` JSONB snapshot (console-written) is *longer*, ties→snapshot, so a stale snapshot shadows the real transcript. Establish **one source of truth** (recommend: `chat_messages` authoritative; `turns` becomes a derived cache or is dropped).
- [ ] Make `appendMessages` (`repository.ts:2031-2045`) keep both stores consistent, or remove the second store entirely.
- [ ] Fix the fallback gate at `server/ai/memory/contextAssembler.ts:50` — client history currently restores turn 1 **only when the store is empty**; a non-empty-but-wrong result skips it. Reconcile/merge instead of `!turns?.length`.
- [ ] Reorder `/api/chat` persist before the `final` SSE event (`server/features/chat/routes.ts:113` vs `:116`) — closes the intermittent race.
- [ ] Make the silent no-op loud: `persistExchange` returns early when `conversationId` is falsy with no log (`server/features/controller/routes.ts:58`) — log/error it.
- [ ] Align `workspaceId` between the two chat endpoints (`chat/routes.ts:118` vs `controller/routes.ts:63-65`) so `list()` and assembly agree.
- **Acceptance:** turn 2's logged `messages` literally contains turn 1's text, in a fresh conversation, on both endpoints, 10/10 runs.

### P0.2 — Cross-user data exposure
- [ ] Remove the OR-NULL owner disjunction in `server/ai/memory/runMemory.ts:151-153` — `(owner_id IS NULL OR owner_id = ?)` leaks every null-owner row into **every** user's coder prompt. Require `ownerId`; treat null-owner rows as unreadable (or migrate/backfill them).
- [ ] Ensure writers always supply owner: `execution.ts:162` → `recordRunMemory` (`runMemory.ts:102`) currently writes `owner_id || null`.
- [ ] Scope or remove `loadRunMemories()`'s unscoped `SELECT *` (`runMemory.ts:227`), which is live-wired into every execution trace (`tracer.ts:51`) and embeds other users' data.
- [ ] Enforce `ownerId` at the query in `artifactMemory.ts:91,120` and `repository.ts:1981` (`listMessages`) — today conversation artifacts are keyed by `conversation_id` alone (IDOR).
- [ ] Refuse to write/recall `agent_memory` with an empty owner instead of collapsing to the global `*::*::*` bucket (`store.ts:59-61`).
- **Acceptance:** a scripted two-user test proves User B's recall returns zero of User A's rows across all four read paths.

### P0.3 — Silent data loss & crash safety
- [ ] **FIRST ITEM IN THIS PHASE — `plansByCase` mirror discards plans.** Plans are stashed **per case** (`testRunGraph.ts:521`) but mirrored as a **whole-key replace** (`runStoreMirror.ts:17-22`), so the durable row keeps only the **last** case's plan. **Confirmed empirically: 2 cases compiled, 1 plan persisted.** Bites whenever `AGENT_NATIVE_V1=1` (`.env.local` already sets sibling flags at `:50-51` — verify which are live per environment).
  > **Why this outranks the evidence-count bugs despite a lower severity label:** it is *silent, permanent, per-run* data loss. No error, no chip, no UI signal. The evidence-count confusion is at least visible as "something looks off"; this one quietly discards a case's work and would make you distrust results without ever learning why. Fix before the evidence-tagging plumbing.
- [ ] Gate `reconcileOrphanedRunsOnStartup` on ownership + staleness (`runtime.ts:882-895`) — today a booting instance marks **every** non-terminal run `failed`, cross-killing another instance's live runs.
- [ ] Add optimistic version/lock to `agent_runs` writes (`repository.ts:643-651`) — whole-row last-writer-wins currently drops concurrent phase updates (`routes.ts:1429-1437`).

---

# PHASE 1 — Build the ruler (measurement)
**Goal:** replace "≈75%" with a number that moves. **Nothing after this ships without an eval delta.**
**Risk:** Low (test-only). **Est. accuracy impact:** 0 direct, **enables all of it**. **Scope:** new `scripts/` + fixtures.

- [ ] Restore the dead eval entry points — `eval:routing`, `eval:agents`, `eval:coercion`, `benchmark:agents`, `benchmark:behavior` all reference **missing files** (`package.json:99-104`).
- [ ] Build **golden set v1**: 40–60 frozen cases across the real loss buckets — routing intent, case authoring vs known-good cases, selector grounding, assertion correctness (the transform/preserve/normalize family from `caseCritic.ts:238-241`), compile-success, and false-bug detection.
- [ ] Define the **headline metric** and sub-metrics: end-to-end task success %, plus per-stage: routing accuracy, grounding coverage %, cases→scripts conversion %, assertion-correctness %, false-PASS rate, false-BUG rate.
- [ ] **Record the baseline.** This becomes the real "current %" — expect it to differ from 75.
- [ ] Add a **regression gate**: any prompt or pipeline change runs the suite; a drop beyond tolerance fails.
- [ ] Add an **adversarial subset** (v1, 10–15 cases): prompt-injection strings in repo files/case descriptions/DOM text, scope-violation asks, contradiction traps, loop bait.
- [ ] Persist eval runs over time so quality becomes a **trend line**, not a vibe.
- **Acceptance:** `npm run eval:all` produces a scored report; two consecutive runs are stable within noise; baseline committed to `docs/`.

---

# PHASE 2 — Enforce, don't suggest (safety + capability)
**Goal:** remove the silent-corruption paths. These are cheap and prevent whole classes of wrong output.
**Risk:** Low–Med. **Est. accuracy impact:** +3–6 pts (L6) + eliminates catastrophic tail. **Scope:** ~8 files.

### P2.1 — Restore the safety stack on the live paths
- [ ] Route `SUPERVISOR_SYSTEM` and `ADAPTIVE_CODE_EXPLORER_SYSTEM` through `composeSystemPrompt` (`supervisor.ts:115-132,292-306`, passed raw at `:638,453`) — today the two loops that read untrusted repo/DB/DOM and call live tools have **no** `INJECTION_DEFENSE`, `SAFETY_POLICY`, or `SCOPE_POLICY`.
- [ ] Make a Settings prompt override **layer onto** the composed stack rather than replace it (`orchestrator.ts:207-213` returns `override.body` + a request-id line only, silently deleting all policy). Use `getEffectivePrompt` semantics.
- [ ] Fence untrusted content with explicit delimiters + "data, not instructions" markers: repo files (`supervisor.ts:567,584`; `registry.ts:352-359`), DB artifact text (`controller.ts:73-91,208-210`), DOM labels (`authoring.ts:387-391`).

### P2.2 — Capability enforcement at dispatch
- [ ] Make `capability` **required** on every `AgentTool` (`tools/types.ts:35-42`); delete the name-regex inference (`policy.ts:6-15`).
- [ ] Add a dispatch-time capability/permission re-check before `tool.execute` (`orchestrator.ts:481-482`) — enforcement is visibility-time only today.
- [ ] Add **argument-schema validation** against `tool.spec.parameters` before execute (`orchestrator.ts:482`) — malformed args currently reach tool bodies and cost a full round-trip.
- [ ] Remove hardcoded `TARGET_*` / `/auth/login` from `agentTools.ts:35-37,264,338`; route through the understanding + `credentialsService` layer (violates the repo's own no-hardcoding rule).

### P2.3 — Truncation honesty
- [ ] Inject an explicit `[truncated: N chars omitted]` marker wherever tool results are cut (`orchestrator.ts:670-677`, 8000-char silent slice) and in the authoring blocks (`authoring.ts:371,377`) — the model currently cannot distinguish a complete payload from a mid-JSON clip.

### P2.4 — Prompt-system hygiene, instruction gaps, and consistency
**Source:** prompt audit (33 questions) — the items below are the ones NOT already covered by P2.1–P2.3 or P3.1.

**Instruction gaps that directly cost accuracy:**
- [ ] Add **empty-result and unexpected-shape guidance**. Today only hard *errors* get a recovery hint (`orchestrator.ts:513-514`); an empty `query_workspace`/search result is passed through raw (`:515`) with no interpretation rule, inviting the model to read "found nothing" as "didn't check."
- [ ] Add **contradicting-evidence handling**. No prompt covers reconciling a tool result that contradicts an earlier one — a changed DOM, a previously-verified selector that now fails. Only static-source-vs-live-browser priority exists (`systemPrompts.ts:234,297`). This pairs with P3.3's post-action re-verification: the code must re-check *and* the prompt must say which observation wins.
- [ ] Add a **tool-call budget signal**. No prompt tells the model what a reasonable number of calls looks like; it free-runs to code caps (`supervisor.ts:459-460,641`). The prompt says only "STOP when done" (`:131`).
- [ ] Add **prompt-level confirmation language before live/destructive actions**. Confirmation today is 100% code-gated (`policy.ts:17-24`, `platformApi.ts:6`); if a filter regex misses a tool name, the prompt provides no backstop. The action-driving prompts contain no "confirm before irreversible" instruction.

**Structural contradiction (fix the claim or fix the behavior):**
- [ ] Resolve the `CORE_IDENTITY` conflict: every agent is told *"You do not silently mutate production data. You propose, the human decides."* (`systemPrompts.ts:40-42`), yet under the default `auto` review policy the pipeline executes against the live app with **no human gate** (`routeAfterAuthorCases:168`; script review removed at `testRunGraph.ts:180-181`). Either the prompt is lying to the model or the default policy is wrong — pick one deliberately.

**Registry/ownership hygiene:**
- [ ] Give the critic its own prompt, or stop registering it as an LLM agent. `CriticAgent` borrows `caseWriter`'s prompt (`agents.ts:103`) while the critic that actually runs is deterministic code with no rubric (`caseCritic.ts:228-244`). The deterministic critic is the *right* design — the defect is the misleading registry entry plus the `verify_selectors`/`list_api_endpoints` tools it is granted and never uses.
- [ ] Remove or reconnect the **seven dead personas** — `caseReworker, stepExpander, runNamer, namingAgent, gitWatcher, folderOrganizer, reportNarrator` are shadowed by `AGENT_ALIASES` (`systemPrompts.ts:523-535`) yet remain fully defined in `AGENT_PROMPTS` + `roleMap`; a single alias-line change silently resurrects stale text. Also resolve the `searchAgent` orphan (live but un-canonical/un-editable) and confirm whether `explainer` has any live call site.
- [ ] Unify agent terminology — **three naming schemes for the same actors**: canonical prompt keys (`appInspector`/`caseWriter`/`playwrightCoder`/`defectTriage`), registry/bus names (`ApplicationInspector`/`TestGenerationAgent`/`PlaywrightAgent`/`CriticAgent`, `agents.ts:100-104`), and caseWriter's own producer list (`FeatureAnalyst`/`FeatureDiscoveryAgent`/`E2EFlowAgent`, `systemPrompts.ts:203`). A receiving agent can mismap handed-off content on names alone.
- [ ] Rename the confusable twins `server/ai/verifier.ts` (live-DOM grounding gates) vs `server/ai/verification.ts` (DB/API re-read mutation verifier) — near-identical names, opposite purposes, import-the-wrong-one hazard.
- [ ] Restate the scope boundary **near the end** of long personas. The four policy blocks are all front-loaded (`systemPrompts.ts:152-164`); caseWriter runs ~48 lines past them, so the boundary sits where it is most diluted.
- [ ] Fix the encoding corruption at `systemPrompts.ts:218` (`expected result � no exceptions`) — one character, trivially fixed, currently sitting in the most-used authoring prompt.
- [ ] Make the deterministic gates language-agnostic or scope them honestly: critic/oracle regexes are English-only (`caseCritic.ts:142-147`, `behaviorOracle.ts:101-104`) while `SCOPE_POLICY` invites non-English input (`systemPrompts.ts:68-69`) — grounding/refutation coverage silently drops to zero for non-English cases.
- [ ] Establish a **single prompt index**: the registry covers 19 personas, but the two most powerful runtime drivers (`SUPERVISOR_SYSTEM`, `ADAPTIVE_CODE_EXPLORER_SYSTEM`) plus node addenda live in code files, so finding "every prompt" requires a repo grep.

### P2.5 — Context-assembly correctness (what actually reaches the model)
- [ ] Add **supersession dedup**: a summary segment and the verbatim turns it summarizes can both be injected (`contextAssembler.ts:63-66`), so a stale statement sits beside its own correction — mitigated only by a "background, not authoritative" wrapper (`:91-92`), not by removal.
- [ ] Pick **one canonical version per fact**: ledger + segments + turns (`contextAssembler.ts`) and client-history + workspace-snapshot (`controller.ts:130-144`, which falls back between two sources that can disagree) can co-inject contradictory facts with no resolver.
- [ ] Raise verbatim-turn priority or protect recent turns from eviction — they carry the **lowest** budget priority (`contextAssembler.ts:65`, `10_000+index`) and are dropped first under pressure, which is the latent version of the P0.1 continuity bug in long threads.
- [ ] Emit an explicit **"N earlier turns omitted"** marker into the prompt when the budgeter drops turns (`contextAssembler.ts:70,86`) — the drop is audited in the manifest but invisible to the model.
- **Acceptance:** adversarial eval subset (P1) passes; no prompt path reaches a provider without the policy blocks (assert in test); a fixture with a corrected fact proves the correction wins over the stale one.

---

# PHASE 3 — The accuracy engine
**Goal:** the largest single accuracy jump. Fix ungrounded output, fake-green, and work attrition.
**Risk:** Medium. **Est. accuracy impact:** +10–15 pts (L2+L3+L4). **Scope:** two sub-phases, ~12 files each.

### P3.1 — Grounding must fail closed and label itself
- [ ] Fix the self-disabling gate: `caseCritic.ts:191` returns "not ungrounded" when the catalog vocabulary is empty — if `evidence.catalog` fails to load (`:216`), the strongest hallucination gate **silently switches off**. Make it fail closed / mark the run low-confidence.
- [ ] Require **provenance labeling** in output: no agent is currently told to mark a claim as live-DOM-verified vs source-inferred (only conflict priority exists, `systemPrompts.ts:234,297`). Add the instruction *and* a schema field.
- [ ] Validate `verifiedBy` against real captured artifacts (`investigation.ts:156-157`) — today it's a self-selected enum tag with no runtime check that the cited evidence supports the claim.
- [ ] Move the per-claim citation requirement into the **base** `defectTriage` prompt (`systemPrompts.ts:265-273`), not only the investigation addendum.
- [ ] Add a token-budget guard to the deep-run authoring prompt (`authoring.ts:362-432`) — fixed char caps today, no model-aware budget, silent provider truncation possible.

### P3.2 — Verification must gate acceptance; critic must close the loop
- [ ] Make a failed write re-read force `accepted:false` (`orchestrator.ts:486-489` computes it, `:484` ignores it) — verification currently only informs the model.
- [ ] Remove the blind-trust terminal: `accepted:true` on any non-empty final text when no `accept()` callback is supplied (`orchestrator.ts:612-613`). Require an explicit acceptance gate per agent.
- [ ] **Wire the dead Reflexion loop** — `opts.accept`/`maxAcceptRetries` (`orchestrator.ts:597-610`) has **zero production callers**; supply grounded `accept()` callbacks for authoring/critic paths.
- [ ] **Re-critique the revision**: author↔critic is single-shot and the revision is accepted on non-emptiness alone (`testRunGraph.ts:425-427`). Add one re-critique pass with a bounded cap.
- [ ] Make the false-PASS oracle consequential: `suspiciousPasses`/`intentSatisfied` are report-only and never block a green run (`investigation.ts:445-448`).
- [ ] Fix cases→scripts attrition: severity-aware partial compile instead of all-or-nothing, and disambiguation-first grounding (both already designed in prior session plans — `playwrightCompiler.ts:345`, `evidenceGraph.ts:99`).
- [ ] Define a **conflict-resolution rule** for disagreeing agents. Today the inspector's required/read-only truth is a one-way prompt hint (`testRunGraph.ts:403-407`) the author is trusted to honor, with no reconciliation and no tie-breaker beyond "proceed."
- [ ] Add a **downstream veto path**. The pipeline is strictly forward (discover→ground→author→plan→compile→execute→investigate); the compiler can refuse unverified selectors (`testRunGraph.ts:181`) but cannot send a run back to re-inspect, and investigation cannot re-open authoring. At minimum, let a compile/execute failure that indicates an evidence gap re-trigger discovery once, bounded.
- **Acceptance:** golden-set assertion-correctness and cases→scripts conversion both improve measurably; false-PASS rate drops; no regression on the adversarial subset.

### P3.3 — Evidence reachability + post-action truth *(run this sub-phase FIRST within P3)*
**Source:** `docs/diagnostics/pipeline-stage-handoff-forensics-2026-08-01.md` — one real run, 0/2 passed, every boundary traced with literal payloads.

**Reachability (L7) — the agent must actually get to the screen under test:**
- [ ] **DESIGN DECISION, not a defect fix — scope separately before implementing.** `navigateToGoalObject` returns immediately when *any* create opener exists on the landing page (`discovery.ts:186` — `if (!goalTerms.length || elements.some(isCreateOpener)) return;`), so a landing-page `New` button cancels navigation to the real goal object. **This single line caused the wrong-screen capture.** But the fix is not "make the heuristic smarter" — it is deciding the policy: *should goal-navigation bias toward a control matching the mission's own subject (a "Tabs" case prefers a Tabs-labeled control) rather than the first plausible create opener?* Answer that first; the code change follows trivially. Treating this as a bug fix will produce another heuristic with a different wrong judgment call.
- [ ] Replace the hardcoded disclosure verb regex (`discovery.ts:102` — `actions|export options|settings|more|menu|filter|filters|columns|options`) with goal-term-driven reachability. Per the repo's no-hardcoding rule, these verbs must come from learned understanding, not a literal list.
- [ ] Add a **reachability assertion before authoring**: if the mission's goal object never appeared in any captured DOM, fail/flag the run rather than authoring against an unrelated screen. (Today authoring self-reports `@evidence-gap` in prose — good, but nothing consumes it.)
- [ ] Add iframe traversal (`page.frames()`), and an animation/transition settle for `captureVerifiedElementsForOpenPage`, which today evaluates immediately with no settle (`domExplorer.ts:850`; the `settle()` helper at `:49-58` is used only by the legacy path). Closed shadow roots remain out of scope — document as a known limit.

**Post-action truth (L8) — stop emitting asserts that cannot pass:**
- [ ] Fix the submit-guard bail: `if (submitIdx < 0) return drops;` (`playwrightCompiler.ts:79`) skips exactly the most impossible case — a validation assert in a plan with **no submit at all**. The behavior oracle already had `requiresSubmitToValidate: true`; the guard just never consulted it. Drop/rewrite such asserts and emit a compiler diagnostic (today `compiler_diagnostics` is literally `[]`).
- [ ] **Then re-measure outcome classification before treating it as a separate fix.** Test-logic defects are currently reported as `infra`/`unknown` with `assertionDefects: 0` (artifact `outcomeValidation`) — but these two are **compounding, not independent**: the impossible assert *produces* the failure that the classifier then mislabels. Fix the guard first, re-run, and only fix the classifier for whatever still mis-sorts. Do not open these as two parallel tickets.
- [ ] Re-verify selector uniqueness **after** state-changing actions, not once on the resting page (`domExplorer.ts:861-870`). The Tabs click rendered a second matching control → strict-mode violation on a locator that was genuinely unique at discovery time. **This is the concrete meaning of "executes differently than a human":** a human doesn't re-verify uniqueness after clicking — they perceive the new state. The pipeline has no perception step after a state change; verification happens once, pre-interaction, and is trusted forever after.
- [ ] Capture and expose state signals the pipeline currently discards — `aria-current`, `aria-selected`, `aria-pressed`, active-class (`renderCatalogForPrompt.ts:23-33` omits them all). Without these the author has **no vocabulary for "this tab is now active"** and can only assert `VISIBLE` on the thing it just clicked — a tautology that is a live false-PASS generator (`missionRunner.template.ts:186`).

**Traceability (user-visible trust):**
- [ ] Thread `sourceStep` end-to-end so evidence maps to the case step that caused it: add to `planStepSchema` (`compiler/testPlan.ts:51-56`) → require in the plan prompt (`authoring.ts:418-431`) → emit per runner call (`playwrightCompiler.ts:365-495`) → `logStep` (`missionRunner.template.ts:72-75`) → `EvidenceShot['steps']` (`nodes/execution.ts:117-127`).
- [ ] Replace the positional zip in `shared/testCases.ts:74-85` with grouping by `sourceStep`. Today every step displays the **wrong** screenshot (off by one) and 10 of 13 frames are unreachable from the case view — the 3-step → 13-frame expansion surfaces *only* as an unexplained evidence count.
- [ ] Stop the silent metadata degradation: an absent metadata block is an empty string with no sentinel (`authoring.ts:380-382`, `:408`) — authors emit with identical confidence. Add an explicit "metadata unavailable — field requirements unverified" signal.
- [ ] Fix the `MetadataFetch` chip mislabelling a genuine `NETWORK_TRANSIENT` failure as *"Skipped — (normal for Admin-platform runs)"* (`runtime.ts:135-136`). The discriminating pattern already exists two lines above for discovery (`:128-133`) — mirror it.
- [ ] Remove stale comments claiming before/after capture (`missionRunner.template.ts:59`, `:184`); code takes one frame per action.
- **Acceptance:** the specimen run re-executed against a live SUT reaches the Tab form, emits zero impossible asserts, produces zero strict-mode violations from stale uniqueness, and every evidence frame maps to a named case step.

---

### P3.4 — Trust surface (what the user can see and correct)
**Source:** Set 6 §3 — end-user trust & transparency. These do not change model output; they change whether a wrong output is *catchable*.
- [ ] **Communicate uncertainty.** Output ships with identical confidence regardless of evidence quality — a run grounded on the wrong screen reads the same as a fully-grounded one. Surface the grounding/reachability verdict (P3.3) in the UI, not just in artifacts.
- [ ] **Make reasoning inspectable.** The execution trace exists on disk but is mis-keyed and never surfaced (`tracer.ts:33`), so every result is a black box the user must trust or reject wholesale. Expose which tool calls and which evidence produced an output. (Depends on the trace-key fix in P7.)
- [ ] **Signal + undo on live actions.** Under the default `auto` policy a live-app mutation happens with no human gate and no undo path (`routeAfterAuthorCases:168`). At minimum: a visible record of what was mutated. This is the UX half of the `CORE_IDENTITY` contradiction in P2.4 — resolve them together.
- [ ] **Make correction teach the system.** A user marking a case wrong edits the artifact and teaches nothing; every run is stateless w.r.t. user judgment. Route corrections into the user-fact memory built in P4.2 so the same mistake isn't re-authored next run. **This is the feedback loop that converts one-time fixes into compounding accuracy** — without it, every phase above is a one-shot gain.

# PHASE 4 — Memory that decides (not memory that decorates)
**Goal:** make memory change behavior, and add the user-fact layer that doesn't exist.
**Risk:** Medium. **Est. accuracy impact:** +5–8 pts compounding (L5). **Scope:** two sub-phases.

### P4.1 — Wire the dead gate (highest leverage, lowest risk)
- [ ] Make `isSelectorKnownBroken` / `preferredApproach` (`gate.ts:33-101`, **zero live callers**) actual branch points in the coder/planner — today memory only pads the prompt and hopes the LLM obeys (`routes.ts:2974-2981`).
- [ ] Retire the duplicate episodic path: consolidate `runMemory.ts` onto the typed store (`store.ts`) — two systems record the same selector facts and can disagree.
- [ ] Add upsert/versioning semantics: both stores are insert-only (`store.ts:141-147`; `runMemory.ts:93` defeats its own `ON CONFLICT`), so contradictions accumulate forever.
- [ ] Fix the ranking hazard: lexical overlap is weighted ×2 vs sub-1 recency (`store.ts:70-79`), so a stale fact can outrank its correction.

### P4.2 — The user-fact memory that is entirely absent
- [ ] Build the **capture layer**: today *no* user-stated fact is ever persisted — the only durable subjects are machine-learned `app.understanding`/`app.profile` (`understandingProducer.ts:168`) and executed-selector outcomes (`execution.ts:154`). Add an explicit save path (user-triggered and/or LLM-gated "worth remembering").
- [ ] Build the **promotion step** (session → durable) — none exists (grep for `promote|distill|consolidate` finds only unrelated hits).
- [ ] Add **semantic recall** behind the existing `store.recall` interface (pgvector where Postgres is on; keep the lexical fallback) — all recall today is substring/recency.
- [ ] Add per-fact-type TTL and a **user/admin surface to view, correct, and delete** memory — today it's a write-only black box with a poisoned `app.profile` recalling forever (`discoverAppProfile.ts:127-132`).
- [ ] Surface a user-visible "using saved context" signal (`routes.ts:2981,3174` inject invisibly).
- [ ] End restart amnesia: persist the RAM-only fallbacks (`store.ts:87`, summary/manifest/artifact fallbacks) or require Postgres for memory.
- **Acceptance:** save-today → new-session-tomorrow → zero-reference recall works for a *user-stated* fact, proven by test; a known-broken selector is provably not re-attempted.

---

# PHASE 5 — Cost & reliability
**Goal:** make unit economics and uptime bettable.
**Risk:** Low–Med. **Scope:** ~8 files.

- [ ] Add `run_id` to `usage_log` (`costTracker.ts:15-29,75-77`) — cost-per-run is currently **not computable**; `request_id` is a per-call UUID.
- [ ] Revive the dead cost guardrail: no caller passes `costUsedToday`/`costDailyLimit`, so `0 >= Infinity` never trips (`guardrails.ts:212-215`; call sites `orchestrator.ts:216-224,289-297,402-410`).
- [ ] Add a **per-run dollar ceiling** enforced mid-flight (today only a per-project daily quota checked once at start, *after* the response is sent — `routes.ts:5920-5930`).
- [ ] Fix CLI/codex provider reporting `$0`/0 tokens always (`cli.ts:182,222,257`) — those runs are invisible to caps *and* to the token budget.
- [ ] Add a **concurrency cap / semaphore** on runs (`runtime.ts:744-747`, currently unbounded: N users = N graph streams + N browsers on one event loop).
- [ ] Add request **rate limiting / abuse detection** — none exists (`apps/api/src/server.ts:120-124`; only a same-prompt dedupe at `routes.ts:5798-5807`).
- [ ] Add **provider fallback**: `callWithRetry` retries the same model 4× then fails; no secondary provider, queue, or circuit breaker (`orchestrator.ts:651-668`). Wrap `generateObject`/`generateText` too (`:245,307`).
- [ ] Relevance-gate tool exposure (≤8–10 specs/turn vs all ~31 every call — `registry.ts:608`, `supervisor.ts:611-614`) and add parallel read fan-out (`orchestrator.ts:471-537` is serial).
- [ ] Make DOM/understanding caches survive restart (`routes.ts:1482-1508` in-process only); add an embedding cache.

---

# PHASE 6 — Governance (the enterprise gate)
**Goal:** survive a security questionnaire and a due-diligence review.
**Risk:** Low–Med. **Scope:** schema + ~6 files.

- [ ] Build a **single deletion path** (per-user / per-workspace erasure). Today: no `purge`/`gdpr` function exists, `owner_id` is bare `TEXT` with **no FK** (`schema.sql:702-706`), so deleting a user orphans cases/runs/memories/artifacts across ~20 tables.
- [ ] Extend the audit log beyond credentials/auth/projects — `recordAudit` covers only 3 route files; agent mutations and **all read access** are unlogged (`recordAudit.ts:20-43`).
- [ ] Add **data classification + outbound redaction** before provider egress — prompts carrying repo code/DOM/understanding ship with no sensitivity tiering; only model *output* is scrubbed (`guardrails.ts:336-359`).
- [ ] Produce an **egress inventory doc** (what data reaches which provider) reviewable by a customer's legal team.
- [ ] Add reproducibility columns: `prompt_version`, served `model`, `code_version`/git-sha on the run (`agent_runs.model` is the *requested*, usually empty, model — `routes.ts:5780`; no join key from `usage_log`).
- [ ] Record the **served** model id, not the sent one (`anthropic.ts:83`, `openai.ts:102`; only `responsesClient.ts:76` does it right) so a silent provider upgrade is detectable. Pair with the P1 eval suite — the served-model field tells you *that* the model changed; the eval tells you *whether it mattered*.
- [ ] Persist sampling parameters (temperature/effort/seed) per run — today output drift on an identical prompt cannot be attributed.
- [ ] Add a **dependency supply-chain check** to CI (`npm audit` or equivalent), with particular attention to anything touching prompt construction or tool execution. No such step currently exists in `package.json` scripts.
- [ ] Add **`CODEOWNERS` / an ownership map** per agent and pipeline stage — there is no clear owner today, making the system one person's mental model and a single point of failure for the business.
- [ ] Write the **onboarding doc that describes the LIVE path**, not the intended architecture. Existing `docs/plans` and `docs/diagnostics` are substantial and above average, but they describe dark/flag-gated layers alongside live ones — a new engineer cannot tell which executes without tribal knowledge. One page: what actually runs, which flags are on, where the seams are.

---

# PHASE 7 — Architecture consolidation (retire the debt)
**Goal:** stop paying for two systems. **Do this last, deliberately.**
**Risk:** High. **Scope:** one subsystem.

- [ ] **Decide:** cut the agent-native bus/blackboard over to load-bearing, **or** freeze it as pure observability and stop growing it. Today `AGENT_NATIVE_V1` defaults OFF (`agentNativeFlag.ts:6-9`), `runViaBus` has zero live callers, and `runInstrumentation.ts:1-16` is shadow-only.
- [ ] If cutting over: derive stage→agent identity from the graph definition instead of the hand-maintained `STAGE_AGENT` map (`runInstrumentation.ts:28-39`, a drift surface).
- [ ] Add real handoff **leases** (today HANDOFF/DELEGATE are labels with no lock — `runViaBus.ts:68-100`).
- [ ] Fix the O(n)-per-publish Postgres bus (`COUNT(*)` + full chain scan per message, `messageBus.ts:196-206`) → `MAX(seq)+1` with an index.
- [ ] Add a resume consumer so a crash mid-run resumes instead of `failed` (`runtime.ts:882-895`; heavy artifacts are RAM-only, `:838-843`).
- [ ] Decompose the 550-line intent `switch` (`controller.ts:534-1083`) so one capability change no longer touches 6 files.
- [ ] Fix the trace correlation key: `runId = pipeline.requestId = randomUUID()` per LLM call (`tracer.ts:33`, `guardrails.ts:258`) instead of `agent_runs.id`, and persist the assembled prompt (only `"[prompt metadata]…"` is stored, `tracer.ts:82-85`).

---

# Cross-cutting: process changes that protect the gains

- [ ] **Canary/staged rollout for prompts** — today `savePromptVersion` flips `isActive` globally, direct-to-100% (`promptStore.ts:75-88`).
- [ ] **Prompt changes reviewed like code** — a Settings override currently ships with no review and strips the safety stack.
- [ ] **Kill switch + rollback path** documented per phase flag.
- [ ] **Runbook** for the four likely incidents: stuck run, orphaned run, memory poisoning, cost spike.
- [ ] **Trend dashboard** off the P1 eval history.

---

# Expected trajectory (honest)

| Milestone | Expected measured accuracy |
|---|---|
| Today | **Unknown** — estimated ~75%, unverified (no eval) |
| After P1 | Baseline established (may read lower than 75 — that's good) |
| After P0+P2 | +8–15 pts — context bug + injection/corruption removed |
| After P3 | +10–15 pts — the main jump (grounding, verification, attrition) |
| After P4 | +5–8 pts compounding — system stops repeating known failures |
| Ceiling | **~93–97% on the golden set**, with residual failures *surfaced*, not silent |

**The last few points are not code — they're evidence quality.** When grounding fails, the correct outcome is an honest "insufficient evidence," not a confident guess. That's what turns a 93% into a *trustworthy* 93%.

---

# Approval gate

Per `CLAUDE.md`, implementation begins only on explicit approval, **one phase at a time**. Recommended first approval: **Phase 0 + Phase 1 together** — P0 stops live harm, P1 gives us the ruler for everything after. I will report per phase: changes, files, reason per change, risks, validation performed, remaining work.

*End of plan — no code changed.*
