/**
 * ArtifactStore (Phase 4) — content-addressed body storage behind a port, so context
 * carries refs while bytes stay out of prompts. Local adapter: artifact_blobs in PG,
 * an in-memory map in JSON mode. Object-storage production adapter is a later
 * operational phase (plan §15.5); the PORT is what matters now.
 */

import { createHash } from 'crypto';
import { isPostgresEnabled, query, queryOne } from '../../../../server/db/pool';
import { redactSecrets } from '../../../../server/ai/memory/artifactMemory';
import type { ArtifactRef } from '../domain/types';
import type { ArtifactStorePort } from '../ports';

const MAX_BODY_BYTES = 512 * 1024;
const localBlobs = new Map<string, unknown>();

export const artifactStore: ArtifactStorePort = {
  async put(body: unknown, meta: { kind: string }): Promise<ArtifactRef> {
    const redacted = redactSecrets(body);
    let serialized = JSON.stringify(redacted ?? null);
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
      serialized = JSON.stringify({ truncated: true, head: serialized.slice(0, MAX_BODY_BYTES) });
    }
    const contentHash = createHash('sha256').update(serialized).digest('hex');
    if (isPostgresEnabled()) {
      await query(
        'INSERT INTO artifact_blobs (content_hash, body, byte_length) VALUES ($1,$2::jsonb,$3) ON CONFLICT (content_hash) DO NOTHING',
        [contentHash, serialized, Buffer.byteLength(serialized)],
      );
    } else {
      localBlobs.set(contentHash, JSON.parse(serialized));
    }
    return { artifactId: contentHash, kind: meta.kind, contentHash };
  },
  async get(ref: ArtifactRef): Promise<unknown | null> {
    const hash = ref.contentHash || ref.artifactId;
    if (!hash) return null;
    if (isPostgresEnabled()) {
      const row = await queryOne('SELECT body FROM artifact_blobs WHERE content_hash = $1', [hash]);
      return row?.body ?? null;
    }
    return localBlobs.get(hash) ?? null;
  },
};
