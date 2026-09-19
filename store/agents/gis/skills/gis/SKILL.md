---
name: gis
description: Build and verify interactive GeoJSON maps in Atlas, with local exploration, safe imports, feature inspection and export.
---

# Atlas

The starter uses locally vendored Leaflet 1.9.4 and Natural Earth 1:110m country outlines.
No internet or tile account is required. Keep attribution and `vendor/LICENSE` when reusing them.
Use relative URLs in the shared sandboxed viewer. For detailed streets or large datasets, choose
appropriate licensed tiles/data explicitly; do not present the coarse offline layer as detailed mapping.

`cities.geojson` seeds real locations with illustrative population values, not official estimates.
Imported GeoJSON must be a WGS 84 FeatureCollection, coordinates `[longitude, latitude]`.
The local validator handles Point, LineString, Polygon and Multi variants, up to 2,000 features,
100,000 vertices and a 5 MB upload. Closed rings are checked; polygon topology/self-intersections
are not. Simplify large data or use a more suitable renderer instead of freezing the UI.

The feature list shows at most 100 names while the map renders all filtered features.
Search, geometry filtering, selection and export use the same source records. Use `textContent`
for properties and tooltips; never interpolate uploaded strings as HTML.

The distance tool measures a mean-radius spherical great-circle distance between two points;
its straight map segment is only a visual connector. It is not a road route or survey result.
Antimeridian data may need split geometries for intuitive display in Web Mercator.
Imports are temporary browser state; export to persist.

## Prove and inspect

```sh
node "$GIS_SKILLS/gis/scripts/proof.mjs" "$HARNESS_WORKSPACE/index.html"
node "$GIS_SKILLS/gis/scripts/perf.mjs" "$HARNESS_WORKSPACE/index.html"
```

Helpers use the real shared HTTP viewer, current `proof.json` interaction assertions and Playwright
with Chromium. Install Playwright in the shared viewer or set `PLAYWRIGHT_MODULE` to its `index.mjs`.
Proof captures `.harness/last.png`, errors and dependency hashes and updates the verdict.
Inspect pan/zoom, search, selection, two-point measurement, import/export and a narrow viewport.
Test an empty selection, malformed GeoJSON and untrusted property text. Never call a map verified
because a Leaflet container merely exists.
