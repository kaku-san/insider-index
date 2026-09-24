"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { shareLink, type ShareResult } from "@/lib/frontend/share-link";
import { indexDisplayName } from "@/lib/frontend/index-name";
import { canShareImageFiles, copyShareImage, renderShareCardPng, SHARE_CARD_FILE, shareImageNatively, shareText, xIntentUrl, X_IMAGE_HINT } from "@/lib/frontend/share-image";
import { Icon } from "./social/icon";
import styles from "./share-card.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: "Person index" | "Theme index";
  detail: string;
  image?: string | null;
  /** Page to share; defaults to the current page. */
  url?: string;
};

function writeImage(png: Promise<Blob>) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return Promise.reject(new Error("Image clipboard is unavailable."));
  // A pending blob keeps the write inside the click gesture (Safari requires that).
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function downloadImage(png: Blob) {
  const href = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = href;
  link.download = SHARE_CARD_FILE;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

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

export function ShareCard({ open, onClose, title: rawTitle, kind, detail, image, url }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const png = useRef<Promise<Blob> | null>(null);
  const [pngFile, setPngFile] = useState<{ key: string; file: File } | null>(null);
  const [nativeFiles, setNativeFiles] = useState(false);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const title = indexDisplayName(rawTitle) ?? rawTitle;
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

  // Draw the PNG as soon as the sheet opens so Copy / Share act inside the click gesture.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const key = `${title}:${kind}:${detail}:${image ?? ""}`;
    const work = renderShareCardPng({ title, kind, detail }, image);
    png.current = work;
    work.then(blob => { if (alive) setPngFile({ key, file: new File([blob], SHARE_CARD_FILE, { type: "image/png" }) }); }).catch(() => {});
    // Browser capability read after mount (not during render) so SSR and hydration match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNativeFiles(canShareImageFiles({ canShare: navigator.canShare?.bind(navigator), share: navigator.share?.bind(navigator) }, () => new File([new Uint8Array(1)], SHARE_CARD_FILE, { type: "image/png" })));
    return () => { alive = false; png.current = null; };
  }, [open, title, kind, detail, image]);

  if (!open) return null;

  const pageUrl = url ?? (typeof window !== "undefined" ? window.location.href : "https://insiderindex.xyz");
  const text = shareText({ title, kind, detail });
  const data = { title: `${title} · InsiderIndex`, text: `${kind} on InsiderIndex.xyz`, url: pageUrl };
  const readyFile = pngFile?.key === `${title}:${kind}:${detail}:${image ?? ""}` ? pngFile.file : null;
  const say = (value: string | null) => { if (value) setNotice({ key: viewKey, text: value }); };
  async function copyImage() {
    const work = png.current ?? renderShareCardPng({ title, kind, detail }, image);
    const result = await copyShareImage({ writeImage, download: downloadImage }, work);
    say(result === "copied" ? "Image copied. Paste it into your post." : result === "downloaded" ? "Your browser blocked image copy, so the image was downloaded." : "The image could not be made. Copy the link instead.");
  }
  async function shareImage() {
    if (!readyFile) return;
    const result = await shareImageNatively({ canShare: navigator.canShare?.bind(navigator), share: navigator.share?.bind(navigator) }, readyFile, { title: data.title, text, url: pageUrl });
    if (result === "shared") return say("Share sheet opened.");
    if (result === "cancelled") return;
    say(noticeFor(await shareLink({ share: navigator.share?.bind(navigator), copy: copyPageLink }, data)));
  }
  async function copy() {
    say(noticeFor(await shareLink({ copy: copyPageLink }, data)));
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
      <div className={styles.actions}>
        {nativeFiles ? <button type="button" className={styles.primary} disabled={!readyFile} onClick={() => void shareImage()}><Icon name="share" size={16} />Share image</button> : null}
        <button type="button" className={nativeFiles ? undefined : styles.primary} onClick={() => void copyImage()}><Icon name="copy" size={16} />Copy image</button>
        <a href={xIntentUrl(text, pageUrl)} target="_blank" rel="noopener noreferrer"><span aria-hidden="true" className={styles.x}>𝕏</span>Share on X</a>
        <button type="button" onClick={() => void copy()}><Icon name="copy" size={16} />Copy link</button>
      </div>
      <p className={styles.hint}>{X_IMAGE_HINT}</p>
      <p className={styles.notice} role="status" aria-live="polite">{notice?.key === viewKey ? notice.text : null}</p>
    </section>
  </div>;
}
