import { createHash, randomUUID } from 'crypto';
import { ChatConversations } from '../../db/repository';
import { isPostgresEnabled, query, queryOne } from '../../db/pool';
import { db } from '../../shared/storage';
import { readCodeFileInScope } from '../../features/projects/codeSearch';
import { loadSummarySegments } from './conversationSummary';
import type { ToolContext } from '../tools/types';

const SECRET_KEY = /password|passwd|secret|token|cookie|authorization|storage.?state/i;
const EVIDENTIARY_TOOL = /search|read|inspect|explore|query|fetch|execute|run|metadata|schema|selector|coverage|evidence/i;

/** Shared redaction contract (Phase 4): evidence providers reuse the same secret-key scrub. */
export function redactSecrets(value: unknown): unknown {
  return sanitize(value);
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item, seen)]));
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function digestFor(toolName: string, targetKey: string, body: unknown) {
  const text = JSON.stringify(body).replace(/\s+/g, ' ');
  return `${toolName}${targetKey ? ` ${targetKey}` : ''}: ${text.slice(0, 1_000)}`;
}

export function isEvidentiaryTool(toolName: string): boolean {
  return EVIDENTIARY_TOOL.test(toolName) && !/navigate|open_module/i.test(toolName);
}

export async function rememberToolResult(input: {
  conversationId: string;
  runId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}) {
  if (!input.conversationId || !isEvidentiaryTool(input.toolName)) return null;
  const body = sanitize(input.result);
  const serialized = JSON.stringify(body);
  const contentHash = hash(serialized);
  const targetKey = String(input.arguments.path || input.arguments.url || input.arguments.id || input.arguments.query || '').slice(0, 500);
  const validity = input.toolName === 'read_code_file' && typeof (body as any)?.content === 'string'
    ? { kind: 'file-content', target: targetKey, sourceHash: hash((body as any).content) }
    : { kind: 'captured-at', capturedAt: new Date().toISOString() };
  const artifact = {
    id: `ART-${randomUUID()}`,
    conversationId: input.conversationId,
    contentHash,
    runId: input.runId || '',
    toolName: input.toolName,
    targetKey,
    digest: digestFor(input.toolName, targetKey, body),
    validity,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    body,
    createdAt: new Date().toISOString(),
  };
  if (isPostgresEnabled()) {
    await query('INSERT INTO artifact_blobs (content_hash, body, byte_length) VALUES ($1,$2::jsonb,$3) ON CONFLICT (content_hash) DO NOTHING', [contentHash, serialized, Buffer.byteLength(serialized)]);
    const row = await queryOne(
      `INSERT INTO conversation_artifacts (id, conversation_id, content_hash, run_id, tool_name, target_key, digest, validity, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (conversation_id, content_hash, tool_name, target_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
       RETURNING id`,
      [artifact.id, artifact.conversationId, contentHash, artifact.runId || null, artifact.toolName, targetKey, artifact.digest, JSON.stringify(validity), artifact.expiresAt],
    );
    return { ...artifact, id: row?.id || artifact.id };
  }
  if (!(db as any).conversationArtifacts) (db as any).conversationArtifacts = [];
  const existing = (db as any).conversationArtifacts.find((item: any) => item.conversationId === input.conversationId && item.contentHash === contentHash && item.toolName === input.toolName && item.targetKey === targetKey);
  if (existing) return existing;
  (db as any).conversationArtifacts.push(artifact);
  return artifact;
}

async function getArtifact(id: string, conversationId: string): Promise<any | null> {
  if (!isPostgresEnabled()) return ((db as any).conversationArtifacts || []).find((artifact: any) => artifact.id === id && artifact.conversationId === conversationId) || null;
  const row = await queryOne(
    `SELECT a.*, b.body FROM conversation_artifacts a JOIN artifact_blobs b ON b.content_hash = a.content_hash
     WHERE a.id = $1 AND a.conversation_id = $2`,
    [id, conversationId],
  );
  return row ? { id: row.id, conversationId: row.conversation_id, toolName: row.tool_name, targetKey: row.target_key, digest: row.digest, validity: row.validity, expiresAt: row.expires_at, body: row.body } : null;
}

export async function fetchArtifact(id: string, ctx: ToolContext) {
  const conversationId = String(ctx.conversationId || '');
  const artifact = await getArtifact(id, conversationId);
  if (!artifact) throw new Error('Artifact not found in this conversation.');
  let stale = artifact.expiresAt ? Date.parse(artifact.expiresAt) < Date.now() : false;
  if (!stale && artifact.validity?.kind === 'file-content' && artifact.targetKey) {
    const current = await readCodeFileInScope(artifact.targetKey, { projectId: ctx.projectId, appId: ctx.appId }).catch(() => null);
    stale = current === null || hash(current) !== artifact.validity.sourceHash;
  }
  return { id: artifact.id, digest: artifact.digest, stale, provenance: stale ? 'previously observed; freshness check failed' : 'revalidated', body: artifact.body };
}

export async function searchConversationMemory(conversationId: string, queryText: string, limit = 20) {
  const needle = queryText.toLowerCase().trim();
  if (!conversationId || !needle) return [];
  const messages = (await ChatConversations.listMessages(conversationId))
    .filter((message) => message.content.toLowerCase().includes(needle))
    .map((message) => ({ kind: 'turn', ref: `turn:${message.seq}`, text: message.content }));
  const segments = (await loadSummarySegments(conversationId))
    .filter((segment) => segment.summary.toLowerCase().includes(needle))
    .map((segment) => ({ kind: 'segment', ref: `segment:${segment.startSeq}-${segment.endSeq}`, text: segment.summary }));
  let artifacts: any[];
  if (isPostgresEnabled()) {
    const rows = await query('SELECT id, digest FROM conversation_artifacts WHERE conversation_id = $1 AND digest ILIKE $2 ORDER BY created_at DESC LIMIT $3', [conversationId, `%${needle}%`, limit]);
    artifacts = rows.map((row: any) => ({ kind: 'artifact', ref: row.id, text: row.digest }));
  } else {
    artifacts = ((db as any).conversationArtifacts || []).filter((artifact: any) => artifact.conversationId === conversationId && artifact.digest.toLowerCase().includes(needle))
      .map((artifact: any) => ({ kind: 'artifact', ref: artifact.id, text: artifact.digest }));
  }
  return [...messages, ...segments, ...artifacts].slice(0, Math.max(1, Math.min(100, limit)));
}
