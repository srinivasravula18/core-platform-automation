"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page";
import { PlayCircle } from "lucide-react";
import { API } from "@/lib/api";

type Run = { id: string; object: string; suiteType: string; total: number; passed: number; failed: number; status: string; accuracy: number | null; createdAt: number };

export function RunsTable() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetch(`${API}/api/runs`).then((r) => r.json()).then((d) => setRuns(d.runs ?? [])).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (runs.length === 0) return <EmptyState icon={PlayCircle} title="No test runs yet" hint="Ask the Agent Console to run a suite — results are saved here." />;

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Object</th>
            <th className="px-3 py-2 text-left font-medium">Suite</th>
            <th className="px-3 py-2 text-left font-medium">Result</th>
            <th className="px-3 py-2 text-left font-medium">Accuracy</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t hover:bg-accent/40">
              <td className="px-3 py-2 font-medium">{r.object}</td>
              <td className="px-3 py-2"><Badge variant="outline">{r.suiteType}</Badge></td>
              <td className="px-3 py-2"><span className="text-success">{r.passed} passed</span>{r.failed > 0 && <span className="text-destructive"> · {r.failed} failed</span>}<span className="text-muted-foreground"> / {r.total}</span></td>
              <td className="px-3 py-2">{typeof r.accuracy === "number" ? <Badge variant={r.accuracy >= 90 ? "success" : r.accuracy >= 70 ? "warning" : "destructive"}>{r.accuracy}%</Badge> : "—"}</td>
              <td className="px-3 py-2"><Badge variant={r.status === "passed" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge></td>
              <td className="px-3 py-2 text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
