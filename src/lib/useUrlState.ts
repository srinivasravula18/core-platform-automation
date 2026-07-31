import { useSearchParams } from 'react-router-dom';

/**
 * Keeps a small, navigable piece of page UI state (such as a tab or view) in
 * the URL. Unlike component state, this survives a browser refresh and is
 * also restored when the user returns with the browser Back/Forward buttons.
 */
export function useUrlState<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(key) as T | null;
  const value = requested && allowed.includes(requested) ? requested : fallback;

  const setValue = (next: T) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      // Defaults need not make every URL noisy; their absence still restores
      // predictably, while non-default selections remain shareable.
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      return params;
    }, { replace: true });
  };

  return [value, setValue] as const;
}
