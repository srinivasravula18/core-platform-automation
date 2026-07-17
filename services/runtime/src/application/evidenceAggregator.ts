/**
 * Evidence Aggregator (Phase 4) — resolves a capability's evidence requirements through
 * platform providers (parallel collection, deterministic final order), enforces the
 * observed > recorded > derived > inferred authority order, retains contradictions,
 * and reports gaps explicitly. The LLM receives this bundle — never raw read tools.
 */

import { randomUUID } from 'crypto';
import type {
  CapabilityId,
  EntityRef,
  EvidenceBundle,
  EvidenceConflict,
  EvidenceGap,
  EvidenceItem,
  EvidenceRequirement,
  WorkspaceScope,
} from '../domain/types';
import { CAPABILITIES } from '../domain/capabilities';
import type { EvidenceProviderPort } from '../ports';
import { runEvidenceProvider } from '../adapters/runEvidenceProvider';
import { workspaceEvidenceProvider } from '../adapters/workspaceEvidenceProvider';
import { knowledgeEvidenceProvider } from '../adapters/knowledgeEvidenceProvider';
import { sourceEvidenceProvider } from '../adapters/sourceEvidenceProvider';

const AUTHORITY_ORDER: Record<string, number> = { observed: 0, recorded: 1, derived: 2, inferred: 3 };
const PER_PROVIDER_TIMEOUT_MS = 15_000;

export const defaultEvidenceProviders: EvidenceProviderPort[] = [
  runEvidenceProvider,
  workspaceEvidenceProvider,
  knowledgeEvidenceProvider,
  sourceEvidenceProvider,
];

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

/** Contradiction retention: same subject, both observed/recorded, opposing pass/fail facts. */
function detectContradictions(items: EvidenceItem[]): EvidenceConflict[] {
  const conflicts: EvidenceConflict[] = [];
  const verdictsByEntity = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    if (item.kind !== 'test_verdict') continue;
    for (const ref of item.entityRefs) {
      if (ref.type !== 'test_case') continue;
      const key = `${ref.type}:${ref.id}`;
      if (!verdictsByEntity.has(key)) verdictsByEntity.set(key, []);
      verdictsByEntity.get(key)!.push(item);
    }
  }
  for (const [key, group] of verdictsByEntity) {
    const statuses = new Set(group.map((i) => (/failed/i.test(i.summary) ? 'failed' : /passed/i.test(i.summary) ? 'passed' : 'other')));
    if (statuses.has('failed') && statuses.has('passed') && group.length > 1) {
      conflicts.push({
        evidenceIds: group.map((i) => i.id),
        description: `Conflicting verdicts recorded for ${key}; both retained — the model must not silently pick one.`,
      });
    }
  }
  return conflicts;
}

export interface AggregateEvidenceInput {
  capability: CapabilityId;
  subjectRefs: EntityRef[];
  scope: WorkspaceScope;
  conversationId?: string;
  /** Override the capability's declared requirements (rare; tests). */
  requirements?: EvidenceRequirement[];
  providers?: EvidenceProviderPort[];
}

export async function aggregateEvidence(input: AggregateEvidenceInput): Promise<EvidenceBundle> {
  const definition = CAPABILITIES[input.capability];
  const requirements = input.requirements || definition.requiredEvidence;
  const providers = input.providers || defaultEvidenceProviders;
  const collectedAt = new Date().toISOString();
  const gaps: EvidenceGap[] = [];
  const providerNames = new Set<string>();

  // Parallel collection per requirement; deterministic re-ordering afterwards.
  const perRequirement = await Promise.all(requirements.map(async (requirement) => {
    const matching = providers.filter((p) => p.supports(requirement));
    if (!matching.length) {
      if (requirement.required) gaps.push({ requirement, reason: 'no provider supports this evidence kind' });
      return [] as EvidenceItem[];
    }
    const results = await Promise.all(matching.map((provider) =>
      withTimeout(
        provider.collect({
          capability: input.capability,
          requirement,
          subjectRefs: input.subjectRefs,
          scope: input.scope,
          conversationId: input.conversationId,
        }).catch(() => [] as EvidenceItem[]),
        PER_PROVIDER_TIMEOUT_MS,
        [] as EvidenceItem[],
      )));
    const items = results.flat();
    for (const item of items) providerNames.add(item.source.provider);
    if (requirement.required && items.length === 0) {
      gaps.push({ requirement, reason: 'required evidence absent or inaccessible' });
    }
    return items;
  }));

  // Deterministic order: authority, then kind, then stable ID (plan §26 aggregation).
  const items = perRequirement.flat().sort((a, b) => {
    const auth = (AUTHORITY_ORDER[a.authority] ?? 9) - (AUTHORITY_ORDER[b.authority] ?? 9);
    if (auth !== 0) return auth;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });

  const observedFacts = items.filter((i) => i.authority === 'observed').flatMap((i) => i.facts);
  const derivedFacts = items.filter((i) => i.authority === 'derived' || i.authority === 'inferred').flatMap((i) => i.facts);

  return {
    id: `bundle-${randomUUID()}`,
    capability: input.capability,
    subjectRefs: input.subjectRefs,
    items,
    observedFacts,
    derivedFacts,
    contradictions: detectContradictions(items),
    gaps,
    manifest: {
      collectedAt,
      providers: [...providerNames].sort(),
      itemIds: items.map((i) => i.id),
      omitted: [],
    },
  };
}
