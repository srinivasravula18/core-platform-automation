/**
 * Persistence adapters for the Conversational Runtime (Phase 1).
 *
 * Thin delegation to core/persistence — PostgreSQL when configured, the single-process
 * JSON store otherwise. All concurrency/idempotency semantics live in the repository
 * layer; this file only maps repository rows onto the runtime port contracts.
 */

import {
  CanonicalMessages,
  ConversationEntityRefs,
  ConversationSessions,
  AgentRuns,
} from '../../../../core/persistence';
import type { ConversationMessage } from '../domain/types';
import type {
  AppendMessageCommand,
  CanonicalMessagePort,
  EntityRefIndexPort,
  RunReadPort,
  RunScope,
  SessionCommitCommand,
  SessionCommitOutcome,
  SessionRepositoryPort,
  StoredEntityRef,
  StoredSession,
} from '../ports';

export const sessionRepository: SessionRepositoryPort = {
  async get(conversationId: string): Promise<StoredSession | null> {
    return (await ConversationSessions.get(conversationId)) as StoredSession | null;
  },
  async commit(command: SessionCommitCommand): Promise<SessionCommitOutcome> {
    return (await ConversationSessions.commit(command as any)) as SessionCommitOutcome;
  },
  async listEvents(conversationId: string, sinceSeq = 0) {
    return (await ConversationSessions.listEvents(conversationId, sinceSeq)) as any;
  },
};

function toConversationMessage(row: any): ConversationMessage {
  return {
    id: row.messageId,
    conversationId: row.conversationId,
    sequence: row.seq,
    role: row.role,
    kind: row.kind || 'text',
    content: row.content || '',
    payload: row.payload || {},
    entityRefs: row.entityRefs || [],
    artifactRefs: row.artifactRefs || [],
    correlationId: row.correlationId || '',
    causationId: row.causationId || undefined,
    createdAt: row.createdAt,
  };
}

export const canonicalMessages: CanonicalMessagePort = {
  async append(command: AppendMessageCommand) {
    const { message, deduplicated } = await CanonicalMessages.append(command as any);
    return { message: toConversationMessage(message), deduplicated };
  },
  async list(conversationId: string, opts = {}) {
    const rows = await CanonicalMessages.list(conversationId, opts);
    return rows.map(toConversationMessage);
  },
};

export const entityRefIndex: EntityRefIndexPort = {
  async upsert(ref) {
    return (await ConversationEntityRefs.upsert(ref)) as StoredEntityRef;
  },
  async list(conversationId: string, opts = {}) {
    return (await ConversationEntityRefs.list(conversationId, opts)) as StoredEntityRef[];
  },
};

export const runReader: RunReadPort = {
  async getScoped(runId: string, scope: RunScope = {}) {
    return AgentRuns.getScoped(runId, scope);
  },
  async listByConversation(conversationId: string, opts = {}) {
    return AgentRuns.listByConversation(conversationId, opts);
  },
  async latestByConversation(conversationId: string, opts = {}) {
    return AgentRuns.latestByConversation(conversationId, opts);
  },
};
