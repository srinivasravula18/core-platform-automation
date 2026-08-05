## 2026-08-05 - Accessible Custom Popover Trigger Pattern
**Learning:** In Tailwind CSS based applications, custom interactive components like `RowMoreMenu` (3-dots list popovers) often bypass browser-native dropdown accessibility. To make them accessible and user-friendly for keyboard and screen reader users:
1. They must register a global `Escape` key event listener to close the dropdown seamlessly.
2. They must configure visual focus styles explicitly using `focus-visible:ring-2 focus-visible:ring-[var(--accent)]`.
3. They must bind screen reader state attributes: `aria-expanded` (matching React open state), `aria-haspopup="true"`, and `aria-label` (such as descriptive hover titles).

**Action:** Ensure all custom trigger-based dropdowns, popover menus, and modal dialogs follow these keyboard interaction and screen reader specifications.
