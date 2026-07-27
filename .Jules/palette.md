# Palette's Journal — Critical UX/a11y Learnings Only

## 2026-03-31 - Test Plan Accessibility and Interactive Element Focus
**Learning:** Found that interactive element controls (like run buttons, checkboxes, and status selectors) in the table list view did not have clear ARIA labels or visible keyboard focus states (`focus-visible`). Adding `focus-visible` styles ensures keyboard-only users can navigate cleanly, and dynamic tooltips/aria-labels on disabled controls provide clear screen-reader and visual context.
**Action:** Always add `focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none` and descriptive dynamic `title`/`aria-label` attributes to table-row actions, especially when those actions can be conditionally disabled.
