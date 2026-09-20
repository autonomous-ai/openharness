# Seven harness identities — 2026-09-20

Original vector marks now identify the seven creative harnesses. Each package ships its source
`brand/icon.svg`, a transparent 256px PNG, light and dark SVG logo lockups, and a source/output
hash record. The same SVG is embedded into the starter header and its offline favicon; the exact
PNG bytes are bundled into the desktop's existing shared identity system. Store, picker, pane,
search and native tab/history consumers therefore use one identity.

The marks are an island of voxel blocks, flowing contour lines, five tracks under a crescent,
a geometric Forme monogram, a vector through a flight gate, opposing teams around a relay,
and a flask containing a signal. All artwork is original and MIT-licensed. See
`store/showcase/experience-identities.png` for the 16/24/48px proof on light and dark backgrounds.
Each package README links its downloadable brand assets.

Validation:

- Seven browser suites passed with branded headers, 390px layouts, real controls and exports;
  actual Store screenshots were refreshed from these runs.
- 39 desktop tests passed across `engine_identity_test`, `swarm_search_identity_test`,
  `store_screen_test` and `store_showcase_test` with Flutter 3.47.2 / Dart 3.13.2.
- The identity suite was rerun after tightening its check that every package with original brand
  artwork has a registered desktop face, not a fallback initial; all six tests passed.
- Dart analysis of the changed desktop source and identity test reported no issues.
- Generated experience/brand checks and catalog validation passed. CI now checks source hashes,
  generated lockups, PNG dimensions and agreement with the desktop asset copies.
- Icon size proofs and all fourteen light/dark logo lockups were visually inspected.

The identity test allows an initial for new live-catalog packages without bundled artwork. A Store
can add entries between desktop releases; requiring a pre-existing desktop face for every future
catalog entry contradicts that supported fallback. Shipped original brands and all registered
faces are still required to have actual assets.

Publication has two surfaces: Store packages deliver the branded workspace and downloadable
logos; the native Store/picker/tab icons are bundled desktop assets and require a desktop build.
They cannot appear in an older running app merely by refreshing its catalog. The repository's
signed internal-build workflow provides a test app without changing public desktop update feeds.
