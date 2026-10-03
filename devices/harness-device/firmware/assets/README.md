# Art the glyphs are built from

Nothing here is read at runtime — the device has no image decoder and no font engine.
`scripts/gen_habitat_fonts.py` turns each file into a glyph and quantises it to the 2 bits per pixel
every habitat font uses.

## `sparkle.png`, `sparkle_fill.png` — from the old firmware

`icon_sparkle` and `icon_sparkle_fill` from `main/ui/icons_voice.c`, which was deleted with the LVGL
renderer on 2026-09-29. Scaled into their cell.

**The old icons' alpha channel is not the mark.** They were exported as ARGB8888 in B,G,R,A order.
The disc icons (`icon_v_mic`, `icon_v_rec`, `icon_v_orb`) are CIRCULAR-MASKED — alpha 0 outside the
coloured disc, 255 across it — so alpha traces the disc and says nothing about the shape; the mark
comes out of the colour channels instead. The sparkles are not on a disc, and their alpha is the
shape.

Regenerate from git if they are ever needed again:

    git show <rev>:devices/harness-device/firmware/main/ui/icons_voice.c

## `engines/*.png` — from the old firmware

`main/ui/icons_engine.c`, same export and the same disc caveat. Scaled to cap height.
