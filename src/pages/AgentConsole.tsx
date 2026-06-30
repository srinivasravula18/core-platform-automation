import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
  Star,
  Target,
  Trash2,
  AppWindow,
  Check,
  ChevronDown,
  Copy,
  User,
  Info,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useProjects } from '@/src/store/project';
import { useSpeechToText } from '@/src/lib/useSpeechToText';
import { showToast } from '@/src/lib/dialog';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';
import { DeepRunResult } from '@/src/components/DeepRunResult';
import { CodeChangeReview } from '@/src/components/CodeChangeReview';
import { RequirementDiscoveryResult } from '@/src/components/RequirementDiscoveryResult';
import { RequirementDraftReview } from '@/src/components/RequirementDraftReview';
import { GeneratedCases } from '@/src/components/GeneratedCases';

// NOTE: The brittle regex DECISION layer that used to live here (GIT_RE, REQ_RE, DEEP_RE,
// GEN_VERB_RE, siteActionable, isQuestionForSupervisor, isCoreListViewText, isProceedLike,
// extractTargetUrl, findCoreAdminWebsite, …) has been retired. The routing decision is now
// made by ONE backend call to POST /api/agent/goal (see send() below), which returns a typed
// `kind` the console dispatches on. Only the small helpers still used by preserved EXECUTION
// and rendering flows (describeAgentStep, isNoiseAnswer/lastAssistantAnswer for grounding,
// escapeRegExp/findWebsiteInText for resolving a named app to a websiteId) remain.

// Turn a streamed Supervisor step into a human-readable "what it's doing right now" label.
function describeAgentStep(ev: { toolCalls?: Array<{ name: string; arguments?: any }> }): string {
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
  if (/^\[(openai|anthropic|gemini|google|cli|deepseek|cerebras)\]/i.test(c)) return true;
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
// Find a stored website whose name is mentioned in the message (longest match wins).
function findWebsiteInText(text: string, websites: Array<{ id: string; name: string; baseUrl: string }>): { id: string; name: string; baseUrl: string } | null {
  const lower = (text || '').toLowerCase();
  const matches = (websites || []).filter((w) => w?.name && new RegExp(`\\b${escapeRegExp(String(w.name).toLowerCase())}\\b`).test(lower));
  matches.sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
  return matches[0] || null;
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

function isAutoFolderResponse(text: string): boolean {
  return /^(auto|automatic|you\s+decide|any|organi[sz]e)\b/i.test(text.trim());
}

function isExplicitFolderResponse(text: string): boolean {
  const trimmed = text.trim();
  return /^folder\s*[:=-]\s*\S+/i.test(trimmed) || /^@\w+/.test(trimmed);
}

function isLikelyFolderResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('?')) return false;
  if (isAutoFolderResponse(trimmed) || isExplicitFolderResponse(trimmed)) return true;
  return trimmed.split(/\s+/).length <= 4 && trimmed.length <= 60;
}

function stripFolderPrefix(text: string): string {
  return text.trim().replace(/^folder\s*[:=-]\s*/i, '');
}

// Matches "requirement(s)" and common misspellings/truncations.
const REQUIREMENT_WORD_RE = /\b(?:requirements?|requirments?|requiremnts?|requiremts?|requiments?|requriments?|reqs?)\b/i;
const REQUIREMENT_WORD_RE_GLOBAL = /\b(?:requirements?|requirments?|requiremnts?|requiremts?|requiments?|requriments?|reqs?)\b/gi;

function isRequirementWord(text: string): boolean {
  return REQUIREMENT_WORD_RE.test(text);
}

function isExplicitRequirementOnlyRequest(text: string): boolean {
  const value = (text || '').toLowerCase();
  if (!isRequirementWord(value)) return false;
  const createVerb = /\b(?:create|generate|write|draft|discover|add|make)\b[\s\S]{0,80}req/i.test(value);
  // "req* for/to/of X" without asking for cases/scripts/runs is a requirement-only request.
  const asksCasesOrScripts = /\b(?:cases?|scripts?|playwright|suite|run)\b/.test(value);
  return createVerb && !asksCasesOrScripts;
}

function extractRequirementOnlyQuery(text: string): string {
  return (text || '')
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:i\s+(?:want|need)\s+(?:you\s+)?to\s+)/i, '')
    .replace(/\b(?:create|generate|write|draft|discover|add|make)\b/gi, ' ')
    .replace(/\b(?:test\s+plan|plan|containing|with)\b/gi, ' ')
    .replace(/\breq(?:u(?:i(?:r?e?m?e?n?t?s?|ments?|rements?|irements?|uirements?)?)?)?s?\b/gi, ' ')
    .replace(/\bonly\b/gi, ' ')
    .replace(/\b(?:from|using|based on)\s+(?:the\s+)?(?:code|codebase|source|product source)\b/gi, ' ')
    .replace(/\b(?:for|on|about)\b/gi, ' ')
    .replace(/\b(?:a|an|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRequirementDraftApprove(text: string): boolean {
  return /^(?:yes|ok|okay|approve|approved|save|create|confirm|looks good|proceed|go ahead)\b/i.test(text.trim());
}

function isRequirementDraftCancel(text: string): boolean {
  return /^(?:cancel|discard|stop|never mind|nevermind)\b/i.test(text.trim());
}

function initialThinkingLabel(text: string, opts: { selectedApps: number; requirementDraftPending: boolean }): string {
  const value = (text || '').toLowerCase();
  if (opts.requirementDraftPending) return 'Updating requirement draft...';
  if (isExplicitRequirementOnlyRequest(text)) return 'Reading source for requirement draft...';
  if (isRequirementWord(value)) return 'Preparing requirement review...';
  if (/\b(?:test\s*)?(?:cases?|scripts?|playwright|suite|plan|run)\b/.test(value)) return 'Preparing test workflow...';
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
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'plan'; plan: any }
  | { id: string; role: 'assistant'; kind: 'deeprun'; taskId: string }
  | { id: string; role: 'assistant'; kind: 'codereview'; analysis: any }
  | { id: string; role: 'assistant'; kind: 'reqdiscovery'; result: any }
  | { id: string; role: 'assistant'; kind: 'reqdraft'; result: any; query: string; revisionCount?: number }
  | { id: string; role: 'assistant'; kind: 'cases'; cases: any[] }
  | { id: string; role: 'assistant'; kind: 'clarify'; plan: any; summary: string; confidence: number }
  | { id: string; role: 'assistant'; kind: 'folderask'; text: string; understanding?: string; understandingSource?: string; folderName?: string; originalPrompt?: string; contextPrompt?: string; caseCountPrompt?: string; targetUrl?: string; websiteId?: string; websiteName?: string; revisionCount?: number }
  | { id: string; role: 'assistant'; kind: 'thinking'; label: string };

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
    label: 'Generate cases + scripts',
    prompt: 'Generate 5 test cases for the login flow of https://example.com, then write the Playwright scripts and capture evidence',
    icon: FlaskConical,
  },
  {
    label: 'Draft a test plan',
    prompt: 'Create a regression test plan for the checkout flow',
    icon: ClipboardList,
  },
  {
    label: 'Group into a suite',
    prompt: 'Create a smoke test suite and group the login and checkout cases into it',
    icon: Layers,
  },
  {
    label: 'Schedule a run',
    prompt: 'Set up a smoke test run for the latest build',
    icon: PlayCircle,
  },
  {
    label: 'File a defect',
    prompt: 'File a high severity defect: the payment button is unresponsive on mobile',
    icon: Bug,
  },
  {
    label: 'Write a report',
    prompt: 'Generate a stakeholder test report for the latest release',
    icon: ClipboardList,
  },
];

// Capability strip shown on the empty state so the client sees the full scope.
const CAPABILITIES: { label: string; icon: typeof FlaskConical }[] = [
  { label: 'Test cases', icon: FlaskConical },
  { label: 'Playwright scripts', icon: Code2 },
  { label: 'Evidence', icon: ImageIcon },
  { label: 'Test plans', icon: ClipboardList },
  { label: 'Suites', icon: Layers },
  { label: 'Runs', icon: PlayCircle },
  { label: 'Defects', icon: Bug },
  { label: 'Reports', icon: ClipboardList },
  { label: 'Folders', icon: FolderTree },
  { label: 'Rework / expand', icon: Wand2 },
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
  create_folder: { label: 'Open File System', href: '/repository', icon: FolderTree },
  organize_repository: { label: 'Open File System', href: '/repository', icon: FolderTree },
  move_to_folder: { label: 'Open File System', href: '/repository', icon: FolderTree },
};

let turnCounter = 0;
function nextId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

const CONV_KEY_BASE = 'tfa_active_conversation';
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

function planIsChatOnly(plan: any): boolean {
  const steps = plan?.steps || [];
  if (!steps.length) return true;
  return steps.every((s: any) => s.intent.kind === 'explain' || s.intent.kind === 'unknown');
}

// Lowest confidence across the plan's steps — used to decide if we should
// confirm an ambiguous request with the user before acting.
function planConfidence(plan: any): number {
  const steps = plan?.steps || [];
  if (!steps.length) return 100;
  return Math.min(...steps.map((s: any) => Number(s.intent?.confidence) || 0));
}
const CLARIFY_THRESHOLD = 60;

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

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => {
    try {
      // URL param takes precedence — lets users share / bookmark a specific chat
      if (urlChatId) return urlChatId;
      return localStorage.getItem(convKey) || makeConversationId();
    } catch {
      return makeConversationId();
    }
  });
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('tfa_conv_favorites');
      return new Set(stored ? JSON.parse(stored) : []);
    } catch {
      return new Set();
    }
  });
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
  // Explicit "apps under test" selected by the user in the composer. ALL selected apps
  // are passed to the agent as target context on every request, so it always has the app
  // data and never replies "I don't have the URL / context".
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(new Set());
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pendingDeep, setPendingDeep] = useState<PendingDeep | null>(null);
  const [pendingRequirementDraft, setPendingRequirementDraft] = useState<PendingRequirementDraft | null>(null);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Existing repository folders, for the deep-run "save results to folder" picker.
  const [folderOptions, setFolderOptions] = useState<Array<{ id: string; name: string; path?: string }>>([]);
  // Requirement mode: toggled with Shift+Tab. When on, every message is routed to
  // the requirement-discovery pipeline regardless of phrasing.
  const [reqMode, setReqMode] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId: urlChatId } = useParams<{ chatId?: string }>();
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
  // Load existing repository folders for the deep-run results folder picker.
  useEffect(() => {
    fetch('/api/folders')
      .then((r) => r.json())
      .then((data) => setFolderOptions(Array.isArray(data) ? data : []))
      .catch(() => setFolderOptions([]));
  }, []);
  // The target (app URL / website) resolved earlier in THIS chat, so a later generation
  // request ("generate them", "for admin", "yes") reuses it without re-asking — the chat
  // remembers what it's testing, like a normal assistant.
  const convTargetRef = useRef<{ targetUrl: string; websiteId?: string; websiteName?: string } | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeThinkingIdRef = useRef<string | null>(null);

  // Keep the active conversation id in localStorage (per scope) so a refresh
  // resumes the right conversation for the selected project/app.
  useEffect(() => {
    try {
      localStorage.setItem(convKey, conversationId);
    } catch {
      /* ignore */
    }
  }, [conversationId, convKey]);

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

  const loadConversation = useCallback(async (id: string) => {
    loadedRef.current = false;
    try {
      const r = await fetch(`/api/chat/conversations/${id}`);
      const d = await r.json();
      // Drop any transient "thinking" turns that may have been persisted.
      const clean = (Array.isArray(d.turns) ? d.turns : []).filter(
        (t: Turn) => !(t.role === 'assistant' && t.kind === 'thinking'),
      );
      setTurns(clean);
    } catch {
      setTurns([]);
    } finally {
      loadedRef.current = true;
    }
  }, []);

  // Initial load: restore the active conversation + the history list. If the remembered id has no
  // content (e.g. a fresh id was minted before the scope settled, or the user navigated away and
  // back to the console), fall back to the most recently updated non-empty chat for this scope so
  // the recent conversation is shown instead of the empty welcome screen.
  useEffect(() => {
    const cleanTurns = (raw: unknown): Turn[] =>
      (Array.isArray(raw) ? (raw as Turn[]) : []).filter((t) => !(t.role === 'assistant' && t.kind === 'thinking'));
    (async () => {
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
      try {
        const r = await fetch(`/api/chat/conversations/${preferredId}`);
        chosenTurns = cleanTurns((await r.json())?.turns);
      } catch { /* ignore */ }

      // Only fall back when this wasn't an explicit deep link to a specific chat.
      if (chosenTurns.length === 0 && !urlChatId) {
        const recent = [...convs]
          .filter((c) => (c.turnCount || 0) > 0)
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
        if (recent && recent.id !== preferredId) {
          try {
            const r = await fetch(`/api/chat/conversations/${recent.id}`);
            chosenTurns = cleanTurns((await r.json())?.turns);
            chosen = recent.id;
          } catch { /* ignore */ }
        }
      }

      if (chosen !== conversationId) setConversationId(chosen);
      setTurns(chosenTurns);
      loadedRef.current = true;
    })();
    fetch('/api/credentials/websites')
      .then((r) => r.json())
      .then((d) => setWebsites(Array.isArray(d?.websites) ? d.websites : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the conversation (debounced) whenever the turns change.
  useEffect(() => {
    if (!loadedRef.current) return;
    const clean = turns.filter((t) => !(t.role === 'assistant' && t.kind === 'thinking'));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!clean.length) return; // don't persist empty conversations
      const firstUser = clean.find((t) => t.role === 'user') as { text?: string } | undefined;
      fetch(`/api/chat/conversations/${conversationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, title: firstUser?.text?.slice(0, 80) || 'New chat', turns: clean }),
      })
        .then(() => loadConversations())
        .catch(() => {});
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [turns, conversationId, workspaceId, loadConversations]);

  // Close the history dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    if (historyOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [historyOpen]);

  const newConversation = useCallback(() => {
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
      setConversationId(id);
      loadConversation(id);
      setHistoryOpen(false);
    },
    [conversationId, loadConversation],
  );

  useEffect(() => {
    try {
      localStorage.setItem('tfa_conv_favorites', JSON.stringify(Array.from(favorites)));
    } catch { /* ignore */ }
  }, [favorites]);

  const toggleFavorite = useCallback((id: string, e: MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const deleteConversation = useCallback(async (id: string, e: MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setFavorites((prev) => { const next = new Set(prev); next.delete(id); return next; });
    if (id === conversationId) newConversation();
  }, [conversationId, newConversation]);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const patchTurn = useCallback((id: string, plan: any) => {
    setTurns((prev) => prev.map((t) => (t.id === id && t.role === 'assistant' && t.kind === 'plan' ? { ...t, plan } : t)));
  }, []);

  const replaceTurn = useCallback((id: string, turn: Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? turn : t)));
  }, []);

  const updateThinkingLabel = useCallback((id: string, label: string) => {
    setTurns((prev) => prev.map((t) => (
      t.id === id && t.role === 'assistant' && t.kind === 'thinking'
        ? { ...t, label }
        : t
    )));
  }, []);

  const stopActiveRequest = useCallback(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    const thinkingId = activeThinkingIdRef.current;
    activeThinkingIdRef.current = null;
    stopListening();
    if (thinkingId) {
      replaceTurn(thinkingId, {
        id: thinkingId,
        role: 'assistant',
        kind: 'text',
        text: 'Stopped.',
      });
    }
    setBusy(false);
    inputRef.current?.focus();
  }, [replaceTurn, stopListening]);

  const richestAssistantContext = useCallback((): string => {
    const recent = turnsRef.current
      .filter((t) => t.role === 'assistant')
      .map((t) => {
        switch (t.kind) {
          case 'text': return t.text || '';
          case 'folderask': return t.understanding || t.text || '';
          case 'clarify': return t.summary || '';
          case 'plan': return t.plan?.summary || '';
          case 'cases': return Array.isArray(t.cases)
            ? `Generated test cases:\n${t.cases.map((c: any, i: number) => `${i + 1}. ${c?.title || c?.name || `case ${i + 1}`}`).join('\n')}`
            : '';
          case 'codereview': return typeof t.analysis === 'string' ? t.analysis : (t.analysis?.summary || '');
          case 'reqdiscovery': return typeof t.result === 'string' ? t.result : (t.result?.summary || '');
          case 'reqdraft': return t.result?.requirement?.description || t.result?.requirement?.title || '';
          default: return '';
        }
      })
      .filter((content) => content && !isNoiseAnswer(content))
      .slice(-6);
    if (!recent.length) return '';
    return recent.reduce((best, content) => (content.length > best.length ? content : best), '').trim();
  }, []);

  const buildDeepContextPrompt = useCallback((rawRequest: string, resolvedScope: string): string => {
    const request = (rawRequest || '').trim();
    const scope = (resolvedScope || '').trim();
    const prior = richestAssistantContext();
    const parts = [
      request ? `User follow-up/request: ${request}` : '',
      scope && scope !== request ? `Resolved scope from router: ${scope}` : '',
      prior ? `Carry forward this prior agent answer as authoritative scope:\n${prior}` : '',
    ].filter(Boolean);
    return (parts.join('\n\n') || scope || request).trim();
  }, [richestAssistantContext]);

  // The prior turns of THIS chat, as a compact role/content transcript, so every
  // request carries conversation memory (ChatGPT/Claude-style continuity).
  const buildHistory = useCallback((): Array<{ role: 'user' | 'assistant'; content: string }> => {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const push = (content: string) => { if (content && content.trim()) out.push({ role: 'assistant', content: content.trim().slice(0, 2400) }); };
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
            ? t.cases.map((c: any, i: number) => `${i + 1}. ${c?.title || c?.name || `case ${i + 1}`}`).join('; ')
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
    return out.slice(-16);
  }, []);

  const startDeepRun = useCallback(async (args: {
    thinkingId: string;
    prompt: string;
    targetUrl: string;
    websiteId?: string;
    approvedUnderstanding?: string;
    understandingSource?: string;
    priorGrounding?: string;
    folderMention?: string;
    caseCountPrompt?: string;
  }) => {
    updateThinkingLabel(args.thinkingId, 'Starting agent run...');
    const res = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: activeAbortRef.current?.signal,
      body: JSON.stringify({
        app_url: args.targetUrl,
        websiteId: args.websiteId || undefined,
        prompt: args.prompt,
        approvedUnderstanding: args.approvedUnderstanding || '',
        understandingSource: args.understandingSource || '',
        priorGrounding: args.priorGrounding || args.approvedUnderstanding || '',
        testCaseCount: parseCaseCount(args.caseCountPrompt || args.prompt),
        flowMode: 'review_cases',
        folderMention: args.folderMention || undefined,
        // Carry the conversation so case generation is grounded in what was actually
        // discussed — not just the (sometimes generic) prompt.
        history: buildHistory(),
        apps: getSelectedApps(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.chat_response) {
      replaceTurn(args.thinkingId, { id: args.thinkingId, role: 'assistant', kind: 'text', text: data.chat_response });
    } else if (data?.task_id) {
      replaceTurn(args.thinkingId, { id: args.thinkingId, role: 'assistant', kind: 'deeprun', taskId: data.task_id });
    } else {
      replaceTurn(args.thinkingId, {
        id: args.thinkingId,
        role: 'assistant',
        kind: 'text',
        text: data?.error || 'I could not start the generation. Check that an AI provider key is set in Settings.',
      });
    }
  }, [replaceTurn, buildHistory, updateThinkingLabel]);

  const requestDeepUnderstanding = useCallback(async (args: {
    prompt: string;
    originalRequest?: string;
    contextPrompt?: string;
    targetUrl: string;
    targetName?: string;
    currentUnderstanding?: string;
    correction?: string;
  }) => {
    const res = await fetch('/api/agent/understand-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: activeAbortRef.current?.signal,
      body: JSON.stringify({
        ...args,
        history: buildHistory(),
        projectId: selectedProjectId || undefined,
        appId: selectedAppId || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Failed to understand request');
    return data;
  }, [buildHistory, selectedProjectId, selectedAppId]);

  // Present the "Here's what I understood" review card for a deep generation/run request:
  // generate an understanding (grounded in the conversation), stash it as pendingDeep, and
  // render the folder-ask card so the user can edit, correct, pick a folder, or proceed.
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
    try {
      const generated = await requestDeepUnderstanding({ prompt, originalRequest: originalRequest || prompt, contextPrompt, targetUrl, targetName: websiteName || '' });
      understanding = generated.understanding || fallbackUnderstanding;
      understandingSource = generated.source || understandingSource;
    } catch {
      /* use deterministic fallback */
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
      revisionCount: 0,
      text: 'Look right? Pick a folder for the results (type a name below), or proceed with an auto-named folder.',
    });
  }, [buildDeepContextPrompt, requestDeepUnderstanding, replaceTurn, updateThinkingLabel]);

  const runRequirementDraft = useCallback(async (thinkingId: string, query: string, previousDraft?: PendingRequirementDraft, instruction?: string) => {
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
          projectId: selectedProjectId || undefined,
          appId: selectedAppId || undefined,
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
  }, [replaceTurn, selectedProjectId, selectedAppId, updateThinkingLabel]);

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

  // The apps the user explicitly selected in the composer (all of them), as target
  // context for the agent. Mirrored to a ref so callbacks read the latest without churn.
  const selectedApps = websites.filter((w) => selectedAppIds.has(w.id)).map((w) => ({ name: w.name, baseUrl: w.baseUrl }));
  const allAppsSelected = websites.length > 0 && selectedAppIds.size === websites.length;
  const selectedAppsRef = useRef<Array<{ name: string; baseUrl: string }>>([]);
  useEffect(() => { selectedAppsRef.current = selectedApps; });
  // The top-bar scope app, mirrored to a ref so callbacks read the latest.
  const scopeAppRef = useRef<{ name: string; baseUrl: string } | null>(null);
  useEffect(() => { scopeAppRef.current = scopeApp ? { name: scopeApp.name, baseUrl: scopeApp.baseUrl } : null; });
  // The single "selected apps" payload sent on EVERY chat fetch: merges the top-bar
  // scope app and the composer multi-select, deduped by baseUrl. This is the target the
  // agent must use so it never asks "which app" when an app is selected.
  const getSelectedApps = useCallback((): Array<{ name: string; baseUrl: string }> => {
    const out: Array<{ name: string; baseUrl: string }> = [];
    const seen = new Set<string>();
    const add = (a?: { name: string; baseUrl: string } | null) => {
      if (!a || !a.baseUrl) return;
      const key = a.baseUrl.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ name: a.name, baseUrl: a.baseUrl });
    };
    add(scopeAppRef.current);
    for (const a of selectedAppsRef.current) add(a);
    return out;
  }, []);

  // Route a message to the SupervisorAgent (dynamic tool-loop: query_workspace,
  // search_codebase, create_* …) and STREAM its live steps into the thinking turn, so the
  // user sees what the agent is actually doing in real time instead of a static label.
  const runViaSupervisor = useCallback(async (text: string, thinkingId: string) => {
    const setThinkingLabel = (label: string) =>
      setTurns((prev) => prev.map((t) => (t.id === thinkingId && t.role === 'assistant' && t.kind === 'thinking' ? { ...t, label } : t)));
    const requestBody = {
      userMessage: text,
      workspaceId: 'default',
      history: buildHistory(),
      pageContext: { path: location.pathname },
      apps: getSelectedApps(),
    };
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
      let liveReply = '';
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
          if (ev.type === 'step') setThinkingLabel(ev.text && ev.text.length < 80 ? ev.text : describeAgentStep(ev));
          else if (ev.type === 'answer_delta') {
            liveReply += ev.delta || '';
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(liveReply || ' ') });
          }
          else if (ev.type === 'heartbeat') {
            // Keeps production proxies from treating a long AI call as idle.
          }
          else if (ev.type === 'final') finalReply = ev.reply || '';
          else if (ev.type === 'error') finalReply = ev.error || 'The agent could not complete that.';
        }
      }
      replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(finalReply || 'Done.') });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: 'Stopped.' });
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
  }, [buildHistory, location.pathname, replaceTurn, getSelectedApps]);

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

      const thinkingId = nextId();
      const requestController = new AbortController();
      activeAbortRef.current?.abort();
      activeAbortRef.current = requestController;
      activeThinkingIdRef.current = thinkingId;
      const clearActiveRequest = () => {
        if (activeAbortRef.current === requestController) activeAbortRef.current = null;
        if (activeThinkingIdRef.current === thinkingId) activeThinkingIdRef.current = null;
      };
      setTurns((prev) => {
        const nextTurns = editedTurnId
          ? prev.map((t) => (t.id === editedTurnId && t.role === 'user' ? { ...t, text } : t))
          : [...prev, { id: nextId(), role: 'user', text }];
        return [...nextTurns, {
          id: thinkingId,
          role: 'assistant',
          kind: 'thinking',
          label: initialThinkingLabel(text, {
            selectedApps: getSelectedApps().length,
            requirementDraftPending: Boolean(pendingRequirementDraft),
          }),
        }];
      });

      if (pendingRequirementDraft) {
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

      // A pending "Here's what I understood" card only consumes a SHORT folder-like reply
      // (a folder name, or "auto"/"proceed"). ANY other message means the user moved on or
      // is asking something new — abandon the card and route this message fresh, so a
      // follow-up question ("what else should I test?") gets a chat answer instead of being
      // swallowed as a correction. (Corrections are still possible by editing the card's box.)
      const proceedingDeep = !!pendingDeep && isLikelyFolderResponse(text);
      if (pendingDeep && !proceedingDeep) setPendingDeep(null);
      const activePending = proceedingDeep ? pendingDeep : null;

      // ── Preserved pre-checks (run BEFORE the unified router) ───────────────────────
      // These two flows are explicit, stateful, or have no equivalent backend route-kind,
      // so they are kept exactly as before and short-circuit the /api/agent/goal call.

      // 1) Pending "Here's what I understood" review card: a folder-like reply (folder name
      //    or "auto"/"proceed") FINALIZES the deep run; any other reply REVISES the
      //    understanding. (Non-folder replies that abandon the card already cleared
      //    pendingDeep above and fall through to the unified router.)
      if (activePending) {
        if (!isLikelyFolderResponse(text)) {
          try {
            updateThinkingLabel(thinkingId, 'Revising reviewed test scope...');
            const revised = await requestDeepUnderstanding({
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
              revisionCount: nextPending.revisionCount,
              text: 'I updated what I understood. You can edit it, correct me again, pick a folder, or proceed with an auto-named folder.',
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
        // Folder-like reply → start the deep run with the reviewed understanding.
        const folderMention = isAutoFolderResponse(text) ? '' : stripFolderPrefix(text);
        const approvedUnderstanding = activePending.understanding || lastAssistantAnswer(buildHistory());
        setPendingDeep(null);
        try {
          updateThinkingLabel(thinkingId, 'Starting reviewed test run...');
          await startDeepRun({
            thinkingId,
            prompt: activePending.contextPrompt || activePending.prompt,
            targetUrl: activePending.targetUrl,
            websiteId: activePending.websiteId,
            approvedUnderstanding,
            understandingSource: activePending.understandingSource,
            priorGrounding: approvedUnderstanding,
            folderMention: folderMention || undefined,
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

      // 2) Requirement creation only:
      //    - Shift+Tab requirement mode keeps forcing this route.
      //    - Plain-text requests like "create requirements only for list view" also bypass
      //      the goal router, so the console drafts a requirement without starting a deep run.
      const requirementOnly = isExplicitRequirementOnlyRequest(text);
      if (reqMode || requirementOnly) {
        try {
          updateThinkingLabel(thinkingId, 'Starting requirement drafting agent...');
          await runRequirementDraft(thinkingId, requirementOnly ? extractRequirementOnlyQuery(text) : text);
        } finally {
          clearActiveRequest();
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // ── The single primary decision: the unified backend router ─────────────────────
      // POST the message to /api/agent/goal and dispatch on the returned `kind`, reusing
      // the existing execution + rendering helpers. This replaces the old pile of frontend
      // regexes (DEEP_RE / GEN_VERB_RE / siteActionable / isQuestionForSupervisor / …).
      const historyForRouting = buildHistory();
      const scopeAppUrl = (scopeApp?.baseUrl || '').trim();
      try {
        updateThinkingLabel(thinkingId, 'Routing request to the right agent...');
        const res = await fetch('/api/agent/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: activeAbortRef.current?.signal,
          body: JSON.stringify({
            message: text,
            history: historyForRouting,
            apps: getSelectedApps(),
            pageContext: { path: location.pathname },
          }),
        });
        const goal = await res.json().catch(() => ({}));
        if (!res.ok) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: goal?.error || 'Sorry, I could not process that request. Please try rephrasing it.',
          });
          return;
        }

        const kind = goal?.kind;
        updateThinkingLabel(thinkingId, kind === 'answer'
          ? 'Preparing grounded answer...'
          : kind === 'clarify'
            ? 'Checking what needs clarification...'
            : kind === 'code_analysis'
              ? 'Preparing code analysis...'
              : kind === 'requirement_draft'
                ? 'Researching codebase for requirement draft...'
                : kind === 'generate_cases' || kind === 'deep_test_run'
                  ? 'Preparing reviewed test generation...'
                  : kind === 'workspace_action'
                    ? 'Preparing workspace action...'
                    : 'Preparing response...');

        // answer / clarify → a plain assistant-text turn. For 'answer' we keep the nicer
        // streaming UX by re-using the Supervisor stream (which grounds in code + workspace);
        // if that fails it falls back to the reply text the router already produced.
        if (kind === 'answer') {
          if (typeof goal.reply === 'string' && goal.reply.trim()) {
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(goal.reply) });
          } else {
            updateThinkingLabel(thinkingId, 'Streaming grounded answer...');
            await runViaSupervisor(text, thinkingId);
          }
          return;
        }
        if (kind === 'clarify') {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: cleanChat(goal.reply || 'Could you give me a bit more detail so I get this right?'),
          });
          return;
        }

        // code_analysis → the existing git-agent analysis path (renders a CodeChangeReview).
        if (kind === 'code_analysis') {
          try {
            updateThinkingLabel(thinkingId, 'Reading repository changes...');
            const ares = await fetch('/api/git-agent/analyze', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: activeAbortRef.current?.signal,
              body: JSON.stringify({ baseRef: 'auto', workspaceId: 'default' }),
            });
            const data = await ares.json();
            if (!ares.ok) {
              replaceTurn(thinkingId, {
                id: thinkingId,
                role: 'assistant',
                kind: 'text',
                text: data?.error || 'I could not read the codebase. Make sure the Git Agent target repo is available.',
              });
            } else {
              replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'codereview', analysis: data });
            }
          } catch (err: any) {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: `Something went wrong analyzing the code changes: ${err?.message || 'unknown error'}.`,
            });
          }
          return;
        }

        // requirement_draft → codebase-only, never touches the live app.
        if (kind === 'requirement_draft') {
          try {
            updateThinkingLabel(thinkingId, 'Starting requirement drafting agent...');
            await runRequirementDraft(thinkingId, goal?.scope || text);
          } finally {
            clearActiveRequest();
            setBusy(false);
            inputRef.current?.focus();
          }
          return;
        }

        // generate_cases / deep_test_run → the existing deep pipeline via startDeepRun, with
        // the review-first folder-ask card. The router's `execute` flag distinguishes a
        // review (generate_cases) from a full run (deep_test_run); the deep pipeline's
        // flowMode='review_cases' already realizes review-first, so generate_cases shows the
        // understanding card before any execution and deep_test_run proceeds with it.
        if (kind === 'generate_cases' || kind === 'deep_test_run') {
          // Resolve a concrete target. Prefer the router's resolved target, then the named
          // website (so we can pass a websiteId), then the selected/scope app, then the
          // target remembered earlier in THIS chat. Never fabricate a hardcoded URL.
          const routedUrl = (goal?.target?.url || '').trim();
          const routedName = (goal?.target?.name || '').trim();
          const namedSite =
            findWebsiteInText(routedName, websites) ||
            findWebsiteInText(routedUrl, websites) ||
            findWebsiteInText(text, websites);
          const targetUrl =
            routedUrl ||
            namedSite?.baseUrl ||
            scopeAppUrl ||
            (getSelectedApps()[0]?.baseUrl || '') ||
            convTargetRef.current?.targetUrl ||
            '';
          const websiteId = namedSite?.id || convTargetRef.current?.websiteId;
          const websiteName = routedName || namedSite?.name || convTargetRef.current?.websiteName;
          if (!targetUrl && !websiteId) {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: 'Which app should I run this against? Select an app in the project switcher (top bar) so I can use its URL, or paste the target URL here — then I will inspect it, generate the cases and Playwright scripts, and capture evidence.',
            });
            setBusy(false);
            inputRef.current?.focus();
            return;
          }
          // The prompt carries the router's grounded scope when it has one, so the deep run
          // reflects the actual conversation rather than just the raw message.
          const prompt = (typeof goal.scope === 'string' && goal.scope.trim()) ? goal.scope.trim() : text;
          const contextPrompt = buildDeepContextPrompt(text, prompt);
          updateThinkingLabel(thinkingId, 'Building reviewed test scope...');
          await presentDeepUnderstanding({ thinkingId, prompt, originalRequest: text, contextPrompt, targetUrl, websiteId, websiteName });
          setBusy(false);
          inputRef.current?.focus();
          return;
        }

        // workspace_action → the existing plan-card flow (same plan shape as
        // /api/controller/plan). Pure chat-only plans stream the answer; low-confidence
        // plans confirm first; otherwise render the reviewable WorkflowRunner plan card.
        const plan = goal?.plan;
        if (kind === 'workspace_action' && plan) {
          if (planIsChatOnly(plan)) {
            const fallbackText = 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.';
            updateThinkingLabel(thinkingId, 'Streaming workspace answer...');
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: '' });
            try {
              const histForExplain = historyForRouting;
              const ans = await fetch('/api/controller/explain/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: activeAbortRef.current?.signal,
                body: JSON.stringify({ topic: text, workspaceId: 'default', history: histForExplain, apps: getSelectedApps() }),
              });
              if (!ans.ok || !ans.body) {
                const data = await fetch('/api/controller/explain', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: activeAbortRef.current?.signal,
                  body: JSON.stringify({ topic: text, workspaceId: 'default', history: histForExplain, apps: getSelectedApps() }),
                }).then((r) => r.json()).catch(() => ({}));
                replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(data?.answer || plan?.summary || fallbackText) });
              } else {
                const reader = ans.body.getReader();
                const decoder = new TextDecoder();
                let acc = '';
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  acc += decoder.decode(value, { stream: true });
                  const display = cleanChat(acc);
                  setTurns((prev) => prev.map((t) => (t.id === thinkingId ? { id: thinkingId, role: 'assistant', kind: 'text', text: display } : t)));
                }
                if (!acc.trim()) {
                  setTurns((prev) => prev.map((t) => (t.id === thinkingId ? { id: thinkingId, role: 'assistant', kind: 'text', text: fallbackText } : t)));
                }
              }
            } catch {
              replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: plan?.summary || fallbackText });
            }
            return;
          }

          if (planConfidence(plan) < CLARIFY_THRESHOLD) {
            updateThinkingLabel(thinkingId, 'Preparing clarification...');
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'clarify',
              plan,
              summary: plan.summary || 'do that',
              confidence: planConfidence(plan),
            });
          } else {
            updateThinkingLabel(thinkingId, 'Preparing approval card...');
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'plan', plan });
          }
          return;
        }

        // Unknown / unhandled kind: surface any reply, else a safe fallback.
        replaceTurn(thinkingId, {
          id: thinkingId,
          role: 'assistant',
          kind: 'text',
          text: cleanChat(goal?.reply || plan?.summary || 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.'),
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: 'Stopped.' });
          return;
        }
        replaceTurn(thinkingId, {
          id: thinkingId,
          role: 'assistant',
          kind: 'text',
          text: `Something went wrong: ${err?.message || 'unknown error'}. Check that an AI provider key is configured in Settings.`,
        });
      } finally {
        clearActiveRequest();
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [input, busy, editingTurnId, location.pathname, stopListening, replaceTurn, updateThinkingLabel, requestDeepUnderstanding, presentDeepUnderstanding, runRequirementDraft, reqMode, pendingDeep, pendingRequirementDraft, websites, scopeApp, buildHistory, buildDeepContextPrompt, startDeepRun, runViaSupervisor, getSelectedApps],
  );

  // Start the deep run directly from a "Here's what I understood" card's OWN stored data
  // (understanding + target), independent of the volatile pendingDeep state. This keeps
  // the Proceed buttons working even if the user typed other messages after the card
  // appeared (which clears pendingDeep), so they never misfire into the planner.
  const proceedDeepFromTurn = useCallback(
    async (turn: { id: string; understanding?: string; understandingSource?: string; originalPrompt?: string; contextPrompt?: string; caseCountPrompt?: string; targetUrl?: string; websiteId?: string }, folderName?: string) => {
      if (busy) return;
      setBusy(true);
      setPendingDeep(null);
      if (turn.targetUrl || turn.websiteId) convTargetRef.current = { targetUrl: turn.targetUrl || '', websiteId: turn.websiteId };
      // Keep the confirmed understanding visible in the chat as a record, and add the run
      // card BELOW it — so clicking Proceed never makes the dialog vanish with nothing shown.
      const runTurnId = nextId();
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: turn.understanding || 'Proceeding with the run…' });
      setTurns((prev) => [...prev, { id: runTurnId, role: 'assistant', kind: 'thinking', label: 'Starting the run…' }]);
      try {
        await startDeepRun({
          thinkingId: runTurnId,
          prompt: turn.contextPrompt || turn.originalPrompt || '',
          targetUrl: turn.targetUrl || '',
          websiteId: turn.websiteId || undefined,
          approvedUnderstanding: turn.understanding || '',
          understandingSource: turn.understandingSource || '',
          priorGrounding: turn.understanding || '',
          folderMention: folderName || undefined,
          caseCountPrompt: turn.caseCountPrompt || turn.originalPrompt || '',
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

  return (
    <div className="flex h-full w-full flex-col px-4 sm:px-6">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
            <BrainCircuit className="h-5 w-5" />
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
                    <span className="text-[var(--text-muted)]/70"> / {scopeApp ? scopeApp.name : 'All apps'}</span>
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
                <div className="border-b border-[var(--border)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Conversations
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
                      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{c.title || 'Untitled chat'}</span>
                        <span className="block font-mono text-[10px] text-[var(--text-muted)]/60 truncate">{c.id}</span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {c.turnCount} message{c.turnCount === 1 ? '' : 's'} · {new Date(c.updatedAt).toLocaleString()}
                        </span>
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto rounded-xl">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
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
                <button
                  key={s.label}
                  onClick={() => send(s.prompt)}
                  className="group flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-secondary)]"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-secondary)] text-[var(--accent)] group-hover:bg-[var(--accent)]/10">
                    <s.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-primary)]">{s.label}</span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)] line-clamp-2">{s.prompt}</span>
                  </span>
                </button>
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
                          title={copiedTurnId === turn.id ? 'Copied' : 'Copy prompt'}
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
                return (
                  <div key={turn.id} className="flex items-center gap-2.5 text-sm text-[var(--text-muted)]">
                    <style>{`
                      @keyframes tfaStepIn{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}
                      @keyframes tfaDot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
                    `}</style>
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
                        <DeepRunResult taskId={turn.taskId} />
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
                        <GeneratedCases cases={turn.cases} />
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
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex max-w-[90%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <FolderTree className="h-4 w-4" />
                      </div>
                      <div className="rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm">
                        {turn.understanding && (
                          <textarea
                            value={turn.understanding}
                            rows={3}
                            // Auto-grow to fit content (dynamic height, not fixed), capped so it never
                            // takes over the viewport; scrolls past the cap.
                            ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 360)}px`; } }}
                            onChange={(e) => {
                              e.target.style.height = 'auto';
                              e.target.style.height = `${Math.min(e.target.scrollHeight, 360)}px`;
                              const nextUnderstanding = e.target.value;
                              setTurns((prev) => prev.map((item) => (
                                item.id === turn.id && item.role === 'assistant' && item.kind === 'folderask'
                                  ? { ...item, understanding: nextUnderstanding }
                                  : item
                              )));
                              setPendingDeep((prev) => (prev ? { ...prev, understanding: nextUnderstanding } : prev));
                            }}
                            className="mb-2 w-full resize-none overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-sans text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          />
                        )}
                        <p className="text-[var(--text-primary)]">{turn.text}</p>
                        {/* Results folder + actions, all in a single row: pick an existing folder,
                            or type a new name (blank = auto-named), then proceed/cancel. */}
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            value={folderOptions.some((f) => (f.path || f.name) === turn.folderName) ? turn.folderName : ''}
                            onChange={(e) => {
                              const name = e.target.value;
                              setTurns((prev) => prev.map((item) => (
                                item.id === turn.id && item.role === 'assistant' && item.kind === 'folderask' ? { ...item, folderName: name } : item
                              )));
                            }}
                            className="shrink-0 max-w-[150px] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          >
                            <option value="">Auto-named new folder</option>
                            {folderOptions.map((f) => (
                              <option key={f.id} value={f.path || f.name}>{f.path || f.name}</option>
                            ))}
                          </select>
                          <input
                            value={turn.folderName || ''}
                            onChange={(e) => {
                              const name = e.target.value;
                              setTurns((prev) => prev.map((item) => (
                                item.id === turn.id && item.role === 'assistant' && item.kind === 'folderask' ? { ...item, folderName: name } : item
                              )));
                            }}
                            placeholder="or new folder name"
                            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          />
                          <button
                            onClick={() => proceedDeepFromTurn(turn, (turn.folderName || '').trim() || undefined)}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                          >
                            <Sparkles className="h-3.5 w-3.5" /> {(turn.folderName || '').trim() ? 'Proceed' : 'Proceed (auto)'}
                          </button>
                          <button
                            onClick={() => {
                              setPendingDeep(null);
                              replaceTurn(turn.id, {
                                id: turn.id,
                                role: 'assistant',
                                kind: 'text',
                                text: 'Cancelled. Tell me what to change (target, fields, or steps) and I will re-plan.',
                              });
                              inputRef.current?.focus();
                            }}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              if (turn.kind === 'text') {
                return (
                  <div key={turn.id} className="flex justify-start">
                    <div className="flex max-w-[90%] gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                        <BrainCircuit className="h-4 w-4" />
                      </div>
                      <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2.5 text-sm text-[var(--text-primary)]">
                        {turn.text}
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
          className={cn(
            'rounded-2xl border bg-[var(--bg-card)] p-2 shadow-sm transition-colors',
            reqMode
              ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30'
              : 'border-[var(--border)] focus-within:border-[var(--accent)]',
          )}
        >
          {reqMode && (
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
                <Target className="h-3.5 w-3.5" /> Requirement mode
              </span>
              <button
                onClick={() => setReqMode(false)}
                className="text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Exit (Shift+Tab)
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                setReqMode((m) => !m);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={reqMode
              ? 'Requirement mode — name a feature or section to test (e.g. list view, permissions)…'
              : 'Ask the agent to create cases, plan tests, run a suite, file a defect…'}
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-muted)]"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              {/* Apps-under-test multi-select: all selected apps are sent to the agent as
                  target context, so it never lacks the URL/app data. */}
              <div ref={appPickerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAppPickerOpen((o) => !o)}
                  title="Select which saved apps the agent should target (multi-select)"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                    selectedApps.length
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]',
                  )}
                >
                  <AppWindow className="h-3.5 w-3.5" />
                  {selectedApps.length ? `${selectedApps.length} app${selectedApps.length > 1 ? 's' : ''} selected` : 'Apps to test'}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {appPickerOpen && (
                  <div className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-72 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-lg">
                    {websites.length === 0 ? (
                      <div className="px-2 py-2 text-[11px] text-[var(--text-muted)]">No saved apps. Add them in Settings → Website Credentials.</div>
                    ) : (
                      <>
                        <div className="mb-1 flex items-center justify-between gap-2 border-b border-[var(--border)] px-2 py-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Apps to test</span>
                          <button
                            type="button"
                            onClick={() => setSelectedAppIds(allAppsSelected ? new Set() : new Set(websites.map((w) => w.id)))}
                            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)] hover:bg-[var(--accent)]/10"
                          >
                            {allAppsSelected ? 'Clear' : 'Select all'}
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
              {isListening || interimTranscript || speechError ? (
                <span className={cn(speechError ? 'text-red-400' : 'text-[var(--text-muted)]')}>
                  {speechError || (interimTranscript ? `Listening: ${interimTranscript}` : 'Listening…')}
                </span>
              ) : (
                <span className="hidden sm:inline">
                  Enter to send · Shift+Enter for a new line · Shift+Tab for {reqMode ? 'normal' : 'requirement'} mode
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
                  className="flex h-9 items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/25 hover:text-red-200"
                >
                  <StopCircle className="h-4 w-4" />
                  <span className="hidden sm:inline">Stop</span>
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
  );
}
