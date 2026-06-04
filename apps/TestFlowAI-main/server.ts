import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer as createViteServer } from 'vite';
import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { chromium } from 'playwright';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

dotenv.config({
  path: [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')],
  override: true,
});

function getGeminiApiKey() {
  const key = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim().replace(/^['"]|['"]$/g, '');

  if (!key) {
    throw new Error('Gemini API key is missing. Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in .env.local.');
  }

  if (key === 'MY_GEMINI_API_KEY' || key.includes('MY_GEMINI_API_KEY')) {
    throw new Error('Gemini API key is still the placeholder value. Replace it with a real Google AI Studio API key.');
  }

  return key;
}

function getGeminiKeyStatus() {
  const rawKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
  const key = rawKey.trim().replace(/^['"]|['"]$/g, '');

  return {
    configured: Boolean(key),
    length: key.length,
    prefix: key ? `${key.slice(0, 6)}...` : '',
    source:
      process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' :
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'GOOGLE_GENERATIVE_AI_API_KEY' :
      process.env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' :
      'none',
    looksLikeGeminiApiKey: key.startsWith('AIza'),
    looksLikeServiceAccountBoundKey: key.startsWith('AQ.'),
    looksLikeOAuthToken: key.startsWith('ya29.'),
  };
}

function createGeminiModel() {
  const apiKey = getGeminiApiKey();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  const google = createGoogleGenerativeAI({ apiKey });
  return google(db.settings?.geminiModel || 'gemini-2.5-flash');
}

function getAIErrorMessage(err: any) {
  const responseBody = typeof err?.responseBody === 'string' ? err.responseBody : '';
  const message = err?.message || 'AI generation failed.';

  if (message.includes('API Key not found') || responseBody.includes('API_KEY_INVALID')) {
    return 'Google rejected the configured Gemini API key. The local app is reading a key, but generativelanguage.googleapis.com says it is invalid. Create/copy a fresh Google AI Studio API key and replace GEMINI_API_KEY in .env.local.';
  }

  return message;
}

function normalizeTargetUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getUrlMatchKey(url: string) {
  const normalized = normalizeTargetUrl(url || '');
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return normalized.replace(/\/+$/, '').toLowerCase();
  }
}

const domainPattern = /\b((?:https?:\/\/)?(?:(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?(?:\/[^\s]*)?)/i;

function extractTargetUrl(message: string) {
  const match = message.match(domainPattern);
  if (!match) return '';
  return normalizeTargetUrl(match[1].replace(/[),.;!?]+$/, ''));
}

function extractCredentials(message: string) {
  const text = message || '';
  const usernameMatch =
    text.match(/\b(?:username|user\s*name|user|login|id)\s*(?:is|:|=)?\s*([^\n,;]+?)(?=\s+(?:and\s+)?(?:password|pass|pwd)\b|[,;.]|$)/i);
  const passwordMatch =
    text.match(/\b(?:password|pass|pwd)\s*(?:is|:|=)?\s*([^\n,;]+?)(?=\s+(?:and\s+)?(?:username|user\s*name|user|login|id)\b|[,;.]|$)/i);

  return {
    username: usernameMatch?.[1]?.trim() || '',
    password: passwordMatch?.[1]?.trim() || '',
  };
}

function buildCredentialContext(credentials: any) {
  if (!credentials?.username || !credentials?.password) {
    return 'No login credentials were provided.';
  }

  return `Use these exact login credentials when a login step is needed: username/email "${credentials.username}" and password "${credentials.password}". Generated test steps and Playwright scripts must explicitly fill these values instead of saying only "valid credentials".`;
}

function findSettingsCredentials(targetUrl: string) {
  const targetKey = getUrlMatchKey(targetUrl);
  if (!targetKey) return { username: '', password: '', source: 'none' };

  const allCredentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const credentials = allCredentials.filter((item: any) => item?.isPlaywrightTarget) || [];
  const searchSpace = credentials.length ? credentials : allCredentials;
  const match = searchSpace.find((item: any) => {
    const siteKey = getUrlMatchKey(item?.url || '');
    return siteKey && (targetKey === siteKey || targetKey.startsWith(siteKey) || siteKey.startsWith(targetKey));
  });

  return {
    username: match?.username?.trim?.() || '',
    password: match?.password?.trim?.() || '',
    source: match ? 'settings' : 'none',
  };
}

function normalizeLookupText(value: string) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findSettingsSiteByName(message: string) {
  const normalizedMessage = ` ${normalizeLookupText(message)} `;
  if (!normalizedMessage.trim()) return null;

  const allCredentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const selectedCredentials = allCredentials.filter((item: any) => item?.isPlaywrightTarget);
  const searchSpace = selectedCredentials.length ? selectedCredentials : allCredentials;
  return searchSpace.find((item: any) => {
    const name = normalizeLookupText(item?.name || '');
    return name && normalizedMessage.includes(` ${name} `);
  }) || null;
}

function findSettingsPlaywrightTargetUrl() {
  const credentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const selected = credentials.filter((item: any) => item?.isPlaywrightTarget && item?.url);
  if (selected.length > 0) return normalizeTargetUrl(selected[0].url);

  if (credentials.length === 1 && credentials[0]?.url) {
    return normalizeTargetUrl(credentials[0].url);
  }

  return '';
}

function resolveAgentTargetUrl(prompt: string, appUrl: string) {
  const explicitUrl = normalizeTargetUrl(appUrl || extractTargetUrl(prompt || '') || '');
  if (explicitUrl) return explicitUrl;

  const siteByName = findSettingsSiteByName(prompt || '');
  if (siteByName?.url) return normalizeTargetUrl(siteByName.url);

  return findSettingsPlaywrightTargetUrl();
}

function resolveAgentCredentials(prompt: string, targetUrl: string) {
  const chatCredentials = extractCredentials(prompt || '');
  if (chatCredentials.username && chatCredentials.password) {
    return { ...chatCredentials, source: 'chat' };
  }

  const siteByName = findSettingsSiteByName(prompt || '');
  if (siteByName?.username && siteByName?.password) {
    return {
      username: String(siteByName.username || '').trim(),
      password: String(siteByName.password || '').trim(),
      source: 'settings-name',
      siteName: siteByName.name || '',
    };
  }

  return findSettingsCredentials(targetUrl);
}

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

function summarizeChangedFiles(changedFiles: any[]) {
  return changedFiles.reduce((acc: any, item: any) => {
    acc.total += 1;
    acc.byArea[item.area] = (acc.byArea[item.area] || 0) + 1;
    acc.byRisk[item.risk] = (acc.byRisk[item.risk] || 0) + 1;
    return acc;
  }, { total: 0, byArea: {}, byRisk: {} });
}

function getGitRepoStatus() {
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

function syncGitAgentMain() {
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

function scanGitAgentChanges(baseRef = 'auto') {
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
}

async function generateGitAgentCases(baseRef = 'auto') {
  const scan = scanGitAgentChanges(baseRef);
  const templates = scan.changedFiles.flatMap((change: any, index: number) => buildGitAgentScenarioTemplates(change, index));
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
    },
  });
  addActivity(`Git Agent generated ${templates.length} draft test cases from ${scan.changedFiles.length} changed files.`);
  void savePersistedData().catch((error) => {
    console.error('Failed to persist git agent artifacts:', error);
  });
  return generation;
}

async function fillLocator(locator: any, value: string) {
  try {
    if (!(await locator.count())) return false;
    const field = locator.first();
    await field.waitFor({ state: 'visible', timeout: 5000 });
    await field.fill(value, { timeout: 5000 });
    await field.dispatchEvent('input').catch(() => undefined);
    await field.dispatchEvent('change').catch(() => undefined);

    try {
      const actualValue = await field.inputValue({ timeout: 1000 });
      return actualValue === value;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

async function fillFirstAvailable(page: any, selectors: string[], value: string) {
  if (!value) return false;

  for (const selector of selectors) {
    if (await fillLocator(page.locator(selector), value)) {
      return true;
    }
  }

  return false;
}

async function fillByAccessibleLabel(page: any, labels: RegExp[], value: string) {
  for (const label of labels) {
    if (await fillLocator(page.getByLabel(label), value)) {
      return true;
    }
  }

  return false;
}

async function fillVisibleInputFallback(page: any, value: string, fieldType: 'username' | 'password') {
  const selector = fieldType === 'password'
    ? 'input[type="password"]'
    : 'input:not([type="hidden"]):not([type="password"]):not([disabled])';
  const inputs = page.locator(selector);
  const count = await inputs.count();

  for (let index = 0; index < count; index += 1) {
    if (await fillLocator(inputs.nth(index), value)) {
      return true;
    }
  }

  return false;
}

async function fillByDomFallback(page: any, value: string, fieldType: 'username' | 'password') {
  if (!value) return false;

  return page.evaluate(({ value, fieldType }) => {
    const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
    const candidates = inputs.filter((input) => {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      if (input.disabled || input.readOnly || type === 'hidden') return false;
      return fieldType === 'password' ? type === 'password' : type !== 'password';
    });
    const field = candidates[0];
    if (!field) return false;

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.focus();
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return field.value === value;
  }, { value, fieldType }).catch(() => false);
}

async function performLoginIfCredentialsProvided(page: any, credentials: any) {
  if (!credentials?.username || !credentials?.password) {
    return { attempted: false, success: false, reason: 'No credentials provided.' };
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);

  const usernameFilled =
    await fillByAccessibleLabel(page, [/email\s*or\s*username/i, /username/i, /email/i, /login/i, /user/i], credentials.username) ||
    await fillFirstAvailable(page, [
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="identifier"]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
      'input[aria-label*="email" i]',
      'input[aria-label*="user" i]',
      'input[type="email"]',
      'input[type="text"]',
    ], credentials.username) ||
    await fillVisibleInputFallback(page, credentials.username, 'username') ||
    await fillByDomFallback(page, credentials.username, 'username');

  const passwordFilled =
    await fillByAccessibleLabel(page, [/password/i, /pass/i], credentials.password) ||
    await fillFirstAvailable(page, [
      'input[name="password"]',
      'input[name="pass"]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]',
      'input[aria-label*="password" i]',
      'input[type="password"]',
    ], credentials.password) ||
    await fillVisibleInputFallback(page, credentials.password, 'password') ||
    await fillByDomFallback(page, credentials.password, 'password');

  if (!usernameFilled || !passwordFilled) {
    return {
      attempted: true,
      success: false,
      usernameFilled,
      passwordFilled,
      reason: 'Could not populate username or password fields.',
    };
  }

  const beforeUrl = page.url();
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Submit")',
  ];

  for (const selector of submitSelectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
        const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        const success = page.url() !== beforeUrl || !/sign\s*in|login|404\s+not\s+found/i.test(bodyText);
        return {
          attempted: true,
          success,
          usernameFilled,
          passwordFilled,
          reason: success
            ? 'Credentials populated and submitted.'
            : 'Credentials were populated and submitted, but the target app stayed on login or returned an error.',
          beforeUrl,
          afterUrl: page.url(),
        };
      }
    } catch {
      // Try the next submit selector.
    }
  }

  try {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const success = page.url() !== beforeUrl || !/sign\s*in|login|404\s+not\s+found/i.test(bodyText);
    return {
      attempted: true,
      success,
      usernameFilled,
      passwordFilled,
      reason: success
        ? 'Credentials populated and submitted with Enter key.'
        : 'Credentials were populated and submitted with Enter key, but the target app stayed on login or returned an error.',
      beforeUrl,
      afterUrl: page.url(),
    };
  } catch {
    return { attempted: true, success: false, usernameFilled, passwordFilled, reason: 'Credentials filled, but submit failed.' };
  }
}

async function capturePlaywrightEvidence(targetUrl: string, runId: string, testCases: any[] = [], credentials: any = {}) {
  const normalizedUrl = normalizeTargetUrl(targetUrl);
  if (!normalizedUrl) return [];

  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });

  const selectedCases = testCases
    .map((testCase, index) => ({ testCase, index }))
    .filter(({ testCase }) => testCase?.captureEvidence !== false);
  const casesToCapture = selectedCases.length ? selectedCases : [{ testCase: { title: 'Target base URL evidence' }, index: 0 }];
  const browser = await chromium.launch({ headless: true });

  try {
    const evidence = [];

    for (let index = 0; index < casesToCapture.length; index += 1) {
      const { testCase, index: testCaseIndex } = casesToCapture[index];
      const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
      const filename = `${runId}-case-${index + 1}.png`;
      const screenshotPath = path.join(evidenceDir, filename);
      const response = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const loginResult = await performLoginIfCredentialsProvided(page, credentials);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.close();

      evidence.push({
        title: testCase?.title || `Test case ${index + 1}`,
        testCaseIndex,
        url: normalizedUrl,
        screenshotUrl: `/evidence/${filename}`,
        status: response?.status() || null,
        login: loginResult,
        capturedAt: new Date().toISOString(),
      });
    }

    return evidence;
  } finally {
    await browser.close();
  }
}

const casualGreetingPattern = /^(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?)\b[\s!.?]*$/i;
const identityQuestionPattern = /\b(who\s+are\s+you|what\s+can\s+you\s+do|help|your\s+purpose)\b/i;
const qaIntentPattern = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|checkout|workflow|flow|requirements?)\b/i;
const abusivePattern = /\b(fuck|shit|asshole|bastard|bitch|stupid|idiot|moron|dumb)\b/i;

function getAgentGuardrailResponse(message: string) {
  const normalized = message.trim();

  if (abusivePattern.test(normalized)) {
    return 'Please keep the conversation professional. I can help with QA tasks such as test planning, test case generation, and Playwright automation when the request is stated respectfully.';
  }

  if (casualGreetingPattern.test(normalized)) {
    return 'Hello. I am the QA Assistant. Please provide the application URL or describe the feature you want tested, and I will generate the QA workflow.';
  }

  if (identityQuestionPattern.test(normalized)) {
    return 'I am a QA-focused assistant. I can help generate test plans, test cases, suites, and Playwright scripts for application testing workflows.';
  }

  if (!qaIntentPattern.test(normalized) && !extractTargetUrl(normalized)) {
    return 'This assistant is scoped to QA and test automation. Please ask about an application, feature, test case, test plan, defect, or automation script.';
  }

  return null;
}

// JSON-backed local storage
const db = {
  plans: [] as any[],
  suites: [] as any[],
  cases: [] as any[],
  runs: [] as any[],
  defects: [] as any[],
  agentRuns: [] as any[],
  recentActivity: [] as any[],
  settings: {
    geminiModel: 'gemini-2.5-flash',
    siteCredentials: [] as any[],
  },
  reports: [] as any[]
};

const settingsFilePath = path.resolve(process.cwd(), '.testflow-settings.json');
const dataFilePath = path.resolve(process.cwd(), '.testflow-data.json');

function getPersistableDbSnapshot() {
  return {
    plans: db.plans,
    suites: db.suites,
    cases: db.cases,
    runs: db.runs,
    defects: db.defects,
    agentRuns: db.agentRuns,
    recentActivity: db.recentActivity,
    reports: db.reports,
  };
}

async function loadPersistedData() {
  try {
    const raw = await fs.readFile(dataFilePath, 'utf-8');
    const data = JSON.parse(raw);
    db.plans = Array.isArray(data.plans) ? data.plans : [];
    db.suites = Array.isArray(data.suites) ? data.suites : [];
    db.cases = Array.isArray(data.cases) ? data.cases : [];
    db.runs = Array.isArray(data.runs) ? data.runs : [];
    db.defects = Array.isArray(data.defects) ? data.defects : [];
    db.agentRuns = Array.isArray(data.agentRuns) ? data.agentRuns : [];
    db.recentActivity = Array.isArray(data.recentActivity) ? data.recentActivity : [];
    db.reports = Array.isArray(data.reports) ? data.reports : [];
  } catch {
    // Missing data file is fine on first run.
  }
}

async function savePersistedData() {
  await fs.writeFile(dataFilePath, JSON.stringify(getPersistableDbSnapshot(), null, 2), 'utf-8');
}

async function loadPersistedSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath, 'utf-8');
    const settings = JSON.parse(raw);
    db.settings = {
      ...db.settings,
      ...settings,
      siteCredentials: Array.isArray(settings.siteCredentials) ? settings.siteCredentials : [],
    };
  } catch {
    // Missing settings file is fine on first run.
  }
}

async function savePersistedSettings() {
  await fs.writeFile(settingsFilePath, JSON.stringify(db.settings, null, 2), 'utf-8');
}

function addActivity(message: string) {
  db.recentActivity.unshift({ message, time: 'Just now' });
  if (db.recentActivity.length > 10) db.recentActivity.pop();
  void savePersistedData().catch((error) => {
    console.error('Failed to persist activity log:', error);
  });
}

function buildStatsChartData() {
  const days = [...Array(5)].map((_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (4 - index));
    return {
      key: date.toISOString().split('T')[0],
      name: date.toLocaleDateString('en-US', { weekday: 'short' }),
      passed: 0,
      failed: 0,
      blocked: 0,
    };
  });

  const chartByDate = new Map(days.map((day) => [day.key, day]));

  (db.runs || []).forEach((run: any) => {
    const runDate = String(run?.date || '').trim();
    const chartRow = chartByDate.get(runDate);
    if (!chartRow) return;

    chartRow.passed += Number(run?.passed || 0);
    chartRow.failed += Number(run?.failed || 0);
    const blockedCount = Number(run?.blocked || 0);
    const inferredBlocked = Number(run?.totalExecutions || 0) - Number(run?.passed || 0) - Number(run?.failed || 0) - blockedCount;
    chartRow.blocked += Math.max(0, blockedCount + inferredBlocked);
  });

  return days.map(({ key, ...rest }) => rest);
}

// Application Flow Schema for AI
const appFlowsSchema = z.object({
  flows: z.array(z.object({
    name: z.string().describe('Name of the user flow'),
    description: z.string().describe('Detailed description of the flow'),
    pages: z.array(z.string()).describe('Pages involved'),
  }))
});

// Test Cases Schema for AI
const testCasesSchema = z.object({
  test_cases: z.array(z.object({
    title: z.string(),
    description: z.string(),
    preconditions: z.string(),
    tags: z.array(z.string()),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
    type: z.enum(['Manual', 'Automated', 'Both']),
    steps: z.array(z.object({
      action: z.string(),
      expected: z.string()
    }))
  }))
});

// Playwright Scripts Schema for AI
const playwrightScriptsSchema = z.object({
  scripts: z.array(z.object({
    test_case_title: z.string(),
    filename: z.string(),
    code: z.string()
  }))
});

function normalizeCaseSteps(steps: any[] = []) {
  return steps
    .map((step) => ({
      action: String(step?.action || '').trim(),
      expected: String(step?.expected || '').trim(),
    }))
    .filter((step) => step.action || step.expected);
}

function normalizeCaseTags(tags: any[] = []) {
  return tags
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => {
      const normalized = tag.replace(/^#+/, '').replace(/^@+/, '').replace(/\s+/g, '-');
      return normalized ? `@${normalized}` : '';
    })
    .filter(Boolean);
}

function buildCaseDescription(testCase: any) {
  const baseDescription = String(testCase?.description || '').trim();
  const steps = normalizeCaseSteps(testCase?.steps);

  if (!steps.length) return baseDescription;

  const stepLines = steps.map((step, index) => {
    return `${index + 1}. ${step.action}\n   Expected: ${step.expected}`;
  });

  return [baseDescription, 'Test Steps:', ...stepLines].filter(Boolean).join('\n\n');
}

function buildAgentExecutionSteps(run: any) {
  const evidenceByCaseIndex = new Map(
    (run.evidence_screenshots || []).map((evidence: any) => [evidence.testCaseIndex, evidence.screenshotUrl])
  );

  return (run.generated_cases || []).flatMap((testCase: any, caseIndex: number) => {
    const steps = normalizeCaseSteps(testCase.steps);
    const screenshot = evidenceByCaseIndex.get(caseIndex) || run.app_url || '';

    if (!steps.length) {
      return [{
        step: `${caseIndex + 1}`,
        action: testCase.title || `Execute generated test case ${caseIndex + 1}`,
        expected: testCase.description || 'Expected behavior is verified.',
        outcome: 'Pass',
        reason: '',
        screenshot,
      }];
    }

    return steps.map((step, stepIndex) => ({
      step: `${caseIndex + 1}.${stepIndex + 1}`,
      action: step.action,
      expected: step.expected,
      outcome: 'Pass',
      reason: '',
      screenshot,
      testCaseTitle: testCase.title,
    }));
  });
}

function persistAgentCaseArtifacts(run: any) {
  const now = new Date();
  const planId = `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
  const suiteId = `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.prompt?.slice(0, 48) || run.app_url || run.id;

  if (!db.plans.some((item) => item.id === planId)) {
    db.plans.unshift({
      id: planId,
      name: `Agent Plan - ${baseName}`,
      scope: run.app_url || 'Generated from QA Assistant',
      objectives: 'Validate generated user flows, test cases, automation scripts, and evidence.',
      strategy: 'AI-assisted functional and UI validation',
      testTypes: 'Functional, UI, Regression, Sanity',
      environments: run.app_url || '',
      roles: 'QA Assistant, PlaywrightAgent, EvidenceAgent',
      status: 'Draft',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    });
  }

  if (!db.suites.some((item) => item.id === suiteId)) {
    db.suites.unshift({
      id: suiteId,
      name: `Agent Suite - ${baseName}`,
      description: `Generated suite for ${run.app_url || baseName}`,
      testPlanId: planId,
      parentSuite: '',
      module: 'QA Assistant',
      owner: 'QA Assistant',
      tags: ['@agent', '@generated'],
      priority: 'Medium',
      status: 'Active',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    });
  }

  (run.generated_cases || []).forEach((testCase: any, index: number) => {
    const caseId = `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
    const casePayload = {
      id: caseId,
      title: testCase.title,
      description: buildCaseDescription(testCase),
      steps: normalizeCaseSteps(testCase.steps),
      testPlanId: planId,
      testSuiteId: suiteId,
      status: 'Draft',
      tags: normalizeCaseTags(testCase.tags || []),
      type: testCase.type || 'Manual',
      priority: testCase.priority || 'Medium',
      createdBy: 'QA Assistant',
      createdAt: now,
      agentRunId: run.id,
    };
    const existingIndex = db.cases.findIndex((item) => item.id === caseId);
    if (existingIndex >= 0) {
      db.cases[existingIndex] = { ...db.cases[existingIndex], ...casePayload };
    } else {
      db.cases.unshift(casePayload);
    }
  });

  void savePersistedData().catch((error) => {
    console.error('Failed to persist agent case artifacts:', error);
  });
}

function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = `RUN-${run.id.substring(0, 8).toUpperCase()}`;
  const existingReportId = `REP-${run.id.substring(0, 8).toUpperCase()}`;
  const baseName = run.prompt?.slice(0, 48) || run.app_url || run.id;

  persistAgentCaseArtifacts(run);

  const executionSteps = buildAgentExecutionSteps(run);

  const runPayload = {
      id: existingRunId,
      name: `Agent Run - ${baseName}`,
      suiteName: `Agent Suite - ${baseName}`,
      requestedBy: 'QA Assistant',
      executionTime: 'Generated',
      status: 'Completed',
      progress: `${executionSteps.length} passed`,
      date,
      totalExecutions: executionSteps.length,
      passed: executionSteps.length,
      failed: 0,
      targetUrl: run.app_url || '',
      steps: executionSteps,
      evidence: run.evidence_screenshots || [],
      agentRunId: run.id,
  };
  const runIndex = db.runs.findIndex((item) => item.id === existingRunId);
  if (runIndex >= 0) {
    db.runs[runIndex] = { ...db.runs[runIndex], ...runPayload };
  } else {
    db.runs.unshift(runPayload);
  }

  const reportPayload = {
      id: existingReportId,
      name: `Agent Report - ${baseName}`,
      planName: `Agent Plan - ${baseName}`,
      suiteName: `Agent Suite - ${baseName}`,
      requestedBy: 'QA Assistant',
      executionTime: 'Generated',
      totalExecutions: executionSteps.length,
      status: 'Passed',
      failureReason: '',
      date,
      targetUrl: run.app_url || '',
      steps: executionSteps,
      evidence: run.evidence_screenshots || [],
      agentRunId: run.id,
  };
  const reportIndex = db.reports.findIndex((item) => item.id === existingReportId);
  if (reportIndex >= 0) {
    db.reports[reportIndex] = { ...db.reports[reportIndex], ...reportPayload };
  } else {
    db.reports.unshift(reportPayload);
  }

  run.persisted = true;
  addActivity(`Agent artifacts saved across Plans, Suites, Cases, Runs, and Reports: ${baseName}`);
  void savePersistedData().catch((error) => {
    console.error('Failed to persist agent run artifacts:', error);
  });
}

async function runPostCaseAgentFlow(run: any, model: any, testCases: any, targetUrl: string) {
  run.messages.push({ agent: 'PlaywrightAgent', status: 'running' });
  const credentialContext = buildCredentialContext(run.credentials || {});
  const { object: scripts } = await generateObject({
    model,
    schema: playwrightScriptsSchema,
    prompt: `You are a Playwright automation expert. Convert these reviewed test cases into production-quality Playwright TypeScript scripts. Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}. ${credentialContext} For authenticated flows, fill the username/email and password fields before clicking submit, then assert that the expected authenticated page or table/list view is visible. Test cases: ${JSON.stringify(testCases)}`
  });
  run.playwright_scripts = scripts.scripts as any;
  run.messages.push({ agent: 'PlaywrightAgent', status: 'completed', output: scripts });

  run.messages.push({ agent: 'EvidenceAgent', status: 'running' });
  if (targetUrl) {
    const evidence = await capturePlaywrightEvidence(targetUrl, run.id, testCases?.test_cases || run.generated_cases || [], run.credentials || {});
    run.evidence_screenshots = evidence as any;
    run.messages.push({ agent: 'EvidenceAgent', status: 'completed', output: evidence });
  } else {
    run.messages.push({ agent: 'EvidenceAgent', status: 'skipped', output: 'No target URL was provided in chat and no Website Credentials row is selected for Playwright.' });
  }

  run.status = 'completed';
  persistAgentRunArtifacts(run);
}

async function startServer() {
  await loadPersistedData();
  await loadPersistedSettings();

  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use('/evidence', express.static(path.resolve(process.cwd(), 'evidence')));

  // API Routes
  app.get('/api/settings', (req, res) => {
    res.json(db.settings);
  });

  app.get('/api/git-agent/status', (req, res) => {
    try {
      res.json(getGitRepoStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to read git agent status.' });
    }
  });

  app.post('/api/git-agent/sync', (req, res) => {
    try {
      res.json(syncGitAgentMain());
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to sync main branch.' });
    }
  });

  app.post('/api/git-agent/scan', (req, res) => {
    try {
      const baseRef = String(req.body?.baseRef || 'auto').trim() || 'auto';
      res.json(scanGitAgentChanges(baseRef));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to scan changed files.' });
    }
  });

  app.post('/api/git-agent/generate', async (req, res) => {
    try {
      const baseRef = String(req.body?.baseRef || 'auto').trim() || 'auto';
      res.json(await generateGitAgentCases(baseRef));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to generate git change test cases.' });
    }
  });

  app.get('/api/ai/health', (req, res) => {
    res.json({
      gemini: getGeminiKeyStatus(),
      model: db.settings?.geminiModel || 'gemini-2.5-flash',
      cwd: process.cwd(),
      checkedAt: new Date().toISOString(),
    });
  });

  // Screenshot Engine Endpoint for Target URL Screenshots
  app.get('/api/screenshot', (req, res) => {
    const targetUrlRaw = req.query.url as string;
    if (!targetUrlRaw) {
      return res.status(400).send('Missing url query parameter');
    }

    if (targetUrlRaw.startsWith('/evidence/')) {
      return res.redirect(targetUrlRaw);
    }

    // Normalize target url
    let targetUrl = targetUrlRaw;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      const screenshotServiceUrl = `https://image.thum.io/get/width/1280/crop/800/maxAge/12/${targetUrl}`;
      res.redirect(screenshotServiceUrl);
    } catch (error) {
      console.error("Screenshot redirection error:", error);
      res.status(500).send('Screenshot capture failed');
    }
  });

    app.post('/api/settings', async (req, res) => {
    const siteCredentials = Array.isArray(req.body.siteCredentials)
      ? req.body.siteCredentials
          .map((item: any) => ({
            id: String(item?.id || randomUUID()),
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            username: String(item?.username || '').trim(),
            password: String(item?.password || '').trim(),
            isPlaywrightTarget: Boolean(item?.isPlaywrightTarget),
          }))
          .filter((item: any) => item.url && item.username && item.password)
      : db.settings.siteCredentials;

    db.settings = { ...db.settings, ...req.body, siteCredentials };
    await savePersistedSettings();
    addActivity('Updated settings preferences');
    res.json({ success: true, settings: db.settings });
  });

  app.get('/api/stats', (req, res) => {
    const chartData = buildStatsChartData();
    const activeRunsCount = db.agentRuns.filter((run: any) => ['running', 'review_required'].includes(String(run?.status || ''))).length;
    res.json({
      chartData,
      plansCount: db.plans.length,
      suitesCount: db.suites.length,
      casesCount: db.cases.length,
      runsCount: db.runs.length,
      activeRunsCount,
      defectsCount: db.defects.length,
      reportsCount: db.reports.length,
      recentActivity: db.recentActivity
    });
  });

  app.get('/api/plans', (req, res) => res.json(db.plans));
  app.get('/api/suites', (req, res) => res.json(db.suites));
  app.get('/api/cases', (req, res) => res.json(db.cases));
  app.get('/api/runs', (req, res) => res.json(db.runs));
  app.get('/api/defects', (req, res) => res.json(db.defects));
  app.get('/api/reports', (req, res) => res.json(db.reports));
  app.get('/api/agent-runs', (req, res) => res.json(db.agentRuns));
  
  app.get('/api/agent-runs/:id', (req, res) => {
    const run = db.agentRuns.find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  const createCrudRoutes = (entityPath: string, entityArrayKey: keyof typeof db) => {
    app.put(`/api/${entityPath}/:id`, (req, res) => {
      const arr = db[entityArrayKey] as any[];
      const index = arr.findIndex(item => item.id === req.params.id);
      if (index !== -1) {
        arr[index] = { ...arr[index], ...req.body };
        void savePersistedData().catch((error) => {
          console.error(`Failed to persist ${entityPath} update:`, error);
        });
        addActivity(`Updated ${entityPath.slice(0, -1)}: ${arr[index].name || arr[index].title}`);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });

    app.delete(`/api/${entityPath}/:id`, (req, res) => {
      const arr = db[entityArrayKey] as any[];
      const index = arr.findIndex(item => item.id === req.params.id);
      if (index !== -1) {
        const deletedName = arr[index].name || arr[index].title;
        arr.splice(index, 1);
        void savePersistedData().catch((error) => {
          console.error(`Failed to persist ${entityPath} delete:`, error);
        });
        addActivity(`Deleted ${entityPath.slice(0, -1)}: ${deletedName}`);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });
  };

  createCrudRoutes('plans', 'plans');
  createCrudRoutes('suites', 'suites');
  createCrudRoutes('cases', 'cases');
  createCrudRoutes('runs', 'runs');
  createCrudRoutes('defects', 'defects');
  createCrudRoutes('reports', 'reports');

  app.post('/api/reports', (req, res) => {
    const r = req.body;
    const name = r.name || 'New Execution Report';
    const reportId = `REP-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = r.targetUrl || '';
    
    // If targetUrl exists, map step screenshots to the targetUrl if they aren't presets
    const processedSteps = (r.steps || []).map((st: any) => {
      let stepScreenshot = st.screenshot;
      if (targetUrl && !stepScreenshot) {
        stepScreenshot = targetUrl;
      }
      return { ...st, screenshot: stepScreenshot };
    });

    const newReport = {
      id: reportId,
      name: name,
      planName: r.planName || '',
      suiteName: r.suiteName || '',
      requestedBy: r.requestedBy || '',
      executionTime: r.executionTime || '',
      totalExecutions: r.totalExecutions || processedSteps.length,
      status: r.status || 'Passed',
      failureReason: r.failureReason || '',
      date: r.date || new Date().toISOString().split('T')[0],
      targetUrl: targetUrl,
      steps: processedSteps
    };
    db.reports.unshift(newReport);
    void savePersistedData().catch((error) => {
      console.error('Failed to persist report:', error);
    });
    addActivity(`Logged Test Report: ${name}`);
    res.json({ success: true, report: newReport });
  });

  app.post('/api/plans', (req, res) => {
    const p = req.body;
    const name = p.name || 'New Plan';
    db.plans.unshift({ 
      id: `TP-${Math.random().toString(36).substring(2,6).toUpperCase()}`, 
      name: name, 
      scope: p.scope, objectives: p.objectives, inScope: p.inScope, outOfScope: p.outOfScope, 
      strategy: p.strategy, testTypes: p.testTypes, environments: p.environments, roles: p.roles, 
      entryExit: p.entryExit, schedule: p.schedule, risks: p.risks, deliverables: p.deliverables,
      status: 'Draft', riskLevel: 'Medium', owner: 'User', createdAt: new Date() 
    });
    void savePersistedData().catch((error) => {
      console.error('Failed to persist plan:', error);
    });
    addActivity(`Created Plan: ${name}`);
    res.json({ success: true });
  });
  
  app.post('/api/suites', (req, res) => {
    const s = req.body;
    const name = s.name || 'New Suite';
    db.suites.unshift({
       id: `TS-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
       name: name, description: s.description, parentSuite: s.parentSuite, module: s.module,
       owner: s.owner || 'User', priority: s.priority || 'Medium', status: s.status || 'Active', 
       tags: s.tags || [], riskLevel: s.riskLevel || 'Low', createdBy: 'User', createdAt: new Date()
    });
    void savePersistedData().catch((error) => {
      console.error('Failed to persist suite:', error);
    });
    addActivity(`Created Suite: ${name}`);
    res.json({ success: true });
  });

  app.post('/api/cases', (req, res) => {
    const c = req.body;
    const title = c.title || 'New Case';
    db.cases.unshift({
       id: `TC-${Math.random().toString(36).substring(2,6).toUpperCase()}`,
       title: title, description: buildCaseDescription(c), steps: normalizeCaseSteps(c.steps),
       status: 'Draft', tags: normalizeCaseTags(c.tags || []), type: c.type || 'Manual', priority: c.priority || 'Medium',
       createdBy: c.createdBy || 'User', createdAt: new Date()
    });
    void savePersistedData().catch((error) => {
      console.error('Failed to persist case:', error);
    });
    addActivity(`Created Case: ${title}`);
    res.json({ success: true });
  });

  app.post('/api/runs', (req, res) => {
    const name = req.body.name || 'New Run';
    const runId = `RUN-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
    const targetUrl = normalizeTargetUrl(req.body.targetUrl || findSettingsPlaywrightTargetUrl() || '');
    const steps = targetUrl ? [
      { step: '1', action: `Load target webpage address URL: ${targetUrl}`, expected: 'Page responds successfully.', outcome: 'Pass', reason: '', screenshot: targetUrl },
      { step: '2', action: 'Verify primary page layout renders', expected: 'Core page content is visible.', outcome: 'Pass', reason: '', screenshot: targetUrl },
      { step: '3', action: 'Capture responsive viewport evidence', expected: 'Screenshot evidence is available for review.', outcome: 'Pass', reason: '', screenshot: targetUrl }
    ] : [];
    const passed = steps.filter((step: any) => step.outcome === 'Pass').length;
    const failed = steps.filter((step: any) => step.outcome === 'Fail').length;
    
    const newRun = { 
      id: runId, 
      name: name, 
      suiteName: req.body.suiteName || 'Playwright Verification Suite',
      requestedBy: req.body.requestedBy || '',
      executionTime: req.body.executionTime || '',
      status: 'Completed', 
      progress: `${passed} passed`,
      date: new Date().toISOString().split('T')[0],
      totalExecutions: steps.length,
      passed,
      failed,
      targetUrl: targetUrl,
      steps
    };
    db.runs.unshift(newRun);
    void savePersistedData().catch((error) => {
      console.error('Failed to persist run:', error);
    });
    addActivity(`Started Run: ${name}`);
    res.json({ success: true, run: newRun });
  });
  app.post('/api/defects', (req, res) => {
    const title = req.body.title || 'New Defect';
    db.defects.unshift({ id: `DEF-${Math.random().toString(36).substring(2,6).toUpperCase()}`, title: title, severity: req.body.severity || 'High', status: 'Open' });
    void savePersistedData().catch((error) => {
      console.error('Failed to persist defect:', error);
    });
    addActivity(`Logged Defect: ${title}`);
    res.json({ success: true });
  });

  app.post('/api/agent/action', async (req, res) => {
    const { taskType, prompt } = req.body;

    try {
      const model = createGeminiModel();
      
      let schema;
      let systemPrompt = "";

      if (taskType === 'plan') {
         schema = z.object({
           name: z.string(),
           scope: z.string(),
           objectives: z.string(),
           inScope: z.string(),
           outOfScope: z.string(),
           strategy: z.string(),
           testTypes: z.string(),
           environments: z.string(),
           roles: z.string(),
           entryExit: z.string(),
           schedule: z.string(),
           risks: z.string(),
           deliverables: z.string()
         });
         systemPrompt = `Generate a detailed Test Plan based on the prompt. Provide Fields: name, scope, objectives, in-scope, out-of-scope, strategy, test types, environments, roles, entry/exit criteria, schedule, risks, and deliverables. Prompt: ${prompt}`;
      } else if (taskType === 'suite') {
         schema = z.object({
           name: z.string(),
           description: z.string(),
           parentSuite: z.string().optional(),
           module: z.string(),
           owner: z.string(),
           tags: z.array(z.string()),
           priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
           status: z.enum(['Active', 'Draft', 'Deprecated'])
         });
         systemPrompt = `Generate a Test Suite based on the prompt. Fields: name, description, parentSuite, module, owner, tags, priority, status. Tags should specify features/platforms etc. Prompt: ${prompt}`;
      } else if (taskType === 'case') {
         schema = z.object({
           title: z.string(),
           description: z.string(),
           tags: z.array(z.string()),
           type: z.enum(['Manual', 'Automated']),
           priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
           steps: z.array(z.object({
             action: z.string(),
             expected: z.string()
           }))
         });
         systemPrompt = `Generate a Test Case based on the prompt. Provide title, description, type, priority, automation tags, and 3-6 ordered steps. Tags must use @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Each step must include action and expected result for report display. Prompt: ${prompt}`;
      } else if (taskType === 'run') {
         schema = z.object({
           name: z.string(),
         });
         systemPrompt = `Generate a Test Run name based on the prompt. Provide a short name e.g. 'Sprint 20 Smoke'. Prompt: ${prompt}`;
      } else if (taskType === 'defect') {
         schema = z.object({
           title: z.string(),
           severity: z.enum(['Low', 'Medium', 'High', 'Critical']),
         });
         systemPrompt = `Generate a Defect description and severity based on the prompt. Prompt: ${prompt}`;
      } else {
         return res.status(400).json({ error: 'Invalid taskType' });
      }

      const { object } = await generateObject({
        model,
        schema,
        prompt: systemPrompt
      });

      res.json(object);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  // AI Agent API (A2A Orchestrator Simulation)
  app.post('/api/agent/start', async (req, res) => {
    const { app_url, provider, prompt } = req.body;
    const testCaseCount = Math.min(10, Math.max(1, Number(req.body.testCaseCount) || 3));
    const flowMode = req.body.flowMode === 'review_cases' ? 'review_cases' : 'complete';
    const guardrailResponse = getAgentGuardrailResponse(prompt || app_url || '');

    if (guardrailResponse) {
      return res.json({ chat_response: guardrailResponse });
    }

    const targetUrl = resolveAgentTargetUrl(prompt || '', app_url || '');
    const credentials = resolveAgentCredentials(prompt || '', targetUrl);
    const taskId = randomUUID();
    
    const newRun = {
      id: taskId,
      app_url: targetUrl,
      provider,
      prompt: prompt || '',
      status: 'running',
      messages: [] as any[],
      generated_cases: [],
      playwright_scripts: [],
      evidence_screenshots: [],
      credentials,
      created_at: new Date()
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `Resolved target: ${targetUrl || 'none'}. Credentials: ${credentials.username && credentials.password ? `${credentials.source || 'provided'} for ${(credentials as any).siteName || credentials.username}` : 'none'}.`,
    });
    
    db.agentRuns.unshift(newRun);
    void savePersistedData().catch((error) => {
      console.error('Failed to persist new agent run:', error);
    });
    
    // Return early, continue processing asynchronously (simulating A2A workers)
    res.json({ task_id: taskId });

    try {
      const model = createGeminiModel();
      const credentialContext = buildCredentialContext(credentials);

      // 1. ApplicationInspector Agent
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'running' });
      const { object: flows } = await generateObject({
        model,
        schema: appFlowsSchema,
        prompt: `You are an expert web application analyst. Use this Playwright target base URL when available: ${targetUrl || 'not provided'}. ${credentialContext} Given this context: ${prompt ? `Requirements: ${prompt}` : ''}. Identify the top 3-5 user-facing flows and pages. Be concise.`
      });
      newRun.messages.push({ agent: 'ApplicationInspector', status: 'completed', output: flows });

      // 2. TestGenerationAgent
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'running' });
      const { object: testCases } = await generateObject({
        model,
        schema: testCasesSchema,
        prompt: `You are a senior QA engineer. Generate exactly ${testCaseCount} comprehensive test cases covering positive and negative scenarios for these flows: ${JSON.stringify(flows)}. ${credentialContext} If a test case verifies a valid login or an authenticated page, the steps must explicitly say to enter username/email "${credentials.username || '<provided username>'}" and password "${credentials.password || '<provided password>'}", then click Sign in/Login and verify the target list/table view. Each test case must include automation tags in @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Each test case must include a steps array with 3-6 ordered rows. Each row must have a clear action and expected result suitable for a report table.`
      });
      newRun.generated_cases = (testCases.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
      newRun.messages.push({ agent: 'TestGenerationAgent', status: 'completed', output: testCases });
      persistAgentCaseArtifacts(newRun);

      if (flowMode === 'review_cases') {
        newRun.status = 'review_required';
        newRun.messages.push({ agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
        void savePersistedData().catch((error) => {
          console.error('Failed to persist review-required agent run:', error);
        });
        return;
      }

      await runPostCaseAgentFlow(newRun, model, testCases, targetUrl);
    } catch (err: any) {
      console.error("AI Gen Error:", err);
      newRun.status = 'failed';
      newRun.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      void savePersistedData().catch((error) => {
        console.error('Failed to persist failed agent run:', error);
      });
    }
  });

  app.post('/api/agent/continue', async (req, res) => {
    const { taskId, cases } = req.body;
    const run = db.agentRuns.find((item) => item.id === taskId);

    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'Reviewed cases are required to continue.' });
    }

    run.status = 'running';
    run.generated_cases = cases;
    run.playwright_scripts = [];
    run.evidence_screenshots = [];
    persistAgentCaseArtifacts(run);
    void savePersistedData().catch((error) => {
      console.error('Failed to persist continued agent run:', error);
    });
    res.json({ success: true });

    try {
      const model = createGeminiModel();
      await runPostCaseAgentFlow(run, model, { test_cases: cases }, run.app_url || '');
    } catch (err: any) {
      console.error("AI Continue Error:", err);
      run.status = 'failed';
      run.messages.push({ agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      void savePersistedData().catch((error) => {
        console.error('Failed to persist failed continued agent run:', error);
      });
    }
  });

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const model = createGeminiModel();
      const { testCase, feedback, targetUrl } = req.body;

      const { object } = await generateObject({
        model,
        schema: z.object({
          title: z.string(),
          description: z.string(),
          preconditions: z.string(),
          tags: z.array(z.string()),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          type: z.enum(['Manual', 'Automated', 'Both']),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        prompt: `Rework this QA test case based on the reviewer feedback. Keep it practical, detailed, and report-ready. Include 3-6 ordered steps, each with action and expected result. Keep or improve automation tags using @ format, for example @bvt, @sanity, @regression, @smoke, @ui, @positive, @negative. Target URL: ${targetUrl || 'not provided'}. Current case: ${JSON.stringify(testCase)}. Feedback: ${feedback || 'Improve clarity and coverage.'}`,
      });

      res.json(object);
    } catch (err: any) {
      console.error("AI Rework Error:", err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/expand-case-steps', async (req, res) => {
    try {
      const model = createGeminiModel();
      const { testCase, targetStepCount, targetUrl } = req.body;
      const requestedCount = Math.max(2, Math.min(20, Number(targetStepCount) || 8));

      const { object } = await generateObject({
        model,
        schema: z.object({
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        prompt: `Break this QA test case into exactly ${requestedCount} clear, granular, executable test steps. Preserve the original intent, credentials, target URL, assertions, and coverage. Do not add unrelated scenarios. Each step must have one specific user/system action and one matching expected result. Target URL: ${targetUrl || 'not provided'}. Test case: ${JSON.stringify(testCase)}`,
      });

      const steps = normalizeCaseSteps(object.steps).slice(0, requestedCount);
      res.json({ steps });
    } catch (err: any) {
      console.error("AI Step Expansion Error:", err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  // Save generated cases back to DB route
  app.post('/api/agent/save-cases', (req, res) => {
    const { cases } = req.body;
    if (Array.isArray(cases)) {
      cases.forEach(c => {
        db.cases.unshift({
          id: `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          title: c.title,
          description: buildCaseDescription(c),
          steps: normalizeCaseSteps(c.steps),
          status: 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          type: c.type,
          priority: c.priority
        });
      });
    }
    res.json({ success: true });
  });

  // Vite Integration for dev & production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
