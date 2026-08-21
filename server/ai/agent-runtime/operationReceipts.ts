import { createHash } from 'crypto';
import { isPostgresEnabled, query, queryOne } from '../../db/pool';
import { db } from '../../shared/storage';
import type { ToolContext } from '../tools/types';
import { redactSecrets } from '../memory/artifactMemory';
import { buildAgentScopeHash } from './responseCache';

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export interface OperationReceipt {
  idempotencyKey: string;
  status: 'running' | 'completed' | 'failed';
  operation: string;
  requestHash: string;
  resourceId?: string;
  response?: unknown;
  verification?: unknown;
  error?: string;
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function scopeHash(ctx: ToolContext): string {
  return buildAgentScopeHash({
    workspaceId: String(ctx.workspaceId || 'default'), userId: ctx.userId ? String(ctx.userId) : '', role: ctx.role ? String(ctx.role) : '',
    projectId: ctx.projectId ? String(ctx.projectId) : '', appId: ctx.appId ? String(ctx.appId) : '',
    targets: (ctx.targetApps || []).map((target) => ({ id: target.id, name: target.name, baseUrl: target.baseUrl })),
  });
}

export function buildOperationIdentity(input: {
  ctx: ToolContext; operationId: string; method: string; pathParams: Record<string, unknown>;
  query: Record<string, unknown>; body: unknown;
}) {
  const scoped = scopeHash(input.ctx);
  const requestHash = hash({ operationId: input.operationId, method: input.method.toUpperCase(), pathParams: input.pathParams, query: input.query, body: input.body });
  // "Again/another" is an explicit request for a new create. A per-turn request id keeps retries
  // inside that turn idempotent while allowing a later explicit repeat to create a new resource.
  const repeatNonce = /\b(again|another|separate|one more)\b/i.test(String(input.ctx.userMessage || ''))
    ? String(input.ctx.requestId || input.ctx.conversationId || '')
    : '';
  return { scopeHash: scoped, requestHash, idempotencyKey: hash({ scoped, requestHash, repeatNonce }) };
}

function mapRow(row: any): OperationReceipt {
  return {
    idempotencyKey: row.idempotency_key || row.idempotencyKey,
    status: row.status,
    operation: row.operation,
    requestHash: row.request_hash || row.requestHash,
    resourceId: row.resource_id || row.resourceId || undefined,
    response: row.response,
    verification: row.verification,
    error: row.error || undefined,
    createdAt: row.created_at || row.createdAt,
    completedAt: row.completed_at || row.completedAt || undefined,
    expiresAt: row.expires_at || row.expiresAt,
  };
}

export async function beginOperationReceipt(input: {
  ctx: ToolContext; operationId: string; method: string; targetType?: string;
  pathParams: Record<string, unknown>; query: Record<string, unknown>; body: unknown;
}): Promise<{ acquired: boolean; receipt: OperationReceipt }> {
  const identity = buildOperationIdentity(input);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + RECEIPT_TTL_MS).toISOString();
  if (isPostgresEnabled()) {
    const renewed: any = await queryOne(
      `UPDATE agent_operation_receipts SET scope_hash=$2, operation=$3, target_type=$4, request_hash=$5,
       status='running', resource_id=NULL, response=NULL, verification=NULL, error=NULL,
       created_at=now(), completed_at=NULL, expires_at=$6
       WHERE idempotency_key=$1 AND expires_at <= now() RETURNING *`,
      [identity.idempotencyKey, identity.scopeHash, input.operationId, input.targetType || '', identity.requestHash, expiresAt],
    );
    if (renewed) return { acquired: true, receipt: mapRow(renewed) };
    const inserted: any = await queryOne(
      `INSERT INTO agent_operation_receipts (idempotency_key, scope_hash, operation, target_type, request_hash, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [identity.idempotencyKey, identity.scopeHash, input.operationId, input.targetType || '', identity.requestHash, expiresAt],
    );
    if (inserted) return { acquired: true, receipt: mapRow(inserted) };
    const existing: any = await queryOne('SELECT * FROM agent_operation_receipts WHERE idempotency_key = $1', [identity.idempotencyKey]);
    return { acquired: false, receipt: mapRow(existing) };
  }
  const existing = (db.agentOperationReceipts || []).find((row: any) => row.idempotencyKey === identity.idempotencyKey);
  if (existing && Date.parse(existing.expiresAt) > Date.now()) return { acquired: false, receipt: mapRow(existing) };
  if (existing) db.agentOperationReceipts = db.agentOperationReceipts.filter((row: any) => row !== existing);
  const receipt: OperationReceipt = { idempotencyKey: identity.idempotencyKey, status: 'running', operation: input.operationId, requestHash: identity.requestHash, createdAt: now, expiresAt };
  db.agentOperationReceipts.push(receipt);
  return { acquired: true, receipt };
}

export async function completeOperationReceipt(idempotencyKey: string, response: unknown, verification: unknown): Promise<OperationReceipt> {
  const safeResponse = redactSecrets(response);
  const safeVerification = redactSecrets(verification);
  const resourceId = findResourceId(response) || findResourceId(verification);
  if (isPostgresEnabled()) {
    const row: any = await queryOne(
      `UPDATE agent_operation_receipts SET status='completed', resource_id=$2, response=$3::jsonb,
       verification=$4::jsonb, completed_at=now() WHERE idempotency_key=$1 RETURNING *`,
      [idempotencyKey, resourceId || null, JSON.stringify(safeResponse ?? null), JSON.stringify(safeVerification ?? null)],
    );
    return mapRow(row);
  }
  const row = db.agentOperationReceipts.find((item: any) => item.idempotencyKey === idempotencyKey);
  Object.assign(row, { status: 'completed', resourceId, response: safeResponse, verification: safeVerification, completedAt: new Date().toISOString() });
  return mapRow(row);
}

export async function failOperationReceipt(idempotencyKey: string, error: unknown): Promise<void> {
  const message = String((error as Error)?.message || error || 'Operation failed').slice(0, 2_000);
  if (isPostgresEnabled()) {
    await query(`UPDATE agent_operation_receipts SET status='failed', error=$2, completed_at=now() WHERE idempotency_key=$1`, [idempotencyKey, message]);
    return;
  }
  const row = db.agentOperationReceipts.find((item: any) => item.idempotencyKey === idempotencyKey);
  if (row) Object.assign(row, { status: 'failed', error: message, completedAt: new Date().toISOString() });
}

function findResourceId(value: any): string {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['id', 'record_id', 'recordId', 'resource_id', 'resourceId']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number') return String(value[key]);
  }
  for (const key of ['data', 'item', 'record', 'result']) {
    const nested = findResourceId(value[key]);
    if (nested) return nested;
  }
  return '';
}

export function clearOperationReceiptsForTests(): void {
  db.agentOperationReceipts = [];
}
