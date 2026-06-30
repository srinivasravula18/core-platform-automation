"use client";

import { useEffect, useState } from "react";
import { FolderGit2, CheckCircle2, AlertTriangle, GitBranch, Loader2, Plus, Trash2 } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { API, type RepoInfo } from "@/lib/api";

export default function Page() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [input, setInput] = useState("");
  const [target, setTarget] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [targetBusy, setTargetBusy] = useState(false);

  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem("targetUrls") || "[]").filter(Boolean);
    fetch(`${API}/api/repo`).then((r) => r.json()).then((d) => {
      setRepo(d?.repo ?? null);
      if (d?.repo?.ref) setInput(d.repo.ref);
      if (d?.repo?.baseUrl) setTarget(d.repo.baseUrl);
      setTargets(Array.from(new Set([d?.repo?.baseUrl, ...saved].filter(Boolean))));
    }).catch(() => setTargets(saved));
  }, []);

  const rememberTargets = (next: string[]) => {
    setTargets(next);
    localStorage.setItem("targetUrls", JSON.stringify(next));
  };
  const saveTarget = async (url = target) => {
    const v = url.trim();
    if (!v) return;
    setTargetBusy(true);
    try {
      await fetch(`${API}/api/repo/target`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: v }) });
      setTarget(v);
      setRepo((r) => (r ? { ...r, baseUrl: v } : r));
      rememberTargets(Array.from(new Set([v, ...targets])));
    }
    finally { setTargetBusy(false); }
  };
  const removeTarget = (url: string) => rememberTargets(targets.filter((x) => x !== url));

  const connect = async () => {
    const v = input.trim();
    if (!v) return;
    setBusy(true);
    const isUrl = /^(https?:\/\/|git@)/.test(v);
    try {
      const info = await fetch(`${API}/api/connect-repo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(isUrl ? { url: v } : { path: v }) }).then((r) => r.json());
      setRepo(info);
    } catch { setRepo({ source: isUrl ? "remote" : "local", ref: v, error: "could not reach the API gateway" }); }
    finally { setBusy(false); }
  };
  const disconnect = async () => { await fetch(`${API}/api/repo`, { method: "DELETE" }).catch(() => {}); setRepo(null); setInput(""); };

  return (
    <PageBody>
      <PageHeader icon={FolderGit2} title="File System" description="The source-of-truth repository (local folder or GitHub URL) the agents ground tests against." />

      {repo && !repo.error && (
        <div className="mb-6 rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-success"><CheckCircle2 className="h-5 w-5" /><span className="font-medium text-foreground">Connected</span><Badge variant="secondary">{repo.source}</Badge></div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Reference</dt><dd className="truncate font-mono text-xs">{repo.ref}</dd></div>
            {repo.branch && <div><dt className="text-muted-foreground">Branch</dt><dd className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{repo.branch}{repo.sha ? `@${repo.sha}` : ""}</dd></div>}
            {repo.framework && <div><dt className="text-muted-foreground">Framework</dt><dd>{repo.framework}</dd></div>}
            {typeof repo.fileCount === "number" && <div><dt className="text-muted-foreground">Files</dt><dd>{repo.fileCount}</dd></div>}
            {repo.hasMetadata != null && <div><dt className="text-muted-foreground">Metadata</dt><dd>{repo.hasMetadata ? "detected" : "none"}</dd></div>}
          </dl>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-sm font-medium">{repo && !repo.error ? "Change repository" : "Connect a repository"}</h2>
        <p className="mb-3 text-xs text-muted-foreground">Paste a <strong>local folder path</strong> (a git repo on this machine) or a <strong>GitHub URL</strong>. Saved to the database.</p>
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} placeholder="E:\\GnanaBodha   or   https://github.com/org/repo" aria-label="Local folder path or GitHub URL" className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <Button onClick={connect} disabled={busy || !input.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : repo && !repo.error ? "Update" : "Connect"}</Button>
          {repo && !repo.error && <Button variant="outline" onClick={disconnect}>Disconnect</Button>}
        </div>
        {repo?.error && <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> {repo.error}</p>}
      </div>

      <div className="mt-4 rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-sm font-medium">Target app URL <span className="font-normal text-muted-foreground">— where the app is running</span></h2>
        <p className="mb-3 text-xs text-muted-foreground">The repo above grounds the tests; this URL is where they <strong>run</strong>. Use your local dev server (e.g. <code className="rounded bg-muted px-1">http://localhost:3000</code>) or the live app URL. Headless Playwright runs against it.</p>
        <div className="flex gap-2">
          <input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveTarget()} placeholder="http://localhost:3000   or   https://app.yourcompany.com" aria-label="Target app URL" className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <Button onClick={() => saveTarget()} disabled={targetBusy || !target.trim()}>{targetBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Add URL</>}</Button>
        </div>
        {targets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {targets.map((url) => (
              <div key={url} className="flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs">
                <button onClick={() => saveTarget(url)} className="min-w-0 truncate font-mono hover:underline" title="Use this target">{url}</button>
                <button onClick={() => removeTarget(url)} aria-label={`Remove ${url}`} className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        )}
        {repo?.baseUrl && <p className="mt-2 text-xs text-success">Current target: <span className="font-mono">{repo.baseUrl}</span></p>}
      </div>
    </PageBody>
  );
}
