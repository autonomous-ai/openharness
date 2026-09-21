# FreeCAD

Turn measurements into a custom bracket, adapter, enclosure or other solid part—even if you do
not know CAD. Describe what it must fit and how it attaches. The agent captures the requirements,
builds an editable FreeCAD model, measures the result and delivers separate parts you can take
to a slicer, another CAD tool or a fabricator for review.

Try: “Make a bench bracket with a 60 mm mounting pattern. Keep room for the sensor and screwdriver,
then give me the individual part files and a project I can keep editing.”

Or: “My board is 65 × 40 mm, with 12 mm-high components. Design a removable-lid enclosure. Ask me
for the connector measurements you need, and check the actual clearances before handing it over.”

## What you get

- An editable macro, named inputs and a native FreeCAD document—not just a render.
- A saved brief and measurable requirements: size, position, holes, clearance, interference,
  containment and modeled tool-access space.
- Assembly STEP plus **individual STEP and closed STL parts**, reimported for validation.
- Three-view reference SVGs, actual measurements and explicit manufacturing assumptions.
- A portable project ZIP with sources and standalone rebuild tools. Extract it elsewhere and run
  `node tools/build.mjs` with Node and FreeCAD installed; no Harness installation is required.

The build checks the reopened native solids against the saved requirements. A wrong hole pattern,
obstructed tool envelope or insufficient gap fails even when the CAD solid itself is valid. Failed
builds keep the previous successful exports intact and identify the failing candidate. Source
fingerprints prevent an in-flight edit from being passed off as the built revision.

The included enclosure demonstrates the workflow; new jobs are not restricted to that design.
For a successful build, open `handoff/index.html` or ask the agent for its local download link.
The page includes the ZIP, per-part files, drawings, checks and assembly notes. It describes the
last successful build, not later edits to the source.

## Run locally

Requires FreeCADCmd with Part, MeshPart and TechDraw, Node 20+ and the shared CAD Viewer. Native
acceptance tests use FreeCAD 1.1.3. Set `FREECAD_BIN` for a custom installation. Installation does
not bundle FreeCAD; the toolchain reports how to install it if it is missing.

```sh
harness dsh install "$PWD/store/agents/freecad" --link
harness dsh doctor autonomous/freecad
```

Inside a project, the agent builds with:

```sh
sh "$FREECAD_SKILLS/freecad/scripts/build-part.sh"
node "$FREECAD_SKILLS/freecad/scripts/serve-handoff.mjs" "$HARNESS_WORKSPACE"
```

The second command prints a clickable loopback download URL. It serves only generated handoff
files, not arbitrary workspace contents. Stop it with Ctrl-C when finished.

## What remains your responsibility

Passing checks means the **specified geometric requirements** passed—not that strength, material,
electrical safety, weather sealing or as-printed fit is certified. Review process allowances,
hardware, support/orientation and physical fit. The SVGs show overall dimensions, not complete
production tolerances. STL orientation is unchanged; the assembly mesh is not a prepared print bed.
Generated native solids do not promise a constrained Sketcher feature history. Run only trusted macros.

See [the contract](skills/freecad/references/design-contract.md) for supported checks and
[acceptance evidence](test/ACCEPTANCE.md) for tests, versions and limitations.

Upstream: [FreeCAD](https://freecad.org). This package adds the measured-job workflow, workspace,
skill, native export checks and portable handoff.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
