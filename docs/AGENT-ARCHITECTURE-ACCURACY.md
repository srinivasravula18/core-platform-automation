# Agent Architecture, Accuracy & Gap‑Closing Design

> Grounded in the book **"Agentic Design Patterns" (Antonio Gulli, 21 patterns)** and in this
> repository's **actual code** (file/line citations throughout). This document answers four
> questions the team asked:
> 1. Which agent architecture should we choose? (per the book)
> 2. Does it suit a platform focused on **automated testing with agents**?
> 3. How accurate is it really — vs. "big‑company" agents?
> 4. What concrete work closes the gap?
>
> Status: assessment + design. Numbers marked *(est.)* are reasoned estimates, **not measured**
> — see §5 (the absence of a full‑pipeline eval harness is itself a finding).

---

## Status — implemented this session (all typecheck clean; offline evals green)

Closed most of the §6 gaps. New/added, with their offline proof:

| Pattern | Module | Wired into | Eval |
|---|---|---|---|
| Exception/Recovery (Ch 12) | `ai/recovery.ts` | execution fallback classifies degrade/escalate | `eval:recovery` 21/21 |
| Verifier hardening (Ch 4/19) | `ai/verifier.ts` | grounding ratio/weak, skip‑heavy false‑green fix, completeness | `eval:recovery` |
| Sub‑feature **deep** coverage (Ch 7/11/19) | `ai/exploration/featureCoverage.ts` | `analyze_feature_coverage` tool | ran live on `core-platform` (135s) |
| **Relational code search** (Claude‑Code style) | `ai/exploration/referenceGraph.ts` | feeds coverage discovery (root→child→nth‑child) | ran live (0.6s); resolver bug found+fixed |
| Exploration/edge‑finding (Ch 21) | `ai/exploration/edgeFinder.ts` | `find_untested_edges` tool | tool wired (live run pending) |
| Episodic memory (Ch 8/9) | `ai/memory/runMemory.ts` | injected at script‑gen; recorded at run end | `eval:memprio` 13/13 |
| Prioritization (Ch 20) | `ai/prioritization.ts` | pure ranker (queue wiring pending) | `eval:memprio` |
| Resource quota (Ch 16) | `ai/costTracker.ts` | hard per‑project gate at run start | typecheck |

Known open: coverage **seed‑altitude tuning** (UI vs adapter layer), `find_untested_edges` live run, prioritization queue wiring, commit + backend restart.

---

## 0. Verdict (the one‑paragraph answer)

**Keep the architecture you have. The book points at it directly.** The right shape for this
app is a **Router‑fronted, Hierarchical Multi‑Agent system whose core worker is a fixed,
Reflection‑gated pipeline** — *not* an autonomous planner, *not* a flat agent swarm. Chapter 17
(MASS) names the empirically‑optimal coding‑agent topology as *"a predictor agent that reflects
plus one executor agent that runs the code against test cases"* — which **is** your
`caseWriter → playwrightCoder → execute → verifier` loop. The work ahead is in the **supporting
patterns** (exception/recovery, exploration, goal‑monitoring), not the backbone.

---

## 1. The recommended architecture (locked)

Four layers, each mapped to the book's pattern and to the code that already implements it.

| Layer | Book pattern | In this repo |
|---|---|---|
| **1. Router (front door)** | Routing (Ch 2) | `agent-runtime/goals/router.ts` — `classifyGoal()` (LLM proposal) + `decideRoute()` (pure deterministic safety net). `CONFIDENCE_FLOOR = 55`; a question is never turned into an action. |
| **2. Supervisor / Hierarchical orchestrator** | Multi‑Agent (Ch 7) | `ai/supervisor.ts` — `runSupervisor()` tool‑loop choosing among `INTENT_TOOLS` + `query_workspace`/`search_codebase`/`read_code_file`. |
| **3. Fixed pipeline (core worker)** | Prompt Chaining (Ch 1), **not** Planning (Ch 6) | `features/agent/routes.ts` phases: `ApplicationInspector → TestGenerationAgent → PlaywrightAgent → SelectorVerifier → ExecutionRepair → EvidenceAgent`. |
| **4. Reflection / verification gates** | Reflection (Ch 4) | `ai/verifier.ts` — `assessInspection`, `assessCasesGrounding`, `assessExecution` (deterministic, no extra LLM call). |

**Why fixed pipeline, not planner (the load‑bearing decision).** Ch 6 is explicit: *"When a
problem's solution is already well‑understood and repeatable, constraining the agent to a
predetermined, fixed workflow is more effective… guaranteeing a reliable and consistent
outcome."* The deciding question it gives — *"does the 'how' need to be discovered, or is it
already known?"* — resolves to **known** for a test procedure. A test platform's value is
reproducible, auditable runs; a planner would trade that away for flexibility you don't need.

**Own the trade‑off (correction to an earlier over‑claim).** Ch 7 presents **six** multi‑agent
models (Single, Network, Supervisor, Supervisor‑as‑Tool, Hierarchical, Custom) and warns the
Supervisor is *"a single point of failure"* and *"can become a bottleneck."* The supervisor
backbone is the right pick here, but it is a deliberate trade bought back by your per‑project
concurrency limits — not a universally optimal choice.

---

## 2. Pattern coverage map (all 21)

| # | Pattern | Status | Evidence in repo |
|---|---|---|---|
| 1 | Prompt Chaining | ✅ Strong | pipeline phases in `agent/routes.ts` |
| 2 | Routing | ✅ Strong | `goals/router.ts` (LLM‑propose / pure‑decide) |
| 3 | Parallelization | ✅ Strong | `research/deepResearch.ts` facet fan‑out |
| 4 | Reflection | ✅ Strong (grounded) | `verifier.ts` accept‑gates |
| 5 | Tool Use | ✅ Strong | `orchestrator.ts:runToolLoop`, `tools/registry.ts` |
| 6 | Planning | ◐ Bounded (by design) | `intents.ts` plan + human review — *intentionally* not autonomous |
| 7 | Multi‑Agent | ✅ Strong | 8 canonical roles + `supervisor.ts` |
| 8 | Memory | ◐ Partial | knowledge packs grow via `recordObservation`; **no episodic run memory** |
| 9 | Learning & Adaptation | ◯ Minimal | no run‑outcome learning loop |
| 10 | MCP | ◯ N/A (correctly) | in‑process tools; Ch 10 says direct function‑calling suffices |
| 11 | Goal Setting & Monitoring | ◐ Partial | `agent-runtime/goals/` routing done; **monitoring half thin** |
| 12 | Exception Handling & Recovery | ◐ Ad‑hoc | real recovery exists (`repairTestCode`, `MAX_REPAIR_ROUNDS`, fallbacks) but **not a formal policy** |
| 13 | Human‑in‑the‑Loop | ✅ Good | `review_cases` flow, `intentRequiresApproval` |
| 14 | Knowledge Retrieval (RAG) | ✅ Strong | `knowledgeService.ts`, code‑grounded `codeSearch` |
| 15 | Inter‑Agent (A2A) | ◯ N/A today | single in‑process framework; borrow the *task‑envelope* idea only |
| 16 | Resource‑Aware Optimization | ◐ Partial | `costTracker.ts` + per‑agent model routing; cap is **logged not always enforced** |
| 17 | Reasoning Techniques | ✅ Strong | `runToolLoop` = ReAct; pipeline = MASS coding topology |
| 18 | Guardrails / Safety | ✅ Good | `guardrails.ts` pipeline (+ deterministic router net) |
| 19 | Evaluation & Monitoring | ◐ Partial | `scripts/eval-routing.ts`, `agent-evals.ts`; **no full‑pipeline eval** |
| 20 | Prioritization | ◯ Minimal | no run‑queue prioritization yet |
| 21 | Exploration & Discovery | ◯ Missing | **biggest QA‑specific opportunity** — find untested edge cases |

Legend: ✅ strong · ◐ partial · ◯ minimal/absent.

---

## 3. How it suits **automated testing with agents**

Testing has a peculiar shape: **the method is known (inspect→generate→run→verify), the inputs
are open‑ended (any app/feature/free‑form ask), and correctness must be provable.** Each layer
exists for one of those facts:

- **Fixed pipeline → reproducible, auditable runs.** The credibility a QA tool lives on. (Ch 1 + Ch 17/MASS.)
- **Reflection gates → the anti‑"fake‑green" mechanism.** A test tool's worst failure is reporting
  pass when nothing ran. Your gates are anchored in *real signals* — what the inspector actually
  observed, what Playwright actually returned — which Ch 4 calls *grounded* self‑correction (the
  only kind that works). **This is your single biggest reliability asset.**
- **Router + Supervisor → plain‑language driving.** Non‑technical users say "test the list view";
  the router decides answer‑vs‑generate‑vs‑run; the supervisor composes the right specialist
  testers (Ch 7's software example literally names *"a third [agent] a tester"*).

---

## 4. Per‑stage accuracy assessment

Two different things are measured per stage and **must not be conflated**:
- **Deterministic correctness** — did the mechanical step do what the code says? (Real DOM read,
  real Playwright verdict.) These can be ~99%+.
- **LLM‑judgment quality** — did the model make a *good* decision? (Right cases, right sub‑features,
  real defect.) These live in **70–90%** bands and **never reach 100%**.

| Pipeline stage | What's deterministic | What's LLM‑judgment | Existing guard | Det. *(est.)* | Judgment *(est.)* |
|---|---|---|---|---|---|
| **Routing** | `decideRoute()` pure rules | `classifyGoal()` label | unit‑tested net + `eval-routing.ts` | ~99% | **80–92%** |
| **Inspection** | `collectPageContext` DOM read via `page.evaluate` | planner clicks (≤2 steps, `plannerSchema`) | `assessInspection` (blind = `nav+forms+tables===0`) | ~95%¹ | **70–85%** |
| **Case generation** | schema shape (`testCasesSchema`) | which cases, coverage | `assessCasesGrounding` + `inspection_blind` hard‑stop | ~99% | **70–88%** |
| **Script generation** | 1‑script‑per‑case via `alignScriptsToCases` + `scriptLooksUsable` | selector/logic choices | missing‑script ⇒ run **failed** (`routes.ts:1173`) | ~97% | **70–85%** |
| **Selector verify** | `gitGrep` match against real source | replacement choice | best‑effort, `SELECTOR_VERIFY_CONCURRENCY=4` | n/a | **65–85%²** |
| **Execution** | **real Playwright** JSON reporter | none | `assessExecution` (`total>0 && failed===0`) | **~99%** | n/a |
| **Execution repair** | re‑run + parse | the fix | `MAX_REPAIR_ROUNDS=2`, early‑stop | ~95% | **50–75%³** |
| **Evidence** | screenshots/trace copy, `not_executed` rows | none | `executed:true/false` honesty | **~99%** | n/a |

¹ Inspection determinism is high *when the page loads*; flaky/lazy apps degrade it (`Loading…`
wait caps at 8 s, then proceeds). ² Skipped entirely when the repo is unavailable. ³ A fix that
doesn't parse / doesn't help is dropped — honest, but low yield.

**Composite, end‑to‑end** *(est.)*: for a **well‑behaved app**, a "deep test run" produces a
*useful, grounded, honestly‑reported* result ~**75–88%** of the time; the rest fail **loudly**
(blind inspection, ungrounded cases, missing scripts, zero‑test execution all hard‑stop) rather
than fake‑green. That loud‑failure property is worth more than a higher silent number.

**Known accuracy leaks (from the code, name them honestly):**
- `assessCasesGrounding` is **lenient**: a *single* observed token in a *single* case flips the
  whole batch to `ok:true` (`verifier.ts:80‑89`). The ratio is reported but **not thresholded**.
- `assessExecution` treats a **skip‑heavy** run as green (`skipped` is neither passed nor failed;
  `verifier.ts:101‑105`).
- The coder contract allows `expect.soft` intermediates with **one** hard final assertion
  (`routes.ts:1112`): a test can pass while intermediate checks silently failed.
- Grounding can be satisfied by **source‑inventory** tokens overriding a failing **live‑page**
  verdict (`assessCasesInventoryGrounding`, `routes.ts:997`).

---

## 5. Reliability reality check (vs. Claude / ChatGPT)

**No agent — yours, Claude, ChatGPT, or any lab's — is 100% accurate.** The book says so:
LLMs are *"probabilistic and non‑deterministic… traditional software testing is insufficient"*
(Ch 19) and *"may hallucinate"* / *"may incorrectly assess its performance as successful"* (Ch 11).

What separates a lab agent from yours is **not the architecture** (you share the pattern family —
the book documents these patterns from Google Deep Research, Co‑Scientist, Anthropic, OpenAI). It's:

| Accuracy driver | Labs | You |
|---|---|---|
| Base model | frontier, self‑trained | **rented via API — you can match this** |
| Eval infra (thousands of graded cases) | massive, continuous | **thin — the real gap** |
| RLHF / fine‑tuning | yes | no |
| Grounding & verification | heavy | **you can match — and largely do** |

**The good news for *your* domain:** testing has **ground truth** (a test ran or it didn't), so a
small team *can* approach lab‑grade reliability on the *deterministic* half — which is exactly
what `verifier.ts` exploits. Target **"high accuracy with honest, verified failure reporting,"**
never "100%."

> **Finding:** there is no end‑to‑end eval harness (only `eval-routing.ts` / `agent-evals.ts` at
> the component level). Every composite number above is *(est.)*. Building an **evalset** (Ch 19:
> *test files for unit, evalset files for multi‑turn integration*) is the highest‑leverage
> reliability investment available — it converts estimates into measurements.

---

## 6. Gap‑closing designs (prioritized)

### 6.1 Formalize Exception Handling & Recovery — **Ch 12** *(highest leverage)*
You already do retry/repair/degrade/escalate ad‑hoc; the book gives the taxonomy to make it a
*policy*. Map (and complete) what exists:

| Ch 12 strategy | Exists today | Make explicit |
|---|---|---|
| **Retry** | `MAX_REPAIR_ROUNDS=2`, per‑case regen, `callWithRetry` | a typed `RecoveryPolicy` per stage |
| **Fallback** | pre‑login → self‑login → base‑URL evidence | declare the chain, don't bury in `catch` |
| **Graceful degradation** | `quarantined` bad spec, keep batch | a `degraded:true` flag on the run |
| **Escalation** | SIGKILL timeout, mark `failed` | route to HITL queue, not just `failed` |
| **Diagnosis / replan** | execution‑repair feeds real error back | persist failure cause for learning (→ 6.4) |

**Design:** a `stageRecovery(stage, error) → { action: 'retry'|'repair'|'degrade'|'escalate', ... }`
wrapper around each pipeline phase, replacing inline try/catch. One place to reason about
resilience; testable offline like `decideRoute`.

### 6.2 Exploration & Discovery agent — **Ch 21** *(biggest QA‑specific win)*
A fixed suite optimizes *known* coverage; Ch 21 is about *"unknown unknowns rather than merely
optimizing a known process,"* and explicitly names *"probe… codebases to find flaws."*

**Design:** an `explore_untested` capability that (1) reuses `deepResearch.ts` facet fan‑out +
`search_codebase` to enumerate real branches/states/error‑paths, (2) diffs them against existing
`Cases`, (3) ranks the gaps (Ch 21's Elo‑style tournament → a cheap pairwise ranker), (4) proposes
the top‑N untested scenarios as draft cases. Plugs in as a new `INTENT_TOOLS` entry + a Console
action. **This is what turns "an agent that writes tests" into "an agent that improves coverage."**

### 6.3 Sub‑feature completeness gate — **Ch 7 + Ch 11 + Ch 19**
Decomposition into sub‑features already happens (facet fan‑out, `summarizeFeatureInventory`), but
each sub‑feature is **not a tracked unit with its own verdict** — so a feature can read "tested"
while sub‑features were silently skipped (the Ch 19 silent‑gap failure).

**Design:** make `feature → [subFeature]` a first‑class object; run/track per sub‑feature; add a
`assessFeatureCompleteness(feature)` gate that fails/flags when a sub‑feature has 0 cases or 0
passing runs. Pairs with a separate **reviewer** agent (Ch 11 warns against self‑judging; prescribes
a distinct Code‑Reviewer + Test‑Writer).

### 6.4 Episodic run memory — **Ch 8 + Ch 9**
Today knowledge grows from observations but the agent has **no memory of prior run outcomes**
("this selector was flaky last time"). Ch 8 episodic memory + Ch 9 (SICA learns from benchmark
results) → store per‑run `{ selector, stability, failureCause }`; retrieve at script‑gen to avoid
known‑flaky patterns. Directly cuts re‑discovered flakiness.

### 6.5 Test‑data provisioning — **Ch 5 + Ch 3**
Credentials, generated inputs, and inter‑stage hand‑off already work. The gap is **precondition
setup/teardown** in the system‑under‑test. Add `seed_test_data` / `cleanup_test_data` tools
(Ch 5 Tool Use) the pipeline calls before/after a run; fan out a case over a **dataset**
(valid/invalid/boundary) via `parallel` (Ch 3) for data‑driven testing.

### 6.6 Run prioritization — **Ch 20**
When the per‑project concurrency semaphore is saturated, decide *which* queued run goes first
(urgency, dependency, cost/benefit — Ch 20's P0/P1/P2 model). Cheap to add, visible under load.

### 6.7 Enforce the resource cap — **Ch 16**
`costTracker.ts` records per workspace/user/agent/model and `costGuardrail` can `reject` (429),
but the daily cap is *logged* and easily raised. Add a hard per‑project quota in the orchestrator
(Ch 16 Resource‑Aware) so one project can't burn the budget.

---

## 7. Prioritized roadmap

1. **Eval harness first (Ch 19).** Build an evalset of real scenarios so §4's *(est.)* become
   measured. Everything else is guesswork without this.
2. **Exception/Recovery policy (Ch 12, §6.1).** Highest reliability‑per‑effort.
3. **Exploration agent (Ch 21, §6.2).** Highest *product* value for a test platform.
4. **Sub‑feature completeness gate (§6.3).** Kills the silent‑coverage‑gap failure.
5. **Episodic run memory (§6.4)** and **prioritization (§6.6)** — incremental hardening.

**Backbone stays. The work is the supporting patterns, in this order.**

---

*Generated with grounding in `inspectionService.ts`, `verifier.ts`, `agent/routes.ts`,
`playwright/executionService.ts`, `guardrails.ts`, `costTracker.ts`, `goals/router.ts`,
`supervisor.ts`, `research/deepResearch.ts`, and the 21 chapters of "Agentic Design Patterns."*
