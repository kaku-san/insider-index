"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { shareLink, type ShareResult } from "@/lib/frontend/share-link";
import { Icon } from "./social/icon";
import styles from "./share-card.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: "Person index" | "Theme index";
  detail: string;
  image?: string | null;
};

function copyPageLink(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error("Clipboard access is unavailable."));
}

function noticeFor(result: ShareResult) {
  if (result === "copied") return "Link copied.";
  if (result === "shared") return "Share sheet opened.";
  if (result === "manual") return "Copy the link from your browser to share.";
  return null;
}

export function ShareCard({ open, onClose, title, kind, detail, image }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const viewKey = `${title}:${open}`;

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreFocus.current?.focus();
      restoreFocus.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  const data = { title: `${title} · InsiderIndex`, text: `${kind} on InsiderIndex.xyz`, url: window.location.href };
  async function share() {
    const result = await shareLink({ share: navigator.share?.bind(navigator), copy: copyPageLink }, data);
    const text = noticeFor(result);
    if (text) setNotice({ key: viewKey, text });
  }
  async function copy() {
    const result = await shareLink({ copy: copyPageLink }, data);
    const text = noticeFor(result);
    if (text) setNotice({ key: viewKey, text });
  }

  return <div className={styles.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header><div><strong id={titleId}>Ready for the group chat.</strong><span id={descriptionId}>Share the index, not a spreadsheet.</span></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close share card"><Icon name="close" size={17} /></button></header>
      <div className={styles.card}>
        {image ? <Image src={image} alt="" fill sizes="(max-width: 620px) 330px, 440px" /> : null}<div className={styles.scrim} />
        <div className={styles.brand}>InsiderIndex<span>®</span></div>
        <div className={styles.copy}><small>{kind.toUpperCase()}</small><h2>{title}</h2><p>{detail}</p></div>
        <div className={styles.footer}><span>PUBLIC FILINGS → INDEX</span><span>InsiderIndex.xyz</span></div>
      </div>
      <div className={styles.actions}><button type="button" className={styles.primary} onClick={() => void share()}><Icon name="share" size={16} />Share</button><button type="button" onClick={() => void copy()}><Icon name="copy" size={16} />Copy link</button></div>
      <p className={styles.notice} role="status" aria-live="polite">{notice?.key === viewKey ? notice.text : null}</p>
    </section>
  </div>;
}
