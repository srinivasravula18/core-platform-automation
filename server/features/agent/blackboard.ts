import { db, persistDataInBackground } from '../../shared/storage';

export interface BlackboardEntry {
  id: string;
  sessionId?: string;
  baseUrl: string;
  route: string;
  opened?: string[];
  elements: any[];
  coverage: { total_extracted: number; verified: number; not_unique: number; unresolvable: number; broken: number; loggedIn: boolean };
  createdAt: string;
}

export function writeBlackboard(rec: { id: string; baseUrl: string; route: string; opened?: string[]; elements: any[]; coverage: any }): void {
  const existing = db.blackboard.findIndex((e: BlackboardEntry) => e.id === rec.id);
  const entry: BlackboardEntry = {
    id: rec.id,
    baseUrl: rec.baseUrl,
    route: rec.route,
    opened: rec.opened,
    elements: rec.elements,
    coverage: rec.coverage,
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    db.blackboard[existing] = entry;
  } else {
    db.blackboard.unshift(entry);
    if (db.blackboard.length > 100) db.blackboard.length = 100;
  }
  persistDataInBackground('blackboard updated');
}

export function readBlackboard(id: string): BlackboardEntry | null {
  return db.blackboard.find((e: BlackboardEntry) => e.id === id) || null;
}

export function latestBlackboard(): BlackboardEntry | null {
  if (!db.blackboard.length) return null;
  return db.blackboard.reduce((a: BlackboardEntry, b: BlackboardEntry) =>
    new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
  );
}

export function listBlackboard(): BlackboardEntry[] {
  return db.blackboard.slice(0, 50);
}
