# Blender, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[Blender](https://www.blender.org): describe an object, a scene, a shot in the chat pane; watch it
take shape in the 3D Viewer pane — modelled in Blender's Python, exported as glTF on every run and
shown as a live viewport (outliner, properties in mm, shading modes, measure, section, the scene
camera, the timeline), with the rendered turntable and still beside it — and get it as glTF or STL.
Runs on Claude Code.

**Shape Lab** makes the authored model something you can explore yourself. Ask for a lamp with
adjustable height, twist and ribbon count, or an enclosure with adjustable clearances. The agent
declares the relevant controls in the scene's Python source; changing them in the pane builds
actual Blender geometry. Keep named directions, return to any of them, and download a project ZIP
containing its source, chosen values, model, measurements and standalone rebuild script.

The starter mug demonstrates the loop with proportions, a removable handle and ceramic finishes.
It is a starting point: the agent should author a scene and meaningful controls for your request.
**Use values on next build** writes `design-values.json`; the agent's next run reads those values
and produces the final exports, renders and verdict. Previews and kept designs do not replace
the main model or its verdict.

[Watch Shape Lab](../../../docs/images/blender-shape-lab-demo.mp4) ·
[See the saved design shelf](../../../docs/images/blender-shape-lab.png)

- `harness.json` — engine, template, skill, toolchain, `viewer.use: autonomous/model-viewer`.
- `toolchain/setup.sh` — one venv with `bpy` (Blender as a Python module) at the pinned version
  (`BPY_VERSION`, or `BPY_VERSION_INTEL_MAC` — 4.5 LTS — on an Intel Mac, which Blender 5 no longer builds for; the wheel needs Python 3.11 exactly, which setup fetches through uv when the machine has none); `harness_blender.py` gives a script the
  scene, camera, glTF export (names, collections, materials, camera, lights, animation and per-object
  facts as extras, written atomically), renders and report, and keeps `.harness/build.json` current
  while it runs; `verdict.py` judges what `out/` holds and names the glTF as the artifact.
- `skills/blender/` — the Blender skill (ours). `template/` — a mug, exported first, then rendered and turned.
- `toolchain/harness_design.py` — the optional parameter declaration and value validation shared
  by normal builds and Shape Lab. Saved designs live under `out/designs/`; each includes
  `rebuild.py --preview` for a geometry-only rebuild using Python with `bpy` installed.

## Credit and stewardship

Blender is the Blender Foundation's and its community's — [blender/blender](https://projects.blender.org/blender/blender),
GPL-2.0-or-later (`LICENSE-blender`); `bpy` is Blender itself, installed from PyPI as released.
Nothing of it is changed here. This folder is the Harness wrapper — the manifest, a skill, the
helper, the template, the verdict — written by Autonomous to bring Blender into Harness, on the
project's behalf, to bootstrap the catalogue. The wrapper's own files are MIT; scripts that import
`bpy` run under Blender's GPL terms, as every Blender add-on does.

If you maintain Blender and want to own its Harness package, it is yours: open an issue on
[OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Blender belong upstream, bugs in
the wrapper belong here, and a newer Blender is a bump of `BPY_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without bpy
python3 -m unittest toolchain/test_harness_design.py # controls and values, without bpy
"$BLENDER_PYTHON" -m unittest discover -s toolchain -p 'test_*.py' # native exports and tiny renders
```

The native viewer integration check lives in
[`model-viewer/test/shape-lab-browser.mjs`](../../viewers/model-viewer/test/shape-lab-browser.mjs).
It exercises the mug and an independently authored ribbon lampshade, validates a downloaded ZIP
with Python, and rebuilds its source from another directory.
