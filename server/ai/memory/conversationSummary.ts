import { createHash } from 'crypto';
import { ChatConversations } from '../../db/repository';
import { isPostgresEnabled, query } from '../../db/pool';
import { db } from '../../shared/storage';

export interface ConversationSummarySegment {
  startSeq: number;
  endSeq: number;
  summary: string;
  tokenEstimate: number;
  sourceHash: string;
}

const KEEP_RECENT_TURNS = 60;
const SEGMENT_TURNS = 10;

export async function loadSummarySegments(conversationId: string): Promise<ConversationSummarySegment[]> {
  if (!conversationId) return [];
  if (!isPostgresEnabled()) {
    return ((db as any).chatSummarySegments || []).filter((segment: any) => segment.conversationId === conversationId)
      .sort((a: any, b: any) => a.startSeq - b.startSeq);
  }
  const rows = await query(
    'SELECT start_seq, end_seq, summary, token_estimate, source_hash FROM chat_summary_segments WHERE conversation_id = $1 ORDER BY start_seq',
    [conversationId],
  );
  return rows.map((row: any) => ({ startSeq: Number(row.start_seq), endSeq: Number(row.end_seq), summary: row.summary, tokenEstimate: Number(row.token_estimate), sourceHash: row.source_hash }));
}

export async function ensureSummarySegments(conversationId: string): Promise<ConversationSummarySegment[]> {
  const messages = await ChatConversations.listMessages(conversationId);
  const existing = await loadSummarySegments(conversationId);
  const compactThrough = messages.length - KEEP_RECENT_TURNS;
  let start = (existing.at(-1)?.endSeq || 0) + 1;
  while (start + SEGMENT_TURNS - 1 <= compactThrough) {
    const chunk = messages.filter((message) => message.seq >= start && message.seq < start + SEGMENT_TURNS);
    if (chunk.length !== SEGMENT_TURNS) break;
    const endSeq = chunk.at(-1)!.seq;
    const sourceHash = createHash('sha256').update(JSON.stringify(chunk.map((message) => message.payload))).digest('hex');
    const summary = `[turns ${start}-${endSeq}; source ${sourceHash.slice(0, 12)}]\n${chunk
      .map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').slice(0, 800)}`)
      .join('\n')}`;
    const segment: ConversationSummarySegment = { startSeq: start, endSeq, summary, tokenEstimate: Math.ceil(summary.length / 4), sourceHash };
    if (isPostgresEnabled()) {
      await query(
        `INSERT INTO chat_summary_segments (conversation_id, start_seq, end_seq, summary, token_estimate, source_hash)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (conversation_id, start_seq, end_seq) DO NOTHING`,
        [conversationId, start, endSeq, summary, segment.tokenEstimate, sourceHash],
      );
    } else {
      if (!(db as any).chatSummarySegments) (db as any).chatSummarySegments = [];
      (db as any).chatSummarySegments.push({ conversationId, ...segment });
    }
    existing.push(segment);
    start = endSeq + 1;
  }
  return existing;
}

export function renderSummarySegments(segments: ConversationSummarySegment[]): string {
  if (!segments.length) return '';
  return `\n\nCONVERSATION SUMMARY SEGMENTS (immutable, oldest first):\n${segments.map((segment) => segment.summary).join('\n\n')}`;
}
