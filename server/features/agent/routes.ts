import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { readBlackboard } from './blackboard';
import { getFolderPath, resolveFolderForAgent } from '../../shared/folders';
import { getAIErrorMessage } from '../../shared/ai';
import { buildCredentialContext, resolveAgentTargetUrl, findSettingsCredentials } from '../../shared/url';
import { playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { capturePlaywrightEvidence, createAuthStorageState } from '../evidence/evidenceService';
import { gitGrep, readRepoFile, searchCodeWithContext } from '../git-agent/gitAgentService';
import { analyzeFeatureFromSource, discoverFeatureInventoryFromSource, proposeGapCases } from '../requirements/requirementService';
import { executePlaywrightScripts, killRunProcesses, sanitizeTestCode, repairTestCode } from '../playwright/executionService';
import { liveAuthor, emitScript, canLiveAuthorGoal, actionableAuthorBlockers } from './liveAuthor';
import { inspectFlow, flowToScript } from './flowInspector';
import { extractSelectorMap, renderSelectorMap, mapHas, correctSelectorMethods, type SelectorMap } from './selectorMap';

// Cache the extracted code selector-map per repo+app (the source rarely changes mid-session).
// Keyed by the SCOPED path AND appId so two apps that share one repo never get each other's
// selector map. When an app
// declares a repoSubpath, extraction is scoped to that subtree so its selectors don't include the
// sibling app's. Falls back to the whole repo when no subpath is set (shared-source apps).
const selectorMapCache = new Map<string, SelectorMap>();
function getSelectorMap(repoPath: string, opts: { appId?: string; subpath?: string } = {}): SelectorMap | null {
  const base = (repoPath || '').trim();
  if (!base) return null;
  const scopedPath = opts.subpath ? path.join(base, opts.subpath) : base;
  const key = `${scopedPath}::${opts.appId || ''}`;
  if (selectorMapCache.has(key)) return selectorMapCache.get(key)!;
  try {
    const target = existsSync(scopedPath) ? scopedPath : base;
    const m = extractSelectorMap(target);
    selectorMapCache.set(key, m);
    return m;
  } catch { return null; }
}
/** Selector map scoped to the run's selected app (its repo subpath + appId)  -  never the sibling app's. */
function getRunSelectorMap(run: any): SelectorMap | null {
  const repoPath = getProjectRepoPath(run?.projectId || '').trim();
  const app = run?.appId ? getApp(run.appId) : undefined;
  return getSelectorMap(repoPath, { appId: run?.appId || '', subpath: (app as any)?.repoSubpath || '' });
}
import { promises as fsp, readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { inspectApplicationFlow } from './inspectionService';
import { exploreAndVerifyPage, exploreAppElements, rankVerifiedElements } from './domExplorer';
import { getFeatureGrounding } from './knowledge';
import { projectRunLifecycleSafe } from '../../../services/runtime/src/application/sessionProjector';
import { getOrchestrator, listConfiguredProviders, resolveProviderForAgent, resolveModelForAgent } from '../../ai/orchestrator';
import { assembleConversationContext } from '../../ai/memory/contextAssembler';
import { answerAppQuestionFromCode, stripCodebaseLocationsForAgentConsole } from '../../ai/supervisor';
import { buildKnowledgeBlock, recordObservation } from '../knowledge/knowledgeService';
import { resolveCredentials, maskPassword } from '../credentials/credentialsService';
import {
  detectSurfaceKind, resolveTargetApp, buildAppScopedUrl, connForRun,
  fetchCorePlatformApps, fetchCorePlatformAppTabs, ALL_APPS_ID, loadAdminNavModules, isMutationIntent,
} from './appTargeting';
import {
  buildMissionContext, platformTypeFromSurface, runtimeSurfaceFromSurface, moduleFromUrl,
  buildMissionVerificationSnippet, missionContextFromRun, finalizeMissionFromInspectedSurface,
  renderMissionContextForPrompt, collapseDoubledLabels, describeMission,
  needsExplicitListViewModule, sameMissionEvidenceScope,
  type MissionContext, type RuntimeSurface,
} from './mission/missionContext';
// Evidence-Graph Phase 5: deterministic compiler path (flag-gated by AIQA_COMPILER; legacy path is default).
import { generateCompiledScripts, aiqaCompilerEnabled } from './compiler/compiledGeneration';
// LangGraph workflow runtime (flag-gated by AGENT_GRAPH_V2; legacy path is default and untouched).
import { isWorkflowGraphEnabled } from './workflow/checkpointer';
import { startGraphRun, resumeGraphRun, cancelGraphRun, getPendingReview, reconcileRunIfOrphaned, orphanedRunFailure, persistDefectReport, registerTerminalArtifactPersister } from './workflow/runtime';
import { buildDefectDrafts } from './workflow/defectReporter';
import type { MissionRef } from './workflow/state';
import { renderTargetCatalogForPrompt } from './compiler/renderCatalogForPrompt';
import { testPlanSchema, parseTestPlan } from './compiler/testPlan';
import { semanticPlanFromCase } from './compiler/semanticPlanner';
import { linkedExistingCases, scoreCaseReuse } from './caseReuse';
import { pushInboxItem } from '../inbox/routes';
import { AgentRuns, ChatConversations, Plans, Suites, Cases, Runs, Reports, Scripts, Folders, Requirements, RequirementLinks, Defects, isPgEnabled } from '../../db/repository';
import { loadConversationHandoff } from '../../ai/memory/conversationState';
import { runGuardrailPipeline } from '../../ai/guardrails';
import { assessInspection, assessCasesGrounding, assessExecution, assessFeatureCompleteness } from '../../ai/verifier';
import { classifyFailure } from '../../ai/recovery';
import { isProjectOverQuota } from '../../ai/costTracker';
import { retrieveRunMemories, summarizeMemoriesForPrompt } from '../../ai/memory/runMemory';
import { reqScope, scopeFilter, scopeStamp } from '../../shared/scope';
import { getApp, getProject, getProjectRepoPath } from '../projects/projectService';
import { fetchTestDataPack } from '../../ai/tools/corePlatformData';
import { applicationContextCacheKey, buildCorePlatformApplicationContext } from './applicationContext';
import {
  renderSelectorRegistryForPrompt,
  runContextBuilderPhase,
  runMetadataFetchPhase,
  runMultiContextInspectionPhase,
  runSelectorRegistryPhase,
  domOpenPathForPrompt,
} from './pipelineDelta';
import { renderMcpDomFactsForPrompt } from './mcpDomFacts';
// Strike 3: the single, shared source of grounding for every deep-run worker.
// isNoiseTurn / deriveUnderstandingFromChat live here now (were duplicated below)
// and resolveUnderstanding is the one place that decides the run's understanding,
// so the case writer, coder, and analyst can no longer disagree.
import { isNoiseTurn, deriveUnderstandingFromChat, resolveUnderstanding } from '../../agent-runtime/context/goalContext';

function wantsCodeGroundedTestUnderstanding(value: string): boolean {
  const text = String(value || '').toLowerCase();
  // A bare "test <feature>" verb (e.g. "test list view at Accounts CRM") is a test-generation
  // request too  -  not just literal "test cases"/"coverage"  -  so include `test` as a trigger.
  // Without it those requests skip code grounding and fall back to the terse understanding.
  return /\b(test|cases?|test\s*areas?|coverage|scenarios?|qa|regression|what\s+(?:can|should)\s+i\s+test|write|create|generate|draft)\b/.test(text)
    && /\b(test|case|cases|qa|coverage|scenario|scenarios|regression)\b/.test(text);
}

function listRepoSrcApps(repoPath: string): string[] {
  const root = String(repoPath || '');
  if (!root || !existsSync(root)) return [];
  try {
    const roots = ['apps', 'packages', 'src'].map((name) => path.join(root, name)).filter((p) => existsSync(p));
    const ignored = /^(__tests__|test|tests|types|utils?|shared|common|components?|node_modules|dist|build|coverage)$/i;
    const found: string[] = [];
    for (const base of roots) {
      const baseName = path.basename(base);
      const top = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !ignored.test(d.name)).map((d) => d.name);
      found.push(...top.map((name) => `${baseName}/${name}`));
      for (const name of top) {
        const p = path.join(base, name);
        try {
          found.push(...readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !ignored.test(d.name)).map((d) => `${baseName}/${name}/${d.name}`));
        } catch { /* ignore */ }
      }
    }
    return found;
  } catch { return []; }
}

function wantsGenericOrAllApps(text: string): boolean {
  return /\b(all apps?|every app|generic(?:ally)?|common feature|shared feature|not app specific|app[-\s]?agnostic|irrespective of (?:the )?app|everywhere)\b/i.test(String(text || ''));
}

function wantsPlatformAdminScope(value: string): boolean {
  const text = String(value || '').toLowerCase();
  return /\b(?:create|add|new|edit|update|delete)\s+(?:an?\s+)?app\b/.test(text)
    || /\bapp\s+(?:creation|catalog|management|manager|list|settings?|configuration)\b/.test(text)
    || /\b(?:parent\s+app|child\s+app|api\s*name|icon[_\s-]*id)\b/.test(text)
    || (/\bprefix\b/.test(text) && /\blabel\b/.test(text) && /\bapp\b/.test(text));
}

function platformCandidates(repoPath = ''): string[] {
  const configured = (db.apps as any[] || []).map((a) => String(a?.name || '').trim()).filter(Boolean);
  const repoDiscovered = listRepoSrcApps(repoPath).map((name) => name.split('/').pop() || name).filter(Boolean);
  return [...new Set([...configured, ...repoDiscovered])].slice(0, 20);
}

function requestedFeatureTerms(prompt: string): string[] {
  const stop = new Set(['test', 'run', 'generate', 'create', 'write', 'draft', 'validate', 'case', 'cases', 'script', 'scripts', 'for', 'the', 'and', 'in', 'on', 'of', 'a', 'an', 'app', 'apps', 'platform', 'feature']);
  return [...new Set((String(prompt || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((t) => !stop.has(t)))].slice(0, 5);
}

function repoFeaturePlatforms(prompt: string, repoPath = ''): string[] {
  const terms = requestedFeatureTerms(prompt);
  if (!terms.length || !repoPath || !existsSync(repoPath)) return [];
  const roots = ['apps', 'packages', 'src'].map((name) => path.join(repoPath, name)).filter((p) => existsSync(p));
  const hits: string[] = [];
  const exts = /\.(tsx?|jsx?|html?|vue|svelte|md)$/i;
  const skip = /^(node_modules|dist|build|coverage|\.next|\.git|shared|common|components?)$/i;
  const scan = (dir: string, budget: { n: number }): string => {
    if (budget.n <= 0) return '';
    let out = '';
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (budget.n <= 0 || skip.test(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out += ` ${ent.name} ${scan(p, budget)}`;
      else if (exts.test(ent.name)) {
        budget.n -= 1;
        try { out += ` ${ent.name} ${readFileSync(p, 'utf8').slice(0, 12000)}`; } catch { /* ignore */ }
      }
    }
    return out.toLowerCase();
  };
  for (const root of roots) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || skip.test(ent.name)) continue;
      const hay = scan(path.join(root, ent.name), { n: 80 });
      if (terms.every((t) => hay.includes(t))) hits.push(ent.name);
    }
  }
  return [...new Set(hits)].slice(0, 20);
}

function targetTokens(name = '', url = ''): Set<string> {
  const ignore = new Set(['http', 'https', 'www', 'localhost', 'local', 'ui', 'app', 'apps']);
  return new Set(`${name} ${url}`.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => !ignore.has(t) && t.length > 2) || []);
}

function selectedPlatformFeatureExists(prompt: string, repoPath = '', targetName = '', targetUrl = ''): boolean {
  if (!repoPath || !existsSync(repoPath)) return false;
  const tokens = targetTokens(targetName, targetUrl);
  if (!tokens.size) return false;
  const roots = ['apps', 'packages', 'src'].map((name) => path.join(repoPath, name)).filter((p) => existsSync(p));
  const terms = requestedFeatureTerms(prompt);
  if (!terms.length) return false;
  const stems = terms.map((t) => t.length > 5 ? t.slice(0, 5) : t);
  const exts = /\.(tsx?|jsx?|html?|vue|svelte|md)$/i;
  const skip = /^(node_modules|dist|build|coverage|\.next|\.git|shared|common|components?)$/i;
  const scan = (dir: string, budget: { n: number }): string => {
    if (budget.n <= 0) return '';
    let out = '';
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (budget.n <= 0 || skip.test(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out += ` ${ent.name} ${scan(p, budget)}`;
      else if (exts.test(ent.name)) {
        budget.n -= 1;
        try { out += ` ${ent.name} ${readFileSync(p, 'utf8').slice(0, 12000)}`; } catch { /* ignore */ }
      }
    }
    return out.toLowerCase();
  };
  for (const root of roots) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || skip.test(ent.name) || !tokens.has(ent.name.toLowerCase())) continue;
      const hay = scan(path.join(root, ent.name), { n: 120 });
      const hits = stems.filter((stem) => hay.includes(stem)).length;
      if (hits >= Math.max(1, Math.ceil(stems.length / 2))) return true;
    }
  }
  return false;
}
function needsExplicitAppScope(prompt: string, selectedApp: any, explicitUrl: string, repoPath = ''): string {
  const text = String(prompt || '').toLowerCase();
  if (selectedApp || explicitUrl) return '';
  if (wantsGenericOrAllApps(text)) return '';
  if (wantsPlatformAdminScope(text)) return '';
  if (!/\b(test|run|generate|create|write|draft|validate)\b/.test(text)) return '';
  const configured = platformCandidates(repoPath);
  if (configured.some((name) => text.includes(name.toLowerCase()))) return '';
  const names = repoFeaturePlatforms(prompt, repoPath);
  if (names.length < 2) return '';
  return `The requested feature appears in multiple repo targets. Which platform should I test it in?\n\nAvailable platforms: ${names.join(' · ')}\n\nReply with a platform name, or say "generic/common/all platforms" to generate shared coverage without choosing one.`;
}
function latestRunForConversation(conversationId: string, scope: any) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  return scopeFilter(db.agentRuns as any[], scope)
    .filter((run: any) => run.conversationId === id)
    .sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

function stripScriptBlocksFromScope(value: string): string {
  const stripped = String(value || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .split(/\r?\n/)
    .filter((line) => !/\b(import\s+\{?\s*test|test\.describe\(|test\(|page\.|expect\(|const\s+USERNAME|const\s+PASSWORD)\b/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return /\bskipped new selector invention\b/i.test(stripped) && !/\b(?:flow|case|scenario|requirement|expected|steps?)\b/i.test(stripped)
    ? ''
    : stripped;
}

function extractCarriedForwardScope(value: string): string {
  const text = String(value || '');
  const marker = 'Carry forward this prior agent answer as authoritative scope:';
  const idx = text.indexOf(marker);
  if (idx === -1) return '';
  return stripScriptBlocksFromScope(stripCodebaseLocationsForAgentConsole(text.slice(idx + marker.length).trim()));
}

function isShortFollowUpAction(value: string): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 80) return false;
  return /\b(deep\s*test|test\s+them\s+all|run\s+them|test\s+all|continue|proceed|generate\s+(?:scripts|cases)|create\s+(?:scripts|cases))\b/.test(text);
}

function buildCarriedForwardUnderstanding(input: {
  task: string;
  rawOriginalRequest: string;
  targetName: string;
  targetUrl: string;
  carriedScope: string;
}): string {
  const target = input.targetName
    ? `${input.targetName}${input.targetUrl ? ` at ${input.targetUrl}` : ''}`
    : input.targetUrl || 'Target not provided';
  const action = input.rawOriginalRequest || input.task || 'Continue with the requested deep QA work';
  return stripCodebaseLocationsForAgentConsole(
    `Here's what I understood\n` +
    `You want me to continue from the grounded scope already found in this chat and perform: ${action}.\n\n` +
    `Target\n${target}\n\n` +
    `Task\n${input.task || action}\n\n` +
    `Grounded scope I will carry forward\n${input.carriedScope}\n\n` +
    `Plan\nUse the grounded scope above as the source of truth, create human-reviewable QA cases, then generate matching Playwright scripts and evidence only after approval.`,
  );
}

function getAgentPlanStatus(run: any) {
  if (run?.status === 'completed') return 'Completed';
  if (run?.status === 'review_required') return 'Under Review';
  if (run?.status === 'failed') return 'Blocked';
  if (run?.status === 'running') return 'In Progress';
  // A generated plan holds real, usable cases — an interrupted/cancelled generation still leaves a
  // Draft plan the user works with, so it must NOT default to 'Cancelled' (bug #18).
  return 'Draft';
}

function getAgentPlanRiskLevel(run: any) {
  const prompt = String(run?.prompt || '').toLowerCase();
  const cases = Array.isArray(run?.generated_cases) ? run.generated_cases : [];
  const priorities = cases.map((testCase: any) => String(testCase?.priority || '').toLowerCase());
  const tagsAndText = cases
    .map((testCase: any) => `${testCase?.title || ''} ${testCase?.description || ''} ${(testCase?.tags || []).join(' ')}`)
    .join(' ')
    .toLowerCase();

  if (priorities.includes('critical')) {
    return 'High';
  }

  if (priorities.includes('high')) {
    return 'Medium';
  }

  return 'Low';
}

// Request filler the folder name must not carry — verbs/counts, not the feature being tested.
const FOLDER_NAME_STOPWORDS = new Set([
  'please', 'can', 'could', 'would', 'will', 'you', 'kindly', 'pls',
  'generate', 'create', 'write', 'draft', 'author', 'make', 'build', 'add', 'give',
  'test', 'tests', 'testing', 'case', 'cases', 'scenario', 'scenarios', 'coverage',
  'verify', 'check', 'validate', 'run', 'execute', 'do', 'help', 'me', 'us', 'i',
  'a', 'an', 'the', 'for', 'of', 'in', 'on', 'to', 'and', 'with', 'some', 'few', 'more',
  'new', 'app', 'application', 'website', 'site', 'page', 'feature', 'functionality',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '15', '20',
]);

// Intent-based folder suggestion (mirrors the console's suggestFolderName): the FEATURE the user
// asked to test, title-cased and prefixed with the target app — "CRM - Accounts List View", never
// a URL-host label. Empty when the request carries no usable feature phrase.
function suggestIntentFolderName(request: string, targetName: string): string {
  const words = String(request || '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const appLower = String(targetName || '').trim().toLowerCase();
  // Also drop tokens repeating the app name — it becomes the prefix, not part of the feature.
  const kept = words.filter((w) => !FOLDER_NAME_STOPWORDS.has(w.toLowerCase()) && w.toLowerCase() !== appLower);
  if (!kept.length) return '';
  const title = (value: string) => value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, ' ').trim();
  const feature = title(kept.slice(0, 8).join(' '));
  const app = title(String(targetName || '').trim());
  return app ? `${app} - ${feature}` : feature;
}

// Meaningful artifact names: compose from the run's REAL context (application + module/feature)
// so suites/plans read "Keystone · Leads — Functional Validation", never an id-looking label.
function buildContextualArtifactName(ctx: { appLabel?: string; appName?: string; moduleName?: string; prompt?: string }): string {
  const app = String(ctx.appLabel || ctx.appName || '').trim();
  const module = String(ctx.moduleName || '').trim();
  const scope = /\bsmoke\b/i.test(String(ctx.prompt || '')) ? 'Smoke' : 'Functional';
  const subject = [app, module].filter(Boolean).join(' · ');
  return subject ? `${subject} — ${scope} Validation` : '';
}

function buildFallbackArtifactName(prompt: string, targetUrl: string) {
  const source = `${prompt || ''} ${targetUrl || ''}`.toLowerCase();
  // App name is DERIVED from the target URL host (works for any app), never a hardcoded
  // per-app guess. Falls back to a neutral label when there is no usable URL.
  let appName = '';
  if (targetUrl) {
    try { appName = new URL(targetUrl).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ') || ''; } catch { /* keep default */ }
  }
  const scopeParts = [];
  if (/\bsmoke/.test(source)) scopeParts.push('Smoke');
  const scope = scopeParts.length ? scopeParts.join(' and ') : 'Functional';
  return `${appName.replace(/\b\w/g, (char) => char.toUpperCase())} ${scope} Validation`.replace(/\s+/g, ' ').trim();
}

const caseUrlPattern = /\b(?:https?:\/\/|www\.)[^\s),]+|\b(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s),]*)?/gi;
function cleanCaseText(value: any, run: any): string {
  const appName = String(run?.appName || '').trim();
  const targetUrl = String(run?.app_url || '').trim();
  let out = String(value || '');
  // Guard: replacing an EMPTY targetUrl matches the empty string at position 0 and PREPENDS appName
  // to every value ("Application" + text). Only substitute when there is an actual URL to replace.
  if (targetUrl) out = out.replace(targetUrl, appName);
  return out
    .replace(caseUrlPattern, appName)
    .replace(/\s+/g, ' ')
    .trim();
}

// The steps live in their own Steps section, so the description must not repeat them. If the model
// still embeds a "Test Steps: 1. ... Expected: ..." block (or a bare "1. ... 2. ..." list) in the
// description, strip it and keep only the short lead summary  -  otherwise the same steps show twice.
function stripEmbeddedSteps(text: string): string {
  let out = String(text || '');
  out = out.split(/\b(?:test\s+)?steps\s*:/i)[0];
  out = out.split(/\bexpected\s*:/i)[0];
  out = out.replace(/\s+\d+[.)]\s+\S.*$/s, ''); // bare "1. ... 2. ..." enumeration with no header
  return out.replace(/\s+/g, ' ').trim();
}

// Cap a title's length WITHOUT ending mid-thought. A plain word-slice left dangling connectors
// ("... name validation and", "... loads automatically with", "... support lookup") that read as broken.
// Trim to the word cap, then drop any trailing connector / article / dash so the title stops on a
// complete word.
const TITLE_DANGLING = /^(and|or|but|with|to|for|of|in|on|at|by|the|a|an|that|when|which|while|so|is|are|was|were|as|from|into|per|via|no)$/i;
// The cap is a RUNAWAY guard, not a style enforcer. Verify-convention titles carry an
// "<app> - <feature area> - verify ..." prefix that alone uses ~6-8 words, so a tight cap
// (the old 18) chopped the behavior clause mid-sentence ("... verify reordering a visible
// column is treated"), which is worse than a slightly long title. Style-level brevity is
// the case writer's job (see CASE_AUTHORING_CONTRACT); this only stops true runaways.
function capTitleWords(title: string, maxWords = 30): string {
  const words = String(title || '').split(/\s+/).filter(Boolean);
  const kept = words.slice(0, maxWords);
  while (kept.length > 4 && (TITLE_DANGLING.test(kept[kept.length - 1]) || /^[-:]$/.test(kept[kept.length - 1]))) kept.pop();
  return kept.join(' ').replace(/[\s\-:]+$/, '').trim();
}

function conciseCaseTitle(value: any, run: any): string {
  const appName = String(run?.appName || '').trim();
  let title = cleanCaseText(value, run)
    .replace(/^verif(?:y|ies)\s+that\s+/i, 'verify ')
    .replace(/^test\s+/i, 'verify ');
  if (appName && !title.toLowerCase().includes(appName.toLowerCase())) title = `${appName} - ${title}`;
  return capTitleWords(title);
}

function readableCaseTitle(value: any, run: any, _extraText = ''): string {
  const raw = cleanCaseText(value, run);
  const prompt = String(run?.prompt || '').toLowerCase();
  const area = String(run?.appName || '').trim();

  // Use the model's OWN title  -  it is written from the real codebase understanding + live
  // inspection, so it names what the repo actually does. We only tidy it (strip app-word noise,
  // ensure it reads as a "verify ..." behaviour, cap the length). No keyword->canned-title mapping:
  // that discarded the case's real specifics and collapsed distinct cases onto identical titles,
  // which the title de-dupe then silently dropped.
  let title = conciseCaseTitle(raw, { ...run, appName: area });
  if (!/^verify\b/i.test(title) && !title.toLowerCase().includes(' - verify ')) {
    title = title.replace(`${area} - `, `${area} - verify `);
  }
  return capTitleWords(title);
}

function testCaseText(run: any): string {
  return [run?.description, run?.preconditions, run?.prompt].filter(Boolean).join(' ');
}

function normalizeGeneratedCaseText(testCase: any, run: any) {
  return {
    ...testCase,
    title: readableCaseTitle(
      testCase?.title || 'verify application behavior',
      run,
      `${testCase?.description || ''} ${testCase?.preconditions || ''}`,
    ),
    description: stripEmbeddedSteps(cleanCaseText(testCase?.description || '', run)),
    preconditions: cleanCaseText(testCase?.preconditions || '', run),
    steps: normalizeCaseSteps(testCase?.steps || []).map((step) => ({
      action: cleanCaseText(step.action, run),
      expected: cleanCaseText(step.expected, run),
    })),
  };
}

function normalizeGeneratedCasesText(cases: any[], run: any): any[] {
  const seen = new Set<string>();
  return (Array.isArray(cases) ? cases : [])
    .map((testCase) => normalizeGeneratedCaseText(testCase, run))
    .filter((testCase) => {
      const key = String(testCase?.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function metadataProofTerms(run: any): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown) => {
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !CASE_MATCH_STOP.has(word))
      .forEach((word) => out.add(word));
  };
  for (const obj of Array.isArray(run?.metadata_map?.objects) ? run.metadata_map.objects : []) {
    add(obj?.api_name);
    add(obj?.label);
    for (const field of Array.isArray(obj?.fields) ? obj.fields : []) {
      add(field?.api_name);
      add(field?.label);
      for (const option of Array.isArray(field?.picklist_options) ? field.picklist_options : []) add(option);
    }
  }
  return out;
}

function proofTerms(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    ?.filter((word) => word.length >= 3 && !CASE_MATCH_STOP.has(word) && !/^\d+$/.test(word)) || [];
}

function expandProofTokens(values: Set<string>): Set<string> {
  const out = new Set(values);
  for (const value of values) for (const token of proofTerms(value)) out.add(token);
  return out;
}

function buildCaseProofIndex(run: any) {
  const live = buildLiveSelectorIndex(run);
  const registry = buildSelectorRegistryIndex((run as any).selector_registry);
  const metadata = metadataProofTerms(run);
  const dom = new Set<string>();
  const addDom = (e: any) => {
    [e?.name, e?.aria_label, e?.ariaLabel, e?.text, e?.placeholder, e?.input_name, e?.element_id, e?.id, e?.role, e?.tag, e?.resolved_selector, e?.fallback_selector]
      .forEach((v) => { const s = String(v || '').replace(/\s+/g, ' ').trim(); if (s) dom.add(s.toLowerCase()); });
  };
  for (const e of Array.isArray(run?.dom_exploration?.elements) ? run.dom_exploration.elements : []) addDom(e);
  const bb = run?.blackboard_id ? readBlackboard(String(run.blackboard_id)) : null;
  for (const e of Array.isArray(bb?.elements) ? bb.elements : []) addDom(e);
  return { live: expandProofTokens(new Set([...live.names, ...dom])), registry: expandProofTokens(registry.names), metadata };
}

function classifyProofForText(text: string, proof: { live: Set<string>; registry: Set<string>; metadata: Set<string> }) {
  const tokens = [...new Set(proofTerms(text))];
  const liveHits = tokens.filter((token) => proof.live.has(token) || proof.registry.has(token));
  const metadataHits = tokens.filter((token) => proof.metadata.has(token));
  if (liveHits.length >= 3) return { status: 'verified', hits: liveHits };
  if (liveHits.length > 0 || metadataHits.length > 0) return { status: 'metadata-backed', hits: [...liveHits, ...metadataHits] };
  return { status: 'blocked', hits: [] as string[] };
}

function annotateGeneratedCasesWithProof(cases: any[], run: any): any[] {
  const proof = buildCaseProofIndex(run);
  return (Array.isArray(cases) ? cases : []).map((testCase: any) => {
    const steps = normalizeCaseSteps(testCase?.steps || []).map((step) => {
      const verdict = classifyProofForText(`${step?.action || ''} ${step?.expected || ''}`, proof);
      return {
        ...step,
        proofStatus: verdict.status,
        proofTokens: verdict.hits.slice(0, 8),
      };
    });
    const verifiedCount = steps.filter((step: any) => step.proofStatus === 'verified').length;
    const metadataCount = steps.filter((step: any) => step.proofStatus === 'metadata-backed').length;
    const blockedCount = steps.filter((step: any) => step.proofStatus === 'blocked').length;
    const automationReadiness = blockedCount === 0 && verifiedCount > 0
      ? 'verified'
      : (verifiedCount > 0 || metadataCount > 0 ? 'metadata-backed' : 'blocked');
    return {
      ...testCase,
      steps,
      confidence: automationReadiness,
      automationReadiness,
      proofSummary: `${verifiedCount} verified step(s), ${metadataCount} metadata-backed, ${blockedCount} blocked`,
      proofCounts: { verified: verifiedCount, metadataBacked: metadataCount, blocked: blockedCount },
    };
  });
}

function assessScriptGrounding(run: any, cases: any[], hasRepoSelectorMap: boolean) {
  const live = buildLiveSelectorIndex(run);
  const registry = buildSelectorRegistryIndex((run as any).selector_registry);
  const domCoverage = run?.dom_exploration?.coverage || {};
  const mcpCoverage = (run as any)?.mcp_dom_facts?.coverage || {};
  const verifiedCases = (Array.isArray(cases) ? cases : []).filter((tc: any) => tc?.automationReadiness === 'verified').length;
  const metadataBackedCases = (Array.isArray(cases) ? cases : []).filter((tc: any) => tc?.automationReadiness === 'metadata-backed').length;
  const blockedCases = (Array.isArray(cases) ? cases : []).filter((tc: any) => tc?.automationReadiness === 'blocked').length;
  const hasLiveDomProof = Number(domCoverage.verified || 0) > 0 || Number(mcpCoverage.actionables || 0) > 0 || live.usable;
  const hasRegistryProof = registry.usable || Number(run?.selector_registry?.coverage?.verified || 0) > 0;
  const mode = blockedCases > 0
    ? 'blocked'
    : hasLiveDomProof
      ? (metadataBackedCases > 0 ? 'mixed' : 'live')
      : (hasRepoSelectorMap && hasRegistryProof ? 'source-only' : 'blocked');
  const ok = mode !== 'blocked';
  const reason = mode === 'live'
    ? `Live grounding is usable (${verifiedCases}/${cases.length} case(s) verified against live proof).`
    : mode === 'mixed'
      ? `Mixed grounding: live proof exists, but ${metadataBackedCases}/${cases.length} case(s) still depend partly on source/metadata evidence.`
      : mode === 'source-only'
        ? 'Live DOM grounding is weak or unavailable; scripts may still be authored from source-backed selectors and inspection context only.'
        : blockedCases > 0
          ? `Blocked script generation: ${blockedCases}/${cases.length} case(s) have no usable automation proof.`
          : 'Blocked script generation: neither live DOM proof nor usable source-backed selectors were available.';
  return {
    ok,
    mode,
    reason,
    liveUsable: hasLiveDomProof,
    registryUsable: hasRegistryProof,
    verifiedCases,
    metadataBackedCases,
    blockedCases,
  };
}

function renderScriptGroundingBlock(grounding: {
  mode: string;
  reason: string;
  liveUsable: boolean;
  verifiedCases: number;
  metadataBackedCases: number;
  blockedCases: number;
}, cases: any[]): string {
  const caseLines = (Array.isArray(cases) ? cases : []).slice(0, 40).map((tc: any, index: number) => {
    const title = String(tc?.title || `Test case ${index + 1}`).slice(0, 120);
    const readiness = String(tc?.automationReadiness || 'unknown');
    const proof = String(tc?.proofSummary || '').slice(0, 160);
    return `- ${title}: readiness=${readiness}${proof ? `; ${proof}` : ''}`;
  });
  return `
SCRIPT GROUNDING MODE: ${grounding.mode}
GROUNDING SUMMARY: ${grounding.reason}
GROUNDING RULES:
- LIVE mode: prefer selectors and assertions proven by the live inspection/DOM evidence.
- MIXED mode: live evidence is available for some controls, but some cases still rely on source/metadata grounding. Use live evidence first; only use repo/source selectors when the needed control was not proven live.
- SOURCE-ONLY mode: no trustworthy live DOM proof exists for this run. You may still write scripts, but ONLY from the inspection context, verified selector registry, repo selector map, and metadata-backed case steps. Do NOT claim a selector was live-verified. Do NOT invent menus, labels, success toasts, or page states.
- BLOCKED mode: do not write scripts.
- If a case below is marked readiness=blocked, it is not automatable from current evidence and must not receive a script.
CASE READINESS:
${caseLines.join('\n') || '(none)'}
`;
}

function lightOutput(value: any) {
  if (typeof value === 'string') return value.slice(0, 1200);
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value).slice(0, 1200)); }
  catch { return String(value).slice(0, 1200); }
}

function runStatusSnapshot(run: any) {
  const messages = Array.isArray(run?.messages) ? run.messages : [];
  const latest = messages[messages.length - 1] || null;
  return {
    id: run?.id,
    status: run?.status || 'running',
    // Graph-engine gates only set pending_review.kind (never review_stage), so derive it here —
    // otherwise the UI can't tell a 'scripts' review pause from a 'cases' one and the button stays
    // "Continue -> scripts" instead of advancing to "Run scripts & capture evidence".
    review_stage: run?.review_stage || run?.pending_review?.kind || '',
    created_at: run?.created_at,
    completed_at: run?.completed_at,
    paused_ms: run?.paused_ms || 0,
    artifactName: run?.artifactName,
    app_url: run?.app_url,
    verdict: run?.verdict,
    execution_result: run?.execution_result ? {
      ok: run.execution_result.ok,
      total: run.execution_result.total,
      passed: run.execution_result.passed,
      failed: run.execution_result.failed,
      skipped: run.execution_result.skipped,
      error: run.execution_result.error,
      tests: (run.execution_result.tests || []).map((t: any) => ({
        title: t.title,
        status: t.status,
        durationMs: t.durationMs,
        error: t.error,
      })),
    } : undefined,
    counts: {
      messages: messages.length,
      cases: Array.isArray(run?.generated_cases) ? run.generated_cases.length : 0,
      scripts: Array.isArray(run?.playwright_scripts) ? run.playwright_scripts.length : 0,
      evidence: Array.isArray(run?.evidence_screenshots) ? run.evidence_screenshots.length : 0,
    },
    messages: messages.slice(-24).map((m: any) => ({
      agent: m.agent,
      status: m.status,
      at: m.at,
      output: lightOutput(m.output),
    })),
    latest: latest ? {
      agent: latest.agent,
      status: latest.status,
      at: latest.at,
      output: lightOutput(latest.output),
    } : null,
  };
}

function runStatusSignature(snapshot: any) {
  return JSON.stringify({
    status: snapshot.status,
    review_stage: snapshot.review_stage,
    completed_at: snapshot.completed_at,
    counts: snapshot.counts,
    messages: snapshot.messages?.map((m: any) => [m.agent, m.status, m.at, typeof m.output === 'string' ? m.output : JSON.stringify(m.output || '').slice(0, 200)]),
    execution: snapshot.execution_result && [snapshot.execution_result.ok, snapshot.execution_result.total, snapshot.execution_result.passed, snapshot.execution_result.failed, snapshot.execution_result.error],
  });
}

function buildSelectedQaContext(input: { testPlanId?: string; testSuiteId?: string; testCaseId?: string }) {
  const selectedPlan = input.testPlanId ? db.plans.find((item: any) => item.id === input.testPlanId) : null;
  const selectedSuite = input.testSuiteId ? db.suites.find((item: any) => item.id === input.testSuiteId) : null;
  const selectedCase = input.testCaseId ? db.cases.find((item: any) => item.id === input.testCaseId) : null;
  const planSuites = selectedPlan ? db.suites.filter((suite: any) =>
    (Array.isArray(suite.testPlanIds) && suite.testPlanIds.length ? suite.testPlanIds : [suite.testPlanId]).includes(selectedPlan.id)
  ) : [];
  const suiteCases = selectedSuite ? db.cases.filter((testCase: any) =>
    (Array.isArray(testCase.testSuiteIds) && testCase.testSuiteIds.length ? testCase.testSuiteIds : [testCase.testSuiteId]).includes(selectedSuite.id)
  ) : [];
  const planCases = selectedPlan ? db.cases.filter((testCase: any) =>
    testCase.testPlanId === selectedPlan.id || planSuites.some((suite: any) =>
      (Array.isArray(testCase.testSuiteIds) && testCase.testSuiteIds.length ? testCase.testSuiteIds : [testCase.testSuiteId]).includes(suite.id)
    )
  ) : [];

  const context = {
    selectedPlan: selectedPlan ? {
      id: selectedPlan.id,
      name: selectedPlan.name,
      scope: selectedPlan.scope,
      objectives: selectedPlan.objectives,
      strategy: selectedPlan.strategy,
      testTypes: selectedPlan.testTypes,
      environments: selectedPlan.environments,
      status: selectedPlan.status,
      riskLevel: selectedPlan.riskLevel,
    } : null,
    selectedSuite: selectedSuite ? {
      id: selectedSuite.id,
      name: selectedSuite.name,
      description: selectedSuite.description,
      module: selectedSuite.module,
      priority: selectedSuite.priority,
      status: selectedSuite.status,
      tags: selectedSuite.tags,
    } : null,
    selectedCase: selectedCase ? {
      id: selectedCase.id,
      title: selectedCase.title,
      description: selectedCase.description,
      steps: normalizeCaseSteps(selectedCase.steps || []),
      type: selectedCase.type,
      priority: selectedCase.priority,
      status: selectedCase.status,
      tags: selectedCase.tags,
    } : null,
    relatedSuites: planSuites.slice(0, 10).map((suite: any) => ({
      id: suite.id,
      name: suite.name,
      module: suite.module,
      status: suite.status,
    })),
    relatedCases: (selectedCase ? [selectedCase] : selectedSuite ? suiteCases : planCases).slice(0, 12).map((testCase: any) => ({
      id: testCase.id,
      title: testCase.title,
      priority: testCase.priority,
      status: testCase.status,
      steps: normalizeCaseSteps(testCase.steps || []).slice(0, 8),
    })),
  };

  const hasContext = Boolean(context.selectedPlan || context.selectedSuite || context.selectedCase);
  return {
    context,
    hasContext,
    promptText: hasContext
      ? `Selected QA repository context. Treat this as the scope boundary and source of truth. If a test case is selected, rework, expand, automate, or generate adjacent coverage for that case instead of inventing unrelated scenarios. If a suite is selected, keep generated cases inside that suite/module. If a plan is selected, align scope, risks, environments, and test types to the plan. Context: ${JSON.stringify(context)}`
      : 'No existing test plan, suite, or case was selected. Generate from the user request and inspected app context.',
  };
}

function getAgentGuardrailResponse(message: string): string | null {
  // The legacy regex guardrail is replaced by runGuardrailPipeline in guardrails.ts.
  // Kept here as a safety net for callers that still import it.
  const pipeline = runGuardrailPipeline({
    agent: 'chatAssistant',
    userMessage: message,
  });
  if (pipeline.policyVerdict.kind === 'respond') return pipeline.policyVerdict.reply;
  if (pipeline.policyVerdict.kind === 'reject') return pipeline.policyVerdict.error;
  return null;
}

// The deep pipeline builds folders in-memory (shared/folders). When Postgres is
// enabled, the list pages read PG, and case/plan rows carry a folder_id FK -> the
// folder must exist in PG first. Mirror the in-memory folder chain (ancestors first).
async function ensureFolderInPg(folderId: string) {
  if (!folderId) return;
  const chain: any[] = [];
  const visited = new Set<string>();
  let current: any = db.folders.find((f: any) => f.id === folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    current = current.parentId ? db.folders.find((f: any) => f.id === current.parentId) : null;
  }
  for (const folder of chain) {
    await Folders.upsert({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId || null,
      path: getFolderPath(folder.id),
      description: folder.description || '',
      kind: folder.kind || 'Feature',
      createdBy: folder.createdBy || 'QA Assistant',
      projectId: folder.projectId || '',
      appId: folder.appId || '',
      ownerId: folder.ownerId || '',
    });
  }
}

function agentPlanId(run: any): string {
  return run.testPlanId || `PLAN-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentSuiteId(run: any): string {
  return run.testSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentCaseId(run: any, index: number): string {
  return `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
}

function runCaseId(run: any, index: number): string {
  const testCase = Array.isArray(run?.generated_cases) ? run.generated_cases[index] : null;
  return testCase?.reused && testCase?.existingCaseId ? testCase.existingCaseId : agentCaseId(run, index);
}

function agentRequirementId(run: any): string {
  return `REQ-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentRunRecordId(run: any): string {
  return `RUN-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentReportId(run: any): string {
  return `REP-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentDisplayName(run: any): string {
  // Contextual name outranks the host-derived fallback so pre-fix runs also render meaningfully.
  return run.artifactName
    || buildContextualArtifactName({
      appLabel: run.target_app_label,
      appName: run.appName,
      moduleName: run.mission_context?.module?.name || run.mission_context?.tab?.name,
      prompt: run.prompt,
    })
    || buildFallbackArtifactName(run.prompt || '', run.app_url || '');
}

function agentRunStatusForList(status: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    // A cancelled/interrupted generation still produced usable cases — surface it as a Draft run
    // rather than 'Cancelled', so freshly-generated runs aren't mislabelled (bug #18).
    case 'cancelled': return 'Draft';
    case 'review_required': return 'Review Required';
    case 'coverage_options': return 'Coverage Options';
    case 'running': return 'In Progress';
    default: return 'Draft';
  }
}

function summarizeAgentRunExecution(run: any) {
  const executionSteps = buildAgentExecutionSteps(run);
  const failed = executionSteps.filter((s: any) => /fail/i.test(String(s.outcome || ''))).length;
  const passed = executionSteps.filter((s: any) => /pass/i.test(String(s.outcome || ''))).length;
  const notVerified = executionSteps.length - passed - failed;
  const firstFailure = executionSteps.find((s: any) => /fail/i.test(String(s.outcome || '')));
  const reportStatus = failed > 0
    ? 'Failed'
    : (passed > 0 && notVerified === 0 ? 'Passed' : 'Inconclusive');
  const progressLabel = [
    `${passed} passed`,
    failed > 0 ? `${failed} failed` : '',
    notVerified > 0 ? `${notVerified} not executed` : '',
  ].filter(Boolean).join(' / ') || agentRunStatusForList(run.status);
  return { executionSteps, failed, passed, notVerified, firstFailure, reportStatus, progressLabel };
}

async function persistAgentRequirementArtifacts(run: any) {
  const cases = Array.isArray(run.generated_cases) ? run.generated_cases : [];
  const existingMatches = linkedExistingCases(Array.isArray(run.existing_matches) ? run.existing_matches : [], cases);
  const requirementId = agentRequirementId(run);
  run.requirement_id = requirementId;
  const understanding = run.feature_understanding && typeof run.feature_understanding === 'object' ? run.feature_understanding : {};
  const baseName = agentDisplayName(run);
  const isFinished = ['completed', 'failed', 'cancelled'].includes(String(run.status || '').toLowerCase());
  const coverageStatus = run.status === 'completed'
    ? 'covered'
    : cases.length
      ? 'gaps-proposed'
      : existingMatches.length
        ? 'partial'
        : 'unknown';
  await Requirements.upsert({
    id: requirementId,
    title: understanding.title || baseName,
    description: understanding.description || resolveUnderstanding(run) || run.prompt || '',
    featureQuery: run.prompt || baseName,
    businessRules: Array.isArray(understanding.businessRules) ? understanding.businessRules : [],
    dataPopulationNotes: understanding.dataPopulationNotes || '',
    adminBehavior: understanding.adminBehavior || '',
    keystoneBehavior: understanding.keystoneBehavior || '',
    metadataRefs: Array.isArray(understanding.metadataRefs) ? understanding.metadataRefs : [],
    sourceFiles: [],
    coverageStatus,
    status: isFinished ? 'Approved' : 'Draft',
    folderId: run.folderId || null,
    approvalState: 'proposed',
    proposedBy: 'QA Assistant',
    sourceRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  for (const existing of existingMatches) {
    const caseId = existing.existingCaseId || existing.id;
    if (!caseId) continue;
    await RequirementLinks.upsert({
      requirementId,
      caseId,
      linkType: 'existing',
      note: `Matched by agent run ${run.id}.`,
    });
  }

  for (let index = 0; index < cases.length; index++) {
    if (cases[index]?.reused && cases[index]?.existingCaseId) continue;
    await RequirementLinks.upsert({
      requirementId,
      caseId: runCaseId(run, index),
      linkType: 'generated',
      note: `Generated by agent run ${run.id}.`,
    });
  }
}

async function persistAgentRunAndReportArtifacts(run: any) {
  const baseName = agentDisplayName(run);
  const date = new Date().toISOString().split('T')[0];
  const { executionSteps, failed, passed, notVerified, firstFailure, reportStatus, progressLabel } = summarizeAgentRunExecution(run);
  const runRecordId = agentRunRecordId(run);
  const listStatus = agentRunStatusForList(run.status);
  const caseIds = (Array.isArray(run.generated_cases) ? run.generated_cases : []).map((_: any, index: number) => runCaseId(run, index));
  // Real elapsed time (excludes human review pause) — shared by the run AND its report so the
  // report's Duration is an actual time, not the literal "Generated" (#6).
  const durationLabel = run.completed_at && run.created_at
    ? `${Math.max(0, Math.round((Date.parse(run.completed_at) - Date.parse(run.created_at) - (run.paused_ms || 0)) / 1000))}s`
    : 'Pending';

  await Runs.upsert({
    id: runRecordId,
    name: `Agent Run - ${baseName}`,
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds,
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    status: listStatus,
    progress: progressLabel,
    date,
    totalExecutions: executionSteps.length,
    passed,
    failed,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    triggerType: 'agent',
    proposedBy: 'QA Assistant',
    approvalState: 'approved',
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: agentReportId(run),
    name: `Agent Report - ${baseName}`,
    runId: runRecordId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    totalExecutions: executionSteps.length,
    status: reportStatus,
    failureReason: firstFailure
      ? String(firstFailure.reason || firstFailure.expected || '')
      : (reportStatus === 'Inconclusive' ? `${notVerified} case(s) are not verified yet.` : ''),
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    narrative: `Generated from agent run ${run.id}. Current status: ${listStatus}.`,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  if (String(run.status || '').toLowerCase() === 'failed') {
    await Defects.upsert({
      id: `DEF-${run.id.substring(0, 8).toUpperCase()}`,
      title: `Agent run failed - ${baseName}`,
      description: (run.messages || []).slice(-3).map((m: any) => typeof m.output === 'string' ? m.output : JSON.stringify(m.output || '')).filter(Boolean).join('\n\n'),
      severity: 'High',
      status: 'Open',
      linkedRunId: runRecordId,
      evidence: run.evidence_screenshots || [],
      tags: ['@failure'],
      folderId: run.folderId || null,
      approvalState: 'approved',
      proposedBy: 'QA Assistant',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  // Per-signature professional defects (bug-investigation framework): the same deterministic builder the
  // graph terminal hook uses, fed from this run's execution_result. Additive — the coarse defect above and
  // its id space are untouched; idempotent ids + the once-per-run occurrence guard prevent double filing.
  try {
    const tests = run.execution_result?.tests;
    if (Array.isArray(tests) && tests.some((t: any) => ['failed', 'timedOut', 'interrupted'].includes(String(t?.status)))) {
      const [priorDefects, priorRuns] = await Promise.all([
        Defects.list().catch(() => []),
        (async () => {
          const runs = await AgentRuns.list().catch(() => [] as any[]);
          return runs
            .filter((r: any) => r?.id !== run.id && Array.isArray(r?.execution_result?.tests) && r.execution_result.tests.length)
            .slice(0, 20)
            .map((r: any) => ({
              runId: r.id,
              at: r.updated_at || r.created_at,
              verdicts: Object.fromEntries(r.execution_result.tests.map((t: any) => [String(t?.title || ''), String(t?.status || '')])),
            }));
        })(),
      ]);
      const report = buildDefectDrafts({
        runId: run.id,
        runRecordId,
        baseUrl: run.app_url || '',
        missionScope: run.mission_context?.executionScope || '',
        appLabel: run.target_app_label || '',
        mutationIntent: (run.playwright_scripts || []).some((s: any) => String(s?.code || '').includes('"mutationIntent":true')),
        cases: Array.isArray(run.generated_cases) ? run.generated_cases : [],
        tests,
        evidenceShots: run.evidence_screenshots || [],
        priorRuns,
        existingDefects: priorDefects,
        scope: { projectId: run.projectId || null, appId: run.appId || null, ownerId: run.ownerId || null },
      });
      await persistDefectReport(report, run.id);
    }
  } catch (err) {
    console.warn(`[agent] run ${run.id}: per-signature defect filing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistAgentQualityArtifacts(run: any) {
  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifacts(run);
  await persistAgentRunAndReportArtifacts(run);
  await saveAgentRunState(run, 'agent quality artifacts');
}

async function persistAgentCaseArtifacts(run: any) {
  await ensureAgentPlanAndSuite(run);
  const planId = agentPlanId(run);
  const suiteId = agentSuiteId(run);

  const cases = run.generated_cases || [];
  // Rework rounds replace the set: rows from a prior save of THIS run that are no longer in
  // the current case list are removed (reused existing cases keep their original run link).
  const keepIds = new Set(cases.map((c: any, i: number) => c?.id || agentCaseId(run, i)));
  try {
    const stale = (await Cases.list()).filter((existing: any) => existing.agentRunId === run.id && !keepIds.has(existing.id));
    for (const existing of stale) await Cases.remove(existing.id);
  } catch (err: any) {
    console.warn(`[agent] run ${run.id}: stale case cleanup failed: ${err?.message || err}`);
  }
  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    if (testCase?.reused && testCase?.existingCaseId) continue;
    const caseId = testCase?.id || agentCaseId(run, index);
    await Cases.upsert({
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
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'pending_review',
      agentRunId: run.id,
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  persistDataInBackground('agent case artifacts');
}

// Plan+suite creation shared by terminal persistence AND /api/agent/save-cases: cases carry
// FK refs to these rows, so whichever path runs first must materialize them (the graph engine
// has no review-pause persistence, unlike the legacy engine this endpoint assumed).
async function ensureAgentPlanAndSuite(run: any) {
  const planId = agentPlanId(run);
  const suiteId = agentSuiteId(run);
  const baseName = agentDisplayName(run);

  await ensureFolderInPg(run.folderId || '');

  // Plan must exist before the suite (suites.test_plan_id FK) and the suite before
  // the cases (cases.test_suite_id FK). Only create the ones the run didn't reuse.
  if (!run.testPlanId) {
    await Plans.upsert({
      id: planId,
      name: `Agent Plan - ${baseName}`,
      scope: run.app_url || 'Generated from QA Assistant',
      objectives: 'Validate generated user flows, test cases, automation scripts, and evidence.',
      strategy: 'AI-assisted functional and UI validation',
      testTypes: 'Functional, UI, Regression, Sanity',
      environments: run.app_url || '',
      roles: 'QA Assistant, CodeAnalyst, FeatureDiscoveryAgent, FeatureWriter, RequirementWriter, CoverageScout, PlaywrightAgent, EvidenceAgent',
      status: getAgentPlanStatus(run),
      riskLevel: getAgentPlanRiskLevel(run),
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'approved',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  // The suite's tags should reflect the coverage it actually holds  -  reuse the real tags the
  // cases were generated with (deduped), not a generic "@agent" label the user doesn't recognize.
  const suiteTags = Array.from(new Set(
    (run.generated_cases || []).flatMap((c: any) => normalizeCaseTags(c.tags || [])),
  ));

  if (!run.testSuiteId) {
    await Suites.upsert({
      id: suiteId,
      name: `Agent Suite - ${baseName}`,
      description: `Generated suite for ${run.app_url || baseName}`,
      testPlanId: planId,
      parentSuite: '',
      module: db.folders.find((folder: any) => folder.id === run.folderId)?.name || getFolderPath(run.folderId || ''),
      owner: 'QA Assistant',
      tags: suiteTags.length ? suiteTags : ['@generated'],
      priority: 'Medium',
      status: 'Active',
      folderId: run.folderId || null,
      createdBy: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'approved',
      sourceRunId: run.id,
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }
}

async function persistAgentScripts(run: any) {
  const scripts = Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [];
  const baseName = run.artifactName || buildFallbackArtifactName(run.prompt || '', run.app_url || '');

  await ensureFolderInPg(run.folderId || '');

  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index];
    const scriptId = `SCR-${run.id.substring(0, 8).toUpperCase()}-${index + 1}`;
    await Scripts.upsert({
      id: scriptId,
      name: script.filename || script.test_case_title || `Agent Script - ${baseName} - ${index + 1}`,
      filename: script.filename || `agent-script-${run.id.substring(0, 8)}-${index + 1}.spec.ts`,
      title: script.test_case_title || script.filename || `Agent Script - ${index + 1}`,
      code: script.code || '',
      language: 'typescript',
      framework: 'playwright',
      status: 'Generated',
      folderId: run.folderId || null,
      agentRunId: run.id,
      targetUrl: run.app_url || '',
      createdBy: 'QA Assistant',
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  persistDataInBackground('agent scripts');
}

// Stamp every pipeline phase message with an ISO timestamp so the Agent Console
// can show per-phase durations and a total. Routing phase boundaries through
// this keeps timing accurate without threading a clock through each call site.
function nowIso(): string { return new Date().toISOString(); }
function pushPhase(run: any, msg: any): void {
  // Best-effort cancellation: if the user requested a stop, abort as soon as the next
  // phase tries to start (so the pipeline doesn't advance past where it is).
  if (run?.cancelRequested && msg?.status === 'running') {
    throw new Error('RUN_CANCELLED');
  }
  run.messages.push({ ...msg, at: nowIso() });
}

function allCasesForRun(run: any): any[] {
  if (Array.isArray(run?.all_generated_cases) && run.all_generated_cases.length) return run.all_generated_cases;
  const msg = [...(run?.messages || [])].reverse().find((m: any) => m?.agent === 'TestGenerationAgent' && Array.isArray(m?.output?.test_cases));
  return msg?.output?.test_cases || run?.generated_cases || [];
}

function runDetailsPayload(run: any): any {
  return {
    ...run,
    // Same graph-gate derivation as runStatusSnapshot so the full-details refetch agrees with polling.
    review_stage: run?.review_stage || run?.pending_review?.kind || '',
    generated_cases: annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(run.generated_cases || [], run), run),
    all_generated_cases: annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(allCasesForRun(run), run), run),
  };
}

// A phase only gets its 'completed'/'skipped' follow-up if its step runs to the end. If the
// run is cancelled/errored mid-phase, or a retry resumes past a phase without re-running it,
// that phase's last message stays 'running' forever and its UI chip spins indefinitely with
// no way to tell "still working" from "orphaned". Call this wherever a run moves on without
// re-running the phase, so every chip lands on an honest terminal state.
function resolveDanglingPhases(run: any, note: string): void {
  const lastByAgent = new Map<string, any>();
  for (const msg of run.messages || []) {
    if (msg?.agent) lastByAgent.set(msg.agent, msg);
  }
  for (const [agent, msg] of lastByAgent) {
    if (msg.status === 'running') {
      run.messages.push({ agent, status: 'skipped', output: note, at: nowIso() });
    }
  }
}
// Mark the run as finished (or failed) and record the wall-clock end so the UI
// can compute total time. paused_ms (human review gap) is excluded by the UI.
function markRunDone(run: any, status: 'completed' | 'failed' | 'cancelled'): void {
  resolveDanglingPhases(run, 'Run ended before this phase reported a final status.');
  // Never override an explicit user cancel with completed/failed.
  if (run.status === 'cancelled') return;
  run.status = status;
  run.completed_at = nowIso();
  // Conversational Runtime Phase 6: publish the terminal outcome into the conversation session.
  projectRunLifecycleSafe({ run, phase: 'completed' });
}

async function saveAgentRunState(run: any, reason: string): Promise<void> {
  run.updated_at = nowIso();
  if (isPgEnabled()) await AgentRuns.upsert(run);
  persistDataInBackground(reason);
}

function saveAgentRunStateSoon(run: any, reason: string): void {
  void saveAgentRunState(run, reason).catch((err) => console.warn(`Failed to persist ${reason}:`, err?.message || err));
}

async function loadAgentRun(id: string): Promise<any | null> {
  const run = await loadAgentRunRaw(id);
  if (!run) return null;
  // Self-heal on read: a graph run left 'running' by a dead process (no live pump, stash gone) can never
  // advance — flip it to a truthful 'failed' the moment it's read so the UI never spins forever. No-op for
  // terminal, review-paused, actively-pumping, legacy, and just-projected runs.
  const healed = await reconcileRunIfOrphaned(run).catch(() => null);
  if (!healed) return run;
  const idx = db.agentRuns.findIndex((r: any) => r.id === id);
  if (idx >= 0) { Object.assign(db.agentRuns[idx], healed); return db.agentRuns[idx]; }
  return healed;
}

async function loadAgentRunRaw(id: string): Promise<any | null> {
  const live = db.agentRuns.find((run: any) => run.id === id);
  if (live) return live;
  const stored = await AgentRuns.get(id);
  if (!stored) return null;
  const idx = db.agentRuns.findIndex((run: any) => run.id === id);
  if (idx >= 0) {
    db.agentRuns[idx] = { ...db.agentRuns[idx], ...stored };
    return db.agentRuns[idx];
  }
  db.agentRuns.unshift(stored);
  return stored;
}

function throwIfCancelled(run: any): void {
  if (run?.cancelRequested || run?.status === 'cancelled') throw new Error('RUN_CANCELLED');
}

function groundingIsFresh(run: any): boolean {
  const at = Date.parse(String(run?.phases?.inspection?.completed_at || run?.updated_at || run?.created_at || ''));
  return Number.isFinite(at) && Date.now() - at < INSPECT_CACHE_TTL_MS;
}

/* ---------------------------------------------------------------------------
 * #5 Inspection / code-understanding cache.
 * Iterative local testing re-runs the same app+feature repeatedly. Cache the two
 * expensive, slow-on-codex results (live inspection + source understanding) keyed by
 * target + feature so 2nd+ runs skip them entirely. Short TTL so app changes are picked
 * up; cleared automatically. Keyed by lowercased targetUrl + normalized prompt.
 * -------------------------------------------------------------------------- */
const INSPECT_CACHE_TTL_MS = Math.max(60_000, Number(process.env.INSPECT_CACHE_TTL_MS) || 15 * 60 * 1000);
const inspectionCache = new Map<string, { at: number; value: any }>();
const understandingCache = new Map<string, { at: number; value: any }>();
const featureInventoryCache = new Map<string, { at: number; value: any }>();
const AUTH_SESSION_CACHE_TTL_MS = 15 * 60 * 1000;
const authSessionCache = new Map<string, {
  at: number;
  storageStatePath: string;
  sessionStorageState?: { origin: string; items: Record<string, string> };
}>();

function featureCacheKey(targetUrl: string, prompt: string, contextKey = ''): string {
  return [
    String(contextKey || '').toLowerCase(),
    String(targetUrl || '').toLowerCase(),
    String(prompt || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500),
  ].join('::');
}
function getCached(cache: Map<string, { at: number; value: any }>, key: string): any | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > INSPECT_CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}
function setCached(cache: Map<string, { at: number; value: any }>, key: string, value: any): void {
  cache.set(key, { at: Date.now(), value });
}

// Decide how many cases to write. An explicit number the user typed always wins.
// Otherwise (requested === 0 -> "auto" / "as many as possible" / "comprehensive")
// scale to the feature's REAL complexity as understood from the source: roughly one
// case per distinct business rule and candidate scenario, within a sane floor/ceiling
// so a trivial feature isn't padded and a complex one isn't starved.
// For background flows, restrict credential resolution to the run owner's own
// websites (every user is isolated). Legacy '' owners are reassigned to admin at
// startup, so admin's pre-existing credentials keep resolving.
function ownerScopeForRun(run: any): string | undefined {
  return run?.ownerId || undefined;
}

// OBJECT COVERAGE CONTRACT (prescriptive): when the goal names a metadata object we hold REAL
// fields for, prescribe the QA dimensions up front — CRUD, required-field validation, permissions,
// negative/boundary, relationships — so an "object" request cannot collapse into one generic case.
// App-agnostic by construction: every concrete detail (object label, field names, relationship
// fields) comes from the run's live-fetched metadata, never from hardcoded app knowledge.
function buildObjectCoverageBlock(run: any, prompt: string, understanding: string): string {
  const objects: any[] = Array.isArray(run?.metadata_map?.objects) ? run.metadata_map.objects : [];
  if (!objects.length) return '';
  const hay = `${prompt} ${understanding}`.toLowerCase();
  const target = objects.find((obj: any) => {
    const label = String(obj?.label || '').toLowerCase();
    const api = String(obj?.api_name || '').toLowerCase();
    return (label.length > 2 && hay.includes(label)) || (api.length > 2 && hay.includes(api));
  });
  const fields: any[] = Array.isArray(target?.fields) ? target.fields : [];
  if (!target || !fields.length) return '';
  const names = (list: any[]) => list.map((f: any) => String(f?.label || f?.api_name || '').trim()).filter(Boolean).slice(0, 20).join(', ');
  const required = fields.filter((f: any) => f?.required);
  const permissionSensitive = fields.filter((f: any) => f?.permission_sensitive);
  const relational = fields.filter((f: any) => /lookup|reference|relation|master|detail/i.test(String(f?.type || '')));
  return `\nOBJECT COVERAGE CONTRACT — the goal targets the "${target.label || target.api_name}" object (verified from live metadata: ${fields.length} fields). Object-level testing MUST cover each applicable dimension below with at least one focused case; do NOT collapse them into one generic "validate object" case. Skip a dimension only when the inspected UI/metadata proves it does not apply, and say so in a case description:
- CRUD: create with valid data, read/list the created record, update a field, delete (or the closest lifecycle the UI exposes).
- Required-field validation: submit with each required field missing/blank${required.length ? ` (required fields: ${names(required)})` : ''} and assert the validation message.
- Negative/boundary: invalid formats, over-length values, and boundary values for constrained fields.
- Permissions/visibility: behavior of permission-sensitive fields for the current role${permissionSensitive.length ? ` (permission-sensitive: ${names(permissionSensitive)})` : ''} — cover the OBSERVED state (hidden/read-only), never invent roles.
- Relationships: lookups/references resolve and constrain correctly${relational.length ? ` (relationship fields: ${names(relational)})` : ''}.
Ground every step in the inspected UI and the REAL TEST DATA pack; if a dimension's controls are not reachable in the UI, mark that case blocked in its preconditions instead of guessing.\n`;
}

function complexityDrivenCaseCount(understanding: any, requested: number): number {
  if (requested && requested > 0) return Math.min(40, requested);
  const rules = Array.isArray(understanding?.businessRules) ? understanding.businessRules.length : 0;
  const scenarios = Array.isArray(understanding?.candidateScenarios) ? understanding.candidateScenarios.length : 0;
  const features = Array.isArray(understanding?.featureInventory?.features) ? understanding.featureInventory.features : [];
  const directFeatures = Array.isArray(understanding?.features) ? understanding.features : [];
  const inventoryFeatures = features.length ? features : directFeatures;
  const subfeatures = inventoryFeatures.reduce((total: number, feature: any) => {
    const count = Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0;
    return total + Math.max(1, count);
  }, 0);
  const e2eFlows = Array.isArray(understanding?.featureInventory?.e2eFlows)
    ? understanding.featureInventory.e2eFlows.length
    : Array.isArray(understanding?.e2eFlows)
      ? understanding.e2eFlows.length
      : 0;
  const suggested = Math.max(rules, scenarios, subfeatures + e2eFlows);
  return Math.min(40, Math.max(5, suggested));
}

// Parse an explicit case count the user typed in natural language ("generate 5 test cases",
// "10 cases", "write 3 tests", "give me 8 scenarios"). Returns 0 when none is stated, so the
// flow/complexity decides. App-agnostic  -  pure language parsing, no app specifics.
function parseCaseCount(prompt: string): number {
  const text = String(prompt || '').toLowerCase();
  const m = text.match(/\b(\d{1,3})(?:\s+[a-z][a-z-]*){0,5}\s+(?:test\s*)?(?:cases?|tests?|scenarios?)\b/)
    || text.match(/\b(?:generate|create|write|add|make|need|want|give\s+me)\s+(\d{1,3})\b/)
    || text.match(/\b(?:only|just|limit(?:ed)?\s+to|exactly|maximum|max|top)\s+(\d{1,3})\b/)
    || text.match(/\b(\d{1,3})\s*(?:only|please)?\s*$/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 200) return n; }
  return 0;
}

function wantsFeatureInventory(prompt: string, approvedUnderstanding: string): boolean {
  const text = `${prompt || ''} ${approvedUnderstanding || ''}`.toLowerCase();
  // The inventory path fans a request out across MANY units (one case per object/subfeature). Only
  // a genuinely BROAD request should trigger it  -  broad intent ("all/every/each/entire/whole/
  // across/comprehensive/complete") combined with a scope noun (features/modules/app/...), or an
  // explicit end-to-end/coverage ask. A SINGULAR feature request ("the list view feature") must
  // NOT trigger it, or it sprays cases over every object that has that feature (the bug the user
  // hit: a "list view" request producing per-object "Sharing Settings list view" cases).
  const broadIntent = /\b(all|every|each|entire|whole|across|comprehensive|complete)\b/.test(text);
  const broadScope = /\b(features?|sub[-\s]?features?|modules?|screens?|pages?|workflows?|journeys?|app|application|product|system|everything|areas?)\b/.test(text);
  const e2e = /\b(end\s*to\s*end|e2e)\b/.test(text);
  return (broadIntent && broadScope) || (e2e && broadScope);
}

// Keywords that describe what this run is about  -  drawn from the prompt and the
// source understanding  -  used to find existing test cases that already cover it.
function canReusePriorCodeGrounding(source: string, grounding: string): boolean {
  const normalized = String(source || '').toLowerCase();
  // 'requirement' source already has deep code grounding baked into the context string.
  return /^(codebase|conversation_context|requirement)$/.test(normalized) && String(grounding || '').trim().length >= 120;
}

function meaningfulGroundingLines(value: string, limit = 40): string[] {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-**]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 18)
    .filter((line) => !/^(here'?s what i understood|target|task|plan|grounding i found|good test areas)$/i.test(line))
    .slice(0, limit);
}

function splitRequirementList(value: string): string[] {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 3);
}

function requirementSection(value: string, start: RegExp, endMarkers: RegExp[]): string {
  const text = String(value || '');
  const match = start.exec(text);
  if (!match) return '';
  const from = match.index + match[0].length;
  let to = text.length;
  for (const marker of endMarkers) {
    marker.lastIndex = 0;
    const rest = text.slice(from);
    const end = marker.exec(rest);
    if (end && end.index >= 0) to = Math.min(to, from + end.index);
  }
  return text.slice(from, to).trim();
}

function parseRequirementContextText(prompt: string, targetUrl: string, grounding: string): any | null {
  const text = String(grounding || '').trim();
  if (!/\bRequirement\s*:/i.test(text) && !/\bCandidate scenarios\s*\(/i.test(text)) return null;

  const title = (text.match(/^\s*Requirement\s*:?\s*(.+)$/im)?.[1] || titleFromPrompt(prompt, targetUrl)).trim();
  const description = requirementSection(text, /^\s*Description\s*:?\s*/im, [
    /^\s*Business rules\s*:?\s*$/im,
    /^\s*Admin surface\s*:?/im,
    /^\s*End-user surface\s*:?/im,
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]);
  const businessRules = splitRequirementList(requirementSection(text, /^\s*Business rules\s*:?\s*/im, [
    /^\s*Admin surface\s*:?/im,
    /^\s*End-user surface\s*:?/im,
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]));
  const adminBehavior = requirementSection(text, /^\s*Admin surface\s*:?\s*/im, [
    /^\s*End-user surface\s*:?/im,
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]);
  const keystoneBehavior = requirementSection(text, /^\s*End-user surface\s*:?\s*/im, [
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]);
  const metadataLine = text.match(/^\s*Metadata objects\s*:?\s*(.+)$/im)?.[1] || '';
  const metadataRefs = metadataLine
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== '[object Object]')
    .map((object) => ({ object, note: 'From reviewed requirement context.' }));
  const sourceLine = text.match(/^\s*Key source files\s*:?\s*(.+)$/im)?.[1] || '';
  const sourceFiles = sourceLine
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pathValue) => ({ path: pathValue, why: 'From reviewed requirement context.' }));
  const scenarios = splitRequirementList(requirementSection(text, /^\s*Candidate scenarios\s*\(\d+\)\s*:?\s*/im, []))
    .map((scenario) => ({
      title: scenario,
      priority: /unauth|unknown|non-admin|block|delete|disabled|invalid|unsupported|not found|permission|403|404|409|401/i.test(scenario) ? 'High' : 'Medium',
      rationale: 'Candidate scenario from reviewed requirement context.',
      steps: [
        { action: `Exercise: ${scenario}`, expected: 'The behavior matches the reviewed requirement and source-defined rule.' },
      ],
    }));

  return {
    title,
    description,
    businessRules,
    dataPopulationNotes: '',
    adminBehavior,
    keystoneBehavior,
    metadataRefs,
    sourceFiles,
    candidateScenarios: scenarios,
    reusedPriorGrounding: true,
    groundingSource: 'requirement_context',
  };
}

function titleFromPrompt(prompt: string, targetUrl: string): string {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean.slice(0, 90);
  if (targetUrl) {
    try { return `${new URL(targetUrl).hostname.replace(/^www\./, '')} workflow`; } catch { /* keep fallback */ }
  }
  return 'Grounded workflow';
}

/** Proposed-case titles from a prior chat answer that IS a test-case list (e.g. "**TC-01: title**"). */
function extractProposedCases(grounding: string): string[] {
  const text = String(grounding || '');
  const titles: string[] = [];
  // Bold/inline form: **TC-01: Create account with all required fields**
  for (const m of text.matchAll(/\*\*\s*TC[-_ ]?\d+\s*[:.\-–]\s*([^*\n]{5,140})\*\*/gi)) titles.push(m[1].trim());
  if (!titles.length) {
    // Plain form: a line starting with "TC-01: title"
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:[-*•]\s*)?TC[-_ ]?\d+\s*[:.\-–]\s*(.{5,140})$/i.exec(line.trim());
      if (m) titles.push(m[1].replace(/\*+/g, '').trim());
    }
  }
  return Array.from(new Set(titles)).slice(0, 40);
}

function buildUnderstandingFromPriorGrounding(prompt: string, targetUrl: string, grounding: string): any {
  const parsedRequirement = parseRequirementContextText(prompt, targetUrl, grounding);
  if (parsedRequirement) return parsedRequirement;

  const lines = meaningfulGroundingLines(grounding, 50);
  // A prior answer that already PROPOSES cases is a case list, not prose to shred: each proposed case
  // becomes ONE candidate scenario (a coverage contract), so the run writes them once instead of
  // re-deriving overlapping cases from every markdown fragment.
  const proposedCases = extractProposedCases(grounding);
  if (proposedCases.length >= 3) {
    return {
      title: titleFromPrompt(prompt, targetUrl),
      description: lines[0] || String(grounding || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      businessRules: lines.slice(0, 28),
      dataPopulationNotes: '',
      adminBehavior: '',
      keystoneBehavior: '',
      metadataRefs: [],
      sourceFiles: [],
      candidateScenarios: proposedCases.map((title) => ({
        title: title.slice(0, 110),
        priority: /permission|delete|blank|empty|invalid|duplicate|error|unauthenticated|blocked/i.test(title) ? 'High' : 'Medium',
        rationale: 'Proposed in the prior code-grounded chat answer.',
        steps: [{ action: `Exercise: ${title.slice(0, 140)}`, expected: 'The behavior matches the proposed case from the prior answer.' }],
      })),
      reusedPriorGrounding: true,
      groundingSource: 'chat_memory',
    };
  }
  const title = titleFromPrompt(prompt, targetUrl);
  return {
    title,
    description: lines[0] || String(grounding || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    businessRules: lines.slice(0, 28),
    dataPopulationNotes: '',
    adminBehavior: /admin/i.test(grounding) ? lines.filter((line) => /admin/i.test(line)).slice(0, 8).join(' ') : '',
    keystoneBehavior: /keystone/i.test(grounding) ? lines.filter((line) => /keystone/i.test(line)).slice(0, 8).join(' ') : '',
    metadataRefs: [],
    sourceFiles: [],
    candidateScenarios: lines.slice(0, 14).map((line) => ({
      title: line.slice(0, 110),
      priority: /permission|delete|bulk|export|error|access|role/i.test(line) ? 'High' : 'Medium',
      rationale: 'Reused from the prior code-grounded chat answer.',
      steps: [
        { action: `Exercise ${line.slice(0, 140)}`, expected: 'The behavior matches the code-grounded understanding from the prior answer.' },
      ],
    })),
    reusedPriorGrounding: true,
    groundingSource: 'chat_memory',
  };
}

function buildInventoryFromPriorGrounding(prompt: string, targetUrl: string, grounding: string): any {
  const title = titleFromPrompt(prompt, targetUrl);
  const lines = meaningfulGroundingLines(grounding, 80);
  // Case-list answers map 1:1 — ONE feature, one subfeature per proposed case. Shredding such an answer
  // into per-line "features" made every fragment regenerate overlapping cases (34 proposed → 59 written).
  const proposedCases = extractProposedCases(grounding);
  if (proposedCases.length >= 3) {
    return {
      appName: targetUrl || '',
      summary: `Proposed test cases reused from the prior code-grounded chat answer for: ${title}`,
      coverageAudit: {
        structuralFilesReviewed: [],
        omittedStructuralFiles: [],
        riskNotes: ['The prior chat answer proposed these cases; they were mapped 1:1 instead of re-derived.'],
      },
      features: [{
        name: title,
        surface: '',
        description: `Coverage contract: ${proposedCases.length} case(s) proposed in the prior answer.`,
        sourceFiles: [],
        subfeatures: proposedCases.map((caseTitle) => ({
          name: caseTitle.slice(0, 90),
          description: caseTitle,
          businessRules: [],
          userActions: [`Exercise: ${caseTitle.slice(0, 120)}`],
          testIdeas: [caseTitle.slice(0, 120)],
          priority: /permission|delete|blank|empty|invalid|duplicate|error|unauthenticated|blocked/i.test(caseTitle) ? 'High' : 'Medium',
          tags: ['@regression'],
        })),
      }],
      e2eFlows: [],
    };
  }
  const numbered = String(grounding || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\d+[.)]\s+(.{8,120})$/);
      return match ? match[1].trim() : '';
    })
    .filter(Boolean);
  const featureNames = Array.from(new Set((numbered.length ? numbered : lines.slice(0, 12))
    .map((line) => line.replace(/\s+-\s+.*$/, '').slice(0, 90).trim())
    .filter(Boolean)))
    .slice(0, 18);
  const features = (featureNames.length ? featureNames : [title]).map((name) => {
    const related = lines.filter((line) => line.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0] || '')).slice(0, 8);
    const material = related.length ? related : lines.slice(0, 8);
    return {
      name,
      surface: '',
      description: material[0] || name,
      sourceFiles: [],
      subfeatures: material.slice(0, 6).map((line) => ({
        name: line.slice(0, 90),
        description: line,
        businessRules: [line],
        userActions: [`Verify ${line.slice(0, 120)}`],
        testIdeas: [`Cover ${line.slice(0, 120)}`],
        priority: /permission|delete|bulk|export|error|access|role/i.test(line) ? 'High' : 'Medium',
        tags: ['@regression'],
      })),
    };
  });
  const wantsE2E = /\b(end\s*to\s*end|e2e|workflow|journey|flow)\b/i.test(`${prompt} ${grounding}`);
  return {
    appName: targetUrl || '',
    summary: `Reused from prior code-grounded chat answer for: ${title}`,
    coverageAudit: {
      structuralFilesReviewed: [],
      omittedStructuralFiles: [],
      riskNotes: ['Source code was not reread for this run; the prior code-grounded chat answer was reused as authoritative memory.'],
    },
    features,
    e2eFlows: wantsE2E ? [{
      name: `E2E - ${title}`.slice(0, 120),
      description: 'End-to-end workflow derived from the prior code-grounded chat answer.',
      entryPoint: targetUrl || '',
      coveredFeatures: features.map((feature: any) => feature.name).slice(0, 8),
      userJourney: ['Open target app', 'Authenticate if required', 'Navigate to the grounded feature area', 'Exercise the listed behaviors', 'Verify results and evidence'],
      businessRules: lines.slice(0, 10),
      sourceFiles: [],
      priority: 'High',
      tags: ['@e2e', '@regression'],
    }] : [],
  };
}

function featureInventoryCounts(inventory: any): { features: number; subfeatures: number; flows: number } {
  const features = Array.isArray(inventory?.features) ? inventory.features : [];
  const subfeatures = features.reduce((total: number, feature: any) => total + (Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0), 0);
  const flows = Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows.length : 0;
  return { features: features.length, subfeatures, flows };
}

function featureWriterOutput(inventory: any, extra: Record<string, unknown> = {}) {
  const counts = featureInventoryCounts(inventory);
  const features = (Array.isArray(inventory?.features) ? inventory.features : [])
    .map((feature: any) => ({
      name: feature?.name || 'Feature',
      subfeatures: Array.isArray(feature?.subfeatures) ? feature.subfeatures.length : 0,
    }))
    .slice(0, 20);
  const flows = (Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows : [])
    .map((flow: any) => flow?.name || 'E2E flow')
    .slice(0, 20);
  return {
    summary: inventory?.summary || '',
    counts,
    features,
    flows,
    ...extra,
  };
}

const CASE_MATCH_STOP = new Set([
  'the', 'and', 'for', 'test', 'tests', 'case', 'cases', 'with', 'that', 'this', 'from', 'into',
  'your', 'will', 'must', 'should', 'verify', 'check', 'across', 'have', 'page', 'app', 'application',
  'when', 'then', 'should', 'using', 'about', 'flow', 'flows', 'scenario', 'scenarios',
]);
function caseMatchKeywords(run: any): string[] {
  const u = run.feature_understanding || {};
  const inv = run.feature_inventory || {};
  const inventoryTerms = [
    ...(Array.isArray(inv.features) ? inv.features.flatMap((feature: any) => [
      feature?.name,
      ...(Array.isArray(feature?.subfeatures) ? feature.subfeatures.map((sub: any) => sub?.name) : []),
    ]) : []),
    ...(Array.isArray(inv.e2eFlows) ? inv.e2eFlows.map((flow: any) => flow?.name) : []),
  ];
  const text = [run.prompt, run.approvedUnderstanding, u.title, ...(Array.isArray(u.businessRules) ? u.businessRules : []), ...inventoryTerms]
    .filter(Boolean).join(' ').toLowerCase();
  const toks = (text.match(/[a-z][a-z0-9-]{2,}/g) || []).filter((t) => !CASE_MATCH_STOP.has(t));
  return Array.from(new Set(toks));
}

// Find EXISTING test cases (scoped to the run's project/app) that look related to
// this request, so the agent can offer reuse instead of regenerating from scratch.
// Cheap keyword-overlap scorer  -  surfaces candidates for the human to confirm.
/** Rebuild the graph's MissionRef from the run's sealed MissionContext (stored at start). */
function missionRefFromRun(run: any): MissionRef {
  const m = (run?.mission_context || {}) as any;
  return {
    platformType: m.platformType,
    platform: m.platform,
    runtimeSurface: m.runtimeSurface ?? null,
    applicationId: m.application?.id ?? null,
    moduleId: m.module?.id ?? null,
    tabId: m.tab?.id ?? null,
    targetUrl: m.targetUrl || run.app_url || '',
    executionScope: m.executionScope || '',
  };
}

/**
 * Launch the LangGraph run for a stored run record. Shared by the direct start path and the coverage
 * decision (reuse/gaps/fresh) so the gate and the no-gate path start the graph identically.
 * `seedCases` (reuse) makes author_cases use those cases instead of the LLM; `avoidCaseTitles` (gaps)
 * tells the author to skip duplicates of the reused set.
 */
async function beginGraphRunFor(run: any, opts?: { seedCases?: any[]; avoidCaseTitles?: string[]; credential?: any }): Promise<void> {
  const gs = (run.graph_start || {}) as any;
  const creds = opts?.credential
    || resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) })
    || run.credentials || {};
  const priorCapturedAt = Date.parse(String(run.session_context?.capturedAt || ''));
  const priorVerifiedElements = Number.isFinite(priorCapturedAt) && Date.now() - priorCapturedAt < 15 * 60 * 1000
    ? (run.session_context?.selector_registry?.verified_selectors || [])
    : [];
  await startGraphRun({
    runId: run.id,
    workspaceId: run.projectId || undefined,
    projectId: run.projectId || undefined,
    requestedBy: run.ownerId || undefined,
    goal: run.prompt || '',
    // The chat's code-grounded feature analysis — so the case writer authors from the real behaviors/rules
    // it found (derivation, validation, payload, edges), not just the one-line prompt + the live DOM catalog.
    understanding: (resolveUnderstanding(run) || '').trim() || undefined,
    conversationId: run.conversationId || undefined,
    requestedCaseCount: Number(gs.requestedCaseCount) || 0,
    reviewPolicy: gs.reviewPolicy === 'auto' ? 'auto' : 'manual',
    mission: missionRefFromRun(run),
    credential: { username: creds.username, password: creds.password, token: (creds as any).token },
    modelOverrides: { provider: gs.provider || undefined, model: gs.model || undefined, effort: gs.effort || undefined },
    legacyRunSeed: run,
    seedCases: opts?.seedCases,
    avoidCaseTitles: opts?.avoidCaseTitles,
    graphDeps: priorVerifiedElements.length ? { priorVerifiedElements } : undefined,
  });
}

// Find EXISTING test cases (scoped to the run's project/app) that look related to this request, so the
// agent can offer reuse instead of regenerating from scratch. Restored to the proven keyword-overlap
// scorer used on main/testflow_v2: caseMatchKeywords strips router/instruction boilerplate via
// CASE_MATCH_STOP, and scoreCaseReuse surfaces a candidate on >=2 keyword hits + a phrase anchor. The
// IDF ranker (rankReuseCandidates) diluted the prompt boilerplate ("User follow-up/request: ... Resolved
// scope from router: ...") below its 0.34 threshold, so genuinely-related cases stopped surfacing.
async function findRelatedExistingCases(run: any): Promise<any[]> {
  let all: any[] = [];
  try { all = await Cases.list(); } catch { return []; }
  if (!Array.isArray(all) || !all.length) return [];
  const scoped = scopeFilter(all as any[], { projectId: run.projectId || '', appId: run.appId || null, userId: run.ownerId || '', role: '' });
  const kws = caseMatchKeywords(run);
  const query = `${run.prompt || ''} ${run.feature_understanding?.title || ''}`.trim();
  if (!kws.length || !scoped.length) return [];
  return scoped
    .map((c: any) => {
      const hay = `${c.title || ''} ${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      return { c, ...scoreCaseReuse(query, hay, kws) };
    })
    .filter((x) => x.matched)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.c, _matchScore: x.score, _matchReasons: x.reasons, _matchAnchor: x.anchor }));
}

async function findExistingFeatureRequirements(run: any, limit = 8): Promise<any[]> {
  let all: any[] = [];
  try { all = await Requirements.list(); } catch { return []; }
  if (!Array.isArray(all) || !all.length) return [];
  const scoped = scopeFilter(all as any[], { projectId: run.projectId || '', appId: run.appId || null, userId: run.ownerId || '', role: '' });
  const kws = caseMatchKeywords(run);
  if (!kws.length || !scoped.length) return [];
  return scoped
    .map((requirement: any) => {
      const hay = [
        requirement.title,
        requirement.description,
        requirement.featureQuery,
        ...(Array.isArray(requirement.businessRules) ? requirement.businessRules : []),
      ].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const k of kws) if (hay.includes(k)) score += 1;
      return { requirement, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.requirement, _matchScore: x.score }));
}

// Map a stored QA-repository case into the shape the run's generated_cases use, so
// reused cases render and execute exactly like generated ones. Keeps a back-pointer.
function mapExistingToRunCase(c: any): any {
  return {
    title: c.title || 'Untitled',
    description: c.description || '',
    priority: c.priority || 'Medium',
    type: c.type || 'Manual',
    tags: normalizeCaseTags(c.tags || []),
    steps: normalizeCaseSteps(c.steps || []),
    captureEvidence: true,
    existingCaseId: c.id,
    reused: true,
    reuseMatchScore: c._matchScore,
    reuseMatchReasons: c._matchReasons || [],
    reuseMatchAnchor: c._matchAnchor || '',
  };
}

// Compact, prompt-friendly summary of the source understanding for grounding the
// case writer and the coder without blowing the token budget.
function summarizeUnderstanding(u: any, maxChars = 4000): string {
  if (!u || typeof u !== 'object') return '';
  const lines: string[] = [];
  if (u.title) lines.push(`Feature: ${u.title}`);
  if (u.description) lines.push(`What it does: ${u.description}`);
  if (Array.isArray(u.businessRules) && u.businessRules.length) lines.push(`Business rules enforced by the code:\n- ${u.businessRules.join('\n- ')}`);
  if (u.adminBehavior) lines.push(`Configuration/admin-surface behavior: ${u.adminBehavior}`);
  if (u.keystoneBehavior) lines.push(`End-user-surface behavior: ${u.keystoneBehavior}`);
  if (u.dataPopulationNotes) lines.push(`Background data/preconditions: ${u.dataPopulationNotes}`);
  if (Array.isArray(u.sharedComponents) && u.sharedComponents.length) {
    const componentLines = u.sharedComponents.slice(0, 12).map((c: any) => {
      const parts = [
        c.name || 'Shared component',
        Array.isArray(c.reusedBy) && c.reusedBy.length ? `reused by ${c.reusedBy.slice(0, 8).join(', ')}` : '',
        Array.isArray(c.controlsOrBehaviors) && c.controlsOrBehaviors.length ? `behaviors: ${c.controlsOrBehaviors.slice(0, 12).join('; ')}` : '',
        Array.isArray(c.metadataOrPermissionGates) && c.metadataOrPermissionGates.length ? `gates: ${c.metadataOrPermissionGates.slice(0, 8).join('; ')}` : '',
        Array.isArray(c.testFocus) && c.testFocus.length ? `test focus: ${c.testFocus.slice(0, 10).join('; ')}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
    });
    lines.push(`Reusable components discovered by code search:\n- ${componentLines.join('\n- ')}`);
  }
  if (Array.isArray(u.metadataRefs) && u.metadataRefs.length) lines.push(`Metadata source of truth: ${u.metadataRefs.map((m: any) => m.object).filter(Boolean).join(', ')}`);
  if (u.uiSelectors && typeof u.uiSelectors === 'object') {
    const selectorLines: string[] = [];
    const push = (label: string, values: string[]) => {
      const clean = (values || []).map(String).filter(Boolean).slice(0, 30);
      if (clean.length) selectorLines.push(`${label}: ${clean.join(' | ')}`);
    };
    push('aria-labels', u.uiSelectors.ariaLabels || []);
    push('labels', u.uiSelectors.labels || []);
    push('role names', (u.uiSelectors.roleNames || []).map((r: any) => `${r.role}:${r.name}`));
    push('test ids', u.uiSelectors.testIds || []);
    push('css ids', (u.uiSelectors.cssIds || []).map((id: string) => `#${id}`));
    push('css classes', (u.uiSelectors.cssClasses || []).map((cls: string) => `.${cls}`));
    push('placeholders', u.uiSelectors.placeholders || []);
    push('field ids', (u.uiSelectors.fieldIds || []).map((f: any) => `${f.label}=>#${f.id}`));
    if (selectorLines.length) lines.push(`Repo UI hooks for testing:\n- ${selectorLines.join('\n- ')}`);
  }
  if (Array.isArray(u.sourceFiles) && u.sourceFiles.length) lines.push(`Grounded in source files: ${u.sourceFiles.map((f: any) => f.path).filter(Boolean).slice(0, 10).join(', ')}`);
  if (Array.isArray(u.candidateScenarios) && u.candidateScenarios.length) {
    lines.push(`Candidate scenarios (${u.candidateScenarios.length}):\n- ${u.candidateScenarios.map((s: any) => s.title || s).filter(Boolean).join('\n- ')}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

function summarizeFeatureInventory(inventory: any, maxChars = 12000): string {
  if (!inventory || typeof inventory !== 'object') return '';
  const lines: string[] = [];
  if (inventory.appName) lines.push(`Application: ${inventory.appName}`);
  if (inventory.summary) lines.push(`Summary: ${inventory.summary}`);
  const features = Array.isArray(inventory.features) ? inventory.features : [];
  for (const feature of features.slice(0, 35)) {
    lines.push(`Feature: ${feature?.name || 'Feature'} [${feature?.surface || ''}] - ${feature?.description || ''}`.trim());
    const subfeatures = Array.isArray(feature?.subfeatures) ? feature.subfeatures : [];
    for (const sub of subfeatures.slice(0, 14)) {
      lines.push(`  Subfeature: ${sub?.name || 'Subfeature'} | priority=${sub?.priority || 'Medium'} | actions=${(sub?.userActions || []).join('; ')} | rules=${(sub?.businessRules || []).join('; ')} | testIdeas=${(sub?.testIdeas || []).join('; ')} | tags=${(sub?.tags || []).join(', ')}`);
    }
  }
  const flows = Array.isArray(inventory.e2eFlows) ? inventory.e2eFlows : [];
  if (flows.length) {
    lines.push('End-to-end flows:');
    for (const flow of flows.slice(0, 20)) {
      lines.push(`  E2E: ${flow?.name || 'Flow'} | priority=${flow?.priority || 'High'} | features=${(flow?.coveredFeatures || []).join(' > ')} | journey=${(flow?.userJourney || []).join(' -> ')} | rules=${(flow?.businessRules || []).join('; ')}`);
    }
  }
  return lines.join('\n').slice(0, maxChars);
}

function scenarioCoverageBlock(scenarios: any[], maxChars = 16000): string {
  const lines = scenarios
    .map((scenario, index) => `${index + 1}. ${String(scenario?.title || scenario || '').trim()}`)
    .filter((line) => /\S/.test(line));
  return lines.join('\n').slice(0, maxChars);
}

function normalizeScenarioTitle(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|or|for|with|to|of|in|on|is|are|view|views|list|lists)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function caseMentionsScenario(testCase: any, scenarioTitle: string): boolean {
  const scenario = normalizeScenarioTitle(scenarioTitle);
  if (!scenario) return true;
  const scenarioTerms = scenario.split(' ').filter((term) => term.length >= 4);
  if (!scenarioTerms.length) return true;
  const hay = normalizeScenarioTitle([
    testCase?.title,
    testCase?.description,
    ...(Array.isArray(testCase?.steps) ? testCase.steps.flatMap((step: any) => [step?.action, step?.expected]) : []),
  ].filter(Boolean).join(' '));
  const matched = scenarioTerms.filter((term) => hay.includes(term)).length;
  return matched >= Math.min(3, scenarioTerms.length);
}

function fallbackCaseForScenario(scenario: any): any {
  const title = String(scenario?.title || scenario || 'Requirement scenario').trim();
  const negative = /reject|block|invalid|unsupported|unknown|unauth|non-admin|cannot|disabled|not found|403|404|409|401/i.test(title);
  return {
    title: title.length > 90 ? title.slice(0, 87).trimEnd() + '...' : title,
    description: `Covers the reviewed requirement scenario: ${title}`,
    preconditions: 'User has the role, app, records, and metadata configuration required by the reviewed requirement.',
    priority: scenario?.priority || (negative ? 'High' : 'Medium'),
    type: 'Automated',
    tags: normalizeCaseTags(['@regression', negative ? '@negative' : '@positive', negative ? '@smoke' : '@bvt']),
    steps: normalizeCaseSteps(Array.isArray(scenario?.steps) && scenario.steps.length
      ? scenario.steps
      : [
          { action: `Exercise the scenario: ${title}`, expected: 'The application behavior matches the reviewed requirement.' },
          { action: 'Capture the visible response, table state, API response, or confirmation message for this scenario.', expected: 'The observed result is traceable to the requirement rule.' },
        ]),
    captureEvidence: true,
    generatedFallback: true,
  };
}

function isInvalidGeneratedCase(testCase: any): boolean {
  const title = String(testCase?.title || '').trim();
  const description = String(testCase?.description || '').trim();
  const steps = normalizeCaseSteps(testCase?.steps || []);
  const hay = `${title}\n${description}\n${steps.map((s) => `${s.action} ${s.expected}`).join('\n')}`;
  if (/preconditions?:|setup:|edge\/negative checks?:|edge cases?:|negative checks?:|risks?:|notes?:/i.test(title)) return true;
  if (steps.length === 1 && /\bexercise\b/i.test(steps[0]?.action || '') && /matches the .*understanding|traceable to the requirement/i.test(steps[0]?.expected || '')) return true;
  return /\bCovers the reviewed requirement scenario:\s*(Preconditions?|Setup|Edge\/negative checks?|Edge cases?|Negative checks?|Risks?|Notes)\s*:/i.test(hay);
}

function ensureScenarioCoverage(generated: any[], scenarios: any[], explicitCount: number): any[] {
  if (explicitCount > 0 || !Array.isArray(scenarios) || !scenarios.length) return generated;
  const output = Array.isArray(generated) ? [...generated] : [];
  for (const scenario of scenarios) {
    const title = String(scenario?.title || scenario || '').trim();
    if (!title) continue;
    if (/^(preconditions?|setup|edge\/negative checks?|edge cases?|negative checks?)\s*:/i.test(title)) continue;
    if (!output.some((testCase) => caseMentionsScenario(testCase, title))) {
      output.push(fallbackCaseForScenario(scenario));
    }
  }
  return output;
}

function renderBlackboardForPrompt(run: any, maxItems = 80): string {
  const entry = run?.blackboard_id ? readBlackboard(String(run.blackboard_id)) : null;
  const elements = Array.isArray(entry?.elements) ? entry.elements : Array.isArray(run?.dom_exploration?.elements) ? run.dom_exploration.elements : [];
  if (!elements.length) return '';
  const usable = elements
    .filter((e: any) => (e.status === 'verified' || e.status === 'not_unique') && (e.resolved_selector || e.fallback_selector))
    .slice(0, maxItems);
  if (!usable.length) return '';
  const lines = usable.map((e: any) => {
    const label = e.name || e.aria_label || e.text || e.placeholder || e.element_id || e.id || '';
    const selector = e.resolved_selector || e.fallback_selector;
    const opts = e.tag === 'select' && Array.isArray(e.options) && e.options.length
      ? ` options=${e.options.filter((o: any) => !o.disabled).slice(0, 12).map((o: any) => `${String(o.label || '').slice(0, 40)}=>${String(o.value || '').slice(0, 40)}${o.selected ? '*' : ''}`).join(' | ')}`
      : '';
    const state = [e.status === 'not_unique' ? 'not_unique' : '', e.state?.disabled ? 'disabled' : '', e.state?.required ? 'required' : '', e.value ? `value=${e.value}` : ''].filter(Boolean).join(', ');
    return `- ${e.role || e.tag || 'element'} "${String(label).slice(0, 80)}" -> ${selector}${state ? ` [${state}]` : ''}${opts}`;
  });
  const id = entry?.id || run?.blackboard_id || 'current-run-dom';
  return `\nVERIFIED BLACKBOARD: use these labels/selectors only.\nblackboard_id: ${id}\n${lines.join('\n')}\n`;
}
function inventoryGroundingTokens(inventory: any): Set<string> {
  const tokens = new Set<string>();
  const add = (value: unknown) => {
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !CASE_MATCH_STOP.has(word))
      .forEach((word) => tokens.add(word));
  };
  for (const feature of Array.isArray(inventory?.features) ? inventory.features : []) {
    add(feature?.name);
    add(feature?.description);
    for (const sub of Array.isArray(feature?.subfeatures) ? feature.subfeatures : []) {
      add(sub?.name);
      add(sub?.description);
      (sub?.businessRules || []).forEach(add);
      (sub?.userActions || []).forEach(add);
      (sub?.testIdeas || []).forEach(add);
    }
  }
  for (const flow of Array.isArray(inventory?.e2eFlows) ? inventory.e2eFlows : []) {
    add(flow?.name);
    add(flow?.description);
    (flow?.coveredFeatures || []).forEach(add);
    (flow?.userJourney || []).forEach(add);
    (flow?.businessRules || []).forEach(add);
  }
  return tokens;
}

function assessCasesInventoryGrounding(cases: any[], inventory: any) {
  if (!inventory || !Array.isArray(cases) || cases.length === 0) return null;
  const tokens = inventoryGroundingTokens(inventory);
  if (tokens.size === 0) return null;
  let grounded = 0;
  for (const c of cases) {
    const text = JSON.stringify([c?.title, c?.description, c?.tags, c?.steps]).toLowerCase();
    if ([...tokens].some((token) => text.includes(token))) grounded += 1;
  }
  if (grounded === 0) return { ok: false, reason: 'No generated cases reference the source-discovered feature inventory.' };
  return { ok: true, reason: `${grounded}/${cases.length} cases reference source-discovered features/subfeatures/E2E flows.` };
}

async function persistAgentRunArtifacts(run: any) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const existingRunId = agentRunRecordId(run);
  const existingReportId = agentReportId(run);
  const baseName = agentDisplayName(run);

  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifacts(run);
  await persistAgentScripts(run);

  const executionSteps = buildAgentExecutionSteps(run);
  // Count only REAL verdicts. "Not Executed"/"Blocked"/"Skipped" are neither a pass
  // nor a fail  -  counting them as passed is the false-green bug we are removing.
  const failed = executionSteps.filter((s: any) => /fail/i.test(String(s.outcome || ''))).length;
  const passed = executionSteps.filter((s: any) => /pass/i.test(String(s.outcome || ''))).length;
  const notVerified = executionSteps.length - passed - failed;
  const firstFailure = executionSteps.find((s: any) => /fail/i.test(String(s.outcome || '')));
  // A run is only "Passed" when something actually ran AND every executed verdict passed.
  // If nothing produced a real verdict, the result is Inconclusive, never Passed.
  const reportStatus = failed > 0
    ? 'Failed'
    : (passed > 0 && notVerified === 0 ? 'Passed' : 'Inconclusive');
  const progressLabel = [
    `${passed} passed`,
    failed > 0 ? `${failed} failed` : '',
    notVerified > 0 ? `${notVerified} not executed` : '',
  ].filter(Boolean).join(' / ');

  // Real elapsed time (shared by run + report) so Duration isn't the literal "Generated" (#6).
  const durationLabel = run.completed_at && run.created_at
    ? `${Math.max(0, Math.round((Date.parse(run.completed_at) - Date.parse(run.created_at) - (run.paused_ms || 0)) / 1000))}s`
    : 'Pending';

  await Runs.upsert({
    id: existingRunId,
    name: `Agent Run - ${baseName}`,
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds: (run.generated_cases || []).map((_: any, index: number) => runCaseId(run, index)),
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    status: 'Completed',
    progress: progressLabel,
    date,
    totalExecutions: executionSteps.length,
    passed,
    failed,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    triggerType: 'agent',
    proposedBy: 'QA Assistant',
    approvalState: 'approved',
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: existingReportId,
    name: `Agent Report - ${baseName}`,
    runId: existingRunId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: `Agent Plan - ${baseName}`,
    suiteName: `Agent Suite - ${baseName}`,
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    totalExecutions: executionSteps.length,
    status: reportStatus,
    failureReason: firstFailure
      ? String(firstFailure.reason || firstFailure.expected || '')
      : (reportStatus === 'Inconclusive' ? `${notVerified} case(s) were generated but never executed against the target  -  no verdict.` : ''),
    date,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  // Honest overall verdict combining the three grounded gates: did we SEE the app,
  // were the cases grounded, and did the scripts actually pass? Surfaced so the Agent
  // Console can show the truth instead of an unconditional green.
  const inspectionOk = !(run as any).inspection_blind;
  // Grounding can only be "ok" if we actually SAW the app AND the cases reference it.
  // A blind inspection means the cases are NOT grounded  -  never report grounded:ok then.
  const groundingOk = inspectionOk && ((run as any).cases_grounding ? (run as any).cases_grounding.ok : true);
  const execVerdict = assessExecution(run.execution_result);
  const overall = inspectionOk && groundingOk && execVerdict.ok ? 'verified'
    : (reportStatus === 'Failed' ? 'failed' : 'inconclusive');
  (run as any).verdict = {
    overall,
    inspection: inspectionOk ? 'ok' : 'blind',
    grounding: !inspectionOk ? 'not grounded (blind)' : (groundingOk ? 'ok' : 'ungrounded'),
    execution: execVerdict.reason,
    reportStatus,
  };

  run.persisted = true;
  addActivity(`Agent artifacts saved to ${run.folderId ? getFolderPath(run.folderId) : 'Uncategorized'}: ${baseName}`);
  await saveAgentRunState(run, 'agent run artifacts');
}

// isNoiseTurn and deriveUnderstandingFromChat moved to agent-runtime/context/goalContext.ts
// (imported above) so the chat-fallback logic is the single source shared by every worker.

/**
 * Write the run's test cases, then either pause for human review (review_cases) or
 * run scripts + evidence (complete). Resumable: it reads everything it needs off the
 * run record, so it can be invoked from the initial /start flow OR from the coverage
 * gate's decision endpoint. mode 'fresh' generates from scratch; mode 'gaps' keeps
 * the matched existing cases and appends only the scenarios they don't cover.
 */

/**
 * The ONE shared authoring-style contract appended to every case-writer prompt.
 * Kept in a single constant so the per-feature and whole-run prompts cannot drift
 * into conflicting conventions: previously each embedded its own title rules
 * ("15-20 words max" vs "10-18 words" vs the system prompt's verify convention),
 * and the contradictions + rule noise measurably degraded output quality by
 * crowding out the actual evidence. App-agnostic  -  style only, no app facts.
 */
const SOURCE_BOUNDARY_CONTRACT = `SOURCE BOUNDARY RULES (non-negotiable):
- Production repo code, live DOM/inspection, selector registry, metadata, and the approved agent understanding are the only evidence for application behavior.
- Existing test cases, previous runs, generated reports, QA artifacts, scripts, fixtures, and conversation memory are NOT product evidence. Use them only as reuse candidates after strict matching; never let them introduce new behavior into cases.
- Before asking for a child app/object/tab, use the selected platform plus repo/live evidence to decide whether the requested feature is platform-level or app-scoped. If the repo/live evidence shows the feature is global/platform-level, do not ask for an app. If it shows the feature is app-scoped and the user did not name the app/object/tab, ask for that missing scope instead of guessing.
- For generic feature requests, ground the reusable/shared implementation first, then the selected platform/app integration. Do not choose a convenient default entity, section, object, tab, or record type unless the user named it or the approved understanding names it.
- If repo/live evidence is missing for a behavior, mark it blocked/manual or omit it. Never fill the gap from old cases, similar apps, model memory, or assumed product conventions.
- CaseWriter must write only from the approved understanding and current evidence. Any case outside that boundary is invalid and must be dropped before saving.`;
const CASE_AUTHORING_CONTRACT = `CASE TEXT RULES (apply to every case):
- Titles must be short, plain-English, QA/business-readable, and name one behavior. Do not force prefixes like app name, surface name, feature name, or "verify" into every title. Prefer titles like "Actions menu shows core options", "Refresh is disabled while loading", or "New is disabled without permission". Never a vague label like "page works" or a compressed fragment like "404 blocks admin entry".
- When the request or reviewed understanding names a business app/object such as CRM Accounts, use that business name in titles/descriptions; do not expose environment ids such as keystone_local unless that is the only user-facing name available.
- Never put URLs in titles, descriptions, or steps; mention the selected app/area name instead. Never use "Automations" in a case title.
- If the selected target/surface conflicts with the source-grounded owner of the requested feature, do NOT blend the names. State the mismatch plainly in the reviewed understanding and generate cases for the actual owning surface only if the user approves that target; mention the originally selected target only when it has a real post-flow behavior to verify.
- Do not mention authentication, login, sign-in, credentials, username, or password anywhere in the case text unless the user explicitly asked for authentication coverage  -  login is only ever a silent setup/precondition step, never the subject of a case.
- Write titles, descriptions, preconditions, and every step action and expected result in plain, black-box, user-facing English: what a user does and sees on screen, in short sentences with common words. NEVER use internal identifiers (camelCase/snake_case names like "created_at" or "appId", component/file/prop names), database or implementation terms ("bootstrap", "deduplication", "persisted", "AND filters", "descending"), or developer phrasing  -  describe the visible on-screen outcome instead (say "sorted with the newest first", not "created_at descending"; "a default view appears automatically", not "a bootstrap view is created"; "opening it again does not add a duplicate").
- The description is ONE short plain sentence saying what the case checks and why. Do not restate the steps in it and do not embed a "Test Steps:" or "Expected:" list  -  the case has a separate Steps section.
- PRECONDITIONS ARE REQUIRED and concrete: for every case, state in ONE plain sentence the exact state that must already be true before the steps run — the signed-in role/permissions, which app/surface is open, and any records, metadata, or configuration that must already exist (e.g. "Signed in as an Admin with the Sales app open and at least one account record present"). This is where setup/login belongs (per the rule above), so keep it out of the title, description, and steps. Never leave preconditions empty and never restate the steps; if the only requirement is being signed in, say so naming the role and app.
- STEPS MUST BE DETAILED AND CONCRETE: each step is ONE specific user/system action naming the REAL on-screen element (the exact label/field/button/menu from the evidence) paired with its own specific, OBSERVABLE expected result for that action. No vague steps ("verify it works", "check the page"), no invented labels, no meta/setup scaffolding (CI, seeding, regression jobs). A reviewer must be able to follow the steps by hand and a Playwright script must be able to mirror them 1:1.
- TEST DESIGN  -  design coverage deliberately like a senior QA engineer, not just one happy path. Apply the techniques the feature's real behaviour supports: happy path; equivalence partitioning (one case per valid input class); boundary values (empty, minimum, maximum, over-maximum, max-length); decision tables for combined conditions; state transitions (create -> edit -> delete); negative/invalid input and error states; permission/role (RBAC) differences; and disabled/empty/loading/error states, including WHEN an action is unavailable (e.g. disabled while busy, disabled without permission, disabled for a protected/default item). Cover the highest-value behaviors first; never pad past the requested count.
- Each case includes automation tags in @ format (@bvt, @sanity, @regression, @smoke, @ui, @positive, @negative, ...). If the user requested specific tag types, apply those exact tags to every generated case.
- Every case tests the TARGET APPLICATION's own UI/behavior. NEVER write cases about the QA assistant, the chat/conversation, app-selection replies ("verify a follow-up of X applies to the request"), request routing/scoping, or test-generation itself  -  none of that is application behavior a user can perform in the app under test.`;

/** Generate test cases focused on ONE specific feature from the feature inventory. */
async function generateCasesForFeature(run: any, feature: any, liveCredentials: any): Promise<any[]> {
  const credentials = liveCredentials || run.credentials || {};
  const credentialContext = buildCredentialContext(credentials);
  const inspectionContext = run.inspection_context || null;
  const approvedUnderstanding = resolveUnderstanding(run);
  const targetUrl = run.app_url || '';
  const applicationContextBlock = run.application_context_prompt
    ? `\n${String(run.application_context_prompt)}\n`
    : '';
  const selectorRegistryBlock = renderSelectorRegistryForPrompt((run as any).selector_registry);
  const blackboardBlock = renderBlackboardForPrompt(run);

  const subfeatureBlock = (feature.subfeatures || []).map((s: any) =>
    `  * ${s.name}: ${s.description || ''}\n    Rules: ${(s.businessRules || []).join('; ') || 'none'}\n    Actions: ${(s.userActions || []).join('; ') || 'none'}`,
  ).join('\n');

  const caseWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
  const result = await caseWriter.generateObject<any>({
    prompt: `Write focused test cases for this specific feature: "${feature.name}".
${feature.description ? `Feature description: ${feature.description}` : ''}
This feature is part of the ${feature.surface || ''} side of the app (context only  -  never put this word in a title).
Subfeatures to cover:
${subfeatureBlock || '  (no repo-grounded subfeatures were provided; do not infer extra behavior)'}

User request context: ${run.prompt || 'not provided'}
Target URL: ${targetUrl || 'not provided'}
${credentialContext}
${applicationContextBlock}
${selectorRegistryBlock}
${blackboardBlock}
App inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}
${renderPageOutlineForPrompt((run as any).dom_exploration)}Code understanding: ${approvedUnderstanding ? approvedUnderstanding.slice(0, 3000) : 'not provided'}

Feature-scope rules:
- Generate ONE test case per subfeature (or per distinct business rule if no subfeatures).
- Each case covers ONLY "${feature.name}"  -  do not test unrelated features.
- Default to normal UI tests only. Do NOT generate API validation/API contract/backend endpoint cases unless the user explicitly asks for API testing.
- For generic/reusable UI features, use the reusable component groups discovered by CodeAnalyst. Target only controls and behaviours proven in source, live inspection, or selector registry. If metadata or permissions hide/disable a discovered control, cover that observed state; do not replace it with unrelated object/API behavior.
- Use real on-screen element labels from the inspection result and selector ids from the selector registry when available.

${SOURCE_BOUNDARY_CONTRACT}

${CASE_AUTHORING_CONTRACT}`,
    schema: testCasesSchema,
    userMessage: run.prompt || '',
  });
  return annotateGeneratedCasesWithProof(
    normalizeGeneratedCasesText(result.object.test_cases as any[], run).map((tc: any) => ({ ...tc, captureEvidence: true, _feature: feature.name })),
    run,
  );
}

/**
 * Optional learned-skill text injected into the case-writer and Playwright-coder prompts.
 * The SkillOpt loop's trainable state for the case/script/test-data agents  -  a plain-markdown
 * skill it edits and validation-gates. App-agnostic (general QA-authoring guidance, never app
 * facts). Read per-request so edits apply without a restart; empty unless the env path is set.
 */
function readAgentSkill(): string {
  const p = process.env.AGENT_SKILL_PATH;
  if (!p) return '';
  try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''; } catch { return ''; }
}

async function generateCasesForRun(
  run: any,
  liveCredentials: any,
  opts: { flowMode: 'review_cases' | 'complete'; mode: 'fresh' | 'gaps'; existingCases?: any[] },
): Promise<void> {
  const credentials = liveCredentials || run.credentials || {};
  const liveInspectionVerdict = assessInspection(run.inspection_context);
  const credentialContext = buildCredentialContext(credentials);
  const inspectionContext = run.inspection_context || null;
  const featureUnderstanding = run.feature_understanding || null;
  const featureInventory = run.feature_inventory || null;
  const prompt = run.prompt || '';
  const canFallbackToSourceOnly = !!featureUnderstanding || !!featureInventory || run.understandingSource === 'requirement';
  if (((run as any).inspection_blind || !liveInspectionVerdict.ok) && run.status !== 'cancelled') {
    if (!canFallbackToSourceOnly) {
      const why = 'Inspection saw nothing on the page and no repo-grounded understanding is available, so case generation would be guesswork.';
      const finalWhy = liveInspectionVerdict.ok ? why : `${liveInspectionVerdict.reason} ${why}`.trim();
      pushPhase(run, { agent: 'System', status: 'failed', output: finalWhy });
      markRunDone(run, 'failed');
      (run as any).cases_grounding = { ok: false, reason: why };
      await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist blind-inspection agent artifacts:', err));
      persistDataInBackground('blind-inspection blocked agent run');
      return;
    }
    pushPhase(run, {
      agent: 'System',
      status: 'completed',
      output: `Live inspection could not reach the authenticated application (${liveInspectionVerdict.reason}). Continuing with source-grounded case generation only; cases must stay inside repo-proven behavior and mark any live-only details as blocked.`,
    });
  }
  if (!featureUnderstanding && !featureInventory && run.understandingSource !== 'requirement') {
    const why = 'Case generation blocked: repo-grounded code understanding is unavailable, so fallback cannot be limited to repository facts.';
    pushPhase(run, { agent: 'TestGenerationAgent', status: 'failed', output: why });
    (run as any).cases_grounding = { ok: false, reason: why };
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist source-grounding-blocked artifacts:', err));
    persistDataInBackground('source-grounding blocked case generation');
    return;
  }
  // Resolve the ONE understanding shared by every worker (Strike 3). resolveUnderstanding
  // centralizes the former inline logic: prefer the human-approved understanding, else fall
  // back to the richest grounded answer the agent gave earlier in THIS chat (e.g. the feature
  // inventory). Without the fallback, runs started from supervisor/shortcut paths reached the
  // case writer with "understanding: not provided" and drifted to a generic feature set.
  const approvedUnderstanding = resolveUnderstanding(run);
  const targetUrl = run.app_url || '';
  const requestedCaseCount = Math.max(0, Math.floor(Number(run.requested_case_count) || 0));
  const selectedQaPromptText = run.selected_qa_prompt_text || 'No selected QA repository context was provided for this automation scope.';
  const applicationContextBlock = run.application_context_prompt
    ? `\n${String(run.application_context_prompt)}\n`
    : '';
  const selectorRegistryBlock = renderSelectorRegistryForPrompt((run as any).selector_registry);
  const blackboardBlock = renderBlackboardForPrompt(run);
  const knowledgeBlock = buildKnowledgeBlock(
    { knowledgePackId: run.application_context?.app?.knowledgePackId || undefined, websiteId: run.websiteId, targetUrl, text: `${run.scope_context_text || ''} ${prompt} ${approvedUnderstanding}`.trim(), ownerId: run.ownerId },
    { maxChars: 12000 },
  );
  const effectiveUnderstanding = featureInventory
    ? { ...(featureUnderstanding || {}), featureInventory }
    : featureUnderstanding;
  const testCaseCount = complexityDrivenCaseCount(effectiveUnderstanding, requestedCaseCount);
  const understandingBlock = featureUnderstanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the application's real code  -  treat as authoritative for business rules, roles, and edge cases):\n${summarizeUnderstanding(featureUnderstanding)}\n`
    : '';
  const featureInventoryBlock = featureInventory
    ? `\nFEATURE/SUBFEATURE COVERAGE BLUEPRINT (from the requirement-based feature inventory; use this to structure cases, not just the top-level feature summary):\n${summarizeFeatureInventory(featureInventory)}\n`
    : '';
  const candidateScenarios = Array.isArray(featureUnderstanding?.candidateScenarios) ? featureUnderstanding.candidateScenarios : [];
  const scenarioBlock = candidateScenarios.length
    ? `\nREVIEWED REQUIREMENT CANDIDATE SCENARIOS (${candidateScenarios.length}) - this is a coverage contract when no exact user count was requested:\n${scenarioCoverageBlock(candidateScenarios)}\n`
    : '';
  // The actual chat that led to this run. AUTHORITATIVE for scope  -  the cases must cover
  // what the user and agent discussed (e.g. specific objects/users/permissions), not a
  // generic template. Prevents the "cases don't match the conversation" disconnect.
  const conv = (Array.isArray((run as any).chat_history) ? (run as any).chat_history : [])
    // Drop greetings / capability blurbs / provider-error dumps so the scope signal
    // (what the user actually asked for, what the agent actually found) isn't buried.
    .filter((m: any) => m && m.content && !(m.role === 'assistant' && isNoiseTurn(m.content)))
    .slice(-12)
    // Give substantive assistant answers (e.g. a feature inventory) room to survive -
    // 800 chars truncated the very inventory the cases must cover.
    .map((m: any) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content).replace(/\s+/g, ' ').trim().slice(0, m.role === 'assistant' ? 2400 : 600)}`)
    .join('\n');
  const conversationBlock = conv
    ? `\nCONVERSATION THAT LED TO THIS RUN (authoritative for WHICH application features to cover  -  cover the features/objects/behaviors discussed here, in the TARGET APPLICATION's UI; do not substitute a generic feature set. The conversation itself is NOT a test subject: never write cases about the QA assistant, this chat, app-selection replies, prompts, or how the request was interpreted/scoped  -  those are not application behavior):\n${conv}\n`
    : '';

  // REAL TEST DATA grounding (MCP/data tools): pull the actual field schema (api_names, types,
  // required, picklist options) + a sample record for the object(s) this prompt is about, so the
  // cases use valid concrete values instead of placeholder guesses. Per-app + access-enforced;
  // best-effort  -  never blocks generation.
  let testDataBlock = (run as any).test_data_pack
    ? `\nREAL TEST DATA (from the run's application context - AUTHORITATIVE). Use these EXACT field api_names and valid values when steps create/edit a record; for picklists choose one of the listed options; to edit/delete, act on the example existing record. Do NOT invent field names or placeholder values:\n${(run as any).test_data_pack}\n`
    : '';
  try {
    const activeApp = run.appId ? getApp(run.appId) : undefined;
    let apiBase = activeApp?.baseUrl || '';
    if (!apiBase && targetUrl) { try { apiBase = new URL(targetUrl).origin; } catch { /* ignore */ } }
    if (apiBase) {
      // Hints include the live inspection context, so even prompts that say "a record" without
      // naming the object still resolve to the object the inspector actually landed on (e.g. the
      // Accounts list), and the pack is built for it.
      const inspectionHint = (() => { try { return JSON.stringify(compactInspectionContext(inspectionContext) || ''); } catch { return ''; } })();
      // Explicit object hints from the source-grounded understanding (authoritative even when the
      // inspected screen is generic, e.g. the Recycle Bin), so delete/restore-type runs still
      // resolve the real object instead of falling back blindly.
      const objectHints = (() => {
        const refs = (featureUnderstanding as any)?.metadataRefs;
        if (!Array.isArray(refs)) return [] as string[];
        return refs.map((r: any) => String(r?.object || r?.api_name || r || '')).filter(Boolean);
      })();
      const pack = await fetchTestDataPack(
        { baseUrl: apiBase, specPath: activeApp?.specPath, username: credentials.username, password: credentials.password },
        `${prompt} ${approvedUnderstanding} ${summarizeUnderstanding(featureUnderstanding || {})} ${inspectionHint}`,
        objectHints,
      );
      if (pack) {
        testDataBlock = `\nREAL TEST DATA (from the live app metadata  -  AUTHORITATIVE). Use these EXACT field api_names and valid values when steps create/edit a record; for picklists choose one of the listed options; to edit/delete, act on the example existing record. Do NOT invent field names or placeholder values:\n${pack}\n`;
        (run as any).test_data_pack = pack; // shared with the coder so generated code uses the same real values
      }
    }
  } catch { /* fall back to no test-data grounding */ }

  pushPhase(run, { agent: 'TestGenerationAgent', status: 'running' });

  let generated: any[];
  if (opts.mode === 'gaps' && Array.isArray(opts.existingCases) && opts.existingCases.length) {
    // Keep the reused cases; ask the model for ONLY the gaps the code reveals they miss.
    const existingForReconcile = opts.existingCases.map((c: any) => ({
      id: c.existingCaseId || c.id || c.title,
      title: c.title,
      tags: c.tags || [],
      type: c.type,
      priority: c.priority,
      stepCount: (c.steps || []).length,
    }));
    const gaps = await proposeGapCases(featureUnderstanding, existingForReconcile);
    const gapCases = (gaps || []).map((g: any) => ({
      title: g.title,
      description: g.rationale || '',
      priority: g.priority || 'Medium',
      type: g.type || 'Automated',
      tags: normalizeCaseTags(g.tags || []),
      steps: normalizeCaseSteps(g.steps || []),
      captureEvidence: true,
    }));
    generated = [...opts.existingCases, ...gapCases];
  } else {
    const caseWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
    const objectCoverageBlock = buildObjectCoverageBlock(run, prompt || '', approvedUnderstanding || '');
    const caseResult = await caseWriter.generateObject<any>({
      prompt: `User prompt: ${prompt || 'not provided'}.
Approved user-reviewed understanding: ${approvedUnderstanding || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${credentialContext}
${applicationContextBlock}
${selectorRegistryBlock}
${blackboardBlock}
${selectedQaPromptText}${conversationBlock}
Browser inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}${understandingBlock}
${featureInventoryBlock}${scenarioBlock}${testDataBlock}${objectCoverageBlock}${readAgentSkill() ? `\nLEARNED QA-AUTHORING SKILL (general case/script guidance refined over prior runs  -  apply it):\n${readAgentSkill()}\n` : ''}
${requestedCaseCount > 0
  ? `Produce EXACTLY ${requestedCaseCount} test case(s)  -  no more and no fewer. The user FIXED this count, so make every case COUNT: cover the MOST IMPORTANT ones for this feature / scenario / business logic / flow FIRST  -  the critical primary user flows, the core business rules, the highest-risk and most-used behavior, and the key negative / permission / edge cases that matter most. ORDER the cases from most important to least so the ${requestedCaseCount} you return are genuinely the highest-value tests (the set is kept in order). Skip trivial or duplicate checks; do not exceed the count or pad to reach it.`
  : `Write approximately ${testCaseCount} test case(s)  -  this target is derived from the feature's real complexity in the source above, so treat it as a guide: cover every distinct business rule, role/permission difference, branch, and negative/edge case the code reveals, and do not pad with trivial duplicates to hit a number. The user asked for comprehensive coverage, so err toward thoroughness over brevity.`}

When REVIEWED REQUIREMENT CANDIDATE SCENARIOS are present and no exact user count was requested:
- Generate at least one test case for every listed candidate scenario.
- Keep the scenario title or its key behavior visible in the case title or description so coverage can be audited.
- Default to normal UI tests only. Do NOT generate API validation/API contract/backend endpoint cases unless the user explicitly asks for API testing. Do not collapse positive, negative, permission, admin adapter, and specialized-list-view scenarios into one broad case.

If the Approved user-reviewed understanding contains numbered coverage sections, treat those sections as the coverage contract:
- Generate at least one case for each numbered section unless it is explicitly unproven/skipped/blocked.
- Preserve the section's concrete labels, controls, warnings, counts, and risks in steps/expected results instead of replacing them with generic checks.
- Do not duplicate the same section under two titles; merge overlapping coverage into one stronger case.
- Unproven/skipped items must be marked blocked/manual in the case text, not converted into automated positive cases.

When the FEATURE/SUBFEATURE COVERAGE BLUEPRINT is present, it is the case-coverage contract:
- Generate one focused test case for each testable subfeature unless the user explicitly requested fewer cases; if fewer were requested, choose the highest-risk subfeatures first and state the omitted units in the descriptions/tags.
- Generate separate @e2e test cases for the E2E flows listed in the feature inventory. Do not merge E2E flows into single-feature cases.
- For generic/reusable UI requests across apps/objects, target the shared component groups discovered by CodeAnalyst. Cover only source-proven or inspection-proven controls/behaviours. If metadata or permissions hide/disable a discovered control, cover that observed state; do not replace it with unrelated object/API behavior.
- Each feature case's steps must stay inside that feature/subfeature and test its concrete actions, rules, states, and edge paths.
- Do not collapse multiple unrelated subfeatures into a broad "validate page" case.
- Default to normal UI tests only. Do NOT generate API validation/API contract/backend endpoint cases unless the user explicitly asks for API testing.

Use the inspection result as the source of truth for reachable pages, visible navigation, forms, tables, list-like regions, and assertion targets. Do not invent unrelated admin pages or menu names. If live inspection is partial or missing a detail, fall back ONLY to the SOURCE-GROUNDED UNDERSTANDING / FEATURE BLUEPRINT / application repo context above; if the repo-grounded context also does not prove the detail, mark that detail as blocked in the case preconditions instead of guessing. If the inspector reached the requested goal, at least one @bvt test case must cover that exact inspected end-to-end path  -  but that case must be about the FEATURE at the end of the path (e.g. the list view, the form, the record), never about login/authentication itself. If the inspector was partial or blocked, generate cases only for the reachable or repo-proven context and include clear preconditions/steps that show what needs to be verified next.

When the request involves verifying data views, include steps that verify the visible table/list/grid container, headers, rows or empty-state, and absence of loading/error state using the labels found by inspection.

For metadata/list rows with columns such as Label, API Name, Version, App Prefix, and Parent App, use the Label column as the human-facing row/search value. Never combine Label with API Name or App Prefix (for example, use "Revenue Hub", not "Revenue Hubrev").

${SOURCE_BOUNDARY_CONTRACT}

${CASE_AUTHORING_CONTRACT}${knowledgeBlock}`,
      schema: testCasesSchema,
      userMessage: prompt || '',
    });
    generated = (caseResult.object.test_cases as any[]).map((testCase) => ({ ...testCase, captureEvidence: true }));
  }

  // FIXED COUNT (user wish): when the user fixed a case count, enforce it EXACTLY  -  the model can
  // over-produce. If it produced more, keep the first N (the prompt ordered them highest-value
  // first). When no count is fixed, the count follows the flow/complexity (untouched here).
  generated = (Array.isArray(generated) ? generated : []).filter((testCase) => !isInvalidGeneratedCase(testCase));

  // COUNT FLOOR (pad-up): when the user FIXED a count, enforce it exactly; in AUTO mode the
  // complexity-derived target is now a MINIMUM too — previously auto mode accepted whatever a
  // single pass returned, so a lazy/truncated 1-case reply shipped as-is ("same prompt sometimes
  // generates one case"). The loop still stops early when the model can only produce duplicates,
  // so a genuinely thin feature yields fewer cases rather than fabricated filler.
  const caseCountFloor = requestedCaseCount > 0 ? requestedCaseCount : testCaseCount;
  if (generated.length < caseCountFloor) {
    if (requestedCaseCount === 0) {
      console.warn(`[agent] run ${run.id}: auto mode produced ${generated.length}/${caseCountFloor} cases — padding up to the complexity floor.`);
    }
    const padWriter = await getOrchestrator('caseWriter', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
    const norm = (t: any) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = new Set(generated.map((c: any) => norm(c.title || c.name)));
    const maxBatches = Math.min(20, Math.ceil((caseCountFloor - generated.length) / 5) + 5);
    for (let b = 0; b < maxBatches && generated.length < caseCountFloor; b += 1) {
      const remaining = caseCountFloor - generated.length;
      const existingTitles = [...seen].slice(0, 200).map((t) => `- ${t}`).join('\n');
      let more: any[] = [];
      try {
        const res = await padWriter.generateObject<any>({
          prompt: `User prompt: ${prompt || 'not provided'}.
Approved user-reviewed understanding: ${approvedUnderstanding || 'not provided'}.
Playwright target URL: ${targetUrl || 'not provided'}.
${applicationContextBlock}${selectorRegistryBlock}${understandingBlock}${featureInventoryBlock}${scenarioBlock}
Browser inspection result: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}
CONTINUATION: ${generated.length} test case(s) already exist for this scope (their titles are listed below). Produce ${remaining} MORE, DISTINCT, high-value test case(s) that do NOT duplicate any existing title — continue the coverage with the next most valuable behaviors the code/inspection reveal (further business rules, role/permission differences, negative/edge/error paths, and E2E flows). Stay grounded in the inspection/understanding above; never invent unrelated pages or controls. If genuinely no further distinct, grounded cases exist, return fewer rather than padding with trivial duplicates.
EXISTING TITLES (do NOT repeat any of these):
${existingTitles}
${SOURCE_BOUNDARY_CONTRACT}
${CASE_AUTHORING_CONTRACT}`,
          schema: testCasesSchema,
          userMessage: prompt || '',
        });
        more = ((res.object?.test_cases as any[]) || []).map((tc) => ({ ...tc, captureEvidence: true }));
      } catch { more = []; }
      let added = 0;
      for (const tc of more) {
        if (isInvalidGeneratedCase(tc)) continue;
        const key = norm(tc.title || tc.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        generated.push(tc);
        added += 1;
        if (generated.length >= requestedCaseCount) break;
      }
      if (added === 0) break; // model produced only duplicates/nothing — stop (no infinite loop)
    }
  }

  if (requestedCaseCount > 0 && generated.length > requestedCaseCount) {
    generated = generated.slice(0, requestedCaseCount);
  }
  generated = ensureScenarioCoverage(generated, candidateScenarios, requestedCaseCount);
  generated = (Array.isArray(generated) ? generated : []).filter((testCase) => !isInvalidGeneratedCase(testCase));
  if (requestedCaseCount > 0 && generated.length > requestedCaseCount) {
    generated = generated.slice(0, requestedCaseCount);
  }
  generated = annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(generated, run), run);
  if (requestedCaseCount > 0 && Array.isArray(generated) && generated.length > requestedCaseCount) {
    generated = generated.slice(0, requestedCaseCount);
  }
  // Stamp a stable id now, at the ONE point where array order is final. Everything downstream
  // (chat output, review UI, save-cases) must key off this id instead of re-deriving one from
  // array position later  -  position shifts the moment a case is deleted in the review UI, which
  // previously caused save-cases to overwrite the wrong row and orphan another.
  generated = generated.map((tc: any, i: number) => (
    tc.id ? tc : { ...tc, id: tc.reused && tc.existingCaseId ? tc.existingCaseId : agentCaseId(run, i) }
  ));
  run.generated_cases = generated;
  (run as any).all_generated_cases = generated;
  // GROUNDING GATE (Phase 2): verify the generated cases actually reference what the
  // inspector saw on the live page. If they don't (and the page WAS readable), the
  // cases were written from the prompt alone  -  flag it honestly so the run isn't sold
  // as grounded coverage.
  const liveGroundingVerdict = assessCasesGrounding(generated, run.inspection_context);
  const inventoryGroundingVerdict = assessCasesInventoryGrounding(generated, run.feature_inventory);
  const groundingVerdict = inventoryGroundingVerdict?.ok
    ? {
        ok: true,
        reason: `${liveGroundingVerdict.reason} Source blueprint grounding: ${inventoryGroundingVerdict.reason}`,
      }
    : liveGroundingVerdict;
  (run as any).cases_grounding = groundingVerdict;

  // SUB-FEATURE COMPLETENESS (book Ch 7/11/19): a feature must not read "tested" while some
  // of its discovered sub-features have zero cases (the silent-coverage-gap failure). We
  // check every sub-feature in the source-discovered inventory against the generated cases
  // and surface any uncovered ones. Non-blocking on purpose  -  like the grounding "weak"
  // flag, this informs the human/report rather than failing an otherwise valid run.
  try {
    const inv: any = run.feature_inventory;
    const subFeatures = (Array.isArray(inv?.features) ? inv.features : [])
      .flatMap((f: any) => (Array.isArray(f?.subfeatures) ? f.subfeatures : []))
      .map((s: any) => ({ name: String(s?.name || '').trim() }))
      .filter((s: { name: string }) => s.name);
    if (subFeatures.length) {
      const featureLabel = (Array.isArray(inv?.features) && inv.features[0]?.name)
        ? String(inv.features[0].name)
        : (String(run.prompt || 'feature').slice(0, 60));
      const completeness = assessFeatureCompleteness(featureLabel, subFeatures, generated);
      (run as any).feature_completeness = completeness;
      pushPhase(run, {
        agent: 'System',
        status: completeness.ok ? 'completed' : 'running',
        output: completeness.ok
          ? `Sub-feature coverage: ${completeness.reason}`
          : `COVERAGE GAP  -  ${completeness.reason} Consider find_untested_edges or another generation pass for the uncovered sub-features.`,
      });
    }
  } catch (err: any) {
    console.warn('feature-completeness check failed (non-fatal):', err?.message || err);
  }

  pushPhase(run, {
    agent: 'TestGenerationAgent',
    status: 'completed',
    output: { test_cases: generated, grounding: groundingVerdict.reason, grounded: groundingVerdict.ok },
  });
  // In the human-review flow the user curates cases and saves them explicitly ("Save all") —
  // do NOT auto-save authored cases to the workspace here. The automatic (no-review) flow has no
  // human gate, so it persists inline as before (terminal persistence also re-saves on completion).
  if (opts.flowMode !== 'review_cases') {
    await persistAgentCaseArtifacts(run);
  }
  await persistAgentRequirementArtifacts(run);

  // Push every generated case to the inbox as a pending decision, so the human can
  // approve / reject per-case from the inbox instead of just seeing a "review" button.
  (run.generated_cases || []).forEach((tc: any, idx: number) => {
    pushInboxItem({
      workspaceId: 'default',
      source: 'case',
      sourceId: `${run.id}:${idx}`,
      title: `Review new test case: ${tc.title || `Case ${idx + 1}`}`,
      summary: tc.description || '',
      confidence: 80,
      proposedBy: 'QA Assistant',
      payload: { runId: run.id, caseIndex: idx, case: tc },
      links: [{ label: 'Open in Test Cases', href: '/test-cases' }],
    });
  });

  if (opts.flowMode === 'review_cases') {
    run.status = 'review_required';
    (run as any).review_stage = 'cases';
    run.review_started_at = nowIso();
    pushPhase(run, { agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
    await persistAgentRunAndReportArtifacts(run);
    persistDataInBackground('review-required agent run');
    return;
  }

  // BLOCKING GROUNDING GATE: in the automatic (no-human-review) flow, ungrounded cases
  // must NOT proceed to script generation/execution as if they were valid  -  that would
  // produce "passes" against cases that don't reflect the live app. Stop here with an
  // honest non-verified verdict instead of executing scripts for ungrounded cases.
  // (review_cases flow already routes through a human, who is the gate there.)
  if (!groundingVerdict.ok && run.status !== 'cancelled') {
    pushPhase(run, {
      agent: 'System',
      status: 'failed',
      output: `Generated cases are not grounded in the live application (${groundingVerdict.reason})  -  not executing scripts for ungrounded cases.`,
    });
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist failed agent artifacts:', err));
    persistDataInBackground('ungrounded-cases blocked agent run');
    return;
  }

  await runPostCaseAgentFlow(run, undefined as any, { test_cases: generated }, targetUrl, credentials);
}

/**
 * DISCOVER-THEN-BIND per-case control resolver. Before the coder writes selectors, drive the LIVE
 * app toward EACH case's specific goal  -  the inspection planner opens menus/overflows/dialogs to
 * REVEAL the controls that case operates (e.g. it opens "List view actions" to expose "Settings").
 * Returns, per case, the access PATH the inspector took plus the CONFIRMED real control labels, so
 * the coder binds to what genuinely exists instead of guessing a hidden control's name. This is the
 * semantic-reasoning + exploration step applied at the point of binding (not just upstream/in repair).
 * Best-effort, bounded concurrency; any failure leaves that case on the shared inspection context.
 */
async function resolveControlsPerCase(
  targetUrl: string,
  cases: any[],
  credentials: any,
  runId: string,
  workspaceId: string,
): Promise<string[]> {
  const out: string[] = new Array(Array.isArray(cases) ? cases.length : 0).fill('');
  if (!targetUrl || !Array.isArray(cases) || !cases.length) return out;
  const MAX = 6; // bound the number of live resolutions per run
  const indexes = cases.map((_, i) => i).slice(0, MAX);
  const resolveOne = async (i: number) => {
    const c = cases[i];
    const steps = Array.isArray(c?.steps)
      ? c.steps.map((s: any) => (typeof s === 'string' ? s : (s?.action || s?.description || ''))).filter(Boolean).join('; ')
      : '';
    const goal = `${c?.title || `Case ${i + 1}`}.${steps ? ` Steps: ${steps}.` : ''} Reach and REVEAL the exact controls this case operates  -  open any actions / overflow / settings menu, dialog, or tab needed so the target control is visible.`;
    try {
      const ctx: any = await inspectApplicationFlow({ targetUrl, prompt: goal, credentials, runId: `${runId}-resolve-${i + 1}`, workspaceId });
      const controls = (ctx.visibleNavigation || [])
        .map((a: any) => ({
          label: String(a.ariaLabel || a.text || a.name || '').trim(),
          role: String(a.role || a.control || a.tag || '').trim(),
          selectors: Array.isArray(a.selectorHints) ? a.selectorHints.slice(0, 3) : [],
        }))
        .filter((x: any) => x.label)
        .slice(0, 30);
      if (!controls.length) return;
      const path = (ctx.actionsTaken || [])
        .filter((a: any) => a.type === 'click')
        .map((a: any) => String(a.text || a.elementId || '').trim())
        .filter(Boolean);
      const ctrls = controls.map((c2: any) => `"${c2.label}"${c2.role ? ` (${c2.role})` : ''}${c2.selectors.length ? ` selectors: ${c2.selectors.join(', ')}` : ''}`).join(' | ');
      const pathStr = path.length ? path.map((p: string) => `"${p}"`).join(' -> ') : '(already visible  -  no extra navigation needed)';
      out[i] = `\nLIVE-RESOLVED CONTROLS for case "${c?.title || `Case ${i + 1}`}" (a live exploration drove the app toward THIS case and opened any menus needed to REVEAL the controls  -  these are CONFIRMED to exist on the page right now at ${ctx.currentUrl || targetUrl}). Reproduce the access path, then operate the controls by their EXACT labels via getByRole/getByLabel  -  never invent or paraphrase a label:\n   access path to reveal the controls: ${pathStr}\n   confirmed real controls now visible: ${ctrls}\n`;
    } catch { /* leave ''  -  falls back to shared inspection context */ }
  };
  for (let s = 0; s < indexes.length; s += 3) {
    await Promise.all(indexes.slice(s, s + 3).map(resolveOne));
  }
  return out;
}

function normalizeSelectorsFromInspection(code: string, inspectionContext: any): string {
  if (!code || !inspectionContext) return code;
  const labels = new Map<string, string>();
  const add = (value: any) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    if (label.length > 1) labels.set(label.toLowerCase(), label);
  };
  for (const item of inspectionContext.visibleNavigation || []) {
    add(item?.ariaLabel || item?.text || item?.name);
    if (item?.dom?.placeholder) add(item.dom.placeholder);
    if (item?.placeholder) add(item.placeholder);
  }
  let out = code.replace(/name:\s*(['"`])([^'"`]{2,80})\1/g, (whole, q, raw) => {
    const exact = labels.get(String(raw).toLowerCase().trim());
    return exact ? `name: ${q}${exact}${q}` : whole;
  });
  out = out.replace(/getByRole\((['"`])button\1,\s*\{\s*name:\s*\/([^/]{2,80})\/i\s*\}\)/g, (whole, q, raw) => {
    const exact = labels.get(String(raw).toLowerCase().trim());
    return exact ? `getByRole(${q}button${q}, { name: ${q}${exact}${q}, exact: true })` : whole;
  });
  return out;
}

export function hasRunnableScripts(scripts: unknown): boolean {
  return Array.isArray(scripts) && scripts.length > 0;
}

async function runPostCaseAgentFlow(run: any, model: any, testCases: any, targetUrl: string, liveCredentials?: any) {
  // The run record stores a MASKED password for safe persistence/logging. The live
  // browser (login + evidence) must use the REAL resolved credentials, so prefer the
  // passed live credentials; only fall back to the (possibly masked) run copy.
  const liveCreds = liveCredentials && liveCredentials.username && liveCredentials.password
    ? liveCredentials
    : (run.credentials || {});
  pushPhase(run, { agent: 'PlaywrightAgent', status: 'running' });
  // Use the REAL (live) credentials so the generated scripts contain a working
  // login  -  run.credentials stores a MASKED password unsuitable for execution.
  const credentialContext = buildCredentialContext(liveCreds);
  const hasLoginCredentials = !!(liveCreds?.username && liveCreds?.password);
  const loginScriptBlock = hasLoginCredentials
    ? `LOGIN IS REQUIRED BEFORE TESTING AUTHENTICATED PAGES. Every generated script must define these constants near the top of the file and use them in guarded login code:
const USERNAME = ${JSON.stringify(String(liveCreds.username))};
const PASSWORD = ${JSON.stringify(String(liveCreds.password))};

Do NOT write comments such as "Auth is expected to be handled by global setup". Do NOT rely on auth.setup.ts. The script must be runnable by itself. After page.goto(...), if a login form is present, fill USERNAME into the email/username/login field, fill PASSWORD into the password field, click the sign-in/login button, and wait for the post-login page. Each login action must be guarded with a short timeout and .catch(() => {}) because an authenticated storage state may already be injected.`
    : `No login credentials were resolved for this run. Do not invent username/password values. If a login wall is present, the script should fail with a clear assertion that credentials are required.`;
  const inspectionContext = run.inspection_context || null;
  const selectedQaContextText = run.selectedQaContext
    ? `Selected QA repository context for this automation scope: ${JSON.stringify(run.selectedQaContext)}`
    : 'No selected QA repository context was provided for this automation scope.';
  const coderUnderstanding = run.feature_understanding
    ? `\nSOURCE-GROUNDED UNDERSTANDING (from the app's real code  -  use it to assert the right business rules and pick meaningful selectors, but only assert what the inspection context confirms is on screen):\n${summarizeUnderstanding(run.feature_understanding, 2500)}\n`
    : '';
  const coderFeatureInventory = run.feature_inventory
    ? `\nFEATURE/SUBFEATURE + E2E COVERAGE BLUEPRINT (keep generated scripts aligned to these reviewed case units):\n${summarizeFeatureInventory(run.feature_inventory, 5000)}\n`
    : '';
  // CRITICAL FIX (Strike 3): ground the coder on the SAME understanding the case writer
  // used. Previously this prompt printed raw run.approvedUnderstanding, so on the common
  // path where approvedUnderstanding is empty the coder saw "not provided" while the case
  // writer had the chat-derived understanding  -  the two agents diverged. resolveUnderstanding
  // applies the identical chat fallback, so coder and case writer now agree.
  const reviewedUnderstanding = resolveUnderstanding(run);
  const applicationContextBlock = run.application_context_prompt
    ? `\n${String(run.application_context_prompt)}\n`
    : '';

  const coderKnowledge = buildKnowledgeBlock({ knowledgePackId: run.application_context?.app?.knowledgePackId || undefined, targetUrl, text: run.prompt || '', ownerId: run.ownerId }, { maxChars: 9000 });
  // EPISODIC MEMORY (book Ch 8/9): recall selectors that were flaky/broken on prior runs of
  // this feature so the coder avoids them instead of re-discovering the same flakiness.
  let coderMemory = '';
  try {
    const mems = await retrieveRunMemories({
      feature: String(run.prompt || run.artifactName || '').slice(0, 80),
      projectId: run.projectId || undefined,
      appId: run.appId || undefined,
      ownerId: run.ownerId || undefined,
      limit: 25,
    });
    const block = summarizeMemoriesForPrompt(mems);
    if (block) coderMemory = `\nLESSONS FROM PRIOR RUNS (avoid the flaky/broken selectors below; prefer the stable ones):\n${block}\n`;
  } catch { /* memory is an enhancement, never a hard dependency */ }
  const tdPack = (run as any).test_data_pack || '';
  const coderTestData = tdPack
    ? `\nREAL TEST DATA (from the live app metadata  -  use these EXACT field api_names and valid values when the case creates/edits a record; for picklists use one listed option; reference the example existing record for edit/delete; do NOT use placeholder/env-var values for the data the case specifies):\n${tdPack}\n`
    : '';
  // REAL SELECTORS extracted from the app's source. These are fallback grounding when the live DOM
  // did not prove a selector directly; they are not automatically equivalent to live verification.
  const codeMap = getRunSelectorMap(run);
  const coderSelectorMap = codeMap
    ? `\nREPO / SOURCE SELECTOR HINTS (fallback grounding when live DOM proof is incomplete  -  use these EXACT labels/names; ground every getByRole name / getByLabel / getByText / getByTestId in one of these; do NOT invent a selector that is not here):\n${renderSelectorMap(codeMap)}\n`
    : '';
  const coderSelectorRegistry = renderSelectorRegistryForPrompt((run as any).selector_registry);
  const coderMcpDomFacts = renderMcpDomFactsForPrompt((run as any).mcp_dom_facts);
  const repoLabelHints = codeMap ? [
    ...(codeMap.ariaLabels || []),
    ...(codeMap.labels || []),
    ...(codeMap.placeholders || []),
    ...(codeMap.roleNames || []).map((r: any) => r.name),
    ...(codeMap.fieldIds || []).map((f: any) => f.label),
  ].filter(Boolean).slice(0, 120) : [];
  const coder = await getOrchestrator('playwrightCoder', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
  const rawCaseList = Array.isArray(testCases?.test_cases) ? testCases.test_cases : [];
  const caseList = annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(rawCaseList, run), run);
  const scriptGrounding = assessScriptGrounding(run, caseList, Boolean(codeMap));
  const scriptGroundingBlock = renderScriptGroundingBlock(scriptGrounding, caseList);
  if (!scriptGrounding.ok) {
    const why = `Script generation blocked: ${scriptGrounding.reason}`;
    pushPhase(run, { agent: 'PlaywrightAgent', status: 'failed', output: why });
    (run as any).execution_result = { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, error: why, tests: [] };
    await persistAgentScripts(run);
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist script-grounding-blocked agent artifacts:', err));
    persistDataInBackground('script-grounding blocked script generation');
    return;
  }
  run.generated_cases = caseList;
  pushPhase(run, {
    agent: 'PlaywrightAgent',
    status: 'running',
    output: `Script grounding mode: ${scriptGrounding.mode}. ${scriptGrounding.reason}`,
  });

  // ===== Evidence-Graph Phase 5: deterministic compiler path (flag-gated) =====
  // When AIQA_COMPILER=1, the LLM authors an abstract Test Plan (targets from the verified Evidence-Graph
  // catalog only) and the deterministic PlaywrightCompiler emits the code. No selectors/URLs/login are
  // authored by the model; ungrounded targets become diagnostics, never guessed scripts. Legacy path (below)
  // is untouched and remains the default when the flag is unset.
  if (aiqaCompilerEnabled()) {
    const mission = (run as any).mission_context || missionContextFromRun(run);
    const catalog = renderTargetCatalogForPrompt((run as any).evidence_graph);
    const compiled = await generateCompiledScripts({
      run, mission, testCases: caseList,
      generatePlan: async ({ testCase, evidenceGraph }) => {
        const deterministic = semanticPlanFromCase(testCase, evidenceGraph, mission);
        if (deterministic) return deterministic;
        try {
          const r = await coder.generateObject<any>({
            prompt: `Author an ABSTRACT TEST PLAN as JSON — NOT Playwright code. Reference ONLY target names from the catalog below; emit NO selectors, URLs, roles, aria, css, xpath, waits, login, or navigation.\n${renderMissionContextForPrompt(mission)}\n${catalog}\nReviewed test case:\nTitle: ${testCase?.title || ''}\nDescription: ${testCase?.description || ''}\nSteps:\n${(Array.isArray(testCase?.steps) ? testCase.steps : []).map((s: any) => `- ${s?.action} => ${s?.expected}`).join('\n')}\nReturn JSON {mission, module, title, steps:[{action|assert, target, value?}]}. Every locator-bearing "target" (CLICK/FILL/asserts) MUST be a catalog name verbatim. OPEN_MODULE is mission-scoped navigation — the runner re-enters the mission surface, so its target is advisory and needs no catalog match. Use VISIBLE / VERIFY_* asserts for expectations; OPEN_MODULE/CLICK/FILL for interactions.`,
            schema: testPlanSchema,
            userMessage: `Author the test plan for: ${testCase?.title || 'case'}`,
          });
          const plan = parseTestPlan(r.object);
          if (!plan) console.warn('[compiler] planner returned unparseable output for case:', testCase?.title, '| raw:', JSON.stringify(r.object).slice(0, 400));
          return plan;
        } catch (e: any) {
          console.warn('[compiler] plan authoring failed for case:', testCase?.title, '|', e?.message || e);
          return null;
        }
      },
    });
    run.playwright_scripts = compiled.scripts;
    (run as any).compiler_diagnostics = compiled.diagnostics;
    (run as any).coverage_plan = compiled.coverage;
    const automatedCaseCount = caseList.filter((testCase: any) => String(testCase?.type || '').toLowerCase() !== 'manual').length;
    const canRunEvidence = hasRunnableScripts(compiled.scripts);
    pushPhase(run, {
      agent: 'PlaywrightCompiler',
      status: canRunEvidence ? 'completed' : 'failed',
      output: { compiled: compiled.scripts.length, skipped: Math.max(0, automatedCaseCount - compiled.scripts.length), diagnostics: compiled.diagnostics.length, coverage: compiled.coverage.length },
    });
    await persistAgentScripts(run);
    if (!canRunEvidence) {
      (run as any).execution_result = { ok: false, total: 0, passed: 0, failed: 0, skipped: automatedCaseCount - compiled.scripts.length, error: 'Compiler did not produce a grounded script for every automated case (see compiler_diagnostics).', tests: [] };
      markRunDone(run, 'failed');
      await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist compiler-incomplete agent artifacts:', err));
      persistDataInBackground('compiler produced incomplete script suite');
      return;
    }
    await completeScriptProofFlow(run, targetUrl, { test_cases: caseList }, liveCreds);
    return;
  }
  if (targetUrl && caseList.length && caseList.every((tc: any) => canLiveAuthorGoal([
    tc?.title || '',
    tc?.description || '',
    normalizeCaseSteps(tc?.steps || []).map((s: any) => `${s.action || ''} ${s.expected || ''}`).join(' '),
  ].join(' ')))) {
    pushPhase(run, { agent: 'LiveAuthor', status: 'running', output: 'Driving the live app first so scripts are recorded from verified selectors instead of guessed.' });
    const authoredScripts: any[] = [];
    const authoredNotes: string[] = [];
    const authoredEvidence: any[] = [];
    const safeFileName = (value: string) => String(value || 'test-case').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'test-case';
    for (let i = 0; i < caseList.length; i += 1) {
      const tc = caseList[i] || {};
      const steps = normalizeCaseSteps(tc.steps || []);
      const goal = [
        tc.title || `Test case ${i + 1}`,
        tc.description || '',
        steps.length ? `Steps: ${steps.map((s: any, n: number) => `${n + 1}. ${s.action}${s.expected ? ` => ${s.expected}` : ''}`).join(' ')}` : '',
      ].filter(Boolean).join('. ');
      const authored = await liveAuthor({
        goal,
        url: targetUrl,
        credentials: liveCreds,
        testData: tdPack,
        repoLabels: repoLabelHints,
        workspaceId: run.ownerId || 'default',
        maxSteps: 14,
      }).catch((err: any) => ({ steps: [], evidence: [], goalReached: false, notes: [`${err?.message || err}`] }));
      authoredEvidence.push(...((authored.evidence || []).map((ev: any) => ({ ...ev, caseIndex: i, caseTitle: tc.title || `Test case ${i + 1}` }))));
      if (authored.goalReached && authored.evidence?.length) {
        tc.evidenceSource = 'live-author';
        tc.confidence = 'verified';
        tc.proofIds = authored.evidence.map((ev: any) => ev.id);
      }
      authoredNotes.push(`case ${i + 1}: ${authored.goalReached ? 'reached' : 'partial'}; ${authored.steps.length} step(s); ${(authored.notes || []).join('; ')}`.slice(0, 500));
      if (!authored.goalReached || !authored.steps.length) break;
      authoredScripts.push({
        test_case_title: tc.title || `Test case ${i + 1}`,
        filename: `${safeFileName(tc.title || `test-case-${i + 1}`)}.spec.ts`,
        code: emitScript(tc.title || `Test case ${i + 1}`, { url: targetUrl, credentials: liveCreds }, authored.steps),
      });
    }
    if (authoredScripts.length === caseList.length) {
      run.playwright_scripts = authoredScripts;
      (run as any).live_author_evidence = authoredEvidence;
      pushPhase(run, { agent: 'LiveAuthor', status: 'completed', output: authoredNotes });
      pushPhase(run, { agent: 'PlaywrightAgent', status: 'completed', output: { scripts: run.playwright_scripts, source: 'live-author' } });
      await completeScriptProofFlow(run, targetUrl, { test_cases: caseList }, liveCreds);
      return;
    }
    (run as any).live_author_evidence = authoredEvidence;
    pushPhase(run, {
      agent: 'LiveAuthor',
      status: 'completed',
      output: `Live recording proved ${authoredScripts.length}/${caseList.length} case(s); continuing with source-grounded script generation for the rest. ${authoredNotes.join(' | ')}`.slice(0, 1800),
    });
  } else if (targetUrl && caseList.length) {
    pushPhase(run, {
      agent: 'LiveAuthor',
      status: 'skipped',
      output: 'Skipped live recording because at least one case requires external setup or failure simulation; using source-grounded script generation instead.',
    });
  }
  // DISCOVER-THEN-BIND: resolve each case's real controls + access flow on the LIVE app BEFORE the
  // coder writes selectors, so it binds to confirmed controls (incl. ones hidden behind menus)
  // instead of guessing. Best-effort; on failure a case just uses the shared inspection context.
  let perCaseControlBlocks: string[] = [];
  if (targetUrl) {
    pushPhase(run, { agent: 'ControlResolver', status: 'running' });
    try {
      perCaseControlBlocks = await resolveControlsPerCase(targetUrl, caseList, liveCreds, run.id, run.ownerId || 'default');
      const n = perCaseControlBlocks.filter(Boolean).length;
      pushPhase(run, { agent: 'ControlResolver', status: n ? 'completed' : 'skipped', output: n ? `Discover-then-bind: resolved live controls + access path for ${n}/${caseList.length} case(s) before coding.` : 'No live controls resolved; using the shared inspection context.' });
    } catch (e: any) {
      pushPhase(run, { agent: 'ControlResolver', status: 'skipped', output: `Control resolution skipped: ${e?.message || e}` });
    }
  }
  const allCaseControls = perCaseControlBlocks.filter(Boolean).join('');
  // FEATURE GROUNDING: pull the real controls/labels/access-flows for the feature(s) the prompt
  // is about (objects, permissions, sharing, tabs, flows, users, list view, cross-app propagation)
  // from the app-knowledge modules, so the coder binds to real labels instead of guessing.
  const featureGrounding = getFeatureGrounding({ prompt: `${run.prompt || ''} ${reviewedUnderstanding || ''}` });
  const coderBlackboard = renderBlackboardForPrompt(run, 140);
  // The batch call generates ALL scripts in one shot. For 5-6 cases that single response can
  // exceed a provider's per-call timeout (e.g. the account/CLI runner's cap). If it throws,
  // do NOT fail the whole run  -  fall through with an empty batch so the per-case path below
  // (alignScriptsToCases) regenerates each script in its own small call, well under any single
  // call timeout. App-agnostic resilience; no prompt/behavior change to the scripts themselves.
  let scriptsResult: { object: any };
  if (caseList.length > 1) {
    (run as any).script_queue = { status: 'running', total: caseList.length, generated: 0, verified: 0, evidenced: 0, items: caseList.map((c: any, i: number) => ({ index: i, title: c?.title || ('Case ' + (i + 1)), status: 'pending' })) };
    pushPhase(run, { agent: 'ScriptQueue', status: 'running', output: 'Queueing ' + caseList.length + ' script(s): generate one script per case instead of waiting for one large batch.' });
    persistDataInBackground('script queue started');
    scriptsResult = { object: { scripts: [] } };
  } else try {
    scriptsResult = await coder.generateObject<any>({
    prompt: `Use this baseURL in the scripts when provided: ${targetUrl || 'not provided'}.
${renderMissionContextForPrompt((run as any).mission_context || missionContextFromRun(run))}
Approved user-reviewed understanding: ${reviewedUnderstanding || 'not provided'}.
${credentialContext}
${loginScriptBlock}
${applicationContextBlock}
${selectedQaContextText}${coderUnderstanding}${coderFeatureInventory}${coderMemory}${coderTestData}${scriptGroundingBlock}${coderMcpDomFacts}${coderSelectorMap}${coderSelectorRegistry}${coderBlackboard}${featureGrounding}${readAgentSkill() ? `\nLEARNED QA-AUTHORING SKILL (general script guidance refined over prior runs  -  apply it):\n${readAgentSkill()}\n` : ''}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}${renderVerifiedElementsForPrompt((run as any).dom_exploration)}${allCaseControls}
SETUP  -  NAVIGATE THEN LOG IN IF NEEDED: the MANDATORY FIRST LINES of every test body are (use this EXACT absolute URL  -  NOT '/', which resolves to the wrong path):
  await page.goto('${targetUrl || '/'}');
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1500);
Then handle login with a ROBUST, DYNAMIC-WAIT helper (a session may already be injected, so it must be a safe no-op when no login form is present, but when a login form IS present it must ACTUALLY log in and WAIT until the app has loaded  -  not fail fast). Define and call this exact helper shape:
  async function loginIfNeeded() {
    const pw = page.locator('input[type="password"]');
    // Dynamic wait: only treat this as a login page if the password field APPEARS within a real window.
    const onLogin = await pw.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!onLogin) return; // already authenticated (session injected)  -  nothing to do
    await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i], input[id*="email" i], #username').first().fill(USERNAME, { timeout: 8000 });
    await pw.first().fill(PASSWORD, { timeout: 8000 });
    await page.getByRole('button', { name: /sign ?in|log ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => { await pw.first().press('Enter'); });
    // DYNAMIC WAIT until login actually completes: block until the password field is GONE (app rendered).
    await page.locator('input[type="password"]').first().waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  }
Call await loginIfNeeded(); right after the goto/settle. Use the REAL login field/button selectors from the inspection context when they differ (the verifier corrects them). Do NOT assert anything about the login form.
WAIT FOR ASYNC CONTENT BEFORE ASSERTING (dynamic, never fixed sleeps): list/grid screens render a "Loading.../Loading records..." placeholder and only mount the real <table> and its toolbar once rows arrive  -  so after login, before any assertion that depends on grid/table/toolbar content, WAIT for the actual content to appear and, if a REAL loading indicator was observed, wait for that loading indicator to disappear. Use guarded dynamic waits only for loading/busy signals, e.g.: await page.getByText(/loading|please wait|fetching/i).first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {}); then await page.locator('table tbody tr, [role="row"], [role="gridcell"]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {}); NEVER wait for a normal persistent control/label to become hidden (examples: Refresh list view, Search results, Unpin list view, Tabs, Accounts, Created At) because those are target UI, not loading indicators. Only after the target content is READY do you proceed to the substantive task. NEVER use waitForLoadState('networkidle'). NEVER call APIs with undefined variables. Never leave USERNAME or PASSWORD undefined. Never use a relative URL when an absolute target URL is provided  -  verify only through the page UI.
GUARDED ACTIONS: every SETUP / navigation / intermediate click or fill whose exact selector is uncertain MUST be guarded so a missing element does not hang or abort the run. Prefer getByRole/getByText using the EXACT visible labels from the inspection context. After a guarded action, take the step screenshot regardless of whether it succeeded. EXCEPTION: the case's PRIMARY GOAL action and its outcome assertion are NEVER guarded  -  see the ACTION COMPLETION CONTRACT below.
GROUNDING (no hallucination): only assert text, labels, headings, buttons, or table/list content that ACTUALLY appears in the inspection context above. NEVER assert "assumed" UI  -  no guessed success toasts (e.g. "created successfully"), menu names, or headings you did not see in the inspection context. If unsure an element exists, do not assert it; prefer asserting a URL change or a landmark the inspector recorded. NEVER make contradictory assertions about the same locator in one script (for example, asserting it is visible and later asserting its count is zero) unless a real intervening action is expected to remove it. SELECTOR PRIORITY (choose the HIGHEST that actually resolves in the inspection context, never a lower one when a higher exists): 1) getByTestId (data-testid), 2) getByRole(role, { name }) with the accessible name, 3) getByLabel, 4) getByPlaceholder, 5) a stable #id via page.locator('#id'), 6) exact visible text via getByText, 7) a scoped attribute/CSS selector only as a last resort. NEVER use XPath, nth-child/positional chains, or generated/utility (e.g. Tailwind) class names. SCRIPT QUALITY (web-first, auto-waiting): assert with await expect(locator).toBeVisible()/toHaveText()/toHaveValue()/toBeEnabled()/toHaveURL(); do NOT use waitForTimeout or fixed sleeps to wait for elements or content (the only allowed fixed wait is the short post-navigation settle in SETUP); scope locators to the relevant region and store reused ones in named consts. ICON / TOOLBAR / HEADER CONTROLS: these expose their name via aria-label or title with NO visible text  -  locate them with getByRole(role, { name }) or getByLabel using the EXACT aria-label from the REAL SELECTORS / inspection context; NEVER use getByText(...) for a button or icon control (it matches visible text, which icon buttons lack, so it can never resolve). GENERIC WORDS ARE NOT SELECTORS  -  "More", "...", "Options", "Actions", "resize", "settings" are almost never the real accessible name (often only a hidden responsive label); an overflow/actions menu's real label is the feature it controls (e.g. "List view actions") and column auto-resize is typically "Fit columns"  -  take the EXACT aria-label from the inspection/map and use getByRole/getByLabel, and to reach an item inside an actions menu (e.g. Settings) click the actions button first then the item by its exact text. DISAMBIGUATE REPEATED TEXT: when a record name / cell value can appear on multiple rows, scope to one row (page.locator('tr', { hasText }) ) or add .first() so the locator is not strict-mode-ambiguous. SECTION NAVIGATION (avoid drift): to open an Admin section, navigate DIRECTLY by URL  -  preserve the appId already in the URL and set nav to the section's nav key from FEATURE GROUNDING, e.g. { const u = new URL(page.url()); u.searchParams.set('nav', 'objects'); await page.goto(u.toString()); await page.waitForTimeout(1200); }. Do NOT click the left sidebar to navigate (a sidebar click can land on the WRONG section). Use the EXACT navKey (objects, tabs, users, permissions, access_controls, sharing_settings, flows). STABLE IDS: when FEATURE GROUNDING gives a control's stable #id (e.g. #create-object-label, #field-type), locate it with page.locator('#<id>')  -  never guess its placeholder or text. TRANSIENT / HOVER-ONLY ELEMENTS: never assert .toBeVisible() on a tooltip, popover, or hover hint (it is hidden until hovered, so the assert will flake-fail)  -  instead trigger it explicitly (await locator.hover()) before asserting, OR assert the durable state it reflects (e.g. a disabled action button, or a persistent "N selected" counter) rather than the floating hint itself. CONTROL NOT IN CONTEXT: if a control the case needs is NOT present in the inspection context, do NOT fall back to a selector you "remember" or guessed earlier  -  reach it through the UI the inspector DID record (open the toolbar/overflow/actions menu that would contain it), then operate the now-visible control; if it genuinely cannot be reached, assert the closest grounded landmark instead of inventing a locator. When asserting a URL, match only a STABLE fragment with a loose regex (e.g. expect(page).toHaveURL(/nav=apps/) or expect(page.url()).toContain('nav=apps'))  -  NEVER assert the full URL or a pattern that includes query separators (?, &) or generated ids (appId, record ids) which vary every run.
RESILIENCE (the user's intent MUST actually be performed): use await expect.soft(...) for every intermediate per-step verification so a single mismatched locator does NOT abort the test before the user's real goal (e.g. creating the record) is carried out. Always run each ACTION step (goto/fill/click/submit) regardless of whether a prior soft assertion failed. Then follow the user-requested path discovered by the inspector; do not invent unrelated pages or menu names.
ACTION COMPLETION CONTRACT (CRITICAL  -  the test must DO the thing, not just look at it): identify the case's PRIMARY GOAL action from its title/steps, actually PERFORM it, then make exactly ONE hard expect verify its real OUTCOME. Discover every selector from the inspection context / source  -  NEVER hardcode element names; the patterns below show only the Playwright technique per outcome type, not which element to use.
- Asserting that a control/page is visible (toBeVisible) is NOT performing the action and is NEVER an acceptable primary assertion. Operate the control and verify what it PRODUCED.
- The primary goal action AND its outcome assertion must NOT be wrapped in .catch(() => {}). If the real selector is uncertain, still attempt it UN-guarded so a miss FAILS the test  -  the execution-repair step then fixes the selector against the live DOM. (Guarding the goal makes the test pass without doing the work, which is forbidden.)
- Pick the assertion by the action's OUTCOME TYPE:
  - the action produces a FILE DOWNLOAD -> const [ d ] = await Promise.all([ page.waitForEvent('download', { timeout: 15000 }), <the discovered trigger>.click() ]); expect(d.suggestedFilename()).toBeTruthy();  (if it instead produces an in-app success result, assert that concrete result element).
  - the action CHANGES A CONTROL'S STATE (checkbox/switch/select) -> perform the real .check()/.uncheck()/.setChecked()/selectOption on the discovered control, persist it, then re-query and assert the NEW state held (after refresh if it persists server-side).
  - the action CREATES / EDITS / DELETES data -> assert the row or value actually appeared / changed / was removed in the list  -  not a toast you did not see.
STRICT OUTPUT CONTRACT: return JSON exactly like {"scripts":[{"test_case_title":"...","filename":"kebab-case.spec.ts","code":"import { test, expect } from '@playwright/test';\n..."}]}. Produce EXACTLY ONE script object per test case below, in the SAME order, so the count of scripts equals the count of test cases. Every object MUST include non-empty string fields "test_case_title", "filename", and "code"; never return empty objects. For each script, set "test_case_title" to that case's title VERBATIM, and name the Playwright test identically: test('<exact case title>', async ({ page }, testInfo) => { ... }). One file = one test() = one case; do not merge multiple cases into one script and do not split a case across scripts. Each script's actions must mirror that case's ordered steps.
EVIDENCE: do NOT attach screenshots after every step by default. The runner captures viewport screenshots and traces on failure. Include testInfo in the signature only if the specific case explicitly asks for step-by-step evidence.
Test cases: ${JSON.stringify(testCases)}${coderKnowledge}`,
    schema: playwrightScriptsSchema,
    userMessage: 'Generate Playwright scripts for the inspected flow.',
    });
  } catch (batchErr: any) {
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'running',
      output: `Batch script generation did not complete (${getAIErrorMessage(batchErr)}); generating scripts one case at a time.`,
    });
    scriptsResult = { object: { scripts: [] } };
  }
  const scripts = scriptsResult.object;
  // Normalize EACH generated script so a truncated/unterminated file (LLM dropping the
  // trailing `});` of test(...)) does not get persisted or break execution. We repair
  // parse errors up front; the executor quarantines anything still unrecoverable so one
  // bad file never zeroes out the whole batch.
  const initialScripts = Array.isArray(scripts.scripts) ? scripts.scripts as any[] : [];
  if (initialScripts.length) {
    for (const s of initialScripts) {
      if (s && typeof s.code === 'string') {
        const cleaned = sanitizeTestCode(s.code);
        s.code = repairTestCode(cleaned) || cleaned;
      }
    }
  }
  if (caseList.length && initialScripts.length !== caseList.length) {
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'running',
      output: `Playwright coder returned ${initialScripts.length}/${caseList.length} script(s); generating missing scripts one case at a time.`,
    });
  }
  const aligned = await alignScriptsToCases(initialScripts, caseList, async (testCase, index) => {
    try {
      const one = await coder.generateObject<any>({
        prompt: `Generate exactly ONE Playwright TypeScript script for exactly ONE reviewed test case.

Use this baseURL in the script when provided: ${targetUrl || 'not provided'}.
${renderMissionContextForPrompt((run as any).mission_context || missionContextFromRun(run))}
Approved user-reviewed understanding: ${reviewedUnderstanding || 'not provided'}.
${credentialContext}
${loginScriptBlock}
${applicationContextBlock}
${selectedQaContextText}${coderUnderstanding}${scriptGroundingBlock}${coderMcpDomFacts}${coderSelectorMap}${coderSelectorRegistry}${coderBlackboard}${featureGrounding}
Use this browser inspection context as the source of truth for reachable pages, visible labels, forms, navigation actions, tables/lists, buttons, links and final URL: ${JSON.stringify(compactInspectionContext(inspectionContext))}.
${renderPageOutlineForPrompt((run as any).dom_exploration)}${renderVerifiedElementsForPrompt((run as any).dom_exploration)}${perCaseControlBlocks[index] || ''}

Rules:
- SELECTOR PRIORITY: use the highest-priority selector that actually resolves in the inspection context. NEVER use XPath, nth-child/positional chains, or generated/utility (e.g. Tailwind) class names  -  they break on any re-render.
- SCRIPT QUALITY (web-first, auto-waiting): assert with await expect(locator).toBeVisible()/toHaveText()/toHaveValue()/toBeEnabled()/toHaveURL()  -  these auto-wait. Do NOT use waitForTimeout or fixed sleeps to wait for elements or content (the only allowed fixed wait is the short post-navigation settle in SETUP). Scope locators to the relevant region (e.g. page.getByRole('table').getByRole('row').filter({ hasText })) and store reused locators in named consts so the test reads clearly.
- ICON / TOOLBAR / HEADER CONTROLS expose their name via aria-label or title with NO visible text  -  locate them with getByRole(role, { name }) or getByLabel using the EXACT aria-label from the REAL SELECTORS / inspection context above. NEVER use getByText(...) for a button or icon control (it matches visible text, which icon buttons do not have, so it will never resolve).
- GENERIC WORDS ARE NOT SELECTORS: "More", "...", "Options", "Actions", "resize", "settings" are almost never the real accessible name (they often exist only as a hidden responsive label). An overflow / actions menu's real label is the feature it controls (e.g. "List view actions"); column auto-resize ("fit columns" / "resize columns") is typically labeled "Fit columns". For ANY such control, take the EXACT aria-label from the inspection/map and use getByRole/getByLabel  -  never the generic word. To operate an item inside an actions menu (e.g. Settings), click the actions button (e.g. "List view actions") FIRST, then click the item by its exact text.
- DISAMBIGUATE REPEATED TEXT: when a label/cell text can appear on multiple rows or cells (record names, column values), scope to a single row (e.g. page.locator('tr', { hasText: '...' })) or add .first() so the locator is not strict-mode-ambiguous (matching 2+ elements fails).
- SECTION NAVIGATION (avoid drift): open an Admin section DIRECTLY by URL  -  preserve the appId in the current URL and set nav to the section's URL param from the ROUTES / BLACKBOARD context: { const u = new URL(page.url()); u.searchParams.set('nav', discoverableSectionKey); await page.goto(u.toString()); await page.waitForTimeout(1200); }. Do NOT click the left sidebar to navigate (it can drift to the wrong section). Discover section keys from the browser's DOM exploration  -  every accessible nav tab/link is recorded in the inspection context above.
- STABLE IDS: when the DOM exploration lists a control's stable #id, use page.locator('#<id>')  -  never guess a placeholder/text for it.
- HIDDEN CONTROLS: if a control the case needs (settings, export, column options, a row action) is not in the inspection context, it lives inside an overflow / actions menu  -  open the menu the inspector DID record (e.g. the actions/overflow/"More"-style button by its real aria-label) first, then operate the now-visible item.
- Return JSON exactly like {"scripts":[{"test_case_title":"...","filename":"kebab-case.spec.ts","code":"import { test, expect } from '@playwright/test';\\n..."}]}.
- Return exactly one script object. No combined scripts. No empty placeholder scripts.
- Set test_case_title to the test case title verbatim: ${JSON.stringify(testCase?.title || `Test case ${index + 1}`)}.
- This specific case currently has readiness=${String(testCase?.automationReadiness || 'unknown')} with proof summary: ${JSON.stringify(String(testCase?.proofSummary || 'none').slice(0, 200))}. If readiness is not "verified", stay inside the grounded selectors and labels above; do not invent missing UI.
- The Playwright test name must be the same title verbatim and must use async ({ page }, testInfo).
- Start by navigating to ${targetUrl || '/'} and handling login with USERNAME/PASSWORD before the feature steps when credentials are available. Do not assume global auth.
- Mirror this exact test case's ordered steps, not any other case. The script must cover every step in the payload below in order. Do not add per-step screenshots unless this case explicitly asks for step evidence.
- Ground selectors and assertions only in the inspection context or source-grounded understanding. Do not invent menus, labels, or success messages.
- Never make contradictory assertions about the same locator (such as visible and count zero) unless an intervening action is expected to remove it.
- WAIT RULE: only wait for real loading/busy indicators to become hidden. Never wait for normal controls, labels, tabs, fields, columns, toolbar buttons, or selected-view labels to become hidden; those should be asserted visible or used directly.
- ACTION COMPLETION CONTRACT: the test must PERFORM the case's primary goal action and make exactly ONE hard expect verify its real OUTCOME  -  asserting a control is visible is NOT performing the action. The primary action and its assertion must NOT be wrapped in .catch(() => {}) (a miss must FAIL so the repair step fixes it against the live DOM). Discover selectors from the inspection/source (never hardcode). Pick the assertion by outcome type: a file download -> assert page.waitForEvent('download'); a control state change -> do the real .check()/.setChecked()/selectOption, persist, then assert the new state held; create/edit/delete -> assert the row/value actually changed in the list.

Test case payload: ${JSON.stringify({ test_cases: [testCase] })}${coderKnowledge}`,
        schema: playwrightScriptsSchema,
        userMessage: `Generate one Playwright script for case ${index + 1}.`,
      });
      const generated = Array.isArray(one.object?.scripts) ? one.object.scripts[0] : null;
      if (generated && scriptLooksUsable(generated)) {
        const queued = normalizeScriptForCase(generated, testCase, index, run);
        const existing = Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [];
        run.playwright_scripts = [...existing.filter((s: any) => normTitle(s?.test_case_title || s?.title) !== normTitle(queued.test_case_title)), queued];
        const q = (run as any).script_queue;
        if (q?.items?.[index]) {
          q.items[index] = { ...q.items[index], status: 'script_ready', filename: queued.filename };
          q.generated = q.items.filter((x: any) => x.status !== 'pending').length;
        }
        pushPhase(run, { agent: 'ScriptQueue', status: 'running', output: `Script / ready: ` });
        await persistAgentScripts(run);
        persistDataInBackground('queued script ready');
        return queued;
      }
      return generated || null;
    } catch {
      return null;
    }
  }, run);
  if (caseList.length && aligned.missing.length && !hasRunnableScripts(aligned.scripts)) {
    run.playwright_scripts = aligned.scripts;
    pushPhase(run, {
      agent: 'PlaywrightAgent',
      status: 'failed',
      output: `No runnable scripts were generated. Missing script(s) for case ${aligned.missing.map((i) => i + 1).join(', ')}.`,
    });
    await persistAgentScripts(run);
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist incomplete-script agent artifacts:', err));
    persistDataInBackground('incomplete agent scripts');
    return;
  }
  if (caseList.length && aligned.missing.length) {
    pushPhase(run, {
      agent: 'ScriptQueue',
      status: 'completed',
      output: `Proceeding with ${aligned.scripts.length}/${caseList.length} runnable script(s); case ${aligned.missing.map((i) => i + 1).join(', ')} will remain skipped.`,
    });
  }
  const preVerifiedMap = getRunSelectorMap(run);
  // Only let the STATIC repo map rewrite selector methods when we lack a usable live DOM capture.
  // With live truth available, this static rewrite corrupts correct role selectors toward repo
  // homonyms; the DOM-first verifier below grounds them from the real page instead.
  const preVerifyLiveUsable = buildLiveSelectorIndex(run).usable;
  run.playwright_scripts = (caseList.length ? aligned.scripts : initialScripts)
    .map((script: any) => {
      const guarded = ensureExecutableLogin(script, liveCreds, targetUrl, (run as any).mission_context || missionContextFromRun(run));
      if (preVerifiedMap && !preVerifyLiveUsable && guarded?.code) {
        guarded.code = correctSelectorMethods(String(guarded.code), preVerifiedMap).code;
      }
      if (guarded?.code) {
        guarded.code = normalizeSelectorsFromInspection(String(guarded.code), run.inspection_context);
      }
      return guarded;
    }) as any;
  if ((run as any).script_queue?.items) {
    (run as any).script_queue.status = 'scripts_ready';
    (run as any).script_queue.generated = (run as any).script_queue.items.filter((x: any) => x.status !== 'pending').length;
    pushPhase(run, { agent: 'ScriptQueue', status: 'completed', output: String((run as any).script_queue.generated) + '/' + caseList.length + ' script(s) ready for verification.' });
  }
  pushPhase(run, { agent: 'PlaywrightAgent', status: 'completed', output: { scripts: run.playwright_scripts } });
  run.playwright_scripts = (run.playwright_scripts || []).map((script: any) => ({
    ...script,
    code: script?.code ? normalizeSelectorsFromInspection(String(script.code), run.inspection_context) : script?.code,
  }));
  await completeScriptProofFlow(run, targetUrl, { test_cases: caseList }, liveCreds);
  return;
}

/**
 * GIT-AGENT SELECTOR VERIFICATION GATE.
 * Before any script runs, check its selectors against the application's REAL source
 * code (the git-agent target repo) and repair any that don't match.
 * This is the "verify selectors during creation" step  -  it grounds guessed selectors
 * in the actual DOM/source so the scripts hit real elements instead of timing out.
 */
/**
 * VERIFY-LOCATORS at full potential: the codebase is the source of truth for selectors. Extract
 * every selector target from each script, cross-check it against the code SELECTOR MAP, flag the
 * culprits (selectors with no real-element match), and have the verifier rewrite each culprit with
 * the correct real selector from the code. App-agnostic; no hardcoded labels.
 */
type SelectorVerificationResult = { ok: boolean; reason?: string; unresolved?: string[] };

/**
 * The LIVE DOM is the only ground truth for selectors  -  it IS the running page the generated test
 * binds to at execution time. Repo source is a lossy, ambiguous, unscoped proxy: a prop fallback
 * ("searchPlaceholder ?? 'Search results'"), an i18n key, or a string that's real but on a DIFFERENT
 * page (the "Global Search" false-pass) all read as "grounded" against a repo-wide regex dump.
 *
 * This harvests every exact accessible string + ready-made Playwright hint the inspector captured
 * across every permission context and every observed page state (incl. controls revealed by opening
 * menus/overflows during the drill, now unioned into visibleNavigation). It is THIS page's real DOM,
 * so a selector is trustworthy only if it appears here.
 */
function buildLiveSelectorIndex(ic: any): { names: Set<string>; roles: Set<string>; hints: string[]; usable: boolean } {
  const names = new Set<string>();
  const roles = new Set<string>();
  const hints = new Set<string>();
  const addName = (v: any) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length >= 2) names.add(s.toLowerCase());
  };
  const addRole = (role: any, name: any) => {
    const r = String(role || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const n = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (r && n.length >= 2) roles.add(`${r}|${n}`);
  };
  const addDom = (d: any) => {
    if (!d) return;
    addName(d.ariaLabel); addName(d.placeholder); addName(d.id); addName(d.testId);
    addName(d.name); addName(d.text); addName(d.role);
    addRole(d.role, d.ariaLabel || d.name || d.text);
    for (const h of d.selectorHints || []) if (h) hints.add(String(h));
  };
  const addAction = (a: any) => {
    if (!a) return;
    addDom(a.dom || a);
    for (const h of a.selectorHints || []) if (h) hints.add(String(h));
    addName(a.ariaLabel); addName(a.text); addName(a.name);
    addRole(a.role || a.control || a.tag, a.ariaLabel || a.name || a.text);
  };
  // Accept either a run (has inspection_contexts / inspection_context) or a single context object.
  const contexts = Array.isArray(ic?.inspection_contexts) && ic.inspection_contexts.length
    ? ic.inspection_contexts
    : [ic?.inspection_context || ic].filter(Boolean);
  for (const ctx of contexts) {
    for (const a of ctx?.visibleNavigation || []) addAction(a);
    for (const p of ctx?.observedPages || []) for (const a of p?.actions || []) addAction(a);
    for (const f of ctx?.visibleForms || []) for (const fld of f?.fields || []) { addDom(fld?.dom); addName(fld?.label); addName(fld?.name); }
    for (const t of ctx?.visibleTables || []) for (const h of t?.headers || []) addName(h);
    for (const at of ctx?.assertionTargets || []) { addName(at?.text); addName(at?.label); }
    for (const h of ctx?.headings || []) addName(h);
  }
  return { names, roles, hints: [...hints], usable: names.size >= 8 };
}

function buildSelectorRegistryIndex(registry: any): { names: Set<string>; roles: Set<string>; hints: string[]; usable: boolean } {
  const names = new Set<string>();
  const roles = new Set<string>();
  const hints = new Set<string>();
  const add = (v: any) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length >= 2) names.add(s.toLowerCase());
  };
  const addRole = (role: any, name: any) => {
    const r = String(role || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const n = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (r && n.length >= 2) roles.add(`${r}|${n}`);
  };
  const addSelector = (selector: any) => {
    const s = String(selector || '').trim();
    if (!s) return;
    hints.add(s);
    for (const m of s.matchAll(/getByRole\(\s*['"`](\w+)['"`]\s*,\s*\{\s*name\s*:\s*['"`]([^'"`\n]{2,80})['"`]/g)) addRole(m[1], m[2]);
    for (const m of s.matchAll(/getBy(?:Role|Label|Text|Placeholder|TestId)\([^'"`]*['"`]([^'"`\n]{2,80})['"`]/g)) add(m[1]);
    for (const m of s.matchAll(/name\s*:\s*['"`]([^'"`\n]{2,80})['"`]/g)) add(m[1]);
    for (const m of s.matchAll(/\[(?:aria-label|placeholder|title|name|data-testid|alt)\s*[*^$|~]?=\s*['"]([^'"\n]{2,80})['"]\s*\]/g)) add(m[1]);
    for (const m of s.matchAll(/#([a-zA-Z][\w:-]{1,80})/g)) add(m[1]);
  };
  for (const [id, value] of Object.entries(registry?.selectors || {}) as any[]) {
    if (!value?.verified) continue;
    const hasConcreteSelector = !!(String(value.primary_selector || '').trim() || String(value.fallback_selector || '').trim());
    if (!hasConcreteSelector) continue;
    add(id);
    add(value.proof_id);
    add(value.label);
    add(value.metadata_api_name);
    add(value.role);
    addRole(value.role, value.label);
    addSelector(value.primary_selector);
    addSelector(value.fallback_selector);
  }
  return { names, roles, hints: [...hints], usable: names.size > 0 || hints.size > 0 };
}

function findVerifiedControl(run: any, selector: string): any | null {
  const elements = [
    ...(Array.isArray(run?.dom_exploration?.elements) ? run.dom_exploration.elements : []),
    ...(run?.blackboard_id ? (readBlackboard(String(run.blackboard_id))?.elements || []) : []),
  ];
  const wanted = String(selector || '').trim();
  if (!wanted) return null;
  return elements.find((e: any) =>
    e?.resolved_selector === wanted ||
    e?.fallback_selector === wanted ||
    (wanted.startsWith('#') && e?.element_id === wanted.slice(1)) ||
    (wanted.startsWith('[name=') && wanted.includes(String(e?.input_name || '')))
  ) || null;
}

function validateControlActions(run: any, scripts: any[]): string[] {
  const issues: string[] = [];
  const typed = new Set<string>();
  for (const script of scripts || []) {
    const code = String(script?.code || '');
    for (const m of code.matchAll(/\.fill\(\s*['"`]([^'"`]*)['"`]/g)) typed.add(m[1]);
    for (const m of code.matchAll(/page\.locator\(\s*['"`]([^'"`]+)['"`]\s*\)\.(fill|selectOption)\(\s*([^)]*)\)/g)) {
      const [, selector, action, rawArg] = m;
      const el = findVerifiedControl(run, selector);
      if (!el) continue;
      if (action === 'fill' && el.tag === 'select') {
        issues.push(`${script?.filename || script?.test_case_title || 'script'} uses fill() on select ${selector}`);
        continue;
      }
      if (action === 'selectOption' && el.tag === 'select' && Array.isArray(el.options)) {
        const literal = String(rawArg || '').match(/['"`]([^'"`]*)['"`]/)?.[1];
        if (literal && !el.options.some((o: any) => !o.disabled && (String(o.value) === literal || String(o.label).trim() === literal))) {
          issues.push(`${script?.filename || script?.test_case_title || 'script'} selects missing option "${literal}" for ${selector}`);
        }
      }
    }
    for (const m of code.matchAll(/expect\(\s*page\.locator\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\)\.toHaveValue\(\s*['"`]([^'"`]*)['"`]/g)) {
      const [, selector, expected] = m;
      const el = findVerifiedControl(run, selector);
      if (el?.tag === 'select' && expected === '' && el.value && !code.includes(`selectOption('')`) && !code.includes(`selectOption("")`)) {
        issues.push(`${script?.filename || script?.test_case_title || 'script'} expects select ${selector} to be blank, but live value is "${el.value}"`);
      }
    }
    for (const m of code.matchAll(/getByRole\(\s*['"`]row['"`]\s*\)\.filter\(\s*\{\s*hasText\s*:\s*\/([^/\n]{8,120})\//g)) {
      const expected = m[1].replace(/\\s\+/g, ' ').replace(/\\/g, '').trim();
      const liveText = JSON.stringify(run?.dom_exploration || '').toLowerCase();
      if (expected && !typed.has(expected) && !liveText.includes(expected.toLowerCase().slice(0, 40))) {
        issues.push(`${script?.filename || script?.test_case_title || 'script'} asserts row data not captured from live DOM: ${expected.slice(0, 80)}`);
      }
    }
  }
  return issues.slice(0, 20);
}

async function verifyScriptsWithGitAgent(run: any, scripts: any[], _prompt: string): Promise<SelectorVerificationResult> {
  if (!Array.isArray(scripts) || !scripts.length) return { ok: true };
  pushPhase(run, { agent: 'SelectorVerifier', status: 'running' });
  try {
    const controlIssues = validateControlActions(run, scripts);
    if (controlIssues.length) {
      const reason = `Script verification blocked invalid live-control actions: ${controlIssues.slice(0, 8).join(' | ')}`;
      (run as any).selector_verification = { ok: false, reason, unresolved: controlIssues };
      pushPhase(run, { agent: 'SelectorVerifier', status: 'failed', output: reason });
      return { ok: false, reason, unresolved: controlIssues };
    }
    const repoPath = getProjectRepoPath(run.projectId || '').trim();
    const map = getRunSelectorMap(run);
    const registry = buildSelectorRegistryIndex((run as any).selector_registry);
    if (!registry.usable) {
      const reason = 'Selector verification blocked: selector registry is empty, so script writer has no verified agent handoff to use.';
      (run as any).selector_verification = { ok: false, reason, unresolved: [] };
      pushPhase(run, { agent: 'SelectorVerifier', status: 'failed', output: reason });
      return { ok: false, reason };
    }
    // DOM-first: the live inspection of THIS page is the primary authority; the repo map is only a
    // fallback for when live capture is too thin to trust. Fail only when we have NEITHER.
    const live = buildLiveSelectorIndex(run);
    if (!registry.usable && !map && !live.usable) {
      const reason = 'Selector verification failed: no live-DOM capture and no source repo selector map are available to ground selectors.';
      pushPhase(run, { agent: 'SelectorVerifier', status: 'failed', output: reason });
      return { ok: false, reason };
    }
    const mapBlock = map ? renderSelectorMap(map, 220) : '';
    const groundedInRegistry = (t: string) => {
      const lt = String(t || '').toLowerCase().trim();
      return !!lt && registry.names.has(lt);
    };
    // Page-scoped, so substring matching safely accepts partial/regex selectors without the
    // repo-wide false positives that forced exact-only matching against the static map.
    const groundedInLive = (t: string) => {
      const lt = String(t || '').toLowerCase().trim();
      if (!lt) return false;
      if (live.names.has(lt)) return true;
      if (lt.length >= 4) for (const n of live.names) if (n.includes(lt)) return true;
      return false;
    };
    const badRoleLocatorsOf = (code: string) => {
      const out: string[] = [];
      const roleAuthority = registry.roles.size ? registry.roles : live.roles;
      if (!roleAuthority.size) return out;
      for (const m of String(code || '').matchAll(/getByRole\(\s*['"`](\w+)['"`]\s*,\s*\{\s*name\s*:\s*['"`]([^'"`\n]{2,80})['"`]/g)) {
        const role = m[1].toLowerCase();
        const name = cleanRegexTarget(m[2]).toLowerCase();
        if (!roleAuthority.has(`${role}|${name}`)) out.push(`${role}:${m[2]}`);
      }
      return out;
    };
    // The rewrite pass draws from the REAL running-page selectors when we have them, falling back
    // to repo strings only when live capture is thin. This is what makes real on-page selectors
    // reach the coder verbatim.
    const liveBlock = live.usable
      ? `LIVE PAGE SELECTORS  -  the ACTUAL running DOM this test executes against. These are the ONLY valid options; pick the closest by meaning and use it EXACTLY:\nReady-made locators:\n${live.hints.slice(0, 140).join('\n')}\nReal on-page names/labels: ${[...live.names].slice(0, 160).join(' | ')}`
      : mapBlock;
    const selectorAuthorityBlock = registry.usable
      ? `VERIFIED SELECTOR REGISTRY - the ONLY valid selector handoff from Inspector/Registry to ScriptWriter. Pick from these proof-backed selectors exactly; do not invent replacements:\n${registry.hints.slice(0, 160).join('\n')}\nValid proof ids/names: ${[...registry.names].slice(0, 180).join(' | ')}`
      : liveBlock;

    // A regex-literal target like /^More$/ gets captured WITH its anchors ("^More$") because
    // capture stops at the closing '/'. Left un-stripped, that garbled string can't exact-match
    // anything in the selector map OR anything a rewrite produces, so it silently rides through
    // as a "different but still ungrounded" string instead of being cleanly recognized as "More".
    const cleanRegexTarget = (s: string) => s.trim().replace(/^\^/, '').replace(/\$$/, '').trim();
    const targetsOf = (code: string, includeDataText = false) => {
      const t = new Set<string>();
      const addSelectorLiteral = (raw: string) => {
        const s = String(raw || '').trim();
        if (!s) return;
        for (const m of s.matchAll(/(?:text|has-text|:text)\s*[=:(]\s*["']([^"'\n]{2,80})["']/g)) t.add(cleanRegexTarget(m[1]));
        for (const m of s.matchAll(/role\s*=\s*\w+\s*\[\s*name\s*=\s*["']([^"'\n]{2,80})["']\s*\]/g)) t.add(cleanRegexTarget(m[1]));
        for (const m of s.matchAll(/#([A-Za-z][\w-]{1,80})/g)) t.add(m[1].trim());
      };
      for (const m of code.matchAll(/getByRole\(\s*['"`]\w+['"`]\s*,\s*\{\s*name\s*:\s*[/]?\s*['"`]?([^'"`/)\n,}]{2,50})/g)) t.add(cleanRegexTarget(m[1]));
      for (const m of code.matchAll(/getBy(?:Label|Text|Placeholder|TestId)\(\s*[/]?\s*['"`]?([^'"`/)\n,]{2,50})/g)) t.add(cleanRegexTarget(m[1]));
      for (const m of code.matchAll(/(?:page|\w+)\.locator\(\s*['"`]([^'"`\n]{2,180})['"`]\s*\)/g)) addSelectorLiteral(m[1]);
      // Attribute/CSS locators the coder loves to invent  -  locator('[aria-label="..."]'),
      // [placeholder="..."], [data-testid="..."]  -  were NEVER cross-checked before, so a
      // hallucinated aria-label (e.g. "List view: All Apps") sailed straight through to a
      // 15s "element not found" timeout. Extract them so they get grounded like the rest.
      for (const m of code.matchAll(/\[(?:aria-label|placeholder|title|name|data-testid|alt)\s*[*^$|~]?=\s*['"]([^'"\n]{2,60})['"]\s*\]/g)) t.add(m[1].trim());
      // .filter({ hasText: '...' }) row/text grounding (data-coupled assertions).
      if (includeDataText) for (const m of code.matchAll(/hasText\s*:\s*['"`]([^'"`\n]{2,60})['"`]/g)) t.add(m[1].trim());
      // hasText also commonly uses a JS regex literal (hasText: /^More$/) instead of a quoted
      // string  -  the pattern above only caught quoted values, so a hallucinated regex-literal
      // hasText (the exact "More" toolbar-button bug) slipped through verification untouched.
      if (includeDataText) for (const m of code.matchAll(/hasText\s*:\s*\/\^?([^/\n]{2,60}?)\$?\//g)) t.add(cleanRegexTarget(m[1]));
      return [...t];
    };
    const ignorable = /sign ?in|log ?in|email|user(name)?|password/i;

    // PASS 1 (deterministic): rewrite every selector to the METHOD the code defines for it
    // (placeholder->getByPlaceholder, testid->getByTestId, etc.)  -  right name AND right method,
    // straight from the code map. No LLM, no guessing. SKIPPED when we have a usable live DOM
    // capture: the static map rewrites a name toward a repo homonym under a possibly-wrong method
    // (e.g. corrupting a correct getByRole into a getByText/getByLabel that
    // doesn't match the live page). With live truth available, live grounding below is authoritative.
    let methodFixes = 0;
    if (map && !live.usable) {
      for (const s of scripts) {
        if (!s?.code) continue;
        const r = correctSelectorMethods(String(s.code), map);
        if (r.fixes > 0) { s.code = r.code; methodFixes += r.fixes; }
      }
    }

    // PASS 2 (LLM, REJECT-AND-REGENERATE): for selectors whose NAME is still not in the code map,
    // rewrite them  -  but HARD-ENFORCE the result. A rewrite is accepted ONLY when it actually
    // reduces the count of un-grounded selectors (so the model can't swap one invented selector
    // for another and have it pass silently). Re-verify after every rewrite and loop until zero
    // culprits remain or no further progress is made. Any selector that STILL isn't in the
    // codebase after the gate is reported honestly (it will be caught again by execution-repair).
    const verifier = await getOrchestrator('appInspector', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
    // DOM-first culprit test: when we have a real live capture of this page, it is the SOLE
    // authority  -  a selector absent from the live DOM is a culprit even if the repo mentions it
    // somewhere (that is exactly the "Global Search" false-pass: real string, wrong page). Fall
    // back to the static repo map only when the live capture is too thin to trust.
    // Skip JS code artifacts the extractor can accidentally capture from dynamic locators
    // (e.g. getByText(new RegExp(...)) yields the garbage target "new RegExp(")  -  these are not
    // UI labels, can never be "grounded", and must not be treated as culprits.
    const looksLikeCode = (t: string) => /new\s|regexp|=>|[(){}\\]|\$\{|\bfunction\b/i.test(t);
    const culpritsOf = (code: string) => targetsOf(String(code), true).filter((t) => {
      const typed = new Set([...String(code).matchAll(/\.fill\(\s*['"`]([^'"`]*)['"`]/g)].map((m) => String(m[1]).toLowerCase().trim()));
      if (ignorable.test(t) || looksLikeCode(t)) return false;
      if (typed.has(String(t).toLowerCase().trim())) return false;
      return registry.usable ? !groundedInRegistry(t) : live.usable ? !groundedInLive(t) : !mapHas(map!, t);
    }).concat(badRoleLocatorsOf(code));
    const MAX_VERIFY_ROUNDS = 3;
    let totalCulprits = 0; let rewritten = 0; let residualUngrounded = 0;
    let cursor = 0;
    const verifyOne = async (s: any) => {
      if (!s?.code) return;
      let culprits = culpritsOf(String(s.code));
      if (!culprits.length) return; // every selector is grounded in the codebase  -  nothing to fix
      totalCulprits += culprits.length;
      for (let round = 0; round < MAX_VERIFY_ROUNDS && culprits.length; round += 1) {
        try {
          const res = await verifier.generateObject<any>({
            prompt: `A Playwright script uses selectors that do NOT exist on the application's real, running page. The SELECTORS below are the SOURCE OF TRUTH  -  they are what the live DOM this test runs against actually exposes. Replace each CULPRIT selector with the correct real locator / label / role-name / testid from that list (closest match by meaning)  -  you MUST pick from the list; do NOT invent a new one. Keep the test structure, step order, testInfo.attach screenshots, and assertions intact; only fix the selectors. Return the corrected full script in "code".
${selectorAuthorityBlock}
CULPRIT selectors in this script (each is NOT on the real page  -  fix every one):
${culprits.join(' | ')}
SCRIPT:
${s.code}`,
            schema: z.object({ code: z.string() }),
            userMessage: 'Rewrite the culprit selectors using ONLY the real on-page selectors listed.',
          });
          const code = res?.object?.code;
          if (!(code && code.length > 80 && /test\(/.test(code))) break; // unusable output  -  stop
          const newCulprits = culpritsOf(code);
          // Accept ONLY a genuine improvement; a rewrite that doesn't reduce un-grounded
          // selectors (or introduces new ones) is rejected so we never regress.
          if (newCulprits.length < culprits.length) {
            s.code = code; rewritten += 1; culprits = newCulprits;
          } else {
            break; // no progress  -  keep the best version so far
          }
        } catch { break; /* keep the best version on a verifier error */ }
      }
      residualUngrounded += culprits.length;
    };
    const worker = async () => { while (cursor < scripts.length) { await verifyOne(scripts[cursor++]); } };
    await Promise.all(Array.from({ length: 4 }, worker));
    const groundLabel = registry.usable ? 'the selector registry' : live.usable ? 'the live page DOM' : 'the codebase';
    const crossRef = registry.usable
      ? `${registry.names.size} registry selector proof(s)`
      : live.usable
        ? `${live.names.size} live on-page selector(s)`
        : `${map?.fileCount ?? 0} source files`;
    // DOM-first: this pass is ADVISORY, never a hard gate. The real page is the arbiter  -  the
    // script runs and the execution-repair step re-inspects the live DOM to fix any selector that
    // still misses. Blocking evidence here (especially on a non-authoritative repo match) is what
    // produced the "not found in the codebase" dead-ends; we best-effort rewrite and always proceed.
    const unresolved = [...new Set(scripts.flatMap((s: any) => s?.code ? culpritsOf(String(s.code)) : []))].slice(0, 40);
    (run as any).selector_verification = { ok: true, unresolved };
    const note = unresolved.length
      ? ` ${unresolved.length} selector(s) not pre-matched (${unresolved.slice(0, 8).join(' | ')}); execution + live re-grounding will resolve them against the real page.`
      : ` every selector matched ${groundLabel}.`;
    pushPhase(run, { agent: 'SelectorVerifier', status: 'completed', output: `Cross-verified ${scripts.length} script(s) vs ${crossRef}; ${methodFixes} method fix(es), ${totalCulprits} culprit(s) found, ${rewritten} rewrite(s) applied.${note}` });
    return { ok: true };
  } catch (e: any) {
    const reason = `Selector verification failed: ${e?.message || e}`;
    (run as any).selector_verification = { ok: false, reason, unresolved: [] };
    pushPhase(run, { agent: 'SelectorVerifier', status: 'failed', output: reason });
    return { ok: false, reason };
  }
}

/**
 * Actually EXECUTE the generated Playwright scripts (so the user's intent is
 * performed in a real browser) and build evidence from that run  -  one real
 * screenshot per executed case, with true pass/fail and failure reasons.
 * Falls back to a base-URL login screenshot if the scripts can't be executed.
 */
const normTitle = (t: string) => String(t || '').trim().toLowerCase();
const baseName = (f: string) => String(f || '').split(/[\\/]/).pop() || '';

function scriptFilenameForCase(title: string, index: number): string {
  const slug = String(title || `case-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || `case-${index + 1}`}.spec.ts`;
}

function normalizeSelectorLabel(v: unknown) {
  const text = String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return '';
  // Handle generated labels like "sampathsam" or "Revenue Hubrev" -> "sampath", "Revenue Hub".
  // 1) exact repeated prefix+suffix, e.g. "sampathsam" (sam + sampathsam) -> "sampath"
  for (let i = Math.min(8, Math.floor(text.length / 2)); i >= 2; i -= 1) {
    const prefix = text.slice(0, i);
    const suffix = text.slice(text.length - i);
    if (prefix && prefix === suffix) return text.slice(0, text.length - i).trim();
  }
  // 2) exact token repetition from extraction bugs, e.g. "Revenue Hub Hub" -> "Revenue Hub".
  const words = text.split(/\s+/);
  if (words.length >= 2 && words[0] && words[0] === words[words.length - 1]) {
    return words.slice(0, -1).join(' ').trim();
  }
  const tokens = text.split(' ').filter(Boolean);
  const deduped: string[] = [];
  for (const token of tokens) {
    const last = deduped[deduped.length - 1];
    if (last && last === token) continue;
    deduped.push(token);
  }
  return deduped.join(' ');
}

function buildAmbiguousRoleNameSet(run: any) {
  const counts = new Map<string, number>();
  const add = (roleValue: unknown, nameValue: unknown) => {
    const role = String(roleValue || 'button').trim().toLowerCase() || 'button';
    const name = normalizeSelectorLabel(nameValue);
    if (!name) return;
    const key = `${role}|${name}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  const walk = (items: any[]) => {
    for (const item of items) {
      add(item?.role, item?.name);
      add(item?.role, item?.aria_label);
      add(item?.role, item?.ariaLabel);
      add(item?.role, item?.text);
      add(item?.role, item?.placeholder);
      add(item?.role, item?.input_name);
      add(item?.role, item?.element_id);
      add(item?.role, item?.id);
    }
  };
  walk(Array.isArray(run?.dom_exploration?.elements) ? run.dom_exploration.elements : []);
  const bbId = run?.blackboard_id;
  const bb = bbId ? readBlackboard(String(bbId)) : null;
  walk(Array.isArray(bb?.elements) ? bb.elements : []);
  const ambiguous = new Set<string>();
  for (const [key, count] of counts) if (count > 1) ambiguous.add(key);
  return ambiguous;
}

function applyRoleSelectorSafetyGuards(code: string, run: any) {
  if (!code) return code;
  const ambiguous = buildAmbiguousRoleNameSet(run);
  if (!ambiguous.size) return code;
  const byRoleRegex = /\bgetByRole\(([^,]+),\s*\{([^}]*)\}\s*\)(?!\s*\.\w+\()/g;
  return code.replace(byRoleRegex, (match, roleRaw, optionsRaw, offset) => {
    const role = String(roleRaw || 'button').trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase() || 'button';
    const nameMatch = optionsRaw.match(/\bname\s*:\s*(\/[^/]+\/[gimsuy]*|(['"])([^'"]+)\2)/i);
    if (!nameMatch) return match;
    const name = nameMatch[3] || nameMatch[1];
    const normalizedName = normalizeSelectorLabel(name);
    if (!normalizedName || !ambiguous.has(`${role}|${normalizedName}`)) return match;
    const hasExact = /\bexact\s*:\s*(true|false)\b/i.test(optionsRaw);
    const after = code.slice((offset as any as number) + match.length);
    if (hasExact) return `${match}.first()`;
    if (/^\s*\.first\(\)|^\s*\.nth\(\d+\)/.test(after)) return match;
    const withExact = match.replace('{', '{ exact: true, ');
    return `${withExact}.first()`;
  });
}

function normalizeScriptForCase(script: any, testCase: any, index: number, run?: any) {
  const title = String(testCase?.title || script?.test_case_title || script?.title || `Test case ${index + 1}`).trim();
  const rawCode = String(script?.code || '');
  const cleaned = rawCode ? sanitizeTestCode(rawCode) : '';
  const safeCode = applyRoleSelectorSafetyGuards(injectRuntimeFallbacks(cleaned), run);
  return {
    ...script,
    test_case_title: title,
    filename: String(script?.filename || '').trim() || scriptFilenameForCase(title, index),
    code: repairTestCode(safeCode) || safeCode,
  };
}

function injectRuntimeFallbacks(code: string) {
  const declarationPattern = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  const declared = new Set<string>();
  let m: RegExpExecArray | null;
  declarationPattern.lastIndex = 0;
  while ((m = declarationPattern.exec(code)) !== null) {
    const name = m[1];
    if (name) declared.add(name);
  }
  const fallbackNames = ['initialTopRowLabel', 'topRowLabel', 'firstRowLabel', 'initialRowLabel'];
  const missing = fallbackNames.filter((name) => {
    if (declared.has(name)) return false;
    const re = new RegExp(`\\\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\b`, 'g');
    return re.test(code);
  });
  if (!missing.length) return code;
  const guardBlock = missing.map((name) => `if (typeof ${name} === 'undefined') { var ${name} = ''; }`).join('\n');
  const importBlock = code.match(/^(?:import[^\n]*\n)+/);
  if (importBlock && /from ['"]@playwright\/test['"]/i.test(importBlock[0])) {
    return `${importBlock[0]}${guardBlock}\n${code.slice(importBlock[0].length)}`;
  }
  return `${guardBlock}\n${code}`;
}

function scriptLooksUsable(script: any): boolean {
  const code = String(script?.code || '');
  return code.length > 80 && /@playwright\/test/.test(code) && /\btest\s*\(/.test(code);
}

/**
 * Make every LOGIN interaction a safe no-op. The runner injects an authenticated
 * storageState, so at execution time there is usually NO login form. An UNGUARDED login
 * fill/click/redirect-wait then BLOCKS for the full actionTimeout (15s) and fails the test
 * before it ever reaches the feature  -  the #1 cause of the "label not found / fill timeout"
 * failures. Guarding is idempotent and harmless when a login form IS present (the action
 * still runs; only a miss is swallowed). Line-based so we only touch single-line statements
 * the model actually wrote this way; multi-line login blocks are left untouched (no harm).
 */
function guardLoginInteractions(code: string): string {
  const lines = code.split('\n');
  const loginFill = /\.fill\(\s*(?:USERNAME|PASSWORD)\b/;
  const signIn = /sign ?in|log ?in|signin|log[-\s]?in/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('await ')) continue;
    if (line.includes('.catch(')) continue;       // already guarded
    if (!/;\s*$/.test(trimmed)) continue;          // single-line statements only
    const isFill = loginFill.test(line);
    const isLoginClick = /\.click\(/.test(line) && signIn.test(line);
    const isWaitUrl = /\.waitForURL\(/.test(line);
    if (!isFill && !isLoginClick && !isWaitUrl) continue;
    let next = line.replace(/\.fill\(\s*(USERNAME|PASSWORD)\s*\)/, '.fill($1, { timeout: 5000 })');
    next = next.replace(/;\s*$/, '.catch(() => {});');
    lines[i] = next;
  }
  return lines.join('\n');
}

/**
 * Remove assertions ABOUT the login UI. The harness injects an authenticated storageState,
 * so the login screen/fields/headings are ABSENT at run time  -  any assertion that
 * the login UI is visible or that a credential field holds a value, is then
 * guaranteed to fail (and is irrelevant to the feature under test). A single failed soft
 * assertion marks the whole test failed even when every feature step passed, so these
 * login-UI assertions are the dominant remaining failure once login ACTIONS are guarded.
 * Auth is the harness's job; the test body must be auth-free. Single-line statements only,
 * so we never half-delete a multi-line expression.
 */
function neutralizeLoginAssertions(code: string): string {
  const lines = code.split('\n');
  const isAssert = /\bexpect(\.soft)?\s*\(/;
  const loginRef = /sign ?in|log ?in|signin/i;
  const credValueAssert = /toHaveValue\(\s*(?:USERNAME|PASSWORD)\b/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (!isAssert.test(line)) continue;
    if (!/;\s*$/.test(t)) continue;          // complete single-line statement only
    if (!/\.to[A-Z]/.test(line)) continue;   // must be an actual matcher (.toBeVisible/.toHaveValue/...)
    if (loginRef.test(line) || credValueAssert.test(line)) {
      lines[i] = line.replace(/\S.*/, '// [auth-neutralized] login-UI assertion removed  -  session is pre-authenticated');
    }
  }
  return lines.join('\n');
}

function ensureExecutableLogin(script: any, credentials: any, targetUrl: string, mission?: MissionContext | null) {
  if (!script) return script;
  let code = String(script.code || '');
  if (!code) return script;
  // Phase 3: inject the mission-verification preamble immediately before the FIRST assertion, so no
  // test can assert on the wrong platform/application/module. Deterministic recovery + abort live in
  // the snippet. Guarded against double-injection; no-op when there is nothing enforceable.
  const missionVerify = buildMissionVerificationSnippet(mission);
  const withVerify = (c: string) =>
    missionVerify && !c.includes('MISSION VERIFICATION')
      ? c.replace(/(\n[ \t]*)(await\s+expect\()/, `$1${missionVerify}$1$2`)
      : c;
  // Phase 4: collapse label+apiname concatenation artifacts (e.g. "App1app1" → "App1") deterministically.
  code = collapseDoubledLabels(code).code;
  code = code.replace(/\/\/\s*Auth is expected[^\n]*\n?/gi, '');
  // networkidle hangs on SPAs that keep streaming/long-poll connections open; the coder
  // prompt forbids it but models still emit it. Downgrade to a deterministic, fast wait.
  code = code.replace(/waitForLoadState\(\s*['"]networkidle['"]\s*\)/g, "waitForLoadState('domcontentloaded')");
  // Guard whatever login the model wrote so an already-authenticated session never hangs it,
  // and strip assertions ABOUT the login UI (which can't hold once we inject a session).
  code = guardLoginInteractions(code);
  code = neutralizeLoginAssertions(code);
  if (targetUrl) {
    code = code.replace(/await\s+page\.goto\((['"`])\/[^'"`]*\1\)/, `await page.goto(${JSON.stringify(targetUrl)})`);
  }
  // Beyond guarding, the rest (constant injection, login-snippet fallback) needs real creds.
  if (!credentials?.username || !credentials?.password) return { ...script, code: withVerify(code) };
  const constants = `const USERNAME = ${JSON.stringify(String(credentials.username))};\nconst PASSWORD = ${JSON.stringify(String(credentials.password))};`;
  if (!/\bconst\s+USERNAME\b/.test(code) || !/\bconst\s+PASSWORD\b/.test(code)) {
    const importBlock = code.match(/^(?:import[^\n]*\n)+/);
    if (importBlock) {
      code = code.replace(importBlock[0], `${importBlock[0]}\n${constants}\n\n`);
    } else {
      code = `${constants}\n\n${code}`;
    }
  }
  const hasLoginFill = /\.fill\(\s*USERNAME\b/.test(code) && /\.fill\(\s*PASSWORD\b/.test(code);
  if (!hasLoginFill) {
    const loginSnippet =
      `\n  // Discover login field selectors from the inspection context; fallback to common patterns if unknown.\n` +
      `  await page.getByLabel(/email|user|login/i).first().fill(USERNAME, { timeout: 4000 }).catch(() => {});\n` +
      `  await page.getByLabel(/password/i).first().fill(PASSWORD, { timeout: 4000 }).catch(() => {});\n` +
      `  await page.getByRole('button', { name: /sign ?in|log ?in/i }).first().click({ timeout: 4000 }).catch(() => {});\n` +
      `  await page.waitForTimeout(2000);\n`;
    if (/await\s+page\.waitForLoadState\(\s*['"]domcontentloaded['"]\s*\)\s*;/.test(code)) {
      code = code.replace(/await\s+page\.waitForLoadState\(\s*['"]domcontentloaded['"]\s*\)\s*;/, (match) => `${match}${loginSnippet}`);
    } else {
      code = code.replace(/await\s+page\.goto\([^)]+\)\s*;/, (match) => `${match}${loginSnippet}`);
    }
  }
  return { ...script, code: withVerify(code) };
}

async function alignScriptsToCases(
  initialScripts: any[],
  cases: any[],
  generateOne: (testCase: any, index: number) => Promise<any | null>,
  run?: any,
): Promise<{ scripts: any[]; missing: number[] }> {
  if (!cases.length) return { scripts: Array.isArray(initialScripts) ? initialScripts : [], missing: [] };
  const candidates = (Array.isArray(initialScripts) ? initialScripts : [])
    .map((script, index) => ({ script, index }))
    .filter(({ script }) => scriptLooksUsable(script));
  const used = new Set<number>();
  const aligned: Array<any | null> = Array(cases.length).fill(null);
  const fullPositionalSet = candidates.length === cases.length;

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const expectedTitle = normTitle(cases[caseIndex]?.title);
    let candidateIndex = candidates.findIndex(({ script, index }) => {
      if (used.has(index)) return false;
      return expectedTitle && normTitle(script?.test_case_title || script?.title) === expectedTitle;
    });
    if (candidateIndex < 0 && fullPositionalSet && candidates[caseIndex] && !used.has(candidates[caseIndex].index)) {
      candidateIndex = caseIndex;
    }
    if (candidateIndex >= 0 && candidates[candidateIndex]) {
      const { script, index } = candidates[candidateIndex];
      used.add(index);
      aligned[caseIndex] = normalizeScriptForCase(script, cases[caseIndex], caseIndex, run);
    }
  }

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    if (aligned[caseIndex]) continue;
    const generated = await generateOne(cases[caseIndex], caseIndex);
    if (generated && scriptLooksUsable(generated)) {
      aligned[caseIndex] = normalizeScriptForCase(generated, cases[caseIndex], caseIndex, run);
    }
  }

  const missing: number[] = [];
  const scripts: any[] = [];
  aligned.forEach((script, index) => {
    if (script) scripts.push(script);
    else missing.push(index);
  });
  return { scripts, missing };
}

// Bound the inspection context before it is embedded into LLM prompts, so a large
// page (long nav/tables/forms/actions) does not blow the token budget. Keeps the
// fields the CaseWriter/Coder actually rely on.
function compactInspectionContext(ic: any) {
  if (!ic) return null;
  const cap = (v: any, n: number) => (Array.isArray(v) ? v.slice(0, n) : v);
  const sanitizeTable = (table: any) => ({
    label: String(table?.label || ''),
    headers: Array.isArray(table?.headers) ? table.headers.filter(Boolean) : [],
    rowCount: Number(table?.rowCount || 0),
  });
  return {
    goalStatus: ic.goalStatus,
    currentUrl: ic.currentUrl,
    pageSummary: typeof ic.pageSummary === 'string' ? ic.pageSummary.slice(0, 800) : ic.pageSummary,
    visibleNavigation: cap(ic.visibleNavigation, 40),
    visibleForms: cap(ic.visibleForms, 12),
    visibleTables: cap(ic.visibleTables, 12).map(sanitizeTable),
    assertionTargets: cap(ic.assertionTargets, 24),
    actionsTaken: cap(ic.actionsTaken, 24),
  };
}

function renderPageOutlineForPrompt(exploration: any, maxChars = 6000): string {
  const outline = String(exploration?.outline || '').trim();
  if (!outline) return '';
  const cleaned = outline.replace(/\s*\[ref=e\d+\]/g, '');
  const body = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n  ... (outline truncated)` : cleaned;
  return `\nPAGE OUTLINE:\n${body}\n`;
}

function renderVerifiedElementsForPrompt(exploration: any): string {
  const ambiguous = new Map<string, number>();
  for (const e of Array.isArray(exploration?.elements) ? exploration.elements : []) {
    const key = `${String((e?.role || 'button')).trim().toLowerCase()}|${normalizeSelectorLabel(e?.name || e?.text || e?.input_name || e?.aria_label || e?.ariaLabel || e?.placeholder)}`;
    if (!key.endsWith('|')) ambiguous.set(key, (ambiguous.get(key) || 0) + 1);
  }
  const ambiguousRoleName = new Set<string>([...ambiguous].filter(([, n]) => n > 1).map(([k]) => k));

  const elements = Array.isArray(exploration?.elements) ? exploration.elements : [];
  const hasVerification = elements.some((e: any) => typeof e?.status === 'string' && e?.resolved_selector !== undefined);
  if (!hasVerification) return renderRawElementsForPrompt(exploration);
  const ranked = rankVerifiedElements(elements);
  const usable = ranked.filter((e: any) => (e.status === 'verified' || e.status === 'not_unique') && e.resolved_selector);
  if (!usable.length) return renderRawElementsForPrompt(exploration);
  const lines = usable.slice(0, 120).map((e: any) => {
    const label = e.name || e.placeholder || e.input_name || e.text || '';
    const normalizedRole = String(e.role || 'button').toLowerCase() || 'button';
    const normalizedLabel = normalizeSelectorLabel(label).toLowerCase();
    const locator = (e.status === 'not_unique' || ambiguousRoleName.has(`${normalizedRole}|${normalizedLabel}`)) && e.resolved_selector
      ? `${e.resolved_selector}.first()`
      : e.resolved_selector;
    const options = e.tag === 'select' && Array.isArray(e.options) && e.options.length
      ? ` options=${e.options.filter((o: any) => !o.disabled).slice(0, 12).map((o: any) => `${String(o.label || '').slice(0, 40)}=>${String(o.value || '').slice(0, 40)}${o.selected ? '*' : ''}`).join(' | ')}`
      : '';
    const flags = [
      e.status === 'not_unique' ? 'NOT UNIQUE  -  scope it or use .first()' : '',
      e.state?.disabled ? 'disabled' : '',
      e.state?.required ? 'required' : '',
      e.value ? `value=${e.value}` : '',
      !e.visible ? 'not visible' : '',
      e.tooltip ? `tooltip title="${String(e.tooltip).slice(0, 70)}"  -  assert via toHaveAttribute('title', ...)` : '',
    ].filter(Boolean).join('; ');
    return `  ${e.role || e.tag} "${String(label).slice(0, 60)}" -> ${locator}${e.fallback_selector ? ` | fallback: ${e.fallback_selector}` : ''}${flags ? ` [${flags}]` : ''}${options}`;
  });
  const broken = elements.filter((e: any) => e.status === 'broken').length;
  return `\nVERIFIED SELECTORS: use these exact labels/selectors${broken ? `; ${broken} failed candidate(s) removed` : ''}.\n${lines.join('\n')}\n${renderOnPageTextForPrompt(exploration)}`;
}

function renderOnPageTextForPrompt(exploration: any, maxItems = 80): string {
  const texts = new Set<string>();
  const controlRoles = new Set([
    'button', 'link', 'tab', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'menuitem', 'switch',
    'listbox', 'option', 'menu', 'toolbar', 'heading', 'columnheader',
  ]);
  const add = (v: any) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeSelectorLabel(t);
    if (!normalized || normalized.length < 3 || normalized.length > 110) return;
    texts.add(normalized);
  };
  for (const e of Array.isArray(exploration?.elements) ? exploration.elements : []) {
    if (!e) continue;
    const role = String(e.role || '').toLowerCase();
    const values = [e.name, e?.text, e.ariaLabel, e.aria_label, e.placeholder, e.title];
    if (!role || controlRoles.has(role)) {
      values.forEach(add);
    }
  }
  const outline = String(exploration?.outline || '');
  for (const m of outline.matchAll(/"((?:[^"\\]|\\.){3,120})"/g)) add(m[1]);
  for (const m of outline.matchAll(/\]:\s*([^\n]{3,120})$/gm)) add(m[1]);
  if (!texts.size) return '';
  const list = [...texts].slice(0, maxItems).map((t) => `  "${t}"`).join('\n');
  return `\nON-PAGE TEXT:\n${list}\n`;
}

function renderRawElementsForPrompt(exploration: any): string {
  if (!exploration?.elements?.length) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const el of exploration.elements) {
    const text = (el.text || '').slice(0, 60);
    const placeholder = (el.placeholder || '').slice(0, 40);
    const label = (el.ariaLabel || '').slice(0, 60);
    const name = (el.name || '').slice(0, 40);
    const id = (el.id || '').slice(0, 40);
    const role = el.role || '';
    const tag = el.tag;
    const key = `${tag}|${role}|${label}|${placeholder}|${text}|${name}`;
    if (seen.has(key) || (!text && !label && !placeholder && !name && !id)) continue;
    seen.add(key);
    const summary = [tag, role, text, label, placeholder, name, id].filter(Boolean).slice(0, 4).join(' ');
    const hints: string[] = [];
    if (label) hints.push(`getByLabel("${label}")`);
    if (placeholder) hints.push(`getByPlaceholder("${placeholder}")`);
    if (role && (label || text)) hints.push(`getByRole("${role}", { name: "${label || text}" })`);
    if (name) hints.push(`locator('[name="${name}"]')`);
    if (id) hints.push(`page.locator('#${id}')`);
    lines.push(`  ${summary.padEnd(50)} ${hints[0] || ''}`);
  }
  return lines.length ? `\nRAW DOM ELEMENTS:\n${lines.slice(0, 120).join('\n')}\n` : '';
}

function summarizeExecutionTests(tests: any[], durationMs = 0, error?: string) {
  const failed = tests.filter((t) => /fail|timedout|interrupted/i.test(String(t.status))).length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;
  const passed = tests.filter((t) => t.status === 'passed').length;
  const total = tests.length;
  return {
    ok: total > 0 && failed === 0 && passed > 0,
    total,
    passed,
    failed,
    skipped,
    durationMs,
    error: error || (total === 0 ? 'Execution produced zero tests.' : passed === 0 ? 'Execution produced no passing tests.' : undefined),
    tests: tests.map((t) => ({ title: t.title, status: t.status, durationMs: t.durationMs, error: t.error })),
  };
}

async function publishAgentRunSnapshot(run: any, reason: string) {
  await saveAgentRunState(run, reason);
}

async function copyTestEvidenceToRun(opts: {
  run: any;
  tests: any[];
  cases: any[];
  targetUrl: string;
  evidence: any[];
  usedCaseIndexes: Set<number>;
  resolveCaseIndex: (t: any, fallbackPos: number) => number;
  startIndex: number;
}) {
  const { run, tests, cases, targetUrl, evidence, usedCaseIndexes, resolveCaseIndex, startIndex } = opts;
  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });

  for (let offset = 0; offset < tests.length; offset += 1) {
    const t = tests[offset];
    const evidenceIndex = startIndex + offset;
    let caseIndex = resolveCaseIndex(t, evidenceIndex);
    if (usedCaseIndexes.has(caseIndex)) {
      const free = cases.findIndex((_, idx) => !usedCaseIndexes.has(idx));
      if (free >= 0) caseIndex = free;
    }
    usedCaseIndexes.add(caseIndex);

    let screenshotUrl = '';
    if (t.screenshotPath) {
      const dest = `${run.id}-case-${evidenceIndex + 1}.png`;
      const copied = await fsp.copyFile(t.screenshotPath, path.join(evidenceDir, dest))
        .then(() => true)
        .catch((e) => { console.warn(`[evidence] failed to copy screenshot for "${t.title}":`, e?.message || e); return false; });
      if (copied) screenshotUrl = `/evidence/${dest}`;
    }

    const stepScreenshots: string[] = [];
    const stepPaths = t.stepScreenshotPaths || [];
    for (let k = 0; k < stepPaths.length; k += 1) {
      const dest = `${run.id}-case-${evidenceIndex + 1}-step-${k + 1}.png`;
      const ok = await fsp.copyFile(stepPaths[k], path.join(evidenceDir, dest)).then(() => true).catch(() => false);
      stepScreenshots.push(ok ? `/evidence/${dest}` : '');
    }

    let traceUrl = '';
    if (t.tracePath) {
      const dest = `${run.id}-case-${evidenceIndex + 1}-trace.zip`;
      const ok = await fsp.copyFile(t.tracePath, path.join(evidenceDir, dest)).then(() => true).catch(() => false);
      if (ok) traceUrl = `/evidence/${dest}`;
    }

    evidence.push({
      title: t.title || cases[caseIndex]?.title || `Test case ${evidenceIndex + 1}`,
      testCaseIndex: caseIndex,
      url: targetUrl,
      screenshotUrl,
      stepScreenshots,
      traceUrl,
      status: t.status,
      reason: t.error || '',
      durationMs: t.durationMs,
      executed: true,
      capturedAt: new Date().toISOString(),
    });
  }
}

async function runScriptsAndCollectEvidence(run: any, targetUrl: string, testCases: any, liveCreds: any) {
  const rawScripts = (run.playwright_scripts || []) as any[];
  const scripts = rawScripts.map((s: any) => ({ filename: s.filename, title: s.test_case_title, code: s.code }));
  const cases = (testCases?.test_cases || run.generated_cases || []) as any[];
  const norm = normTitle;
  const selectorVerification = (run as any).selector_verification;
  const brokenScripts = rawScripts.filter((s: any) => s?.has_unresolved_selectors === true);
  const gateReason = !scripts.length
    ? 'No Playwright scripts found for evidence execution.'
    : selectorVerification && selectorVerification.ok === false
      ? selectorVerification.reason || 'Selector verification has unresolved selectors.'
      : brokenScripts.length
        ? `${brokenScripts.length} script(s) are flagged with unresolved selectors.`
        : '';
  if (gateReason) {
    (run as any).execution_result = {
      ok: false,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: scripts.length,
      durationMs: 0,
      error: gateReason,
      tests: [],
    };
    run.phases = {
      ...(run.phases || {}),
      evidence_capture: {
        status: 'skipped',
        reason: gateReason,
        completed_at: new Date().toISOString(),
      },
    };
    pushPhase(run, { agent: 'EvidenceAgent', status: 'skipped', output: gateReason });
    return [];
  }

  // Reliable mapping chain: executed test -> its spec file -> the script that
  // produced it (by filename) -> that script's test_case_title -> the case index.
  // Title match is only a secondary fallback; positional is the last resort.
  const titleByFile = new Map<string, string>();
  for (const s of scripts) if (s.filename) titleByFile.set(baseName(s.filename), norm(s.title));
  const caseIndexByTitle = new Map<string, number>();
  cases.forEach((c, i) => { if (!caseIndexByTitle.has(norm(c.title))) caseIndexByTitle.set(norm(c.title), i); });

  const resolveCaseIndex = (t: any, fallbackPos: number): number => {
    const viaFile = titleByFile.get(baseName(t.file));
    if (viaFile && caseIndexByTitle.has(viaFile)) return caseIndexByTitle.get(viaFile)!;
    const viaTitle = caseIndexByTitle.get(norm(t.title));
    if (viaTitle !== undefined) return viaTitle;
    return fallbackPos < cases.length ? fallbackPos : Math.max(0, cases.length - 1);
  };

  if (scripts.length) {
    try {
      // Log in ONCE and inject the authenticated session into every script, so the
      // generated tests never have to re-implement a brittle login against the SPA.
      let storageStatePath: string | undefined;
      let sessionStorageState: { origin: string; items: Record<string, string> } | undefined;
      let authStorageReady = false;
      let authSetupReason = '';
      try {
        const authPath = path.join(process.cwd(), '.testflow-pw', `${run.id}-auth.json`);
        const sessionPath = path.join(process.cwd(), '.testflow-pw', `${run.id}-session-storage.json`);
        const cached = authSessionCache.get(run.id);
        const cacheUsable = !!cached && Date.now() - cached.at < AUTH_SESSION_CACHE_TTL_MS
          && await fsp.access(cached.storageStatePath).then(() => true).catch(() => false);
        const diskState = !cached
          ? await fsp.stat(authPath).then((stat) => ({ fresh: Date.now() - stat.mtimeMs < AUTH_SESSION_CACHE_TTL_MS })).catch(() => null)
          : null;
        const diskSessionAvailable = !cached
          && await fsp.access(sessionPath).then(() => true).catch(() => false);
        if ((cached && cacheUsable) || (diskState?.fresh && diskSessionAvailable)) {
          storageStatePath = cached?.storageStatePath || authPath;
          sessionStorageState = cached?.sessionStorageState || await fsp.readFile(sessionPath, 'utf8')
            .then((raw) => JSON.parse(raw))
            .catch(() => undefined);
          authStorageReady = true;
          authSetupReason = 'Reused the authenticated session prepared earlier in this run.';
          if (!cached) authSessionCache.set(run.id, { at: Date.now(), storageStatePath });
        } else {
          if (cached) authSessionCache.delete(run.id);
          await fsp.mkdir(path.dirname(authPath), { recursive: true });
          const auth = await createAuthStorageState(targetUrl, liveCreds, authPath);
          sessionStorageState = auth.sessionStorage;
          authStorageReady = !!(auth.ok || sessionStorageState);
          authSetupReason = auth.reason || '';
          // When login succeeds, the storageState file contains cookies + localStorage; pair it
          // with captured sessionStorage so SPAs that keep auth there are truly logged in.
          if (authStorageReady) {
            storageStatePath = authPath;
            authSessionCache.set(run.id, { at: Date.now(), storageStatePath: authPath, sessionStorageState });
            if (sessionStorageState) await fsp.writeFile(sessionPath, JSON.stringify(sessionStorageState), 'utf8');
          }
        }
        if (authStorageReady) {
          run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: 'Browser session prepared for script execution.' });
          pushPhase(run, { agent: 'AuthSessionAgent', status: 'completed', output: 'Browser session prepared for script execution.' });
        } else {
          run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: 'Browser session setup was incomplete; scripts will continue with their own setup.' });
          pushPhase(run, { agent: 'AuthSessionAgent', status: 'failed', output: authSetupReason || 'Browser session setup was incomplete.' });
        }
      } catch (e: any) {
        authSetupReason = e?.message || String(e);
        run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Browser session setup error: ${e?.message || e}` });
        pushPhase(run, { agent: 'AuthSessionAgent', status: 'failed', output: authSetupReason });
      }

      const credentialsProvided = !!(liveCreds?.username && liveCreds?.password);
      const authPrepared = !credentialsProvided || !!(storageStatePath && authStorageReady);
      if (credentialsProvided && !authPrepared) {
        const reason = `Authentication setup failed before script execution${authSetupReason ? `: ${authSetupReason}` : ''}. Scripts were blocked to avoid repeated login attempts and account throttling.`;
        const evidence = cases.map((c, idx) => ({
          title: c.title || `Test case ${idx + 1}`,
          testCaseIndex: idx,
          url: targetUrl,
          screenshotUrl: '',
          status: 'not_executed',
          reason,
          executed: false,
          capturedAt: new Date().toISOString(),
        }));
        run.execution_result = {
          ok: false,
          total: 0,
          passed: 0,
          failed: 0,
          skipped: scripts.length,
          durationMs: 0,
          error: reason,
          tests: [],
        };
        run.evidence_screenshots = evidence as any;
        run.phases = {
          ...(run.phases || {}),
          evidence_capture: {
            status: 'skipped',
            reason,
            completed_at: new Date().toISOString(),
          },
        };
        pushPhase(run, { agent: 'EvidenceAgent', status: 'skipped', output: reason });
        await publishAgentRunSnapshot(run, 'agent evidence auth blocked');
        return evidence;
      }

      // Compiled scripts do not use model repair, so run them serially for per-case progress.
      // Legacy scripts continue to the batch evaluator below, where real failures trigger
      // the existing live re-inspection and bounded repair loop.
      if (scripts.length > 1 && aiqaCompilerEnabled()) {
        pushPhase(run, { agent: 'EvidenceQueue', status: 'running', output: 'Running evidence one script at a time with the shared authenticated session.' });
        const evidence: any[] = [];
        const usedCaseIndexes = new Set<number>();
        const allTests: any[] = [];
        const executionErrors: string[] = [];
        const startedAt = Date.now();
        run.evidence_screenshots = evidence as any;
        const q = (run as any).script_queue;
        if (q?.items) q.status = 'evidence_running';

        for (let i = 0; i < scripts.length; i += 1) {
          throwIfCancelled(run);
          const script = scripts[i];
          if (q?.items?.[i]) q.items[i] = { ...q.items[i], status: 'evidence_running' };
          pushPhase(run, { agent: 'EvidenceQueue', status: 'running', output: 'Running evidence ' + (i + 1) + '/' + scripts.length + ': ' + (script.filename || script.title || 'script') });
          const execOne = await executePlaywrightScripts({
            scripts: [script],
            baseUrl: targetUrl,
            runId: run.id + '-case-' + (i + 1),
            storageStatePath,
            sessionStorageState,
            singleSession: true,
            screenshotMode: 'on',
            actionTimeoutMs: 10000,
            navigationTimeoutMs: 20000,
            expectTimeoutMs: 15000,
            timeoutMs: 90000,
            emitMissionRunner: aiqaCompilerEnabled(), // compiled specs import ./mission-runner (dark by default)
          });
          throwIfCancelled(run);
          if (!execOne.ok) executionErrors.push(`${script.filename || script.title || `script ${i + 1}`}: ${execOne.error || 'no passing test result'}`);
          allTests.push(...(execOne.tests || []));
          await copyTestEvidenceToRun({
            run,
            tests: execOne.tests || [],
            cases,
            targetUrl,
            evidence,
            usedCaseIndexes,
            resolveCaseIndex,
            startIndex: i,
          });
          const failed = !execOne.ok || (execOne.tests || []).some((t: any) => /fail|timedout|interrupted/i.test(String(t.status)));
          if (q?.items?.[i]) {
            q.items[i] = { ...q.items[i], status: failed ? 'failed' : 'evidence_ready' };
            q.evidenced = q.items.filter((x: any) => ['evidence_ready', 'failed'].includes(String(x.status))).length;
          }
          run.execution_result = summarizeExecutionTests(allTests, Date.now() - startedAt, executionErrors.join(' | ') || undefined);
          run.evidence_screenshots = evidence as any;
          await publishAgentRunSnapshot(run, 'queued evidence progress');
        }

        cases.forEach((c, idx) => {
          if (!usedCaseIndexes.has(idx)) {
            evidence.push({
              title: c.title || `Test case ${idx + 1}`,
              testCaseIndex: idx,
              url: targetUrl,
              screenshotUrl: '',
              status: 'not_executed',
              reason: 'No Playwright result was produced for this case, so it was not executed.',
              executed: false,
              capturedAt: new Date().toISOString(),
            });
          }
        });
        run.execution_result = summarizeExecutionTests(allTests, Date.now() - startedAt, executionErrors.join(' | ') || undefined);
        run.evidence_screenshots = evidence as any;
        run.phases = {
          ...(run.phases || {}),
          evidence_capture: {
            status: run.execution_result.ok ? 'complete' : 'complete_with_failures',
            scripts_run: run.execution_result.total,
            passed: run.execution_result.passed,
            failed: run.execution_result.failed,
            skipped: run.execution_result.skipped,
            completed_at: new Date().toISOString(),
          },
        };
        if (q?.items) q.status = 'completed';
        pushPhase(run, { agent: 'EvidenceQueue', status: 'completed', output: evidence });
        await publishAgentRunSnapshot(run, 'agent queued evidence complete');
        return evidence;
      }

      let exec = await executePlaywrightScripts({
        scripts,
        baseUrl: targetUrl,
        runId: run.id,
        storageStatePath,
        sessionStorageState,
        singleSession: true,
        screenshotMode: 'only-on-failure',
        actionTimeoutMs: 10000,
        navigationTimeoutMs: 20000,
        expectTimeoutMs: 15000,
        emitMissionRunner: aiqaCompilerEnabled(), // compiled specs import ./mission-runner (dark by default)
      });

      // EXECUTION-REPAIR LOOP (Phase 3, evaluator-optimizer): the real Playwright result
      // is ground truth. When tests fail, feed the actual error + the observed DOM back to
      // the coder to fix the failing script, then re-run  -  up to a bounded budget. This is
      // the agent "fixing itself until the tests pass" instead of reporting a broken result.
      // Compiled scripts are deterministic products of verified evidence. A model repair would
      // reintroduce guessed selectors and hide infrastructure failures (for example, expired auth).
      const MAX_REPAIR_ROUNDS = aiqaCompilerEnabled() ? 0 : 2;
      // Re-inspect each failing case against the LIVE page at most once, then reuse across rounds.
      const freshContextByFile = new Map<string, any>();
      for (let round = 1; round <= MAX_REPAIR_ROUNDS && (exec.failed || 0) > 0; round += 1) {
        throwIfCancelled(run);
        const failing = (exec.tests || []).filter((t) => /fail|timedout|interrupted/i.test(String(t.status)));
        if (!failing.length) break;
        pushPhase(run, { agent: 'ExecutionRepair', status: 'running', output: `Round ${round}/${MAX_REPAIR_ROUNDS}: ${failing.length} failing test(s)  -  re-grounding against the live page, then repairing against the real failure.` });
        let repaired = 0;
        for (const t of failing) {
          throwIfCancelled(run);
          const idx = scripts.findIndex((s) => (s.filename && baseName(s.filename) === baseName(t.file)) || normTitle(s.title) === normTitle(t.title));
          if (idx < 0) continue;

          // RE-GROUND ON THE LIVE PAGE (fix for ungrounded "label not found"): the original
          // grounding came from ONE inspection drill toward the whole prompt, so selectors for
          // sub-features it never opened were guessed. Re-inspect the live app driving toward
          // THIS failing case's specific goal and feed the coder the REAL controls it finds.
          const fileKey = baseName(t.file) || normTitle(t.title);
          let freshContext = freshContextByFile.get(fileKey);
          if (freshContext === undefined) {
            freshContext = null;
            try {
              const reinspect = await inspectApplicationFlow({
                targetUrl,
                prompt: `${scripts[idx].title || t.title || run.prompt || ''}. Reach and reveal the exact controls this test needs.`,
                credentials: liveCreds,
                runId: `${run.id}-repair`,
                workspaceId: run.ownerId || 'default',
              });
              if (reinspect && ((reinspect.visibleNavigation || []).length || (reinspect.visibleTables || []).length || (reinspect.visibleForms || []).length)) {
                freshContext = reinspect;
              }
            } catch { /* fall back to the original inspection context */ }
            freshContextByFile.set(fileKey, freshContext);
          }
          const groundingContext = freshContext || run.inspection_context;

          try {
            const coder = await getOrchestrator('playwrightCoder', { workspaceId: run.ownerId || 'default', effort: run.requestedEffort });
            const res = await coder.generateObject<{ code: string }>({
              prompt: `A generated Playwright test FAILED when executed against the live app. Fix it.\n\nFailure error:\n${String(t.error || 'unknown failure').slice(0, 1500)}\n\nThe browser session is ALREADY AUTHENTICATED via an injected storage state, so there is usually NO login form at run time. Do NOT depend on logging in: if login steps exist, keep them but ensure EVERY login fill/click/waitForURL is guarded with .catch(() => {}) and a short timeout so it is a harmless no-op when no login form is present. NEVER use waitForLoadState('networkidle').\n\nWhat a fresh inspection of the LIVE page for THIS test's goal actually observed (use these REAL selectors/labels  -  do not invent; if a control you need is here, use its exact label/role/text):\n${JSON.stringify(compactInspectionContext(groundingContext))}\n\nCurrent failing test code:\n${String(scripts[idx].code || '').slice(0, 6000)}\n\nReturn the corrected full test file as {"code":"..."}. Keep the same test title. Prefer role/label/text selectors grounded in the observed page. Add resilient waits. Do not change what the test verifies. CRITICAL: if the failure is that the PRIMARY action did not happen (e.g. the export produced no download, or the setting toggle/save did not persist), fix the SELECTOR or interaction so the action ACTUALLY executes and its outcome assertion PASSES  -  you must NOT remove, soften, or wrap that primary action/assertion in .catch(() => {}) just to make the test green. Faking a pass is forbidden; the real action must occur.`,
              schema: z.object({ code: z.string() }),
              userMessage: 'Repair a failing Playwright test against the real execution error.',
            });
            let code = res?.object?.code;
            if (code && code.length > 80 && /test\(/.test(code)) {
              // Re-apply the deterministic guards (login guarding, networkidle strip, absolute
              // URL) + structural repair so a repair can never re-introduce the login hang.
              const guarded = ensureExecutableLogin({ ...scripts[idx], code }, liveCreds, targetUrl, (run as any).mission_context || missionContextFromRun(run));
              code = repairTestCode(sanitizeTestCode(guarded.code)) || guarded.code;
              // Only apply the static repo method-rewrite when the fresh live re-inspection of THIS
              // failing control was too thin to trust  -  otherwise it drags the selector the coder
              // just grounded against the real page back toward a repo homonym (re-introducing the
              // exact failure repair is meant to fix).
              const repairLiveUsable = buildLiveSelectorIndex({ inspection_context: groundingContext }).usable;
              const repairMap = getRunSelectorMap(run);
              if (repairMap && !repairLiveUsable) code = correctSelectorMethods(code, repairMap).code;
              code = normalizeSelectorsFromInspection(code, groundingContext || run.inspection_context);
              scripts[idx].code = code;
              const orig = (run.playwright_scripts || []).find((ps: any) => baseName(ps.filename) === baseName(scripts[idx].filename));
              if (orig) orig.code = code;
              repaired += 1;
            }
          } catch { /* keep the original script if repair fails */ }
        }
        pushPhase(run, { agent: 'ExecutionRepair', status: 'completed', output: `Repaired ${repaired} of ${failing.length} failing test(s)${repaired ? '  -  re-running.' : '  -  no fix produced, stopping repair.'}` });
        if (!repaired) break;
        await persistAgentScripts(run);
        // Re-run ONLY the repaired scripts, not the whole suite  -  re-running every already-passing
        // test on every repair round was multiplying wall time by up to MAX_REPAIR_ROUNDS+1 for no
        // reason. A distinct runId gives this subset its own empty tests dir (no stale spec files).
        const repairedFilenames = new Set(failing.map((t) => baseName(t.file)));
        const rerunScripts = scripts.filter((s) => s.filename && repairedFilenames.has(baseName(s.filename)));
        const rerunExec = await executePlaywrightScripts({
          scripts: rerunScripts.length ? rerunScripts : scripts,
          baseUrl: targetUrl,
          runId: `${run.id}-repair-${round}`,
          storageStatePath,
          sessionStorageState,
          singleSession: true,
          screenshotMode: 'only-on-failure',
          actionTimeoutMs: 10000,
          navigationTimeoutMs: 20000,
          expectTimeoutMs: 15000,
        });
        const mergedByTitle = new Map((exec.tests || []).map((t) => [normTitle(t.title), t]));
        for (const t of rerunExec.tests || []) mergedByTitle.set(normTitle(t.title), t);
        const mergedTests = Array.from(mergedByTitle.values());
        exec = {
          ...exec,
          tests: mergedTests,
          total: mergedTests.length,
          passed: mergedTests.filter((t) => t.status === 'passed').length,
          failed: mergedTests.filter((t) => /fail|timedout|interrupted/i.test(String(t.status))).length,
          skipped: mergedTests.filter((t) => t.status === 'skipped').length,
          durationMs: (exec.durationMs || 0) + (rerunExec.durationMs || 0),
          ok: mergedTests.every((t) => t.status === 'passed' || t.status === 'skipped'),
        };
      }

      // Persist the full result (incl. per-test pass/fail) so the Agent Console can
      // show it directly  -  no need to press "Run all scripts" a second time (G6).
      run.execution_result = {
        ok: exec.ok,
        total: exec.total,
        passed: exec.passed,
        failed: exec.failed,
        skipped: exec.skipped,
        durationMs: exec.durationMs,
        error: exec.error,
        stderrTail: exec.stderrTail,
        tests: (exec.tests || []).map((t) => ({ title: t.title, status: t.status, durationMs: t.durationMs, error: t.error })),
      };
      const executionText = `${exec.error || ''} ${(exec.tests || []).map((t) => t.error || '').join(' ')}`;
      if (!exec.ok && /auth|login|sign[ -]?in|unauthori[sz]ed|forbidden|session/i.test(executionText)) {
        authSessionCache.delete(run.id);
        await Promise.all([
          fsp.unlink(path.join(process.cwd(), '.testflow-pw', `${run.id}-auth.json`)).catch(() => undefined),
          fsp.unlink(path.join(process.cwd(), '.testflow-pw', `${run.id}-session-storage.json`)).catch(() => undefined),
        ]);
      }
      if (exec.tests && exec.tests.length) {
        run.phases = {
          ...(run.phases || {}),
          evidence_capture: {
            status: exec.failed === 0 ? 'complete' : 'complete_with_failures',
            scripts_run: exec.total,
            passed: exec.passed,
            failed: exec.failed,
            skipped: exec.skipped,
            completed_at: new Date().toISOString(),
          },
        };
        const evidenceDir = path.resolve(process.cwd(), 'evidence');
        await fsp.mkdir(evidenceDir, { recursive: true });
        const evidence: any[] = [];
        const usedCaseIndexes = new Set<number>();
        for (let i = 0; i < exec.tests.length; i += 1) {
          const t = exec.tests[i];
          // Reliable test -> case mapping (file -> script title -> case), with title
          // and positional fallbacks. Avoid two tests colliding on one case index.
          let caseIndex = resolveCaseIndex(t, i);
          if (usedCaseIndexes.has(caseIndex)) {
            const free = cases.findIndex((_, idx) => !usedCaseIndexes.has(idx));
            if (free >= 0) caseIndex = free;
          }
          usedCaseIndexes.add(caseIndex);
          let screenshotUrl = '';
          if (t.screenshotPath) {
            const dest = `${run.id}-case-${i + 1}.png`;
            const copied = await fsp.copyFile(t.screenshotPath, path.join(evidenceDir, dest))
              .then(() => true)
              .catch((e) => { console.warn(`[evidence] failed to copy screenshot for "${t.title}":`, e?.message || e); return false; });
            if (copied) screenshotUrl = `/evidence/${dest}`; // only expose a URL that actually has a file
          }
          // Copy each per-step screenshot the script attached, so the report can show
          // a distinct image for every step instead of one image per case.
          const stepScreenshots: string[] = [];
          const stepPaths = t.stepScreenshotPaths || [];
          for (let k = 0; k < stepPaths.length; k += 1) {
            const dest = `${run.id}-case-${i + 1}-step-${k + 1}.png`;
            const ok = await fsp.copyFile(stepPaths[k], path.join(evidenceDir, dest)).then(() => true).catch(() => false);
            stepScreenshots.push(ok ? `/evidence/${dest}` : '');
          }
          // Surface the Playwright trace (retain-on-failure) so a failed test can be
          // replayed step-by-step in the Trace Viewer  -  real, debuggable evidence.
          let traceUrl = '';
          if (t.tracePath) {
            const dest = `${run.id}-case-${i + 1}-trace.zip`;
            const ok = await fsp.copyFile(t.tracePath, path.join(evidenceDir, dest)).then(() => true).catch(() => false);
            if (ok) traceUrl = `/evidence/${dest}`;
          }
          evidence.push({
            title: t.title || cases[caseIndex]?.title || `Test case ${i + 1}`,
            testCaseIndex: caseIndex,
            url: targetUrl,
            screenshotUrl,
            stepScreenshots,
            traceUrl,
            status: t.status,
            reason: t.error || '',
            durationMs: t.durationMs,
            executed: true,
            capturedAt: new Date().toISOString(),
          });
        }
        // Flag any case that produced no script/test, so the report can show it
        // honestly as "not executed" instead of a silent green pass.
        cases.forEach((c, idx) => {
          if (!usedCaseIndexes.has(idx)) {
            evidence.push({
              title: c.title || `Test case ${idx + 1}`,
              testCaseIndex: idx,
              url: targetUrl,
              screenshotUrl: '',
              status: 'not_executed',
              reason: 'No Playwright script was generated for this case, so it was not executed.',
              executed: false,
              capturedAt: new Date().toISOString(),
            });
          }
        });
        return evidence;
      }
      run.execution_result = {
        ok: false,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: scripts.length,
        durationMs: exec.durationMs || 0,
        error: exec.error || 'Script execution produced no test results.',
        tests: [],
      };
      run.messages.push({ agent: 'EvidenceAgent', status: 'running', output: `Script execution produced no test results${exec.error ? `: ${exec.error}` : ''}. Falling back to base-URL evidence.` });
    } catch (err: any) {
      // Classify the failure (book Ch 12 taxonomy) so the degradation is reported honestly:
      // a 'degrade' is an expected graceful fallback; an 'escalate' means something needs a human.
      const decision = classifyFailure('execute', err);
      run.messages.push({
        agent: 'EvidenceAgent',
        status: 'running',
        output: `Script execution failed [${decision.action}: ${decision.reason}]: ${err?.message || err}. Falling back to base-URL evidence.`,
      });
      (run as any).execution_recovery = decision;
      run.execution_result = {
        ok: false,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: scripts.length,
        durationMs: 0,
        error: err?.message || String(err),
        tests: [],
      };
    }
  }
  // FALLBACK / graceful degradation: base-URL login + screenshot (original behaviour) when
  // scripts can't run  -  partial, honest evidence instead of a hard failure or a fake green.
  return capturePlaywrightEvidence(targetUrl, run.id, cases, liveCreds);
}

async function completeScriptProofFlow(run: any, targetUrl: string, testCases: any, liveCreds: any) {
  await persistAgentScripts(run);
  const selectorVerification = await verifyScriptsWithGitAgent(run, run.playwright_scripts, run.prompt || '');
  if (!selectorVerification.ok) {
    const why = selectorVerification.reason || 'Selector verification failed.';
    (run as any).execution_result = { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, error: why, tests: [] };
    markRunDone(run, 'failed');
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist selector verification artifacts:', err));
    persistDataInBackground('selector verification blocked evidence');
    return;
  }

  pushPhase(run, { agent: 'EvidenceAgent', status: 'running' });
  if (targetUrl) {
    const evidence = await runScriptsAndCollectEvidence(run, targetUrl, testCases, liveCreds);
    run.evidence_screenshots = evidence as any;
    pushPhase(run, { agent: 'EvidenceAgent', status: 'completed', output: evidence });
  } else {
    (run as any).execution_result = { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, error: 'No target URL was provided, so no browser proof was executed.', tests: [] };
    pushPhase(run, { agent: 'EvidenceAgent', status: 'skipped', output: 'No target URL was provided in chat and no Website Credentials row is selected for Playwright.' });
  }

  const proof = assessExecution((run as any).execution_result);
  if (!proof.ok && (run as any).execution_result && !(run as any).execution_result.error) {
    (run as any).execution_result.error = proof.reason;
  }
  markRunDone(run, proof.ok ? 'completed' : 'failed');
  await persistAgentRunArtifacts(run);
  await saveAgentRunState(run, 'agent proof flow completed');
}

async function copyExecutionScreenshots(runId: string, tests: any[]) {
  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });
  const screenshotUrls: string[] = [];
  for (const t of tests || []) {
    const paths = [...(t.stepScreenshotPaths || []), t.screenshotPath].filter(Boolean);
    for (let i = 0; i < paths.length; i += 1) {
      const dest = `${runId}-shot-${screenshotUrls.length + 1}.png`;
      const ok = await fsp.copyFile(paths[i], path.join(evidenceDir, dest)).then(() => true).catch(() => false);
      if (ok) screenshotUrls.push(`/evidence/${dest}`);
    }
  }
  return screenshotUrls;
}

export function registerAgentRoutes(app: Express) {
  // Graph terminal hook: materialize plan/suite/cases/run/report for graph runs (injected here
  // because runtime.ts cannot import this module — routes.ts already imports the runtime).
  registerTerminalArtifactPersister(persistAgentQualityArtifacts);
  // NOTE: authored cases are intentionally NOT auto-saved at the cases-review gate. The end user
  // curates them in the review UI and persists explicitly via "Save all" (/api/agent/save-cases).
  // Terminal persistence still runs for completed/automatic runs via the terminal persister above.

  // CODE-FLOW test endpoint: trace the complete flow from SOURCE (no live driving), transcribe
  // it deterministically into a script, and execute it.
  app.post('/api/agent/flow-test', async (req, res) => {
    try {
      const { goal, app_url, username, password, testData, projectId } = req.body || {};
      const repoPath = getProjectRepoPath(String(projectId || '')).trim();
      if (!repoPath) { res.status(400).json({ error: 'No repo bound to the project  -  FlowInspector needs source.' }); return; }
      const url = String(app_url || '');
      const creds = (username && password) ? { username: String(username), password: String(password) } : undefined;
      const { flow, sourceFiles, notes } = await inspectFlow({ goal: String(goal || ''), repoPath, testData: String(testData || ''), workspaceId: 'default' });
      const stepCount = (flow.steps || []).length;
      // A flow with no steps is a FAILURE of the tracer (e.g. the prompt overflowed), NOT a passing
      // test  -  the emitted script would be login-only and "pass" trivially. Report it honestly.
      if (stepCount === 0) {
        res.json({ steps: 0, summary: flow.summary, sourceFiles, notes, script: '', execution: { passed: 0, failed: 1, total: 1, tests: [{ status: 'failed', title: String(goal || ''), error: 'FlowInspector produced 0 steps (no flow traced)  -  not a real test.' }] } });
        return;
      }
      const script = flowToScript(String(goal || 'Flow test').slice(0, 80), { url, credentials: creds }, flow);
      const exec = await executePlaywrightScripts({ scripts: [{ filename: 'flow.spec.ts', title: 'flow', code: script }], baseUrl: url, runId: `flow-${randomUUID().slice(0, 8)}`, singleSession: true });
      res.json({
        steps: stepCount, summary: flow.summary, sourceFiles, notes, script,
        execution: { passed: exec.passed, failed: exec.failed, total: exec.total, tests: (exec.tests || []).map((t: any) => ({ status: t.status, title: t.title, error: t.error })) },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  async function planAuthorGoal(input: { goal: string; url: string; hasCredentials: boolean; testData: string; workspaceId: string }) {
    const fallback = {
      understoodGoal: input.goal,
      workflow: [input.goal].filter(Boolean),
      testData: input.testData,
      blockers: [] as string[],
    };
    try {
      const ai = await getOrchestrator('appInspector', { workspaceId: input.workspaceId || 'default' });
      const result = await ai.generateObject<any>({
        schema: z.object({
          understoodGoal: z.string().default(''),
          workflow: z.array(z.string()).default([]),
          testData: z.string().default(''),
          blockers: z.array(z.string()).default([]),
        }),
        userMessage: input.goal,
        prompt: `Turn this browser automation request into an execution plan before any browser action.
Target URL: ${input.url}
Saved credentials available: ${input.hasCredentials ? 'yes' : 'no'}
Existing test data hint: ${input.testData || '(none)'}

Rules:
- Understand the target app/module/tab/object from the wording.
- The target app URL is already selected. Never block because the request is brief or omits a module, tab, object, or detailed workflow; resolve those details from the live DOM.
- If the user asks for random test data, create concrete valid-looking values.
- Login is a silent setup step when saved credentials are available.
- The only valid blocker is that login is required but saved credentials are not available.
- Return only the real app workflow. Do not include QA assistant/chat/UI behavior.`,
      });
      const obj = result.object || {};
      return {
        understoodGoal: String(obj.understoodGoal || input.goal),
        workflow: Array.isArray(obj.workflow) ? obj.workflow.map(String).filter(Boolean).slice(0, 12) : fallback.workflow,
        testData: String(obj.testData || input.testData || ''),
        blockers: actionableAuthorBlockers(obj.blockers, input.hasCredentials),
      };
    } catch {
      return fallback;
    }
  }

  // AUTHOR-BY-DOING test endpoint: drive the goal live, emit the recorded script, execute it.
  app.post('/api/agent/author-test', async (req, res) => {
    try {
      const { goal, app_url, username, password, testData, websiteId } = req.body || {};
      const url = String(app_url || '');
      const resolved = resolveCredentials({ targetUrl: url, websiteId: String(websiteId || ''), ownerId: reqScope(req).userId })
        || resolveCredentials({ targetUrl: url, websiteId: String(websiteId || '') })
        || undefined;
      const settingsCreds = findSettingsCredentials(url);
      const creds = (username && password)
        ? { username: String(username), password: String(password) }
        : resolved?.username && resolved?.password
          ? { username: String(resolved.username), password: String(resolved.password) }
          : settingsCreds.username && settingsCreds.password
            ? { username: settingsCreds.username, password: settingsCreds.password }
          : undefined;
      const attention = await planAuthorGoal({ goal: String(goal || ''), url, hasCredentials: !!(creds?.username && creds?.password), testData: String(testData || ''), workspaceId: reqScope(req).userId || 'default' });
      if (attention.blockers.length) return res.status(400).json({ error: attention.blockers.join(' ') });
      const plannedGoal = `${attention.understoodGoal}\nWorkflow:\n${attention.workflow.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
      const result = await liveAuthor({ goal: plannedGoal, url, credentials: creds, testData: attention.testData, maxSteps: 14 });
      const script = emitScript(String(attention.understoodGoal || goal || 'Authored test').slice(0, 80), { url, credentials: creds }, result.steps);
      const runId = `author-${randomUUID().slice(0, 8)}`;
      const exec = await executePlaywrightScripts({ scripts: [{ filename: 'authored.spec.ts', title: 'authored', code: script }], baseUrl: url, runId, singleSession: true, screenshotMode: 'on' });
      const screenshotUrls = await copyExecutionScreenshots(runId, exec.tests || []);
      if (!screenshotUrls.length) {
        const fallback = await capturePlaywrightEvidence(url, runId, [{ title: String(goal || 'Authored script') }], creds).catch(() => []);
        for (const shot of fallback || []) if (shot?.screenshotUrl) screenshotUrls.push(shot.screenshotUrl);
      }
      res.json({
        attention,
        goalReached: result.goalReached, steps: result.steps.length, notes: result.notes, script, screenshotUrls,
        execution: { passed: exec.passed, failed: exec.failed, total: exec.total, tests: (exec.tests || []).map((t: any) => ({ status: t.status, title: t.title, error: t.error })) },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post('/api/agent/author-test/screenshots', async (req, res) => {
    try {
      const { script, app_url } = req.body || {};
      const code = String(script || '');
      const url = String(app_url || '');
      if (!code.trim()) return res.status(400).json({ error: 'script is required' });
      const settingsCreds = findSettingsCredentials(url);
      const runnableCode = settingsCreds.username && settingsCreds.password
        ? code
            .replace(/const\s+USERNAME\s*=\s*(['"]).*?\1\s*;?/m, `const USERNAME = ${JSON.stringify(settingsCreds.username)};`)
            .replace(/const\s+PASSWORD\s*=\s*(['"]).*?\1\s*;?/m, `const PASSWORD = ${JSON.stringify(settingsCreds.password)};`)
            .replace(/(getBy(?:Label|Placeholder)\([^)]*(?:email|user(?:name)?|login)[^)]*\)[\s\S]{0,80}\.fill\()\s*(['"]).*?\2(\s*[,)]?)/gi, `$1${JSON.stringify(settingsCreds.username)}$3`)
            .replace(/(getBy(?:Label|Placeholder)\([^)]*password[^)]*\)[\s\S]{0,80}\.fill\()\s*(['"]).*?\2(\s*[,)]?)/gi, `$1${JSON.stringify(settingsCreds.password)}$3`)
        : code;
      const runId = `author-rerun-${randomUUID().slice(0, 8)}`;
      const exec = await executePlaywrightScripts({
        scripts: [{ filename: 'authored-rerun.spec.ts', title: 'authored rerun', code: runnableCode }],
        baseUrl: url,
        runId,
        singleSession: true,
        screenshotMode: 'on',
      });
      res.json({
        screenshotUrls: await copyExecutionScreenshots(runId, exec.tests || []),
        execution: { passed: exec.passed, failed: exec.failed, total: exec.total, tests: (exec.tests || []).map((t: any) => ({ status: t.status, title: t.title, error: t.error })) },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  app.get('/api/ai/health', (req, res) => {
    res.json({
      providers: listConfiguredProviders(),
      defaultProvider: db.settings?.defaultProvider || 'gemini',
      cwd: process.cwd(),
      checkedAt: new Date().toISOString(),
    });
  });

  /**
   * Deep understanding is a LONG call (repo research + several model calls  -  minutes).
   * A single synchronous HTTP request dies at any reverse proxy's read timeout (the
   * production 504-at-60s failure that silently degraded every prod understanding to
   * the terse fallback card). So it now follows the same pattern as /api/agent/start:
   * POST returns a job id immediately; the client polls GET /:jobId (each poll is a
   * fast request, so no proxy timeout can kill the work).
   */
  const understandingJobs = new Map<string, { status: 'running' | 'done'; result?: any; createdAt: number }>();
  const UNDERSTANDING_JOB_TTL_MS = 30 * 60 * 1000;
  function pruneUnderstandingJobs() {
    const cutoff = Date.now() - UNDERSTANDING_JOB_TTL_MS;
    for (const [id, job] of understandingJobs) if (job.createdAt < cutoff) understandingJobs.delete(id);
  }

  async function computeUnderstanding(body: any, scope: { userId?: string; projectId?: string | null; appId?: string | null }): Promise<any> {
    const { prompt, originalRequest, contextPrompt, targetName, targetUrl, currentUnderstanding, correction, history, conversationId } = body || {};
    const rawPrompt = String(prompt || '').trim();
    const rawOriginalRequest = String(originalRequest || '').trim();
    const rawContextPrompt = String(contextPrompt || '').trim();
    const intentPrompt = [rawOriginalRequest, rawPrompt, rawContextPrompt].filter(Boolean).join('\n\n');
    const groundingPrompt = rawContextPrompt || [rawOriginalRequest, rawPrompt].filter(Boolean).join('\n\n');
    // Prior turns of this chat, so the understanding reflects the ongoing conversation
    // (e.g. "now do the same for the reports page" refers back to earlier messages).
    // Reconstructed server-side from the stored conversation (ledger + summary segments +
    // budgeted verbatim turns); the client-sent history is only the fallback.
    let historyBlock = '';
    try {
      const assembled = await assembleConversationContext({
        conversationId: typeof conversationId === 'string' && conversationId ? conversationId : undefined,
        fallbackHistory: history,
        currentMessage: intentPrompt,
        model: resolveModelForAgent('chatAssistant', resolveProviderForAgent('chatAssistant')),
        path: 'agent.understand-request',
      });
      historyBlock = assembled.promptBlock.trim() ? `${assembled.promptBlock.trim()}\n\n` : '';
    } catch (err: any) {
      console.warn('[understand] context assembly failed, falling back to client history:', err?.message || err);
      historyBlock = Array.isArray(history) && history.length
        ? `Conversation so far (oldest first):\n${history.slice(-16).map((m: any) => `${m?.role === 'assistant' ? 'assistant' : 'user'}: ${String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200)}`).filter((l: string) => l.length > 6).join('\n')}\n\n`
        : '';
    }
    const rawTargetUrl = String(targetUrl || '').trim();
    const rawTargetName = String(targetName || '').trim();

    const fallback = {
      understanding:
        `Here's what I understood:\n` +
        `- Target: ${rawTargetName ? `${rawTargetName} (${rawTargetUrl || 'URL not provided'})` : rawTargetUrl || 'Target not provided'}\n` +
        `- Task: ${rawPrompt}\n\n` +
        `Plan: log in to the target, perform the requested steps on the live app, verify the result, and capture screenshots as evidence.`,
      targetName: rawTargetName,
      targetUrl: rawTargetUrl,
      task: rawPrompt,
      plannedApproach: 'Log in, inspect the live app, generate test cases, create Playwright scripts, execute them, and capture screenshot evidence.',
      suggestedFolderName: suggestIntentFolderName(rawOriginalRequest || rawPrompt, rawTargetName)
        || buildFallbackArtifactName(rawOriginalRequest || rawPrompt, rawTargetUrl),
      confidence: 70,
      missingInfo: [] as string[],
      source: 'fallback',
    };

    const carriedScope = extractCarriedForwardScope(rawContextPrompt);
    if (!correction && carriedScope && isShortFollowUpAction(rawOriginalRequest || rawPrompt)) {
      return {
        ...fallback,
        understanding: buildCarriedForwardUnderstanding({
          task: rawPrompt,
          rawOriginalRequest,
          targetName: rawTargetName,
          targetUrl: rawTargetUrl,
          carriedScope,
        }),
        task: rawPrompt,
        plannedApproach: 'Use the previously grounded scope from this chat as the reviewed understanding, then continue the deep QA workflow.',
        confidence: 90,
        missingInfo: [],
        source: 'conversation_context',
      };
    }

    if (!correction && wantsCodeGroundedTestUnderstanding(intentPrompt)) {
      try {
        const targetLabel = rawTargetName || rawTargetUrl;
        const apps = targetLabel
          ? [{ name: rawTargetName || targetLabel, baseUrl: rawTargetUrl || targetLabel }]
          : undefined;
        const grounded = await answerAppQuestionFromCode(groundingPrompt || intentPrompt, {
          workspaceId: scope.userId || 'default',
          userId: scope.userId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
        });
        const understanding = stripCodebaseLocationsForAgentConsole(String(grounded || '').trim());
        if (understanding) {
          return {
            ...fallback,
            understanding,
            task: rawPrompt,
            plannedApproach: 'Use the codebase-grounded test areas above as the reviewed understanding, then draft human-reviewable cases.',
            // Intent-based: the feature the user asked about + target app — never the URL host.
            suggestedFolderName: suggestIntentFolderName(rawOriginalRequest || rawPrompt, rawTargetName)
              || buildFallbackArtifactName(rawOriginalRequest || rawPrompt, rawTargetUrl),
            confidence: 85,
            missingInfo: [],
            source: 'codebase',
          };
        }
      } catch {
        // Fall through to the concise confirmation generator/fallback below.
      }
    }

    try {
      const ai = await getOrchestrator('chatAssistant', { workspaceId: scope.userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt:
          `Interpret this QA automation request for a human confirmation card.\n\n` +
          historyBlock +
          `Original request: ${rawOriginalRequest || rawPrompt}\n` +
          (rawOriginalRequest && rawOriginalRequest !== rawPrompt ? `Router-extracted scope: ${rawPrompt}\n` : '') +
          (rawContextPrompt ? `Full carried-forward context for this follow-up:\n${rawContextPrompt}\n` : '') +
          `Detected target name: ${rawTargetName || 'not provided'}\n` +
          `Detected target URL: ${rawTargetUrl || 'not provided'}\n` +
          (currentUnderstanding ? `Current understanding:\n${String(currentUnderstanding)}\n` : '') +
          (correction ? `User correction/revision:\n${String(correction)}\n` : '') +
          `\nThe "understanding" field must be concise, user-facing plain text with these sections: Here's what I understood, Target, Task, Plan.\n` +
          `Also create "suggestedFolderName": a short, human-readable folder/artifact name based on the user's request and target app, e.g. "CRM - List View Actions". Do not use a full sentence.`,
        schema: z.object({
          understanding: z.string().min(20),
          targetName: z.string().default(''),
          targetUrl: z.string().default(''),
          task: z.string().default(''),
          plannedApproach: z.string().default(''),
          suggestedFolderName: z.string().default(''),
          confidence: z.number().min(0).max(100).default(70),
          missingInfo: z.array(z.string()).default([]),
        }),
        userMessage: rawPrompt,
      });
      return {
        ...fallback,
        ...result.object,
        understanding: stripCodebaseLocationsForAgentConsole(String(result.object?.understanding || fallback.understanding)),
        source: 'ai',
      };
    } catch (err: any) {
      return { ...fallback, source: 'fallback', error: getAIErrorMessage(err) };
    }
  }

  app.post('/api/agent/understand-request', (req, res) => {
    const body = req.body || {};
    if (!String(body.prompt || '').trim() && !String(body.contextPrompt || '').trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    pruneUnderstandingJobs();
    const scope = reqScope(req);
    const jobId = randomUUID();
    understandingJobs.set(jobId, { status: 'running', createdAt: Date.now() });
    // Run in the background; the job NEVER fails hard  -  computeUnderstanding already
    // degrades to the deterministic fallback payload on any model/research error.
    computeUnderstanding(body, { userId: scope.userId, projectId: scope.projectId, appId: scope.appId })
      .catch((err: any) => ({ understanding: '', source: 'fallback', error: getAIErrorMessage(err) }))
      .then((result) => {
        const job = understandingJobs.get(jobId);
        if (job) { job.status = 'done'; job.result = result; }
      });
    res.json({ job_id: jobId });
  });

  app.get('/api/agent/understand-request/:jobId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = understandingJobs.get(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Unknown or expired understanding job.' });
    if (job.status !== 'done') return res.json({ status: 'running' });
    res.json({ status: 'done', result: job.result });
  });

  app.get('/api/agent/understand-request/:jobId/events', (req, res) => {
    const jobId = String(req.params.jobId);
    if (!understandingJobs.has(jobId)) return res.status(404).json({ error: 'Unknown or expired understanding job.' });
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let closed = false;
    const send = () => {
      if (closed) return;
      const job = understandingJobs.get(jobId);
      if (!job) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Unknown or expired understanding job.' })}\n\n`);
        res.end();
        return;
      }
      if (job.status === 'done') {
        res.write(`event: done\ndata: ${JSON.stringify({ status: 'done', result: job.result })}\n\n`);
        res.end();
      } else {
        res.write(`event: status\ndata: ${JSON.stringify({ status: 'running' })}\n\n`);
      }
    };
    send();
    const timer = setInterval(send, 5000);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });

  app.get('/api/agent-runs', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const runs = await AgentRuns.list();
    res.json(scopeFilter(runs, reqScope(req)).map((run: any) => {
      // Truthful history: an orphaned graph run (dead process, no live pump) shows as failed, not a phantom
      // "running". Persist the heal in the background so the list read stays fast.
      const healed = orphanedRunFailure(run);
      if (healed) void reconcileRunIfOrphaned(run).catch(() => undefined);
      const shown = healed ?? run;
      return {
        ...shown,
        generated_cases: annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(shown.generated_cases || [], shown), shown),
      };
    }));
  });

  app.get('/api/agent-runs/:id/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(runStatusSnapshot(run));
  });

  app.get('/api/agent-runs/:id/events', async (req, res) => {
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let last = '';
    let closed = false;
    const send = async () => {
      if (closed) return;
      const current = await loadAgentRun(req.params.id);
      if (!current) {
        res.write(`event: deleted\ndata: {}\n\n`);
        res.end();
        return;
      }
      const snapshot = runStatusSnapshot(current);
      const sig = runStatusSignature(snapshot);
      if (sig !== last) {
        last = sig;
        res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } else {
        res.write(`: keep-alive\n\n`);
      }
      if (['completed', 'failed', 'review_required', 'coverage_options', 'cancelled'].includes(String(snapshot.status))) {
        res.write(`event: done\ndata: ${JSON.stringify(snapshot)}\n\n`);
        res.end();
      }
    };
    void send();
    const timer = setInterval(() => { void send(); }, 1500);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });

  app.get('/api/agent-runs/:id/details', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(runDetailsPayload(run));
  });

  app.get('/api/agent-runs/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (req.query.include === 'details') {
      return res.json(runDetailsPayload(run));
    }
    res.json(runStatusSnapshot(run));
  });

  app.delete('/api/agent-runs/:id', async (req, res) => {
    const idx = db.agentRuns.findIndex((r: any) => r.id === req.params.id);
    if (idx >= 0) db.agentRuns.splice(idx, 1);
    const removed = await AgentRuns.remove(req.params.id).catch(() => false);
    if (idx < 0 && !removed) return res.status(404).json({ error: 'Run not found' });
    persistDataInBackground('agent run delete');
    res.json({ success: true });
  });

  app.post('/api/agent/action', async (req, res) => {
    const { taskType, prompt } = req.body;

    const agentMap: Record<string, { agent: any; schema: any; pushToInbox?: boolean }> = {
      plan: {
        agent: 'testPlanner',
        schema: z.object({
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
          deliverables: z.string(),
        }),
      },
      suite: {
        agent: 'suiteDesigner',
        schema: z.object({
          name: z.string(),
          description: z.string(),
          parentSuite: z.string().optional(),
          module: z.string(),
          owner: z.string(),
          tags: z.array(z.string()),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          status: z.enum(['Active', 'Draft', 'Deprecated']),
        }),
      },
      case: {
        agent: 'caseWriter',
        schema: z.object({
          title: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
          type: z.enum(['Manual', 'Automated']),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
      },
      run: {
        agent: 'runNamer',
        schema: z.object({ name: z.string() }),
      },
      defect: {
        agent: 'defectTriage',
        schema: z.object({
          title: z.string(),
          severity: z.enum(['Low', 'Medium', 'High', 'Critical']),
        }),
      },
    };

    const config = agentMap[taskType];
    if (!config) return res.status(400).json({ error: 'Invalid taskType' });

    try {
      const ai = await getOrchestrator(config.agent, { workspaceId: reqScope(req).userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt: String(prompt || ''),
        schema: config.schema,
        userMessage: String(prompt || ''),
      });
      if ((result as any).shortCircuit) {
        return res.status(422).json({ error: (result as any).shortCircuit });
      }
      res.json(result.object);
    } catch (err: any) {
      console.error(err);
      const status = Number(err?.status);
      res.status(status >= 400 && status <= 599 ? status : 502).json({ error: getAIErrorMessage(err) });
    }
  });

  // TARGET PRE-FLIGHT: the console calls this BEFORE any research/understanding. When the
  // request doesn't name its target, it returns the platform's REAL options (RUNTIME apps with
  // their tabs / ADMIN navigations) so the user picks from a dropdown up front — the run never
  // burns minutes of research before discovering the target was ambiguous.
  app.post('/api/agent/target-options', async (req, res) => {
    try {
      const scope = reqScope(req);
      const prompt = String(req.body?.prompt || '').trim();
      const selectedApp = scope.appId ? getApp(scope.appId) : undefined;
      const appUrl = String(req.body?.app_url || selectedApp?.baseUrl || '').trim();
      if (!prompt) return res.json({ needsChoice: false });
      // No target configured anywhere — tell the client explicitly so it can guide the user
      // to set up a project/app instead of silently proceeding into an untargeted flow.
      if (!appUrl) return res.json({ needsChoice: false, reason: 'no-target-configured' });

      const platform = platformTypeFromSurface(selectedApp?.name || '', appUrl);
      if (platform === 'ADMIN') {
        // Ambiguous when the prompt names a feature (e.g. "list view") but no admin module —
        // offer the side-nav modules PARSED FROM THE BOUND REPO so the user pins the target.
        const navModules = loadAdminNavModules(getProjectRepoPath(scope.projectId || ''));
        if (!navModules.length) return res.json({ needsChoice: false });
        // "in admin" names the PLATFORM, not a module — strip platform words so they can't
        // satisfy the module detector ("list view in admin" is still module-ambiguous).
        const promptForGate = prompt.replace(/\b(in|on|at|for)\s+(the\s+)?(admin(istrator)?(\s*-?\s*ui)?|platform)\b/gi, ' ');
        const namesModule = navModules.some((m) => prompt.toLowerCase().includes(m.name.toLowerCase()) || prompt.toLowerCase().includes(m.id.replace(/_/g, ' ')));
        if (namesModule || !needsExplicitListViewModule(promptForGate, '')) return res.json({ needsChoice: false });
        return res.json({
          needsChoice: true,
          app_options: {
            surface: selectedApp?.name || 'Admin',
            platform: 'ADMIN',
            allowAllApps: false,
            apps: navModules.map((m) => ({ id: m.id, name: m.name, group: m.group, tabs: [] })),
          },
        });
      }

      // RUNTIME: ambiguous unless the prompt names an app (or explicitly asks for all apps).
      const credentials = resolveCredentials({ targetUrl: appUrl, ownerId: scope.userId || undefined }) || ({} as any);
      if (!credentials.username && !(credentials as any).token) return res.json({ needsChoice: false });
      const conn = connForRun(appUrl, credentials, selectedApp?.specPath);
      const apps = await fetchCorePlatformApps(conn).catch(() => []);
      if (!apps.length || wantsGenericOrAllApps(prompt)) return res.json({ needsChoice: false });
      const picked = resolveTargetApp(apps, prompt);
      if (picked.app) return res.json({ needsChoice: false });
      const candidates = picked.candidates.slice(0, 20);
      const optionApps = await Promise.all(candidates.map(async (a: any) => {
        const tabs = await fetchCorePlatformAppTabs(conn, a.id).catch(() => []);
        const tabNames = [...new Set(tabs.map((t: any) => t.label || t.object_api_name).filter(Boolean))].slice(0, 12) as string[];
        return { id: String(a.id), name: String(a.label), tabs: tabNames };
      }));
      return res.json({
        needsChoice: true,
        app_options: {
          surface: selectedApp?.name || 'this runtime',
          platform: 'RUNTIME',
          allowAllApps: !isMutationIntent(prompt),
          apps: optionApps,
        },
      });
    } catch (err: any) {
      // Pre-flight is advisory — never block the flow on its failure.
      console.warn(`[agent] target-options failed: ${err?.message || err}`);
      res.json({ needsChoice: false });
    }
  });

  app.post('/api/agent/start', async (req, res) => {
    const { app_url, prompt } = req.body;
    const conversationId = String(req.body.conversationId || req.body.agentConsoleId || req.body.sessionId || '').trim();
    let approvedUnderstanding = String(req.body.approvedUnderstanding || '').trim();
    const understandingSource = String(req.body.understandingSource || '').trim();
    let priorGrounding = String(req.body.priorGrounding || approvedUnderstanding || '').trim();
    // The conversation that led here, so case generation is grounded in what was actually
    // discussed (e.g. the Admin objects/users/permissions), not just the prompt string.
    let chatHistory: Array<{ role: string; content: string }> = Array.isArray(req.body.history) ? req.body.history : [];
    let conversationMemory = '';
    if (conversationId) {
      const storedConversation = await ChatConversations.get(conversationId).catch(() => null);
      if (storedConversation?.turns?.length) {
        chatHistory = storedConversation.turns.map((turn: any) => ({
          role: turn?.role === 'assistant' ? 'assistant' : 'user',
          content: String(turn?.content ?? turn?.text ?? turn?.summary ?? '').trim(),
        })).filter((turn: any) => turn.content);
      }
      conversationMemory = await loadConversationHandoff(conversationId).catch(() => '');
      approvedUnderstanding ||= conversationMemory;
    }
    // 0 (or absent) means "auto"  -  let the depth of the source understanding decide
    // the count. A positive number is an explicit user request and is honored as-is.
    // Honor the user's wish: an explicit count from the UI field OR parsed from the prompt
    // ("Generate 5 test cases ...") wins. 0 means "auto"  -  the flow/complexity decides.
    const requestedCaseCount = Math.max(0, Math.floor(Number(req.body.testCaseCount) || 0)) || parseCaseCount(prompt || '');
    const flowMode = req.body.flowMode === 'review_cases' ? 'review_cases' : 'complete';

    // Layered guardrail pipeline. If the pipeline short-circuits (greeting, off-topic, etc.)
    // we return a chat_response instead of starting a run.
    const pipeline = runGuardrailPipeline({
      agent: 'chatAssistant',
      userMessage: prompt || app_url || '',
    });
    if (pipeline.policyVerdict.kind === 'respond') {
      return res.json({ chat_response: pipeline.policyVerdict.reply });
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      return res.status(pipeline.policyVerdict.code).json({ error: pipeline.policyVerdict.error });
    }

    // Resolve the selected Project/App context. A selected app makes the agent's target
    // and grounding deterministic: its base URL drives the Playwright target and its name
    // sharpens knowledge-pack matching, instead of guessing from the prompt.
    const scope = reqScope(req);
    const selectedApp = scope.appId ? getApp(scope.appId) : undefined;
    const selectedProject = scope.projectId ? getProject(scope.projectId) : undefined;
    const priorSessionRun = latestRunForConversation(conversationId, scope);
    if (priorSessionRun) {
      approvedUnderstanding ||= String(priorSessionRun.approvedUnderstanding || '').trim();
      priorGrounding ||= String(priorSessionRun.priorGrounding || priorSessionRun.approvedUnderstanding || '').trim();
    }
    approvedUnderstanding = stripScriptBlocksFromScope(approvedUnderstanding);
    priorGrounding = stripScriptBlocksFromScope(priorGrounding);
    const scopeContextText = [selectedProject?.name, selectedApp?.name].filter(Boolean).join(' ');
    const explicitModuleId = String(req.body.moduleId || req.body.module || '').trim();
    // Admin-only question: its examples (Apps/Objects/Roles/Users) are Admin modules. A RUNTIME surface
    // (keystone/shockwave) falls through to the app-resolution flow below, which asks with the REAL
    // app list + tabs instead of admin module names.
    const provisionalPlatform = platformTypeFromSurface(selectedApp?.name || '', app_url || selectedApp?.baseUrl || '');
    if (provisionalPlatform === 'ADMIN' && needsExplicitListViewModule(prompt || '', explicitModuleId)) {
      // Structured options drive the console's dropdown card (ids = admin URL nav keys);
      // chat_response stays as the plain-text fallback and still accepts a typed module reply.
      // Repo-parsed side-nav modules drive the dropdown; when the repo has none the plain
      // question remains (older behavior) and the user can type the module name.
      const adminNavModules = loadAdminNavModules(getProjectRepoPath(scope.projectId || ''));
      return res.json({
        chat_response: 'Which list view should I test? Name the module or record type, for example Apps, Objects, Roles, or Users.',
        ...(adminNavModules.length ? {
          app_options: {
            surface: selectedApp?.name || 'Admin',
            platform: 'ADMIN',
            allowAllApps: false,
            apps: adminNavModules.map((m) => ({ id: m.id, name: m.name, group: m.group, tabs: [] })),
          },
        } : {}),
      });
    }
    const appScopeQuestion = needsExplicitAppScope(prompt || '', selectedApp, app_url || '', getProjectRepoPath(scope.projectId || '').trim());
    if (appScopeQuestion) {
      return res.json({ chat_response: appScopeQuestion });
    }

    // Precedence: an explicit URL the user typed > the selected app's base URL > prompt parsing.
    // `let` because app-within-surface targeting (below) may deep-link this into a specific app.
    let targetUrl = resolveAgentTargetUrl(prompt || '', app_url || selectedApp?.baseUrl || '');
    const surfaceBaseUrl = app_url || selectedApp?.baseUrl || targetUrl;

    // Resolve credentials through the new multi-website, multi-user model.
    // Fall back to inline credentials if the user pasted them in chat.
    const resolvedCreds = resolveCredentials({
      targetUrl,
      userId: req.body.credentialUserId,
      role: req.body.credentialRole,
      websiteId: req.body.websiteId,
      websiteName: req.body.websiteName || selectedApp?.name,
      inline: req.body.inlineCredentials,
      ownerId: scope.userId || undefined,
    }) || (req.body.websiteName ? resolveCredentials({
      websiteName: req.body.websiteName,
      role: req.body.credentialRole,
      inline: req.body.inlineCredentials,
      ownerId: scope.userId || undefined,
    }) : null);
    const inlineRequestCreds = (() => {
      const inline = req.body.inlineCredentials || {};
      const username = String(inline.username || '').trim();
      const password = String(inline.password || '');
      if (!username || !password) return null;
      return {
        username,
        password,
        siteName: String(inline.siteName || req.body.websiteName || '').trim(),
        baseUrl: targetUrl,
        environment: 'unknown',
        source: 'request-body',
      };
    })();
    const credentials = resolvedCreds || inlineRequestCreds || (() => {
      const settingsCreds = findSettingsCredentials(targetUrl);
      if (settingsCreds.username && settingsCreds.password) {
        return { ...settingsCreds, siteName: '', baseUrl: targetUrl, environment: 'unknown' };
      }
      const envUser = process.env.TARGET_USERNAME || process.env.ADMIN_USERNAME || '';
      const envPass = process.env.TARGET_PASSWORD || process.env.ADMIN_PASSWORD || '';
      if (envUser && envPass) {
        return { username: envUser, password: envPass, siteName: '', baseUrl: targetUrl, environment: 'unknown', source: 'env' };
      }
      return { username: '', password: '', siteName: '', baseUrl: targetUrl, environment: 'unknown', source: 'none' };
    })();
    // -- App-within-surface targeting ----------------------------------------------------------
    // The platform surface hosts many individual apps (resolved from the live API).
    // The user names one in the prompt; resolve it to the platform's real app id (from the live
    // apps API using this surface's creds), then deep-link the target URL into that app so every
    // downstream phase (inspection, metadata, evidence) runs INSIDE it. Best-effort: on any failure
    // we fall back to targeting the bare surface. If the surface has apps but the prompt names none
    // (and doesn't ask for "all apps"), we ASK which app instead of guessing.
    let targetCoreAppId = '';
    let targetAppLabel = '';
    let targetAppObjects: string[] = [];
    // -- Target Resolution (Phase 2): the SINGLE place that determines platform / application / module /
    // targetUrl, materialized as one immutable MissionContext. The Agent Console selection is
    // AUTHORITATIVE; prompt text is advisory and NEVER overrides an explicit platform/application/module.
    const explicitPlatform = String(req.body.platform || req.body.platformType || '').toUpperCase();
    const platformType: 'ADMIN' | 'RUNTIME' = (explicitPlatform === 'ADMIN' || explicitPlatform === 'RUNTIME')
      ? (explicitPlatform as 'ADMIN' | 'RUNTIME')
      : platformTypeFromSurface(selectedApp?.name || '', surfaceBaseUrl);
    const navInUrl = moduleFromUrl(surfaceBaseUrl);
    const selectedModule = explicitModuleId
      ? { id: explicitModuleId, name: String(req.body.moduleName || explicitModuleId).trim() }
      : (navInUrl ? { id: navInUrl, name: navInUrl } : null);
    let mission: MissionContext;

    if (platformType === 'ADMIN') {
      // ADMIN: the Admin Platform itself. NO application, NO appId, NO app discovery. Prompt text can
      // never turn an Admin mission into a tenant-app mission.
      mission = buildMissionContext({ platformType: 'ADMIN', baseUrl: surfaceBaseUrl, module: selectedModule || undefined });
    } else {
      // RUNTIME: application is REQUIRED. An explicit UI application selection is authoritative; only
      // when NONE was selected do we fall back to advisory, prompt-based resolution (backward compat).
      const runtimeSurface = (String(req.body.runtimeSurface || '').toLowerCase() as RuntimeSurface)
        || runtimeSurfaceFromSurface(selectedApp?.name || '', surfaceBaseUrl);
      const explicitAppId = String(req.body.applicationId || '').trim();
      let application: { id: string; name: string } | null = explicitAppId
        ? { id: explicitAppId, name: String(req.body.applicationName || explicitAppId).trim() }
        : null;

      if (!application && surfaceBaseUrl && (credentials.username || (credentials as any).token)) {
        const conn = connForRun(surfaceBaseUrl, credentials, selectedApp?.specPath);
        const apps = await fetchCorePlatformApps(conn).catch(() => []);
        if (apps.length) {
          const historyText = (chatHistory || []).filter((m) => m.role === 'user').map((m) => String(m.content || '')).slice(-4).join(' ');
          const targetText = `${prompt || ''} ${historyText}`.trim();
          const picked = wantsGenericOrAllApps(targetText)
            ? { allApps: true, app: null as any, candidates: apps }
            : resolveTargetApp(apps, targetText);
          if (picked.allApps) {
            application = { id: ALL_APPS_ID, name: 'All apps' };
          } else if (picked.app) {
            application = { id: picked.app.id, name: picked.app.label };
          } else {
            // Show each app WITH its tabs so the user can pick a target. Structured `app_options`
            // drives the console's dropdown card; `chat_response` remains the plain-text fallback
            // for older clients (and still accepts a typed reply like "CRM Accounts list view").
            const candidates = picked.candidates.slice(0, 20);
            const optionApps = await Promise.all(candidates.map(async (a) => {
              const tabs = await fetchCorePlatformAppTabs(conn, a.id).catch(() => []);
              const tabNames = [...new Set(tabs.map((t: any) => t.label || t.object_api_name).filter(Boolean))].slice(0, 12) as string[];
              return { id: String(a.id), name: String(a.label), tabs: tabNames };
            }));
            const lines = optionApps.slice(0, 8).map((a) => `- ${a.name}${a.tabs.length ? ` — tabs: ${a.tabs.join(', ')}` : ''}`);
            const more = picked.candidates.length > 8 ? `\n(and ${picked.candidates.length - 8} more apps)` : '';
            return res.json({
              chat_response: `Which app should I test in ${selectedApp?.name || 'this runtime'}?\n\n${lines.join('\n')}${more}\n\nReply with the app name and optionally a tab (e.g. "CRM Accounts list view"), or say "all apps" to sweep every app.`,
              app_options: {
                surface: selectedApp?.name || 'this runtime',
                platform: 'RUNTIME',
                // Mutating goals must target ONE concrete app (see scope hardening below).
                allowAllApps: !isMutationIntent(prompt || ''),
                apps: optionApps,
              },
            });
          }
        }
      }
      // Scope hardening: a data-mutating goal may NEVER sweep every app — the mutation would land in an
      // arbitrary tenant app (observed: a create scoped __all_apps__ wrote into App1 and still PASSED).
      // Ask for ONE concrete app instead of executing; read-only all-apps sweeps stay allowed.
      if (application && application.id === ALL_APPS_ID && isMutationIntent(prompt || '')) {
        return res.json({
          chat_response: 'This goal creates or changes data, so it needs ONE concrete app — an all-apps sweep would write into an arbitrary app. Reply with the app to target (e.g. its name), and I\'ll run it there.',
        });
      }
      // Real-app tabs → object nav defaulting (keystone deep-links into an object).
      if (application && application.id && application.id !== ALL_APPS_ID && (credentials.username || (credentials as any).token)) {
        const conn = connForRun(surfaceBaseUrl, credentials, selectedApp?.specPath);
        const tabs = await fetchCorePlatformAppTabs(conn, application.id).catch(() => []);
        targetAppObjects = [...new Set(tabs.map((t) => t.object_api_name).filter(Boolean))];
      }
      mission = buildMissionContext({
        platformType: 'RUNTIME',
        baseUrl: surfaceBaseUrl,
        runtimeSurface: runtimeSurface || null,
        application,
        module: selectedModule || { id: 'objects', name: 'Objects' },
      });
    }
    // Downstream stages consume run.app_url / target_core_app_id / target_app_label unchanged — those
    // are now a PROJECTION of the one MissionContext (backward compatible; no downstream code changes).
    targetUrl = mission.targetUrl;
    targetCoreAppId = mission.application?.id || '';
    targetAppLabel = mission.application?.name || '';
    const priorEvidenceRun = priorSessionRun && sameMissionEvidenceScope(
      priorSessionRun.mission_context || missionContextFromRun(priorSessionRun),
      mission,
    ) ? priorSessionRun : null;

    // Mask passwords in any persisted run record; the live agent gets the real
    // value from the resolved credential in memory only.
    const safeCredentialsForLog = {
      ...credentials,
      password: credentials.password ? maskPassword(credentials.password) : '',
    };

    const exactAppName = String(req.body.websiteName || (resolvedCreds as any)?.websiteName || (resolvedCreds as any)?.siteName || selectedApp?.name || '').trim();
    const selectedQaContext = buildSelectedQaContext({
      testPlanId: req.body.testPlanId,
      testSuiteId: req.body.testSuiteId,
      testCaseId: req.body.testCaseId,
    });
    // -- Folder gate: nothing starts without a folder to save into ------------------------------
    // Require an EXPLICIT folder  -  a selected folder id, or a folder name the user mentioned  -  and
    // do NOT silently auto-create an inferred one. This guarantees every artifact this run produces
    // (plan, suite, cases, run, requirements, reports, defects) lands in a folder the user chose and
    // can find, instead of a machine-named folder they never see.
    // Only an EXPLICIT folder the user chose counts: a selected folder id, or a folder name they
    // supplied in the folderMention field. Do NOT infer one from the prompt text  -  the prompt is the
    // test request (and derived context can contain stray @tokens like "@bvt" that would falsely
    // look like an @folder mention and bypass this gate).
    const explicitFolderId = !!(req.body.folderId && db.folders.some((f: any) => f.id === req.body.folderId));
    const explicitFolderMention = !!String(req.body.folderMention || '').trim();
    if (!explicitFolderId && !explicitFolderMention) {
      const existing = [...new Set((db.folders as any[]).map((f: any) => getFolderPath(f.id)).filter(Boolean))].slice(0, 25);
      const listing = existing.length ? `\n\nExisting folders: ${existing.join(' - ')}` : '';
      return res.json({
        chat_response: `Before I start, which folder should I save this under? Pick an existing folder or name a new one  -  I won't begin a run without a folder, so every test plan, suite, case, run, requirement, report and defect stays together and easy to find.${listing}\n\nTip: say it in the prompt, e.g. "test the list view, save under Regression".`,
      });
    }

    const folder = resolveFolderForAgent({
      folderId: req.body.folderId,
      folderMention: req.body.folderMention,
      prompt: prompt || '',
      targetUrl,
    });
    if (folder) {
      Object.assign(folder, scopeStamp(scope));
      folder.path = getFolderPath(folder.id);
      await ensureFolderInPg(folder.id);
      if (!isPgEnabled()) persistDataInBackground('agent folder');
      addActivity(`Agent folder ready: ${folder.path}`);
    }
    const taskId = randomUUID();
    const requestedProvider = req.body.provider || '';
    const requestedModel = req.body.model || '';
    const requestedEffort = req.body.effort || '';
    const runProvider = requestedProvider || resolveProviderForAgent('chatAssistant');
    // Ground the run in the relevant slice of the app-knowledge pack (retrieved per request).
    // Smaller budget for the inspector (it runs in a loop), generous for the one-shot case writer.
    const knowledgeCtx = { knowledgePackId: selectedApp?.knowledgePackId || undefined, websiteId: req.body.websiteId, targetUrl, text: `${scopeContextText} ${prompt || ''} ${approvedUnderstanding}`.trim(), ownerId: scope.userId || '' };
    const inspectorKnowledge = buildKnowledgeBlock(knowledgeCtx, { maxChars: 3500 });

    const newRun = {
      id: taskId,
      app_url: targetUrl,
      provider: runProvider,
      prompt: prompt || '',
      approvedUnderstanding,
      conversationMemory,
      understandingSource,
      priorGrounding,
      conversationId,
      previousAgentRunId: priorSessionRun?.id || '',
      websiteId: req.body.websiteId || '',
      projectId: scope.projectId || '',
      appId: scope.appId || '',
      ownerId: scope.userId || '',
      projectName: selectedProject?.name || '',
      appName: exactAppName,
      status: 'running',
      messages: [] as any[],
      generated_cases: [],
      playwright_scripts: [],
      evidence_screenshots: [],
      phases: {} as any,
      metadata_map: null as any,
      context_matrix: null as any,
      inspection_contexts: priorEvidenceRun?.inspection_contexts || [] as any[],
      selector_registry: priorEvidenceRun?.selector_registry || null as any,
      inspection_context: priorEvidenceRun?.inspection_context || null as any,
      folderId: folder?.id || '',
      folderPath: folder ? getFolderPath(folder.id) : 'Uncategorized',
      selectedQaContext: selectedQaContext.context,
      testPlanId: req.body.testPlanId || '',
      testSuiteId: req.body.testSuiteId || '',
      testCaseId: req.body.testCaseId || '',
      credentials: safeCredentialsForLog,
      // Stamp only when real context resolved it; empty lets agentDisplayName resolve contextually
      // LATER (mission is often known only after target clarification) instead of freezing the
      // host-derived fallback at creation time.
      artifactName: buildContextualArtifactName({
        appLabel: targetAppLabel,
        appName: exactAppName || mission?.application?.name,
        moduleName: mission?.module?.name || mission?.tab?.name,
        prompt,
      }),
      created_at: new Date(),
      completed_at: null as string | null,
      review_started_at: null as string | null,
      paused_ms: 0,
      feature_understanding: null as any,
      feature_inventory: priorSessionRun?.feature_inventory || null as any,
      application_context: priorSessionRun?.application_context || null as any,
      application_context_prompt: priorSessionRun?.application_context_prompt || '',
      application_context_cache_key: priorSessionRun?.application_context_cache_key || '',
      requested_case_count: 0,
      selected_qa_prompt_text: '',
      scope_context_text: priorSessionRun?.scope_context_text || '',
      chat_history: chatHistory,
      existing_matches: [] as any[],
      session_context: priorSessionRun ? {
        runId: priorSessionRun.id,
        capturedAt: priorSessionRun.updatedAt || priorSessionRun.updated_at || priorSessionRun.createdAt || priorSessionRun.created_at,
        approvedUnderstanding: priorSessionRun.approvedUnderstanding || '',
        priorGrounding: priorSessionRun.priorGrounding || '',
        inspection_context: priorEvidenceRun?.inspection_context || null,
        inspection_contexts: priorEvidenceRun?.inspection_contexts || [],
        selector_registry: priorEvidenceRun?.selector_registry || null,
        generated_cases: priorSessionRun.generated_cases || [],
        playwright_scripts: priorSessionRun.playwright_scripts || [],
        evidence_screenshots: priorEvidenceRun?.evidence_screenshots || [],
        execution_result: priorSessionRun.execution_result || null,
      } : null,
      // Resolved individual app within the surface (platform app id, e.g. app0000006), so every
      // phase scopes to that app. Empty when targeting the bare surface / all apps.
      target_core_app_id: targetCoreAppId,
      target_app_label: targetAppLabel,
      // Phase 2: the immutable MissionContext that single-handedly resolved this run's target. Every
      // stage should consume this instead of independently re-deriving platform/application/module.
      mission_context: mission,
      target_app_objects: targetAppObjects,
      requestedProvider,
      requestedModel,
      requestedEffort,
    };
    newRun.messages.push({
      agent: 'System',
      status: 'completed',
      output: `${selectedApp ? `Context: ${selectedProject?.name || 'project'} > ${selectedApp.name}. ` : selectedProject ? `Context: ${selectedProject.name} (project-level). ` : ''}Resolved target: ${targetUrl || 'none'}. Repository folder: ${folder ? getFolderPath(folder.id) : 'Uncategorized'}. QA scope: ${selectedQaContext.hasContext ? 'selected plan/suite/case context' : 'prompt only'}.`,
    });
    pushPhase(newRun, {
      agent: 'ScopeAgent',
      status: 'completed',
      output: `${targetAppLabel || selectedApp?.name || selectedProject?.name || 'Target'} -> ${targetUrl || 'none'}`,
    });

    if (approvedUnderstanding) {
      newRun.messages.push({
        agent: 'System',
        status: 'completed',
        output: `Approved understanding:\n${approvedUnderstanding}`,
      });
    }

    db.agentRuns.unshift(newRun);
    saveAgentRunStateSoon(newRun, 'new agent run');
    // Conversational Runtime Phase 6: the session now knows a run is in flight.
    projectRunLifecycleSafe({ run: newRun, phase: 'started' });
    res.json({ task_id: taskId });

    // COST QUOTA (book Ch 16: Resource-Aware Optimization): if this project has already burned
    // its daily budget, refuse to start the (expensive) pipeline rather than overspending. The
    // response is already sent, so we just stop here with an honest, surfaced reason.
    const quota = isProjectOverQuota(newRun.ownerId || 'default');
    if (quota.over) {
      pushPhase(newRun, {
        agent: 'System',
        status: 'failed',
        output: `Daily AI cost quota reached for this project ($${quota.usedUsd.toFixed(2)} of $${quota.quotaUsd.toFixed(2)}). Not starting a new run until the quota resets or is raised in Settings.`,
      });
      markRunDone(newRun, 'failed');
      persistDataInBackground('cost-quota blocked agent run');
      return;
    }

    // AGENT_GRAPH_V2: route this run through the LangGraph workflow runtime instead of the legacy
    // procedural pipeline. Same run record/SSE/status contracts; the runtime projects graph state
    // back onto this run. Flag off (default) = the legacy path below runs byte-for-byte unchanged.
    if (isWorkflowGraphEnabled()) {
      // Non-secret graph-start params, so the coverage decision can launch the graph later (creds re-resolved then).
      (newRun as any).graph_start = {
        requestedCaseCount,
        reviewPolicy: flowMode === 'review_cases' ? 'manual' : 'auto',
        provider: requestedProvider || '',
        model: requestedModel || '',
        effort: requestedEffort || '',
      };

      // Existing-case reuse gate: if stored cases already cover this request, ask the user whether to
      // reuse them or generate fresh BEFORE spending a run. Only in review mode (auto mode never pauses).
      if (flowMode === 'review_cases') {
        pushPhase(newRun, { agent: 'CoverageScout', status: 'running' });
        const relatedExisting = await findRelatedExistingCases(newRun).catch(() => []);
        newRun.existing_matches = relatedExisting.map(mapExistingToRunCase);
        pushPhase(newRun, { agent: 'CoverageScout', status: 'completed', output: `${relatedExisting.length} related existing test case(s) found.` });
        if (relatedExisting.length) {
          newRun.status = 'coverage_options';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'coverage_options', output: `Found ${relatedExisting.length} existing test case(s) that look related. Reuse them, add only the gaps, or generate fresh.` });
          await persistAgentQualityArtifacts(newRun).catch(() => undefined);
          persistDataInBackground('coverage-options graph run');
          return;
        }
      }

      pushPhase(newRun, { agent: 'Workflow', status: 'running', output: 'AGENT_GRAPH_V2: run routed through the durable LangGraph workflow runtime.' });
      beginGraphRunFor(newRun, { credential: credentials }).catch((err: any) => {
        markRunDone(newRun, 'failed');
        pushPhase(newRun, { agent: 'Workflow', status: 'failed', output: `Workflow runtime failed to start: ${String(err?.message || err).slice(0, 300)}` });
        persistDataInBackground('failed graph run start');
      });
      return;
    }

    try {
      // #1: NamingAgent removed from the critical path  -  newRun.artifactName already holds
      // a deterministic name (buildFallbackArtifactName), saving a ~30s codex call up front.
      const credentialContext = buildCredentialContext(credentials);
      pushPhase(newRun, { agent: 'ApplicationContext', status: 'running' });
      try {
        const appContext = await buildCorePlatformApplicationContext({
          projectId: newRun.projectId,
          appId: newRun.appId,
          websiteId: newRun.websiteId,
          targetUrl,
          prompt: prompt || '',
          understanding: approvedUnderstanding || priorGrounding || '',
          ownerId: newRun.ownerId,
          credentials,
          maxChars: 24000,
        });
        newRun.application_context = appContext.context;
        newRun.application_context_prompt = appContext.promptText;
        newRun.application_context_cache_key = appContext.cacheKey;
        if (appContext.context.testDataPack) (newRun as any).test_data_pack = appContext.context.testDataPack;
        pushPhase(newRun, {
          agent: 'ApplicationContext',
          status: 'completed',
          output: {
            project: appContext.context.project?.name || '',
            app: appContext.context.app?.name || '',
            repo: appContext.context.repo?.appRoot || '',
            catalogObjects: appContext.context.catalog.length,
            hasTestData: !!appContext.context.testDataPack,
            hasKnowledge: !!appContext.context.knowledgeBlock,
            warnings: appContext.context.warnings,
          },
        });
      } catch (err: any) {
        pushPhase(newRun, { agent: 'ApplicationContext', status: 'completed', output: `Application context unavailable: ${getAIErrorMessage(err)}. Downstream agents must rely only on inspection/source evidence and must not guess missing details.` });
      }
      // Ground the case writer to the resolved app: cover ONLY that app's list-view objects (from
      // its tabs), not the whole surface. Threads through application_context_prompt, which the
      // case/coder prompts already include.
      if (targetAppLabel) {
        const objectsLine = targetAppObjects.length
          ? ` Its user-facing list views are for these objects (from the app's tabs): ${targetAppObjects.join(', ')}.`
          : '';
        // Reflection window: metadata and runtime share a store behind a short (~60s) metadata cache,
        // so a change made in metadata can take a moment to appear in runtime.
        const reflectionLine = ' If a case changes metadata and then checks it in runtime, allow up to ~60 seconds for the change to appear (wait and re-check) rather than asserting it instantly.';
        newRun.application_context_prompt = `TARGET APP: Every test case must cover ONLY the "${targetAppLabel}" app within this surface  -  not other apps.${objectsLine} Some objects may be inherited from a parent app; that is expected (the app shows its whole scope).${reflectionLine}\n${String(newRun.application_context_prompt || '')}`;
      }
      const appContextPrompt = String(newRun.application_context_prompt || '');
      const appContextKey = String(newRun.application_context_cache_key || applicationContextCacheKey(newRun.application_context));
      const cacheKey = featureCacheKey(targetUrl, `${prompt || ''} ${approvedUnderstanding}`, appContextKey);

      // Metadata fetch is scoped to the RESOLVED platform app id (app0NNNNNN). Note: newRun.appId is
      // our internal surface id (APP-xxxx), which is NOT a platform app id  -  feeding it here was a
      // no-op/mismatch, so we only fetch when a real platform app was resolved.
      if (targetCoreAppId && targetCoreAppId !== ALL_APPS_ID) {
        await runMetadataFetchPhase({
          run: newRun,
          appId: targetCoreAppId,
          baseUrl: surfaceBaseUrl || selectedApp?.baseUrl || targetUrl,
          credentials,
          onPhase: (msg) => pushPhase(newRun, msg),
        });
      } else {
        const why = targetCoreAppId === ALL_APPS_ID ? 'All-apps sweep; per-app metadata skipped.' : 'No individual app resolved; metadata fetch skipped.';
        pushPhase(newRun, { agent: 'MetadataFetch', status: 'skipped', output: why });
        newRun.phases = {
          ...(newRun.phases || {}),
          metadata_fetch: { status: 'skipped', reason: why, completed_at: nowIso() },
        };
      }
      runContextBuilderPhase({
        run: newRun,
        websiteId: req.body.websiteId || (credentials as any).websiteId || '',
        ownerId: newRun.ownerId || undefined,
        primaryCredentials: credentials,
        onPhase: (msg) => pushPhase(newRun, msg),
      });

      // Inspection is the hard grounding gate. If the live app cannot be read, stop here
      // before spending tokens on code understanding or generating ungrounded cases.
      const cachedInspection = getCached(inspectionCache, cacheKey);
      let inspectionContext: any = null;
      let inspectionOk = false;
      if (cachedInspection) {
        newRun.inspection_context = cachedInspection;
        newRun.inspection_contexts = [{ ...cachedInspection, context_id: 'cached_primary' }];
        inspectionContext = cachedInspection;
        inspectionOk = true;
        pushPhase(newRun, { agent: 'ApplicationInspector', status: 'completed', output: { ...cachedInspection, cached: true, verifier: 'reused cached inspection' } });
      } else {
        const inspectionContexts = await runMultiContextInspectionPhase({
          run: newRun,
          targetUrl,
          prompt: approvedUnderstanding ? `${prompt || ''}\n\nApproved understanding:\n${approvedUnderstanding}` : prompt || '',
          primaryCredentials: credentials,
          ownerId: newRun.ownerId || undefined,
          knowledge: `${appContextPrompt}\n\n${inspectorKnowledge}`.trim(),
          onPhase: (msg) => pushPhase(newRun, msg),
        });
        inspectionContext = newRun.inspection_context;
        inspectionOk = inspectionContexts.some((ctx: any) => assessInspection(ctx).ok);
        if (inspectionOk && inspectionContext) setCached(inspectionCache, cacheKey, inspectionContext);
      }

      // Surface-Consistency Invariant (Phase 1): seal the mission to the surface discovery landed on, before
      // the Selector Registry / Evidence Graph consume it. Prefer the live DOM URL; fall back to inspection.
      const inspectedSurfaceUrl = String((newRun as any).dom_exploration?.url || inspectionContext?.currentUrl || '').trim();
      if (inspectedSurfaceUrl) {
        try {
          const sealed = finalizeMissionFromInspectedSurface(mission, inspectedSurfaceUrl);
          if (sealed !== mission) {
            mission = sealed;
            targetUrl = mission.targetUrl;
            newRun.mission_context = mission;
            newRun.app_url = mission.targetUrl;
            pushPhase(newRun, {
              agent: 'System',
              status: 'completed',
              output: `Mission sealed to discovery surface: ${describeMission(mission)} -> ${mission.targetUrl}`,
            });
          }
        } catch (e: any) {
          // Wrong-surface conflict: stop the run (HTTP response already sent) instead of grounding wrong.
          pushPhase(newRun, { agent: 'System', status: 'failed', output: `Refusing to generate tests on the wrong surface: ${String(e?.message || e)}` });
          markRunDone(newRun, 'failed');
          persistDataInBackground('surface-mismatch blocked agent run');
          return;
        }
      }

      runSelectorRegistryPhase({ run: newRun, page: targetUrl, onPhase: (msg) => pushPhase(newRun, msg) });

      (newRun as any).inspection_blind = !inspectionOk;
      if (!inspectionOk) {
        const detail = (assessInspection(inspectionContext).reason || '').trim();
        pushPhase(newRun, {
          agent: 'System',
          status: 'running',
          output: `Live inspection did not reach the authenticated application.${detail ? ` Details: ${detail}` : ''} Continuing to CodeAnalyst so the run can fall back to repo-grounded generation if source evidence exists.`,
        });
      }

      pushPhase(newRun, { agent: 'CodeAnalyst', status: 'running' });

      const understandTask = (async () => {
        const cached = getCached(understandingCache, cacheKey);
        if (cached) {
          const cachedUnderstanding = cached?.understanding || cached;
          // featureInventory is now emitted separately after FeatureDiscoveryAgent
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'completed', output: { ...cachedUnderstanding, cached: true, searchedFiles: [] } });
          return { understanding: cachedUnderstanding, featureInventory: cached?.featureInventory || null };
        }
        if (canReusePriorCodeGrounding(newRun.understandingSource, newRun.priorGrounding)) {
          const reusedGrounding = stripCodebaseLocationsForAgentConsole(newRun.priorGrounding || approvedUnderstanding);
          const reusedUnderstanding = buildUnderstandingFromPriorGrounding(prompt || '', targetUrl, reusedGrounding);
          const reusedInventory = wantsFeatureInventory(prompt || '', reusedGrounding)
            ? buildInventoryFromPriorGrounding(prompt || '', targetUrl, reusedGrounding)
            : null;
          pushPhase(newRun, {
            agent: 'CodeAnalyst',
            status: 'completed',
            output: {
              ...reusedUnderstanding,
              reused: true,
              memorySource: newRun.understandingSource,
              note: 'Reused the prior code-grounded chat answer; source files were not reread for this stage.',
            },
          });
          // FeatureWriter phase is emitted after FeatureDiscoveryAgent  -  not here
          setCached(understandingCache, cacheKey, { understanding: reusedUnderstanding, featureInventory: reusedInventory });
          return { understanding: reusedUnderstanding, featureInventory: reusedInventory };
        }
        try {
          // Research the SELECTED project's repo  -  dynamic per app, no hardcoded path.
          const repoPath = getProjectRepoPath(newRun.projectId || '').trim();
          // Strike 3: ground the CodeAnalyst on the SAME resolved understanding the case
          // writer/coder use (resolveUnderstanding applies the chat fallback) instead of the
          // raw request-body approvedUnderstanding, so all three workers share one grounding.
          const analystUnderstanding = resolveUnderstanding(newRun);
          const analysis = await analyzeFeatureFromSource(`${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim(), {
            workspaceId: newRun.ownerId || 'default',
            userId: newRun.ownerId,
            repoPath,
            projectId: newRun.projectId,
            appId: newRun.appId,
            applicationContextPrompt: appContextPrompt,
          });
          const rawUnderstanding = (analysis.understanding || {}) as any;
          const { sourceFiles: _sourceFiles, files: _files, searchedFiles: _searchedFiles, ...visibleUnderstanding } = rawUnderstanding;
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'completed', output: visibleUnderstanding });
          // FeatureWriter now runs AFTER FeatureDiscoveryAgent (post understandTask) so phases
          // emit in the correct order: Find Existing -> Write New (missing). Cache the inventory
          // key here so FeatureWriter can retrieve it without re-running the LLM.
          setCached(understandingCache, cacheKey, { understanding: analysis.understanding, featureInventory: null });
          return { understanding: analysis.understanding, featureInventory: null };
        } catch (err: any) {
          pushPhase(newRun, { agent: 'CodeAnalyst', status: 'skipped', output: `Code understanding unavailable: ${getAIErrorMessage(err)}` });
          return { understanding: null, featureInventory: null };
        }
      })();

      const sourceUnderstanding = await understandTask;
      newRun.feature_understanding = sourceUnderstanding?.understanding || null;
      newRun.feature_inventory = sourceUnderstanding?.featureInventory || null;
      if (!newRun.feature_understanding && newRun.understandingSource !== 'requirement') {
        const why = 'CodeAnalyst could not produce repo-grounded understanding. Generation is blocked because agents must not fall back to guessed behavior.';
        pushPhase(newRun, { agent: 'System', status: 'failed', output: why });
        (newRun as any).cases_grounding = { ok: false, reason: why };
        markRunDone(newRun, 'failed');
        await persistAgentQualityArtifacts(newRun).catch((persistErr) => console.warn('Failed to persist failed code-grounding agent artifacts:', persistErr));
        persistDataInBackground('code-grounding blocked agent run');
        return;
      }

      // -- Phase 3: Find Existing Features ------------------------------------
      pushPhase(newRun, { agent: 'FeatureDiscoveryAgent', status: 'running' });
      const existingFeatureRequirements = await findExistingFeatureRequirements(newRun);
      (newRun as any).existing_feature_matches = existingFeatureRequirements;
      pushPhase(newRun, {
        agent: 'FeatureDiscoveryAgent',
        status: 'completed',
        output: existingFeatureRequirements.length
          ? { count: existingFeatureRequirements.length, matches: existingFeatureRequirements.map((req: any) => ({ id: req.id, title: req.title })).slice(0, 10) }
          : 'No existing feature/requirement records found for this scope.',
      });

      // -- Phase 4: Write New Features (missing) ------------------------------
      // FeatureWriter now runs here (after discovery) so the phase order in the UI is correct.
      let featureInventory = newRun.feature_inventory;
      if (!featureInventory && newRun.understandingSource !== 'requirement') {
        const analystUnderstanding = resolveUnderstanding(newRun);
        const inventoryKey = featureCacheKey(targetUrl, `feature-inventory ${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim(), appContextKey);
        const cachedInventory = getCached(featureInventoryCache, inventoryKey);
        if (cachedInventory) {
          featureInventory = cachedInventory;
          newRun.feature_inventory = featureInventory;
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory, { cached: true }) });
        } else if (wantsFeatureInventory(prompt || '', analystUnderstanding || approvedUnderstanding || '')) {
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'running' });
          try {
            const repoPath = getProjectRepoPath(newRun.projectId || '').trim();
            const inventoryResult = await discoverFeatureInventoryFromSource(
              `${scopeContextText} ${prompt || ''} ${analystUnderstanding}`.trim(),
              {
                workspaceId: newRun.ownerId || 'default',
                userId: newRun.ownerId,
                repoPath,
                projectId: newRun.projectId,
                appId: newRun.appId,
                applicationContextPrompt: appContextPrompt,
              },
            );
            featureInventory = inventoryResult.inventory;
            newRun.feature_inventory = featureInventory;
            setCached(featureInventoryCache, inventoryKey, featureInventory);
            pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory) });
          } catch (inventoryErr: any) {
            pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: `Feature inventory unavailable: ${getAIErrorMessage(inventoryErr)}` });
          }
        } else {
          pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: 'Focused scope  -  no broad feature inventory needed.' });
        }
      } else if (featureInventory) {
        pushPhase(newRun, { agent: 'FeatureWriter', status: 'completed', output: featureWriterOutput(featureInventory, { reused: true }) });
      } else {
        pushPhase(newRun, { agent: 'FeatureWriter', status: 'skipped', output: 'Requirement context already available  -  feature discovery skipped.' });
      }

      // -- Phase 5: Write New Requirements (missing)  -  per-feature loop --------
      if (newRun.understandingSource === 'requirement') {
        pushPhase(newRun, { agent: 'RequirementWriter', status: 'skipped', output: 'Requirement already exists  -  skipping draft phase.' });
      } else {
        pushPhase(newRun, { agent: 'RequirementWriter', status: 'running' });
        await persistAgentRequirementArtifacts(newRun);
        pushPhase(newRun, {
          agent: 'RequirementWriter',
          status: 'completed',
          output: { requirementId: agentRequirementId(newRun), status: 'Draft', source: 'feature_inventory' },
        });
      }

      // Auto-grow the app knowledge
      try {
        const ic: any = inspectionContext || {};
        const nav = (ic.visibleNavigation || []).slice(0, 10).join(', ');
        const forms = (ic.visibleForms || []).map((f: any) => f?.name || f?.label).filter(Boolean).slice(0, 6).join(', ');
        const obsNote = `For "${(prompt || '').slice(0, 80)}" the app showed page "${ic.pageSummary || ic.currentUrl || ''}"`
          + (nav ? `; nav: ${nav}` : '') + (forms ? `; forms: ${forms}` : '') + ` (goal: ${ic.goalStatus || 'unknown'}).`;
        recordObservation({ websiteId: req.body.websiteId, targetUrl, text: prompt || '', ownerId: newRun.ownerId || '' }, obsNote);
      } catch { /* observation is best-effort */ }

      newRun.requested_case_count = requestedCaseCount;
      newRun.selected_qa_prompt_text = selectedQaContext.promptText;
      newRun.scope_context_text = scopeContextText;

      // Per-feature sub-loop: for each NEW feature -> Map -> Find existing -> Write cases.
      // BUT when the user FIXED a case count, skip the comprehensive per-feature expansion (which
      // produces one case per subfeature) and use the focused single-batch path below, which
      // honors the exact requested count.
      const inventoryFeatures = (featureInventory?.features as any[] || []);
      const requirementScenarioCount = Array.isArray(newRun.feature_understanding?.candidateScenarios)
        ? newRun.feature_understanding.candidateScenarios.length
        : 0;
      const useRequirementScenarioContract = newRun.understandingSource === 'requirement' && requirementScenarioCount > 0;
      if (flowMode === 'review_cases') {
        const relatedExisting = await findRelatedExistingCases(newRun);
        newRun.existing_matches = relatedExisting.map(mapExistingToRunCase);
        if (relatedExisting.length) {
          newRun.status = 'coverage_options';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'coverage_options', output: `Found ${relatedExisting.length} strongly related existing test case(s). Choose reuse, gaps, or fresh generation.` });
          await persistAgentQualityArtifacts(newRun);
          persistDataInBackground('coverage-options agent run');
          return;
        }
      }
      if (inventoryFeatures.length > 0 && !requestedCaseCount && !useRequirementScenarioContract) {
        const existingTitles = existingFeatureRequirements.map((r: any) => (r.title || '').toLowerCase());
        const newFeatures = inventoryFeatures.filter((f: any) =>
          !existingTitles.some((t) => t.includes((f.name || '').toLowerCase().slice(0, 10))),
        );
        const featureLoop = newFeatures.length ? newFeatures : inventoryFeatures;
        const allGeneratedCases: any[] = [];

        // Feature writers are independent model calls. Run a small bounded batch so a
        // complete 15-feature inventory does not take 15 serial model round trips.
        const FEATURE_WRITER_CONCURRENCY = 3;
        for (let start = 0; start < featureLoop.length; start += FEATURE_WRITER_CONCURRENCY) {
          const batch = featureLoop.slice(start, start + FEATURE_WRITER_CONCURRENCY);
          for (const feature of batch) {
            pushPhase(newRun, {
              agent: 'FeatureMapper',
              status: 'completed',
              output: { feature: feature.name, subfeatures: (feature.subfeatures || []).length, surface: feature.surface || '' },
            });
            pushPhase(newRun, { agent: 'FeatureTestWriter', status: 'running', output: `Writing cases for "${feature.name}".` });
          }
          const results = await Promise.all(batch.map(async (feature: any) => {
            try {
              return { feature, cases: await generateCasesForFeature(newRun, feature, credentials), error: null };
            } catch (error: any) {
              return { feature, cases: [] as any[], error };
            }
          }));
          // Promise.all preserves input order, keeping generated case order deterministic.
          for (const result of results) {
            if (result.error) {
              pushPhase(newRun, { agent: 'FeatureTestWriter', status: 'skipped', output: `"${result.feature.name}": ${getAIErrorMessage(result.error)}` });
              continue;
            }
            allGeneratedCases.push(...result.cases);
            pushPhase(newRun, {
              agent: 'FeatureTestWriter',
              status: 'completed',
              output: `${result.cases.length} new case(s) written for "${result.feature.name}".`,
            });
          }
        }

        // -- Phase 6: Recheck coverage  -  fill any gaps --------------------------
        pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'running' });
        const allSubFeatures = inventoryFeatures
          .flatMap((f: any) => (Array.isArray(f?.subfeatures) ? f.subfeatures : []))
          .map((s: any) => ({ name: String(s?.name || '').trim() }))
          .filter((s: { name: string }) => s.name);
        if (allSubFeatures.length && allGeneratedCases.length) {
          const featureLabel = inventoryFeatures[0]?.name ? String(inventoryFeatures[0].name) : String(prompt || 'feature').slice(0, 60);
          const completeness = assessFeatureCompleteness(featureLabel, allSubFeatures, allGeneratedCases);
          if (!completeness.ok) {
            try {
              const gapCases = await proposeGapCases(newRun.feature_understanding, allGeneratedCases.map((c: any) => ({
                id: c.existingCaseId || c.id || c.title, title: c.title, tags: c.tags || [], type: c.type, priority: c.priority, stepCount: (c.steps || []).length,
              })));
              const gapFormatted = (gapCases || []).map((g: any) => ({
                title: g.title, description: g.rationale || '', priority: g.priority || 'Medium', type: g.type || 'Automated',
                tags: normalizeCaseTags(g.tags || []), steps: normalizeCaseSteps(g.steps || []), captureEvidence: true,
              }));
              if (gapFormatted.length) allGeneratedCases.push(...gapFormatted);
              pushPhase(newRun, {
                agent: 'CoverageGapChecker',
                status: 'completed',
                output: gapFormatted.length ? `${gapFormatted.length} gap case(s) added. ${completeness.reason}` : `No actionable gaps. ${completeness.reason}`,
              });
            } catch {
              pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: completeness.reason });
            }
          } else {
            pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: `All features covered. ${completeness.reason}` });
          }
        } else {
          pushPhase(newRun, { agent: 'CoverageGapChecker', status: 'completed', output: 'No subfeature inventory to validate against.' });
        }

        // Commit all accumulated cases and go straight to script generation
        newRun.generated_cases = annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(allGeneratedCases, newRun), newRun);
        (newRun as any).all_generated_cases = newRun.generated_cases;
        newRun.existing_matches = [];
        pushPhase(newRun, {
          agent: 'TestGenerationAgent',
          status: 'completed',
          output: { test_cases: newRun.generated_cases, grounded: true, grounding: 'Per-feature case generation complete.' },
        });
        await persistAgentCaseArtifacts(newRun);
        await persistAgentRequirementArtifacts(newRun);
        (newRun.generated_cases || []).forEach((tc: any, idx: number) => {
          pushInboxItem({
            workspaceId: 'default', source: 'case', sourceId: `${newRun.id}:${idx}`,
            title: `Review new test case: ${tc.title || `Case ${idx + 1}`}`, summary: tc.description || '',
            confidence: 80, proposedBy: 'QA Assistant',
            payload: { runId: newRun.id, caseIndex: idx, case: tc },
            links: [{ label: 'Open in Test Cases', href: '/test-cases' }],
          });
        });
        if (flowMode === 'review_cases') {
          newRun.status = 'review_required';
          (newRun as any).review_stage = 'cases';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'review_required', output: 'Review and edit generated test cases, then continue the agent flow.' });
          await persistAgentRunAndReportArtifacts(newRun);
          persistDataInBackground('review-required agent run');
          return;
        }
        await runPostCaseAgentFlow(newRun, undefined as any, { test_cases: newRun.generated_cases }, targetUrl, credentials);
      } else {
        // No feature inventory  -  fall back to single-batch generation with coverage-options gate
        pushPhase(newRun, { agent: 'CoverageScout', status: 'running' });
        const relatedExisting = await findRelatedExistingCases(newRun);
        newRun.existing_matches = relatedExisting.map(mapExistingToRunCase);
        await persistAgentRequirementArtifacts(newRun);
        pushPhase(newRun, { agent: 'CoverageScout', status: 'completed', output: `${relatedExisting.length} related existing test case(s) found.` });
        if (relatedExisting.length && flowMode === 'review_cases') {
          newRun.status = 'coverage_options';
          newRun.review_started_at = nowIso();
          pushPhase(newRun, { agent: 'System', status: 'coverage_options', output: `Found ${relatedExisting.length} existing test case(s). Reuse them, add only the gaps, or generate fresh.` });
          await persistAgentQualityArtifacts(newRun);
          persistDataInBackground('coverage-options agent run');
          return;
        }
        await generateCasesForRun(newRun, credentials, { flowMode, mode: 'fresh' });
      }
    } catch (err: any) {
      console.error('AI Gen Error:', err);
      markRunDone(newRun, 'failed');
      pushPhase(newRun, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(newRun).catch((persistErr) => console.warn('Failed to persist failed agent artifacts:', persistErr));
      persistDataInBackground('failed agent run');
    }
  });

  // Resolve the early reuse gate: the user chose to reuse existing cases, extend
  // them with only the gaps, or generate a fresh set. Mirrors /continue's async shape.
  app.post('/api/agent/coverage-decision', async (req, res) => {
    const { taskId, action } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'coverage_options') {
      return res.status(400).json({ error: 'No coverage decision is pending for this run.' });
    }
    const act: 'reuse' | 'gaps' | 'fresh' = ['reuse', 'gaps', 'fresh'].includes(action) ? action : 'fresh';

    // Fold the time spent on this decision into paused_ms so it doesn't inflate the total.
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    run.status = 'running';
    run.completed_at = null;
    delete (run as any).cancelRequested;
    persistDataInBackground('coverage decision');
    res.json({ success: true, action: act });

    let matched = Array.isArray(run.existing_matches) ? run.existing_matches : [];
    // Honor per-case deletions from the coverage card: keep only the cases the user kept,
    // so irrelevant/over-matched existing cases (e.g. unrelated auth/coupon) aren't reused.
    const keepIds = Array.isArray(req.body.keep) ? req.body.keep.map(String) : null;
    if (keepIds) {
      const keepSet = new Set(keepIds);
      matched = matched.filter((c: any) => keepSet.has(String(c.id ?? c.existingCaseId ?? c.title)));
    }

    // Graph engine: the graph run hasn't started yet (the gate ran before it). Launch it now with the
    // decision applied — reuse seeds the cases (author_cases uses them), gaps tells the author to skip
    // duplicates, fresh generates from scratch. Scripts + evidence then run automatically in the graph.
    if ((run as any).engine === 'langgraph' || (run as any).graph_start) {
      try {
        if (act === 'reuse' && matched.length) {
          await beginGraphRunFor(run, { seedCases: matched });
        } else if (act === 'gaps' && matched.length) {
          await beginGraphRunFor(run, { avoidCaseTitles: matched.map((c: any) => String(c.title || '')).filter(Boolean) });
        } else {
          await beginGraphRunFor(run);
        }
      } catch (err: any) {
        console.error('Graph coverage decision error:', err);
        markRunDone(run, 'failed');
        pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
        persistDataInBackground('failed graph coverage decision');
      }
      return;
    }

    try {
      const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;

      if (act === 'reuse' && matched.length) {
        // No generation  -  load the existing cases and let the human review, then
        // Continue runs scripts + evidence against them like any other case set.
        run.generated_cases = matched;
        pushPhase(run, { agent: 'TestGenerationAgent', status: 'completed', output: { test_cases: matched, reused: true } });
        run.status = 'review_required';
        (run as any).review_stage = 'cases';
        run.review_started_at = nowIso();
        pushPhase(run, { agent: 'System', status: 'review_required', output: `Reusing ${matched.length} existing case(s)  -  review and continue to run scripts + evidence.` });
        await persistAgentQualityArtifacts(run);
        persistDataInBackground('reuse existing cases');
      } else if (act === 'gaps' && matched.length) {
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: 'gaps', existingCases: matched });
      } else {
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: 'fresh' });
      }
    } catch (err: any) {
      console.error('AI Coverage Decision Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed coverage decision:', persistErr));
      persistDataInBackground('failed coverage decision');
    }
  });

  app.post('/api/agent/continue', async (req, res) => {
    const { taskId, cases, executionCases, scripts } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);

    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Graph-engine runs resume through the workflow runtime (durable interrupt), never the legacy flow.
    // The pending correlationId is read server-side from the checkpointed state — no UI change needed.
    if ((run as any).engine === 'langgraph') {
      try {
        const pending = await getPendingReview(taskId);
        const correlationId = pending?.correlationId;
        if (!correlationId) return res.status(409).json({ error: 'This run has no pending review to continue.' });
        run.status = 'running';
        persistDataInBackground('continued graph run');
        res.json({ success: true });
        await resumeGraphRun(taskId, { correlationId, decision: 'approved', actor: reqScope(req).userId || 'user' });
      } catch (err: any) {
        console.error('Graph continue error:', err);
        if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      }
      return;
    }
    if ((run as any).review_stage === 'scripts') {
      if (Array.isArray(scripts) && scripts.length) run.playwright_scripts = scripts;
      if (!Array.isArray(run.playwright_scripts) || run.playwright_scripts.length === 0) {
        return res.status(400).json({ error: 'Generated scripts are required to continue.' });
      }
      run.status = 'running';
      delete (run as any).cancelRequested;
      if (run.review_started_at) {
        run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
        run.review_started_at = null;
      }
      (run as any).review_stage = '';
      persistDataInBackground('continued script review');
      res.json({ success: true });

      try {
        const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
        await completeScriptProofFlow(run, run.app_url || '', { test_cases: run.generated_cases || [] }, liveCreds);
      } catch (err: any) {
        console.error('AI Script Continue Error:', err);
        markRunDone(run, 'failed');
        pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
        await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed script continued agent run:', persistErr));
        persistDataInBackground('failed script continued agent run');
      }
      return;
    }
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'Reviewed cases are required to continue.' });
    }
    const selectedExecutionCases = Array.isArray(executionCases) && executionCases.length ? executionCases : cases;

    run.status = 'running';
    run.completed_at = null;
    // The human just finished reviewing cases  -  fold that idle gap into paused_ms
    delete (run as any).cancelRequested;
    // so the reported total reflects automation time, not how long they deliberated.
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    (run as any).all_generated_cases = cases;
    (run as any).execution_case_count = selectedExecutionCases.length;
    run.generated_cases = cases;
    (run as any).review_stage = '';
    run.playwright_scripts = [];
    run.evidence_screenshots = [];
    await persistAgentQualityArtifacts(run);
    persistDataInBackground('continued agent run');
    res.json({ success: true });

    try {
      // Re-resolve the real credentials (the run only stores a masked copy) so the
      // evidence run can actually log in.
      const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
      await runPostCaseAgentFlow(run, undefined as any, { test_cases: selectedExecutionCases }, run.app_url || '', liveCreds);
    } catch (err: any) {
      console.error('AI Continue Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed continued agent run:', persistErr));
      persistDataInBackground('failed continued agent run');
    }
  });

  // RESUME-ON-RETRY: restart a failed run from the phase it died on, reusing the
  // expensive work already done (inspection, code-understanding, coverage matches) instead
  // of starting from scratch. Resume point is derived from what the run already produced.
  // Stop/terminate a running agent run. Marks it cancelled (a terminal state) and sets a
  // flag the pipeline checks at the next phase boundary, so it stops advancing.
  app.post('/api/agent/cancel', async (req, res) => {
    const { taskId } = req.body || {};
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Graph-engine runs also abort the workflow runtime (checkpointed cancel + AbortController).
    if ((run as any).engine === 'langgraph') await cancelGraphRun(taskId).catch((err) => console.warn('Graph cancel error:', err));
    (run as any).cancelRequested = true;
    run.status = 'cancelled';
    run.completed_at = nowIso();
    // Kill any in-flight Playwright execution for this run (the heavy, killable work).
    const killed = killRunProcesses(run.id);
    pushPhase(run, { agent: 'System', status: 'cancelled', output: `Run stopped by user.${killed ? ` Terminated ${killed} running process(es).` : ''}` });
    await persistAgentQualityArtifacts(run).catch((err) => console.warn('Failed to persist cancelled agent run:', err));
    await saveAgentRunState(run, 'cancel agent run');
    res.json({ success: true, status: 'cancelled', killed });
  });

  app.post('/api/agent/retry', async (req, res) => {
    const { taskId } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Graph-engine runs never resume through the legacy pipeline (their seed can carry a STALE
    // inspection_context from a prior session run, which fooled this path into a blind-inspection
    // block). needsFullRestart → the UI starts a fresh run, which routes per the current engine flag.
    if ((run as any).engine === 'langgraph') return res.json({ success: false, needsFullRestart: true });

    const hasInspection = !!run.inspection_context;
    const hasCases = Array.isArray(run.generated_cases) && run.generated_cases.length > 0;
    const liveCreds = resolveCredentials({ targetUrl: run.app_url, websiteId: run.websiteId, role: (run.credentials || {}).role, ownerId: ownerScopeForRun(run) }) || undefined;
    if (!hasInspection) return res.json({ success: false, needsFullRestart: true });
    // A cancelled run retains both terminal status and cancelRequested. Clear them before any
    // revalidation work, otherwise the phase guard aborts the retry as RUN_CANCELLED.
    run.cancelRequested = false;
    run.status = 'running';
    run.completed_at = null;
    if (!groundingIsFresh(run)) {
      try {
        pushPhase(run, { agent: 'DOMExplorer', status: 'running', output: 'Revalidating live selectors before retry; the prior inspection is stale.' });
        const verifiedPage = await exploreAndVerifyPage({
          targetUrl: run.app_url,
          open: domOpenPathForPrompt(run.prompt || ''),
          credentials: liveCreds?.username && liveCreds?.password
            ? { username: liveCreds.username, password: liveCreds.password }
            : undefined,
        });
        if (!verifiedPage?.coverage?.verified) throw new Error('No unique live selectors were revalidated.');
        run.dom_exploration = verifiedPage;
        run.phases = {
          ...(run.phases || {}),
          inspection: { ...(run.phases?.inspection || {}), completed_at: nowIso(), refreshed_by: 'DOMExplorer' },
          retry_grounding: { status: 'complete', ...verifiedPage.coverage, completed_at: nowIso() },
        };
        runSelectorRegistryPhase({ run, page: verifiedPage.url || run.app_url, onPhase: (msg) => pushPhase(run, msg) });
        pushPhase(run, { agent: 'DOMExplorer', status: 'completed', output: `Revalidated ${verifiedPage.coverage.verified} unique live selector(s) for retry.` });
      } catch (error: any) {
        pushPhase(run, { agent: 'DOMExplorer', status: 'failed', output: `Retry grounding refresh failed: ${error?.message || String(error)}` });
        run.status = 'cancelled';
        run.completed_at = nowIso();
        return res.json({ success: false, needsFullRestart: true });
      }
    }
    if (run.review_started_at) {
      run.paused_ms = (run.paused_ms || 0) + Math.max(0, Date.parse(nowIso()) - Date.parse(run.review_started_at));
      run.review_started_at = null;
    }
    const resumedFrom = hasCases ? 'scripts' : 'write_cases';
    // Earlier phases (metadata fetch, context build, inspection, etc.) are being reused, not
    // re-run  -  resolve any that were left stuck at 'running' from the stopped attempt so their
    // chips don't spin forever.
    resolveDanglingPhases(run, 'Reused from the previous attempt; not re-run on retry.');
    pushPhase(run, { agent: 'System', status: 'running', output: `Retrying  -  resuming from ${hasCases ? 'script generation' : 'case writing'} (reusing the completed inspection${run.feature_understanding ? ' + code understanding' : ''}).` });
    persistDataInBackground('retry agent run');
    res.json({ success: true, resumedFrom });

    try {
      if (hasCases) {
        await runPostCaseAgentFlow(run, undefined as any, { test_cases: run.generated_cases }, run.app_url || '', liveCreds);
      } else {
        // Resume case writing using the already-computed inspection + understanding +
        // coverage matches. Keep existing matches (gaps) when present, else fresh.
        const matched = Array.isArray(run.existing_matches) ? run.existing_matches : [];
        await generateCasesForRun(run, liveCreds, { flowMode: 'review_cases', mode: matched.length ? 'gaps' : 'fresh', existingCases: matched });
      }
    } catch (err: any) {
      console.error('AI Retry Error:', err);
      markRunDone(run, 'failed');
      pushPhase(run, { agent: 'System', status: 'failed', output: getAIErrorMessage(err) });
      await persistAgentQualityArtifacts(run).catch((persistErr) => console.warn('Failed to persist failed retry:', persistErr));
      persistDataInBackground('failed retry');
    }
  });

  function reworkNeedsRepoRead(text: string): boolean {
    return /\b(repo|code|source|implementation|actual|exact|business rules?|validation|permission|role|api|endpoint|schema|field|selector|label|component|route|logic|behavior)\b/i.test(text);
  }

  function reworkTerms(text: string): string[] {
    const stop = new Set(['test', 'case', 'step', 'expected', 'result', 'should', 'when', 'then', 'with', 'this', 'that', 'from', 'into', 'user', 'page']);
    return [...String(text || '').matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)]
      .map((m) => m[0])
      .filter((w) => !stop.has(w.toLowerCase()))
      .slice(0, 12);
  }

  function buildReworkRepoContext(input: { scope: any; testCase: any; feedback: string }): string {
    const hay = `${input.feedback || ''}\n${JSON.stringify(input.testCase || {})}`;
    if (!reworkNeedsRepoRead(hay)) return '';
    const repoPath = getProjectRepoPath(input.scope.projectId || '').trim();
    if (!repoPath) return '\nREPO CONTEXT: requested by intent, but no repository is configured for the selected project.\n';
    const app = input.scope.appId ? getApp(input.scope.appId) : undefined;
    const sub = String((app as any)?.repoSubpath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const hits = searchCodeWithContext(reworkTerms(hay), repoPath, {
      maxFiles: 5,
      contextLines: 2,
      maxLinesPerFile: 24,
      pathspecs: sub ? [`${sub}/**`] : undefined,
    });
    if (!hits.length) return '\nREPO CONTEXT: searched the selected repository, but no matching source lines were found.\n';
    return `\nREPO CONTEXT: source lines from the selected project. Use these as the source of truth for exact behavior; if they do not prove a detail, keep it generic.\n${hits.map((h) => `FILE ${h.path}\n${h.snippet}`).join('\n\n')}\n`;
  }

  // Allowed image attachment types + decoded-size cap for rework attachments.
  const REWORK_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const REWORK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

  // Validates optional { name, mimeType, dataBase64 } attachments; returns provider images or an error string.
  function parseReworkAttachments(attachments: unknown): { images?: Array<{ mimeType: string; dataBase64: string }>; error?: string } {
    if (attachments === undefined || attachments === null) return {};
    if (!Array.isArray(attachments)) return { error: 'attachments must be an array of { name, mimeType, dataBase64 } objects.' };
    if (attachments.length > 4) return { error: 'At most 4 image attachments are allowed per rework request.' };
    const images: Array<{ mimeType: string; dataBase64: string }> = [];
    for (const a of attachments) {
      const name = String(a?.name || 'unnamed');
      const mimeType = String(a?.mimeType || '').toLowerCase();
      const dataBase64 = String(a?.dataBase64 || '');
      if (!REWORK_IMAGE_TYPES.has(mimeType)) return { error: `Attachment "${name}": unsupported type "${mimeType || 'unknown'}" — only image/png, image/jpeg, image/webp, image/gif are allowed.` };
      if (!dataBase64) return { error: `Attachment "${name}": dataBase64 is empty.` };
      if ((dataBase64.length * 3) / 4 > REWORK_IMAGE_MAX_BYTES) return { error: `Attachment "${name}": exceeds the 5MB size limit.` };
      images.push({ mimeType, dataBase64 });
    }
    return { images: images.length ? images : undefined };
  }

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const { testCase, feedback, targetUrl, attachments } = req.body;
      const scope = reqScope(req);
      const parsedAttachments = parseReworkAttachments(attachments);
      if (parsedAttachments.error) return res.status(400).json({ error: parsedAttachments.error });
      const images = parsedAttachments.images;
      const reworkRunScope = { appName: (scope.appId ? getApp(scope.appId)?.name : '') || '', app_url: targetUrl || '' };
      const repoContext = buildReworkRepoContext({ scope, testCase, feedback: String(feedback || '') });
      const ai = await getOrchestrator('caseReworker', { workspaceId: reqScope(req).userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt: `Target URL: ${targetUrl || 'not provided'}. Current case: ${JSON.stringify(testCase)}. Feedback: ${feedback || 'Improve clarity and coverage.'}
${repoContext}
${images ? `The user attached ${images.length} image(s) as additional context for this rework — use what they show when improving the case.\n` : ''}Return a complete test case object. Preserve any useful existing fields. If no explicit preconditions are needed, return preconditions as an empty string. Do not omit required keys.`,
        schema: z.object({
          title: z.string(),
          description: z.string().optional().default(''),
          preconditions: z.string().optional().default(''),
          tags: z.array(z.string()).optional().default([]),
          priority: z.enum(['Low', 'Medium', 'High', 'Critical']).optional().default('Medium'),
          type: z.enum(['Manual', 'Automated', 'Both']).optional().default('Manual'),
          steps: z.array(z.object({
            action: z.string(),
            expected: z.string(),
          })),
        }),
        userMessage: feedback || 'Rework the case for clarity and coverage.',
        images,
      });
      const reworked = result.object || {};
      res.json(normalizeGeneratedCaseText({
        ...testCase,
        ...reworked,
        title: String(reworked.title || testCase?.title || 'Reworked test case'),
        description: String(reworked.description ?? testCase?.description ?? ''),
        preconditions: String(reworked.preconditions ?? testCase?.preconditions ?? ''),
        tags: Array.isArray(reworked.tags) ? reworked.tags : Array.isArray(testCase?.tags) ? testCase.tags : [],
        priority: reworked.priority || testCase?.priority || 'Medium',
        type: reworked.type || testCase?.type || 'Manual',
        steps: normalizeCaseSteps(reworked.steps || testCase?.steps || []),
      }, reworkRunScope));
    } catch (err: any) {
      console.error('AI Rework Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  // Chat-based bulk rework: ONE free-text intent for the whole suite — the model decides whether to
  // MODIFY existing cases and/or ADD missing coverage (e.g. "you missed this feature, please add it").
  app.post('/api/agent/rework-cases-chat', async (req, res) => {
    try {
      const { instruction, cases, selectedIndexes, targetUrl } = req.body || {};
      const intent = String(instruction || '').trim();
      if (!intent) return res.status(400).json({ error: 'instruction required' });
      const list = Array.isArray(cases) ? cases : [];
      if (!list.length) return res.status(400).json({ error: 'cases required' });
      const scope = reqScope(req);
      const chatRunScope = { appName: (scope.appId ? getApp(scope.appId)?.name : '') || '', app_url: targetUrl || '' };
      const picked = [...new Set((Array.isArray(selectedIndexes) ? selectedIndexes : [])
        .map((i: any) => Number(i))
        .filter((i: number) => Number.isInteger(i) && i >= 0 && i < list.length))];
      // The intent applies to the selected cases when any are ticked, else the whole suite.
      const focus = picked.length ? picked : list.map((_: any, i: number) => i);
      const catalog = list.map((c: any, i: number) => `${i}. ${String(c?.title || 'Untitled')}${picked.includes(i) ? '  [SELECTED]' : ''}`).join('\n');
      const detail = focus.slice(0, 15).map((i: number) => `INDEX ${i}: ${JSON.stringify(list[i])}`).join('\n');
      const repoContext = buildReworkRepoContext({ scope, testCase: list[focus[0]] || list[0], feedback: intent });
      const caseSchema = z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        preconditions: z.string().optional().default(''),
        tags: z.array(z.string()).optional().default([]),
        priority: z.enum(['Low', 'Medium', 'High', 'Critical']).optional().default('Medium'),
        type: z.enum(['Manual', 'Automated', 'Both']).optional().default('Manual'),
        steps: z.array(z.object({ action: z.string(), expected: z.string() })),
      });
      const ai = await getOrchestrator('caseReworker', { workspaceId: scope.userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt: `You maintain a QA test-case suite. Target URL: ${targetUrl || 'not provided'}.
ALL CASES (index. title):
${catalog}

FULL CASES IN FOCUS:
${detail}
${repoContext}
USER REQUEST: ${intent}

Decide what the request needs:
- MODIFY existing cases -> return each changed case in updatedCases with its index (only cases that actually change).
- ADD coverage the suite is missing (e.g. "you missed this feature") -> return complete new cases in newCases.
Do both when the request implies both. Never delete or renumber cases. Steps must be concrete and executable against the target app. In note, say in one short sentence what you did.`,
        schema: z.object({
          updatedCases: z.array(z.object({ index: z.number().int(), testCase: caseSchema })).optional().default([]),
          newCases: z.array(caseSchema).optional().default([]),
          note: z.string().optional().default(''),
        }),
        userMessage: intent,
      });
      const out = result.object || {};
      const updatedCases = (Array.isArray(out.updatedCases) ? out.updatedCases : [])
        .filter((u: any) => Number.isInteger(u?.index) && u.index >= 0 && u.index < list.length && u?.testCase)
        .map((u: any) => ({
          index: u.index,
          testCase: normalizeGeneratedCaseText({ ...list[u.index], ...u.testCase, steps: normalizeCaseSteps(u.testCase.steps || list[u.index]?.steps || []) }, chatRunScope),
        }));
      const newCases = (Array.isArray(out.newCases) ? out.newCases : [])
        .map((c: any) => normalizeGeneratedCaseText({ captureEvidence: true, ...c, steps: normalizeCaseSteps(c?.steps || []) }, chatRunScope));
      if (!updatedCases.length && !newCases.length) {
        return res.status(422).json({ error: 'The AI could not map that request to any case changes — try being more specific about the feature or cases.' });
      }
      res.json({ updatedCases, newCases, note: String(out.note || '') });
    } catch (err: any) {
      console.error('AI Chat Rework Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  // AI step editing for the case editor: EXPAND selected steps into finer sub-steps, or MERGE
  // selected steps into one  -  both driven by the ticked step indexes and both returning the FULL
  // new ordered step list so the client just replaces its steps. Falls back to whole-case expansion
  // (targetStepCount) when no steps are selected.
  app.post('/api/agent/expand-case-steps', async (req, res) => {
    try {
      const { testCase, targetStepCount, targetUrl, stepIndex, op, selectedStepIndexes } = req.body;
      const scope = reqScope(req);
      const stepRunScope = { appName: (scope.appId ? getApp(scope.appId)?.name : '') || '', app_url: targetUrl || '' };
      const steps = normalizeCaseSteps(testCase?.steps || []);
      // Accept a list of ticked indexes; also honour the legacy single stepIndex.
      const rawIndexes = Array.isArray(selectedStepIndexes)
        ? selectedStepIndexes
        : (Number.isInteger(stepIndex) ? [stepIndex] : []);
      const indexes = [...new Set(rawIndexes.map((i: any) => Number(i)).filter((i: number) => Number.isInteger(i) && i >= 0 && i < steps.length))].sort((a, b) => a - b);
      const mode = op === 'merge' ? 'merge' : 'expand';
      const numbered = steps.map((s, i) => `${i + 1}. ${s.action}  =>  Expected: ${s.expected}`).join('\n');
      const plain = 'Write every action and expected result in plain, simple, everyday English a non-technical person can read  -  short sentences, common words, no jargon or internal field names.';

      let prompt: string;
      let userMessage: string;
      if (mode === 'merge' && indexes.length >= 2) {
        const picks = indexes.map((i) => i + 1).join(', ');
        prompt = `Here are a QA test case's steps (numbered):\n${numbered}\n\nMerge ONLY the steps at positions ${picks} into a SINGLE step  -  one action and one matching expected result that together capture what those steps did. Keep every OTHER step exactly as it is and in the same order; the merged step takes the position of the earliest merged step. ${plain} Return the COMPLETE new ordered list of steps.`;
        userMessage = 'Merge the selected steps into one.';
      } else if (indexes.length >= 1) {
        const picks = indexes.map((i) => i + 1).join(', ');
        prompt = `Here are a QA test case's steps (numbered):\n${numbered}\n\nExpand ONLY the steps at positions ${picks}: break each of those into a few smaller, concrete, executable sub-steps (one specific action and one observable expected result each). Keep every OTHER step exactly as it is and in the same order. ${plain} Return the COMPLETE new ordered list of steps. Target URL: ${targetUrl || 'not provided'}.`;
        userMessage = 'Expand the selected steps into finer sub-steps.';
      } else {
        const requestedCount = Math.max(2, Math.min(20, Number(targetStepCount) || 8));
        prompt = `Break this QA test case into exactly ${requestedCount} clear, granular, executable test steps. Preserve the original intent, credentials, assertions, and coverage. Each step is one specific action and one matching expected result. ${plain} Return the complete ordered list. Target URL: ${targetUrl || 'not provided'}. Test case: ${JSON.stringify(testCase)}`;
        userMessage = `Expand case steps to ${requestedCount}.`;
      }

      const ai = await getOrchestrator('stepExpander', { workspaceId: scope.userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt,
        schema: z.object({ steps: z.array(z.object({ action: z.string(), expected: z.string() })) }),
        userMessage,
      });
      const out = normalizeCaseSteps(result.object.steps).slice(0, 40).map((step) => ({
        action: cleanCaseText(step.action, stepRunScope),
        expected: cleanCaseText(step.expected, stepRunScope),
      }));
      // Never wipe the case: if the model returned nothing usable, keep the original steps.
      const finalSteps = out.length
        ? out
        : steps.map((step) => ({ action: cleanCaseText(step.action, stepRunScope), expected: cleanCaseText(step.expected, stepRunScope) }));
      res.json({ steps: finalSteps });
    } catch (err: any) {
      console.error('AI Step Edit Error:', err);
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });

  app.post('/api/agent/save-cases', async (req, res) => {
    try {
    const { cases, taskId } = req.body;
    if (!Array.isArray(cases) || !cases.length) {
      // A body without cases used to no-op with success:true — masking client bugs. Be explicit.
      return res.status(400).json({ error: 'cases array is required (each case with title/steps; include taskId to link the agent run).' });
    }
    // Memory-first, DB fallback: after a backend restart the run only exists in Postgres,
    // and losing the link silently dropped the plan/suite association of saved cases.
    const linkedRun = taskId
      ? (db.agentRuns.find((run: any) => run.id === taskId) || await AgentRuns.get(String(taskId)).catch(() => null))
      : null;
    const saveScope = reqScope(req);
    const caseProjectId = linkedRun?.projectId || saveScope.projectId || '';
    const caseAppId = linkedRun?.appId || saveScope.appId || '';
    const caseOwnerId = linkedRun?.ownerId || saveScope.userId || '';
    const linkedPlanId = linkedRun ? `PLAN-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    const linkedSuiteId = linkedRun ? `SUITE-${linkedRun.id.substring(0, 8).toUpperCase()}` : '';
    if (Array.isArray(cases)) {
      // Cases FK-reference the linked plan/suite, so they MUST exist before the upserts below.
      // The legacy engine created them at the review pause; the graph engine does not — saving
      // at a graph run's review previously hit cases_test_plan_id_fkey and hung the request.
      if (linkedRun) await ensureAgentPlanAndSuite(linkedRun);
      // Cases deleted in the review UI before saving must be deleted here too  -  otherwise
      // they stay in the DB as orphaned stale rows (previously mis-attributed to the wrong
      // case when index-derived ids shifted after a deletion).
      if (linkedRun) {
        const keepIds = new Set(cases.map((c: any) => c.id).filter(Boolean));
        const allCases = await Cases.list();
        const toRemove = allCases.filter((existing: any) => existing.agentRunId === linkedRun.id && !keepIds.has(existing.id));
        for (const existing of toRemove) await Cases.remove(existing.id);
      }
      // Save last-to-first so the generation order is preserved on display: both the PG list
      // (created_at DESC) and the in-memory list (unshift) surface newest-first, so persisting in
      // reverse index order makes case #1 the newest and keeps 1..N reading top-to-bottom (bug: cases
      // were previously saved in reverse of how they were generated).
      for (let index = cases.length - 1; index >= 0; index--) {
        const c = cases[index];
        const caseId = c.id || (linkedRun ? `TC-${linkedRun.id.substring(0, 4).toUpperCase()}-${index + 1}` : `TC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
        await Cases.upsert({
          id: caseId,
          title: c.title,
          description: buildCaseDescription(c),
          preconditions: c.preconditions || '',
          steps: normalizeCaseSteps(c.steps),
          testPlanId: c.testPlanId || linkedPlanId || null,
          testSuiteId: c.testSuiteId || linkedSuiteId || null,
          status: c.status || 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          type: c.type || 'Manual',
          priority: c.priority || 'Medium',
          automationStatus: c.automationStatus || 'Not Automated',
          testingScope: c.testingScope || (c.type === 'Automated' ? 'Automation' : 'Manual'),
          testingType: c.testingType || 'Functional',
          folderId: c.folderId || linkedRun?.folderId || null,
          createdBy: c.createdBy || 'QA Assistant',
          proposedBy: 'QA Assistant',
          approvalState: 'approved',
          agentRunId: c.agentRunId || linkedRun?.id || null,
          projectId: caseProjectId,
          appId: caseAppId,
          ownerId: caseOwnerId,
        });
      }
      persistDataInBackground('saved generated cases');
    }
    res.json({ success: true });
    } catch (err: any) {
      console.warn(`[agent] save-cases failed: ${err?.message || err}`);
      res.status(500).json({ error: getAIErrorMessage(err) || err?.message || 'Failed to save cases.' });
    }
  });

  app.post('/api/agent/explore-dom', async (req, res) => {
    try {
      const { targetUrl, username, password, open, interactions } = req.body;
      if (!targetUrl) return res.status(400).json({ error: 'targetUrl is required' });
      const credentials = username && password ? { username, password } : undefined;
      const result = await exploreAppElements({ targetUrl, credentials, open, interactions });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: getAIErrorMessage(err) });
    }
  });
}
