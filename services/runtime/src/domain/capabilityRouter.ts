/**
 * Deterministic capability router (Phase 3) — a pure decision over request facts,
 * resolved entities, session state, and capability preconditions (plan §14.3).
 * No LLM output can select entities, override a precondition, or bypass clarification.
 */

import type {
  CapabilityDecision,
  CapabilityId,
  EntityRef,
  MissingRequirement,
  ReferenceBinding,
  SessionContext,
  SpeechAct,
} from './types';
import { CAPABILITIES, CAPABILITY_RULES_VERSION } from './capabilities';
import type { TopicHints } from '../application/requestAnalyzer';

export interface RouterFacts {
  speechAct: SpeechAct;
  isQuestion: boolean;
  wantsExecution: boolean;
  topics: TopicHints;
  bindings: ReferenceBinding[];
  session: SessionContext;
}

function resolvedOfType(bindings: ReferenceBinding[], types: string[]): EntityRef[] {
  const out: EntityRef[] = [];
  for (const b of bindings) {
    if (b.status !== 'resolved') continue;
    for (const r of b.resolved) if (types.includes(r.type)) out.push(r);
  }
  return out;
}

function hasAmbiguousMutationTarget(facts: RouterFacts): boolean {
  const mutating = facts.speechAct === 'run' || facts.speechAct === 'modify' || facts.speechAct === 'create';
  return mutating && facts.bindings.some((b) => b.status === 'ambiguous');
}

function decide(
  capability: CapabilityId,
  facts: RouterFacts,
  entities: EntityRef[],
  reasonCodes: string[],
): CapabilityDecision {
  const def = CAPABILITIES[capability];
  const missing: MissingRequirement[] = [];
  for (const type of def.requiredEntityTypes) {
    const has = entities.some((e) => e.type === type)
      || (type === 'run' && (facts.session.latestRun || facts.session.currentExecution));
    if (!has) missing.push({ requirement: { entityType: type }, reason: `no resolvable ${type} in session or bindings` });
  }
  return {
    capability,
    interaction: def.interaction,
    resolvedEntities: entities,
    requiredEvidence: def.requiredEvidence,
    missing,
    confidence: 'deterministic',
    reasonCodes: [ `rules:${CAPABILITY_RULES_VERSION}`, ...reasonCodes],
  };
}

function clarifyDecision(facts: RouterFacts, reasonCodes: string[]): CapabilityDecision {
  return {
    capability: 'app_knowledge',
    interaction: 'clarify',
    resolvedEntities: [],
    requiredEvidence: [],
    missing: [],
    confidence: 'ambiguous',
    reasonCodes: [`rules:${CAPABILITY_RULES_VERSION}`, ...reasonCodes],
  };
}

/**
 * Pure capability selection. Precedence encodes the plan's examples:
 * diagnostics > review > generation > automation > analysis > recall > knowledge.
 */
export function decideCapability(facts: RouterFacts): CapabilityDecision {
  const { speechAct, topics, session, bindings } = facts;
  const asking = facts.isQuestion || speechAct === 'ask' || speechAct === 'explain' || speechAct === 'compare';

  // Ambiguous binding on a mutation → clarify before anything else (plan §13.5).
  if (hasAmbiguousMutationTarget(facts)) {
    return clarifyDecision(facts, ['ambiguous-mutation-target']);
  }

  const runEntities = resolvedOfType(bindings, ['run', 'execution']);
  const failureEntities = resolvedOfType(bindings, ['test_case', 'script']).filter(() =>
    bindings.some((b) => b.status === 'resolved' && b.resolved.some((r) => r.type === 'test_case' || r.type === 'script')));
  const defectEntities = resolvedOfType(bindings, ['defect']);
  const hasRunContext = runEntities.length > 0 || !!session.latestRun || !!session.currentExecution;

  // ask/explain + failure focus or resolved run/failure entity → run_diagnostics.
  if (asking && (topics.failure || runEntities.length > 0) && hasRunContext && !topics.code) {
    const subjects = [...runEntities, ...failureEntities];
    if (!subjects.length && session.latestRun) subjects.push(session.latestRun);
    return decide('run_diagnostics', facts, subjects, ['ask+failure/run']);
  }

  // Failure question with NO run anywhere: still diagnostics, with the gap made explicit.
  if (asking && topics.failure && !hasRunContext && !topics.code) {
    return decide('run_diagnostics', facts, [], ['ask+failure', 'no-run-context']);
  }

  // review/ask about an execution (non-failure phrasing) → execution_review.
  if ((speechAct === 'review' || asking) && topics.review && hasRunContext && runEntities.length > 0) {
    return decide('execution_review', facts, runEntities, ['review+execution']);
  }

  // ask/review + code/diff/branch topics → code_review (architecture outranks when named).
  if (topics.architecture && (asking || speechAct === 'review')) {
    return decide('architecture_review', facts, [], ['architecture-topic']);
  }
  if (topics.code && (speechAct === 'review' || asking)) {
    return decide('code_review', facts, resolvedOfType(bindings, ['branch', 'review']), ['code-topic']);
  }

  // ask/analyze + resolved defect → defect_analysis.
  if (asking && (defectEntities.length > 0 || (topics.defect && !!session.currentDefect))) {
    const subjects = defectEntities.length ? defectEntities : (session.currentDefect ? [session.currentDefect] : []);
    return decide('defect_analysis', facts, subjects, ['ask+defect']);
  }

  // create/modify of plan/suite/folder/report artifacts (no case noun) → workspace_action.
  if ((speechAct === 'create' || speechAct === 'modify') && topics.workspace && !topics.caseNoun && !topics.requirement) {
    return decide('workspace_action', facts, resolvedOfType(bindings, ['test_plan', 'test_suite', 'test_case', 'report', 'defect']), ['workspace-artifact-verb']);
  }

  // create/generate + test artifact noun → test_generation.
  if (speechAct === 'create' && topics.test && !topics.requirement) {
    const scope = [session.currentApp, session.currentModule].filter(Boolean) as EntityRef[];
    return decide('test_generation', facts, scope, ['create+test-noun']);
  }

  // requirement topic → requirement_review (draft/review both live here).
  if (topics.requirement) {
    return decide('requirement_review', facts, resolvedOfType(bindings, ['requirement']), ['requirement-topic']);
  }

  // run/re-run + resolved suite/cases/scripts/run → automation.
  if (facts.wantsExecution) {
    const targets = resolvedOfType(bindings, ['test_suite', 'test_case', 'script', 'run']);
    if (targets.length || topics.test || session.latestScripts || session.latestTestCases) {
      return decide('automation', facts, targets, ['run+artifacts']);
    }
  }

  // API topic → api_testing.
  if (topics.api) {
    return decide('api_testing', facts, resolvedOfType(bindings, ['api_endpoint', 'run']), ['api-topic']);
  }

  // flow topic → flow_analysis.
  if (topics.flow && asking) {
    return decide('flow_analysis', facts, [], ['flow-topic']);
  }

  // create/modify on workspace artifacts → workspace_action.
  if ((speechAct === 'create' || speechAct === 'modify') && topics.workspace) {
    return decide('workspace_action', facts, resolvedOfType(bindings, ['test_plan', 'test_suite', 'test_case', 'report', 'defect']), ['workspace-verb']);
  }

  // recall predicate → conversation_recall (needs an actual conversation history focus).
  if (asking && topics.recall) {
    return decide('conversation_recall', facts, [], ['recall-phrase']);
  }

  // plain question with app scope → app_knowledge.
  if (asking) {
    return decide('app_knowledge', facts, session.currentApp ? [session.currentApp] : [], ['ask-fallback']);
  }

  // Non-question with no matching predicate: never guess an action.
  return clarifyDecision(facts, ['no-predicate-matched']);
}
