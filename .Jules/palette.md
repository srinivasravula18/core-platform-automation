## 2026-07-11 - Custom Popovers and Dropdowns Accessibility Patterns
**Learning:** Custom overlay, trigger-based, and popover components (like `RowMoreMenu`) lack native HTML focus/dismiss features. When building/refactoring these elements, they must explicitly support keyboard and screen-reader interactions to remain accessible.
**Action:** Always:
1. Register a global `keydown` event listener for `Escape` when open to support keyboard dismissal.
2. Ensure triggers have proper ARIA attributes (`aria-expanded`, `aria-haspopup="true"`, `aria-label` or descriptive accessible name).
3. Set appropriate list/menu roles (`role="menu"`, `role="menuitem"`) on popover containers and children.
4. Add Tailwind `focus-visible:ring-2` focus rings for keyboard-only focus states to avoid visible rings on click while preserving keyboard accessibility.
