# Agent-native, hardcoding removal & section population — consolidated summary

Single reference for the 2026-07-28/29 work-stream. Replaces: agent-native-implementation-tasks,
generic-engine-migration, routes-decomposition-staged-plan, understanding-layer-and-hardcoding-removal,
deep-run-grounding-audit-2026-07-28, core-platform-hardcoding-audit, hardcoding-removal-live-test-2026-07-29.
Status: BUILT + live-verified, **uncommitted**. Additive; flag-gated where noted (flag-off = prior behavior).

## 1. Agent-native substrate (flag AGENT_NATIVE_V1, default OFF)
`server/agent-core/`: bus/{blackboard,messageBus}, registry/{tools,agents,apiEndpointsTool}, grounding/
coverageContract, memory/{store,gate}, runstore/{runStore,mirror}, router/{routerAgent,discoverAppProfile},
appProfile, agentNativeFlag. Typed A2A message bus + append-only blackboard; capability registry (lookup,
not switch); coverage-gated grounding; semantic memory + decision gate. Schema: agent_blackboard,
agent_messages, agent_memory, agent_run_artifacts. Tests: scripts/test-agent-* (all green). Inert until a
phase is cut over.

## 2. Understanding layer (the app-agnostic engine)
`server/agent-core/understanding.ts` (typed, evidence-carrying AppUnderstanding: surfaces w/
targetsTenantApp, routing param-names, navModules, objects, auth.storageKeys, api base/metadata) +
`understandingProducer.ts` (`resolveAppUnderstanding`): learns from the CONNECTED repo — auth storage keys
grepped from its auth code, nav from its sidebar, API contract from its OpenAPI — memory-first, published to
the blackboard. Wired at `/api/agent/start` to register learned auth keys for the inspector. Proven live:
learned Core-Platform's 9 auth keys + 24 nav modules from the repo, API contract from `/openapi.json`.

## 3. Hardcoding removal (product literals gone from the live paths)
- Surface classifier (missionContext.ts): `keystone|shockwave`/ADMIN-guess regex → URL/host derivation.
- Auth injection (domExplorer.ts): `shockwave.*`/`core_platform.*` keys → learned keys via host registry
  `setAuthStorageKeys`, name-role injection, form-login fallback.
- Product-name heuristics: goal-router alias → `local ${name}`; supervisor multi-surface → generic; removed
  `isAdminAppsIntent`; apiAnalyst `localhost:5001`/`admin` → env-or-empty; `nav='objects'` prompt example → `<navKey>`.
- Metadata REST client → OpenAPI contract: `server/ai/tools/apiContract.ts` (`resolveAppApiContract` +
  `fillApiPath`) resolves an app's endpoint templates from its OWN OpenAPI; migrated all `/api/apps` +
  `__all_apps__` literals out of corePlatformData.ts, corePlatformMeta.ts, apiAnalystService.ts
  (`__all_apps__` → app-iteration). `probeServiceBase` detects the API by its OpenAPI spec.
  Live-verified: crm.account 13 fields + sample; search_relevant_objects/get_object_fields return real data.

## 4. Section population (agent output → every section page, correct columns)
`server/features/agent/routes.ts`: `persistAgentQualityArtifacts` now also creates a PLAN
(ensureAgentPlanAndSuite: name/scope=prompt/objectives=analyst/test_types/environments/risk_level/in_scope/tags)
and a REQUIREMENT (`persistAgentRequirementArtifact`: title/featureQuery/coverage + ui_selectors harvested
from compiled scripts). `agentPlanId` synthesizes `PLAN-<runid>` (guarded by cases-exist) so cases link to
the plan (FK-safe). `summarizeAgentCaseExecution` now reads `execution_result.tests` → correct run pass/fail.
Verified live: cases(plan-linked)/suites/plans/runs(pass-fail)/requirements(selectors) all populate; defects
only on real app failures (no false positives).

## 5. SUT / test notes
Core-Platform admin :5002 + keystone :5003 were both broken (missing `mermaid` dep in packages/ui,
declared-not-installed → Vite error overlay; the `/process/task_queues:104:5` string runs ground on was that
error's stack frame) — fixed via `npm install` in D:/core-platform. Local SUT credential (website + admin/admin)
created so runs authenticate deterministically (localhost had none). Driver: `.testflow-pw/scratch/observe.cjs`.

## Remaining (not blockers)
- Wire app.understanding into the mission builder (replace platformTypeFromSurface) — deliberately deferred.
- routes.ts staged decomposition. Column-header selector authoring precision.
