export function CoverageGapList({ gaps }: { gaps: string[] }) {
  return (
    <div className="mt-2 pl-6">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Gaps</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--text-muted)]">
        {gaps.map((gap, index) => <li key={index}>{gap}</li>)}
      </ul>
    </div>
  );
}

export function ScenarioStepGrid({ steps }: { steps: Array<{ action: string; expected: string }> }) {
  return (
    <div className="space-y-1">
      {steps.map((step, index) => (
        <div key={index} className="grid grid-cols-2 gap-2 rounded bg-[var(--bg-card)] p-1.5 text-[11px]">
          <span className="text-[var(--text-primary)]">{index + 1}. {step.action}</span>
          <span className="text-[var(--text-muted)]">{step.expected}</span>
        </div>
      ))}
    </div>
  );
}
