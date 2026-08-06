// Reusable data-export helpers shared by every section (plans, suites, cases,
// runs, requirements, traceability, reports, defects).
// Supports CSV, JSON, Markdown table, and Print/PDF (via the browser print dialog).

import { normalizeTestCaseTypes, TESTING_TYPES } from '../../core/shared/testCaseTypes';

export type ExportFormat = 'csv' | 'json' | 'md' | 'pdf' | 'html';

export interface ExportColumn {
  key: string;
  label: string;
  /** Custom accessor; defaults to row[key]. Return a primitive (string/number/boolean). */
  get?: (row: any) => any;
  /** Render image URLs as linked thumbnails in HTML/PDF while keeping the URL in data exports. */
  kind?: 'image';
}

const cell = (col: ExportColumn, row: any): string => {
  const raw = col.get ? col.get(row) : row?.[col.key];
  if (raw === null || raw === undefined) return '';
  if (Array.isArray(raw)) return raw.join('; ');
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
};

export function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function toCSV(rows: any[], columns: ExportColumn[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(cell(c, r))).join(',')).join('\r\n');
  return `${header}\r\n${body}`;
}

export function toJSONExport(rows: any[], columns: ExportColumn[]): string {
  const shaped = rows.map((r) => {
    const o: Record<string, any> = {};
    for (const c of columns) o[c.key] = c.get ? c.get(r) : r?.[c.key];
    return o;
  });
  return JSON.stringify(shaped, null, 2);
}

export function toMarkdown(rows: any[], columns: ExportColumn[], title?: string): string {
  const mdCell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = `| ${columns.map((c) => mdCell(c.label)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${columns.map((c) => {
    const value = cell(c, r);
    return c.kind === 'image' && value ? `[View screenshot](${value})` : mdCell(value);
  }).join(' | ')} |`).join('\n');
  const heading = title ? `# ${title}\n\n_${rows.length} row(s) · exported ${new Date().toLocaleString()}_\n\n` : '';
  return `${heading}${head}\n${sep}\n${body}\n`;
}

export function toHTMLTable(rows: any[], columns: ExportColumn[], title: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (m) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[m]));
  const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
  const htmlCell = (column: ExportColumn, row: any) => {
    const value = cell(column, row);
    if (column.kind !== 'image' || !/^(?:https?:\/\/|\/|data:image\/)/i.test(value)) return esc(value).replace(/\r?\n/g, '<br>');
    const url = escAttr(value);
    return `<a href="${url}" target="_blank" rel="noreferrer"><img src="${url}" alt="Execution screenshot"></a>`;
  };
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${htmlCell(c, r)}</td>`).join('')}</tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>
    :root{color-scheme:light dark}
    body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111;background:#fff}
    h1{font-size:20px;margin:0 0 4px}.s{color:#666;font-size:12px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
    td img{display:block;width:180px;max-height:120px;object-fit:cover;border:1px solid #ddd;border-radius:4px}
    th{background:#f4f4f5}tr:nth-child(even){background:#fafafa}
    /* Legible in a dark-theme browser too. */
    @media (prefers-color-scheme: dark){
      body{color:#e5e7eb;background:#0f172a}
      .s{color:#94a3b8}
      th,td{border-color:#334155}
      th{background:#1e293b}tr:nth-child(even){background:#111827}
    }
    /* Printed output / PDF is always light on white regardless of screen theme. */
    @media print{@page{margin:14mm} body{color:#111;background:#fff} .s{color:#666} th,td{border-color:#ddd} th{background:#f4f4f5} tr:nth-child(even){background:#fafafa}}
  </style></head><body><h1>${esc(title)}</h1><div class="s">${rows.length} row(s) · ${esc(new Date().toLocaleString())}</div>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function printHTML(html: string) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  const images = Array.from(w.document.images);
  const loaded = Promise.all(images.map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
      })));
  void Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => w.print());
}

interface ReportContext {
  run?: any;
  results?: any[];
  plan?: any;
  cases?: any[];
  suites?: any[];
}

function linkedReportCases(report: any, context: ReportContext): any[] {
  const caseById = new Map((context.cases || []).map((testCase) => [String(testCase.id), testCase]));
  const ids = new Set<string>();
  for (const id of context.run?.caseIds || []) ids.add(String(id));
  for (const result of context.results || []) if (result?.caseId) ids.add(String(result.caseId));
  for (const step of report.steps || []) if (step?.testCaseId) ids.add(String(step.testCaseId));
  return [...ids].map((id) => caseById.get(id)).filter(Boolean);
}

export function reportMetrics(report: any, context: ReportContext = {}) {
  const results = Array.isArray(context.results) ? context.results : [];
  const linkedCases = linkedReportCases(report, context);
  const stepCaseTitles = new Set((report.steps || []).map((step: any) => String(step?.testCaseTitle || '').trim()).filter(Boolean));
  const caseCount = linkedCases.length || results.length || stepCaseTitles.size || ((report.steps || []).length ? 1 : Number(report.totalExecutions) || 0);
  const resultSteps = results.reduce((total, result) => total + (Array.isArray(result?.stepResults) ? result.stepResults.length : 0), 0);
  const authoredSteps = linkedCases.reduce((total, testCase) => total + (Array.isArray(testCase?.steps) ? testCase.steps.length : 0), 0);
  return { caseCount, stepCount: resultSteps || authoredSteps || (report.steps || []).length };
}

export function reportTypeLabel(report: any, context: ReportContext = {}): string {
  const types = Array.from(new Set(linkedReportCases(report, context).flatMap((testCase) => [
    String(testCase.type || '').trim(),
    ...normalizeTestCaseTypes(testCase),
  ]).filter(Boolean)));
  if (types.length) return types.join(', ');
  if (report.testingTypes || report.testingType) return normalizeTestCaseTypes(report).join(', ');
  if (TESTING_TYPES.includes(report.suiteName)) return report.suiteName;
  const mode = String(context.run?.mode || '').trim();
  if (mode) return mode.charAt(0).toUpperCase() + mode.slice(1);
  // Record & Play / scheduled / agent runs set triggerType but not always `mode` — fall back to it
  // rather than showing a bare '-' for otherwise-known run types.
  const trigger = String(context.run?.triggerType || '').trim();
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'automation' || trigger === 'agent' || trigger === 'schedule') return 'Automated';
  return '—';
}

export function toReportHTML(report: any, context: ReportContext = {}): string {
  const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
  const duration = (value: unknown) => {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return value ? String(value) : 'Not recorded';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  };
  const run = context.run || {};
  const plan = context.plan || {};
  const manualResults = Array.isArray(context.results) ? context.results : [];
  const allCases = Array.isArray(context.cases) ? context.cases : [];
  const caseById = new Map(allCases.map((testCase) => [String(testCase.id), testCase]));
  const suiteById = new Map((context.suites || []).map((suite) => [String(suite.id), suite]));
  const linkedCases = linkedReportCases(report, context);
  const featureName = report.suiteName || plan.name || report.planName || 'General';
  const environment = run.triggerMeta?.environment || run.definition?.environment
    || manualResults.map((result) => result.configuration).find(Boolean)
    || plan.environments || report.targetUrl || run.targetUrl || 'Not recorded';
  const tags = Array.from(new Set([
    ...(Array.isArray(report.tags) ? report.tags : []),
    ...(Array.isArray(run.tags) ? run.tags : []),
    ...(Array.isArray(plan.tags) ? plan.tags : []),
    ...linkedCases.flatMap((testCase) => Array.isArray(testCase.tags) ? testCase.tags : []),
  ].filter(Boolean)));
  const featureFor = (result: any, testCase: any) => {
    const suiteIds = Array.from(new Set([
      ...(Array.isArray(testCase?.testSuiteIds) ? testCase.testSuiteIds : []),
      testCase?.testSuiteId,
    ].filter(Boolean).map(String)));
    return result?.feature || testCase?.feature
      || suiteIds.map((id) => suiteById.get(id)?.name).find(Boolean)
      || featureName;
  };
  const cases = manualResults.length
    ? manualResults.map((result) => {
      const testCase = caseById.get(String(result.caseId || ''));
      return {
        title: result.caseTitle || testCase?.title || 'Untitled test case',
        feature: featureFor(result, testCase),
        steps: result.stepResults || [],
      };
    })
    : Array.from((report.steps || []).reduce((groups: Map<string, any>, step: any) => {
      const title = step.testCaseTitle || report.name || 'Execution';
      const testCase = caseById.get(String(step.testCaseId || '')) || allCases.find((item) => item.title === title);
      if (!groups.has(title)) groups.set(title, { title, feature: featureFor(step, testCase), steps: [] });
      groups.get(title).steps.push(step);
      return groups;
    }, new Map<string, any>()).values());
  const features = Array.from(new Set(cases.map((testCase: any) => testCase.feature)));
  const metrics = reportMetrics(report, context);
  const type = reportTypeLabel(report, context);
  const caseSections = features.map((feature) => `<section class="feature"><h2>Feature: ${esc(feature)}</h2>${cases.filter((testCase: any) => testCase.feature === feature).map((testCase: any) => `<section class="case">
    <h3>${esc(testCase.title)}</h3>
    <table><thead><tr><th>#</th><th>Test step</th><th>Expected result</th><th>Actual result</th><th>Outcome</th><th>Execution time</th></tr></thead><tbody>
    ${(testCase.steps || []).map((step: any, index: number) => {
      const failed = /fail|block/i.test(String(step.outcome || ''));
      const actual = step.actual || step.reason || step.comment || (failed ? 'No actual result was recorded.' : '—');
      const elapsed = step.durationMs ?? (step.startedAt && step.completedAt
        ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
        : undefined);
      return `<tr class="${failed ? 'failed' : ''}"><td>${esc(step.step || index + 1)}</td><td>${esc(step.action)}</td><td>${esc(step.expected || 'Not recorded')}</td><td>${esc(actual)}</td><td>${esc(step.outcome || 'Not Run')}</td><td>${esc(duration(elapsed))}</td></tr>`;
    }).join('')}</tbody></table></section>`).join('')}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(report.name)}</title><style>
    body{font-family:Arial,sans-serif;margin:28px;color:#172033}h1{margin-bottom:4px}.muted{color:#64748b;font-size:12px}.summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0}.card,.case{border:1px solid #dbe2ea;border-radius:8px;padding:12px}.label{display:block;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px}h2{margin-top:28px}h3{margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #dbe2ea;padding:7px;text-align:left;vertical-align:top}th{background:#f1f5f9}.case{margin:12px 0;padding:14px}.failed{background:#fff1f2}.failed td:nth-child(3),.failed td:nth-child(4){font-weight:600}@media print{@page{margin:12mm}.case{break-inside:avoid}}
  </style></head><body><h1>${esc(report.name)}</h1><div class="muted">Generated ${esc(new Date().toLocaleString())}</div>
  <div class="summary"><div class="card"><span class="label">Report ID</span>${esc(report.id || 'Not recorded')}</div><div class="card"><span class="label">Run ID</span>${esc(report.runId || run.id || 'Not recorded')}</div><div class="card"><span class="label">Environment</span>${esc(environment)}</div><div class="card"><span class="label">Type</span>${esc(type)}</div><div class="card"><span class="label">Features executed</span>${esc(features.join(', ') || 'Not recorded')}</div><div class="card"><span class="label">Tags</span>${esc(tags.join(', ') || 'None')}</div><div class="card"><span class="label">Executed cases</span>${esc(metrics.caseCount)}</div><div class="card"><span class="label">Executed steps</span>${esc(metrics.stepCount)}</div><div class="card"><span class="label">Overall execution time</span>${esc(report.executionTime || duration(run.durationMs) || 'Not recorded')}</div></div>
  <h2>Feature-wise test cases and steps</h2>${caseSections || '<p>No execution steps were recorded.</p>'}</body></html>`;
}

const slug = (s: string) => (s || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 50);

export function exportRows(
  format: ExportFormat,
  opts: { rows: any[]; columns: ExportColumn[]; filename: string; title?: string },
) {
  const { rows, columns, filename, title } = opts;
  const base = slug(filename);
  if (format === 'csv') return downloadFile('﻿' + toCSV(rows, columns), `${base}.csv`, 'text/csv;charset=utf-8');
  if (format === 'json') return downloadFile(toJSONExport(rows, columns), `${base}.json`, 'application/json');
  if (format === 'md') return downloadFile(toMarkdown(rows, columns, title), `${base}.md`, 'text/markdown;charset=utf-8');
  if (format === 'html') return downloadFile(toHTMLTable(rows, columns, title || filename), `${base}.html`, 'text/html;charset=utf-8');
  if (format === 'pdf') return printHTML(toHTMLTable(rows, columns, title || filename));
}
