// Cross-tab record of an in-flight PRE-RUN phase (routing/understanding), which has no agent-runs record yet —
// lets the RunningIndicator show a spinner then. localStorage-backed (survives nav, shared across tabs); a TTL
// reaps stale entries so a closed tab can't leave a permanent spinner; a listener set gives same-tab reactivity.
const KEY = 'tfa_agent_activity';
const TTL_MS = 10 * 60 * 1000;

export interface AgentActivity {
  conversationId: string;
  label: string;
  ts: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): AgentActivity[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list: AgentActivity[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota/private-mode: best-effort */ }
  listeners.forEach((l) => { try { l(); } catch { /* isolate */ } });
}

/** Entries still within the TTL — a stale entry (owner tab gone without clearing) is never counted. */
export function freshActivities(now = Date.now()): AgentActivity[] {
  return read().filter((a) => a && typeof a.ts === 'number' && now - a.ts < TTL_MS);
}

/** Mark a conversation as actively working (routing/understanding). Idempotent per conversation. */
export function markAgentActive(conversationId: string, label: string): void {
  if (!conversationId) return;
  const list = freshActivities().filter((a) => a.conversationId !== conversationId);
  list.push({ conversationId, label: label || 'Working…', ts: Date.now() });
  write(list);
}

/** Clear a conversation's pre-run marker (the phase finished, or a durable run has taken over). */
export function clearAgentActive(conversationId: string): void {
  if (!conversationId) return;
  const before = read();
  const after = before.filter((a) => a.conversationId !== conversationId);
  if (after.length !== before.length) write(after);
}

/** How many conversations have a fresh in-flight pre-run — the count the RunningIndicator adds to agent-runs. */
export function agentActivityCount(now = Date.now()): number {
  return freshActivities(now).length;
}

/** Subscribe to changes (same-tab via the listener set, cross-tab via the `storage` event). Returns unsubscribe. */
export function subscribeAgentActivity(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
