import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { Timestamp } from '@/src/components/Timestamp';
import { humanizeDuration } from '@/src/lib/time';

/** Execution metadata for an agent response — LangSmith/OpenAI-Playground style. All fields optional;
 *  only present ones render. */
export interface ExecutionMeta {
  // Execution
  startedAt?: string; finishedAt?: string; durationMs?: number; latencyMs?: number;
  // AI
  provider?: string; model?: string; effort?: string; temperature?: number;
  // Usage
  promptTokens?: number; completionTokens?: number; cachedTokens?: number; totalTokens?: number; costUsd?: number;
  // Pipeline
  pipeline?: string; stages?: Array<{ name: string; durationMs?: number }>; toolCalls?: number; retries?: number; memoryRetrievals?: number;
  // Context
  workspace?: string; projectId?: string; appId?: string; userId?: string; userName?: string;
  runId?: string; conversationId?: string;
}

function Row({ label, value }: { label: string; value?: ReactNode }) {
  if (value == null || value === '' || value === undefined) return null;
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="text-right font-medium text-[var(--text-primary)] break-all">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const kids = Array.isArray(children) ? children.filter(Boolean) : children;
  if (!kids || (Array.isArray(kids) && kids.length === 0)) return null;
  return (
    <div className="mb-2">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{title}</div>
      {children}
    </div>
  );
}

/** Per-response footer: exact timestamp (with seconds, tz on hover) + a collapsible execution panel. */
export function MessageMeta({ createdAt, execution }: { createdAt?: string; execution?: ExecutionMeta }) {
  const [open, setOpen] = useState(false);
  const ex = execution || {};
  const hasDetails =
    ex.provider || ex.model || ex.durationMs != null || ex.totalTokens != null ||
    ex.pipeline || ex.runId || ex.conversationId || ex.workspace;

  return (
    <div className="mt-1 pl-1 text-[11px] text-[var(--text-muted)]">
      <div className="flex items-center gap-2">
        <Clock className="h-3 w-3" />
        <Timestamp value={createdAt} mode="absolute" seconds />
        {ex.durationMs != null && <span>· {humanizeDuration(ex.durationMs)}</span>}
        {ex.model && <span>· {ex.model}</span>}
        {hasDetails && (
          <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]">
            Details <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {open && hasDetails && (
        <div className="mt-1 max-w-md rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2.5 text-[11px]">
          <Section title="Execution">
            <Row label="Started" value={ex.startedAt ? new Date(ex.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : undefined} />
            <Row label="Finished" value={ex.finishedAt ? new Date(ex.finishedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : undefined} />
            <Row label="Duration" value={ex.durationMs != null ? humanizeDuration(ex.durationMs) : undefined} />
            <Row label="Latency" value={ex.latencyMs != null ? humanizeDuration(ex.latencyMs) : undefined} />
          </Section>
          <Section title="AI">
            <Row label="Provider" value={ex.provider} />
            <Row label="Model" value={ex.model} />
            <Row label="Reasoning effort" value={ex.effort} />
            <Row label="Temperature" value={ex.temperature != null ? String(ex.temperature) : undefined} />
          </Section>
          <Section title="Usage">
            <Row label="Prompt tokens" value={ex.promptTokens} />
            <Row label="Completion tokens" value={ex.completionTokens} />
            <Row label="Cached tokens" value={ex.cachedTokens} />
            <Row label="Total tokens" value={ex.totalTokens} />
            <Row label="Est. cost" value={ex.costUsd != null ? `$${ex.costUsd.toFixed(4)}` : undefined} />
          </Section>
          <Section title="Pipeline">
            <Row label="Pipeline" value={ex.pipeline} />
            {(ex.stages || []).map((s, i) => (
              <Fragment key={i}><Row label={`· ${s.name}`} value={s.durationMs != null ? humanizeDuration(s.durationMs) : ''} /></Fragment>
            ))}
            <Row label="Tool calls" value={ex.toolCalls} />
            <Row label="Retries" value={ex.retries} />
            <Row label="Memory retrievals" value={ex.memoryRetrievals} />
          </Section>
          <Section title="Context">
            <Row label="Workspace" value={ex.workspace} />
            <Row label="Project" value={ex.projectId} />
            <Row label="Application" value={ex.appId} />
            <Row label="User" value={ex.userName || ex.userId} />
            <Row label="Run ID" value={ex.runId} />
            <Row label="Conversation ID" value={ex.conversationId} />
          </Section>
        </div>
      )}
    </div>
  );
}
