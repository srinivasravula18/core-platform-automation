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

export interface ReportContext {
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

const normalizeTag = (value: unknown) => {
  const tag = String(value ?? '').trim();
  return tag ? (tag.startsWith('@') ? tag : `@${tag}`) : '';
};

/**
 * Real tags for a report, resolved from the executed test cases (reports never store their own).
 * `all` is the run-wide tag line; `byCase` is the per-test tag line keyed by case id AND title, so a
 * step that carries only one of the two still resolves.
 */
export function reportTags(report: any, context: ReportContext = {}) {
  const byCase = new Map<string, string[]>();
  const all = new Set<string>();
  const collect = (source: any) => {
    const tags = Array.from(new Set((Array.isArray(source?.tags) ? source.tags : []).map(normalizeTag).filter(Boolean))) as string[];
    tags.forEach((tag) => all.add(tag));
    return tags;
  };
  collect(report).forEach((tag) => all.add(tag));
  for (const testCase of linkedReportCases(report, context)) {
    const tags = collect(testCase);
    if (testCase?.id) byCase.set(String(testCase.id), tags);
    if (testCase?.title) byCase.set(String(testCase.title), tags);
  }
  for (const step of report.steps || []) collect(step);
  return { all: [...all], byCase };
}

export function reportMetrics(report: any, context: ReportContext = {}) {
  const results = Array.isArray(context.results) ? context.results : [];
  const linkedCases = linkedReportCases(report, context);
  const executed = (step: any) => !/^(not run|untested|paused)$/i.test(String(step?.outcome || ''));
  const reportSteps = (report.steps || []).filter(executed);
  const stepCaseTitles = new Set(reportSteps.map((step: any) => String(step?.testCaseTitle || step?.testCaseId || '').trim()).filter(Boolean));
  const executedResults = results.filter((result) => !/^(not run|paused)$/i.test(String(result?.outcome || '')));
  const caseCount = stepCaseTitles.size || executedResults.length || (reportSteps.length ? 1 : 0);
  const resultSteps = executedResults.reduce((total, result) => total + (Array.isArray(result?.stepResults) ? result.stepResults.filter(executed).length : 0), 0);
  const authoredSteps = linkedCases.reduce((total, testCase) => total + (Array.isArray(testCase?.steps) ? testCase.steps.length : 0), 0);
  return { caseCount, stepCount: resultSteps || reportSteps.length || (caseCount ? authoredSteps : 0) };
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
  ].map(normalizeTag).filter(Boolean)));
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
  const allSteps = cases.flatMap((testCase: any) => testCase.steps || []);
  // report.executionTime is the primary source; run.durationMs never exists on a Run (duration only
  // lives per-step), so the real fallback is summing the steps this report already has in hand.
  const totalStepsDurationMs = allSteps.reduce((sum: number, step: any) => sum + Number(step.durationMs || 0), 0);
  const passed = allSteps.filter((step: any) => /pass/i.test(String(step.outcome || ''))).length;
  const failed = allSteps.filter((step: any) => /fail|block/i.test(String(step.outcome || ''))).length;
  const skipped = Math.max(0, allSteps.length - passed - failed);
  const resultFor = (steps: any[]) => steps.some((step) => /fail|block/i.test(String(step.outcome || ''))) ? 'Fail' : steps.every((step) => /skip/i.test(String(step.outcome || ''))) ? 'Skipped' : 'Pass';
  const fileCards = cases.map((testCase: any) => `<div class="card"><b>${esc(testCase.steps?.[0]?.file || `${String(testCase.title).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spec.ts`)}</b><div class="muted">${esc(resultFor(testCase.steps || []))} · ${(testCase.steps || []).length} step(s)</div></div>`).join('');
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
    *{box-sizing:border-box}body{font-family:Inter,"Segoe UI",Arial,sans-serif;margin:0;background:#0f172a;color:#e5e7eb;line-height:1.5}.report{max-width:1200px;margin:auto;padding:28px}.header{border-bottom:1px solid #334155;padding-bottom:22px;margin-bottom:26px}h1{margin:0;font-size:24px}.muted{color:#94a3b8;font-size:12px}.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:24px}.sidebar{display:grid;align-content:start;gap:10px}.status,.card,.case,.meta{border:1px solid #334155;border-radius:10px;background:#111c2f}.status{padding:13px 15px}.status b{display:block;font-size:22px}.passed{color:#10b981}.failed{color:#ef4444}.skipped{color:#f59e0b}.meta{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}.meta th,.meta td{padding:11px 14px;border-bottom:1px solid #334155;text-align:left;vertical-align:top;font-size:12px}.meta tr:last-child th,.meta tr:last-child td{border:0}.meta th{width:170px;background:#18243a}.section{display:flex;align-items:center;gap:10px;margin:28px 0 12px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.section:after{content:"";height:1px;flex:1;background:#334155}.overview{border:1px solid #34579b;background:#122647;border-radius:8px;padding:12px 14px;font-size:13px}.case{margin:10px 0;padding:14px;break-inside:avoid}h2{margin:0 0 10px;font-size:15px}h3{margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed}th,td{border:1px solid #334155;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#18243a}.failed-row{background:#321b24}.footer{border-top:1px solid #334155;margin-top:32px;padding-top:14px;text-align:center}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.card{padding:12px}.label{display:block;color:#94a3b8;font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:4px}@media(max-width:760px){.layout{grid-template-columns:1fr}.sidebar{grid-template-columns:repeat(4,1fr)}.report{padding:16px}.summary-grid{grid-template-columns:1fr 1fr}}@media print{@page{size:A4 landscape;margin:10mm}body{background:#fff;color:#172033}.report{max-width:none;padding:0}.layout{grid-template-columns:150px minmax(0,1fr);gap:14px}.status,.card,.case,.meta{background:#fff;border-color:#cbd5e1}.meta th,th{background:#f1f5f9}.meta th,.meta td,th,td{border-color:#cbd5e1}.muted,.section{color:#64748b}.overview{background:#eff6ff;border-color:#93c5fd}.section:after,.footer{border-color:#cbd5e1;background:#cbd5e1}.failed-row{background:#fff1f2}}
  </style></head><body><div class="report"><header class="header"><h1>QA Automation Report</h1><div class="muted">${esc(report.name)} · Generated ${esc(new Date().toLocaleString())}</div></header><div class="layout"><aside class="sidebar"><div class="status"><b>${allSteps.length}</b><span class="muted">All Tests</span></div><div class="status"><b class="passed">${passed}</b><span class="muted">Passed</span></div><div class="status"><b class="failed">${failed}</b><span class="muted">Failed</span></div><div class="status"><b class="skipped">${skipped}</b><span class="muted">Skipped</span></div></aside><main>
  <table class="meta"><tbody><tr><th>Run date</th><td>${esc(report.date || 'Not recorded')}</td></tr><tr><th>Total execution time</th><td>${esc(report.executionTime || (totalStepsDurationMs ? duration(totalStepsDurationMs) : 'Not recorded'))}</td></tr><tr><th>Environment</th><td>${esc(environment)}</td></tr><tr><th>App URL</th><td>${esc(report.targetUrl || run.targetUrl || 'Not recorded')}</td></tr><tr><th>Type</th><td>${esc(type)}</td></tr><tr><th>Features executed</th><td>${esc(features.join(', ') || 'Not recorded')}</td></tr><tr><th>Tags</th><td>${esc(tags.join(', ') || 'None')}</td></tr></tbody></table>
  <h2 class="section">Overview (Plain Summary)</h2><div class="overview">Out of <b>${allSteps.length} checks</b>, <b>${passed} passed</b>, <b>${failed} failed</b>, and <b>${skipped} were skipped</b>.</div>
  <h2 class="section">Files Executed</h2><div class="summary-grid">${fileCards || '<div class="card">No files recorded.</div>'}</div>
  <h2 class="section">Execution summary</h2><div class="summary-grid"><div class="card"><span class="label">Report ID</span>${esc(report.id || 'Not recorded')}</div><div class="card"><span class="label">Run ID</span>${esc(report.runId || run.id || 'Not recorded')}</div><div class="card"><span class="label">Executed cases / steps</span>${esc(metrics.caseCount)} / ${esc(metrics.stepCount)}</div></div>
  <h2 class="section">Test Results</h2>${caseSections || '<p>No execution steps were recorded.</p>'}</main></div><div class="footer muted">Generated by QA Automation · Report ${esc(report.id || '')}</div></div></body></html>`;
}

export function toReportMarkdown(report: any, context: ReportContext = {}): string {
  const run = context.run || {};
  const results = Array.isArray(context.results) ? context.results : [];
  const steps = results.length ? results.flatMap((result) => (result.stepResults || []).map((step: any) => ({ ...step, testCaseTitle: result.caseTitle }))) : (report.steps || []);
  const passed = steps.filter((step: any) => /pass/i.test(String(step.outcome || ''))).length;
  const failed = steps.filter((step: any) => /fail|block/i.test(String(step.outcome || ''))).length;
  const md = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const rows = steps.map((step: any, index: number) => `| ${index + 1} | ${md(step.testCaseTitle || report.name)} | ${md(step.action)} | ${md(step.expected || '—')} | ${md(step.actual || step.reason || '—')} | ${md(step.outcome || 'Not Run')} |`).join('\n');
  const files = [...new Set(steps.map((step: any) => step.file).filter(Boolean))];
  return `# QA Automation Report\n\n## ${md(report.name)}\n\n| Run metadata | Value |\n| --- | --- |\n| Report ID | ${md(report.id || 'Not recorded')} |\n| Run ID | ${md(report.runId || run.id || 'Not recorded')} |\n| Run date | ${md(report.date || 'Not recorded')} |\n| Total execution time | ${md(report.executionTime || 'Not recorded')} |\n| App URL | ${md(report.targetUrl || run.targetUrl || 'Not recorded')} |\n\n## Overview (Plain Summary)\n\nOut of **${steps.length} checks**, **${passed} passed**, **${failed} failed**, and **${Math.max(0, steps.length - passed - failed)} were skipped**.\n\n## Files Executed\n\n${files.length ? files.map((file) => `- \`${md(file)}\``).join('\n') : '- No files recorded.'}\n\n## Test Results\n\n| # | Test case | Test step | Expected result | Actual result | Outcome |\n| ---: | --- | --- | --- | --- | --- |\n${rows || '| — | No execution steps were recorded | — | — | — | — |'}\n`;
}

export function printReportPDF(report: any, context: ReportContext = {}) {
  printHTML(toReportHTML(report, context));
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
