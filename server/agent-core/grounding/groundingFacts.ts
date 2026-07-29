/**
 * Shared grounding facts (Phase 5) — grounding is learned ONCE and published to the blackboard so every
 * downstream agent (author, critic, planner) reads the same evidence instead of privately re-deriving it.
 *
 * Complements the already-shared `app.understanding` fact (understandingProducer) with the run-specific
 * `evidence.catalog` (the verified target vocabulary the author/critic must ground against) and
 * `grounding.coverage` (the gate's continue/retry/blocked decision + counts). Published as append-only
 * facts plus an ApplicationInspector RESULT so the console shows grounding as a real contribution. Flag-gated
 * by AGENT_NATIVE_V1; best-effort — never throws, never affects the deterministic grounding result.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
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
  if (!isAgentNativeEnabled()) return null;
  try {
    const labels = Array.from(new Set(input.catalogLabels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)));
    const blackboard = getBlackboard();
    await blackboard.put(input.runId, 'evidence.catalog', { labels, count: labels.length }, INSPECTOR);
    await blackboard.put(input.runId, 'grounding.coverage', { gate: input.gate?.decision ?? null, reasons: input.gate?.reasons?.slice(0, 6) ?? [], missing: input.gate?.missingRequirements?.slice(0, 10) ?? [], live: input.liveCount ?? 0, targets: labels.length }, INSPECTOR);
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
