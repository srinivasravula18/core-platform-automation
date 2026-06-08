import { useCallback, useRef, useState } from 'react';

/**
 * `@ai` smart search for any list page. Typing `@ai <query>` in a search box
 * sends the CURRENT page's items + the query to the search-only AI agent, which
 * returns the ids that match. The page then filters to those ids.
 *
 * Usage:
 *   const ai = useAiSearch('cases');
 *   onChange: ai.isAiQuery(v) ? ai.run(v, items.map(c => ({ id, title, ... }))) : ai.reset()
 *   render:   ai.active ? items.filter(c => ai.matchedIds?.has(c.id)) : normalTextFilter
 */
export function useAiSearch(kind: string) {
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const isAiQuery = useCallback((q: string) => /^@ai\b/i.test((q || '').trim()), []);
  const stripPrefix = useCallback((q: string) => (q || '').replace(/^@ai\b/i, '').trim(), []);

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setMatchedIds(null);
    setLoading(false);
    setError('');
  }, []);

  const run = useCallback(
    (rawQuery: string, items: Array<Record<string, any>>) => {
      const q = stripPrefix(rawQuery);
      if (timer.current) clearTimeout(timer.current);
      if (!q) {
        setMatchedIds(null);
        setLoading(false);
        setError('');
        return;
      }
      setLoading(true);
      setError('');
      const mine = ++seq.current;
      timer.current = setTimeout(async () => {
        try {
          const res = await fetch('/api/ai/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q, kind, items: (items || []).slice(0, 300) }),
          });
          const data = await res.json();
          if (mine !== seq.current) return; // a newer query superseded this one
          setMatchedIds(new Set((data.matchIds || []).map(String)));
          if (data.error) setError(data.error);
        } catch (e: any) {
          if (mine !== seq.current) return;
          setError(e?.message || 'AI search failed');
          setMatchedIds(new Set());
        } finally {
          if (mine === seq.current) setLoading(false);
        }
      }, 450);
    },
    [kind, stripPrefix],
  );

  return { matchedIds, loading, error, run, reset, isAiQuery, stripPrefix, active: matchedIds !== null };
}
