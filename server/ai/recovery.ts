/**
 * Test Flow AI — Typed Exception Handling & Recovery
 *
 * This module formalizes the project's previously ad-hoc error recovery (the
 * `callWithRetry` helper in orchestrator.ts and the scattered try/catch logic in
 * executionService.ts) into one typed, standalone, side-effect-free module so the
 * pipeline can make a single, consistent recovery decision per failure.
 *
 * It follows the taxonomy from "Agentic Design Patterns" Chapter 12
 * (Exception Handling & Recovery):
 *
 *   HANDLING
 *     - Logging              — surfaced via the onRetry/onDegrade/onEscalate callbacks
 *     - Retries              — RecoveryAction 'retry' (transient errors, exp. backoff)
 *     - Fallbacks            — RecoveryAction 'repair' (corrective regeneration)
 *     - Graceful degradation — RecoveryAction 'degrade' (keep partial function)
 *     - Notification         — onEscalate / onDegrade callbacks notify the caller
 *
 *   RECOVERY
 *     - State rollback       — the caller rolls back using the surfaced RecoveryDecision
 *     - Diagnosis            — classifyFailure() turns a raw error into a typed decision
 *     - Self-correction /
 *       replanning           — RecoveryAction 'repair' (stage-specific corrective regen)
 *     - Escalation           — RecoveryAction 'escalate' (human / higher-level handling)
 *
 * Transient-error detection and the backoff curve (`Math.min(8000, 500 * 2**i)`,
 * up to 4 attempts) intentionally mirror orchestrator.ts's `callWithRetry`.
 *
 * Deliberately standalone: NO imports from other app files, so it is trivially
 * unit-testable and free of side effects.
 */

/** The stages of the test-generation pipeline that can fail and be recovered. */
export type PipelineStage =
  | 'inspect'
  | 'generate_cases'
  | 'generate_scripts'
  | 'verify_selectors'
  | 'execute'
  | 'evidence';

/**
 * The recovery action chosen for a failure, mapped to Ch 12 strategies:
 *   - 'retry'    → Retries (transient errors)
 *   - 'repair'   → Fallbacks / Self-correction (regenerate bad model output)
 *   - 'degrade'  → Graceful degradation (lose a capability, keep partial function)
 *   - 'escalate' → Escalation (human or higher-level handling)
 */
export type RecoveryAction = 'retry' | 'repair' | 'degrade' | 'escalate';

/** A diagnosed, typed verdict for a single failure. */
export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  retryable: boolean;
}

/**
 * Diagnose a raw error into a typed RecoveryDecision (the "Diagnosis" step of Ch 12).
 *
 * Deterministic: it inspects the error message plus optional `code`/`status` fields.
 * The transient-error detection matches orchestrator.ts's `callWithRetry`.
 *
 * @param stage       the pipeline stage that failed (included in the reason text)
 * @param error       the thrown value (any shape; safely coerced)
 * @param attempt     the zero-based attempt index that just failed
 * @param maxAttempts the attempt budget; once exhausted, transient errors escalate
 */
export function classifyFailure(
  stage: PipelineStage,
  error: unknown,
  attempt = 0,
  maxAttempts = 3,
): RecoveryDecision {
  const msg = String((error as any)?.message || error || '');
  const code = (error as any)?.code;
  const status = (error as any)?.status;

  // TRANSIENT → retry (rate limit / network / 429 / 5xx / timeouts / overloaded).
  // Mirrors callWithRetry's `retryable` check, plus a message regex for SDKs that
  // do not attach a structured code/status.
  const isTransient =
    code === 'rate_limit' ||
    code === 'network' ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|rate.?limit|overloaded|503|temporarily/i.test(msg);
  if (isTransient) {
    if (attempt >= maxAttempts) {
      return {
        action: 'escalate',
        reason: `Stage "${stage}" hit a transient failure but retries are exhausted (${attempt}/${maxAttempts}); escalating.`,
        retryable: false,
      };
    }
    return {
      action: 'retry',
      reason: `Stage "${stage}" hit a transient failure (rate limit / network / 5xx / timeout); retrying with backoff.`,
      retryable: true,
    };
  }

  // MALFORMED / PARSE → repair. The model produced bad structured output or code;
  // a corrective regeneration usually fixes it (Fallbacks / Self-correction).
  const isMalformed =
    /schema|invalid_type|invalid_value|unexpected token|unexpected end of (json|input)|not valid json|json\.parse|parse error|syntaxerror|truncat/i.test(
      msg,
    );
  if (isMalformed) {
    return {
      action: 'repair',
      reason: `Stage "${stage}" produced malformed/off-schema output; attempting a corrective regeneration.`,
      retryable: false,
    };
  }

  // UNAVAILABLE / NOT FOUND → degrade. The capability is gone; keep partial function.
  const isUnavailable =
    status === 404 ||
    /not found|unavailable|ENOTFOUND|ECONNREFUSED|no such file|cannot find|repo.*(unavailable|failed)/i.test(
      msg,
    );
  if (isUnavailable) {
    return {
      action: 'degrade',
      reason: `Stage "${stage}" depends on an unavailable/not-found resource; degrading gracefully and continuing with partial function.`,
      retryable: false,
    };
  }

  // Otherwise → escalate. Unclassified or severe; needs human / higher-level handling.
  return {
    action: 'escalate',
    reason: `Stage "${stage}" failed with an unclassified/severe error that needs human or higher-level handling.`,
    retryable: false,
  };
}

/** The result of running a stage through {@link withRecovery}. */
export interface WithRecoveryResult<T> {
  value?: T;
  outcome: 'ok' | 'degraded' | 'escalated';
  attempts: number;
  decision?: RecoveryDecision;
  error?: unknown;
}

/**
 * Run a pipeline stage with built-in handling & recovery.
 *
 * Loops attempts 0..maxRetries (default 3), awaiting `fn(attempt)` each time:
 *   - success           → { outcome: 'ok', value, attempts }
 *   - aborted signal    → { outcome: 'escalated' } immediately
 *   - decision 'retry'  → onRetry(), wait `Math.min(8000, 500 * 2**attempt)` ms, loop
 *   - decision 'repair' → surfaced as 'escalated' (see note below)
 *   - decision 'degrade'→ onDegrade(), { outcome: 'degraded' }
 *   - decision 'escalate→ onEscalate(), { outcome: 'escalated' }
 *
 * NOTE on 'repair': self-correction is inherently stage-specific (each caller knows
 * how to re-prompt its model with a corrective instruction — see generateObject's
 * one-shot regen in orchestrator.ts). This generic wrapper therefore does NOT perform
 * the repair itself; it surfaces the RecoveryDecision (action: 'repair') as an
 * 'escalated' outcome so the stage-specific caller can read `decision` and act on it.
 */
export async function withRecovery<T>(
  stage: PipelineStage,
  fn: (attempt: number) => Promise<T>,
  opts?: {
    maxRetries?: number;
    onRetry?: (d: RecoveryDecision, attempt: number) => void;
    onDegrade?: (d: RecoveryDecision) => void;
    onEscalate?: (d: RecoveryDecision) => void;
    signal?: { aborted?: boolean };
  },
): Promise<WithRecoveryResult<T>> {
  const maxRetries = opts?.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, outcome: 'ok', attempts: attempt + 1 };
    } catch (err) {
      // Cooperative cancellation: bail out before any further retry/backoff.
      if (opts?.signal?.aborted) {
        const decision: RecoveryDecision = {
          action: 'escalate',
          reason: `Stage "${stage}" was aborted by signal; escalating.`,
          retryable: false,
        };
        return { outcome: 'escalated', decision, attempts: attempt + 1, error: err };
      }

      const decision = classifyFailure(stage, err, attempt, maxRetries);

      if (decision.action === 'retry') {
        opts?.onRetry?.(decision, attempt);
        const ms = Math.min(8000, 500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, ms));
        continue;
      }

      if (decision.action === 'repair') {
        // Surfaced for the stage-specific caller to perform a corrective regen.
        return { outcome: 'escalated', decision, attempts: attempt + 1, error: err };
      }

      if (decision.action === 'degrade') {
        opts?.onDegrade?.(decision);
        return { outcome: 'degraded', decision, attempts: attempt + 1, error: err };
      }

      // decision.action === 'escalate'
      opts?.onEscalate?.(decision);
      return { outcome: 'escalated', decision, attempts: attempt + 1, error: err };
    }
  }

  // The loop only falls through here when every attempt was a transient 'retry' and
  // the retry budget is now spent. classifyFailure will have escalated on the final
  // attempt (attempt >= maxRetries), so this is a defensive fallback for type safety.
  const decision: RecoveryDecision = {
    action: 'escalate',
    reason: `Stage "${stage}" exhausted all ${maxRetries + 1} attempts; escalating.`,
    retryable: false,
  };
  opts?.onEscalate?.(decision);
  return { outcome: 'escalated', decision, attempts: maxRetries + 1 };
}
