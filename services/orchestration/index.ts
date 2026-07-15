/**
 * The workflow boundary (LangGraph migration, Phase 1 — Section 11). Other code imports the new agent
 * workflow runtime from here, not from `server/features/agent/workflow/*` directly, so the internal layout
 * of that directory can keep changing across phases without every caller needing to know its shape.
 */
export const orchestrationServiceBoundary = 'agentic-orchestration';

export {
  WORKFLOW_STATE_SCHEMA_VERSION,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_ENGINES,
  WORKFLOW_STATUSES,
  WorkflowStateAnnotation,
  createInitialWorkflowState,
  parseWorkflowState,
  workflowStateSchema,
  assertNoSecretLeakage,
  SecretLeakageError,
  type WorkflowEngine,
  type WorkflowStatus,
  type WorkflowState,
  type WorkflowStateUpdate,
  type CreateInitialWorkflowStateInput,
  type CredentialRef,
  type WorkflowRequest,
  type MissionRef,
} from '../../server/features/agent/workflow/state';

export {
  WORKFLOW_ERROR_CLASSES,
  getRetryPolicy,
  isRetryableError,
  classifyError,
  parseWorkflowError,
  WorkflowRuntimeError,
  type WorkflowErrorClass,
  type WorkflowError,
  type RetryPolicy,
} from '../../server/features/agent/workflow/errors';

export {
  MAX_IN_STATE_EVENTS,
  eventIdempotencyKey,
  appendWorkflowEvents,
  startEvent,
  terminalEvent,
  type WorkflowEvent,
  type WorkflowEventStatus,
  type NodeAttemptIdentity,
} from '../../server/features/agent/workflow/events';

export {
  getWorkflowCheckpointer,
  closeWorkflowCheckpointer,
  isWorkflowGraphEnabled,
} from '../../server/features/agent/workflow/checkpointer';

export {
  reconcileRunIfOrphaned,
  reconcileOrphanedRunsOnStartup,
  orphanedRunFailure,
  isGraphRunActive,
} from '../../server/features/agent/workflow/runtime';
