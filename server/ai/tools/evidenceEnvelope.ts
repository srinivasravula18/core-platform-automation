import type { EvidenceResult, LiveEvidenceScopeKind } from './types';

type EvidenceInput = {
  subject: string;
  scope: { kind: LiveEvidenceScopeKind; id?: string; label?: string };
  method: string;
  operation: string;
  complete: boolean;
  returned?: number;
  total?: number;
};

function inferredCount(payload: Record<string, unknown>): number {
  for (const value of Object.values(payload)) if (Array.isArray(value)) return value.length;
  return 0;
}

export function withEvidence<T extends Record<string, unknown>>(payload: T, input: EvidenceInput): EvidenceResult<T> {
  const returned = input.returned ?? inferredCount(payload);
  return {
    ...payload,
    evidence: {
      subject: input.subject,
      scope: input.scope,
      source: { method: input.method, operation: input.operation },
      completeness: {
        complete: input.complete,
        returned,
        ...(input.total == null ? {} : { total: input.total }),
      },
      observedAt: new Date().toISOString(),
    },
  };
}
