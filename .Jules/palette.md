# Palette's UX Journal

## 2026-08-07 - Accessible Custom Trigger Popovers and Seamless Escape Dismissal
**Learning:** Custom trigger-based popover menus (like `RowMoreMenu`) built without robust component libraries lack basic keyboard/screen-reader compliance by default. For full accessibility and a delightful user experience, they must bind `aria-expanded`, `aria-haspopup`, and an informative `aria-label`, configure distinct `focus-visible` focus outlines to make them fully keyboard navigatable, and register a global `Escape` key event listener when opened so users can dismiss them effortlessly without reaching for their mouse.
**Action:** Always wrap trigger elements with global key listeners, bind proper visual focus rings using Tailwind's `focus-visible`, and assign standard screen reader fields (`aria-expanded`, `aria-haspopup`, `aria-label`).
