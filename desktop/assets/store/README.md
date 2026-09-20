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
