import type { FeatureKnowledge } from './types';

/**
 * Cross-app metadata & data propagation (Admin → Keystone). Critical for cross-app E2E timing:
 * "if I do X in Admin, when does it show in Keystone?" Shared backend + two cache layers.
 */
export const propagationKnowledge: FeatureKnowledge = {
  id: 'propagation',
  title: 'Admin → Keystone metadata/data propagation & caching',
  apps: ['admin', 'keystone'],
  navigation: 'Not a screen — cross-app behavior. Applies whenever a test changes metadata/data in Admin and verifies the effect in Keystone (or vice versa).',
  matchTerms: ['propagate', 'propagation', 'reflect', 'appear in keystone', 'sync', 'cache', 'eventual', 'end to end', 'cross app', 'after creating', 'shows up', 'background data', 'metadata refresh'],
  uiLevel: `There is no "make it appear" button for structural changes. The in-app "Refresh metadata" button (AgentRefreshMetadataButton) ONLY refreshes the AI agent's schema catalog — it does NOT refresh Keystone tabs/objects/layouts. To surface an Admin change in an already-open Keystone view: reload the page, OR blur+refocus the window/tab, OR switch the selected app away and back.`,
  codeLevel: `Architecture: ONE Fastify backend (apps/service) + ONE Postgres (meta.* tables) serve BOTH SPAs. No separate Keystone backend; Admin writes land immediately in shared Postgres.
TWO cache layers:
1) Server in-process TTL caches (~60s, per process): records/routes.ts metaCache (METADATA_CACHE_TTL_MS ?? 60000; objectMeta/fieldMeta/fieldDefs/recordTypes/picklistRules), access/evaluator.ts (ACCESS_CACHE_TTL_MS ?? 60000; permSet/objectContext/sharePrincipal), effective-principals (60s), auth settings (60s), super-user (120s). Object/field/tab DESCRIBE+objects+tabs endpoints read FRESH from DB (no metaCache) → structural changes visible server-side almost immediately. Permission/sharing/role changes lag up to ~60s UNLESS the Admin write route fired the matching invalidate (the access/roles/sharing routes DO, for the affected user/object → immediate for that user).
2) Keystone front-end React-state cache: useShockwaveTabs caches tabs and will NOT refetch once loaded (refetch only on app-change, window FOCUS, tab VISIBILITY, or full reload). So a new tab/object created in Admin won't appear in an open Keystone view without one of those.`,
  intentMap: [
    { saysAny: ['appears in keystone', 'show up in keystone', 'reflect in keystone', 'after creating in admin'], realControl: 'reload / refocus the Keystone view before asserting', accessFlow: 'do the Admin change → in Keystone call page.reload() (or switch browser tab to trigger focus refetch / switch app and back) → THEN assert the tab/object/field' },
  ],
  testNotes: `RULES for cross-app E2E:
- Same backend → no cross-service replication wait; Admin writes are in the DB immediately.
- New TAB or OBJECT in Keystone: you MUST force a front-end refetch (page.reload(), or blur+refocus, or switch app and back). A plain waitFor WILL HANG — Keystone does not poll.
- New FIELD on a record layout: surfaces after reloading the Keystone record page (describe reads fresh; record metaCache is invalidated on field writes).
- PERMISSION / SHARING / ROLE changes: can lag up to ~60s (60s access caches). Changes made via the Admin access/roles/sharing routes for the SAME user are invalidated immediately; otherwise wait ~60s or lower METADATA_CACHE_TTL_MS / ACCESS_CACHE_TTL_MS in the test env.
- USER: a new user can log in immediately; super-user/role-power changes lag ~120s.
- Do NOT rely on the "Refresh metadata" button to surface structural Admin changes (it only refreshes the agent catalog).
- Test knob: a single-instance service with low METADATA_CACHE_TTL_MS / ACCESS_CACHE_TTL_MS makes invalidation deterministic.`,
};
