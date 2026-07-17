/**
 * Conversational Intelligence Runtime — infrastructure ports (Phase 1).
 *
 * Application services depend on these interfaces only; concrete adapters live in
 * services/runtime/src/adapters and delegate to existing server modules. The domain
 * layer never imports an adapter (see the plan's dependency-direction diagram).
 */

import type {
  ArtifactRef,
  CapabilityId,
  ConversationMessage,
  EntityRef,
  EvidenceItem,
  EvidenceRequest,
  EvidenceRequirement,
  SessionContext,
  SessionEvent,
  SessionEventType,
} from './domain/types';

/* ---------- session persistence ---------- */

export interface SessionCommitCommand {
  conversationId: string;
  ownerId?: string;
  workspaceId?: string;
  projectId?: string | null;
  state?: SessionContext;
  expectedVersion?: number;
  events?: Array<{
    eventId?: string;
    eventType: SessionEventType;
    payload?: Record<string, unknown>;
    sourceKey: string;
    correlationId?: string;
    causationId?: string;
    actorId?: string;
  }>;
}

export interface StoredSession {
  conversationId: string;
  ownerId: string;
  workspaceId: string;
  projectId: string | null;
  state: Partial<SessionContext>;
  version: number;
  schemaVersion: number;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type SessionCommitOutcome =
  | { ok: true; session: StoredSession; appendedEvents: number }
  | { ok: false; conflict: true; currentVersion: number };

export interface SessionRepositoryPort {
  get(conversationId: string): Promise<StoredSession | null>;
  commit(command: SessionCommitCommand): Promise<SessionCommitOutcome>;
  listEvents(conversationId: string, sinceSeq?: number): Promise<SessionEvent[]>;
}

/* ---------- canonical messages ---------- */

export interface AppendMessageCommand {
  conversationId: string;
  workspaceId?: string;
  title?: string;
  clientMessageId?: string;
  role: 'user' | 'assistant';
  kind?: string;
  content: string;
  payload?: Record<string, unknown>;
  entityRefs?: EntityRef[];
  artifactRefs?: ArtifactRef[];
  correlationId?: string;
  causationId?: string;
}

export interface CanonicalMessagePort {
  append(command: AppendMessageCommand): Promise<{ message: ConversationMessage; deduplicated: boolean }>;
  list(conversationId: string, opts?: { beforeSeq?: number; limit?: number }): Promise<ConversationMessage[]>;
}

/* ---------- entity recency index ---------- */

export interface StoredEntityRef {
  id: string;
  conversationId: string;
  entityType: string;
  entityId: string;
  relation: string;
  sourceMessageId: string | null;
  sourceEventSeq: number | null;
  sourceRunId: string;
  projectId: string;
  appId: string;
  ownerId: string;
  salience: number;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityRefIndexPort {
  upsert(ref: {
    conversationId: string; entityType: string; entityId: string; relation: string;
    sourceMessageId?: string; sourceEventSeq?: number; sourceRunId?: string;
    projectId?: string; appId?: string; ownerId?: string; salience?: number;
    metadata?: Record<string, unknown>;
  }): Promise<StoredEntityRef>;
  list(conversationId: string, opts?: { entityType?: string; relation?: string; limit?: number }): Promise<StoredEntityRef[]>;
}

/* ---------- run reads (scoped; never global list-and-filter) ---------- */

export interface RunScope { ownerId?: string; projectId?: string; appId?: string }

export interface RunReadPort {
  getScoped(runId: string, scope?: RunScope): Promise<any | null>;
  listByConversation(conversationId: string, opts?: { limit?: number; scope?: RunScope }): Promise<any[]>;
  latestByConversation(conversationId: string, opts?: { terminal?: boolean; scope?: RunScope }): Promise<any | null>;
}

/* ---------- evidence (capability-owned providers, not model tools) ---------- */

export interface EvidenceProviderPort {
  supports(requirement: EvidenceRequirement): boolean;
  collect(request: EvidenceRequest): Promise<EvidenceItem[]>;
}

/* ---------- artifact bytes (refs in context; bodies behind this port) ---------- */

export interface ArtifactStorePort {
  put(body: unknown, meta: { kind: string; conversationId?: string }): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<unknown | null>;
}

/* ---------- provider-neutral LLM gateway ---------- */

export interface PreparedInvocation {
  capability: CapabilityId;
  systemContract: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  task: string;
  manifestId?: string;
}

export interface LLMPort {
  invoke(invocation: PreparedInvocation): Promise<{ text: string; usage?: Record<string, number> }>;
}
