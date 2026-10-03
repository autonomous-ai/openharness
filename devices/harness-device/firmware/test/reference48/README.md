# Renderer reference before the overnight optimizations

These are byte-for-byte captures of the `.48` text compositor and octopus layout,
before the glyph cache, packed artwork, ASCII fast paths, and curved glyph bounds.
The terminal capture was made before `.49`; the unchanged octopus implementation
and unpacked poses were captured before `.50`. File hashes and snapshot paths are
recorded in `source-hashes.json`.

The small wrapper translation units give public functions an `ht48_` namespace.
Both versions use the same font atlases, geometry table, scene structures, input
fixtures, and display driver. A native regression compares their complete scenes,
damage rectangles, and final pixels before the hardware A/B benchmark is run.

This is a rendering reference, not the stock LVGL UI. It already includes the
larger `.48` reading layout. Timing it does not measure touch sampling, app command
delivery, speech recognition, panel scanout, or time to photons.

These sources and the unpacked reference artwork are excluded from normal images.
Do not optimize them or use their image size as the production image size.
