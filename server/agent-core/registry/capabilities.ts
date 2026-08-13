/** Deterministic capability delegation. DELEGATE initiates the work, exactly once per idempotency key. */
import { getMessageBus } from '../bus/messageBus';
import { getBlackboard } from '../bus/blackboard';
import { getToolRegistry, type ToolRegistry } from './tools';

const ORCHESTRATOR = 'Maestro';

/** Thrown when a capability is unknown or not deterministic — drift is surfaced, never silently skipped. */
export class CapabilityError extends Error {
  constructor(message: string) { super(message); this.name = 'CapabilityError'; }
}

export interface InvokeCapabilityInput<T> {
  runId: string;
  capability: string;
  /** Stable across retries and restarts — what makes compile/execute run exactly once. */
  idempotencyKey: string;
  requestSummary: string;
  /** The deterministic work itself. Invoked at most once per idempotency key. */
  handler: () => Promise<T>;
  summarize?: (result: T) => { summary: string; value?: Record<string, unknown> };
  tools?: ToolRegistry;
  taskId?: string | null;
}

export interface CapabilityInvocation<T> {
  result: T;
  /** False when a prior invocation under the same key already did the work. */
  executed: boolean;
  delegateId: string | null;
}

/** In-flight and completed invocations for this process, keyed by `${runId}:${idempotencyKey}`. */
const invocations = new Map<string, Promise<unknown>>();

/**
 * Delegate to a deterministic capability and RUN it. The delegation is what initiates the work, so a
 * retried or replayed graph node cannot compile or execute twice: the second call returns the first
 * result. Cross-process safety comes from the durable `capability.result.*` fact keyed the same way.
 */
export async function invokeCapability<T>(input: InvokeCapabilityInput<T>): Promise<CapabilityInvocation<T>> {
  const def = (input.tools ?? getToolRegistry()).get(input.capability);
  if (!def || !def.deterministic) {
    throw new CapabilityError(`'${input.capability}' is not a registered deterministic capability.`);
  }

  const key = `${input.runId}:${input.idempotencyKey}`;
  // The memo must be claimed SYNCHRONOUSLY: any await before this lets concurrent callers slip past and
  // execute the side effect more than once.
  const inFlight = invocations.get(key);
  if (inFlight) return { result: (await inFlight) as T, executed: false, delegateId: null };

  let settle: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const claim = new Promise<T>((res, rej) => { settle = res; reject = rej; });
  invocations.set(key, claim);
  // Nothing may observe an unhandled rejection on the claim itself; real callers await the throw below.
  claim.catch(() => undefined);

  const bus = getMessageBus();
  const bb = getBlackboard();
  try {
    // A completed invocation from an earlier process is authoritative — never redo the side effect.
    const prior = await bb.latestAccepted<T>(input.runId, `capability.result.${input.capability}`, input.idempotencyKey).catch(() => null);
    if (prior) {
      settle(prior.value as T);
      return { result: prior.value as T, executed: false, delegateId: null };
    }

    const delegate = await bus.publish({
      runId: input.runId, from: ORCHESTRATOR, to: input.capability, type: 'DELEGATE',
      payload: { summary: input.requestSummary, deterministic: true, idempotencyKey: input.idempotencyKey },
      taskId: input.taskId ?? null,
    });

    let result: T;
    try {
      result = await input.handler();
    } catch (err) {
      await bus.publish({
        runId: input.runId, from: input.capability, to: ORCHESTRATOR, type: 'RESULT',
        payload: { summary: `Failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 500), deterministic: true, failed: true },
        causationId: delegate.id, taskId: input.taskId ?? null,
      }).catch(() => undefined);
      throw err;
    }

    const { summary, value } = input.summarize?.(result) ?? { summary: 'completed', value: undefined };
    await bus.publish({
      runId: input.runId, from: input.capability, to: ORCHESTRATOR, type: 'RESULT',
      payload: { summary, deterministic: true, ...(value ?? {}) },
      causationId: delegate.id, taskId: input.taskId ?? null,
    }).catch(() => undefined);
    await bb.put(input.runId, `capability.result.${input.capability}`, value ?? { summary }, input.capability, {
      key: input.idempotencyKey, causationId: delegate.id, status: 'accepted', taskId: input.taskId ?? null,
    }).catch(() => undefined);

    settle(result);
    return { result, executed: true, delegateId: delegate.id };
  } catch (err) {
    // A failed invocation may be retried; only a successful one is memoized.
    invocations.delete(key);
    reject(err);
    throw err;
  }
}

/** Test seam — clears the in-process invocation memo. */
export function resetCapabilityInvocations(): void {
  invocations.clear();
}
