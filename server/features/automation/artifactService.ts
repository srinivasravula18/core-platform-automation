/**
 * Record & Play — run artifact storage.
 *
 * After a run the agent uploads binary artifacts (video, trace.zip, screenshots, HTML report, junit,
 * logs). They're written under automation-artifacts/<jobId>/ on the cloud host and indexed in
 * automation_artifacts. Downloads go through a scope-authorized route (not blanket static serving) so
 * one tenant can never read another's traces.
 */

import path from 'path';
import fs from 'fs/promises';
import { AutomationArtifacts } from '../../db/repository';
import { isPostgresEnabled } from '../../db/pool';
import { persistDataInBackground } from '../../shared/storage';
import { emitEvent } from './eventsService';
import type { ArtifactKind } from './types';

const ARTIFACT_ROOT = path.resolve(process.cwd(), 'automation-artifacts');

const CONTENT_TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function safeName(name: string): string {
  return String(name || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
}

export async function saveArtifact(input: { jobId: string; kind: ArtifactKind; filename: string; buffer: Buffer; ownerId?: string }) {
  const filename = safeName(input.filename);
  const dir = path.join(ARTIFACT_ROOT, safeName(input.jobId));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, input.buffer);
  const row = await AutomationArtifacts.create({
    jobId: input.jobId,
    kind: input.kind || 'other',
    filename,
    size: input.buffer.length,
    // Store a path relative to the root so the row stays valid if the deployment moves.
    path: path.relative(ARTIFACT_ROOT, filePath),
  });
  if (!isPostgresEnabled()) persistDataInBackground('artifact saved');
  if (input.ownerId) {
    await emitEvent({ scopeType: 'job', scopeId: input.jobId, type: 'job.artifact', ownerId: input.ownerId, data: { artifact: row } });
  }
  return row;
}

export async function listArtifacts(jobId: string) {
  return AutomationArtifacts.listByJob(jobId);
}

/** Resolve a single artifact + its absolute file path (across both stores). */
export async function resolveArtifact(jobId: string, artifactId: string): Promise<{ row: any; absPath: string } | null> {
  const rows = await AutomationArtifacts.listByJob(jobId);
  const row = rows.find((a: any) => a.id === artifactId);
  if (!row) return null;
  const absPath = path.resolve(ARTIFACT_ROOT, row.path);
  // Defense-in-depth: never let a crafted stored path escape the artifact root.
  if (!absPath.startsWith(ARTIFACT_ROOT)) return null;
  return { row, absPath };
}
