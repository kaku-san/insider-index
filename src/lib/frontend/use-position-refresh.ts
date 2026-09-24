"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPositionRefresher, pendingPositionChanges, subscribePositionChanges, type PositionChange } from "./position-refresh";

/** Refetch a wallet's position view after a confirmed VaultFlow signature (polling until the chain shows it) and on window focus. */
export function usePositionRefresh<T>(input: {
  owner: string | null | undefined;
  /** Single-index views pass their index; the Positions list passes null to follow every index. */
  indexId?: string | null;
  load: () => Promise<T>;
  apply: (value: T) => void;
  reflected: (value: T, change: PositionChange) => boolean;
  enabled?: boolean;
}) {
  const { owner, indexId = null, enabled = true } = input;
  const latest = useRef(input);
  useEffect(() => { latest.current = input; });
  const [updatingIndexIds, setUpdatingIndexIds] = useState<string[]>([]);
  const refetchRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (!enabled || !owner) return;
    const refresher = createPositionRefresher<T>({
      load: () => latest.current.load(),
      apply: value => latest.current.apply(value),
      reflected: (value, change) => latest.current.reflected(value, change),
      accepts: change => change.owner === owner && (indexId === null || change.indexId === indexId),
      onUpdating: setUpdatingIndexIds,
    });
    refetchRef.current = refresher.refetch;
    for (const change of pendingPositionChanges(owner)) refresher.track(change);
    const unsubscribe = subscribePositionChanges(change => refresher.track(change));
    const onFocus = () => { if (document.visibilityState !== "hidden") void refresher.refetch(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      refresher.dispose();
      refetchRef.current = () => Promise.resolve();
      setUpdatingIndexIds([]);
    };
  }, [owner, indexId, enabled]);

  const refetch = useCallback(() => refetchRef.current(), []);
  return { updatingIndexIds, updating: updatingIndexIds.length > 0, refetch };
}
