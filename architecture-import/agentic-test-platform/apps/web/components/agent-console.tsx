"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";
import { Sparkles, Send, Mic, Volume2, VolumeX, Loader2, Plus, History, X, User, Star, Trash2, Copy, Pencil, FlaskConical, ClipboardList, Layers, PlayCircle, Bug, Code2, Image as ImageIcon, FolderTree, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSidebar } from "@/components/sidebar-context";
import { cn } from "@/lib/utils";
import { API, type SessionMeta } from "@/lib/api";

marked.setOptions({ gfm: true, breaks: true });

type ModelInfo = { id: string; label: string };
type Provider = { name: string; label: string; models: ModelInfo[]; keyConfigured: boolean; default: string };
type ToolStep = { tool: string; input?: unknown; result?: unknown; isError?: boolean; done: boolean };
type Msg = { id: string; role: "user" | "assistant"; content: string; steps: ToolStep[]; streaming: boolean };
type Conf = { score: number; level: "high" | "medium" | "low"; matched?: number; total?: number; passRate?: number; mismatches?: { reason: string }[] };
type SSEEvent =
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; result: unknown; isError: boolean }
  | { type: "final"; content: string }
  | { type: "error"; message: string };

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);
const stripMd = (s: string) => s.replace(/[#*`_>|]/g, "").replace(/\n+/g, ". ").slice(0, 600);
function latestConfidence(m: Msg): Conf | null {
  for (let i = m.steps.length - 1; i >= 0; i--) {
    const r = m.steps[i]!.result as { confidence?: Conf } | undefined;
    if (r?.confidence) return r.confidence;
  }
  return null;
}

/** One-line description of what the agent actually did — its query/path + what it found. */
function describeStep(tool: string, input: any, result: any): string {
  const i = input ?? {};
  const r = result ?? {};
  switch (tool) {
    case "search_repo": return r.matches != null ? `“${i.query ?? ""}” → ${r.matches} match${r.matches === 1 ? "" : "es"}` : `searching “${i.query ?? ""}”`;
    case "list_files": return `${i.glob ? i.glob + " → " : ""}${r.count != null ? `${r.count} files` : "listing files"}`;
    case "read_file": return `${i.path ?? ""}${typeof r.totalLines === "number" ? ` · ${r.totalLines} lines` : ""}`;
    case "follow_imports": return `${i.path ?? ""}${r.localImports != null ? ` → ${r.localImports} imports, ${(r.packages?.length ?? 0)} pkgs` : ""}`;
    case "read_package": return `${r.name ?? i.path ?? "package.json"}${r.dependencies ? ` · ${Object.keys(r.dependencies).length} deps` : ""}`;
    case "describe_object": return `${i.object ?? ""}${Array.isArray(r.fields) ? ` · ${r.fields.length} fields` : ""}`;
    case "list_objects": return i.app ? `app: ${i.app}` : "all apps";
    case "list_apps": return r.length != null ? `${r.length} apps` : "";
    case "generate_tests": return `${i.object ?? ""}${r.uiCases ? ` → ${r.uiCases.length} UI + ${r.apiCases?.length ?? 0} API cases` : ""}`;
    case "generate_script": return `${i.object ?? ""}${r.lintOk != null ? (r.lintOk ? " · grounded ✓" : " · ungrounded ✗") : ""}`;
    case "run_suite":
    case "run_headless": return `${i.object ?? ""}${typeof r.passed === "number" ? ` → ${r.passed}/${r.total} passed` : ""}`;
    case "connect_repo": return i.path || i.url || "";
    case "repo_info": return r.ref || (r.connected === false ? "no repo" : "");
    case "query_records": return i.object ?? "";
    case "connect_org": return i.name ?? "";
    default: { const v = Object.values(i)[0]; return v ? String(v).slice(0, 60) : ""; }
  }
}

/** Rich tooltip: the call + a preview of what the agent saw. */
function stepTitle(tool: string, input: any, result: any): string {
  let t = `${tool}(${JSON.stringify(input ?? {})})`;
  const r = result ?? {};
  if (tool === "search_repo" && Array.isArray(r.results)) t += "\n\n" + r.results.slice(0, 10).join("\n");
  else if (tool === "list_files" && Array.isArray(r.files)) t += "\n\n" + r.files.slice(0, 20).join("\n");
  else if (tool === "read_file" && typeof r.content === "string") t += "\n\n" + r.content.slice(0, 600);
  else if (tool === "follow_imports" && Array.isArray(r.related)) t += "\n\nrelated files:\n" + r.related.map((x: any) => x.path).join("\n");
  else if (tool === "read_package" && r.dependencies) t += "\n\ndeps: " + Object.keys(r.dependencies).join(", ");
  else if (r.error) t += "\n\nerror: " + r.error;
  return t;
}
const SELECT = "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Empty-state content — same as TestFlow's Agent Console.
const SUGGESTIONS = [
  { label: "Generate cases + scripts", prompt: "Generate 5 test cases for the login flow of https://example.com, then write the Playwright scripts and capture evidence", icon: FlaskConical },
  { label: "Draft a test plan", prompt: "Create a regression test plan for the checkout flow", icon: ClipboardList },
  { label: "Group into a suite", prompt: "Create a smoke test suite and group the login and checkout cases into it", icon: Layers },
  { label: "Schedule a run", prompt: "Set up a smoke test run for the latest build", icon: PlayCircle },
  { label: "File a defect", prompt: "File a high severity defect: the payment button is unresponsive on mobile", icon: Bug },
  { label: "Write a report", prompt: "Generate a stakeholder test report for the latest release", icon: ClipboardList },
];
const CAPABILITIES = [
  { label: "Test cases", icon: FlaskConical },
  { label: "Playwright scripts", icon: Code2 },
  { label: "Evidence", icon: ImageIcon },
  { label: "Test plans", icon: ClipboardList },
  { label: "Suites", icon: Layers },
  { label: "Runs", icon: PlayCircle },
  { label: "Defects", icon: Bug },
  { label: "Reports", icon: ClipboardList },
  { label: "Folders", icon: FolderTree },
  { label: "Rework / expand", icon: Wand2 },
];

export function AgentConsole({ initialQuery, initialChatId }: { initialQuery?: string; initialChatId?: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [chatId, setChatId] = useState(initialChatId ?? uid());
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const firedQuery = useRef(false);

  const refreshHistory = useCallback(() => { fetch(`${API}/api/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {}); }, []);
  useEffect(() => {
    fetch(`${API}/api/providers`).then((r) => r.json()).then((d: { providers: Provider[]; active: string }) => {
      setProviders(d.providers);
      const a = d.providers.find((p) => p.name === d.active) ?? d.providers[0];
      if (a) { setProvider(a.name); setModel(a.default); }
    }).catch(() => {});
    refreshHistory();
  }, [refreshHistory]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);
  useEffect(() => { setSlot(document.getElementById("topbar-actions")); }, []);
  const syncUrl = (id: string) => { try { window.history.replaceState(null, "", `/${id}`); } catch { /* ignore */ } };
  // keep the URL as localhost:3000/{chatId} at all times (fresh chat, new chat, or loaded chat)
  useEffect(() => { syncUrl(chatId); }, [chatId]);

  const speak = useCallback((t: string) => {
    if (!voiceOut || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(stripMd(t)));
  }, [voiceOut]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || streaming) return;
    setInput("");
    setStreaming(true);
    syncUrl(chatId); // reflect the chat id in the URL: localhost:3000/{chatId}
    setMessages((m) => [...m, { id: uid(), role: "user", content: message, steps: [], streaming: false }, { id: uid(), role: "assistant", content: "", steps: [], streaming: true }]);
    const patch = (fn: (m: Msg) => Msg) => setMessages((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));
    try {
      const res = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: chatId, message, provider, model }) });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const p = t.slice(5).trim();
            if (!p) continue;
            let e: SSEEvent; try { e = JSON.parse(p); } catch { continue; }
            if (e.type === "tool_call") patch((m) => ({ ...m, steps: [...m.steps, { tool: e.tool, input: e.input, done: false }] }));
            else if (e.type === "tool_result") patch((m) => ({ ...m, steps: m.steps.map((s, j) => (j === m.steps.length - 1 ? { ...s, result: e.result, isError: e.isError, done: true } : s)) }));
            else if (e.type === "final") { patch((m) => ({ ...m, content: e.content, streaming: false })); speak(e.content); }
            else if (e.type === "error") patch((m) => ({ ...m, content: `⚠️ ${e.message}`, streaming: false }));
          }
        }
      }
    } catch (err) {
      patch((m) => ({ ...m, content: `⚠️ ${(err as Error).message}. Is the API gateway running on ${API}?`, streaming: false }));
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      setStreaming(false);
      refreshHistory();
    }
  }, [provider, model, streaming, speak, refreshHistory, chatId]);

  useEffect(() => {
    if (initialQuery && !firedQuery.current && provider) { firedQuery.current = true; send(initialQuery); }
  }, [initialQuery, provider, send]);

  const toggleMic = useCallback(() => {
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!SR) { alert("Voice input needs Chrome (Web Speech API)."); return; }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR(); rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (ev: any) => setInput(ev.results[0][0].transcript as string);
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
    recRef.current = rec; rec.start(); setListening(true);
  }, [listening]);

  const newChat = () => { setChatId(uid()); setMessages([]); setHistOpen(false); }; // URL syncs via the chatId effect
  const loadSession = useCallback(async (id: string) => {
    const s = await fetch(`${API}/api/sessions/${id}`).then((r) => r.json()).catch(() => null);
    if (!s) return;
    setChatId(id);
    syncUrl(id);
    setMessages((s.messages ?? []).map((m: any) => ({ id: uid(), role: m.role, content: m.content, steps: (m.steps ?? []).map((st: any) => ({ tool: st.tool, isError: st.isError, done: true })), streaming: false })));
    setHistOpen(false);
  }, []);
  // deep link: /{chatId} loads that conversation on mount
  useEffect(() => { if (initialChatId) loadSession(initialChatId); }, [initialChatId, loadSession]);
  const toggleFavorite = async (id: string, fav: boolean) => {
    await fetch(`${API}/api/sessions/${id}/favorite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: fav }) }).catch(() => {});
    refreshHistory();
  };
  const deleteSession = async (id: string) => {
    await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    if (id === chatId) newChat();
    refreshHistory();
  };

  const activeProvider = providers.find((p) => p.name === provider);
  const localMode = provider.startsWith("local");
  const confVariant = (l: string) => (l === "high" ? "success" : l === "medium" ? "warning" : "destructive");
  const { collapsed } = useSidebar();
  const wrap = collapsed ? "max-w-none" : "max-w-7xl"; // full viewport when the sidebar is hidden

  return (
    <div className="flex h-full flex-col">
      {/* console controls — rendered into the topbar's single row, next to "Ask anything" */}
      {slot && createPortal(
        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:flex-nowrap">
          <button onClick={() => navigator.clipboard?.writeText(chatId)} title={`Chat ID: ${chatId} — click to copy`} className="hidden items-center gap-1 rounded-md border bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground lg:flex">
            <span className="uppercase tracking-wide text-muted-foreground/70">Chat</span>
            <span className="font-mono text-foreground">{chatId.slice(0, 8)}</span>
            <Copy className="h-3 w-3" />
          </button>
          <select aria-label="Provider" className={cn(SELECT, "min-w-0 flex-1 sm:flex-none")} value={provider} onChange={(e) => { setProvider(e.target.value); const p = providers.find((x) => x.name === e.target.value); if (p) setModel(p.default); }}>
            {providers.map((p) => <option key={p.name} value={p.name} disabled={!p.keyConfigured}>{p.label}{p.keyConfigured ? "" : " (no key)"}</option>)}
          </select>
          <select aria-label="Model" className={cn(SELECT, "hidden md:block")} value={model} onChange={(e) => setModel(e.target.value)}>
            {(activeProvider?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <Button variant="ghost" size="icon" className={cn("h-8 w-8", voiceOut ? "text-primary" : "text-muted-foreground")} aria-pressed={voiceOut} aria-label="Read replies aloud" onClick={() => setVoiceOut((v) => !v)}>{voiceOut ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</Button>
          <div className="relative">
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setHistOpen((o) => !o)} aria-expanded={histOpen}><History className="h-4 w-4" /><span className="hidden sm:inline"> History</span></Button>
            {histOpen && (
              <div role="dialog" aria-label="Recent chats" className="absolute right-0 top-9 z-30 max-h-80 w-72 overflow-y-auto rounded-lg border bg-popover p-1.5 shadow-lg">
                <div className="flex items-center justify-between px-1.5 py-1"><span className="text-xs font-semibold text-muted-foreground">Recent chats</span><button aria-label="Close" onClick={() => setHistOpen(false)}><X className="h-3.5 w-3.5 text-muted-foreground" /></button></div>
                {sessions.length === 0 && <p className="px-1.5 py-2 text-xs text-muted-foreground">No chats yet</p>}
                {sessions.map((s) => (
                  <div key={s.id} className={cn("group flex items-center gap-1 rounded-md pr-1 hover:bg-accent", s.id === chatId && "bg-accent/60")}>
                    <button onClick={() => loadSession(s.id)} className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1.5 text-left text-sm">
                      {s.favorite && <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />}
                      <span className="truncate">{s.title}</span>
                    </button>
                    <button onClick={() => toggleFavorite(s.id, !s.favorite)} aria-label={s.favorite ? "Unfavorite" : "Favorite"} title="Favorite" className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-warning group-hover:opacity-100"><Star className={cn("h-3.5 w-3.5", s.favorite && "fill-warning text-warning opacity-100")} /></button>
                    <button onClick={() => deleteSession(s.id)} aria-label="Delete chat" title="Delete" className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" className="h-8" onClick={newChat}><Plus className="h-4 w-4" /><span className="hidden sm:inline"> New</span></Button>
        </div>, slot)}

      {/* thread */}
      <div ref={logRef} role="log" aria-live="polite" className="flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex flex-col gap-6 px-4 py-6", wrap)}>
          {messages.length === 0 && (
            <div className="flex min-h-[70vh] flex-col items-center justify-center px-2 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="h-8 w-8" /></div>
              <h2 className="mt-5 text-xl font-semibold">What should the QA agent do?</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">Describe a testing task in plain language. I&apos;ll turn it into a step-by-step plan, you review and approve, and I&apos;ll execute it — generating cases, plans, runs, defects, and reports for you.</p>
              <div className="mt-7 grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SUGGESTIONS.map((s) => (
                  <button key={s.label} onClick={() => send(s.prompt)} className="group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary group-hover:bg-primary/10"><s.icon className="h-4 w-4" /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{s.prompt}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-8 w-full">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Everything the agent can do for you</div>
                <div className="flex flex-wrap justify-center gap-2">
                  {CAPABILITIES.map((c) => (
                    <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium"><c.icon className="h-3.5 w-3.5 text-primary" />{c.label}</span>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((m) => m.role === "user" ? (
            <div key={m.id} className="group flex justify-end gap-2">
              {editingId === m.id ? (
                <div className="flex w-full max-w-[85%] flex-col gap-2">
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={Math.min(8, editText.split("\n").length + 1)} autoFocus className="w-full resize-none rounded-2xl border border-input bg-background px-3.5 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button size="sm" disabled={!editText.trim()} onClick={() => { const t = editText; setEditingId(null); send(t); }}>Resubmit</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => navigator.clipboard?.writeText(m.content)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Copy" title="Copy"><Copy className="h-3.5 w-3.5" /></button>
                    <button onClick={() => { setEditingId(m.id); setEditText(m.content); }} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Edit and resubmit" title="Edit & resubmit"><Pencil className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">{m.content}</div>
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground"><User className="h-4 w-4" /></div>
                </>
              )}
            </div>
          ) : (
            <div key={m.id} className="group flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"><Sparkles className="h-4 w-4" /></div>
              <div className="flex min-w-0 max-w-[85%] flex-col gap-2">
                {m.steps.length > 0 && (
                  <details open={m.streaming} className="rounded-lg border bg-card text-xs">
                    <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground">Agent actions ({m.steps.length}){m.streaming && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin" />}</summary>
                    <ul className="space-y-1 px-3 pb-2.5">{m.steps.map((s, i) => (
                      <li key={i} className="flex items-start gap-2" title={stepTitle(s.tool, s.input, s.result)}>
                        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5">{s.tool}</code>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{describeStep(s.tool, s.input, s.result)}</span>
                        <span className={cn("shrink-0 text-[11px]", s.isError ? "text-destructive" : "text-muted-foreground")}>{s.done ? (s.isError ? "error" : "done") : "running…"}</span>
                      </li>
                    ))}</ul>
                  </details>
                )}
                {localMode && (() => {
                  const c = latestConfidence(m);
                  if (!c) return null;
                  const title = c.mismatches?.length ? `${c.mismatches.length} reference(s) not in repo:\n` + c.mismatches.map((x) => `• ${x.reason}`).join("\n") : "All references grounded in your repo metadata";
                  return (
                    <Badge variant={confVariant(c.level)} title={title} className="w-fit gap-2 py-1" role="status">
                      <span>Accuracy {c.score}%</span>
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/15"><span className="block h-full bg-current" style={{ width: `${c.score}%` }} /></span>
                      {typeof c.total === "number" && <span className="font-normal opacity-80">{c.matched}/{c.total} vs repo{typeof c.passRate === "number" ? ` · ${c.passRate}% pass` : ""}</span>}
                    </Badge>
                  );
                })()}
                {m.content ? <div className="prose-chat rounded-2xl rounded-bl-sm border bg-card px-3.5 py-2.5 text-sm" dangerouslySetInnerHTML={{ __html: marked.parse(m.content) as string }} /> : m.streaming ? <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-card px-3.5 py-2.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Working…</div> : null}
                {m.content && !m.streaming && (
                  <div className="opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => navigator.clipboard?.writeText(m.content)} className="flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:text-foreground" aria-label="Copy response" title="Copy"><Copy className="h-3.5 w-3.5" /> Copy</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* composer */}
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className={cn("mx-auto flex w-full shrink-0 items-end gap-2 px-4 py-3", wrap)}>
        <Button type="button" variant={listening ? "destructive" : "outline"} size="icon" onClick={toggleMic} aria-pressed={listening} aria-label={listening ? "Stop voice input" : "Start voice input"}><Mic className="h-4 w-4" /></Button>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Ask me to test something…  (Enter to send)" rows={1} aria-label="Message" className="max-h-40 min-h-[40px] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="submit" size="icon" disabled={streaming || !input.trim()} aria-label="Send">{streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
      </form>
    </div>
  );
}

function MessagesIcon() { return <Sparkles className="h-4 w-4 text-primary" />; }
