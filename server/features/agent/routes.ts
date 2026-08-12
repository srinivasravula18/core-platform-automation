import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, addActivity, persistDataInBackground } from '../../shared/storage';
import { readBlackboard } from './blackboard';
import { getFolderPath, resolveFolderForAgent } from '../../shared/folders';
import { tagNativeOrgEnabled } from '../../shared/orgMode';
import { getAIErrorMessage } from '../../shared/ai';
import { parseAIImageAttachments } from '../../shared/aiImageAttachments';
import { buildCredentialContext, resolveAgentTargetUrl, findSettingsCredentials } from '../../shared/url';
import { playwrightScriptsSchema, testCasesSchema } from '../../shared/schemas';
import { buildAgentExecutionSteps, buildCaseDescription, normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { nextArtifactId } from '../../shared/artifactIds';
import { capturePlaywrightEvidence, createAuthStorageState } from '../evidence/evidenceService';
import { gitGrep, readRepoFile, searchCodeWithContext } from '../git-agent/gitAgentService';
import { analyzeFeatureFromSource, discoverFeatureInventoryFromSource, proposeGapCases } from '../requirements/requirementService';
import { executePlaywrightScripts, killRunProcesses, sanitizeTestCode, repairTestCode } from '../playwright/executionService';
import { liveAuthor, emitScript, canLiveAuthorGoal, actionableAuthorBlockers } from './liveAuthor';
import { inspectFlow, flowToScript } from './flowInspector';
import { renderSelectorMap, mapHas, correctSelectorMethods, type SelectorMap } from './selectorMap';
// Phase 8 (decomposition slice 1): the repo selector-map cache moved to its own focused module.
import { getRunSelectorMap } from './routeHelpers/selectorMapCache';
import { promises as fsp, readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { inspectApplicationFlow } from './inspectionService';
import { exploreAndVerifyPage, exploreAppElements, rankVerifiedElements, setAuthStorageKeys } from './domExplorer';
import { resolveAppUnderstanding } from '../../agent-core/understandingProducer';
import { getFeatureGrounding } from './knowledge';
import { projectRunLifecycleSafe } from '../../../services/runtime/src/application/sessionProjector';
import { getOrchestrator, listConfiguredProviders, resolveProviderForAgent, resolveModelForAgent } from '../../ai/orchestrator';
import { agentSetupReadiness } from './setupReadiness';
import { assembleConversationContext } from '../../ai/memory/contextAssembler';
import { answerAppQuestionFromCode, stripCodebaseLocationsForAgentConsole } from '../../ai/supervisor';
import { buildKnowledgeBlock, recordObservation } from '../knowledge/knowledgeService';
import { resolveCredentials, maskPassword } from '../credentials/credentialsService';
import {
  detectSurfaceKind, resolveTargetApp, buildAppScopedUrl, connForRun,
  fetchCorePlatformApps, fetchCorePlatformAppTabs, ALL_APPS_ID, loadAdminNavModules, resolveAdminModuleFromRefs, isMutationIntent,
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
// Agent-native substrate (P2): the console renders the REAL A2A bus + blackboard for a run. Flag-gated.
import { isAgentNativeEnabled } from '../../agent-core/agentNativeFlag';
import { getMessageBus } from '../../agent-core/bus/messageBus';
import { getBlackboard } from '../../agent-core/bus/blackboard';
import { buildDefectDrafts } from './workflow/defectReporter';
import type { MissionRef } from './workflow/state';
import { renderTargetCatalogForPrompt } from './compiler/renderCatalogForPrompt';
import { testPlanSchema, parseTestPlan } from './compiler/testPlan';
import { semanticPlanFromCase } from './compiler/semanticPlanner';
import { scoreCaseReuse } from './caseReuse';
import { mergeScriptsByCase, reviewedCasesForRun, syncReviewedCases } from './caseCollection';
import { pushInboxItem } from '../inbox/routes';
import { agentRunStatusForList, isPendingReviewTestRun } from '../../../core/shared/testRunStatus';
import { AgentRuns, ChatConversations, Suites, Cases, Runs, Reports, Scripts, Folders, Requirements, Defects, Plans, isPgEnabled } from '../../db/repository';
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
import { generateValidCaseRework, requestsAdditionalCaseStep } from './reworkCaseValidation';
import { prepareSse, sendSse } from '../../shared/sse';
import { runTestAuthorAgentAuto } from './toolloop/testAuthorAgent';

function wantsCodeGroundedTestUnderstanding(value: string): boolean {
  const text = String(value || '').toLowerCase();
  // A bare "test <feature>" verb (e.g. "test list view at Accounts CRM") is a test-generation
  // request too  -  not just literal "test cases"/"coverage"  -  so include `test` as a trigger.
  // Without it those requests skip code grounding and fall back to the terse understanding.
  return /\b(test|cases?|test\s*areas?|coverage|scenarios?|qa|regression|what\s+(?:can|should)\s+i\s+test|write|create|generate|draft)\b/.test(text)
    && /\b(test|case|cases|qa|coverage|scenario|scenarios|regression)\b/.test(text);
}

const REVIEW_BRIEF_VERSION = 'review-brief-v1';
const REVIEW_BRIEF_INSTRUCTIONS = `
REVIEW CARD OUTPUT CONTRACT — follow this exactly:
- Write a source-grounded coverage brief titled "<Feature> — What to Test", not a generated test-case artifact.
- Open with "Here is the full test brief for **<feature and app>**, grounded in the actual source code"; mention executed test evidence only when it is actually present in the supplied evidence.
- Organize the response into numbered functional-area sections such as fields and validation, action behavior, boundaries, duplicate handling, list behavior, permissions, and access preconditions.
- Describe confirmed controls, business behavior, validation timing/messages, edge cases, and evidence gaps. Label unknown behavior as an "Untested Gap" and explain what must be probed.
- Tables are allowed for compact field/control inventories. Use concise bullets for behavior matrices and edge cases.
- NEVER output individual generated test cases: no case IDs, case titles, numbered scenario rows, per-case steps/expected-results, priorities, tags, or automation types. Those belong to the generation stage after approval.
- Do not claim a behavior is verified, executed, required, unique, or permission-gated unless the source or supplied evidence proves it.`;

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
    // Fold the substrate's size in so a new A2A message/fact pushes an SSE update to the console.
    conversation: snapshot.conversation && [snapshot.conversation.messages?.length ?? 0, snapshot.conversation.facts?.length ?? 0],
  });
}

/** Trim a payload/value to a bounded, JSON-safe shape for the wire (the console expands these inline). */
function lightPayload(value: any) {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, 800);
  try { return JSON.parse(JSON.stringify(value).slice(0, 1600)); }
  catch { return String(value).slice(0, 800); }
}

/**
 * P2 — the live agent-to-agent CONVERSATION for a run: the real typed messages exchanged on the bus plus
 * the append-only blackboard facts, straight from the substrate P1 populates. Flag-gated by AGENT_NATIVE_V1
 * (off → null, so the console falls back to the legacy chips and nothing changes). Best-effort: any substrate
 * read error yields null rather than failing the status endpoint. This is what makes the console "real" —
 * it renders what agents actually said, not a template.
 */
async function attachConversation(snapshot: any, runId: string): Promise<void> {
  if (!snapshot || !isAgentNativeEnabled()) return;
  try {
    const [messages, facts] = await Promise.all([
      getMessageBus().history(runId),
      getBlackboard().all(runId),
    ]);
    if (!messages.length && !facts.length) return; // nothing on the substrate yet — keep chips as the view
    snapshot.conversation = {
      messages: messages.map((m) => ({ id: m.id, seq: m.seq, from: m.from, to: m.to, type: m.type, at: m.at, causationId: m.causationId, payload: lightPayload(m.payload) })),
      facts: facts.map((f) => ({ id: f.id, seq: f.seq, kind: f.kind, key: f.key, at: f.provenance.at, by: f.provenance.by, value: lightPayload(f.value) })),
    };
  } catch {
    /* substrate read failed — leave the snapshot on its legacy chips */
  }
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
  if (run.testPlanId) return run.testPlanId;
  // Synthesize a plan id ONLY when the run produced cases (so a Plan row is created to satisfy the
  // cases.test_plan_id FK); a run with no cases carries no plan reference.
  const hasCases = Array.isArray(run.generated_cases) && run.generated_cases.length > 0;
  return hasCases ? `PLAN-${run.id.substring(0, 8).toUpperCase()}` : '';
}

function agentSuiteId(run: any): string {
  return run.testSuiteId || run.generatedSuiteId || `SUITE-${run.id.substring(0, 8).toUpperCase()}`;
}

// Match names only inside a folder (and a selected plan) so separately managed areas stay distinct.
function normalizedSuiteName(name: unknown): string {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function agentCaseId(run: any, index: number): string {
  return `TC-${run.id.substring(0, 4).toUpperCase()}-${index + 1}`;
}

function runCaseId(run: any, index: number): string {
  const testCase = Array.isArray(run?.generated_cases) ? run.generated_cases[index] : null;
  return testCase?.reused && testCase?.existingCaseId ? testCase.existingCaseId : agentCaseId(run, index);
}

function agentRunRecordId(run: any): string {
  return `RUN-${run.id.substring(0, 8).toUpperCase()}`;
}

function agentReportId(run: any): string {
  return `REP-${run.id.substring(0, 8).toUpperCase()}`;
}

// The bare SUBJECT of a run's artifacts — the feature/area under test, with NO scope suffix (the name
// builders below add scope). Prefers the LLM-designed feature title (from the user's request) so names
// read as a QA engineer would write them; falls back to app·module context, then the URL host, then
// the prompt. Never contains a tool label like "Agent".
function artifactSubject(run: any): string {
  // The agent-authored suite title (written from the actual generated cases + the user's request — see
  // ensureSuiteTitle) is the best, most human-readable name; prefer it over any derived label.
  const authored = String(run.suiteTitle || '').trim();
  if (authored) return authored;
  const llm = String(run.feature_understanding?.title || '').trim();
  if (llm) return llm;
  const app = String(run.target_app_label || run.appName || '').trim();
  const module = String(run.mission_context?.module?.name || run.mission_context?.tab?.name || '').trim();
  const subject = [app, module].filter(Boolean).join(' · ');
  if (subject) return subject;
  try {
    const host = new URL(run.app_url || '').hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').trim();
    if (host) return host.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { /* no usable URL */ }
  return String(run.prompt || 'Test').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Test';
}

// Human display name for reports/scripts/requirement titles — the clean subject, no "Agent"/scope noise.
function agentDisplayName(run: any): string {
  return artifactSubject(run);
}

// QA-standard artifact naming (no tool prefix like "Agent", no formula suffix). A SUITE/PLAN is just
// the agent-authored title. A RUN appends execution context (timestamp + environment) so repeated
// executions of the same suite stay distinguishable and traceable, as every QA tool expects.
function formatRunStamp(run: any): string {
  const raw = run?.startedAt || run?.createdAt || run?.created_at;
  const dt = raw ? new Date(raw) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
function agentSuiteName(run: any): string {
  return artifactSubject(run);
}
function agentRunName(run: any): string {
  const env = String(run?.environment || run?.target_environment || '').trim();
  return `${artifactSubject(run)} · ${formatRunStamp(run)}${env ? ` · ${env}` : ''}`;
}
function agentPlanName(run: any): string {
  return artifactSubject(run);
}

// Have the AGENT author a clear, human-readable suite title from the actual generated cases + the
// user's request — so a suite/run/plan reads like a QA engineer named it ("Admin list view: display,
// filtering, sorting, and export"), not a terse feature label. Best-effort and idempotent: runs once
// per completed run (only when cases exist and no title is set yet); any failure leaves the derived
// fallback name in place. Provider access respects the owner's Access-Group grants (userId threaded).
async function ensureSuiteTitle(run: any): Promise<void> {
  if (String(run?.suiteTitle || '').trim()) return;
  const cases = Array.isArray(run?.generated_cases) ? run.generated_cases : [];
  if (cases.length === 0) return;
  try {
    const caseTitles = cases.map((c: any) => String(c?.title || c?.name || '').trim()).filter(Boolean).slice(0, 20);
    if (caseTitles.length === 0) return;
    const orchestrator = await getOrchestrator('chatAssistant', { workspaceId: run.ownerId || 'default', userId: run.ownerId });
    const res = await orchestrator.generateObject<{ title: string }>({
      prompt: `You are naming a QA TEST SUITE so a tester or manager understands it at a glance.

User's request: ${String(run.prompt || '').slice(0, 300) || 'not provided'}
Feature under test: ${String(run.feature_understanding?.title || '').slice(0, 120) || 'not provided'}
Titles of the generated test cases:
${caseTitles.map((t: string) => `- ${t}`).join('\n')}

Write ONE clear, human-readable suite title in Title Case, 5-10 words, that names the feature/area under test and what it broadly covers. Good examples: "Record Creation and Validation", "Search, Filtering, and Export", "Login and Session Handling". Rules: plain English a non-engineer understands; NO tool words like "agent"; no credentials, URLs, dates, or the word "test"/"suite" padding. Return only the title.`,
      schema: z.object({ title: z.string() }),
      userMessage: String(run.prompt || ''),
    });
    const title = String((res as any)?.object?.title || '').trim();
    if (title) run.suiteTitle = title.slice(0, 120);
  } catch {
    // Best-effort — fall back to the derived subject name.
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

/**
 * Test Run summaries are case-level. Generated-case steps are checklist rows and
 * must not turn five cases with four steps each into twenty "untested" cases.
 */
function summarizeAgentCaseExecution(run: any) {
  const cases = Array.isArray(run.generated_cases) ? run.generated_cases : [];
  // Prefer the authoritative execution result (per-test verdicts) — evidence status is often unset,
  // which is why the Runs section showed 0 passed/0 failed for a run that actually executed.
  const tests = Array.isArray(run.execution_result?.tests) ? run.execution_result.tests : [];
  if (tests.length) {
    let passed = 0;
    let failed = 0;
    for (const t of tests) {
      const status = String(t?.status || '');
      if (/pass/i.test(status)) passed += 1;
      else if (/(fail|timedout|interrupted|error)/i.test(status)) failed += 1;
    }
    return { total: cases.length || tests.length, passed, failed };
  }
  const evidenceByCaseIndex = new Map<number, any>(
    (Array.isArray(run.evidence_screenshots) ? run.evidence_screenshots : [])
      .map((evidence: any) => [evidence.testCaseIndex, evidence]),
  );
  let passed = 0;
  let failed = 0;
  for (let index = 0; index < cases.length; index++) {
    const status = String(evidenceByCaseIndex.get(index)?.status || '');
    if (/pass/i.test(status)) passed += 1;
    else if (/(fail|timedout|interrupted)/i.test(status)) failed += 1;
  }
  return { total: cases.length, passed, failed };
}

async function persistAgentRunAndReportArtifacts(run: any) {
  await ensureSuiteTitle(run); // agent-author the artifact title before run/suite/report names are built
  const baseName = agentDisplayName(run);
  const date = new Date().toISOString().split('T')[0];
  const { executionSteps, failed, passed, notVerified, firstFailure, reportStatus, progressLabel } = summarizeAgentRunExecution(run);
  const caseExecution = summarizeAgentCaseExecution(run);
  const runRecordId = agentRunRecordId(run);
  const listStatus = agentRunStatusForList(run.status);
  const pendingReview = isPendingReviewTestRun({ status: listStatus });
  const caseIds = (Array.isArray(run.generated_cases) ? run.generated_cases : []).map((_: any, index: number) => runCaseId(run, index));
  // Real elapsed time (excludes human review pause) — shared by the run AND its report so the
  // report's Duration is an actual time, not the literal "Generated" (#6).
  const durationLabel = run.completed_at && run.created_at
    ? `${Math.max(0, Math.round((Date.parse(run.completed_at) - Date.parse(run.created_at) - (run.paused_ms || 0)) / 1000))}s`
    : 'Pending';

  await Runs.upsert({
    id: runRecordId,
    name: agentRunName(run),
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds,
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    status: listStatus,
    state: pendingReview ? 'Pending Review' : listStatus,
    progress: progressLabel,
    date,
    totalExecutions: caseExecution.total,
    passed: caseExecution.passed,
    failed: caseExecution.failed,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    triggerType: 'agent',
    proposedBy: 'QA Assistant',
    approvalState: pendingReview ? 'pending_review' : 'approved',
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: agentReportId(run),
    name: `${baseName} — Report`,
    runId: runRecordId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: run.testPlanId ? agentPlanName(run) : '',
    suiteName: agentSuiteName(run),
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

  // A "run failed" is not, on its own, a product bug: it can mean the app misbehaved (the rich
  // per-signature defects below, built from real Playwright test results, already file THAT case
  // correctly and exclude tooling/harness faults) or it can mean the agent never got as far as
  // executing anything (an authoring/orchestration failure — e.g. "stopped mid-generation"). The
  // unconditional Defect this block used to file here for EVERY failed run — titled "Run failed" and
  // described by the last 3 workflow status/chip lines (not a real error) — produced exactly the
  // confusing, non-actionable "bugs" QA flagged: orchestration noise and tooling faults mislabeled as
  // product defects, sometimes with a real underlying error truncated by the UI's generic-failure
  // fallback because this text never carried a classifiable one. Removed; the rich path below is the
  // sole source of auto-filed Bugs.

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
        scope: { projectId: run.projectId || null, appId: run.appId || null, ownerId: run.ownerId || null, folderId: run.folderId || null },
      });
      await persistDefectReport(report, run.id);
    }
  } catch (err) {
    console.warn(`[agent] run ${run.id}: per-signature defect filing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistAgentQualityArtifacts(run: any) {
  await persistAgentCaseArtifacts(run);
  await persistAgentRequirementArtifact(run).catch((err) => console.warn(`[agent] run ${run.id}: requirement persist failed: ${err?.message || err}`));
  await persistAgentRunAndReportArtifacts(run);
  await saveAgentRunState(run, 'agent quality artifacts');
}

/** UI-selector index for a requirement — harvested from the run's VERIFIED selectors in the compiled
 *  scripts (the authoritative source on graph runs) plus live inspection when present. Shape matches the
 *  Requirements uiSelectors model so the section renders labels/roles/ids the agent actually used. */
function buildAgentRequirementSelectors(run: any): Record<string, unknown> {
  const labels = new Set<string>();
  const aria = new Set<string>();
  const cssIds = new Set<string>();
  const roleNames = new Map<string, { role: string; name: string }>();
  const fieldIds: Array<{ label: string; id: string }> = [];

  const ctx = run.inspection_context || {};
  for (const form of (ctx.visibleForms || [])) for (const fld of (form?.fields || [])) {
    if (fld?.label) labels.add(String(fld.label));
    if (fld?.dom) fieldIds.push({ label: String(fld.label || ''), id: String(fld.dom) });
  }
  for (const table of (ctx.visibleTables || [])) for (const h of (table?.headers || [])) {
    labels.add(String(h)); roleNames.set(`columnheader:${h}`, { role: 'columnheader', name: String(h) });
  }
  for (const nav of (ctx.visibleNavigation || [])) if (typeof nav === 'string') labels.add(nav);

  // Verified selectors emitted into the compiled scripts: {selector, selectorType, role, label}.
  for (const s of (Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [])) {
    const code = String(s?.code || '');
    for (const m of code.matchAll(/"label":"((?:[^"\\]|\\.)*)"/g)) { if (m[1]) labels.add(m[1].replace(/\\"/g, '"')); }
    for (const m of code.matchAll(/"role":"([^"]+)"\s*,\s*"label":"((?:[^"\\]|\\.)*)"/g)) roleNames.set(`${m[1]}:${m[2]}`, { role: m[1], name: m[2].replace(/\\"/g, '"') });
    for (const m of code.matchAll(/"selector":"#([a-zA-Z0-9_:-]+)"/g)) cssIds.add(m[1]);
    for (const m of code.matchAll(/aria-label=\\?"([^"\\]+)/g)) aria.add(m[1]);
  }
  return {
    ariaLabels: [...aria], labels: [...labels], roleNames: [...roleNames.values()],
    uiHooks: [], testIds: [], cssIds: [...cssIds], cssClasses: [], placeholders: [], fieldIds, fileCount: 0,
  };
}

/** Persist a REQUIREMENT from a completed run so the Requirements section reflects what the agent tested.
 *  Uses the code-derived feature_understanding when present, else synthesizes from prompt + live inspection. */
async function persistAgentRequirementArtifact(run: any) {
  const cases = reviewedCasesForRun(run);
  if (!cases.length) return; // no coverage → nothing to require
  const fu = run.feature_understanding || {};
  await ensureSuiteTitle(run);
  const title = String(fu.title || artifactSubject(run) || run.prompt || 'Requirement').slice(0, 200);
  await Requirements.upsert({
    id: `REQ-${run.id.substring(0, 8).toUpperCase()}`,
    title,
    description: String(fu.description || run.prompt || '').slice(0, 2000),
    featureQuery: String(run.prompt || '').slice(0, 2000),
    businessRules: Array.isArray(fu.businessRules) ? fu.businessRules : [],
    srsModules: Array.isArray(fu.srsModules) ? fu.srsModules : [],
    dataPopulationNotes: String(fu.dataPopulationNotes || ''),
    metadataRefs: Array.isArray(fu.metadataRefs) ? fu.metadataRefs : [],
    uiSelectors: (fu.uiSelectors && Object.keys(fu.uiSelectors).length) ? fu.uiSelectors : buildAgentRequirementSelectors(run),
    sourceFiles: Array.isArray(fu.sourceFiles) ? fu.sourceFiles : [],
    coverageStatus: 'covered',
    status: 'Draft',
    approvalState: 'pending_review',
    proposedBy: 'QA Assistant',
    sourceRunId: run.id,
    folderId: run.folderId || null,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });
  persistDataInBackground('agent requirement artifact');
}

async function persistAgentCaseArtifacts(run: any) {
  await ensureAgentPlanAndSuite(run);
  const planId = agentPlanId(run);
  const suiteId = agentSuiteId(run);

  const cases = reviewedCasesForRun(run);
  const groupTag = runGroupTag(run); // stamped on every case so the whole run shares one findable tag
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
      tags: normalizeCaseTags([...(testCase.tags || []), groupTag]),
      // Agent-run output is automation; an explicit type from the generator still wins.
      type: testCase.type || 'Automated',
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

// The tag-native replacement for the old "results folder": one grouping tag derived from the run's
// feature/subject, applied to every artifact this run creates so they stay together and are findable
// by a single tag (Repository tag rail + list-page tag filters). Empty when no subject is available.
function runGroupTag(run: any): string {
  const subject = String(run?.feature_understanding?.title || agentDisplayName(run) || run?.prompt || '')
    .split(/[.\n]/)[0].trim().slice(0, 40);
  return subject ? (normalizeCaseTags([subject])[0] || '') : '';
}

// Suite creation shared by terminal persistence AND /api/agent/save-cases. A plan is linked
// only when the user selected one; generating cases must not create a Test Plan implicitly.
async function ensureAgentPlanAndSuite(run: any) {
  await ensureSuiteTitle(run); // idempotent — ensures the agent-authored title exists for the suite name
  const planId = agentPlanId(run);
  let suiteId = agentSuiteId(run);
  const baseName = agentDisplayName(run);

  await ensureFolderInPg(run.folderId || '');

  // The suite's tags should reflect the coverage it actually holds  -  reuse the real tags the
  // cases were generated with (deduped), not a generic "@agent" label the user doesn't recognize.
  // Union of the real case tags + the per-run grouping tag, so plan + suite share the run's label.
  const suiteTags = Array.from(new Set([
    ...(run.generated_cases || []).flatMap((c: any) => normalizeCaseTags(c.tags || [])),
    runGroupTag(run),
  ].filter(Boolean)));

  // Persist a Test PLAN from the run's real data so the Plans section is populated and cases link to it.
  // Agent-synthesized plans only — a user-selected plan (run.testPlanId) is left untouched. Created BEFORE
  // the suite/cases so the cases.test_plan_id FK to plans(id) resolves.
  if (!run.testPlanId && planId) {
    const planCases = reviewedCasesForRun(run);
    const distinct = (arr: any[]) => Array.from(new Set(arr.map((s) => String(s || '').trim()).filter(Boolean)));
    const analyst = run.analyst_report || null;
    const riskScore = Number(analyst?.riskScore ?? 0);
    const riskLevel = riskScore >= 60 ? 'High' : riskScore >= 25 ? 'Medium' : 'Low';
    let envHost = String(run.app_url || '');
    try { envHost = new URL(String(run.app_url)).host; } catch { /* keep raw */ }
    await Plans.upsert({
      id: planId,
      name: baseName,
      description: String(run.feature_understanding?.description || run.prompt || '').slice(0, 2000),
      scope: String(run.prompt || '').slice(0, 2000),
      objectives: String(analyst?.narrative || run.feature_understanding?.title || run.prompt || '').slice(0, 2000),
      inScope: planCases.map((c: any) => `- ${c.title}`).join('\n'),
      testTypes: distinct(planCases.map((c: any) => c.testingType || c.testing_type || 'Functional')).join(', '),
      environments: envHost,
      risks: analyst ? distinct([...(analyst.rationale || []), ...((analyst.businessRuleViolations || []).map((v: any) => v?.title || v?.rule || v))]).join('\n') : '',
      riskLevel,
      status: 'Draft',
      folderId: run.folderId || null,
      owner: 'QA Assistant',
      proposedBy: 'QA Assistant',
      approvalState: 'pending_review',
      sourceRunId: run.id,
      runIds: [run.id],
      tags: suiteTags.length ? suiteTags : ['@generated'],
      projectId: run.projectId || '',
      appId: run.appId || '',
      ownerId: run.ownerId || '',
    });
  }

  if (!run.testSuiteId) {
    const suiteName = agentSuiteName(run);
    // A suite's identity is folder + name. Reuse a same-folder, same-name suite regardless of plan — each run
    // synthesizes its OWN per-run plan id, and requiring plan-equality here fragmented one subject into a new
    // suite per run (the "1 suite for some, 2 for others" inconsistency). This restores the documented
    // reuse-by-name-in-folder intent; a suite can group cases across runs/plans (runIds already tracks them).
    const matchingSuite = (await Suites.list()).find((suite: any) =>
      suite.folderId === (run.folderId || null)
      && normalizedSuiteName(suite.name) === normalizedSuiteName(suiteName),
    );

    if (matchingSuite) {
      // A workspace action may already have created this suite before the agent persists cases.
      run.generatedSuiteId = matchingSuite.id;
      suiteId = matchingSuite.id;
    } else {
      await Suites.upsert({
        id: suiteId,
        name: suiteName,
        description: `Generated suite for ${run.app_url || baseName}`,
        testPlanId: planId || null,
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
      name: script.filename || script.test_case_title || `${baseName} — Script ${index + 1}`,
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

function runDetailsPayload(run: any): any {
  return {
    ...run,
    // Same graph-gate derivation as runStatusSnapshot so the full-details refetch agrees with polling.
    review_stage: run?.review_stage || run?.pending_review?.kind || '',
    generated_cases: annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(run.generated_cases || [], run), run),
    all_generated_cases: annotateGeneratedCasesWithProof(normalizeGeneratedCasesText(reviewedCasesForRun(run), run), run),
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
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]);
  const businessRules = splitRequirementList(requirementSection(text, /^\s*Business rules\s*:?\s*/im, [
    /^\s*Metadata objects\s*:?/im,
    /^\s*Key source files\s*:?/im,
    /^\s*Candidate scenarios\s*\(/im,
  ]));
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
// The CURRENT request signal for reuse/requirement matching: the prompt with its embedded "Prior agent answer
// (background only …)" block removed, so a new request ("list view") is not matched against the PREVIOUS
// answer's vocabulary (app creation). The user request, resolved scope, and user-selected target are kept.
function currentRequestText(run: any): string {
  return String(run?.prompt || '')
    .replace(/Prior agent answer \(background only[\s\S]*?(?=\n\s*(?:User[-\s]selected target:|User follow-up\/request|Resolved scope from router:)|$)/i, '')
    .trim();
}
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
  const text = [currentRequestText(run), run.approvedUnderstanding, u.title, ...(Array.isArray(u.businessRules) ? u.businessRules : []), ...inventoryTerms]
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
  const query = `${currentRequestText(run)} ${run.feature_understanding?.title || ''}`.trim();
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
  await persistAgentScripts(run);

  const executionSteps = buildAgentExecutionSteps(run);
  const caseExecution = summarizeAgentCaseExecution(run);
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
  const listStatus = agentRunStatusForList(run.status);
  const pendingReview = isPendingReviewTestRun({ status: listStatus });

  await Runs.upsert({
    id: existingRunId,
    name: agentRunName(run),
    suiteId: agentSuiteId(run),
    testPlanId: agentPlanId(run),
    caseIds: (run.generated_cases || []).map((_: any, index: number) => runCaseId(run, index)),
    requestedBy: 'QA Assistant',
    executionTime: durationLabel,
    status: listStatus,
    state: pendingReview ? 'Pending Review' : listStatus,
    progress: progressLabel,
    date,
    totalExecutions: caseExecution.total,
    passed: caseExecution.passed,
    failed: caseExecution.failed,
    targetUrl: run.app_url || '',
    folderId: run.folderId || null,
    steps: executionSteps,
    evidence: run.evidence_screenshots || [],
    triggerType: 'agent',
    proposedBy: 'QA Assistant',
    approvalState: pendingReview ? 'pending_review' : 'approved',
    sourceRunId: run.id,
    agentRunId: run.id,
    projectId: run.projectId || '',
    appId: run.appId || '',
    ownerId: run.ownerId || '',
  });

  await Reports.upsert({
    id: existingReportId,
    name: `${baseName} — Report`,
    runId: existingRunId,
    planId: agentPlanId(run),
    suiteId: agentSuiteId(run),
    planName: run.testPlanId ? agentPlanName(run) : '',
    suiteName: agentSuiteName(run),
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
- When the request or reviewed understanding names a business app/object, use that business name in titles/descriptions; do not expose environment ids or internal slugs unless that is the only user-facing name available.
- Never put URLs in titles, descriptions, or steps; mention the selected app/area name instead.
- If the selected target/surface conflicts with the source-grounded owner of the requested feature, do NOT blend the names. State the mismatch plainly in the reviewed understanding and generate cases for the actual owning surface only if the user approves that target; mention the originally selected target only when it has a real post-flow behavior to verify.
- Do not mention authentication, login, sign-in, credentials, username, or password anywhere in the case text unless the user explicitly asked for authentication coverage  -  login is only ever a silent setup/precondition step, never the subject of a case.
- Write titles, descriptions, preconditions, and every step action and expected result in plain, black-box, user-facing English: what a user does and sees on screen, in short sentences with common words. NEVER use internal identifiers (camelCase/snake_case names like "created_at" or "appId", component/file/prop names), database or implementation terms ("bootstrap", "deduplication", "persisted", "AND filters", "descending"), or developer phrasing  -  describe the visible on-screen outcome instead (say "sorted with the newest first", not "created_at descending"; "a default view appears automatically", not "a bootstrap view is created"; "opening it again does not add a duplicate").
- The description is ONE short plain sentence saying what the case checks and why. Do not restate the steps in it and do not embed a "Test Steps:" or "Expected:" list  -  the case has a separate Steps section.
- PRECONDITIONS ARE REQUIRED and concrete: for every case, state in ONE plain sentence the exact state that must already be true before the steps run — the signed-in role/permissions, which app/surface is open, and any records, metadata, or configuration that must already exist (e.g. "Signed in as an Admin with the Sales app open and at least one account record present"). This is where setup/login belongs (per the rule above), so keep it out of the title, description, and steps. Never leave preconditions empty and never restate the steps; if the only requirement is being signed in, say so naming the role and app.
- STEPS MUST BE DETAILED AND CONCRETE: each step is ONE specific user/system action naming the REAL on-screen element (the exact label/field/button/menu from the evidence) paired with its own specific, OBSERVABLE expected result for that action. No vague steps ("verify it works", "check the page"), no invented labels, no meta/setup scaffolding (CI, seeding, regression jobs). A reviewer must be able to follow the steps by hand and a Playwright script must be able to mirror them 1:1.
- TEST DESIGN  -  design coverage deliberately like a senior QA engineer, not just one happy path. Apply the techniques the feature's real behaviour supports: happy path; equivalence partitioning (one case per valid input class); boundary values (empty, minimum, maximum, over-maximum, max-length); decision tables for combined conditions; state transitions (create -> edit -> delete); negative/invalid input and error states; permission/role (RBAC) differences; and disabled/empty/loading/error states, including WHEN an action is unavailable (e.g. disabled while busy, disabled without permission, disabled for a protected/default item). Cover the highest-value behaviors first; never pad past the requested count.
- Each case includes automation tags in @ format (@bvt, @sanity, @regression, @smoke, @ui, @positive, @negative, ...). If the user requested specific tag types, apply those exact tags to every generated case.
- Every case tests the TARGET APPLICATION's own UI/behavior. NEVER write cases about the QA assistant, the chat/conversation, app-selection replies ("verify a follow-up of X applies to the request"), request routing/scoping, or test-generation itself  -  none of that is application behavior a user can perform in the app under test.`;

export function hasRunnableScripts(scripts: unknown): boolean {
  return Array.isArray(scripts) && scripts.length > 0;
}

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
  // context carries the folder-ask continuation args so a client that navigated away mid-thinking can re-attach
  // by conversation and rebuild the review card without re-running the understanding.
  const understandingJobs = new Map<string, { status: 'running' | 'done'; result?: any; createdAt: number; conversationId?: string; ownerId?: string; context?: any; consumed?: boolean }>();
  const UNDERSTANDING_JOB_TTL_MS = 30 * 60 * 1000;
  function pruneUnderstandingJobs() {
    const cutoff = Date.now() - UNDERSTANDING_JOB_TTL_MS;
    for (const [id, job] of understandingJobs) if (job.createdAt < cutoff) understandingJobs.delete(id);
  }
  // The review gate is a one-shot: once the user proceeds (a run starts) or cancels, the job must stop
  // being re-attachable. Without this it stayed offerable for its whole TTL, so any later reload grafted
  // a second "Look right? … Proceed" card onto a conversation whose run was already underway.
  function consumeUnderstandingJobs(conversationId: string) {
    const id = String(conversationId || '').trim();
    if (!id) return;
    for (const job of understandingJobs.values()) if (job.conversationId === id) job.consumed = true;
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
    // Attention layer: only carry the prior scope forward when the CURRENT target hasn't changed. If the user
    // gave a target URL whose host is absent from the carried scope (they switched app/surface mid-chat), do
    // NOT reuse the prior scope as authoritative — fall through to fresh grounding for the new target. No
    // explicit target, or a matching host → carry forward exactly as before (non-regressive).
    const carriedTargetMatches = (() => {
      if (!rawTargetUrl) return true;
      try { return carriedScope.toLowerCase().includes(new URL(rawTargetUrl).host.toLowerCase()); }
      catch { return true; }
    })();
    if (!correction && carriedScope && carriedTargetMatches && isShortFollowUpAction(rawOriginalRequest || rawPrompt)) {
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
      const reviewPrompt = `${groundingPrompt}\n\n${REVIEW_BRIEF_INSTRUCTIONS}`;
      const cacheKey = featureCacheKey(rawTargetUrl, groundingPrompt, [REVIEW_BRIEF_VERSION, scope.userId, scope.projectId, scope.appId].filter(Boolean).join(':'));
      const cached = getCached(understandingCache, cacheKey);
      if (cached) return cached;
      try {
        const targetLabel = rawTargetName || rawTargetUrl;
        const apps = targetLabel
          ? [{ name: rawTargetName || targetLabel, baseUrl: rawTargetUrl || targetLabel }]
          : undefined;
        const grounded = await answerAppQuestionFromCode(reviewPrompt, {
          workspaceId: scope.userId || 'default',
          userId: scope.userId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
        });
        const understanding = stripCodebaseLocationsForAgentConsole(String(grounded || '').trim());
        if (understanding) {
          const result = {
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
          setCached(understandingCache, cacheKey, result);
          return result;
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
          (rawContextPrompt ? `Prior conversation context (BACKGROUND ONLY — informative, not authoritative; it must NEVER change the target/app/surface stated below):\n${rawContextPrompt}\n` : '') +
          `AUTHORITATIVE target for THIS request (overrides anything implied by the background above) — name: ${rawTargetName || 'not provided'}, URL: ${rawTargetUrl || 'not provided'}\n` +
          (currentUnderstanding ? `Current understanding:\n${String(currentUnderstanding)}\n` : '') +
          (correction ? `User correction/revision:\n${String(correction)}\n` : '') +
          `\nThe "understanding" field must be concise, user-facing plain text with these sections: Here's what I understood, Target, Task, Plan.\n` +
          `Also create "suggestedFolderName": a short, human-readable folder/artifact name based on the user's request and target app, e.g. "<Area> - <Behavior>". Do not use a full sentence.`,
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
    understandingJobs.set(jobId, {
      status: 'running', createdAt: Date.now(),
      conversationId: String(body.conversationId || '').trim() || undefined,
      ownerId: scope.userId || undefined,
      // Enough to rebuild the review card on re-attach (see /for-conversation below).
      context: {
        prompt: body.prompt, originalRequest: body.originalRequest, contextPrompt: body.contextPrompt,
        targetUrl: body.targetUrl, websiteId: body.websiteId, websiteName: body.targetName || body.websiteName,
      },
    });
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

  // Re-attach after a navigate-away: return the latest understanding job for this conversation (owned by the
  // caller) with the context needed to rebuild the review card. Lets the console resume a "thinking" that was
  // in flight when the user left, instead of dropping it.
  app.get('/api/agent/understand-request/for-conversation/:conversationId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    pruneUnderstandingJobs();
    const conversationId = String(req.params.conversationId || '').trim();
    const ownerId = reqScope(req).userId || '';
    if (!conversationId) return res.json({ job: null });
    let latest: { jobId: string; job: any } | null = null;
    for (const [jobId, job] of understandingJobs) {
      if (job.conversationId !== conversationId) continue;
      if (job.consumed) continue; // already proceeded/cancelled — never offer the review gate twice
      if (ownerId && job.ownerId && job.ownerId !== ownerId) continue;
      if (!latest || job.createdAt > latest.job.createdAt) latest = { jobId, job };
    }
    if (!latest) return res.json({ job: null });
    res.json({ job: { jobId: latest.jobId, status: latest.job.status, result: latest.job.result ?? null, context: latest.job.context ?? null } });
  });

  // The client calls this when the user dismisses the review card, so a cancelled gate cannot re-attach.
  app.delete('/api/agent/understand-request/for-conversation/:conversationId', (req, res) => {
    consumeUnderstandingJobs(String(req.params.conversationId || ''));
    res.json({ ok: true });
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

  // Runs are keyed by conversation (indexed), so the console can recover a run whose deep-run card
  // never reached the chat snapshot (navigated away mid-start). Slim descriptors — id is enough.
  app.get('/api/agent-runs/for-conversation/:conversationId', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.json({ runs: [] });
    const runs = await AgentRuns.listByConversation(conversationId, { limit: 25 });
    const scoped = scopeFilter(runs, reqScope(req));
    res.json({
      runs: scoped.map((run: any) => {
        // Truthful status: heal an orphaned "running" run (dead process) to failed, as the main list does.
        const healed = orphanedRunFailure(run);
        if (healed) void reconcileRunIfOrphaned(run).catch(() => undefined);
        const shown = healed ?? run;
        return { id: shown.id, status: shown.status, created_at: shown.created_at, prompt: shown.prompt || '' };
      }),
    });
  });

  app.get('/api/agent-runs/:id/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const snapshot = runStatusSnapshot(run);
    await attachConversation(snapshot, req.params.id);
    res.json(snapshot);
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
      await attachConversation(snapshot, req.params.id);
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
    const payload = runDetailsPayload(run);
    await attachConversation(payload, req.params.id);
    res.json(payload);
  });

  app.get('/api/agent-runs/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = await loadAgentRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (req.query.include === 'details') {
      const payload = runDetailsPayload(run);
      await attachConversation(payload, req.params.id);
      return res.json(payload);
    }
    const snapshot = runStatusSnapshot(run);
    await attachConversation(snapshot, req.params.id);
    res.json(snapshot);
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
    const stream = String(req.headers.accept || '').includes('text/event-stream');
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      if (stream) {
        prepareSse(res);
        sendSse(res, { type: 'step', text: 'Generating the requested artifact...' });
        heartbeat = setInterval(() => sendSse(res, { type: 'heartbeat', at: Date.now() }), 10000);
      }
      const ai = await getOrchestrator(config.agent, { workspaceId: reqScope(req).userId || 'default' });
      const result = await ai.generateObject<any>({
        prompt: String(prompt || ''),
        schema: config.schema,
        userMessage: String(prompt || ''),
      });
      if ((result as any).shortCircuit) {
        if (stream) return sendSse(res, { type: 'error', error: (result as any).shortCircuit });
        return res.status(422).json({ error: (result as any).shortCircuit });
      }
      if (stream) sendSse(res, { type: 'final', result: result.object });
      else res.json(result.object);
    } catch (err: any) {
      console.error(err);
      if (stream) sendSse(res, { type: 'error', error: getAIErrorMessage(err) });
      else {
        const status = Number(err?.status);
        res.status(status >= 400 && status <= 599 ? status : 502).json({ error: getAIErrorMessage(err) });
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) res.end();
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

  // Tool-loop test-authoring agent: repo-grounded, real browser + real Playwright execution, no
  // deterministic compiler in between. Synchronous — runs to completion (write + validate) and
  // returns the result directly. See server/features/agent/toolloop/testAuthorAgent.ts.
  app.post('/api/agent/toolloop/start', async (req, res) => {
    const { app_url, prompt, maxSteps } = req.body || {};
    const scope = reqScope(req);
    if (!scope.projectId) return res.status(400).json({ error: 'A project must be selected (repo grounding needs its connected repository).' });
    const repoPath = getProjectRepoPath(scope.projectId).trim();
    if (!repoPath) return res.status(400).json({ error: 'The selected project has no connected repository to ground against.' });
    const targetUrl = String(app_url || '').trim();
    if (!targetUrl) return res.status(400).json({ error: 'app_url is required.' });
    if (!String(prompt || '').trim()) return res.status(400).json({ error: 'prompt is required.' });
    try {
      const credentials = resolveCredentials({ targetUrl, ownerId: scope.userId || undefined });
      const runId = `TOOLLOOP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runTestAuthorAgentAuto({
        targetUrl, repoPath, prompt: String(prompt).trim(), credentials, runId,
        workspaceId: scope.projectId, userId: scope.userId || undefined, maxSteps: Number(maxSteps) || undefined,
      });
      res.json({ runId, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Tool-loop agent run failed.' });
    }
  });

  app.post('/api/agent/start', async (req, res) => {
    const { app_url, prompt } = req.body;
    // Fail fast when the workspace isn't set up (no LLM / no target URL+credentials / no project):
    // refuse before creating a run so the user gets an immediate setup message instead of a run that
    // starts, spins, then flips to failed. `chat_response` renders as a normal assistant turn.
    const setup = agentSetupReadiness(reqScope(req));
    if (!setup.ready) {
      return res.json({ chat_response: setup.message });
    }
    const conversationId = String(req.body.conversationId || req.body.agentConsoleId || req.body.sessionId || '').trim();
    // Starting a run IS proceeding past the review gate — retire its understanding job so a later
    // reload cannot re-attach and append the "Look right? … Proceed" card behind the running card.
    consumeUnderstandingJobs(conversationId);
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
    // Learn the connected app's OWN auth storage keys (from its repo) and register them for the inspector's
    // token injection — replaces hardcoded product keys with the app's learned keys. Best-effort, non-fatal.
    try {
      const understanding = await resolveAppUnderstanding({
        connectedApp: {
          projectId: scope.projectId || undefined,
          appId: scope.appId || undefined,
          ownerId: scope.userId || undefined,
          repoPath: getProjectRepoPath(scope.projectId || '') || undefined,
          appUrl: String(app_url || selectedApp?.baseUrl || '') || undefined,
          appLabel: selectedApp?.name || undefined,
        },
        runId: conversationId || 'run',
      });
      if (understanding.auth.storageKeys.length) setAuthStorageKeys(String(app_url || selectedApp?.baseUrl || ''), understanding.auth.storageKeys);
    } catch (err) { console.warn('[understanding] auth-key registration skipped:', (err as Error)?.message); }
    const priorSessionRun = latestRunForConversation(conversationId, scope);
    // Attention layer: the CURRENT request's target is authoritative. If the user switched the target
    // app/URL mid-conversation, the prior run's understanding/grounding (and the conversation-memory scope
    // inherited above) describe the OLD surface — drop them so the new surface is grounded fresh. Prior turns
    // stay available downstream as conversation CONTEXT, never as authoritative scope. Same target → unchanged.
    const normTarget = (u: string) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.replace(/\/+$/, '').toLowerCase(); } catch { return String(u || '').toLowerCase(); } };
    const currentTargetUrl = String(app_url || selectedApp?.baseUrl || '').trim();
    const priorTargetUrl = String(priorSessionRun?.app_url || '').trim();
    const priorAppId = String(priorSessionRun?.appId || priorSessionRun?.mission_context?.application?.id || '').trim();
    const targetChanged = Boolean(priorSessionRun) && (
      (Boolean(currentTargetUrl) && Boolean(priorTargetUrl) && normTarget(currentTargetUrl) !== normTarget(priorTargetUrl))
      || (Boolean(scope.appId) && Boolean(priorAppId) && String(scope.appId) !== priorAppId)
    );
    if (targetChanged) {
      approvedUnderstanding = '';
      priorGrounding = '';
    } else if (priorSessionRun) {
      approvedUnderstanding ||= String(priorSessionRun.approvedUnderstanding || '').trim();
      priorGrounding ||= String(priorSessionRun.priorGrounding || priorSessionRun.approvedUnderstanding || '').trim();
    }
    approvedUnderstanding = stripScriptBlocksFromScope(approvedUnderstanding);
    priorGrounding = stripScriptBlocksFromScope(priorGrounding);
    const scopeContextText = [selectedProject?.name, selectedApp?.name].filter(Boolean).join(' ');
    const explicitModuleIdRaw = String(req.body.moduleId || req.body.module || '').trim();
    // Admin-only question: its examples (Apps/Objects/Roles/Users) are Admin modules. A RUNTIME surface
    // (keystone/shockwave) falls through to the app-resolution flow below, which asks with the REAL
    // app list + tabs instead of admin module names.
    const provisionalPlatform = platformTypeFromSurface(selectedApp?.name || '', app_url || selectedApp?.baseUrl || '');
    // Auto-resolve the admin section from the requirement's metadata objects (e.g. "app" → Apps), so a
    // requirement that already names one concrete section skips the "which navigation?" ask. Fills in
    // ONLY on an unambiguous single match; a cross-cutting requirement (e.g. list_view) still asks.
    const metadataRefs: string[] = Array.isArray(req.body.metadataRefs)
      ? req.body.metadataRefs.map((r: any) => String(r || '').trim()).filter(Boolean)
      : [];
    const adminNavModules = provisionalPlatform === 'ADMIN'
      ? loadAdminNavModules(getProjectRepoPath(scope.projectId || ''))
      : [];
    // Auto-resolve a section ONLY from the requirement's real metadata refs matched against the repo-parsed
    // nav modules — no hardcoded object noun. Ambiguous prompts still fall through to the module question.
    const autoModuleId = (!explicitModuleIdRaw && provisionalPlatform === 'ADMIN')
      ? resolveAdminModuleFromRefs(metadataRefs, adminNavModules)
      : '';
    const explicitModuleId = explicitModuleIdRaw || autoModuleId;
    if (provisionalPlatform === 'ADMIN' && needsExplicitListViewModule(prompt || '', explicitModuleId)) {
      // Structured options drive the console's dropdown card (ids = admin URL nav keys);
      // chat_response stays as the plain-text fallback and still accepts a typed module reply.
      // Repo-parsed side-nav modules drive the dropdown; when the repo has none the plain
      // question remains (older behavior) and the user can type the module name.
      // Examples derived from the live repo-parsed side-nav — never a hardcoded app's module names.
      const moduleExamples = adminNavModules.slice(0, 4).map((m) => m.name).filter(Boolean).join(', ');
      return res.json({
        chat_response: `Which list view should I test? Name the module or record type${moduleExamples ? `, for example ${moduleExamples}` : ''}.`,
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
    // Accept whatever platform the connected app declares; only infer when none was given.
    const platformType: string = explicitPlatform
      || platformTypeFromSurface(selectedApp?.name || '', surfaceBaseUrl);
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
            application = { id: ALL_APPS_ID, name: 'All Apps' };
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
              chat_response: `Which app should I test in ${selectedApp?.name || 'this runtime'}?\n\n${lines.join('\n')}${more}\n\nReply with the app name and optionally a tab, or say "all apps" to sweep every app.`,
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
        module: selectedModule || null,
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
    const availableFolders = scopeFilter(await Folders.list(), scope);
    const explicitFolderId = !!(req.body.folderId && availableFolders.some((f: any) => f.id === req.body.folderId));
    const explicitFolderMention = !!String(req.body.folderMention || '').trim();
    // Tag-native (default): runs no longer require a folder — artifacts are organized by tags. The
    // folder gate only applies under the legacy flag. When on, a folder stays optional (used only if
    // the caller supplied one).
    if (!tagNativeOrgEnabled() && !explicitFolderId && !explicitFolderMention) {
      const existing = [...new Set(availableFolders.map((f: any) => getFolderPath(f.id, availableFolders)).filter(Boolean))].slice(0, 25);
      const listing = existing.length ? `\n\nExisting folders: ${existing.join(' - ')}` : '';
      return res.json({
        chat_response: `Before I start, which folder should I save this under? Pick an existing folder or name a new one  -  I won't begin a run without a folder, so every test plan, suite, case, run, requirement, report and defect stays together and easy to find.${listing}\n\nTip: name the folder in the prompt, e.g. "…, save under Regression".`,
      });
    }

    const folder = resolveFolderForAgent({
      folderId: req.body.folderId,
      folderMention: req.body.folderMention,
      prompt: prompt || '',
      targetUrl,
    }, availableFolders);
    if (folder) {
      Object.assign(folder, scopeStamp(scope));
      folder.path = getFolderPath(folder.id, availableFolders);
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
    const artifactIdContext = {
      ownerId: scope.userId || '',
      websiteId: req.body.websiteId || '',
      websiteName: exactAppName,
      targetUrl,
      sourceText: prompt || '',
    };
    const generatedSuiteId = req.body.testSuiteId ? '' : await nextArtifactId('SUITE', artifactIdContext);

    // In-flight guard: a hard refresh / double-submit can re-drive this endpoint for a conversation whose run is
    // still going, minting a duplicate run each time. If the conversation's latest run is non-terminal AND this
    // is the SAME request (same target + prompt), attach to it instead of starting another.
    const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled']);
    if (priorSessionRun
      && !TERMINAL_RUN_STATUS.has(String(priorSessionRun.status || ''))
      && normTarget(String(priorSessionRun.app_url || '')) === normTarget(targetUrl)
      && String(priorSessionRun.prompt || '').trim() === String(prompt || '').trim()) {
      console.log(`[agent/start] duplicate suppressed — conversation ${conversationId} already has in-flight run ${priorSessionRun.id} (status ${priorSessionRun.status}); attaching instead of starting a new one.`);
      return res.json({ task_id: priorSessionRun.id });
    }

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
      generatedSuiteId,
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

    // The LangGraph workflow runtime is the only engine now (isWorkflowGraphEnabled() is permanently
    // true — no flag). Same run record/SSE/status contracts; the runtime projects graph state back
    // onto this run. The legacy procedural pipeline below is unreachable; retained pending its own
    // dedicated removal pass rather than deleted in this cleanup.
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
  });

  app.post('/api/agent/continue', async (req, res) => {
    const { taskId, cases, executionCases, selectedCaseIndexes, scripts, appendScripts } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);

    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Graph-engine runs resume through the workflow runtime (durable interrupt), never the legacy flow.
    // The pending correlationId is read server-side from the checkpointed state — no UI change needed.
    if ((run as any).engine === 'langgraph') {
      try {
        const pending = await getPendingReview(taskId);
        const correlationId = pending?.correlationId;
        if (!correlationId) {
          const selectedExecutionCases = Array.isArray(executionCases) ? executionCases : [];
          const canStartAdditionalBatch = appendScripts
            && ['completed', 'failed'].includes(String(run.status || ''))
            && selectedExecutionCases.length > 0;
          if (!canStartAdditionalBatch) return res.status(409).json({ error: 'This run has no pending review to continue.' });

          const nextTaskId = randomUUID();
          const now = nowIso();
          const nextRun = {
            ...run,
            id: nextTaskId,
            previousAgentRunId: run.id,
            status: 'running',
            messages: [],
            phases: {},
            generated_cases: selectedExecutionCases,
            all_generated_cases: Array.isArray(cases) && cases.length ? cases : selectedExecutionCases,
            playwright_scripts: Array.isArray(run.playwright_scripts) ? run.playwright_scripts : [],
            preserve_playwright_scripts: true,
            compiler_diagnostics: [],
            execution_result: null,
            execution_case_count: Math.min(
              Array.isArray(cases) ? cases.length : selectedExecutionCases.length,
              Number((run as any).execution_case_count || 0) + selectedExecutionCases.length,
            ),
            review_stage: '',
            review_started_at: null,
            pending_review: null,
            cancelRequested: false,
            completed_at: null,
            created_at: now,
            updated_at: now,
            graph_start: {
              ...((run as any).graph_start || {}),
              requestedCaseCount: selectedExecutionCases.length,
              reviewPolicy: 'auto',
            },
          };
          db.agentRuns.unshift(nextRun);
          await saveAgentRunState(nextRun, 'started additional selected graph batch');
          res.json({ success: true, taskId: nextTaskId });
          await beginGraphRunFor(nextRun, { seedCases: selectedExecutionCases });
          return;
        }
        if (pending?.kind === 'cases' && (!Array.isArray(cases) || cases.length === 0)) {
          return res.status(400).json({ error: 'Reviewed cases are required to continue.' });
        }
        const reviewedCaseCount = Array.isArray(cases) ? cases.length : 0;
        const selectedIndexes = Array.isArray(selectedCaseIndexes)
          ? [...new Set(selectedCaseIndexes.map(Number).filter((index: number) => Number.isInteger(index) && index >= 0 && index < reviewedCaseCount))]
          : [];
        if (pending?.kind === 'cases') {
          (run as any).all_generated_cases = cases;
          (run as any).execution_case_count = selectedIndexes.length || cases.length;
        }
        run.status = 'running';
        persistDataInBackground('continued graph run');
        res.json({ success: true });
        await resumeGraphRun(taskId, {
          correlationId,
          decision: 'approved',
          actor: reqScope(req).userId || 'user',
          selectedCaseIndexes: selectedIndexes,
          reviewedCases: pending?.kind === 'cases' ? cases : undefined,
        });
      } catch (err: any) {
        console.error('Graph continue error:', err);
        if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      }
      return;
    }
    // Every run created going forward is a langgraph run (graph_start is set unconditionally at
    // creation); this only fires for a run row that predates the current engine.
    return res.status(410).json({ error: 'This run predates the current workflow engine and cannot be continued — please restart it.' });
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

  // Restart body the client forwards to /api/agent/start. Reuses the run's resolved MissionContext so
  // the fresh start doesn't re-ask for the target (which returns no task_id → Retry silently no-ops).
  function fullRestartParams(run: any) {
    const mc = (run?.mission_context || {}) as any;
    const folder = run?.folderPath || run?.folder_path || '';
    return {
      app_url: mc.targetUrl || run?.app_url || '',
      websiteId: run?.websiteId || run?.website_id || undefined,
      projectId: run?.projectId || run?.project_id || undefined,
      appId: run?.appId || run?.app_id || undefined,
      prompt: run?.prompt || '',
      testCaseCount: Number(run?.requested_case_count || run?.requestedCaseCount || 0) || 0,
      flowMode: 'review_cases',
      folderMention: folder && folder !== 'Uncategorized' ? folder : undefined,
      applicationId: mc.application?.id || undefined,
      applicationName: mc.application?.name || undefined,
      moduleId: mc.module?.id || mc.tab?.id || undefined,
      moduleName: mc.module?.name || mc.tab?.name || undefined,
      approvedUnderstanding: run?.approvedUnderstanding || run?.approved_understanding || '',
      understandingSource: run?.understandingSource || '',
      priorGrounding: run?.priorGrounding || run?.approvedUnderstanding || '',
      provider: run?.requestedProvider || run?.provider || undefined,
      model: run?.requestedModel || run?.model || undefined,
      effort: run?.requestedEffort || undefined,
      conversationId: run?.conversationId || run?.conversation_id || '',
      metadataRefs: Array.isArray(run?.metadata_refs) ? run.metadata_refs : undefined,
    };
  }

  app.post('/api/agent/retry', async (req, res) => {
    const { taskId } = req.body;
    const run = db.agentRuns.find((item: any) => item.id === taskId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Graph-engine runs never resume through the legacy pipeline (their seed can carry a STALE
    // inspection_context from a prior session run, which fooled this path into a blind-inspection
    // block). needsFullRestart → the UI starts a fresh run, which routes per the current engine flag.
    if ((run as any).engine === 'langgraph') return res.json({ success: false, needsFullRestart: true, restart: fullRestartParams(run) });
    // Every run created going forward is a langgraph run; this only fires for a run row that
    // predates the current engine — same restart contract as the graph branch above.
    return res.json({ success: false, needsFullRestart: true, restart: fullRestartParams(run) });
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

  app.post('/api/agent/rework-case', async (req, res) => {
    try {
      const { testCase, feedback, targetUrl, attachments } = req.body;
      const scope = reqScope(req);
      const parsedAttachments = parseAIImageAttachments(attachments);
      if (parsedAttachments.error) return res.status(400).json({ error: parsedAttachments.error });
      const images = parsedAttachments.images;
      const reworkRunScope = { appName: (scope.appId ? getApp(scope.appId)?.name : '') || '', app_url: targetUrl || '' };
      const repoContext = buildReworkRepoContext({ scope, testCase, feedback: String(feedback || '') });
      const ai = await getOrchestrator('caseReworker', { workspaceId: reqScope(req).userId || 'default' });
      const originalSteps = normalizeCaseSteps(testCase?.steps || []);
      const mustAddStep = requestsAdditionalCaseStep(feedback);
      const caseSchema = z.object({
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
      });
      const addStepRequirement = mustAddStep
        ? `\nMANDATORY ADD-STEP REQUIREMENT: The current case has ${originalSteps.length} steps. Return at least ${originalSteps.length + 1} steps. Preserve the existing steps and add the requested new step; rewriting an existing step does not satisfy the request.`
        : '';
      const reworked = await generateValidCaseRework<any>(feedback, originalSteps, async (isRetry) => {
        const result = await ai.generateObject<any>({
          prompt: `Target URL: ${targetUrl || 'not provided'}. Current case: ${JSON.stringify(testCase)}. Feedback: ${feedback || 'Improve clarity and coverage.'}
${repoContext}
${images ? `The user attached ${images.length} image(s) as additional context for this rework — use what they show when improving the case.\n` : ''}Return a complete test case object. Preserve any useful existing fields. If no explicit preconditions are needed, return preconditions as an empty string. Do not omit required keys.${addStepRequirement}${isRetry ? '\nCORRECTION: The previous response did not add a step. Follow the mandatory add-step requirement exactly.' : ''}`,
          schema: caseSchema,
          userMessage: feedback || 'Rework the case for clarity and coverage.',
          images,
        });
        const object = result.object || {};
        return { ...object, steps: normalizeCaseSteps(object.steps || []) };
      });
      if (!reworked) {
        return res.status(422).json({ error: `The AI did not add a new step after two attempts. The original ${originalSteps.length} steps were left unchanged; please refine the request and try again.` });
      }
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
      const { instruction, cases, selectedIndexes, targetUrl, attachments } = req.body || {};
      const intent = String(instruction || '').trim();
      if (!intent) return res.status(400).json({ error: 'instruction required' });
      const list = Array.isArray(cases) ? cases : [];
      if (!list.length) return res.status(400).json({ error: 'cases required' });
      const scope = reqScope(req);
      const parsedAttachments = parseAIImageAttachments(attachments);
      if (parsedAttachments.error) return res.status(400).json({ error: parsedAttachments.error });
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
${parsedAttachments.images ? `The user attached ${parsedAttachments.images.length} image(s). Use what they show as authoritative visual context for this rework.` : ''}

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
        images: parsedAttachments.images,
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
    const linkedPlanId = linkedRun ? agentPlanId(linkedRun) : '';
    const linkedSuiteId = linkedRun ? agentSuiteId(linkedRun) : '';
    if (Array.isArray(cases)) {
      for (const testCase of cases) {
        if (testCase.id) continue;
        testCase.id = await nextArtifactId('TC', {
          ownerId: caseOwnerId,
          websiteId: linkedRun?.websiteId,
          websiteName: linkedRun?.appName,
          targetUrl: linkedRun?.app_url,
          sourceText: linkedRun?.prompt || testCase.title,
        });
      }
      if (linkedRun) {
        syncReviewedCases(linkedRun, cases);
        await saveAgentRunState(linkedRun, 'saved reviewed cases');
      }
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
        const savedCase = await Cases.upsert({
          id: c.id,
          title: c.title,
          description: buildCaseDescription(c),
          preconditions: c.preconditions || '',
          steps: normalizeCaseSteps(c.steps),
          testPlanId: c.testPlanId || linkedPlanId || null,
          testSuiteId: c.testSuiteId || linkedSuiteId || null,
          status: c.status || 'Draft',
          tags: normalizeCaseTags(c.tags || []),
          // Agent output is automation; an explicit type from the generator wins.
          type: c.type || 'Automated',
          priority: c.priority || 'Medium',
          automationStatus: c.automationStatus || 'Not Automated',
          testingScope: c.testingScope || ((c.type || 'Automated') === 'Automated' ? 'Automation' : 'Manual'),
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
        c.id = savedCase.id;
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
