# Why the pipeline "fails all the time" — unified root cause

Date: 2026-07-30. Reverse-engineered from a 10-prompt parallel API reproduction (fresh backend).
Symptoms observed: authoring-blocked runs (Pattern C), false `[Auto] timeout on <control>` defects, and
authoring-blocks mis-filed as `"Run failed"` High product defects.

## The single upstream root cause: discovery is GOAL-BLIND

Production routes every run through AGENT_GRAPH_V2 (LangGraph). Its discovery node is resolved as:

- `runtime.ts:726` builds the graph with **empty deps** (no override).
- `testRunGraph.ts:266`: `const discoveryNode = deps.discoveryNode ?? runDiscoveryNode` → **`runDiscoveryNode`** (`nodes/discovery.ts`).
- `testRunGraph.ts:316`: called as `discoveryNode({ mission, credential, runId, auth })` — **the goal/prompt is never passed in.**

What `runDiscoveryNode` actually does (`nodes/discovery.ts`):
1. Opens **only `mission.targetUrl`** (`discovery.ts:237,252`) — for Admin that is the root `http://localhost:5002/`, unmodified.
2. `exploreFormState` (`discovery.ts:162-217`) opens a create/edit form, but picks the **FIRST** element whose label matches a generic verb regex `FORM_OPENER_LABEL = /^(new|create|add|edit|\+ ?new|\+ ?add)\b/i` (`:132,164-166`) — it has **no concept of the goal** ("Role" vs "Tab" vs "Field"). After capture it **restores** back to the landing URL (`:209-211`).
3. It never navigates goal-first from the landing root to the specific object's list → that object's create modal.

**Consequence:** whether the evidence graph contains the controls the goal needs is a **coincidence** — it only works when the goal's create form happens to be the first create button reachable on the exact landing URL. This is why it is **non-deterministic** (p6/Role blocked in one run, authored in another; the failing prompts differ run-to-run).

There IS a goal-DRIVEN inspector — the legacy `inspectApplicationFlow` (`inspectionService.ts`) with MCP/tool-loop LLM variants that navigate toward the named feature and open its create form (`toolLoopInspector.ts:25`, `mcpInspector.ts:50`). But production is NOT using it for these runs — the capable inspector exists and sits unused behind the goal-blind LangGraph node.

## One cause, two faces

- **Face 1 — authoring blocked (Pattern C):** goal needs modal controls the graph never captured → `authorCases` emits all-`@blocked` → gate throws `EVIDENCE_INSUFFICIENT` "Case authoring blocked — the discovered page does not expose the controls this goal needs" (`testRunGraph.ts:433-443`). Seen on p9 (Field), p10 (Tab).
- **Face 2 — execution timeout:** authoring proceeds on partial/resting-page evidence → the compiled script targets a control not reachable in that state → `locator … Timeout` at execution → `[Auto] timeout on "<control>"`. Seen on p5 (Industry), p6 (#create-app-label), p7 (Search results).

## Two ungated defect leaks turn tooling faults into "product bugs"

- **Coarse path (`routes.ts:1062-1080`):** `if (run.status === 'failed') Defects.upsert({ title: '… — Run failed', severity: 'High' })` — fires for ANY failed run with **no cause check**, and completely bypasses the `NON_PRODUCT_DEFECT_KINDS` gate. This filed the authoring-blocked p9/p10 as High product defects.
- **Per-signature path (`routes.ts:1102` → `defectReporter.buildDefectDrafts`):** has the gate, but `NON_PRODUCT_DEFECT_KINDS = {'tooling-obscured'}` excludes only the obscured-behind-overlay class. The p5/p6/p7 failures classify as `timeout`/`element-not-found` (control never *reached*, not *obscured*), so they slip through and file.

## One-sentence root cause

The active discovery node is goal-blind — it scrapes the single landing URL and opens whatever generic create form is first, never navigating to the specific object the prompt names — so the evidence the author needs is present only by luck; when it's absent the run either blocks (Pattern C) or authors a script that times out on an unreachable control, and two ungated defect paths then file both as product bugs.

## Fix directions (not yet implemented)

1. **Make the active discovery goal-aware.** Either route these runs through the goal-driven inspector (`inspectApplicationFlow`, MCP), or pass the goal into `runDiscoveryNode` and have `exploreFormState` navigate to the goal's object and open ITS create modal (domExplorer already supports an `open?: string[]` click-path). This removes the coincidence.
2. **Close the two defect leaks.** Gate the coarse `routes.ts:1062` path on cause (never file `EVIDENCE_INSUFFICIENT`/tooling as a product defect), and broaden the per-signature gate beyond `tooling-obscured` to the grounding-miss class (`timeout`/`element-not-found` on an unreached control), pending QA-verify.
3. **Bug A (separate, intermittent):** the case-JSON repair detector regex (`authoring.ts:194`) still doesn't match Node 20+ V8 JSON errors ("Expected ',' or ']' …"); add those shapes so truncation triggers the one-repair retry.
