"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LayoutDashboard, ListChecks, PlayCircle, MessagesSquare, FileCode2 } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { API } from "@/lib/api";

type Stats = { cases: number; runs: number; sessions: number; scripts: number; recentRuns: any[] };

function Stat({ icon: Icon, label, value, href }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/50">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
    </Link>
  );
}

export default function Page() {
  const [s, setS] = useState<Stats>({ cases: 0, runs: 0, sessions: 0, scripts: 0, recentRuns: [] });
  useEffect(() => {
    (async () => {
      const [c, r, se, a] = await Promise.all([
        fetch(`${API}/api/cases`).then((x) => x.json()).catch(() => ({ cases: [] })),
        fetch(`${API}/api/runs`).then((x) => x.json()).catch(() => ({ runs: [] })),
        fetch(`${API}/api/sessions`).then((x) => x.json()).catch(() => ({ sessions: [] })),
        fetch(`${API}/api/artifacts`).then((x) => x.json()).catch(() => ({ artifacts: [] })),
      ]);
      setS({ cases: (c.cases ?? []).length, runs: (r.runs ?? []).length, sessions: (se.sessions ?? []).length, scripts: (a.artifacts ?? []).filter((x: any) => x.kind === "script").length, recentRuns: (r.runs ?? []).slice(0, 6) });
    })();
  }, []);

  return (
    <PageBody>
      <PageHeader icon={LayoutDashboard} title="Dashboard" description="An overview of everything the agents have produced." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={ListChecks} label="Test cases" value={s.cases} href="/cases" />
        <Stat icon={PlayCircle} label="Test runs" value={s.runs} href="/runs" />
        <Stat icon={FileCode2} label="Scripts" value={s.scripts} href="/cases" />
        <Stat icon={MessagesSquare} label="Chats" value={s.sessions} href="/" />
      </div>
      <h2 className="mb-2 mt-8 text-sm font-medium">Recent runs</h2>
      {s.recentRuns.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No runs yet — start one from the <Link href="/" className="underline">Agent Console</Link>.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <tbody>
              {s.recentRuns.map((r) => (
                <tr key={r.id} className="border-t first:border-t-0">
                  <td className="px-3 py-2 font-medium">{r.object}</td>
                  <td className="px-3 py-2"><Badge variant="outline">{r.suiteType}</Badge></td>
                  <td className="px-3 py-2 text-muted-foreground">{r.passed}/{r.total} passed</td>
                  <td className="px-3 py-2"><Badge variant={r.status === "passed" ? "success" : "destructive"}>{r.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageBody>
  );
}
