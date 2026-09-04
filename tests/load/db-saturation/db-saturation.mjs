// Database connection saturation probe.
//
// Opens connections up to and past the service's pool ceiling while timing a
// trivial query on each, so you can see the point where the platform starts
// queueing instead of serving — and whether it queues or fails.
import pg from "pg";

const config = () => {
  const url = process.env.OBSERVABILITY_DB_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (url) return { connectionString: url };
  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? process.env.DB_USERNAME ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "core-platform"
  };
};

const run = async () => {
  const target = Number(process.env.SATURATION_CONNECTIONS ?? 60);
  const holdSeconds = Number(process.env.SATURATION_HOLD_SECONDS ?? 30);
  const stepDelayMs = Number(process.env.SATURATION_STEP_DELAY_MS ?? 100);
  const queryDelayMs = Number(process.env.SATURATION_QUERY_DELAY_MS ?? 0);
  const clients = [];
  let firstFailureAt = null;

  console.log(`db-saturation: opening up to ${target} connections, holding ${holdSeconds}s`);

  for (let index = 1; index <= target; index += 1) {
    const client = new pg.Client(config());
    const startedAt = Date.now();
    try {
      await client.connect();
      await client.query("select 1");
      clients.push(client);
      const elapsed = Date.now() - startedAt;
      if (index % 5 === 0 || elapsed > 500) {
        console.log(`db-saturation: connection ${index} established in ${elapsed}ms`);
      }
    } catch (error) {
      firstFailureAt = firstFailureAt ?? index;
      console.log(`db-saturation: connection ${index} FAILED after ${Date.now() - startedAt}ms — ${error.message}`);
      break;
    }
    if (stepDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
  }

  const slowQueries = queryDelayMs > 0
    ? clients.map((client) => client.query("select pg_sleep($1)", [queryDelayMs / 1000]))
    : [];
  if (slowQueries.length > 0) {
    console.log(`db-saturation: running ${slowQueries.length} concurrent ${queryDelayMs}ms queries`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, queryDelayMs)));
  }

  const probe = new pg.Client(config());
  let probeLatency = null;
  try {
    await probe.connect();
    const startedAt = Date.now();
    await probe.query("select count(*) from pg_stat_activity");
    probeLatency = Date.now() - startedAt;
    await probe.end();
  } catch (error) {
    console.log(`db-saturation: probe query failed — ${error.message}`);
  }

  console.log(
    `db-saturation: held ${clients.length} connections · first failure at ${firstFailureAt ?? "none"} · probe latency ${probeLatency ?? "n/a"}ms`
  );
  await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
  await Promise.allSettled(slowQueries);
  await Promise.allSettled(clients.map((client) => client.end()));
  console.log("db-saturation: released");

  if (firstFailureAt !== null && firstFailureAt < target * 0.5) {
    console.log("db-saturation: VERDICT fail — connections exhausted well below the requested ceiling");
    process.exit(1);
  }
  console.log("db-saturation: VERDICT pass");
};

run().catch((error) => {
  console.error(`db-saturation failed: ${error.message}`);
  process.exit(1);
});
