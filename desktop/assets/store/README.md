# Store previews

These are bundled example outputs, so Discover works without external image services.
They illustrate existing harnesses; editorial features are only shown when their package
is present in the live catalog. They are not claims of automatic engineering validation.

- `blender-studio.png`: original procedural Blender scene, made for Harness. Reproduce with
  `desktop/tool/store_artwork/render.py` using the Blender harness's `bpy` environment.
- `copper-board.png`: Blender render of Copper's `examples/terminal-keyboard/boards/main_fab/board.glb`.
  Source: [autonomous-circuit](https://github.com/autonomous-ai/autonomous-circuit), MIT;
  copyright notice retained in `LICENSE-copper`. This is a board example, not a fabrication certification.
- `phaser-bricks.png`: gameplay capture of the bundled Phaser Bricks starter
  (`store/agents/phaser/template`), with one brick removed by play. The starter uses procedural
  graphics and no third-party image assets.

To regenerate the renders:

```sh
<blender-harness>/.venv/bin/python desktop/tool/store_artwork/render.py \
  --output desktop/assets/store \
  --pcb-glb <copper>/examples/terminal-keyboard/boards/main_fab/board.glb
```

`polymath.png` is the original Harness Store mark: six colorful branches meeting
at one center. The Store button, tabs, and History use the same asset. Its vector
source is `desktop/tool/render_store_mark.swift`; regenerate from `desktop/` with
`swift tool/render_store_mark.swift`.
## Exploration previews

`projects/` contains unaltered copies of the repository's showcase outputs.
Discovery and category pages use these; individual harness pages keep their existing artwork.

| Bundled image | Source under `store/showcase/` |
| --- | --- |
| `projects/blender.jpg` | `blender/cozy-reading-nook.jpg` |
| `projects/cad.jpg` | `text-to-cad/planetary-gear-set.jpg` |
| `projects/circuit.jpg` | `autonomous-circuit/six-key-macropad.jpg` |
| `projects/robot.jpg` | `mujoco/g1-humanoid-hello.jpg` |
| `projects/game.jpg` | `godogen/neon-drift.jpg` |
| `projects/music.jpg` | `score/ensemble.jpg` |
| `projects/data.jpg` | `marimo/lorenz-butterfly.jpg` |
| `projects/film.jpg` | `remotion/harness-store-launch.jpg` |
| `projects/research.jpg` | `roundtable/windows-port-room.jpg` |
| `projects/slides.jpg` | `marp/deep-sea-keynote.jpg` |
| `projects/circuitjs.jpg` | `circuitjs/555-led-flasher.jpg` |
| `projects/yosys.jpg` | `yosys/fibonacci-cpu.jpg` |
| `projects/orca-slicer.jpg` | `orca-slicer/spacer.jpg` |

New packages can supply example images in their Store metadata. If no preview is available,
the card displays the package mark. Shared viewers never appear as creative projects.

## Browse covers

`covers/` contains curated covers for discovery tiles and category pages. Files are
unaltered; the UI sets the crop, alignment and background. These covers show what a tool
can do. They are **not** paired with an example prompt or presented as Harness output
when they come from upstream. The prompt gallery and individual harness pages keep
their real example images. New upstream covers need a source, credit and redistributable
license; a project's source-code license is not permission to reuse unrelated gallery art.

Upstream images have an image-credit control that opens their source. Corresponding
license texts are bundled alongside the images, and `sources.json` records the exact
download URL and SHA-256 of each original. Retrieved 2026-09-20.

| Cover | Credit | License / source |
| --- | --- | --- |
| `covers/blender.jpg` | DOGWALK · © Blender Foundation | [CC BY 4.0](https://www.blender.org/download/demo-files/) · [notice](covers/LICENSE-blender-CC-BY-4.0) |
| `covers/kicad.png` | KiCad contributors | [CC BY 3.0](https://www.kicad.org/about/licenses/) · [notice](covers/LICENSE-kicad-CC-BY-3.0) |
| `covers/freecad.png` | FreeCAD contributors | [LGPL 2.1](https://github.com/FreeCAD/FreeCAD-Homepage) · [notice](covers/LICENSE-freecad-LGPL-2.1) |
| `covers/mujoco.png` | MuJoCo Menagerie · Unitree Robotics | [BSD 3-Clause](https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_g1) · [notice](covers/LICENSE-mujoco-unitree-BSD-3-Clause) |
| `covers/marimo.png` | marimo contributors | [Apache 2.0](https://github.com/marimo-team/marimo) · [notice](covers/LICENSE-marimo-Apache-2.0) |

DOGWALK's current [project distribution](https://blenderstudio.itch.io/dogwalk)
identifies its assets as CC BY 4.0 and requests credit to Blender Foundation. The splash
is also listed as CC BY on Blender's demo-files page. The image retains its original
Blender logo and studio credit; trademarks remain with their owners.

These covers are our existing showcase outputs, copied without alteration:

| Cover | Source under `store/showcase/` |
| --- | --- |
| `covers/workshop.jpg` | `autonomous-workshop/honeycomb-desk-organizer.jpg` |
| `covers/creative-direction.jpg` | `creative-direction/stillwater.jpg` |
| `covers/generative-art.png` | `generative-art/canopy.png` |
| `covers/voxel-worlds.jpg` | `voxel-worlds/amber-vault.jpg` |
| `covers/music-studio.png` | `music-studio/keepsake.png` |
| `covers/data-studio.jpg` | `data-studio/evidence.jpg` |
| `covers/drone-pilot.jpg` | `drone-pilot/works-yard.jpg` |
| `covers/game-master.jpg` | `game-master/signal-garden.jpg` |
| `covers/lab-bench.jpg` | `lab-bench/canopy.jpg` |
| `covers/jev-browser.jpg` | `jev-browser/jev-picks-the-columns.jpg` |
| `covers/jev-sheets.jpg` | `jev-sheets/typed-column.jpg` |
| `covers/roundtable.jpg` | `roundtable/claim-map-mid-round.jpg` |
| `covers/phaser.jpg` | `phaser/sunset-fox-platformer.jpg` |
| `covers/manim.jpg` | `manim/fourier-knight.jpg` |
| `covers/openmontage.jpg` | `openmontage/lanterns-title-sequence.jpg` |
| `covers/remotion.jpg` | `remotion/year-in-running.jpg` |
| `covers/strudel.jpg` | `strudel/synthwave-night-drive.jpg` |
| `covers/typst.jpg` | `typst/orbital-mechanics-guide.jpg` |
| `covers/excalidraw.jpg` | `excalidraw/url-shortener-architecture.jpg` |
| `covers/rdkit.jpg` | `rdkit/ibuprofen-analogues.jpg` |

For wrapped tools whose published art is only a logo, a text title, or a less useful
view, retain the clearer Harness output. Tools without a curated cover continue to use
their existing example, package screenshot, or mark. Original license terms for upstream
work are preserved; the repository's MIT license does not relicense these images.
