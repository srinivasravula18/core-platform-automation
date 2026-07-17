/**
 * Conversational Intelligence Runtime — pure domain contracts (Phase 1).
 *
 * Plan of record: docs/diagnostics/conversational-intelligence-runtime-architecture-plan-2026-07-17.md.
 * This module is the shared domain language for the session aggregate, entity resolution,
 * capability routing, evidence aggregation, and planning. It is dependency-free by design:
 * no Express, no PostgreSQL, no provider SDKs (see the plan's dependency-direction rules).
 */

/* ---------- entities and references ---------- */

export type EntityType =
  | 'project' | 'app' | 'module' | 'page' | 'object' | 'record'
  | 'run' | 'execution' | 'test_case' | 'test_suite' | 'test_plan' | 'script'
  | 'defect' | 'report' | 'review' | 'requirement' | 'flow' | 'api_endpoint'
  | 'branch' | 'artifact' | 'conversation';

/** How a conversation came to hold a reference to an entity. */
export type EntityRelation = 'selected' | 'current' | 'latest' | 'generated' | 'mentioned' | 'failed' | 'linked';

export interface EntityRef {
  type: EntityType;
  id: string;
  /** Presentation label only — never used for identity or resolution ranking. */
  label?: string;
  projectId?: string;
  appId?: string;
}

export interface EntityCollectionRef {
  memberType: EntityType;
  ids: string[];
  /** What binds the collection together, e.g. the run that generated/failed them. */
  sourceRunId?: string;
  label?: string;
}

export interface PageRef { path: string; title?: string; appId?: string }
export interface BranchRef { repositoryId: string; branch: string }
export interface ArtifactRef { artifactId: string; kind: string; contentHash?: string }
export interface ArtifactSetRef { id: string; sourceRunId?: string; artifactRefs: ArtifactRef[] }

export interface GeneratedOutputRef {
  kind: 'cases' | 'scripts' | 'defects' | 'review' | 'plan' | 'flow' | 'api_doc' | 'report' | 'document';
  refs: EntityRef[];
  sourceRunId?: string;
  sourceMessageId?: string;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  summary: string;
  sourceMessageId?: string;
  sourceEventSeq?: number;
  supersededBy?: string;
  createdAt: string;
}

export interface GoalState {
  description: string;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
}

/* ---------- session aggregate ---------- */

export type CapabilityIntent = { capability: CapabilityId; interaction: InteractionMode };

/** Conversation-scoped engineering-session snapshot — durable working state, not prompt memory. */
export interface SessionContext {
  schemaVersion: 1;
  conversationId: string;
  workspaceId: string;
  ownerId: string;
  projectId: string | null;

  currentApp: EntityRef | null;
  currentModule: EntityRef | null;
  currentPage: PageRef | null;
  currentObject: EntityRef | null;
  currentRecord: EntityRef | null;
  currentExecution: EntityRef | null;
  currentTestSuite: EntityRef | null;
  currentDefect: EntityRef | null;
  currentBranch: BranchRef | null;
  currentArtifactSet: ArtifactSetRef | null;

  currentGoal: GoalState | null;
  currentIntent: CapabilityIntent | null;
  currentSelectedEntity: EntityRef | null;

  latestRun: EntityRef | null;
  latestReview: EntityRef | null;
  latestScripts: EntityCollectionRef | null;
  latestTestCases: EntityCollectionRef | null;
  generatedOutputs: GeneratedOutputRef[];
  recentDecisions: DecisionRecord[];

  activeEntities: EntityRef[];
  version: number;
  updatedAt: string;
}

export type SessionEventType =
  | 'ConversationStarted' | 'ScopeSelected' | 'EntitySelected' | 'GoalAccepted'
  | 'CapabilityRouted' | 'ArtifactGenerated' | 'RunStarted' | 'RunCompleted'
  | 'ReviewCompleted' | 'DecisionRecorded' | 'EntityInvalidated' | 'ConversationArchived'
  | 'SessionReconciled' | 'TurnAborted';

export interface SessionEvent {
  conversationId: string;
  seq: number;
  eventId: string;
  eventType: SessionEventType;
  payload: Record<string, unknown>;
  /** Idempotent projection key, e.g. `runId:projectionVersion:status`. */
  sourceKey: string;
  correlationId?: string | null;
  causationId?: string | null;
  actorId?: string | null;
  createdAt: string;
}

/* ---------- canonical conversation message ---------- */

export type MessageKind =
  | 'text' | 'cases' | 'scripts' | 'run' | 'review' | 'defects' | 'plan'
  | 'flow' | 'api_doc' | 'report' | 'clarification' | 'error';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  content: string;
  /** Structured references and bounded display data; full bodies live in domain/artifact stores. */
  payload: Record<string, unknown>;
  entityRefs: EntityRef[];
  artifactRefs: ArtifactRef[];
  correlationId: string;
  causationId?: string;
  createdAt: string;
}

/* ---------- entity resolution ---------- */

export type ReferenceExpressionKind =
  | 'explicit_id' | 'explicit_name' | 'pronoun' | 'collection' | 'ordinal' | 'recency' | 'ellipsis';

export interface ResolutionProvenance {
  tier: 'selected_entity' | 'artifact_set' | 'latest_run' | 'conversation_recency' | 'workspace' | 'repository';
  detail?: string;
}

export interface CandidateTrace {
  candidate: EntityRef;
  tier: ResolutionProvenance['tier'];
  accepted: boolean;
  reason: string;
}

export interface ReferenceBinding {
  expression: string;
  expressionKind: ReferenceExpressionKind;
  expectedTypes: EntityType[];
  resolved: EntityRef[];
  status: 'resolved' | 'ambiguous' | 'unresolved';
  provenance: ResolutionProvenance[];
  candidatesConsidered: CandidateTrace[];
}

export interface WorkspaceScope {
  workspaceId: string;
  ownerId: string;
  projectId?: string | null;
  appId?: string | null;
}

export interface ResolutionRequest {
  utterance: string;
  session: SessionContext;
  recentMessages: ConversationMessage[];
  workspaceScope: WorkspaceScope;
  explicitSelections: EntityRef[];
}

/* ---------- capability routing ---------- */

export type CapabilityId =
  | 'run_diagnostics' | 'execution_review' | 'code_review' | 'test_generation'
  | 'api_testing' | 'automation' | 'requirement_review' | 'defect_analysis'
  | 'flow_analysis' | 'architecture_review' | 'documentation' | 'workspace_action'
  | 'app_knowledge' | 'conversation_recall';

export type InteractionMode = 'answer' | 'action' | 'review' | 'clarify';

export type SpeechAct = 'ask' | 'create' | 'run' | 'modify' | 'review' | 'explain' | 'compare';

export interface EvidenceRequirement {
  kind: EvidenceKind;
  /** When true, the capability cannot proceed without this evidence class. */
  required: boolean;
  subjectTypes?: EntityType[];
}

export interface MissingRequirement {
  requirement: EvidenceRequirement | { entityType: EntityType };
  reason: string;
}

export interface CapabilityDecision {
  capability: CapabilityId;
  interaction: InteractionMode;
  resolvedEntities: EntityRef[];
  requiredEvidence: EvidenceRequirement[];
  missing: MissingRequirement[];
  confidence: 'deterministic' | 'ambiguous';
  reasonCodes: string[];
}

/* ---------- evidence ---------- */

export type EvidenceKind =
  | 'execution_aggregate' | 'test_verdict' | 'error_detail' | 'screenshot' | 'trace'
  | 'console_log' | 'network_log' | 'step_log' | 'generated_case' | 'generated_script'
  | 'defect' | 'report' | 'review' | 'requirement' | 'workspace_record'
  | 'knowledge' | 'source_code' | 'conversation_artifact' | 'decision';

export type EvidenceAuthority = 'observed' | 'recorded' | 'derived' | 'inferred';

export interface EvidenceSource { provider: string; ref?: string }

export interface EvidenceFact {
  statement: string;
  authority: EvidenceAuthority;
  evidenceId: string;
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  authority: EvidenceAuthority;
  source: EvidenceSource;
  entityRefs: EntityRef[];
  occurredAt?: string;
  capturedAt: string;
  freshness: 'current' | 'stale' | 'unknown';
  integrity?: { algorithm: 'sha256'; digest: string };
  summary: string;
  payloadRef?: ArtifactRef;
  facts: EvidenceFact[];
  redactions: string[];
}

export interface EvidenceConflict {
  evidenceIds: string[];
  description: string;
}

export interface EvidenceGap {
  requirement: EvidenceRequirement;
  reason: string;
}

export interface EvidenceManifest {
  collectedAt: string;
  providers: string[];
  itemIds: string[];
  omitted: Array<{ itemId: string; reason: string }>;
}

export interface EvidenceBundle {
  id: string;
  capability: CapabilityId;
  subjectRefs: EntityRef[];
  items: EvidenceItem[];
  observedFacts: EvidenceFact[];
  derivedFacts: EvidenceFact[];
  contradictions: EvidenceConflict[];
  gaps: EvidenceGap[];
  manifest: EvidenceManifest;
}

export interface EvidenceRequest {
  capability: CapabilityId;
  requirement: EvidenceRequirement;
  subjectRefs: EntityRef[];
  scope: WorkspaceScope;
  /** Conversation link for conversation-scoped providers (run lookup, artifacts, decisions). */
  conversationId?: string;
}

/* ---------- planning ---------- */

export interface PlanStep {
  id: string;
  description: string;
  evidenceKinds: EvidenceKind[];
}

export interface CapabilityCommand {
  name: string;
  targetRefs: EntityRef[];
}

export interface PlanBlocker {
  reason: string;
  missing?: MissingRequirement;
}

export interface CapabilityPlan {
  id: string;
  capability: CapabilityId;
  subjectRefs: EntityRef[];
  steps: PlanStep[];
  evidenceRequirements: EvidenceRequirement[];
  permittedCommands: CapabilityCommand[];
  responseSchema: string;
  blockers: PlanBlocker[];
  version: number;
}
