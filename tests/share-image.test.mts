import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canShareImageFiles, copyShareImage, drawShareCard, shareImageNatively, shareText, wrapLines, xIntentUrl, X_IMAGE_HINT, type ShareCanvasContext } from "../src/lib/frontend/share-image.ts";
import { indexDisplayName } from "../src/lib/frontend/index-name.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { ShareCard } = await import("../src/components/share-card.tsx");

function recordingContext() {
  const texts: string[] = [];
  const images: unknown[] = [];
  const gradient = { addColorStop() {} } as unknown as CanvasGradient;
  const ctx = {
    fillStyle: "", font: "16px sans-serif", textBaseline: "alphabetic", textAlign: "left",
    fillRect() {}, save() {}, restore() {},
    fillText(text: string) { texts.push(text); },
    drawImage(...args: unknown[]) { images.push(args); },
    createLinearGradient: () => gradient,
    measureText: (value: string) => ({ width: value.length * 50 }) as TextMetrics,
  } as unknown as ShareCanvasContext;
  return { ctx, texts, images };
}

test("share card image draws the real index name, kind, holdings count and brand, and no returns", () => {
  const { ctx, texts, images } = recordingContext();
  drawShareCard(ctx, { title: "Nancy P Index", kind: "Person index", detail: "18 holdings" }, { width: 400, height: 600, source: {} as CanvasImageSource });
  assert.ok(texts.includes("Nancy P Index"));
  assert.ok(texts.includes("PERSON INDEX"));
  assert.ok(texts.includes("18 holdings"));
  assert.ok(texts.includes("InsiderIndex®"));
  assert.ok(texts.includes("InsiderIndex.xyz"));
  assert.doesNotMatch(texts.join(" "), /%|return|\$/i, "no fabricated performance on the card");
  assert.equal(images.length, 1, "cover image drawn once");
  const bare = recordingContext();
  drawShareCard(bare.ctx, { title: "Mag7 Caucus", kind: "Theme index", detail: "7 stocks" }, null);
  assert.equal(bare.images.length, 0, "no image still yields a card");
  assert.ok(bare.texts.includes("Mag7 Caucus"));
});

test("long titles wrap and ellipsize within the card", () => {
  const measure = (value: string) => value.length * 10;
  assert.deepEqual(wrapLines("Nancy P Index", 200, measure, 3), ["Nancy P Index"]);
  const lines = wrapLines("A very long thematic index name that keeps going and going", 120, measure, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines[2]!.endsWith("…"));
  assert.ok(lines.every(line => measure(line) <= 120));
});

test("copy image uses the clipboard, falls back to a download, and never claims a copy that failed", async () => {
  const png = Promise.resolve(new Blob(["png"], { type: "image/png" }));
  let written: Promise<Blob> | null = null;
  assert.equal(await copyShareImage({ writeImage: async value => { written = value; }, download: () => assert.fail("no download after a copy") }, png), "copied");
  assert.equal(written, png);
  let downloaded: Blob | null = null;
  assert.equal(await copyShareImage({ writeImage: async () => { throw new Error("NotAllowedError"); }, download: blob => { downloaded = blob; } }, png), "downloaded");
  assert.ok(downloaded);
  assert.equal(await copyShareImage({ download: () => {} }, png), "downloaded", "no image clipboard: download");
  assert.equal(await copyShareImage({ download: () => {} }, Promise.reject(new Error("draw failed"))), "failed");
});

test("native share sends the image file only when the browser can share files", async () => {
  const file = new File(["png"], "card.png", { type: "image/png" });
  const data = { title: "Nancy P Index · InsiderIndex", text: "Nancy P Index on InsiderIndex", url: "https://insiderindex.xyz/indexes/insiderindex-nancy-pelosi" };
  let sent: ShareData | null = null;
  assert.equal(await shareImageNatively({ canShare: () => true, share: async value => { sent = value; } }, file, data), "shared");
  assert.deepEqual((sent as ShareData | null)?.files, [file]);
  assert.match(String((sent as ShareData | null)?.text), /insiderindex\.xyz\/indexes/);
  assert.equal(await shareImageNatively({ canShare: () => false, share: async () => assert.fail("no share") }, file, data), "unsupported");
  assert.equal(await shareImageNatively({ share: async () => assert.fail("no share") }, file, data), "unsupported");
  assert.equal(await shareImageNatively({ canShare: () => true, share: async () => { throw { name: "AbortError" }; } }, file, data), "cancelled");
  assert.equal(canShareImageFiles({ canShare: () => true, share: async () => {} }, () => file), true);
  assert.equal(canShareImageFiles({ canShare: () => { throw new Error("nope"); }, share: async () => {} }, () => file), false);
});

test("Share on X uses the post intent with short text and the index URL", () => {
  const text = shareText({ title: "Nancy P Index", kind: "Person index", detail: "18 holdings" });
  const href = new URL(xIntentUrl(text, "https://insiderindex.xyz/indexes/insiderindex-nancy-pelosi"));
  assert.equal(href.origin + href.pathname, "https://x.com/intent/post");
  assert.equal(href.searchParams.get("url"), "https://insiderindex.xyz/indexes/insiderindex-nancy-pelosi");
  assert.match(href.searchParams.get("text")!, /^Nancy P Index/);
  assert.ok(text.length < 200);
  assert.equal(indexDisplayName("Nancy P Index · InsiderIndex"), "Nancy P Index");
});

test("share sheet offers Copy image, Share on X with the paste hint, and Copy link", () => {
  const html = renderToStaticMarkup(createElement(ShareCard, {
    open: true, onClose() {}, title: "Nancy P Index · InsiderIndex", kind: "Person index", detail: "18 holdings",
    image: "/portraits/nancy-pelosi.jpg", url: "https://insiderindex.xyz/indexes/insiderindex-nancy-pelosi",
  }));
  assert.match(html, /Copy image/);
  assert.match(html, /Share on X/);
  assert.match(html, /href="https:\/\/x\.com\/intent\/post\?text=[^"]*url=https%3A%2F%2Finsiderindex\.xyz%2Findexes%2Finsiderindex-nancy-pelosi"/);
  assert.ok(html.includes(X_IMAGE_HINT.replace("'", "&#x27;")));
  assert.match(html, /Copy link/);
  assert.match(html, /<h2>Nancy P Index<\/h2>/, "brand suffix is not repeated in the title");
});
