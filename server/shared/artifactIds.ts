import { db } from './storage';
import { isPostgresEnabled, query, queryOne } from '../db/pool';

export type SequencedArtifactType = 'PLAN' | 'SUITE' | 'TC';

type ArtifactIdContext = {
  ownerId?: string;
  websiteId?: string;
  websiteName?: string;
  targetUrl?: string;
  sourceText?: string;
};

const artifactTables: Record<SequencedArtifactType, string> = {
  PLAN: 'plans',
  SUITE: 'suites',
  TC: 'cases',
};

export function normalizeWebsiteKey(name: string): string {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'GENERAL';
}

function urlHost(value: string): string {
  try { return new URL(value).host.toLowerCase(); } catch { return ''; }
}

export function websiteKeyForArtifact(context: ArtifactIdContext = {}): string {
  const sites = (Array.isArray(db.websites) ? db.websites : [])
    .filter((website: any) => !context.ownerId || website.ownerId === context.ownerId);
  let website: any = null;

  if (context.websiteId) website = sites.find((site: any) => site.id === context.websiteId);
  if (!website && context.websiteName) {
    const wanted = context.websiteName.trim().toLowerCase();
    website = sites.find((site: any) => String(site.name || '').trim().toLowerCase() === wanted);
  }
  if (!website && context.targetUrl) {
    const host = urlHost(context.targetUrl);
    website = sites.find((site: any) => host && urlHost(site.baseUrl) === host);
  }
  if (!website && context.sourceText) {
    const source = context.sourceText.toLowerCase();
    website = [...sites]
      .sort((a: any, b: any) => String(b.name || '').length - String(a.name || '').length)
      .find((site: any) => site.name && source.includes(String(site.name).toLowerCase()));
  }
  if (!website && sites.length === 1) website = sites[0];

  return normalizeWebsiteKey(website?.name || 'GENERAL');
}

function highestExistingNumber(ids: string[], prefix: string): number {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  return ids.reduce((highest, id) => Math.max(highest, Number(pattern.exec(id)?.[1] || 0)), 0);
}

export async function nextArtifactId(type: SequencedArtifactType, context: ArtifactIdContext = {}): Promise<string> {
  const websiteKey = websiteKeyForArtifact(context);
  const prefix = `${websiteKey}-${type}`;
  let value: number;

  if (isPostgresEnabled()) {
    const existing = await query(`SELECT id FROM ${artifactTables[type]} WHERE id LIKE $1`, [`${prefix}-%`]);
    const seed = highestExistingNumber(existing.map((row: any) => String(row.id)), prefix) + 1;
    const counter = await queryOne(
      `INSERT INTO artifact_id_counters (website_key, artifact_type, last_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (website_key, artifact_type) DO UPDATE SET
         last_value = GREATEST(artifact_id_counters.last_value + 1, EXCLUDED.last_value)
       RETURNING last_value`,
      [websiteKey, type, seed],
    );
    value = Number(counter.last_value);
  } else {
    if (!db.artifactIdCounters) db.artifactIdCounters = {};
    const counterKey = `${websiteKey}:${type}`;
    const collection = type === 'PLAN' ? db.plans : type === 'SUITE' ? db.suites : db.cases;
    const seed = highestExistingNumber((collection || []).map((item: any) => String(item.id || '')), prefix);
    value = Math.max(Number(db.artifactIdCounters[counterKey] || 0), seed) + 1;
    db.artifactIdCounters[counterKey] = value;
  }

  return `${prefix}-${String(value).padStart(6, '0')}`;
}
