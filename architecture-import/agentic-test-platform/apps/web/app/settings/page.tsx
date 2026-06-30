"use client";

import { useCallback, useEffect, useState } from "react";
import { Settings as SettingsIcon, Bot, Globe, Activity, Sun, CheckCircle2, Eye, EyeOff, Trash2, Plus, Loader2 } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { API } from "@/lib/api";

type Provider = { name: string; label: string; models: { id: string; label: string }[]; model: string; authMode: string; enabled: boolean; configured: boolean; needsKey: boolean; apiKeyMasked: string; keyFromEnv: boolean };
type SettingsData = { providers: Provider[]; defaultProvider: string; dailyCostLimit: number; autonomyLevel: string };
type WUser = { id: string; label?: string; username: string; role: string; useForPlaywright: boolean; passwordMasked: string };
type Website = { id: string; name: string; baseUrl: string; environment: string; loginUrl?: string; users: WUser[] };

const TABS = [
  { key: "providers", label: "AI Providers", icon: Bot },
  { key: "connections", label: "Connections", icon: Globe },
  { key: "cost", label: "Cost", icon: Activity },
  { key: "appearance", label: "Appearance", icon: Sun },
] as const;

export default function Page() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("providers");
  return (
    <PageBody>
      <PageHeader icon={SettingsIcon} title="Settings" description="Providers, connections to the app under test, and cost." />
      <div className="mb-5 flex gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={cn("flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === "providers" && <Providers />}
      {tab === "connections" && <Connections />}
      {tab === "cost" && <Cost />}
      {tab === "appearance" && <Appearance />}
    </PageBody>
  );
}

function Providers() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const load = useCallback(() => fetch(`${API}/api/settings`).then((r) => r.json()).then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const put = async (name: string, body: any) => { await fetch(`${API}/api/settings/provider/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); load(); };
  const setDefault = async (name: string, model: string) => { await fetch(`${API}/api/settings/default-provider`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: name, model }) }); load(); };
  const test = async (name: string) => { setTesting(name); try { const r = await fetch(`${API}/api/ai/providers/${name}/test`, { method: "POST" }).then((x) => x.json()); setResult((p) => ({ ...p, [name]: r.ok ? `✓ ${r.sample || "OK"}` : `✗ ${r.error?.slice(0, 60)}` })); } finally { setTesting(null); } };

  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-3">
      {data.providers.map((p) => (
        <div key={p.name} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{p.label}</span>
              {p.configured ? <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> configured</Badge> : <Badge variant="warning">no key</Badge>}
              {data.defaultProvider === p.name && <Badge variant="secondary">default</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={p.enabled} onChange={(e) => put(p.name, { enabled: e.target.checked })} /> enabled</label>
              <Button size="sm" variant="outline" onClick={() => test(p.name)} disabled={testing === p.name}>{testing === p.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}</Button>
              <Button size="sm" variant={data.defaultProvider === p.name ? "secondary" : "ghost"} onClick={() => setDefault(p.name, p.model)}>Set default</Button>
            </div>
          </div>
          {result[p.name] && <p className={cn("mt-2 text-xs", result[p.name]!.startsWith("✓") ? "text-success" : "text-destructive")}>{result[p.name]}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="text-muted-foreground">Model</span>
              <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={p.model} onChange={(e) => put(p.name, { model: e.target.value })}>
                {p.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            {p.needsKey && (
              <label className="text-xs">
                <span className="text-muted-foreground">API key {p.keyFromEnv && "(currently from env)"}</span>
                <div className="mt-1 flex gap-1.5">
                  <input type="password" placeholder={p.apiKeyMasked || "sk-…"} value={keyInput[p.name] ?? ""} onChange={(e) => setKeyInput((s) => ({ ...s, [p.name]: e.target.value }))} className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm" />
                  <Button size="sm" disabled={!keyInput[p.name]} onClick={() => { put(p.name, { apiKey: keyInput[p.name] }); setKeyInput((s) => ({ ...s, [p.name]: "" })); }}>Save</Button>
                  {p.configured && !p.keyFromEnv && <Button size="sm" variant="outline" onClick={() => put(p.name, { apiKey: "" })}>Remove</Button>}
                </div>
              </label>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Connections() {
  const [sites, setSites] = useState<Website[]>([]);
  const [nw, setNw] = useState({ name: "", baseUrl: "", environment: "staging", loginUrl: "" });
  const [nu, setNu] = useState<Record<string, { username: string; password: string; role: string }>>({});
  const [reveal, setReveal] = useState<Record<string, string>>({});
  const load = useCallback(() => fetch(`${API}/api/credentials/websites`).then((r) => r.json()).then((d) => setSites(d.websites ?? [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const addSite = async () => { if (!nw.name || !nw.baseUrl) return; await fetch(`${API}/api/credentials/websites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nw) }); setNw({ name: "", baseUrl: "", environment: "staging", loginUrl: "" }); load(); };
  const delSite = async (id: string) => { await fetch(`${API}/api/credentials/websites/${id}`, { method: "DELETE" }); load(); };
  const addUser = async (id: string) => { const u = nu[id]; if (!u?.username || !u?.password) return; await fetch(`${API}/api/credentials/websites/${id}/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...u, useForPlaywright: true }) }); setNu((s) => ({ ...s, [id]: { username: "", password: "", role: "standard" } })); load(); };
  const delUser = async (uid: string) => { await fetch(`${API}/api/credentials/users/${uid}`, { method: "DELETE" }); load(); };
  const doReveal = async (uid: string) => { if (reveal[uid]) { setReveal((s) => { const c = { ...s }; delete c[uid]; return c; }); return; } const r = await fetch(`${API}/api/credentials/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: uid }) }).then((x) => x.json()); setReveal((s) => ({ ...s, [uid]: r.password ?? "—" })); };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Sites the agents test against, with login credentials (passwords are AES-256 encrypted; used to log into the live app during headless runs).</p>
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Add a site</h2>
        <div className="grid gap-2 sm:grid-cols-4">
          <input placeholder="Name" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
          <input placeholder="https://app… or http://localhost:3000" value={nw.baseUrl} onChange={(e) => setNw({ ...nw, baseUrl: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm sm:col-span-2" />
          <select value={nw.environment} onChange={(e) => setNw({ ...nw, environment: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm">{["dev", "staging", "prod", "local", "preview"].map((x) => <option key={x}>{x}</option>)}</select>
        </div>
        <div className="mt-2 flex gap-2">
          <input placeholder="Login URL (optional, defaults to base URL)" value={nw.loginUrl} onChange={(e) => setNw({ ...nw, loginUrl: e.target.value })} className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm" />
          <Button onClick={addSite} disabled={!nw.name || !nw.baseUrl}><Plus className="h-4 w-4" /> Add site</Button>
        </div>
      </div>

      {sites.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No sites yet.</p>}
      {sites.map((w) => (
        <div key={w.id} className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <div><span className="font-medium">{w.name}</span> <Badge variant="outline">{w.environment}</Badge> <span className="ml-1 font-mono text-xs text-muted-foreground">{w.baseUrl}</span></div>
            <Button size="icon" variant="ghost" aria-label="Delete site" onClick={() => delSite(w.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
          <div className="mt-3 space-y-1.5">
            {w.users.map((u) => (
              <div key={u.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-sm">
                <span className="font-medium">{u.username}</span>
                <Badge variant="secondary">{u.role}</Badge>
                {u.useForPlaywright && <Badge variant="outline">login</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{reveal[u.id] ?? u.passwordMasked}</span>
                <button onClick={() => doReveal(u.id)} aria-label="Reveal" className="text-muted-foreground hover:text-foreground">{reveal[u.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
                <button onClick={() => delUser(u.id)} aria-label="Delete user" className="ml-auto text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <input placeholder="username / email" value={nu[w.id]?.username ?? ""} onChange={(e) => setNu((s) => ({ ...s, [w.id]: { ...(s[w.id] ?? { username: "", password: "", role: "standard" }), username: e.target.value } }))} className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm" />
            <input type="password" placeholder="password" value={nu[w.id]?.password ?? ""} onChange={(e) => setNu((s) => ({ ...s, [w.id]: { ...(s[w.id] ?? { username: "", password: "", role: "standard" }), password: e.target.value } }))} className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm" />
            <select value={nu[w.id]?.role ?? "standard"} onChange={(e) => setNu((s) => ({ ...s, [w.id]: { ...(s[w.id] ?? { username: "", password: "", role: "standard" }), role: e.target.value } }))} className="h-8 rounded-md border border-input bg-background px-2 text-sm">{["admin", "standard", "guest", "service"].map((x) => <option key={x}>{x}</option>)}</select>
            <Button size="sm" onClick={() => addUser(w.id)}><Plus className="h-3.5 w-3.5" /> Add login</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Cost() {
  const [limit, setLimit] = useState(50);
  const [saved, setSaved] = useState(false);
  useEffect(() => { fetch(`${API}/api/settings`).then((r) => r.json()).then((d) => setLimit(d.dailyCostLimit ?? 50)).catch(() => {}); }, []);
  const save = async () => { await fetch(`${API}/api/settings/cost-limit`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit }) }); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  return (
    <div className="max-w-md rounded-xl border bg-card p-4">
      <h2 className="text-sm font-medium">Daily cost limit (USD)</h2>
      <p className="mb-3 text-xs text-muted-foreground">A soft cap on agent spend per day. Model-tier routing + prompt caching keep runs cheap.</p>
      <div className="flex gap-2">
        <input type="number" min={0} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="h-9 w-32 rounded-md border border-input bg-background px-2 text-sm" />
        <Button onClick={save}>{saved ? <CheckCircle2 className="h-4 w-4" /> : "Save"}</Button>
      </div>
    </div>
  );
}

function Appearance() {
  return (
    <div className="max-w-md rounded-xl border bg-card p-4 text-sm">
      <h2 className="font-medium">Theme</h2>
      <p className="mt-1 text-muted-foreground">Use the sun/moon toggle in the top bar to switch light / dark. Your choice is saved locally and applied before paint (no flash).</p>
    </div>
  );
}
