import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BrainCircuit,
  Mic,
  Send,
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
  Target,
  AppWindow,
  Check,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useProjects } from '@/src/store/project';
import { useSpeechToText } from '@/src/lib/useSpeechToText';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';
import { DeepRunResult } from '@/src/components/DeepRunResult';
import { CodeChangeReview } from '@/src/components/CodeChangeReview';
import { RequirementDiscoveryResult } from '@/src/components/RequirementDiscoveryResult';
import { GeneratedCases } from '@/src/components/GeneratedCases';

// A request about the git codebase / recent code changes -> AI diff analysis.
// Only UNAMBIGUOUS developer/codebase vocabulary triggers this. Ambiguous everyday words
// that collide with normal TestFlow actions (e.g. "merge these suites", "what changed in my
// last run") are deliberately excluded so they reach the planner and are understood in context.
const GIT_RE = /\b(code\s*changes?|codebase|code\s*base|git\b|repositor(?:y|ies)|diff|commit|pull\s*request|source\s*code|db\s*change|schema\s*change|api\s*change)\b/i;

// A requirement-based testing request -> search the target app source, reconcile
// against existing coverage, propose gap cases. This is a heavy, niche pipeline that
// greps a specific repo, so it must be OPT-IN via an explicit phrase. It deliberately
// does NOT trigger on the everyday words "feature"/"section"/"business logic" — those
// belong to the conversational planner, which asks for the target instead of guessing.
const REQ_RE = /\brequirement[-\s]?based\b|\brequirements?\s+(?:testing|coverage|analysis|traceability|gaps?)\b/i;

// A request needs the deep pipeline (real inspect -> cases -> Playwright scripts
// -> evidence) when it targets a URL or asks for cases / scripts / automation.
const DEEP_RE = /\b(cases?|test\s*cases?|playwright|scripts?|automat\w*|e2e|end[-\s]?to[-\s]?end|screenshots?|evidence|scenarios?)\b/i;
const DOMAIN_RE = /\b((?:https?:\/\/)?(?:(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?(?:\/[^\s]*)?)/i;

function extractTargetUrl(message: string): string {
  const match = message.match(DOMAIN_RE);
  if (!match) return '';
  const raw = match[1].replace(/[),.;!?]+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isDeepRequest(text: string): boolean {
  return !!extractTargetUrl(text) || DEEP_RE.test(text);
}

// Informational / workspace queries ("how many test cases?", "list my suites",
// "which runs failed?") are NOT deep runs — they should be answered by the Supervisor
// (which calls query_workspace / reads the codebase), not trigger an inspect→generate
// pipeline asking for a target app. A request only counts as informational when it asks
// ABOUT existing artifacts without a generation/run verb and without a target URL.
const ARTIFACT_RE = /\b(test\s*cases?|cases?|suites?|plans?|runs?|scripts?|defects?|reports?|folders?)\b/i;
const ASK_RE = /\b(how many|how much|number of|count|list|show|what(?:'s| is| are| does)?|which|do i have|are there|exist|tell me|give me|status of|summary)\b/i;
const GEN_VERB_RE = /\b(generate|create|write|build|make|run|execute|automat\w*|inspect|screenshot|capture|test\s+the|check\s+the|verify|validate|add\s+\w+\s+to|new\b)\b/i;
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

function isInformationalQuery(text: string): boolean {
  const t = text || '';
  if (extractTargetUrl(t)) return false;       // a URL means they want a live run
  if (GEN_VERB_RE.test(t)) return false;        // generation/run verbs → deep/action flow
  return ASK_RE.test(t) && ARTIFACT_RE.test(t); // a question about existing artifacts
}

// App-knowledge questions ("how many features in the list view?", "what fields does the
// user form have?", "which pages need testing?") must be answered by the Supervisor, which
// reads the GIT SOURCE OF TRUTH (search_codebase / read_code_file) — NOT punted to the
// explain path that asks for a URL. Any question about app surface area, with no
// generation/run verb and no URL, routes to the Supervisor.
const APP_KNOWLEDGE_RE = /\b(features?|pages?|fields?|buttons?|columns?|views?|list\s*views?|screens?|tabs?|forms?|workflows?|modules?|endpoints?|routes?|menus?|navigation|sections?|filters?|how does|how do(?:es)? it|what does|capabilit\w+)\b/i;
function isQuestionForSupervisor(text: string): boolean {
  const t = text || '';
  if (extractTargetUrl(t)) return false;
  if (GEN_VERB_RE.test(t)) return false;
  if (isInformationalQuery(t)) return true;            // artifact counts/lists
  return ASK_RE.test(t) && APP_KNOWLEDGE_RE.test(t);   // app-surface questions → consult git
}

// When a stored website is named, route to the deep pipeline if the request is
// an actionable QA task on that site (test/check/verify/generate/explore/etc.),
// but NOT when it is a plain info question ("what is…", "tell me about…").
const CHAT_Q_RE = /\b(tell me|what(?:'s| is| are| does)|explain|describe|who\s|how (?:do|can) i|why\s|when\s|(?:list|show me)(?: the)? (?:cases?|suites?|plans?|runs?|defects?|reports?))\b/i;
const SITE_ACTION_RE = /\b(test|tests|testing|login|log\s*in|sign\s*in|works?|working|does|check|verify|validate|automat\w*|e2e|end[-\s]?to[-\s]?end|flows?|features?|scenarios?|regression|smoke|sanity|click|navigat\w*|search|export|import|filter|sort|submit|create|add|edit|update|delete|remove|upload|download|generate|cases?|coverage|inspect|explore|screenshots?|evidence|buttons?|forms?|dashboards?|modules?|functionality|workflows?|pages?)\b/i;
function siteActionable(text: string): boolean {
  return !CHAT_Q_RE.test(text || '') && SITE_ACTION_RE.test(text || '');
}
const LIST_VIEW_RE = /\blist\s*view\b|\blistview\b|\btable\b|\bgrid\b/i;
const CORE_SURFACE_RE = /\badmin\b|\bshockwave\b|\bkeystone\b|\bcore\s*platform\b/i;
const PROCEED_RE = /\b(go\s*a\s*h(?:ea|e)?d|go\s+ahead|proceed|start|run\s+it|do\s+it|do\s+that|yes|yep|ok(?:ay)?|auto)\b/i;
const CORE_LISTVIEW_PROMPT = 'test listview in end to end across admin and shockwave with as many high-value test cases as needed for strong QA confidence';
const CORE_LISTVIEW_UNDERSTANDING =
  `Here's what I understood\n` +
  `You want comprehensive end-to-end coverage for the ListView workflow, with as many high-value test cases as needed for strong QA confidence.\n\n` +
  `Target\n` +
  `admin at https://ops.acchindra.com/admin, and the related Shockwave flow if it is reachable from the same test scope.\n\n` +
  `Task\n` +
  `Create or route a QA task to design detailed E2E test coverage for ListView behavior across Admin and Shockwave.\n\n` +
  `Plan\n` +
  `Inspect the reachable ListView pages, identify core user flows and edge cases, then generate reviewed E2E test cases covering rendering, search, sorting, filtering, pagination, column behavior, row actions, empty states, error states, permissions, and cross-app consistency.`;

function isProceedLike(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  const compact = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  return PROCEED_RE.test(trimmed) || ['goahead', 'goahed', 'proceed', 'doit', 'dothat', 'start', 'runit', 'yes', 'yep', 'ok', 'okay', 'auto'].includes(compact);
}

function isCoreListViewText(text: string): boolean {
  return LIST_VIEW_RE.test(text || '') && CORE_SURFACE_RE.test(text || '');
}

function findCoreAdminWebsite(websites: Array<{ id: string; name: string; baseUrl: string }>): { id: string; name: string; baseUrl: string } | null {
  return (websites || []).find((w) => {
    const name = String(w?.name || '').toLowerCase();
    const url = String(w?.baseUrl || '').toLowerCase();
    return name === 'admin' || /\/admin\b/.test(url);
  }) || null;
}

function hasCoreListViewContext(history: Array<{ role: 'user' | 'assistant'; content: string }>): boolean {
  return isCoreListViewText(history.map((h) => h.content || '').join('\n'));
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
  | { id: string; role: 'assistant'; kind: 'cases'; cases: any[] }
  | { id: string; role: 'assistant'; kind: 'clarify'; plan: any; summary: string; confidence: number }
  | { id: string; role: 'assistant'; kind: 'folderask'; text: string; understanding?: string; originalPrompt?: string; targetUrl?: string; websiteId?: string; websiteName?: string; revisionCount?: number }
  | { id: string; role: 'assistant'; kind: 'thinking'; label: string };

type PendingDeep = {
  prompt: string;
  targetUrl: string;
  websiteId?: string;
  websiteName?: string;
  understanding: string;
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
  return `CONV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
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
      return localStorage.getItem(convKey) || makeConversationId();
    } catch {
      return makeConversationId();
    }
  });
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
  // Explicit "apps under test" selected by the user in the composer. ALL selected apps
  // are passed to the agent as target context on every request, so it always has the app
  // data and never replies "I don't have the URL / context".
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(new Set());
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pendingDeep, setPendingDeep] = useState<PendingDeep | null>(null);
  // Requirement mode: toggled with Shift+Tab. When on, every message is routed to
  // the requirement-discovery pipeline regardless of phrasing.
  const [reqMode, setReqMode] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  // Mirror the live turn list in a ref so send() can read the prior conversation
  // (for per-chat memory) without depending on a possibly-stale render closure.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  // The target (app URL / website) resolved earlier in THIS chat, so a later generation
  // request ("generate them", "for admin", "yes") reuses it without re-asking — the chat
  // remembers what it's testing, like a normal assistant.
  const convTargetRef = useRef<{ targetUrl: string; websiteId?: string; websiteName?: string } | null>(null);

  // Keep the active conversation id in localStorage (per scope) so a refresh
  // resumes the right conversation for the selected project/app.
  useEffect(() => {
    try {
      localStorage.setItem(convKey, conversationId);
    } catch {
      /* ignore */
    }
  }, [conversationId, convKey]);

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

  // Initial load: restore the active conversation + the history list.
  useEffect(() => {
    loadConversation(conversationId);
    loadConversations();
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

  // The prior turns of THIS chat, as a compact role/content transcript, so every
  // request carries conversation memory (ChatGPT/Claude-style continuity).
  const buildHistory = useCallback((): Array<{ role: 'user' | 'assistant'; content: string }> => {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const push = (content: string) => { if (content && content.trim()) out.push({ role: 'assistant', content: content.trim().slice(0, 1000) }); };
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
    folderMention?: string;
  }) => {
    const res = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_url: args.targetUrl,
        websiteId: args.websiteId || undefined,
        prompt: args.prompt,
        approvedUnderstanding: args.approvedUnderstanding || '',
        testCaseCount: parseCaseCount(args.prompt),
        flowMode: 'review_cases',
        folderMention: args.folderMention || undefined,
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
  }, [replaceTurn]);

  const requestDeepUnderstanding = useCallback(async (args: {
    prompt: string;
    targetUrl: string;
    targetName?: string;
    currentUnderstanding?: string;
    correction?: string;
  }) => {
    const res = await fetch('/api/agent/understand-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, history: buildHistory() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Failed to understand request');
    return data;
  }, [buildHistory]);

  // The apps the user explicitly selected in the composer (all of them), as target
  // context for the agent. Mirrored to a ref so callbacks read the latest without churn.
  const selectedApps = websites.filter((w) => selectedAppIds.has(w.id)).map((w) => ({ name: w.name, baseUrl: w.baseUrl }));
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
    try {
      const res = await fetch('/api/controller/supervise/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: text, workspaceId: 'default', history: buildHistory(), pageContext: { path: location.pathname }, apps: getSelectedApps() }),
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'step') setThinkingLabel(ev.text && ev.text.length < 80 ? ev.text : describeAgentStep(ev));
          else if (ev.type === 'final') finalReply = ev.reply || '';
          else if (ev.type === 'error') finalReply = ev.error || 'The agent could not complete that.';
        }
      }
      replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: cleanChat(finalReply || 'Done.') });
    } catch (err: any) {
      replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: `Something went wrong: ${err?.message || 'unknown error'}.` });
    }
  }, [buildHistory, location.pathname, replaceTurn, getSelectedApps]);

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      stopListening();
      setInput('');
      setBusy(true);

      const thinkingId = nextId();
      setTurns((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text },
        { id: thinkingId, role: 'assistant', kind: 'thinking', label: 'Understanding your request…' },
      ]);

      // A pending "Here's what I understood" card only consumes a SHORT folder-like reply
      // (a folder name, or "auto"/"proceed"). ANY other message means the user moved on or
      // is asking something new — abandon the card and route this message fresh, so a
      // follow-up question ("what else should I test?") gets a chat answer instead of being
      // swallowed as a correction. (Corrections are still possible by editing the card's box.)
      const proceedingDeep = !!pendingDeep && isLikelyFolderResponse(text);
      if (pendingDeep && !proceedingDeep) setPendingDeep(null);
      const activePending = proceedingDeep ? pendingDeep : null;

      // Informational/workspace questions ("how many test cases?", "list my suites") AND
      // app-knowledge questions ("how many features in the list view?") go to the
      // Supervisor — it answers artifact queries from the DB and app-behaviour questions by
      // reading the git source of truth (search_codebase), instead of the deep-run pipeline
      // asking "which app should I run this against?".
      if (!activePending && isQuestionForSupervisor(text)) {
        try {
          await runViaSupervisor(text, thinkingId);
        } finally {
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      const historyForRouting = buildHistory();
      const coreAdminSite = findCoreAdminWebsite(websites);
      const scopeAppUrlForRouting = (scopeApp?.baseUrl || '').trim();
      const directCoreListViewRequest =
        !activePending &&
        ((isCoreListViewText(text) && (DEEP_RE.test(text) || siteActionable(text))) ||
          (isProceedLike(text) && hasCoreListViewContext(historyForRouting)));
      if (directCoreListViewRequest) {
        const targetUrl = coreAdminSite?.baseUrl || scopeAppUrlForRouting || 'https://ops.acchindra.com/admin';
        convTargetRef.current = { targetUrl, websiteId: coreAdminSite?.id, websiteName: coreAdminSite?.name || 'admin' };
        try {
          await startDeepRun({
            thinkingId,
            prompt: isCoreListViewText(text) ? text : CORE_LISTVIEW_PROMPT,
            targetUrl,
            websiteId: coreAdminSite?.id,
            approvedUnderstanding: CORE_LISTVIEW_UNDERSTANDING,
            folderMention: isAutoFolderResponse(text) ? '' : undefined,
          });
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: `Something went wrong starting the agent: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // Requirement-based testing path: search the target app source for a feature
      // / section, reconcile against existing coverage, propose gap cases. Only when
      // no URL or stored website is referenced (those want live inspection instead).
      if (
        !activePending &&
        (reqMode || (REQ_RE.test(text) && !extractTargetUrl(text) && !findWebsiteInText(text, websites)))
      ) {
        try {
          const res = await fetch('/api/requirements/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: text, workspaceId: 'default' }),
          });
          const data = await res.json();
          if (!res.ok) {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: data?.error || 'I could not analyze that feature. Make sure the configured target repo is available.',
            });
          } else {
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'reqdiscovery', result: data });
          }
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: `Something went wrong analyzing the feature: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // Codebase path: analyze recent git changes, reconcile against existing
      // coverage, propose gap tests. Checked before the deep/URL path.
      if (GIT_RE.test(text) && !extractTargetUrl(text)) {
        try {
          const res = await fetch('/api/git-agent/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseRef: 'auto', workspaceId: 'default' }),
          });
          const data = await res.json();
          if (!res.ok) {
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
        } finally {
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      // Deep generation path: cases + Playwright scripts + evidence via the
      // multi-agent pipeline. Triggered by a URL, generation keywords, OR a
      // request to test a stored website by name. Before preparing, we ask the
      // user which folder to save the results in (unless one is mentioned).
      const promptForDeep = activePending?.prompt || text;
      const explicitUrl = activePending?.targetUrl || extractTargetUrl(promptForDeep);
      const site = activePending?.websiteId
        ? websites.find((w) => w.id === activePending.websiteId) || null
        : findWebsiteInText(promptForDeep, websites);
      // Fall back to the SELECTED project/app's base URL so a generation request in an
      // ongoing conversation ("generate the test cases") runs the full deep pipeline
      // (inspect -> cases -> scripts -> evidence) against the current app — instead of
      // dropping to the generic planner and showing a plan-card.
      const scopeAppUrl = (scopeApp?.baseUrl || '').trim();
      const explicitTarget = !!explicitUrl || !!site;
      const targetUrl = explicitUrl || (site ? '' : scopeAppUrl);
      const hasTarget = !!targetUrl || !!site;
      // A genuine case/script/automation generation request (DEEP_RE) always wants the
      // deep pipeline. When a URL/website is named explicitly, any actionable QA request
      // (test/check/verify…) can also go deep — but the selected-app fallback is reserved
      // for real generation, so plain "create a test plan/suite/run" still uses the planner.
      const isGenerationReq = DEEP_RE.test(promptForDeep);
      const wantsGeneration = isGenerationReq || (explicitTarget && siteActionable(promptForDeep));
      const isDeep = activePending ? true : (wantsGeneration && hasTarget);

      // Generation requested but no target anywhere (e.g. "All apps" selected and no URL
      // typed): ask which app/URL to run against — never fall through to the plan-card.
      if (!activePending && wantsGeneration && !hasTarget) {
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
      if (isDeep) {
        if (activePending && !isLikelyFolderResponse(text)) {
          try {
            const revised = await requestDeepUnderstanding({
              prompt: activePending.prompt,
              targetUrl: activePending.targetUrl,
              targetName: activePending.websiteName,
              currentUnderstanding: activePending.understanding,
              correction: text,
            });
            const nextPending: PendingDeep = {
              ...activePending,
              understanding: revised.understanding || activePending.understanding,
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
              originalPrompt: nextPending.prompt,
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
            setBusy(false);
            inputRef.current?.focus();
          }
          return;
        }

        // Ask for a folder first (only when we haven't already asked).
        if (!activePending) {
          const mentionsFolder = /\bfolder\b/i.test(text) || /@\w+/.test(text);
          if (!mentionsFolder) {
            const target = site ? `${site.name} (${site.baseUrl})` : targetUrl;
            const understanding =
              `Here's what I understood:\n` +
              `• Target: ${target}\n` +
              `• Task: ${promptForDeep}\n\n` +
              `Plan: log in to the target → perform the steps on the live app → verify the result → capture screenshots as evidence.`;
            let generatedUnderstanding = understanding;
            try {
              const generated = await requestDeepUnderstanding({
                prompt: promptForDeep,
                targetUrl: site ? site.baseUrl : targetUrl,
                targetName: site ? site.name : '',
              });
              generatedUnderstanding = generated.understanding || understanding;
            } catch {
              /* use deterministic fallback */
            }
            const nextPending: PendingDeep = {
              prompt: text,
              targetUrl: site ? site.baseUrl : targetUrl,
              websiteId: site ? site.id : undefined,
              websiteName: site ? site.name : undefined,
              understanding: generatedUnderstanding,
              revisionCount: 0,
            };
            setPendingDeep(nextPending);
            // Remember this chat's target so later generation requests reuse it.
            convTargetRef.current = { targetUrl: nextPending.targetUrl, websiteId: nextPending.websiteId, websiteName: nextPending.websiteName };
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'folderask',
              understanding: generatedUnderstanding,
              originalPrompt: nextPending.prompt,
              targetUrl: nextPending.targetUrl,
              websiteId: nextPending.websiteId,
              websiteName: nextPending.websiteName,
              revisionCount: 0,
              text: 'Look right? Pick a folder for the results (type a name below), or proceed with an auto-named folder.',
            });
            setBusy(false);
            inputRef.current?.focus();
            return;
          }
        }
        const folderMention = activePending
          ? (isAutoFolderResponse(text) ? '' : stripFolderPrefix(text))
          : '';
        const approvedUnderstanding = activePending?.understanding || '';
        setPendingDeep(null);
        try {
          const res = await fetch('/api/agent/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              app_url: targetUrl || (site ? site.baseUrl : ''),
              websiteId: site ? site.id : undefined,
              prompt: promptForDeep,
              approvedUnderstanding,
              testCaseCount: parseCaseCount(promptForDeep),
              flowMode: 'review_cases',
              folderMention: folderMention || undefined,
              apps: getSelectedApps(),
            }),
          });
          const data = await res.json();
          if (data?.chat_response) {
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: data.chat_response });
          } else if (data?.task_id) {
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'deeprun', taskId: data.task_id });
          } else {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: data?.error || 'I could not start the generation. Check that an AI provider key is set in Settings.',
            });
          }
        } catch (err: any) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: `Something went wrong starting the agent: ${err?.message || 'unknown error'}.`,
          });
        } finally {
          setBusy(false);
          inputRef.current?.focus();
        }
        return;
      }

      try {
        const res = await fetch('/api/controller/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userMessage: text,
            pageContext: { path: location.pathname },
            workspaceId: 'default',
            history: historyForRouting,
            apps: getSelectedApps(),
          }),
        });
        const plan = await res.json();
        if (!res.ok) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'text',
            text: plan?.error || 'Sorry, I could not process that request. Please try rephrasing it.',
          });
          return;
        }

        // If the backend's plan involves ANY test-case / script generation (regardless of
        // phrasing — "yep write them", "for admin", and even when paired with a navigate
        // step), run the full deep pipeline (inspect -> cases -> scripts -> evidence) instead
        // of EVER showing the generic plan-card. Trusts the model's classification + memory.
        const planSteps = Array.isArray(plan.steps) ? plan.steps : [];
        const GEN_KINDS = new Set(['create_cases', 'generate_script']);
        const hasGenIntent = planSteps.some((s: any) => GEN_KINDS.has(s?.intent?.kind));
        const hasPlanIntent = planSteps.some((s: any) => s?.intent?.kind === 'create_plan');
        const planText = [
          text,
          plan?.summary || '',
          ...planSteps.map((s: any) => `${s?.intent?.title || ''} ${s?.intent?.description || ''}`),
        ].join('\n');
        const shouldDeepRoutePlan = hasGenIntent || (hasPlanIntent && (isCoreListViewText(planText) || hasCoreListViewContext(historyForRouting)));
        if (shouldDeepRoutePlan) {
          // Resolve a target: the selected app, a website named in this message, or the
          // target remembered from earlier in THIS chat (so "for admin"/"yes" just works).
          const siteFromMsg = findWebsiteInText(text, websites);
          const fallbackAdminSite = findCoreAdminWebsite(websites);
          const pivotUrl = scopeAppUrl || (siteFromMsg ? siteFromMsg.baseUrl : '') || convTargetRef.current?.targetUrl || fallbackAdminSite?.baseUrl || '';
          const pivotWebsiteId = siteFromMsg?.id || convTargetRef.current?.websiteId || fallbackAdminSite?.id;
          if (!pivotUrl && !pivotWebsiteId) {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: 'Which app should I run this against? Select an app in the project switcher (top bar) so I can use its URL — then I will inspect it, generate the cases and Playwright scripts, and capture evidence.',
            });
            setBusy(false);
            inputRef.current?.focus();
            return;
          }
          convTargetRef.current = { targetUrl: pivotUrl, websiteId: pivotWebsiteId, websiteName: siteFromMsg?.name || fallbackAdminSite?.name };
          const genScopeFromPlan = planSteps
            .filter((s: any) => GEN_KINDS.has(s?.intent?.kind))
            .map((s: any) => s?.intent?.description || s?.intent?.title)
            .filter(Boolean).join('. ').trim() || plan.summary || text;
          const genScope = hasGenIntent ? genScopeFromPlan : CORE_LISTVIEW_PROMPT;
          const approvedUnderstanding = !hasGenIntent && (isCoreListViewText(planText) || hasCoreListViewContext(historyForRouting))
            ? CORE_LISTVIEW_UNDERSTANDING
            : '';
          try {
            await startDeepRun({
              thinkingId,
              targetUrl: pivotUrl,
              websiteId: pivotWebsiteId,
              prompt: genScope,
              approvedUnderstanding,
            });
          } catch (err: any) {
            replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: `Something went wrong starting the run: ${err?.message || 'unknown error'}.` });
          } finally {
            setBusy(false);
            inputRef.current?.focus();
          }
          return;
        }

        if (planIsChatOnly(plan)) {
          // Pure question / chat — stream the answer token-by-token.
          const fallbackText = 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.';
          replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: '' });
          try {
            const histForExplain = historyForRouting;
            const ans = await fetch('/api/controller/explain/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ topic: text, workspaceId: 'default', history: histForExplain, apps: getSelectedApps() }),
            });
            if (!ans.ok || !ans.body) {
              const data = await fetch('/api/controller/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

        // Ambiguous request: confirm the interpretation before acting.
        if (planConfidence(plan) < CLARIFY_THRESHOLD) {
          replaceTurn(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            kind: 'clarify',
            plan,
            summary: plan.summary || 'do that',
            confidence: planConfidence(plan),
          });
        } else {
          replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'plan', plan });
        }
      } catch (err: any) {
        replaceTurn(thinkingId, {
          id: thinkingId,
          role: 'assistant',
          kind: 'text',
          text: `Something went wrong: ${err?.message || 'unknown error'}. Check that an AI provider key is configured in Settings.`,
        });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [input, busy, location.pathname, stopListening, replaceTurn, requestDeepUnderstanding, reqMode, pendingDeep, websites, scopeApp, buildHistory, startDeepRun, runViaSupervisor, getSelectedApps],
  );

  // Start the deep run directly from a "Here's what I understood" card's OWN stored data
  // (understanding + target), independent of the volatile pendingDeep state. This keeps
  // the Proceed buttons working even if the user typed other messages after the card
  // appeared (which clears pendingDeep), so they never misfire into the planner.
  const proceedDeepFromTurn = useCallback(
    async (turn: { id: string; understanding?: string; originalPrompt?: string; targetUrl?: string; websiteId?: string }, folderName?: string) => {
      if (busy) return;
      setBusy(true);
      setPendingDeep(null);
      if (turn.targetUrl || turn.websiteId) convTargetRef.current = { targetUrl: turn.targetUrl || '', websiteId: turn.websiteId };
      replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'thinking', label: 'Starting the run…' });
      try {
        const res = await fetch('/api/agent/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_url: turn.targetUrl || '',
            websiteId: turn.websiteId || undefined,
            prompt: turn.originalPrompt || '',
            approvedUnderstanding: turn.understanding || '',
            testCaseCount: parseCaseCount(turn.originalPrompt || ''),
            flowMode: 'review_cases',
            folderMention: folderName || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.task_id) {
          replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'deeprun', taskId: data.task_id });
        } else if (data?.chat_response) {
          replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: data.chat_response });
        } else {
          replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: data?.error || 'I could not start the run. Check that an AI provider key is set in Settings.' });
        }
      } catch (err: any) {
        replaceTurn(turn.id, { id: turn.id, role: 'assistant', kind: 'text', text: `Something went wrong starting the run: ${err?.message || 'unknown error'}.` });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, replaceTurn],
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
            <p className="text-xs text-[var(--text-muted)]">Tell the AI what to do. It plans, you approve, it runs.</p>
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
                  {conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => switchConversation(c.id)}
                      className={cn(
                        'flex w-full items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--bg-secondary)]',
                        c.id === conversationId && 'bg-[var(--accent)]/5',
                      )}
                    >
                      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{c.title || 'Untitled chat'}</span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {c.turnCount} message{c.turnCount === 1 ? '' : 's'} · {new Date(c.updatedAt).toLocaleString()}
                        </span>
                      </span>
                    </button>
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
                return (
                  <div key={turn.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2.5 text-sm text-white">
                      {turn.text}
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
                        <RequirementDiscoveryResult result={turn.result} />
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
                            onChange={(e) => {
                              const nextUnderstanding = e.target.value;
                              setTurns((prev) => prev.map((item) => (
                                item.id === turn.id && item.role === 'assistant' && item.kind === 'folderask'
                                  ? { ...item, understanding: nextUnderstanding }
                                  : item
                              )));
                              setPendingDeep((prev) => (prev ? { ...prev, understanding: nextUnderstanding } : prev));
                            }}
                            className="mb-2 min-h-[150px] w-full resize-y whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-sans text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          />
                        )}
                        <p className="text-[var(--text-primary)]">{turn.text}</p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <button
                            onClick={() => proceedDeepFromTurn(turn)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                          >
                            <Sparkles className="h-3.5 w-3.5" /> Proceed (auto folder)
                          </button>
                          <button
                            onClick={() => proceedDeepFromTurn(turn)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/15"
                          >
                            <Wand2 className="h-3.5 w-3.5" /> Use edited understanding
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
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
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
              <div className="relative">
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
                      websites.map((w) => {
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
                      })
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
              <button
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span className="hidden sm:inline">Send</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
