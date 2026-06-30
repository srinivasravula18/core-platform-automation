import { getDb, appSettings, websites, websiteUsers } from "@atp/db";
import { eq, asc } from "drizzle-orm";
import { encryptSecret, decryptSecret, maskSecret } from "@atp/shared";
import { MODEL_REGISTRY, defaultModel, PROVIDER_LABELS, type ProviderName } from "@atp/llm";

const PROVIDERS: ProviderName[] = ["anthropic", "openai", "google", "local-claude", "local-codex"];
const ENV_KEY: Partial<Record<ProviderName, string | undefined>> = {
  anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, google: process.env.GOOGLE_API_KEY,
};
const safeDecrypt = (s?: string): string => { try { return s ? decryptSecret(s) : ""; } catch { return ""; } };

type ProviderCfg = { apiKeyEnc?: string; model?: string; authMode?: string; enabled?: boolean };

async function rawSettings() {
  const [s] = await getDb().select().from(appSettings).where(eq(appSettings.id, "active"));
  return s ?? null;
}
async function upsert(patch: Partial<{ providers: Record<string, ProviderCfg>; defaultProvider: string; dailyCostLimit: string; autonomyLevel: string }>) {
  const db = getDb();
  const s = await rawSettings();
  const row = {
    id: "active",
    providers: patch.providers ?? (s?.providers as Record<string, ProviderCfg>) ?? {},
    defaultProvider: patch.defaultProvider ?? s?.defaultProvider ?? null,
    dailyCostLimit: patch.dailyCostLimit ?? s?.dailyCostLimit ?? "50",
    autonomyLevel: patch.autonomyLevel ?? s?.autonomyLevel ?? "review",
    updatedAt: new Date(),
  };
  await db.insert(appSettings).values(row).onConflictDoUpdate({ target: appSettings.id, set: row });
}

export async function getSettings() {
  const s = await rawSettings();
  const provs = (s?.providers ?? {}) as Record<string, ProviderCfg>;
  const providers = PROVIDERS.map((name) => {
    const p = provs[name] ?? {};
    const isLocal = name.startsWith("local");
    const hasKey = Boolean(p.apiKeyEnc) || Boolean(ENV_KEY[name]) || isLocal;
    return {
      name, label: PROVIDER_LABELS[name], models: MODEL_REGISTRY[name as Exclude<ProviderName, "mock">],
      model: p.model ?? defaultModel(name), authMode: p.authMode ?? (isLocal ? "account" : "api_key"),
      enabled: p.enabled ?? false, configured: hasKey, needsKey: !isLocal,
      apiKeyMasked: p.apiKeyEnc ? maskSecret(safeDecrypt(p.apiKeyEnc)) : ENV_KEY[name] ? "from env ****" : "",
      keyFromEnv: Boolean(ENV_KEY[name]) && !p.apiKeyEnc,
    };
  });
  return { providers, defaultProvider: s?.defaultProvider ?? "local-claude", dailyCostLimit: Number(s?.dailyCostLimit ?? 50), autonomyLevel: s?.autonomyLevel ?? "review" };
}

export async function updateProvider(name: string, patch: { apiKey?: string; model?: string; enabled?: boolean; authMode?: string }) {
  const s = await rawSettings();
  const provs = ((s?.providers as Record<string, ProviderCfg>) ?? {});
  const cur: ProviderCfg = { ...(provs[name] ?? {}) };
  if (patch.apiKey !== undefined) cur.apiKeyEnc = patch.apiKey ? encryptSecret(patch.apiKey) : undefined;
  if (patch.model !== undefined) cur.model = patch.model;
  if (patch.enabled !== undefined) cur.enabled = patch.enabled;
  if (patch.authMode !== undefined) cur.authMode = patch.authMode;
  provs[name] = cur;
  await upsert({ providers: provs });
}
export async function setDefaultProvider(provider: string, model?: string) {
  if (model) await updateProvider(provider, { model });
  await upsert({ defaultProvider: provider });
}
export async function setCostLimit(limit: number) { await upsert({ dailyCostLimit: String(limit) }); }

/** Decrypted API key for the gateway to use (DB key first, then env). */
export async function getProviderKey(name: string): Promise<string | undefined> {
  const s = await rawSettings();
  const p = ((s?.providers as Record<string, ProviderCfg>) ?? {})[name];
  if (p?.apiKeyEnc) { const k = safeDecrypt(p.apiKeyEnc); if (k) return k; }
  return ENV_KEY[name as ProviderName];
}

// ---------------- credentials / connections ----------------
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

export async function listWebsites() {
  const db = getDb();
  const ws = await db.select().from(websites).orderBy(asc(websites.createdAt));
  const out = [];
  for (const w of ws) {
    const us = await db.select().from(websiteUsers).where(eq(websiteUsers.websiteId, w.id));
    out.push({ ...w, createdAt: w.createdAt?.getTime() ?? 0, users: us.map((u) => ({ id: u.id, label: u.label, username: u.username, role: u.role, useForPlaywright: u.useForPlaywright, passwordMasked: "********" })) });
  }
  return out;
}
export async function createWebsite(w: { name: string; baseUrl: string; environment?: string; loginUrl?: string }) {
  const id = `ws-${Date.now().toString(36)}`;
  await getDb().insert(websites).values({ id, name: w.name, baseUrl: w.baseUrl, environment: w.environment ?? "staging", loginUrl: w.loginUrl ?? null });
  return { id };
}
export async function deleteWebsite(id: string) {
  const db = getDb();
  await db.delete(websiteUsers).where(eq(websiteUsers.websiteId, id));
  await db.delete(websites).where(eq(websites.id, id));
}
export async function createUser(websiteId: string, u: { label?: string; username: string; password: string; role?: string; useForPlaywright?: boolean }) {
  const id = `wu-${Date.now().toString(36)}`;
  await getDb().insert(websiteUsers).values({ id, websiteId, label: u.label ?? null, username: u.username, passwordEnc: encryptSecret(u.password), role: u.role ?? "standard", useForPlaywright: u.useForPlaywright ?? true });
  return { id };
}
export async function deleteUser(id: string) { await getDb().delete(websiteUsers).where(eq(websiteUsers.id, id)); }
export async function revealPassword(id: string): Promise<string | null> {
  const [u] = await getDb().select().from(websiteUsers).where(eq(websiteUsers.id, id));
  if (!u) return null;
  try { return decryptSecret(u.passwordEnc); } catch { return null; }
}

/** Resolve login creds for a target URL (host match) — decrypted; used by the headless run. */
export async function resolveCredsForUrl(url: string): Promise<{ username: string; password: string; loginUrl: string } | null> {
  const db = getDb();
  const ws = await db.select().from(websites);
  const h = host(url);
  const match = ws.find((w) => host(w.baseUrl) === h) ?? ws.find((w) => h.includes(host(w.baseUrl)) || host(w.baseUrl).includes(h));
  if (!match) return null;
  const us = await db.select().from(websiteUsers).where(eq(websiteUsers.websiteId, match.id));
  const u = us.find((x) => x.useForPlaywright) ?? us[0];
  if (!u) return null;
  try { return { username: u.username, password: decryptSecret(u.passwordEnc), loginUrl: match.loginUrl ?? match.baseUrl }; } catch { return null; }
}
