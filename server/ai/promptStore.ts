/**
 * DB-backed prompt store.
 *
 * Each agent has a prompt record. The `body` field can be a custom override
 * (edited by humans in Settings) or empty (meaning: use the hardcoded default
 * from systemPrompts.ts).
 *
 * Prompts are versioned. A new edit creates a new version and marks the prior
 * as `isActive = false`. The active version is what getOrchestrator assembles.
 *
 * Persists into the JSON-backed db in `shared/storage` so the same file-store
 * that the rest of the app uses works out of the box. When the app moves to
 * PostgreSQL this file is the only one that needs to change shape.
 */

import { randomUUID } from 'crypto';
import { db } from '../shared/storage';
import { AGENT_PROMPTS, type AgentName } from './systemPrompts';

export { AGENT_PROMPTS };
export type { AgentName };

export interface PromptVersion {
  id: string;
  agent: string;
  version: number;
  body: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  notes: string;
}

function ensureTable() {
  if (!db.prompts) db.prompts = [] as any;
}

export function listPrompts(): PromptVersion[] {
  ensureTable();
  return (db.prompts as any[]).slice();
}

export function getActivePrompt(agent: string): PromptVersion | null {
  ensureTable();
  return (db.prompts as any[]).find((p) => p.agent === agent && p.isActive) || null;
}

export function getDefaultPrompt(agent: AgentName): string {
  return AGENT_PROMPTS[agent] || '';
}

export function getEffectivePrompt(agent: string): { body: string; source: 'override' | 'default'; version?: number } {
  const active = getActivePrompt(agent);
  if (active && active.body && active.body.trim().length > 0) {
    return { body: active.body, source: 'override', version: active.version };
  }
  if (AGENT_PROMPTS[agent as AgentName]) {
    return { body: AGENT_PROMPTS[agent as AgentName], source: 'default' };
  }
  return { body: '', source: 'default' };
}

export function savePromptVersion(opts: {
  agent: string;
  body: string;
  createdBy: string;
  notes?: string;
  activate?: boolean;
}): PromptVersion {
  ensureTable();
  const all = db.prompts as any[];
  const existing = all.filter((p) => p.agent === opts.agent);
  const nextVersion = existing.length === 0 ? 1 : Math.max(...existing.map((p) => p.version)) + 1;
  const wantActive = opts.activate !== false;
  if (wantActive) {
    existing.forEach((p) => (p.isActive = false));
  }
  const record: PromptVersion = {
    id: randomUUID(),
    agent: opts.agent,
    version: nextVersion,
    body: opts.body,
    isActive: wantActive,
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy,
    notes: opts.notes || '',
  };
  all.push(record);
  return record;
}

export function activatePromptVersion(agent: string, versionId: string): PromptVersion | null {
  ensureTable();
  const all = db.prompts as any[];
  const target = all.find((p) => p.id === versionId && p.agent === agent);
  if (!target) return null;
  all.forEach((p) => {
    if (p.agent === agent) p.isActive = false;
  });
  target.isActive = true;
  return target;
}

export function resetPromptToDefault(agent: string): boolean {
  ensureTable();
  const all = db.prompts as any[];
  let changed = false;
  all.forEach((p) => {
    if (p.agent === agent && p.isActive) {
      p.isActive = false;
      changed = true;
    }
  });
  return changed;
}
