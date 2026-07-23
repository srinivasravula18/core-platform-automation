import { useState } from 'react';
import { Download, ChevronDown, FileSpreadsheet, FileJson, FileText, Printer } from 'lucide-react';
import { exportRows, type ExportColumn, type ExportFormat } from '../lib/exportData';

interface ExportMenuProps {
  /** Rows to export (already filtered/visible set is fine). */
  rows: any[];
  columns: ExportColumn[];
  /** Base filename (no extension) and document title. */
  filename: string;
  title?: string;
  /** Which formats to offer. Defaults to all four. */
  formats?: ExportFormat[];
  label?: string;
  className?: string;
  dropUp?: boolean;
}

const FORMAT_META: Record<ExportFormat, { label: string; icon: typeof FileText }> = {
  csv: { label: 'Excel / CSV (.csv)', icon: FileSpreadsheet },
  json: { label: 'JSON (.json)', icon: FileJson },
  md: { label: 'Markdown (.md)', icon: FileText },
  pdf: { label: 'PDF (.pdf)', icon: Printer },
  html: { label: 'HTML (.html)', icon: FileText },
};

export default function ExportMenu({
  rows,
  columns,
  filename,
  title,
  formats = ['csv', 'json', 'md', 'pdf'],
  label = 'Export',
  className = '',
  dropUp = false,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const disabled = !rows || rows.length === 0;

  const run = (fmt: ExportFormat) => {
    setOpen(false);
    exportRows(fmt, { rows, columns, filename, title: title || filename });
  };

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? 'Nothing to export yet' : `Export ${rows.length} row(s)`}
        className="flex items-center gap-1.5 border border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] text-[var(--text-primary)] px-3 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download className="w-4 h-4" /> {label}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          {/* click-away overlay */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 z-50 w-52 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-lg ${dropUp ? 'bottom-full mb-1' : 'mt-1'}`}>
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)]">
              Export {rows.length} row{rows.length === 1 ? '' : 's'}
            </div>
            {formats.map((fmt) => {
              const Meta = FORMAT_META[fmt];
              const Icon = Meta.icon;
              return (
                <button
                  key={fmt}
                  onClick={() => run(fmt)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <Icon className="w-4 h-4 text-[var(--accent)]" /> {Meta.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
