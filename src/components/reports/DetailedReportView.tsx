import { Check, ChevronRight, CircleMinus, Copy, FileText, Image, MapPin, Video, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { reportTags, type ReportContext } from '@/src/lib/exportData';
import './DetailedReportView.css';

type Outcome = 'passed' | 'failed' | 'skipped';

export interface DetailedReportStep {
  step?: string;
  action?: string;
  expected?: string;
  outcome?: string;
  reason?: string;
  actual?: string;
  durationMs?: number;
  testCaseTitle?: string;
  testCaseId?: string;
  screenshot?: string;
  file?: string;
  template?: string;
  tags?: string[];
}

export interface DetailedReportData {
  id: string;
  runId?: string;
  name: string;
  planName?: string;
  suiteName?: string;
  requestedBy?: string;
  executionTime?: string;
  targetUrl?: string;
  date?: string;
  failureReason?: string;
  steps?: DetailedReportStep[];
  tags?: string[];
  environment?: string;
  browser?: string;
  metadata?: Record<string, any>;
}

interface TestGroup {
  key: string;
  title: string;
  caseId: string;
  file: string;
  steps: Array<DetailedReportStep & { sourceIndex: number }>;
  outcome: Outcome;
  durationMs: number;
}

const outcomeOf = (value: unknown): Outcome => /fail|block/i.test(String(value || '')) ? 'failed' : /pass/i.test(String(value || '')) ? 'passed' : 'skipped';
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
const duration = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s` : ms > 0 ? `${Math.round(ms / 100) / 10}s` : '—';

function groupTests(report: DetailedReportData): TestGroup[] {
  const groups = new Map<string, TestGroup>();
  (report.steps || []).forEach((step, sourceIndex) => {
    const title = step.testCaseTitle || step.action || `Check ${sourceIndex + 1}`;
    const key = step.testCaseId || title;
    const current = groups.get(key) || {
      key,
      title,
      caseId: String(step.testCaseId || ''),
      file: step.file || `${slug(title)}.spec.ts`,
      steps: [],
      outcome: 'passed' as Outcome,
      durationMs: 0,
    };
    current.steps.push({ ...step, sourceIndex });
    current.durationMs += Number(step.durationMs || 0);
    const status = outcomeOf(step.outcome);
    if (status === 'failed') current.outcome = 'failed';
    else if (status === 'skipped' && current.outcome !== 'failed') current.outcome = 'skipped';
    groups.set(key, current);
  });
  return [...groups.values()];
}

export function DetailedReportView({ report, jobId, context, evidenceFor, onViewEvidence }: {
  report: DetailedReportData;
  jobId?: string;
  /** Linked run/cases/results — the only source of a report's real tags. */
  context?: ReportContext;
  evidenceFor: (step: DetailedReportStep, index: number) => string;
  onViewEvidence: (key: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | Outcome>('all');
  const [showVideo, setShowVideo] = useState(false);
  const groups = useMemo(() => groupTests(report), [report]);
  const counts = {
    all: groups.length,
    passed: groups.filter((group) => group.outcome === 'passed').length,
    failed: groups.filter((group) => group.outcome === 'failed').length,
    skipped: groups.filter((group) => group.outcome === 'skipped').length,
  };
  const visible = filter === 'all' ? groups : groups.filter((group) => group.outcome === filter);
  // Reports never store tags of their own — resolve them from the executed test cases.
  const resolvedTags = useMemo(() => reportTags(report, context || {}), [report, context]);
  const tagsFor = (group: TestGroup) => resolvedTags.byCase.get(group.caseId) || resolvedTags.byCase.get(group.title) || [];
  const features = [...new Set([report.planName, report.suiteName, ...groups.map((group) => group.title)].filter(Boolean))] as string[];
  const files = [...new Set(groups.map((group) => group.file))].map((name) => {
    const related = groups.filter((group) => group.file === name);
    return { name, passed: related.filter((group) => group.outcome === 'passed').length, failed: related.filter((group) => group.outcome === 'failed').length, skipped: related.filter((group) => group.outcome === 'skipped').length };
  });
  const environment = report.environment || report.metadata?.environment || '—';
  const browser = report.browser || report.metadata?.browser || 'Chromium (Desktop)';
  const failedGroups = groups.filter((group) => group.outcome === 'failed');
  const skippedGroups = groups.filter((group) => group.outcome === 'skipped');
  const percentage = (value: number) => counts.all ? `${value / counts.all * 100}%` : '0%';
  const copy = (value: string) => void navigator.clipboard?.writeText(value);

  return <div className="qa-report">
    <header className="qa-report-header"><div><h1>QA Automation Report</h1><p>{report.name}{report.suiteName ? ` — ${report.suiteName}` : ''}</p></div></header>
    <div className="qa-report-layout">
      <aside className="qa-report-sidebar" aria-label="Test result filters"><div className="qa-status-tabs" role="tablist">
        {([['all', 'All Tests'], ['passed', 'Passed'], ['failed', 'Failed'], ['skipped', 'Skipped']] as const).map(([value, label]) => <button type="button" key={value} className={`qa-status-tab ${filter === value ? 'active' : ''}`} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}><div className={`qa-tab-num ${value}`}>{counts[value]}</div><div className="qa-tab-label">{label}</div></button>)}
      </div></aside>
      <main className="qa-report-main">
        <table className="qa-meta-table"><tbody>
          <tr><th>Run date</th><td>{report.date || '—'}</td></tr>
          <tr><th>Total execution time</th><td>{report.executionTime || '—'}</td></tr>
          <tr><th>Environment</th><td>{environment}</td></tr>
          <tr><th>App URL</th><td>{report.targetUrl ? <a href={report.targetUrl} target="_blank" rel="noreferrer">{report.targetUrl}</a> : '—'}</td></tr>
          <tr><th>Browser</th><td>{browser}</td></tr>
          <tr><th>Features executed</th><td>{features.length ? <ul>{features.map((feature) => <li key={feature}>{feature}</li>)}</ul> : '—'}</td></tr>
          <tr><th>Tags</th><td><div className="qa-tags">{resolvedTags.all.length ? resolvedTags.all.map((tag) => <span key={tag}>{tag}</span>) : '—'}</div></td></tr>
          {/* Tagline = the tag line of each executed test, so per-test tagging is auditable next to the run-wide set. */}
          <tr><th>Taglines</th><td>{groups.length ? <ul className="qa-taglines">{groups.map((group) => <li key={group.key}><span className="qa-tagline-test">{group.title}</span><span className="qa-tags">{tagsFor(group).length ? tagsFor(group).map((tag) => <span key={tag}>{tag}</span>) : <em>untagged</em>}</span></li>)}</ul> : '—'}</td></tr>
        </tbody></table>

        <div className="qa-result-bar" aria-label="Execution outcome distribution"><span className="pass" style={{ width: percentage(counts.passed) }} /><span className="fail" style={{ width: percentage(counts.failed) }} /><span className="skip" style={{ width: percentage(counts.skipped) }} /></div>

        <h2 className="qa-section-title">Overview (Plain Summary)</h2>
        <div className="qa-plain">Out of <b>{counts.all} checks</b> run against {report.targetUrl ? <b>{report.targetUrl}</b> : 'this application'}, <b>{counts.passed} worked correctly</b>{counts.failed ? <>, <b>{counts.failed} failed</b></> : ''}{counts.skipped ? <>, and <b>{counts.skipped} were skipped</b></> : ''}.</div>

        {(failedGroups.length > 0 || skippedGroups.length > 0) && <>
          <h2 className="qa-section-title">Rerun commands</h2>
          {failedGroups.length > 0 && <div className="qa-rerun-all"><div className="qa-rerun-title">Rerun all failed tests</div>{failedGroups.map((group) => { const command = `npx playwright test ${group.file} --grep ${JSON.stringify(group.title)}`; return <div className="qa-rerun-item" key={group.key}><div><b>{group.title}</b><small>{group.file}</small></div><div className="qa-rerun-row"><code>{command}</code><button type="button" onClick={() => copy(command)}><Copy size={13} />Copy</button></div></div>; })}</div>}
          {skippedGroups.length > 0 && <div className="qa-rerun-all skipped"><div className="qa-rerun-title">Rerun skipped tests</div>{skippedGroups.map((group) => { const command = `npx playwright test ${group.file} --grep ${JSON.stringify(group.title)}`; return <div className="qa-rerun-item" key={group.key}><div><b>{group.title}</b><small>{group.file}</small></div><div className="qa-rerun-row"><code>{command}</code><button type="button" onClick={() => copy(command)}><Copy size={13} />Copy</button></div></div>; })}</div>}
        </>}

        <h2 className="qa-section-title">Files Executed</h2>
        <div className="qa-file-grid">{files.map((file) => <div className={`qa-file-card ${file.failed ? 'has-fail' : ''}`} key={file.name}><div className="qa-file-name"><FileText size={15} />{file.name}</div><div className="qa-file-stats">{file.passed > 0 && <><span className="dot pass" />{file.passed} passed</>}{file.failed > 0 && <><span className="dot fail" />{file.failed} failed</>}{file.skipped > 0 && <><span className="dot skip" />{file.skipped} skipped</>}</div></div>)}</div>

        <h2 className="qa-section-title">Test Results</h2>
        {!visible.length && <div className="qa-filter-empty">No tests match this filter.</div>}
        {visible.map((group) => <details className="qa-test" key={group.key}><summary className="qa-test-head"><span className={`qa-status-dot ${group.outcome}`} /><div className="qa-test-title"><b>{group.title}</b>{tagsFor(group).length > 0 && <small className="qa-tags">{tagsFor(group).map((tag) => <span key={tag}>{tag}</span>)}</small>}</div><code>{group.file}</code><time>{duration(group.durationMs)}</time><ChevronRight className="qa-chevron" size={15} /></summary><div className="qa-test-body">
          <div className="qa-plain">{group.steps[0]?.expected || group.title}</div>
          <div className="qa-steps">{group.steps.map((step, index) => { const status = outcomeOf(step.outcome); const evidence = evidenceFor(step, step.sourceIndex); return <div className="qa-step" key={`${step.step || index}-${step.action}`}><span className={`qa-step-icon ${status}`}>{status === 'passed' ? <Check size={12} /> : status === 'failed' ? <X size={12} /> : <CircleMinus size={12} />}</span><div className="qa-step-text"><b>{step.action || `Step ${index + 1}`}</b><code>{step.action || '—'}</code><p><strong>Expected:</strong> {step.expected || '—'}</p>{(step.actual || step.reason) && <p className={status === 'failed' ? 'qa-actual' : ''}><strong>Actual:</strong> {step.actual || step.reason}</p>}{status === 'failed' && <><div className="qa-fail-location"><MapPin size={18} /><div><b>Failure location</b><code>{group.file} · step {step.step || index + 1}</code></div></div><div className="qa-compare"><div className="expected"><b>Expected</b><p>{step.expected || '—'}</p></div><div className="actual"><b>Actual</b><p>{step.actual || step.reason || report.failureReason || 'No actual result was recorded.'}</p></div></div>{(step.reason || report.failureReason) && <pre className="qa-error-box">{step.reason || report.failureReason}</pre>}</>}{evidence && <button type="button" className="qa-media-tag" onClick={() => onViewEvidence(evidence)}><Image size={14} />screenshot</button>}</div><span className={`qa-step-status ${status}`}>{status}</span></div>; })}</div>
          <div className="qa-media-row">{group.steps.some((step) => evidenceFor(step, step.sourceIndex)) && <span className="qa-media-tag"><Image size={14} />screenshots</span>}{jobId && <button type="button" className="qa-media-tag" aria-expanded={showVideo} onClick={() => setShowVideo((visible) => !visible)}><Video size={14} />video.webm</button>}</div>
          {showVideo && jobId && <AutomationRunArtifacts jobId={jobId} videoOnly />}
        </div></details>)}
      </main>
    </div>
    <footer>Generated by QA Automation · Report {report.id}{report.runId ? ` · Run ${report.runId}` : ''}</footer>
  </div>;
}
