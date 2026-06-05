import { useState } from 'react';
import { cn } from '@/src/lib/utils';
import { CheckCircle2, Circle, Loader2, XCircle, AlertCircle, Play, Ban, FileText, Layers, Bug, TestTube2, PlayCircle, ClipboardList, Bot, FolderTree } from 'lucide-react';

interface SideEffect {
  type: 'read' | 'create' | 'update' | 'delete' | 'navigate' | 'run_workflow';
  entity?: string;
  label: string;
  path?: string;
  requiresApproval?: boolean;
}

interface IntentDraft {
  kind: string;
  confidence: number;
  agent: string;
  title: string;
  description: string;
  params: Record<string, any>;
  sideEffects: SideEffect[];
  estimatedCostUsd: number;
}

interface PlanStep {
  id: string;
  index: number;
  intent: IntentDraft;
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';
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
  status: 'draft' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  workspaceId: string;
  userId?: string;
}

interface WorkflowRunnerProps {
  plan: Plan;
  onExecutePlan?: (planId: string, options?: { approveAll?: boolean }) => void;
  onCancelPlan?: (planId: string) => void;
  onClose?: () => void;
  compact?: boolean;
  showClose?: boolean;
  className?: string;
}

function StatusIcon({ status, className }: { status: PlanStep['status']; className?: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={cn('w-4 h-4 text-emerald-500', className)} />;
    case 'running':
      return <Loader2 className={cn('w-4 h-4 animate-spin text-[var(--accent)]', className)} />;
    case 'failed':
      return <XCircle className={cn('w-4 h-4 text-red-500', className)} />;
    case 'cancelled':
      return <Ban className={cn('w-4 h-4 text-slate-400', className)} />;
    case 'skipped':
      return <AlertCircle className={cn('w-4 h-4 text-slate-400', className)} />;
    case 'awaiting_approval':
      return <AlertCircle className={cn('w-4 h-4 text-amber-400', className)} />;
    default:
      return <Circle className={cn('w-4 h-4 text-[var(--text-muted)]', className)} />;
  }
}

function IntentIcon({ kind, className }: { kind: string; className?: string }) {
  switch (kind) {
    case 'navigate': return <FileText className={cn('w-4 h-4', className)} />;
    case 'create_plan': return <FileText className={cn('w-4 h-4 text-blue-400', className)} />;
    case 'create_suite': return <Layers className={cn('w-4 h-4 text-purple-400', className)} />;
    case 'create_cases': return <TestTube2 className={cn('w-4 h-4 text-emerald-400', className)} />;
    case 'expand_case_steps': return <TestTube2 className={cn('w-4 h-4 text-teal-400', className)} />;
    case 'rework_case': return <TestTube2 className={cn('w-4 h-4 text-amber-400', className)} />;
    case 'create_run': return <PlayCircle className={cn('w-4 h-4 text-sky-400', className)} />;
    case 'create_defect': return <Bug className={cn('w-4 h-4 text-red-400', className)} />;
    case 'generate_script': return <Bot className={cn('w-4 h-4 text-indigo-400', className)} />;
    case 'generate_report': return <ClipboardList className={cn('w-4 h-4 text-orange-400', className)} />;
    case 'analyze_run': return <PlayCircle className={cn('w-4 h-4', className)} />;
    case 'triage_defect': return <Bug className={cn('w-4 h-4', className)} />;
    case 'create_folder': return <FolderTree className={cn('w-4 h-4 text-cyan-400', className)} />;
    case 'resolve_credentials': return <FileText className={cn('w-4 h-4', className)} />;
    case 'set_autonomy': return <FileText className={cn('w-4 h-4', className)} />;
    default: return <Circle className={cn('w-4 h-4', className)} />;
  }
}

function getStatusBadgeColor(status: Plan['status']): string {
  switch (status) {
    case 'awaiting_approval': return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'running': return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
    case 'completed': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    case 'failed': return 'bg-red-500/10 text-red-400 border-red-500/20';
    case 'cancelled': return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    case 'draft': return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    default: return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
  }
}

export function WorkflowRunner({ plan, onExecutePlan, onCancelPlan, onClose, compact, showClose, className }: WorkflowRunnerProps) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const completedSteps = plan.steps.filter((s) => s.status === 'completed').length;
  const totalSteps = plan.steps.length;
  const progressPct = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return (
    <div className={cn('flex flex-col', className)}>
      <div className={cn('flex items-start justify-between gap-3', compact ? 'mb-2' : 'mb-4')}>
        <div className="min-w-0 flex-1">
          <h3 className={cn('font-semibold text-[var(--text-primary)]', compact ? 'text-sm' : 'text-base')}>{plan.summary || plan.userMessage}</h3>
          {plan.reasoning && !compact && (
            <p className="mt-1 text-xs text-[var(--text-muted)] leading-relaxed">{plan.reasoning}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn('rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', getStatusBadgeColor(plan.status))}>
            {plan.status.replace(/_/g, ' ')}
          </span>
          {showClose && onClose && (
            <button onClick={onClose} className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors">
              <XCircle className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {!compact && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {completedSteps}/{totalSteps} steps · ${plan.estimatedCostUsd.toFixed(3)} est.
            </span>
          </div>
          <div className="h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', plan.status === 'failed' ? 'bg-red-500' : plan.status === 'completed' ? 'bg-emerald-500' : 'bg-[var(--accent)]')}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {plan.steps.map((step) => (
          <div key={step.id}>
            <button
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
              className={cn(
                'w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                step.status === 'completed' ? 'border-emerald-500/20 bg-emerald-500/5' :
                step.status === 'failed' ? 'border-red-500/20 bg-red-500/5' :
                step.status === 'running' ? 'border-[var(--accent)]/20 bg-[var(--accent)]/5' :
                step.status === 'cancelled' ? 'border-slate-500/10 bg-slate-500/5 opacity-60' :
                'border-[var(--border)] hover:border-[var(--accent)]/30 hover:bg-[var(--bg-secondary)]'
              )}
            >
              <StatusIcon status={step.status} />
              <IntentIcon kind={step.intent.kind} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">{step.intent.title}</div>
                {step.intent.description && (
                  <div className="text-[10px] text-[var(--text-muted)] truncate">{step.intent.description}</div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {step.intent.confidence > 0 && (
                  <span className="text-[10px] text-[var(--text-muted)]">{step.intent.confidence}%</span>
                )}
                {step.intent.sideEffects?.some((s) => s.requiresApproval) && (
                  <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">Review</span>
                )}
              </div>
            </button>
            {expandedStep === step.id && (
              <div className="ml-8 mt-1 mb-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-primary)] space-y-2">
                {step.intent.description && (
                  <p className="text-[var(--text-muted)]">{step.intent.description}</p>
                )}
                {step.intent.sideEffects?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {step.intent.sideEffects.map((se, i) => (
                      <span
                        key={i}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-medium',
                          se.requiresApproval ? 'bg-amber-500/10 text-amber-400' : 'bg-[var(--bg-primary)] text-[var(--text-muted)]'
                        )}
                      >
                            {se.label}
                      </span>
                    ))}
                  </div>
                )}
                {step.result && (
                  <div className="rounded bg-[var(--bg-primary)] p-2 font-mono text-[10px] text-[var(--text-muted)] whitespace-pre-wrap break-all">
                    {JSON.stringify(step.result, null, 2)}
                  </div>
                )}
                {step.error && (
                  <div className="rounded bg-red-500/10 p-2 text-[10px] text-red-400 whitespace-pre-wrap">{step.error}</div>
                )}
                {step.inboxItemId && (
                  <a href="/settings" className="block text-[10px] text-[var(--accent)] hover:underline">Inbox item: {step.inboxItemId}</a>
                )}
                {step.startedAt && (
                  <div className="text-[10px] text-[var(--text-muted)]">
                    Started: {new Date(step.startedAt).toLocaleTimeString()}
                    {step.finishedAt && ` · Finished: ${new Date(step.finishedAt).toLocaleTimeString()}`}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {plan.status === 'awaiting_approval' && (
        <div className={cn('flex items-center gap-2', compact ? 'mt-2' : 'mt-4')}>
          {onExecutePlan && (
            <button
              onClick={() => onExecutePlan(plan.id, { approveAll: true })}
              className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 text-xs font-medium transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> Run All Steps
            </button>
          )}
          {onExecutePlan && (
            <button
              onClick={() => onExecutePlan(plan.id)}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--border)] text-[var(--text-primary)] px-4 py-2 text-xs font-medium transition-colors"
            >
              Run Approvable Steps
            </button>
          )}
          {onCancelPlan && (
            <button
              onClick={() => onCancelPlan(plan.id)}
              className="flex items-center gap-1.5 rounded-md border border-red-500/20 hover:bg-red-500/10 text-red-400 px-4 py-2 text-xs font-medium transition-colors"
            >
              <Ban className="w-3.5 h-3.5" /> Cancel
            </button>
          )}
        </div>
      )}

      {plan.status === 'running' && (
        <div className={cn('flex items-center gap-2 text-xs text-[var(--text-muted)]', compact ? 'mt-2' : 'mt-4')}>
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
          <span>Executing plan...</span>
        </div>
      )}

      {plan.status === 'completed' && (
        <div className={cn('flex items-center gap-2 text-xs text-emerald-400', compact ? 'mt-2' : 'mt-4')}>
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>All steps completed</span>
        </div>
      )}

      {plan.status === 'failed' && (
        <div className={cn('flex items-center gap-2 text-xs text-red-400', compact ? 'mt-2' : 'mt-4')}>
          <XCircle className="w-3.5 h-3.5" />
          <span>Plan execution failed</span>
          <button onClick={() => onCancelPlan?.(plan.id)} className="underline hover:no-underline">Dismiss</button>
        </div>
      )}
    </div>
  );
}

export function PlanList({ plans, onExecutePlan, onCancelPlan }: { plans: Plan[]; onExecutePlan?: (planId: string, opts?: { approveAll?: boolean }) => void; onCancelPlan?: (planId: string) => void }) {
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  if (!plans.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
        <Bot className="w-10 h-10 mb-3 opacity-50" />
        <p className="text-sm">No AI workflows yet</p>
        <p className="text-xs mt-1">Press Cmd+K to create one</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {plans.map((plan) => (
        <div key={plan.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
          <button
            onClick={() => setExpandedPlan(expandedPlan === plan.id ? null : plan.id)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-[var(--text-primary)] truncate">{plan.summary || plan.userMessage}</div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{plan.steps.length} steps · ${plan.estimatedCostUsd.toFixed(3)} · {new Date(plan.createdAt).toLocaleString()}</div>
            </div>
            <span className={cn('shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', getStatusBadgeColor(plan.status))}>
              {plan.status.replace(/_/g, ' ')}
            </span>
          </button>
          {expandedPlan === plan.id && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <WorkflowRunner plan={plan} onExecutePlan={onExecutePlan} onCancelPlan={onCancelPlan} compact />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
