import type { KeyboardEvent } from 'react';

const INDENT = '  ';

export function codeEditorEdit(value: string, start: number, end: number, key: string): { value: string; caret: number } | null {
  let insert = '';
  if (key === 'Enter') {
    const line = value.slice(value.lastIndexOf('\n', start - 1) + 1, start);
    insert = `\n${line.match(/^[ \t]*/)?.[0] || ''}`;
  } else if (key === 'Tab') {
    insert = INDENT;
  } else {
    return null;
  }
  return { value: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length };
}

/** Preserve code indentation on Enter and keep Tab inside the script editor. */
export function handleCodeEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, value: string, onChange: (value: string) => void) {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.currentTarget;
  const edit = codeEditorEdit(value, target.selectionStart ?? value.length, target.selectionEnd ?? value.length, event.key);
  if (!edit) return;
  event.preventDefault();
  onChange(edit.value);
  requestAnimationFrame(() => target.setSelectionRange(edit.caret, edit.caret));
}
