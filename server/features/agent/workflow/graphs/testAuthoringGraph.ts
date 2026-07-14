/**
 * Test-authoring graph — Phase 4 composition of the authoring + compilation nodes (LangGraph migration).
 *
 * Topology: START → 'author_cases' → 'author_plans' → 'compile_and_validate' → END, sequential; no
 * browser, no execution. Full TestPlans and compiled spec sources live ONLY in the run-scoped artifact
 * stash (artifactStash.ts) — checkpointed state carries per-case refs/digests (CasePlanResult,
 * CompiledScriptRef), never plan bodies or code. Standalone from the discovery graph by design:
 * Phase 5's TestRunGraph stitches the two subgraphs together, including routing compile-time
 * TARGET_UNRESOLVED back into targeted rediscovery.
 */
import { createHash } from 'crypto';
import { StateGraph, START, END, type BaseCheckpointSaver } from '@langchain/langgraph';
import { authorTestCases, authorAbstractPlan } from '../nodes/authoring';
import { runCompilationNode } from '../nodes/compilation';
import type { MissionContext } from '../../mission/missionContext';
import type { TestPlan } from '../../compiler/testPlan';
import { readArtifacts, stashArtifacts } from '../artifactStash';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import {
  WorkflowStateAnnotation,
  type CasePlanResult,
  type MissionRef,
  type UsageRecord,
  type WorkflowCase,
  type WorkflowState,
  type WorkflowStateUpdate,
} from '../state';

/** Plan authoring fan-out bound (plan performance target) — at most this many concurrent model calls. */
const PLAN_CONCURRENCY = 3;

export interface TestAuthoringGraphDeps {
  /** Test seams — default to the real model-backed node functions. */
  authorCases?: typeof authorTestCases;
  authorPlan?: typeof authorAbstractPlan;
}

export interface BuildTestAuthoringGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

/** Same inline sha1 idiom as grounding.ts — state stores this digest of the plan, never the plan itself. */
function digestOfPlan(plan: TestPlan): string {
  return createHash('sha1').update(JSON.stringify(plan)).digest('hex');
}

/** Rebuilds a MissionContext from state's frozen MissionRef verbatim — no URL/scope re-derivation; names fall back to ids since the ref stores only ids. */
function missionContextFromRef(ref: MissionRef | null): MissionContext | null {
  if (!ref) return null;
  return Object.freeze({
    platform: ref.platform,
    platformType: ref.platformType,
    runtimeSurface: ref.runtimeSurface,
    application: ref.applicationId ? { id: ref.applicationId, name: ref.applicationId } : null,
    module: ref.moduleId ? { id: ref.moduleId, name: ref.moduleId } : null,
    tab: ref.tabId ? { id: ref.tabId, name: ref.tabId } : null,
    targetUrl: ref.targetUrl,
    executionScope: ref.executionScope,
  });
}

/** Router after author_cases: zero authored cases (no-evidence invariant / refusal path) ends the graph. */
export function routeAfterAuthorCases(state: Pick<WorkflowState, 'cases'>): 'author_plans' | 'end' {
  return (state.cases?.length ?? 0) > 0 ? 'author_plans' : 'end';
}

/** Router after author_plans: with zero planned cases there is nothing to compile — end explicitly. */
export function routeAfterAuthorPlans(state: Pick<WorkflowState, 'plansByCase'>): 'compile_and_validate' | 'end' {
  return Object.values(state.plansByCase ?? {}).some((p) => p.status === 'planned') ? 'compile_and_validate' : 'end';
}

/** Builds and compiles the Phase 4 authoring graph; real nodes by default, injectable for tests. */
export function buildTestAuthoringGraph(deps: TestAuthoringGraphDeps = {}, opts: BuildTestAuthoringGraphOptions = {}) {
  const authorCases = deps.authorCases ?? authorTestCases;
  const authorPlan = deps.authorPlan ?? authorAbstractPlan;

  const authorCasesWrapper = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    const { evidenceGraph } = readArtifacts(state.runId);
    if (!evidenceGraph) {
      // Stash gone (fresh process / resumed thread) — never author against zero evidence; end via the router.
      const err = new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
        'No in-memory evidence graph stashed for this run — the artifact stash is transient; route back through discovery/grounding before authoring.',
        undefined,
        'author_cases',
      );
      return { cases: [], stage: 'author_cases', errors: [err.toWorkflowError()] };
    }
    const result = await authorCases({
      mission: state.mission ?? null,
      goal: state.request?.goal ?? '',
      requestedCaseCount: state.request?.requestedCaseCount ?? 0,
      evidenceGraph,
    });
    // Bounded WorkflowCase projection — full case bodies (steps text) never enter checkpointed state.
    const cases: WorkflowCase[] = result.cases.map((c, i) => ({
      id: `case-${i + 1}`,
      title: c.title,
      description: c.description,
      tags: c.tags,
    }));
    return { cases, stage: 'author_cases', errors: result.errors, usage: result.usage };
  };

  const authorPlansWrapper = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    const { evidenceGraph } = readArtifacts(state.runId);
    const results: CasePlanResult[] = [];
    const usage: UsageRecord[] = [];
    const errors: WorkflowError[] = [];
    const fullPlans: Record<string, TestPlan> = {};

    const cases = state.cases ?? [];
    for (let i = 0; i < cases.length; i += PLAN_CONCURRENCY) {
      const chunk = cases.slice(i, i + PLAN_CONCURRENCY);
      const settled = await Promise.all(chunk.map(async (c) => ({
        c,
        r: await authorPlan({
          mission: state.mission ?? null,
          testCase: { title: c.title, description: c.description },
          evidenceGraph: evidenceGraph ?? null,
        }),
      })));
      for (const { c, r } of settled) {
        usage.push(...r.usage);
        if (r.plan) {
          fullPlans[c.id] = r.plan;
          results.push({ caseId: c.id, status: 'planned', planRef: digestOfPlan(r.plan) });
        } else {
          errors.push(...r.errors);
          const failedResult: CasePlanResult = { caseId: c.id, status: 'failed', planRef: null };
          if (r.errors[0]) failedResult.error = r.errors[0];
          results.push(failedResult);
        }
      }
    }

    // Full plans → stash; state gets only the refs/digests via the per-case reducer.
    stashArtifacts(state.runId, { plansByCase: fullPlans });
    return { plansByCase: results, stage: 'author_plans', errors, usage };
  };

  const compileAndValidateWrapper = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    const { evidenceGraph, verifiedSelectors, plansByCase } = readArtifacts(state.runId);
    const mission = missionContextFromRef(state.mission ?? null);
    if (!evidenceGraph || !mission) {
      // Defensive re-check: the stash can vanish between nodes only across a resume — fail explicit, never guess.
      const err = new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
        `Cannot compile without ${!evidenceGraph ? 'an in-memory evidence graph (stash is transient — rediscover first)' : 'a resolved mission'}.`,
        undefined,
        'compile_and_validate',
      );
      return { stage: 'compile_and_validate', errors: [err.toWorkflowError()] };
    }
    const result = runCompilationNode({
      mission,
      cases: state.cases ?? [],
      plansByCase: plansByCase ?? {},
      evidenceGraph,
      verifiedSelectors: verifiedSelectors ?? [],
    });
    // Full spec sources → stash for Phase 5 same-process execution; state gets scripts refs + diagnostics only.
    stashArtifacts(state.runId, { compiledSources: result.compiledSources });
    return {
      coveragePlan: result.coveragePlan,
      riskScores: result.riskScores,
      compilation: result.compilation,
      stage: 'compile_and_validate',
      errors: result.errors,
    };
  };

  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode('author_cases', authorCasesWrapper)
    .addNode('author_plans', authorPlansWrapper)
    .addNode('compile_and_validate', compileAndValidateWrapper)
    .addEdge(START, 'author_cases')
    .addConditionalEdges('author_cases', routeAfterAuthorCases, { author_plans: 'author_plans', end: END })
    .addConditionalEdges('author_plans', routeAfterAuthorPlans, { compile_and_validate: 'compile_and_validate', end: END })
    // Compile always ends here: routing TARGET_UNRESOLVED into targeted rediscovery spans subgraphs — Phase 5's TestRunGraph job.
    .addEdge('compile_and_validate', END);

  return graph.compile({ checkpointer: opts.checkpointer });
}
