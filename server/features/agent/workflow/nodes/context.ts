/**
 * Context node — first node of the discovery/grounding subgraph (Phase 3).
 *
 * Populates `WorkflowState.context.metadata` from the application's metadata map. Deliberately
 * does no browser/DOM work — that is `discovery.ts`'s job, built in parallel. Reuses
 * `fetchCorePlatformMetadataMap` (server/ai/tools/corePlatformData.ts) exactly as
 * pipelineDelta.ts's `runMetadataFetchPhase` already calls it; does not reimplement fetch/caching.
 *
 * Retries happen at exactly one layer (the graph's node policy, per workflow/errors.ts) — this
 * node never retries itself, it only classifies and returns a WorkflowError for the caller to act on.
 */
import { createHash } from 'crypto';
import { fetchCorePlatformMetadataMap, type CatalogConn } from '../../../../ai/tools/corePlatformData';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { ContextMetadataSummary, MissionRef } from '../state';

export interface RunContextNodeInput {
  mission: MissionRef | null;
  /** Already-resolved credential for the target app — mirrors runMetadataFetchPhase's `credentials` passthrough; this node does not resolve CredentialRef itself. */
  credential?: Pick<CatalogConn, 'token' | 'username' | 'password'>;
}

export interface RunContextNodeResult {
  context: { metadata: ContextMetadataSummary | null };
  errors: WorkflowError[];
}

function digestOf(map: { objects: unknown }): string {
  return createHash('sha1').update(JSON.stringify(map.objects)).digest('hex');
}

/** LangGraph node: reads only mission/credential, owns and returns only `context.metadata`. */
export async function runContextNode(input: RunContextNodeInput): Promise<RunContextNodeResult> {
  const appId = String(input.mission?.applicationId || '').trim();
  const baseUrl = String(input.mission?.targetUrl || '').trim();

  // A missing targetUrl is the ONLY real invariant here — nothing downstream can recover from it.
  if (!baseUrl) {
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      'Context node requires a resolved mission with a targetUrl.',
      { appId, hasBaseUrl: false },
      'context',
    );
    return { context: { metadata: null }, errors: [err.toWorkflowError()] };
  }
  // Metadata is a tenant-application concept and ADVISORY only (the run grounds on live evidence, not
  // metadata). No appId — ADMIN by design, or a RUNTIME mission whose app wasn't resolved — is a clean
  // "no metadata" outcome, never a hard error: the run just proceeds on discovery.
  if (!appId) {
    return { context: { metadata: null }, errors: [] };
  }

  const conn: CatalogConn = { baseUrl, ...input.credential };

  try {
    const map = await fetchCorePlatformMetadataMap(conn, appId);
    if (!map) {
      // fetchCorePlatformMetadataMap never throws; null covers unreachable service, bad auth, and empty
      // catalogs alike. Treated as transient/retryable since the far more common cause is the target
      // not being up yet, not a permanent condition.
      const err = new WorkflowRuntimeError(
        WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT,
        'Metadata map unavailable for the resolved application.',
        { appId },
        'context',
      );
      return { context: { metadata: null }, errors: [err.toWorkflowError()] };
    }

    return {
      context: {
        metadata: {
          ref: appId,
          digest: digestOf(map),
          objectCount: map.objects.length,
          source: 'live',
        },
      },
      errors: [],
    };
  } catch (error) {
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT,
      error instanceof Error ? error.message : 'Metadata fetch failed.',
      { appId },
      'context',
    );
    return { context: { metadata: null }, errors: [err.toWorkflowError()] };
  }
}
