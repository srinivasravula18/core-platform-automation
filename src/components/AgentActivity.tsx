import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, Clock3, Loader2, Search, Wrench, X } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { containsPrivateFileActivity } from '@/src/lib/userFacingAgentActivity';

type ActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ActivityEvent {
  seq: number;
  correlationId?: string;
  payload: {
    requestId: string;
    kind: string;
    status: ActivityStatus;
    label?: string;
    tool?: { name?: string; arguments?: unknown; resultSummary?: string; error?: string; ms?: number };
  };
}

interface ActivityStep {
  key: string;
  kind: string;
  label: string;
  status: ActivityStatus;
  tool?: ActivityEvent['payload']['tool'];
  items?: Array<{ key: string; status: ActivityStatus; tool?: ActivityEvent['payload']['tool'] }>;
}

function friendlyTool(name = '') {
  const labels: Record<string, string> = {
    search_codebase: 'Searched the codebase',
    read_code_file: 'Read source code',
    follow_imports: 'Followed connected modules',
    query_workspace: 'Checked workspace data',
    search_conversation: 'Searched conversation memory',
    fetch_artifact: 'Loaded supporting evidence',
    check_url: 'Checked target availability',
    prepare_test_scope: 'Prepared test scope',
    create_cases: 'Generated test cases',
    generate_script: 'Generated Playwright script',
  };
  return labels[name] || `Ran ${name.replace(/_/g, ' ')}`;
}

export function activitySteps(events: ActivityEvent[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const toolSteps = new Map<string, number>();
  const pending = new Map<string, Array<{ step: number; item: number }>>();
  for (const event of events) {
    const payload = event.payload;
    const name = String(payload.tool?.name || '');
    if (payload.kind === 'tool_started') {
      let step = toolSteps.get(name);
      if (step === undefined) {
        step = steps.push({ key: String(event.seq), kind: payload.kind, label: friendlyTool(name), status: 'running', tool: payload.tool, items: [] }) - 1;
        toolSteps.set(name, step);
      }
      const item = steps[step].items!.push({ key: String(event.seq), status: 'running', tool: payload.tool }) - 1;
      steps[step].status = 'running';
      pending.set(name, [...(pending.get(name) || []), { step, item }]);
      continue;
    }
    if (payload.kind === 'tool_completed') {
      const waiting = pending.get(name) || [];
      const target = waiting.shift();
      let step = target?.step ?? toolSteps.get(name);
      if (step === undefined) {
        step = steps.push({ key: String(event.seq), kind: payload.kind, label: friendlyTool(name), status: 'completed', tool: payload.tool, items: [] }) - 1;
        toolSteps.set(name, step);
      }
      const item = target?.item ?? steps[step].items!.length;
      steps[step].items![item] = { key: String(event.seq), status: payload.tool?.error ? 'failed' : 'completed', tool: payload.tool };
      steps[step].tool = payload.tool;
      steps[step].status = steps[step].items!.some((entry) => entry.status === 'running')
        ? 'running'
        : steps[step].items!.some((entry) => entry.status === 'failed') ? 'failed' : 'completed';
      pending.set(name, waiting);
      continue;
    }
    // Queueing and routing are request plumbing, not actions performed by the agent.
    if (payload.kind === 'queued' || payload.kind === 'routing') continue;
    steps.push({ key: String(event.seq), kind: payload.kind, label: payload.label || payload.kind.replace(/_/g, ' '), status: payload.status });
  }
  return steps;
}

function toolItemLabel(tool: ActivityEvent['payload']['tool']) {
  const value = tool?.arguments;
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const useful = input.query ?? input.path ?? input.url ?? input.file ?? input.action;
    if (useful != null) return String(useful);
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function StepIcon({ step }: { step: ActivityStep }) {
  if (step.status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (step.status === 'failed' || step.status === 'cancelled' || step.status === 'interrupted') return <X className="h-3.5 w-3.5" />;
  if (step.kind.startsWith('tool_')) return step.tool?.name?.includes('search') ? <Search className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />;
  if (step.kind === 'responding') return <Clock3 className="h-3.5 w-3.5" />;
  return step.status === 'completed' ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />;
}

export const AgentActivity = memo(function AgentActivity({
  conversationId,
  requestId,
  liveLabel,
  partialText,
  className,
  onCompleted,
}: {
  conversationId: string;
  requestId: string;
  liveLabel?: string;
  partialText?: string;
  className?: string;
  onCompleted?: () => void;
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<ActivityStatus>('running');
  const completedNotified = useRef(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastSeq.current = 0;
    completedNotified.current = false;
    setEvents([]);
    setStatus('running');
    const refresh = async () => {
      try {
        const response = await fetch(`/api/controller/activity/for-conversation/${encodeURIComponent(conversationId)}?since=${lastSeq.current}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (disposed) return;
        const received = Array.isArray(data.events) ? data.events as ActivityEvent[] : [];
        const matching = received.filter((event) =>
          String(event.correlationId || event.payload?.requestId || '') === requestId,
        );
        const request = (Array.isArray(data.requests) ? data.requests : []).find((item: any) => item.requestId === requestId);
        if (received.length) lastSeq.current = Math.max(lastSeq.current, ...received.map((event) => Number(event.seq) || 0));
        if (matching.length) setEvents((current) => [...current, ...matching]);
        setStatus(request?.status || matching.at(-1)?.payload?.status || 'running');
        if ((request?.status || matching.at(-1)?.payload?.status) === 'running') timer = setTimeout(refresh, 1_250);
      } catch {
        if (!disposed) timer = setTimeout(refresh, 2_500);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [conversationId, requestId]);

  useEffect(() => {
    if (status !== 'completed' || completedNotified.current) return;
    completedNotified.current = true;
    onCompleted?.();
  }, [onCompleted, status]);

  const steps = useMemo(() => activitySteps(events), [events]);
  const heading = status === 'running'
    ? (liveLabel || steps.at(-1)?.label || 'Working on your request...')
    : status === 'completed' ? (steps.some((step) => step.kind.startsWith('tool_')) ? 'Worked through sources' : 'Completed')
      : status === 'cancelled' ? 'Stopped'
        : status === 'interrupted' ? 'Interrupted'
          : 'Could not complete';
  const tone = status === 'failed' || status === 'interrupted'
    ? 'text-red-600 dark:text-red-300'
    : status === 'cancelled' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]';

  return (
    <div className={cn('max-w-[95%] text-sm', className)} aria-live={status === 'running' ? 'polite' : 'off'}>
      <details className="group/activity" open={status === 'running' || undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1 font-medium [&::-webkit-details-marker]:hidden">
          <span className={cn('flex h-5 w-5 items-center justify-center', tone)}>
            {status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : status === 'completed' ? <Check className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
          </span>
          <span className={tone}>{heading}</span>
          <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)] transition-transform group-open/activity:rotate-180" />
          {steps.length > 0 ? <span className="ml-auto text-xs font-normal text-[var(--text-muted)]">{steps.length} step{steps.length === 1 ? '' : 's'}</span> : null}
        </summary>

        <div className="custom-scrollbar mt-2 max-h-[min(55vh,32rem)] overflow-y-auto overscroll-contain pl-2 pr-2">
          <div className="relative ml-2.5 border-l border-[var(--border)] pl-6">
            {steps.length ? steps.map((step) => {
            const items = step.items || [];
            return (
              <div key={step.key} className="relative pb-4 last:pb-1">
                <span className={cn(
                  'absolute -left-[33px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--bg-primary)]',
                  step.status === 'failed' ? 'text-red-500' : step.status === 'running' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]',
                )}>
                  <StepIcon step={step} />
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-[var(--text-primary)]">{step.label}</span>
                  {step.tool?.name ? (
                    <code className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--text-muted)]">
                      {step.tool.name}
                    </code>
                  ) : null}
                  {items.length > 1 ? <span className="shrink-0 text-xs text-[var(--text-muted)]">{items.length} calls</span> : null}
                  {typeof step.tool?.ms === 'number' ? <span className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">{step.tool.ms} ms</span> : null}
                </div>
                {items.length ? (
                  <div className="custom-scrollbar mt-2 max-h-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-muted)]">
                    {items.map((item) => {
                      const label = toolItemLabel(item.tool);
                      const detail = item.tool?.error || item.tool?.resultSummary;
                      const visibleDetail = detail && !containsPrivateFileActivity(detail) ? detail : '';
                      return (
                        <div key={item.key} className="border-b border-[var(--border)] px-3 py-2 last:border-b-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <StepIcon step={{ ...step, status: item.status, tool: item.tool }} />
                            <span className="truncate text-[var(--text-primary)]">{label || friendlyTool(item.tool?.name)}</span>
                            {typeof item.tool?.ms === 'number' ? <span className="ml-auto shrink-0">{item.tool.ms} ms</span> : null}
                          </div>
                          {visibleDetail ? <pre className="mt-1 whitespace-pre-wrap break-words pl-5 font-sans leading-5">{visibleDetail}</pre> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
            }) : null}
          </div>
        </div>
      </details>
      {partialText ? <div className="mt-2 whitespace-pre-wrap break-words text-[var(--text-primary)]">{partialText}</div> : null}
    </div>
  );
});
