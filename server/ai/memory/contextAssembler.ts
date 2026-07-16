import { randomUUID } from 'crypto';
import { ChatConversations } from '../../db/repository';
import { isPostgresEnabled, query } from '../../db/pool';
import { db } from '../../shared/storage';
import { assemblePromptBudget } from '../contextBudget';
import { ensureSummarySegments, renderSummarySegments } from './conversationSummary';
import { loadConversationLedger, renderConversationLedger } from './conversationState';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  kind?: string;
}

function normalize(turn: any): ConversationMessage | null {
  const content = String(turn?.content ?? turn?.text ?? turn?.summary ?? '').trim();
  if (!content) return null;
  return { role: turn?.role === 'assistant' ? 'assistant' : 'user', content, kind: String(turn?.kind || 'text') };
}

function fallbackTurns(history: unknown): ConversationMessage[] {
  return (Array.isArray(history) ? history : []).map(normalize).filter(Boolean) as ConversationMessage[];
}

async function persistManifest(manifest: any) {
  if (isPostgresEnabled()) {
    await query(
      `INSERT INTO context_manifests (id, conversation_id, path, model, total_turns, verbatim_turns, estimated_tokens, entries, retrieved_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [manifest.id, manifest.conversationId || null, manifest.path, manifest.model, manifest.totalTurns, manifest.verbatimTurns, manifest.estimatedTokens, JSON.stringify(manifest.entries), JSON.stringify(manifest.retrievedRefs || [])],
    );
    return;
  }
  if (!(db as any).contextManifests) (db as any).contextManifests = [];
  (db as any).contextManifests.unshift(manifest);
  if ((db as any).contextManifests.length > 1_000) (db as any).contextManifests.length = 1_000;
}

export async function assembleConversationContext(input: {
  conversationId?: string;
  fallbackHistory?: unknown;
  currentMessage: string;
  model: string;
  path: string;
}) {
  const stored = input.conversationId ? await ChatConversations.get(input.conversationId).catch(() => null) : null;
  let turns = stored?.turns?.map(normalize).filter(Boolean) as ConversationMessage[] | undefined;
  if (!turns?.length) turns = fallbackTurns(input.fallbackHistory);
  if (turns.at(-1)?.role === 'user' && turns.at(-1)?.content === input.currentMessage.trim()) turns = turns.slice(0, -1);

  if (input.conversationId && !stored) {
    await ChatConversations.updateMetadata({ id: input.conversationId, title: input.currentMessage.slice(0, 120) }).catch(() => null);
  }

  const segments = input.conversationId && stored ? await ensureSummarySegments(input.conversationId) : [];
  const compactedThrough = segments.at(-1)?.endSeq || 0;
  const verbatimTurns = turns.slice(compactedThrough);
  const ledger = input.conversationId ? await loadConversationLedger(input.conversationId) : { lines: [], runIds: [] };
  const ledgerContent = ledger.lines.join('\n');
  const candidates = [
    ...(ledgerContent ? [{ key: 'ledger', content: ledgerContent, priority: 900_000 }] : []),
    ...segments.map((segment, index) => ({ key: `segment:${index}`, content: segment.summary, priority: 800_000 + index, tokenEstimate: segment.tokenEstimate })),
    ...verbatimTurns.map((turn, index) => ({ key: `turn:${compactedThrough + index}`, content: turn.content, priority: 10_000 + index })),
    { key: 'current-message', content: input.currentMessage, priority: 1_000_000 },
  ];
  const budget = assemblePromptBudget(candidates, { model: input.model });
  const includedKeys = new Set(budget.included.map((candidate) => candidate.key));
  const history = verbatimTurns.filter((_, index) => includedKeys.has(`turn:${compactedThrough + index}`));
  const includedSegments = segments.filter((_, index) => includedKeys.has(`segment:${index}`));
  const includedLedger = includedKeys.has('ledger') ? ledger : { lines: [], runIds: [] };
  const manifest = {
    id: `CTX-${randomUUID()}`,
    conversationId: input.conversationId,
    path: input.path,
    model: input.model,
    totalTurns: turns.length,
    verbatimTurns: history.length,
    estimatedTokens: budget.totalTokens,
    entries: budget.entries,
    retrievedRefs: ledger.runIds,
    createdAt: new Date().toISOString(),
  };
  await persistManifest(manifest).catch((error) => console.warn('[context] manifest persistence failed:', error?.message || error));
  const memoryBlock = `${renderConversationLedger(includedLedger)}${renderSummarySegments(includedSegments)}`;
  const promptBlock = `${memoryBlock}${renderConversationHistory(history)}`;
  return { history, segments: includedSegments, ledger: includedLedger, memoryBlock, promptBlock, manifest };
}

export function renderConversationHistory(history: ConversationMessage[]): string {
  if (!history.length) return '';
  return `\n\nRECENT CONVERSATION (oldest first):\n${history.map((message) => `${message.role}: ${message.content}`).join('\n')}`;
}
