# OpenSCAD acceptance — real part families

Validation date: 2026-09-20. Native engine: OpenSCAD 2021.01 on macOS. Unit/native runner:
Node 22.23.2. The actual `render-part.sh` entrypoint was also exercised. The shared CAD pane used
its pinned cadgen 0.5.1 viewer. No physical print or hardware test is claimed.

## Complete workflows

**Drawer Grid:** three sizes (150/180/210 × 96 × 40 mm), three clear compartments, 2.4 mm floor and
walls. The native build requires agreeing repeat exports and passes 24 measured checks:
closed/positively oriented meshes and expected surface shells, saved bounds, each pocket, floor/divider/back-wall material,
print-envelope fit and native final-STL reopening. Three native reference sections accompany
each variant.

A substantive revision changes depth to 104 mm and the compartment count to four while retaining
the same floor/wall requirements. It passes. Deliberately thinning the floor, obstructing a pocket
or choosing a too-small printer fails and leaves the previous complete ZIP byte-identical.
Extracting the ZIP into a separate directory and running its own `node rebuild/build.mjs .`
regenerates the same source revision, checks and measured part bounds without Harness/npm/Python.
An undeclared private workspace note is excluded from the archive.

**Bottle Bench:** independent cylindrical geometry: six 26 mm craft-paint bottles; radial clearance
variants 0.15/0.30/0.45 mm; a separate matching fit-test ring for each. All six parts pass 39 checks.
The ring starts in negative X/Y design coordinates, is rotated 180° and exported into nonnegative
bed coordinates. Every bore, the rack floor, ring material sample and a declared noninterfering
placement are measured from the exported meshes. A deliberately overlapping placement fails
without replacing the good project. The ring is an artifact for a future real fit test, not
evidence that one happened.

**Legacy:** original Ripple source still renders as a closed mesh. Without a saved checked brief,
readiness stays false and the result is explicitly a geometry preview.

## Negative and portability evidence

- Native assertion failures and unknown modules cannot masquerade as a successful empty query.
- Two differing source exports reject unseeded random geometry.
- Native dependency receipts reject an undeclared external source; a declared relative include works.
- Source symlinks and unsafe/reserved source paths fail. Source edits during compilation invalidate
  the candidate and preserve the previous STL.
- Build locking leaves another writer's verdict untouched.
- Unknown schema fields, invalid parameter overrides, noninteger counts, missing bounds,
  unsupported expressions and reserved/ambiguous export/check IDs are rejected.
- STL tests cover ASCII/binary agreement, volume, bounds, opposite edge orientation, open and
  degenerate surfaces, independent surface shells and negative signed volume.
- Transport fixtures are labelled as fixtures; they are not used as native-render evidence.

## Browser and visual evidence

The actual print-oriented organizer, wide variant, bottle rack and fit ring were opened in the
shared CAD Viewer. Zoom and reset interactions were exercised; saved screenshots were inspected.
These are real STL loads, not reconstructed illustrations.

The handoff is exercised in Chromium at 1600 × 1100 and 390 × 844. Checks cover initial selection,
all three configuration buttons, the comparison table, every native SVG image, every evidence
panel, no horizontal page overflow and no JavaScript errors. All three organizer STLs / six
bottle-project STLs and both project ZIPs are downloaded through the browser and compared
byte-for-byte with the built files. Undeclared model/state routes return 404; POST returns 405.
The final desktop/mobile part views are visually reviewed.

Store images capture the real CAD pane and handoff. Existing logo/icon assets are retained.

## Reproduce

```sh
node --test store/agents/openscad/test/*.test.mjs

OPENSCAD_BIN=/path/to/openscad \
OPENSCAD_QA_ROOT=/path/to/qa-directory \
node --test store/agents/openscad/test/*.test.mjs

PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node store/agents/openscad/test/browser.mjs /path/to/built-project /path/to/screenshots
```

Without `OPENSCAD_BIN` the four native cases are explicitly skipped; they are not counted as
native proof. The suite has 21 cases (17 unit/transport, 4 native). Test setup uses its own
temporary install location and clears inherited OpenSCAD overrides for prerequisite checks.

Also run package conformance, skill validation, generated-experience/branding checks, and the
registry/store/catalog/publisher suite from `cli/`. Native QA workspaces, browser receipts, complete
downloads and publication receipts are retained in the release workspace, not committed generated
model binaries.

## Limits

The stated brief, exported-region probes and individual build envelope are verified, not every
possible manufacturing property. No global minimum-wall, complete self-intersection, strength,
supports, packed-plate, slicing, food-safety or physical-fit certification is implied. STL uses
millimetres; no native STEP export is promised. Source compilation is trusted-code execution,
not a sandbox. A handoff page is the last successful saved snapshot; edits require a new build.
