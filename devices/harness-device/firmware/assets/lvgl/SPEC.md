# The live dial, as data

What the Focus skin takes from the LVGL firmware that shipped as **0.0.86**, and where from. Regenerate
everything here with `python3 devices/harness-device/firmware/scripts/gen_lvgl_assets.py`.

**Provenance.** `0.0.86.bin` on GCS: Last-Modified 24 Sep 2026 11:17:54 GMT, 3,175,728 bytes. The
version bump `e96fc50c` landed 17 s later, so the build is `e96fc50c^`. LVGL 9.5.0 (component hash
184e5325…). After the release, e5c13558 moved the pill's bell to montserrat_22; the device draws it
in **montserrat_14**, and so does this.

## Fonts

lv_font_conv `--bpp 4 --no-compress --no-prefilter`, class kerning, copied glyph for glyph. LVGL
decode, reproduced in terminal.c: `adv_w` is 1/16 px and the advance is
`(adv_w + kern + 8) >> 4` per letter pair; a letter's box sits at `pen + ofs_x`,
`top + (line - base) - box_h - ofs_y`; coverage `v * 17` is blended with `lv_color_16_16_mix`.

| use | font | line / base | bytes kept |
|---|---|---|---|
| the close cross | `montserrat_22` | 24 / 4 | 161 |
| the bell glyph in the pill | `montserrat_14` | 16 / 3 | 131 |

## Icons

ARGB8888 (B,G,R,A, straight alpha), blended with `lv_color_24_16_mix`.

| icon | source | drawn |
|---|---|---|
| 14 engine marks | `icons_engine.c`, 20×20 | header: scaled 358/256 about (10,10) → 27 px from box offset 0 (LVGL's transform, ported); inbox: 20 native |
| Claude | white mark, shape in alpha | recoloured `0xcc7c5e`, alpha kept; the others keep their colours |
| microphone | `icon_act_voice`, 44×44, `#00ff2f` baked | native, centred on (233, 393) |
| bell, cross | FontAwesome U+F0F3 / U+F00D in Montserrat | text |

## Layout of the LVGL firmware (COL_FG `0xeaeaf0`, COL_MUTED `0x8a8a99`)

Historical: the face names below are the old firmware's Geist ones. The Focus skin now sets every word and
number in Inter (focus_faces.c, gen_focus_faces.py, docs/plans/2026-10-03-inter-sf-compact.md); only the
boxes, colours and spacing here still apply.

| item | values |
|---|---|
| header | 384 wide at x 41: 28 mark + 10 gap + name `geist_med_38`; 1 line with a recap or a turn, up to 2 when empty |
| tab pill | header top − 51 (y 68 with a card), 41 tall, 12 px pad, fully round, `0x1c1e24`@70% (= `0x141519` on black), 1 px `0x3a3f4b`; `montserrat_24`, ≤ 340 px "…" (here ≤ 314 with its pad, the widest inside r 230) |
| recap card | y 191, 384×119, radius 28, `0x23252f`, 1 px `0xa6a6a6`@20% (= `0x3d3f47`), pad 18/19; 2 lines of `geist_med_28`, 38 + 3 spacing, 346 wide, "…"; red `0xff5a5a` on error |
| no card | the name + body block is centred: top = 233 − ⌊(name + 21 + body) / 2⌋, clamped to [75, 302 − block] |
| working | `geist_med_32` `0x00ff2f`, "verb… 34s" (then "1m 05s") |
| empty | "No activity yet", `geist_reg_38` `0x585863`, 276 wide, wraps |
| bell pill | y 22, 32 tall, `0x006fff`, pad 13/4, gap 6: bell `montserrat_14`, count `montserrat_22`, COL_FG |
| drawer | ground `0x16161c`; close pill 60×32 at (203,16), COL_FG@10 %; list at (53,107) 360×320, gap 12 |
| drawer card | 360 wide, radius 26, `0x23252f`, 1 px 20 %, pad 16/14, row gap 8: machine `geist_reg_20` muted; [20 px mark or 8 px `0x04fe08` dot] 8 gap, name `geist_reg_20` `0x04fe08`; message `geist_reg_25` COL_FG, wraps, ≤ 100 chars "…" |
