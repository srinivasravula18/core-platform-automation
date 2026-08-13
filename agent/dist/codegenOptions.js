/**
 * How the recording browser is sized.
 *
 * A visible browser must behave like the user's own Chrome: maximized, page filling the window,
 * re-laying-out on resize. Pinning the viewport (1280x720) to keep video frames letterbox-free was
 * tried twice and both times clipped the app under test — the user could only see it zoomed out.
 * Reintroduced in ae716c1, reverted in 6fe106d; scripts/test-recorder-viewport.ts locks it down.
 * Size stays null unless a caller explicitly asks for a fixed one via --viewport w,h.
 */
export function parseRecordSize(raw) {
    const [width, height] = String(raw || '').split(',').map(Number);
    const valid = [width, height].every((n) => Number.isFinite(n) && n > 0);
    return valid ? { width, height } : null;
}
export function codegenSizing(rawViewport) {
    const pinned = parseRecordSize(rawViewport);
    return {
        viewport: pinned,
        windowArgs: pinned ? [`--window-size=${pinned.width},${pinned.height + 140}`] : ['--start-maximized'],
        ...(pinned ? { videoSize: pinned } : {}),
    };
}
//# sourceMappingURL=codegenOptions.js.map