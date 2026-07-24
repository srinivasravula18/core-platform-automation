# Palette's Journal - UX & Accessibility Learnings

## 2026-07-24 - Async State Toggles & Switched Elements Accessibility
**Learning:** In list/table displays where users can toggle independent rows (e.g., schedule enablement), single-state variables can cause race conditions or bad UX. Using a reactive `Set` tracking individual row IDs (`togglingIds`) allows precise, per-item disabled states and prevents multi-click API race conditions. Furthermore, toggles/switches must use `role="switch"` with `aria-checked` and dynamic context-aware `aria-label` attributes to enable screen reader users to understand both the control type and which row it modifies.
**Action:** Always wrap list toggles with a set of active transaction IDs (`togglingIds`) and ensure toggle switch elements use accessibility-first standards (`role="switch"`, `aria-checked`, `aria-label` referencing row content, and `focus-visible:ring`).
