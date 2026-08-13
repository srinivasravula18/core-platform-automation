/** Mission profiles: the request picks the roster and the terminal deliverable, not a fixed topology. */
import { getAgentRegistry, orchestrationAgents, type AgentRegistry } from '../registry/agents';
import { CoordinationError, type PlanTaskSpec } from './coordinator';
import type { AgentRoleId, MissionKind } from './contracts';

export interface MissionStage {
  taskId: string;
  agentRoleId: AgentRoleId;
  objective: string;
  dependsOn?: string[];
}

export interface MissionProfile {
  kind: MissionKind;
  /** What the mission produces. A profile never runs past its own deliverable. */
  deliverable: string;
  stages: MissionStage[];
  /** Gates policy adds; a supervisor may not remove them. */
  mandatoryGates: string[];
  /** Fact kinds this mission is allowed to emit — anything else is rejected at acceptance. */
  allowedOutputKinds: string[];
  /** Missions this one may be promoted to, only via an explicit policy-allowed next action. */
  allowedPromotions: MissionKind[];
}

const GROUND_REPO: MissionStage = { taskId: 'map_repo', agentRoleId: 'specialist.repo_cartographer', objective: 'Map the codebase: stack, routes, components, API surface, selector inventory, environment.' };
const RESOLVE_SCOPE: MissionStage = { taskId: 'resolve_scope', agentRoleId: 'specialist.scope_resolver', objective: 'Reduce the repo map to the minimal slice needed to test the target.', dependsOn: ['map_repo'] };
const GROUND_LIVE: MissionStage = { taskId: 'ground_live', agentRoleId: 'specialist.live_grounding', objective: 'Ground the resolved scope against the live application: DOM, selectors, API.', dependsOn: ['resolve_scope'] };

/** One entry per mission. Adding a mission is data, never a new graph. */
export const MISSION_PROFILES: Record<MissionKind, MissionProfile> = {
  requirements: {
    kind: 'requirements',
    deliverable: 'accepted requirements',
    stages: [
      GROUND_REPO, RESOLVE_SCOPE,
      { taskId: 'author_requirements', agentRoleId: 'specialist.requirements_analyst', objective: 'Produce testable requirements with acceptance criteria and source refs.', dependsOn: ['resolve_scope'] },
      { taskId: 'review_requirements', agentRoleId: 'specialist.critic', objective: 'Refute unsupported, duplicate, or unverifiable requirements.', dependsOn: ['author_requirements'] },
    ],
    mandatoryGates: ['critique'],
    allowedOutputKinds: ['evidence.repository', 'scope.resolved', 'requirements.draft', 'critique.findings'],
    allowedPromotions: ['test_plan', 'cases'],
  },
  test_plan: {
    kind: 'test_plan',
    deliverable: 'accepted test plan',
    stages: [
      GROUND_REPO, RESOLVE_SCOPE,
      { taskId: 'author_plan', agentRoleId: 'specialist.test_plan_author', objective: 'Author the test plan: scope, strategy, risk, entry/exit criteria, case selection.', dependsOn: ['resolve_scope'] },
      { taskId: 'review_plan', agentRoleId: 'specialist.critic', objective: 'Refute unsupported scope, missing risk, or unverifiable exit criteria.', dependsOn: ['author_plan'] },
    ],
    mandatoryGates: ['critique'],
    allowedOutputKinds: ['evidence.repository', 'scope.resolved', 'testplan.draft', 'critique.findings'],
    allowedPromotions: ['cases'],
  },
  suite: {
    kind: 'suite',
    deliverable: 'accepted suite composition',
    stages: [
      { taskId: 'curate_suite', agentRoleId: 'specialist.suite_curator', objective: 'Compose a suite from accepted cases and tag queries.' },
      { taskId: 'review_suite', agentRoleId: 'specialist.critic', objective: 'Refute duplicate, empty, or mis-scoped suite membership.', dependsOn: ['curate_suite'] },
    ],
    mandatoryGates: ['critique'],
    allowedOutputKinds: ['suite.draft', 'critique.findings'],
    allowedPromotions: [],
  },
  cases: {
    kind: 'cases',
    deliverable: 'accepted cases (review-first, not executed)',
    stages: [
      GROUND_REPO, RESOLVE_SCOPE, GROUND_LIVE,
      { taskId: 'author_requirements', agentRoleId: 'specialist.requirements_analyst', objective: 'Produce testable requirements for the resolved scope.', dependsOn: ['resolve_scope'] },
      { taskId: 'design_cases', agentRoleId: 'specialist.case_designer', objective: 'Design executable cases from the accepted requirements, using only inventory selectors.', dependsOn: ['author_requirements', 'ground_live'] },
      { taskId: 'review_cases', agentRoleId: 'specialist.critic', objective: 'Refute ungrounded, duplicate, or unsafe cases before they reach review.', dependsOn: ['design_cases'] },
    ],
    mandatoryGates: ['evidence', 'critique', 'human_review'],
    allowedOutputKinds: ['evidence.repository', 'evidence.selectors', 'evidence.surfaces', 'evidence.api', 'scope.resolved', 'requirements.draft', 'cases.draft', 'critique.findings'],
    allowedPromotions: ['automation', 'deep_test_run'],
  },
  automation: {
    kind: 'automation',
    deliverable: 'verified scripts',
    stages: [
      { taskId: 'engineer_scripts', agentRoleId: 'specialist.script_engineer', objective: 'Generate Playwright specs from the accepted cases; evidence capture comes from the shared fixture.' },
    ],
    mandatoryGates: ['evidence', 'compile'],
    allowedOutputKinds: ['plans.abstract'],
    allowedPromotions: ['deep_test_run'],
  },
  deep_test_run: {
    kind: 'deep_test_run',
    deliverable: 'executed evidence, verdicts, and a report',
    stages: [
      GROUND_REPO, RESOLVE_SCOPE, GROUND_LIVE,
      { taskId: 'author_requirements', agentRoleId: 'specialist.requirements_analyst', objective: 'Produce testable requirements for the resolved scope.', dependsOn: ['resolve_scope'] },
      { taskId: 'design_cases', agentRoleId: 'specialist.case_designer', objective: 'Design executable cases from the accepted requirements.', dependsOn: ['author_requirements', 'ground_live'] },
      { taskId: 'review_cases', agentRoleId: 'specialist.critic', objective: 'Refute ungrounded, duplicate, or unsafe cases before compile.', dependsOn: ['design_cases'] },
      { taskId: 'engineer_scripts', agentRoleId: 'specialist.script_engineer', objective: 'Generate Playwright specs from the accepted cases.', dependsOn: ['review_cases'] },
      { taskId: 'triage_failures', agentRoleId: 'specialist.triage_analyst', objective: 'Triage each stable failure; rule out the test before blaming the product.', dependsOn: ['engineer_scripts'] },
      { taskId: 'compose_report', agentRoleId: 'specialist.report_composer', objective: 'Compose the run report from accepted outcomes only.', dependsOn: ['triage_failures'] },
    ],
    mandatoryGates: ['evidence', 'critique', 'compile', 'execute'],
    allowedOutputKinds: ['evidence.repository', 'evidence.selectors', 'evidence.surfaces', 'evidence.api', 'scope.resolved', 'requirements.draft', 'cases.draft', 'critique.findings', 'plans.abstract', 'investigation.classification', 'report.summary'],
    allowedPromotions: [],
  },
  investigation: {
    kind: 'investigation',
    deliverable: 'classified failures',
    stages: [
      { taskId: 'triage_failures', agentRoleId: 'specialist.triage_analyst', objective: 'Classify each failure with cited evidence; name the artifact that would settle any ambiguity.' },
      { taskId: 'compose_report', agentRoleId: 'specialist.report_composer', objective: 'Summarize the classified failures and residual risk.', dependsOn: ['triage_failures'] },
    ],
    mandatoryGates: [],
    allowedOutputKinds: ['investigation.classification', 'report.summary'],
    allowedPromotions: [],
  },
  answer: {
    kind: 'answer',
    deliverable: 'a grounded answer (no workspace artifacts)',
    stages: [
      GROUND_REPO,
      { taskId: 'compose_report', agentRoleId: 'specialist.report_composer', objective: 'Answer the question from the repo map alone; cite what you used.', dependsOn: ['map_repo'] },
    ],
    mandatoryGates: [],
    allowedOutputKinds: ['evidence.repository', 'report.summary'],
    allowedPromotions: ['requirements', 'cases', 'deep_test_run'],
  },
};

/** Existing RouteKinds stay the compatibility surface; profiles are the richer internal contract. */
const ROUTE_KIND_TO_MISSION: Record<string, MissionKind> = {
  requirement_draft: 'requirements',
  workspace_action: 'test_plan',
  generate_cases: 'cases',
  deep_test_run: 'deep_test_run',
  code_analysis: 'answer',
  answer: 'answer',
};

export function missionForRouteKind(kind: string): MissionKind | null {
  return ROUTE_KIND_TO_MISSION[kind] ?? null;
}

export function missionProfile(kind: MissionKind): MissionProfile {
  const profile = MISSION_PROFILES[kind];
  if (!profile) throw new CoordinationError(`Unknown mission kind '${kind}'.`);
  return profile;
}

/** A profile whose roster the registry cannot satisfy fails loudly rather than degrading to a fuller run. */
export function assertProfileSatisfiable(profile: MissionProfile, registry: AgentRegistry = getAgentRegistry()): void {
  const available = new Set(orchestrationAgents(registry).map((d) => d.roleId));
  const missing = profile.stages.map((s) => s.agentRoleId).filter((r) => !available.has(r));
  if (missing.length) throw new CoordinationError(`Mission '${profile.kind}' needs unregistered roles: ${[...new Set(missing)].join(', ')}.`);
}

/** Task specs for a mission, in dependency order. What the coordinator turns into a validated plan. */
export function missionTaskSpecs(kind: MissionKind, goal: string, registry: AgentRegistry = getAgentRegistry()): PlanTaskSpec[] {
  const profile = missionProfile(kind);
  assertProfileSatisfiable(profile, registry);
  return profile.stages.map((s) => ({
    taskId: s.taskId,
    agentRoleId: s.agentRoleId,
    objective: `${s.objective}\nGOAL: ${goal}`,
    dependsOn: s.dependsOn ?? [],
  }));
}

/** True when a mission is permitted to emit this fact kind. Enforced at acceptance, not by prompt. */
export function missionAllowsOutput(kind: MissionKind, factKind: string): boolean {
  return missionProfile(kind).allowedOutputKinds.includes(factKind);
}

/** A mission may only be extended along an explicitly declared promotion path. */
export function canPromoteMission(from: MissionKind, to: MissionKind): boolean {
  return missionProfile(from).allowedPromotions.includes(to);
}
