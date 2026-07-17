/**
 * Source evidence provider (Phase 4) — NARROW scoped source excerpts that explain an
 * observation. Lowest evidence tier: inferred-from-source, explicitly labeled, bounded.
 * Repository search never becomes a primary answer source for diagnostic capabilities.
 */

import { searchCodeInScope } from '../../../../server/features/projects/codeSearch';
import type { EvidenceItem, EvidenceRequest, EvidenceRequirement } from '../domain/types';
import type { EvidenceProviderPort } from '../ports';

const MAX_MATCHES = 5;
const MAX_EXCERPT_CHARS = 600;

export const sourceEvidenceProvider: EvidenceProviderPort = {
  supports(requirement: EvidenceRequirement): boolean {
    return requirement.kind === 'source_code';
  },
  async collect(request: EvidenceRequest): Promise<EvidenceItem[]> {
    // Query derives from the subjects under explanation — never a broad repo crawl.
    const query = request.subjectRefs.map((r) => r.label || '').filter(Boolean).join(' ').trim();
    if (!query) return [];
    let matches: any[] = [];
    try {
      const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
      const result: any = await searchCodeInScope(terms, { projectId: request.scope.projectId || undefined, appId: request.scope.appId || undefined });
      matches = Array.isArray(result?.matches) ? result.matches : [];
    } catch {
      return [];
    }
    return matches.slice(0, MAX_MATCHES).map((m: any, i: number) => {
      const id = `ev:source:${i}`;
      const file = String(m?.path || m?.file || 'unknown');
      const excerpt = String(m?.snippet || m?.line || m?.content || '').slice(0, MAX_EXCERPT_CHARS);
      return {
        id,
        kind: 'source_code' as const,
        authority: 'inferred' as const,
        source: { provider: 'sourceEvidence', ref: file },
        entityRefs: request.subjectRefs,
        capturedAt: new Date().toISOString(),
        freshness: 'current' as const,
        summary: `Source excerpt ${i + 1} relevant to "${query.slice(0, 80)}"`,
        facts: [{ statement: `implementation context: ${excerpt}`, authority: 'inferred' as const, evidenceId: id }],
        redactions: [],
      };
    });
  },
};
