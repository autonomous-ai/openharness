# App logo

`harness-logo-4.svg` is the current logo, the untouched SVG supplied on 2026-09-23
("Logo Harness_4"): the same figure on the green tile, with the circle pulled in
off the tile's edges (r 179.5 about 200.5, 199.5) and the square redrawn around
it. It ships as drawn — no inset and no small-size stroke boost — so at 64px and
below the circle and square fade to a faint line and the figure carries the icon.
Unlike the rounds before it this revision carries no clip path: its own rounded
tile is the first element and nothing is drawn outside it.

The macOS menu bar uses the team's updated September 30 portrait symbols from
`team-symbols-2026-09-30/Symbol Harness_Lightmode.svg` and
`team-symbols-2026-09-30/Symbol Harness_Darkmode.svg`, drawn at 17pt in a 28 × 22pt
footprint. The light variant has an outlined tile and the dark variant has a
filled tile; both preserve the supplied vector paths and transparent cutouts.
Their shipping copies live in
`desktop/macos/Runner/Assets.xcassets/HarnessStatusIcon.imageset/` as light and
dark appearance variants. AppKit tints the template for the menu bar and
composes the unread badge at runtime, overlapping the lower-right corner.
The badge is absent at zero, and its footprint stays stable as the count changes.

Four app icon proposals reuse the Departure Mono `hn`, with green, graphite,
and light backgrounds. [Review them in Dock mockups](hn-dock-options/dock-options.png);
the proposed icon is under the Harness label and the current app icon is at the
right. These are preview assets. Regenerate them on a Mac with Visual Studio Code
installed, from the repository root:

```sh
swift docs/branding/app-logo/render-hn-dock-options.swift
```

The team's initial September 30 portrait symbols are preserved alongside the
updated sources in `team-symbols-2026-09-30/`. [Review the original symbols in the
Dock and menu bar](team-symbols-2026-09-30/team-icons-preview.png). These earlier
preview assets keep the original transparent cutouts; the Dock background shows
through the face. Their menu bar examples use the previous 20pt size. Regenerate
these archived previews from the repository root on a Mac with Xcode installed:

```sh
swift docs/branding/app-logo/render-team-symbols.swift
```

Earlier rounds, kept for reference:

- `harness-logo-3.svg`: the untouched SVG supplied on 2026-09-22, which shipped
  with the circle touching the top of the tile.

- `harness-polymath.svg`: the untouched SVG supplied on 2026-09-21.
- `harness-polymath-v2.svg`: its refinement, which shipped in #184 on the macOS
  icons and the in-app logo only — dark green circle and square at 82% opacity
  with a 2.8-unit outline, diagonals removed, figure and geometry inset by 6%,
  and strokes strengthened at small sizes. `geometry-comparison.png` compares
  the original with two refinement options.

## Regenerate

From the repository root on macOS:

```sh
swift docs/branding/app-logo/render-app-icon.swift
```

The source is the macOS `app_icon.svg`, which wraps the 400-unit artwork in the
existing 54-pixel transparent margin on a 1024-pixel canvas. The renderer draws
every app icon from it:

- macOS: all seven icon sizes, plus the same art at 512px for Linux
  (`desktop/linux/harness.png`) and at 256px for the in-app logo in both apps
  (`desktop/assets/app_icon.png`, `mobile/assets/app_icon.png`).
- Windows and Android: cropped to the tile, with the design's rounded corners.
- iOS: cropped to the tile with square corners and no alpha, every slot listed in
  the asset catalog's `Contents.json`. iOS applies its own mask.
- Web: the browser app's `favicon.ico` and 192/512 install icons in `desktop/web/`
  with the tile's rounded corners, and its `apple-touch-icon.png` with square ones,
  which iOS masks. The website gets the same favicon and its `public/icon.svg`.
  Bump the `?v=` on their links (`desktop/web/index.html`,
  `website/src/app/layout.tsx`) so browsers drop the cached icon.

To adopt a new logo, add its untouched SVG here, put its 400x400 markup inside
the `<g transform>` in `app_icon.svg`, and rerun the renderer.

## Backups and restore

Both backups preserve exact file copies and SHA-256 manifests of the desktop
icons:

- `previous-2026-09-21/`: the original terminal logo, including macOS, shared,
  and Windows icons, with its source commit recorded.
- `green-v1/`: the first green logo preview with the white circle, square,
  and diagonals.

Restore one from the repository root:

```sh
cp -R docs/branding/app-logo/green-v1/desktop/. desktop/
cp -R docs/branding/app-logo/previous-2026-09-21/desktop/. desktop/
```

Rebuild the desktop app after restoring. A backup restores the desktop icons and
their macOS source SVG only; rerunning the renderer afterwards carries that logo
to Linux and mobile as well. The v2 icons are in the history of #184.
