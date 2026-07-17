/**
 * Response recorder (Phase 5) — closes the state loop after a turn: persists the
 * assistant message with entity/evidence refs and refreshes the recency index so the
 * NEXT turn's resolver sees what this answer was about.
 */

import type { CapabilityDecision, EvidenceBundle } from '../domain/types';
import { canonicalMessages, entityRefIndex } from '../adapters/sessionRepository';

export async function recordAssistantResponse(input: {
  conversationId: string;
  requestId: string;
  causationMessageId?: string;
  answer: string;
  decision: CapabilityDecision;
  evidence: EvidenceBundle | null;
  manifestId: string;
}): Promise<{ messageId: string }> {
  const evidenceRefs = (input.evidence?.items || []).slice(0, 50).map((i) => ({
    artifactId: i.id, kind: i.kind, contentHash: i.integrity?.digest,
  }));
  const { message } = await canonicalMessages.append({
    conversationId: input.conversationId,
    role: 'assistant',
    kind: 'text',
    content: input.answer,
    payload: {
      capability: input.decision.capability,
      interaction: input.decision.interaction,
      manifestId: input.manifestId,
      evidenceGaps: (input.evidence?.gaps || []).map((g) => g.requirement.kind),
    },
    entityRefs: input.decision.resolvedEntities,
    artifactRefs: evidenceRefs,
    correlationId: input.requestId,
    causationId: input.causationMessageId,
  });

  for (const ref of input.decision.resolvedEntities.slice(0, 20)) {
    await entityRefIndex.upsert({
      conversationId: input.conversationId,
      entityType: ref.type,
      entityId: ref.id,
      relation: 'mentioned',
      sourceMessageId: message.id,
      salience: 1,
      metadata: { label: ref.label },
    }).catch(() => undefined);
  }
  return { messageId: message.id };
}
