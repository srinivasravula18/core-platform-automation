/**
 * Capability planner (Phase 5) — deterministic, auditable plans created BEFORE provider
 * invocation. Read-only capabilities use fixed step templates; the model may synthesize
 * prose over the plan but cannot add data sources or commands (plan §17.1).
 */

import { randomUUID } from 'crypto';
import type { CapabilityDecision, CapabilityPlan, EvidenceBundle, PlanBlocker, PlanStep } from '../domain/types';
import { CAPABILITIES } from '../domain/capabilities';

export const PLAN_VERSION = 1;

const STEP_TEMPLATES: Partial<Record<string, Array<{ id: string; description: string; evidenceKinds: string[] }>>> = {
  run_diagnostics: [
    { id: 'observe', description: 'Establish the observed outcome from the execution aggregate.', evidenceKinds: ['execution_aggregate'] },
    { id: 'identify', description: 'Identify the failing cases/scripts by verdict.', evidenceKinds: ['test_verdict'] },
    { id: 'correlate', description: 'Correlate each failure with its error detail, trace, log, and screenshot evidence.', evidenceKinds: ['error_detail', 'trace', 'screenshot', 'console_log', 'step_log'] },
    { id: 'explain', description: 'Explain the likely cause, distinguishing observed facts from inference.', evidenceKinds: ['error_detail', 'source_code'] },
    { id: 'gaps', description: 'List evidence gaps and the next recommended action.', evidenceKinds: [] },
  ],
  execution_review: [
    { id: 'aggregate', description: 'Summarize aggregate outcome, timing, and verdict distribution.', evidenceKinds: ['execution_aggregate', 'test_verdict'] },
    { id: 'assess', description: 'Assess stability and notable slow/flaky verdicts.', evidenceKinds: ['test_verdict'] },
  ],
  conversation_recall: [
    { id: 'collect', description: 'Collect the canonical conversation records and decisions in scope.', evidenceKinds: ['conversation_artifact', 'decision'] },
    { id: 'answer', description: 'Answer strictly from recorded conversation history — never invent history.', evidenceKinds: [] },
  ],
  defect_analysis: [
    { id: 'load', description: 'Load the defect record and its linked run/case outcome.', evidenceKinds: ['defect', 'test_verdict'] },
    { id: 'analyze', description: 'Analyze the observed failure evidence before any source reasoning.', evidenceKinds: ['error_detail', 'source_code'] },
  ],
  app_knowledge: [
    { id: 'ground', description: 'Ground the answer in validated knowledge and scoped source evidence.', evidenceKinds: ['knowledge', 'source_code'] },
  ],
};

const GENERIC_STEPS: PlanStep[] = [
  { id: 'ground', description: 'Use only the evidence bundle and session facts provided.', evidenceKinds: [] },
  { id: 'answer', description: 'Produce the response for the selected capability; state gaps explicitly.', evidenceKinds: [] },
];

export function createCapabilityPlan(decision: CapabilityDecision, bundle: EvidenceBundle): CapabilityPlan {
  const definition = CAPABILITIES[decision.capability];
  const blockers: PlanBlocker[] = [
    ...decision.missing.map((m) => ({ reason: m.reason, missing: m })),
    ...bundle.gaps.filter((g) => g.requirement.required).map((g) => ({ reason: `evidence gap: ${g.requirement.kind} — ${g.reason}` })),
  ];
  const steps = (STEP_TEMPLATES[decision.capability] as PlanStep[] | undefined) || GENERIC_STEPS;
  return {
    id: `plan-${randomUUID()}`,
    capability: decision.capability,
    subjectRefs: decision.resolvedEntities,
    steps,
    evidenceRequirements: definition.requiredEvidence,
    // Read-only phases expose no commands; mutation capabilities gain them only after cutover.
    permittedCommands: [],
    responseSchema: 'markdown/prose',
    blockers,
    version: PLAN_VERSION,
  };
}
