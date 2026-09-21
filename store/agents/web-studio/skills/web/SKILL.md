---
name: web
description: Build and verify interactive HTML experiences in Web Studio's live, sandboxed preview.
---

# Web Studio

`index.html` is the entry point. Local JS, CSS, images and ES modules work through the shared viewer;
use relative URLs. No bundler is required. Prefer local assets for a reliable first open.

Field's starter uses WebGL2 with a Canvas 2D fallback. Its geometry, palette and controls are all
editable. Keep GPU resources and geometry buffers reusable; coalesce continuous updates in rAF.
Pause animation when hidden and respect reduced motion. Controls must still work when paused.
A new visual direction can replace the starter entirely when that serves the user's request.

## Verify the experience

Keep `proof.json` aligned with the current page. Each action names a CSS `selector`, followed by
`click: true`, `fill` or `select`; assertions use exact `text` or
`attribute: {"name":"aria-pressed","value":"true"}`. Include a state change and its meaningful result.

```sh
node "$WEB_SKILLS/web/scripts/screenshot.mjs" "$HARNESS_WORKSPACE/index.html"
node "$WEB_SKILLS/web/scripts/perf.mjs" "$HARNESS_WORKSPACE/index.html"
```

The proof runs the real sandboxed HTTP viewer, checks the actions and browser errors, saves
`.harness/last.png` and a dependency-hashed `browser-proof.json`, and refreshes the verdict.
Inspect the image and test a narrow viewport as well as desktop.

The performance probe drives those controls while measuring rAF delays and long tasks, rather than
measuring an idle page. Target ≥55 fps and <2% slow frames. Record the hardware/renderer and dataset;
a software WebGL renderer is not a measurement of the user's GPU. `PLAYWRIGHT_CHANNEL=chrome` can
measure installed Chrome. Do not label an unmeasured or failing page “60 fps.”

Helpers need Playwright plus Chromium, installed in the shared isolated-web-viewer package or addressed by
`PLAYWRIGHT_MODULE` (absolute path to `playwright/index.mjs`). Missing tooling is a failed proof,
not permission to report success. The preview itself needs only Node 20+.
