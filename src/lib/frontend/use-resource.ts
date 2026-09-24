"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, readApi } from "./api";

export function useResource<T>(url: string | null, initialData?: T | null) {
  const [data, setData] = useState<T | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url) && initialData == null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  /** Show a fresher read taken outside this hook (e.g. a post-signature refresh) without refetching. */
  const replace = useCallback((value: T) => { setData(value); setError(null); }, []);

  useEffect(() => {
    if (!url) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    // Keep existing rows on screen while a refresh is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch lifecycle
    setLoading(true);
    setError(null);

    void readApi<T>(url, controller.signal)
      .then((value) => {
        if (!cancelled) {
          setData(value);
        }
      })
      .catch((err) => {
        if (!cancelled && !controller.signal.aborted) {
          setError(errorText(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, version]);

  if (!url) {
    return { data: null, error: null, loading: false, reload, replace };
  }

  return { data, error, loading, reload, replace };
}
