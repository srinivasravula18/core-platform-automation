import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { PlayCircle, Target, TestTube2, ShieldAlert, Sparkles, Layers } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/src/components/Modal';
import { AIActionModal } from '@/src/components/AIActionModal';
import { FolderSelect } from '@/src/components/FolderSelect';

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [suitesCount, setSuitesCount] = useState(0);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isAIPlanModalOpen, setIsAIPlanModalOpen] = useState(false);
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

  const handleAIApprove = (data: any) => {
    fetch('/api/plans', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: data.name })
    }).then(() => fetchStats());
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
          <button onClick={() => setIsAIPlanModalOpen(true)} className="flex items-center gap-1.5 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
            <Sparkles className="w-4 h-4" /> AI Auto
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

      <AIActionModal 
        isOpen={isAIPlanModalOpen}
        onClose={() => setIsAIPlanModalOpen(false)}
        taskType="plan"
        onApprove={handleAIApprove}
        title="AI Auto: New Test Plan"
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          { label: 'Test Plans', val: stats?.plansCount ?? 0, icon: Target },
          { label: 'Test Suites', val: suitesCount, icon: Layers },
          { label: 'Test Cases', val: stats?.casesCount ?? 0, icon: TestTube2 },
          { label: 'Active Runs', val: stats?.activeRunsCount ?? 0, icon: PlayCircle },
          { label: 'Open Defects', val: stats?.defectsCount ?? 0, icon: ShieldAlert },
        ].map((k) => (
          <div key={k.label} className="p-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
            <div className="flex justify-between items-start mb-2">
              <span className="text-sm font-medium text-[var(--text-muted)]">{k.label}</span>
              <k.icon className="w-5 h-5 text-[var(--text-muted)] opacity-50" />
            </div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{k.val}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        {/* Chart View */}
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

        {/* Recent Activity */}
        <div className="p-5 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm flex max-h-[420px] min-h-0 flex-col">
          <h2 className="text-base font-semibold mb-4">Recent Activity</h2>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
            {!stats?.recentActivity ? (
              <div className="text-sm text-[var(--text-muted)]">Loading activity...</div>
            ) : stats.recentActivity.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)]">No recent activity.</div>
            ) : (
              stats.recentActivity.slice(0, 6).map((act: any, i: number) => (
                <div key={i} className="flex flex-col border-l-2 border-[var(--accent)] pl-4 py-1">
                  <span className="text-sm text-[var(--text-primary)] font-medium">{act.message}</span>
                  <span className="text-xs text-[var(--text-muted)] mt-1">{act.time}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

