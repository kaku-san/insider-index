"use client";

import { useEffect, useRef } from "react";
import { getIndexPosition, type IndexSharePosition } from "./vault-api";
import { positionNeedsListen, SETTLEMENT_POLL_MS } from "./settlement-progress";

/** Re-read one index position while a deposit or cash-out is still open. No-op when nothing is pending. */
export function useIndexPositionListen(indexId: string | null | undefined, owner: string | null | undefined, position: IndexSharePosition | null | undefined, onPosition: (position: IndexSharePosition) => void, enabled = true) {
  const onPositionRef = useRef(onPosition);
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  const signature = position?.pendingOperations?.filter(operation => operation.complete !== true).map(operation => `${operation.kind}:${operation.phase}`).join("|") ?? "";
  const listen = enabled && Boolean(indexId && owner && positionNeedsListen(position));
  useEffect(() => {
    if (!listen || !indexId || !owner) return;
    let alive = true;
    const timer = setInterval(() => {
      void getIndexPosition(indexId, owner).then(next => { if (alive && next) onPositionRef.current(next); }).catch(() => {});
    }, SETTLEMENT_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [listen, indexId, owner, signature]);
}
