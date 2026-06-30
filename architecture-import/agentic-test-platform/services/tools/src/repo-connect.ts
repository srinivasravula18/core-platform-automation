import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pexec = promisify(execFile);

export interface RepoInfo {
  source: "local" | "remote";
  ref: string; // local path or remote url
  branch?: string;
  sha?: string;
  framework?: string;
  fileCount?: number;
  hasMetadata?: boolean;
  error?: string;
}

function detectFramework(path: string): string {
  const pj = join(path, "package.json");
  if (existsSync(pj)) {
    try {
      const d = JSON.parse(readFileSync(pj, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...d.dependencies, ...d.devDependencies };
      if (deps.next) return "next";
      if (deps.react) return "react";
      if (deps.vue) return "vue";
      if (deps["@angular/core"]) return "angular";
      if (deps.svelte) return "svelte";
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}

/** Attach a LOCAL git folder as the source of truth — reads branch/sha/files/framework server-side. */
export async function connectLocalRepo(path: string): Promise<RepoInfo> {
  if (!existsSync(path)) return { source: "local", ref: path, error: "path does not exist on this machine" };
  try {
    await pexec("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { source: "local", ref: path, error: "not a git repository (no .git found)" };
  }
  try {
    const branch = (await pexec("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const sha = (await pexec("git", ["-C", path, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const files = (await pexec("git", ["-C", path, "ls-files"], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim().split("\n").filter(Boolean);
    const hasMetadata = files.some((f) => /metadata|\.object\.|force-app|\.field-meta|schema\.(sql|prisma)/.test(f));
    return { source: "local", ref: path, branch, sha, framework: detectFramework(path), fileCount: files.length, hasMetadata };
  } catch (e) {
    return { source: "local", ref: path, error: (e as Error).message };
  }
}

/** Attach a REMOTE git repo (GitHub URL) — validates reachability via ls-remote (no clone in lean mode). */
export async function connectRemoteRepo(url: string): Promise<RepoInfo> {
  try {
    const { stdout } = await pexec("git", ["ls-remote", "--heads", url], { timeout: 20000 });
    const branches = stdout.trim().split("\n").filter(Boolean).length;
    return { source: "remote", ref: url, branch: branches ? `${branches} branches` : undefined };
  } catch {
    return { source: "remote", ref: url, error: "cannot reach remote (check URL or auth)" };
  }
}

export async function connectRepo(input: { path?: string; url?: string }): Promise<RepoInfo> {
  if (input.path) return connectLocalRepo(input.path);
  if (input.url) return connectRemoteRepo(input.url);
  throw new Error("provide a local 'path' or a remote 'url'");
}
