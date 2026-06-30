// Local Postgres (no Docker required). Set DATABASE_URL in .env.
export default {
    schema: "./src/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/atp" },
};
//# sourceMappingURL=drizzle.config.js.map