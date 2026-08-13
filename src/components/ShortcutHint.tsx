import React from 'react';
import { Command } from 'lucide-react';

/** macOS is the only platform where the palette opens with ⌘; everywhere else it is Ctrl. */
export const isMacPlatform = /mac/i.test(
  (navigator as any)?.userAgentData?.platform || navigator.platform || navigator.userAgent || '',
);

/**
 * The shortcut as the user's own keyboard shows it: the ⌘ glyph on Mac, where the key IS a symbol,
 * and plain "Ctrl" elsewhere — Windows keyboards label the key, and its logo means a different key.
 */
export function CommandPaletteHint({ iconClassName = 'w-3.5 h-3.5' }: { iconClassName?: string }) {
  if (!isMacPlatform) return <span>Ctrl + K</span>;
  return <><Command className={iconClassName} aria-hidden="true" /><span>+ K</span></>;
}

/** Inline form for prose ("Press ⌘ + K to create one"). */
export const commandPaletteShortcut = isMacPlatform ? '⌘ + K' : 'Ctrl + K';
/** Tooltips name the real keys on both platforms. */
export const commandPaletteTitle = `Open command palette (${commandPaletteShortcut})`;
