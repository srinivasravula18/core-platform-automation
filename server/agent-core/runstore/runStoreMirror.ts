/** Mirrors stash writes to the durable shared store, best-effort. */
import { getRunArtifactStore } from './runStore';

/** Mirror a partial stash write to the shared store. Awaitable, so a boundary can require durability. */
export function mirrorArtifactsToRunStore(runId: string, partial: Record<string, unknown>): Promise<void> {
  const store = getRunArtifactStore();
  const writes = Object.entries(partial)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => Promise.resolve(store.put(runId, key, value)).catch((err) => {
      // A store failure must never break the run; it only costs this run its cross-process resume.
      console.warn(`[run-store] mirror of '${key}' for run ${runId} failed (non-fatal):`, (err as Error)?.message);
    }));
  return Promise.all(writes).then(() => undefined);
}

/** Re-hydrate all shared-store artifacts for a run (for a resuming worker). Empty object when none/flag off. */
export async function hydrateArtifactsFromRunStore(runId: string): Promise<Record<string, unknown>> {
  try {
    return await getRunArtifactStore().getAll(runId);
  } catch (err) {
    console.warn(`[run-store] hydrate for run ${runId} failed (non-fatal):`, (err as Error)?.message);
    return {};
  }
}
