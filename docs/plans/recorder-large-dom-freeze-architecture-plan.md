# Recorder Freeze on Large/Complex DOM — Root Cause and Optimal Solution

Date: 2026-08-05
Status: **Phase 0 — analysis only. No runtime code changed by this document.**
Scope: local desktop-agent recording (`agent/src/recorder.ts`, `agent/src/codegen.ts`) and the injected Playwright recorder it enables.

Companion: [codegen-freeze-and-polling-performance-audit-2026-08-04.md](../diagnostics/codegen-freeze-and-polling-performance-audit-2026-08-04.md) (process/memory evidence, polling findings, plaintext-secret finding).

---

## 1. Verdict

The freeze is an **upstream Playwright defect that will not be fixed**, confirmed from the GitHub API rather than a rendered page:

| Field | Value |
|---|---|
| Issue | [`microsoft/playwright#22041`](https://github.com/microsoft/playwright/issues/22041) |
| State | **closed**, `state_reason: not_planned` |
| Opened → closed | 2023-03-28 → **2026-05-07** (3 years open, 14 comments) |
| Candidate fix | [`PR #22468`](https://github.com/microsoft/playwright/pull/22468) by maintainer `mxschmitt` — **`merged: false`, closed unmerged** |
| Reports | 2023, 2024 (×3), 2025 — including AG-Grid specifically |

Our own code is not implicated: the affected 4-minute session produced a 719-byte script; the agent sat at ~112 MB and <2 CPU-seconds while the inspected renderer reached ~900 MB and **216.7 CPU-seconds**, single-thread bound (one child at ~118% CPU with the machine at 10–23%).

## 2. Mechanism (from installed `playwright-core@1.61.1`)

**Trigger** — `RecordActionTool.onMouseMove` → `_updateModelForHoveredElement` calls `generateSelector` **synchronously on every change of hovered element**. No debounce, no rAF, no time budget; the only guard is element identity.

**Cost** — `generateSelectorFor` builds 10–30 candidates per element, runs `injectedScript.querySelectorAll(candidate, document)` **per candidate over the whole document**, and the only early exit is `elements.length === 1 → break`. `internal:role` / `internal:text` / `internal:label` are not CSS — they walk the document computing accessible names. When nothing is unique it **recurses up every ancestor**, each with its own full sweep.

**Per action** — `performAction` calls `generateAriaTree(documentElement)` **twice** per click.

**Caches don't survive** — `generateSelector` does `beginAriaCaches()/beginDOMCaches()` … `finally { endDOMCaches(); endAriaCaches(); }` inside a single call. Every hover pays a cold cache.

## 3. Why upstream gave up — and why it decides our design

`mxschmitt` (maintainer), 2023-04-14, independently found the same thing:

> *"a) that we **clear most of our good caches after each `generateSelector` call**; b) that we in two places not put DOM Elements into our `_cached` function… This gives us always negative cache hits."* — with a gist showing *"significantly better"* performance.

`dgozman` (maintainer), 2023-05-04 — the decisive constraint:

> *"There doesn't seem to be an easy fix in `selectorGenerator` that will work for **dynamic pages changing over time**. Currently, we cache as much as we can during synchronous execution, which is safe, but **have to reset caches before next generation**. Leaving the issue open, just in case we'd like to do some **major reworks** in this area."*

**Read that carefully: the per-call cache reset is a correctness requirement on dynamic pages, not an oversight.** Caching cannot fix this, which is why the caching PR died. The only remaining lever is **call frequency**. That is not a preference — it is the one axis upstream left open.

## 4. Correction to the cost model

`weeix`, 2023-07-06:

> *"It has more factors than element count, doesn't it? I found this site with **only ~1,000 elements**, yet it is **slower** than the example with 15,000 elements… It froze Codegen on my old computer."*

Cost is **candidates × ancestor depth × document size**, and the dominant term is usually **ambiguity** — how many elements share the same text/role, which is what defeats the `length === 1` early exit and forces the ancestor recursion. A deeply nested, highly repetitive 1k-element page beats a flat 15k one. Any benchmark that varies only node count measures the wrong axis.

## 4A. Phase 0 results — measured, 2026-08-05

`scripts/bench-recorder-dom.ts`. Chromium headless, 120-point pointer sweep, long-task total blocking time (sum of `duration - 50ms`). Baseline = same sweep with no recorder.

| Fixture (nodes-ambiguity-depth) | Baseline | Recorder blocking | Max task | Per hover | Sweep wall |
|---|---|---|---|---|---|
| 1000-unique-d1 | 0 ms | 3 ms | 53 ms | 0.0 ms | 2.0 s → 2.6 s |
| 1000-repeated-d6 | 0 ms | 56 ms | 70 ms | 0.5 ms | 2.0 s → 3.2 s |
| 15000-unique-d1 | 0 ms | 6,343 ms | 356 ms | **52.9 ms** | 2.0 s → 12.5 s |
| 15000-unique-d6 | 0 ms | 12,228 ms | 215 ms | **101.9 ms** | 2.0 s → 18.4 s |
| 15000-repeated-d6 | 0 ms | 31,253 ms | 849 ms | **260.4 ms** | 2.0 s → 38.1 s |
| 15000-repeated-d1 | 0 ms | **46,848 ms** | **803 ms** | **390.4 ms** | 2.0 s → **53.8 s** |

**Findings.**

1. **The recorder is 100 % of the cost.** Baseline blocking is 0 ms in every fixture. Nothing about the page itself blocks; the injected recorder is the entire freeze.
2. **Ambiguity dominates, as §4 predicted.** At an identical 15,000 nodes and identical depth, changing cell text from distinct to identical takes blocking from 6,343 ms to 46,848 ms — **7.4× worse with no change in page size**. This confirms `weeix`'s 2023 report and proves a node-count-only benchmark measures the wrong axis.
3. **Nesting compounds it.** 15k unique: depth 1 → 6,343 ms, depth 6 → 12,228 ms (~2×).
4. **The freeze is real and severe.** 390 ms of main-thread blocking per hover with single tasks up to 849 ms. A 2-second sweep becomes 54 seconds — **27× slower**. At that rate the overlay cannot track the cursor, which is exactly the reported "I can't see the element I'm hovering".

**Caveats.** Fixtures hold total node count constant, so deeper nesting yields fewer cells — that is why `repeated-d6` scores lower than `repeated-d1` (fewer ambiguous peers), an artifact of the shared node budget rather than depth helping. Headless Chromium on one machine; absolute values will differ elsewhere, ratios should not. 40k not yet run.

**Harness bug worth recording:** the first run reported all zeros. `PW_CODEGEN_NO_INSPECTOR` was set to suppress the Inspector window — but that flag early-returns `RecorderApp.show`, which is what pushes the recorder's UI state. Without it the recorder stays in `NoneTool` and does nothing. **That env var does not merely hide the Inspector; it disables recording.** The benchmark now asserts `document.body[data-pw-cursor]` is present before measuring, so it can never again report false zeros.

## 5. The optimal solution

**Principle: locator generation is an authoring-time operation, not a pointer-tracking operation.** Playwright conflates *"show what I'm pointing at"* (must run at pointer rate) with *"compute the durable locator"* (must run at action rate). Separating them is the entire fix.

Replace `_enableRecorder` with our own injected capture script (`context.addInitScript`, all frames):

**Layer 1 — Highlight, at pointer rate, O(1).**
On `mousemove`, read `event.target`, take `getBoundingClientRect()`, position an absolutely-positioned overlay, coalesced to one `requestAnimationFrame`. No selector generation, no document queries, no `MutationObserver` on `document.body`. Constant cost regardless of page size or ambiguity. Tooltip shows a cheap provisional descriptor read straight off the element — display-only, never entering the script.

**Layer 2 — Capture, at action rate, passive.**
`click`/`input`/`change`/`keydown` listeners in the capture phase but **non-consuming**: record and let the event propagate untouched. This is precisely what agent 1.0.3/1.0.4 got wrong — Playwright's tools call `consumeEvent()` and re-dispatch, which reordered pointer events and swallowed clicks. An observer that never intercepts cannot reorder anything.

**Layer 3 — Resolve, one call per action, at the moment of the action.**
Call Playwright's own `injectedScript.generateSelector(element, …)` — same algorithm, same locator quality — **immediately, while the element is live**. Not deferred to stop.

This placement follows directly from §3. `dgozman` says generation must run against the page *as it is at that moment*; resolving at click time satisfies that by construction — the element is attached, the page is in the state the action applies to, and cache staleness is structurally impossible. Deferring to stop would fight the same constraint upstream could not solve, and would reintroduce the detached-element risk (§7 K3).

~20 calls per session instead of thousands, each landing inside a click the application is already responding to, where 100–300 ms is invisible.

Never call `generateAriaTree(documentElement)`. If auto-expect assertions are wanted later, scope the snapshot to the acted-on subtree.

**Layer 3b — Scope-bounded generation (app-agnostic).**
`generateSelectorFor` honours `options.root` and scopes its queries to it. Walk up to the nearest structurally meaningful container (`[role=dialog]`, `form`, `[role=row]`, `table`, or "nearest ancestor under N descendants"), generate that container once, then generate the element with `root` set to it. Whole-document scans become subtree scans and the ancestor climb terminates at the container. Emit as a chained locator, which is also better test code:

```ts
page.getByRole('row', { name: 'Scheduled-Account-20260621-095001-430A' })
    .getByRole('cell', { name: 'Bronze' })
```

This attacks the ambiguity term identified in §4 without any cooperation from the application under test.

**Layer 3c — Hard budget.** Per-action time budget; on expiry fall back to a scoped CSS path. One uglier locator beats a hang.

### Rejected alternatives

| Option | Why not |
|---|---|
| Wait for upstream | Closed `not_planned`; fix PR unmerged; maintainers say it needs "major reworks" they declined |
| Patch `node_modules` recorder | Tried in agent 1.0.3/1.0.4 — broke pointer ordering, ate clicks, reverted in 1.0.5. Also unsafe under `^1.60.0` + internal `_enableRecorder` |
| Add caching ourselves | The maintainers' own conclusion: caches *must* reset for dynamic-page correctness |
| Require `data-testid` in the SUT | We record arbitrary customer apps; cannot mandate DOM changes. Take it opportunistically, never depend on it |
| Switch recorder product | No embeddable fast recorder exists — DevTools Recorder is a panel not a library; Testim/mabl are closed SaaS |
| Switch Playwright as executor | The executor is not implicated. Rewrites `runner.ts`, compiler, artifacts, every script — fixes nothing |

## 6. Guardrails

- Never patch `node_modules`. Layers 1–2 are ours; Layer 3 calls the injected script. If `generateSelector` disappears, fall back to a scoped CSS path — degraded, not broken.
- **Exact-pin** `playwright`/`playwright-core` (`agent/package.json` says `^1.60.0`, lock resolves 1.61.1).
- Ship behind an agent-config flag so one bundle runs either engine; rollback is a flag flip.

## 7. Risks — ranked

**K1. Chromium-only if CDP is used.** `Overlay.setInspectMode` also *swallows the click* (it is DevTools' picker), so it is unusable for recording; the workable CDP path needs a page-side `mousemove` → `DOM.getNodeForLocation` round trip that lags the cursor. **A page-side `getBoundingClientRect()` overlay is O(1), synchronous, simpler, and cross-browser.** Prefer it; CDP only buys immunity to the app's CSS/z-index and closed-shadow-root piercing. Firefox/WebKit have no CDP at all.

**K2. We inherit Playwright's long tail.** Shadow DOM retargeting (`composedPath`), same- and cross-origin iframes with `frameLocator` ownership, `select`, file inputs, checkbox-vs-click, modifiers, dialogs, popups, mid-flow navigation, assert-visibility/value/text tools. **We will regress things that work today.** Cross-origin iframes are the hardest.

**K3. Locator quality.** Mitigated — not eliminated — by resolving at action time rather than at stop. Requires the equivalence gate in §8.

**K4. Ambiguity is not removed, only relocated** if we ever skip verification: expect Playwright strict-mode `resolved to N elements` at run time.

**K5. Version coupling reduced, not escaped.** Layer 3 still calls an internal API.

**K6. May not be the user's bottleneck.** A slow SUT stays slow; we only stop being the bottleneck.

**K7. Opportunity cost.** The plaintext-password-in-spec finding in the companion audit is production-blocking and outranks this.

## 8. Testing and acceptance

Benchmark **two axes, not one** (per §4):

- node count: 1k / 5k / 15k / 40k
- ambiguity/nesting: unique-label vs fully-repetitive grid, shallow vs deeply nested

Measure per engine (plain Chromium / current `_enableRecorder` / new engine):

- p95 per-hover main-thread time across a 200-cell sweep — **target: flat across both axes**
- long tasks > 50 ms during the sweep — target: none
- renderer working set and CPU-seconds at idle / hover / click
- click → visible app reaction, p95 < 500 ms
- **equivalence gate:** for a fixed 10-action scenario the generated script must be locator-equivalent to `_enableRecorder` output — this is what proves no quality regression

## 9. Implementation order

| Phase | Content | Files | Risk |
|---|---|---|---|
| 0 | Two-axis benchmark + fixtures against the **current** engine; capture baseline | 2 new | Low |
| 1 | Exact-pin Playwright; thread test-id attribute through `codegenArguments` (opportunistic) | 2 | Low |
| 2 | New engine behind a flag, default OFF: Layer 1 + Layer 2 + Layer 3 at action time | 2–3 | High |
| 3 | Layer 3b scope-bounding + 3c budget; equivalence gate | 1–2 | Medium |
| 4 | Default flag ON after both gates pass; bump agent version | 2 | Medium |

Phase 0 is the falsifiable step and should be done before committing to Phase 2.

## 10. Limitations

- The per-hover scan-count model is derived from source plus one measured session, not a flamegraph — Phase 0 exists to replace it with measurement.
- Layer 2 may miss actions in apps that `stopPropagation` ahead of our capture-phase listener — a different failure mode from Playwright's consuming approach, and one to test against real targets.

## Sources

- [microsoft/playwright#22041](https://github.com/microsoft/playwright/issues/22041) — closed `not_planned` 2026-05-07; maintainer comments by `mxschmitt` (2023-04-14) and `dgozman` (2023-05-04); user report by `weeix` (2023-07-06); AG-Grid report by `dopitek` (2024-05-10)
- [microsoft/playwright#22468](https://github.com/microsoft/playwright/pull/22468) — caching fix, closed unmerged
- Installed source: `agent/node_modules/playwright-core@1.61.1`, `lib/coreBundle.js` (`packages/injected/src/recorder/recorder.ts`, `packages/injected/src/selectorGenerator.ts`)
