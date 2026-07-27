**Comparison target**

- Source visual truth: `C:\Users\bdevi\AppData\Local\Temp\codex-clipboard-lcVOXQ.png`
- Implementation screenshot: `D:\core-platform-automation\docs\diagnostics\schedule-repository-picker-2026-07-22.jpg`
- Viewport: 1535 × 782 CSS px, desktop Chrome, device scale factor 1
- Pixels: source 812 × 797; implementation 1535 × 782. The source modal and implementation modal were compared at their native desktop density; no resampling was used.
- State: dark-theme New schedule modal. Source shows the old flat recording list; implementation shows the requested repository hierarchy, global search results, and one selected script.

**Full-view comparison evidence**

- The modal retains the source typography, dark palette, border treatment, date-time control, fixed action footer, and clear disabled Create Schedule state.
- The obsolete Recordings/Test Cases/Suites tabs and flat scrolling list are replaced by a two-pane repository browser. Folder context remains visible while scripts scroll independently.
- The wider modal is intentional and necessary for the new folder/script hierarchy; it remains centered with ample viewport clearance and no clipped controls.

**Focused region comparison evidence**

- The repository picker region was checked at readable size: folder selection, direct script counts, search, script filename, checkbox state, and selected count are all visible without a separate crop.
- Fonts/typography: existing application font, weights, truncation, and hierarchy are preserved.
- Spacing/layout: the two-pane grid aligns with the source form and footer rhythm; both panes have independent bounded scrolling.
- Colors/tokens: existing CSS variables and accent color are reused; selected folder, icons, focus, and checkbox states remain consistent with the app.
- Image/asset quality: no raster product assets were required; existing Lucide vector icons are used consistently.
- Copy/content: scheduling copy now names repository scripts and removes the obsolete Test Case/Suite recording explanation.

**Findings**

- No actionable P0/P1/P2 findings remain.
- P3: duplicate repository folder and script names remain visually identical because that is the underlying repository data, not presentation drift.

**Comparison history**

1. P2: the initially selected uncategorized script was shown while its folder row was below the fold, making the visible context ambiguous. Folder IDs also arrived with mixed numeric/string types, which could make selection highlighting and direct counts disagree.
2. Fix: normalized folder/script IDs at the fetch boundary and moved the populated Uncategorized node to the top.
3. Post-fix evidence: the revised screenshot shows Uncategorized selected with count 1 and its script visible. Search for `case-11` returns repository-wide results; selecting a result updates the selected count to 1.

**Implementation checklist**

- [x] Repository folder navigation replaces source tabs.
- [x] Global script search works across folders.
- [x] Multi-script selection and disabled action states work.
- [x] Browser console checked: 0 errors.
- [x] Backend scheduling bridge covered by the focused automation test.

**Primary interactions tested**

- Opened New Schedule after a full reload.
- Navigated between repository folders.
- Searched globally for `case-11`.
- Selected a script and verified the selected count.
- Left Create Schedule disabled without a date and did not submit the final QA state.

final result: passed

---

## Test Plans filter popover responsiveness — 2026-07-27

**Comparison target**

- Source visual truth: `C:\Users\bdevi\AppData\Local\Temp\codex-clipboard-IC74V4.png`
- Implementation screenshot: `D:\core-platform-automation\docs\diagnostics\test-plans-filter-responsive-768.png`
- Side-by-side comparison: `D:\core-platform-automation\docs\diagnostics\test-plans-filter-responsive-comparison.png`
- Source pixels: 1600 × 745. Implementation pixels/CSS viewport: 768 × 720 at device scale factor 1. The comparison preserves both native captures because this check targets viewport containment rather than pixel-identical content.
- State: dark-theme Test Plans list with the Filters popover expanded.

**Full-view comparison evidence**

- The source popover is left-aligned to a right-edge trigger and extends beyond the visible screen.
- The implementation right-aligns the same popover to its trigger, preserves the existing visual language, and keeps the entire panel within the 768 × 720 viewport.
- Final measured bounds: left 273.8, right 657.8, top 271.2, bottom 671.2 within a 768 × 720 viewport.

**Focused region comparison evidence**

- The filter panel itself is readable in both captures, so a separate crop was unnecessary.
- Fonts/typography: existing family, weights, labels, and hierarchy are unchanged.
- Spacing/layout: panel width remains 24rem when space permits; viewport width and height caps add internal scrolling instead of clipping.
- Colors/tokens: existing background, border, accent, and muted-text tokens are unchanged.
- Image/asset quality: no image assets were introduced or changed.
- Copy/content: filter labels and actions are unchanged.

**Findings and comparison history**

1. P1: the source filter panel extends outside the viewport, hiding lower controls on smaller screens.
2. Fix: right-aligned the panel to the Filters trigger and capped its width to the viewport.
3. P2: the first fix still allowed the panel bottom to reach 863px in a 720px viewport.
4. Fix: capped panel height to the available below-toolbar region and retained internal scrolling.
5. Post-fix evidence: the panel is fully contained at both 1024 × 720 and 768 × 720, with no console errors.

**Primary interactions tested**

- Opened Test Plans and expanded Filters.
- Verified the open panel at 1024 × 720 and 768 × 720.
- Confirmed the panel remains scrollable and all viewport bounds are contained.
- Browser console checked: 0 errors.

**Implementation checklist**

- [x] Right-edge collision prevented.
- [x] Narrow viewport width constrained.
- [x] Short viewport height constrained with internal scrolling.
- [x] Existing filter controls and styling preserved.

final result: passed

---

## AI rework corner-radius polish — 2026-07-24

**Comparison target**

- Source visual truth: `D:\core-platform-automation\docs\design-qa\ai-rework-radius-source.png`
- Implementation screenshot: `D:\core-platform-automation\docs\design-qa\ai-rework-radius-implementation.png`
- Side-by-side comparison: `D:\core-platform-automation\docs\design-qa\ai-rework-radius-comparison.png`
- Viewport and pixels: 1513 × 543 CSS px at device scale factor 1; both captures are 1513 × 543 px.
- State: one selected test case, suite rework active, and the Agent Console scoped to that selected case.

**Evidence**

- The three highlighted controls now use a 6px radius: the selected-case scope, selected-case chip, and Agent Console rework-context chip.
- Full-view comparison confirms the controls remain aligned, readable, and visually associated with the existing rework flow.
- Focused inspection confirms the previous capsule treatment is removed without changing typography, spacing, colors, icons, copy, or interaction state.
- No image assets were added or changed.

**Findings**

- No actionable P0/P1/P2 findings remain.
- Browser console checked with zero errors or warnings.

final result: passed

---

## Test run evidence export — 2026-07-24

**Comparison target**

- Source visual truth: `C:\Users\bdevi\AppData\Local\Temp\codex-clipboard-FPSm36.png`
- Local preview: `http://localhost:3000/runs`
- State requested: run detail with execution-evidence thumbnails and export controls.

**Verification**

- The local application loaded and authenticated successfully in desktop Chrome.
- The Test Runs page rendered without layout or navigation errors.
- The local sandbox contains zero test runs, so the requested run-detail evidence state could not be opened or compared without adding fabricated test data.
- No production or user test data was changed for visual QA.
- Static validation completed through TypeScript compilation, the production build, lint, and the focused run-evidence export check.

final result: blocked — no test run with execution evidence exists in the local sandbox

---

## AI rework workflow — 2026-07-24

**Comparison target**

- Source visual truth: `D:\core-platform-automation\docs\design-qa\ai-rework-source.png`
- Implementation screenshot: `D:\core-platform-automation\docs\design-qa\ai-rework-implementation-final.png`
- Side-by-side comparison: `D:\core-platform-automation\docs\design-qa\ai-rework-comparison.png`
- Viewport: 1587 × 870 CSS px, desktop Chrome, device scale factor 1
- State: completed Functional Validation run with one generated case. The inline suite rework control is active and the Agent Console is scoped to all cases.

**Full-view comparison evidence**

- The implementation retains the source dark palette, typography, borders, tab hierarchy, case-row density, and existing Lucide icon language.
- Rework is now a contextual workflow instead of an always-on ambiguous text field: scope, request, and Preview action are visible together in one compact row.
- Activating rework scrolls the control into view and exposes the same scope in the persistent Agent Console, without taking over ordinary chat.

**Focused region comparison evidence**

- Typography: existing Inter weights and muted/accent hierarchy are preserved.
- Spacing/layout: the compact desktop row keeps the Preview action above the fixed composer; narrow layouts stack responsively.
- Colors/tokens: existing application tokens are reused for borders, focus, selected scope, success, and destructive actions.
- Images/assets: no new raster assets were required; existing icon components are reused.
- Copy/content: scope is explicit (`all cases`, selected cases, or one named case), and the action says `Preview changes` before any draft is mutated.

**Findings and comparison history**

1. P2: the first implementation made the rework surface taller, leaving its primary action clipped behind the fixed Agent Console.
2. Fix: compacted the desktop composer into a single row and scrolled the activated rework surface to the viewport center.
3. Final comparison: the request, scope, Preview action, case-level entry point, and bottom context pill are all visible together. No actionable P0/P1/P2 findings remain.

**Primary interactions tested**

- Activated suite rework from the inline request field.
- Verified the bottom Agent Console changed to the exact active scope and `Preview changes`.
- Cleared rework context and verified ordinary chat/Send behavior returned.
- Verified the final state at the source viewport with no browser console errors or warnings.
- Did not invoke a live AI model during visual QA; proposal application, partial selection, undo prerequisites, and stale-draft blocking are covered by `scripts/test-ai-rework-proposal.ts`.

final result: passed

---

## Automation data preview containment — 2026-07-27

**Comparison target**

- Source visual truth: `C:\Users\bdevi\AppData\Local\Temp\codex-clipboard-9X2sCc.png`
- Local preview evidence: `D:\core-platform-automation\docs\diagnostics\data-preview-qa-no-dataset.png`
- Source pixels: 1848 × 550.
- Local viewport and pixels: 1400 × 800 CSS px at device scale factor 1; capture is 1400 × 800 px.
- Requested state: an imported dataset with the first 50 rows visible.

**Verification**

- The preview now has an accessible Close action and a non-destructive Show data preview action.
- Table scrolling is contained inside a bounded panel with a sticky header.
- Ordinary columns retain stable minimum widths; Step Detail receives a readable 28rem minimum width and preserves line breaks.
- TypeScript compilation, production frontend/backend builds, and `git diff --check` pass.
- Browser console checked: 0 errors.
- The local project/app scope contains no imported datasets, so the populated preview, Close/reopen interaction, and same-state visual comparison could not be exercised without adding persistent QA data.

final result: blocked — no imported dataset exists in the local project/app scope
