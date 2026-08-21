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
  workspaceId?: string;
  ownerId?: string;
  projectId?: string;
  appId?: string;
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
  const ttlMs = validity.kind === 'file-content' ? 30 * 24 * 60 * 60 * 1_000 : 5 * 60 * 1_000;
  const artifact = {
    id: `ART-${randomUUID()}`,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId || 'default',
    ownerId: input.ownerId || '',
    projectId: input.projectId || '',
    appId: input.appId || '',
    contentHash,
    runId: input.runId || '',
    toolName: input.toolName,
    targetKey,
    digest: digestFor(input.toolName, targetKey, body),
    validity,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    body,
    createdAt: new Date().toISOString(),
  };
  if (isPostgresEnabled()) {
    await query('INSERT INTO artifact_blobs (content_hash, body, byte_length) VALUES ($1,$2::jsonb,$3) ON CONFLICT (content_hash) DO NOTHING', [contentHash, serialized, Buffer.byteLength(serialized)]);
    const row = await queryOne(
      `INSERT INTO conversation_artifacts (id, conversation_id, workspace_id, owner_id, project_id, app_id, content_hash, run_id, tool_name, target_key, digest, validity, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (conversation_id, content_hash, tool_name, target_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
       RETURNING id`,
      [artifact.id, artifact.conversationId, artifact.workspaceId, artifact.ownerId || null, artifact.projectId || null, artifact.appId || null, contentHash, artifact.runId || null, artifact.toolName, targetKey, artifact.digest, JSON.stringify(validity), artifact.expiresAt],
    );
    return { ...artifact, id: row?.id || artifact.id };
  }
  if (!(db as any).conversationArtifacts) (db as any).conversationArtifacts = [];
  const existing = (db as any).conversationArtifacts.find((item: any) => item.conversationId === input.conversationId && item.contentHash === contentHash && item.toolName === input.toolName && item.targetKey === targetKey);
  if (existing) return existing;
  (db as any).conversationArtifacts.push(artifact);
  return artifact;
}

function artifactMatchesScope(artifact: any, conversationId: string, ctx: ToolContext): boolean {
  if (artifact.conversationId === conversationId) return true;
  if (!ctx.userId || String(artifact.ownerId || artifact.owner_id || '') !== String(ctx.userId)) return false;
  return String(artifact.workspaceId || artifact.workspace_id || 'default') === String(ctx.workspaceId || 'default')
    && String(artifact.projectId || artifact.project_id || '') === String(ctx.projectId || '')
    && String(artifact.appId || artifact.app_id || '') === String(ctx.appId || '');
}

async function getArtifact(id: string, conversationId: string, ctx: ToolContext): Promise<any | null> {
  if (!isPostgresEnabled()) {
    const artifact = ((db as any).conversationArtifacts || []).find((item: any) => item.id === id);
    return artifact && artifactMatchesScope(artifact, conversationId, ctx) ? artifact : null;
  }
  const row = await queryOne(
    `SELECT a.*, b.body FROM conversation_artifacts a JOIN artifact_blobs b ON b.content_hash = a.content_hash
     WHERE a.id = $1 AND (a.conversation_id = $2 OR
       ($3 <> '' AND a.owner_id = $3 AND a.workspace_id = $4
        AND COALESCE(a.project_id, '') = $5 AND COALESCE(a.app_id, '') = $6))`,
    [id, conversationId, String(ctx.userId || ''), String(ctx.workspaceId || 'default'), String(ctx.projectId || ''), String(ctx.appId || '')],
  );
  return row ? { id: row.id, conversationId: row.conversation_id, workspaceId: row.workspace_id, ownerId: row.owner_id, projectId: row.project_id, appId: row.app_id, toolName: row.tool_name, targetKey: row.target_key, digest: row.digest, validity: row.validity, expiresAt: row.expires_at, body: row.body } : null;
}

export async function fetchArtifact(id: string, ctx: ToolContext) {
  const conversationId = String(ctx.conversationId || '');
  const artifact = await getArtifact(id, conversationId, ctx);
  if (!artifact) throw new Error('Artifact not found in this authorized scope.');
  let stale = artifact.expiresAt ? Date.parse(artifact.expiresAt) < Date.now() : false;
  if (!stale && artifact.validity?.kind === 'file-content' && artifact.targetKey) {
    const current = await readCodeFileInScope(artifact.targetKey, { projectId: ctx.projectId, appId: ctx.appId }).catch(() => null);
    stale = current === null || hash(current) !== artifact.validity.sourceHash;
  }
  return { id: artifact.id, digest: artifact.digest, stale, provenance: stale ? 'previously observed; freshness check failed' : 'revalidated', body: artifact.body };
}

export async function searchConversationMemory(conversationId: string, queryText: string, limit = 20, ctx?: ToolContext) {
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
    const rows = await query(
      `SELECT id, digest FROM conversation_artifacts
       WHERE digest ILIKE $2 AND (conversation_id = $1 OR
         ($4 <> '' AND owner_id = $4 AND workspace_id = $5
          AND COALESCE(project_id, '') = $6 AND COALESCE(app_id, '') = $7))
       ORDER BY created_at DESC LIMIT $3`,
      [conversationId, `%${needle}%`, limit, String(ctx?.userId || ''), String(ctx?.workspaceId || 'default'), String(ctx?.projectId || ''), String(ctx?.appId || '')],
    );
    artifacts = rows.map((row: any) => ({ kind: 'artifact', ref: row.id, text: row.digest }));
  } else {
    artifacts = ((db as any).conversationArtifacts || []).filter((artifact: any) => artifactMatchesScope(artifact, conversationId, ctx || {}) && artifact.digest.toLowerCase().includes(needle))
      .map((artifact: any) => ({ kind: 'artifact', ref: artifact.id, text: artifact.digest }));
  }
  return [...messages, ...segments, ...artifacts].slice(0, Math.max(1, Math.min(100, limit)));
}
