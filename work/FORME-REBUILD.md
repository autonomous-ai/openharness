# Creative Direction: editable brand and launch delivery

2026-09-20. First of the user's five sequential rebuilds. The original preset implementation
remains in `store/tools/experiences/creative-direction.*`; it no longer builds this package.

## What changed

Forme now authors arbitrary project data from a business brief. Shared copy, colors, licensed
fonts, original vector symbols and supplied image assets feed individually composed applications.
The person can edit actual layers, preserve local overrides, compare an approved version,
undo changes and save directly to the agent's workspace. Saves retain complete source history
and reject stale revisions. A delayed source poll cannot overwrite a successful save.

Delivery includes editable SVG, PNG, transparent logos, licensed fonts, original source images,
tokens, a portable project/studio, a static website and a brand guide. The workspace exporter
also produces dimensioned PDFs and the PDF guide. It does not claim a working commerce backend
or printer-specific color and bleed validation.

## Tested briefs and revisions

These are authored acceptance fixtures, not customer commissions or autonomous engine trials.

| Brief | Distinct work | Targeted revision |
|---|---|---|
| Morrow bakery | Two vector identities; six coordinated applications per direction; editable menu | Opening weekend changed to 3–4 October |
| Vectorial consultancy | Supplied monogram; technical grid; proposal, service and event materials; custom website | Event moved to 29 October, 18:00 UTC |
| Stillwater ceramics | Original currents mark and clay illustration; product/workshop materials; custom website | Workshop price changed to $75 |

The revision suite uses actual project import and backups, then exports before and after.
Only SVG artboards bound to the revised field changed. All other copy, geometry, fonts, source
assets and logo vectors were preserved. The consultancy's supplied SVG survived byte for byte.
Logo rasters are compared after decoding: vectors must be exact; a tiny transparent-edge rounding
tolerance accommodates separate browser rasterizations. This is not a cross-browser pixel guarantee.

## Verification completed

- 21 package/model/workspace tests passed, including stale saves, foreign origins, invalid
  imports, filesystem boundaries, rotated logo crops and approval data.
- Shared release suite: 110 model/package/viewer tests; 43 CLI Store/conformance tests. Generated
  artifacts, branding and catalog checks passed. The local desktop identity test could not start:
  installed Dart is 3.12.2 while this checkout requires 3.13.0. The tagline is the only desktop change.
- Actual Chrome interaction passed: shared/local edits, drag/undo/lock, complete saves and
  backups, delayed-poll regression, source revision/draft recovery, approved comparison,
  native saved-project picker, portable reopening, both bakery directions and 390px layout.
- Browser ZIP opened with Python zipfile; 32 files, six SVGs and six 2× PNGs, font files,
  transparent logo exports, project, portable studio and website.
- Three briefs, before and after: 36 SVG/PNG/PDF artboards opened by an independent reader
  using Python stdlib and Poppler. SVG hashes/XML, PNG chunks/dimensions, real logo alpha,
  one-page PDFs, physical dimensions and extractable PDF text passed. Font files/licenses
  accompany every delivery; PDF font inspection confirmed embedding.
- Visually inspected all three collections and exported artwork, including the corrected
  clay-colored ceramic illustration, bakery menu and opening poster. Reviewed all seven
  pages of the final bakery guide. All three websites fit their phone preview without
  horizontal overflow and loaded without browser exceptions.
- Store images are screenshots of these authored projects, not promotional mockups.

The checks found and fixed clipped PDF pagination, collapsed menu price spacing, hollow-mark
dragging, draft recovery, approval font retention, misleading portable save labels and a polling
race. Those were user-facing defects; screenshots alone would not have caught all of them.

## Reproduce

From the repository root, after package setup, with Chrome/Chromium and Poppler available:

```sh
node --test store/agents/creative-direction/test/*.test.mjs
node store/agents/creative-direction/test/browser.mjs
node store/agents/creative-direction/test/acceptance.mjs
python3 store/agents/creative-direction/test/verify-delivery.py PATH_TO_ACCEPTANCE_RUN
node store/tools/build-experiences.mjs --check
node store/tools/build-experience-branding.mjs --check
```

Use `EXPERIENCE_OUTPUT` to choose evidence storage. The acceptance script prints its unique run
directory. `examples/materialize.mjs NAME NEW_DIRECTORY` creates isolated editable projects.
CI runs the browser and independent delivery checks as well as package checks.

## Remaining product evidence

The rebuilt package is relisted so the user can test it. Passing these finite checks does not
establish a subjective “wow,” logo distinctiveness, trademark clearance or print-shop approval.
Actual installed-engine completion of new customer briefs and user acceptance remain separate
from the authored fixtures above. The technical tools keep `ready:false` pending real review.
Voxel Worlds is next; Drone Pilot, Game Master and Lab Bench remain unlisted while awaiting rebuilds.
