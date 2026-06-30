import type { Config } from "drizzle-kit";

// Local Postgres (no Docker required). Set DATABASE_URL in .env.
export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/atp" },
} satisfies Config;
