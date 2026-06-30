import { getDb, chatSessions, chatMessages, artifacts, connectedRepo, testCases, runs } from "@atp/db";
import { eq, desc, sql, asc } from "drizzle-orm";

export interface RepoRow { source: string; ref: string; baseUrl?: string | null; branch?: string | null; sha?: string | null; framework?: string | null; fileCount?: number | null; hasMetadata?: boolean | null; error?: string | null }

export async function saveRepo(info: RepoRow): Promise<void> {
  const db = getDb();
  const existing = await getRepo();
  const baseUrl = info.baseUrl ?? existing?.baseUrl ?? null; // keep the target URL across re-connect
  const row = { id: "active", source: info.source, ref: info.ref, baseUrl, branch: info.branch ?? null, sha: info.sha ?? null, framework: info.framework ?? null, fileCount: info.fileCount ?? null, hasMetadata: info.hasMetadata ?? null, error: info.error ?? null, updatedAt: new Date() };
  await db.insert(connectedRepo).values(row).onConflictDoUpdate({ target: connectedRepo.id, set: row });
}

/** Set just the target app URL (where the live/localhost app runs) — the execution target. */
export async function setTarget(baseUrl: string): Promise<void> {
  const db = getDb();
  const existing = await getRepo();
  if (existing) await db.update(connectedRepo).set({ baseUrl, updatedAt: new Date() }).where(eq(connectedRepo.id, "active"));
  else await db.insert(connectedRepo).values({ id: "active", source: "local", ref: "(target only)", baseUrl, updatedAt: new Date() });
}
export async function getRepo() {
  const db = getDb();
  const [r] = await db.select().from(connectedRepo).where(eq(connectedRepo.id, "active"));
  return r ?? null;
}
export async function clearRepo(): Promise<void> {
  const db = getDb();
  await db.delete(connectedRepo).where(eq(connectedRepo.id, "active"));
}

/**
 * Postgres-backed history + artifact store (local DB, not JSON files).
 * Chats and every generated script/cases/run are persisted to the database so they survive
 * restarts and are queryable. All functions are async (DB round-trips).
 */

export interface StoredStep { tool: string; isError?: boolean }

export async function saveTurn(id: string, user: string, assistant: string, steps: StoredStep[]): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(chatSessions)
    .values({ id, title: user.slice(0, 64), updatedAt: now })
    .onConflictDoUpdate({ target: chatSessions.id, set: { updatedAt: now } });
  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(chatMessages).where(eq(chatMessages.sessionId, id));
  const n = countRow?.n ?? 0;
  await db.insert(chatMessages).values([
    { sessionId: id, role: "user", content: user, seq: n },
    { sessionId: id, role: "assistant", content: assistant, steps, seq: n + 1 },
  ]);
}

export async function listSessions() {
  const db = getDb();
  const rows = await db
    .select({ id: chatSessions.id, title: chatSessions.title, favorite: chatSessions.favorite, updatedAt: chatSessions.updatedAt, count: sql<number>`count(${chatMessages.id})::int` })
    .from(chatSessions)
    .leftJoin(chatMessages, eq(chatMessages.sessionId, chatSessions.id))
    .groupBy(chatSessions.id)
    .orderBy(desc(chatSessions.favorite), desc(chatSessions.updatedAt))
    .limit(50);
  return rows.map((r) => ({ id: r.id, title: r.title ?? "Untitled", favorite: r.favorite, updatedAt: r.updatedAt?.getTime() ?? 0, count: r.count }));
}

export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  await getDb().update(chatSessions).set({ favorite }).where(eq(chatSessions.id, id));
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb();
  await db.delete(chatMessages).where(eq(chatMessages.sessionId, id)); // FK: messages first
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}

export async function getSession(id: string) {
  const db = getDb();
  const [s] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
  if (!s) return null;
  const msgs = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, id)).orderBy(asc(chatMessages.seq));
  return { id: s.id, title: s.title, messages: msgs.map((m) => ({ role: m.role, content: m.content, steps: m.steps ?? [] })) };
}

let artSeq = 0;
export async function addArtifact(sessionId: string, kind: string, object: string, title: string, content: string, ext: string) {
  const db = getDb();
  const id = `${Date.now().toString(36)}-${++artSeq}`;
  await db.insert(artifacts).values({ id, sessionId, kind, object, title, content, ext });
  return { id };
}

export async function listArtifacts() {
  const db = getDb();
  const rows = await db
    .select({ id: artifacts.id, sessionId: artifacts.sessionId, kind: artifacts.kind, object: artifacts.object, title: artifacts.title, ext: artifacts.ext, createdAt: artifacts.createdAt })
    .from(artifacts)
    .orderBy(desc(artifacts.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt?.getTime() ?? 0 }));
}

export async function getArtifact(id: string) {
  const db = getDb();
  const [a] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return a ?? null;
}

/** Persist a tool result — both the raw artifact (for the viewer) AND structured DB rows
 *  (test_cases / runs) so the entity pages are real DB-backed tables. */
export async function captureArtifact(sessionId: string, tool: string, result: any): Promise<void> {
  if (!result || result.error) return;
  const db = getDb();
  if (tool === "generate_script" && result.script) {
    await addArtifact(sessionId, "script", result.object, `Playwright spec — ${result.object}`, result.script, "spec.ts");
  } else if (tool === "generate_tests" && result.uiCases) {
    await addArtifact(sessionId, "cases", result.object, `Test cases — ${result.object}`, JSON.stringify(result, null, 2), "json");
    const rows = [
      ...result.uiCases.map((c: any) => ({ sessionId, code: c.code, title: c.title, object: result.object, kind: "ui", technique: c.technique, priority: c.priority ?? "p2", suiteTypes: c.suites ?? [] })),
      ...(result.apiCases ?? []).map((c: any) => ({ sessionId, code: c.caseId, title: c.caseId, object: result.object, kind: "api", technique: c.variant ?? "contract", priority: "p2", suiteTypes: ["api"] })),
    ];
    if (rows.length) await db.insert(testCases).values(rows);
  } else if ((tool === "run_suite" || tool === "run_headless") && result.runId) {
    const tag = result.headless ? "headless run" : `${result.suiteType} run`;
    await addArtifact(sessionId, "run", result.object, `${tag} — ${result.object} (${result.status})`, JSON.stringify(result, null, 2), "json");
    await db.insert(runs).values({ sessionId, object: result.object, suiteType: result.suiteType, total: result.total, passed: result.passed, failed: result.failed, status: result.status, accuracy: result.confidence?.score ?? (result.headless ? 100 : null), env: result.headless ? "headless" : "local", startedAt: new Date(), finishedAt: new Date() });
  }
}

export async function listCases() {
  const db = getDb();
  const rows = await db.select().from(testCases).orderBy(desc(testCases.createdAt)).limit(300);
  return rows.map((c) => ({ id: c.id, code: c.code, title: c.title, object: c.object, kind: c.kind, technique: c.technique, priority: c.priority, suiteTypes: c.suiteTypes, createdAt: c.createdAt?.getTime() ?? 0 }));
}

export async function listRuns() {
  const db = getDb();
  const rows = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(100);
  return rows.map((r) => ({ id: r.id, object: r.object, suiteType: r.suiteType, total: r.total, passed: r.passed, failed: r.failed, status: r.status, accuracy: r.accuracy, createdAt: r.createdAt?.getTime() ?? 0 }));
}
