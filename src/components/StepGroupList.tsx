import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

/**
 * Read-only viewer for a case's steps that collapses recorder step-explosion into readable blocks.
 *
 * Recorded cases can carry 200-300 steps, each tagged with an optional `group`/`groupIndex` by the
 * backend (see server/features/automation/stepGrouping.ts). This renders them as collapsible logical
 * groups (page/section), so a huge recording reads as a handful of named blocks you expand on demand.
 * When no step carries a group (manual/AI cases), it falls back to the original flat step table — so
 * it is a drop-in for any case-steps display.
 */

export interface ViewStep {
  action: string;
  expected: string;
  group?: string;
  groupIndex?: number;
}

interface Group {
  index: number;
  title: string;
  steps: Array<{ step: ViewStep; number: number }>;
}

// Bucket steps into their groups, preserving order and a stable 1-based global step number.
function toGroups(steps: ViewStep[]): Group[] {
  const groups: Group[] = [];
  const byIndex = new Map<number, Group>();
  steps.forEach((step, i) => {
    const idx = Number.isInteger(step.groupIndex) ? (step.groupIndex as number) : 0;
    let g = byIndex.get(idx);
    if (!g) { g = { index: idx, title: step.group || 'Steps', steps: [] }; byIndex.set(idx, g); groups.push(g); }
    g.steps.push({ step, number: i + 1 });
  });
  return groups.sort((a, b) => a.index - b.index);
}

function StepTable({ rows }: { rows: Array<{ step: ViewStep; number: number }> }) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <tbody>
        {rows.map(({ step, number }) => (
          <tr key={number} className="align-top">
            <td className="w-1/2 border-b border-[var(--border)] px-3 py-2 text-[var(--text-primary)]">
              <span className="text-[var(--text-muted)]">{number}.</span> {step.action}
            </td>
            <td className="w-1/2 border-b border-[var(--border)] px-3 py-2 text-[var(--text-muted)]">{step.expected}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function StepGroupList({ steps }: { steps: ViewStep[] }) {
  const grouped = useMemo(() => steps.some((s) => !!s.group), [steps]);
  const groups = useMemo(() => (grouped ? toGroups(steps) : []), [grouped, steps]);
  // Collapse groups by default when there are many — the whole point is to tame a huge recording.
  const [open, setOpen] = useState<Set<number>>(() => new Set(groups.length <= 3 ? groups.map((g) => g.index) : []));

  if (!steps.length) return null;

  // Flat fallback: manual / AI cases with no grouping metadata render exactly as before.
  if (!grouped) {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="bg-[var(--bg-secondary)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Test Steps</th>
              <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Expected Result</th>
            </tr>
          </thead>
          <StepTable rows={steps.map((step, i) => ({ step, number: i + 1 }))} />
        </table>
      </div>
    );
  }

  const allOpen = open.size === groups.length;
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.index)));
  const toggle = (idx: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    return next;
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--text-muted)]">{groups.length} groups · {steps.length} steps</span>
        <button onClick={toggleAll} className="text-[11px] font-medium text-[var(--accent)] hover:underline">
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        {groups.map((g) => {
          const isOpen = open.has(g.index);
          return (
            <div key={g.index} className="border-b border-[var(--border)] last:border-b-0">
              <button
                onClick={() => toggle(g.index)}
                className="flex w-full items-center gap-2 bg-[var(--bg-secondary)] px-3 py-2 text-left hover:bg-[var(--border)]/40"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />}
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text-primary)]">{g.title}</span>
                <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                  {g.steps.length} step{g.steps.length === 1 ? '' : 's'}
                </span>
              </button>
              {isOpen && <StepTable rows={g.steps} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
