# Palette's Journal - Critical UX/Accessibility Learnings

## 2026-07-10 - Initial Setup
**Learning:** UX and accessibility should always be verified in a concrete, testable way, maintaining small under 50-line commits when possible. Focus styles (`focus-visible`) and proper form labels are essential for standard accessibility compliant workflows.
**Action:** When creating or modifying icons or interactive trigger elements, always include screen reader-friendly labels and support seamless escape/dismiss patterns.

## 2026-07-30 - Dropdown Menus and Trigger Buttons
**Learning:** Interactive popover menus like `RowMoreMenu` require visual cues and state-tracking elements to conform to WCAG and screen reader standards. They need escape key listener for fast dismissal, proper ARIA states (aria-expanded, aria-haspopup, aria-label) to communicate their dynamic toggle states, and tailored focus rings to aid keyboard navigators.
**Action:** Always configure custom dropdown buttons with standard keyboard event listeners, hook up the matching focus styles, and export appropriate role annotations.
