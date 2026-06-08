import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';

const gitAgentTargetRepo = 'D:\\core-platform';
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

function classifyChangedFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('apps/admin/')) return { area: 'Admin', surface: 'admin', suite: 'admin-changes' };
  if (normalized.includes('apps/shockwave/')) return { area: 'Keystone / Shockwave', surface: 'keystone', suite: 'keystone-changes' };
  if (normalized.includes('apps/service/')) return { area: 'API / Service', surface: 'api', suite: 'api-changes' };
  if (normalized.includes('metadata/') || normalized.includes('seeds/')) return { area: 'Metadata', surface: 'all', suite: 'metadata-changes' };
  if (normalized.includes('packages/list-view/') || normalized.includes('list-view')) return { area: 'Shared List View', surface: 'all', suite: 'shared-list-view-changes' };
  if (normalized.includes('packages/ui/')) return { area: 'Shared UI', surface: 'all', suite: 'shared-ui-changes' };
  return { area: 'Application', surface: 'all', suite: 'application-changes' };
}

function riskForChangedFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (/routes|auth|permission|access|validation|trigger|bulk|delete|recycle|migration|schema/.test(normalized)) {
    return { risk: 'High', reason: 'Touches authorization, validation, destructive flow, schema, or backend route behavior.' };
  }
  if (/list-view|table|record|layout|form|search|export|workflow|flow/.test(normalized)) {
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
  if (normalized.includes('flow') || normalized.includes('workflow')) return 'Workflow';
  if (normalized.includes('settings')) return 'Settings';
  return area;
}

function sanitizeTag(tag: string) {
  const normalized = String(tag || '').trim().toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]+/g, '-');
  return normalized ? `@${normalized}` : '';
}

function buildGitAgentSteps(change: any, scenarioFamily: string, feature: string) {
  const fileName = path.basename(change.path);
  const surface = change.surface === 'api' ? 'API' : change.surface === 'keystone' ? 'Keystone' : 'Admin';
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
  const surfaceLabel = change.surface === 'api' ? 'API' : change.surface === 'keystone' ? 'Keystone' : change.surface === 'admin' ? 'Admin' : 'Application';
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
