/**
 * Write-through mirror between the in-process artifact stash and the shared run store (Phase 5).
 *
 * When AGENT_NATIVE_V1 is on, every stashArtifacts() write is best-effort mirrored to the durable shared
 * store so a second worker can re-hydrate. When the flag is OFF (default) these are no-ops, so the hot
 * stash path is byte-for-byte unchanged. Mirroring is fire-and-forget and never throws into the caller —
 * a store hiccup must never break a run; worst case the run stays process-bound exactly as today.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getRunArtifactStore } from './runStore';

/** Best-effort mirror of a partial stash write to the shared store. No-op unless AGENT_NATIVE_V1 is on. */
export function mirrorArtifactsToRunStore(runId: string, partial: Record<string, unknown>): void {
  if (!isAgentNativeEnabled()) return;
  const store = getRunArtifactStore();
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    // Fire-and-forget; swallow errors so a store failure can never break the run.
    Promise.resolve(store.put(runId, key, value)).catch((err) => {
      console.warn(`[run-store] mirror of '${key}' for run ${runId} failed (non-fatal):`, (err as Error)?.message);
    });
  }
}

/** Re-hydrate all shared-store artifacts for a run (for a resuming worker). Empty object when none/flag off. */
export async function hydrateArtifactsFromRunStore(runId: string): Promise<Record<string, unknown>> {
  if (!isAgentNativeEnabled()) return {};
  try {
    return await getRunArtifactStore().getAll(runId);
  } catch (err) {
    console.warn(`[run-store] hydrate for run ${runId} failed (non-fatal):`, (err as Error)?.message);
    return {};
  }
}
