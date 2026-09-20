---
name: direct
description: Create and revise a usable brand identity and coordinated launch materials from a business brief, using the Forme project and the person's own artwork, text and production requirements.
---

# Direct an original identity

Read the current `board/project.json` and `board/DESIGN.md`. Understand the actual business,
audience, approved material and delivery requirements. The starter is a fictional bakery example,
not a default visual direction. Produce a system suited to the person's brief.

For structure, read [the project format](references/project.md). The model and validator in
`studio/project.mjs` are the executable contract. Layouts and symbols are arbitrary design data;
there is no supported list of styles. Reuse an existing direction only when it fits the request.

## Make decisions visible in usable work

Show how the identity works on the actual materials: packaging, signage, a pitch, social assets,
stationery or another requested medium. A palette and moodboard by themselves are incomplete.
If alternatives help the decision, author materially different geometry and hierarchy. If the
person already approved a direction, extend it instead of asking them to select again.

Use shared copy bindings for facts that should stay consistent. Use named color roles and embedded
fonts for the visual system. Author each format's composition, keeping important text editable.
Separate source artwork from staged applications through logo lockups and asset slots.
Keep licensed input fonts and their redistribution licenses; do not bundle arbitrary system fonts.

Put supplied image files under `board/assets/` and refer to them with `file`. The build embeds
them. The supplied font files are in `board/fonts/`; additional fonts need explicit license text.
A custom static website can live in `board/site.html` and bind to the same brand copy and tokens.

## Build, revise, hand off

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs --scale 2
node tools/import-project.mjs saved.forme.json
```

The tools are workspace-local. Browser export dependencies live in the installed package referenced
by `FORME_DSH_DIR`. Setup installs pinned Playwright and finds local Chrome or downloads Chromium.

Read `board/project.json` again before revising: the person's **Save to workspace** writes their
canvas edits there. Unsaved browser drafts remain local; do not pretend to have read them. A stale
browser save is refused, with a source-versus-draft choice. Save/import keeps history.

Inspect the actual files in `delivery/`, not only the editor. Check clipped text, line breaks,
color pairings, clear space, the brief's content, intended print dimensions and mobile website.
Open SVG/PNG/PDF independently; retain the editable project and its source assets. Fix what the
review reveals. A successful export leaves `ready:false` until that review is real.

The project is bounded to 24 applications per direction, 6 directions and 36 MB of embedded data.
For larger campaigns, separate related projects. The included site is static; its contact action
must be the user's real intended destination. Work that needs a production backend or a printer's
specific color/bleed workflow requires those actual tools and checks.
