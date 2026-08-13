import React from 'react';
import { Command } from 'lucide-react';

/** macOS is the only platform where the palette opens with ⌘; everywhere else it is Ctrl. */
export const isMacPlatform = /mac/i.test(
  (navigator as any)?.userAgentData?.platform || navigator.platform || navigator.userAgent || '',
);

/** Lucide ships no Windows mark, so the four-pane logo is drawn inline. */
function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M3 5.6 10.6 4.5v7.1H3zM11.7 4.3 21 3v8.6h-9.3zM3 12.7h7.6v7.1L3 18.7zM11.7 12.7H21V21l-9.3-1.3z" />
    </svg>
  );
}

/** The modifier as the user's own keyboard shows it: ⌘ on Mac, the Windows mark elsewhere. */
export function ModifierIcon({ className }: { className?: string }) {
  return isMacPlatform ? <Command className={className} /> : <WindowsIcon className={className} />;
}

/** Text beside the icon — the icon is the modifier, so only the combination needs spelling out. */
export const commandPaletteHint = '+ K';
/** Inline form for prose ("Press ⌘ + K to create one"). */
export const commandPaletteShortcut = isMacPlatform ? '⌘ + K' : 'Ctrl + K';
/** Accurate key names for tooltips — the Windows mark is branding, Ctrl is what actually opens it. */
export const commandPaletteTitle = `Open command palette (${commandPaletteShortcut})`;
