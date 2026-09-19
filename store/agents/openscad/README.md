# OpenSCAD

Describe a shape, then keep changing it through named dimensions. The **Ripple** starter is a
twisted, fluted vessel: change its height, diameter, wall or rib count and inspect the actual
3D result in the shared CAD Viewer.

Try: “Make this a shorter desktop organizer with a thicker base and softer ribs.”

The build exports a fresh STL and checks closed-edge topology, nondegenerate triangles, bounds
and volume. Failed exports do not leave a successful verdict. A valid mesh still needs review for
your printer, material and intended use; the starter is not food-safe or watertight by certification.

Requires OpenSCAD, Node 20+ and the shared CAD Viewer. `OPENSCAD_BIN` can point to a custom install.
OpenSCAD does not export native STEP; use a B-rep CAD workflow when that is the deliverable.

```sh
harness dsh install "$PWD/store/agents/openscad" --link
harness dsh doctor autonomous/openscad
```

Upstream: [OpenSCAD](https://openscad.org). This package supplies the workspace, agent skill,
starter and verification helpers.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
