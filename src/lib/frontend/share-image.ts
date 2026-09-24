/**
 * Share-card image: drawn on a canvas from the same facts the on-screen card shows (index name, kind,
 * holdings count). No returns or prices are drawn. Browser capabilities are passed in so every outcome
 * (copied, downloaded, shared, cancelled) is explicit and never claimed when it did not happen.
 */

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1560; // 9:13, matching the on-screen card
export const SHARE_CARD_FILE = "insiderindex-share-card.png";
export const X_IMAGE_HINT = "X can't attach an image from a link. Copy the image first, then paste it into your post.";

export type ShareCardFacts = { title: string; kind: string; detail: string };

/** The subset of CanvasRenderingContext2D the card needs (lets tests record the drawing). */
export type ShareCanvasContext = Pick<CanvasRenderingContext2D,
  "fillRect" | "fillText" | "drawImage" | "createLinearGradient" | "measureText" | "save" | "restore"> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
};
export type ShareCardImage = { width: number; height: number; source: CanvasImageSource };

const FONT = '"Avenir Next", Avenir, "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';

/** Greedy word wrap; the last allowed line is ellipsized rather than overflowing the card. */
export function wrapLines(text: string, maxWidth: number, measure: (value: string) => number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line || measure(next) <= maxWidth) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
  while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** Draws the share card: gradient, optional cover image, scrim, brand, kind, title, detail, footer. */
export function drawShareCard(ctx: ShareCanvasContext, facts: ShareCardFacts, image?: ShareCardImage | null, width = SHARE_CARD_WIDTH, height = SHARE_CARD_HEIGHT) {
  const pad = Math.round(width * 0.075);
  ctx.save();
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#111c43");
  background.addColorStop(1, "#ff5a36");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  if (image && image.width > 0 && image.height > 0) {
    // object-fit: cover
    const scale = Math.max(width / image.width, height / image.height);
    const sw = width / scale, sh = height / scale;
    ctx.drawImage(image.source, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, 0, 0, width, height);
  }
  const scrim = ctx.createLinearGradient(0, 0, 0, height);
  scrim.addColorStop(0, "rgba(7,13,31,0.14)");
  scrim.addColorStop(0.38, "rgba(7,13,31,0.12)");
  scrim.addColorStop(1, "rgba(7,13,31,0.92)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = `850 ${Math.round(width * 0.052)}px ${FONT}`;
  ctx.fillText("InsiderIndex®", pad, pad + Math.round(width * 0.05));

  const footerY = height - pad;
  ctx.font = `800 ${Math.round(width * 0.024)}px ${FONT}`;
  ctx.fillText("PUBLIC FILINGS → INDEX", pad, footerY);
  ctx.textAlign = "right";
  ctx.fillText("InsiderIndex.xyz", width - pad, footerY);
  ctx.textAlign = "left";

  const detailSize = Math.round(width * 0.036);
  ctx.font = `500 ${detailSize}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  const detailY = footerY - Math.round(width * 0.09);
  ctx.fillText(facts.detail, pad, detailY);

  const titleSize = Math.round(width * 0.105);
  ctx.font = `760 ${titleSize}px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  const lines = wrapLines(facts.title, width - pad * 2, value => ctx.measureText(value).width, 3);
  const lineHeight = Math.round(titleSize * 0.98);
  const titleBottom = detailY - Math.round(detailSize * 1.4);
  lines.forEach((line, i) => ctx.fillText(line, pad, titleBottom - (lines.length - 1 - i) * lineHeight));

  ctx.font = `850 ${Math.round(width * 0.024)}px ${FONT}`;
  ctx.fillText(facts.kind.toUpperCase(), pad, titleBottom - (lines.length - 1) * lineHeight - titleSize - Math.round(width * 0.012));
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The share image could not be drawn.")), "image/png"); }
    catch (error) { reject(error); }
  });
}

/** Browser only: renders the card to a PNG blob. A cross-origin image that taints the canvas is dropped. */
export async function renderShareCardPng(facts: ShareCardFacts, imageSrc?: string | null): Promise<Blob> {
  const image = imageSrc ? await loadImage(imageSrc) : null;
  const draw = (withImage: HTMLImageElement | null) => {
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_CARD_WIDTH;
    canvas.height = SHARE_CARD_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The share image could not be drawn.");
    drawShareCard(ctx, facts, withImage ? { width: withImage.naturalWidth, height: withImage.naturalHeight, source: withImage } : null);
    return canvasBlob(canvas);
  };
  try { return await draw(image); }
  catch (error) { if (image) return draw(null); throw error; }
}

export type CopyImageResult = "copied" | "downloaded" | "failed";
export type CopyImageBridge = {
  /** navigator.clipboard.write with a ClipboardItem for image/png; absent when unsupported. */
  writeImage?: (png: Promise<Blob>) => Promise<void>;
  download: (png: Blob) => void;
};

/** Copies the PNG to the clipboard; if the browser blocks it, downloads the PNG instead. */
export async function copyShareImage(bridge: CopyImageBridge, png: Promise<Blob>): Promise<CopyImageResult> {
  if (bridge.writeImage) {
    try { await bridge.writeImage(png); return "copied"; } catch { /* fall back to a download */ }
  }
  try { bridge.download(await png); return "downloaded"; } catch { return "failed"; }
}

export type NativeImageShareResult = "shared" | "cancelled" | "unsupported" | "failed";
export type NativeImageShareBridge = {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** Native share sheet with the image file, only when the browser says it can share files. */
export async function shareImageNatively(bridge: NativeImageShareBridge, file: File, data: { title: string; text: string; url: string }): Promise<NativeImageShareResult> {
  const payload: ShareData = { files: [file], title: data.title, text: `${data.text} ${data.url}` };
  let supported = false;
  try { supported = Boolean(bridge.share && bridge.canShare?.(payload)); } catch { supported = false; }
  if (!supported) return "unsupported";
  try { await bridge.share!(payload); return "shared"; }
  catch (error) { return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError" ? "cancelled" : "failed"; }
}

/** True when this browser can put an image file in the native share sheet (typically mobile). */
export function canShareImageFiles(bridge: NativeImageShareBridge, makeFile: () => File): boolean {
  try { return Boolean(bridge.share && bridge.canShare?.({ files: [makeFile()] })); } catch { return false; }
}

/** X web intent. Intents cannot attach images, so the copied card is pasted by the user. */
export function xIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text, url }).toString()}`;
}

export function shareText(facts: Pick<ShareCardFacts, "title" | "kind" | "detail">): string {
  return `${facts.title} (${facts.kind.toLowerCase()}, ${facts.detail}) on InsiderIndex, built from public stock disclosures.`;
}
