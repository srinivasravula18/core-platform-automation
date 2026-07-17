/**
 * Knowledge evidence provider (Phase 4) — validated feature knowledge (grounding modules)
 * as derived evidence. Reuses the existing per-feature knowledge base; bounded excerpt only.
 */

import { getFeatureGrounding } from '../../../../server/features/agent/knowledge';
import type { EvidenceItem, EvidenceRequest, EvidenceRequirement } from '../domain/types';
import type { EvidenceProviderPort } from '../ports';

const MAX_KNOWLEDGE_CHARS = 4_000;

export const knowledgeEvidenceProvider: EvidenceProviderPort = {
  supports(requirement: EvidenceRequirement): boolean {
    return requirement.kind === 'knowledge';
  },
  async collect(request: EvidenceRequest): Promise<EvidenceItem[]> {
    const topic = request.subjectRefs.map((r) => r.label || r.id).join(' ')
      || request.capability;
    let grounding = '';
    try {
      grounding = getFeatureGrounding({ prompt: topic, maxChars: MAX_KNOWLEDGE_CHARS }) || '';
    } catch {
      return [];
    }
    if (!grounding.trim()) return [];
    const id = `ev:knowledge:${request.capability}`;
    return [{
      id,
      kind: 'knowledge',
      authority: 'derived',
      source: { provider: 'knowledgeEvidence', ref: 'feature-knowledge-base' },
      entityRefs: request.subjectRefs,
      capturedAt: new Date().toISOString(),
      freshness: 'unknown',
      summary: `Validated feature knowledge for "${topic}" (${grounding.length} chars)`,
      facts: [{ statement: grounding.slice(0, MAX_KNOWLEDGE_CHARS), authority: 'derived', evidenceId: id }],
      redactions: [],
    }];
  },
};
