/** Original editorial illustrations. No logos, figures or copy embedded in the cover. */
export const THEME_ART: Record<string, { src: string; thumb: string; alt: string }> = {
  "idx-theme-mag7-caucus": {
    "src": "/index-assets/themes/idx-theme-mag7-caucus-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-mag7-caucus-thumb.webp",
    "alt": "An oversized seven keycap wearing sunglasses."
  },
  "idx-theme-silicon-hill": {
    "src": "/index-assets/themes/idx-theme-silicon-hill-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-silicon-hill-thumb.webp",
    "alt": "A microchip with a miniature green mountain."
  },
  "idx-theme-capitol-cluster": {
    "src": "/index-assets/themes/idx-theme-capitol-cluster-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-capitol-cluster-thumb.webp",
    "alt": "A violet horseshoe magnet gathering silver spheres."
  },
  "idx-theme-bipartisan-handshake": {
    "src": "/index-assets/themes/idx-theme-bipartisan-handshake-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-bipartisan-handshake-thumb.webp",
    "alt": "A handshake between orange and violet sleeves."
  },
  "idx-theme-fresh-ink": {
    "src": "/index-assets/themes/idx-theme-fresh-ink-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-fresh-ink-thumb.webp",
    "alt": "A bright rubber stamp hovering over a newly marked filing."
  },
  "idx-theme-beta-caucus": {
    "src": "/index-assets/themes/idx-theme-beta-caucus-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-beta-caucus-thumb.webp",
    "alt": "A sleeping piggy bank with an eye mask and a single coin."
  },
  "idx-theme-whips-desk": {
    "src": "/index-assets/themes/idx-theme-whips-desk-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-whips-desk-thumb.webp",
    "alt": "A leather wallet holding three oversized bank cards."
  },
  "idx-theme-capitol-arsenal": {
    "src": "/index-assets/themes/idx-theme-capitol-arsenal-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-capitol-arsenal-thumb.webp",
    "alt": "An oversized folded paper aircraft on a sage background."
  },
  "idx-theme-dual-lock": {
    "src": "/index-assets/themes/idx-theme-dual-lock-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-dual-lock-thumb.webp",
    "alt": "Two interlocking padlocks in blue and golden yellow."
  },
  "idx-theme-house-heat": {
    "src": "/index-assets/themes/idx-theme-house-heat-cover.webp",
    "thumb": "/index-assets/themes/idx-theme-house-heat-thumb.webp",
    "alt": "A hot house-shaped tile popping from a blue toaster."
  }
};
export function themeArtFor(id: string) { return THEME_ART[id] ?? null; }
