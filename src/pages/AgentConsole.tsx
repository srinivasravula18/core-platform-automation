import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { TopbarActions } from '@/src/components/TopbarActions';
import { MarkdownText } from '@/src/components/MarkdownText';
import {
  BrainCircuit,
  Mic,
  Send,
  StopCircle,
  Loader2,
  Inbox,
  Sparkles,
  ArrowRight,
  FlaskConical,
  PlayCircle,
  Bug,
  ClipboardList,
  FolderTree,
  SquarePen,
  Code2,
  Layers,
  Image as ImageIcon,
  Wand2,
  History,
  MessageSquare,
  MessagesSquare,
  Star,
  Target,
  Trash2,
  AppWindow,
  LayoutGrid,
  Check,
  ChevronDown,
  Copy,
  User,
  Info,
  RotateCcw,
  Pencil,
  X,
} from 'lucide-react';

/**
 * Does an assistant text response look like an AI-agent ERROR (as opposed to a normal answer that
 * merely mentions "error"/status codes)? Deliberately STRICT and START-ANCHORED so a test-generation
 * answer that discusses error handling / 4xx codes never triggers a false Retry. The authoritative
 * signal is the explicit `isError` flag on the turn; this is only a fallback for provider/system
 * errors surfaced as plain text (e.g. "[openai] badrequest: 400 ...").
 */
function looksLikeAgentError(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  return (
    /^\[[a-z0-9_-]+\]\s/i.test(s) ||                 // runtime-prefixed: "[codex] auth: ..."
    /^(?:error|failed)\b[:\s]/i.test(s) ||           // "Error: ...", "Failed: ..."
    /^something went wrong\b/i.test(s) ||
    /^request failed\b/i.test(s) ||
    /^(?:the\s+)?(?:run|request|generation|agent)\s+failed\b/i.test(s)
  );
}
import { cn } from '@/src/lib/utils';
import { withEventSourceAuth } from '@/src/lib/base-path';
import { MessageMeta, type ExecutionMeta } from '@/src/components/MessageMeta';
import { getUsername } from '@/src/components/AuthGate';
import { readScopedStorage, writeScopedStorage, RUNTIME_MODEL_KEY, RUNTIME_MODEL_EVENT } from '@/src/lib/storage';
import { containsPrivateFileActivity, hasPrivateResearchToolCall } from '@/src/lib/userFacingAgentActivity';
import { useProjects, type ProjectApp } from '@/src/store/project';
import { useUiSettings } from '@/src/store/uiSettings';
import { useSpeechToText } from '@/src/lib/useSpeechToText';
import { useFlushOnUnload } from '@/src/lib/useFlushOnUnload';
import { markAgentActive, clearAgentActive } from '@/src/lib/agentActivity';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { showToast } from '@/src/lib/dialog';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';
import { DeepRunResult } from '@/src/components/DeepRunResult';
import { CodeChangeReview } from '@/src/components/CodeChangeReview';
import { RequirementDiscoveryResult } from '@/src/components/RequirementDiscoveryResult';
import { RequirementDraftReview } from '@/src/components/RequirementDraftReview';
import type { AIImageAttachment } from '@/src/components/AIImageAttachmentPicker';
import { GeneratedCases } from '@/src/components/GeneratedCases';
import { AgentActivity, restoreActiveActivity } from '@/src/components/AgentActivity';
import { selectTargetActionResult, TargetActionResult, type TargetActionSummary } from '@/src/components/TargetActionResult';

// NOTE: The brittle regex DECISION layer that used to live here (GIT_RE, REQ_RE, DEEP_RE,
// GEN_VERB_RE, siteActionable, isQuestionForSupervisor, isCoreListViewText, isProceedLike,
// extractTargetUrl, findCoreAdminWebsite, …) has been retired. The routing decision is now
// made by the backend controller stream, which selects a deterministic reply, one authenticated
// SDK turn, or the grounded Supervisor. Only the small helpers used by preserved EXECUTION
// and rendering flows (describeAgentStep, isNoiseAnswer/lastAssistantAnswer for grounding,
// escapeRegExp/findWebsiteInText for resolving a named app to a websiteId) remain.

// Turn a streamed Supervisor step into a human-readable "what it's doing right now" label.
function describeAgentStep(ev: { toolCalls?: Array<{ name: string; arguments?: any }> }): string {
  if (hasPrivateResearchToolCall(ev)) return 'Researching application...';
  const calls = ev.toolCalls || [];
  if (!calls.length) return 'Thinking…';
  const tc = calls[0];
  const a = tc.arguments || {};
  switch (tc.name) {
    case 'query_workspace': return `Looking up ${a.kind || 'the workspace'}…`;
    case 'search_codebase': return `Searching the codebase for ${(Array.isArray(a.terms) ? a.terms.join(', ') : a.terms) || 'the feature'}…`;
    case 'read_code_file': return `Reading ${a.path || 'the source code'}…`;
    case 'create_cases': return 'Generating test cases…';
    case 'create_plan': return 'Creating a test plan…';
    case 'create_suite': return 'Creating a test suite…';
    case 'create_run': return 'Starting a test run…';
    case 'generate_script': return 'Writing a Playwright script…';
    case 'generate_report': return 'Generating a report…';
    case 'create_defect': return 'Filing a defect…';
    case 'create_folder': return 'Creating a folder…';
    case 'move_to_folder': return 'Organizing artifacts…';
    default: return `Running ${tc.name}…`;
  }
}

// The agent's most recent substantive answer — used as the deep run's understanding when
// the user says "proceed/yep", so generated cases reflect the ACTUAL conversation
// (e.g. the Admin objects/users/permissions the agent just described) instead of a
// hardcoded template.
// Turns that carry no scope signal — greetings, capability blurbs, provider-error dumps,
// and failed "I don't know" answers. Never ground a run in these.
function isNoiseAnswer(content: string): boolean {
  const c = (content || '').trim();
  if (c.length < 12) return true;
  if (/^\[(codex|openai)\]/i.test(c)) return true;
  if (/invalid_type|invalid_value|"code"\s*:\s*"invalid_/i.test(c)) return true;
  if (/^(hi|hello|hey)[.!,\s]/i.test(c)) return true;
  if (/^(i['’]?m ready to help|i can draft a test plan|hi\.? i can)/i.test(c)) return true;
  if (/no matching source files|i don['’]?t know|i can['’]?t list|could not read/i.test(c)) return true;
  return false;
}
// The richest grounded assistant answer (e.g. a feature inventory), not just the trailing
// message — a short "ok, doing it" must not win over the real answer the cases must cover.
function lastAssistantAnswer(history: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  const recent = history.filter((h) => h.role === 'assistant' && !isNoiseAnswer(h.content || '')).slice(-6);
  if (!recent.length) {
    // Fall back to the most recent non-empty assistant turn if everything looked like noise.
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'assistant' && (history[i].content || '').trim()) return history[i].content;
    }
    return '';
  }
  return recent.reduce((best, h) => (h.content.length > best.length ? h.content : best), '');
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeAppMention(value: string): string {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// URL path segments are meaningful per-app identifiers here (e.g. a Keystone service lives at
// `…/shockwave/`), so the user naming "shockwave" should resolve that app even though it isn't the
// app's display name. Generic infra segments are skipped so they never become an alias.
const URL_ALIAS_STOP = new Set(['app', 'apps', 'api', 'index', 'home', 'public', 'static', 'assets', 'dashboard', 'en', 'us']);
function urlPathAliases(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .map((s) => normalizeAppMention(s))
      .filter((s) => s.length >= 3 && !URL_ALIAS_STOP.has(s));
  } catch {
    return [];
  }
}
function appMentionAliases(app: { name?: string; baseUrl?: string }): string[] {
  const name = normalizeAppMention(app.name || '');
  const url = String(app.baseUrl || '').toLowerCase();
  const aliases = new Set<string>();
  if (name) aliases.add(name);
  if (/\badmin\b/.test(name) && (/\blocal\b/.test(name) || /\blocalhost\b|127\.0\.0\.1/.test(url))) aliases.add('local admin');
  if (/\bkeystone\b/.test(name) && (/\blocal\b/.test(name) || /\blocalhost\b|127\.0\.0\.1/.test(url))) aliases.add('local keystone');
  for (const seg of urlPathAliases(app.baseUrl || '')) aliases.add(seg);
  return [...aliases].sort((a, b) => b.length - a.length);
}
function hasAppMention(text: string, alias: string): boolean {
  return !!alias && new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(text);
}
// Find a stored website whose name is mentioned in the message (longest match wins).
function findWebsiteInText(text: string, websites: Array<{ id: string; name: string; baseUrl: string }>): { id: string; name: string; baseUrl: string } | null {
  const q = normalizeAppMention(text);
  const matches = (websites || [])
    .map((w) => ({ w, score: appMentionAliases(w).find((a) => hasAppMention(q, a))?.length || 0 }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  return matches[0]?.w || null;
}

// A literal URL the user typed in THIS message is an explicit target — honor it (the "paste the
// target URL here" promise) even if the router didn't extract it into goal.target.url.
function firstUrlInText(text: string): string {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/i);
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}

function findTargetInText(text: string, targets: Array<{ id?: string; name: string; baseUrl?: string }>): { id?: string; name: string; baseUrl: string } | null {
  const q = normalizeAppMention(text);
  const matches = (targets || [])
    .filter((t) => t.baseUrl)
    .map((t) => ({ t: { id: t.id, name: t.name, baseUrl: t.baseUrl! }, score: appMentionAliases(t).find((a) => hasAppMention(q, a))?.length || 0 }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  return matches[0]?.t || null;
}

// An explicit number in the prompt ("write 12 cases") is honored as-is (capped at
// 40). With no number — including "as many as possible / comprehensive" — return 0,
// the "auto" signal that tells the backend to scale the count to the feature's real
// complexity (derived from the deep source-code understanding) instead of a fixed 3.
function parseCaseCount(text: string): number {
  const m = text.match(/(\d{1,3})\s*(?:test\s*)?(?:cases?|scenarios?|scripts?)/i);
  if (!m) return 0;
  return Math.min(40, Math.max(1, parseInt(m[1], 10) || 0));
}

function requestedCaseCount(text: string): number {
  const explicit = parseCaseCount(text);
  if (explicit) return explicit;
  const trailing = String(text || '').match(/\b(\d{1,2})\s*$/);
  return trailing ? Math.min(40, Math.max(1, Number(trailing[1]) || 0)) : 0;
}

function requestedFeatureScope(text: string): string {
  const value = String(text || '').toLowerCase();
  const onlyMatch = value.match(/\b(?:for|on|about)\s+(.+?)\s+only\b/) || value.match(/\b(.+?)\s+only\b/);
  const raw = (onlyMatch?.[1] || '').replace(/\b(?:can|you|generate|create|write|test|cases?|for|the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return raw || 'requested feature';
}

// A short affirmative reply to the review card ("proceed", "yes", "go ahead") starts the run;
// any other reply is treated as a new message and routed fresh.
function isProceedResponse(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('?')) return false;
  // Whole-message anchor: "run" confirms the pending card, "run the export tests" is a NEW request.
  // A first-word match hijacked any follow-up that merely opened with an affirmative verb.
  return /^(proceed|go ahead|go|yes|yep|yeah|ok|okay|sure|do it|start|run|looks good|lgtm|confirm|approved?)[\s.!]*$/i.test(t);
}

// Whole-message anchors, as in isProceedResponse: "create" approves the pending draft, "create test cases
// for the export screen" is a NEW request. The approve branch never reads the message, so a first-word
// match silently discarded the user's actual task.
function isRequirementDraftApprove(text: string): boolean {
  return /^(?:yes|ok|okay|approve|approved|save|create|confirm|looks good|proceed|go ahead)[\s.!]*$/i.test(text.trim());
}

function isRequirementDraftCancel(text: string): boolean {
  return /^(?:cancel|discard|stop|never mind|nevermind)[\s.!]*$/i.test(text.trim());
}

function authoredScriptFromTurn(turn: { text?: string; authoredScript?: string }): string {
  if (turn.authoredScript) return turn.authoredScript;
  const m = String(turn.text || '').match(/```(?:ts|typescript)?\s*([\s\S]*?)```/i);
  const code = m?.[1]?.trim() || '';
  return /\btest\s*\(/.test(code) && /\bpage\./.test(code) ? code : '';
}

function initialThinkingLabel(_text: string, opts: { selectedApps: number; requirementDraftPending: boolean }): string {
  if (opts.requirementDraftPending) return 'Updating requirement draft...';
  if (opts.selectedApps > 0) return `Inspecting ${opts.selectedApps} selected app${opts.selectedApps === 1 ? '' : 's'}...`;
  return 'Analyzing request...';
}

/**
 * Agent Console — the single, conversational home of Test Flow AI.
 *
 * The human describes what they want in plain language (or voice). The AI
 * controller classifies the request into a reviewable plan, the human approves,
 * and the agent executes every step for real. Decisions that need a human land
 * in the AI Inbox (top bar). The classic sidebar pages remain available for
 * anyone who wants to drill into the raw data.
 */

type Turn =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string; authoredScript?: string; authoredTargetUrl?: string; screenshotUrls?: string[]; isError?: boolean; stopped?: boolean; createdAt?: string; execution?: ExecutionMeta; activityRequestId?: string; targetResult?: TargetActionSummary }
  | { id: string; role: 'assistant'; kind: 'plan'; plan: any }
  | { id: string; role: 'assistant'; kind: 'deeprun'; taskId: string; saved?: boolean; createdAt?: string; execution?: ExecutionMeta; activityRequestId?: string }
  | { id: string; role: 'assistant'; kind: 'codereview'; analysis: any }
  | { id: string; role: 'assistant'; kind: 'reqdiscovery'; result: any }
  | { id: string; role: 'assistant'; kind: 'reqdraft'; result: any; query: string; revisionCount?: number }
  | { id: string; role: 'assistant'; kind: 'cases'; cases: any[] }
  | { id: string; role: 'assistant'; kind: 'clarify'; plan: any; summary: string; confidence: number }
  | { id: string; role: 'assistant'; kind: 'folderask'; text: string; understanding?: string; understandingSource?: string; originalPrompt?: string; contextPrompt?: string; caseCountPrompt?: string; targetUrl?: string; websiteId?: string; websiteName?: string; revisionCount?: number; metadataRefs?: string[]; applicationId?: string; applicationName?: string; moduleId?: string; moduleName?: string; activityRequestId?: string }
  | { id: string; role: 'assistant'; kind: 'appask'; text: string; surface: string; platform: 'ADMIN' | 'RUNTIME'; allowAllApps: boolean; apps: Array<{ id: string; name: string; tabs: string[]; group?: string; baseUrl?: string }>; runArgs: Record<string, any> }
  | { id: string; role: 'assistant'; kind: 'thinking'; label: string; debug?: string[]; partialText?: string; activityRequestId?: string };

// Narrowed turn shape for the folder-ask review card component below.
type FolderAskTurn = Extract<Turn, { kind: 'folderask' }>;
// Narrowed turn shape for the app/navigation-picker card component below.
type AppAskTurn = Extract<Turn, { kind: 'appask' }>;

type PendingDeep = {
  prompt: string;
  originalRequest?: string;
  contextPrompt?: string;
  caseCountPrompt?: string;
  targetUrl: string;
  websiteId?: string;
  websiteName?: string;
  understanding: string;
  understandingSource?: string;
  revisionCount: number;
};

type PendingRequirementDraft = {
  turnId: string;
  query: string;
  result: any;
  revisionCount: number;
};

interface Suggestion {
  label: string;
  prompt: string;
  icon: typeof FlaskConical;
}

const SUGGESTIONS: Suggestion[] = [
  {
    label: 'Generate Cases + Scripts',
    prompt: 'Generate 5 test cases for the login flow of https://example.com, then write the Playwright scripts and capture evidence',
    icon: FlaskConical,
  },
  {
    label: 'Draft a Test Plan',
    prompt: 'Create a regression test plan for the checkout flow',
    icon: ClipboardList,
  },
  {
    label: 'Group into a Suite',
    prompt: 'Create a smoke test suite and group the login and checkout cases into it',
    icon: Layers,
  },
  {
    label: 'Schedule a Run',
    prompt: 'Set up a smoke test run for the latest build',
    icon: PlayCircle,
  },
  {
    label: 'File a Defect',
    prompt: 'File a high severity defect: the payment button is unresponsive on mobile',
    icon: Bug,
  },
  {
    label: 'Write a Report',
    prompt: 'Generate a stakeholder test report for the latest release',
    icon: ClipboardList,
  },
];

// Capability strip shown on the empty state so the client sees the full scope.
const CAPABILITIES: { label: string; icon: typeof FlaskConical }[] = [
  { label: 'Test Cases', icon: FlaskConical },
  { label: 'Playwright Scripts', icon: Code2 },
  { label: 'Evidence', icon: ImageIcon },
  { label: 'Test Plans', icon: ClipboardList },
  { label: 'Suites', icon: Layers },
  { label: 'Runs', icon: PlayCircle },
  { label: 'Defects', icon: Bug },
  { label: 'Reports', icon: ClipboardList },
  { label: 'Rework / Expand', icon: Wand2 },
];

// Where each completed step type lives, so we can offer a "drill in" link.
const KIND_TO_PAGE: Record<string, { label: string; href: string; icon: typeof FlaskConical }> = {
  create_plan: { label: 'Open Test Plans', href: '/plans', icon: ClipboardList },
  create_suite: { label: 'Open Test Suites', href: '/suites', icon: FolderTree },
  create_cases: { label: 'Open Test Cases', href: '/cases', icon: FlaskConical },
  expand_case_steps: { label: 'Open Test Cases', href: '/cases', icon: FlaskConical },
  rework_case: { label: 'Open Test Cases', href: '/cases', icon: FlaskConical },
  create_run: { label: 'Open Test Runs', href: '/runs', icon: PlayCircle },
  create_defect: { label: 'Open Defects', href: '/defects', icon: Bug },
  generate_report: { label: 'Open Reports', href: '/reports', icon: ClipboardList },
  generate_script: { label: 'Open Git Agent', href: '/git-agent', icon: FolderTree },
  create_folder: { label: 'Open Repository', href: '/repository', icon: FolderTree },
  organize_repository: { label: 'Open Repository', href: '/repository', icon: FolderTree },
  move_to_folder: { label: 'Open Repository', href: '/repository', icon: FolderTree },
};

let turnCounter = 0;
function nextId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

const CONV_KEY_BASE = 'tfa_active_conversation';
// The runtime's model/effort are workspace-wide settings; these remember the user's own pick for them.
const MODEL_PREF_KEY = RUNTIME_MODEL_KEY;
const EFFORT_PREF_KEY = 'tfa_runtime_effort';
const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * The topbar pick is the runtime setting, not a private local preference — persist it so Settings
 * shows the same value. Best-effort: on failure the pick still governs this session locally.
 */
function persistRuntimeChoice(runtimeName: string | undefined, body: { model?: string; effort?: string }) {
  if (!runtimeName) return;
  void fetch(`/api/ai/providers/${encodeURIComponent(runtimeName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* keep the local pick */ });
}
function runtimeModelIds(runtime: any): string[] {
  const live = Array.isArray(runtime?.models) ? runtime.models.map((model: any) => String(model?.id || '')).filter(Boolean) : [];
  return live.length ? live : [runtime?.defaultModel, ...(Array.isArray(runtime?.alternatives) ? runtime.alternatives : [])].filter(Boolean).map(String);
}
function runtimeEfforts(runtime: any, modelId: string): string[] {
  const model = Array.isArray(runtime?.models) ? runtime.models.find((item: any) => item?.id === modelId) : null;
  const live = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(String).filter(Boolean) : [];
  const provider = Array.isArray(runtime?.efforts) ? runtime.efforts.map(String).filter(Boolean) : [];
  return live.length ? live : (provider.length ? provider : DEFAULT_EFFORT_LEVELS);
}
// Each unique project + app is its own chat workspace. We namespace the chat
// workspace id and the "active conversation" pointer by the selected scope, so
// switching project/app swaps the console to that context's own history.
// appId is null for the project-level "All apps" view, which gets its own bucket.
function scopeWorkspaceId(projectId: string | null, appId: string | null): string {
  return `${projectId || 'none'}::${appId || 'all'}`;
}
function activeConvKey(workspaceId: string): string {
  return `${CONV_KEY_BASE}::${workspaceId}`;
}
function makeConversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: manually generate a UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface ConversationMeta {
  id: string;
  title: string;
  turnCount: number;
  updatedAt: string;
}

// Strip markdown / emoji from streamed chat text so it renders as clean plain text.
function cleanChat(s: string): string {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/[*_`~#>]+/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

// Build a plain-language summary of what the agent actually created.
function summarizeResults(plan: any): string {
  const counts: Record<string, number> = {};
  for (const step of plan?.steps || []) {
    if (step.status !== 'completed') continue;
    const r = step.result || {};
    if (Array.isArray(r.caseIds)) counts.cases = (counts.cases || 0) + r.caseIds.length;
    if (r.planId) counts.plans = (counts.plans || 0) + 1;
    if (r.suiteId) counts.suites = (counts.suites || 0) + 1;
    if (r.runId) counts.runs = (counts.runs || 0) + 1;
    if (r.defectId) counts.defects = (counts.defects || 0) + 1;
    if (r.folderId && !r.planId) counts.folders = (counts.folders || 0) + 1;
  }
  const label: Record<string, [string, string]> = {
    plans: ['test plan', 'test plans'],
    suites: ['test suite', 'test suites'],
    cases: ['test case', 'test cases'],
    runs: ['test run', 'test runs'],
    defects: ['defect', 'defects'],
    folders: ['folder', 'folders'],
  };
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? label[k][0] : label[k][1]}`);
  if (!parts.length) return 'Done — I finished the plan.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.slice(-1)}`;
  return `Done — I created ${list}. Use the links below to open and edit them.`;
}

function drillLinksForPlan(plan: any): { label: string; href: string; icon: typeof FlaskConical }[] {
  const seen = new Set<string>();
  const links: { label: string; href: string; icon: typeof FlaskConical }[] = [];
  for (const step of plan?.steps || []) {
    if (step.status !== 'completed') continue;
    const target = KIND_TO_PAGE[step.intent.kind];
    if (target && !seen.has(target.href)) {
      seen.add(target.href);
      links.push(target);
    }
  }
  return links;
}

// Folder-ask review card, extracted + memoized: the old inline version wrote every keystroke
// into the global turns array (re-rendering every message + re-firing persist/autoscroll effects)
// and re-measured the textarea on every render — both caused typing/scroll jank. Drafts stay
// LOCAL here and are committed on blur / select / Proceed only.
const FolderAskCard = memo(function FolderAskCard({
  turn,
  conversationId,
  onCommit,
  onProceed,
  onCancel,
}: {
  turn: FolderAskTurn;
  conversationId: string;
  onCommit: (turnId: string, patch: { understanding?: string }) => void;
  onProceed: (turn: FolderAskTurn) => void;
  onCancel: (turnId: string) => void;
}) {
  const [understanding, setUnderstanding] = useState(turn.understanding || '');
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Reflect external revisions (e.g. a revise-understanding reply) back into the local draft.
  useEffect(() => { setUnderstanding(turn.understanding || ''); }, [turn.understanding]);
  // One-shot auto-grow (capped at 360px): runs on mount and when the LOCAL value changes only.
  useEffect(() => {
    const el = taRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 360)}px`; }
  }, [understanding]);
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[90%] gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
          <FolderTree className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          {turn.activityRequestId ? (
            <AgentActivity
              conversationId={conversationId}
              requestId={turn.activityRequestId}
              className="mb-2"
            />
          ) : null}
          <div className="rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm">
            {turn.understanding && (
              <textarea
                ref={taRef}
                value={understanding}
                rows={3}
                onChange={(e) => setUnderstanding(e.target.value)}
                onBlur={() => onCommit(turn.id, { understanding })}
                className="mb-2 w-full resize-none overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-sans text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            )}
            <p className="text-[var(--text-primary)]">{turn.text}</p>
            {/* Review the understanding above (edit if needed), then proceed or cancel. */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => onProceed({ ...turn, understanding })}
                title="Start the run"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
              >
                <Sparkles className="h-3.5 w-3.5" /> Proceed
              </button>
              <button
                onClick={() => onCancel(turn.id)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// App/navigation picker: when a test request doesn't name a target, the run pauses HERE — the
// user picks the app (+ optional tab) on RUNTIME, or the admin navigation on ADMIN, then continues.
// Local draft state only (no global turns writes per selection), mirroring FolderAskCard.
const AppAskCard = memo(function AppAskCard({
  turn,
  onProceed,
}: {
  turn: AppAskTurn;
  onProceed: (turn: AppAskTurn, choice: { appId: string; appName: string; tab?: string }) => void;
}) {
  const [appId, setAppId] = useState(turn.apps[0]?.id || '');
  const [tab, setTab] = useState('');
  const selected = turn.apps.find((a) => a.id === appId) || null;
  const isAdmin = turn.platform === 'ADMIN';
  const isPlatform = turn.apps.some((a) => Boolean(a.baseUrl));
  const label = isPlatform
    ? `Which platform should I test for ${turn.surface}?`
    : isAdmin
    ? `Which admin navigation should I test in ${turn.surface}?`
    : `Which app should I test in ${turn.surface}?${turn.apps.some((a) => a.tabs.length) ? ' Optionally pick a tab to focus on.' : ''}`;
  // Group options into optgroups when the server sends groups (the admin side-nav sections).
  const groups = [...new Set(turn.apps.map((a) => a.group).filter(Boolean))] as string[];
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[90%] gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
          <LayoutGrid className="h-4 w-4" />
        </div>
        <div className="rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm">
          <p className="text-[var(--text-primary)]">{label}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={appId}
              onChange={(e) => { setAppId(e.target.value); setTab(''); }}
              aria-label={isPlatform ? 'Test platform' : isAdmin ? 'Admin navigation' : 'Application'}
              className="min-w-0 max-w-[260px] truncate rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              {groups.length
                ? groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {turn.apps.filter((a) => a.group === g).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                ))
                : turn.apps.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              {turn.allowAllApps && <option value="__all_apps__">All Apps (Read-only Sweep)</option>}
            </select>
            {!isAdmin && selected && selected.tabs.length > 0 && (
              <select
                value={tab}
                onChange={(e) => setTab(e.target.value)}
                aria-label="Tab (optional)"
                className="min-w-0 max-w-[220px] truncate rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="">Whole App</option>
                {selected.tabs.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => {
                const name = appId === '__all_apps__' ? 'All Apps' : (selected?.name || appId);
                if (!appId) return;
                onProceed(turn, { appId, appName: name, tab: tab || undefined });
              }}
              disabled={!appId}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:hover:bg-[var(--accent)]"
            >
              <Sparkles className="h-3.5 w-3.5" /> Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

// Last-rendered turns per conversation — seeds useState on remount so the first paint shows the chat, not the
// empty "new chat" flash. The mount load still runs to revalidate + resume.
const turnsCache = new Map<string, Turn[]>();

export default function AgentConsole() {
  // Active project/app scope. The whole page subtree remounts when this changes
  // (see App.tsx scopeKey), so reading it once at mount binds this console
  // instance to the right chat workspace.
  const selectedProjectId = useProjects((s) => s.selectedProjectId);
  const selectedAppId = useProjects((s) => s.selectedAppId);
  const scopeProject = useProjects((s) => s.selectedProject());
  const scopeApp = useProjects((s) => s.selectedApp());
  const workspaceId = scopeWorkspaceId(selectedProjectId, selectedAppId);
  const convKey = activeConvKey(workspaceId);

  // Settings toggle: show/hide per-query background-communication logs in this chat.
  const showQueryLogs = useUiSettings((s) => s.showQueryLogs);
  const loadUiSettings = useUiSettings((s) => s.load);
  useEffect(() => { void loadUiSettings(); }, [loadUiSettings]);

  // Router hooks must be read BEFORE the conversationId initializer below uses `urlChatId`. Previously
  // `useParams` was declared further down, so the initializer referenced it in the temporal dead zone —
  // it always threw, fell into the catch, and minted a NEW id, silently ignoring a shared /chat/:id link.
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId: urlChatId } = useParams<{ chatId?: string }>();

  // Seed from cache (same id as conversationId resolves) so a remount paints the chat, not the empty flash.
  const [turns, setTurns] = useState<Turn[]>(() => {
    const seedId = urlChatId || readScopedStorage(convKey);
    return seedId ? (turnsCache.get(seedId) ?? []) : [];
  });
  // True when this mount painted from cache (a revisit) — lets the load guard reconcile without wiping.
  const hydratedRef = useRef(turns.length > 0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const rememberedConversationIdRef = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string>(() => {
    if (urlChatId) return urlChatId;
    rememberedConversationIdRef.current = readScopedStorage(convKey);
    return rememberedConversationIdRef.current || makeConversationId();
  });
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Mirror the console's working state into the durable, cross-tab pre-run signal so the global RunningIndicator
  // shows a spinner during routing/understanding (which has no agent-runs record yet) and it stays visible after
  // navigating away. Explicit clear on unmount-while-busy is intentionally omitted — the signal's TTL reaps it,
  // and keeping it lets the pill persist across pages/tabs while the request is still in flight.
  useEffect(() => {
    if (busy) markAgentActive(conversationId, 'Working on your request…');
    else clearAgentActive(conversationId);
  }, [busy, conversationId]);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const stored = readScopedStorage('tfa_conv_favorites');
    return new Set(stored ? JSON.parse(stored) : []);
  });
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
  // Explicit "apps under test" selected by the user in the composer. ALL selected apps
  // are passed to the agent as target context on every request, so it always has the app
  // data and never replies "I don't have the URL / context".
  // Persisted per workspace (mirrors the convKey pattern) so the selection survives remounts.
  const appSelKey = `tfa_selected_apps::${workspaceId}`;
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(() => {
    const stored = readScopedStorage(appSelKey);
    return new Set(stored ? (JSON.parse(stored) as string[]) : []);
  });
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pendingDeep, setPendingDeep] = useState<PendingDeep | null>(null);
  const [pendingRequirementDraft, setPendingRequirementDraft] = useState<PendingRequirementDraft | null>(null);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState('medium');
  // Requirement mode: selected from the composer. When on, every message is routed
  // to the requirement-discovery pipeline regardless of phrasing.
  const [reqMode, setReqMode] = useState(false);
  const [scriptAuthorMode, setScriptAuthorMode] = useState(false);
  // The topbar pick is the user's, not the runtime's default — remember it so a refresh does not
  // silently drop them back onto the configured model/effort mid-task.
  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    writeScopedStorage(MODEL_PREF_KEY, model || null);
    // Usage is metered per model, so the topbar pill must re-read the allowance for the new pick.
    window.dispatchEvent(new CustomEvent(RUNTIME_MODEL_EVENT, { detail: model }));
    const runtime = providers.find((provider: any) => provider.callable);
    // Write through to the runtime settings: the topbar and Settings are ONE choice, not a local
    // preference shadowing a saved default that then disagree with each other.
    persistRuntimeChoice(runtime?.name, { model });
    const efforts = runtimeEfforts(runtime, model);
    if (!efforts.includes(selectedEffort)) {
      const next = efforts.includes(runtime?.effort) ? runtime.effort : (efforts[0] || 'medium');
      setSelectedEffort(next);
      writeScopedStorage(EFFORT_PREF_KEY, next);
      persistRuntimeChoice(runtime?.name, { effort: next });
    }
  }, [providers, selectedEffort]);

  const handleEffortChange = useCallback((effort: string) => {
    setSelectedEffort(effort);
    writeScopedStorage(EFFORT_PREF_KEY, effort || null);
    persistRuntimeChoice(providers.find((provider: any) => provider.callable)?.name, { effort });
  }, [providers]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const appPickerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  // Mirror the live turn list in a ref so send() can read the prior conversation
  // (for per-chat memory) without depending on a possibly-stale render closure.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  // Keep the composer compact for short prompts, then grow it to a readable cap.
  // Once the cap is reached, the textarea scrolls internally instead of displacing
  // the conversation above it.
  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const maxHeight = 160;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  // Snapshot the current execution context (AI + scope) for a response's metadata panel.
  const currentExecution = useCallback((): ExecutionMeta => ({
    model: selectedModel || undefined,
    effort: selectedEffort,
    workspace: workspaceId,
    projectId: selectedProjectId || undefined,
    appId: selectedAppId || undefined,
    userName: getUsername() || undefined,
    conversationId,
  }), [selectedModel, selectedEffort, workspaceId, selectedProjectId, selectedAppId, conversationId]);

  // Stamp createdAt + execution metadata on each assistant response the moment it appears, so the
  // per-message footer can show the exact time (with seconds) and the execution details (Phase 3).
  useEffect(() => {
    if (!turns.some((t) => t.role === 'assistant' && (t.kind === 'text' || t.kind === 'deeprun') && !(t as any).createdAt)) return;
    setTurns((prev) => prev.map((t) =>
      t.role === 'assistant' && (t.kind === 'text' || t.kind === 'deeprun') && !(t as any).createdAt
        ? { ...t, createdAt: new Date().toISOString(), execution: { ...currentExecution(), ...((t as any).execution || {}) } }
        : t,
    ));
  }, [turns, currentExecution]);
  // The target (app URL / website) resolved earlier in THIS chat, so a later generation
  // request ("generate them", "for admin", "yes") reuses it without re-asking — the chat
  // remembers what it's testing, like a normal assistant.
  const convTargetRef = useRef<{ targetUrl: string; websiteId?: string; websiteName?: string } | null>(null);
  // The app/navigation the user picked in the AppAskCard for the CURRENT request chain. Threaded
  // as explicit ids into /api/agent/start so no later gate re-asks; cleared on each new message.
  const targetChoiceRef = useRef<{ applicationId?: string; applicationName?: string; moduleId?: string; moduleName?: string } | null>(null);
  // The same choice as plain turn fields. Turns persist, refs do not — so the pick survives a reload
  // (and any remount) between the review card and run start instead of being asked for again.
  const targetChoiceFields = () => ({ ...(targetChoiceRef.current || {}) });
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeThinkingIdRef = useRef<string | null>(null);
  const activeActivityRef = useRef<{ conversationId: string; requestId: string; thinkingId: string } | null>(null);
  // Bridge to send() for reconcileGoal (send is defined later; a ref avoids the ordering/dep cycle).
  const sendRef = useRef<((raw?: string, editTurnIdArg?: string | null) => Promise<void>) | null>(null);

  // Keep the active conversation id in localStorage (per scope) so a refresh
  // resumes the right conversation for the selected project/app.
  useEffect(() => {
    writeScopedStorage(convKey, conversationId);
  }, [conversationId, convKey]);

  // Write-through: persist the app selection per workspace so it survives scope remounts.
  useEffect(() => {
    writeScopedStorage(appSelKey, JSON.stringify(Array.from(selectedAppIds)));
  }, [selectedAppIds, appSelKey]);

  // Drop restored app ids that no longer exist once the saved-website list loads.
  useEffect(() => {
    if (!websites.length) return;
    setSelectedAppIds((prev) => {
      const valid = new Set(Array.from(prev).filter((id) => websites.some((w) => w.id === id)));
      return valid.size === prev.size ? prev : valid;
    });
  }, [websites]);

  // Sync conversationId → URL so the address bar always reflects the active chat.
  // Uses replace so switching chats doesn't pollute the browser history stack.
  useEffect(() => {
    const basePath = location.pathname.replace(/\/chat\/[^/]*$/, '').replace(/\/$/, '') || '/';
    const target = `${basePath === '/' ? '' : basePath}/chat/${conversationId}`;
    if (location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [conversationId, location.pathname, navigate]);

  useEffect(() => {
    if (!appPickerOpen) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && appPickerRef.current?.contains(target)) return;
      setAppPickerOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAppPickerOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [appPickerOpen]);

  const loadConversations = useCallback(async () => {
    try {
      const r = await fetch(`/api/chat/conversations?workspaceId=${encodeURIComponent(workspaceId)}`);
      const d = await r.json();
      setConversations(Array.isArray(d.conversations) ? d.conversations : []);
    } catch {
      /* ignore */
    }
  }, [workspaceId]);

  // Monotonic token so a slow/stale conversation load can never overwrite newer state.
  const loadReqRef = useRef(0);
  // The ACTIVE conversation's stored title — the snapshot PUT reuses it so a custom rename is
  // never clobbered by the auto-title derived from the first user message.
  const convTitleRef = useRef('');
  // Append a deep-run card for any server run not already shown, recovering runs the snapshot lost
  // (navigated away mid-start). Best-effort, idempotent (dedup by taskId); the append re-persists.
  const reconcileConversationRuns = useCallback(async (id: string, token: number) => {
    try {
      const r = await fetch(`/api/agent-runs/for-conversation/${encodeURIComponent(id)}`);
      if (!r.ok || token !== loadReqRef.current) return;
      const d = await r.json();
      const runs: Array<{ id?: string; created_at?: string }> = Array.isArray(d?.runs) ? d.runs : [];
      if (!runs.length) return;
      const ordered = [...runs].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      setTurns((prev) => {
        if (token !== loadReqRef.current) return prev; // conversation changed under us — don't graft
        const shown = new Set(
          prev
            .filter((t): t is Extract<Turn, { kind: 'deeprun' }> => t.role === 'assistant' && t.kind === 'deeprun')
            .map((t) => t.taskId),
        );
        const cards: Turn[] = ordered
          .filter((run) => run.id && !shown.has(run.id))
          .map((run) => ({ id: nextId(), role: 'assistant', kind: 'deeprun', taskId: run.id as string }));
        return cards.length ? [...prev, ...cards] : prev;
      });
    } catch { /* best-effort recovery */ }
  }, []);

  // Resume an understanding ("thinking") that was in flight when the user navigated away: the backend job is
  // durable, so on return we re-attach by conversation and rebuild the review card instead of dropping it.
  const reconcileUnderstanding = useCallback(async (id: string, token: number, restored?: Turn[]) => {
    try {
      const known = restored ?? turnsRef.current;
      // Never double-attach — if the restored turns already show a thinking/folder-ask, it wasn't dropped.
      if (known.some((t) => t.role === 'assistant' && (t.kind === 'thinking' || t.kind === 'folderask'))) return;
      // Nor when this request already moved past the gate: an assistant turn after the last user message
      // means the understanding was answered (proceeded or superseded), so re-attaching would graft a
      // second review card behind a run that is already underway.
      let lastUserIdx = -1;
      for (let i = known.length - 1; i >= 0; i -= 1) if (known[i].role === 'user') { lastUserIdx = i; break; }
      if (lastUserIdx >= 0 && known.slice(lastUserIdx + 1).some((t) => t.role === 'assistant')) return;
      const r = await fetch(`/api/agent/understand-request/for-conversation/${encodeURIComponent(id)}`);
      if (!r.ok || token !== loadReqRef.current) return;
      const job = (await r.json())?.job;
      const ctx = job?.context;
      if (!job || !ctx || !ctx.targetUrl) return;

      const buildCard = (result: any) => {
        if (token !== loadReqRef.current) return;
        const prompt = String(ctx.prompt || '');
        const originalRequest = String(ctx.originalRequest || prompt);
        const contextPrompt = String(ctx.contextPrompt || '');
        const targetUrl = String(ctx.targetUrl || '');
        const websiteId = ctx.websiteId || undefined;
        const websiteName = ctx.websiteName || undefined;
        const target = websiteName ? `${websiteName} (${targetUrl})` : targetUrl;
        const fallbackUnderstanding = `Here's what I understood:\n• Target: ${target}\n• Task: ${prompt}\n\nPlan: log in to the target → perform the steps on the live app → verify the result → capture screenshots as evidence.`;
        const understanding = String(result?.understanding || '').trim() || fallbackUnderstanding;
        const understandingSource = String(result?.source || 'fallback');
        const caseCountPrompt = originalRequest || prompt;
        const activityRequestId = job.jobId ? `understanding:${job.jobId}` : undefined;
        setPendingDeep({ prompt, originalRequest, contextPrompt, caseCountPrompt, targetUrl, websiteId, websiteName, understanding, understandingSource, revisionCount: 0 });
        convTargetRef.current = { targetUrl, websiteId, websiteName };
        const cardId = nextId();
        // Dedup against live turns (not the stale ref): on refresh the restored snapshot already holds
        // this review card, so re-attaching the durable understanding job must never double it.
        setTurns((prev) => {
          if (token !== loadReqRef.current) return prev;
          if (prev.some((t) => t.role === 'assistant' && t.kind === 'folderask')) return prev;
          return [...prev, {
            id: cardId, role: 'assistant', kind: 'folderask' as const, understanding, understandingSource,
            originalPrompt: contextPrompt || prompt, contextPrompt, caseCountPrompt, targetUrl, websiteId, websiteName,
            revisionCount: 0, activityRequestId,
            text: 'Look right? Review the summary above, then Proceed — or tell me what to change.',
          }];
        });
      };

      if (job.status === 'done') { buildCard(job.result); return; }
      // Still running: show a resuming spinner and poll the durable job to completion.
      const thinkingId = nextId();
      // Same dedup: never stack a second resuming-spinner onto a thread that already shows one / a review card.
      setTurns((prev) => {
        if (token !== loadReqRef.current) return prev;
        if (prev.some((t) => t.role === 'assistant' && (t.kind === 'thinking' || t.kind === 'folderask'))) return prev;
        return [...prev, {
          id: thinkingId,
          role: 'assistant',
          kind: 'thinking' as const,
          label: 'Resuming — finishing what I was analyzing…',
          activityRequestId: job.jobId ? `understanding:${job.jobId}` : undefined,
        }];
      });
      for (let i = 0; i < 240; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        if (token !== loadReqRef.current) return;
        const jr = await fetch(`/api/agent/understand-request/${job.jobId}`).then((x) => x.json()).catch(() => null);
        if (token !== loadReqRef.current) return;
        if (jr?.status === 'done') { setTurns((prev) => prev.filter((t) => t.id !== thinkingId)); buildCard(jr.result); return; }
        if (!jr || jr.error) { setTurns((prev) => prev.filter((t) => t.id !== thinkingId)); return; } // job expired (pruned/restart)
      }
    } catch { /* best-effort resume */ }
  }, []);

  // Resume a router decision that finished while the user was away: re-drive the unconsumed message through
  // send() (reusing its user turn). Guards below skip any double-run. Pairs with the durable goal job.
  // `restored` is the conversation the caller just loaded: turnsRef still holds the PREVIOUS
  // conversation at this point (state updates land after this tick), and re-driving against it
  // re-ran an already-answered message — which the console then showed as a duplicate response.
  const reconcileGoal = useCallback(async (id: string, token: number, restored?: Turn[]) => {
    try {
      const known = restored ?? turnsRef.current;
      if (known.some((t) => t.role === 'assistant' && (t.kind === 'thinking' || t.kind === 'folderask'))) return;
      const u = await fetch(`/api/agent/understand-request/for-conversation/${encodeURIComponent(id)}`).then((x) => x.json()).catch(() => null);
      if (token !== loadReqRef.current) return;
      if (u?.job) return; // understanding is in flight — its own reconcile handles it
      const g = await fetch(`/api/agent/goal/for-conversation/${encodeURIComponent(id)}`, { headers: { 'Cache-Control': 'no-store' } }).then((x) => x.json()).catch(() => null);
      if (token !== loadReqRef.current || !g?.job) return;
      // Only the last user turn with no assistant response after it is unconsumed work to resume.
      const turns = known;
      let lastUserIdx = -1;
      for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i].role === 'user') { lastUserIdx = i; break; }
      if (lastUserIdx < 0) return;
      if (turns.slice(lastUserIdx + 1).some((t) => t.role === 'assistant')) return;
      const text = String((turns[lastUserIdx] as any).text || '').trim();
      if (!text || !sendRef.current) return;
      void sendRef.current(text, turns[lastUserIdx].id); // re-drive via the battle-tested send() path
    } catch { /* best-effort resume */ }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const token = ++loadReqRef.current;
    loadedRef.current = false;
    try {
      const activityRequest = fetch(`/api/controller/activity/for-conversation/${encodeURIComponent(id)}`, { cache: 'no-store' })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null);
      const r = await fetch(`/api/chat/conversations/${id}`);
      const d = await r.json();
      if (token !== loadReqRef.current) return; // a newer load won — discard this result
      // The conversation belongs to another user (e.g. a stale pinned id from before login).
      // Never keep it or write into it — fork to a fresh, own conversation so new messages are
      // saved under this user and show up in their history.
      if (d?.foreign) {
        convTitleRef.current = '';
        setConversationId(makeConversationId());
        setTurns([]);
        loadedRef.current = true;
        return;
      }
      // Drop any transient "thinking" turns that may have been persisted.
      const clean = (Array.isArray(d.turns) ? d.turns : []).filter(
        (t: Turn) => !(t.role === 'assistant' && t.kind === 'thinking'),
      );
      const activity = await activityRequest;
      if (token !== loadReqRef.current) return;
      const restored: Turn[] = restoreActiveActivity(clean, activity);
      convTitleRef.current = String(d.title || '');
      setTurns(restored);
      // Re-attach any run the snapshot lost (navigated away mid-start) — see reconcileConversationRuns.
      void reconcileConversationRuns(id, token);
      // Resume an understanding that was in flight when the user navigated away mid-thinking.
      void reconcileUnderstanding(id, token, restored);
      // Resume a router decision that finished while the user was away (before understanding started).
      void reconcileGoal(id, token, restored);
    } catch {
      // Never wipe a live thread on a failed load — only clear when nothing is on screen.
      if (token === loadReqRef.current && turnsRef.current.length === 0) setTurns([]);
    } finally {
      if (token === loadReqRef.current) loadedRef.current = true;
    }
  }, [reconcileConversationRuns, reconcileUnderstanding, reconcileGoal]);

  // Initial load: restore the active conversation + the history list. If the remembered id has no
  // content (e.g. a fresh id was minted before the scope settled, or the user navigated away and
  // back to the console), fall back to the most recently updated non-empty chat for this scope so
  // the recent conversation is shown instead of the empty welcome screen.
  useEffect(() => {
    const cleanTurns = (raw: unknown): Turn[] =>
      (Array.isArray(raw) ? (raw as Turn[]) : []).filter((t) => !(t.role === 'assistant' && t.kind === 'thinking'));
    (async () => {
      const token = ++loadReqRef.current; // stale-response guard for the mount-time load
      let convs: ConversationMeta[] = [];
      try {
        const r = await fetch(`/api/chat/conversations?workspaceId=${encodeURIComponent(workspaceId)}`);
        const d = await r.json();
        convs = Array.isArray(d.conversations) ? d.conversations : [];
        setConversations(convs);
      } catch { /* ignore */ }

      const preferredId = conversationId;
      let chosen = preferredId;
      let chosenTurns: Turn[] = [];
      let chosenTitle = '';
      let preferredForeign = false;
      try {
        const r = await fetch(`/api/chat/conversations/${preferredId}`);
        const d = await r.json();
        if (d?.foreign) preferredForeign = true; // pinned id belongs to another user
        chosenTurns = cleanTurns(d?.turns);
        chosenTitle = String(d?.title || '');
      } catch { /* ignore */ }

      // Fall back to a recent OWN chat when the preferred one is empty (and not a deep link) OR
      // when it belongs to another user — never land the user inside a foreign conversation.
      if ((chosenTurns.length === 0 && !urlChatId && !rememberedConversationIdRef.current) || preferredForeign) {
        const recent = [...convs]
          .filter((c) => (c.turnCount || 0) > 0)
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
        if (recent && recent.id !== preferredId) {
          try {
            const r = await fetch(`/api/chat/conversations/${recent.id}`);
            const d = await r.json();
            chosenTurns = cleanTurns(d?.turns);
            chosenTitle = String(d?.title || '');
            chosen = recent.id;
          } catch { /* ignore */ }
        }
      }

      // If the preferred conversation was foreign and no own chat was chosen instead, mint a
      // fresh id so we never keep (or write into) another user's conversation.
      if (preferredForeign && chosen === preferredId) {
        chosen = makeConversationId();
        chosenTurns = [];
        chosenTitle = '';
      }

      if (token !== loadReqRef.current) return; // a newer load (chat switch/new chat) won
      loadedRef.current = true;
      if (turnsRef.current.length > 0) {
        // Never wipe a live/hydrated thread; a cache-hydrated revisit still reconciles (idempotent) to resume.
        if (hydratedRef.current) {
          const activity = await fetch(`/api/controller/activity/for-conversation/${encodeURIComponent(conversationId)}`, { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : null)
            .catch(() => null);
          const restored = restoreActiveActivity(turnsRef.current, activity) as Turn[];
          setTurns(restored);
          void reconcileConversationRuns(conversationId, token);
          void reconcileUnderstanding(conversationId, token, restored);
          void reconcileGoal(conversationId, token, restored);
        }
        return;
      }
      const activity = await fetch(`/api/controller/activity/for-conversation/${encodeURIComponent(chosen)}`, { cache: 'no-store' })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null);
      if (token !== loadReqRef.current) return;
      const restored = restoreActiveActivity(chosenTurns, activity) as Turn[];
      convTitleRef.current = chosenTitle;
      if (chosen !== conversationId) setConversationId(chosen);
      setTurns(restored);
      // Re-attach any run the snapshot lost for the restored conversation (navigated away mid-start).
      void reconcileConversationRuns(chosen, token);
      // Resume an understanding that was in flight when the user navigated away mid-thinking.
      void reconcileUnderstanding(chosen, token, restored);
      // Resume a router decision that finished while the user was away (before understanding started).
      void reconcileGoal(chosen, token, restored);
    })();
    fetch('/api/credentials/websites')
      .then((r) => r.json())
      .then((d) => setWebsites(Array.isArray(d?.websites) ? d.websites : []))
      .catch(() => {});
    fetch('/api/ai/providers')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data?.providers) ? data.providers : [];
        setProviders(list);
        const runtime = list.find((p: any) => p.callable);
        if (runtime) {
          const offered = runtimeModelIds(runtime);
          const savedModel = readScopedStorage(MODEL_PREF_KEY) || '';
          const savedEffort = readScopedStorage(EFFORT_PREF_KEY) || '';
          // The SERVER value wins: the topbar writes through to it, so it is always at least as fresh
          // as the local pref — and this is what makes a change made in Settings show up here.
          // The stored pref is only a fallback for a runtime that reports no model of its own.
          const nextModel = offered.includes(runtime.model) ? runtime.model : (offered.includes(savedModel) ? savedModel : offered[0]);
          const efforts = runtimeEfforts(runtime, nextModel);
          setSelectedModel(nextModel);
          setSelectedEffort(efforts.includes(runtime.effort) ? runtime.effort : (efforts.includes(savedEffort) ? savedEffort : (efforts[0] || 'medium')));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The latest savable snapshot, kept in a ref so the unmount/page-hide flush below can persist it
  // even though the debounced timer is cleared on unmount before it fires. Without this, a rich turn
  // created moments before navigating away — notably a deep-run card holding the run's task_id — is
  // never written, so returning to the console shows only the user's message and the still-running
  // durable run is orphaned (this was the "my request disappears when I switch pages" bug).
  const pendingSnapshotRef = useRef<{ conversationId: string; workspaceId: string; turns: typeof turns } | null>(null);

  const writeConversationSnapshot = useCallback(
    (snap: { conversationId: string; workspaceId: string; turns: typeof turns }, keepalive = false) => {
      if (!snap.turns.length) return undefined; // don't persist empty conversations
      const firstUser = snap.turns.find((t) => t.role === 'user') as { text?: string } | undefined;
      // Full turn snapshot (not just title): rich turns (deep-run cards, drafts, cases) only live in
      // React state, so without this they vanish on navigation/restart and history opens blank.
      // A custom (renamed) title always wins over the auto-title from the first user message.
      return fetch(`/api/chat/conversations/${snap.conversationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        keepalive,
        body: JSON.stringify({ workspaceId: snap.workspaceId, title: convTitleRef.current || firstUser?.text?.slice(0, 80) || 'New Chat', turns: snap.turns }),
      });
    },
    [],
  );

  // Persist the conversation (debounced) whenever the turns change.
  useEffect(() => {
    if (!loadedRef.current) return;
    const clean = turns.filter((t) => !(t.role === 'assistant' && t.kind === 'thinking'));
    // Keep the hydration cache current so a remount paints this conversation instantly (see turnsCache).
    if (clean.length) turnsCache.set(conversationId, clean); else turnsCache.delete(conversationId);
    pendingSnapshotRef.current = clean.length ? { conversationId, workspaceId, turns: clean } : null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const res = writeConversationSnapshot({ conversationId, workspaceId, turns: clean });
      if (res) res.then(() => loadConversations()).catch(() => {});
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [turns, conversationId, workspaceId, loadConversations, writeConversationSnapshot]);

  // Flush the pending snapshot when the console unmounts (SPA navigation, scope remount) or the page
  // is hidden/closed — the app-level safety net. This is what actually rescues a deep-run card (its
  // task_id) created just before navigating away: because the snapshot lands, returning restores the
  // turn and DeepRunResult/useAgentRun re-attach to the still-running durable run instead of the
  // console showing only the user turn.
  useFlushOnUnload(() => {
    if (!loadedRef.current) return;
    const snap = pendingSnapshotRef.current;
    if (snap) writeConversationSnapshot(snap, true);
  });

  // Close the history dropdown on outside click.
  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    if (historyOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [historyOpen]);

  const newConversation = useCallback(() => {
    // Cancel any in-flight generation from the conversation we're leaving. Otherwise `busy`
    // stays true and the toolbar is stuck showing "Stop" in the new chat with no way to send
    // (send() early-returns while busy), and nothing generates.
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    activeThinkingIdRef.current = null;
    activeActivityRef.current = null;
    setBusy(false);
    loadReqRef.current++; // invalidate any in-flight conversation load
    convTitleRef.current = '';
    convTargetRef.current = null; // the sticky target belongs to the conversation we are leaving
    setPendingDeep(null);
    setPendingRequirementDraft(null);
    setConversationId(makeConversationId());
    setTurns([]);
    loadedRef.current = true;
    setHistoryOpen(false);
  }, []);

  const switchConversation = useCallback(
    (id: string) => {
      if (id === conversationId) {
        setHistoryOpen(false);
        return;
      }
      // Leaving this conversation: cancel any in-flight run so `busy`/the "Stop" button don't
      // carry over into the conversation we're opening.
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
      activeThinkingIdRef.current = null;
      activeActivityRef.current = null;
      setBusy(false);
      convTargetRef.current = null; // never carry one conversation's target into another
      setPendingDeep(null);
      setPendingRequirementDraft(null);
      setConversationId(id);
      loadConversation(id);
      setHistoryOpen(false);
    },
    [conversationId, loadConversation],
  );

  useEffect(() => {
    try {
      writeScopedStorage('tfa_conv_favorites', JSON.stringify(Array.from(favorites)));
    } catch { /* ignore */ }
  }, [favorites]);

  const toggleFavorite = useCallback((id: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const deleteConversation = useCallback(async (id: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setFavorites((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setSelectedConversationIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    if (id === conversationId) newConversation();
  }, [conversationId, newConversation]);

  const toggleConversationSelection = useCallback((id: string) => {
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const deleteSelectedConversations = useCallback(async () => {
    const ids = Array.from(selectedConversationIds);
    if (!ids.length) return;
    if (!await showConfirm(`Delete ${ids.length === conversations.length ? 'all' : ids.length} selected conversation${ids.length === 1 ? '' : 's'}? This cannot be undone.`, { tone: 'danger' })) return;

    const results = await Promise.all(ids.map(async (id) => {
      try {
        const response = await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
        return response.ok ? id : null;
      } catch {
        return null;
      }
    }));
    const deleted = new Set<string>(results.filter((id): id is string => id !== null));

    setConversations((prev) => prev.filter((conversation) => !deleted.has(conversation.id)));
    setFavorites((prev) => {
      const next = new Set(prev);
      deleted.forEach((id) => next.delete(id));
      return next;
    });
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      deleted.forEach((id) => next.delete(id));
      return next;
    });
    if (deleted.has(conversationId)) newConversation();
    if (deleted.size !== ids.length) void showAlert(`${ids.length - deleted.size} conversation${ids.length - deleted.size === 1 ? '' : 's'} could not be deleted.`);
  }, [selectedConversationIds, conversations.length, conversationId, newConversation]);

  // Rename a conversation to a custom name (so it can be tracked against its test cases) — persisted
  // via the metadata-only PUT; for the ACTIVE chat the snapshot PUT keeps the custom title from then on.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const commitRename = useCallback(async () => {
    const id = renamingId;
    const title = renameDraft.trim().slice(0, 80);
    setRenamingId(null);
    if (!id || !title) return;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    if (id === conversationId) convTitleRef.current = title;
    try {
      await fetch(`/api/chat/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, title }),
      });
    } catch { /* list refresh below restores the server's view on failure */ }
    loadConversations();
  }, [renamingId, renameDraft, conversationId, workspaceId, loadConversations]);

  const appendSpeechTranscript = useCallback((transcript: string) => {
    setInput((prev) => prev + (prev.trim() ? ' ' : '') + transcript);
  }, []);

  const {
    error: speechError,
    interimTranscript,
    isListening,
    isSupported: isSpeechSupported,
    stopListening,
    toggleListening,
  } = useSpeechToText({ onTranscript: appendSpeechTranscript });

  // Track whether the user is near the bottom (~120px) so streaming never yanks them back down.
  const atBottomRef = useRef(true);
  const handleChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);
  const followChatBottom = useCallback(() => {
    if (!atBottomRef.current) return;
    const active = document.activeElement;
    if (active && scrollRef.current?.contains(active) && active.matches('input, textarea, select, [contenteditable="true"]')) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, []);
  useEffect(() => {
    if (turns.length === 0) {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }
    if (!atBottomRef.current) return; // user scrolled up — leave them alone
    const active = document.activeElement;
    if (active && scrollRef.current?.contains(active) && active.matches('input, textarea, select, [contenteditable="true"]')) return;
    // 'auto' (not 'smooth'): retargeting a smooth scroll on every streamed token is jerky.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, [turns]);

  const patchTurn = useCallback((id: string, plan: any) => {
    setTurns((prev) => prev.map((t) => (t.id === id && t.role === 'assistant' && t.kind === 'plan' ? { ...t, plan } : t)));
  }, []);

  const replaceTurn = useCallback((id: string, turn: Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? turn : t)));
  }, []);

  // replaceTurn + persist immediately from turnsRef (not React state), so a terminal result — notably
  // a deep-run card's task_id — still lands if the console unmounted mid-start. Use for TERMINAL results.
  const commitTurn = useCallback((id: string, turn: Turn) => {
    replaceTurn(id, turn);
    if (!loadedRef.current) return;
    const nextTurns = turnsRef.current.map((t) => (t.id === id ? turn : t));
    const clean = nextTurns.filter((t) => !(t.role === 'assistant' && t.kind === 'thinking'));
    if (!clean.length) return;
    pendingSnapshotRef.current = { conversationId, workspaceId, turns: clean };
    writeConversationSnapshot({ conversationId, workspaceId, turns: clean }, true)?.catch(() => {});
  }, [replaceTurn, writeConversationSnapshot, conversationId, workspaceId]);

  const updateThinkingLabel = useCallback((id: string, label: string) => {
    setTurns((prev) => prev.map((t) => (
      t.id === id && t.role === 'assistant' && t.kind === 'thinking'
        ? { ...t, label }
        : t
    )));
  }, []);

  const formatDebugPayload = useCallback((payload: any): string => {
    if (payload == null || payload === '') return '';
    if (typeof payload === 'string') return payload;
    const lines: string[] = [];
    const routeLabel = (kind: string) => {
      switch (kind) {
        case 'answer': return 'general grounded answer';
        case 'clarify': return 'clarification request';
        case 'code_analysis': return 'code analysis';
        case 'requirement_draft': return 'requirement drafting';
        case 'generate_cases': return 'reviewed test case generation';
        case 'deep_test_run': return 'deep test run';
        case 'workspace_action': return 'workspace action';
        default: return kind || 'unknown route';
      }
    };
    if (payload.message) lines.push(`Message: ${payload.message}`);
    if (payload.userMessage) lines.push(`User message: ${payload.userMessage}`);
    if (payload.type) lines.push(`Event: ${payload.type}`);
    if (payload.text) lines.push(`Step: ${payload.text}`);
    if (payload.kind) {
      const chosen = routeLabel(payload.kind);
      lines.push('Thinking step:');
      lines.push('I need to route this request first.');
      lines.push('Reason:');
      lines.push('The user asked something in chat, so I need to decide whether this is a quick answer, requirement draft, test generation, deep test run, or workspace action.');
      lines.push('Decision:');
      lines.push(`Use the ${chosen} path.`);
      lines.push('Next:');
      lines.push('Build scope from selected app, chat history, current page, and target URL if available.');
      lines.push(`What I understood: this request should be handled as ${chosen}.`);
      lines.push(`Decision: route to ${chosen}.`);
      lines.push(`Why: the router classified the user message, chat history, current page, and selected app context.`);
      lines.push(`Next: ${payload.kind === 'generate_cases' || payload.kind === 'deep_test_run' ? 'build a reviewed test scope, then start the test-generation run' : payload.kind === 'answer' ? 'prepare a grounded answer' : payload.kind === 'clarify' ? 'ask the missing question before acting' : 'continue with the selected workflow'}.`);
      if (payload.kind === 'generate_cases' || payload.kind === 'deep_test_run') {
        const featureScope = requestedFeatureScope(payload.message || payload.userMessage || '');
        const count = requestedCaseCount(payload.message || payload.userMessage || '');
        lines.push('Thinking step:');
        lines.push('I need source/context before writing cases.');
        lines.push('Reason:');
        lines.push(`The request is scoped to ${featureScope}, so the generated cases should stay limited to that feature.`);
        lines.push('Decision:');
        lines.push(`Scope test generation to ${featureScope}.`);
        lines.push('Next:');
        lines.push(count ? `Generate ${count} reviewable test case${count === 1 ? '' : 's'}.` : 'Generate reviewable test cases for that scoped feature.');
      }
      lines.push(`Router chose: ${payload.kind}`);
    }
    if (payload.reply) lines.push(`Reply ready: ${String(payload.reply).slice(0, 500)}`);
    if (payload.error) lines.push(`Error: ${payload.error}`);
    if (payload.delta) lines.push(`Answer text: ${payload.delta}`);
    if (payload.pageContext?.path) lines.push(`Current page: ${payload.pageContext.path}`);
    if (payload.projectId) lines.push(`Project: ${payload.projectId}`);
    if (payload.appId) lines.push(`App: ${payload.appId}`);
    if (Array.isArray(payload.apps)) lines.push(`Apps in scope: ${payload.apps.map((app: any) => app.name || app.id || app.baseUrl).filter(Boolean).join(', ') || 'none'}`);
    if (Array.isArray(payload.history)) lines.push(`History sent: ${payload.history.length} turns`);
    if (payload.toolCalls?.length) {
      const tools = payload.toolCalls.map((tool: any) => tool.name).filter(Boolean).join(', ');
      lines.push(`Evidence used: live tool-call event from the supervisor stream.`);
      lines.push(`Decision: call ${tools}.`);
      lines.push(`Why: the current step needs workspace/code/application data before answering.`);
      lines.push(`Next: read the tool result and continue the response.`);
      lines.push(`Tool call: ${tools}`);
    }
    if (!lines.length) lines.push('Background data received.');
    if (!payload.error && !payload.kind && !payload.toolCalls?.length) lines.push('Uncertainty: none reported by this step.');
    return lines.join('\n');
  }, []);

  const appendThinkingDebug = useCallback((id: string, line: string, payload?: any) => {
    if (containsPrivateFileActivity(payload === undefined ? line : payload)) return;
    const text = payload === undefined
      ? line
      : `${line}\n${formatDebugPayload(payload)}`;
    setTurns((prev) => prev.map((t) => (
      t.id === id && t.role === 'assistant' && t.kind === 'thinking'
        ? { ...t, debug: [...(t.debug || []), text].slice(-20) }
        : t
    )));
  }, [formatDebugPayload]);

  const stopActiveRequest = useCallback(() => {
    const activity = activeActivityRef.current;
    if (activity) {
      void fetch(`/api/controller/activity/${encodeURIComponent(activity.conversationId)}/${encodeURIComponent(activity.requestId)}`, { method: 'DELETE' });
      activeActivityRef.current = null;
    }
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    const thinkingId = activeThinkingIdRef.current;
    activeThinkingIdRef.current = null;
    stopListening();
    if (thinkingId) {
      // Flag the turn as stopped so a Retry affordance appears — otherwise a stopped pipeline
      // left the user with no way to re-run it (bug: unable to retry after stopping generation).
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: 'Stopped. You can retry this request.',
        stopped: true,
        activityRequestId: activity?.requestId,
      });
    }
    setBusy(false);
    inputRef.current?.focus();
  }, [replaceTurn, stopListening]);

  // The run prompt is the user's CURRENT sentence, nothing else. Labels/boilerplate here used to dominate
  // the server's subjectChanged() term set, so the attention gate never saw a feature change and every
  // follow-up inherited the previous task. Prior turns still reach the server as structured history.
  /**
   * The scope produced for the CURRENT request: assistant answers since the last user message.
   * Bounded there on purpose — the old fallback took the longest of the last SIX assistant turns,
   * which is how a previous task's answer became a new run's approved grounding. Without any
   * fallback the agent's own coverage plan was written, shown, then dropped, and the case writer
   * authored from the bare prompt.
   */
  const scopeFromCurrentExchange = useCallback((): string => {
    const turns = turnsRef.current;
    let best = '';
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i] as any;
      if (turn.role === 'user') break; // stop at this request — never reach into an earlier task
      const text = String(turn.text || turn.understanding || turn.summary || '').trim();
      if (turn.role === 'assistant' && text && !isNoiseAnswer(text) && text.length > best.length) best = text;
    }
    return best;
  }, []);

  const buildDeepContextPrompt = useCallback((rawRequest: string, resolvedScope: string): string => {
    const request = (rawRequest || '').trim();
    const scope = (resolvedScope || '').trim();
    return [request, scope && scope !== request ? scope : ''].filter(Boolean).join('\n\n').trim() || request;
  }, []);

  // The prior turns of THIS chat, as a compact role/content transcript, so every
  // request carries conversation memory (ChatGPT/Claude-style continuity).
  const buildHistory = useCallback((): Array<{ role: 'user' | 'assistant'; content: string }> => {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const push = (content: string) => { if (content && content.trim()) out.push({ role: 'assistant', content: content.trim().slice(0, 4000) }); };
    for (const t of turnsRef.current) {
      if (t.role === 'user') {
        if (t.text?.trim()) out.push({ role: 'user', content: t.text });
        continue;
      }
      // Serialize EVERY assistant turn kind — not just plain text. Previously the
      // "work" turns (plan/cases/deeprun/codereview/reqdiscovery) contributed zero
      // bytes, so follow-ups like "add sorting" or "rerun those" lost the artifacts
      // the agent had just produced. The agent must remember what it did.
      switch (t.kind) {
        case 'text':
          push(t.text);
          break;
        case 'folderask':
          push(t.understanding || t.text);
          break;
        case 'appask':
          push(t.text);
          break;
        case 'clarify':
          push(t.summary);
          break;
        case 'plan': {
          const steps = Array.isArray(t.plan?.steps)
            ? t.plan.steps.map((s: any, i: number) => `${i + 1}. ${s?.intent?.title || s?.intent?.kind || 'step'}`).join('; ')
            : '';
          push([t.plan?.summary, steps && `Plan steps: ${steps}`].filter(Boolean).join(' '));
          break;
        }
        case 'cases': {
          const titles = Array.isArray(t.cases)
            ? t.cases.map((c: any, i: number) => `${c?.id || c?.caseId || i + 1}: ${c?.title || c?.name || `case ${i + 1}`}`).join('; ')
            : '';
          push(`Generated ${Array.isArray(t.cases) ? t.cases.length : 0} test case(s): ${titles}`);
          break;
        }
        case 'deeprun': {
          const tgt = convTargetRef.current?.targetUrl || convTargetRef.current?.websiteName || '';
          push(`Started a deep test-generation run (task ${t.taskId})${tgt ? ` for ${tgt}` : ''}.`);
          break;
        }
        case 'reqdiscovery':
          push(`Requirement discovery: ${typeof t.result === 'string' ? t.result : (t.result?.summary || JSON.stringify(t.result || {})).slice(0, 600)}`);
          break;
        case 'reqdraft':
          push(`Requirement draft: ${t.result?.requirement?.title || t.query || ''}. ${t.result?.requirement?.description || ''}`);
          break;
        case 'codereview':
          push(`Code review findings: ${typeof t.analysis === 'string' ? t.analysis : (t.analysis?.summary || JSON.stringify(t.analysis || {})).slice(0, 600)}`);
          break;
        default:
          break;
      }
    }
    return out.slice(-60);
  }, []);

  const startDeepRun = useCallback(async (args: {
    thinkingId: string;
    prompt: string;
    targetUrl: string;
    websiteId?: string;
    websiteName?: string;
    approvedUnderstanding?: string;
    understandingSource?: string;
    priorGrounding?: string;
    caseCountPrompt?: string;
    applicationId?: string;
    applicationName?: string;
    moduleId?: string;
    moduleName?: string;
    metadataRefs?: string[];
  }) => {
    const requestedActivityId = globalThis.crypto.randomUUID();
    activeActivityRef.current = { conversationId, requestId: requestedActivityId, thinkingId: args.thinkingId };
    setTurns((prev) => prev.map((turn) => (
      turn.id === args.thinkingId && turn.role === 'assistant' && turn.kind === 'thinking'
        ? { ...turn, activityRequestId: requestedActivityId }
        : turn
    )));
    updateThinkingLabel(args.thinkingId, 'Starting agent run...');
    const res = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: activeAbortRef.current?.signal,
        body: JSON.stringify({
        app_url: args.targetUrl,
        websiteId: args.websiteId || undefined,
        websiteName: args.websiteName || undefined,
        prompt: args.prompt,
        conversationId,
        activityRequestId: requestedActivityId,
        approvedUnderstanding: args.approvedUnderstanding || '',
        understandingSource: args.understandingSource || '',
        priorGrounding: args.priorGrounding || args.approvedUnderstanding || '',
        testCaseCount: parseCaseCount(args.caseCountPrompt || args.prompt),
        flowMode: 'review_cases',
        model: selectedModel,
        effort: selectedEffort,
        // Explicit target chosen in the app/navigation picker card — authoritative on the server,
        // so no downstream gate ever re-asks. The ref covers the pre-understanding picker whose
        // choice must survive the understanding → review-card → run-start chain.
        applicationId: args.applicationId || targetChoiceRef.current?.applicationId || undefined,
        applicationName: args.applicationName || targetChoiceRef.current?.applicationName || undefined,
        moduleId: args.moduleId || targetChoiceRef.current?.moduleId || undefined,
        moduleName: args.moduleName || targetChoiceRef.current?.moduleName || undefined,
        // The requirement's metadata objects, so the server can auto-resolve the admin section
        // (e.g. "app" → Apps) and skip the "which navigation?" question when the requirement
        // already identifies one concrete section.
        metadataRefs: args.metadataRefs && args.metadataRefs.length ? args.metadataRefs : undefined,
        // Carry the conversation so case generation is grounded in what was actually
        // discussed — not just the (sometimes generic) prompt.
        history: buildHistory(),
        apps: getSelectedApps(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    const activityRequestId = String(data?.activity_request_id || '');
    if (data?.app_options?.apps?.length) {
      // Ambiguous target: pause and let the user pick the app/navigation from a dropdown
      // instead of a plain-text question; Continue resubmits this same run with the choice.
      const { thinkingId: _omit, ...runArgs } = args;
      // commitTurn (not replaceTurn): these are terminal results of the multi-minute start pipeline,
      // which may resolve after the user has navigated away. Persist them durably so the run/choice
      // isn't lost on an unmounted console.
      commitTurn(args.thinkingId, {
        id: args.thinkingId,
        role: 'assistant',
        kind: 'appask',
        text: String(data.chat_response || 'Which app should I test?'),
        surface: String(data.app_options.surface || ''),
        platform: data.app_options.platform === 'ADMIN' ? 'ADMIN' : 'RUNTIME',
        allowAllApps: Boolean(data.app_options.allowAllApps),
        apps: data.app_options.apps,
        runArgs,
      });
    } else if (data?.task_id) {
      commitTurn(args.thinkingId, { id: args.thinkingId, role: 'assistant', kind: 'deeprun', taskId: data.task_id, activityRequestId });
    } else if (data?.chat_response) {
      commitTurn(args.thinkingId, { id: args.thinkingId, role: 'assistant', kind: 'text', text: data.chat_response, activityRequestId: activityRequestId || undefined });
    } else {
      commitTurn(args.thinkingId, {
        id: args.thinkingId,
        role: 'assistant',
        kind: 'text',
        text: data?.error || 'I could not start the generation — the agent returned no run and no answer.',
      });
    }
  }, [commitTurn, buildHistory, updateThinkingLabel, selectedModel, selectedEffort, conversationId]);

  const requestDeepUnderstanding = useCallback(async (args: {
    thinkingId?: string;
    prompt: string;
    originalRequest?: string;
    contextPrompt?: string;
    targetUrl: string;
    targetName?: string;
    websiteId?: string;
    currentUnderstanding?: string;
    correction?: string;
  }) => {
    // Deep understanding runs for MINUTES server-side (repo research + model calls). A single
    // long HTTP request dies at any reverse proxy's read timeout (prod 504'd at 60s and every
    // understanding silently degraded to the terse fallback card). So the server now returns a
    // job id immediately and we poll — each poll is a fast request no proxy can kill.
    const signal = activeAbortRef.current?.signal;
    const res = await fetch('/api/agent/understand-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        ...args,
        history: buildHistory(),
        conversationId,
        projectId: selectedProjectId || undefined,
        appId: selectedAppId || undefined,
        // The topbar pick must drive this turn too, not just the chat one.
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      }),
    });
    const started = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(started?.error || 'Failed to understand request');
    const activityRequestId = String(started?.activity_request_id || '');
    if (activityRequestId && args.thinkingId) {
      const requestId = activityRequestId;
      activeActivityRef.current = { conversationId, requestId, thinkingId: args.thinkingId };
      setTurns((prev) => prev.map((turn) => (
        turn.id === args.thinkingId && turn.role === 'assistant' && turn.kind === 'thinking'
          ? { ...turn, activityRequestId: requestId }
          : turn
      )));
    }
    if (!started?.job_id) return { ...started, activityRequestId }; // older backend replied synchronously — use it as-is
    return await new Promise((resolve, reject) => {
      const es = new EventSource(withEventSourceAuth(`/api/agent/understand-request/${started.job_id}/events`));
      let settled = false;
      const timeout = window.setTimeout(() => { es.close(); reject(new Error('Understanding timed out')); }, 20 * 60 * 1000);
      const cleanup = () => { window.clearTimeout(timeout); es.close(); };
      signal?.addEventListener('abort', () => { settled = true; cleanup(); reject(new Error('aborted')); }, { once: true });
      es.addEventListener('done', (ev) => {
        settled = true;
        cleanup();
        const data = JSON.parse((ev as MessageEvent).data || '{}');
        resolve({ ...(data.result || {}), activityRequestId });
      });
      es.onerror = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Understanding stream disconnected before completion'));
      };
    });
  }, [buildHistory, conversationId, selectedProjectId, selectedAppId]);

  // Present the "Here's what I understood" review card for a deep generation/run request:
  // generate an understanding (grounded in the conversation), stash it as pendingDeep, and
  // render the review card so the user can edit, correct, or proceed.
  // This is the SAME review-first flow the console has always used for deep runs — it is
  // reused by the unified router's generate_cases / deep_test_run decisions.
  const presentDeepUnderstanding = useCallback(async (args: {
    thinkingId: string;
    prompt: string;
    originalRequest?: string;
    contextPrompt?: string;
    targetUrl: string;
    websiteId?: string;
    websiteName?: string;
  }) => {
    const { thinkingId, prompt, originalRequest, targetUrl, websiteId, websiteName } = args;
    updateThinkingLabel(thinkingId, 'Building reviewed test scope...');
    const contextPrompt = (args.contextPrompt || buildDeepContextPrompt(originalRequest || prompt, prompt)).trim();
    const target = websiteName ? `${websiteName} (${targetUrl})` : targetUrl;
    const fallbackUnderstanding =
      `Here's what I understood:\n` +
      `• Target: ${target}\n` +
      `• Task: ${prompt}\n\n` +
      `Plan: log in to the target → perform the steps on the live app → verify the result → capture screenshots as evidence.`;
    let understanding = fallbackUnderstanding;
    let understandingSource = 'fallback';
    let activityRequestId = activeActivityRef.current?.thinkingId === thinkingId
      ? activeActivityRef.current.requestId
      : undefined;
    // Explicit case-generation requests already enter the evidence-grounded workflow after review.
    // Do not make the user wait for a second, pre-run research pass that duplicates that work.
    if (!/\b(?:generate|create|write|draft|author)\b[\s\S]{0,80}\btest\s*cases?\b/i.test(originalRequest || prompt)) {
      try {
        const generated = await requestDeepUnderstanding({ thinkingId, prompt, originalRequest: originalRequest || prompt, contextPrompt, targetUrl, targetName: websiteName || '', websiteId });
        understanding = generated.understanding || fallbackUnderstanding;
        understandingSource = generated.source || understandingSource;
        activityRequestId = generated.activityRequestId || activityRequestId;
      } catch (error: any) {
        if (/aborted/i.test(String(error?.message || error || ''))) return;
        /* use deterministic fallback */
      }
    }
    const caseCountPrompt = originalRequest || prompt;
    const nextPending: PendingDeep = { prompt, originalRequest: originalRequest || prompt, contextPrompt, caseCountPrompt, targetUrl, websiteId, websiteName, understanding, understandingSource, revisionCount: 0 };
    setPendingDeep(nextPending);
    // Remember this chat's target so later generation requests reuse it.
    convTargetRef.current = { targetUrl, websiteId, websiteName };
    replaceTurn(thinkingId, {
      id: thinkingId,
      role: 'assistant',
      kind: 'folderask',
      understanding,
      understandingSource,
      originalPrompt: contextPrompt || prompt,
      contextPrompt,
      caseCountPrompt,
      targetUrl,
      websiteId,
      websiteName,
      ...targetChoiceFields(),
      revisionCount: 0,
      activityRequestId,
      text: 'Look right? Review the summary above, then Proceed — or tell me what to change.',
    });
  }, [buildDeepContextPrompt, requestDeepUnderstanding, replaceTurn, updateThinkingLabel]);

  // App/navigation picked in the AppAskCard. Two phases:
  // - 'pre-understanding' (the default flow): the target was resolved FIRST, before any research —
  //   continue into the reviewed-understanding step with the choice woven into the request.
  // - run-start (safety net): /api/agent/start still detected ambiguity — resubmit the same run
  //   with the explicit target (RUNTIME: applicationId/Name; ADMIN: moduleId/Name).
  const proceedAppAsk = useCallback(async (turn: AppAskTurn, choice: { appId: string; appName: string; tab?: string }) => {
    const base = turn.runArgs as any;
    // A no-target ask offers platforms from Settings. Carry the picked URL back as app_url; it is
    // not an application choice — the server discovers the real apps inside that platform next.
    const pickedUrl = turn.apps.find((a) => a.id === choice.appId)?.baseUrl || '';
    if (pickedUrl) base.app_url = pickedUrl;
    const focus = turn.platform === 'ADMIN'
      ? ` — test the ${choice.appName} list view`
      : choice.appId === '__all_apps__'
        ? ' — across all apps'
        : ` — target the ${choice.appName} app${choice.tab ? `, focus on the ${choice.tab} tab` : ''}`;
    // Remember the choice for the WHOLE request chain (understanding → review card → run start).
    if (!pickedUrl && choice.appId && choice.appId !== '__all_apps__') {
      targetChoiceRef.current = turn.platform === 'ADMIN'
        ? { moduleId: choice.appId, moduleName: choice.appName }
        : { applicationId: choice.appId, applicationName: choice.appName };
    }
    if (base?.phase === 'pre-understanding') {
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'thinking', label: `Building reviewed test scope for ${choice.appName}${choice.tab ? ` · ${choice.tab}` : ''}...` });
      try {
        await presentDeepUnderstanding({
          thinkingId: turn.id,
          prompt: `${base.prompt}${focus}`,
          originalRequest: `${base.originalRequest || base.prompt}${focus}`,
          contextPrompt: base.contextPrompt
            ? `${base.contextPrompt}\n\nUser-selected target: ${choice.appName}${choice.tab ? ` › ${choice.tab} tab` : ''}`
            : undefined,
          targetUrl: base.targetUrl || pickedUrl || '',
          websiteId: base.websiteId,
          websiteName: base.websiteName,
        });
      } catch (err: any) {
        replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: `I could not build the test scope: ${err?.message || 'unknown error'}.`, isError: true });
      }
      return;
    }
    replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'thinking', label: `Starting the run for ${choice.appName}${choice.tab ? ` · ${choice.tab}` : ''}...` });
    const prompt = choice.tab ? `${base.prompt} — focus on the ${choice.tab} tab` : base.prompt;
    try {
      if (pickedUrl) {
        await startDeepRun({ ...base, thinkingId: turn.id, prompt });
      } else if (turn.platform === 'ADMIN') {
        await startDeepRun({ ...base, thinkingId: turn.id, prompt, moduleId: choice.appId, moduleName: choice.appName });
      } else {
        await startDeepRun({ ...base, thinkingId: turn.id, prompt, applicationId: choice.appId, applicationName: choice.appName });
      }
    } catch (err: any) {
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: `I could not start the run: ${err?.message || 'unknown error'}.`, isError: true });
    }
  }, [replaceTurn, startDeepRun, presentDeepUnderstanding]);

  const runRequirementDraft = useCallback(async (thinkingId: string, query: string, previousDraft?: PendingRequirementDraft, instruction?: string, attachments?: AIImageAttachment[]) => {
    const featureQuery = (query || '').trim();
    if (!featureQuery) {
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: 'Which feature or section should I create the requirement for?',
      });
      return;
    }
    const draftQuery = previousDraft && instruction
      ? [
        `Original requirement request: ${previousDraft.query}`,
        `Current draft: ${JSON.stringify(previousDraft.result?.requirement || {})}`,
        `User requested changes: ${instruction}`,
      ].join('\n\n')
      : featureQuery;
    updateThinkingLabel(thinkingId, previousDraft ? 'Applying your requirement changes...' : 'Preparing requirement scope...');
    try {
      const res = await fetch('/api/requirements/draft/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: activeAbortRef.current?.signal,
        body: JSON.stringify({
          query: draftQuery,
          workspaceId: 'default',
          conversationId,
          history: buildHistory(),
          projectId: selectedProjectId || undefined,
          appId: selectedAppId || undefined,
          attachments: attachments?.length ? attachments : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        replaceTurn(thinkingId, {
          id: thinkingId,
          role: 'assistant',
          kind: 'text',
          text: data?.error || 'I could not draft that requirement. Make sure the configured target repo is available.',
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: any = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const raw = line.startsWith('data: ') ? line.slice(6) : line;
          let event: any;
          try { event = JSON.parse(raw); } catch { continue; }
          if (event.type === 'step' && event.text) {
            updateThinkingLabel(thinkingId, String(event.text));
          } else if (event.type === 'final') {
            finalResult = event.result;
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Failed to draft requirement.');
          }
        }
      }

      if (finalResult) {
        const data = finalResult;
        const revisionCount = previousDraft ? previousDraft.revisionCount + 1 : 0;
        const nextDraft = { turnId: thinkingId, query: previousDraft?.query || featureQuery, result: data, revisionCount };
        setPendingDeep(null);
        setPendingRequirementDraft(nextDraft);
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'reqdraft', result: data, query: nextDraft.query, revisionCount });
      } else {
        throw new Error('Requirement draft stream ended without a final result.');
      }
    } catch (err: any) {
      const rawMsg = err?.message || 'unknown error';
      const safeMsg = rawMsg.split(/\r?\n/)[0].slice(0, 200);
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: err?.name === 'AbortError'
          ? 'Stopped.'
          : `Something went wrong drafting the requirement: ${safeMsg}.`,
      });
    }
  }, [replaceTurn, buildHistory, conversationId, selectedProjectId, selectedAppId, updateThinkingLabel]);

  const confirmRequirementDraft = useCallback(async (turn: { id: string; result: any }) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/requirements/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: turn.result,
          workspaceId: 'default',
          projectId: selectedProjectId || undefined,
          appId: selectedAppId || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to create requirement.');
      setPendingRequirementDraft(null);
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'reqdiscovery', result: data });
    } catch (err: any) {
      replaceTurn(turn.id, {
        id: turn.id,
        role: 'assistant',
        kind: 'text',
        text: `I could not create the requirement: ${err?.message || 'unknown error'}.`,
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, replaceTurn, selectedProjectId, selectedAppId]);

  const discardRequirementDraft = useCallback((turnId: string) => {
    setPendingRequirementDraft((prev) => (prev?.turnId === turnId ? null : prev));
    replaceTurn(turnId, {
      id: turnId,
      role: 'assistant',
      kind: 'text',
      text: 'Requirement draft discarded.',
    });
    inputRef.current?.focus();
  }, [replaceTurn]);

  // Explicit "Rework with AI" from the draft card: re-run the drafting agent seeded with the current
  // draft + the user's instruction so it realigns/expands in place (same path a chat follow-up uses).
  const reworkRequirementDraft = useCallback(async (turn: { id: string; result: any; query?: string; revisionCount?: number }, instruction: string, attachments: AIImageAttachment[] = []) => {
    if (busy || !instruction.trim()) return;
    const previousDraft: PendingRequirementDraft = {
      turnId: turn.id,
      query: turn.query || pendingRequirementDraft?.query || '',
      result: turn.result,
      revisionCount: turn.revisionCount || 0,
    };
    setBusy(true);
    // Show a LIVE progress indicator during the rework. Without this the reqdraft turn stays static and the
    // user only sees the stop button — runRequirementDraft's updateThinkingLabel is a no-op on a non-'thinking'
    // turn, so the reqdraft id must first become a thinking turn (runRequirementDraft swaps it back to the result).
    replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'thinking', label: 'Applying your requirement changes...' });
    try {
      await runRequirementDraft(turn.id, previousDraft.query, previousDraft, instruction.trim(), attachments);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, runRequirementDraft, pendingRequirementDraft, replaceTurn]);

  // The apps the user explicitly selected in the composer (all of them), as target
  // context for the agent. Mirrored to a ref so callbacks read the latest without churn.
  const selectedApps = websites.filter((w) => selectedAppIds.has(w.id)).map((w) => ({ id: w.id, name: w.name, baseUrl: w.baseUrl }));
  const allAppsSelected = websites.length > 0 && selectedAppIds.size === websites.length;
  const selectedAppsRef = useRef<Array<{ id?: string; name: string; baseUrl: string }>>([]);
  useEffect(() => { selectedAppsRef.current = selectedApps; });
  const projectAppsRef = useRef<ProjectApp[]>([]);
  useEffect(() => { projectAppsRef.current = scopeProject?.apps || []; });
  // The top-bar scope app, mirrored to a ref so callbacks read the latest.
  const scopeAppRef = useRef<{ id?: string; name: string; baseUrl: string } | null>(null);
  useEffect(() => { scopeAppRef.current = scopeApp ? { id: scopeApp.id, name: scopeApp.name, baseUrl: scopeApp.baseUrl } : null; });
  // The single "selected apps" payload sent on EVERY chat fetch: merges the top-bar scope app and the
  // composer multi-select. Deduped by name+baseUrl (not baseUrl alone) so distinct apps that share a
  // base URL — common in core-platform where tenant/admin apps sit under one host — aren't collapsed.
  const getSelectedApps = useCallback((): Array<{ id?: string; name: string; baseUrl: string }> => {
    const out: Array<{ id?: string; name: string; baseUrl: string }> = [];
    const seen = new Set<string>();
    const add = (a?: { id?: string; name: string; baseUrl: string } | null) => {
      if (!a || !a.baseUrl) return;
      const key = `${(a.name || '').trim().toLowerCase()}|${a.baseUrl.trim().toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: a.id, name: a.name, baseUrl: a.baseUrl });
    };
    add(scopeAppRef.current);
    for (const a of selectedAppsRef.current) add(a);
    if (!out.length) {
      for (const app of projectAppsRef.current) {
        if (app.baseUrl) add({ id: app.id, name: app.name, baseUrl: app.baseUrl });
      }
    }
    return out;
  }, []);
  const authorScriptFromSteps = useCallback(async (thinkingId: string, text: string) => {
    const namedSite = findWebsiteInText(text, websites);
    const namedTarget = findTargetInText(text, [...websites, ...projectAppsRef.current]);
    const selectedTarget = getSelectedApps()[0];
    const targetUrl =
      firstUrlInText(text) ||
      selectedTarget?.baseUrl ||
      (scopeApp?.baseUrl || '').trim() ||
      namedTarget?.baseUrl ||
      namedSite?.baseUrl ||
      convTargetRef.current?.targetUrl ||
      '';
    const normUrl = (u: string) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
    const urlSite = targetUrl ? websites.find((w) => normUrl(w.baseUrl) === normUrl(targetUrl)) : undefined;
    // Attention layer: if the resolved target URL differs from the conversation's sticky target, the user
    // switched apps — do NOT fall back to the PRIOR site's identity/creds. Let it resolve from the new URL.
    const staleRef = Boolean(convTargetRef.current) && normUrl(convTargetRef.current!.targetUrl) !== normUrl(targetUrl);
    const websiteId = namedSite?.id || urlSite?.id || (staleRef ? undefined : convTargetRef.current?.websiteId);
    const websiteName = namedTarget?.name || namedSite?.name || urlSite?.name || (staleRef ? undefined : convTargetRef.current?.websiteName);
    if (!targetUrl) {
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: 'Which app should I author the script against? Select an app, mention a saved app name, or paste the URL.',
      });
      return;
    }
    convTargetRef.current = { targetUrl, websiteId, websiteName };
    updateThinkingLabel(thinkingId, 'Driving the live app and recording selectors...');
    const res = await fetch('/api/agent/author-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: activeAbortRef.current?.signal,
      body: JSON.stringify({
        goal: text,
        app_url: targetUrl,
        websiteId,
        projectId: selectedProjectId || undefined,
        appId: selectedAppId || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Failed to author script from live steps.');
    const tests = Array.isArray(data?.execution?.tests) ? data.execution.tests : [];
    const status = data?.execution
      ? `${data.execution.passed || 0} passed, ${data.execution.failed || 0} failed, ${data.execution.total || 0} total`
      : 'not executed';
    const notes = Array.isArray(data?.notes) && data.notes.length
      ? `\n\nNotes:\n${data.notes.slice(0, 8).map((n: string) => `- ${n}`).join('\n')}`
      : '';
    const failures = tests.filter((t: any) => String(t?.status || '').toLowerCase() !== 'passed' && t?.error)
      .slice(0, 3)
      .map((t: any) => `- ${t.title || 'test'}: ${String(t.error).split('\n')[0]}`)
      .join('\n');
    const screenshots = Array.isArray(data?.screenshotUrls) && data.screenshotUrls.length
      ? `\n\nScreenshots:\n${data.screenshotUrls.slice(0, 8).map((url: string, i: number) => `![Step ${i + 1}](${url})`).join('\n')}`
      : '';
    const attention = data?.attention?.understoodGoal
      ? `\n\nUnderstanding:\n${data.attention.understoodGoal}${Array.isArray(data.attention.workflow) && data.attention.workflow.length ? `\n${data.attention.workflow.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}` : ''}`
      : '';
    replaceTurn(thinkingId, {
      id: thinkingId,
      role: 'assistant',
      kind: 'text',
      authoredScript: data?.script || '',
      authoredTargetUrl: targetUrl,
      screenshotUrls: Array.isArray(data?.screenshotUrls) ? data.screenshotUrls : [],
      text: `Authored script from live browser actions for ${websiteName || targetUrl}.${attention}\n\nExecution: ${status}${data?.goalReached ? '\nGoal reached: yes' : '\nGoal reached: partial'}${failures ? `\n\nFailures:\n${failures}` : ''}${notes}${screenshots}\n\n\`\`\`ts\n${data?.script || ''}\n\`\`\``,
    });
  }, [replaceTurn, updateThinkingLabel, websites, scopeApp, getSelectedApps, selectedProjectId, selectedAppId]);

  const rerunAuthoredForScreenshots = useCallback(async (turn: Extract<Turn, { role: 'assistant'; kind: 'text' }>) => {
    const script = authoredScriptFromTurn(turn);
    if (!script || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/playwright/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scripts: [{ filename: 'authored-rerun.spec.ts', title: 'authored rerun', code: script }],
          baseUrl: turn.authoredTargetUrl || convTargetRef.current?.targetUrl || '',
          runId: `author-rerun-${Date.now()}`,
          singleSession: true,
          screenshotMode: 'on',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to rerun script.');
      const urls = Array.isArray(data?.screenshotUrls) ? data.screenshotUrls : [];
      const shots = urls.length
        ? `\n\nScreenshots:\n${urls.slice(0, 8).map((url: string, i: number) => `![Step ${i + 1}](${url})`).join('\n')}`
        : '\n\nNo screenshots were produced by the headless rerun.';
      replaceTurn(turn.id, { ...turn, screenshotUrls: urls, text: `${turn.text.replace(/\n\nNo screenshots were produced by the headless rerun\.$/, '')}${shots}` });
    } catch (err: any) {
      replaceTurn(turn.id, { ...turn, text: `${turn.text}\n\nHeadless screenshot run failed: ${err?.message || 'unknown error'}` });
    } finally {
      setBusy(false);
    }
  }, [busy, replaceTurn]);

  // Route a message to the SupervisorAgent (dynamic tool-loop: query_workspace,
  // search_codebase, create_* …) and STREAM its live steps into the thinking turn, so the
  // user sees what the agent is actually doing in real time instead of a static label.
  const runViaSupervisor = useCallback(async (text: string, thinkingId: string) => {
    const activityRequestId = globalThis.crypto.randomUUID();
    activeActivityRef.current = { conversationId, requestId: activityRequestId, thinkingId };
    setTurns((prev) => prev.map((turn) => (
      turn.id === thinkingId && turn.role === 'assistant' && turn.kind === 'thinking'
        ? { ...turn, activityRequestId }
        : turn
    )));
    const setThinkingLabel = (label: string) =>
      setTurns((prev) => prev.map((t) => (t.id === thinkingId && t.role === 'assistant' && t.kind === 'thinking' ? { ...t, label } : t)));
    const requestBody = {
      userMessage: text,
      workspaceId: 'default',
      conversationId,
      requestId: activityRequestId,
      projectId: selectedProjectId || undefined,
      appId: selectedAppId || undefined,
      model: selectedModel || undefined,
      effort: selectedEffort,
      history: buildHistory(),
      pageContext: { path: location.pathname },
      apps: getSelectedApps(),
    };
    appendThinkingDebug(thinkingId, 'Starting supervisor stream', requestBody);
    try {
      const res = await fetch('/api/controller/supervise/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: activeAbortRef.current?.signal,
        body: JSON.stringify(requestBody),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(data?.error || `Request failed (${res.status}).`) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalReply = '';
      let finalUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number; costUsd?: number } | null = null;
      let finalCache: { status?: string; ageMs?: number; savedTokens?: number; reason?: string } | null = null;
      let finalProviderCache: { readTokens?: number; writeTokens?: number; hitRate?: number } | null = null;
      let liveReply = '';
      let finalActions: Array<{ tool?: string; arguments?: Record<string, any>; result?: any }> = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const rawLine = line.startsWith('data: ') ? line.slice(6) : line;
          let ev: any;
          try { ev = JSON.parse(rawLine); } catch { continue; }
          if (ev.type === 'step') {
            appendThinkingDebug(thinkingId, 'Supervisor step', ev);
            setThinkingLabel(hasPrivateResearchToolCall(ev) ? describeAgentStep(ev) : (ev.text && ev.text.length < 80 ? ev.text : describeAgentStep(ev)));
          }
          else if (ev.type === 'answer_delta') {
            liveReply += ev.delta || '';
            setTurns((prev) => prev.map((turn) => (
              turn.id === thinkingId && turn.role === 'assistant' && turn.kind === 'thinking'
                ? { ...turn, partialText: cleanChat(liveReply) }
                : turn
            )));
          }
          else if (ev.type === 'heartbeat') {
            // Keeps production proxies from treating a long AI call as idle.
          }
          else if (ev.type === 'final') {
            appendThinkingDebug(thinkingId, 'Supervisor final', ev);
            finalReply = ev.reply || '';
            finalActions = Array.isArray(ev.actions) ? ev.actions : [];
            finalUsage = ev.usage || null;
            finalCache = ev.cache || null;
            finalProviderCache = ev.providerCache || null;
          }
          else if (ev.type === 'error') {
            appendThinkingDebug(thinkingId, 'Supervisor error', ev);
            finalReply = ev.error || 'The agent could not complete that.';
          }
        }
      }
      const requirement = [...finalActions].reverse().find((action) => action.tool === 'draft_requirement')?.result;
      const generatedCases = [...finalActions].reverse().find((action) => action.tool === 'create_cases')?.result?.cases;
      const liveTest = [...finalActions].reverse().find((action) =>
        action.tool === 'prepare_test_scope' && action.result?.startReviewedGeneration !== false,
      );
      const targetResult = selectTargetActionResult(finalActions);
      if (liveTest) {
        const scopePrompt = String(liveTest.result?.scope || liveTest.arguments?.scope || text);
        const targetUrl = String(liveTest.result?.targetUrl || liveTest.arguments?.targetUrl || getSelectedApps()[0]?.baseUrl || convTargetRef.current?.targetUrl || '');
        // Pick the target BEFORE any work: the repo dive, the scope, the cases and the run all hang off
        // this URL, so choosing it late means everything upstream was grounded on a guess.
        // A configured-but-dead target is as unusable as none: check before spending a scope build.
        const reachable = targetUrl
          ? await fetch(`/api/agent/target-check?url=${encodeURIComponent(targetUrl)}`).then((r) => r.json()).catch(() => ({ up: true, error: '' }))
          : { up: false, error: '' };
        if (!targetUrl || !reachable.up) {
          const targets = await fetch('/api/agent/targets')
            .then((r) => r.json())
            .then((d) => (d.targets || []).filter((t: any) => String(t.url) !== targetUrl))
            .catch(() => []);
          if (targets.length) {
            commitTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'appask',
              text: targetUrl
                ? `I could not reach ${targetUrl}${reachable.error ? ` (${reachable.error})` : ''}. Which target should I test instead? I will read its repository and work out what to cover from there.`
                : 'Which target should I test? I will read its repository and work out what to cover from there.',
              surface: 'Targets',
              platform: 'RUNTIME',
              allowAllApps: false,
              apps: targets.map((t: any) => ({ id: String(t.id), name: `${t.name} — ${t.url}`, tabs: [], baseUrl: String(t.url) })),
              runArgs: { phase: 'pre-understanding', prompt: scopePrompt, originalRequest: text },
            });
            return;
          }
          commitTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: 'I have no target configured to test against. Add an app or a website (with its base URL) in Settings → Credentials, then ask me again.' });
          return;
        }
        // answer_delta temporarily rendered the Supervisor's handoff text as a completed response.
        // Restore an active turn while the deeper understanding job runs so the console never looks stuck.
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'thinking', label: 'Building reviewed test scope...' });
        await presentDeepUnderstanding({
          thinkingId,
          prompt: scopePrompt,
          originalRequest: text,
          targetUrl,
        });
      } else if (requirement?.draft) {
        const nextDraft = { turnId: thinkingId, query: text, result: requirement, revisionCount: 0 };
        setPendingDeep(null);
        setPendingRequirementDraft(nextDraft);
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'reqdraft', result: requirement, query: text, revisionCount: 0 });
      } else if (Array.isArray(generatedCases) && generatedCases.length) {
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'cases', cases: generatedCases });
      } else {
        replaceTurn(thinkingId, {
          id: thinkingId,
          role: 'assistant',
          kind: 'text',
          text: cleanChat(finalReply || 'Done.'),
          activityRequestId,
          targetResult,
          execution: finalUsage ? {
            ...currentExecution(),
            promptTokens: finalUsage.inputTokens,
            completionTokens: finalUsage.outputTokens,
            cachedTokens: (finalUsage.cacheReadTokens || 0) + (finalUsage.cacheWriteTokens || 0),
            totalTokens: finalUsage.totalTokens,
            costUsd: finalUsage.costUsd,
            providerCacheReadTokens: finalProviderCache?.readTokens,
            providerCacheWriteTokens: finalProviderCache?.writeTokens,
            providerCacheHitRate: finalProviderCache?.hitRate,
            resultCacheStatus: finalCache?.status,
            resultCacheAgeMs: finalCache?.ageMs,
            resultCacheSavedTokens: finalCache?.savedTokens,
          } : currentExecution(),
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: 'Stopped.', activityRequestId });
        return;
      }
      const message = err instanceof Error ? err.message : String(err || 'network error');
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: `The streaming request was interrupted before the agent finished: ${message}.`,
      });
    }
  }, [appendThinkingDebug, buildHistory, conversationId, location.pathname, replaceTurn, getSelectedApps, presentDeepUnderstanding, selectedProjectId, selectedAppId, selectedModel, selectedEffort, currentExecution]);

  const send = useCallback(
    async (raw?: string, editTurnIdArg?: string | null) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      stopListening();
      // Inline edit passes the turn id explicitly; the bottom composer uses editingTurnId.
      const editedTurnId = editTurnIdArg !== undefined ? editTurnIdArg : (raw === undefined ? editingTurnId : null);
      if (editTurnIdArg === undefined) setInput('');
      setEditingTurnId(null);
      setBusy(true);

      // A fresh user message starts a fresh request chain — any earlier picker choice no longer applies.
      targetChoiceRef.current = null;

      const thinkingId = nextId();
      const requestController = new AbortController();
      activeAbortRef.current?.abort();
      activeAbortRef.current = requestController;
      activeThinkingIdRef.current = thinkingId;
      const clearActiveRequest = () => {
        if (activeAbortRef.current === requestController) activeAbortRef.current = null;
        if (activeThinkingIdRef.current === thinkingId) activeThinkingIdRef.current = null;
        if (activeActivityRef.current?.thinkingId === thinkingId) activeActivityRef.current = null;
      };
      setTurns((prev) => {
        const nextTurns: Turn[] = editedTurnId
          ? prev.map((t) => (t.id === editedTurnId && t.role === 'user' ? { ...t, text } : t))
          : [...prev, { id: nextId(), role: 'user', text }];
        const thinkingTurn: Turn = {
          id: thinkingId,
          role: 'assistant',
          kind: 'thinking',
          label: initialThinkingLabel(text, {
            selectedApps: getSelectedApps().length,
            requirementDraftPending: Boolean(pendingRequirementDraft),
          }),
          debug: [
            `User prompt\n${text}`,
            [
              'Client context',
              `Current page: ${location.pathname}`,
              `Selected project: ${selectedProjectId || 'none'}`,
              `Selected app: ${selectedAppId || 'none'}`,
              `Apps in scope: ${getSelectedApps().map((app) => app.baseUrl ? `${app.name || 'app'} — ${app.baseUrl}` : app.name).filter(Boolean).join(', ') || 'none'}`,
              `Requirement mode: ${reqMode ? 'on' : 'off'}`,
              `Script author mode: ${scriptAuthorMode ? 'on' : 'off'}`,
            ].join('\n'),
          ],
        };
        return [...nextTurns, thinkingTurn];
      });

      // A pending requirement draft only swallows the NEXT message as a rework while Requirement mode
      // is ON. With the mode OFF, only an explicit approve/discard acts on the draft; any other message
      // (e.g. "generate test cases") falls through to normal routing instead of being turned into another
      // requirement. (Reworking a draft with the mode off is still available via the card's own buttons.)
      // A new request that is neither approve nor cancel retires the pending draft, mirroring pendingDeep.
      // Without this it kept intercepting later messages for the rest of the conversation.
      if (pendingRequirementDraft && !reqMode && !isRequirementDraftApprove(text) && !isRequirementDraftCancel(text)) {
        setPendingRequirementDraft(null);
      }
      if (pendingRequirementDraft && (reqMode || isRequirementDraftApprove(text) || isRequirementDraftCancel(text))) {
        try {
          if (isRequirementDraftCancel(text)) {
            updateThinkingLabel(thinkingId, 'Discarding requirement draft...');
            setPendingRequirementDraft(null);
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: 'Requirement draft discarded.' });
          } else if (isRequirementDraftApprove(text)) {
            updateThinkingLabel(thinkingId, 'Saving approved requirement...');
            const res = await fetch('/api/requirements/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: activeAbortRef.current?.signal,
              body: JSON.stringify({
                draft: pendingRequirementDraft.result,
                workspaceId: 'default',
                projectId: selectedProjectId || undefined,
                appId: selectedAppId || undefined,
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to create requirement.');
            setPendingRequirementDraft(null);
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'reqdiscovery', result: data });
          } else {
            updateThinkingLabel(thinkingId, 'Reworking requirement draft...');
            await runRequirementDraft(thinkingId, pendingRequirementDraft.query, pendingRequirementDraft, text);
          }
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: err?.name === 'AbortError' ? 'Stopped.' : `I could not update the requirement draft: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // A pending "Here's what I understood" card only consumes a SHORT affirmative reply
      // ("proceed"/"yes"). ANY other message means the user moved on or is asking something
      // new — abandon the card and route this message fresh, so a follow-up question
      // ("what else should I test?") gets a chat answer instead of being swallowed as a
      // correction. (Corrections are still possible by editing the card's box.)
      const proceedingDeep = !!pendingDeep && isProceedResponse(text);
      if (pendingDeep && !proceedingDeep) setPendingDeep(null);
      const activePending = proceedingDeep ? pendingDeep : null;

      // ── Preserved pre-checks (run BEFORE the unified router) ───────────────────────
      // These two flows are explicit, stateful, or have no equivalent backend route-kind,
      // so they are kept exactly as before and short-circuit the controller stream.

      // 1) Pending "Here's what I understood" review card: an affirmative reply ("proceed"/"yes")
      //    FINALIZES the deep run; any other reply REVISES the understanding. (Non-affirmative
      //    replies that abandon the card already cleared pendingDeep above and fall through to
      //    the unified router.)
      if (activePending) {
        if (!isProceedResponse(text)) {
          try {
            updateThinkingLabel(thinkingId, 'Revising reviewed test scope...');
            const revised = await requestDeepUnderstanding({
              thinkingId,
              prompt: activePending.prompt,
              originalRequest: activePending.originalRequest || activePending.prompt,
              contextPrompt: activePending.contextPrompt || activePending.prompt,
              targetUrl: activePending.targetUrl,
              targetName: activePending.websiteName,
              currentUnderstanding: activePending.understanding,
              correction: text,
            });
            const nextPending: PendingDeep = {
              ...activePending,
              understanding: revised.understanding || activePending.understanding,
              understandingSource: revised.source || activePending.understandingSource,
              targetUrl: revised.targetUrl || activePending.targetUrl,
              websiteName: revised.targetName || activePending.websiteName,
              revisionCount: activePending.revisionCount + 1,
            };
            setPendingDeep(nextPending);
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'folderask',
              understanding: nextPending.understanding,
              understandingSource: nextPending.understandingSource,
              originalPrompt: nextPending.contextPrompt || nextPending.prompt,
              contextPrompt: nextPending.contextPrompt,
              caseCountPrompt: nextPending.caseCountPrompt || nextPending.originalRequest || nextPending.prompt,
              targetUrl: nextPending.targetUrl,
              websiteId: nextPending.websiteId,
              websiteName: nextPending.websiteName,
              ...targetChoiceFields(),
              revisionCount: nextPending.revisionCount,
              activityRequestId: revised.activityRequestId,
              text: 'I updated what I understood. Review it and Proceed, or correct me again.',
            });
          } catch (err: any) {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: `I could not revise the understanding: ${err?.message || 'unknown error'}.`,
            });
          } finally {
            clearActiveRequest();
            setBusy(false);
            inputRef.current?.focus();
          }
          return;
        }
        // Affirmative reply → start the deep run with the reviewed understanding, else the scope this
        // exchange just produced. Never an earlier task's answer — see scopeFromCurrentExchange.
        const approvedUnderstanding = activePending.understanding || scopeFromCurrentExchange();
        setPendingDeep(null);
        try {
          updateThinkingLabel(thinkingId, 'Starting reviewed test run...');
          await startDeepRun({
            thinkingId,
            prompt: activePending.originalRequest || activePending.prompt,
            targetUrl: activePending.targetUrl,
            websiteId: activePending.websiteId,
            websiteName: activePending.websiteName,
            approvedUnderstanding,
            understandingSource: activePending.understandingSource,
            priorGrounding: approvedUnderstanding,
            caseCountPrompt: activePending.caseCountPrompt || activePending.originalRequest || activePending.prompt,
          });
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: `Something went wrong starting the agent: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // Explicit composer modes are user-selected controls, not inferred intent.
      if (scriptAuthorMode) {
        try {
          updateThinkingLabel(thinkingId, 'Authoring script in a live browser...');
          await authorScriptFromSteps(thinkingId, text);
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: err?.name === 'AbortError' ? 'Stopped.' : `I could not author that script: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      if (reqMode) {
        try {
          updateThinkingLabel(thinkingId, 'Starting requirement drafting agent...');
          await runRequirementDraft(thinkingId, text);
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      const directTargets = getSelectedApps();
      const directCaseRequest = /\b(?:generate|create|write|draft|author)\b[\s\S]{0,80}\btest\s*cases?\b/i.test(text);
      if (directCaseRequest && directTargets.length === 1) {
        try {
          await presentDeepUnderstanding({
            thinkingId,
            prompt: text,
            originalRequest: text,
            targetUrl: directTargets[0].baseUrl,
            websiteName: directTargets[0].name,
          });
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // The backend chooses the cheapest safe path: deterministic helpers, one authenticated
      // Codex SDK turn, or the grounded Supervisor tool loop for actions/product evidence.
      try {
        updateThinkingLabel(thinkingId, 'Working on your request...');
        await runViaSupervisor(text, thinkingId);
      } finally {
        clearActiveRequest();
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [input, busy, editingTurnId, conversationId, location.pathname, stopListening, replaceTurn, updateThinkingLabel, appendThinkingDebug, requestDeepUnderstanding, presentDeepUnderstanding, runRequirementDraft, reqMode, scriptAuthorMode, pendingDeep, pendingRequirementDraft, websites, scopeApp, buildHistory, buildDeepContextPrompt, startDeepRun, runViaSupervisor, getSelectedApps, authorScriptFromSteps, selectedProjectId, selectedAppId],
  );

  // Start the deep run directly from a "Here's what I understood" card's OWN stored data
  // (understanding + target), independent of the volatile pendingDeep state. This keeps
  // the Proceed buttons working even if the user typed other messages after the card
  // appeared (which clears pendingDeep), so they never misfire into the planner.
  const proceedDeepFromTurn = useCallback(
    async (turn: { id: string; understanding?: string; understandingSource?: string; originalPrompt?: string; contextPrompt?: string; caseCountPrompt?: string; targetUrl?: string; websiteId?: string; websiteName?: string; metadataRefs?: string[]; applicationId?: string; applicationName?: string; moduleId?: string; moduleName?: string }) => {
      if (busy) return;
      setBusy(true);
      setPendingDeep(null);
      if (turn.targetUrl || turn.websiteId) convTargetRef.current = { targetUrl: turn.targetUrl || '', websiteId: turn.websiteId, websiteName: turn.websiteName };
      // Keep the confirmed understanding visible in the chat as a record, and add the run
      // card BELOW it — so clicking Proceed never makes the dialog vanish with nothing shown.
      const runTurnId = nextId();
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: turn.understanding || 'Proceeding with the run…' });
      setTurns((prev) => [...prev, {
        id: runTurnId,
        role: 'assistant',
        kind: 'thinking',
        label: 'Starting the run...',
        debug: [
          `Proceed request\n${turn.contextPrompt || turn.originalPrompt || turn.understanding || ''}`,
          [
            'Run target',
            `Target URL: ${turn.targetUrl || 'none'}`,
            `Website: ${turn.websiteName || turn.websiteId || 'none'}`,
          ].join('\n'),
        ],
      }]);
      try {
        await startDeepRun({
          thinkingId: runTurnId,
          prompt: turn.contextPrompt || turn.originalPrompt || '',
          targetUrl: turn.targetUrl || '',
          websiteId: turn.websiteId || undefined,
          websiteName: turn.websiteName || undefined,
          approvedUnderstanding: turn.understanding || scopeFromCurrentExchange(),
          understandingSource: turn.understandingSource || '',
          priorGrounding: turn.understanding || scopeFromCurrentExchange(),
          caseCountPrompt: turn.caseCountPrompt || turn.originalPrompt || '',
          metadataRefs: turn.metadataRefs,
          // The scope already chosen for this chain — sent so no gate re-asks for it at run start.
          applicationId: turn.applicationId,
          applicationName: turn.applicationName,
          moduleId: turn.moduleId,
          moduleName: turn.moduleName,
        });
      } catch (err: any) {
        replaceTurn(runTurnId, { id: runTurnId, role: 'assistant', kind: 'text', text: `Something went wrong starting the run: ${err?.message || 'unknown error'}.` });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, replaceTurn, startDeepRun],
  );

  // Commit review-card understanding edits back into the turn (and pendingDeep) — on blur/proceed, never per keystroke.
  const commitFolderAskDraft = useCallback((turnId: string, patch: { understanding?: string }) => {
    setTurns((prev) => prev.map((item) => (
      item.id === turnId && item.role === 'assistant' && item.kind === 'folderask' ? { ...item, ...patch } : item
    )));
    if (typeof patch.understanding === 'string') {
      const nextUnderstanding = patch.understanding;
      setPendingDeep((prev) => (prev ? { ...prev, understanding: nextUnderstanding } : prev));
    }
  }, []);

  // Cancel a folder-ask card: clear the pending run and swap the card for a plain notice.
  const cancelFolderAsk = useCallback((turnId: string) => {
    setPendingDeep(null);
    // Retire the durable understanding job too, or returning to this chat re-attaches it and the
    // dismissed review card comes back.
    void fetch(`/api/agent/understand-request/for-conversation/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }).catch(() => {});
    replaceTurn(turnId, {
      id: turnId,
      role: 'assistant',
      kind: 'text',
      text: 'Cancelled. Tell me what to change (target, fields, or steps) and I will re-plan.',
    });
    inputRef.current?.focus();
  }, [replaceTurn, conversationId]);

  const executePlan = useCallback(
    async (planId: string, turnId: string, opts?: { approveAll?: boolean }) => {
      // Optimistically reflect "running" while the server executes.
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.role === 'assistant' && t.kind === 'plan'
            ? { ...t, plan: { ...t.plan, status: 'running' } }
            : t,
        ),
      );
      try {
        const res = await fetch(`/api/controller/plans/${planId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts || {}),
        });
        const updated = await res.json();
        patchTurn(turnId, updated);
        if (updated?.status === 'completed') {
          // Surface any generated test cases inline (with their steps), so the human
          // reviews/edits them right in the chat — no AI Inbox hand-off.
          const generatedCases = (updated.steps || [])
            .filter((s: any) => s.status === 'completed' && Array.isArray(s.result?.cases))
            .flatMap((s: any) => s.result.cases);
          setTurns((prev) => [
            ...prev,
            ...(generatedCases.length
              ? [{ id: nextId(), role: 'assistant' as const, kind: 'cases' as const, cases: generatedCases }]
              : []),
            { id: nextId(), role: 'assistant', kind: 'text', text: summarizeResults(updated) },
          ]);
        }
      } catch (err: any) {
        setTurns((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', kind: 'text', text: `Execution failed: ${err?.message || 'unknown error'}.` },
        ]);
      }
    },
    [patchTurn],
  );

  const cancelPlan = useCallback(
    async (planId: string, turnId: string) => {
      try {
        const res = await fetch(`/api/controller/plans/${planId}/cancel`, { method: 'POST' });
        const updated = await res.json();
        patchTurn(turnId, updated);
      } catch {
        /* ignore */
      }
    },
    [patchTurn],
  );

  // INLINE edit: turn the user's message bubble into an editable box in place (instead of
  // pushing the text down into the composer).
  const editUserPrompt = useCallback((turnId: string, text: string) => {
    setEditingTurnId(turnId);
    setEditDraft(text);
  }, []);

  const cancelInlineEdit = useCallback(() => {
    setEditingTurnId(null);
    setEditDraft('');
  }, []);

  const saveInlineEdit = useCallback((turnId: string) => {
    const text = editDraft.trim();
    if (!text || busy) return;
    setEditingTurnId(null);
    setEditDraft('');
    void send(text, turnId);
  }, [editDraft, busy, send]);

  const copyUserPrompt = useCallback(async (turnId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTurnId(turnId);
      showToast('Copied to clipboard');
      window.setTimeout(() => setCopiedTurnId((current) => (current === turnId ? null : current)), 1500);
    } catch {
      /* ignore */
    }
  }, []);

  /** Re-run the user prompt that produced a (failed) assistant response. Finds the nearest preceding
   *  user turn and re-sends it — used by the Retry button that appears on agent errors. */
  const retryTurn = useCallback((assistantTurnId: string) => {
    if (busy) return;
    const list = turnsRef.current;
    const idx = list.findIndex((t) => t.id === assistantTurnId);
    if (idx < 0) return;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = list[i];
      if (t.role === 'user' && t.text.trim()) {
        void send(t.text);
        return;
      }
    }
    showToast('Nothing to retry');
  }, [busy, send]);

  const confirmClarify = useCallback((turnId: string, plan: any) => {
    setTurns((prev) => prev.map((t) => (t.id === turnId ? { id: turnId, role: 'assistant', kind: 'plan', plan } : t)));
  }, []);

  const rejectClarify = useCallback((turnId: string) => {
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId
          ? {
              id: turnId,
              role: 'assistant',
              kind: 'text',
              text: 'No problem. Tell me what you would like to do, and include any details (which app, suite, flow, or URL) so I get it right.',
            }
          : t,
      ),
    );
    inputRef.current?.focus();
  }, []);

  const isEmpty = turns.length === 0;

  // The runtime endpoint reports the Codex runtime even when it is switched off. The topbar
  // renders the model/effort selectors only when it is callable,
  // or a compact Settings prompt when none is available.
  const providerPortal = providers.length > 0
    ? document.getElementById('topbar-actions')
    : null;

  // Keep the send() bridge current so reconcileGoal can re-drive a message after navigation.
  sendRef.current = send;

  return (
    <><div className="flex h-full min-h-0 w-full flex-col">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
            <MessagesSquare className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-base font-semibold leading-tight text-[var(--text-primary)]">Agent Console</h1>
              {scopeProject && (
                <span
                  title="This chat is scoped to the selected project / app"
                  className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]"
                >
                  <Layers className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                  <span className="truncate">
                    {scopeProject.name}
                    <span className="text-[var(--text-muted)]/70"> / {scopeApp ? scopeApp.name : 'All Apps'}</span>
                  </span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-[var(--text-muted)]">Tell the AI what to do. It plans, you approve, it runs.</p>
              <span className="font-mono text-[10px] text-[var(--text-muted)] border border-[var(--border)] bg-[var(--bg-secondary)] rounded px-1.5 py-0.5 tracking-wide select-all" title="Chat ID">
                #{conversationId}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative" ref={historyRef}>
            <button
              onClick={() => { setHistoryOpen((o) => !o); if (!historyOpen) loadConversations(); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
            >
              <History className="h-3.5 w-3.5" /> History
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Conversations</span>
                  {conversations.length > 0 && (
                    <div className="flex items-center gap-2 text-[10px] font-medium">
                      <button
                        type="button"
                        onClick={() => setSelectedConversationIds(
                          selectedConversationIds.size === conversations.length
                            ? new Set()
                            : new Set(conversations.map((conversation) => conversation.id)),
                        )}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {selectedConversationIds.size === conversations.length ? 'Clear Selection' : 'Select All'}
                      </button>
                      {selectedConversationIds.size > 0 && (
                        <button
                          type="button"
                          onClick={() => void deleteSelectedConversations()}
                          className="text-red-400 hover:underline"
                        >
                          {selectedConversationIds.size === conversations.length ? 'Delete All' : `Delete (${selectedConversationIds.size})`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {conversations.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No saved conversations yet.</div>
                  )}
                  {[...conversations]
                    .sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0))
                    .map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        'group flex w-full items-start gap-2 border-b border-[var(--border)] px-3 py-2 last:border-b-0 hover:bg-[var(--bg-secondary)] cursor-pointer',
                        c.id === conversationId && 'bg-[var(--accent)]/5',
                      )}
                      onClick={() => switchConversation(c.id)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedConversationIds.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleConversationSelection(c.id)}
                        aria-label={`Select ${c.title || 'Untitled chat'}`}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                      />
                      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1">
                        {renamingId === c.id ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onBlur={() => void commitRename()}
                            maxLength={80}
                            placeholder="Conversation name"
                            className="w-full rounded border border-[var(--accent)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-primary)] outline-none"
                          />
                        ) : (
                          <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{c.title || 'Untitled Chat'}</span>
                        )}
                        <span className="block font-mono text-[10px] text-[var(--text-muted)]/60 truncate">{c.id}</span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {c.turnCount} message{c.turnCount === 1 ? '' : 's'} · {new Date(c.updatedAt).toLocaleString()}
                        </span>
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          title="Rename conversation"
                          onClick={(e) => { e.stopPropagation(); setRenamingId(c.id); setRenameDraft(String(c.title || '')); }}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title={favorites.has(c.id) ? 'Remove from favorites' : 'Add to favorites'}
                          onClick={(e) => toggleFavorite(c.id, e)}
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-secondary)]',
                            favorites.has(c.id) ? 'text-amber-400' : 'text-[var(--text-muted)]',
                          )}
                        >
                          <Star className={cn('h-3.5 w-3.5', favorites.has(c.id) && 'fill-amber-400')} />
                        </button>
                        <button
                          type="button"
                          title="Delete conversation"
                          onClick={(e) => void deleteConversation(c.id, e)}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={newConversation}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
          >
            <SquarePen className="h-3.5 w-3.5" /> New
          </button>
        </div>
      </div>

      {/* Thread */}
      <div ref={scrollRef} onScroll={handleChatScroll} className="-mr-3 flex-1 min-h-0 overflow-y-auto rounded-xl pr-3 sm:-mr-6 sm:pr-6">
        {isEmpty ? (
          <div className="flex min-h-full flex-col items-center justify-center px-4 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent)]/10 text-[var(--accent)]">
              <Sparkles className="h-8 w-8" />
            </div>
            <h2 className="mt-5 text-xl font-semibold text-[var(--text-primary)]">What should the QA agent do?</h2>
            <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
              Describe a testing task in plain language. I&apos;ll turn it into a step-by-step plan, you review and approve,
              and I&apos;ll execute it — generating cases, plans, runs, defects, and reports for you.
            </p>
            <div className="mt-7 grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {SUGGESTIONS.map((s) => (
                <div
                  key={s.label}
                  className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 text-left"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-secondary)] text-[var(--accent)]">
                    <s.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-primary)]">{s.label}</span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)] line-clamp-2">{s.prompt}</span>
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-8 w-full">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Everything the agent can do for you
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {CAPABILITIES.map((c) => (
                  <span
                    key={c.label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)]"
                  >
                    <c.icon className="h-3.5 w-3.5 text-[var(--accent)]" />
                    {c.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-6 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <Inbox className="h-3.5 w-3.5" />
              Decisions that need you appear in the AI Inbox (top-right).
            </div>
            <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
              Tip: set how much I do on my own — say &ldquo;set autonomy to manual&rdquo;, &ldquo;review&rdquo;, or &ldquo;autonomous&rdquo;.
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {turns.map((turn) => {
              if (turn.role === 'user') {
                const isEditing = editingTurnId === turn.id;
                if (isEditing) {
                  return (
                    <div key={turn.id} className="flex items-start justify-end gap-2.5">
                      <div className="flex w-fit min-w-[240px] max-w-[85%] flex-col overflow-hidden rounded-2xl border border-[var(--accent)] bg-[var(--bg-card)] shadow-sm ring-2 ring-[var(--accent)]/30">
                        <textarea
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit(); }
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveInlineEdit(turn.id); }
                          }}
                          rows={1}
                          className="field-sizing-content block max-h-[320px] min-w-0 max-w-full resize-none whitespace-pre-wrap break-words bg-transparent px-4 py-3 text-sm text-[var(--text-primary)] outline-none"
                        />
                        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5">
                          <span className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--text-muted)]">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            Editing this message will update it and re-run the response from here.
                          </span>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={cancelInlineEdit}
                              className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => saveInlineEdit(turn.id)}
                              disabled={!editDraft.trim() || busy}
                              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <User className="h-4 w-4" />
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={turn.id} className="group flex items-start justify-end gap-2.5">
                    {/* Softer tinted bubble + primary text reads better than solid accent + white. */}
                    <div className="max-w-[85%]">
                      <div className="rounded-2xl rounded-br-sm border border-[var(--accent)]/30 bg-[var(--accent)]/15 px-4 py-2.5 text-sm text-[var(--text-primary)]">
                        {turn.text}
                      </div>
                      <div className="mt-1 pr-1 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => editUserPrompt(turn.id, turn.text)}
                          title="Edit prompt"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <SquarePen className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyUserPrompt(turn.id, turn.text)}
                          title={copiedTurnId === turn.id ? 'Copied' : 'Copy Prompt'}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                      <User className="h-4 w-4" />
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'thinking') {
                if (turn.activityRequestId) {
                  return (
                    <AgentActivity
                      key={turn.id}
                      conversationId={conversationId}
                      requestId={turn.activityRequestId}
                      liveLabel={turn.label}
                      partialText={turn.partialText}
                      onActivity={followChatBottom}
                      onCompleted={turn.id.startsWith('activity-') ? () => { void loadConversation(conversationId); } : undefined}
                    />
                  );
                }
                const visibleDebug = (turn.debug || []).filter((entry) => !containsPrivateFileActivity(entry));
                return (
                  <div key={turn.id} className="text-sm text-[var(--text-muted)]">
                    <style>{`
                      @keyframes tfaStepIn{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}
                      @keyframes tfaDot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
                    `}</style>
                    <div className="flex items-center gap-2.5">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
                    {/* key={turn.label} remounts the span on every step so the new
                        activity fades/slides in — the live "what the agent is doing" feed. */}
                    <span key={turn.label} style={{ animation: 'tfaStepIn .28s ease-out' }} className="font-medium text-[var(--text-primary)]">
                      {turn.label}
                    </span>
                    <span className="ml-0.5 inline-flex items-end gap-[3px] pb-0.5">
                      {[0, 150, 300].map((d) => (
                        <span key={d} className="inline-block h-1 w-1 rounded-full bg-[var(--accent)]" style={{ animation: 'tfaDot 1s ease-in-out infinite', animationDelay: `${d}ms` }} />
                      ))}
                    </span>
                    </div>
                    {turn.partialText && (
                      <div className="ml-6 mt-2 max-w-[95%] whitespace-pre-wrap break-words text-[var(--text-primary)]">
                        {turn.partialText}
                      </div>
                    )}
                    {showQueryLogs && visibleDebug.length > 0 && (
                      <details className="ml-6 mt-2 max-w-[95%] rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                        <summary className="cursor-pointer text-xs font-semibold text-[var(--text-primary)]">
                          Background communication ({visibleDebug.length})
                        </summary>
                        <pre className="custom-scrollbar mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--bg-secondary)] p-3 text-[11px] leading-5 text-[var(--text-primary)]">
                          {visibleDebug.join('\n\n---\n\n')}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              }
              if (turn.kind === 'deeprun') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex w-full max-w-[95%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        {turn.activityRequestId ? (
                          <AgentActivity conversationId={conversationId} requestId={turn.activityRequestId} className="mb-2" />
                        ) : null}
                        {/* saved is threaded through the persisted turn so "Save all" stays "Saved" after navigation. */}
                        <DeepRunResult
                          taskId={turn.taskId}
                          initialSaved={!!turn.saved}
                          onSaved={() => replaceTurn(turn.id, { ...turn, saved: true })}
                          onActivityStarted={(activityRequestId) => replaceTurn(turn.id, { ...turn, activityRequestId })}
                        />
                        <MessageMeta createdAt={turn.createdAt} execution={turn.execution} />
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'codereview') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex w-full max-w-[95%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CodeChangeReview analysis={turn.analysis} />
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'reqdiscovery') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex w-full max-w-[95%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <RequirementDiscoveryResult
                          result={turn.result}
                          onGenerateTests={(context) => {
                            const thinkingId = `gen-${Date.now()}`;
                            const reqTitle = turn.result?.requirement?.title || 'this requirement';
                            const prompt = `Generate test cases for: ${reqTitle}`;
                            const targetUrl = (scopeApp?.baseUrl || '').trim() || getSelectedApps()[0]?.baseUrl || '';
                            const namedSite = websites?.find((w: any) => w.baseUrl === targetUrl);
                            // The requirement's metadata objects — let the server auto-resolve the admin
                            // section from these and skip the "which navigation?" ask when they name one.
                            const metadataRefs: string[] = ((turn.result?.requirement?.metadataRefs || turn.result?.understanding?.metadataRefs || []) as any[])
                              .map((m) => String(m?.object || '').trim()).filter(Boolean);
                            setTurns((prev) => [
                              ...prev,
                              { id: `user-${Date.now()}`, role: 'user', text: `Generate tests for the "${reqTitle}" requirement` },
                              { id: thinkingId, role: 'assistant', kind: 'thinking', label: 'Preparing test generation from requirement...' },
                            ]);
                            setBusy(true);
                            setPendingDeep({
                              prompt,
                              originalRequest: prompt,
                              contextPrompt: context,
                              caseCountPrompt: prompt,
                              targetUrl,
                              websiteId: namedSite?.id,
                              websiteName: namedSite?.name,
                              understanding: context,
                              understandingSource: 'requirement',
                              revisionCount: 0,
                            });
                            replaceTurn(thinkingId, {
                              id: thinkingId,
                              role: 'assistant',
                              kind: 'folderask',
                              text: context,
                              understanding: context,
                              understandingSource: 'requirement',
                              originalPrompt: prompt,
                              contextPrompt: context,
                              caseCountPrompt: prompt,
                              targetUrl,
                              websiteId: namedSite?.id,
                              websiteName: namedSite?.name,
                              metadataRefs,
                              ...targetChoiceFields(),
                            });
                            setBusy(false);
                            setTimeout(() => inputRef.current?.focus(), 50);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'reqdraft') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex w-full max-w-[95%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <RequirementDraftReview
                          result={turn.result}
                          busy={busy || (!!pendingRequirementDraft && pendingRequirementDraft.turnId !== turn.id)}
                          onCreate={() => void confirmRequirementDraft(turn)}
                          onDiscard={() => discardRequirementDraft(turn.id)}
                          onRework={(instruction, attachments) => void reworkRequirementDraft(turn, instruction, attachments)}
                          onChange={(result) => {
                            replaceTurn(turn.id, { ...turn, result });
                            setPendingRequirementDraft((current) => current?.turnId === turn.id ? { ...current, result } : current);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'cases') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex w-full max-w-[95%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        {/* Edits + adopted case ids flow back into the persisted turn so savedness survives reload. */}
                        <GeneratedCases cases={turn.cases} onCasesChange={(next) => replaceTurn(turn.id, { ...turn, cases: next })} />
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'clarify') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex max-w-[90%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="rounded-2xl rounded-bl-sm border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
                        <div className="font-medium text-[var(--text-primary)]">Just so I get it right</div>
                        <p className="mt-1 text-[var(--text-muted)]">
                          It looks like you want me to:{' '}
                          <span className="font-medium text-[var(--text-primary)]">{turn.summary}</span>{' '}
                          <span className="text-[11px]">({turn.confidence}% sure)</span>. Is that what you meant, or did you mean something else?
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() => confirmClarify(turn.id, turn.plan)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                          >
                            Yes, do that
                          </button>
                          <button
                            onClick={() => rejectClarify(turn.id)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]"
                          >
                            No, I meant something else
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'folderask') {
                return (
                  <FolderAskCard
                    key={turn.id}
                    turn={turn}
                    conversationId={conversationId}
                    onCommit={commitFolderAskDraft}
                    onProceed={proceedDeepFromTurn}
                    onCancel={cancelFolderAsk}
                  />
                );
              }
              if (turn.kind === 'appask') {
                return <AppAskCard key={turn.id} turn={turn} onProceed={proceedAppAsk} />;
              }
              if (turn.kind === 'text') {
                // Retry appears when the agent response is an error (explicit flag or heuristic) OR
                // when the user stopped the request (so a stopped pipeline can be re-run).
                const isErr = Boolean(turn.isError) || looksLikeAgentError(turn.text);
                const canRetry = isErr || Boolean(turn.stopped);
                return (
                  <div key={turn.id} className="group flex justify-start">
                    <div className="flex max-w-[90%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        {turn.activityRequestId ? (
                          <AgentActivity
                            conversationId={conversationId}
                            requestId={turn.activityRequestId}
                            className="mb-2"
                          />
                        ) : null}
                        <div className={cn(
                          'min-w-0 rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm text-[var(--text-primary)]',
                          isErr ? 'border-red-500/30 bg-red-500/5' : 'border-[var(--border)] bg-[var(--bg-card)]',
                        )}>
                          <MarkdownText value={turn.text} />
                          {turn.targetResult ? <TargetActionResult result={turn.targetResult} /> : null}
                          {authoredScriptFromTurn(turn) && !(turn.screenshotUrls || []).length && (
                            <button
                              type="button"
                              onClick={() => void rerunAuthoredForScreenshots(turn)}
                              disabled={busy}
                              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                            >
                              <PlayCircle className="h-3.5 w-3.5 text-[var(--accent)]" />
                              Run Headless for Screenshots
                            </button>
                          )}
                        </div>
                        <MessageMeta createdAt={turn.createdAt} execution={turn.execution} />
                        {/* Action row: Copy (hover-reveal, always) + Retry (only on agent errors). */}
                        <div className="mt-1 flex items-center gap-1 pl-1">
                          <button
                            type="button"
                            onClick={() => void copyUserPrompt(turn.id, turn.text)}
                            title={copiedTurnId === turn.id ? 'Copied' : 'Copy Response'}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            {copiedTurnId === turn.id ? <Check className="h-3 w-3 text-[var(--accent)]" /> : <Copy className="h-3 w-3" />}
                          </button>
                          {canRetry && (
                            <button
                              type="button"
                              onClick={() => retryTurn(turn.id)}
                              disabled={busy}
                              title="Retry this request"
                              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-red-500/70 hover:bg-red-500/10 disabled:opacity-50"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Retry
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              // plan
              const links = turn.plan?.status === 'completed' ? drillLinksForPlan(turn.plan) : [];
              return (
                <div key={turn.id} className="flex justify-start">
                  <div className="flex w-full max-w-[95%] gap-2.5">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                      <BrainCircuit className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--bg-card)] p-4">
                      <WorkflowRunner
                        plan={turn.plan}
                        onExecutePlan={(planId, opts) => executePlan(planId, turn.id, opts)}
                        onCancelPlan={(planId) => cancelPlan(planId, turn.id)}
                      />
                      {links.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                          {links.map((l) => (
                            <button
                              key={l.href}
                              onClick={() => navigate(l.href)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
                            >
                              <l.icon className="h-3.5 w-3.5 text-[var(--accent)]" />
                              {l.label}
                              <ArrowRight className="h-3 w-3 text-[var(--text-muted)]" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3 shrink-0">
        <div
          className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-2 shadow-sm transition-colors focus-within:border-[var(--accent)]"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // Clipboard text from Windows / browsers / rich sources carries CRLF (\r\n) or bare
              // \r, which shows up as an extra blank line. Normalize to \n and insert at the caret
              // so pasted text lands exactly as it looks — no phantom newline.
              const raw = e.clipboardData.getData('text');
              if (!/\r/.test(raw)) return; // clean text — let the browser paste normally
              e.preventDefault();
              const clean = raw.replace(/\r\n?/g, '\n');
              const el = e.currentTarget;
              const start = el.selectionStart ?? input.length;
              const end = el.selectionEnd ?? input.length;
              const next = input.slice(0, start) + clean + input.slice(end);
              setInput(next);
              const caret = start + clean.length;
              requestAnimationFrame(() => { try { el.selectionStart = el.selectionEnd = caret; } catch { /* ignore */ } });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask the agent to create cases, plan tests, run a suite, file a defect…"
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-muted)]"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              {/* Platform multi-select: configured website credentials identify test platforms;
                  app discovery happens inside the selected platform. */}
              <div ref={appPickerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAppPickerOpen((o) => !o)}
                  title="Select which saved platforms the agent should target (multi-select)"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                    selectedApps.length
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]',
                  )}
                >
                  <AppWindow className="h-3.5 w-3.5" />
                  {selectedApps.length ? `${selectedApps.length} platform${selectedApps.length > 1 ? 's' : ''} selected` : 'Platforms to Test'}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {appPickerOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-72 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-lg">
                    {websites.length === 0 ? (
                      <div className="px-2 py-2 text-[11px] text-[var(--text-muted)]">No saved platforms. Add them in Settings → Website Credentials.</div>
                    ) : (
                      <>
                        <div className="mb-1 flex items-center justify-between gap-2 border-b border-[var(--border)] px-2 py-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Platforms to Test</span>
                          <button
                            type="button"
                            onClick={() => setSelectedAppIds(allAppsSelected ? new Set() : new Set(websites.map((w) => w.id)))}
                            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)] hover:bg-[var(--accent)]/10"
                          >
                            {allAppsSelected ? 'Clear' : 'Select All'}
                          </button>
                        </div>
                        {websites.map((w) => {
                        const on = selectedAppIds.has(w.id);
                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => setSelectedAppIds((prev) => { const n = new Set(prev); if (on) n.delete(w.id); else n.add(w.id); return n; })}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)]"
                          >
                            <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)]')}>
                              {on && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium text-[var(--text-primary)]">{w.name}</span>
                              <span className="ml-1 text-[var(--text-muted)]">{w.baseUrl}</span>
                            </span>
                          </button>
                        );
                      })}
                      </>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setReqMode((mode) => !mode)}
                aria-pressed={reqMode}
                title="Create source-grounded requirements"
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                  reqMode
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]',
                )}
              >
                <Target className="h-3.5 w-3.5" />
                Requirements
              </button>
              <button
                type="button"
                onClick={() => setScriptAuthorMode((m) => !m)}
                title="Author one Playwright script by driving the live app from your exact steps"
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                  scriptAuthorMode
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]',
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                Script Author
              </button>
              {isListening || interimTranscript || speechError ? (
                <span className={cn(speechError ? 'text-red-400' : 'text-[var(--text-muted)]')}>
                  {speechError || (interimTranscript ? `Listening: ${interimTranscript}` : 'Listening…')}
                </span>
              ) : (
                <span className="hidden sm:inline">
                  {scriptAuthorMode ? 'Script author mode: enter exact UI steps' : 'Enter to send · Shift+Enter for a new line'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={toggleListening}
                disabled={!isSpeechSupported}
                title={isSpeechSupported ? (isListening ? 'Stop voice input' : 'Speak') : 'Voice input not supported in this browser'}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full transition-colors disabled:opacity-40',
                  isListening
                    ? 'bg-red-500/20 text-red-500'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                <Mic className="h-4 w-4" />
              </button>
              {busy ? (
                <button
                  type="button"
                  onClick={stopActiveRequest}
                  title="Stop the active agent response"
                  className="flex h-9 items-center gap-1.5 rounded-full border border-red-500/50 bg-red-50 px-4 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 hover:text-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:bg-red-500/15 dark:text-red-100 dark:hover:bg-red-500/25 dark:hover:text-white"
                >
                  <StopCircle className="h-4 w-4" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!input.trim()}
                  className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    {providerPortal && createPortal(
      <TopbarActions
        providers={providers}
        selectedModel={selectedModel}
        selectedEffort={selectedEffort}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
      />,
      providerPortal,
    )}
  </>);
}
