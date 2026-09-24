/**
 * Regenerate the homepage hero collage as an alpha-edged cut-out so it sits on
 * the page background in both themes instead of reading as a pasted rectangle.
 *
 *   node --experimental-strip-types scripts/cutout-editorial-collage.mts
 *
 * Source: public/index-assets/home/editorial-collage.png (unchanged, see
 * EDITORIAL-COLLAGE-SOURCE.md). Output: editorial-collage.webp beside it.
 * Only the outer paper background (flood-filled from the frame) becomes
 * transparent; every drawn element, paper scrap and pixel colour is kept.
 * Uses `sharp`, which ships with Next.js image optimisation.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index-assets", "home");
const source = path.join(dir, "editorial-collage.png");
const output = path.join(dir, "editorial-collage.webp");

/** Outer paper: bright, near-neutral pixels reachable from the frame. */
const PAPER_MIN_LUMA = 232;
const PAPER_MAX_CHROMA = 18;
/** Die-cut margin kept around every element, in source pixels. */
const CUT_MARGIN = 3;
/** Paper kept behind the "Same" headline, which is lettered straight onto the outer paper. */
const HEADLINE_BOX = { width: 200, height: 70 };
const HEADLINE_INK_LUMA = 140;
const HEADLINE_MARGIN = 9;
/** Softening of the cut edge and the fade where art touches the frame. */
const EDGE_BLUR = 1.4;
const FRAME_FADE = 10;

const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h, channels } = info;
const size = w * h;
const luma = (i: number) => data[i * channels] * 0.299 + data[i * channels + 1] * 0.587 + data[i * channels + 2] * 0.114;
const chroma = (i: number) => {
  const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
  return Math.max(r, g, b) - Math.min(r, g, b);
};

function dilate(mask: Uint8Array, radius: number): Uint8Array {
  const out = new Uint8Array(size);
  const offsets: [number, number][] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius + radius) offsets.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 255;
    }
  }
  return out;
}

// Flood-fill the outer paper from the frame.
const paper = new Uint8Array(size);
const queue: number[] = [];
const visit = (i: number) => {
  if (!paper[i] && luma(i) >= PAPER_MIN_LUMA && chroma(i) < PAPER_MAX_CHROMA) { paper[i] = 1; queue.push(i); }
};
for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
while (queue.length) {
  const i = queue.pop()!;
  const x = i % w, y = (i / w) | 0;
  if (x > 0) visit(i - 1);
  if (x < w - 1) visit(i + 1);
  if (y > 0) visit(i - w);
  if (y < h - 1) visit(i + w);
}

const keep = new Uint8Array(size);
for (let i = 0; i < size; i++) keep[i] = paper[i] ? 0 : 255;
const ink = new Uint8Array(size);
for (let y = 0; y < HEADLINE_BOX.height; y++) for (let x = 0; x < HEADLINE_BOX.width; x++) if (luma(y * w + x) < HEADLINE_INK_LUMA) ink[y * w + x] = 255;
const headline = dilate(ink, HEADLINE_MARGIN);
for (let i = 0; i < size; i++) if (headline[i]) keep[i] = 255;

const soft = await sharp(Buffer.from(dilate(keep, CUT_MARGIN)), { raw: { width: w, height: h, channels: 1 } })
  .blur(EDGE_BLUR).extractChannel(0).raw().toBuffer();

const rgba = Buffer.alloc(size * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  const t = Math.min(1, (Math.min(x, y, w - 1 - x, h - 1 - y) + 0.5) / FRAME_FADE);
  rgba[i * 4] = data[i * channels];
  rgba[i * 4 + 1] = data[i * channels + 1];
  rgba[i * 4 + 2] = data[i * channels + 2];
  rgba[i * 4 + 3] = Math.round(soft[i] * t * t * (3 - 2 * t));
}

await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
  .webp({ quality: 88, alphaQuality: 100, effort: 6, smartSubsample: true })
  .toFile(output);
console.log(`wrote ${path.relative(process.cwd(), output)} (${w}×${h}, alpha cut-out)`);
