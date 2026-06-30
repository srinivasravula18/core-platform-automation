/**
 * Memory store — the persistence seam for BOTH conversation memory (the chat) and per-agent
 * memory (each agent's own working notes + long-term facts).
 *
 * ponytail: in-memory + JSON file snapshot. Swap MemoryStore for a Postgres+pgvector impl when
 * recall needs semantic search across many runs — the interface stays the same.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** agent/tool name for assistant/tool turns */
  name?: string;
  /** ties a tool result back to the call that produced it */
  toolCallId?: string;
  /** monotonic sequence (no wall-clock; reproducible) */
  seq: number;
}

export type MemoryScope = "fact" | "note";

export interface MemoryRecord {
  id: string;
  agentId: string;
  scope: MemoryScope;
  text: string;
  tags: string[];
  seq: number;
}

export interface MemoryStore {
  appendMessage(sessionId: string, msg: Omit<ChatMessage, "seq">): ChatMessage;
  getMessages(sessionId: string): ChatMessage[];
  setSummary(sessionId: string, summary: string): void;
  getSummary(sessionId: string): string | undefined;
  dropOldMessages(sessionId: string, keepLast: number): ChatMessage[];

  putMemory(rec: Omit<MemoryRecord, "id" | "seq">): MemoryRecord;
  listMemory(agentId: string, scope?: MemoryScope): MemoryRecord[];
  clearMemory(agentId: string, scope: MemoryScope): void;
}

export class InMemoryStore implements MemoryStore {
  private messages = new Map<string, ChatMessage[]>();
  private summaries = new Map<string, string>();
  private memory: MemoryRecord[] = [];
  private seq = 0;

  private next(): number {
    return ++this.seq;
  }

  appendMessage(sessionId: string, msg: Omit<ChatMessage, "seq">): ChatMessage {
    const full: ChatMessage = { ...msg, seq: this.next() };
    const list = this.messages.get(sessionId) ?? [];
    list.push(full);
    this.messages.set(sessionId, list);
    return full;
  }
  getMessages(sessionId: string): ChatMessage[] {
    return [...(this.messages.get(sessionId) ?? [])];
  }
  setSummary(sessionId: string, summary: string): void {
    this.summaries.set(sessionId, summary);
  }
  getSummary(sessionId: string): string | undefined {
    return this.summaries.get(sessionId);
  }
  dropOldMessages(sessionId: string, keepLast: number): ChatMessage[] {
    const list = this.messages.get(sessionId) ?? [];
    const dropped = list.slice(0, Math.max(0, list.length - keepLast));
    this.messages.set(sessionId, list.slice(-keepLast));
    return dropped;
  }

  putMemory(rec: Omit<MemoryRecord, "id" | "seq">): MemoryRecord {
    const seq = this.next();
    const full: MemoryRecord = { ...rec, id: `mem-${seq}`, seq };
    this.memory.push(full);
    return full;
  }
  listMemory(agentId: string, scope?: MemoryScope): MemoryRecord[] {
    return this.memory.filter((m) => m.agentId === agentId && (!scope || m.scope === scope));
  }
  clearMemory(agentId: string, scope: MemoryScope): void {
    this.memory = this.memory.filter((m) => !(m.agentId === agentId && m.scope === scope));
  }
}
