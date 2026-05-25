import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(repoRoot, "tests/e2e/dashboard-src"),
  base: "/",
  build: {
    outDir: path.resolve(repoRoot, "tests/e2e/list-view-test-environment"),
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5373
  }
});
