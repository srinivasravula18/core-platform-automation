import { randomUUID } from 'crypto';
import { db } from './storage';

const artifactKeys = ['plans', 'suites', 'cases', 'runs', 'reports', 'agentRuns'] as const;

function normalizeFolderName(name: string) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function slugifyFolderName(name: string) {
  return normalizeFolderName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getFolderPathParts(folder: any): string[] {
  const parts = [folder?.name || ''];
  let parentId = folder?.parentId || '';
  const visited = new Set<string>();

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = db.folders.find((item: any) => item.id === parentId);
    if (!parent) break;
    parts.unshift(parent.name || '');
    parentId = parent.parentId || '';
  }

  return parts.filter(Boolean);
}

function inferFolderNameFromPrompt(prompt: string, targetUrl = '') {
  const text = String(prompt || '').trim();
  const urlHost = (() => {
    try {
      return targetUrl ? new URL(targetUrl).hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  })();

  const featureMatch = text.match(/\b(?:test|verify|validate|cover)\s+(?:the\s+)?(.+?)(?:\s+(?:at|on|for)\s+https?:\/\/|\s*$)/i);
  const feature = normalizeFolderName(featureMatch?.[1] || text || 'Generated QA Work').slice(0, 60);
  return urlHost ? `${urlHost} / ${feature}` : feature;
}

export function getFolderPath(folderId: string) {
  if (!folderId) return 'Uncategorized';
  const folder = db.folders.find((item: any) => item.id === folderId);
  if (!folder) return 'Uncategorized';
  return getFolderPathParts(folder).join(' / ') || folder.name || 'Uncategorized';
}

export function createFolder(name: string, parentId = '', extra: any = {}) {
  const normalizedName = normalizeFolderName(name);
  if (!normalizedName) return null;

  const existing = db.folders.find((item: any) =>
    normalizeFolderName(item.name).toLowerCase() === normalizedName.toLowerCase() &&
    (item.parentId || '') === (parentId || '')
  );
  if (existing) return existing;

  const now = new Date();
  const folder = {
    id: `FOL-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: normalizedName,
    parentId: parentId || '',
    description: extra.description || '',
    kind: extra.kind || 'Feature',
    createdBy: extra.createdBy || 'User',
    createdAt: now,
    updatedAt: now,
  };
  db.folders.unshift(folder);
  return folder;
}

export function resolveFolderPath(pathText: string, extra: any = {}) {
  const parts = String(pathText || '')
    .split('/')
    .map((part) => normalizeFolderName(part))
    .filter(Boolean);

  let parentId = '';
  let folder: any = null;
  for (const part of parts) {
    folder = createFolder(part, parentId, extra);
    parentId = folder?.id || '';
  }
  return folder;
}

export function extractFolderMention(prompt: string) {
  const match = String(prompt || '').match(/@([A-Za-z0-9][A-Za-z0-9 _./-]{1,80})/);
  return match ? normalizeFolderName(match[1]).replace(/[.,;!?]+$/, '') : '';
}

export function resolveFolderForAgent(options: { folderId?: string; folderMention?: string; prompt?: string; targetUrl?: string }) {
  if (options.folderId && db.folders.some((folder: any) => folder.id === options.folderId)) {
    return db.folders.find((folder: any) => folder.id === options.folderId);
  }

  const mention = normalizeFolderName(options.folderMention || extractFolderMention(options.prompt || ''));
  if (mention) {
    const mentionSlug = slugifyFolderName(mention);
    const matched = db.folders.find((folder: any) =>
      slugifyFolderName(folder.name) === mentionSlug ||
      slugifyFolderName(getFolderPath(folder.id)) === mentionSlug
    );
    if (matched) return matched;
    return resolveFolderPath(mention, { createdBy: 'QA Assistant', kind: 'Feature' });
  }

  return resolveFolderPath(inferFolderNameFromPrompt(options.prompt || '', options.targetUrl || ''), {
    createdBy: 'QA Assistant',
    kind: 'Auto',
  });
}

export function folderHasArtifacts(folderId: string) {
  return artifactKeys.some((key) => (db[key] as any[]).some((item) => item.folderId === folderId));
}
