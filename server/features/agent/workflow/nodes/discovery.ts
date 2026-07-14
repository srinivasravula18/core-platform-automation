/**
 * Discovery node — second node of the discovery/grounding subgraph (Phase 3).
 *
 * Consolidates the legacy TWO-browser-session discovery (inspectApplicationFlow +
 * exploreAndVerifyPage, each authenticating independently) into exactly ONE session via
 * `withPageSession`. Owns only its own bounded result — writing into `WorkflowState.evidence`
 * is grounding.ts's job (built next), not this node's.
 *
 * Retries happen at exactly one layer (the graph's node policy, per workflow/errors.ts) — this
 * node never retries itself, it only classifies and returns a WorkflowError for the caller to act on.
 */
import { withPageSession, sessionArtifacts } from '../../pageSession';
import { collectPageContext } from '../../inspectionService';
import { captureVerifiedElementsForOpenPage, type VerifiedElement } from '../../domExplorer';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, type WorkflowError } from '../errors';
import type { MissionRef } from '../state';

export interface RunDiscoveryNodeInput {
  mission: MissionRef | null;
  /** Mirrors pageSession.ts's `credentials?: any` passthrough — only username/password are actually read (performLoginIfCredentialsProvided), token is carried for parity with other nodes' credential shape. */
  credential?: { username?: string; password?: string; token?: string };
  runId: string;
  maxElements?: number;
}

export interface DiscoveryPageSummary {
  url: string;
  title: string;
  headingCount: number;
  tableCount: number;
  formCount: number;
  bodyTextExcerpt: string;
}

export interface RunDiscoveryNodeResult {
  /** Primary evidence: live-verified, deduped, ranked — captureVerifiedElementsForOpenPage's output is already bounded/typed. */
  elements: VerifiedElement[];
  pageSummary: DiscoveryPageSummary;
  screenshotRef: string | null;
  errors: WorkflowError[];
}

const EMPTY_PAGE_SUMMARY: DiscoveryPageSummary = { url: '', title: '', headingCount: 0, tableCount: 0, formCount: 0, bodyTextExcerpt: '' };

function emptyResult(errors: WorkflowError[]): RunDiscoveryNodeResult {
  return { elements: [], pageSummary: EMPTY_PAGE_SUMMARY, screenshotRef: null, errors };
}

/** Bounded summary from the richer collectPageContext blob — counts/excerpt only, never the full actions/forms/tables lists. */
function summarizePageContext(ctx: any): DiscoveryPageSummary {
  return {
    url: String(ctx?.url || ''),
    title: String(ctx?.title || ''),
    headingCount: Array.isArray(ctx?.headings) ? ctx.headings.length : 0,
    tableCount: Array.isArray(ctx?.tables) ? ctx.tables.length : 0,
    formCount: Array.isArray(ctx?.forms) ? ctx.forms.length : 0,
    bodyTextExcerpt: String(ctx?.bodyText || '').slice(0, 600),
  };
}

/** Session open/navigation/login failures all surface here (withPageSession guarantees cleanup regardless of where inside it the throw came from). */
function classifyDiscoveryError(err: unknown, loginAttempted: boolean): WorkflowRuntimeError {
  if (err instanceof WorkflowRuntimeError) return err;
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown discovery failure.');
  const lower = message.toLowerCase();

  // A login was attempted this session and the message itself talks about auth/credentials — treat as auth, not generic infra.
  if (loginAttempted && /login|credential|auth|password|username/.test(lower)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.AUTH_FAILURE, 'Authentication failed while opening the discovery session.', undefined, 'discovery');
  }
  if (/timeout|timed out|econnreset|econnrefused|enotfound/.test(lower)) {
    return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.NETWORK_TRANSIENT, 'Network timeout while opening the discovery session.', undefined, 'discovery');
  }
  return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.EXECUTION_INFRA_FAILURE, 'Browser session failed during discovery.', undefined, 'discovery');
}

/** LangGraph node: opens exactly ONE authenticated page session and returns bounded evidence + summary. */
export async function runDiscoveryNode(input: RunDiscoveryNodeInput): Promise<RunDiscoveryNodeResult> {
  const targetUrl = String(input.mission?.targetUrl || '').trim();
  if (!targetUrl) {
    const err = new WorkflowRuntimeError(
      WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION,
      'Discovery node requires a resolved mission with targetUrl.',
      undefined,
      'discovery',
    );
    return emptyResult([err.toWorkflowError()]);
  }

  // Tracked outside the try so the catch below can tell an auth-flavored throw from a generic infra one.
  let loginAttempted = false;

  try {
    return await withPageSession(
      { targetUrl, credentials: input.credential, runId: input.runId },
      async ({ sessionId, page, login }) => {
        loginAttempted = Boolean(login?.attempted);

        // Sequential by design: both reads hit the same live page, and Playwright reads against
        // one page are not meant to run concurrently from two call sites at once.
        const ctx = await collectPageContext(page);
        const elements = await captureVerifiedElementsForOpenPage(page, { maxElements: input.maxElements });

        // Must read screenshots before the callback returns — withPageSession closes the session right after.
        const artifacts = sessionArtifacts(sessionId);
        const screenshots = artifacts?.screenshots || [];
        const screenshotRef = screenshots.length ? screenshots[screenshots.length - 1] : null;

        return {
          elements,
          pageSummary: summarizePageContext(ctx),
          screenshotRef,
          errors: [],
        };
      },
    );
  } catch (error) {
    return emptyResult([classifyDiscoveryError(error, loginAttempted).toWorkflowError()]);
  }
}
