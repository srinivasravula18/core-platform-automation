import type { FeatureKnowledge } from './types';

/** Tabs. Admin authors tab definitions; Keystone end-users pick & personally reorder them. */
export const tabsKnowledge: FeatureKnowledge = {
  id: 'tabs',
  title: 'Tabs (Admin tab management + Keystone tabs picker)',
  apps: ['admin', 'keystone'],
  navigation:
    'Admin: /?nav=tabs&appId=<id> (requires an app scope; &id=<tabId> for detail). Keystone: the Tabs picker dropdown in the topbar (aria-label="Tabs").',
  matchTerms: ['tab', 'tabs', 'tab picker', 'create tab', 'reorder tabs', 'customize order', 'navigation tab'],
  uiLevel: `ADMIN (nav=tabs): heading "Tabs", subtitle "User-facing navigation tabs for objects or custom pages."; shared list view (activeObjectApiName="tab"), table only; "New" → "New Tab" modal. Detail sub-tabs "Details"/"Audit Log"; "Tab Details" with "Edit"/"Delete". A synthetic read-only "Flows" row exists (uses "Manage Flows" instead of Edit/Delete).
  CREATE modal "New Tab" (ids): #create-tab-app ("Target App *", All-Apps only), #create-tab-type ("Tab Type *": "Object Workspace"=object / "Custom Website Tab"=external_url / "Page"=dashboard), #create-tab-object ("Object *", object type only), #create-tab-label ("Label *"), #create-tab-api ("API Name *"), #create-tab-icon ("Icon (optional)"), #create-tab-target-url ("Website URL *", external_url only), #create-tab-target-mode ("Website Display": "Embed in tab"=embed / "Open from tab"=new_window). Footer "Cancel"/"Create".
  EDIT modal "Edit Tab": same fields with #edit-tab-* ids; #edit-tab-api is read-only (api_name immutable); no Target App. Footer "Cancel"/"Save".
KEYSTONE: Tabs picker button aria-label="Tabs" (aria-expanded); panel header "Tabs", footnote "Selection persists across sessions."; search input aria-label="Search tabs"/placeholder "Search tabs"; tab buttons select. "Customize order" button → reorder mode: "Reset"/"Cancel"/"Save" ("Saving..."), instruction "Drag tabs to reorder them. This order only affects your Keystone tabs dropdown.", arrow buttons aria-label "Move <label> up"/"Move <label> down", drag handle title="Drag to reorder". Empty "No tabs available".`,
  codeLevel: `Files: AdminTabsPanel.tsx, AdminCreateTabModal.tsx, AdminEditTabModal.tsx, main.tsx (submitCreateTab ~10265, submitEditTab ~11365); Keystone ShockwaveTopbar.tsx (picker ~640-1047), useShockwaveTabs.ts. API: POST/PUT/DELETE /admin/apps/:appId/tabs; Keystone PUT/DELETE /api/apps/:appId/tab-order.
Rules: tab_type ∈ object/external_url/dashboard. Object tabs need an object_id belonging to the target app; external_url tabs need target_url (target_display_mode persisted only for external_url). api_name auto-derived from label until edited, normalized, IMMUTABLE on edit. Admin Tabs nav requires an app scope; All-Apps forces the Target App selector in Create. Keystone never creates/edits tabs — only selects + personal reorder (per-user, per-app); reorder needs ≥2 tabs; flow-type object tabs hidden from default selection.`,
  intentMap: [
    { saysAny: ['create tab', 'new tab', 'add tab'], realControl: 'Admin Tabs "New" → "New Tab" modal', accessFlow: 'nav=tabs&appId=… → New → set #create-tab-type, #create-tab-label, #create-tab-api (+ #create-tab-object or #create-tab-target-url) → Create' },
    { saysAny: ['reorder tabs', 'customize order', 'move tab', 'rearrange tabs'], realControl: 'Keystone Tabs picker → "Customize order"', accessFlow: 'open Tabs picker (aria-label="Tabs") → "Customize order" → drag or arrow "Move <label> up/down" → "Save"' },
    { saysAny: ['search tabs', 'find tab'], realControl: 'Keystone Tabs picker search (aria-label="Search tabs")', accessFlow: 'open Tabs picker → type in the "Search tabs" input' },
  ],
  testNotes: `Admin tab creation needs an app scope (not All-Apps unless you also pick Target App). api_name immutable on edit. Keystone reorder is per-user/per-app and never creates tabs. A tab created in Admin will NOT appear in an already-open Keystone view until reload/refocus/app-switch (Keystone caches tabs in React state — see propagation module).`,
};
