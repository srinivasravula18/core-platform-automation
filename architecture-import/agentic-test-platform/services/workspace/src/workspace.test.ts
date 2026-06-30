/** ponytail self-check: write artifacts + manifest + commit in a temp workspace. Run: pnpm -F @atp/workspace test */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./index.ts";

const dir = await mkdtemp(join(tmpdir(), "atp-ws-"));
try {
  const ws = new Workspace(dir);
  await ws.writeArtifact("hr", "proj1", "run-1", "plan/PLAN.md", "# plan");
  await ws.writeArtifact("hr", "proj1", "run-1", "scripts/leave_request/create.spec.ts", "test('x', ()=>{})");
  await ws.writeManifest("hr", "proj1", { runId: "run-1", status: "done", object: "leave_request", traceId: "trace-abc" });

  const plan = await ws.readArtifact("hr", "proj1", "run-1", "plan/PLAN.md");
  assert.equal(plan, "# plan");

  const manifestRaw = await readFile(join(dir, "hr", "proj1", "runs", "run-1", "manifest.json"), "utf8");
  assert.equal(JSON.parse(manifestRaw).traceId, "trace-abc");

  const sha = await ws.commit("run-1: leave_request");
  assert.ok(sha && sha.length >= 4, "commit returns a sha");
  console.log("✓ workspace self-check passed (artifacts + manifest + git commit", sha + ")");
} finally {
  await rm(dir, { recursive: true, force: true });
}
