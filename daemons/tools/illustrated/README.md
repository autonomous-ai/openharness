# Illustrated desktop daemons

This is the host-side source for the desktop's ten illustrated daemons and egg artwork.
It is independent of the firmware build. `daemon_art.py` is a local copy of the
approved Pro illustration source; `generate.py` exports all ten and eggs.
No runtime Python, SVG parsing, external bitmap, or network service is involved.

Regenerate with Python 3, Pillow and NumPy:

```sh
python3 daemons/tools/illustrated/generate.py
```

The exporter writes identical zero-based asset keys under
`desktop/assets/daemon-art/slot/` (64 × 64) and `portrait/` (350 × 350).
`manifest.json` records all files, frame counts, source hashes, dimensions,
compressed bytes, image hashes and alpha bounds. Every base PNG is reopened
and checked for lossless equality and a fully transparent outer pixel border.

Daemon keys are `{species}_{baby|young|adult}_{mood}_{frame}`. Versions `0.1`, `1.0`, and
`2.0` map to those growth stages. All eight roster moods use four frames except
`fail`, which is a still; `blink` is one additional frame. Each species has 90 keys.
The hatchling's head is proportionally larger with short curling arms. The
adult preserves the approved purple octopus shape, cream eyes and pink cheeks.

Egg keys are `egg_{kind}_{stage}_{frame}`. The eight roster kinds each have
28 keys: `p0` 4; `p1`, `p2`, `p3` 1 each; `p4`, `rock`, `burst`, `tumble` 4 each;
`open` 1; `hatchling` 4. The egg's pattern stays attached to each shell fragment.
No egg stage reveals the species: `hatchling` is an anonymous rounded silhouette.
After a result is revealed, compose the actual daemon art with the existing hatch
state machine. Do not redraw the UI's server completion, consent or motion
preference logic as part of artwork selection.

For that composition, Tim baby rises from approximately `dy=30` to `dy=-90`
behind `egg_{kind}_open_0`. Clip the translated figure to `(88, 0, 264, 200)`
before drawing the shell; this hides the arms inside the bowl instead of
letting them protrude below it early in the rise. The irregular rim is at
`y=181..200`, with its centre near `y=198`; the shell floor is `y=316`.
`review/hatch-composition.png` checks silhouette and colour registration.

There are 1,124 base keys and 2,248 base PNGs, plus 3,600 RGB material PNGs. The manifest records the total bytes. One predecoded image per displayed
frame is enough for AppKit or Flutter; no runtime geometry evaluation is needed.
Static/reduced-motion views use frame 0. Use the manifest's count maps rather
than the ASCII plates' different frame counts. Contact sheets under `review/`
are development artifacts, not application assets.

`appearance.py` authors the six rolled coat families and four named markings per species.
`_material.png` stores shade, coat coverage and marking 1; `_marks.png` stores
markings 2–4. These data images are opaque RGB so premultiplication cannot corrupt
the channels. Flutter, AppKit and the round firmware apply the same integer shader;
eyes and other protected features retain their original colours. Seed 0 keeps the
approved unmodified palette. Rolled accessories and individual proportions remain
metadata; only growth, coat and markings are illustrated.

`styles.json` and `illustrated_styles.g.dart` share colour/mark order and species
motion timing. Done and boop reactions end after four frames. Decorative idle motion
is separate from work activity and stops in quiet mode, reduced motion and background
windows. The round dial shares adult layer data and shrinks only active layers into
five fixed PSRAM caches, rather than storing every identity or growth combination.

`alignment.json` and `illustrated_alignment.g.dart` are generated from idle alpha
bounds. Flutter and AppKit use these stable anchors for all moods, centering
the visible art without cancelling jumps or breathing. Native decoding stays
at 64px with a 128-frame / 2 MB cache; portrait decodes never exceed 350px.
