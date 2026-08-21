export type TargetActionSummary = {
  title: string;
  method: string;
  scope?: string;
  operation?: string;
  data: unknown;
};

function evidenceResult(value: any): any {
  return value?.verification?.evidence ? value.verification : value?.evidence ? value : null;
}

export function selectTargetActionResult(actions: Array<{ tool?: string; result?: any }>): TargetActionSummary | undefined {
  for (const action of [...actions].reverse()) {
    const result = action.result;
    const verified = evidenceResult(result);
    const isFlow = action.tool === 'author_core_platform_flow' && ['created', 'updated'].includes(String(result?.status));
    if (!verified && !isFlow) continue;
    const evidence = verified?.evidence || result?.evidence;
    const data = isFlow
      ? { status: result.status, message: result.message, flowId: result.flowId, flowApiName: result.flowApiName, objectApiName: result.objectApiName, verification: result.verification }
      : Object.fromEntries(Object.entries(verified).filter(([key]) => key !== 'evidence'));
    return {
      title: isFlow ? `${result.status === 'created' ? 'Created' : 'Updated'} Core Platform Flow` : evidence?.subject || 'Verified target result',
      method: evidence?.source?.method || (result?.status === 'created' ? 'POST' : result?.status === 'updated' ? 'PATCH' : 'GET'),
      scope: evidence?.scope?.label,
      operation: evidence?.source?.operation,
      data,
    };
  }
}

export function TargetActionResult({ result }: { result: TargetActionSummary }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-emerald-500/30 bg-emerald-500/5" data-testid="target-action-result">
      <div className="flex flex-wrap items-center gap-2 border-b border-emerald-500/20 px-3 py-2">
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">{result.method}</span>
        <span className="text-xs font-semibold text-[var(--text-primary)]">{result.title}</span>
        {result.scope ? <span className="text-[11px] text-[var(--text-muted)]">Scope: {result.scope}</span> : null}
      </div>
      <details className="px-3 py-2" open>
        <summary className="cursor-pointer text-xs font-medium text-[var(--text-primary)]">Verified data</summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-secondary)] p-2 text-[11px] text-[var(--text-muted)]">{JSON.stringify(result.data, null, 2)}</pre>
      </details>
    </div>
  );
}
