import type { A2AMessage, AgentCard, AgentContext, AgentHandler, AgentTool } from "./types.ts";

export interface BusOptions {
  /** max agent→agent call depth before throwing (loop / runaway-fan-out guard) */
  maxDepth?: number;
  /** trace/observe every message (ties to packages/tracing + the chat "agent trace" panel) */
  onMessage?: (msg: A2AMessage) => void;
}

/**
 * In-process agent-to-agent message bus.
 *
 * Why in-process and not the full A2A wire protocol: all agents share one trust domain under one
 * orchestrator (Google's own guidance — "MCP for tools, A2A for cross-runtime agents"). We adopt
 * the A2A *concepts* (agent cards, request/reply, correlation) without the transport. Every message
 * is logged to a transcript so the chat UI / tracing can render who said what to whom.
 *
 * Respects Claude Agent SDK context isolation: agents exchange explicit messages here, never shared
 * conversation context. A reply is a distilled result, not a transcript dump.
 */
export class AgentBus {
  private agents = new Map<string, { card: AgentCard; handler: AgentHandler }>();
  private subs = new Map<string, Set<string>>(); // topic -> subscriber names
  private mailboxes = new Map<string, A2AMessage[]>();
  private transcript: A2AMessage[] = [];
  private seq = 0;
  private readonly maxDepth: number;
  private readonly onMessage?: (msg: A2AMessage) => void;

  constructor(opts: BusOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 8;
    this.onMessage = opts.onMessage;
  }

  register(card: AgentCard, handler: AgentHandler): void {
    if (this.agents.has(card.name)) throw new Error(`agent already registered: ${card.name}`);
    this.agents.set(card.name, { card, handler });
  }

  cards(): AgentCard[] {
    return [...this.agents.values()].map((a) => a.card);
  }

  subscribe(agentName: string, topic: string): void {
    const set = this.subs.get(topic) ?? new Set();
    set.add(agentName);
    this.subs.set(topic, set);
  }

  inbox(agentName: string): A2AMessage[] {
    const m = this.mailboxes.get(agentName) ?? [];
    this.mailboxes.set(agentName, []);
    return m;
  }

  getTranscript(correlationId?: string): A2AMessage[] {
    return correlationId ? this.transcript.filter((m) => m.correlationId === correlationId) : [...this.transcript];
  }

  private record(msg: A2AMessage): void {
    this.transcript.push(msg);
    this.onMessage?.(msg);
  }

  private makeCtx(self: string, correlationId: string, depth: number): AgentContext {
    return {
      self,
      correlationId,
      depth,
      request: (to, content) => this.dispatch(self, to, content, correlationId, depth + 1),
      notify: (to, content) => this.enqueue(self, to, content, correlationId, depth + 1),
      publish: (topic, content) => this.publish(self, topic, content, correlationId, depth + 1),
      cards: () => this.cards(),
    };
  }

  /** Agent-to-agent request/reply: send to `to`, run its handler, return the distilled reply. */
  async request(from: string, to: string, content: unknown): Promise<unknown> {
    return this.dispatch(from, to, content, `corr-${++this.seq}`, 1);
  }

  private async dispatch(
    from: string,
    to: string,
    content: unknown,
    correlationId: string,
    depth: number,
  ): Promise<unknown> {
    if (depth > this.maxDepth) {
      throw new Error(`agent call depth ${depth} exceeded max ${this.maxDepth} (from ${from} to ${to}) — possible loop`);
    }
    const target = this.agents.get(to);
    if (!target) throw new Error(`unknown agent: ${to}`);

    const req: A2AMessage = { id: `msg-${++this.seq}`, kind: "request", from, to, correlationId, content, depth, seq: this.seq };
    this.record(req);

    const result = await target.handler(content, this.makeCtx(to, correlationId, depth));

    const reply: A2AMessage = { id: `msg-${++this.seq}`, kind: "reply", from: to, to: from, correlationId, content: result, depth, seq: this.seq };
    this.record(reply);
    return result;
  }

  private enqueue(from: string, to: string, content: unknown, correlationId: string, depth: number): void {
    const msg: A2AMessage = { id: `msg-${++this.seq}`, kind: "notify", from, to, correlationId, content, depth, seq: this.seq };
    this.record(msg);
    const box = this.mailboxes.get(to) ?? [];
    box.push(msg);
    this.mailboxes.set(to, box);
  }

  private publish(from: string, topic: string, content: unknown, correlationId: string, depth: number): void {
    const msg: A2AMessage = { id: `msg-${++this.seq}`, kind: "publish", from, to: topic, correlationId, content, depth, seq: this.seq };
    this.record(msg);
    for (const sub of this.subs.get(topic) ?? []) {
      const box = this.mailboxes.get(sub) ?? [];
      box.push({ ...msg, kind: "notify", to: sub });
      this.mailboxes.set(sub, box);
    }
  }

  /** Expose a registered agent as a callable tool — the agents-as-tools / internal tool-calling seam. */
  asTool(name: string): AgentTool {
    const a = this.agents.get(name);
    if (!a) throw new Error(`unknown agent: ${name}`);
    return {
      name,
      description: a.card.description,
      call: (input, from = "orchestrator") => this.request(from, name, input),
    };
  }
}
