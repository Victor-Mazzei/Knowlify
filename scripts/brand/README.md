# Brand assets

The vector sources live in `assets/brand/`; every raster file is generated and
committed, so normal builds (CI, Docker, Tauri) never rasterize anything.

| Source | Use |
| --- | --- |
| `logo-mark.svg` | master, follows `prefers-color-scheme` |
| `logo-mark-light.svg` / `logo-mark-dark.svg` | fixed variants for rasterizers and banners |
| `logo-mark-mono.svg` | bare mark in `currentColor` |
| `logo-mark-small.svg` | favicon geometry (16 px grid) |
| `logo-mark-maskable.svg` | full-bleed PWA icon; mark inside the 80% safe circle |

## Regenerate

```bash
npm install
npm run brand:build
npx --yes --package @tauri-apps/cli@^2 tauri icon assets/brand/logo-1024.png \
  -o apps/desktop/src-tauri/icons
rm -rf apps/desktop/src-tauri/icons/android apps/desktop/src-tauri/icons/ios
```

`brand:build` writes `assets/brand/logo-1024.png`, the files in
`apps/web/public/` and `assets/brand/banner.png`, and prints a local
preview at `$TMPDIR/knowlify-brand/contact-sheet.html` (not committed). The
Tauri command writes the desktop icon set; the mobile folders are removed
because Knowlify has no mobile target.

The build script regenerates every raster and the icon set; the committed files
must match it. There is no separate tooling test suite.
