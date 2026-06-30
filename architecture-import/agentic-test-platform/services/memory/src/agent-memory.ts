import type { MemoryRecord, MemoryStore } from "./store.ts";

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

/**
 * Per-agent memory — each agent has its OWN memory, separate from the chat and from other agents:
 *  - facts: durable, cross-run knowledge the agent accumulates (learned conventions, known-flaky
 *    locators, prior decisions). Recalled into context on demand (just-in-time).
 *  - notes: ephemeral working memory for the current task (the agent's scratchpad).
 *
 * recall() is keyword + recency scored. ponytail ceiling: lexical, not semantic — swap in
 * pgvector when cross-run recall needs meaning-based matching.
 */
export class AgentMemory {
  constructor(
    private store: MemoryStore,
    public readonly agentId: string,
  ) {}

  remember(text: string, tags: string[] = []): MemoryRecord {
    return this.store.putMemory({ agentId: this.agentId, scope: "fact", text, tags });
  }

  note(text: string, tags: string[] = []): MemoryRecord {
    return this.store.putMemory({ agentId: this.agentId, scope: "note", text, tags });
  }

  notes(): MemoryRecord[] {
    return this.store.listMemory(this.agentId, "note");
  }

  clearNotes(): void {
    this.store.clearMemory(this.agentId, "note");
  }

  /** Top-N durable facts most relevant to a query (keyword overlap, then recency). */
  recall(query?: string, limit = 5): MemoryRecord[] {
    const facts = this.store.listMemory(this.agentId, "fact");
    if (!query) return facts.slice(-limit).reverse();
    const q = new Set(tokenize(query));
    const scored = facts.map((f) => {
      const words = tokenize(f.text + " " + f.tags.join(" "));
      const overlap = words.reduce((n, w) => n + (q.has(w) ? 1 : 0), 0);
      return { f, overlap };
    });
    return scored
      .filter((s) => s.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.f.seq - a.f.seq)
      .slice(0, limit)
      .map((s) => s.f);
  }

  /** Recalled facts joined for prompt injection (the agent's "what I already know" block). */
  recallText(query?: string, limit = 5): string {
    return this.recall(query, limit)
      .map((f) => `- ${f.text}`)
      .join("\n");
  }
}
