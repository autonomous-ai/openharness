# Creature gallery / study 02

September 27, 2026. Firmware `0.0.87-gallery.4`. Twenty entries: all ten original creatures plus ten new text-animation studies. Only the artwork appears on the display. No title, status, instructions, voice, agent commands or companion mechanics.

The subsequent [connected octopus build](README.md) uses entry 11 with the live Harness controls. This gallery remains a separate, preserved visual comparison.

## Controls

- Opens on **11 — Octopus / ASCII**. Swipe left for 12, then 13, and so on. Swipe right for the previous entry. Both ends wrap.
- Swipe vertically to change the animation. New entries cycle through **original timing → half speed → double speed → quarter speed**. The original ten retain their four moods.
- Tap a new entry to replay its loop; tap an original creature for its existing brief reaction.
- PWR and the five-minute screen timeout still work. The first touch after sleep only wakes the display.
- Sound stays muted. The USB connection provides device health and firmware access, with app actions disabled.

The selected mode carries between entries for comparison. This is a visual player, not the future companion behavior system.

## Device feedback

After installation, the user said **“i love the octopus!”** They subsequently clarified **“i like the text one more”**: **11 — Octopus / ASCII** is the preferred rendering. After seeing its actual installed text frame in chat, they confirmed **“yeah this is it.”** This exact text octopus is the confirmed visual reference for the next iteration. Keep the block rendering and all other entries for comparison; no app wiring or additional behavior was requested by this feedback.

## New entries

| # | Study | Source and adaptation |
|---|---|---|
| 11 | **Octopus / ASCII** | The [Brrtfetch octopus](https://github.com/ferrebarrat/brrtfetch/blob/main/gifs/defaults/brrt.gif), converted before the build into a punctuation/letter density ramp. Every second source pose is retained, with the combined original holds: 63 poses across 5.21 seconds. |
| 12 | **Octopus / blocks** | The same movement rendered with standard Unicode shade/block characters. Its 39 × 19 grid uses an 8 × 16 glyph atlas. This comparison isolates the visual vocabulary while preserving the source animation. |
| 13 | **Tiny cat** | The user's three-line cat, with newly authored blink, glance and pleased expressions. Long quiet holds between small changes. |
| 14 | **Party Parrot** | [John Hobbs's terminal-parrot](https://github.com/jmhobbs/terminal-parrot), ten original ASCII frames at 100 ms per frame, shown in one color. |
| 15 | **Stone giant** | [Stone Story RPG](https://stonestoryrpg.com/), character grids recovered from the [published animation](https://clan.akamai.steamstatic.com/images/30519309/0fc363cf3b74de81fddd4338632f7f6856285ae6.gif). Source holds retained; the separate player is cropped out. |
| 16 | **Stone spider** | Character grids recovered from the [published Stone Story animation](https://clan.fastly.steamstatic.com/images/30519309/55db1b7f85cea872b4b1a1782ef56fdabe0c3be1.gif). Source holds retained. Accented eye symbols and infinity are approximated as printable `o` and `8`; source colors become one foreground color. |
| 17 | **Stark dragon** | Joan G. Stark's signed, front-facing [dragon](https://www.asciiart.eu/mythology/dragons), with new blink and wing-tip poses. The `jgs` signature remains. This is a second Stark reference that fits the screen; the previously documented, larger fire-breathing dragon remains a research reference. The added animation is ours, not the artist's. |
| 18 | **Turning face** | Newly authored poses inspired by [Adel Faure's Face Study](https://adelfaure.net/docs/lures/ascii_faces.gif). This is a simplified turning-head study, not a transcription of the artist's full animation. |
| 19 | **Nyan / blocks** | The original twelve-frame [Nyan Cat CLI matrix](https://github.com/klange/nyancat/blob/master/src/animation.c), cropped to the cat and mapped to monochrome Unicode shade blocks. Original animation credited to prguitarman; terminal project by K. Lange. |
| 20 | **Desk companion** | Polyducks's *Button Presser* (2021), [source preview](https://adelfaure.net/docs/lures/POLYDUCKS-BUTTON_PRESSER.GIF), cropped to the companion and converted to monochrome Unicode shade blocks. Eight source frames and their encoded holds. [Artist attribution](https://adelfaure.net/docs/lures/). |

Entries 01–10 remain Miso, Hopper, Pip, Rook, Moo, Boo, Sprout, Drift, Bolt and Echo. Their artwork and moods remain in [study 01](CREATURE_GALLERY.md); its labels have been removed in this build so both sets show just the art.

The full [reference collection](CREATURE_REFERENCES.md) remains available. Following the comparison, the user confirmed the text octopus as the preferred visual reference. Agent-state behavior remains deferred. The third-party art is credited here for this local visual comparison.

## Representation and build

All installed character poses are text. GIF decoding and image conversion happen on the computer during preparation; the device receives immutable strings and frame holds. There is no on-device GIF/image decoder, raster character sprite, browser or animation framework.

- Existing C / ESP-IDF renderer, partial-region updates and two DMA strip buffers.
- 227 new stored text poses, **263,599 bytes** including UTF-8 and string terminators. The original 60 poses remain.
- Six ASCII font sizes derived from OFL Jgs7 plus two compact, geometrically generated Unicode Block Elements atlases: **50,369 bytes** total glyph data.
- **32-byte** gallery state; no gallery heap allocation or new framebuffer.
- Original frame holds determine wake-ups. Unchanged text produces no screen transfer. Vertical speed choices rescale playback locally.
- Unicode-only atlases safely treat spaces and unsupported glyphs as empty cells. A compositor regression checks rendering and incremental damage without indexing before the atlas.

The canonical editable text and credits are in [clips.json](assets/creature-references/clips.json). Run [gen_creature_clips.py](../../firmware/scripts/gen_creature_clips.py) to regenerate the C data and [gen_creature_font.py](../../firmware/scripts/gen_creature_font.py) for the font atlases. Builds need no network or original GIFs.

The font source and [OFL license](../../firmware/fonts/Jgs-OFL.txt) remain in the firmware tree. The derived fonts use the name *Habitat ASCII Art*; the block glyphs are generated independently.

## Validation

The native firmware suite passed under undefined-behavior and bounds sanitizers. Gallery checks cover **25,600 scenes**, all 80 entry/mode combinations, glyph support, row byte limits, scene bounds, wrapping, interrupted contacts and time wrap. Driver traces retain the wake/sleep recovery checks. The Unicode compositor regression also passed.

Round-screen contact sheet (local experiment artifact) uses the actual production C compositor. Every entry was visually inspected at that mask. Physical brightness and how each motion feels on the desk remain for the user to judge.

The image is **816,512 bytes**, SHA-256 `775e181f551876f1407104e920526cb4e3976f137b70374b50a1a92848805009`. It fits the existing application partition without changing partition layout or NVS. This is larger than gallery .3 because it contains substantially more artwork; no new latency or performance-improvement claim is made.

The previous gallery .3 and daily-use Habitat .25 images remain available for restoration. Deployment evidence (local experiment artifact) confirms both flash-write hashes, the expected device MAC and .4 firmware hello, live animation, touch activity, zero touch-read failures and mute enabled. The flashing wrapper reported a serial error during the final watchdog reset; the independent live hello and heartbeats confirmed that the new image booted successfully. Host and desktop binaries were preserved.
