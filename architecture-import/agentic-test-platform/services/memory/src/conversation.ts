import type { ChatMessage, ChatRole, MemoryStore } from "./store.ts";

/** rough token estimate without a tokenizer dependency (≈4 chars/token) */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Conversation (chat) memory for one session. Holds the running thread and, when it grows past a
 * budget, COMPACTS older turns into a rolling summary (Anthropic context-engineering: keep the
 * smallest set of high-signal tokens). The summary + recent turns become the agent's context.
 */
export class ConversationMemory {
  constructor(
    private store: MemoryStore,
    public readonly sessionId: string,
  ) {}

  add(role: ChatRole, content: string, opts: { name?: string; toolCallId?: string } = {}): ChatMessage {
    return this.store.appendMessage(this.sessionId, { role, content, ...opts });
  }

  history(): ChatMessage[] {
    return this.store.getMessages(this.sessionId);
  }

  summary(): string | undefined {
    return this.store.getSummary(this.sessionId);
  }

  tokens(): number {
    const msgs = this.history().reduce((n, m) => n + approxTokens(m.content), 0);
    return msgs + approxTokens(this.summary() ?? "");
  }

  /**
   * If the thread exceeds maxTokens, fold all-but-last `keepLast` turns into the summary.
   * `summarize` is injected (an LLM call in prod, a naive joiner in tests) so this stays pure.
   */
  async compactIfNeeded(
    maxTokens: number,
    keepLast: number,
    summarize: (priorSummary: string | undefined, dropped: ChatMessage[]) => Promise<string>,
  ): Promise<boolean> {
    if (this.tokens() <= maxTokens) return false;
    const dropped = this.store.dropOldMessages(this.sessionId, keepLast);
    if (dropped.length === 0) return false;
    const merged = await summarize(this.summary(), dropped);
    this.store.setSummary(this.sessionId, merged);
    return true;
  }

  /** The context window to hand an agent: summary (as a system note) + remaining turns. */
  toContext(): ChatMessage[] {
    const out: ChatMessage[] = [];
    const sum = this.summary();
    if (sum) out.push({ role: "system", content: `Conversation so far (summary):\n${sum}`, seq: 0 });
    return out.concat(this.history());
  }
}
