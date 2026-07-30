function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class ToolProgressTracker {
  private lastSignature = '';
  private repeats = 0;
  private failures = 0;

  recordAttempt(name: string, args: Record<string, unknown>): 'repeated_call' | null {
    const signature = `${name}:${stable(args)}`;
    this.repeats = signature === this.lastSignature ? this.repeats + 1 : 1;
    this.lastSignature = signature;
    return this.repeats >= 3 ? 'repeated_call' : null;
  }

  recordOutcome(ok: boolean): 'consecutive_failures' | null {
    this.failures = ok ? 0 : this.failures + 1;
    return this.failures >= 5 ? 'consecutive_failures' : null;
  }
}

export function maxToolIterations(requested?: number): number {
  const configured = Number(process.env.AGENT_MAX_TOOL_ITERATIONS || 64);
  const fallback = Number.isFinite(configured) ? configured : 64;
  const value = requested ?? fallback;
  return Math.max(1, Math.min(64, Math.floor(value)));
}
