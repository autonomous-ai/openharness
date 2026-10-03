# ASCII creature gallery / study 01

September 27, 2026. A local visual prototype for the 466 × 466 round Harness device. Ten creatures, four moods, and a brief tap reaction. The purpose is to choose a character and animation direction by looking at the physical screen.

**Historical first set:** the installed [study 02 / gallery .4](CREATURE_GALLERY_02.md) retains these ten, adds ten reference/adaptation studies and removes labels. The implementation and .3 validation below describe the original gallery baseline.

**Reference collection:** [Creature directions and artwork](CREATURE_REFERENCES.md) records the user's request to keep all ten, the four richer examples they also liked, their tiny ASCII cat, solid-block/textmode exploration, and the supplied conversion/animation links including the Brrtfetch octopus. Those are retained research directions; this document describes the installed first set.

## On the device

- Swipe left/right to change creature. The list wraps at both ends.
- Swipe up/down to change mood: **calm → curious → playful → sleepy**. The mood stays selected when changing creature, making comparisons easy.
- Tap for a short reaction. Drags, ambiguous diagonal gestures, long rests and cancelled sensor contacts do not turn into taps.
- PWR still controls the screen. The usual five-minute screen timeout remains; touch wakes it.

The gallery opens immediately on boot and works without a computer. Agent commands, voice, approvals, pane switching and app-controlled visuals are disabled for this build. The existing cable connection remains available for device health and firmware operations. Speaker initialization is skipped, and the saved mute preference is preserved.

| # | Resident | Main movement | Sleep pose |
|---|---|---|---|
| 01 | **Miso**, cat | Ear flick, curling tail, raised paws | Curls into a loaf |
| 02 | **Hopper**, frog | Crouches, stretches and jumps | Settles low between its feet |
| 03 | **Pip**, rabbit | Flops an ear, stretches both ears and hops | Folds its ears around its head |
| 04 | **Rook**, penguin | Flipper wave and alternating waddle | Tucks its flippers inward |
| 05 | **Moo**, cow | Ear flick, chewing muzzle and bouncing feet | Lowers its head |
| 06 | **Boo**, ghost | Floats, changes its hem, spreads its arms | Deflates toward the floor |
| 07 | **Sprout**, plant | Sways, opens leaves and blooms | Droops over its pot |
| 08 | **Drift**, jellyfish | Contracts its bell and spreads its tentacles | Gathers its tentacles |
| 09 | **Bolt**, robot | Bends its antenna and dances with alternating arms | Lowers its antenna and idles its chest display |
| 10 | **Echo**, bat | Glides and folds its wings | Wraps its wings around its body |

Curious changes gaze/expression and adds a small question mark. Calm includes brief blinks. Playful uses a held anticipation pose, two action poses and a rest. Sleep uses slower breathing and a small `z`. These are visual experiments; moods are manually selected.

## Research: what survived the small-screen constraint

This is the initial survey of relevant traditions and projects, rather than an exhaustive catalog of every ASCII artwork. Sources include original artists, maintainers, archives and project documentation. The first set favored recognizable silhouettes, a small expressive face, and motion within a 25 × 9 character canvas. That canvas was an initial choice, not a hardware limit; the [expanded reference collection](CREATURE_REFERENCES.md) explores additional densities and character sets.

| Reference | Evidence / reason to study it | Device lesson |
|---|---|---|
| [Scott Fahlman's original smiley thread, 1982](https://www.cs.cmu.edu/~sef/Orig-Smiley.htm) | The original post and surrounding discussion survive. A few punctuation marks convey tone. | Eyes and mouth can carry expression without an elaborate portrait. |
| [Joan G. Stark and Usenet line art](https://velvetyne.fr/news/about-ascii-art-and-jgs-font/) | ASCII artist Adel Faure documents Stark's work beginning in the 1990s, her animal drawings, and the influence of Usenet's line style. | Clear outlines and familiar animals are strong starting points for a tiny companion. |
| [Christopher Johnson's ASCII collection](https://asciiart.website/browse.php) | A large, categorized collection with many animal and character examples, preserving the variety of contributed text art. | Compare silhouettes and character proportions; retain individual attribution when considering an existing drawing. |
| [aSCIIaRENA](https://www.asciiarena.se/) | An active archive and community for Amiga ASCII, with collections and artist credits. | Dense banners and logos are impressive at terminal width; their detail becomes hard to read on this device. |
| [16colo.rs / Sixteen Colors](https://16colo.rs/faq/) | A continuing ANSI/ASCII art-pack archive. Its documentation stresses original character geometry, spacing, preservation and author rights. | Font geometry is part of the art. ANSI, CP437 and strict ASCII need to be distinguished. |
| [Simon Jansen's Star Wars ASCIIMATION, 1997–](https://www.asciimation.co.nz/asciimation/ascii_faq.html) | The creator describes fixed-size text frames, frame holds and compression of repeated poses. The [project remains maintained](https://www.asciimation.co.nz/). | Timing and a few well-chosen poses produce character. Store a pose once and hold it for the intended duration. |
| [Tony Monroe's cowsay, first released 1999](https://cowsay.diamonds/) | Continued maintenance and package distribution show the enduring appeal of a small terminal mascot. Configurable expressions are central to the idea. | A character can be readable, funny and personal with very little text. Moo is a new drawing inspired by that principle. |
| [ASCIIQuarium, Kirk Baucom](https://robobunny.com/projects/asciiquarium/html/?page=2) | The creator's animated aquarium credits much of its art to Joan Stark. | Drift's bell and tentacles, and Boo's floating movement, explore quiet continuous life. A full aquarium would crowd the display. |
| [Andy Sloane's donut.c, 2006](https://www.a1k0n.net/2006/09/15/obfuscated-c-donut.html) | The original compact C program demonstrates moving volume using a luminance ramp of ordinary characters. | Text can express depth. A shaded creature is a useful future direction; a continuously rotating donut is less characterful for this first companion set. |
| [Nyancat CLI, K. Lange](https://github.com/klange/nyancat) | About 1.6k GitHub stars were displayed during research; the project documents packaging across Linux and BSD distributions. It credits the original animation to prguitarman. | A short, unmistakable motion loop can be memorable. Borrow that principle while keeping this study's art original and printable ASCII. |
| [cbonsai, John Allbritten](https://gitlab.com/jallbrit/cbonsai/-/raw/master/README.md) | Its maintained C/ncurses project documents growing trees, live mode, saved growth and several packaging routes. | A companion need not be an animal. Sprout explores a quieter, organic alternative. |
| [Stone Story RPG](https://stonestoryrpg.com/faq.html) | Its creators describe hand-authored text animation, development from 2014, a 2019 Steam release, and community-created pets and cosmetics. | Pose design and animation craft make text feel alive. Different bodies deserve different actions. |
| [Durdraw](https://durdraw.org/) | A contemporary terminal animation editor explicitly builds on TheDraw, ACiDDraw and PabloDraw traditions. | Frame-based ASCII authoring is still useful. An artist-friendly pose source should remain easy to edit outside the embedded runtime. |
| [Jgs Font, Adel Faure / Velvetyne, 2023](https://velvetyne.fr/fonts/jgs-font/) | Designed expressly for ASCII drawing, with glyphs that join across cells and exact pixel-size/line-height recommendations. | Use the art font's intended grid. Jgs7 at 28 px gives 14 × 28 px cells with clean joins. |

The longevity, distribution, community work and adoption signals above indicate sustained interest. They do not establish a universal ranking of what people love. The initial design hypothesis favored Miso, Drift and Sprout for familiar animal warmth, soft continuous motion, and calm organic life. Subsequent user feedback retains **all ten**, alongside richer artwork and tiny ASCII companions. No final creature has been selected; further comparison should include substantially different visual styles.

## What was built

All ten portraits are **new ASCII drawings for this study**, inspired by the traditions above. No original Joan Stark, cowsay, Nyan Cat, film or game frame was copied into the firmware. This keeps the experiment easy to reshape while respecting the original artists. Existing archival artwork would need its own attribution and reuse review before adoption; the [16colo.rs archive explicitly explains this](https://16colo.rs/faq/).

The art consists of printable characters **32–126**. No Unicode pictograms, CP437 block characters, character images, video decoder, image frames, SVG or browser runtime are involved. The glyph atlas is the normal text-rendering mechanism: the device draws characters, and only the font's individual glyphs are pre-rasterized.

- **C on ESP-IDF / FreeRTOS**, using the existing direct RGB565 → QSPI DMA text compositor.
- **25 × 9 cells**, 60 authored poses, **14,040 bytes** of fixed ASCII pose data.
- **9,310-byte** ASCII-only font atlas derived from Jgs7, named *Habitat ASCII Art 28*.
- **32 bytes** of gallery state, no dynamic allocation in the gallery module.
- Animation scheduling at **125 ms** while awake, **250 ms** in sleepy mode. Touch changes notify the renderer immediately rather than waiting for this cadence. Unchanged frames cause no display transfer.
- Existing partial-region redraws and two DMA strip buffers are retained. The gallery adds no framebuffer.
- One stable creature name, one mood label and one gesture hint keep screen text minimal.

Jgs7 is copyright © 2022 Adel Faure, distributed by Velvetyne under the SIL Open Font License 1.1. The original font and [full license](../../firmware/fonts/Jgs-OFL.txt) are retained. The generated atlas remains under that license and uses a different name from the reserved original font name. The surrounding interface retains Geist Mono and its existing license.

## Validation and build

**Gallery .3 cancels a gesture when the screen turns off.** Previously, turning the display off partway through a swipe could still change creature on release. The production touch task now checks screen power while holding the same lock used to deliver input, and suppresses the entire interrupted contact even if PWR wakes the display before the finger lifts. Driver/gallery traces reproduce the old failure and cover sleep during movement, sleep at release, PWR off/on while held, and sleep occurring while input waits for the UI lock.

**Gallery .2 fixes recovery after wake-up and interrupted contacts.** The driver already suppresses the wake/damaged contact through its release. Gallery .1 also waited for that release, which the driver deliberately never forwarded, so the next healthy gesture was discarded. The gallery now simply resets its local contact when cancelled. A regression replays the actual production touch task into the gallery: it failed against .1 and passes for wake → tap, wake → creature swipe, wake → mood swipe, stale ACK, read error and malformed-coordinate recovery. This changes no portraits, animation timing or gesture mappings.

The native gallery test rendered **3,840 scenes** covering every creature/mood combination. It checks printable ASCII, scene bounds, visible animation in every mode, horizontal/vertical wrapping, diagonal rejection, drag-return rejection, sensor cancellation, unreliable release coordinates and the 32-bit clock wrap. The complete existing native firmware suite passed under undefined-behavior and bounds sanitizers.

Across **3,800 consecutive-frame comparisons** in that test, the compositor marked a mean of **14,282 pixels** and a maximum of **88,900 pixels** dirty, compared with 217,156 pixels for a full screen. These are deterministic scene-damage measurements on the host, not device latency or FPS measurements. Creature switches and initial full-screen paint are excluded from this particular calculation.

The contact sheets in results/creature-gallery (local experiment artifact) were rasterized by the actual production C compositor and inspected with the round display mask. They are useful for layout review; physical viewing remains the authority for brightness, apparent size and motion quality.

Build in a separate directory so the experimental flag cannot leak into a normal build:

```sh
idf.py -B build-gallery -DSDKCONFIG=build-gallery/sdkconfig \
  -DDEVICE_HABITAT=1 -DDEVICE_CREATURE_GALLERY=1 \
  -DDEVICE_PERF_BENCH=0 -DDEVICE_FORCE_PROD=1 \
  -DPROJECT_VER=0.0.87-gallery.3 build
```

For a normal Habitat build use its own build directory and `-DDEVICE_CREATURE_GALLERY=0`. The gallery source and font are omitted entirely when this flag is off. The normal .25 image has been retained for restoration; the in-progress .26 carry/return changes remain in the worktree and are separate from this visual study.

Sources: [gallery module](../../firmware/main/ui/habitat/creature_gallery.c), [editable portraits](../../firmware/scripts/gen_creature_art.py), [font generator](../../firmware/scripts/gen_creature_font.py), [native test](../../firmware/test/test_creature_gallery.c), [driver/gallery recovery regression](../../firmware/test/test_touch_driver.py). The .3 image is **527,040 bytes**, SHA-256 `64ab3d212cbf4a9f070f5249364d54c775f90783c4fd4642ab6d15b8c5350c76`. The expected board and version booted, the bridge reconnected, and live heartbeats confirmed animation with mute enabled. Host/desktop hashes and desktop layout were unchanged. Physical gesture ergonomics await the user’s inspection. Installation evidence is recorded in the gallery deployment record (local experiment artifact); .2 (local experiment artifact) and the original .1 record (local experiment artifact) retain their earlier evidence.
