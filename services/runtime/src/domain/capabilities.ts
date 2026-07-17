/**
 * Capability catalog (Phase 3) — configuration-as-code, versioned and unit tested.
 * Each capability declares its accepted speech acts, entity types, evidence policy,
 * and action boundary (plan §14.2/§14.4). This is NOT a prompt catalog.
 */

import type {
  CapabilityId,
  EntityType,
  EvidenceRequirement,
  InteractionMode,
  SpeechAct,
} from './types';

export const CAPABILITY_RULES_VERSION = '1.0.0';

export interface CapabilityDefinition {
  id: CapabilityId;
  interaction: InteractionMode;
  acceptedSpeechActs: SpeechAct[];
  acceptedEntityTypes: EntityType[];
  /** Entity types that must be resolvable for a deterministic decision. */
  requiredEntityTypes: EntityType[];
  requiredEvidence: EvidenceRequirement[];
  /** Observed runtime evidence must outrank source inference for this capability. */
  observedEvidenceMandatory: boolean;
  sourceEvidenceAllowed: boolean;
  /** Capability may mutate workspace/run state. */
  mutating: boolean;
  handler: string;
}

export const CAPABILITIES: Record<CapabilityId, CapabilityDefinition> = {
  run_diagnostics: {
    id: 'run_diagnostics',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'explain', 'compare'],
    acceptedEntityTypes: ['run', 'execution', 'test_case', 'script'],
    requiredEntityTypes: ['run'],
    requiredEvidence: [
      { kind: 'execution_aggregate', required: true, subjectTypes: ['run'] },
      { kind: 'test_verdict', required: true, subjectTypes: ['run'] },
      { kind: 'error_detail', required: false },
      { kind: 'screenshot', required: false },
      { kind: 'defect', required: false },
      { kind: 'source_code', required: false },
    ],
    observedEvidenceMandatory: true,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'runDiagnostics',
  },
  execution_review: {
    id: 'execution_review',
    interaction: 'review',
    acceptedSpeechActs: ['ask', 'review', 'compare', 'explain'],
    acceptedEntityTypes: ['run', 'execution'],
    requiredEntityTypes: ['run'],
    requiredEvidence: [
      { kind: 'execution_aggregate', required: true },
      { kind: 'test_verdict', required: true },
    ],
    observedEvidenceMandatory: true,
    sourceEvidenceAllowed: false,
    mutating: false,
    handler: 'executionReview',
  },
  code_review: {
    id: 'code_review',
    interaction: 'review',
    acceptedSpeechActs: ['ask', 'review', 'explain'],
    acceptedEntityTypes: ['branch', 'review'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'source_code', required: true }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'codeReview',
  },
  test_generation: {
    id: 'test_generation',
    interaction: 'action',
    acceptedSpeechActs: ['create'],
    acceptedEntityTypes: ['app', 'module', 'page', 'requirement'],
    requiredEntityTypes: [],
    requiredEvidence: [
      { kind: 'knowledge', required: false },
      { kind: 'requirement', required: false },
      { kind: 'generated_case', required: false },
    ],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: true,
    handler: 'testGeneration',
  },
  api_testing: {
    id: 'api_testing',
    interaction: 'action',
    acceptedSpeechActs: ['ask', 'create', 'run', 'review'],
    acceptedEntityTypes: ['api_endpoint', 'run'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'workspace_record', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: true,
    handler: 'apiTesting',
  },
  automation: {
    id: 'automation',
    interaction: 'action',
    acceptedSpeechActs: ['run'],
    acceptedEntityTypes: ['test_suite', 'test_case', 'script', 'run'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'workspace_record', required: false }, { kind: 'generated_script', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: false,
    mutating: true,
    handler: 'automation',
  },
  requirement_review: {
    id: 'requirement_review',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'create', 'review', 'explain'],
    acceptedEntityTypes: ['requirement', 'module'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'requirement', required: false }, { kind: 'knowledge', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'requirementReview',
  },
  defect_analysis: {
    id: 'defect_analysis',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'explain', 'review', 'compare'],
    acceptedEntityTypes: ['defect', 'run', 'test_case'],
    requiredEntityTypes: ['defect'],
    requiredEvidence: [
      { kind: 'defect', required: true },
      { kind: 'test_verdict', required: false },
      { kind: 'source_code', required: false },
    ],
    observedEvidenceMandatory: true,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'defectAnalysis',
  },
  flow_analysis: {
    id: 'flow_analysis',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'explain'],
    acceptedEntityTypes: ['app', 'module', 'page', 'flow'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'knowledge', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'flowAnalysis',
  },
  architecture_review: {
    id: 'architecture_review',
    interaction: 'review',
    acceptedSpeechActs: ['ask', 'review', 'explain'],
    acceptedEntityTypes: ['project', 'branch'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'source_code', required: true }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'architectureReview',
  },
  documentation: {
    id: 'documentation',
    interaction: 'action',
    acceptedSpeechActs: ['create'],
    acceptedEntityTypes: ['requirement', 'report', 'artifact'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'workspace_record', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: true,
    handler: 'documentation',
  },
  workspace_action: {
    id: 'workspace_action',
    interaction: 'action',
    acceptedSpeechActs: ['create', 'modify'],
    acceptedEntityTypes: ['test_plan', 'test_suite', 'test_case', 'report', 'defect', 'run'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'workspace_record', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: false,
    mutating: true,
    handler: 'workspaceAction',
  },
  app_knowledge: {
    id: 'app_knowledge',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'explain', 'compare'],
    acceptedEntityTypes: ['app', 'module', 'page', 'object'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'knowledge', required: false }, { kind: 'source_code', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: true,
    mutating: false,
    handler: 'appKnowledge',
  },
  conversation_recall: {
    id: 'conversation_recall',
    interaction: 'answer',
    acceptedSpeechActs: ['ask', 'explain', 'compare'],
    acceptedEntityTypes: ['conversation', 'run', 'test_case', 'script', 'defect'],
    requiredEntityTypes: [],
    requiredEvidence: [{ kind: 'conversation_artifact', required: false }, { kind: 'decision', required: false }],
    observedEvidenceMandatory: false,
    sourceEvidenceAllowed: false,
    mutating: false,
    handler: 'conversationRecall',
  },
};

export function getCapability(id: CapabilityId): CapabilityDefinition {
  return CAPABILITIES[id];
}
