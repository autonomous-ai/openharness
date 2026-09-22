# Store previews

Editorial artwork is bundled. **Featured harnesses** uses the poster and recording from
each harness's live catalog examples; posters load over HTTPS, with an app-icon fallback
when unavailable. Videos load only after a click. Features only appear for tools present
in the local machine's catalog.

## Editorial illustrations

`editorial-*.png` are eleven original illustrations generated with the built-in
imagegen tool. The exact prompts and file mapping are in
[`editorial-prompts.json`](../../tool/store_artwork/editorial-prompts.json).
Discover uses three illustrated features (coding, 3D design, circuits) when the catalog
has no recorded examples; each discipline uses one feature. Catalog rows use app icons.
These illustrations depict a craft,
not an app screenshot or a claimed agent result.

## Original example outputs

These assets are real example outputs, not claims of automatic engineering validation.

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
These remain available for deliberate editorial features. Discovery and categories now use
app icons for browsing; individual harness pages keep their existing artwork.

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

New packages can supply example images in their Store metadata for their detail pages.
Shared viewers never appear as creative projects.

## Curated artwork library

The 48 covers in `store_cover_art.dart` include 13 upstream images and 35 original Harness
outputs or viewer captures. They are retained as a sourced artwork library, not displayed
as a thumbnail grid. Discover and category features use the editorial illustrations
above; their browsing collections use app icons. Individual harness pages retain their
existing examples and artwork.

The UI frames useful image regions without modifying the bundled originals. Upstream
covers illustrate the tool, not a claimed result of a suggested prompt. Their image
credit control links to the source; license notices are bundled alongside the images.
`sources.json` records the catalog ID, exact source, retrieval URL, and SHA-256 for each file.
Retrieved 2026-09-20. Source artwork retains its own terms; the repository's MIT license
does not relicense it.

### Upstream artwork

| Harness | Credit | Terms / source |
| --- | --- | --- |
| blender | DOGWALK · © Blender Foundation | [CC BY 4.0](https://www.blender.org/download/demo-files/) · [notice](covers/LICENSE-blender-CC-BY-4.0) |
| kicad | KiCad contributors | [CC BY 3.0](https://www.kicad.org/about/licenses/) · [notice](covers/LICENSE-kicad-CC-BY-3.0) |
| freecad | FreeCAD contributors | [LGPL 2.1](https://github.com/FreeCAD/FreeCAD-Homepage) · [notice](covers/LICENSE-freecad-LGPL-2.1) |
| mujoco | MuJoCo Menagerie · Unitree Robotics | [BSD 3-Clause](https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_g1) · [notice](covers/LICENSE-mujoco-unitree-BSD-3-Clause) |
| marimo | marimo contributors | [Apache 2.0](https://github.com/marimo-team/marimo) · [notice](covers/LICENSE-marimo-Apache-2.0) |
| ableton-ai | © Ableton AG | [Ableton press image](https://www.ableton.com/en/press/) · [notice](covers/LICENSE-ableton-ai) |
| bonsai-mcp | IfcOpenShell contributors | [GPL 3.0 or later](https://docs.bonsaibim.org/quickstart/explore_model.html) · [notice](covers/LICENSE-bonsai-mcp) |
| comfy-mcp | ComfyUI examples contributors | [ComfyUI examples permission notice](https://comfyanonymous.github.io/ComfyUI_examples/area_composition/) · [notice](covers/LICENSE-comfy-mcp) |
| dimos | Dimensional Inc. | [Apache 2.0](https://github.com/dimensionalOS/dimos) · [notice](covers/LICENSE-dimos) |
| simskill | SimSkill contributors | [Apache 2.0](https://github.com/qiliuchn/SimSkill-V1) · [notice](covers/LICENSE-simskill) |
| text-to-cad | Jake Adair · text-to-cad contributors | [MIT](https://github.com/earthtojake/text-to-cad) · [notice](covers/LICENSE-text-to-cad) |
| home-assistant | Home Assistant contributors | [Apache 2.0 · demo UI](https://demo.home-assistant.io/) · [notice](covers/LICENSE-home-assistant) |
| openscad | OpenSCAD contributors | [GPL 2.0 · application UI](https://openscad.org/) · [notice](covers/LICENSE-openscad) |

DOGWALK's current [project distribution](https://blenderstudio.itch.io/dogwalk)
identifies its assets as CC BY 4.0 and requests credit to Blender Foundation. Its
original logo and studio credit remain in the image.

Ableton's image comes from its official Live 12 press kit and remains © Ableton AG.
It is a product illustration, not open-source artwork. Home Assistant is a capture of
its public demonstration interface. OpenSCAD and Bonsai use official application
screenshots, with the corresponding software notices preserved.

### Original outputs and viewers

| Cover | Source in this repository |
| --- | --- |
| `covers/workshop.jpg` | `store/showcase/autonomous-workshop/honeycomb-desk-organizer.jpg` |
| `covers/creative-direction.jpg` | `store/showcase/creative-direction/stillwater.jpg` |
| `covers/generative-art.png` | `store/showcase/generative-art/canopy.png` |
| `covers/voxel-worlds.jpg` | `store/showcase/voxel-worlds/amber-vault.jpg` |
| `covers/music-studio.png` | `store/showcase/music-studio/keepsake.png` |
| `covers/data-studio.jpg` | `store/showcase/data-studio/evidence.jpg` |
| `covers/drone-pilot.jpg` | `store/showcase/drone-pilot/works-yard.jpg` |
| `covers/game-master.jpg` | `store/showcase/game-master/signal-garden.jpg` |
| `covers/lab-bench.jpg` | `store/showcase/lab-bench/canopy.jpg` |
| `covers/jev-browser.jpg` | `store/showcase/jev-browser/jev-picks-the-columns.jpg` |
| `covers/jev-sheets.jpg` | `store/showcase/jev-sheets/typed-column.jpg` |
| `covers/roundtable.jpg` | `store/showcase/roundtable/claim-map-mid-round.jpg` |
| `covers/phaser.jpg` | `store/showcase/phaser/sunset-fox-platformer.jpg` |
| `covers/manim.jpg` | `store/showcase/manim/fourier-knight.jpg` |
| `covers/openmontage.jpg` | `store/showcase/openmontage/lanterns-title-sequence.jpg` |
| `covers/remotion.jpg` | `store/showcase/remotion/year-in-running.jpg` |
| `covers/strudel.jpg` | `store/showcase/strudel/synthwave-night-drive.jpg` |
| `covers/typst.jpg` | `store/showcase/typst/orbital-mechanics-guide.jpg` |
| `covers/excalidraw.jpg` | `store/showcase/excalidraw/url-shortener-architecture.jpg` |
| `covers/rdkit.jpg` | `store/showcase/rdkit/ibuprofen-analogues.jpg` |
| `covers/autonomous-circuit.png` | `desktop/assets/store/copper-board.png` |
| `covers/autonomous-grid.png` | `store/agents/autonomous-grid/screenshots/grid-topology.png` |
| `covers/autoresearch-mlx.png` | `store/agents/autoresearch-mlx/screenshots/studio.png` |
| `covers/circuitjs.jpg` | `store/showcase/circuitjs/police-light-flasher.jpg` |
| `covers/foam-agent.png` | `store/agents/foam-agent/screenshots/studio.png` |
| `covers/godogen.jpg` | `store/showcase/godogen/neon-drift.jpg` |
| `covers/juce-agent-toolkit.png` | `store/agents/juce-agent-toolkit/screenshots/studio.png` |
| `covers/machine-monitor.png` | `desktop/tool/store_artwork/capture-covers.mjs machine-monitor` |
| `covers/marp.jpg` | `store/showcase/marp/deep-sea-keynote.jpg` |
| `covers/mlx-lm.png` | `desktop/tool/store_artwork/capture-covers.mjs mlx-lm` |
| `covers/ollama.png` | `desktop/tool/store_artwork/capture-covers.mjs ollama` |
| `covers/vllm.png` | `desktop/tool/store_artwork/capture-covers.mjs vllm` |
| `covers/orca-slicer.jpg` | `store/showcase/orca-slicer/review.jpg` |
| `covers/score.jpg` | `store/showcase/score/ensemble.jpg` |
| `covers/yosys.jpg` | `store/showcase/yosys/fibonacci-cpu.jpg` |

For wrapped tools with no useful published artwork, the cover shows an original project
output or Harness's own viewer. For example, Godogen's upstream thumbnail is a text title
card; the library includes our playable Neon Drift game. The local AI runtimes are command-line
tools, so their covers show the original Harness model-control interfaces. Selection
notes for these cases are in `sources.json`.

Machine Monitor and the three local-model covers use synthetic inventories in their real
viewers. No user machines, account data, model downloads, or benchmark results were used.
Their original interface captures can be reproduced with an existing Playwright installation:

```sh
node desktop/tool/store_artwork/capture-covers.mjs all \
  --playwright /path/to/playwright/index.mjs --output /tmp/harness-covers
```

This starts isolated loopback viewers and opens Home Assistant's public demo. It does not
connect to Harness's daemon or start any models. The script closes its browsers and servers
when finished. The Store tests check complete catalog coverage, source records, asset decoding,
and that every configured image viewport stays inside its original image.
