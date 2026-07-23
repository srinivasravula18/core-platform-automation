// Reusable data-export helpers shared by every section (plans, suites, cases,
// runs, requirements, traceability, reports, defects).
// Supports CSV, JSON, Markdown table, and Print/PDF (via the browser print dialog).

export type ExportFormat = 'csv' | 'json' | 'md' | 'pdf' | 'html';

export interface ExportColumn {
  key: string;
  label: string;
  /** Custom accessor; defaults to row[key]. Return a primitive (string/number/boolean). */
  get?: (row: any) => any;
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
  const body = rows.map((r) => `| ${columns.map((c) => mdCell(cell(c, r))).join(' | ')} |`).join('\n');
  const heading = title ? `# ${title}\n\n_${rows.length} row(s) · exported ${new Date().toLocaleString()}_\n\n` : '';
  return `${heading}${head}\n${sep}\n${body}\n`;
}

function toHTMLTable(rows: any[], columns: ExportColumn[], title: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (m) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[m]));
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(cell(c, r)).replace(/\r?\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>
    :root{color-scheme:light dark}
    body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111;background:#fff}
    h1{font-size:20px;margin:0 0 4px}.s{color:#666;font-size:12px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
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
  // give the new window a tick to render before invoking print
  setTimeout(() => w.print(), 250);
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
