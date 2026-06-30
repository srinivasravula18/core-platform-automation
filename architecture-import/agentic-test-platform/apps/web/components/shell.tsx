"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  MessagesSquare, LayoutDashboard, FolderGit2, ClipboardList, Layers, ListChecks, PlayCircle,
  FileText, Network, BarChart3, Bug, GitBranch, Settings, Search, Menu, PanelLeftClose, Sparkles, CheckCircle2,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarCtx } from "@/components/sidebar-context";
import { cn } from "@/lib/utils";
import { API, type RepoInfo } from "@/lib/api";

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
const GROUPS: { title: string; items: Item[] }[] = [
  { title: "Overview", items: [
    { href: "/", label: "Agent Console", icon: MessagesSquare },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  ] },
  { title: "Test Management", items: [
    { href: "/repository", label: "File System", icon: FolderGit2 },
    { href: "/plans", label: "Test Plans", icon: ClipboardList },
    { href: "/suites", label: "Test Suites", icon: Layers },
    { href: "/cases", label: "Test Cases", icon: ListChecks },
    { href: "/runs", label: "Test Runs", icon: PlayCircle },
  ] },
  { title: "Quality", items: [
    { href: "/requirements", label: "Requirements", icon: FileText },
    { href: "/traceability", label: "Traceability", icon: Network },
    { href: "/reports", label: "Reports", icon: BarChart3 },
    { href: "/defects", label: "Defects", icon: Bug },
  ] },
  { title: "Automation", items: [{ href: "/git-agent", label: "Git Agent", icon: GitBranch }] },
];

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(`${API}/api/repo`).then((r) => r.json()).then((d) => setRepo(d?.repo ?? null)).catch(() => {});
  }, [pathname]);
  useEffect(() => { setOpen(false); }, [pathname]);

  const KNOWN = ["/dashboard", "/repository", "/plans", "/suites", "/cases", "/runs", "/requirements", "/traceability", "/reports", "/defects", "/git-agent", "/settings"];
  const onChatRoute = pathname === "/" || (pathname.split("/").filter(Boolean).length === 1 && !KNOWN.includes(pathname));
  const NavLink = ({ item }: { item: Item }) => {
    const active = item.href === "/" ? onChatRoute : pathname.startsWith(item.href);
    const Icon = item.icon;
    return (
      <Link href={item.href} className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors", active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} aria-current={active ? "page" : undefined}>
        <Icon className="h-4 w-4 shrink-0" /><span className="truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="flex h-screen">
      {open && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <aside className={cn("fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r bg-card transition-transform", open ? "translate-x-0" : "-translate-x-full", collapsed ? "md:hidden" : "md:static md:z-0 md:translate-x-0")} aria-label="Main navigation">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground"><Sparkles className="h-4 w-4" /></div>
          <span className="font-semibold tracking-tight">Test Flow AI</span>
          <button className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Hide panel" onClick={() => { setCollapsed(true); setOpen(false); }}><PanelLeftClose className="h-4 w-4" /></button>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{g.title}</div>
              <div className="space-y-0.5">{g.items.map((it) => <NavLink key={it.href} item={it} />)}</div>
            </div>
          ))}
        </nav>
        <div className="border-t p-3"><NavLink item={{ href: "/settings", label: "Settings", icon: Settings }} /></div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-0">
          <button className="text-muted-foreground hover:text-foreground md:hidden" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
          {collapsed && <button className="hidden text-muted-foreground hover:text-foreground md:block" aria-label="Show panel" onClick={() => setCollapsed(false)}><Menu className="h-5 w-5" /></button>}
          <form className="relative min-w-0 flex-1 sm:max-w-xs" onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/?q=${encodeURIComponent(q.trim())}`); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything…" aria-label="Ask the agent" className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </form>
          {/* per-page controls (the Agent Console portals its provider/model/voice/history/new here) */}
          <div id="topbar-actions" className="order-last flex min-w-0 basis-full items-center gap-1.5 sm:order-none sm:flex-1 sm:basis-auto" />
          <Link href="/repository" className="hidden shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent sm:flex" title="Connected repository">
            <FolderGit2 className="h-3.5 w-3.5" />
            {repo && !repo.error ? <span className="max-w-[160px] truncate">{baseName(repo.ref)}{repo.branch ? `@${repo.branch}` : ""}</span> : <span className="text-muted-foreground">Connect repo</span>}
            {repo && !repo.error && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
          </Link>
          <ThemeToggle />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden"><SidebarCtx.Provider value={{ collapsed }}>{children}</SidebarCtx.Provider></main>
      </div>
    </div>
  );
}
