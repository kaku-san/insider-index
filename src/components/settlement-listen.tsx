"use client";

import type { SettlementStatus } from "@/lib/frontend/settlement-progress";
import styles from "./settlement-listen.module.css";

/** Loader plus the observed status. The spinner is not a progress percent. */
export function SettlementListen({ status, listening, detail }: { status: SettlementStatus; listening: boolean; detail: string }) {
  return <div className={styles.card} role="status" aria-live="polite" aria-busy={listening ? true : undefined} data-settlement-status={status} data-listening={listening ? "true" : "false"}>
    {listening ? <span className={styles.loader} aria-hidden="true" /> : null}
    <h3>{status}</h3>
    <p>{detail}</p>
  </div>;
}
