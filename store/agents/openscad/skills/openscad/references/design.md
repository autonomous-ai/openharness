# Checked design contract (spec 1)

Use the starter `template/design.json` as a complete example. The independent bottle/ring project
in `test/fixtures/bottles/` demonstrates cylinders, two repeat axes, two parts, clearance variants,
negative design coordinates and an explicitly rotated print part.

## Saved brief and geometry

Root fields (unknown fields are rejected):

- `spec: 1`; `title`; `brief`; `assumptions: string[]`; `assembly: string[]`.
- `sourceFiles`: explicit portable input paths including `model.scad` and `design.json`. Up to 32
  regular files, 8 MiB each / 16 MiB total; no symlinks, hidden components, traversal or generated
  output paths. Supported suffixes: scad/json/stl/svg/dxf/txt/md.
- `parameters`: 1–64 named numeric definitions `{value,min,max,unit,label?}`. Units are
  `mm`, `degrees`, `count` or `ratio`. Count values are integers. `id` is reserved.
- `variants`: 1–4 `{id,label,values,notes}` objects; `values` overrides defaults by parameter name.
- `parts`: 1–8 `{id,label,quantity,printRotation,shells,views,notes}` objects.
- `checks`: 1–32 independent requirements, described below.
- `process: {material,bedMM:[x,y,z],edgeMarginMM,nozzleMM,notes}`.
- `preview: {variant,part}` chooses the real mesh shown in the main CAD pane.

IDs start with a lowercase letter, contain lowercase letters/digits/hyphens and are at most 32
characters. Their combined export/check names must not collide. Each part's generated
`<part>-topology`, `<part>-reopen` and `<part>-bed` check names are reserved.

Implement every saved numeric parameter as a named module argument:

```scad
module part(id, width=180, depth=96, height=40, wall=2.4, floor=2.4, columns=3) {
    // Assert meaningful parameter combinations, then construct the selected part.
    assert(id == "tray", "Unknown part");
    // ...
}
part("tray"); // optional desktop preview, not part of checked exports
```

The builder uses `use <model.scad>` and calls `part(id="tray",width=...,...)`. Do not depend on
top-level assignments for configurable values; derive dimensions inside the module from its
arguments. Unknown module/parameter diagnostics fail the build. Dependencies must be relative,
declared in `sourceFiles` and portable; native dependency receipts reject outside inputs.
Do not use unseeded random geometry. Repeated exports must agree to 0.00001 mm vertex precision.
This check is not a proof against every possible nondeterministic program.

Compile trusted source only. Dependency checking detects undeclared reads after compilation; it
is a portability check, not an execution sandbox. Font lookup and native libraries are engine
dependencies, not bundled inputs; disclose any reliance on locally installed fonts.

## Measurements and probes

All geometric checks refer to **design coordinates of the actual first exported STL**, before
print orientation. Required dimensions come from the saved brief, never inferred back from a
faulty export. Numeric fields accept finite numbers or bounded arithmetic strings using parameter
names, parentheses and `+ - * /`; no functions, JavaScript, property access or units inside expressions.

Every check has `{id,label,kind,part}`, plus:

| Kind | Additional fields | Measured condition |
| --- | --- | --- |
| `bounds` | `origin:[x,y,z], size:[x,y,z], tolerance` (default 0.02 mm, max 1 mm) | Measured minimum corner and spans match; required for every part. |
| `volume` | `range:[min,max]` in mm³ | Actual oriented-mesh volume is in range. |
| `empty` | `region` | Native intersection of the STL and region is empty. |
| `contains` | `region` | Native difference of the region minus STL is empty. |
| `separated` | `other, translation:[x,y,z], rotation:[x,y,z]` | First STL does not overlap the second after rotation then translation. |

A box region is `{shape:"box",origin:[x,y,z],size:[x,y,z]}`. A cylinder is
`{shape:"cylinder",origin:[x,y,z],radius,height,axis:"z"}`; the origin is the center of its
starting face, and the cylinder extends along the positive x/y/z axis. Cylinders use 128 facets.

Either region can add `repeat:[{count,step:[x,y,z]}, ...]` for one or two repeat axes (at most
64 probes). This checks every pocket/divider in a regular layout without duplicating requirements.

Choose probe tolerances deliberately. The examples inset probe faces by 0.04 mm to avoid
coincident-boundary numerical noise; these tests therefore prove the inset region, not the
untested skin around it. The nozzle value is a recorded assumption, not an automatic minimum-wall
check. Add material probes where wall/floor integrity matters; an empty pocket alone proves no wall.

A diagnostic such as “unknown module” can accompany OpenSCAD's empty-object message. Only the exact
native empty result **without warnings/errors** passes. Missing output or a generic nonzero exit
is a build failure, never a successful clearance check.

## Parts, print orientation and views

`shells` is the expected number of connected **surface** shells, not the number of solids. An
enclosed cavity may have an inner surface shell. The mesh checker welds to 0.00001 mm, checks
oppositely directed paired edges, rejects degenerate faces and requires positive oriented total
volume. It cannot find every self-intersection.

`printRotation` is a fixed numeric [x,y,z] Euler rotation in OpenSCAD degrees. The exact exported
mesh is rotated, translated so minimum XYZ is zero and natively reopened. The individual final
part must fit `bedMM` with `edgeMarginMM` on both X/Y sides. Quantity is a bill-of-materials count;
this is not a packed-plate or G-code check.

`views` has `top`, `front` and `side`, each with `{at: expressionOrNull}`:

- Top: XY plane; `at` selects design Z.
- Front: XZ plane; `at` selects design Y.
- Side: YZ plane; `at` selects design X.
- `null` requests a silhouette, labelled as such. A section must be strictly inside the measured
  bounds and intersect actual material.

Pick planes that reveal the relevant interior, not an attractive silhouette hiding it. Native
SVG viewboxes may be padded; displayed dimensions come from measured meshes. These are reference
views, not certified dimensioned production drawings.

## Outputs and recovery

`part.stl` is the selected print-ready-coordinate preview; `preview.scad` is its editable source
configuration. `handoff/` contains all individual STLs, views, source wrappers, a comparison page,
`checks.json` and `project.zip`. The ZIP is bounded to 256 entries / 32 MiB uncompressed and includes
standalone Node + OpenSCAD rebuild tools and their MIT license. It includes only declared sources
and generated delivery files, never the rest of the workspace.

A unique staging directory, source hashes and build lock guard publication. Failed builds clear
readiness and retain prior successful downloads. History is retained in `.harness/history/`.
Old handoff pages are explicitly saved snapshots. A single-file legacy `model.scad` still renders
without a brief but does not become checked/ready.

No physical testing is implied. Review slicing, supports, material, shrinkage and actual fit;
use a fit coupon before a full part where worthwhile.
