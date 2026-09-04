import { randomUUID } from 'node:crypto';
import { AgentRuns } from '../../db/repository';
import { beginExternalOperationReceipt, clearOperationReceiptResource, completeOperationReceipt, failOperationReceipt, restartExternalOperationReceipt, setOperationReceiptResource } from '../../ai/agent-runtime/operationReceipts';
import { redactSecrets } from '../../ai/memory/artifactMemory';
import { resolveCredentials } from '../credentials/credentialsService';
import { getProject, listApps } from '../projects/projectService';
import { startResolvedRun } from '../agent/startService';
import { buildGylinGoal, normalizeApplicationUrl, type GylinEvidence, type GylinRunRequest, type GylinRunResponse } from './contract';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'review_required', 'coverage_options']);
const DEFAULT_WAIT_MS = 285_000;
const DEFAULT_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class GylinServiceError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
  }
}

interface GylinServiceDeps {
  apps: typeof listApps;
  project: typeof getProject;
  credentials: typeof resolveCredentials;
  beginReceipt: typeof beginExternalOperationReceipt;
  restartReceipt: typeof restartExternalOperationReceipt;
  setResource: typeof setOperationReceiptResource;
  clearResource: typeof clearOperationReceiptResource;
  completeReceipt: typeof completeOperationReceipt;
  failReceipt: typeof failOperationReceipt;
  startRun: typeof startResolvedRun;
  getRun: typeof AgentRuns.get;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
}

const defaultDeps: GylinServiceDeps = {
  apps: listApps,
  project: getProject,
  credentials: resolveCredentials,
  beginReceipt: beginExternalOperationReceipt,
  restartReceipt: restartExternalOperationReceipt,
  setResource: setOperationReceiptResource,
  clearResource: clearOperationReceiptResource,
  completeReceipt: completeOperationReceipt,
  failReceipt: failOperationReceipt,
  startRun: startResolvedRun,
  getRun: AgentRuns.get.bind(AgentRuns),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  uuid: randomUUID,
};

export async function runGylinRequest(input: GylinRunRequest, overrides: Partial<GylinServiceDeps> = {}, signal?: AbortSignal): Promise<GylinRunResponse> {
  const deps = { ...defaultDeps, ...overrides };
  const matches = deps.apps().filter((app) => {
    try { return Boolean(app.baseUrl) && normalizeApplicationUrl(app.baseUrl!) === input.applicationUrl; }
    catch { return false; }
  });
  if (!matches.length) throw new GylinServiceError(422, 'TARGET_NOT_CONFIGURED', 'The candidate target is not configured in TestFlow.');
  if (matches.length > 1) throw new GylinServiceError(409, 'TARGET_AMBIGUOUS', 'The candidate target matches multiple TestFlow Apps.');
  const app = matches[0];
  const project = deps.project(app.projectId);
  if (!project) throw new GylinServiceError(422, 'TARGET_NOT_CONFIGURED', 'The configured App has no owning Project.');
  if (!project.ownerId) throw new GylinServiceError(422, 'TARGET_OWNER_NOT_CONFIGURED', 'The configured Project has no owning user for credential scope.');
  const credential = deps.credentials({ targetUrl: input.applicationUrl, baseUrl: app.baseUrl, ownerId: project.ownerId });
  if (!credential || (!credential.username && !(credential as any).token)) {
    throw new GylinServiceError(422, 'CREDENTIALS_NOT_CONFIGURED', 'No usable credential is configured for this App and owner.');
  }

  const ttlMs = Math.max(DEFAULT_RECEIPT_TTL_MS, Number(process.env.GYLIN_RECEIPT_TTL_MS) || 0);
  let receiptResult = await deps.beginReceipt({
    namespace: 'gylin', externalKey: input.idempotencyKey, operation: 'gylin.run', request: input, ttlMs,
  });
  if (receiptResult.receipt.requestHash !== receiptResult.requestHash) {
    throw new GylinServiceError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different request.');
  }
  if (!receiptResult.acquired && receiptResult.receipt.status === 'completed') {
    return receiptResult.receipt.response as GylinRunResponse;
  }
  if (!receiptResult.acquired && receiptResult.receipt.status === 'failed' && !receiptResult.receipt.resourceId) {
    receiptResult = await deps.restartReceipt(receiptResult.receipt.idempotencyKey, receiptResult.requestHash, ttlMs);
  }

  let runId = receiptResult.receipt.resourceId;
  if (!runId && receiptResult.acquired) {
    runId = `tf-${deps.uuid()}`;
    const receivedAt = new Date(deps.now()).toISOString();
    try {
      // Record the chosen run id before starting expensive work so a concurrent retry can never create a duplicate.
      await deps.setResource(receiptResult.receipt.idempotencyKey, runId);
      await deps.startRun({
        runId,
        projectId: project.id,
        appId: app.id,
        ownerId: project.ownerId,
        targetUrl: input.applicationUrl,
        prompt: buildGylinGoal(input),
        requestedCaseCount: input.acceptanceCriteria.length,
        reviewPolicy: 'auto',
        executionPolicy: 'auto',
        mission: {
          platformType: 'web', platform: 'RUNTIME', runtimeSurface: null,
          applicationId: app.id, moduleId: null, tabId: null,
          targetUrl: input.applicationUrl, executionScope: `story:${input.storyId}`,
        },
        credential: { username: credential.username, password: credential.password, token: (credential as any).token },
        safeMetadata: {
          status: 'running', source: 'gylin', projectId: project.id, appId: app.id, ownerId: project.ownerId || '',
          integrationMetadata: {
            source: 'gylin', storyId: input.storyId, candidateCommit: input.candidateCommit,
            idempotencyKeyHash: receiptResult.receipt.idempotencyKey, projectId: project.id, appId: app.id, receivedAt,
          },
        },
      });
    } catch (error) {
      const durableRun = await deps.getRun(runId).catch(() => null);
      if (!durableRun) await deps.clearResource(receiptResult.receipt.idempotencyKey, runId).catch(() => undefined);
      await deps.failReceipt(receiptResult.receipt.idempotencyKey, new Error('TestFlow workflow start failed'));
      throw new GylinServiceError(500, 'RUN_START_FAILED', 'TestFlow could not start the existing workflow runtime.');
    }
  }
  if (!runId) throw new GylinServiceError(503, 'RUN_STARTING', 'The existing run is still being registered.', 5);

  const waitMs = Math.min(285_000, Math.max(1, Number(process.env.GYLIN_WAIT_TIMEOUT_MS) || DEFAULT_WAIT_MS));
  const deadline = deps.now() + waitMs;
  while (deps.now() <= deadline) {
    if (signal?.aborted) throw new GylinServiceError(503, 'REQUEST_ABORTED', 'The caller disconnected while the TestFlow run continued.', 5);
    const run = await deps.getRun(runId);
    if (run && TERMINAL.has(String(run.status || ''))) {
      const response = projectTerminalRun(run, input);
      await deps.completeReceipt(receiptResult.receipt.idempotencyKey, response, { runId, status: run.status });
      return response;
    }
    await deps.sleep(Math.min(1_000, Math.max(1, deadline - deps.now())));
  }
  throw new GylinServiceError(503, 'RUN_STILL_ACTIVE', 'The TestFlow run is still active; retry with the same idempotency key.', 5);
}

export function projectTerminalRun(run: any, input: Pick<GylinRunRequest, 'candidateCommit' | 'applicationUrl'>): GylinRunResponse {
  const runId = String(run?.id || '');
  const execution = run?.execution_result;
  const tests = Array.isArray(execution?.tests) ? execution.tests : [];
  const evidence = evidenceFromRun(run);
  const metadataCommit = String(run?.integrationMetadata?.candidateCommit || '');
  const reportUrl = publicUrl(`/reports?runId=${encodeURIComponent(runId)}`);
  if (String(run?.status) === 'completed' && tests.length && Number(execution?.failed || 0) === 0 && evidence.length && metadataCommit === input.candidateCommit) {
    return redactSecrets({
      status: 'passed', runId, summary: `${Number(execution.passed || tests.length)} checks passed.`,
      url: reportUrl, evidence, candidateCommit: input.candidateCommit, applicationUrl: input.applicationUrl,
    }) as GylinRunResponse;
  }
  const failed = Number(execution?.failed || 0);
  const missingEvidence = !tests.length || !evidence.length || metadataCommit !== input.candidateCommit;
  const summary = failed
    ? `${failed} of ${Number(execution?.total || tests.length)} checks failed.`
    : missingEvidence ? 'The run finished without complete verified execution evidence.' : `Run ended with status ${String(run?.status || 'unknown')}.`;
  const retryable = String(run?.status) === 'failed'
    && Array.isArray(run?.workflow_error_classes)
    && run.workflow_error_classes.some((error: any) => error?.retryable === true);
  return redactSecrets({
    status: 'failed', runId, summary, error: failed ? 'Acceptance criteria failed' : 'TestFlow run did not produce an evidence-backed pass',
    retryable, url: reportUrl, ...(evidence.length ? { evidence } : {}), candidateCommit: input.candidateCommit,
    applicationUrl: input.applicationUrl,
  }) as GylinRunResponse;
}

function evidenceFromRun(run: any): GylinEvidence[] {
  return (Array.isArray(run?.evidence_screenshots) ? run.evidence_screenshots : [])
    .flatMap((item: any) => {
      const refs = [item?.screenshotUrl, ...(Array.isArray(item?.stepScreenshots) ? item.stepScreenshots : [])]
        .filter((value): value is string => typeof value === 'string' && value.startsWith('/evidence/'));
      return refs.map((url) => ({ type: 'screenshot' as const, url: publicUrl(url) }));
    })
    .slice(0, 50);
}

function publicUrl(path: string): string {
  const base = String(process.env.TESTFLOW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return base ? new URL(path, `${base}/`).toString() : path;
}
