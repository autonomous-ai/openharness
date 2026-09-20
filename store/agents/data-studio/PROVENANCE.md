# Data Studio provenance

The import contracts, CSV parser, SQLite adapters, query guards, viewer,
portable-delivery helpers, synthetic example records, instructions and tests
are original OpenHarness work (MIT). ZIP and filesystem transaction helpers
are adapted from OpenHarness's OpenSCAD/OrcaSlicer workflows under the same MIT
license. Neither example represents real people, sales, shipments or carriers.

## Native and browser engines

The build uses Node's built-in node:sqlite; Node is supplied by the host or the
Harness-managed runtime, not bundled here. API:
https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html

The browser uses the **unmodified official SQLite 3.53.4** JavaScript/WebAssembly
assets from https://www.sqlite.org/2026/sqlite-wasm-3530400.zip.
The archive's SHA3-256 was verified against the official download page:
e4fa7e1750b42f6954115d8e69ffff7dc08da7e9fee6e28a2a0ea6bf228a49f2.
Individual SHA-256 hashes are committed in template/vendor/checksums.json and
checked by setup, build and browser loading.

SQLite is public-domain software. Its generated Emscripten glue has MIT and
University of Illinois/NCSA terms. The upstream banner, exact Emscripten 5.0.1
license and musl copyright notice are retained in template/vendor/ and every
portable project. See vendor/NOTICE.md and https://www.sqlite.org/copyright.html.

Implementation references:
https://www.sqlite.org/wasm/doc/trunk/api-oo1.md
https://www.sqlite.org/wasm/doc/trunk/cookbook.md

No OPFS, localStorage, CDN, npm runtime dependency or hosted database is used.
All source data remains local unless the user chooses to share an export.
No upstream endorsement or warranty is implied.
