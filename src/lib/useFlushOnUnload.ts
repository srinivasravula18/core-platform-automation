import { useEffect, useRef } from 'react';

/**
 * App-level safety net for API-triggered work that outlives a component.
 *
 * The failure mode this guards against: a user triggers an async/streaming API request, then
 * navigates to another page (or the app remounts the routed subtree on a project/app scope change,
 * or the tab is closed). The component unmounts, its React state is discarded, and any pending
 * "persist this result" work that was still debounced never runs — so returning shows a blank/partial
 * state even though the server-side work is durable. This was the "my Agent Console request disappears
 * when I switch pages" bug; the same shape can occur on any page with in-flight API results.
 *
 * `useFlushOnUnload(flush)` runs `flush` exactly when the surrounding work is about to be lost:
 *   - the component unmounts (SPA route change or scope-driven remount), and
 *   - the page is hidden or closed (`pagehide` / `visibilitychange === 'hidden'`), covering tab close
 *     and hard reload where unmount cleanup may not run.
 *
 * `flush` should be cheap and idempotent, and should persist via a `keepalive` request so it survives
 * teardown (a normal fetch started during unmount usually completes for SPA nav, but keepalive also
 * covers full-page unload). The latest `flush` closure is always used, so callers don't need to
 * memoize it.
 */
export function useFlushOnUnload(flush: () => void): void {
  const ref = useRef(flush);
  ref.current = flush;
  useEffect(() => {
    const run = () => { try { ref.current(); } catch { /* best effort — never block navigation */ } };
    const onVisibility = () => { if (document.visibilityState === 'hidden') run(); };
    window.addEventListener('pagehide', run);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', run);
      document.removeEventListener('visibilitychange', onVisibility);
      run(); // real unmount: route change or scope-driven remount
    };
  }, []);
}
