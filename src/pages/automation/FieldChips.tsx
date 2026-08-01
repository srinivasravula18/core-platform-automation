import { useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { X } from 'lucide-react';

// A field's bound value is modelled as an ordered list of chips: literal text + {{token}} pills.
// The user only ever sees pills/text — the {{…}} syntax is generated on serialize, never shown or typed.
export type Chip = { id: string; kind: 'text'; value: string } | { id: string; kind: 'token'; token: string };

let seq = 0;
const uid = () => `chip_${++seq}`;

// Parse an engine expression (e.g. "hi {{Email}} {{unique.email|upper}}") into display chips.
export function expressionToChips(expr: string): Chip[] {
  const chips: Chip[] = [];
  const re = /\{\{([^}]+)\}\}/g;
  let last = 0; let match: RegExpExecArray | null;
  while ((match = re.exec(expr)) !== null) {
    if (match.index > last) chips.push({ id: uid(), kind: 'text', value: expr.slice(last, match.index) });
    chips.push({ id: uid(), kind: 'token', token: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < expr.length) chips.push({ id: uid(), kind: 'text', value: expr.slice(last) });
  return chips;
}

// Serialize chips back to the engine expression the API stores (tokens re-wrapped in {{…}}).
export function chipsToExpression(chips: Chip[]): string {
  return chips.map((chip) => (chip.kind === 'text' ? chip.value : `{{${chip.token}}}`)).join('');
}

// Value kind drives the pill color so a real sheet column reads differently from a generated or
// fresh-each-run value. Precedence mirrors the server resolver: a real column always wins over a
// same-named generator; then unique (fresh every run) > generated (faker) > other builtins.
export type ValueKind = 'column' | 'generated' | 'unique' | 'other';
const UNIQUE_RE = /^(unique\.|unique\b|uuid\b|timestamp\b|faker\.email\b)/i;
const GENERATED_RE = /^faker\./i;
export function tokenVariant(token: string, columnNames: string[]): ValueKind {
  const base = token.split('|')[0].trim();
  if (columnNames.some((name) => name.toLowerCase() === base.toLowerCase())) return 'column';
  if (UNIQUE_RE.test(base)) return 'unique';
  if (GENERATED_RE.test(base)) return 'generated';
  return 'other';
}

// Human label for a token pill — dotted parts and transforms rendered with " · ", never braces.
export function tokenLabel(token: string): string {
  const parts = token.split('|').map((part) => part.trim());
  const core = parts[0].replace(/\./g, ' · ');
  return parts.length > 1 ? `${core} · ${parts.slice(1).join(' · ')}` : core;
}

// Shared pill palette (also used by the value picker) — one color per value kind.
export const VARIANT_CLS: Record<ValueKind, string> = {
  column: 'border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]',       // blue — from your sheet
  generated: 'border-purple-500/50 bg-purple-500/10 text-purple-500',                   // purple — fake but realistic
  unique: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500',                   // green — fresh every run
  other: 'border-sky-500/50 bg-sky-500/10 text-sky-500',                                // sky — other builtins
};

// Inline chip editor for a single recorded field. Emits the serialized expression on every change.
export function FieldChipEditor({ expression, columnNames, onSave, onFocusField, ariaLabel, placeholder }: {
  expression: string; columnNames: string[]; onSave: (expression: string) => void;
  onFocusField?: () => void; ariaLabel: string; placeholder?: string;
}) {
  const chips = useMemo(() => expressionToChips(expression), [expression]);
  const [draft, setDraft] = useState('');
  const removeAt = (index: number) => onSave(chipsToExpression(chips.filter((_, i) => i !== index)));
  const commitDraft = () => {
    const value = draft; setDraft('');
    if (value) onSave(chipsToExpression([...chips, { id: uid(), kind: 'text', value }]));
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commitDraft(); }
    else if (event.key === 'Backspace' && !draft && chips.length) removeAt(chips.length - 1);
  };
  return <div className="flex min-h-[2rem] flex-1 flex-wrap items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1">
    {chips.map((chip, index) => chip.kind === 'token'
      ? <span key={chip.id} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${VARIANT_CLS[tokenVariant(chip.token, columnNames)]}`}>
          {tokenLabel(chip.token)}
          <button type="button" aria-label={`Remove ${tokenLabel(chip.token)}`} onClick={() => removeAt(index)} className="rounded-full hover:text-red-500"><X className="h-3 w-3" /></button>
        </span>
      : chip.value.trim() && <span key={chip.id} className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
          {chip.value}
          <button type="button" aria-label="Remove text" onClick={() => removeAt(index)} className="rounded hover:text-red-500"><X className="h-3 w-3" /></button>
        </span>)}
    <input aria-label={ariaLabel} value={draft} onFocus={onFocusField} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} onBlur={commitDraft}
      placeholder={chips.length ? 'type…' : (placeholder || 'type a value')}
      className="min-w-16 flex-1 bg-transparent py-0.5 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
  </div>;
}

// Draggable palette pill (columns + variables) — drops/clicks insert a chip, never raw braces.
export function PalettePill({ label, variant, draggable, onDragStart, onClick, title }: {
  label: string; variant: ValueKind; draggable?: boolean;
  onDragStart?: (event: DragEvent) => void; onClick?: () => void; title?: string;
}) {
  return <button type="button" draggable={draggable} onDragStart={onDragStart} onClick={onClick} title={title}
    className={`inline-flex cursor-grab items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium hover:opacity-90 active:cursor-grabbing ${VARIANT_CLS[variant]}`}>
    {label}
  </button>;
}
