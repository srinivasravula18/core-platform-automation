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
  RotateCcw,
  Code2,
  Layers,
  Image as ImageIcon,
  Wand2,
  History,
  MessageSquare,
  Target,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
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

// When a stored website is named, route to the deep pipeline if the request is
// an actionable QA task on that site (test/check/verify/generate/explore/etc.),
// but NOT when it is a plain info question ("what is…", "tell me about…").
const CHAT_Q_RE = /\b(tell me|what(?:'s| is| are| does)|explain|describe|who\s|how (?:do|can) i|why\s|when\s|(?:list|show me)(?: the)? (?:cases?|suites?|plans?|runs?|defects?|reports?))\b/i;
const SITE_ACTION_RE = /\b(test|tests|testing|login|log\s*in|sign\s*in|works?|working|does|check|verify|validate|automat\w*|e2e|end[-\s]?to[-\s]?end|flows?|features?|scenarios?|regression|smoke|sanity|click|navigat\w*|search|export|import|filter|sort|submit|create|add|edit|update|delete|remove|upload|download|generate|cases?|coverage|inspect|explore|screenshots?|evidence|buttons?|forms?|dashboards?|modules?|functionality|workflows?|pages?)\b/i;
function siteActionable(text: string): boolean {
  return !CHAT_Q_RE.test(text || '') && SITE_ACTION_RE.test(text || '');
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

function parseCaseCount(text: string): number {
  const m = text.match(/(\d{1,3})\s*(?:test\s*)?(?:cases?|scenarios?|scripts?)/i);
  if (!m) return 3;
  return Math.min(10, Math.max(1, parseInt(m[1], 10) || 3));
}

/**
 * Agent Console — the single, conversational home of TestFlowAI.
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
  | { id: string; role: 'assistant'; kind: 'folderask'; text: string }
  | { id: string; role: 'assistant'; kind: 'thinking'; label: string };

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

const CONV_KEY = 'tfa_active_conversation';
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => {
    try {
      return localStorage.getItem(CONV_KEY) || makeConversationId();
    } catch {
      return makeConversationId();
    }
  });
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [websites, setWebsites] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
  const [pendingDeep, setPendingDeep] = useState<string | null>(null);
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

  // Keep the active conversation id in localStorage so a refresh resumes it.
  useEffect(() => {
    try {
      localStorage.setItem(CONV_KEY, conversationId);
    } catch {
      /* ignore */
    }
  }, [conversationId]);

  const loadConversations = useCallback(async () => {
    try {
      const r = await fetch('/api/chat/conversations?workspaceId=default');
      const d = await r.json();
      setConversations(Array.isArray(d.conversations) ? d.conversations : []);
    } catch {
      /* ignore */
    }
  }, []);

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
        body: JSON.stringify({ workspaceId: 'default', title: firstUser?.text?.slice(0, 80) || 'New chat', turns: clean }),
      })
        .then(() => loadConversations())
        .catch(() => {});
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [turns, conversationId, loadConversations]);

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

      // Requirement-based testing path: search the target app source for a feature
      // / section, reconcile against existing coverage, propose gap cases. Only when
      // no URL or stored website is referenced (those want live inspection instead).
      if (
        !pendingDeep &&
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
              text: data?.error || 'I could not analyze that feature. Make sure the target repo (D:\\core-platform) is available.',
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
      const promptForDeep = pendingDeep || text;
      const targetUrl = extractTargetUrl(promptForDeep);
      const site = findWebsiteInText(promptForDeep, websites);
      // The deep pipeline (real inspect -> cases -> Playwright scripts -> evidence) can only
      // act when there is a concrete target to drive. Require a URL or a known website AND an
      // actionable QA request. With no target we fall through to the planner, which asks for
      // the URL instead of kicking off a deep run against nothing.
      const hasTarget = !!targetUrl || !!site;
      const isDeep = pendingDeep ? true : (hasTarget && (siteActionable(promptForDeep) || isDeepRequest(promptForDeep)));
      if (isDeep) {
        // Ask for a folder first (only when we haven't already asked).
        if (!pendingDeep) {
          const mentionsFolder = /\bfolder\b/i.test(text) || /@\w+/.test(text);
          if (!mentionsFolder) {
            setPendingDeep(text);
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'folderask',
              text: 'Before I prepare these, which folder should I save them in? Type a folder name below, or let me auto-generate one.',
            });
            setBusy(false);
            inputRef.current?.focus();
            return;
          }
        }
        const folderMention = pendingDeep
          ? (/^(auto|automatic|you\s+decide|any|organi[sz]e)\b/i.test(text.trim()) ? '' : text.trim())
          : '';
        setPendingDeep(null);
        try {
          const res = await fetch('/api/agent/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              app_url: extractTargetUrl(promptForDeep) || (site ? site.baseUrl : ''),
              websiteId: site ? site.id : undefined,
              provider: 'gemini',
              prompt: promptForDeep,
              testCaseCount: parseCaseCount(promptForDeep),
              flowMode: 'review_cases',
              folderMention: folderMention || undefined,
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

        if (planIsChatOnly(plan)) {
          // Pure question / chat — stream the answer token-by-token.
          const fallbackText = 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.';
          replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'text', text: '' });
          try {
            const ans = await fetch('/api/controller/explain/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ topic: text, workspaceId: 'default' }),
            });
            if (!ans.ok || !ans.body) {
              const data = await fetch('/api/controller/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: text, workspaceId: 'default' }),
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
    [input, busy, location.pathname, stopListening, replaceTurn, reqMode, pendingDeep, websites],
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
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
            <BrainCircuit className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-[var(--text-primary)]">Agent Console</h1>
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
            <RotateCcw className="h-3.5 w-3.5" /> New
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
            <div className="mt-7 grid w-full max-w-5xl grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
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

            <div className="mt-8 w-full max-w-5xl">
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
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                    {turn.label}
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
                        <p className="text-[var(--text-primary)]">{turn.text}</p>
                        <div className="mt-2.5">
                          <button
                            onClick={() => send('auto')}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                          >
                            <Sparkles className="h-3.5 w-3.5" /> Auto-generate folder name
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
