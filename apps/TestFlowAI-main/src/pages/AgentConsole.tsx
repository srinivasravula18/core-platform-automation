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
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useSpeechToText } from '@/src/lib/useSpeechToText';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';
import { DeepRunResult } from '@/src/components/DeepRunResult';
import { CodeChangeReview } from '@/src/components/CodeChangeReview';

// A request about the git codebase / recent code changes -> AI diff analysis.
const GIT_RE = /\b(code\s*change|codebase|code\s*base|git\b|repo(sitory)?|diff|commit|pull\s*request|\bpr\b|merged?|recent\s*change|what\s*changed|source\s*code|db\s*change|schema\s*change|api\s*change)\b/i;

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
  if (!parts.length) return 'Done — I finished the plan. Anything that needs your sign-off is in the AI Inbox (top-right).';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.slice(-1)}`;
  return `Done — I created ${list}. They're waiting in your AI Inbox (top-right) for your approval.`;
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
      // multi-agent pipeline. Used whenever the request targets a URL or asks
      // for cases / scripts / automation.
      if (isDeepRequest(text)) {
        try {
          const res = await fetch('/api/agent/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              app_url: extractTargetUrl(text),
              provider: 'gemini',
              prompt: text,
              testCaseCount: parseCaseCount(text),
              flowMode: 'review_cases',
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
          // Pure question / chat — fetch a direct answer instead of a workflow card.
          replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'thinking', label: 'Thinking…' });
          try {
            const ans = await fetch('/api/controller/explain', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ topic: text, workspaceId: 'default' }),
            });
            const data = await ans.json();
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: data?.answer || plan?.summary || 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.',
            });
          } catch {
            replaceTurn(thinkingId, {
              id: thinkingId,
              role: 'assistant',
              kind: 'text',
              text: plan?.summary || 'I can help you create test plans, cases, runs, defects, and reports. Tell me what you want to do.',
            });
          }
          return;
        }

        replaceTurn(thinkingId, { id: thinkingId, role: 'assistant', kind: 'plan', plan });
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
    [input, busy, location.pathname, stopListening, replaceTurn],
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
          setTurns((prev) => [
            ...prev,
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
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-2 shadow-sm focus-within:border-[var(--accent)] transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
              {isListening || interimTranscript || speechError ? (
                <span className={cn(speechError ? 'text-red-400' : 'text-[var(--text-muted)]')}>
                  {speechError || (interimTranscript ? `Listening: ${interimTranscript}` : 'Listening…')}
                </span>
              ) : (
                <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
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
