# GIS / Atlas

Bring a dataset into a map you can explore. **Atlas** includes an offline world outline, a searchable
feature list, geometry filters, property inspection, keyboard selection, pan/zoom, two-point
distance measurement and GeoJSON export. Imported data stays local.

Try: “Map these locations, help me compare them, and export just the places I select.”

Choose **GIS** in the Harness Store, then select an empty folder in New Harness. Requires the
shared Web Viewer (Node 20+); no GIS server, map account or CDN. Local development:

```sh
harness dsh install "$PWD/store/agents/gis" --link
harness dsh doctor autonomous/gis
```

The starter supports GeoJSON points, lines, polygons and their Multi variants (WGS 84), with
2,000-feature/100,000-vertex/5 MB limits. The agent can adapt the map for larger or different data.
Browser imports persist only when exported.

Natural Earth outlines are coarse and public-domain; distances are spherical estimates, not travel
routes or survey measurements. The city starter's population values are illustrative.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
