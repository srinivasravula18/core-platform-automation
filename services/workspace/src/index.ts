import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const pexec = promisify(execFile);

export interface RunManifest {
  runId: string;
  traceId?: string;
  sessionId?: string;
  model?: string;
  gitSha?: string;
  snapshotId?: string;
  status: string;
  object?: string;
}

/**
 * Git-backed per-project artifact workspace. Agents write plan/requirements/cases/scripts/evidence
 * here; one run = one commit (the audit trail). manifest.json is the cross-system join key
 * (trace_id ↔ git_sha ↔ sessionId). ponytail: shells to `git` (already installed) instead of a lib.
 */
export class Workspace {
  constructor(private root: string = process.env.WORKSPACE_DIR ?? "./workspace") {}

  runDir(org: string, project: string, runId: string): string {
    return join(this.root, org, project, "runs", runId);
  }

  private async git(args: string[]): Promise<void> {
    if (!existsSync(join(this.root, ".git"))) {
      await mkdir(this.root, { recursive: true });
      await pexec("git", ["init", "-q"], { cwd: this.root }).catch(() => {});
      await pexec("git", ["config", "user.email", "agent@atp.local"], { cwd: this.root }).catch(() => {});
      await pexec("git", ["config", "user.name", "ATP Agent"], { cwd: this.root }).catch(() => {});
    }
    await pexec("git", args, { cwd: this.root });
  }

  async writeArtifact(org: string, project: string, runId: string, relPath: string, content: string): Promise<string> {
    const full = join(this.runDir(org, project, runId), relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return full;
  }

  async writeManifest(org: string, project: string, m: RunManifest): Promise<void> {
    await this.writeArtifact(org, project, m.runId, "manifest.json", JSON.stringify(m, null, 2));
  }

  async readArtifact(org: string, project: string, runId: string, relPath: string): Promise<string | undefined> {
    const full = join(this.runDir(org, project, runId), relPath);
    return existsSync(full) ? readFile(full, "utf8") : undefined;
  }

  /** Commit the run's artifacts; returns the short sha (or undefined if git is unavailable). */
  async commit(message: string): Promise<string | undefined> {
    try {
      await this.git(["add", "-A"]);
      await this.git(["commit", "-q", "-m", message, "--allow-empty"]);
      const { stdout } = await pexec("git", ["rev-parse", "--short", "HEAD"], { cwd: this.root });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
