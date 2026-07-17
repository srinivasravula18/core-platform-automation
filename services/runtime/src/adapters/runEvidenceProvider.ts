/**
 * Run diagnostics evidence provider (Phase 4) — loads the conversation-linked AgentRun
 * envelope by indexed lookup (never a global list-and-filter) and emits normalized,
 * redacted evidence items: aggregate outcome, per-test verdicts, bounded error details,
 * screenshot/trace refs, and linked defects (plan §15.3).
 */

import { AgentRuns } from '../../../../core/persistence';
import { Defects } from '../../../../server/db/repository';
import { redactSecrets } from '../../../../server/ai/memory/artifactMemory';
import type { EntityRef, EvidenceItem, EvidenceKind, EvidenceRequest, EvidenceRequirement } from '../domain/types';
import type { EvidenceProviderPort } from '../ports';

const SUPPORTED: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'execution_aggregate', 'test_verdict', 'error_detail', 'screenshot', 'trace', 'console_log', 'step_log', 'defect',
]);

const MAX_ERROR_CHARS = 800;

function nowIso(): string { return new Date().toISOString(); }

function runRef(run: any): EntityRef {
  return { type: 'run', id: String(run.id), label: run.artifactName || undefined };
}

/** Resolve the subject run: explicit ref first, else latest terminal run for the conversation. */
async function resolveRun(request: EvidenceRequest): Promise<any | null> {
  const explicit = request.subjectRefs.find((r) => r.type === 'run' || r.type === 'execution');
  if (explicit) {
    const run = await AgentRuns.getScoped(explicit.id, {
      ownerId: request.scope.ownerId || undefined,
      projectId: request.scope.projectId || undefined,
    });
    if (run) return run;
  }
  if (request.conversationId) {
    return AgentRuns.latestByConversation(request.conversationId, {
      terminal: true,
      scope: { ownerId: request.scope.ownerId || undefined, projectId: request.scope.projectId || undefined },
    });
  }
  return null;
}

function aggregateItem(run: any): EvidenceItem | null {
  const result = run.execution_result;
  if (!result || typeof result !== 'object') return null;
  const id = `ev:${run.id}:aggregate`;
  const summary = `Run ${run.id}: ${result.passed ?? 0} passed, ${result.failed ?? 0} failed, ${result.skipped ?? 0} skipped of ${result.total ?? 0}` +
    (result.error ? `; run-level error: ${String(result.error).slice(0, 200)}` : '');
  return {
    id,
    kind: 'execution_aggregate',
    authority: 'observed',
    source: { provider: 'runEvidence', ref: String(run.id) },
    entityRefs: [runRef(run)],
    occurredAt: run.completed_at || run.updatedAt || undefined,
    capturedAt: nowIso(),
    freshness: 'current',
    summary,
    facts: [
      { statement: `ok=${!!result.ok} total=${result.total ?? 0} passed=${result.passed ?? 0} failed=${result.failed ?? 0}`, authority: 'observed', evidenceId: id },
    ],
    redactions: [],
  };
}

function verdictItems(run: any): EvidenceItem[] {
  const tests: any[] = Array.isArray(run.execution_result?.tests) ? run.execution_result.tests : [];
  return tests.slice(0, 50).map((t, i) => {
    const id = `ev:${run.id}:test:${i}`;
    const status = String(t?.status || 'unknown');
    const title = String(t?.title || `test ${i + 1}`);
    return {
      id,
      kind: 'test_verdict' as const,
      authority: 'observed' as const,
      source: { provider: 'runEvidence', ref: `${run.id}#${i}` },
      entityRefs: [runRef(run), { type: 'test_case' as const, id: String(t?.caseId || title), label: title }],
      occurredAt: run.completed_at || undefined,
      capturedAt: nowIso(),
      freshness: 'current' as const,
      summary: `${title}: ${status}${t?.durationMs ? ` (${t.durationMs}ms)` : ''}`,
      facts: [{ statement: `"${title}" → ${status}`, authority: 'observed' as const, evidenceId: id }],
      redactions: [],
    };
  });
}

function errorItems(run: any): EvidenceItem[] {
  const tests: any[] = Array.isArray(run.execution_result?.tests) ? run.execution_result.tests : [];
  return tests
    .filter((t) => String(t?.status || '').toLowerCase() === 'failed' && t?.error)
    .slice(0, 20)
    .map((t, i) => {
      const id = `ev:${run.id}:error:${i}`;
      const title = String(t?.title || `failed test ${i + 1}`);
      const error = String(redactSecrets(String(t.error)) ?? t.error).slice(0, MAX_ERROR_CHARS);
      return {
        id,
        kind: 'error_detail' as const,
        authority: 'observed' as const,
        source: { provider: 'runEvidence', ref: `${run.id}#${title}` },
        entityRefs: [runRef(run), { type: 'test_case' as const, id: String(t?.caseId || title), label: title }],
        capturedAt: nowIso(),
        freshness: 'current' as const,
        summary: `"${title}" failed: ${error.slice(0, 200)}`,
        facts: [{ statement: `failure detail for "${title}": ${error}`, authority: 'observed' as const, evidenceId: id }],
        redactions: ['secret-keys'],
      };
    });
}

function screenshotItems(run: any): EvidenceItem[] {
  const shots: any[] = Array.isArray(run.evidence_screenshots) ? run.evidence_screenshots : [];
  return shots.slice(0, 20).map((s, i) => {
    const id = `ev:${run.id}:shot:${i}`;
    const ref = String(s?.url || s?.path || s?.id || `${run.id}:shot:${i}`);
    return {
      id,
      kind: 'screenshot' as const,
      authority: 'observed' as const,
      source: { provider: 'runEvidence', ref },
      entityRefs: [runRef(run)],
      capturedAt: nowIso(),
      freshness: 'current' as const,
      summary: `Screenshot ${s?.label || s?.name || i + 1} (ref only — bytes stay out of context)`,
      payloadRef: { artifactId: ref, kind: 'screenshot' },
      facts: [],
      redactions: [],
    };
  });
}

async function defectItems(run: any): Promise<EvidenceItem[]> {
  const defects = (await Defects.list().catch(() => []))
    .filter((d: any) => d && (d.sourceRunId === run.id || d.linkedRunId === run.id))
    .slice(0, 10);
  return defects.map((d: any) => {
    const id = `ev:${run.id}:defect:${d.id}`;
    return {
      id,
      kind: 'defect' as const,
      authority: 'recorded' as const,
      source: { provider: 'runEvidence', ref: d.id },
      entityRefs: [runRef(run), { type: 'defect' as const, id: String(d.id), label: d.title }],
      capturedAt: nowIso(),
      freshness: 'current' as const,
      summary: `Defect ${d.id} (${d.severity || 'Medium'}): ${String(d.title || '').slice(0, 160)}`,
      facts: [{ statement: `linked defect ${d.id}: ${d.title}`, authority: 'recorded' as const, evidenceId: id }],
      redactions: [],
    };
  });
}

export const runEvidenceProvider: EvidenceProviderPort = {
  supports(requirement: EvidenceRequirement): boolean {
    return SUPPORTED.has(requirement.kind);
  },
  async collect(request: EvidenceRequest): Promise<EvidenceItem[]> {
    const run = await resolveRun(request);
    if (!run) return [];
    switch (request.requirement.kind) {
      case 'execution_aggregate': { const item = aggregateItem(run); return item ? [item] : []; }
      case 'test_verdict': return verdictItems(run);
      case 'error_detail': return errorItems(run);
      case 'screenshot': return screenshotItems(run);
      case 'defect': return defectItems(run);
      case 'trace':
      case 'console_log':
      case 'step_log': {
        // Per-test evidence paths live inside execution_result tests when captured.
        const tests: any[] = Array.isArray(run.execution_result?.tests) ? run.execution_result.tests : [];
        const key = request.requirement.kind === 'trace' ? 'tracePath' : request.requirement.kind === 'console_log' ? 'consolePath' : 'stepLogPath';
        return tests
          .filter((t) => t?.[key])
          .slice(0, 10)
          .map((t, i) => {
            const id = `ev:${run.id}:${request.requirement.kind}:${i}`;
            return {
              id,
              kind: request.requirement.kind,
              authority: 'observed' as const,
              source: { provider: 'runEvidence', ref: String(t[key]) },
              entityRefs: [runRef(run)],
              capturedAt: nowIso(),
              freshness: 'current' as const,
              summary: `${request.requirement.kind} for "${t?.title || i}" (ref only)`,
              payloadRef: { artifactId: String(t[key]), kind: request.requirement.kind },
              facts: [],
              redactions: [],
            };
          });
      }
      default: return [];
    }
  },
};
