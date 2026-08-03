# Palette's Journal - Critical UX/A11y Learnings

## 2026-03-31 - Trigger-based Popover Key Dismissal & ARIA Bindings

**Learning:** Custom dropdown triggers and popover menus (like `RowMoreMenu`) that manage their own visibility state via React state must explicitly handle keyboard-centric interactions. Specifically, they must register a global 'keydown' Escape listener, toggle assistive visibility fields (`aria-expanded`, `aria-haspopup`), and feature focus states (`focus-visible`) for keyboard navigability to ensure parity with mouse-driven hover/click events.
**Action:** Always wrap custom dropdown/modal components with an Escape dismiss listener and bind necessary accessibility labels/roles from day one.
