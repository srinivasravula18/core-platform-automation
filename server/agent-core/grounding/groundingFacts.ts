/** Publishes grounding evidence as shared facts. Best-effort: never throws, never alters the deterministic grounding result. */
import { getMessageBus } from '../bus/messageBus';
import { getBlackboard } from '../bus/blackboard';

const INSPECTOR = 'ApplicationInspector';
const ORCHESTRATOR = 'orchestrator';

export interface GroundingFactsInput {
  runId: string;
  /** Verified target labels/semantic names the author + critic ground against. */
  catalogLabels: string[];
  /** Live/verified evidence-node count (provenance 'live'). */
  liveCount?: number;
  /** The evidence gate's decision + reasons, when computed. */
  gate?: { decision: string; reasons?: string[]; missingRequirements?: string[] } | null;
}

/** Publish the run's grounding as shared facts. Returns the published catalog (or null when flag off). */
export async function publishGroundingFacts(input: GroundingFactsInput): Promise<string[] | null> {
  try {
    const labels = Array.from(new Set(input.catalogLabels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)));
    const blackboard = getBlackboard();
    // Captured by deterministic inspection, so it is accepted evidence rather than an agent proposal.
    await blackboard.put(input.runId, 'evidence.catalog', { labels, count: labels.length }, INSPECTOR, { status: 'accepted' });
    await blackboard.put(input.runId, 'grounding.coverage', { gate: input.gate?.decision ?? null, reasons: input.gate?.reasons?.slice(0, 6) ?? [], missing: input.gate?.missingRequirements?.slice(0, 10) ?? [], live: input.liveCount ?? 0, targets: labels.length }, INSPECTOR, { status: 'accepted' });
    await getMessageBus().publish({
      runId: input.runId, from: INSPECTOR, to: ORCHESTRATOR, type: 'RESULT',
      payload: { summary: `Grounded ${labels.length} verified target(s); gate=${input.gate?.decision ?? 'n/a'}.`, targets: labels.length, gate: input.gate?.decision ?? null },
    });
    return labels;
  } catch (err) {
    console.warn(`[grounding-facts] failed to publish for run ${input.runId} (non-fatal):`, (err as Error)?.message);
    return null;
  }
}

/** Read the shared verified catalog for a run (any agent with just a runId can ground). Empty when absent. */
export async function readSharedCatalog(runId: string): Promise<string[]> {
  try {
    const fact = await getBlackboard().latest<{ labels: string[] }>(runId, 'evidence.catalog');
    return Array.isArray(fact?.value?.labels) ? fact!.value.labels : [];
  } catch {
    return [];
  }
}
