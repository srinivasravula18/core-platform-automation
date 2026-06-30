"use client";

import { useEffect, useState } from "react";
import { FileCode2, ListChecks, PlayCircle, Copy, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page";
import { API, type ArtifactMeta } from "@/lib/api";

const ICON = (k: string) => (k === "script" ? FileCode2 : k === "cases" ? ListChecks : PlayCircle);

export function ArtifactList({ kinds, emptyTitle, emptyHint }: { kinds: string[]; emptyTitle: string; emptyHint: string }) {
  const [items, setItems] = useState<ArtifactMeta[]>([]);
  const [viewing, setViewing] = useState<{ title: string; ext: string; content: string; kind: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/artifacts`).then((r) => r.json()).then((d) => setItems((d.artifacts ?? []).filter((a: ArtifactMeta) => kinds.includes(a.kind)))).catch(() => {}).finally(() => setLoading(false));
  }, [kinds]);

  const open = async (id: string) => {
    const a = await fetch(`${API}/api/artifacts/${id}`).then((r) => r.json()).catch(() => null);
    if (a) setViewing({ title: a.title, ext: a.ext, content: a.content, kind: a.kind });
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (items.length === 0) return <EmptyState icon={ICON(kinds[0]!)} title={emptyTitle} hint={emptyHint} />;

  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-medium">Title</th><th className="px-3 py-2 text-left font-medium">Object</th><th className="px-3 py-2 text-left font-medium">Type</th><th className="px-3 py-2 text-left font-medium">Created</th></tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const Icon = ICON(a.kind);
              return (
                <tr key={a.id} className="cursor-pointer border-t hover:bg-accent/50" onClick={() => open(a.id)}>
                  <td className="px-3 py-2"><span className="flex items-center gap-2"><Icon className="h-4 w-4 text-muted-foreground" />{a.title}</span></td>
                  <td className="px-3 py-2 text-muted-foreground">{a.object ?? "—"}</td>
                  <td className="px-3 py-2"><Badge variant="secondary">.{a.ext}</Badge></td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {viewing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={viewing.title} onClick={() => setViewing(null)}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
              <span className="truncate text-sm font-medium">{viewing.title}</span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label="Copy" onClick={() => navigator.clipboard?.writeText(viewing.content)}><Copy className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Download" onClick={() => { const b = new Blob([viewing.content], { type: "text/plain" }); const u = URL.createObjectURL(b); const l = document.createElement("a"); l.href = u; l.download = `${viewing.title.replace(/[^a-z0-9]+/gi, "_")}.${viewing.ext}`; l.click(); URL.revokeObjectURL(u); }}><Download className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setViewing(null)}><X className="h-4 w-4" /></Button>
              </div>
            </div>
            <pre className="overflow-auto p-4 text-xs leading-relaxed"><code>{viewing.content}</code></pre>
          </div>
        </div>
      )}
    </>
  );
}
