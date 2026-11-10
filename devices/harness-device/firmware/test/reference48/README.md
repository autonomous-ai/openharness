# Renderer reference before the overnight optimizations

This is a byte-for-byte capture of the `.48` text compositor, before the glyph cache,
packed artwork, ASCII fast paths, and curved glyph bounds. It was made before `.49`.
The file hash and snapshot path are recorded in `source-hashes.json`. (The octopus layout
captured beside it is gone with the octopus; the layout benchmark now builds the Focus face
for both renderers.)

The small wrapper translation unit gives public functions an `ht48_` namespace.
Both versions use the same font atlases, geometry table, scene structures, input
fixtures, and display driver. (The native regression that compared their complete scenes, damage
rectangles and final pixels drew the octopus and went with it; the hardware A/B benchmark is
the check now.)

This is a rendering reference, not the stock LVGL UI. It already includes the
larger `.48` reading layout. Timing it does not measure touch sampling, app command
delivery, speech recognition, panel scanout, or time to photons.

These sources and the unpacked reference artwork are excluded from normal images.
Do not optimize them or use their image size as the production image size.
