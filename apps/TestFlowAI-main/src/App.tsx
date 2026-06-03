import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, TestTube2, Bug, Settings, BrainCircuit, PlayCircle, FolderTree, Sun, Moon, Search, CircleUser, Layers, Menu, ClipboardList } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/store/theme';

import Dashboard from '@/src/pages/Dashboard';
import TestPlans from '@/src/pages/TestPlans';
import TestSuites from '@/src/pages/TestSuites';
import TestCases from '@/src/pages/TestCases';
import TestRuns from '@/src/pages/TestRuns';
import Defects from '@/src/pages/Defects';
import Reports from '@/src/pages/Reports';
import SettingsPage from '@/src/pages/Settings';
import AgentPanel from '@/src/pages/AgentPanel';

function Sidebar({ isOpen }: { isOpen: boolean }) {
  const location = useLocation();
  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Test Plans', href: '/plans', icon: FolderTree },
    { name: 'Test Suites', href: '/suites', icon: Layers },
    { name: 'Test Cases', href: '/cases', icon: TestTube2 },
    { name: 'Test Runs', href: '/runs', icon: PlayCircle },
    { name: 'Reports', href: '/reports', icon: ClipboardList },
    { name: 'Defects', href: '/defects', icon: Bug },
    { name: 'AI Agent', href: '/agent', icon: BrainCircuit },
  ];

  return (
    <div className={cn(
      "border-r border-[var(--border)] bg-[var(--bg-card)] flex flex-col h-full flex-shrink-0 transition-all duration-300",
      isOpen ? "w-64" : "w-0 overflow-hidden opacity-0 border-r-0"
    )}>
      <div className="h-16 flex items-center px-6 border-b border-[var(--border)] whitespace-nowrap">
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight text-[var(--text-primary)]">
          <BrainCircuit className="w-6 h-6 text-[var(--accent)]" />
          TestFlowAI
        </div>
      </div>
      <div className="flex-1 py-4 px-3 flex flex-col gap-1 overflow-y-auto overflow-x-hidden">
        {navigation.map((item) => {
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

function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="h-16 border-b border-[var(--border)] bg-[var(--bg-card)] flex items-center justify-between px-6 flex-shrink-0">
      <div className="flex items-center gap-4 w-96">
        <button 
          onClick={onMenuClick}
          className="p-2 rounded-md hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-colors flex-shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input 
            type="text" 
            placeholder="Search plans, cases, runs..." 
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-10 pr-4 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] placeholder-[var(--text-muted)] transition-colors"
          />
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button 
          onClick={toggleTheme}
          className="p-2 rounded-full hover:bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
        <button className="flex items-center gap-2 p-1 rounded-full hover:bg-[var(--bg-secondary)] transition-colors">
          <CircleUser className="w-8 h-8 text-[var(--text-muted)]" />
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="flex h-screen w-full bg-[var(--bg-primary)] font-sans text-[var(--text-primary)] overflow-hidden">
      <Sidebar isOpen={isSidebarOpen} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />
        <main className="flex-1 overflow-auto p-6 relative">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/plans" element={<TestPlans />} />
          <Route path="/suites" element={<TestSuites />} />
          <Route path="/cases" element={<TestCases />} />
          <Route path="/runs" element={<TestRuns />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/defects" element={<Defects />} />
          <Route path="/agent" element={<AgentPanel />} />
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
  );
}
