/**
 * Lightweight tracer shaped to the OpenTelemetry GenAI semantic conventions
 * (gen_ai.operation.name, invoke_agent / execute_tool / chat spans, gen_ai.usage.*).
 *
 * ponytail: an in-memory span recorder + optional console/OTLP export — not the full @opentelemetry
 * SDK. Keeps the app runnable with zero infra; swap in @opentelemetry/sdk-node + an OTLP exporter to
 * Langfuse when real distributed tracing is needed. The span shape is already conventional so the
 * upgrade is a transport change, not a re-instrumentation.
 */

export type SpanKind = "invoke_agent" | "execute_tool" | "chat" | "invoke_workflow";

export interface Span {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentId?: string;
  attributes: Record<string, unknown>;
  startMs: number;
  endMs?: number;
  error?: string;
}

let counter = 0;
const nextId = () => `${Date.now().toString(36)}-${(++counter).toString(36)}`;

export class Tracer {
  private spans: Span[] = [];
  constructor(
    public readonly traceId: string = nextId(),
    private onEnd: (s: Span) => void = () => {},
  ) {}

  /** Wrap an operation in a span carrying gen_ai.* attributes. */
  async span<T>(name: string, kind: SpanKind, attributes: Record<string, unknown>, fn: (s: Span) => Promise<T>): Promise<T> {
    const s: Span = { name, kind, traceId: this.traceId, spanId: nextId(), attributes: { "gen_ai.operation.name": kind, ...attributes }, startMs: Date.now() };
    this.spans.push(s);
    try {
      const out = await fn(s);
      s.endMs = Date.now();
      this.onEnd(s);
      return out;
    } catch (e) {
      s.endMs = Date.now();
      s.error = (e as Error).message;
      this.onEnd(s);
      throw e;
    }
  }

  record(): Span[] {
    return [...this.spans];
  }
}

/** Console exporter, enabled with ATP_TRACE=1. */
export function consoleExporter(s: Span): void {
  if (process.env.ATP_TRACE !== "1") return;
  const dur = s.endMs ? `${s.endMs - s.startMs}ms` : "…";
  // eslint-disable-next-line no-console
  console.error(`[trace] ${s.kind} ${s.name} ${dur}${s.error ? " ERROR:" + s.error : ""}`);
}
