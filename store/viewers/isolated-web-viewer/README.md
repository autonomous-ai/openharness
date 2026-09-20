# Isolated Web Viewer

A shared live preview for local HTML, CSS, JavaScript, data and WebAssembly. Node.js 20+ is the
only preview dependency. No bundler or second application server is needed.

Declare `"viewer": { "use": "autonomous/isolated-web-viewer" }` in a harness manifest. The pane follows the
HTML artifact named by the verdict, or the newest matching file; an empty file selection falls
back to `index.html`. A harness can still override the viewer URL for a fixed entry point.

The toolbar includes fitted, mobile, tablet and desktop widths, manual reload, and a Live/Pause
switch so file changes do not interrupt an interaction you are inspecting.

## Isolation and asset loading

The iframe permits scripts, downloads and pointer lock, but deliberately omits `allow-same-origin`.
It cannot read the parent shell, use origin-backed local storage or register a service worker.
Use downloaded files to persist interactive edits. Godot Web exports must be single-threaded and
not depend on SharedArrayBuffer or a service worker.

A random, per-server capability prefix lets the opaque-origin iframe fetch sibling assets with
CORS. Relative JSON/CSV/GeoJSON requests, ES modules and streaming WASM work inside the sandbox.
Normal `/files/` URLs do not receive CORS permission; use relative paths, not hardcoded root paths.
Do not expose or reuse the capability URL as a public sharing mechanism.

The server is read-only, loopback-only, and rejects hidden paths, `node_modules` and symlinks that
escape the workspace or expose hidden files. It streams ordinary files up to 32 MiB; WASM and PCK
game assets have a bounded 128 MiB allowance. This is a local preview, not a production web server.

## Verification tooling

`probe.mjs` is an optional agent/developer helper. Install Playwright and Chromium in this package
(`npm install --no-save playwright` and `npx playwright install chromium`), or set `PLAYWRIGHT_MODULE`
to an existing absolute `playwright/index.mjs` path. It does not install dependencies on import.

Harness wrappers call the probe with a workspace `proof.json`: selectors, actual control changes
and assertions of exact text or attributes. Proof mode runs the real sandbox, checks browser errors,
captures `.harness/last.png`, records loaded-file hashes in `browser-proof.json`, and refreshes the
verdict, including on failure. A missing assertion recipe or browser is not a successful proof.

Performance mode runs interactions while sampling frame delays and long tasks. It records the
canvas renderer; `PLAYWRIGHT_CHANNEL=chrome` selects installed Chrome when a real GPU benchmark
is needed instead of headless-shell's software WebGL. Frame timing is not end-to-photon latency.

```sh
harness dsh check store/viewers/isolated-web-viewer
harness dsh install "$PWD/store/viewers/isolated-web-viewer" --link
node --test --test-concurrency=1 store/viewers/isolated-web-viewer/test/*.test.mjs
node --test --test-concurrency=1 store/tools/browser/*.test.mjs
```

## Credit and stewardship

Built for OpenHarness by its contributors, MIT. No third-party packages are required to serve a
preview; Playwright is separate optional verification tooling. See [LICENSE](LICENSE)
for the wrapper's terms. Wrapper issues belong in OpenHarness; upstream maintainers
are welcome to discuss stewardship. No upstream endorsement is implied.
