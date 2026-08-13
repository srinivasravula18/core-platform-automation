import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, TestTube2, Bug, Settings, BrainCircuit, PlayCircle, FolderTree, Sun, Moon, Search, CircleUser, Layers, Menu, ClipboardList, Command, MessagesSquare, FolderGit2, ChevronDown, LogOut, Target, ScrollText, Radio, HardDrive, CalendarClock, BookOpen, Database, ShieldAlert, Trash2 } from 'lucide-react';
import { useRemoteAgentFlag } from '@/src/lib/useAutomation';
import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/store/theme';
import { CommandBar } from '@/src/components/CommandBar';
import { CommandPaletteHint, commandPaletteTitle } from '@/src/components/ShortcutHint';
import { useProjects } from '@/src/store/project';
import { AuthGate, logout, getUsername, getGrants } from '@/src/components/AuthGate';
import { FEATURES, grantAllows, featureKeyForPath } from '@/src/lib/features';
import { appBasePath } from '@/src/lib/base-path';
import { DialogHost } from '@/src/lib/dialog';
import { useResizableTables } from '@/src/lib/useResizableTables';
import { useTablePagination } from '@/src/lib/useTablePagination';
import { searchResultHref } from '@/src/lib/controllerIntent';

import AgentConsole from '@/src/pages/AgentConsole';
import RunningIndicator from '@/src/components/RunningIndicator';
import AgentPanel from '@/src/pages/AgentPanel';
import Dashboard from '@/src/pages/Dashboard';
import TestPlans from '@/src/pages/TestPlans';
import TestSuites from '@/src/pages/TestSuites';
import TestCases from '@/src/pages/TestCases';
import TestRuns from '@/src/pages/TestRuns';
import Defects from '@/src/pages/Defects';
import Reports from '@/src/pages/Reports';
import RecycleBin from '@/src/pages/RecycleBin';
import SettingsPage from '@/src/pages/Settings';
import Documentation from '@/src/pages/Documentation';
import GitAgent from '@/src/pages/GitAgent';
import TestRepository from '@/src/pages/TestRepository';
import Requirements from '@/src/pages/Requirements';
import Traceability from '@/src/pages/Traceability';
import RecordPlay from '@/src/pages/RecordPlay';
import LocalAgent from '@/src/pages/automation/LocalAgent';
import Schedules from '@/src/pages/automation/Schedules';
import DataBindings from '@/src/pages/automation/DataBindings';
import Projects from '@/src/pages/Projects';

function Sidebar({ isOpen }: { isOpen: boolean }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const remoteAgent = useRemoteAgentFlag();
  // Record & Play desktop-agent pages appear only when the backend enables REMOTE_AGENT_V1.
  const automationItems = [
    ...(remoteAgent ? [
      // Record Test + Executions folded into Test Management (Test Cases → New Case → Automation, and
      // Test Runs). Their routes below redirect there for any lingering bookmarks/links.
      { name: 'Schedules', href: '/automation/schedules', icon: CalendarClock },
      { name: 'Local Agent', href: '/automation/agent', icon: HardDrive },
      { name: 'Automation Data', href: '/automation/data', icon: Database },
    ] : [
      { name: 'Record & Play', href: '/record-play', icon: Radio },
    ]),
  ];
  const navGroups = [
    {
      label: 'Overview',
      items: [
        { name: 'Agent Console', href: '/', icon: MessagesSquare },
        { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
        { name: 'Projects', href: '/projects', icon: FolderGit2 },
      ],
    },
    {
      label: 'Test Management',
      items: [
        { name: 'Test Plans', href: '/plans', icon: FolderTree },
        { name: 'Test Suites', href: '/suites', icon: Layers },
        { name: 'Test Cases', href: '/cases', icon: TestTube2 },
        { name: 'Test Runs', href: '/runs', icon: PlayCircle },
      ],
    },
    {
      label: 'Quality',
      items: [
        { name: 'Requirements', href: '/requirements', icon: ScrollText },
        { name: 'Traceability', href: '/traceability', icon: Target },
        { name: 'Reports', href: '/reports', icon: ClipboardList },
        { name: 'Defects', href: '/defects', icon: Bug },
        { name: 'Recycle Bin', href: '/recycle-bin', icon: Trash2 },
      ],
    },
    {
      label: 'Automation',
      items: automationItems,
    },
  ];

  // Access-Group feature gating: hide nav items whose feature the user's groups do not grant. Admins
  // are unrestricted; users without grants retain shared chrome but see no grouped navigation.
  const grants = getGrants();
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const key = featureKeyForPath(item.href);
        return !key || grantAllows(grants, 'features', key);
      }),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className={cn(
      "border-r border-[var(--border)] bg-[var(--bg-card)] flex flex-col h-full flex-shrink-0 transition-all duration-300",
      isOpen ? "w-56" : "w-0 overflow-hidden opacity-0 border-r-0"
    )}>
      <div className="h-16 flex items-center px-6 border-b border-[var(--border)] whitespace-nowrap">
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight text-[var(--text-primary)]">
          <BrainCircuit className="w-6 h-6 text-[var(--accent)]" />
          Test Flow AI
        </div>
      </div>
      <div className="flex-1 py-4 px-3 flex flex-col gap-4 overflow-y-auto overflow-x-hidden">
        {visibleGroups.map((group) => {
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
                const matches = (href: string) => href === '/'
                  ? location.pathname === '/' || location.pathname.startsWith('/chat/') || location.pathname === '/agent' || location.pathname.startsWith('/agent/chat/')
                  : location.pathname === href || location.pathname.startsWith(`${href}/`);
                const isActive = matches(item.href)
                  && !group.items.some((candidate) => candidate.href.length > item.href.length && matches(candidate.href));
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
        {visibleGroups.length === 0 && (
          <div className="px-3 py-4 text-center text-xs leading-5 text-[var(--text-muted)]">
            No features assigned.<br />
            Contact an administrator for access.
          </div>
        )}
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
  const username = getUsername();
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ intents: any[]; summary: string } | null>(null);
  const [searchAnswer, setSearchAnswer] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiSearchRequestRef = useRef(0);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const onSearchInput = (value: string) => {
    aiSearchRequestRef.current += 1;
    setGlobalSearch(value);
    setSearchAnswer('');
    setSearchError('');
    setAnswering(false);
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

  const runAiSearch = (query: string) => {
    const requestId = ++aiSearchRequestRef.current;
    setAnswering(true);
    setSearchAnswer('');
    setSearchError('');
    setShowResults(true);
    fetch('/api/controller/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: query, workspaceId: 'default' }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || `Search failed (${response.status})`);
        if (aiSearchRequestRef.current === requestId) setSearchAnswer(data?.answer || 'No answer found.');
      })
      .catch((error) => {
        if (aiSearchRequestRef.current === requestId) setSearchError(error?.message || 'Search failed.');
      })
      .finally(() => {
        if (aiSearchRequestRef.current === requestId) setAnswering(false);
      });
  };

  const submitGlobalSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = globalSearch.trim();
    if (!query) return;
    const directHref = searchResults?.intents?.length === 1 ? searchResultHref(searchResults.intents[0], query) : '';
    if (directHref) {
      navigate(directHref);
      setShowResults(false);
      return;
    }
    runAiSearch(query);
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
          {showResults && (searchResults || searchAnswer || searchError || searching || answering) && (
            <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl overflow-hidden z-50">
              <div className="p-2 space-y-0.5">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {searching || answering ? 'Searching...' : searchAnswer ? 'AI Answer' : 'Search Result'}
                </div>
                {answering ? (
                  <div className="px-3 py-3 text-xs text-[var(--text-muted)]">Searching with AI...</div>
                ) : searchAnswer ? (
                  <div className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-xs leading-5 text-[var(--text-primary)]">
                    {searchAnswer}
                  </div>
                ) : searchError ? (
                  <div className="px-3 py-2 text-xs text-red-400">{searchError}</div>
                ) : searchResults?.intents.map((intent, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const href = searchResultHref(intent, globalSearch);
                      if (href) {
                        navigate(href);
                        setShowResults(false);
                      } else {
                        runAiSearch(globalSearch);
                      }
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[10px] font-bold text-[var(--accent)]">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{intent.title}</div>
                      <div className="text-[10px] text-[var(--text-muted)] line-clamp-3">{intent.params?.topic || intent.description}</div>
                    </div>
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{searchResultHref(intent, globalSearch) ? 'open' : 'answer'}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-[var(--border)] p-2">
                <button
                  onClick={() => { onCommandBarOpen(); setShowResults(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <Command className="w-3.5 h-3.5" />
                  <span>Open Full Command Palette</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div id="topbar-actions" className="flex items-center gap-2" />
      <div className="flex items-center gap-2 sm:gap-4">
        <RunningIndicator />
        <button
          onClick={onCommandBarOpen}
          title={commandPaletteTitle}
          className="hidden sm:flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
        >
          <CommandPaletteHint iconClassName="w-3.5 h-3.5" />
        </button>
        <button
          onClick={toggleTheme}
          className="p-2 rounded-full hover:bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
        <div ref={profileRef} className="relative">
          <button
            type="button"
            onClick={() => setProfileOpen((open) => !open)}
            aria-label={`Profile: ${username || 'User'}`}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
          >
            <CircleUser className="w-7 h-7 text-[var(--text-muted)]" />
            <span className="hidden sm:inline max-w-[10rem] truncate font-medium">{username || 'User'}</span>
            <ChevronDown className={cn('hidden h-3.5 w-3.5 text-[var(--text-muted)] transition-transform sm:block', profileOpen && 'rotate-180')} />
          </button>
          {profileOpen && (
            <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1.5 shadow-xl">
              <div className="border-b border-[var(--border)] px-3 py-2">
                <div className="truncate text-sm font-medium text-[var(--text-primary)]">{username || 'User'}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Signed in</div>
              </div>
              <Link
                role="menuitem"
                to="/documentation"
                onClick={() => setProfileOpen(false)}
                className="mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <BookOpen className="h-4 w-4" />
                Documentation
              </Link>
              <Link
                role="menuitem"
                to="/settings"
                onClick={() => setProfileOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Link>
              <button
                role="menuitem"
                onClick={logout}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // When the selected project/app changes, remount the page subtree so every page
  // re-fetches its data with the new scope (pages fetch on mount).
  const scopeKey = useProjects((s) => `${s.selectedProjectId ?? ''}:${s.selectedAppId ?? ''}`);
  // Gate the keyed subtree on projects having loaded. fetchProjects() resolves asynchronously (from the
  // Topbar's ProjectSwitcher) and may auto-select the first project, flipping scopeKey from ':' to
  // '<projectId>:'. If the subtree were already mounted, that flip would remount it mid-interaction and wipe
  // in-progress state (e.g. the Agent Console chat). Mounting only after `loaded` means the first mount uses
  // the already-resolved scope, so there is no null→first-project remount. (`loaded` becomes true even on
  // fetch error, so this never deadlocks.)
  const projectsLoaded = useProjects((s) => s.loaded);
  const fetchProjects = useProjects((s) => s.fetchProjects);
  const pageScrollRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const pagePositionKey = `testflow:page-position:${location.pathname}${location.search}`;

  // Guarantee the workspace loads even if the ProjectSwitcher is not mounted, so the gate above never
  // deadlocks on "Loading workspace…". Idempotent and only runs until loaded.
  useEffect(() => {
    if (!projectsLoaded) void fetchProjects();
  }, [projectsLoaded, fetchProjects]);

  useResizableTables();
  useTablePagination();

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

  // The application scrolls inside <main>, not the browser document. Native
  // browser scroll restoration therefore cannot restore a refreshed page.
  // Persist positions per route (including its selected URL-backed section).
  useEffect(() => {
    const container = pageScrollRef.current;
    if (!container) return;
    const savePosition = () => {
      try { sessionStorage.setItem(pagePositionKey, String(container.scrollTop)); } catch { /* storage unavailable */ }
    };
    container.addEventListener('scroll', savePosition, { passive: true });
    return () => {
      savePosition();
      container.removeEventListener('scroll', savePosition);
    };
  }, [pagePositionKey]);

  useEffect(() => {
    if (!projectsLoaded) return;
    const container = pageScrollRef.current;
    if (!container) return;
    let savedPosition = 0;
    try { savedPosition = Number(sessionStorage.getItem(pagePositionKey)) || 0; } catch { /* storage unavailable */ }
    if (!savedPosition) return;
    // Most pages fetch their content after mounting; retry briefly so their
    // restored section reaches its saved position once its rows are rendered.
    // Never let a delayed data-load retry override a scroll the user has made.
    let userHasScrolled = false;
    const rememberUserScroll = () => { userHasScrolled = true; };
    container.addEventListener('scroll', rememberUserScroll, { passive: true });
    const restore = () => {
      if (!userHasScrolled) container.scrollTop = savedPosition;
    };
    restore();
    const firstFrame = requestAnimationFrame(restore);
    const contentTimer = window.setTimeout(restore, 300);
    const finalTimer = window.setTimeout(restore, 900);
    return () => {
      cancelAnimationFrame(firstFrame);
      window.clearTimeout(contentTimer);
      window.clearTimeout(finalTimer);
      container.removeEventListener('scroll', rememberUserScroll);
    };
  }, [pagePositionKey, projectsLoaded, scopeKey]);

  return (
    <div className="flex h-[100dvh] w-full bg-[var(--bg-primary)] font-sans text-[var(--text-primary)] overflow-hidden">
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
        <main data-sidebar={isSidebarOpen ? 'open' : 'closed'} className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
          {projectsLoaded ? (
            <div ref={pageScrollRef} key={scopeKey} className="flex-1 min-h-0 overflow-auto p-3 sm:p-6 flex flex-col">
              {children}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
              Loading workspace…
            </div>
          )}
        </main>
      </div>
      <CommandBar isOpen={isCommandBarOpen} onOpenChange={setIsCommandBarOpen} />
    </div>
  );
}

/** Redirect away from a feature route the user's Access Groups do not explicitly grant. */
function NoAccessMessage() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4 text-[var(--text-primary)]">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-7 text-center shadow-xl">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-[var(--accent)]" />
        <h1 className="text-xl font-semibold">No Access Assigned</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">Your account has not been assigned to an access group. Contact an administrator to request access.</p>
        <button onClick={logout} className="mt-6 rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]">Sign Out</button>
      </div>
    </div>
  );
}

/** Shared chrome remains available; individual grouped features are guarded below. */
function AccessBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function FeatureGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const grants = getGrants();
  if (grants === 'UNRESTRICTED') return <>{children}</>;
  const firstAllowed = FEATURES.find((f) => grantAllows(grants, 'features', f.key));
  const key = featureKeyForPath(location.pathname);
  if (!key || grantAllows(grants, 'features', key)) return <>{children}</>;
  if (!firstAllowed) return <NoAccessMessage />;
  return <Navigate to={firstAllowed ? firstAllowed.hrefs[0] : '/'} replace />;
}

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter basename={appBasePath || undefined}>
      <AccessBoundary>
        <Shell>
          <FeatureGuard>
        <Routes>
          <Route path="/" element={<AgentConsole />} />
          <Route path="/chat/:chatId" element={<AgentConsole />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/repository" element={<TestRepository />} />
          <Route path="/plans" element={<TestPlans />} />
          <Route path="/plans/:planId" element={<TestPlans />} />
          <Route path="/suites" element={<TestSuites />} />
          <Route path="/suites/:suiteId" element={<TestSuites />} />
          <Route path="/cases" element={<TestCases />} />
          <Route path="/runs" element={<TestRuns />} />
          <Route path="/runs/:runId" element={<TestRuns />} />
          <Route path="/requirements" element={<Requirements />} />
          <Route path="/traceability" element={<Traceability />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/recycle-bin" element={<RecycleBin />} />
          <Route path="/defects" element={<Defects />} />
          <Route path="/agent" element={<AgentConsole />} />
          <Route path="/agent/chat/:chatId" element={<AgentConsole />} />
          <Route path="/studio" element={<AgentPanel />} />
          <Route path="/record-play" element={<RecordPlay />} />
          {/* Folded into Test Management — redirect old automation URLs to their new homes. */}
          <Route path="/automation" element={<Navigate to="/automation/agent" replace />} />
          <Route path="/automation/record" element={<Navigate to="/cases" replace />} />
          <Route path="/automation/executions" element={<Navigate to="/runs" replace />} />
          <Route path="/automation/schedules" element={<Schedules />} />
          <Route path="/automation/agent" element={<LocalAgent />} />
          <Route path="/automation/data" element={<DataBindings />} />
          <Route path="/git-agent" element={<GitAgent />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/documentation" element={<Documentation />} />
          <Route path="*" element={
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
               <FolderTree className="w-12 h-12 mb-4 opacity-50" />
               <h2 className="text-xl font-medium text-[var(--text-primary)]">Coming Soon</h2>
               <p className="mt-2 text-sm">This module is under construction.</p>
            </div>
          } />
        </Routes>
          </FeatureGuard>
        </Shell>
      </AccessBoundary>
      </BrowserRouter>
      <DialogHost />
    </AuthGate>
  );
}
