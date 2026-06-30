import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createProvider, MODEL_REGISTRY, PROVIDER_LABELS, defaultModel, type ProviderName } from "@atp/llm";
import { EmptyMetadataClient, RunStore, toolCatalogPrompt, connectRepo, type ToolContext } from "@atp/tools";
import { runOrchestrator, buildSystemPrompt, type AgentEvent } from "@atp/agents";
import { saveTurn, listSessions, getSession, setFavorite, deleteSession, listArtifacts, getArtifact, captureArtifact, saveRepo, getRepo, clearRepo, setTarget, listCases, listRuns } from "./store.ts";
import { getSettings, updateProvider, setDefaultProvider, setCostLimit, getProviderKey, listWebsites, createWebsite, deleteWebsite, createUser, deleteUser, revealPassword, resolveCredsForUrl } from "./config-store.ts";

// ---- system prompt (from prompts/system/orchestrator.md, tools injected) ----
let SYSTEM_PROMPT: string;
try {
  const p = fileURLToPath(new URL("../../../prompts/system/orchestrator.md", import.meta.url));
  SYSTEM_PROMPT = readFileSync(p, "utf8").replace("{{TOOLS}}", toolCatalogPrompt());
} catch {
  SYSTEM_PROMPT = buildSystemPrompt();
}

// ---- per-session state (in-memory; swap for a DB-backed store to persist) ----
interface Session { history: Array<{ role: "user" | "assistant"; content: string }>; ctx: ToolContext }
const sessions = new Map<string, Session>();
function getMemSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { history: [], ctx: { metadata: new EmptyMetadataClient(), runs: new RunStore(), orgs: new Map() } };
    sessions.set(id, s);
  }
  return s;
}

async function providerFor(provider?: string, model?: string) {
  const settings = await getSettings();
  const p = (provider as ProviderName) || (settings.defaultProvider as ProviderName) || "local-claude";
  const key = await getProviderKey(p); // saved (encrypted) key in DB, else env
  const m = model || settings.providers.find((x) => x.name === p)?.model;
  return createProvider({ provider: p, model: m || undefined, apiKey: key, command: process.env.LLM_LOCAL_COMMAND });
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ ok: true, service: "atp-api-gateway", persistence: "postgres" }));

// history + artifacts (for the Recent chats sidebar and the Artifacts browser) — DB-backed
app.get("/api/sessions", async () => ({ sessions: await listSessions() }));
app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
  const s = await getSession(req.params.id);
  return s ?? reply.code(404).send({ error: "not found" });
});
app.post<{ Params: { id: string }; Body: { favorite?: boolean } }>("/api/sessions/:id/favorite", async (req) => {
  await setFavorite(req.params.id, Boolean(req.body?.favorite));
  return { ok: true };
});
app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
  await deleteSession(req.params.id);
  return { ok: true };
});
app.get("/api/cases", async () => ({ cases: await listCases() }));
app.get("/api/runs", async () => ({ runs: await listRuns() }));
app.get("/api/artifacts", async () => ({ artifacts: await listArtifacts() }));
app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
  const a = await getArtifact(req.params.id);
  return a ?? reply.code(404).send({ error: "not found" });
});

// providers + models for the in-chat selector (DB-backed: reflects saved keys + default)
app.get("/api/providers", async () => {
  const s = await getSettings();
  return { providers: s.providers.map((p) => ({ name: p.name, label: p.label, models: p.models, keyConfigured: p.configured, default: p.model })), active: s.defaultProvider };
});

// full settings (provider config, default, cost, autonomy)
app.get("/api/settings", async () => getSettings());
app.put<{ Params: { name: string }; Body: { apiKey?: string; model?: string; enabled?: boolean; authMode?: string } }>("/api/settings/provider/:name", async (req) => { await updateProvider(req.params.name, req.body ?? {}); return { ok: true }; });
app.put<{ Body: { provider: string; model?: string } }>("/api/settings/default-provider", async (req) => { await setDefaultProvider(req.body.provider, req.body.model); return { ok: true }; });
app.put<{ Body: { limit: number } }>("/api/settings/cost-limit", async (req) => { await setCostLimit(Number(req.body?.limit) || 50); return { ok: true }; });
app.post<{ Params: { name: string } }>("/api/ai/providers/:name/test", async (req) => {
  try {
    const name = req.params.name as ProviderName;
    const prov = createProvider({ provider: name, apiKey: await getProviderKey(name), command: process.env.LLM_LOCAL_COMMAND });
    const r = await prov.complete({ messages: [{ role: "user", content: "Reply with exactly: OK" }], maxTokens: 10 });
    return { ok: true, sample: (r.text || "").trim().slice(0, 40) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});

// connections / credentials (encrypted at rest)
app.get("/api/credentials/websites", async () => ({ websites: await listWebsites() }));
app.post<{ Body: { name?: string; baseUrl?: string; environment?: string; loginUrl?: string } }>("/api/credentials/websites", async (req, reply) => {
  if (!req.body?.name || !req.body?.baseUrl) return reply.code(400).send({ error: "name + baseUrl required" });
  return createWebsite(req.body as { name: string; baseUrl: string });
});
app.delete<{ Params: { id: string } }>("/api/credentials/websites/:id", async (req) => { await deleteWebsite(req.params.id); return { ok: true }; });
app.post<{ Params: { id: string }; Body: { username?: string; password?: string; label?: string; role?: string; useForPlaywright?: boolean } }>("/api/credentials/websites/:id/users", async (req, reply) => {
  if (!req.body?.username || !req.body?.password) return reply.code(400).send({ error: "username + password required" });
  return createUser(req.params.id, req.body as { username: string; password: string });
});
app.delete<{ Params: { id: string } }>("/api/credentials/users/:id", async (req) => { await deleteUser(req.params.id); return { ok: true }; });
app.post<{ Body: { userId?: string } }>("/api/credentials/reveal", async (req) => ({ password: req.body?.userId ? await revealPassword(req.body.userId) : null }));

// connect a local git folder (path) or remote URL as the source of truth for a session
app.post<{ Body: { sessionId?: string; path?: string; url?: string; baseUrl?: string } }>("/api/connect-repo", async (req, reply) => {
  const { sessionId = "default", path, url, baseUrl } = req.body ?? {};
  if (!path && !url) return reply.code(400).send({ error: "provide a local 'path' or a remote 'url'" });
  const info = await connectRepo({ path, url });
  getMemSession(sessionId).ctx.repo = info;
  await saveRepo({ ...info, baseUrl }).catch(() => {}); // persist the connected repo (+ optional target URL) in the DB
  return info;
});

// view / change / disconnect the connected repo (persisted in the DB)
app.get("/api/repo", async () => ({ repo: await getRepo().catch(() => null) }));
app.delete("/api/repo", async () => { await clearRepo().catch(() => {}); return { ok: true }; });
// set the target app URL (live or localhost) — the execution target for headless runs
app.post<{ Body: { baseUrl?: string } }>("/api/repo/target", async (req, reply) => {
  const baseUrl = (req.body?.baseUrl ?? "").trim();
  if (!baseUrl) return reply.code(400).send({ error: "baseUrl required" });
  await setTarget(baseUrl);
  return { ok: true, baseUrl };
});

// the single chat endpoint — streams the agent loop as SSE
app.post<{ Body: { sessionId?: string; message: string; provider?: string; model?: string } }>("/api/chat", async (req, reply) => {
  const { sessionId = "default", message, provider, model } = req.body ?? ({} as never);
  if (!message || typeof message !== "string") return reply.code(400).send({ error: "message required" });

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const turnSteps: Array<{ tool: string; isError?: boolean }> = [];
  const send = (e: AgentEvent | { type: string; [k: string]: unknown }) => {
    if ((e as AgentEvent).type === "tool_result") {
      const te = e as { tool: string; result: unknown; isError: boolean };
      turnSteps.push({ tool: te.tool, isError: te.isError });
      void captureArtifact(sessionId, te.tool, te.result).catch(() => {}); // persist generated script/cases/run to the DB
    }
    reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  send({ type: "session", sessionId });

  const session = getMemSession(sessionId);
  const activeRepo = await getRepo().catch(() => null); // the agent always sees the current connected repo
  if (activeRepo) session.ctx.repo = activeRepo as never;
  session.ctx.resolveCreds = resolveCredsForUrl; // headless runs can log into the live app
  try {
    const result = await runOrchestrator({
      provider: await providerFor(provider, model),
      ctx: session.ctx,
      systemPrompt: SYSTEM_PROMPT,
      history: session.history,
      userMessage: message,
      onEvent: send,
    });
    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: result.final });
    await saveTurn(sessionId, message, result.final, turnSteps).catch(() => {}); // persist the chat turn to the DB
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
  }
  reply.raw.write("event: done\ndata: {}\n\n");
  reply.raw.end();
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
// eslint-disable-next-line no-console
console.log(`atp-api-gateway listening on http://localhost:${port}`);
