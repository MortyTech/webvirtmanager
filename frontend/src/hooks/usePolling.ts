import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Client-side polling hook. The frontend alone decides the refresh cadence;
 * the backend has no scheduler. Enforces a minimum interval of 10 seconds.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalSec: number,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const MIN = 10;
  const safeInterval = Math.max(MIN, Math.round(intervalSec));
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetcherRef.current();
      setData(d);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    run();
    const id = setInterval(run, safeInterval * 1000);
    return () => clearInterval(id);
  }, [safeInterval, enabled, run]);

  return { data, error, loading, refresh: run };
}
