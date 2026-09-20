# Generative Art — Fieldwork

> Unlisted while the authoring rebuild is validated. Code and existing projects remain available.
> See [the product review](../../../work/SUPERPOWERS.md).

![Generative Art logo](brand/logo.svg)

Describe original visual work in the Harness chat. The agent creates its drawing system, controls
and delivery formats. The studio lets you revise the result and export real files. You are not
limited to a menu of drawing styles.

For example: “Create packaging illustrations for my coffee roastery using my logo. I need a
portrait bag label, a square announcement and a wide shop banner. Make it feel like a woodcut.”

## Workflow

The agent writes `sketch/project.json` and `sketch/artwork.js`, then builds `sketch/index.html`.
You can change the controls created for your project, import your own images, undo/redo, change
artboards and explore seeds. Browser drafts survive reload and are kept separate from new agent
revisions. Save a `.fieldwork.json` to move your edits between sessions or attach them to the agent.

Export SVG for vector editors, PNG for publishing, all named formats as a ZIP, a seeded vector
edition, or a complete studio you can open without Harness. The editable project includes the
program and embedded images. There is no remote generation service or additional AI subscription.
The agent uses the coding-engine account already configured in Harness.

## Authoring and verification

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs --seeds 3
node tools/import-project.mjs path/to/saved.fieldwork.json
```

Setup installs pinned Playwright in the package for the agent's production exports. It uses local
Chrome when available; otherwise it installs Chromium locally. Node.js 20+ and npm are required.
The resulting HTML studio itself works offline without those tools.

The exporter repeats the actual drawing program, checks PNG dimensions and preserves source and
verification reports. Visual review and matching the brief remain required; a build never marks
an artifact ready. SVG uses editable system-font text, whose appearance may differ on another
machine. Output is RGB, not certified press-ready CMYK. This is a static vector authoring tool,
not photo or video generation.

## Credit and stewardship

Original implementation and identity by OpenHarness contributors, maintained by Autonomous under
the [MIT license](LICENSE). Playwright is a separate Apache-2.0 dependency by Microsoft. Branding
sources remain in `brand/`. Report issues in the OpenHarness repository.
