# Pipeline stage-handoff forensics — one real run, every boundary, literal payloads

**Date:** 2026-08-01
**Method:** single persisted run replayed out of Postgres (`agent_runs`, `agent_run_events`, `agent_run_artifacts`) + static code trace with `file:line`. Every payload below is copied verbatim from the database, not reconstructed.

## The run under audit

| field | value |
|---|---|
| run id | `23d5f929-55a0-427d-9993-6b712687a59c` |
| artifact name | `Core Platform Admin — Functional Validation` |
| prompt | *"Write a test that creates a new Tab in the Admin console (choosing the tab Type and target Object)…"* |
| target | `http://localhost:5002/` (Admin surface) |
| engine | LangGraph (`AGENT_GRAPH_V2`) |
| created | 2026-07-30 15:40:56 +05:30 |
| status | `completed` — 0/2 cases passed |

**Why this run and not "keystone · Tabs".** There is no `keystone` run whose subject is Tabs. The Tabs-subject runs in the store are Admin-platform. This one is the exact phenomenon described — a **3-step case that produced 13 evidence frames** — so it is the right specimen. The one keystone run with a Tabs-shaped title (`69be1f15…`) is `review_required` with 0 scripts and 0 evidence, so it has no handoffs to trace.

Stage events (`agent_run_events`, 11 rows, all `success`):

```
1 workflow start          6 author_plans
2 validate_request        7 compile_and_validate
3 load_context            8 execute_tests
4 discover_and_ground     9 investigate_failures
5 author_cases           10 finalize / 11 workflow success
```

Chip roster shown in the UI (`agent_runs.messages`):

```
ScopeAgent          completed
MetadataFetch       skipped    "Skipped — no application metadata available for this mission (normal for Admin-platform runs)."
AuthSessionAgent    completed
ApplicationInspector completed
SelectorRegistry    completed
TestGenerationAgent completed
PlaywrightAgent     completed
SelectorVerifier    completed
EvidenceAgent       completed
```

---

# 1. The step-count mismatch: 3 case steps → 13 evidence frames

## 1.1 What Case Writer literally wrote

`agent_runs.generated_cases[1]` — **3 steps**:

```json
{
  "title": "New tab form controls are identified before automation",
  "type": "Manual",
  "priority": "High",
  "tags": ["@ui", "@manual", "@tabs", "@evidence-gap"],
  "preconditions": "An authenticated Admin user with permission to manage tabs has the Tabs workspace open; no verified Tab Type values, Object values, or tab creation fields are currently available in the evidence.",
  "steps": [
    { "action": "Select the \"New\" button.",
      "expected": "A creation interface opens; capture its visible heading, fields, dropdown labels, and available actions without assuming they match the verified \"New App\" form." },
    { "action": "Inspect the opened interface for controls that choose the tab Type and target Object.",
      "expected": "The exact visible labels and available options are recorded for review; if either control is absent, the requested creation flow is reported as unsupported by the observed interface." },
    { "action": "Select the \"Cancel\" button if it is present in the opened interface.",
      "expected": "The creation interface closes without creating a record; a follow-up case can be authored after the Tab-specific controls and values are verified." }
  ]
}
```

The sibling case (`generated_cases[0]`, *"Tabs workspace opens from Admin"*) has exactly **1** step.

## 1.2 The literal expansion, boundary by boundary

`agent_run_artifacts.plansByCase['case-2']` — the Plan Author turned those 3 steps into **13 plan steps**:

```json
{ "title": "New tab form controls are identified before automation",
  "steps": [
    { "action": "CLICK",  "target": "New" },
    { "assert": "VISIBLE", "target": "NewApp" },
    { "assert": "VISIBLE", "target": "Label_3" },
    { "assert": "VISIBLE", "target": "APIName_2" },
    { "assert": "VISIBLE", "target": "Prefix" },
    { "assert": "VISIBLE", "target": "Version_2" },
    { "assert": "VISIBLE", "target": "ParentApp_2" },
    { "assert": "VISIBLE", "target": "TextStyle" },
    { "assert": "VISIBLE", "target": "Create" },
    { "assert": "VISIBLE", "target": "Cancel" },
    { "assert": "VERIFY_VALIDATION", "target": "NewApp",
      "value": "The observed interface is the New App form; controls and options for choosing a tab Type and target Object are not verified, so the requested Tab creation flow is unsupported pending further evidence." },
    { "action": "CLICK",  "target": "Cancel" },
    { "assert": "NOT_VISIBLE", "target": "NewApp" }
  ] }
```

Case step 2 — *"Inspect the opened interface for controls that choose the tab Type and target Object"* — became **8 separate `VISIBLE` asserts**, one per catalog control. That single prose step is the whole expansion.

The compiler then emitted **1 runner call per plan step**, plus the mandatory `startMission()` — **14 calls**. `agent_runs.playwright_scripts[1]`:

```ts
test("New tab form controls are identified before automation", async ({ page }) => {
  const runner = new MissionRunner(page, MISSION as any);
  await runner.startMission();                                                   // ← not a case step
  await runner.click({"selector":"[aria-label=\"New\"]", ... "label":"New"});
  await runner.expectVisible({"selector":"role=heading[name=\"New App\"]", ...});
  await runner.expectVisible({"selector":"#create-app-label", ...});
  await runner.expectVisible({"selector":"#create-app-api", ...});
  await runner.expectVisible({"selector":"#create-app-prefix", ...});
  await runner.expectVisible({"selector":"#create-app-version", ...});
  await runner.expectVisible({"selector":"#create-app-parent", ...});
  await runner.expectVisible({"selector":"[aria-label=\"Text style\"]", ...});
  await runner.expectVisible({"selector":"role=button[name=\"Create\"]", ...});
  await runner.expectVisible({"selector":"role=button[name=\"Cancel\"]", ...});
  await runner.expectValidation({"selector":"role=heading[name=\"New App\"]", ...}, "The observed interface …");
  await runner.click({"selector":"role=button[name=\"Cancel\"]", ...});
  await runner.expectHidden({"selector":"role=heading[name=\"New App\"]", ...});
});
```

## 1.3 The literal evidence list and what triggered each frame

`agent_runs.evidence_screenshots[0].steps` — **13 frames**, the `kind` field is the runner method that fired:

| # | file | kind | label | ok |
|---|---|---|---|---|
| 1 | `…-case1-step1.png` | `startMission` | *(value: http://localhost:5002/)* | ✔ |
| 2 | `…-case1-step2.png` | `click` | New | ✔ |
| 3 | `…-case1-step3.png` | `expectVisible` | New App | ✔ |
| 4 | `…-case1-step4.png` | `expectVisible` | Label * | ✔ |
| 5 | `…-case1-step5.png` | `expectVisible` | API Name * | ✔ |
| 6 | `…-case1-step6.png` | `expectVisible` | Prefix * | ✔ |
| 7 | `…-case1-step7.png` | `expectVisible` | Version | ✔ |
| 8 | `…-case1-step8.png` | `expectVisible` | Parent App * | ✔ |
| 9 | `…-case1-step9.png` | `expectVisible` | Text style | ✔ |
| 10 | `…-case1-step10.png` | `expectVisible` | Create | ✔ |
| 11 | `…-case1-step11.png` | `expectVisible` | Cancel | ✔ |
| 12 | `…-case1-step12.png` | `expectValidation` | New App | **✘** `element(s) not found`, 10 000 ms |
| 13 | `…-case1-step13.png` | *(none — no log entry)* | | |

Frame 12 threw, so the test aborted: runner calls 13 and 14 (`click Cancel`, `expectHidden`) never ran. Frame 13 is not a runner frame at all — it is the harness's end-of-test full-page capture, attached as `step-999` by an auto-fixture (`server/features/playwright/executionService.ts:91-106`, attach at `:101`), which the parser sorts numerically into last position (`executionService.ts:219-223`) and `publishEvidenceShots` then pairs with a non-existent 13th log entry (`nodes/execution.ts:117-118` → all fields `undefined`).

**Arithmetic:** 3 case steps → 13 plan steps → 14 runner calls → 12 executed (abort at 12) + 1 harness frame = **13 evidence entries.**

The sibling case is the same law at a smaller scale: 1 case step → 2 plan steps → 3 runner calls → 3 executed + 1 harness frame = 4 frames.

## 1.4 Is there a 1:1 mapping anywhere?

There are two 1:1 mappings and one many-to-one, and none of them is `case step → snapshot`:

| boundary | relation | code |
|---|---|---|
| case step → plan step | **1 : N**, unbounded, LLM-decided | prompt rule `authoring.ts:426` — *"Translate EVERY source step into plan steps — never drop or merge away behavior."* |
| plan step → runner call | **1 : 1** (+ compiler-injected extras) | `playwrightCompiler.ts:365-495` (one `body.push(emit…)` per step) |
| runner call → screenshot | **1 : 1** | `missionRunner.template.ts:80-92` — `act()` calls `captureStep()` exactly once, on success (`:84`) or on throw (`:88`) |
| screenshot → evidence card entry | **1 : 1**, zipped by array index | `nodes/execution.ts:114-129` |

So snapshot capture is **decoupled from case-step count entirely** — it is per Playwright *runner action*. A "log in" step would indeed expand to N frames; in this repo login is not authored at all (it is injected storage state, `authoring.ts:356-359`), but "inspect the form" expanded to 8 frames by the same mechanism.

## 1.5 Is the expansion visible anywhere in the UI?

**No, and worse — the UI actively mis-attributes it.** `server/shared/testCases.ts:74-85` zips case steps to evidence frames **positionally**:

```ts
const stepShots: string[] = (ev && Array.isArray(ev.stepScreenshots)) ? ev.stepScreenshots : [];
return steps.map((step, stepIndex) => ({
  step: `${caseIndex + 1}.${stepIndex + 1}`,
  action: step.action,
  ...
  screenshot: stepShots[stepIndex] || screenshot,
}));
```

For this case that renders:

| shown as | case-step prose | screenshot actually attached |
|---|---|---|
| 1.1 | *Select the "New" button.* | frame 1 = `startMission` (landing page, **before** the click) |
| 1.2 | *Inspect the opened interface…* | frame 2 = `click New` |
| 1.3 | *Select the "Cancel" button…* | frame 3 = `expectVisible New App` |
| — | — | frames 4-13 **orphaned, never shown against any step** |

Every step is off by one, and 10 of 13 frames are unreachable from the case view. The "unexplained jump in evidence count" is the *only* place the expansion surfaces.

There is no `stepIndex`/`sourceStep` field to carry the link — `planStepSchema` (`compiler/testPlan.ts:51-56`) is exactly `{action?, assert?, target, value?}`. The identity of the originating case step is destroyed at the very first handoff and never reconstructed.

## 1.6 Duplicated frames?

No before/after pairs. The doc comments at `missionRunner.template.ts:59` and `:184` say *"before and after each interaction"*, but the code takes **one** frame per `act()` (`:84` / `:88`). Those comments are stale.

That said, frames 3-11 are nine consecutive `expectVisible` calls against a **static, already-open modal** — no interaction happens between them, so they are nine visually near-identical PNGs. That is duplication in substance if not in mechanism: 9 frames, 1 page state.

## 1.7 Do retries inflate the count?

No.
- `expect()` polling inside a single `act()` produces one frame, not one per poll.
- `MissionRunner.verify()`'s single recovery re-navigation (`missionRunner.template.ts:127-131`) happens *inside* `startMission`'s `act()` → still one frame.
- A whole-test Playwright retry produces a fresh result object; the parser reads only the **last** result (`executionService.ts:212`), so earlier attempts contribute nothing.
- Hard cap `MAX_STEP_SHOTS = 60` (`missionRunner.template.ts:38`).

The inflation is 100% plan-step fan-out, 0% retries.

---

# 2. Metadata agent — why "skipped", and what downstream loses

## 2.1 The literal condition

The chip is derived, not reported. `workflow/runtime.ts:135-136`:

```ts
{ agent: 'MetadataFetch', stages: ['load_context'], done: Boolean(state.context?.metadata),
  runningLine: 'Fetching application metadata…',
  skipLine: 'Skipped — no application metadata available for this mission (normal for Admin-platform runs).' },
```

`done` is purely `Boolean(state.context.metadata)`. That field is set by `nodes/context.ts`, which returns `metadata: null` on **three different paths**:

| path | code | meaning |
|---|---|---|
| no `targetUrl` | `context.ts:40-48` | `INVARIANT_VIOLATION` |
| **no `applicationId`** | `context.ts:52-54` | deliberate: ADMIN platform, or a RUNTIME app that never resolved. Returns `errors: []` |
| fetch returned null / threw | `context.ts:60-71`, `:87-94` | `NETWORK_TRANSIENT` — target down, bad auth, empty catalog, timeout |

**For this run it is path 2** — a deliberate short-circuit. The mission is `platformType: "ADMIN"`, `application: null` (see the `MISSION` constant embedded in both compiled specs), so `appId` is empty and the node returns clean at `context.ts:53`. No fetch was attempted, nothing failed.

## 2.2 Is "skipped" ever a mislabelled failure? — **Yes.**

The chip cannot tell the three paths apart, because it only reads `context.metadata`. A genuine `NETWORK_TRANSIENT` failure (`context.ts:65-71`) — target unreachable, credentials rejected — renders the identical string, *including the reassuring parenthetical* "(normal for Admin-platform runs)". The `WorkflowError` is returned and lands in `state.errors`, but the chip never consults it.

Contrast the sibling chips, which *do* discriminate — `runtime.ts:128-133` explicitly refuses to let a discovery failure masquerade as a skip:

```ts
// Discovery that RAN and failed (network/auth/browser) must not masquerade as "skipped" — name the cause.
const discoveryError = [...(state.errors ?? [])].reverse().find((e) => e?.nodeName === 'discovery');
const inspectorSkip = discoveryError ? { line: `Failed — …`, status: 'failed' } : { line: 'Skipped — …' };
```

The same treatment was never applied to `MetadataFetch`. **This is a real defect** — the fix is one `state.errors.find(e => e.nodeName === 'context')` lookup mirroring `:129`.

(The legacy non-graph path has the same shape at `pipelineDelta.ts:100-109`, where a thrown fetch is caught at `:97-99` and also emits `status: 'skipped'`.)

## 2.3 What downstream actually loses

Metadata's product is `CorePlatformMetadataMap` (objects + fields + declared required/readonly), stashed as `metadataMap` (`artifactStash.ts:24-26`) and rendered into **prompts only**:

- Case Writer: `authoring.ts:379-382` → `metadataBlock`, capped 4 000 chars
- Plan Author: `authoring.ts:408` → same block, capped 3 000 chars

**Live Inspector and Selector Registry do not consume metadata at all.** Proof in code: the grounding node builds the Evidence Graph with an empty options object —

```ts
// grounding.ts:184
const evidenceGraph = buildEvidenceGraphFromRun({ selector_registry: { verified_selectors: verifiedSelectors } }, {});
```

— so `opts.metadata` is `undefined` and the metadata-binding branch at `evidenceGraph.ts:108` never fires, **regardless of whether metadata ran**. This is documented as intentional at `grounding.ts:28`. Empirically: all 89 graph nodes in this run carry `metadataRef: null`.

Verdict for the question "do Inspector/Registry behave differently when Metadata is skipped": **no — zero difference, by construction.** Selector counts, uniqueness, visibility are unaffected. The catalog still marked `Label *` / `API Name *` / `Prefix *` / `Parent App *` as `(required)` — but from the label-`*` heuristic (`evidenceGraph.ts:173-181`), not from metadata; every node's `fieldMeta.required` in this run is literally `false`.

What *is* lost is authoritative required/readonly/type truth in the two authoring prompts.

## 2.4 Are the authors told they're operating with less grounding?

**No.** `buildCasesPrompt` (`authoring.ts:380-382`) and `buildPlanPrompt` (`:408`) both do:

```ts
const metadataBlock = String(input.metadataHint || '').trim() ? `\n${…}\n` : '';
```

An absent metadata block is an **empty string**. There is no "metadata unavailable — treat field requirements as unverified" sentinel, no confidence flag, no change of system prompt. The authors emit with identical confidence and identical instructions. This is a silent degradation.

---

# 3. DOM snapshot capture — what the tool sees vs. what a human sees

## 3.1 The exact tool calls

`nodes/discovery.ts:317-328`, in order, against **one** authenticated page session:

1. `collectPageContext(page)` — `inspectionService.ts:81` — a single `page.evaluate` returning headings/tables/forms/actions/bodyText. Reduced to counts + a 600-char excerpt (`discovery.ts:62-71`).
2. `captureVerifiedElementsForOpenPage(page, {maxElements})` — `domExplorer.ts:850`. This is the real capture, and it is **two sources merged** (`domExplorer.ts:529-547`):
   - **accessibility snapshot**: `snapshotRoot.ariaSnapshot({ mode: 'ai' })` (`:536`), refs resolved back to elements in chunks of 25 (`:472-486`)
   - **full DOM sweep**: `sweepDom()` (`:490-527`) — `querySelectorAll('*')` with **open shadow-DOM piercing** (`:504`)
   - merged and deduped by a `[tag,id,testId,ariaLabel,name,dataField,placeholder,text[0:40]]` signature (`:540-545`)
3. `revalidatePriorElements` (`:319`) — re-checks selectors carried from a prior attempt
4. `revealAndCaptureDisclosedControls` (`:320` → `:111-132`) — clicks up to 4 disclosure controls
5. `navigateToGoalObject` (`:325` → `:185-209`) — conditional, see §3.3
6. `exploreFormState` (`:328` → `:219-275`) — opens one create form, captures it scoped to the overlay

Then per-selector live verification — `count()` + `first().isVisible()` (`domExplorer.ts:861-870`) — and rank-truncation.

## 3.2 What is excluded by design

| excluded | code |
|---|---|
| `meta/link/script/style/title/base/noscript/template/html/head/body/svg/path` | `domExplorer.ts:498` |
| any element that is neither interactive nor carries an identity attribute (`data-testid`/`data-field`/`aria-label`/`placeholder`/`th` text) | `:515-516` |
| presentational children of a clickable ancestor (icon/label spans in a button) | `:518-519` |
| everything past the **600-element** sweep cap | `:521` |
| everything past the **200-element** rank cap (`maxElements`, scored `interactive→0, visible→0`) | `:852-854` |
| **iframes** — `querySelectorAll` does not cross frame boundaries; no `page.frames()` traversal exists anywhere in the file | *(absence)* |
| **closed** shadow roots — only `e.shadowRoot` (open) is pierced | `:504` |

Hidden elements are *captured* but ranked last and dropped first by the cap.

## 3.3 The wait/settle condition — and the specific "Tabs" answer

There **is** a settle chain, and it is decent for the *initial* capture. `pageSession.ts:113-147`:

```
page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
page.waitForLoadState('networkidle', { timeout: 10000 })        // best-effort
…login…
page.waitForFunction(() => hasGridRows || (!stillLoading && hasContent), { timeout: 20000 })
page.waitForTimeout(700)                                        // "brief settle so late rows/toolbar controls mount"
```

Not a bare snapshot-on-navigation. But note what is **missing**: no animation/transition wait anywhere, and `captureVerifiedElementsForOpenPage` itself (`domExplorer.ts:850`) performs **no settle at all** — it evaluates immediately against whatever the page currently is. The `settle()` helper with its element-count-stability loop (`domExplorer.ts:49-58`) is only used by the *legacy* `exploreAppElements` path, **not** by the graph discovery node.

Post-interaction waits are fixed timeouts:
- after a disclosure click: `waitForTimeout(900)` (`discovery.ts:119`)
- after a nav click: `waitForLoadState('domcontentloaded', 8s)` + `waitForTimeout(700)` (`:198-199`)
- after opening a create form: `waitForSelector('input:not([type=search])…', {timeout: 6000, state:'visible'})` + `waitForTimeout(700)` (`:233-237`) — this one *is* content-conditioned, and the comment at `:231-232` records that a fixed pause previously captured a half-rendered dialog

**Now the decisive finding for the Tabs case.** Tab-panel content that only exists after a tab click is captured **only if some code clicks that tab.** Three functions could:

- `revealAndCaptureDisclosedControls` — gated on `DISCLOSURE_LABEL` (`discovery.ts:102`): `actions|export options|settings|more|menu|filter|filters|columns|options`. **"Tabs" does not match.**
- `navigateToGoalObject` — first line (`:186`): `if (!goalTerms.length || elements.some(isCreateOpener)) return;` The Admin landing page **does** expose a `New` button, so `isCreateOpener` is true and the function **returns immediately without navigating to Tabs**.
- `exploreFormState` — picks the highest-goal-affinity create opener and clicks it. It clicked the landing page's `New`, which opened the **New App** form.

So the run's entire catalog describes the Admin landing page plus the **New App** dialog. Zero Tab-creation controls were ever in the DOM the agent read. This is not a Tabs failure mode — it is the general law: **conditionally-rendered content is invisible unless a hardcoded-verb heuristic happens to click its trigger.** A human clicking through would have seen the Tab form; the agent never navigated there because a *different* create button already satisfied its "found a form" precondition.

To its credit, the Case Writer detected this honestly — it tagged case 2 `@evidence-gap` and wrote the precondition *"no verified Tab Type values, Object values, or tab creation fields are currently available in the evidence"*. The evidence loss is upstream of authoring, and authoring reported it.

---

# 4. Inspector → Selector Registry → Script Author

## 4.1 The literal transformation

```
discovery.elements : VerifiedElement[]          102 elements
        │  grounding.ts:182  → toVerifiedSelector (grounding.ts:61-103)
        ▼
run.selector_registry.verified_selectors        102 VerifiedSelector   [artifact: verifiedSelectors, 71 282 bytes]
        │  grounding.ts:184  → buildEvidenceGraphFromRun (evidenceGraph.ts:95-140)
        ▼
EvidenceGraph.nodes                              89 nodes              [artifact: evidenceGraph, 150 683 bytes]
        │  renderCatalogForPrompt.ts:15-49
        ▼
SEMANTIC TARGET CATALOG (prompt text)            89 lines, cap 200
```

Promotion rule — `grounding.ts:72`:
```ts
verified: hasSelector && confidence === 'verified-live' && el.unique === true
```
Admission filter — `evidenceGraph.ts:104-105`:
```ts
if (!vs || !vs.id || !vs.verified || !vs.selector || vs.confidence !== 'verified-live'
    || vs.provenance !== 'LIVE_DOM' || vs.uniqueness !== true || vs.visibility !== true) continue;
```
**102 → 89: 13 elements dropped** for not being simultaneously verified-live, unique, visible and selector-bearing.

Selector *choice* is `resolveBestSelector` (`domExplorer.ts`), and in this run it produced four distinct strategies — visible in the actual nodes:

```
Tabs        [button]  "Tabs"        role=button[name="Tabs"]                            role+name
New         [button]  "New"         [aria-label="New"]                                  aria-label
Label       [row]     "Label"       tr:has-text("Label")                                row-key
Label_2     [button]  "Label"       tr:has-text("Label") >> role=button[name="Label"]    row-key
Label_3     [textbox] "Label *"     #create-app-label                                   id       (stateTag: form)
APIName     [button]  "API Name"    tr:has-text("Label") >> role=button[name="API Name"] row-key
APIName_2   [textbox] "API Name *"  #create-app-api                                     id       (stateTag: form)
Prefix      [textbox] "Prefix *"    #create-app-prefix                                  id       (stateTag: form)
Version     [button]  "Version"     tr:has-text("Label") >> role=button[name="Version"]  row-key
Version_2   [textbox] "Version"     #create-app-version                                 id       (stateTag: form)
ParentApp   [button]  "Parent App"  tr:has-text("Label") >> role=button[name="Parent App"] row-key
ParentApp_2 [combobox]"Parent App *"#create-app-parent                                  id       (stateTag: form)
TextStyle   [combobox]"Text style"  [aria-label="Text style"]                           aria-label
Create      [button]  "Create"      role=button[name="Create"]                          role+name  (form)
Cancel      [button]  "Cancel"      role=button[name="Cancel"]                          role+name  (form)
NewApp      [heading] "New App"     role=heading[name="New App"]                        role+name  (form)
```

`#id` wins where an id exists; `role=name` where the accessible name is unique; `aria-label` where the label is the only identity; `tr:has-text(…) >> …` for repeated per-row controls (this is `GROUNDING_DISAMBIGUATION_V1=1`, enabled in `.env.local:50`, which rescues row-repeated controls instead of dropping them).

## 4.2 Does the Registry deduplicate or collapse distinct elements?

It **renames** rather than drops. `uniqueSemantic` (`evidenceGraph.ts:143-150`) appends `_2`, `_3` on semantic-name collision. The grid **column header button** `Label`, the grid **row** `Label`, and the **form input** `Label *` are three genuinely different elements that become `Label_2` / `Label` / `Label_3`.

Nothing is lost, but the disambiguating information — *which one is the form field* — survives only as an opaque numeric suffix plus a `stateTag` grouping in the rendered catalog. The Plan Author correctly picked `Label_3`/`APIName_2`/`Version_2`/`ParentApp_2` here, but it did so from the `CONTROLS INSIDE THE CREATE/EDIT FORM` section header (`renderCatalogForPrompt.ts:42`), not from the names. Remove that grouping and the names alone are pure coin-flip.

Elements *are* genuinely dropped by the 600-cap (`domExplorer.ts:521`), the 200-cap (`:852-854`) and the 13-element admission filter above — those are real, silent coverage losses, but they are not the name-collapse the question anticipated.

## 4.3 What does the Script Author actually receive?

Exactly this line format, `renderCatalogForPrompt.ts:23-33`:

```
- {semanticName} [{role}] "{label}" (required)? (observed: value=…)? (metadata: …)? [DATA ROW …]?
```

grouped into `PAGE / LIST CONTROLS (present at rest…)` and `CONTROLS INSIDE THE CREATE/EDIT FORM (…EXIST ONLY AFTER you click the New/Add/Create opener…)`.

So the author gets **label + role + required + observed value + state-group**. It does **not** get:
- the selector (deliberate — invention becomes an explicit `UNRESOLVED_SELECTOR`, `renderCatalogForPrompt.ts:3-5`)
- `aria-current` / `aria-selected` / `aria-pressed` / active-class / any visual-state fact
- the uniqueness caveat, or the DOM scope the selector was verified in

Consequence for the exact scenario in the question: **the Script Author has no vocabulary for "is this tab now visually active".** There is no assert in `PLAN_ASSERTS` that expresses it and no catalog fact that would ground it. The best it can do is what it did — `VISIBLE` on the thing it clicked.

## 4.4 Is there a structural check that the selector matches the step's prose?

No. There are two checks, and neither does that:

1. **`catalogTargetIssues`** (`authoring.ts:456-472`, gated by `PLAN_TARGET_VALIDATION_V1=1`, `.env.local:51`) — verifies each target **exists in the catalog**, nothing more. Comment at `:465-466` is explicit: it flags only "a target name absent from the catalog".
2. **`resolveTarget`** in the compiler (`playwrightCompiler.ts:387`) — same question, at compile time.

The mapping **case-step prose → catalog target** is pure model inference by the Plan Author, with zero structural verification. Nothing anywhere compares "Select the *Cancel* button" to the node labelled `Cancel`.

---

# 5. Script execution vs. human behaviour

## 5.1 The Tabs case — divergence in three lines

Case (1 step): *"Select the 'Tabs' button." → "The Admin console responds to the selection and displays the Tabs workspace…"*

Compiled script (`playwright_scripts[0]`):
```ts
await runner.startMission();
await runner.click(      {"selector":"role=button[name=\"Tabs\"]", "role":"button","label":"Tabs"});
await runner.expectVisible({"selector":"role=button[name=\"Tabs\"]", "role":"button","label":"Tabs"});
```

A human would click Tabs, then **look at the workspace** — a heading, a grid, a URL change. The script clicks Tabs and then asserts **the button it just clicked is still visible.** That is a tautology dressed as verification: the expected result *"displays the Tabs workspace"* is not tested at all.

And it did not even survive as a tautology. Actual runtime error (`executionTests[1].error`):

```
expect(locator).toBeVisible() failed
Locator: locator('role=button[name="Tabs"]')
Expected: visible
Error: strict mode violation: locator('role=button[name="Tabs"]') resolved to 2 elements:
    1) <button type="button" class="nav-item active">…</button>
       aka getByRole('complementary').getByRole('button', { name: 'Tabs' })
    2) <button type="button" aria-current="page" class="record-tab-button …">…</button>
       aka getByRole('main').getByRole('button', { name: 'Tabs' })
```

The registry recorded `Tabs` with `uniqueness: true` — and it was true, **at discovery time, before the click**. Clicking it caused the app to render a second "Tabs" control in `main`. **Registry uniqueness is a snapshot property; the script asserts after a state change that invalidates it.** Verification (`domExplorer.ts:861-870`) happens once, on the resting page; there is no re-verification against post-action state.

The bitter irony: element 2 carries `aria-current="page"` — the *exact* signal a human uses to say "the tab is now selected". It is in the DOM, it is what the case wanted, and the pipeline sees it only as a strict-mode collision.

## 5.2 Does the script assert on rendered results or on "the click didn't throw"?

Both exist, but the runner's semantics matter. `MissionRunner` does own real result-asserts — `expectRowInList` (`missionRunner.template.ts:~300`, polls 40 s and reloads the list), `expectTable`, `expectUrl`, `expectEmptyState`. But the **plan** must ask for them, and neither plan did. Both plans assert only `VISIBLE`/`NOT_VISIBLE` on controls.

For the false-pass concern specifically: `click` (`missionRunner.template.ts:186`) resolves as long as Playwright's actionability checks pass — it does not observe any consequence. If case 1's assert had targeted a genuinely unique control, the test would have **passed** on a click that changed nothing. The tautological assert is a live false-pass generator; here it produced a false *failure* instead, purely by accident of ambiguity.

## 5.3 Fixed timeouts

The generated specs contain **zero** timeouts — the compiler emits none, and the gate forbids raw Playwright calls (`validateCompiledOutput.ts:9-16`). All waits live in `MissionRunner`: `expectValidation` 10 000 ms, `expectVisible` Playwright default, `expectRowInList` a 40 s deadline with reload, `searchGlobalFor` an unconditional `waitForTimeout(800)`.

The one that bit this run is **`expectValidation`'s 10 s** (`missionRunner.template.ts`, `expect(alert.first()).toBeVisible({ timeout: 10000 })`). It is not too short — no error element could ever appear, because nothing was submitted. It spent 10 s of the case's 29.5 s proving a negative.

## 5.4 Why the impossible assert was emitted — the guard that didn't fire

The compiler has a purpose-built guard for exactly this (`playwrightCompiler.ts:43-86`, invoked at `:363` under `BEHAVIOR_ORACLE_V1`, which defaults **on**). The behaviour oracle had already measured the truth (`artifact: behaviorOracle`):

```json
{ "probed": true, "submitLabel": "Create",
  "validationMechanism": "aria-invalid",
  "validationTriggered": true, "requiresSubmitToValidate": true, "fields": [ … 6 … ] }
```

`requiresSubmitToValidate: true` — a validation error cannot exist before Create is clicked. But the guard bails at `playwrightCompiler.ts:79`:

```ts
if (submitIdx < 0) return drops;
```

The plan clicks **Cancel**, never Create, so `submitIdx` stays `-1`, the guard returns an empty drop-set, and the impossible assert is emitted verbatim. `agent_runs.raw.compiler_diagnostics` is literally `[]` — the compiler reported nothing wrong. **A validation assert in a plan with no submit at all is more obviously impossible than one merely mis-placed, and it is the one case the guard skips.**

Downstream, `outcomeValidation` mis-classified the consequence:

```json
{ "infra": 1, "unknown": 1, "appDefects": 0, "assertionDefects": 0,
  "classifications": [
    { "title": "New tab form controls are identified before automation",
      "verdict": "infra", "reason": "Environmental failure (timeout/navigation/browser), not a product or test-logic defect." },
    { "title": "Tabs workspace opens from Admin",
      "verdict": "unknown", "reason": "Failure did not match a classifiable pattern against the behaviour oracle." } ] }
```

Both are **test-logic defects** — an impossible assertion and a stale-uniqueness locator. Neither is infra, neither is unknown, and `assertionDefects` reads `0`.

## 5.5 What is literally on screen at each intermediate frame

| frames | page state | would a human call this a step? |
|---|---|---|
| 1 | Admin landing page, post-navigation | setup, not a step |
| 2 | New App modal open (after `click New`) | **yes — case step 1** |
| 3-11 | **identical** New App modal; nine read-only assertions, nothing interacts | one step ("inspect the form"), not nine |
| 12 | same modal, 10 s after a doomed error-element hunt | not a step at all |
| 13 | same modal, harness end-of-test capture | not a step |

No tab-switch state, no reload, no retry. **Nine of the thirteen frames are the same screen photographed nine times.**

---

# 6. Script Verifier and Evidence Runner

## 6.1 Does Script Verifier check step correspondence?

No. `validateCompiledOutput` (`compiler/validateCompiledOutput.ts:9-16`) is six line-wise regexes:

```
RAW_GOTO          page.goto(
RAW_URL           new URL(
SEARCH_PARAMS     .searchParams
INLINE_LOGIN      loginIfNeeded | logoutIfAlreadySignedIn
POSITIONAL_GUESS  .first( | .nth(
HARDCODED_APPID   appId: "…"
```

Purely architectural hygiene — *"the compiler, not the LLM, owns navigation/login/locators"* (`:1-4`). It never reads the case, never counts steps, never resolves a selector. Step-inflation is structurally invisible to it. (Selector *resolution* happens earlier, in the compiler at `playwrightCompiler.ts:387`, and only against the catalog — not against case prose.)

## 6.2 Does Evidence Runner know about step boundaries?

No — and this is the mechanical answer to the whole §1 question. `parsePlaywrightResults` (`executionService.ts:196-307`) has no case-step concept anywhere. It:
- filters attachments by `/^step-\d+$/i` and sorts numerically (`:219-223`)
- writes each to `t{i}-step-{k+1}.png` (`:264-273`)
- merges `step-log` JSON entries into a flat ordered array (`:291-303`)

`publishEvidenceShots` (`nodes/execution.ts:88-133`) then zips the two flat arrays **by index** (`:117-118`). Evidence is recorded **per low-level runner action**, never per human-legible step. It could not group by step even if asked — the information does not exist in any artifact it receives.

## 6.3 Could snapshots be tagged with their case step?

Yes, and the plumbing is 80% there — `act()` already carries `kind`, `label`, `value`, `ok`, `ms`, `error` into the step log (`missionRunner.template.ts:88`). What is missing is one field threaded end to end:

1. add `sourceStep?: number` to `planStepSchema` (`compiler/testPlan.ts:51-56`) and require it in the plan prompt (`authoring.ts:418-431`)
2. emit it as an extra arg on each runner call (`playwrightCompiler.ts:365-495`)
3. include it in `logStep` (`missionRunner.template.ts:72-75`)
4. carry it into `EvidenceShot['steps']` (`nodes/execution.ts:117-127`)
5. group by it instead of index-zipping in `shared/testCases.ts:74-85`

That yields "step 1 → 1 frame, step 2 → 9 frames, step 3 → not reached", and simultaneously fixes the off-by-one mis-attribution in §1.5.

---

# 7. Empirical confirmation

## 7.1 A live re-run is currently blocked

The system under test is down: ports **5001 (Service), 5002 (Admin), 5003 (Keystone) are all closed**; only 3000/3001 (this app's own frontend/backend) are listening. A fresh run would fail at `discover_and_ground` with `NETWORK_TRANSIENT`, produce zero evidence, and prove nothing about the handoffs. Start `D:\core-platform` and this can be executed on request.

## 7.2 The five artifacts, side by side, from the persisted run

All five boundaries survive in `agent_run_artifacts` and are reproduced in full above:

| # | artifact | key | size | shown in |
|---|---|---|---|---|
| 1 | Inspector output → Registry | `verifiedSelectors` | 71 282 B, 102 entries | §4.1 |
| 2 | Registry → Evidence Graph / catalog | `evidenceGraph` | 150 683 B, 89 nodes | §4.1 |
| 3 | Script Author output (plan IR) | `plansByCase` | 884 B, 13 steps | §1.2 |
| 4 | Generated script | `compiledSources` / `playwright_scripts` | 3 515 B, 2 specs | §1.2, §5.1 |
| 5 | Evidence Runner action log | `executionTests` + `evidence_screenshots` | 5 228 B + 4 475 B | §1.3 |

**Where 3 became 13** is now literal and singular: **`plansByCase['case-2']` holds 13 steps for a 3-step case.** Every stage after that is 1:1 (plus one harness frame). The multiplication happens at exactly one place — the Plan Author, executing `authoring.ts:426`.

**Which DOM state "skipped" corresponds to:** `MetadataFetch skipped` = `mission.applicationId === ''` on an ADMIN mission (`context.ts:52-54`) — a deliberate short-circuit that touched no DOM. It is unrelated to the separate, real evidence gap: the Tab-creation UI was never in any captured DOM, because `navigateToGoalObject` short-circuited at `discovery.ts:186` when it found a `New` button on the landing page.

---

# Appendix — defects found, ranked

| # | severity | defect | location |
|---|---|---|---|
| 1 | **high** | Case step → evidence frames zipped **positionally**; every step shows the wrong screenshot and 10 of 13 frames are unreachable | `shared/testCases.ts:74-85` |
| 2 | **high** | Impossible validation assert emitted: the guard skips any plan with no submit click | `playwrightCompiler.ts:79` |
| 3 | **high** | Registry uniqueness verified once on the resting page; a script asserting after a state change hits strict-mode violations | `domExplorer.ts:861-870` vs runtime |
| 4 | **high** | Test-logic defects mis-classified as `infra` / `unknown`; `assertionDefects: 0` | `outcomeValidator`, artifact `outcomeValidation` |
| 5 | **med** | `MetadataFetch` chip renders "Skipped — (normal for Admin-platform runs)" for genuine `NETWORK_TRANSIENT` failures; the discriminating pattern already exists two lines above for discovery | `runtime.ts:135-136` vs `:128-133` |
| 6 | **med** | Metadata absence silently omits the prompt block — no degraded-confidence signal to either author | `authoring.ts:380-382`, `:408` |
| 7 | **med** | `plansByCase` is stashed **per case** (`testRunGraph.ts:521`) but mirrored as a **whole-key replace** (`runStoreMirror.ts:17-22`) → with `AGENT_NATIVE_V1=1` the durable row keeps only the last case's plan. Confirmed: 2 cases compiled, 1 plan persisted | `runStoreMirror.ts:17-22` |
| 8 | **low** | No `sourceStep` on `planStepSchema` — case-step identity destroyed at the first handoff | `compiler/testPlan.ts:51-56` |
| 9 | **low** | Conditionally-rendered UI reachable only via hardcoded verb regexes; `navigateToGoalObject` self-disables whenever any create opener exists on the landing page | `discovery.ts:102`, `:186` |
| 10 | **low** | Stale comments claim before/after capture; code takes one frame per action | `missionRunner.template.ts:59`, `:184` |
| 11 | **low** | No iframe traversal, no closed-shadow-DOM access, no animation/transition settle | `domExplorer.ts:490-527`, `:850` |
