import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";

const pexec = promisify(execFile);
const repoPath = (ctx: ToolContext): string | undefined => (ctx.repo as { ref?: string } | undefined)?.ref;
const BLOCKED_REPO_FILE = /\.(md|mdx|txt|rst|adoc|doc|docx|pdf)$/i;
const blockedRepoFile = (path: string): boolean => BLOCKED_REPO_FILE.test(path);

/** Extract import/require/export-from specifiers from source. */
function extractImports(src: string): string[] {
  const specs = new Set<string>();
  const res = [
    /import\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) if (m[1]) specs.add(m[1]);
  return [...specs];
}
/** Resolve a relative import to a real file in the repo (try common extensions/index). */
function resolveLocal(dir: string, spec: string): string | undefined {
  const base = resolve(dir, spec);
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js")];
  for (const c of cands) try { if (statSync(c).isFile()) return c; } catch { /* next */ }
  return undefined;
}
import { buildPipeline, Orchestrator } from "@atp/orchestrator";
import { buildCatalog, defaultRenderProfile, defaultChromeAllow, lintScript, routeFor } from "@atp/grounding";
import { renderSpec } from "@atp/orchestrator";
import { scoreAgainstRepo, scoreRun } from "@atp/evaluation";
import { sampleValue } from "@atp/generators";
import { runCreateFlow } from "@atp/execution";
import type { MetadataClient } from "./metadata-client.ts";
import { RunStore } from "./run-store.ts";
import { connectRepo, type RepoInfo } from "./repo-connect.ts";

export interface ToolContext {
  metadata: MetadataClient;
  runs: RunStore;
  /** orgs the user has connected this session (DB-backed in the gateway) */
  orgs: Map<string, { name: string; baseUrl: string; isProduction: boolean }>;
  /** the local/remote git repo connected as the source of truth */
  repo?: RepoInfo;
  /** resolve login credentials for a target URL (set by the gateway from the encrypted store) */
  resolveCreds?: (url: string) => Promise<{ username: string; password: string; loginUrl: string } | null>;
}

export interface Tool {
  name: string;
  description: string;
  /** human-facing one-line schema hint, shown to the LLM */
  inputHint: string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`tool input '${name}' must be a non-empty string`);
  return v;
};

export const TOOLS: Tool[] = [
  {
    name: "search_repo",
    description: "Search the CONNECTED repo's source for code or text (git grep). Use this FIRST to understand what's actually in the repo before answering.",
    inputHint: '{ "query": string }',
    run: async (i, ctx) => {
      const repo = repoPath(ctx);
      if (!repo) return { error: "no repo connected — ask the user to connect one on the File System page" };
      const q = str(i.query, "query");
      try {
        const { stdout } = await pexec("git", ["-C", repo, "grep", "-n", "-I", "-i", "--max-count", "3", "-e", q], { maxBuffer: 4 * 1024 * 1024, timeout: 20000 });
        const results = stdout.split("\n").filter((line) => line && !blockedRepoFile(line.split(":")[0] ?? "")).slice(0, 60);
        return { query: q, matches: results.length, results };
      } catch {
        return { query: q, matches: 0, results: [], note: "no matches" };
      }
    },
  },
  {
    name: "list_files",
    description: "List files in the connected repo, optionally filtered by a glob (e.g. \"**/*.tsx\"). Use to map the repo structure.",
    inputHint: '{ "glob"?: string }',
    run: async (i, ctx) => {
      const repo = repoPath(ctx);
      if (!repo) return { error: "no repo connected" };
      const args = ["-C", repo, "ls-files"];
      if (typeof i.glob === "string" && i.glob) args.push(i.glob);
      try {
        const { stdout } = await pexec("git", args, { maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
        const files = stdout.split("\n").filter((file) => file && !blockedRepoFile(file));
        return { count: files.length, files: files.slice(0, 200) };
      } catch {
        return { count: 0, files: [] };
      }
    },
  },
  {
    name: "read_file",
    description: "Read a file from the connected repo (first ~400 lines). Use after search_repo/list_files to inspect real code.",
    inputHint: '{ "path": string }',
    run: async (i, ctx) => {
      const repo = repoPath(ctx);
      if (!repo) return { error: "no repo connected" };
      const rel = str(i.path, "path");
      if (blockedRepoFile(rel)) return { error: "file type is blocked for agent reads" };
      const full = resolve(repo, rel);
      if (!full.startsWith(resolve(repo))) return { error: "path escapes the repo" };
      if (!existsSync(full)) return { error: "file not found" };
      try {
        const lines = readFileSync(full, "utf8").split("\n");
        return { path: rel, totalLines: lines.length, content: lines.slice(0, 400).join("\n") };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "follow_imports",
    description: "Read a file AND the files it imports (its connected modules). Use this to gather the FULL related context before answering — never rely on a single file.",
    inputHint: '{ "path": string }',
    run: async (i, ctx) => {
      const repo = repoPath(ctx);
      if (!repo) return { error: "no repo connected" };
      const rel = str(i.path, "path");
      if (blockedRepoFile(rel)) return { error: "file type is blocked for agent reads" };
      const full = resolve(repo, rel);
      if (!full.startsWith(resolve(repo)) || !existsSync(full)) return { error: "file not found" };
      let src: string;
      try { src = readFileSync(full, "utf8"); } catch (e) { return { error: (e as Error).message }; }
      const dir = dirname(full);
      const related: { path: string; preview: string }[] = [];
      const packages = new Set<string>();
      for (const spec of extractImports(src)) {
        if (spec.startsWith(".")) {
          const r = resolveLocal(dir, spec);
          if (r && r.startsWith(resolve(repo)) && !blockedRepoFile(relative(repo, r))) {
            try { related.push({ path: relative(repo, r).replace(/\\/g, "/"), preview: readFileSync(r, "utf8").split("\n").slice(0, 80).join("\n") }); } catch { /* skip */ }
          }
        } else {
          packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
        }
      }
      return { file: rel, content: src.split("\n").slice(0, 200).join("\n"), localImports: related.length, packages: [...packages], related: related.slice(0, 14) };
    },
  },
  {
    name: "read_package",
    description: "Read a package.json from the connected repo (root or a sub-path) — name, scripts, and dependencies/packages.",
    inputHint: '{ "path"?: string }',
    run: async (i, ctx) => {
      const repo = repoPath(ctx);
      if (!repo) return { error: "no repo connected" };
      const givenRel = typeof i.path === "string" && i.path ? i.path : "package.json";
      let pj = resolve(repo, givenRel);
      if (!pj.endsWith("package.json")) pj = join(pj, "package.json");
      if (!pj.startsWith(resolve(repo)) || !existsSync(pj)) return { error: "package.json not found" };
      try {
        const d = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
        return { path: relative(repo, pj).replace(/\\/g, "/"), name: d.name, version: d.version, scripts: d.scripts, dependencies: d.dependencies, devDependencies: d.devDependencies };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "list_apps",
    description: "List the apps in the connected platform (core, crm, hr, lims, ops_hub).",
    inputHint: "{}",
    run: (_i, ctx) => ctx.metadata.listApps(),
  },
  {
    name: "list_objects",
    description: "List objects, optionally filtered by app.",
    inputHint: '{ "app"?: string }',
    run: (i, ctx) => ctx.metadata.listObjects(typeof i.app === "string" ? i.app : undefined),
  },
  {
    name: "describe_object",
    description: "Get an object's fields, picklists, validation rules and permissions (the grounding source).",
    inputHint: '{ "object": string }',
    run: (i, ctx) => ctx.metadata.describeObject(str(i.object, "object")),
  },
  {
    name: "generate_tests",
    description: "Generate ISTQB UI cases + API contract cases for an object (runs the agent pipeline; A2A + grounding).",
    inputHint: '{ "object": string }',
    run: async (i, ctx) => {
      const descriptor = await ctx.metadata.describeObject(str(i.object, "object"));
      const orch = new Orchestrator(buildPipeline());
      const a = await orch.runObject(descriptor);
      // ACCURACY: compare what the agent produced against the repo metadata (ground truth)
      const catalog = buildCatalog(descriptor, defaultRenderProfile);
      const confidence = scoreAgainstRepo(descriptor, { cases: a.cases, apiCases: a.requests, script: a.script.script, catalog });
      return {
        object: descriptor.object.api_name,
        uiCases: a.cases.map((c) => ({ code: c.code, title: c.title, technique: c.technique, suites: c.suiteTypes, priority: c.priority })),
        apiCases: a.requests.map((r) => ({ caseId: r.caseId, variant: r.variant, expect: r.expect.statusClass })),
        scriptLintOk: a.script.lintOk,
        confidence,
      };
    },
  },
  {
    name: "generate_script",
    description: "Generate a grounded Playwright spec for an object's create flow (locators verified by selector-lint).",
    inputHint: '{ "object": string }',
    run: async (i, ctx) => {
      const d = await ctx.metadata.describeObject(str(i.object, "object"));
      const catalog = buildCatalog(d, defaultRenderProfile);
      const create = { code: `TC-${d.object.api_name.toUpperCase()}-CREATE`, title: `Create a ${d.object.label}` };
      const script = renderSpec(d, { ...create, object: d.object.api_name, kind: "ui", technique: "crud", suiteTypes: ["sanity"], priority: "p1", preconditions: [], steps: [], expectedResult: "", requirementRefs: [] }, catalog);
      const lint = lintScript(script, catalog, defaultChromeAllow);
      const confidence = scoreAgainstRepo(d, { script, catalog });
      return { object: d.object.api_name, script, lintOk: lint.ok, violations: lint.violations, confidence };
    },
  },
  {
    name: "run_suite",
    description: "SIMULATED bookkeeping run for metadata objects only. Do not use for real app validation; show cases/scripts first, then use run_headless after user approval.",
    inputHint: '{ "object": string, "suiteType": "sanity"|"regression"|"bvt"|"api" }',
    run: async (i, ctx) => {
      return { executed: false, error: "Simulated suite execution is disabled. Review generated steps/scripts, then use run_headless against the configured target URL." };
    },
  },
  {
    name: "run_headless",
    description: "After user approval, run the grounded create-flow in a REAL headless browser (Playwright) against a target base URL, capturing screenshots, a trace, and the browser console.",
    inputHint: '{ "object": string, "baseUrl"?: string }',
    run: async (i, ctx) => {
      const object = str(i.object, "object");
      const d = await ctx.metadata.describeObject(object);
      const baseUrl = (typeof i.baseUrl === "string" && i.baseUrl) || (ctx.repo as { baseUrl?: string } | undefined)?.baseUrl || process.env.ATP_TARGET_URL;
      if (!baseUrl) return { executed: false, note: "No target URL. Pass baseUrl or set ATP_TARGET_URL to your running app, then I can run the script headless." };
      const catalog = buildCatalog(d, defaultRenderProfile);
      const route = routeFor(defaultRenderProfile, "create", { app: d.object.app, object });
      const fields = d.fields.filter((f) => f.required && f.api_name !== "id").map((f) => ({ field: f.api_name, value: sampleValue(f, d.picklists) }));
      const runId = `hl-${Date.now().toString(36)}`;
      const creds = ctx.resolveCreds ? await ctx.resolveCreds(baseUrl).catch(() => null) : null;
      const login = creds ? { url: creds.loginUrl, username: creds.username, password: creds.password } : undefined;
      const result = await runCreateFlow({ baseUrl, route, label: d.object.label, fields, catalog, evidenceDir: `storage/evidence/${runId}`, login });
      return {
        runId, object, suiteType: "headless", baseUrl, executed: true, headless: true, loggedIn: Boolean(login),
        total: result.total, passed: result.passed, failed: result.failed,
        status: result.status === "pass" ? "passed" : "failed",
        url: result.url, durationMs: result.durationMs,
        steps: result.steps.map((s) => ({ name: s.name, status: s.status, error: s.error })),
        consoleLines: result.console.length,
        evidence: { dir: `storage/evidence/${runId}`, trace: result.tracePath, screenshots: result.steps.filter((s) => s.screenshot).length },
        error: result.error,
      };
    },
  },
  {
    name: "get_run",
    description: "Get a run's summary + per-case results.",
    inputHint: '{ "runId": string }',
    run: async (i, ctx) => {
      const r = ctx.runs.get(str(i.runId, "runId"));
      if (!r) throw new Error(`unknown run: ${i.runId}`);
      return r;
    },
  },
  {
    name: "get_evidence",
    description: "List evidence artifacts captured for a run.",
    inputHint: '{ "runId": string }',
    run: async (i, ctx) => {
      const r = ctx.runs.get(str(i.runId, "runId"));
      if (!r) throw new Error(`unknown run: ${i.runId}`);
      return r.evidence;
    },
  },
  {
    name: "connect_repo",
    description: "Connect a LOCAL git folder (path) or a REMOTE GitHub URL as the source of truth for the app under test.",
    inputHint: '{ "path"?: string, "url"?: string }',
    run: async (i, ctx) => {
      const info = await connectRepo({ path: typeof i.path === "string" ? i.path : undefined, url: typeof i.url === "string" ? i.url : undefined });
      ctx.repo = info;
      return info;
    },
  },
  {
    name: "repo_info",
    description: "Show the currently connected repo (branch, sha, framework, file count).",
    inputHint: "{}",
    run: async (_i, ctx) => ctx.repo ?? { connected: false, note: "no repo connected — use connect_repo with a local path or a GitHub URL" },
  },
  {
    name: "connect_org",
    description: "Connect a target platform org (DB CRUD). Production orgs require approval before writes.",
    inputHint: '{ "name": string, "baseUrl": string, "isProduction"?: boolean }',
    run: async (i, ctx) => {
      const name = str(i.name, "name");
      const org = { name, baseUrl: str(i.baseUrl, "baseUrl"), isProduction: Boolean(i.isProduction) };
      ctx.orgs.set(name, org);
      return { connected: true, ...org };
    },
  },
  {
    name: "query_records",
    description: "Record lookup is unavailable until a real live data source is connected.",
    inputHint: '{ "object": string }',
    run: async (i, _ctx) => ({ object: typeof i.object === "string" ? i.object : null, error: "No live record source is configured." }),
  },
];

export const TOOL_MAP: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Render the tool list for the system prompt ({{TOOLS}} placeholder). */
export function toolCatalogPrompt(): string {
  return TOOLS.map((t) => `- **${t.name}** ${t.inputHint} — ${t.description}`).join("\n");
}
