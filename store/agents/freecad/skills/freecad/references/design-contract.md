# Saved design contract (spec 1)

Keep the user's requirements separate from construction code. Check values should come from
the brief or measurements, not from reading back the solid or automatically copying construction
parameters. An unmeasured requirement is still unresolved even when every listed check passes.

## Minimal complete job

```json
{
  "spec": 1,
  "title": "Equipment adapter",
  "brief": "A 60 by 30 by 4 mm prototype plate with a centred 6.4 mm through bore.",
  "units": "mm",
  "sourceFiles": ["part.FCMacro", "design.json", "dimensions.json"],
  "parts": [{"id": "adapter", "object": "Adapter", "label": "Adapter plate", "material": "Prototype plastic; process not yet selected", "quantity": 1}],
  "references": [],
  "checks": [
    {"id": "outside", "type": "bounds", "part": "Adapter", "size": [60, 30, 4], "origin": [-30, -15, 0], "reason": "Fit the measured mounting space."},
    {"id": "bore", "type": "bore", "part": "Adapter", "origin": [0, 0, 0], "axis": [0, 0, 1], "diameter": 6.4, "length": 4, "wall": 2, "reason": "Match the required fastener clearance and location."}
  ],
  "assumptions": ["Nominal geometry only; choose material and verify printed fit before use."],
  "assembly": ["Test the prototype against the measured equipment before installation."],
  "hardware": ["Select fastener length and load rating against the actual joint."]
}
```

Create a document object named `Adapter` (the internal **Name**, not the displayed Label). Save
the document to `os.path.join(os.environ["HARNESS_BUILD_DIR"], "part.FCStd")`. There is no need
to export files manually. Imported references must also be named solid objects in this document.

## Fields and checks

All distances/coordinates are in millimetres; volume tolerances are mm³. Bounds use world axes.
Part IDs become filenames and must be unique ASCII identifiers; internal object names must be
unique. Up to 32 individual manufactured parts, 64 references and 256 checks are supported.
Optional `notes` on each part explain handling, orientation or other caveats.

| Type | Required fields beyond `id`, `type`, `reason` | What the native kernel checks |
| --- | --- | --- |
| `bounds` | `part`, `size: [x,y,z]` | Bounding-box size; optional `origin: [xmin,ymin,zmin]` also checks position. |
| `clearance` | `parts: [A,B]`, `minimum` | Closest surface distance **and no intersecting volume**. Optional `maximum` limits excess gap. |
| `no-overlap` | `parts: [A,B]` | Common volume. Touching surfaces are allowed. |
| `contains` | `part: Container`, `other: Payload` | Volume of Payload outside Container. Use a solid available-space reference, not a hollow shell. |
| `bore` | `part`, `origin`, `axis`, `diameter`, `length`, `wall` | The axial cylinder is empty and an annulus of surrounding material exists. Empty space alone cannot pass as a hole. |

`bounds`, `clearance` and `bore` accept `tolerance` (default 0.02 mm).
`contains` and `no-overlap` accept `toleranceVolume` (default 0.00001 mm³).
These are numeric measurement allowances, **not** a specification of manufacturing tolerances.
Do not loosen them to conceal a faulty design. Bore tolerance must be smaller than the radius,
half-depth and required surrounding wall. Axis is a nonzero vector and is normalized by the runner.

For a through bore, place `origin` on its entry surface and point `axis` through the material.
`length` spans the material; `wall` is the surrounding annulus required along that span. This
check does not establish countersinks, threads, retention or tool access. Model the necessary
access volumes separately and use bounds plus no-overlap checks. A stepped bore needs separate
appropriate probes, not one cylinder through air or counterbore space.

Reference shapes let you check clearance around an actual PCB, connector, moving part or tool.
Check their dimensions and locations independently. A passing check against a shrunken reference
proves nothing about the real object. Include motion extremes or swept volumes when needed.
Model physical inserts/supports intentionally: `no-overlap` alone does not prove retention.

## Sources, receipts and portability

`sourceFiles` is an explicit allowlist of at most 128 regular files (64 MiB each, 128 MiB total).
It must include `part.FCMacro` and `design.json`; include every additional input/helper the macro
needs. Visible nested paths such as `inputs/board.step` are allowed. Hidden files, symlinks,
absolute/parent paths, generated outputs, `tools/` and `handoff/` are rejected. Imported third-party
input must be permitted to redistribute in the user-directed project bundle; keep its notices.

The builder hashes included sources before/after native execution and again before publishing.
The receipt records those SHA-256 values, actual measurements and FreeCAD version. A source edit
during a build invalidates that result. A macro depending on undeclared external files is not
portable: test the extracted ZIP in a new folder to expose missing inputs.

Each manufactured object must be one closed, valid positive-volume solid. Quantity does not create
instances: name actual assembled instances separately when placement/interference matters. The
builder exports only declared manufactured objects, not the reference solids.

Unknown fields/types, duplicate IDs, non-finite numbers and undeclared object names fail validation.
Read `.harness/build.log` for schema/native errors, `.harness/failed-design.json` for failed measured
checks, and `.harness/verdict.json` for the current result. A failed candidate does not replace the
last successful handoff. A success means **the specified checks passed**, not that every aspect of
the user's intended use has been certified.
