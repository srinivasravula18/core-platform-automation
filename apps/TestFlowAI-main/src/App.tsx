import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, TestTube2, Bug, Settings, BrainCircuit, PlayCircle, FolderTree, Sun, Moon, Search, CircleUser, Layers, Menu, ClipboardList, GitBranch, Command, MessagesSquare, ChevronDown, LogOut } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/store/theme';
import { AIInbox } from '@/src/components/AIInbox';
import { CommandBar } from '@/src/components/CommandBar';
import { AuthGate, logout } from '@/src/components/AuthGate';
import { appBasePath } from '@/src/lib/base-path';

import AgentConsole from '@/src/pages/AgentConsole';
import AgentPanel from '@/src/pages/AgentPanel';
import Dashboard from '@/src/pages/Dashboard';
import TestPlans from '@/src/pages/TestPlans';
import TestSuites from '@/src/pages/TestSuites';
import TestCases from '@/src/pages/TestCases';
import TestRuns from '@/src/pages/TestRuns';
import Defects from '@/src/pages/Defects';
import Reports from '@/src/pages/Reports';
import SettingsPage from '@/src/pages/Settings';
import GitAgent from '@/src/pages/GitAgent';
import TestRepository from '@/src/pages/TestRepository';

function Sidebar({ isOpen }: { isOpen: boolean }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const navGroups = [
    {
      label: 'Overview',
      items: [
        { name: 'Agent Console', href: '/', icon: MessagesSquare },
        { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      ],
    },
    {
      label: 'Test Management',
      items: [
        { name: 'File System', href: '/repository', icon: FolderTree },
        { name: 'Test Plans', href: '/plans', icon: FolderTree },
        { name: 'Test Suites', href: '/suites', icon: Layers },
        { name: 'Test Cases', href: '/cases', icon: TestTube2 },
        { name: 'Test Runs', href: '/runs', icon: PlayCircle },
      ],
    },
    {
      label: 'Quality',
      items: [
        { name: 'Reports', href: '/reports', icon: ClipboardList },
        { name: 'Defects', href: '/defects', icon: Bug },
      ],
    },
    {
      label: 'Automation',
      items: [{ name: 'Git Agent', href: '/git-agent', icon: GitBranch }],
    },
  ];

  return (
    <div className={cn(
      "border-r border-[var(--border)] bg-[var(--bg-card)] flex flex-col h-full flex-shrink-0 transition-all duration-300",
      isOpen ? "w-56" : "w-0 overflow-hidden opacity-0 border-r-0"
    )}>
      <div className="h-16 flex items-center px-6 border-b border-[var(--border)] whitespace-nowrap">
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight text-[var(--text-primary)]">
          <BrainCircuit className="w-6 h-6 text-[var(--accent)]" />
          TestFlowAI
        </div>
      </div>
      <div className="flex-1 py-4 px-3 flex flex-col gap-4 overflow-y-auto overflow-x-hidden">
        {navGroups.map((group) => {
          const isCollapsed = collapsed[group.label];
          return (
            <div key={group.label} className="flex flex-col gap-1">
              <button
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.label]: !prev[group.label] }))}
                className="flex items-center justify-between px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] opacity-70 hover:opacity-100 whitespace-nowrap"
              >
                <span>{group.label}</span>
                <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", isCollapsed && "-rotate-90")} />
              </button>
              {!isCollapsed && group.items.map((item) => {
                const isActive = location.pathname === item.href;
                return (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      isActive
                        ? "bg-[var(--accent)] bg-opacity-10 text-[var(--accent)]"
                        : "text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="p-4 border-t border-[var(--border)] whitespace-nowrap">
        <Link
          to="/settings"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <Settings className="w-4 h-4 flex-shrink-0" />
          Settings
        </Link>
      </div>
    </div>
  );
}

function Topbar({ onMenuClick, onCommandBarOpen }: { onMenuClick: () => void; onCommandBarOpen: () => void }) {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ intents: any[]; summary: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const onSearchInput = (value: string) => {
    setGlobalSearch(value);
    const q = value.trim();
    if (q.length < 2) {
      setSearchResults(null);
      setShowResults(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      fetch('/api/controller/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: q, workspaceId: 'default' }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.intents?.length) {
            setSearchResults(data);
            setShowResults(true);
          }
        })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 300);
  };

  const submitGlobalSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = globalSearch.trim();
    if (!query) return;
    if (searchResults?.intents?.length === 1 && searchResults.intents[0].kind === 'navigate') {
      const path = searchResults.intents[0].params?.path || '/cases?search=' + encodeURIComponent(query);
      navigate(path);
      setShowResults(false);
      return;
    }
    if (searchResults?.intents?.length && searchResults.intents.some((i) => i.kind !== 'navigate')) {
      onCommandBarOpen();
      setShowResults(false);
      return;
    }
    navigate(`/cases?search=${encodeURIComponent(query)}`);
    setShowResults(false);
  };

  return (
    <div className="h-16 border-b border-[var(--border)] bg-[var(--bg-card)] flex items-center justify-between px-6 flex-shrink-0">
      <div className="flex items-center gap-4 w-96">
        <button 
          onClick={onMenuClick}
          className="p-2 rounded-md hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-colors flex-shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div ref={searchRef} className="relative w-full">
          <form onSubmit={submitGlobalSearch}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              type="text" 
              value={globalSearch}
              onChange={(e) => onSearchInput(e.target.value)}
              onFocus={() => { if (searchResults) setShowResults(true); }}
              placeholder="Ask AI or search plans, cases, runs..." 
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-10 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] placeholder-[var(--text-muted)] transition-colors"
            />
          </form>
          {showResults && searchResults && (
            <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl overflow-hidden z-50">
              <div className="p-2 space-y-0.5">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {searching ? 'Analyzing...' : 'AI Interpretation'}
                </div>
                {searchResults.intents.map((intent, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (intent.kind === 'navigate') {
                        navigate(intent.params?.path || '/');
                      } else {
                        onCommandBarOpen();
                      }
                      setShowResults(false);
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[10px] font-bold text-[var(--accent)]">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{intent.title}</div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">{intent.description}</div>
                    </div>
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{intent.kind}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-[var(--border)] p-2">
                <button
                  onClick={() => { onCommandBarOpen(); setShowResults(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <Command className="w-3.5 h-3.5" />
                  <span>Open full command palette</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <button
          onClick={onCommandBarOpen}
          className="hidden sm:flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
        >
          <Command className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Cmd+K</span>
        </button>
        <AIInbox />
        <button
          onClick={toggleTheme}
          className="p-2 rounded-full hover:bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
        <button onClick={() => navigate('/settings')} title="Open settings" className="flex items-center gap-2 p-1 rounded-full hover:bg-[var(--bg-secondary)] transition-colors">
          <CircleUser className="w-8 h-8 text-[var(--text-muted)]" />
        </button>
        <button
          onClick={logout}
          title="Sign out"
          className="p-2 rounded-full hover:bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) setIsSidebarOpen(false);
      else setIsSidebarOpen(true);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="flex h-screen w-full bg-[var(--bg-primary)] font-sans text-[var(--text-primary)] overflow-hidden">
      {isMobile && isSidebarOpen && (
        <button
          aria-label="Close sidebar"
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}
      <div
        className={cn(
          'flex-shrink-0 transition-all duration-300',
          isMobile
            ? (isSidebarOpen ? 'fixed inset-y-0 left-0 z-40 w-56 shadow-2xl' : 'w-0 overflow-hidden')
            : (isSidebarOpen ? 'w-56' : 'w-0 overflow-hidden opacity-0 border-r-0'),
        )}
        style={isMobile && !isSidebarOpen ? { display: 'none' } : undefined}
      >
        <Sidebar isOpen={true} />
      </div>
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} onCommandBarOpen={() => setIsCommandBarOpen(true)} />
        <main data-sidebar={isSidebarOpen ? 'open' : 'closed'} className="flex-1 overflow-auto p-3 sm:p-6 relative">
          {children}
        </main>
      </div>
      <CommandBar isOpen={isCommandBarOpen} onOpenChange={setIsCommandBarOpen} />
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter basename={appBasePath || undefined}>
      <Shell>
        <Routes>
          <Route path="/" element={<AgentConsole />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/repository" element={<TestRepository />} />
          <Route path="/plans" element={<TestPlans />} />
          <Route path="/plans/:planId" element={<TestPlans />} />
          <Route path="/suites" element={<TestSuites />} />
          <Route path="/cases" element={<TestCases />} />
          <Route path="/runs" element={<TestRuns />} />
          <Route path="/runs/:runId" element={<TestRuns />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/defects" element={<Defects />} />
          <Route path="/agent" element={<AgentConsole />} />
          <Route path="/studio" element={<AgentPanel />} />
          <Route path="/git-agent" element={<GitAgent />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
               <FolderTree className="w-12 h-12 mb-4 opacity-50" />
               <h2 className="text-xl font-medium text-[var(--text-primary)]">Coming Soon</h2>
               <p className="mt-2 text-sm">This module is under construction.</p>
            </div>
          } />
        </Routes>
      </Shell>
      </BrowserRouter>
    </AuthGate>
  );
}
