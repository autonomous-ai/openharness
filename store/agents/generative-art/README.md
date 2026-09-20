# Generative Art — Fieldwork

> Withdrawn from Store discovery on 2026-09-20: the current starter does not meet our
> standard for an open-ended tool that completes real user work. Existing projects and
> source remain available. See [the product review](../../../work/SUPERPOWERS.md).

![Generative Art logo](brand/logo.svg)

Design reproducible generative editions. Explore contour fields, dunes and orbital studies, tune their geometry and palettes, and export prints up to 3200 × 4000.

## Try it

> Create an edition of 12 tidal contour prints in indigo and burnt orange. Keep the paper quiet and make each seed feel related but distinct.

The starter already works before the first prompt. Change it with the agent, interact with the
result in the pane, and keep the output. Everything needed at runtime is in `sketch/index.html`.
It works offline and can be opened outside Harness.

## What you can do

Three techniques, named random streams, palette selection, density/tension controls, nearby seed previews, high-resolution PNG export.

## Build on the starter

The model functions `artModel` and `artPaths` are the starting points for substantive changes. Preserve seed
reproducibility and user controls while changing the domain behavior. A different brief can replace
this starter's entire visual language. Keep the artifact self-contained and test the actual result.

The source checkout builds these starters with `node store/tools/build-experiences.mjs`. Installed
workspaces are editable HTML; no build tool, network dependency or paid service is required.

## Verification

Model census: `node --test store/tools/experience-tests/models.test.mjs` from the source checkout.
Browser interactions, exports, same-origin APIs and manifest routing: see
[`store/tools/experience-tests`](../../tools/experience-tests/README.md).

`seed-verdict.sh` establishes only artifact presence and keeps `ready:false`. The agent must run
and record real domain and browser checks before writing a ready verdict. No cross-device pixel or
audio equality is promised. The research is inspiration; this is original code, not a wrapper of
any cited third-party engine.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.

## Logo and icon

The original identity ships in `brand/`: [vector icon](brand/icon.svg),
[256px PNG](brand/icon.png), [light logo](brand/logo.svg) and
[dark logo](brand/logo-dark.svg). The same mark appears in the starter header,
its offline favicon and the desktop Store/picker/tabs. MIT, by OpenHarness contributors.

## Credit and stewardship

Original implementation and visual identity by OpenHarness contributors, maintained by
Autonomous under the [MIT license](LICENSE). Report issues in the OpenHarness repository.
