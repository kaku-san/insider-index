"use client";
import { useCallback, useEffect, useState } from "react";
import { readApi, errorText } from "./api";
export function useResource<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!url) { setData(null); setLoading(false); setError(null); return; }
    setLoading(true); setError(null); setData(null);
    readApi<T>(url, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch(err => {
      if (!controller.signal.aborted) setError(errorText(err));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, version]);
  return { data, error, loading, reload };
}
