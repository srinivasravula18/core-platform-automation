import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { PlayCircle, Target, TestTube2, ShieldAlert, Sparkles, Layers, Activity, FileText, CalendarClock, Clock, AlertTriangle, Gauge, Bug, CheckCircle2, ListChecks } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/src/components/Modal';
import { FolderSelect } from '@/src/components/FolderSelect';
import { cn } from '@/src/lib/utils';

// Recent Activity: per-type icon + the page each entry deep-links to.
const ACTIVITY_ICON: Record<string, any> = { case: TestTube2, plan: Target, suite: Layers, run: PlayCircle, defect: ShieldAlert, report: FileText };
function activityRoute(act: any): string {
  switch (act?.type) {
    case 'case': return '/cases';
    case 'plan': return '/plans';
    case 'suite': return '/suites';
    case 'run': return act.entityId ? `/runs/${act.entityId}` : '/runs';
    case 'defect': return '/defects';
    case 'report': return '/reports';
    default: return '';
  }
}
function relativeTime(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m || 1} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
function activityOutcome(act: any): string {
  const meta = act?.meta || {};
  if (act?.type === 'run' && (meta.passed != null || meta.failed != null)) return `${meta.passed ?? 0} passed · ${meta.failed ?? 0} failed`;
  if (act?.type === 'defect' && meta.severity) return String(meta.severity);
  return '';
}

const SEVERITY_COLOR: Record<string, string> = { Critical: 'bg-red-600', High: 'bg-red-500', Medium: 'bg-amber-500', Low: 'bg-emerald-500' };

function formatCountdown(iso?: string | null, now = Date.now()): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return '';
  if (diff <= 0) return 'due now';
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Shared card shell so every widget reads as one system.
function Panel({ title, icon: Icon, children }: { title: string; icon?: any; children: any }) {
  return (
    <div className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        {Icon && <Icon className="h-4 w-4 text-[var(--text-muted)]" />} {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

// A large percentage with a progress bar; shows an honest empty state when the value is null.
function PercentCard({ title, icon, value, sub, empty, tone }: { title: string; icon: any; value: number | null | undefined; sub?: string; empty?: string; tone: 'emerald' | 'accent' }) {
  const barColor = tone === 'emerald' ? 'bg-emerald-500' : 'bg-[var(--accent)]';
  return (
    <Panel title={title} icon={icon}>
      {value == null ? (
        <div className="text-sm text-[var(--text-muted)]">{empty || 'No data yet.'}</div>
      ) : (
        <>
          <div className="text-3xl font-bold text-[var(--text-primary)]">{value}%</div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--bg-secondary)]">
            <div className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
          </div>
          {sub && <div className="mt-2 text-xs text-[var(--text-muted)]">{sub}</div>}
        </>
      )}
    </Panel>
  );
}

function EmptyNote({ children }: { children: any }) {
  return <div className="text-sm text-[var(--text-muted)]">{children}</div>;
}

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [suitesCount, setSuitesCount] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now()); // drives the Next Run countdown
  useEffect(() => { const t = window.setInterval(() => setNowTick(Date.now()), 60_000); return () => window.clearInterval(t); }, []);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [formData, setFormData] = useState({ 
    name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: '', folderId: ''
  });
  const navigate = useNavigate();

  const fetchStats = () => {
    fetch('/api/stats')
      .then(r => r.json())
      .then(data => setStats(data))
      .catch(console.error);
    // Suites count isn't in /api/stats, so derive it from the suites list (scope-filtered like the rest).
    fetch('/api/suites')
      .then(r => r.json())
      .then(data => setSuitesCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});
  };

  useEffect(() => {
    fetchStats();
    const interval = window.setInterval(fetchStats, 10000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchStats();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const handleNewPlan = () => {
    if (!formData.name.trim()) return;
    fetch('/api/plans', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(formData)
    }).then(() => {
       setFormData({ name: '', scope: '', objectives: '', inScope: '', outOfScope: '', strategy: '', testTypes: '', environments: '', roles: '', entryExit: '', schedule: '', risks: '', deliverables: '', folderId: '' });
       setIsPlanModalOpen(false);
       fetchStats();
    });
  };

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Good morning, see your QA progress at a glance.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setIsPlanModalOpen(true)} className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            + New Plan
          </button>
        </div>
      </div>

      <Modal isOpen={isPlanModalOpen} onClose={() => setIsPlanModalOpen(false)} title="Create New Test Plan">
        <div className="space-y-4 max-h-[70dvh] overflow-y-auto px-1">
          <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-card)] pb-4">
            <FolderSelect
              value={formData.folderId}
              onChange={(folderId) => setFormData({ ...formData, folderId })}
              label="Repository Folder"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Plan Name (e.g. Release 2.4)</label>
            <input 
              type="text" 
              value={formData.name}
              onChange={(e) => setFormData({...formData, name: e.target.value})}
              placeholder="e.g., Sprint 20 Regression" 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Scope & Objectives</label>
            <textarea 
              value={formData.objectives}
              onChange={(e) => setFormData({...formData, objectives: e.target.value})}
              placeholder="What are we testing and why?" 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-16" 
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">In-Scope</label>
                <input type="text" value={formData.inScope} onChange={(e) => setFormData({...formData, inScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Out-of-Scope</label>
                <input type="text" value={formData.outOfScope} onChange={(e) => setFormData({...formData, outOfScope: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Strategy</label>
                <input type="text" value={formData.strategy} onChange={(e) => setFormData({...formData, strategy: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Test Types</label>
                <input type="text" value={formData.testTypes} onChange={(e) => setFormData({...formData, testTypes: e.target.value})} placeholder="e.g. Manual, Auto, API" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Environments</label>
                <input 
                  type="text" 
                  value={formData.environments}
                  onChange={(e) => setFormData({...formData, environments: e.target.value})}
                  placeholder="e.g., Staging, UAT, Prod" 
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Resources & Roles</label>
                <input 
                  type="text" 
                  value={formData.roles}
                  onChange={(e) => setFormData({...formData, roles: e.target.value})}
                  placeholder="e.g., QA Team, Devs" 
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Entry/Exit Criteria</label>
                <input type="text" value={formData.entryExit} onChange={(e) => setFormData({...formData, entryExit: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Schedule</label>
                <input type="text" value={formData.schedule} onChange={(e) => setFormData({...formData, schedule: e.target.value})} placeholder="e.g. 2 weeks" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Risks & Dependencies</label>
                <input type="text" value={formData.risks} onChange={(e) => setFormData({...formData, risks: e.target.value})} className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Deliverables</label>
                <input type="text" value={formData.deliverables} onChange={(e) => setFormData({...formData, deliverables: e.target.value})} placeholder="e.g. Plan, Summary Report" className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" />
             </div>
          </div>
          
          <div className="pt-2 flex justify-end gap-3">
            <button onClick={() => setIsPlanModalOpen(false)} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
            <button onClick={handleNewPlan} disabled={!formData.name.trim()} className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50">Create Plan</button>
          </div>
        </div>
      </Modal>

      {/* Row 1 — count KPIs (#1 Plans, #2 Suites, #3 Cases, #4 Active Runs, #5 Open Defects, #8 Cases not in any run) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Test Plans', val: stats?.plansCount ?? 0, icon: Target, to: '/plans' },
          { label: 'Test Suites', val: suitesCount, icon: Layers, to: '/suites' },
          { label: 'Test Cases', val: stats?.casesCount ?? 0, icon: TestTube2, to: '/cases' },
          { label: 'Active Runs', val: stats?.activeRunsCount ?? 0, icon: PlayCircle, to: '/runs' },
          { label: 'Open Defects', val: stats?.openDefectsCount ?? stats?.defectsCount ?? 0, icon: ShieldAlert, to: '/defects' },
          { label: 'Cases Not in Any Run', val: stats?.casesNotInAnyRun ?? 0, icon: AlertTriangle, to: '/cases' },
        ].map((k) => (
          <div key={k.label} onClick={() => navigate(k.to)} className="cursor-pointer rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm transition-colors hover:border-[var(--accent)]">
            <div className="mb-2 flex items-start justify-between">
              <span className="text-sm font-medium text-[var(--text-muted)]">{k.label}</span>
              <k.icon className="h-5 w-5 text-[var(--text-muted)] opacity-50" />
            </div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{k.val}</div>
          </div>
        ))}
      </div>

      {/* Row 2 — health (#6 Pass Rate, #7 Automation Coverage, #7b Defects by Severity) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PercentCard title="Pass Rate / Case Health" icon={Gauge} value={stats?.passRate ?? null} empty="No runs with recorded outcomes yet." sub="passed vs failed across all runs" tone="emerald" />
        <PercentCard title="Automation Coverage" icon={Sparkles} value={stats?.automationCoverage ?? 0} sub={`${stats?.automatedCasesCount ?? 0} of ${stats?.casesCount ?? 0} cases automated`} tone="accent" />
        <Panel title="Open Defects by Severity" icon={Bug}>
          {(() => {
            const sev = stats?.defectsBySeverity || {};
            const total = ['Critical', 'High', 'Medium', 'Low'].reduce((a, k) => a + (sev[k] || 0), 0);
            if (!total) return <EmptyNote>No open defects. 🎉</EmptyNote>;
            return (
              <div className="space-y-2">
                {['Critical', 'High', 'Medium', 'Low'].map((k) => (
                  <div key={k} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-[var(--text-muted)]">{k}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-secondary)]">
                      <div className={cn('h-full rounded-full', SEVERITY_COLOR[k])} style={{ width: `${(((sev[k] || 0) / total) * 100).toFixed(1)}%` }} />
                    </div>
                    <span className="w-6 text-right font-medium text-[var(--text-primary)]">{sev[k] || 0}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </Panel>
      </div>

      {/* Row 3 — Execution Trend (#9) + Recent Activity (#16) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        <div className="lg:col-span-2 p-5 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
          <h2 className="text-base font-semibold mb-6">Execution Trend (Last 5 Days)</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.chartData || []} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'transparent' }} contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)', borderRadius: '8px' }} />
                <Bar dataKey="passed" stackId="a" fill="var(--accent)" radius={[0,0,4,4]} />
                <Bar dataKey="failed" stackId="a" fill="#ef4444" />
                <Bar dataKey="blocked" stackId="a" fill="#f59e0b" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="p-5 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm flex max-h-[420px] min-h-0 flex-col">
          <h2 className="text-base font-semibold mb-4">Recent Activity</h2>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
            {!stats?.recentActivity ? (
              <div className="text-sm text-[var(--text-muted)]">Loading activity...</div>
            ) : stats.recentActivity.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)]">No recent activity.</div>
            ) : (
              stats.recentActivity.slice(0, 8).map((act: any, i: number) => {
                const Icon = ACTIVITY_ICON[act.type] || Activity;
                const route = activityRoute(act);
                const outcome = activityOutcome(act);
                const when = relativeTime(act.createdAt) || act.time;
                return (
                  <div
                    key={i}
                    onClick={route ? () => navigate(route) : undefined}
                    title={route ? 'Open' : undefined}
                    className={cn(
                      'flex items-start gap-3 border-l-2 border-[var(--accent)] pl-3 py-1.5',
                      route && 'cursor-pointer rounded-r-md hover:bg-[var(--bg-secondary)]',
                    )}
                  >
                    <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--text-primary)]">{act.message}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--text-muted)]">
                        <span title={act.createdAt ? new Date(act.createdAt).toLocaleString() : undefined}>{when}</span>
                        {act.actor && <><span>·</span><span>{act.actor}</span></>}
                        {outcome && <><span>·</span><span className={act.type === 'run' ? 'text-[var(--text-primary)]' : ''}>{outcome}</span></>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Row 4 — scheduled automation (#10 Upcoming, #12 Next countdown, #13 Health, #11 Last run) */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Panel title="Upcoming Scheduled Runs" icon={CalendarClock}>
          {(stats?.upcomingSchedules || []).length === 0 ? <EmptyNote>No scheduled runs.</EmptyNote> : (
            <ul className="space-y-2 text-xs">
              {stats.upcomingSchedules.map((s: any) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className="truncate text-[var(--text-primary)]">{s.kind || 'run'}{s.cron ? ` · ${s.cron}` : ''}</span>
                  <span className="whitespace-nowrap text-[var(--text-muted)]">{new Date(s.nextRunAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Next Run In" icon={Clock}>
          {stats?.nextScheduledRunAt ? (
            <div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">{formatCountdown(stats.nextScheduledRunAt, nowTick)}</div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">{new Date(stats.nextScheduledRunAt).toLocaleString()}</div>
            </div>
          ) : <EmptyNote>None scheduled.</EmptyNote>}
        </Panel>
        <Panel title="Schedule Health" icon={AlertTriangle}>
          {(stats?.scheduleHealth?.total ?? 0) === 0 ? <EmptyNote>No schedules configured.</EmptyNote> : (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-[var(--text-muted)]">Enabled</span><span className="font-medium text-[var(--text-primary)]">{stats.scheduleHealth.enabled}</span></div>
              <div className="flex justify-between"><span className="text-[var(--text-muted)]">Missed</span><span className={cn('font-medium', stats.scheduleHealth.missed ? 'text-red-500' : 'text-emerald-500')}>{stats.scheduleHealth.missed}</span></div>
            </div>
          )}
        </Panel>
        <Panel title="Last Automation Run" icon={CheckCircle2}>
          {stats?.lastAutomationRun ? (() => {
            const r = stats.lastAutomationRun; const ok = r.status === 'done';
            return (
              <div>
                <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-red-500/30 bg-red-500/10 text-red-500')}>{ok ? 'Passed' : r.status}</span>
                <div className="mt-2 text-xs text-[var(--text-muted)]">{r.summary?.passed ?? 0}✓ {r.summary?.failed ?? 0}✗{r.finishedAt ? ` · ${relativeTime(r.finishedAt)}` : ''}</div>
              </div>
            );
          })() : <EmptyNote>No automation runs yet.</EmptyNote>}
        </Panel>
      </div>

      {/* Row 5 — insights (#14 Top failing, #15 Plan timelines) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Top Failing Features" icon={Bug}>
          {(stats?.topFailing || []).length === 0 ? <EmptyNote>No failures recorded across runs. 🎉</EmptyNote> : (
            <ul className="space-y-2 text-sm">
              {stats.topFailing.map((f: any, i: number) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate text-[var(--text-primary)]">{f.feature}</span>
                  <span className="whitespace-nowrap font-medium text-red-500">{f.fails} fail{f.fails === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Test Plan Timelines" icon={ListChecks}>
          {(stats?.openPlans || []).length === 0 ? <EmptyNote>No active test plans.</EmptyNote> : (
            <>
              <ul className="space-y-2 text-sm">
                {stats.openPlans.map((p: any) => (
                  <li key={p.id} onClick={() => navigate('/plans')} className="flex cursor-pointer justify-between gap-2 hover:text-[var(--accent)]">
                    <span className="truncate text-[var(--text-primary)]">{p.name}</span>
                    <span className="whitespace-nowrap text-xs text-[var(--text-muted)]">{p.schedule || p.status}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-[11px] text-[var(--text-muted)]">Plans have no due dates configured — showing active plans by status.</div>
            </>
          )}
        </Panel>
      </div>

    </div>
  );
}

