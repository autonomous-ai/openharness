# GIS provenance

Atlas's explorer, validator, tests and package glue are original OpenHarness work (MIT).

- `template/vendor/leaflet.js` and `leaflet.css`: Leaflet 1.9.4, BSD-2-Clause. Upstream
  [Leaflet/Leaflet](https://github.com/Leaflet/Leaflet/tree/v1.9.4). Unmodified distribution files;
  license included as `vendor/LICENSE`. npm tarball SHA-512:
  `nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==`.
- `template/countries.geojson`: Natural Earth v5.1.2, `ne_110m_admin_0_countries.geojson` at commit
  `f1890d9f152c896d250a77557a5751a93d494776` from
  [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/tree/f1890d9f152c896d250a77557a5751a93d494776).
  Geometry is unchanged; unused attributes were removed, retaining the English name.
  [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/): public domain.
  Boundaries follow that dataset's conventions and are not a statement about disputed sovereignty.
- `cities.geojson`: original illustrative starter. Coordinates identify cities; population numbers
  are demonstration values and must not be treated as demographic evidence.

No network service is contacted by the default map.
