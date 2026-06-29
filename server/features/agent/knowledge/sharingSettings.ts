import type { FeatureKnowledge } from './types';

/** Sharing Settings (Admin sharing rules) + Keystone "Shared Records" end-user view. */
export const sharingSettingsKnowledge: FeatureKnowledge = {
  id: 'sharing-settings',
  title: 'Sharing Settings (sharing rules)',
  apps: ['admin', 'keystone'],
  navigation:
    'Admin: /?nav=sharing_settings (label "Sharing Settings"; &id=<ruleId> for a rule). Keystone end-user: a "Shared Records" workspace tab (api_name "shared_records") + "Share Settings I Manage" panel.',
  matchTerms: ['sharing', 'sharing rule', 'sharing settings', 'share', 'shared records', 'record sharing', 'share with', 'access level', 'sharing duration'],
  uiLevel: `ADMIN (nav=sharing_settings): heading "Sharing Settings"; shared list view (activeObjectApiName="sharing_rule"), table only; create → "New Sharing Setting" modal.
  CREATE modal "New Sharing Setting" (stable ids): #create-sharing-rule-object (req, "Select object"), #create-sharing-rule-name (req), #create-sharing-rule-rule-type ("Based on record owner"=owner / "Based on criteria"=criteria), #create-sharing-rule-access-level ("Read"=read / "Read/Write"=edit), #create-sharing-rule-principal-type (req; Role/Group/User), #create-sharing-rule-principal (req; disabled until type set), #create-sharing-rule-source-type + #create-sharing-rule-source-principal (owner-only), #create-sharing-rule-active (checkbox "Active"/"Inactive"), #create-sharing-rule-duration (SharingDurationDropdown), "Criteria" FilterBuilder (criteria-only). Footer "Cancel"/"Create".
  EDIT (detail) ids: #sharing-rule-active, #sharing-object-hierarchy ("Grant Access Using Hierarchy"), #sharing-rule-name, #sharing-rule-access-level, #sharing-rule-duration, #sharing-rule-source-type, #sharing-rule-source-principal, #sharing-rule-principal-type, #sharing-rule-principal, #sharing-rule-type, "Criteria" FilterBuilder. Bottom bar: "Delete" / "Save" (busy "Saving..."). Delete confirm "Delete Sharing Setting".
  DURATION dropdown (button aria-haspopup="listbox", role=option): "Forever" / "For a duration" (relative: "Share For" amount + unit buttons "Hours"/"Days"/"Weeks"/"Months", "Done"/"Clear") / "Specific date and time" (datetime-local, "Stop Sharing At").
KEYSTONE: "Shared Records" tab — "View" select "Shared to me"/"Shared by me"; "Shared by me" → "Share Settings I Manage" (search "Search shares" placeholder "Search object, record, or principal"; "Refresh"; DataTable cols Object/Record/Shared To/Access/Expires/Updated; Access "Edit"/"Read", expiry "Never" when none). Read-only review — NOT rule authoring.`,
  codeLevel: `Files: AdminSharingSettingsPanel.tsx, AdminCreateSharingRuleModal.tsx, SharingDurationDropdown.tsx, useAdminSharingSettings.ts; Keystone ShockwaveSharedRecordsTab.tsx, ShockwaveMyRecordSharesPanel.tsx. API: GET/POST/PATCH/DELETE /admin/sharing-rules[/:id].
Rules: required — object_id, name, principal_type, principal_id; owner rules need source_principal_type + source_principal_id; criteria rules need ≥1 criterion ("Add at least one criterion."). Duration: forever→no expiry; relative→whole number >0; custom→future datetime. A rule with a past expiry is shown "Inactive" even if stored active. "Grant Access Using Hierarchy" is a per-object default (managers inherit). Scope is expressed by principal type Role/Group/User (NOT a Private/Public toggle — that Private/Public scope belongs to LIST-VIEW sharing, a different thing).`,
  intentMap: [
    { saysAny: ['create sharing rule', 'new sharing', 'share records', 'sharing setting'], realControl: 'Sharing Settings "New" → "New Sharing Setting" modal', accessFlow: 'nav=sharing_settings → New → set #create-sharing-rule-object/#create-sharing-rule-name/#create-sharing-rule-principal-type/#create-sharing-rule-principal → Create' },
    { saysAny: ['sharing duration', 'expire sharing', 'share for'], realControl: 'the SharingDurationDropdown (#create-sharing-rule-duration / #sharing-rule-duration)', accessFlow: 'open the duration dropdown (aria-haspopup="listbox") → pick Forever / For a duration / Specific date and time' },
    { saysAny: ['hierarchy access', 'managers inherit'], realControl: '#sharing-object-hierarchy "Grant Access Using Hierarchy"', accessFlow: 'sharing rule detail → toggle the hierarchy checkbox → Save' },
  ],
  testNotes: `Duration is a custom listbox button, not a native select. Scope = principal type (Role/Group/User), not Private/Public. Assert a created rule by the new row in the list / the rule snapshot. Keystone "Shared Records" is read-only review (don't author rules there). Sharing changes propagate subject to ~60s access caches.`,
};
