# Palette Journal

## 2026-07-26 - Init Journal
**Learning:** Initialized Palette's journal for documenting critical UX and accessibility learnings.
**Action:** Always maintain and follow Palette's principles in this repository.

## 2026-07-26 - Dropdown Menu ARIA & Keyboard Navigation Roles
**Learning:** Standard popover dropdown buttons (like Export) require explicit ARIA properties (`aria-expanded`, `aria-haspopup`, `aria-label`) and explicit keyboard focus styles (`focus-visible`) to be fully screen-reader and keyboard accessible.
**Action:** Add proper `role="menu"`, `role="menuitem"`, and correct aria attributes on all future inline dropdown menu actions.
