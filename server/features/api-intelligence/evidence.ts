/**
 * APIEvidence assembly (spec §7). Builds redacted evidence records and registers metadata in the
 * shared Evidence Registry (payloads stay REDACTED on the run object; registry stays metadata-only).
 */
import { recordEvidence } from '../agent/evidence/registry';
import { PROVENANCE } from '../agent/evidence/provenance';
import { redactRequest, redactResponse } from './redact';
import type { ApiEndpoint, ApiEvidenceRecord, ApiExecution, ApiFinding, ApiRun, ApiScenario } from './types';

/** Build one redacted APIEvidence record from an execution + its findings. */
export function buildApiEvidence(
  endpoint: ApiEndpoint,
  scenario: ApiScenario,
  execution: ApiExecution,
  findings: ApiFinding[],
  environment: string,
): ApiEvidenceRecord {
  const differences = findings.filter((f) => f.severity !== 'info').map((f) => `${f.kind}: ${f.message}`);
  return {
    endpoint: endpoint.path,
    method: endpoint.method,
    scenarioId: scenario.id,
    request: redactRequest(execution.request),
    response: redactResponse(execution.response),
    status: execution.status,
    statusCode: execution.response?.status ?? null,
    latencyMs: execution.latencyMs,
    expected: scenario.expected,
    differences,
    environment,
    confidence: execution.status === 'pass' || execution.status === 'fail' ? 'verified-live' : 'unverified',
    timestamp: new Date().toISOString(),
  };
}

/** Attach redacted evidence to the run and register a single summary record in the Evidence Registry. */
export function recordApiEvidence(run: ApiRun, records: ApiEvidenceRecord[]): void {
  run.api_evidence = records;
  const anyLive = records.some((r) => r.confidence === 'verified-live');
  recordEvidence(run, {
    id: 'api',
    type: 'api',
    status: records.length ? 'present' : 'missing',
    source: PROVENANCE.API,
    confidence: anyLive ? 'verified-live' : 'unverified',
    producer: 'ApiExecutor',
    artifactCount: records.length,
    dependencies: ['metadata'],
    validationState: records.some((r) => r.status === 'fail') ? 'failed' : anyLive ? 'passed' : 'unvalidated',
    payloadRef: 'api_evidence',
  });
}
