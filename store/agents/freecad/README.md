# FreeCAD

Turn a design brief into real CAD geometry and a STEP assembly. The **Pocket** starter includes
a rounded electronics enclosure, screw bosses, a cable opening and a vented locating lid.
Change named dimensions in the macro, rebuild, then inspect and measure the parts in the CAD Viewer.

Try: “Resize the enclosure for my board, keep 3 mm clearance, and move the cable opening.”

The build produces STEP, STL and a native FreeCAD document. It reimports the fresh STEP and verifies
closed, valid, positive-volume solids; a failed build cannot reuse an old export as success.
The macro is the parametric source. The native file records the generated shapes and design inputs,
not a complete Sketcher constraint history. Manufacturing fit and strength still need review.

Requires FreeCADCmd, Node 20+ and the shared CAD Viewer. Use `FREECAD_BIN` for a custom binary.

```sh
harness dsh install "$PWD/store/agents/freecad" --link
harness dsh doctor autonomous/freecad
```

Upstream: [FreeCAD](https://freecad.org). This package adds the workspace, skill, example design and
fresh-export verification.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
