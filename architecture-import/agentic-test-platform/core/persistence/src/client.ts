import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

/** Local Postgres connection (no Docker). Reads DATABASE_URL; lazy so importing the schema
 *  for typegen/tests doesn't require a live DB. */
let pool: pg.Pool | undefined;

export function getDb() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/atp",
    });
  }
  return drizzle(pool, { schema });
}

export type DB = ReturnType<typeof getDb>;
export { schema };
