---
name: gen-art
description: Create original vector artwork and complete visual asset sets from a person's brief, with custom drawing programs, user-editable controls and real SVG/PNG/source delivery.
---

# Original work from a brief

The studio is infrastructure. The program is the art. Never restrict a new brief to the example's
flowers, palette or layout. Build the new system in these files:

- `sketch/project.json`: `spec: "fieldwork/1"`, a stable lowercase `id`, title, brief, seed,
  named `formats` with width/height in pixels, `controls`, and optional image `assets`.
- `sketch/artwork.js`: JavaScript function body returning SVG children as a string.
- `sketch/DESIGN.md`: the brief, decisions, requested deliverables, revisions and evidence.
- `studio/`: reusable UI and runtime. Change it only when the task needs a new authoring capability.

## Renderer contract

The function receives `width`, `height`, `seed`, `values`, `assets`, `rng` and `svg`.
`rng('named-stream')` returns a stable random-number function. Never use time or `Math.random()`
for the geometry. `values` contains the current control values; `assets.name` is an embedded image
URL or an empty string. `svg.el(tag, attributes, children)` and `svg.text(text, attributes)` escape
attributes and text. The latter is essential for the person's real text (including `&` and `<`).

```js
const r = rng('constellation');
const marks = Array.from({length: values.stars}, () => svg.el('circle', {
  cx: r() * width, cy: r() * height, r: 1 + r() * 4, fill: values.ink
}));
return svg.el('rect', {width, height, fill: values.paper}) + marks.join('');
```

That tiny example illustrates the contract, not an acceptable finished commission. Use original
composition and domain-appropriate detail. The full SVG vocabulary is available, including paths,
gradients, masks, clipping, patterns, groups, transforms, typography and embedded images.
Rendering runs in a worker with a five-second limit; keep it responsive. A render error preserves
what was visible and disables stale exports until the drawing works again.

## Project controls and assets

A control has `key`, `label`, `type`, `value`. Types:
- `text`, optionally `multiline: true`; can also hold user-pasted CSV/JSON interpreted by the program.
- `color`: six-digit hex.
- `range`: `min`, `max`, optional positive `step`.
- `select`: string `options`.
- `toggle`: boolean.

Use at most 40 meaningful controls, not a wall of arbitrary knobs. Formats are 64–8192 pixels per
side. PNGs are bounded to 32 megapixels. Every control must visibly affect the intended part.
An asset has `key`, `label`, optional `file` relative to `sketch/`. The builder embeds PNG/JPEG/WebP/SVG
bytes; it refuses a path outside that folder. The user can replace images in the pane. All exports
must stay portable: no external image/font URLs, script tags or active SVG content.

## Build, deliver, revise

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs --seeds 3 --scale 1
```

`GENART_DSH_DIR` points to the installed package. Setup installs pinned Playwright locally and uses
an installed Chrome or downloads a local Chromium. Export tooling supports `BROWSER_EXECUTABLE`
and `PLAYWRIGHT_MODULE` for testing. Nothing sends art or prompts to a paid service.

The browser exports individual SVG/PNG, an all-format ZIP, a seeded edition ZIP, an editable
project and a portable studio. Inspect their actual bytes and reopen the project. For revisions
from a user-saved project, run `node tools/import-project.mjs FILE` first; it preserves a backup.
Do not overwrite a browser user's choices with old source defaults without acknowledging the conflict.

The exporter checks same-seed geometry and PNG dimensions, but leaves `ready:false`. Inspect
all formats and their text, image placement, clipping, margins, color and scale. If randomness
is promised, test distinct seeds as well as repeated seeds. If a print edition promises a bounded
range, sample that range. Document font differences and any remaining production work.

Only mark ready after the user's deliverables exist and pass both technical and visual review.
Never label a starter, a thumbnail, a screenshot of a tool, or a successful reload as the finished work.
