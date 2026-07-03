import '../../shared/env';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';

/**
 * Resolve the repo to operate on. DYNAMIC and never app-specific:
 *   1. an explicit repoPath passed by the caller (the SELECTED project's repoPath) —
 *      this is the normal path, so the agents research whatever app the user picked;
 *   2. else an optional GENERIC env override (GIT_AGENT_TARGET_REPO / TARGET_REPO)
 *      for single-repo deployments;
 *   3. else '' → callers surface "repo not configured" instead of guessing a path.
 * No application's path is hardcoded anywhere.
 */
export function resolveTargetRepo(explicit?: string): string {
  const explicitPath = (explicit || '').trim();
  if (explicitPath) return explicitPath;
  // Repo access is UI-configured: the Settings "server repository root" is the source of truth, so
  // the end user sets where code is searched without touching env. Read it lazily (db.settings is
  // populated after module load). The env var is only a last-resort for headless single-repo deploys
  // that were never configured in the UI — it never overrides a UI value. (Env stays for DB/keys.)
  const fromSettings = String((db as any).settings?.serverRepoRoot || '').trim();
  if (fromSettings) return fromSettings;
  // Fall back to a configured LOCAL project's repoPath (set per project in the UI: Edit project →
  // Repository → Local folder). Without this, a code path that DIDN'T thread the project's repoPath
  // (e.g. case generation) fails with "no repo configured" even though the project has one — the
  // exact contradiction where scope grounding read the files but case-gen then claimed no repo.
  const projects = Array.isArray((db as any).projects) ? (db as any).projects : [];
  for (const p of projects) {
    const rp = String(p?.repoPath || '').trim();
    if (p?.repoKind !== 'remote' && rp && existsSync(path.join(rp, '.git'))) return rp;
  }
  return (process.env.GIT_AGENT_TARGET_REPO || process.env.TARGET_REPO || '').trim();
}
// The standalone Git Agent dashboard (status/diff/sync) operates on the env-configured
// default repo; the PER-APP research path (gitGrep/readRepoFile) passes an explicit
// project repoPath instead — see those functions.
const gitAgentTargetRepo = resolveTargetRepo();
const gitAgentStatePath = path.resolve(process.cwd(), '.testflow-git-agent-state.json');

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runGit(cwd: string, args: string[], timeout = 120000) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    // NO size cap at all — read the entire file regardless of size, like Claude Code does. Node's
    // default maxBuffer is 1 MB and exceeding it makes git error out (so a big file would come back
    // empty); Infinity removes the limit so any file, however large, is read in full.
    maxBuffer: Infinity,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git exited ${result.status}`).trim());
  }

  return (result.stdout || '').trim();
}

function gitOutputOrEmpty(cwd: string, args: string[], timeout = 120000) {
  try {
    return runGit(cwd, args, timeout);
  } catch {
    return '';
  }
}

function readGitAgentState() {
  return readJsonFile(gitAgentStatePath, {
    targetRepo: gitAgentTargetRepo,
    trackedBranch: 'main',
    baselineCommit: '',
    lastGeneratedAt: '',
    lastHeadCommit: '',
    lastScan: null as any,
    lastGeneration: null as any,
  });
}

function writeGitAgentState(nextState: any) {
  const merged = {
    ...readGitAgentState(),
    targetRepo: gitAgentTargetRepo,
    trackedBranch: 'main',
    ...nextState,
  };
  writeJsonFile(gitAgentStatePath, merged);
  return merged;
}

// Best-effort area/surface label for a changed file, derived from GENERIC naming
// conventions that hold across most repos — never from one app's directory layout.
// Falls back to the file's own top-level directory so any project is classified.
function classifyChangedFile(filePath: string) {
  const n = filePath.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(admin|backoffice|console)(\/|$)/.test(n)) return { area: 'Admin', surface: '', suite: 'admin-changes' };
  if (/(^|\/)(api|service|services|server|backend|functions|lambda)(\/|$)/.test(n)) return { area: 'API / Service', surface: '', suite: 'api-changes' };
  if (/(^|\/)(web|www|frontend|front-end|client|ui|webapp)(\/|$)/.test(n)) return { area: 'Frontend', surface: '', suite: 'frontend-changes' };
  // Otherwise name the area after the file's top-level directory (repo-derived).
  const top = n.split('/').filter(Boolean)[0] || 'application';
  const label = top.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { area: label, surface: 'all', suite: `${top.replace(/[^a-z0-9]+/g, '-')}-changes` };
}

function riskForChangedFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (/routes|auth|permission|access|validation|trigger|bulk|delete|recycle|migration|schema/.test(normalized)) {
    return { risk: 'High', reason: 'Touches authorization, validation, destructive flow, schema, or backend route behavior.' };
  }
  if (/list-view|table|record|layout|form|search|export|workflow/.test(normalized)) {
    return { risk: 'Medium', reason: 'Touches user-visible workflow, records, table, search, export, or layout behavior.' };
  }
  return { risk: 'Low', reason: 'Change is outside the main E2E risk keywords.' };
}

function inferFeatureFromPath(filePath: string, area: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('search')) return 'Search';
  if (normalized.includes('export')) return 'Export';
  if (normalized.includes('permission') || normalized.includes('access') || normalized.includes('auth')) return 'Security';
  if (normalized.includes('validation') || normalized.includes('schema') || normalized.includes('form') || normalized.includes('modal')) return 'Validation';
  if (normalized.includes('list-view') || normalized.includes('table')) return 'List View';
  if (normalized.includes('workflow')) return 'Workflow';
  if (normalized.includes('settings')) return 'Settings';
  return area;
}

function sanitizeTag(tag: string) {
  const normalized = String(tag || '').trim().toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]+/g, '-');
  return normalized ? `@${normalized}` : '';
}

function buildGitAgentSteps(change: any, scenarioFamily: string, feature: string) {
  const fileName = path.basename(change.path);
  const surface = change.surface || 'application';
  const baseSteps =
    surface === 'API'
      ? [
          { action: 'Open the impacted API or service endpoint flow using the available test harness or API client.', expected: 'The impacted API surface is reachable.' },
          { action: `Exercise the ${feature.toLowerCase()} behavior affected by ${fileName} with valid input.`, expected: 'The API returns the expected success response and payload shape.' },
          { action: 'Verify downstream consumers or dependent reads still behave correctly after the change.', expected: 'Connected downstream behavior remains stable.' },
        ]
      : [
          { action: `Open the ${surface} application and sign in with the configured test credentials.`, expected: `The ${surface} application loads for an authenticated user.` },
          { action: `Navigate to the ${feature} area impacted by ${fileName}.`, expected: 'The impacted screen or table is reachable.' },
          { action: `Exercise the changed ${feature.toLowerCase()} path with valid input and observe the resulting page or table state.`, expected: 'The changed path completes successfully and the UI state remains valid.' },
        ];

  if (scenarioFamily === 'Security' || scenarioFamily === 'Validation') {
    return [
      ...baseSteps.slice(0, 2),
      { action: `Submit invalid, unauthorized, or guarded input against the ${feature.toLowerCase()} behavior changed in ${fileName}.`, expected: 'The application rejects the request safely without a crash or silent corruption.' },
      { action: 'Verify the original data or visible UI state was not mutated by the rejected action.', expected: 'Protected state remains unchanged and the failure is visible.' },
    ];
  }

  if (scenarioFamily === 'Mutation') {
    return [
      ...baseSteps.slice(0, 2),
      { action: `Run a create, update, delete, restore, bulk, or lifecycle action associated with ${fileName} using disposable data.`, expected: 'The guarded write flow succeeds for valid disposable data.' },
      { action: 'Verify the resulting record, table, or downstream screen reflects the completed write action correctly.', expected: 'The mutation is visible and leaves the system in a consistent state.' },
    ];
  }

  if (scenarioFamily === 'Regression') {
    return [
      ...baseSteps,
      { action: 'Refresh the page, revisit the impacted area, and verify related downstream navigation or readback behavior.', expected: 'Downstream behavior remains stable after the code change.' },
    ];
  }

  return baseSteps;
}

function buildGitAgentScenarioTemplates(change: any, index: number) {
  const feature = inferFeatureFromPath(change.path, change.area);
  const fileName = path.basename(change.path);
  const baseId = `GIT-${String(index + 1).padStart(3, '0')}`;
  const surfaceLabel = change.surface;
  const baseTags = [sanitizeTag(change.area), sanitizeTag(feature), '@git-change'].filter(Boolean);
  const scenarios = [
    {
      id: `${baseId}-SAN`,
      title: `Sanity verifies ${feature.toLowerCase()} happy path after ${fileName}`,
      scenarioFamily: 'Sanity',
      tags: [...baseTags, '@sanity'],
      priority: change.risk === 'High' ? 'High' : 'Medium',
      expected: 'The changed feature completes its primary path and leaves the resulting state valid.',
    },
    {
      id: `${baseId}-REG`,
      title: `Regression protects downstream ${feature.toLowerCase()} behavior after ${fileName}`,
      scenarioFamily: 'Regression',
      tags: [...baseTags, '@regression'],
      priority: change.risk === 'High' ? 'High' : 'Medium',
      expected: 'Connected downstream behavior remains stable after the change.',
    },
  ];

  if (change.risk === 'High' || /auth|permission|access|validation|schema|route|api/i.test(change.path)) {
    scenarios.unshift({
      id: `${baseId}-BVT`,
      title: `BVT verifies guarded ${feature.toLowerCase()} behavior after ${fileName}`,
      scenarioFamily: /auth|permission|access|security/i.test(change.path) ? 'Security' : 'Validation',
      tags: [...baseTags, '@bvt'],
      priority: 'Critical',
      expected: 'Guarded behavior remains enforced and invalid or unauthorized input is rejected safely.',
    });
  }

  if (/create|update|delete|restore|bulk|recycle|import|export/i.test(change.path)) {
    scenarios.push({
      id: `${baseId}-MUT`,
      title: `Regression verifies guarded write flow after ${fileName}`,
      scenarioFamily: 'Mutation',
      tags: [...baseTags, '@regression'],
      priority: 'High',
      expected: 'The write flow works on disposable data and leaves the system in a consistent state.',
    });
  }

  return scenarios.map((scenario) => ({
    ...scenario,
    sourcePath: change.path,
    area: change.area,
    surface: change.surface,
    surfaceLabel,
    feature,
    steps: buildGitAgentSteps(change, scenario.scenarioFamily, feature),
    description: `${change.area} ${feature} coverage derived from git changes in ${fileName}. ${change.reason}`,
    type: change.surface === 'api' ? 'Automated' : 'Manual',
    createdBy: 'Git Agent',
    risk: change.risk,
  }));
}

function toSpecName(value: string) {
  return String(value || 'git-change')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'git-change';
}

function escapeScriptString(value: string) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function buildPlaywrightScript(testCase: any) {
  const title = escapeScriptString(testCase.title || 'Git change coverage');
  const sourcePath = escapeScriptString(testCase.sourcePath || '');
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  const body = steps
    .map((step: any, index: number) => {
      const action = escapeScriptString(step?.action || `Execute step ${index + 1}`);
      const expected = escapeScriptString(step?.expected || 'Expected behavior is observed.');
      return [
        `  await test.step(\`${index + 1}. ${action}\`, async () => {`,
        `    // Expected: ${expected}`,
        index === 0 && testCase.surface !== 'api'
          ? `    // Navigate and authenticate using the configured website credentials before exercising this path.`
          : `    // Implement selectors/assertions for this impacted path. Source: ${sourcePath}`,
        `  });`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe('Git change coverage: ${escapeScriptString(testCase.feature || testCase.area || 'Application')}', () => {`,
    `  test('${title}', async ({ page, request }) => {`,
    body || `  // Add generated test steps before execution.`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function buildGitAgentScripts(testCases: any[]) {
  return testCases.map((testCase: any, index: number) => {
    const filename = `${toSpecName(testCase.title || testCase.id)}.spec.ts`;
    const matchingScripts = db.scripts.filter((script: any) => script?.sourcePath === testCase.sourcePath || script?.gitSourcePath === testCase.sourcePath);
    const currentScript = matchingScripts[0] || null;
    const code = buildPlaywrightScript(testCase);
    return {
      id: `GIT-SCRIPT-${testCase.id || index + 1}`,
      filename,
      title: testCase.title,
      testCaseId: testCase.id,
      sourcePath: testCase.sourcePath,
      gitSourcePath: testCase.sourcePath,
      code,
      currentScript: currentScript
        ? {
            id: currentScript.id,
            filename: currentScript.filename || currentScript.name || 'existing-script.spec.ts',
            title: currentScript.title || currentScript.name || 'Existing script',
            code: currentScript.code || '',
            updatedAt: currentScript.updatedAt || currentScript.createdAt || '',
          }
        : null,
      impact: {
        status: currentScript ? 'Updated Coverage' : 'New Coverage',
        summary: currentScript
          ? 'Existing script coverage was found for this changed source path. Review the new draft against the current script before replacing it.'
          : 'No existing script coverage was found for this changed source path. The generated script is a new draft.',
      },
    };
  });
}

function summarizeChangedFiles(changedFiles: any[]) {
  return changedFiles.reduce((acc: any, item: any) => {
    acc.total += 1;
    acc.byArea[item.area] = (acc.byArea[item.area] || 0) + 1;
    acc.byRisk[item.risk] = (acc.byRisk[item.risk] || 0) + 1;
    return acc;
  }, { total: 0, byArea: {}, byRisk: {} });
}

export function getGitRepoStatus() {
  const state = readGitAgentState();
  const exists = existsSync(path.join(gitAgentTargetRepo, '.git'));
  if (!exists) {
    return {
      repoPath: gitAgentTargetRepo,
      exists: false,
      branch: '',
      headCommit: '',
      remoteMainCommit: '',
      clean: false,
      status: '',
      behindCount: 0,
      hasRemoteChanges: false,
      blockedReason: 'Target repo was not found.',
      baselineCommit: state.baselineCommit || '',
      lastGeneratedAt: state.lastGeneratedAt || '',
      lastScan: state.lastScan || null,
      lastGeneration: state.lastGeneration || null,
    };
  }

  const status = gitOutputOrEmpty(gitAgentTargetRepo, ['status', '--short']);
  const branch = gitOutputOrEmpty(gitAgentTargetRepo, ['branch', '--show-current']) || 'main';
  const headCommit = gitOutputOrEmpty(gitAgentTargetRepo, ['rev-parse', 'HEAD']);
  const remoteMainCommit = gitOutputOrEmpty(gitAgentTargetRepo, ['rev-parse', 'origin/main']);
  const behindCount = Number(gitOutputOrEmpty(gitAgentTargetRepo, ['rev-list', '--count', `${headCommit}..origin/main`]) || 0);

  return {
    repoPath: gitAgentTargetRepo,
    exists: true,
    branch,
    headCommit,
    remoteMainCommit,
    clean: !status,
    status,
    behindCount,
    hasRemoteChanges: behindCount > 0,
    blockedReason: behindCount > 0 && status ? 'Local changes detected. Fetched main, but skipped pull to avoid overwriting the worktree.' : '',
    baselineCommit: state.baselineCommit || '',
    lastGeneratedAt: state.lastGeneratedAt || '',
    lastScan: state.lastScan || null,
    lastGeneration: state.lastGeneration || null,
  };
}

export function syncGitAgentMain() {
  if (!existsSync(path.join(gitAgentTargetRepo, '.git'))) {
    throw new Error(`Target repo was not found at ${gitAgentTargetRepo}.`);
  }

  const before = getGitRepoStatus();
  runGit(gitAgentTargetRepo, ['fetch', 'origin', 'main'], 180000);
  const afterFetch = getGitRepoStatus();
  let pulled = false;
  let blockedReason = '';

  if (afterFetch.hasRemoteChanges) {
    if (!afterFetch.clean) {
      blockedReason = 'Local changes detected. Fetched main, but skipped pull.';
    } else {
      runGit(gitAgentTargetRepo, ['pull', '--ff-only', 'origin', 'main'], 180000);
      pulled = true;
    }
  }

  const after = getGitRepoStatus();
  writeGitAgentState({ lastHeadCommit: after.headCommit });
  return { ok: true, before, after, pulled, blockedReason };
}

export function scanGitAgentChanges(baseRef = 'auto') {
  if (!existsSync(path.join(gitAgentTargetRepo, '.git'))) {
    throw new Error(`Target repo was not found at ${gitAgentTargetRepo}.`);
  }

  const state = readGitAgentState();
  const resolvedBaseRef = String(baseRef || '').trim() && baseRef !== 'auto'
    ? String(baseRef).trim()
    : state.baselineCommit || 'HEAD~1';
  const repoStatus = getGitRepoStatus();
  const headCommit = gitOutputOrEmpty(gitAgentTargetRepo, ['rev-parse', 'HEAD']);

  let output = '';
  try {
    output = runGit(gitAgentTargetRepo, ['diff', '--name-status', `${resolvedBaseRef}...HEAD`]);
  } catch {
    output = runGit(gitAgentTargetRepo, ['diff', '--name-status', resolvedBaseRef, 'HEAD']);
  }

  if (repoStatus.status) {
    output = [output, repoStatus.status].filter(Boolean).join('\n');
  }

  const changedFiles = Array.from(new Map(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.trim().split(/\s+/);
        const filePath = rest[rest.length - 1] || '';
        const classification = classifyChangedFile(filePath);
        const risk = riskForChangedFile(filePath);
        return [filePath, {
          status,
          path: filePath,
          ...classification,
          ...risk,
        }];
      })
  ).values());

  const scan = {
    repoPath: gitAgentTargetRepo,
    requestedBaseRef: baseRef,
    baseRef: resolvedBaseRef,
    headCommit,
    branch: repoStatus.branch,
    clean: repoStatus.clean,
    pullBlocked: Boolean(repoStatus.blockedReason),
    blockedReason: repoStatus.blockedReason,
    changedFiles,
    summary: summarizeChangedFiles(changedFiles),
    scannedAt: new Date().toISOString(),
  };

  writeGitAgentState({ lastScan: scan, lastHeadCommit: headCommit });
  return scan;
}

function persistGitAgentArtifacts(generation: any) {
  const now = new Date();
  const stamp = generation.generatedAt.replace(/[-:TZ.]/g, '').slice(0, 14);
  const planId = `PLAN-GIT-${stamp}`;
  const planName = `Git Change Plan - ${generation.branch} - ${stamp}`;

  db.plans.unshift({
    id: planId,
    name: planName,
    scope: generation.repoPath,
    objectives: `Validate code changes from ${generation.baseRef} to ${generation.headCommit}.`,
    strategy: 'Git-diff-driven QA coverage generation',
    testTypes: 'BVT, Sanity, Regression',
    environments: generation.repoPath,
    roles: 'Git Agent',
    status: 'Draft',
    createdBy: 'Git Agent',
    createdAt: now,
    gitAgentRunId: generation.id,
  });

  const suiteIds = new Map<string, string>();
  for (const area of Object.keys(generation.suites)) {
    const suiteId = `SUITE-GIT-${stamp}-${String(area).replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}`;
    suiteIds.set(area, suiteId);
    db.suites.unshift({
      id: suiteId,
      name: `Git Change Suite - ${area}`,
      description: `Draft cases for ${area} changes detected in ${generation.repoPath}.`,
      testPlanId: planId,
      parentSuite: '',
      module: area,
      owner: 'Git Agent',
      tags: ['@git-change', sanitizeTag(area)].filter(Boolean),
      priority: generation.summary.byRisk.High ? 'High' : 'Medium',
      status: 'Draft',
      createdBy: 'Git Agent',
      createdAt: now,
      gitAgentRunId: generation.id,
    });
  }

  generation.testCases.forEach((testCase: any, index: number) => {
    db.cases.unshift({
      id: `TC-GIT-${stamp}-${String(index + 1).padStart(3, '0')}`,
      title: testCase.title,
      description: buildCaseDescription(testCase),
      steps: normalizeCaseSteps(testCase.steps),
      testPlanId: planId,
      testSuiteId: suiteIds.get(testCase.area) || '',
      status: 'Draft',
      tags: normalizeCaseTags(testCase.tags || []),
      type: testCase.type || 'Manual',
      priority: testCase.priority || 'Medium',
      createdBy: 'Git Agent',
      createdAt: now,
      gitAgentRunId: generation.id,
      sourcePath: testCase.sourcePath,
    });
  });

  (generation.scripts || []).forEach((script: any, index: number) => {
    const scriptId = `SCR-GIT-${stamp}-${String(index + 1).padStart(3, '0')}`;
    const scriptPayload = {
      id: scriptId,
      name: script.filename || script.title || `Git Agent Script - ${index + 1}`,
      filename: script.filename || `git-agent-script-${stamp}-${index + 1}.spec.ts`,
      title: script.title || script.filename || `Git Agent Script - ${index + 1}`,
      code: script.code || '',
      language: 'typescript',
      framework: 'playwright',
      status: 'Draft',
      folderId: '',
      gitAgentRunId: generation.id,
      sourcePath: script.sourcePath || '',
      gitSourcePath: script.gitSourcePath || script.sourcePath || '',
      impact: script.impact || null,
      createdBy: 'Git Agent',
      createdAt: now,
      updatedAt: now,
    };
    const existingIndex = db.scripts.findIndex((item: any) => item.id === scriptId);
    if (existingIndex >= 0) {
      db.scripts[existingIndex] = { ...db.scripts[existingIndex], ...scriptPayload };
    } else {
      db.scripts.unshift(scriptPayload);
    }
  });
}

export const GIT_AGENT_TARGET_REPO = gitAgentTargetRepo;

/** Surface a changed/searched file to its core-platform area. Exported for the requirement discovery flow. */
export { classifyChangedFile };

/**
 * Generic SOURCE file globs (by extension, NOT by app-specific directory). Searching
 * the whole repo for these works for ANY application's layout, while skipping binaries,
 * lockfiles, and most docs. No core-platform paths are assumed.
 */
const SOURCE_GLOBS = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue', '*.svelte',
  '*.py', '*.go', '*.java', '*.kt', '*.rb', '*.cs', '*.php', '*.rs', '*.swift', '*.scala',
  '*.html', '*.css', '*.scss', '*.sql', '*.json', '*.yml', '*.yaml', '*.graphql', '*.proto',
];

/**
 * Run `git grep` in the target repo for any of the given patterns, restricted to the
 * given pathspecs. Defaults to source files across the WHOLE repo (app-agnostic), so
 * the agents research any application's real code. Returns matching tracked files,
 * each tagged with a best-effort area. Case-insensitive, names-only.
 */
export function gitGrep(patterns: string[], pathspecs: string[] = SOURCE_GLOBS, maxFiles = 60, repoPath?: string) {
  const repo = resolveTargetRepo(repoPath);
  if (!repo || !existsSync(path.join(repo, '.git'))) {
    throw new Error(`Target repo was not found${repo ? ` at ${repo}` : ' (no repo configured for this project)'}.`);
  }
  const cleanPatterns = patterns.map((p) => String(p || '').trim()).filter((p) => p.length >= 2);
  if (!cleanPatterns.length) return [] as Array<{ path: string; area: string; surface: string }>;

  // -l names only, -i case-insensitive, -I skip binary, --or so any pattern matches.
  const orArgs: string[] = [];
  cleanPatterns.forEach((p, i) => {
    if (i > 0) orArgs.push('--or');
    orArgs.push('-e', p);
  });

  const out = gitOutputOrEmpty(repo, ['grep', '-l', '-i', '-I', ...orArgs, '--', ...pathspecs], 60000);
  const files = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const results: Array<{ path: string; area: string; surface: string }> = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const c = classifyChangedFile(file);
    results.push({ path: file, area: c.area, surface: c.surface });
    if (results.length >= maxFiles) break;
  }
  return results;
}

export interface CodeMatch { path: string; matchCount: number; snippet: string; }

/**
 * Real RIPGREP search (via @vscode/ripgrep's bundled binary) returning matching lines + context.
 * Faster than git grep, respects .gitignore, regex, type filters. Returns null if rg can't run
 * (so the caller falls back to git grep); returns [] if rg ran but found nothing.
 */
function ripgrepWithContext(patterns: string[], repo: string, ctx: number, maxFiles: number, maxLinesPerFile: number): CodeMatch[] | null {
  // Pass the repo as ripgrep's search PATH (forward-slashed) instead of using cwd. On Windows,
  // spawnSync with an absolute exe + a changed cwd throws ENOENT, and a backslash path arg gets
  // mangled (e.g. "D:\repo" -> "D:repo"); a forward-slashed path argument with no cwd works correctly.
  const searchPath = repo.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${searchPath}/`;
  const orArgs = patterns.flatMap((p) => ['-e', p]);
  const res = spawnSync(rgPath, [
    '--json', '-i', '-C', String(ctx),
    '-g', '!*.md', '-g', '!*.mdx', '-g', '!*.markdown',
    '-g', '!**/node_modules/**', '-g', '!**/.git/**', '-g', '!**/dist/**', '-g', '!**/build/**',
    '-g', '!*.min.*', '-g', '!*.map', '-g', '!**/coverage/**',
    ...orArgs, searchPath,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 * 256, windowsHide: true });
  if (res.error || res.status === 2 || res.status === null) return null; // rg unavailable/errored → fall back

  const byFile = new Map<string, { lines: string[]; count: number }>();
  let cur: { path: string; lines: string[]; count: number } | null = null;
  for (const raw of (res.stdout || '').split(/\r?\n/)) {
    if (!raw) continue;
    let ev: any;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type === 'begin') {
      let p = String(ev.data?.path?.text || '').replace(/\\/g, '/');
      if (p.startsWith(prefix)) p = p.slice(prefix.length); // make repo-relative
      cur = { path: p, lines: [], count: 0 };
    } else if (ev.type === 'match' && cur) {
      const n = ev.data?.line_number ?? '';
      const t = String(ev.data?.lines?.text || '').replace(/\r?\n$/, '');
      cur.lines.push(`${n}: ${t}`);
      cur.count += Array.isArray(ev.data?.submatches) ? ev.data.submatches.length : 1;
    } else if (ev.type === 'context' && cur) {
      const n = ev.data?.line_number ?? '';
      const t = String(ev.data?.lines?.text || '').replace(/\r?\n$/, '');
      cur.lines.push(`${n}  ${t}`);
    } else if (ev.type === 'end' && cur) {
      if (cur.path && cur.count > 0) byFile.set(cur.path, { lines: cur.lines.slice(0, maxLinesPerFile), count: cur.count });
      cur = null;
    }
  }
  return Array.from(byFile.entries())
    .map(([p, v]) => ({ path: p.replace(/^\.\//, ''), matchCount: v.count, snippet: v.lines.join('\n') }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, maxFiles);
}

/**
 * AGENTIC-SEARCH grep that returns MATCHING LINES WITH CONTEXT (not just file names) — the way
 * Claude Code's ripgrep does it. The agent immediately sees the real matching code (with a few
 * surrounding lines), so it can judge relevance and decide what to read next without a separate
 * read for every candidate. Backed by `git grep -C` (portable — uses the git that's already here;
 * no ripgrep binary needed). Files ranked by match count; markdown excluded. Returns [] on failure
 * so the caller can fall back to the plain file-name grep.
 */
export function searchCodeWithContext(
  patterns: string[],
  repoPath?: string,
  opts: { maxFiles?: number; contextLines?: number; maxLinesPerFile?: number; pathspecs?: string[] } = {},
): CodeMatch[] {
  const repo = resolveTargetRepo(repoPath);
  if (!repo || !existsSync(path.join(repo, '.git'))) return [];
  const clean = Array.from(new Set(patterns.map((p) => String(p || '').trim()).filter((p) => p.length >= 2)));
  if (!clean.length) return [];
  const ctx = opts.contextLines ?? 2;
  const maxFiles = opts.maxFiles ?? 40;
  const maxLinesPerFile = opts.maxLinesPerFile ?? 60;

  // PRIMARY: real ripgrep (faster, .gitignore-aware, regex). FALLBACK: git grep (always present).
  const rg = ripgrepWithContext(clean, repo, ctx, maxFiles, maxLinesPerFile);
  if (rg !== null) return rg;

  const orArgs: string[] = [];
  clean.forEach((p, i) => { if (i > 0) orArgs.push('--or'); orArgs.push('-e', p); });
  const pathspecs = opts.pathspecs && opts.pathspecs.length ? opts.pathspecs : ['.'];
  const excludes = [':(exclude)*.md', ':(exclude)*.mdx', ':(exclude)*.markdown'];

  // --heading puts the filename on its own line and strips the path prefix from each match/context
  // line; --break inserts a blank line between files — both make the output cleanly parseable.
  const out = gitOutputOrEmpty(
    repo,
    ['grep', '-n', '-i', '-I', '-C', String(ctx), '--heading', '--break', ...orArgs, '--', ...pathspecs, ...excludes],
    60000,
  );
  if (!out.trim()) return [];

  const results: CodeMatch[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) continue;
    const headIdx = lines.findIndex((l) => !/^\d+[:-]/.test(l));
    const filePath = (headIdx >= 0 ? lines[headIdx] : '').trim().replace(/\\/g, '/');
    if (!filePath || /\.(md|mdx|markdown)$/i.test(filePath)) continue;
    const body = lines.filter((l) => /^\d+[:-]/.test(l) || l === '--');
    const matchCount = body.filter((l) => /^\d+:/.test(l)).length;
    if (!matchCount) continue;
    results.push({ path: filePath, matchCount, snippet: body.slice(0, maxLinesPerFile).join('\n') });
  }
  return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, maxFiles);
}

/** List tracked source files in the target repo. Used by broad feature discovery so
 * important route/page/feature files are considered even when generic grep terms miss them. */
export function listRepoSourceFiles(repoPath?: string, maxFiles = 8000) {
  const repo = resolveTargetRepo(repoPath);
  if (!repo || !existsSync(path.join(repo, '.git'))) {
    throw new Error(`Target repo was not found${repo ? ` at ${repo}` : ' (no repo configured for this project)'}.`);
  }
  const out = gitOutputOrEmpty(repo, ['ls-files', '--', ...SOURCE_GLOBS], 60000);
  const seen = new Set<string>();
  const results: Array<{ path: string; area: string; surface: string }> = [];
  for (const file of out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const c = classifyChangedFile(file);
    results.push({ path: file, area: c.area, surface: c.surface });
    if (results.length >= maxFiles) break;
  }
  return results;
}

/** Read a tracked file's content at HEAD from the target repo, capped to maxBytes. */
export function readRepoFile(relPath: string, maxBytes = 6000, repoPath?: string): string {
  const repo = resolveTargetRepo(repoPath);
  if (!repo || !existsSync(path.join(repo, '.git'))) {
    throw new Error(`Target repo was not found${repo ? ` at ${repo}` : ' (no repo configured for this project)'}.`);
  }
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return '';
  // Read the ENTIRE file — every line, no byte cap. Agents must see the whole file (the logic,
  // validations, limits, and error branches live deep in the file, not in the first few KB).
  void maxBytes;
  return gitOutputOrEmpty(repo, ['show', `HEAD:${normalized}`], 30000);
}

/**
 * Returns the actual unified diff (committed + staged + working tree) between the
 * resolved base ref and HEAD, capped to keep token cost bounded. Used by the AI
 * code-change analysis so it reasons over real content, not just file names.
 */
export function getGitAgentDiff(baseRef = 'auto', maxChars = 16000): string {
  if (!existsSync(path.join(gitAgentTargetRepo, '.git'))) {
    throw new Error(`Target repo was not found at ${gitAgentTargetRepo}.`);
  }
  const state = readGitAgentState();
  const resolvedBaseRef = String(baseRef || '').trim() && baseRef !== 'auto'
    ? String(baseRef).trim()
    : state.baselineCommit || 'HEAD~1';
  let committed = '';
  try {
    committed = gitOutputOrEmpty(gitAgentTargetRepo, ['diff', '--unified=3', `${resolvedBaseRef}...HEAD`]);
  } catch {
    committed = '';
  }
  const staged = gitOutputOrEmpty(gitAgentTargetRepo, ['diff', '--cached', '--unified=3']);
  const working = gitOutputOrEmpty(gitAgentTargetRepo, ['diff', '--unified=3']);
  const combined = [committed, staged, working].filter(Boolean).join('\n');
  return combined.length > maxChars ? `${combined.slice(0, maxChars)}\n... [diff truncated]` : combined;
}

export async function generateGitAgentCases(baseRef = 'auto') {
  const scan = scanGitAgentChanges(baseRef);
  const templates = scan.changedFiles.flatMap((change: any, index: number) => buildGitAgentScenarioTemplates(change, index));
  const scripts = buildGitAgentScripts(templates);
  const groupedSuites = templates.reduce((acc: any, testCase: any) => {
    acc[testCase.area] = acc[testCase.area] || [];
    acc[testCase.area].push(testCase);
    return acc;
  }, {});

  const generation = {
    id: `git-agent-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    repoPath: gitAgentTargetRepo,
    branch: scan.branch,
    baseRef: scan.baseRef,
    headCommit: scan.headCommit,
    summary: {
      ...scan.summary,
      caseCount: templates.length,
      suiteCount: Object.keys(groupedSuites).length,
    },
    changedFiles: scan.changedFiles,
    suites: groupedSuites,
    testCases: templates,
    scripts,
  };

  persistGitAgentArtifacts(generation);
  writeGitAgentState({
    baselineCommit: scan.headCommit,
    lastGeneratedAt: generation.generatedAt,
    lastGeneration: {
      id: generation.id,
      generatedAt: generation.generatedAt,
      baseRef: generation.baseRef,
      headCommit: generation.headCommit,
      summary: generation.summary,
      changedFiles: generation.changedFiles,
      testCases: generation.testCases,
      scripts: generation.scripts,
    },
  });
  addActivity(`Git Agent generated ${templates.length} draft test cases and ${scripts.length} Playwright scripts from ${scan.changedFiles.length} changed files.`);
  persistDataInBackground('git agent artifacts');
  return generation;
}
