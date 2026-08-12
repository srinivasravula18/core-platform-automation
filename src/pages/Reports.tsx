import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Search, Filter, ShieldCheck, ShieldAlert, Sparkles, Plus, Clock, Layers, User, Calendar, Trash2, Eye, EyeOff, AlertTriangle, PlayCircle, ExternalLink, Activity, Pencil, Check, X } from 'lucide-react';
import { Timestamp, actorName } from '@/src/components/Timestamp';
import { TimeRangeFilter, passesTimeFilter, type TimeFilterValue } from '@/src/components/filters/TimeRangeFilter';
import { nextSort, sortRows, SortableHeader, type SortState } from '@/src/components/DataTable/sortable';
import ExportMenu from '../components/ExportMenu';
import { downloadFile, printReportPDF, reportMetrics, reportTypeLabel, toReportHTML, toReportMarkdown, type ReportContext } from '../lib/exportData';
import { cn } from '@/src/lib/utils';
import { useAiSearch } from '@/src/lib/useAiSearch';
import { useBulkDelete } from '@/src/lib/useBulkDelete';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { FolderSelect } from '@/src/components/FolderSelect';
import { FolderBadge } from '@/src/components/FolderBadge';
import { withBasePath } from '@/src/lib/base-path';
import { showConfirm } from '@/src/lib/dialog';
import { useUrlState } from '@/src/lib/useUrlState';
import { TESTING_TYPES } from '@/core/shared/testCaseTypes';
import { DetailedReportView } from '@/src/components/reports/DetailedReportView';

interface Step {
  step: string;
  action: string;
  expected: string;
  outcome: 'Pass' | 'Fail' | 'Skipped';
  reason?: string;
  actual?: string;
  durationMs?: number;
  testCaseTitle?: string;
  testCaseId?: string;
  screenshot: string;
}

interface Report {
  id: string;
  runId?: string;
  planId?: string;
  name: string;
  folderId?: string;
  planName: string;
  suiteName: string;
  requestedBy: string;
  executionTime: string;
  totalExecutions: number;
  status: 'Passed' | 'Failed' | 'Skipped';
  failureReason?: string;
  targetUrl?: string;
  date: string;
  steps: Step[];
  evidence?: any[];
  updatedAt?: string;
  metadata?: { updatedAt?: string };
}

interface EvidenceGalleryItem {
  key: string;
  title: string;
}

function stepEvidence(report: Report, step: Step, index: number): string {
  if (step.screenshot) return step.screenshot;
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const item = evidence.find((entry) =>
    (entry?.testCaseId && entry.testCaseId === (step as any).testCaseId)
    || (entry?.title && entry.title === (step as any).testCaseTitle)
  ) || evidence[index];
  return item?.stepScreenshots?.[0] || item?.screenshotUrl || item?.screenshot || item?.url || '';
}

function evidenceImageSource(value: string): string {
  return value.startsWith('/evidence/') || value.startsWith('data:')
    ? withBasePath(value)
    : withBasePath(`/api/screenshot?url=${encodeURIComponent(value)}`);
}

function evidenceGalleryItems(report: Report | null): EvidenceGalleryItem[] {
  if (!report) return [];
  const items: EvidenceGalleryItem[] = [];
  const seen = new Set<string>();
  const add = (key: unknown, title: string) => {
    if (typeof key !== 'string' || !key || seen.has(key)) return;
    seen.add(key);
    items.push({ key, title });
  };

  (report.steps || []).forEach((step, index) => {
    add(stepEvidence(report, step, index), `Step ${index + 1}: ${step.action || 'Captured Screenshot'}`);
  });
  (Array.isArray(report.evidence) ? report.evidence : []).forEach((entry, index) => {
    const title = entry?.title || `Evidence ${index + 1}`;
    (Array.isArray(entry?.stepScreenshots) ? entry.stepScreenshots : []).forEach((key: unknown, stepIndex: number) => {
      add(key, `${title} — step ${stepIndex + 1}`);
    });
    add(entry?.screenshotUrl || entry?.screenshot || entry?.url, title);
  });
  return items;
}

// Preset visual screens to render for screenshot evidence
const SCREENSHOT_PRESETS: Record<string, { title: string; url: string; contentHtml: React.ReactNode }> = {
  login_success: {
    title: "Login Screen (Success Code 200)",
    url: "https://auth.testflow.ai/login?state=callback",
    contentHtml: (
      <div className="bg-emerald-950/20 text-emerald-400 p-4 rounded border border-emerald-500/20 font-mono text-xs h-full flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-emerald-500 font-bold mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            AUTH CODE ACCESS GRANTED
          </div>
          <p className="text-slate-400 text-[11px] mb-2 font-sans">Redirecting to active console endpoint...</p>
          <div className="bg-emerald-950/40 p-2 rounded text-emerald-300 border border-emerald-500/10 mb-2 text-[11px]">
            TOKEN_TYPE: Bearer<br />
            EXPIRES_IN: 3600s<br />
            SCOPE: sheets.write profiles.read
          </div>
        </div>
        <div className="text-[10px] text-emerald-500/60 flex justify-between border-t border-emerald-500/10 pt-2 font-sans">
          <span>Client: Test Flow AI Auth Engine</span>
          <span>Latency: 114ms</span>
        </div>
      </div>
    )
  },
  checkout_address: {
    title: "Checkout System (Address Form Verification)",
    url: "https://store.testflow.ai/checkout/shipping",
    contentHtml: (
      <div className="bg-slate-900 border border-slate-800 p-4 rounded text-slate-300 font-sans text-xs h-full flex flex-col justify-between">
        <div>
          <div className="flex justify-between items-center pb-2 border-b border-slate-800 mb-2">
            <span className="font-semibold text-slate-200">Shipping Information</span>
            <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">Address OK</span>
          </div>
          <div className="space-y-1.5">
            <div className="bg-slate-850 p-1.5 rounded text-[11px] border border-slate-800 text-slate-300">
              <span className="text-slate-400 font-semibold mr-1.5">Recipient:</span> J. Doe
            </div>
            <div className="bg-slate-850 p-1.5 rounded text-[11px] border border-slate-800 text-slate-300">
              <span className="text-slate-400 font-semibold mr-1.5">Address:</span> 1600 Amphitheatre Pkwy, Mountain View, CA 94043
            </div>
          </div>
        </div>
        <div className="text-[10px] text-slate-500 text-right pt-2 font-mono">
          DOM: FormValidated = true
        </div>
      </div>
    )
  },
  payment_iframe_error: {
    title: "Secure Payment Iframe (Gateway Refused - Timeout Error)",
    url: "https://gateway.stripe-api.net/secure-frame/charges",
    contentHtml: (
      <div className="bg-red-950/20 text-red-400 p-4 rounded border border-red-500/20 font-mono text-xs h-full flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-red-500 font-bold mb-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            GATEWAY_TIMEOUT_STATUS_504
          </div>
          <p className="text-slate-400 text-[11px] mb-2 leading-relaxed font-sans">The server took too long to resolve the iframe contents from Stripe payment endpoints.</p>
          <div className="bg-red-950/40 p-2 rounded text-red-300 border border-red-500/10 text-[10px]">
            ERR_CONNECTION_TIMED_OUT (30000ms duration limit exceeded)<br />
            API_VERSION: 2026-06-03
          </div>
        </div>
        <div className="text-[10px] text-red-500/70 border-t border-red-500/10 pt-2 flex justify-between font-sans">
          <span>Stripe Integration Bridge</span>
          <span>Retry: count=3 [failed]</span>
        </div>
      </div>
    )
  },
  skipped_step: {
    title: "Skipped Action (Awaiting Previous Dependency)",
    url: "https://store.testflow.ai/checkout/verify",
    contentHtml: (
      <div className="bg-slate-950/30 text-slate-400 p-4 rounded border border-slate-800 font-mono text-xs h-full flex flex-col justify-center items-center text-center">
        <Activity className="w-8 h-8 mb-2 opacity-30 text-slate-500" />
        <div className="font-semibold text-xs text-slate-500">STEP UNEXECUTED</div>
        <p className="text-[10px] text-slate-500 max-w-[200px] mt-1 font-sans">This step was skipped automatically because a preceding verification failed.</p>
      </div>
    )
  },
  api_auth_token: {
    title: "API Gate Token Handshake (JWT Issued)",
    url: "https://api.testflow.ai/v1/auth/token",
    contentHtml: (
      <div className="bg-emerald-950/20 text-emerald-400 p-4 rounded border border-emerald-500/20 font-mono text-xs h-full flex flex-col justify-between">
        <div>
          <div className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded w-max mb-2 font-sans font-medium">HTTP 200 OK</div>
          <p className="font-mono text-[10px] text-emerald-300 break-all leading-tight">
            {"{"} "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIi...JWT_TOKEN_SECRET_VALIDATED" {"}"}
          </p>
        </div>
        <div className="text-[10px] text-emerald-500/60 text-right pt-2 font-sans border-t border-emerald-500/10 mt-2">
          Payload matches expected schema
        </div>
      </div>
    )
  },
  api_user_profile: {
    title: "Account Profile Endpoint Request",
    url: "https://api.testflow.ai/v1/users/profile",
    contentHtml: (
      <div className="bg-slate-900 border border-slate-800 p-4 rounded text-slate-300 font-mono text-[11px] h-full flex flex-col justify-between">
        <div>
          <div className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded w-max mb-2 font-sans font-semibold">HTTP 200 OK</div>
          <pre className="text-slate-300 font-mono leading-tight text-left">
{`{
  "id": "USR-88220",
  "name": "Integration User",
  "status": "active",
  "registered": "2026-06-03"
}`}
          </pre>
        </div>
        <div className="text-[10px] text-slate-500 pt-2 font-sans text-right">
          Verifications passes: 3/3
        </div>
      </div>
    )
  },
  api_billing_history: {
    title: "Billing Records Schema Validation",
    url: "https://api.testflow.ai/v1/billing/history",
    contentHtml: (
      <div className="bg-slate-900 border border-slate-800 p-4 rounded text-slate-300 font-mono text-[11px] h-full flex flex-col justify-between">
        <div>
          <div className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded w-max mb-2 font-sans font-semibold">HTTP 200 OK</div>
          <pre className="text-slate-300 font-mono leading-tight text-left">
{`{
  "invoices": [],
  "limit": 100,
  "total": 0
}`}
          </pre>
        </div>
        <div className="text-[10px] text-slate-500 pt-2 font-sans text-right">
          Assert: IsArray(invoices) is true
        </div>
      </div>
    )
  },
  sheets_auth_granted: {
    title: "Google Consent Handshake (Access Scope Auth)",
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123",
    contentHtml: (
      <div className="bg-emerald-950/20 text-emerald-400 p-4 rounded border border-emerald-500/20 font-mono text-xs h-full flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-emerald-500 font-bold mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            OAUTH CLOUD ACCESS GRANTED
          </div>
          <div className="bg-emerald-950/40 p-2 rounded text-emerald-300 border border-emerald-500/10 text-[10px]">
            SCOPE: sheets.readonly, sheets.write<br />
            PROJECT_ID: gen-lang-client-0842639110
          </div>
        </div>
        <div className="text-[10px] text-emerald-500/60 border-t border-emerald-500/10 pt-2 text-right">
          Authorized Account
        </div>
      </div>
    )
  },
  sheets_sync_success: {
    title: "Spreadsheet Creation Response (ID Sync)",
    url: "https://sheets.googleapis.com/v4/spreadsheets",
    contentHtml: (
      <div className="bg-emerald-950/20 text-emerald-400 p-4 rounded border border-emerald-500/20 font-mono text-xs h-full flex flex-col justify-between">
        <div>
          <div className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded w-max mb-2 font-sans">HTTP 200 OK</div>
          <p className="text-slate-400 text-[10px] font-sans">Spreadsheet initialized successfully:</p>
          <div className="bg-slate-900 p-1.5 rounded text-emerald-300 border border-emerald-500/10 text-[10px] max-w-full truncate font-mono mt-1">
            SpreadsheetID: 1x7W...3J09uW_A
          </div>
        </div>
        <div className="text-[10px] text-emerald-500/60 border-t border-emerald-500/10 pt-2 flex justify-between font-sans">
          <span>Google Sheets v4 API</span>
          <span>Verified!</span>
        </div>
      </div>
    )
  }
};

export default function Reports() {
  const location = useLocation();
  const requestedRunId = new URLSearchParams(location.search).get('runId');
  const requestedReportId = new URLSearchParams(location.search).get('reportId');
  const [reports, setReports] = useState<Report[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [suites, setSuites] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'updated', direction: 'descending' });
  const [updatedFilter, setUpdatedFilter] = useState<TimeFilterValue>({ key: 'all' });
  const aiSearch = useAiSearch('reports');
  const [statusFilter, setStatusFilter] = useUrlState('status', 'All', ['All', 'Passed', 'Failed'] as const);

  // Modal forms
  const [isNewReportModalOpen, setIsNewReportModalOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  
  // Custom Create Report structures
  const [newReportName, setNewReportName] = useState('');
  const [newReportPlan, setNewReportPlan] = useState('');
  const [newReportSuite, setNewReportSuite] = useState('');
  const [newReportRequestedBy, setNewReportRequestedBy] = useState('');
  const [newReportTime, setNewReportTime] = useState('');
  const [newReportStatus, setNewReportStatus] = useState<'Passed' | 'Failed'>('Passed');
  const [newReportFailureReason, setNewReportFailureReason] = useState('');
  const [newReportTargetUrl, setNewReportTargetUrl] = useState('');
  const [newReportFolderId, setNewReportFolderId] = useState('');
  const [newReportSteps, setNewReportSteps] = useState<Step[]>([]);

  // Evidence screenshot lightbox State
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const [lightboxTab, setLightboxTab] = useState<'current' | 'all'>('current');
  const [detailStatusFilter, setDetailStatusFilter] = useState<'all' | 'passed' | 'failed' | 'skipped'>('all');
  const [showInlineScreenshots, setShowInlineScreenshots] = useState(true);
  
  // Active step & screenshot for inline expanded browser mockup
  const [activeStep, setActiveStep] = useState<{ reportId: string; step: Step } | null>(null);
  // The report opened for full step-by-step detail (#9 — list is a summary; click opens detail).
  const [detailReport, setDetailReport] = useState<Report | null>(null);
  // A ?reportId/?runId deep link opens the detail ONCE. The params outlive the modal, so without this
  // latch the 10s refresh below re-opened the report every tick after the user closed it.
  const deepLinkOpened = useRef(false);
  const [renamingReport, setRenamingReport] = useState(false);
  const [reportNameDraft, setReportNameDraft] = useState('');
  const [savingReportName, setSavingReportName] = useState(false);
  const galleryItems = useMemo(() => evidenceGalleryItems(detailReport), [detailReport]);
  const activeGalleryIndex = lightboxKey ? galleryItems.findIndex((item) => item.key === lightboxKey) : -1;
  const activeGalleryItem = activeGalleryIndex >= 0 ? galleryItems[activeGalleryIndex] : null;
  const selectScreenshot = (key: string, tab: 'current' | 'all' = 'current') => {
    setLightboxKey(key);
    setLightboxTab(tab);
  };

  const stepCounts = (rep: Report) => {
    const steps = (rep.steps || []).filter((step) => !/^(not run|untested|paused)$/i.test(String(step.outcome || '')));
    return {
      passed: steps.filter((s) => /pass/i.test(String(s.outcome || ''))).length,
      failed: steps.filter((s) => /fail/i.test(String(s.outcome || ''))).length,
      total: steps.length,
    };
  };

  const handleShareReport = async (reportId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('reportId', reportId);
    url.hash = '';
    try { await navigator.clipboard?.writeText(url.toString()); await showConfirm('Report link copied to clipboard.'); }
    catch { /* clipboard unavailable */ }
  };

  // Only the name is editable — everything else in a report is execution evidence.
  const saveReportName = async () => {
    const name = reportNameDraft.trim();
    if (!detailReport || savingReportName) return;
    if (!name || name === detailReport.name) { setRenamingReport(false); return; }
    setSavingReportName(true);
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(detailReport.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not rename this report.');
      setDetailReport((current) => current ? { ...current, name } : current);
      setReports((current) => current.map((report) => report.id === detailReport.id ? { ...report, name } : report));
      setRenamingReport(false);
    } catch (error: any) {
      await showConfirm(error?.message || 'Could not rename this report.');
    } finally {
      setSavingReportName(false);
    }
  };

  const reportExportContext = async (report: Report): Promise<ReportContext> => {
    let run: any;
    let results: any[] = [];
    if (report.runId) {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(report.runId)}/results`);
        if (response.ok) ({ run, results = [] } = await response.json());
      } catch (error) {
        console.error('Unable to load linked run details for report export.', error);
      }
    }
    const plan = plans.find((item: any) => String(item.id) === String(report.planId || run?.testPlanId));
    return { run, results, plan, cases, suites };
  };

  const handleDetailedReportExport = async (report: Report, format: 'html' | 'md' | 'pdf') => {
    const context = await reportExportContext(report);
    if (format === 'html') return downloadFile(toReportHTML(report, context), `report-${report.id}.html`, 'text/html;charset=utf-8');
    if (format === 'md') return downloadFile(toReportMarkdown(report, context), `report-${report.id}.md`, 'text/markdown;charset=utf-8');
    printReportPDF(report, context);
  };

  const fetchReports = (showLoading = true) => {
    if (showLoading) setLoading(true);
    fetch('/api/reports')
      .then(r => r.json())
      .then(data => {
        const nextReports = Array.isArray(data) ? data : [];
        setReports(nextReports);
        setSelectedReport((current) => current
          ? nextReports.find((report) => report.id === current.id) || null
          : nextReports[0] || null);
        // Resolve the deep link OUTSIDE the state updater: React invokes updaters twice in StrictMode,
        // so latching the ref in there consumed the link on the first pass and returned null on the second.
        const requested = !deepLinkOpened.current && (requestedReportId || requestedRunId)
          ? nextReports.find((report) =>
              (requestedReportId && report.id === requestedReportId) || (requestedRunId && report.runId === requestedRunId))
          : undefined;
        if (requested) deepLinkOpened.current = true;
        setDetailReport((current) => {
          // Re-resolve whatever is already open so a refresh keeps its latest data.
          if (current) return nextReports.find((report) => report.id === current.id) || null;
          return requested || null;
        });
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  };

  const fetchDataConfigs = () => {
    const load = (url: string) => fetch(url).then((response) => response.json()).then((data) => Array.isArray(data) ? data : []);
    void Promise.all([load('/api/plans'), load('/api/runs'), load('/api/cases'), load('/api/suites'), load('/api/folders')])
      .then(([nextPlans, nextRuns, nextCases, nextSuites, nextFolders]) => {
        setPlans(nextPlans);
        setRuns(nextRuns);
        setCases(nextCases);
        setSuites(nextSuites);
        setFolders(nextFolders);
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchReports();
    fetchDataConfigs();
    const refresh = () => {
      if (!document.hidden) fetchReports(false);
    };
    const interval = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const handleCreateReport = () => {
    if (!newReportName.trim() || !newReportSteps.length) return;

    const reportPayload = {
      name: newReportName,
      planName: newReportPlan,
      suiteName: newReportSuite,
      requestedBy: newReportRequestedBy,
      executionTime: newReportTime,
      totalExecutions: newReportSteps.length,
      status: newReportStatus,
      failureReason: newReportStatus === 'Failed' ? newReportFailureReason : '',
      targetUrl: newReportTargetUrl,
      folderId: newReportFolderId,
      steps: newReportSteps
    };

    fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportPayload)
    })
      .then(r => r.json())
      .then(rsp => {
        if (rsp.success) {
          setIsNewReportModalOpen(false);
          fetchReports();
          // Reset form fields
          setNewReportName('');
          setNewReportPlan('');
          setNewReportSuite('');
          setNewReportStatus('Passed');
          setNewReportFailureReason('');
          setNewReportTargetUrl('');
          setNewReportFolderId('');
          setNewReportSteps([]);
        }
      })
      .catch(console.error);
  };

  const bulk = useBulkDelete('reports', () => { setSelectedReport(null); fetchReports(); }, 'report');

  const handleDeleteReport = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (await showConfirm('Are you sure you want to delete this test report entry?', { tone: 'danger' })) {
      fetch(`/api/reports/${id}`, { method: 'DELETE' })
        .then(() => {
          if (selectedReport?.id === id) {
            setSelectedReport(null);
          }
          fetchReports();
        })
        .catch(console.error);
    }
  };

  const addFormStep = () => {
    const nextIdx = (newReportSteps.length + 1).toString();
    setNewReportSteps([...newReportSteps, {
      step: nextIdx,
      action: '',
      expected: '',
      outcome: 'Pass',
      reason: '',
      screenshot: ''
    }]);
  };

  const updateFormStep = (index: number, updatedFields: Partial<Step>) => {
    const stepsCopy = [...newReportSteps];
    stepsCopy[index] = { ...stepsCopy[index], ...updatedFields };
    setNewReportSteps(stepsCopy);
  };

  const removeFormStep = (index: number) => {
    const filtered = newReportSteps.filter((_, i) => i !== index);
    // re-index steps
    const reindexed = filtered.map((st, i) => ({ ...st, step: (i + 1).toString() }));
    setNewReportSteps(reindexed);
  };

  const filteredReports: any[] = reports.filter(r => {
    const matchesSearch = aiSearch.isAiQuery(searchTerm)
      ? (aiSearch.matchedIds ? aiSearch.matchedIds.has(r.id) : true)
      : (r.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          r.planName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          r.suiteName?.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = statusFilter === 'All' || r.status === statusFilter;
    const matchesUpdated = passesTimeFilter(r.metadata?.updatedAt || r.updatedAt || r.date, updatedFilter);
    return matchesSearch && matchesStatus && matchesUpdated;
  });
  const runById = useMemo(() => new Map(runs.map((run) => [String(run.id), run])), [runs]);
  const reportMetricsById = useMemo(() => new Map(reports.map((report) => [report.id, reportMetrics(report, {
    run: runById.get(String(report.runId || '')),
    cases,
  })])), [reports, runById, cases]);
  const sortedReports = sortRows(filteredReports, sort, {
    id: (report) => report.id,
    runId: (report) => report.runId,
    scenario: (report) => report.name,
    type: (report) => reportTypeLabel(report, { run: runById.get(String(report.runId || '')), cases }),
    result: (report) => { const count = stepCounts(report); return `${count.passed}/${count.failed}`; },
    duration: (report) => report.executionTime,
    status: (report) => report.status,
    updated: (report) => report.metadata?.updatedAt || report.updatedAt || report.date,
  });
  const totalReportCases = filteredReports.reduce((total, report) => total + (reportMetricsById.get(report.id)?.caseCount || 0), 0);
  const totalReportSteps = filteredReports.reduce((total, report) => total + (reportMetricsById.get(report.id)?.stepCount || 0), 0);
  const passedReportSteps = filteredReports.reduce((total, report) => {
    const steps = report.steps || [];
    if (steps.length > 0) return total + steps.filter(step => /pass/i.test(String(step.outcome || ''))).length;
    return total + (report.status === 'Passed' ? (report.totalExecutions || 0) : 0);
  }, 0);
  const failedReportSteps = filteredReports.reduce((total, report) => {
    const steps = report.steps || [];
    if (steps.length > 0) return total + steps.filter(step => /fail/i.test(String(step.outcome || ''))).length;
    return total + (report.status === 'Failed' ? 1 : 0);
  }, 0);
  return (
    <div className="flex h-full min-h-0 w-full flex-col px-4 pb-4">
      {/* Header Info */}
      <div className="flex items-center justify-between mb-5 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">Test Reports</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Audit verification results, step checklists, and screenshot evidence payloads.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            filename="test-reports"
            title="Test Reports"
            formats={['csv', 'json', 'md', 'pdf']}
            rows={sortedReports}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'runId', label: 'Run ID' },
              { key: 'name', label: 'Name' },
              { key: 'type', label: 'Type', get: (r) => reportTypeLabel(r, { run: runById.get(String(r.runId || '')), cases }) },
              { key: 'status', label: 'Status' },
              { key: 'planName', label: 'Plan' },
              { key: 'suiteName', label: 'Suite' },
              { key: 'requestedBy', label: 'Requested By' },
              { key: 'executionTime', label: 'Execution Time' },
              { key: 'caseCount', label: 'Executed Cases', get: (r) => reportMetricsById.get(r.id)?.caseCount || 0 },
              { key: 'stepCount', label: 'Executed Steps', get: (r) => reportMetricsById.get(r.id)?.stepCount || 0 },
              { key: 'failureReason', label: 'Failure Reason' },
              { key: 'date', label: 'Date' },
              { key: 'updatedAt', label: 'Updated', get: (r: any) => r.metadata?.updatedAt || r.updatedAt || '' },
              { key: 'updatedBy', label: 'Updated By', get: (r: any) => r.metadata?.updatedBy?.name || '' },
              { key: 'createdAt', label: 'Created', get: (r: any) => r.metadata?.createdAt || r.createdAt || '' },
            ]}
          />
          <button onClick={() => setIsNewReportModalOpen(true)} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Log Manual Report
          </button>
        </div>
      </div>

      {/* Main Widescreen Interface as requested by 2nd image */}
      <div className="flex-1 min-h-0 flex flex-col bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-sm overflow-hidden mb-2">
        
        {/* Statistics Executive Summary Row */}
        <div className="p-5 border-b border-[var(--border)] bg-[var(--bg-secondary)]/30 grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] p-3 rounded-lg shadow-inner">
            <span className="block text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Executed Cases</span>
            <span className="block text-xs font-semibold text-[var(--text-primary)] mt-1">
              {totalReportCases} Test Cases
            </span>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] p-3 rounded-lg shadow-inner">
            <span className="block text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Executed Steps</span>
            <span className="block text-xs font-semibold text-[var(--text-primary)] mt-1">
              {totalReportSteps} Verification Steps
            </span>
          </div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] p-3 rounded-lg shadow-inner">
            <span className="block text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Combined Summary Metric</span>
            <span className="block text-xs font-semibold mt-1 flex items-center gap-2">
              <span className="text-emerald-500 font-bold">{passedReportSteps} Passed</span>
              <span className="text-slate-400 font-bold">•</span>
              <span className="text-red-500 font-bold">{failedReportSteps} Failed</span>
            </span>
          </div>
        </div>

        {/* Filter controls */}
        <div className="flex items-center gap-3 overflow-x-auto border-b border-[var(--border)] p-4">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input 
                type="text" 
                value={searchTerm}
                onChange={(e) => {
                  const v = e.target.value;
                  setSearchTerm(v);
                  if (aiSearch.isAiQuery(v)) aiSearch.run(v, reports.map((r) => ({ id: r.id, name: r.name, planName: r.planName, suiteName: r.suiteName, status: r.status })));
                  else aiSearch.reset();
                }}
                placeholder="Search reports or @ai"
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-9 pr-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] placeholder-[var(--text-muted)] transition-colors"
              />
            </div>
            <TimeRangeFilter value={updatedFilter} onChange={setUpdatedFilter} className="shrink-0" />
            <div className="flex shrink-0 bg-[var(--bg-secondary)] p-1 rounded-md text-xs border border-[var(--border)]">
              {(['All', 'Passed', 'Failed'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setStatusFilter(tab)}
                  className={cn(
                    "py-1 px-3 rounded text-center font-medium transition-colors",
                    statusFilter === tab 
                      ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm font-semibold"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
          {bulk.selectedCount > 0 ? (
            <button onClick={bulk.deleteSelected} disabled={bulk.busy} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50">
              <Trash2 className="w-4 h-4" /> Delete Selected ({bulk.selectedCount})
            </button>
          ) : (
            <div className="ml-auto shrink-0 whitespace-nowrap font-mono text-xs text-slate-500">
              Click <strong className="text-slate-600 dark:text-slate-300">Evidence</strong> to view screenshots
            </div>
          )}
        </div>

        {/* Main Table Styled search similar to Image 2 */}
        <div className="flex-1 min-h-0 w-full overflow-x-auto overflow-y-auto rounded-b-xl">
          <table className="w-full min-w-[1040px] table-fixed border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)] text-[var(--text-muted)] text-[11px] uppercase tracking-wider font-semibold border-b border-[var(--border)]">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" checked={bulk.allSelected(sortedReports.map((r) => r.id))} onChange={() => bulk.toggleAll(sortedReports.map((r) => r.id))} />
                </th>
                <SortableHeader label="ID" column="id" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-24 px-4 py-3" />
                <SortableHeader label="Run ID" column="runId" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3" />
                <SortableHeader label="Test Scenario" column="scenario" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-72 px-4 py-3" />
                <SortableHeader label="Type" column="type" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3" />
                <SortableHeader label="Pass / Fail" column="result" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-32 px-4 py-3" />
                <SortableHeader label="Duration" column="duration" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3" />
                <SortableHeader label="Status" column="status" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-28 px-4 py-3" />
                <SortableHeader label="Updated" column="updated" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="w-32 px-4 py-3" />
                <th className="w-14 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filteredReports.length === 0 ? (
                <tr><td colSpan={10} className="py-12 px-4 text-center text-sm text-[var(--text-muted)]">No test reports found.</td></tr>
              ) : sortedReports.map((r) => {
                const c = stepCounts(r);
                const type = reportTypeLabel(r, { run: runById.get(String(r.runId || '')), cases });
                return (
                  <tr key={r.id} onClick={() => setDetailReport(r)} className="cursor-pointer align-top hover:bg-[var(--bg-secondary)]/40 transition-colors">
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulk.isSelected(r.id)} onChange={() => bulk.toggle(r.id)} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{r.id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{r.runId || '—'}</td>
                    <td className="min-w-0 px-4 py-3 [overflow-wrap:anywhere]">
                      <div className="whitespace-normal break-words font-semibold leading-5 text-[var(--text-primary)]">{r.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]"><FolderBadge folders={folders} folderId={r.folderId} />{r.planName ? <span>· {r.planName}</span> : null}<span>· {r.date}</span></div>
                    </td>
                    <td className="px-4 py-3"><span className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)]">{type}</span></td>
                    <td className="px-4 py-3 text-xs"><span className="font-semibold text-emerald-500">{c.passed}</span> / <span className={c.failed ? 'font-semibold text-red-500' : 'text-[var(--text-muted)]'}>{c.failed}</span></td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{r.executionTime && r.executionTime !== 'Generated' ? r.executionTime : '—'}</td>
                    <td className="px-4 py-3"><span className={cn('inline-flex rounded border px-2 py-0.5 text-[11px] font-bold', r.status === 'Passed' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : r.status === 'Failed' ? 'border-red-500/20 bg-red-500/10 text-red-500' : 'border-slate-500/20 bg-slate-500/10 text-slate-400')}>{r.status}</span></td>
                    <td className="overflow-hidden px-4 py-3 whitespace-nowrap text-xs text-[var(--text-muted)]">
                      <Timestamp value={r.metadata?.updatedAt || r.updatedAt || r.date} />
                      {actorName(r.metadata?.updatedBy) && <div className="truncate text-[10px]" title={`by ${actorName(r.metadata?.updatedBy)}`}>by {actorName(r.metadata?.updatedBy)}</div>}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><button onClick={(e) => handleDeleteReport(r.id, e)} title="Delete report" className="rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Report detail — full step-by-step + evidence + Download/Share (the list is a summary now). */}
      <Modal isOpen={!!detailReport} onClose={() => { setDetailReport(null); setRenamingReport(false); }} size="report"
        title={renamingReport ? (
          <span className="flex items-center gap-2">
            <label htmlFor="report-name" className="sr-only">Report name</label>
            <input
              id="report-name"
              autoFocus
              value={reportNameDraft}
              onChange={(event) => setReportNameDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveReportName(); if (event.key === 'Escape') setRenamingReport(false); }}
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-base font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <button type="button" onClick={() => void saveReportName()} disabled={savingReportName || !reportNameDraft.trim()} aria-label="Save report name" title="Save report name" className="shrink-0 rounded-md p-1.5 text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"><Check className="h-4 w-4" /></button>
            <button type="button" onClick={() => setRenamingReport(false)} aria-label="Cancel rename" title="Cancel rename" className="shrink-0 rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]"><X className="h-4 w-4" /></button>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{detailReport?.name || 'Report'}</span>
            <button
              type="button"
              onClick={() => { setReportNameDraft(detailReport?.name || ''); setRenamingReport(true); }}
              aria-label="Rename report"
              title="Rename report"
              className="shrink-0 rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]"
            ><Pencil className="h-4 w-4" /></button>
          </span>
        )}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="text-xs text-[var(--text-muted)]">Requested By {detailReport?.requestedBy || '—'} · {detailReport?.executionTime && detailReport.executionTime !== 'Generated' ? detailReport.executionTime : '—'} · {detailReport?.date}</div>
            <div className="flex gap-2">
              <button onClick={() => detailReport && handleShareReport(detailReport.id)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:border-[var(--accent)]"><ExternalLink className="h-4 w-4" /> Share</button>
              {detailReport && (
                <ExportMenu
                  label="Export"
                  dropUp
                  filename={`report-${detailReport.id}`}
                  title={detailReport.name}
                  formats={['csv', 'json']}
                  extraItems={[
                    { label: 'HTML Report (.html)', onClick: () => void handleDetailedReportExport(detailReport, 'html') },
                    { label: 'Markdown Report (.md)', onClick: () => void handleDetailedReportExport(detailReport, 'md') },
                    { label: 'PDF (.pdf)', onClick: () => void handleDetailedReportExport(detailReport, 'pdf') },
                  ]}
                  rows={(detailReport.steps || []).map((step, index) => ({
                    ...step,
                    evidence: stepEvidence(detailReport, step, index) ? evidenceImageSource(stepEvidence(detailReport, step, index)) : '',
                  }))}
                  columns={[
                    { key: 'step', label: '#' },
                    { key: 'action', label: 'Test Step' },
                    { key: 'expected', label: 'Expected Result' },
                    { key: 'actual', label: 'Actual Result' },
                    { key: 'outcome', label: 'Outcome' },
                    { key: 'reason', label: 'Reason' },
                    { key: 'evidence', label: 'Evidence', kind: 'image' },
                  ]}
                />
              )}
            </div>
          </div>
        }>
        {detailReport && (() => {
          return <DetailedReportView
            report={detailReport}
            jobId={String(runs.find((run: any) => String(run.id) === String(detailReport.runId))?.triggerMeta?.automationJobId || '')}
            context={{ run: runById.get(String(detailReport.runId || '')), cases, suites }}
            evidenceFor={(step, index) => stepEvidence(detailReport, step as Step, index)}
            onViewEvidence={selectScreenshot}
          />;
          const c = stepCounts(detailReport);
          const steps = detailReport.steps || [];
          const kind = (step: Step) => /pass/i.test(step.outcome) ? 'passed' : /fail/i.test(step.outcome) ? 'failed' : 'skipped';
          const counts = { all: steps.length, passed: steps.filter((s) => kind(s) === 'passed').length, failed: steps.filter((s) => kind(s) === 'failed').length, skipped: steps.filter((s) => kind(s) === 'skipped').length };
          const visibleSteps = detailStatusFilter === 'all' ? steps : steps.filter((step) => kind(step) === detailStatusFilter);
          return <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
            <aside className="lg:sticky lg:top-4 lg:self-start"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">{(['all', 'passed', 'failed', 'skipped'] as const).map((value) => <button key={value} type="button" onClick={() => setDetailStatusFilter(value)} className={cn('rounded-lg border p-3 text-left', detailStatusFilter === value ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--bg-secondary)]')}><div className={cn('text-xl font-bold', value === 'passed' ? 'text-emerald-500' : value === 'failed' ? 'text-red-500' : value === 'skipped' ? 'text-amber-500' : 'text-[var(--text-primary)]')}>{counts[value]}</div><div className="mt-1 text-xs capitalize text-[var(--text-muted)]">{value === 'all' ? 'All checks' : value}</div></button>)}</div></aside>
            <main className="min-w-0 space-y-6"><header className="border-b border-[var(--border)] pb-5"><h2 className="text-xl font-bold text-[var(--text-primary)]">QA Automation Report</h2><p className="mt-1 text-sm text-[var(--text-muted)]">{detailReport.name}{detailReport.suiteName ? ` · ${detailReport.suiteName}` : ''}</p></header><div className="overflow-hidden rounded-lg border border-[var(--border)]"><dl className="grid text-sm sm:grid-cols-[170px_1fr] [&>dt]:border-b [&>dt]:border-[var(--border)] [&>dt]:bg-[var(--bg-secondary)] [&>dt]:px-4 [&>dt]:py-3 [&>dt]:font-semibold [&>dd]:border-b [&>dd]:border-[var(--border)] [&>dd]:px-4 [&>dd]:py-3 [&>dd]:text-[var(--text-muted)]"><dt>Run date</dt><dd><Timestamp value={detailReport.date} /></dd><dt>Total execution time</dt><dd>{detailReport.executionTime || '—'}</dd><dt>Requested by</dt><dd>{detailReport.requestedBy || '—'}</dd>{detailReport.planName && <><dt>Test plan</dt><dd>{detailReport.planName}</dd></>}{detailReport.targetUrl && <><dt>App URL</dt><dd><a className="text-[var(--accent)] hover:underline" href={detailReport.targetUrl} target="_blank" rel="noreferrer">{detailReport.targetUrl}</a></dd></>}</dl></div><div className="flex h-2 overflow-hidden rounded-full bg-[var(--bg-secondary)]"><span className="bg-emerald-500" style={{ width: `${counts.all ? counts.passed / counts.all * 100 : 0}%` }} /><span className="bg-red-500" style={{ width: `${counts.all ? counts.failed / counts.all * 100 : 0}%` }} /><span className="bg-amber-500" style={{ width: `${counts.all ? counts.skipped / counts.all * 100 : 0}%` }} /></div><section><h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Overview</h3><div className="rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/10 p-4 text-sm text-[var(--text-primary)]">Out of <b>{counts.all} checks</b>, <b>{counts.passed} passed</b>{counts.failed ? ` and ${counts.failed} failed` : ''}{counts.skipped ? `; ${counts.skipped} skipped` : ''}.</div></section><section><h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Test Results</h3><div className="space-y-2">{visibleSteps.map((step, index) => { const status = kind(step); const evidence = stepEvidence(detailReport, step, index); return <details key={index} className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]"><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-[var(--bg-primary)]"><span className={cn('h-2.5 w-2.5 rounded-full', status === 'passed' ? 'bg-emerald-500' : status === 'failed' ? 'bg-red-500' : 'bg-amber-500')} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--text-primary)]">{step.testCaseTitle || step.action || `Step ${index + 1}`}</div>{step.testCaseTitle && <div className="truncate text-xs text-[var(--text-muted)]">{step.action}</div>}</div><span className={cn('rounded px-2 py-0.5 text-[10px] font-bold uppercase', status === 'passed' ? 'bg-emerald-500/10 text-emerald-500' : status === 'failed' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500')}>{step.outcome}</span></summary><div className="border-t border-[var(--border)] p-4 text-sm"><b>Expected:</b> <span className="text-[var(--text-muted)]">{step.expected || '—'}</span>{(step.actual || step.reason) && <div className="mt-3 rounded bg-red-500/10 p-3 text-red-400"><b>Actual:</b> {step.actual || step.reason}</div>}{evidence && <button onClick={() => selectScreenshot(evidence)} className="mt-3 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--accent)]">View evidence</button>}</div></details>; })}{!visibleSteps.length && <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">No checks match this filter.</div>}</div></section></main>
          </div>;
          return (
            <div id={`row-container-${detailReport.id}`} className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={cn('inline-flex rounded border px-2 py-0.5 text-xs font-bold', detailReport.status === 'Passed' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : detailReport.status === 'Failed' ? 'border-red-500/20 bg-red-500/10 text-red-500' : 'border-slate-500/20 bg-slate-500/10 text-slate-400')}>{detailReport.status}</span>
                <span className="text-[var(--text-muted)]"><span className="font-semibold text-emerald-500">{c.passed}</span> passed · <span className={c.failed ? 'font-semibold text-red-500' : ''}>{c.failed}</span> failed · {c.total} steps</span>
                {detailReport.planName && <span className="text-[var(--text-muted)]">· Plan: {detailReport.planName}</span>}
                {detailReport.suiteName && <span className="text-[var(--text-muted)]">· Suite: {detailReport.suiteName}</span>}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Requested By</span>
                  <span className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><User className="h-3.5 w-3.5 text-[var(--accent)]" />{detailReport.requestedBy || '—'}</span>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Overall Execution Duration</span>
                  <span className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]"><Clock className="h-3.5 w-3.5 text-blue-500" />{detailReport.executionTime && detailReport.executionTime !== 'Generated' ? detailReport.executionTime : '—'}</span>
                </div>
              </div>
              {detailReport.failureReason && (
                <div className="whitespace-pre-wrap rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{detailReport.failureReason}</div>
              )}
              <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-[var(--bg-secondary)] text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    <tr><th className="w-10 px-3 py-2">#</th><th className="px-3 py-2">Test Case / Step</th><th className="px-3 py-2">Expected Result</th><th className="px-3 py-2">Actual Result / Failure</th><th className="w-24 px-3 py-2">Outcome</th><th className="w-24 px-3 py-2">Evidence</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {(detailReport.steps || []).map((s, i) => (
                      <tr key={i} className="align-top">
                        <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{i + 1}</td>
                        <td className="px-3 py-2 text-[var(--text-primary)]">{s.testCaseTitle && <div className="mb-1 text-xs font-semibold text-[var(--accent)]">{s.testCaseTitle}</div>}{s.action}</td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">{s.expected}</td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">{s.actual || s.reason || '—'}</td>
                        <td className="px-3 py-2"><span className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold', /pass/i.test(String(s.outcome)) ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : /fail/i.test(String(s.outcome)) ? 'border-red-500/20 bg-red-500/10 text-red-500' : 'border-slate-500/20 bg-slate-500/10 text-slate-400')}>{s.outcome || '—'}</span></td>
                        <td className="px-3 py-2">{stepEvidence(detailReport, s, i) ? <button onClick={() => selectScreenshot(stepEvidence(detailReport, s, i))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--accent)] hover:border-[var(--accent)]">View</button> : <span className="text-xs text-[var(--text-muted)]">Not Captured</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Lightbox Modal for Screenshots Evidence */}
      {lightboxKey && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center z-50 p-6" onClick={() => setLightboxKey(null)}>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl w-full max-w-[95vw] sm:max-w-3xl max-h-[90dvh] overflow-hidden shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Browser chrome header bar simulation */}
            <div className="bg-[var(--bg-secondary)] px-4 py-3 border-b border-[var(--border)] flex flex-shrink-0 items-center justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-red-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-yellow-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-emerald-500/80"></span>
                <span className="ml-4 font-mono text-xs text-[var(--text-muted)] font-medium max-w-md truncate bg-[var(--bg-primary)] px-3 py-1 rounded shadow-inner border border-[var(--border)]">
                   {SCREENSHOT_PRESETS[lightboxKey]?.url || lightboxKey}
                </span>
              </div>
              <button onClick={() => setLightboxKey(null)} className="text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded">
                Close View [ESC]
              </button>
            </div>
            <div className="flex shrink-0 gap-1 border-b border-[var(--border)] bg-[var(--bg-card)] px-4 pt-2">
              <button type="button" onClick={() => setLightboxTab('current')} className={cn('border-b-2 px-3 py-2 text-xs font-semibold transition-colors', lightboxTab === 'current' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>Current Screenshot</button>
              <button type="button" onClick={() => setLightboxTab('all')} className={cn('border-b-2 px-3 py-2 text-xs font-semibold transition-colors', lightboxTab === 'all' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>All Screenshots ({galleryItems.length || 1})</button>
            </div>
            {/* Browser body canvas content context */}
            <div className="p-0 bg-slate-900 overflow-auto flex-1 min-h-0">
              {lightboxTab === 'all' ? (
                <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                  {(galleryItems.length ? galleryItems : [{ key: lightboxKey, title: 'Current Screenshot' }]).map((item, index) => (
                    <button key={`${item.key}-${index}`} type="button" onClick={() => selectScreenshot(item.key)} className={cn('overflow-hidden rounded-lg border text-left transition-colors', item.key === lightboxKey ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--accent)]')}>
                      <img src={evidenceImageSource(item.key)} alt={item.title} className="h-40 w-full bg-black object-cover" referrerPolicy="no-referrer" />
                      <span className="block truncate bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)]">{item.title}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <img
                    src={evidenceImageSource(lightboxKey)}
                    alt={activeGalleryItem?.title || SCREENSHOT_PRESETS[lightboxKey]?.title || `Captured URL View: ${lightboxKey}`}
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.src = "https://images.unsplash.com/photo-1541560052-5e137f229371?w=1280&q=80";
                    }}
                  />
                </div>
              )}
            </div>
            {/* Footer labels */}
            <div className="bg-[var(--bg-secondary)] px-5 py-3.5 border-t border-[var(--border)] flex justify-between items-center text-xs">
              <button type="button" onClick={() => activeGalleryIndex > 0 && selectScreenshot(galleryItems[activeGalleryIndex - 1].key)} disabled={activeGalleryIndex <= 0} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-semibold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40">← Previous</button>
              <span className="min-w-0 flex-1 truncate px-3 text-center font-bold text-[var(--text-primary)]">{activeGalleryItem?.title || SCREENSHOT_PRESETS[lightboxKey]?.title || `Automated live capture of ${lightboxKey}`}{activeGalleryIndex >= 0 && ` (${activeGalleryIndex + 1}/${galleryItems.length})`}</span>
              <button type="button" onClick={() => activeGalleryIndex >= 0 && activeGalleryIndex < galleryItems.length - 1 && selectScreenshot(galleryItems[activeGalleryIndex + 1].key)} disabled={activeGalleryIndex < 0 || activeGalleryIndex >= galleryItems.length - 1} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-semibold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40">Next →</button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Report Modal Layout */}
      <Modal
        isOpen={isNewReportModalOpen}
        onClose={() => setIsNewReportModalOpen(false)}
        title="Log Manual Run Audit Report"
        footer={
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setIsNewReportModalOpen(false)} className="px-4 py-2 border border-[var(--border)] text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-all">
               Cancel
            </button>
            <button
              type="button"
              onClick={handleCreateReport}
              disabled={!newReportName.trim() || !newReportSteps.length}
              className="px-4 py-2 bg-[var(--accent)] text-white text-xs font-semibold rounded hover:bg-[var(--accent-hover)] transition-all disabled:opacity-50"
            >
               Save Verification Report
            </button>
          </div>
        }
      >
        <div className="space-y-4 text-left">
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Report / Run Name<RequiredMark /></label>
                <input 
                  type="text" 
                  value={newReportName} 
                  onChange={(e) => setNewReportName(e.target.value)} 
                  placeholder="e.g. Master Branch Deployment Verification" 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Execution Duration</label>
                <input 
                  type="text" 
                  value={newReportTime} 
                  onChange={(e) => setNewReportTime(e.target.value)} 
                  placeholder="e.g. 1m 45s" 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Testing Plan Context</label>
                <select 
                  value={newReportPlan} 
                  onChange={(e) => setNewReportPlan(e.target.value)} 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                >
                  <option value="">-- Choose Plan Scope --</option>
                  {plans.map(p => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Execution Category</label>
                <select 
                  value={newReportSuite} 
                  onChange={(e) => setNewReportSuite(e.target.value)} 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                >
                  <option value="">-- Choose Category --</option>
                  {TESTING_TYPES.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
             </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Requested By</label>
                <input 
                  type="text" 
                  value={newReportRequestedBy} 
                  onChange={(e) => setNewReportRequestedBy(e.target.value)} 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                />
             </div>
             <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Overall Status</label>
                <select 
                  value={newReportStatus} 
                  onChange={(e) => setNewReportStatus(e.target.value as any)} 
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                >
                  <option value="Passed">Passed</option>
                  <option value="Failed">Failed</option>
                </select>
             </div>
          </div>

          <FolderSelect
            value={newReportFolderId}
            onChange={setNewReportFolderId}
          />

          <div>
             <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Target URL to Test (Real-Time Screenshot Engine Target)</label>
             <input 
               type="url" 
               value={newReportTargetUrl} 
               onChange={(e) => setNewReportTargetUrl(e.target.value)} 
               placeholder="e.g. https://google.com or https://example.com" 
               className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
             />
          </div>

          {newReportStatus === 'Failed' && (
            <div>
               <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Overall Failure Description</label>
               <input 
                 type="text" 
                 value={newReportFailureReason} 
                 onChange={(e) => setNewReportFailureReason(e.target.value)} 
                 placeholder="e.g. Expected outcome match failed on stage checkout iframe load" 
                 className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
               />
            </div>
          )}

          <div className="border-t border-[var(--border)] pt-4 mt-2">
             <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase text-[var(--text-muted)] tracking-wider">Verification Steps ({newReportSteps.length})<RequiredMark /></span>
                <button type="button" onClick={addFormStep} className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Append Step
                </button>
             </div>

             <div className="space-y-4 max-h-[30vh] overflow-y-auto pr-1">
                {newReportSteps.length === 0 && <p className="rounded border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--text-muted)]">Add at least one verification step before saving.</p>}
                {newReportSteps.map((st, i) => (
                  <div key={i} className="p-3 rounded bg-[var(--bg-secondary)] border border-[var(--border)] relative space-y-3 text-left">
                     <button type="button" onClick={() => removeFormStep(i)} className="absolute top-2 right-2 text-[var(--text-muted)] hover:text-red-500 transition-colors p-1" title="Remove Step">
                        <Trash2 className="w-3.5 h-3.5" />
                     </button>
                     <span className="inline-block text-[10px] font-mono font-bold bg-[var(--bg-primary)] px-2 py-0.5 rounded border border-[var(--border)]">Step {st.step}</span>
                     
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                           <label className="block text-[11px] font-medium text-[var(--text-muted)] pb-1">Action / Input Details</label>
                           <input 
                             type="text" 
                             value={st.action} 
                             onChange={(e) => updateFormStep(i, { action: e.target.value })} 
                             placeholder="e.g. Select payment and submit form"
                             className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                           />
                        </div>
                        <div>
                           <label className="block text-[11px] font-medium text-[var(--text-muted)] pb-1">Expected Outcome</label>
                           <input 
                             type="text" 
                             value={st.expected} 
                             onChange={(e) => updateFormStep(i, { expected: e.target.value })} 
                             placeholder="e.g. Form displays 200 OK success toast"
                             className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                           />
                        </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                           <label className="block text-[11px] font-medium text-[var(--text-muted)] pb-1">Step Outcome</label>
                            <select 
                              value={st.outcome} 
                              onChange={(e) => updateFormStep(i, { outcome: e.target.value as any })} 
                              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                            >
                              <option value="Pass">Pass</option>
                              <option value="Fail">Fail</option>
                              <option value="Skipped">Skipped</option>
                            </select>
                        </div>
                        <div>
                           <label className="block text-[11px] font-medium text-[var(--text-muted)] pb-1">Evidence URL or Path</label>
                           <input
                             type="text"
                             value={st.screenshot} 
                             onChange={(e) => updateFormStep(i, { screenshot: e.target.value })} 
                             placeholder="Enter screenshot URL or path"
                             className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                           />
                        </div>
                        <div>
                           <label className="block text-[11px] font-medium text-[var(--text-muted)] pb-1">Outcome Detail (Optional)</label>
                           <input 
                             type="text" 
                             value={st.reason || ''} 
                             onChange={(e) => updateFormStep(i, { reason: e.target.value })} 
                             placeholder="Reason of error/warning"
                             className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]" 
                           />
                        </div>
                     </div>
                  </div>
                ))}
             </div>
          </div>

        </div>
      </Modal>

    </div>
  );
}



