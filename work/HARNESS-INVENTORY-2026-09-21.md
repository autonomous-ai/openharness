# Current harness inventory · September 21, 2026

Source baseline: `735471a1`. This is the complete first-pass manifest, template, viewer and package
conformance review, **not** a claim that every runtime or user journey has been exercised.

- 72 harness packages: 49 listed and 23 unlisted. The canonical registry reader confirms the count.
- 10 shared viewers. All 82 packages pass `checkDsh` on this worktree.
- 17 structural warnings remain: setup-provided upstream files, optional missing skills, Marp's
  verdict-driven artifact routing, and OpenMontage's marker created by initialization. These need
  domain-aware review; a warning alone is not evidence that setup is broken.
- The checked-in README/catalog overview omitted Harness Monitor and still counted 48 packages.
  Regenerated both using `node store/tools/presentation.mjs`; `--check` now passes.
- Detailed interaction review and improvement progress live in
  [the working log](HARNESS-IMPROVEMENTS-2026-09-21.md).

Each row names the first workspace marker and the actual viewer route declared by the package.
Upstream templates and instructions can be created by setup rather than checked in. Unlisted
experiments are included in the review scope but are not automatically promoted to the Store.

| Harness | Visibility | First workspace marker | Viewer |
|---|---|---|---|
| [Ableton AI](../store/agents/ableton-ai/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [Autonomous Circuit](../store/agents/autonomous-circuit/) | listed | `product.json` | `toolchain/viewer.sh` |
| [Grid](../store/agents/autonomous-grid/) | listed | `grid-fleet.json` | `./viewer.sh` |
| [Autonomous Workshop](../store/agents/autonomous-workshop/) | listed | `model.step.py` | `autonomous/cad-viewer` |
| [autoresearch-mlx](../store/agents/autoresearch-mlx/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [Blender](../store/agents/blender/) | listed | `scenes/hello.py` | `autonomous/model-viewer` |
| [Bonsai MCP](../store/agents/bonsai-mcp/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [CircuitJS](../store/agents/circuitjs/) | listed | `circuit.txt` | `./viewer.sh` |
| [Comfy MCP](../store/agents/comfy-mcp/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [Creative Direction](../store/agents/creative-direction/) | listed | `board/index.html` | `toolchain/viewer.sh` |
| [Data Studio](../store/agents/data-studio/) | listed | `index.html` | `autonomous/isolated-web-viewer` |
| [DimOS](../store/agents/dimos/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [Drone Pilot](../store/agents/drone-pilot/) | listed | `flight/index.html` | `toolchain/viewer.sh` |
| [Excalidraw](../store/agents/excalidraw/) | listed | `diagram.excalidraw` | `./viewer.sh` |
| [Firmware Studio](../store/agents/firmware-studio/) | unlisted | `platformio.ini` | `autonomous/isolated-web-viewer` |
| [Foam-Agent](../store/agents/foam-agent/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [FreeCAD](../store/agents/freecad/) | listed | `part.FCMacro` | `autonomous/cad-viewer` |
| [Game Master](../store/agents/game-master/) | listed | `game/index.html` | `toolchain/viewer.sh` |
| [Generative Art](../store/agents/generative-art/) | listed | `sketch/index.html` | `autonomous/web-viewer` |
| [GIS](../store/agents/gis/) | unlisted | `index.html` | `autonomous/isolated-web-viewer` |
| [Godogen](../store/agents/godogen/) | listed | `studio.json` | `autonomous/game-viewer` |
| [Godot Studio](../store/agents/godot-studio/) | unlisted | `project.godot` | `autonomous/isolated-web-viewer` |
| [Harness Monitor](../store/agents/harness-monitor/) | listed | `NOTES.md` | `./viewer.sh` |
| [Home Assistant](../store/agents/home-assistant/) | listed | `automations.yaml` | `toolchain/viewer.sh` |
| [Jev Archer](../store/agents/jev-archer/) | unlisted | `archer.json` | `toolchain/viewer.sh` |
| [Jev Arena](../store/agents/jev-arena/) | unlisted | `arena.json` | `toolchain/viewer.sh` |
| [Jev Blocks](../store/agents/jev-blocks/) | unlisted | `blocks.json` | `toolchain/viewer.sh` |
| [Jev Browser](../store/agents/jev-browser/) | listed | `browse.json` | `toolchain/viewer.sh` |
| [Jev Catcher](../store/agents/jev-catcher/) | unlisted | `catcher.json` | `toolchain/viewer.sh` |
| [Jev Compactor](../store/agents/jev-compactor/) | unlisted | `session.json` | `toolchain/viewer.sh` |
| [Jev Conductor](../store/agents/jev-conductor/) | unlisted | `piece.json` | `toolchain/viewer.sh` |
| [Jev Duel](../store/agents/jev-duel/) | unlisted | `battle.json` | `toolchain/viewer.sh` |
| [Jev Firehose](../store/agents/jev-firehose/) | unlisted | `firehose.json` | `toolchain/viewer.sh` |
| [Jev FPS](../store/agents/jev-fps/) | unlisted | `level.json` | `toolchain/viewer.sh` |
| [Jev Guard](../store/agents/jev-guard/) | unlisted | `goal.json` | `toolchain/viewer.sh` |
| [Jev Lander](../store/agents/jev-lander/) | unlisted | `lander.json` | `toolchain/viewer.sh` |
| [Jev Launcher](../store/agents/jev-launcher/) | unlisted | `launcher.json` | `toolchain/viewer.sh` |
| [Jev Pendulum](../store/agents/jev-pendulum/) | unlisted | `pendulum.json` | `toolchain/viewer.sh` |
| [Jev Pong](../store/agents/jev-pong/) | unlisted | `pong.json` | `toolchain/viewer.sh` |
| [Jev Sheets](../store/agents/jev-sheets/) | listed | `sheet.json` | `toolchain/viewer.sh` |
| [Jev Shopper](../store/agents/jev-shopper/) | unlisted | `shopper.json` | `toolchain/viewer.sh` |
| [Jev Slalom](../store/agents/jev-slalom/) | unlisted | `slalom.json` | `toolchain/viewer.sh` |
| [Jev Trader](../store/agents/jev-trader/) | unlisted | `market.json` | `toolchain/viewer.sh` |
| [JUCE Agent Toolkit](../store/agents/juce-agent-toolkit/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [KiCad](../store/agents/kicad/) | listed | `project.json` | `toolchain/viewer.sh` |
| [Lab Bench](../store/agents/lab-bench/) | listed | `bench/index.html` | `toolchain/viewer.sh` |
| [Machine Monitor](../store/agents/machine-monitor/) | listed | `machines.json` | `./viewer.sh` |
| [Manim](../store/agents/manim/) | listed | `scenes/intro.py` | `autonomous/video-viewer` |
| [marimo](../store/agents/marimo/) | listed | `notebook.py` | `./viewer.sh` |
| [Marp](../store/agents/marp/) | listed | `deck.md` | `toolchain/viewer.sh` |
| [MLX-LM](../store/agents/mlx-lm/) | listed | `local-ai.json` | `./viewer.sh` |
| [MuJoCo](../store/agents/mujoco/) | listed | `sim/hello.py` | `autonomous/mujoco-viewer` |
| [Music Studio](../store/agents/music-studio/) | listed | `piece/index.html` | `autonomous/web-viewer` |
| [Ollama](../store/agents/ollama/) | listed | `local-ai.json` | `./viewer.sh` |
| [OpenMontage](../store/agents/openmontage/) | listed | `film.json` | `autonomous/film-viewer` |
| [OpenSCAD](../store/agents/openscad/) | listed | `model.scad` | `autonomous/cad-viewer` |
| [Orca Slicer](../store/agents/orca-slicer/) | listed | `model.stl` | `autonomous/isolated-web-viewer` |
| [Phaser](../store/agents/phaser/) | listed | `vite.config.mjs` | `./viewer.sh` |
| [Quantum Studio](../store/agents/quantum-studio/) | unlisted | `circuit.json` | `autonomous/isolated-web-viewer` |
| [RDKit](../store/agents/rdkit/) | listed | `molecules/hello.py` | `./viewer.sh` |
| [Remotion](../store/agents/remotion/) | listed | `remotion.config.ts` | `./viewer.sh` |
| [Roundtable](../store/agents/roundtable/) | listed | `room.json` | `autonomous/web-viewer` |
| [Score](../store/agents/score/) | listed | `score.ly` | `autonomous/isolated-web-viewer` |
| [Sheet & Docs Studio](../store/agents/sheet-docs/) | unlisted | `doc.json` | `autonomous/doc-viewer` |
| [SimSkill](../store/agents/simskill/) | listed | `studio.json` | `autonomous/studio-viewer` |
| [Strudel](../store/agents/strudel/) | listed | `track.strudel` | `./viewer.sh` |
| [text-to-cad](../store/agents/text-to-cad/) | listed | `src/README.md` | `autonomous/cad-viewer` |
| [Typst](../store/agents/typst/) | listed | `main.typ` | `autonomous/doc-viewer` |
| [vLLM](../store/agents/vllm/) | listed | `local-ai.json` | `./viewer.sh` |
| [Voxel Worlds](../store/agents/voxel-worlds/) | listed | `world/index.html` | `toolchain/viewer.sh` |
| [Web Studio](../store/agents/web-studio/) | unlisted | `index.html` | `autonomous/isolated-web-viewer` |
| [Yosys](../store/agents/yosys/) | listed | `rtl/blink.v` | `./viewer.sh` |
| [CAD Viewer](../store/viewers/cad-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [Doc Viewer](../store/viewers/doc-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [Film Viewer](../store/viewers/film-viewer/) | shared viewer | `—` | `viewer.sh` |
| [Game Viewer](../store/viewers/game-viewer/) | shared viewer | `—` | `bash viewer.sh` |
| [Isolated Web Viewer](../store/viewers/isolated-web-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [3D Viewer](../store/viewers/model-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [MuJoCo Viewer](../store/viewers/mujoco-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [Studio Viewer](../store/viewers/studio-viewer/) | shared viewer | `—` | `viewer.sh` |
| [Video Viewer](../store/viewers/video-viewer/) | shared viewer | `—` | `./viewer.sh` |
| [Web Viewer](../store/viewers/web-viewer/) | shared viewer | `—` | `./viewer.sh` |
