# App logo

`harness-logo-4.svg` is the current logo, the untouched SVG supplied on 2026-09-23
("Logo Harness_4"): the same figure on the green tile, with the circle pulled in
off the tile's edges (r 179.5 about 200.5, 199.5) and the square redrawn around
it. It ships as drawn — no inset and no small-size stroke boost — so at 64px and
below the circle and square fade to a faint line and the figure carries the icon.
Unlike the rounds before it this revision carries no clip path: its own rounded
tile is the first element and nothing is drawn outside it.

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
