# Palette's UX & Accessibility Journal

## 2026-03-05 - Custom Popover & Menu Trigger Accessibility
**Learning:** Custom dropdown/popover menus (like `RowMoreMenu`) constructed using plain buttons/divs lack fundamental screen reader and keyboard affordances. Without global key listeners, they cannot be dismissed seamlessly via the Escape key, leaving keyboard users trapped or forced to click outside. Without `aria-expanded`, `aria-haspopup`, and visual focus rings, they are invisible and inaccessible to assistive technologies.
**Action:** Always bind `aria-expanded` and `aria-haspopup` to the trigger button, add clear keyboard focus rings using Tailwind `focus-visible`, and register a global keydown event listener to close the menu upon pressing the `Escape` key.
