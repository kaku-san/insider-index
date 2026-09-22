# Content-pack assets

The visual and copy assets added for the public index catalog come from the supplied
`InsiderIndex-complete-content-visual-pack` source bundle. The runtime copies live
under `public/index-assets/`; source material is not fetched by the client.

## Included assets

- `home/` — supplied homepage art.
- `share/` — one 1080×1350 share card for each of the 20 published index IDs; route
  metadata uses the matching card for Open Graph and Twitter.
- `logos/actual/` and `logos/fallback/` — 17 supplied company marks and 196 local
  ticker fallbacks. Marks are identification only; see the source bundle's
  `ASSET_SOURCES.csv` for trademark and redistribution guidance.
- `public/portraits/nancy-pelosi.jpg`, `josh-gottheimer.jpg`, and
  `marjorie-taylor-greene.jpg` — higher-resolution official portraits replacing the
  prior thumbnails. Their source pages are listed below.

## Portrait attribution

| Person | Source | License note |
| --- | --- | --- |
| Nancy Pelosi | <https://commons.wikimedia.org/wiki/File:Nancy_Pelosi_official_portrait.jpg> | Public domain — U.S. Congress |
| Josh Gottheimer | <https://commons.wikimedia.org/wiki/File:Josh_Gottheimer,_official_portrait,_115th_Congress_(cropped).jpg> | Public domain — U.S. Congress |
| Marjorie Taylor Greene | <https://commons.wikimedia.org/wiki/File:Marjorie_Taylor_Greene_117th_Congress_portrait_(cropped).jpeg> | Public domain — U.S. Congress |

The remaining person portraits are unchanged. Do not introduce remote portrait or
logo fallbacks: the catalog needs to remain readable when third-party hosts fail.
