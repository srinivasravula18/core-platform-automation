# Palette's Journal

## 2026-03-05 - Accessible Custom Popover Menus
**Learning:** Custom trigger-based popovers (such as `RowMoreMenu`) are common sources of screen-reader and keyboard-navigation failures. They often lack visual focus rings, proper ARIA tags (`aria-expanded`, `aria-haspopup`, `aria-label`), roles (`menu`, `menuitem`), and an Escape key handler for intuitive keyboard dismissal. Adding these makes them compliant with modern a11y expectations and significantly improves the developer & user experience.
**Action:** When creating or modifying popovers, select triggers and dropdowns carefully: bind keydown handlers for Escape, manage focus gracefully back to the trigger on close, and use standard ARIA attributes (`aria-expanded`, `aria-haspopup`) along with proper Tailwind focus-visible states.
