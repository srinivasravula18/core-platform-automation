import type { FeatureKnowledge } from './types';

/** Users (Admin user management + Login-As/impersonation into Keystone). */
export const usersKnowledge: FeatureKnowledge = {
  id: 'users',
  title: 'Users (user management, Login-As)',
  apps: ['admin'],
  navigation:
    'Admin: /?nav=users (list = no id / __meta_users_list__; detail = &id=<userId>). Keystone exposure is only the impersonation landing (Login As banner).',
  matchTerms: ['user', 'users', 'create user', 'edit user', 'reset password', 'login as', 'impersonate', 'impersonation', 'super user', 'deactivate user'],
  uiLevel: `LIST (nav=users): heading "Users", subtitle "Manage user accounts and access settings."; shared list view (activeObjectApiName="user"), table only; bulk delete disabled; "New" → user modal. A leading "Login As" icon column per row: aria-label="Login to Keystone as <username>" (only when status !== "disabled").
DETAIL: sub-tabs "Details"/"Audit Log"; "User Details" with buttons "Login As" (→ "Opening Keystone..."), "Edit", "Reset Password".
USER modal "New User"/"Edit User" (ids): #user-username (create only; edit shows read-only — username IMMUTABLE), #user-first-name, #user-last-name, #user-email, #user-status (select Active=active/Disabled=disabled), #user-manager (select, "None" + managers), #user-is-super-user (checkbox "Super User"), #user-password (create only, "Temporary password"). Footer "Cancel" + "Create"/"Save".
RESET PASSWORD modal "Reset Password": #reset-password ("New password"); buttons "Cancel"/"Reset".
KEYSTONE landing: banner "Login As active", body "You are using Keystone as <user> from Admin as <actor>.", exit button "Log out <user> and close".`,
  codeLevel: `Files: AdminUsersPanel.tsx, AdminUserModal.tsx, AdminUserPasswordModal.tsx, useAdminUsers.ts, impersonation.ts; Keystone banner in ShockwaveTopbar.tsx. API: POST /admin/users (create), PATCH /admin/users/:id (edit, needs row_version), POST /admin/users/:id/password, POST /admin/users/:id/login-as → {handoff_token}, PUT /admin/users/:id/roles.
Rules: username required + unique (case-insensitive), IMMUTABLE after create; temporary password required on create (min 8); first/last/email optional. Bootstrap-admin status is LOCKED ("The bootstrap admin user must remain active."). Edit uses optimistic concurrency (row_version). Roles/groups are NOT assigned in the user modal — only is_super_user; role/group membership is managed in the Roles/Groups panels. Disabled users cannot be impersonated (Login As guarded on status !== "disabled").
IMPERSONATION flow: opens a blank tab, POST login-as → handoff_token, navigates Keystone to ?impersonation_handoff=<token>&return_to=<adminHref>. Keystone target URL: VITE_SHOCKWAVE_BASE_URL, else admin :5002 → :5003, else /admin→/shockwave.`,
  intentMap: [
    { saysAny: ['create user', 'new user', 'add user'], realControl: 'Users "New" → "New User" modal', accessFlow: 'nav=users → New → set #user-username + #user-password (create) → Create' },
    { saysAny: ['edit user', 'change user', 'deactivate user', 'disable user'], realControl: 'user detail "Edit" → "Edit User" modal (#user-status Active/Disabled)', accessFlow: 'open user → Edit → change fields/#user-status → Save' },
    { saysAny: ['login as', 'impersonate', 'open keystone as'], realControl: 'the "Login As" button / row icon (aria-label="Login to Keystone as <username>")', accessFlow: 'user detail "Login As" (or the row icon) → a new Keystone tab opens with the "Login As active" banner' },
    { saysAny: ['reset password', 'change password'], realControl: 'user detail "Reset Password" → modal #reset-password', accessFlow: 'open user → Reset Password → set #reset-password → "Reset"' },
  ],
  testNotes: `Username is immutable (read-only) on edit. Bootstrap-admin status select is disabled. Login As opens a NEW browser tab (Keystone) — a test must handle the popup/new page; disabled users have no Login As. A just-created user can log in immediately, but super-user role changes lag ~120s (super-user cache). Don't assert role assignment from the user modal (it's not there).`,
};
