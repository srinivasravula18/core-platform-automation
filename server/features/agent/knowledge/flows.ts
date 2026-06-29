import type { FeatureKnowledge } from './types';

/** Flows. Admin authors flow definitions (steps/fields/actions); Keystone runs them step-by-step. */
export const flowsKnowledge: FeatureKnowledge = {
  id: 'flows',
  title: 'Flows (Admin authoring + Keystone flow-run)',
  apps: ['admin', 'keystone'],
  navigation:
    'Admin: /?nav=flows&appId=<id> (requires app scope). Keystone: the "flows:home" synthetic workspace tab; a run opens its own tab.',
  matchTerms: ['flow', 'flows', 'flow run', 'run flow', 'flow step', 'wizard', 'process', 'flow builder', 'execute flow'],
  uiLevel: `ADMIN (nav=flows): heading "Flows" (h2), subtitle "Configure app-level flows and ordered step definitions."; shared list view (activeObjectApiName="flow", cols name/api_name/mode/version_no/is_active/is_default); "New" → "Create Flow" modal. Editor sub-tabs "Flow Details"/"Steps"/"Access".
  CREATE FLOW modal "Create Flow" (ids): #flow-create-app (All-Apps only), #flow-create-name (req), #flow-create-api-name (req), Mode select (create/edit), Submit Strategy ("Main record + actions"/"Actions only"/"Main record only"), #flow-create-active, #flow-create-default, #flow-create-cancel. Footer "Cancel"/"Create Flow" (busy "Creating...").
  FLOW DETAILS: Name, Mode (disabled on edit), Submit Strategy, checkboxes "Active"/"Default"/"Allow Cancel", Description; bottom bar "Delete"/"Save" (busy "Saving...").
  ACCESS: Principal Type Role/Group/User + Principal + "Add Grant"/"Reload"; rows with "Remove".
  STEPS builder: "Step Map" rail with "New Step"/"Move Up"/"Move Down"; Step Basics ("Step Order","Label" req,"Help Text"); Step Visibility (Behavior "Always show step"/"Use expression"/"Use field condition"); Field Palette → Step Canvas (drag, "Add Section", "Fields From Previous Steps"); Backend mode ("Add Create Record"/"Add Update Record"/"Add Delete Record"/"Add HTTP Request"); step bar "Delete"/"Save"/"Create Step". (Activation = the "Active"/"Default" checkboxes, no separate toggle. Delete confirm "Delete Flow".)
KEYSTONE (flows:home): toolbar "List view" select "Available Flows"/"Executed Flows", search "Search flows"/"Search runs", "Refresh". Available table cols Flow/Mode/Availability/Action; row action "Start" (create flows) or disabled "Open from record" (edit flows). Executed table cols Flow/Status/Step/Last Run/Action; "Resume"/"View"/"Run Log"; status tabs All/In Progress/Completed/Cancelled/Failed.
  RUN UI (run tab): header flow name + "Step x/y"; left rail stepper; action bar "Back", "Next"/"Submit", "Submit"/"Finish", "Save + Exit", "Cancel". Fields rendered per type; required = red "* "; boolean/multi fields expose aria-label = field label.`,
  codeLevel: `Files: AdminFlowsPanel.tsx (create ~8522, details ~6650, steps ~6932); Keystone ShockwaveFlowsHome.tsx, ShockwaveFlowRunPanel.tsx (action bar ~1662), ShockwaveFlowPanel.tsx, workspaceTabRules.ts.
Rules: only mode==="create" flows are startable from Keystone home ("Start"); edit flows must launch from a record ("Open from record" disabled). Admin Save disabled unless api_name & name set AND there are unsaved changes; Mode immutable after create. Submit Strategy ∈ main_and_actions/actions_only/main_only. Backend actions run on "Next". Allow Cancel (authored) disables the run "Cancel" button when false. Run requires a lock (auto take-over on conflict); "Save + Exit" persists progress. nextActsAsSubmit when next step label matches /status/i; "Finish" on a status step.`,
  intentMap: [
    { saysAny: ['create flow', 'new flow', 'add flow'], realControl: 'Admin Flows "New" → "Create Flow" modal', accessFlow: 'nav=flows&appId=… → New → set #flow-create-name + #flow-create-api-name + Mode → "Create Flow"' },
    { saysAny: ['add step', 'flow step', 'build flow', 'configure steps'], realControl: 'flow editor → "Steps" tab → "New Step"', accessFlow: 'open flow → Steps → New Step → set "Label" + fields → "Create Step"' },
    { saysAny: ['run flow', 'start flow', 'execute flow'], realControl: 'Keystone flows:home → "Start" (create flows)', accessFlow: 'open Flows tab → Available Flows → "Start" → fill steps → "Next"/"Submit"' },
    { saysAny: ['resume flow', 'continue flow'], realControl: 'Keystone flows:home → Executed Flows → "Resume"', accessFlow: 'Flows → Executed Flows → in-progress run → "Resume"' },
  ],
  testNotes: `Admin authoring needs an app scope. Only create-mode flows start from Keystone home; edit flows need a record context. The run action bar verbs change: "Next" becomes "Submit" near the end; "Finish" on a status step. Cancel may be disabled (Allow Cancel=false). Assert run completion via the success message / status "completed". Buttons are shared <Button> (select by accessible text).`,
};
