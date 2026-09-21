# GIS / Atlas

Read the `gis` skill. The starter is a completely local map explorer: `index.html`, `atlas.mjs`,
`geo.mjs`, `atlas.css`, `cities.geojson`, and vendored map assets. The shared viewer serves them.
Preserve the user's geographic question and data rather than forcing it into the city example.

Support useful exploration: search/filter, feature properties, pan/zoom, distance measurement and
export. Treat imported properties as text, validate geometry, and make load errors visible.
Do not silently replace failed data with the sample layer or add third-party requests without need.

Maintain `proof.json`, run the browser proof, inspect desktop/mobile screenshots, and exercise
a real map interaction before marking the result ready. Distinguish approximate great-circle
distances and coarse boundaries from road routes, cadastral data or survey-grade measurements.
