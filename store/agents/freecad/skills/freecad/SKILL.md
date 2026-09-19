---
name: freecad
description: Build parametric FreeCAD macros, export STEP assemblies and verify fresh geometry in the shared CAD Viewer.
---

# FreeCAD

`part.FCMacro` is Python executed by FreeCADCmd, not system Python. Import `FreeCAD as App` and
`Part`; use named dimensions and reusable construction functions. The Pocket starter produces
a base and vented lid laid out side by side, with screw bosses, clearance and a cable opening.

```sh
sh "$FREECAD_SKILLS/freecad/scripts/build-part.sh"
```

Requires Node 20+ and the headless FreeCAD binary. Resolve `FREECAD_BIN`, the toolchain link,
`freecadcmd`/`FreeCADCmd` or the installed macOS app. Recent macOS packages put the CLI at
`FreeCAD.app/Contents/Resources/bin/freecadcmd`, not necessarily `Contents/MacOS/FreeCADCmd`.

## Export contract

The build runs `runner.py` in FreeCAD with `HARNESS_WORKSPACE` and a unique `HARNESS_BUILD_DIR`.
Your macro reads its source inputs from the workspace and writes `part.step` to that build directory.
Optional `part.stl` and `part.FCStd` exports are copied alongside it only after verification.
Use `MeshPart.meshFromShape` for controlled mesh tessellation, and `doc.saveAs` for the native file.

The runner reimports the new STEP, calls `shape.check(True)`, and requires positive-volume,
closed, valid solids. `shape.check` does not return a success boolean; exceptions indicate errors.
It writes a fresh geometry receipt. The Node wrapper rejects missing output or receipt even if
FreeCAD reports exit zero after a Python exception. See `.harness/build.log` and `geometry.json`.

Do not equate STEP validity with printability or machining suitability. Review wall thickness,
clearance, supports, tool access, strength and intended materials separately. Parametric macro
inputs are not a promise of a fully constrained Sketcher history in the exported document.

Inspect both parts in the actual viewer; verify dimensions or section cuts relevant to the request.
