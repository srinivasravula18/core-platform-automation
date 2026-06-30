"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page";
import { ListChecks } from "lucide-react";
import { API } from "@/lib/api";

type Case = { id: string; code: string; title: string; object: string; kind: string; technique: string; priority: string; suiteTypes: string[]; createdAt: number };

export function CasesTable() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetch(`${API}/api/cases`).then((r) => r.json()).then((d) => setCases(d.cases ?? [])).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (cases.length === 0) return <EmptyState icon={ListChecks} title="No test cases yet" hint="Ask the Agent Console to generate tests for an object — they'll be saved here." />;

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Code</th>
            <th className="px-3 py-2 text-left font-medium">Title</th>
            <th className="px-3 py-2 text-left font-medium">Object</th>
            <th className="px-3 py-2 text-left font-medium">Kind</th>
            <th className="px-3 py-2 text-left font-medium">Technique</th>
            <th className="px-3 py-2 text-left font-medium">Suites</th>
            <th className="px-3 py-2 text-left font-medium">Priority</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id} className="border-t hover:bg-accent/40">
              <td className="px-3 py-2"><code className="text-xs">{c.code}</code></td>
              <td className="px-3 py-2">{c.title}</td>
              <td className="px-3 py-2 text-muted-foreground">{c.object}</td>
              <td className="px-3 py-2"><Badge variant={c.kind === "api" ? "secondary" : "outline"}>{c.kind}</Badge></td>
              <td className="px-3 py-2 text-muted-foreground">{c.technique}</td>
              <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{(c.suiteTypes ?? []).map((s) => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}</span></td>
              <td className="px-3 py-2"><Badge variant={c.priority === "p1" ? "destructive" : c.priority === "p2" ? "warning" : "secondary"}>{c.priority}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
