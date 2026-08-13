/**
 * How the recording browser is sized.
 *
 * A visible browser must behave like the user's own Chrome: maximized, page filling the window,
 * re-laying-out on resize. Pinning the viewport (1280x720) to keep video frames letterbox-free was
 * tried twice and both times clipped the app under test — the user could only see it zoomed out.
 * Reintroduced in ae716c1, reverted in 6fe106d; scripts/test-recorder-viewport.ts locks it down.
 * Size stays null unless a caller explicitly asks for a fixed one via --viewport w,h.
 */

export interface RecordSize { width: number; height: number }

export interface CodegenSizing {
  /** null = the page follows the window, exactly as a normal browser tab does. */
  viewport: RecordSize | null;
  /** Chromium-only launch args controlling the window itself. */
  windowArgs: string[];
  /** Omitted unless pinned — Playwright then derives the canvas from the page, keeping its aspect. */
  videoSize?: RecordSize;
}

export function parseRecordSize(raw: string): RecordSize | null {
  const [width, height] = String(raw || '').split(',').map(Number);
  const valid = [width, height].every((n) => Number.isFinite(n) && n > 0);
  return valid ? { width, height } : null;
}

export function codegenSizing(rawViewport: string): CodegenSizing {
  const pinned = parseRecordSize(rawViewport);
  return {
    viewport: pinned,
    windowArgs: pinned ? [`--window-size=${pinned.width},${pinned.height + 140}`] : ['--start-maximized'],
    ...(pinned ? { videoSize: pinned } : {}),
  };
}
