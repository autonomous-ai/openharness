# Provenance

The planner, geometry adapter, editable UI, data importer, file exporters and synthetic site
fixtures are original OpenHarness contributor work under the package MIT license. The original
FPV canyon implementation remains in `store/tools/experiences/`. The existing Vector identity
is retained; no generated bitmap or downloaded map imagery is included.

- `clipper-lib` 6.4.2 / JS port 6.4.2.2, Boost Software License 1.0 with embedded Tom Wu JSBN terms.
  The vendor file is unmodified, SHA-256
  `a650c6946682edc1a64016f6553eeb5c32ce45eb7ca0ad5d8221961af011d97c`.
  https://github.com/junmer/clipper-lib and https://sourceforge.net/p/jsclipper/wiki/documentation/
  Full notices are in `template/studio/vendor/LICENSE-BOOST.txt` and `LICENSE-JSBN.txt`, the
  standalone HTML payload, and exported `LICENSES.txt`. JSBN license mirror:
  https://github.com/andyperlitch/jsbn/blob/master/LICENSE
- esbuild 0.27.2, MIT, build time. https://github.com/evanw/esbuild
- Playwright Core 1.63.0, Apache-2.0, browser verification. https://github.com/microsoft/playwright
- Shapely 2.0.7 / GEOS and NumPy 1.26.4 are independent test readers, not package runtime dependencies.
  https://shapely.readthedocs.io/en/2.0.7/manual.html
- WGS 84 parameters: https://earth-info.nga.mil/index.php?dir=wgs84&action=wgs84
- GeoJSON: https://datatracker.ietf.org/doc/html/rfc7946
- KML: https://www.ogc.org/standards/kml/

No satellite imagery, real flight records, personal telemetry, aircraft connection, native GIS
import, customer trial or installed-agent prompt completion is implied by authored fixtures.
QGroundControl formats were researched but executable mission export is not part of this release.
