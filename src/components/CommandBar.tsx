import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Command, Loader2, ArrowRight, Bot, LayoutDashboard, TestTube2, Bug, BrainCircuit, PlayCircle, FolderTree, Layers, ClipboardList, GitBranch, Settings, Sparkles } from 'lucide-react';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';
import { useProjects } from '@/src/store/project';
import { navigationHref } from '@/src/lib/controllerIntent';

interface PlanStep {
  id: string;
  index: number;
  intent: any;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  result?: any;
  error?: string;
  inboxItemId?: string;
}

interface Plan {
  id: string;
  userMessage: string;
  summary: string;
  reasoning: string;
  steps: PlanStep[];
  estimatedCostUsd: number;
  createdAt: string;
  status: string;
  workspaceId: string;
  userId?: string;
}

interface ClassifyResult {
  intents: any[];
  summary: string;
  reasoning: string;
  rawText: string;
}

const NAV_COMMANDS = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, keywords: 'home dashboard' },
  { name: 'Plans', href: '/plans', icon: FolderTree, keywords: 'plan test plan' },
  { name: 'Suites', href: '/suites', icon: Layers, keywords: 'suite test suite' },
  { name: 'Cases', href: '/cases', icon: TestTube2, keywords: 'case test case' },
  { name: 'Runs', href: '/runs', icon: PlayCircle, keywords: 'run test run execution' },
  { name: 'Reports', href: '/reports', icon: ClipboardList, keywords: 'report' },
  { name: 'Defects', href: '/defects', icon: Bug, keywords: 'defect bug issue' },
  { name: 'AI Agent', href: '/agent', icon: BrainCircuit, keywords: 'ai agent assistant chat' },
  { name: 'Git Agent', href: '/git-agent', icon: GitBranch, keywords: 'git repository repo' },
  { name: 'File System', href: '/repository', icon: FolderTree, keywords: 'file folder repo repository test repository' },
  { name: 'Settings', href: '/settings', icon: Settings, keywords: 'settings config configuration' },
];

interface CommandBarProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandBar({ isOpen, onOpenChange }: CommandBarProps) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'command' | 'ai' | 'plan'>('command');
  const [classifying, setClassifying] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const selectedProjectId = useProjects((state) => state.selectedProjectId);
  const selectedAppId = useProjects((state) => state.selectedAppId);
  const selectedAppName = useProjects((state) => state.selectedApp()?.name || '');
  const selectedAppUrl = useProjects((state) => state.selectedApp()?.baseUrl || '');
  const workspaceId = `${selectedProjectId || 'none'}::${selectedAppId || 'all'}`;

  const filteredCommands = input
    ? NAV_COMMANDS.filter((cmd) => {
        const q = input.toLowerCase();
        return cmd.name.toLowerCase().includes(q) || cmd.keywords.includes(q) || cmd.href.includes(q);
      })
    : NAV_COMMANDS;

  const reset = useCallback(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setInput('');
    setMode('command');
    setClassifying(false);
    setPlan(null);
    setClassifyResult(null);
    setAnswer('');
    setError('');
    setActiveIndex(0);
  }, []);

  const close = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [onOpenChange, reset]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (e.repeat) return;
        if (isOpen) close();
        else {
          reset();
          onOpenChange(true);
        }
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close, onOpenChange, reset]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    document.body.style.overflow = 'hidden';
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen]);

  const executePlan = useCallback(async (planId: string, opts?: { approveAll?: boolean }) => {
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    try {
      const r = await fetch(`/api/controller/plans/${planId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts || {}),
        signal: controller.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      if (requestAbortRef.current !== controller) return;
      setPlan(data);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err.message);
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }, []);

  const cancelPlan = useCallback(async (planId: string) => {
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    try {
      const r = await fetch(`/api/controller/plans/${planId}/cancel`, { method: 'POST', signal: controller.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      if (requestAbortRef.current !== controller) return;
      setPlan(data);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err.message);
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }, []);

  const navigateTo = useCallback((href: string) => {
    close();
    navigate(href);
  }, [close, navigate]);

  const handleSubmit = useCallback(async () => {
    const query = input.trim();
    if (!query || classifying) return;
    if (mode === 'command' && filteredCommands.length > 0) {
      navigateTo(filteredCommands[Math.min(activeIndex, filteredCommands.length - 1)].href);
      return;
    }

    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    setClassifying(true);
    setError('');

    try {
      if (classifyResult) {
        const navigation = classifyResult.intents.length === 1 && classifyResult.intents[0]?.kind === 'navigate'
          ? classifyResult.intents[0]
          : null;
        if (navigation) {
          navigateTo(navigationHref(navigation, query));
          return;
        }
        setMode('plan');
        const r = await fetch('/api/controller/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userMessage: query,
            workspaceId,
            pageContext: { path: location.pathname },
            apps: selectedAppUrl ? [{ name: selectedAppName || selectedAppUrl, baseUrl: selectedAppUrl }] : [],
          }),
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
        if (requestAbortRef.current === controller) setPlan(data);
      } else {
        setMode('ai');
        const r = await fetch('/api/controller/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userMessage: query,
            workspaceId,
            pageContext: { path: location.pathname },
            apps: selectedAppUrl ? [{ name: selectedAppName || selectedAppUrl, baseUrl: selectedAppUrl }] : [],
          }),
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
        if (requestAbortRef.current !== controller) return;
        if (!data?.intents?.length) throw new Error(data?.error || 'Could not classify request');
        setClassifyResult(data);
        if (data.intents.every((intent: any) => intent?.kind === 'explain' || intent?.kind === 'unknown')) {
          const answerResponse = await fetch('/api/controller/explain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              topic: query,
              workspaceId,
              pageContext: { path: location.pathname },
              apps: selectedAppUrl ? [{ name: selectedAppName || selectedAppUrl, baseUrl: selectedAppUrl }] : [],
            }),
            signal: controller.signal,
          });
          const answerData = await answerResponse.json();
          if (!answerResponse.ok) throw new Error(answerData?.error || `Request failed (${answerResponse.status})`);
          if (requestAbortRef.current === controller) setAnswer(answerData?.answer || data.summary);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || requestAbortRef.current !== controller) return;
      setClassifyResult(null);
      setError(err.message || 'Request failed');
    } finally {
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
        setClassifying(false);
      }
    }
  }, [input, classifying, mode, filteredCommands, activeIndex, classifyResult, navigateTo, workspaceId, location.pathname, selectedAppName, selectedAppUrl]);

  const handleInputChange = (value: string) => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setInput(value);
    setActiveIndex(0);
    setMode('command');
    setClassifying(false);
    setClassifyResult(null);
    setAnswer('');
    setError('');
  };

  const navigationIntent = classifyResult?.intents.length === 1 && classifyResult.intents[0]?.kind === 'navigate'
    ? classifyResult.intents[0]
    : null;
  const navigationLabel = navigationIntent
    ? `Open ${NAV_COMMANDS.find((command) => command.href === navigationIntent.params?.path)?.name || 'page'}`
    : 'Create Plan';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={close} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="relative flex max-h-[80dvh] w-full max-w-2xl flex-col bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="relative flex flex-shrink-0 items-center border-b border-[var(--border)]">
          {mode === 'plan' ? (
            <Bot className="absolute left-4 w-4 h-4 text-[var(--accent)]" />
          ) : (
            <Search className="absolute left-4 w-4 h-4 text-[var(--text-muted)]" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (mode === 'command' && filteredCommands.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const direction = e.key === 'ArrowDown' ? 1 : -1;
                setActiveIndex((current) => (current + direction + filteredCommands.length) % filteredCommands.length);
              } else if (e.key === 'Enter' && !e.repeat) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            aria-activedescendant={mode === 'command' && filteredCommands.length ? `command-option-${activeIndex}` : undefined}
            aria-controls="command-results"
            aria-expanded="true"
            aria-autocomplete="list"
            role="combobox"
            placeholder={mode === 'plan' ? 'Plan created. Review below.' : mode === 'ai' ? 'Describe what you want to do...' : 'Type a command or ask AI...'}
            className="w-full bg-transparent pl-11 pr-12 py-3.5 text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-muted)]"
            disabled={mode === 'plan'}
          />
          <div className="absolute right-3 flex items-center gap-2">
            {classifying && <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />}
            {!classifying && mode === 'command' && (
              <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                <Command className="w-2.5 h-2.5" />K
              </kbd>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {mode === 'command' && !classifying && (
            <div id="command-results" role="listbox" className="space-y-0.5">
              {filteredCommands.length > 0 ? (
                filteredCommands.map((cmd, index) => (
                  <button
                    key={cmd.href}
                    id={`command-option-${index}`}
                    role="option"
                    aria-selected={cmd.href === filteredCommands[activeIndex]?.href}
                    onClick={() => navigateTo(cmd.href)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-[var(--text-primary)] transition-colors ${cmd.href === filteredCommands[activeIndex]?.href ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
                  >
                    <cmd.icon className="w-4 h-4 text-[var(--text-muted)]" />
                    <span>{cmd.name}</span>
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">{cmd.href}</span>
                  </button>
                ))
              ) : (
                <button
                  onClick={() => void handleSubmit()}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <Sparkles className="w-4 h-4 text-[var(--accent)]" />
                  <span>Ask AI about "{input}"</span>
                  <ArrowRight className="w-3.5 h-3.5 ml-auto text-[var(--text-muted)]" />
                </button>
              )}
            </div>
          )}

          {mode === 'ai' && !plan && (
            <div className="p-3">
              {error && (
                <div className="text-xs text-red-400 mb-3 p-2 rounded-md bg-red-500/10">{error}</div>
              )}
              {classifying && (
                <div className="flex items-center gap-3 text-sm text-[var(--text-muted)] py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Analyzing request...</span>
                </div>
              )}
              {answer && !classifying && (
                <div className="space-y-4" role="status">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">{answer}</p>
                  <button
                    onClick={close}
                    className="rounded-md border border-[var(--border)] px-4 py-2 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    Close
                  </button>
                </div>
              )}
              {classifyResult && !answer && !classifying && (
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{classifyResult.summary}</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">{classifyResult.reasoning}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {classifyResult.intents.map((intent, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2 bg-[var(--bg-secondary)]">
                        <div className="w-5 h-5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] flex items-center justify-center text-[10px] font-bold">{i + 1}</div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--text-primary)]">{intent.title}</div>
                          {intent.description && (
                            <div className="text-[10px] text-[var(--text-muted)] truncate">{intent.description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-[var(--text-muted)]">{intent.confidence}%</span>
                          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{intent.kind}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => void handleSubmit()}
                      className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 text-xs font-medium transition-colors"
                    >
                      {navigationLabel}
                    </button>
                    <button
                      onClick={close}
                      className="rounded-md border border-[var(--border)] px-4 py-2 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'plan' && (
            <div className="p-3">
              {classifying && (
                <div className="flex items-center gap-3 text-sm text-[var(--text-muted)] py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Building plan...</span>
                </div>
              )}
              {error && (
                <div className="text-xs text-red-400 mb-3 p-2 rounded-md bg-red-500/10">{error}</div>
              )}
              {plan && (
                <WorkflowRunner
                  plan={plan}
                  onExecutePlan={executePlan}
                  onCancelPlan={cancelPlan}
                  onClose={close}
                  showClose
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
