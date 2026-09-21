# App logo previews

`harness-polymath.svg` is the untouched SVG supplied on 2026-09-21.
`harness-polymath-v2.svg` is the geometry refinement used by the current preview:

- Dark green circle and square at 82% opacity, with a 2.8-unit outline.
- Diagonal lines removed so the circle and square read clearly.
- Figure and geometry inset by 6% to separate the circle from the tile edge.
- The figure path, background gradient, and tile shape are unchanged.

The macOS source wraps the 400-unit artwork in the existing 54-pixel transparent
margin on a 1024-pixel canvas. The raster exports strengthen the circle and square
at small sizes: a minimum 0.5px stroke at 16px and 0.65px at the other sizes.
`geometry-comparison.png` compares the original with two refinement options;
its small previews show the base vector before the macOS margin and optical
stroke adjustments.

This preview updates the macOS icons and the shared in-app logo. Windows and
mobile icons are unchanged.

## Regenerate

From the repository root on macOS:

```sh
swift docs/branding/app-logo/render-app-icon.swift
```

The renderer reads the macOS `app_icon.svg`, exports all seven icon sizes, and
copies the 256px icon to `desktop/assets/app_icon.png`.

## Backups and restore

Both backups preserve exact file copies and SHA-256 manifests:

- `previous-2026-09-21/`: the original terminal logo, including macOS, shared,
  and Windows icons, with its source commit recorded.
- `green-v1/`: the first green logo preview with the white circle, square,
  and diagonals.

Restore the first green preview from the repository root:

```sh
cp -R docs/branding/app-logo/green-v1/desktop/. desktop/
```

Or restore the original terminal logo:

```sh
cp -R docs/branding/app-logo/previous-2026-09-21/desktop/. desktop/
```

Rebuild the desktop app after restoring. Restoring either backup also restores
its macOS source SVG; the v2 renderer above is specifically for the v2 geometry.
