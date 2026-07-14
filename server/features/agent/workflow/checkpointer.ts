/**
 * LangGraph checkpointer factory (LangGraph migration, Phase 1).
 *
 * Production requires a durable PostgreSQL checkpointer; the in-memory saver is a
 * dev/test-only fallback. If the workflow runtime is enabled in a production-like
 * deployment with no DATABASE_URL, construction fails closed rather than silently
 * running non-durable.
 *
 * Pure leaf module: no imports from state.ts/errors.ts/events.ts, only server/db/pool.ts
 * and the LangGraph packages.
 */
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { isPostgresEnabled, getConnectionString } from '../../../db/pool';

let cached: BaseCheckpointSaver | null = null;
let cachedPostgres: PostgresSaver | null = null;
let pending: Promise<BaseCheckpointSaver> | null = null;

/** AGENT_GRAPH_V2 truthy check; exported so other modules (e.g. apps/api/src/server.ts) don't re-check the env var ad hoc. */
export function isWorkflowGraphEnabled(): boolean {
  return ['1', 'true'].includes(String(process.env.AGENT_GRAPH_V2 || '').toLowerCase());
}

/** Mirrors apps/api/src/server.ts's inline deployment-mode check; not imported from there to avoid a backwards dependency. */
function isProductionDeployment(): boolean {
  const explicit = (process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'production';
  const implicit = !process.env.DEPLOYMENT_MODE && String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  return explicit || implicit;
}

async function construct(): Promise<BaseCheckpointSaver> {
  if (isPostgresEnabled()) {
    const saver = PostgresSaver.fromConnString(getConnectionString()!);
    await saver.setup();
    cachedPostgres = saver;
    return saver;
  }

  if (isProductionDeployment() && isWorkflowGraphEnabled()) {
    throw new Error(
      'AGENT_GRAPH_V2 is enabled in a production deployment but no DATABASE_URL is configured — the workflow ' +
        'runtime requires a durable PostgreSQL checkpointer in production and refuses to start with a non-durable fallback.'
    );
  }

  console.warn('[workflow] using in-memory checkpointer (no DATABASE_URL set) — state is non-durable');
  return new MemorySaver();
}

/** Returns the process-wide checkpointer singleton, constructing (and setting up Postgres) at most once. */
export async function getWorkflowCheckpointer(): Promise<BaseCheckpointSaver> {
  if (cached) return cached;
  if (!pending) {
    pending = construct()
      .then((saver) => {
        cached = saver;
        return saver;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** Graceful shutdown; resets the singleton so a later getWorkflowCheckpointer() call (e.g. in tests) constructs fresh. */
export async function closeWorkflowCheckpointer(): Promise<void> {
  if (cachedPostgres) await cachedPostgres.end();
  cached = null;
  cachedPostgres = null;
  pending = null;
}
