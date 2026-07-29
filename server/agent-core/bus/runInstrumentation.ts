/**
 * Live-run instrumentation (Phase 1 cutover) — projects the graph runtime's REAL state onto the
 * coordination bus + blackboard so a live run populates the A2A substrate at full fidelity.
 *
 * SHADOW / observability only: it records what the existing graph already decided; it changes NO control
 * flow and makes NO decision. Flag-gated by AGENT_NATIVE_V1 (off → no-op) and fully best-effort — any bus/
 * blackboard hiccup is swallowed so a run can never be affected by instrumentation. This is the first live
 * consumer of the Phase 1 substrate; it proves the bus/blackboard end-to-end against the SUT before any
 * decision-bearing agent is migrated onto them.
 *
 * Fidelity model: each graph stage is voiced by the specialist agent that owns it (same roster the console
 * chips use, so names line up). On every stage boundary we publish (a) a HANDOFF from the orchestrator to
 * the entering stage's agent, (b) a RESULT from the just-completed stage's agent carrying the concrete
 * facts that stage produced (read straight from WorkflowState — cases drafted, selectors verified, verdicts),
 * and (c) an append-only blackboard fact for that produced artifact so any agent can read it once, not
 * re-derive it. The result is a real, causally-linked conversation transcript of the run.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getMessageBus } from './messageBus';
import { getBlackboard } from './blackboard';
import type { WorkflowState } from '../../features/agent/workflow/state';

/** The orchestrator identity that hands work off to specialists (matches the router agent name in Phase 3). */
const ORCHESTRATOR = 'orchestrator';

/** Each graph stage → the specialist agent that voices it. Names mirror the console chip roster so the
 * substrate view and the legacy chips refer to the same actors. */
const STAGE_AGENT: Record<string, string> = {
  validate_request: 'ScopeAgent',
  load_context: 'MetadataFetch',
  discover_and_ground: 'ApplicationInspector',
  author_cases: 'TestGenerationAgent',
  review_cases: 'ReviewAgent',
  author_plans: 'PlaywrightAgent',
  compile_and_validate: 'SelectorVerifier',
  execute_tests: 'EvidenceAgent',
  investigate_failures: 'InvestigatorAgent',
  finalize: 'QAAnalyst',
};

/** The specialist that owns a stage (falls back to the raw stage name so an unknown stage still speaks). */
function agentForStage(stage: string): string {
  return STAGE_AGENT[stage] ?? stage;
}

/** Concrete facts a stage produced, read straight from the real state — this is what makes the RESULT
 * message honest (it is the actual artifact, never a template). Returns null when the stage produced
 * nothing observable (so we don't publish an empty RESULT). */
function factForStage(stage: string, state: WorkflowState): { summary: string; value: Record<string, unknown> } | null {
  switch (stage) {
    case 'validate_request': {
      return { summary: `Scope resolved: ${state.mission?.executionScope ?? state.request?.goal ?? 'run'}`, value: { goal: state.request?.goal ?? '', scope: state.mission?.executionScope ?? null, targetUrl: state.mission?.targetUrl ?? null } };
    }
    case 'load_context': {
      const m = state.context?.metadata;
      if (!m) return null;
      return { summary: `Metadata: ${m.objectCount} object(s) (${m.source}).`, value: { objectCount: m.objectCount, source: m.source, digest: m.digest } };
    }
    case 'discover_and_ground': {
      const ev = state.evidence;
      const live = ev?.countsByProvenance?.live ?? 0;
      const targets = ev?.targetCatalog?.length ?? 0;
      if (!live && !targets && !ev?.gate) return null;
      return { summary: `Grounded: ${live} live evidence node(s), ${targets} verified target(s).`, value: { live, targets, gate: ev?.gate?.decision ?? null, reasons: ev?.gate?.reasons?.slice(0, 4) ?? [] } };
    }
    case 'author_cases': {
      const n = state.cases?.length ?? 0;
      if (!n) return null;
      return { summary: `Authored ${n} test case(s).`, value: { count: n, titles: (state.cases ?? []).slice(0, 20).map((c) => c.title) } };
    }
    case 'author_plans': {
      const plans = Object.values(state.plansByCase ?? {});
      const planned = plans.filter((p) => p.status === 'planned').length;
      if (!plans.length) return null;
      return { summary: `Planned ${planned}/${plans.length} case(s).`, value: { planned, total: plans.length, failed: plans.filter((p) => p.status === 'failed').length } };
    }
    case 'compile_and_validate': {
      const comp = state.compilation;
      const ran = Boolean(comp && (comp.compilerVersion || comp.scripts?.length || comp.diagnostics?.length));
      if (!ran) return null;
      const ok = (comp!.scripts ?? []).filter((s) => s.ok).length;
      return { summary: `Compiled ${ok} script(s); ${comp!.diagnostics?.length ?? 0} diagnostic(s).`, value: { compiled: ok, diagnostics: (comp!.diagnostics ?? []).slice(0, 10).map((d) => ({ kind: d.kind, message: d.message })) } };
    }
    case 'execute_tests': {
      const agg = state.execution?.aggregate;
      if (!agg) return null;
      return { summary: `Executed ${agg.totalCases}: ${agg.passed} passed, ${agg.failed} failed.`, value: { total: agg.totalCases, passed: agg.passed, failed: agg.failed, durationMs: agg.durationMs } };
    }
    case 'investigate_failures': {
      const errs = state.errors?.length ?? 0;
      return { summary: errs ? `Investigated ${errs} diagnostic(s).` : 'Investigation complete.', value: { errorCount: errs } };
    }
    case 'finalize': {
      const o = state.output;
      return { summary: o?.summary ? String(o.summary).slice(0, 200) : `Run ${state.status}.`, value: { status: state.status, reason: o?.reason ?? null } };
    }
    default:
      return null;
  }
}

/**
 * Emit the full-fidelity transition when a run advances to a new stage. `prevStage` is the stage that just
 * completed (null at start); `state` is the run's real WorkflowState at this boundary. Best-effort +
 * flag-gated. Awaited so per-run seq ordering is deterministic, but it never throws.
 */
export async function recordRunStageProgress(
  runId: string,
  state: WorkflowState,
  stage: string,
  status: string,
  prevStage: string | null,
): Promise<void> {
  if (!isAgentNativeEnabled()) return;
  try {
    const bus = getMessageBus();
    const blackboard = getBlackboard();

    // 1. RESULT from the just-completed stage's agent, carrying the concrete artifact it produced.
    if (prevStage) {
      const fact = factForStage(prevStage, state);
      if (fact) {
        const agent = agentForStage(prevStage);
        await bus.publish({ runId, from: agent, to: ORCHESTRATOR, type: 'RESULT', payload: { stage: prevStage, summary: fact.summary, ...fact.value } });
        await blackboard.put(runId, `stage.result.${prevStage}`, fact.value, agent);
      }
    }

    // 2. HANDOFF: the orchestrator hands the run to the entering stage's agent (broadcast — any observer reads it).
    await bus.publish({ runId, from: ORCHESTRATOR, to: agentForStage(stage), type: 'HANDOFF', payload: { stage, status, prevStage, task: `Own the ${stage} stage.` } });
    // 3. Blackboard fact: the current run stage (append-only history of the run's progression).
    await blackboard.put(runId, 'run.stage', { stage, status, prevStage }, ORCHESTRATOR);
  } catch (err) {
    console.warn(`[run-instrumentation] failed to record stage '${stage}' for run ${runId} (non-fatal):`, (err as Error)?.message);
  }
}

/**
 * Terminal flush — emits the RESULT (+ blackboard fact) for the FINAL stage, whose RESULT the boundary-driven
 * path never gets to publish (there is no next transition to carry it). Call once when a run reaches a terminal
 * state so the transcript ends with the finalizer's actual outcome. Best-effort + flag-gated; never throws.
 */
export async function recordRunTerminal(runId: string, state: WorkflowState): Promise<void> {
  if (!isAgentNativeEnabled()) return;
  try {
    const fact = factForStage(state.stage, state);
    if (!fact) return;
    const agent = agentForStage(state.stage);
    await getMessageBus().publish({ runId, from: agent, to: ORCHESTRATOR, type: 'RESULT', payload: { stage: state.stage, summary: fact.summary, ...fact.value } });
    await getBlackboard().put(runId, `stage.result.${state.stage}`, fact.value, agent);
  } catch (err) {
    console.warn(`[run-instrumentation] failed terminal flush for run ${runId} (non-fatal):`, (err as Error)?.message);
  }
}

/**
 * Back-compat thin wrapper (kept for callers/tests that only have stage strings, not full state): records a
 * bare HANDOFF + run.stage fact with no artifact RESULT. Prefer recordRunStageProgress on the live pump.
 */
export async function recordRunStageTransition(
  runId: string,
  stage: string,
  status: string,
  prevStage: string | null,
): Promise<void> {
  if (!isAgentNativeEnabled()) return;
  try {
    await getMessageBus().publish({ runId, from: ORCHESTRATOR, to: agentForStage(stage), type: 'HANDOFF', payload: { stage, status, prevStage } });
    await getBlackboard().put(runId, 'run.stage', { stage, status, prevStage }, ORCHESTRATOR);
  } catch (err) {
    console.warn(`[run-instrumentation] failed to record stage '${stage}' for run ${runId} (non-fatal):`, (err as Error)?.message);
  }
}
