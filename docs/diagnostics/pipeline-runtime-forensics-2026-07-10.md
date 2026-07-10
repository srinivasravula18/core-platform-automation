# Forensic Runtime Data-Flow Trace — "Generate 2 Test Cases"

Read-only code inspection of the current repo (no edits, no fixes). All snippets are quoted verbatim from the current working tree with file:line citations. This complements `docs/diagnostics/agent-run-incident-report-2026-07-10.md` (the live-run incident report) by exposing the actual implementation behind each stage.

---

## PART 1 — Execution flow, in call order

```
HTTP POST /api/agent/start                                    server/features/agent/routes.ts:4527
  ↓
Guardrail pipeline (short-circuit/reject check)                routes.ts:4545 runGuardrailPipeline()
  ↓
Scope/app/folder/credential resolution                         routes.ts:4556-4699
  ↓
runMetadataFetchPhase()                                        server/features/agent/pipelineDelta.ts:57
runContextBuilderPhase()                                       pipelineDelta.ts:89
runMultiContextInspectionPhase()                                pipelineDelta.ts:150
  → inspectApplicationFlow()                                   server/features/agent/inspectionService.ts:317
  → exploreAndVerifyPage()                                     server/features/agent/domExplorer.ts:562
  → collectMcpDomFacts() / evaluateJson()                       server/features/agent/mcpDomFacts.ts:81 / :74
  → extractSelectorMap()                                        server/features/agent/selectorMap.ts:44
  → writeBlackboard()                                           server/features/agent/blackboard.ts:14
  ↓
CodeAnalyst (git-agent step)
FeatureDiscoveryAgent / RequirementWriter / CoverageScout       routes.ts (per-agent phase blocks)
  ↓
TestGenerationAgent
  const caseWriter = await getOrchestrator('caseWriter', {...})  routes.ts:2061 / orchestrator.ts:630
  await caseWriter.generateObject({...})                         routes.ts:2062 → orchestrator.ts:193
    ↓
    runGuardrailPipeline()                                       orchestrator.ts:194
    assembleSystem()                                             orchestrator.ts:185/211
    this.provider.generateObject({system, prompt, schema, ...})   orchestrator.ts:223 → server/ai/providers/{openai,anthropic,gemini}.ts
    recordUsage()                                                 orchestrator.ts:229
    logExecutionTrace()                                           orchestrator.ts:244 → server/ai/tracer.ts:35
    ↓
  LLM provider HTTP call (OpenAI/Anthropic/Gemini SDK)
    ↓
  Response → result.object returned to routes.ts:2062 caller
  ↓
PlaywrightAgent (script authoring)  — same generateObject() shape, different prompt (routes.ts:2497/2575)
  ↓
LiveAuthor / ControlResolver / SelectorVerifier / EvidenceAgent / AuthSessionAgent
```

There is no separate "Supervisor → Tool Loop → executeIntent()" abstraction in this codebase under those literal names. The nearest analogues are: the phase-sequencing code in `routes.ts` (acts as supervisor), `AgentOrchestrator.runToolLoop()` in `server/ai/orchestrator.ts:375-568` (the actual tool-calling agentic loop, used by chat/tool-using agents, not by `caseWriter`/`coder` which call the single-shot `generateObject()` instead), and `getOrchestrator()` (`orchestrator.ts:630`, the per-agent provider/model/effort resolver — closest thing to a dispatcher).

---

## PART 2 — Context-builder functions (full implementations)

### `assembleSystem` — server/ai/orchestrator.ts:185-191
```typescript
private async assembleSystem(pipeline: PipelineResult): Promise<string> {
  const override = await getActivePrompt(this.agent);
  if (override && override.body) {
    return `${override.body}\n\n[Guardrail pipeline: ${pipeline.requestId}]`;
  }
  return pipeline.systemPrompt;
}
```
Input: guardrail pipeline result (which itself ran `composeSystemPrompt()` — see Part 9). Output: either a DB-stored prompt override + requestId tag, or the composed policy+agent prompt. Nothing is removed/summarized/truncated here — it's a straight pass-through with one branch.

### `composeSystemPrompt` — server/ai/systemPrompts.ts:145-165
```typescript
export function composeSystemPrompt(opts: {
  agentName: string; agentRole: string; agentSpecificInstructions: string;
  includeOutputFormat?: boolean; includeInjectionDefense?: boolean;
}): string {
  const parts = [
    CORE_IDENTITY, SCOPE_POLICY, SAFETY_POLICY, GROUNDING_POLICY,
    `--- AGENT: ${opts.agentName} ---`,
    `Your role in this specific call: ${opts.agentRole}`,
    `Your task-specific instructions:`,
    opts.agentSpecificInstructions,
  ];
  if (opts.includeOutputFormat !== false) parts.push(OUTPUT_FORMAT);
  if (opts.includeInjectionDefense !== false) parts.push(INJECTION_DEFENSE);
  return parts.join('\n\n');
}
```
Concatenates 6-8 fixed policy blocks (~2-3KB of static text) + one per-agent instruction block. No truncation — this grows unbounded with the number of policy sections (currently fixed at 4 always-included + 2 optional).

### `summarizeUnderstanding` — server/features/agent/routes.ts:1499-1543 (maxChars=4000 default)
Builds a line-array from `title/description/businessRules/adminBehavior/keystoneBehavior/dataPopulationNotes/sharedComponents(≤12)/metadataRefs/uiSelectors(≤30 each field)/sourceFiles(≤10)/candidateScenarios`, joins with `\n`, then **hard-truncates**: `return lines.join('\n').slice(0, maxChars)` (line 1542) — no continuation marker, so a cut can land mid-word/mid-JSON.

### `summarizeFeatureInventory` — routes.ts:1545-1566 (maxChars=12000 default)
Same shape: features capped to 35, subfeatures per feature capped to 14, e2e flows capped to 20, then `lines.join('\n').slice(0, maxChars)` (line 1565) — hard cut, no marker.

### `renderSelectorRegistryForPrompt` — server/features/agent/pipelineDelta.ts:457-468 (cap 160)
```typescript
export function renderSelectorRegistryForPrompt(registry: any): string {
  const selectors = registry?.selectors || {};
  const lines = Object.entries(selectors)
    .filter(([, value]: any) => value?.verified && (value.primary_selector || value.fallback_selector))
    .slice(0, 160)
    .map(([id, value]: any) =>
      `${id}: proof=${value.proof_id || id} label=${value.label || value.metadata_api_name || ''} primary=${value.primary_selector || '(none)'} fallback=${value.fallback_selector || '(none)'} source=${value.evidence_type || 'inspection'} confidence=${value.confidence || 'verified'}`,
    );
  return lines.length
    ? `\nVERIFIED SELECTOR REGISTRY (STRICT AGENT HANDOFF): use ONLY these proof ids/selectors...\n${lines.join('\n')}\n`
    : '';
}
```
**Filters on `value?.verified`** — this is the field that, per the live-run report, gets set true even for the static source-scan fallback (SelectorRegistry stage), so this filter does not distinguish live-DOM-verified from source-regex-"verified".

### `renderBlackboardForPrompt` — routes.ts:1643-1662 (maxItems=80 default)
Filters elements to `status === 'verified' || 'not_unique'` with a resolved/fallback selector, slices to 80, formats each as `- role "label" -> selector [state] options=...`. Options per select capped at 12, label capped at 80 chars.

### `renderPageOutlineForPrompt` — routes.ts:3328-3334 (maxChars=6000)
```typescript
function renderPageOutlineForPrompt(exploration: any, maxChars = 6000): string {
  const outline = String(exploration?.outline || '').trim();
  if (!outline) return '';
  const cleaned = outline.replace(/\s*\[ref=e\d+\]/g, '');
  const body = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n  ... (outline truncated)` : cleaned;
  return `\nPAGE OUTLINE:\n${body}\n`;
}
```
This is the one context-builder that DOES mark truncation explicitly (`... (outline truncated)`). Everywhere else the cut is silent.

### `renderVerifiedElementsForPrompt` — routes.ts:3336-3372 (cap 120 elements, 12 options, 60-char labels, 70-char tooltips)
Ranks elements, filters to `verified`/`not_unique` with a resolved selector, disambiguates same-role/same-label collisions with `.first()`, then slices to 120. Falls back to `renderRawElementsForPrompt` if no `status` field is present (i.e., raw/never-verified data flows straight into the prompt unlabeled as such).

### `renderOnPageTextForPrompt` — routes.ts:3374-3400 (maxItems=80, 3-110 chars per snippet)
Pulls visible text from a fixed allow-list of interactive roles plus quoted strings scraped out of the outline via regex (`/"((?:[^"\\]|\\.){3,120})"/g`), dedupes into a `Set`, slices to 80.

---

## PART 3 — CaseWriter's exact payload (both call sites)

### Call site A — per-feature case writing, routes.ts:1867-1896
```typescript
const caseWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
const result = await caseWriter.generateObject<any>({
  prompt: `Write focused test cases for this specific feature: "${feature.name}".
${feature.description ? `Feature description: ${feature.description}` : ''}
...
Code understanding: ${approvedUnderstanding ? approvedUnderstanding.slice(0, 3000) : 'not provided'}
...
${SOURCE_BOUNDARY_CONTRACT}
${CASE_AUTHORING_CONTRACT}`,
  schema: testCasesSchema,
  userMessage: run.prompt || '',
});
```

### Call site B — full-run case writing (the one that fired in the traced run), routes.ts:2062-2108
```typescript
const caseResult = await caseWriter.generateObject<any>({
  prompt: `User prompt: ${prompt || 'not provided'}.
Approved user-reviewed understanding: ${approvedUnderstanding || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${applicationContextBlock}
${selectorRegistryBlock}
${blackboardBlock}
${selectedQaPromptText}${conversationBlock}
Browser inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}${understandingBlock}
${featureInventoryBlock}${scenarioBlock}${testDataBlock}${readAgentSkill() ? `...` : ''}
${requestedCaseCount > 0 ? `Produce EXACTLY ${requestedCaseCount} test case(s)...` : `Write approximately ${testCaseCount} test case(s)...`}
[... 6 more literal instruction paragraphs: scenario coverage contract, numbered-section contract,
     feature blueprint contract, inspection-truth contract, data-view-verification note, label-vs-apiname note ...]
${SOURCE_BOUNDARY_CONTRACT}
${CASE_AUTHORING_CONTRACT}${knowledgeBlock}`,
  schema: testCasesSchema,
  userMessage: prompt || '',
});
```

**Every block injected, in order of appearance, with its size cap:**
| Block | Builder | Cap |
|---|---|---|
| `credentialContext` | `buildCredentialContext()` | uncapped (small, structured) |
| `applicationContextBlock` | `run.application_context_prompt` | uncapped |
| `selectorRegistryBlock` | `renderSelectorRegistryForPrompt()` | 160 selectors |
| `blackboardBlock` | `renderBlackboardForPrompt()` | 80 items |
| `conversationBlock` | chat history filter/slice (routes.ts:1987-1998) | 12 turns, 2400/600 chars each |
| inline `JSON.stringify(compactInspectionContext(inspectionContext))` | — | uncapped stringify of an already-capped object |
| `renderPageOutlineForPrompt()` | — | 6000 chars |
| `understandingBlock` | `summarizeUnderstanding()` | 4000 chars |
| `featureInventoryBlock` | `summarizeFeatureInventory()` | 12000 chars |
| `scenarioBlock` | `scenarioCoverageBlock()` | not traced in this pass |
| `testDataBlock` | `run.test_data_pack` | uncapped |
| `knowledgeBlock` | `buildKnowledgeBlock()` | 12000 chars |

**System prompt** sent alongside this: `composeSystemPrompt()` output for `caseWriter`, which is `CORE_IDENTITY + SCOPE_POLICY + SAFETY_POLICY + GROUNDING_POLICY + caseWriter-specific instructions (systemPrompts.ts:192-239, ~4500 words) + OUTPUT_FORMAT + INJECTION_DEFENSE`.

No token count is computed or logged anywhere in this call path — `orchestrator.ts:generateObject` only records `result.usage` **after** the provider responds (actual consumed tokens), not a pre-flight estimate of prompt size. There is no pre-send token/char budget check anywhere in this call chain.

---

## PART 4 — PlaywrightCoder's exact payload

### Batch script generation — routes.ts:2497-2580 (approx, per second agent's citation)
```typescript
scriptsResult = await coder.generateObject<any>({
  prompt: `Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
Approved user-reviewed understanding: ${reviewedUnderstanding || 'not provided'}.
${credentialContext}
${loginScriptBlock}
${applicationContextBlock}
${selectedQaContextText}${coderUnderstanding}${coderFeatureInventory}${coderMemory}${coderTestData}${coderMcpDomFacts}${coderSelectorMap}${coderSelectorRegistry}${coderBlackboard}${featureGrounding}${readAgentSkill() ? `...` : ''}
Use this browser inspection context as the source of truth ...: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}${renderVerifiedElementsForPrompt((run as any).dom_exploration)}${allCaseControls}
SETUP  -  NAVIGATE THEN LOG IN IF NEEDED: ...
  await page.goto('${targetUrl || '/'}');
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1500);
  [literal loginIfNeeded() helper template with credential interpolation]
[Scripts follow in the batch]`,
  schema: playwrightScriptsSchema,
});
```

Additional block unique to the coder path: `coderSelectorMap` = `renderSelectorMap(codeMap)` — the raw static source-scan selector map (from `selectorMap.ts:extractSelectorMap`), rendered **without any live/static distinction**, i.e. the coder receives both a "verified selector registry" block (partially live-derived) and a raw source-scan map, with no field telling it which entries came from a real page vs a regex over `.tsx` files.

`coderMcpDomFacts` = `renderMcpDomFactsForPrompt((run as any).mcp_dom_facts)` — in the traced live run this was **empty**, because `collectMcpDomFacts` had already thrown (Part 6/incident report Finding C) and `run.mcp_dom_facts` was never set.

### Per-case fallback — routes.ts:2575-2580
Same block set minus `coderFeatureInventory`/`scenarioBlock`, invoked when the batch call times out or returns fewer scripts than cases (this is exactly what happened in the traced run: "Playwright coder returned 0/2 script(s); generating missing scripts one case at a time").

---

## PART 5 — Tool result flow

This codebase has two distinct "tool result" mechanisms — they must not be conflated:

**(a) MCP tool calls** (`browser_navigate`, `browser_snapshot`, `browser_evaluate`, `browser_wait_for`) inside `mcpDomFacts.ts` / `mcpInspector.ts`:
- **Produced**: `session.client.callTool({name, arguments})` → raw MCP response object with a `content: [{type, text}]` array.
- **Transformed**: `textFromMcp()` (`mcpDomFacts.ts:67-72`) joins all text blocks with `\n` into one string.
- **Transformed again**: `evaluateJson()` (`mcpDomFacts.ts:74-79`) regex-extracts `/\{[\s\S]*\}/` and `JSON.parse`s it — **this is the exact point where a multi-block response produces the "Unexpected non-whitespace character after JSON" failure** documented in the incident report.
- **Stored**: assigned to `run.mcp_dom_facts` (`pipelineDelta.ts:237`).
- **Injected**: via `renderMcpDomFactsForPrompt()` into the coder's prompt — but ONLY if the call succeeded; on failure the block is simply the empty string, with no marker telling the coder "DOM facts were unavailable" (the coder's prompt silently has one less context block; it cannot tell the difference between "no DOM facts were relevant" and "DOM facts collection crashed").
- **Discarded**: on any error, the `catch` block (`pipelineDelta.ts:244-246`) discards the exception entirely except for a message-log string; `run.mcp_dom_facts` is left `undefined`.

**(b) `runToolLoop()` tool calls** (`orchestrator.ts:375-568`, used by tool-calling agents, NOT by caseWriter/coder in this run):
- **Produced**: `tool.execute(call.arguments, ctx)` (`orchestrator.ts:~455`).
- **Stored**: pushed to `toolResults[]` array (`{name, arguments, result}`) and to `step.toolCalls`.
- **Transformed**: `safeJson(inv.result)` (`orchestrator.ts:594-601`) — `JSON.stringify` then **hard slice to 8000 chars**, the only truncation point in the entire tool loop.
- **Injected**: `messages.push({role: 'tool', toolCallId, toolName, content: safeJson(...)})` — this exact truncated string is what the next LLM call sees.
- **Overwritten**: never — messages array is append-only; nothing is pruned even across 12 max steps.
- **Discarded**: never explicitly, but errors are converted to `inv.error` and sent as `ERROR: ${inv.error}` instead of the real result — that's a controlled discard-and-replace, not silent loss.

---

## PART 6 — Every place information can be lost (grep-verified)

| File:Line | Pattern | Effect |
|---|---|---|
| orchestrator.ts:597 | `.slice(0, 8000)` inside `safeJson()` | Tool result JSON hard-capped at 8000 chars before re-entering the LLM loop |
| pipelineDelta.ts:254-255 | `map.objects.slice(0, 12)` / `obj.fields.slice(0, 30)` | Metadata summary: 12 objects, 30 fields/object |
| routes.ts:1509-1516 | `u.sharedComponents.slice(0, 12)` | Shared components in understanding summary |
| routes.ts:1525-1526 | `.slice(0, 30)` per selector-hint category | uiSelectors sub-arrays |
| routes.ts:1538 | `.slice(0, 10)` | sourceFiles list |
| routes.ts:1542 | `.slice(0, maxChars)` (4000) | `summarizeUnderstanding` final hard cut, **no marker** |
| routes.ts:1551-1556 | `.slice(0, 35)` features / `.slice(0, 14)` subfeatures | Feature inventory |
| routes.ts:1561 | `.slice(0, 20)` | E2E flows |
| routes.ts:1565 | `.slice(0, maxChars)` (12000) | `summarizeFeatureInventory` final hard cut, **no marker** |
| routes.ts:1654-1655, 1658 | `.slice(0, 12)` options / `.slice(0, 80)` label | Blackboard render |
| routes.ts:1882 | `.slice(0, 3000)` | Inline code-understanding slice (feature-specific case-writer call) |
| routes.ts:1991, 1994-1995 | `.slice(-12)` turns, `.slice(0, 2400/600)` per turn | Chat history |
| routes.ts:2117/2122/2126 | `generated.slice(0, requestedCaseCount)` | **Post-generation** enforcement of exact case count — if the model over-generates, extras are silently dropped here, not re-prompted |
| routes.ts:3332 | `.slice(0, maxChars)` (6000) + explicit `... (outline truncated)` marker | Page outline — the one self-documenting truncation |
| routes.ts:3350 | `.slice(0, 120)` | Verified elements |
| routes.ts:3357-3358, 3368 | `.slice(0, 12)` options / `.slice(0, 60)` label | Verified-selectors render |
| routes.ts:3398 | `.slice(0, 80)` | On-page text snippets |
| mcpDomFacts.ts:98 | `.slice(0, 12_000)` | Raw accessibility snapshot truncation |
| mcpDomFacts.ts:74-79 | greedy regex `/\{[\s\S]*\}/` + `JSON.parse` | **Not a size truncation — a correctness bug**: can silently produce wrong/failed parse on multi-block MCP responses (see incident report Finding C) |
| mcpInspector.ts | multiple `.slice()` (headings 40, tables 12, forms 12, bodyText 1500/1500, knowledge 4000, testData 3000, assertions 20, summaries 1200/2000) | Inspector task-prompt assembly |
| liveAuthor.ts | numerous `.slice(0, 8)` (uuid fragments), `.slice(0, 50/12/18/70/80)` | Script recording labels/ids |

**Message-array pruning:** none found in `runToolLoop`. The array is monotonic — grows every step, never trimmed, capped only indirectly by `maxSteps` (default 12) and `maxTotalTokens` (optional, provider-enforced budget stop, not a truncation of existing content).

---

## PART 7 — DOM flow transformations, stage by stage

```
ApplicationInspector (inspectionService.ts:317 inspectApplicationFlow)
  → tries MCP path (mcpInspector.ts) first if INSPECTOR_MCP flag set
  → falls back to classic Playwright navigation+login+capture on any MCP failure
  → returns {goalStatus, warnings, actionsTaken, observedPages, screenshots, currentUrl,
             pageSummary, visibleNavigation, visibleTables, visibleForms, assertionTargets}
        ↓ stored as run.inspection_context / run.inspection_contexts[]
        ↓ compacted via compactInspectionContext() before every prompt injection (caps pageSummary
          to 800 chars per second agent's citation of routes.ts:3319, and other fields to 20-40 items)

DOMExplorer (domExplorer.ts:562 exploreAndVerifyPage)
  → exploreAppElements() extracts raw DOM elements, capped at maxElements (default 200,
     re-sorted by interactive+visible score before the cap, domExplorer.ts:~443)
  → resolveBestSelector() derives a candidate selector per element
  → verifyResolvedSelectors() checks each candidate against the live page: count===1→'verified',
     count>1→'not_unique', count===0→'broken', no selector derivable→'unresolvable'
  → returns VerifiedPage {url, outline, opened, elements[], coverage{...}, warnings}
        ↓ stored as run.dom_exploration
        ↓ ALSO written into the Blackboard (writeBlackboard(), pipelineDelta.ts:~205) keyed by
          exploreUrl, with `elements` = verifiedPage.opened mapped to labels, and `coverage` copied through verbatim

SelectorRegistry (selectorMap.ts:44 extractSelectorMap)
  → INDEPENDENT of the two live stages above — scans up to 4000 source files with 11 regexes
    (aria-label, data-testid, id, class, placeholder, getByRole, getByLabel, label-for, etc.)
  → dedupes into {ariaLabels, testIds, cssIds, cssClasses, placeholders, labels, fieldIds,
    roleNames, uiHooks, fileCount}
  → methodFor() resolves a target string to {by, value} using EXACT case-insensitive match only
        ↓ this static map feeds a SEPARATE "selector registry" object (routes.ts selector-registry
          phase) that gets its own `verified: true` flag set by that phase's own logic — NOT the
          same `verified` as DOMExplorer's live check. Both surface to the prompt under similar
          "verified" language (Part 2, renderSelectorRegistryForPrompt filters on `value?.verified`).

Blackboard (blackboard.ts, full file)
  writeBlackboard(): upsert by id, unshift, hard-cap db.blackboard.length = 100
  latestBlackboard(): reduce by createdAt — most recent entry, used by tracer.ts snapshots
  listBlackboard(): .slice(0, 50)

Context Builder (renderBlackboardForPrompt / renderSelectorRegistryForPrompt / renderPageOutlineForPrompt
  / renderVerifiedElementsForPrompt / renderOnPageTextForPrompt, all in routes.ts / pipelineDelta.ts)
  → each independently filters+caps+formats its own slice of {dom_exploration, selector_registry,
     blackboard_id-referenced entry} into a text block

PlaywrightCoder prompt (routes.ts:2497+)
  → receives BOTH the live-derived blocks (blackboard, verified elements, page outline) AND the
     fully independent static-scan block (coderSelectorMap = renderSelectorMap(codeMap)) with no
     field distinguishing their provenance.
```

---

## PART 8 — Worker prompt shapes

All three workers (`caseWriter`, `playwrightCoder`/`coder`, `featureAnalyst`) receive context the same structural way: **a single flat prompt string** built by JS template-literal interpolation, not objects/JSON payloads passed as structured fields. The only structured (non-string) part of any call is:
- `schema` (a JSON Schema object, e.g. `testCasesSchema`, `playwrightScriptsSchema`) — passed separately from `prompt` to `generateObject()`, so the model is constrained on output shape, not input shape.
- Individual context fragments that themselves used to be objects (inspection context, DOM elements) are `JSON.stringify()`-ed inline into the string (e.g. `JSON.stringify(compactInspectionContext(inspectionContext))` appears verbatim in both the caseWriter and coder prompts) — i.e., the worker receives raw JSON-as-text embedded in an otherwise natural-language prompt, mixed with markdown-ish section headers (`VERIFIED SELECTOR REGISTRY (STRICT AGENT HANDOFF):`, `PAGE OUTLINE:`, etc.) and plain instructional prose.

So the answer to "objects, strings, JSON, markdown, plain text, or templates" is: **all of the above, concatenated into one string** — a JSON blob sits mid-paragraph next to markdown-style ALL-CAPS section labels and plain instructional sentences, with no consistent delimiter or format boundary between them beyond `\n` and ad hoc `LABEL:` prefixes.

---

## PART 9 — Orchestrator internals

### `generateObject` — orchestrator.ts:193-263 (full body already quoted in Part 1/3 context)
Sends: `{system, prompt, schema, temperature, maxTokens, effort}` to `this.provider.generateObject()`. On a schema/JSON parse failure, retries ONCE with an amended system prompt appending a strict-JSON reminder (`orchestrator.ts:226`) — this is the only place a call is retried with modified content; the retry is not logged as a separate step anywhere visible to the case-generation caller.

### `generateText` — orchestrator.ts:265-325
Same shape, no retry-on-bad-output logic (that's `generateObject`-specific), no tool support.

### `runToolLoop` — orchestrator.ts:375-568
Full loop shown in the prior agent's report. Key facts:
- Injects tool results back as `{role: 'tool', toolCallId, toolName, content: safeJson(result)}` — content capped at 8000 chars (Part 6).
- History is **never removed** before a provider call — the full `messages[]` accumulated so far is sent every iteration.
- What gets removed before the provider call: **nothing from `messages[]` itself.** The only removal/reduction anywhere in this loop is the 8000-char cap applied to each tool result at the moment it's formatted, before it's ever added to `messages[]`.

### `assembleSystem` — see Part 2.

---

## PART 10 — Ranked findings (exposure only, no fixes prescribed here — see incident report for those)

1. **`mcpDomFacts.ts:74-79` (`evaluateJson`)** — greedy regex JSON extraction across a joined multi-block MCP response; this is the exact line that threw in the traced run.
2. **`routes.ts:1542` / `routes.ts:1565`** — hard `.slice()` cuts on `summarizeUnderstanding`/`summarizeFeatureInventory` with **no truncation marker**, unlike the page-outline renderer which does mark it (`routes.ts:3332`). A silent mid-sentence cut here is indistinguishable from complete data to the model.
3. **`pipelineDelta.ts:461` / `renderSelectorRegistryForPrompt`'s `value?.verified` filter** — conflates live-DOM-verified and static-source-"verified" selectors under one boolean, the mechanism identified in the incident report as enabling downstream hallucination.
4. **`selectorMap.ts` static scan feeding `coderSelectorMap`** — injected into the coder prompt with zero provenance tag, sitting alongside genuinely live-verified blocks.
5. **`orchestrator.ts:597` `safeJson()` 8000-char cap** — silent, no marker, inside the one code path (`runToolLoop`) that is otherwise carefully instrumented (`logExecutionTrace` calls surround it) — the truncation itself is NOT captured in the trace's `informationTruncated` field (that field only reflects `res.stopReason === 'length'`, i.e. provider-side truncation, not this local cap).
6. **`routes.ts:2117/2122/2126` post-generation `.slice(0, requestedCaseCount)`** — if the model returns more cases than requested, the excess is silently dropped after the fact rather than the prompt being tightened or the model re-asked; whichever cases happen to be first survive, with no visible ranking-aware selection at this exact cut point (ranking is asked for in the prompt, but this final slice trusts the model's own ordering).
7. **`generateObject`'s single retry-on-bad-JSON (`orchestrator.ts:224-227`)** — retries with a mutated system prompt but this second attempt's content is not distinguished from a first-attempt success anywhere in `run` state or the trace log visible to routes.ts.
8. **`mcpInspector.ts` task-prompt slices** (knowledge 4000, testData 3000, bodyText 1500) — same silent-cut pattern, compounding across an already-narrow MCP fallback path.
9. **`compactInspectionContext()`** (referenced but not fully quoted in this pass — routes.ts ~3300s) — caps `pageSummary` to 800 chars before it's `JSON.stringify`-ed into BOTH the caseWriter and coder prompts; a double compression (object-level cap, then stringify) with no marker either.
10. **Blackboard's `db.blackboard.length = 100` hard cap (`blackboard.ts:29`)** — a global (not per-run) cap; a busy multi-run session can evict an earlier run's blackboard entry before a later phase of the SAME run reads it back via `latestBlackboard()`, which has no run-id filter and just returns the most-recently-created entry across ALL runs.

---

## PART 11 — Final provider request assembly

### OpenAI — server/ai/providers/openai.ts
`generateObject` (≈114-124):
```typescript
const completion = await this.client.chat.completions.create(
  {
    model: modelId,
    messages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.prompt },
    ],
    ...this.sampling(modelId, opts.maxTokens, opts.temperature),
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  },
  { signal: opts.signal },
);
```
`chatWithTools`-style call (≈154-163) adds `tools`/`tool_choice: 'auto'` when tools are present. `sampling()` switches `max_completion_tokens` vs `temperature` based on a model-name regex (`/^(gpt-5|o1|o3|o4)/`).

### Anthropic — server/ai/providers/anthropic.ts:144-160
```typescript
const params: Anthropic.MessageCreateParamsNonStreaming = { model: modelId, max_tokens: resolveRequiredMaxTokens(modelId, opts.maxTokens), messages };
if (opts.system) params.system = opts.system;
if (opts.tools?.length) params.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
if (acceptsTemperature(modelId)) params.temperature = opts.temperature ?? 0.2;
const message = await this.client.messages.create(params, { signal: opts.signal });
```
Anthropic requires `max_tokens` — `resolveRequiredMaxTokens()` substitutes a model-specific default if the caller didn't pass one.

### Gemini — server/ai/providers/gemini.ts:81-101
```typescript
const config: Record<string, any> = {};
if (opts.system) config.systemInstruction = opts.system;
if (typeof opts.temperature === 'number') config.temperature = opts.temperature;
if (opts.maxTokens) config.maxOutputTokens = opts.maxTokens;
if (opts.tools?.length) config.tools = [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
const resp = await ai.models.generateContent({ model: modelId, contents, config });
```

**None of the three provider files compute or log a pre-flight token count or context-window-usage percentage anywhere in this call path.** Token counts (`inputTokens`/`outputTokens`) are only known AFTER the call returns, from `result.usage` (provider-reported), and are recorded via `recordUsage()` purely for cost tracking — not fed back into any pre-send budget check. "Was anything removed/summarized/truncated before sending" is answered by everything cited in Parts 2, 3, 4, 6 — but that answer lives entirely upstream in routes.ts/pipelineDelta.ts string-building, not in the provider files themselves, which just forward whatever string they're handed.

---

## PART 12 — Before/after shape (representative example: `summarizeUnderstanding`)

**Input object** (`u`, the `feature_understanding` record):
```
{ title, description, businessRules[], adminBehavior, keystoneBehavior, dataPopulationNotes,
  sharedComponents[] (each: name, reusedBy[], controlsOrBehaviors[], metadataOrPermissionGates[], testFocus[]),
  metadataRefs[], uiSelectors{ariaLabels[], labels[], roleNames[], testIds[], cssIds[], cssClasses[],
  placeholders[], fieldIds[]}, sourceFiles[], candidateScenarios[] }
```
**Output**: a single string, `\n`-joined lines, hard-cut at 4000 chars (`routes.ts:1542`).

- **Removed fields**: none dropped outright — every present field maps to a line — but arrays are pre-truncated at the field level before stringification (`sharedComponents` → 12, each sub-array inside a component → 8-12, `uiSelectors.*` → 30 each, `sourceFiles` → 10).
- **Added fields**: none — purely a projection/format of the input.
- **Summarized fields**: `sharedComponents` entries are reduced to a pipe-joined single line per component (`name | reused by ... | behaviors: ... | gates: ... | test focus: ...`), losing the original nested-array structure.
- **Truncated fields**: the whole output string, at the end, silently at 4000 chars — this is a truncation of the JOINED text, so if a long `businessRules` array pushes the string past 4000 chars, everything after that point (potentially `uiSelectors`, `sourceFiles`, `candidateScenarios` — placed later in the line order) is cut, not just the offending field.
- **Compressed fields**: none via algorithmic compression — only array-length caps and line-flattening.
- **Token count before/after**: not computed anywhere in this function or its caller — no token counting library is invoked in this call path; only character counts (`.length`, `.slice`) are used as the proxy for budget.

This same before/after shape (project → pre-cap arrays → join → hard-slice whole string, no token count, no per-function marker except the page-outline renderer) is the pattern repeated by every other context builder in Part 2.

---

## PART 13 — Tool output trace (MCPDOMFacts, the one hard failure observed in the live run)

```
Raw Output:
  MCP browser_evaluate tool response → { content: [ {type:'text', text: '<JS eval result +
  possibly other blocks>'} ] }               (mcpDomFacts.ts: session.client.callTool(...))
        ↓
  textFromMcp(res) joins all content[].text blocks with '\n' into one raw string
        (mcpDomFacts.ts:67-72)
        ↓
Stored Output:
  raw.match(/\{[\s\S]*\}/) greedily selects from the FIRST '{' to the LAST '}' in the
  ENTIRE joined string (mcpDomFacts.ts:77)
        ↓
  JSON.parse(match[0])  →  THROWS in the traced run: "Unexpected non-whitespace character
  after JSON at position 7215 (line 256 column 1)"                 (mcpDomFacts.ts:78)
        ↓
Injected Output:
  exception propagates up through collectMcpDomFacts() → caught in pipelineDelta.ts:244-246
  → run.mcp_dom_facts is NEVER SET (stays undefined)
  → phase logged as status:'skipped' with a message string only (not structured data)
        ↓
LLM Received Output:
  renderMcpDomFactsForPrompt(undefined) returns '' (mcpDomFacts.ts:214, `if (!facts?.source) return '';`)
  → the coder's prompt simply has one fewer paragraph; NOTHING tells the LLM "MCP DOM facts
    were attempted and failed" vs "this run never uses MCP DOM facts by design"
```

This is the single clearest "raw → stored → injected → received" chain in the whole pipeline where a transformation step (the greedy regex) is also the point of total, silent data loss — everything the live MCP browser snapshot actually observed about the page (actionables, assertions, tables) never reaches any LLM call in this run, and nothing downstream is aware the gap exists.
