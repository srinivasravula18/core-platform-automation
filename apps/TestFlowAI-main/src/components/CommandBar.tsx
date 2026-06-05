import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Search, Command, Loader2, ArrowRight, Bot, LayoutDashboard, TestTube2, Bug, BrainCircuit, PlayCircle, FolderTree, Layers, ClipboardList, GitBranch, Settings, Sparkles } from 'lucide-react';
import { WorkflowRunner } from '@/src/components/WorkflowRunner';

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
  { name: 'Dashboard', href: '/', icon: LayoutDashboard, keywords: 'home dashboard' },
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
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const classifyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filteredCommands = input
    ? NAV_COMMANDS.filter((cmd) => {
        const q = input.toLowerCase();
        return cmd.name.toLowerCase().includes(q) || cmd.keywords.includes(q) || cmd.href.includes(q);
      })
    : NAV_COMMANDS;

  const close = useCallback(() => {
    onOpenChange(false);
    setInput('');
    setMode('command');
    setPlan(null);
    setClassifyResult(null);
    setError('');
  }, [onOpenChange]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onOpenChange(!isOpen);
        setInput('');
        setMode('command');
        setPlan(null);
      }
      if (e.key === 'Escape' && isOpen) {
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close, onOpenChange]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && input && mode === 'command') {
      const isAiRequest = input.length > 15 || /create|generate|analyze|triage|rework|expand|explain|make|build|file|schedule/i.test(input);
      const hasNavMatch = filteredCommands.length > 0;
      if (isAiRequest && !hasNavMatch) {
        setMode('ai');
        setClassifying(true);
        setError('');
        if (classifyTimeoutRef.current) clearTimeout(classifyTimeoutRef.current);
        classifyTimeoutRef.current = setTimeout(() => {
          fetch('/api/controller/classify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMessage: input, workspaceId: 'default' }),
          })
            .then((r) => r.json())
            .then((data: any) => {
              if (data?.intents?.length) {
                setClassifyResult(data);
              } else {
                setClassifyResult(null);
                setError(data?.error || 'Could not classify request');
              }
            })
            .catch((err) => {
              setError(err.message);
              setClassifyResult(null);
            })
            .finally(() => setClassifying(false));
        }, 400);
        return () => {
          if (classifyTimeoutRef.current) clearTimeout(classifyTimeoutRef.current);
        };
      } else {
        setMode('command');
        setClassifyResult(null);
        setError('');
      }
    }
  }, [input, isOpen, filteredCommands.length]);

  const handleAction = useCallback(async (action: string) => {
    if (action === 'create_plan') {
      setMode('plan');
      setClassifying(true);
      try {
        const r = await fetch('/api/controller/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userMessage: input, workspaceId: 'default' }),
        });
        const data = await r.json();
        setPlan(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setClassifying(false);
      }
    }
  }, [input]);

  const executePlan = useCallback(async (planId: string, opts?: { approveAll?: boolean }) => {
    try {
      const r = await fetch(`/api/controller/plans/${planId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts || {}),
      });
      const data = await r.json();
      setPlan(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const cancelPlan = useCallback(async (planId: string) => {
    try {
      const r = await fetch(`/api/controller/plans/${planId}/cancel`, { method: 'POST' });
      const data = await r.json();
      setPlan(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const navigateTo = useCallback((href: string) => {
    close();
    navigate(href);
  }, [close, navigate]);

  const handleSubmit = useCallback(() => {
    if (!input.trim()) return;
    if (mode === 'command' && filteredCommands.length > 0) {
      navigateTo(filteredCommands[0].href);
    } else if (classifyResult) {
      setMode('plan');
      setClassifying(true);
      fetch('/api/controller/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: input, workspaceId: 'default' }),
      })
        .then((r) => r.json())
        .then((data) => {
          setPlan(data);
        })
        .catch((err) => setError(err.message))
        .finally(() => setClassifying(false));
    } else {
      setMode('ai');
      setClassifying(true);
      fetch('/api/controller/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: input, workspaceId: 'default' }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.intents?.length) {
            setClassifyResult(data);
          } else {
            setError(data?.error || 'Could not classify request');
          }
        })
        .catch((err) => setError(err.message))
        .finally(() => setClassifying(false));
    }
  }, [input, mode, filteredCommands, classifyResult, navigateTo]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh]">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={close} />
      <div className="relative w-full max-w-2xl mx-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="relative flex items-center border-b border-[var(--border)]">
          {mode === 'plan' ? (
            <Bot className="absolute left-4 w-4 h-4 text-[var(--accent)]" />
          ) : (
            <Search className="absolute left-4 w-4 h-4 text-[var(--text-muted)]" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
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

        <div className="max-h-80 overflow-y-auto p-2">
          {mode === 'command' && !classifying && (
            <div className="space-y-0.5">
              {filteredCommands.length > 0 ? (
                filteredCommands.map((cmd) => (
                  <button
                    key={cmd.href}
                    onClick={() => navigateTo(cmd.href)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    <cmd.icon className="w-4 h-4 text-[var(--text-muted)]" />
                    <span>{cmd.name}</span>
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">{cmd.href}</span>
                  </button>
                ))
              ) : (
                <button
                  onClick={() => setMode('ai')}
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
              {classifyResult && !classifying && (
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
                      onClick={handleSubmit}
                      className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 text-xs font-medium transition-colors"
                    >
                      Create Plan
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
