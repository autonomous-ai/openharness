# SQLite browser runtime

Unmodified sqlite3.js and sqlite3.wasm from the official SQLite 3.53.4
distribution: https://www.sqlite.org/2026/sqlite-wasm-3530400.zip
Archive SHA3-256 and individual SHA-256 hashes are in checksums.json.

SQLite source and documentation are dedicated to the public domain:
https://www.sqlite.org/copyright.html
The JavaScript file retains the upstream license banner. Its generated
Emscripten glue is offered under MIT and University of Illinois/NCSA terms:
https://emscripten.org/docs/introducing_emscripten/emscripten_license.html
The exact Emscripten 5.0.1 license and its bundled musl copyright notice are
included as EMSCRIPTEN-LICENSE.txt and MUSL-COPYRIGHT.txt, from the upstream
emscripten-core/emscripten repository at the 5.0.1 tag.

No upstream ownership, endorsement or warranty is implied. This package uses
in-memory SQLite only; OPFS, localStorage and extension loading are not used.
