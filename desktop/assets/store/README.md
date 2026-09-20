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
