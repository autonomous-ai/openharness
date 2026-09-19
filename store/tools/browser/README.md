# Group A browser verification

These tests exercise real templates through the shared Web Viewer's opaque-origin iframe.
They cover data loading, user interactions, downloads, errors, and responsive layout.

Install Playwright and Chromium in your development environment. If Playwright is not available
through normal module resolution, set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path.
Run from the repository root:

```sh
node --test --test-concurrency=1 store/tools/browser/*.test.mjs
```

Set `HARNESS_QA_DIR` to a directory outside the workspace to retain screenshots. Tests create
temporary workspaces and remove only those they created. Headless Chromium and loopback servers
need permission to run outside restrictive macOS sandboxes.

The reusable runtime probe ships with `store/viewers/isolated-web-viewer/probe.mjs`. The harness proof/perf
commands call it through the installed viewer dependency. Put `proof.json` in a generated workspace
to describe a real interaction and an assertion of its result; adapt the starter recipe when changing
the product. It accepts CSS selectors with `click`, `fill`, `select`, exact `text`, and `attribute`
checks. A missing recipe, a browser error, or a failed assertion fails the probe.

Proof runs write `.harness/browser-proof.json` (including hashes of loaded local resources) and
`.harness/last.png`. Performance runs exercise the recipe during sampling and record frame rate,
95th-percentile frame intervals, slow-frame proportion, long tasks, and interaction rounds in
`.harness/perf.json`. These are browser frame timings on the test machine, not end-to-photon latency
or proof of performance on every device.

Use `PLAYWRIGHT_CHANNEL=chrome` to benchmark installed Chrome with the machine's GPU. On this
Intel Mac the default headless-shell browser uses SwiftShader, while Chrome uses the Radeon/Metal
renderer. Reports include that distinction. Keep performance tests serial so they do not compete
for the same GPU. Proof mode also updates `.harness/verdict.json`, including on failure.

## Native output checks

Native browser tests are opt-in: first run the real package build, then set
`GODOT_QA_WORKSPACE`, `ORCA_QA_WORKSPACE`, `FIRMWARE_QA_WORKSPACE`,
`SCORE_QA_WORKSPACE` and `SHEET_DOCS_QA_WORKSPACE` to those project directories.
Without them, the corresponding tests report skips, not native success.
The document test also requires the shared Doc Viewer's pinned PDF.js dependency.

`showcase.mjs` captures 1600×1000 JPEGs directly from actual interactive previews.
It uses the same native workspace variables and writes only the matching folders
under `store/showcase/`. To capture the PDF reader, run its test with
`HARNESS_SHOWCASE_DIR` set to the absolute `store/showcase` directory. CAD images
come from the actual CAD Viewer with the inspected STL/STEP loaded, not a mockup.

These new harnesses use `autonomous/isolated-web-viewer`. Existing packages keep
their separate trusted `autonomous/web-viewer` behavior; this release does not
change their storage or iframe contract.
