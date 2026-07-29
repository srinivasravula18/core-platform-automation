# Palette's Journal - Critical UX & Accessibility Insights

## 2026-07-10 - Keyboard Navigation and ARIA Missing in Custom Dropdowns
**Learning:** Custom popovers and trigger buttons (like `RowMoreMenu`) in this design system are often created using custom React state without registering global escape key event listeners or binding standard screen reader attributes. This makes them difficult to navigate for keyboard-only and screen-reader users, violating essential accessibility guidelines.
**Action:** When creating or refining interactive custom components, always bind `aria-expanded` & `aria-haspopup`, implement focus rings with `focus-visible`, and register a `useEffect` listener to dismiss the interactive panel on `Escape`.
