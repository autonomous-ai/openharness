# Generative Art — an authoring tool, not a style picker

Turn the person's idea into original visual work they can use. They should not need to draw,
program, or accept the look of our example. The workspace is a small production studio whose
**drawing program, controls, assets and deliverables belong to the brief**.

Read `skills/gen-art/SKILL.md`. Start by reading `sketch/project.json` and `sketch/artwork.js`.
The Night Garden festival is an example output, not the product or a default style to preserve.
Replace its drawing system for a different brief. Do not simply recolor or reseed it.

## Work from the real task

1. Identify the thing the person will actually use: a print edition, packaging graphic, identity
   assets, an illustration, a visual explanation, a pattern or a set of social assets. Use their
   actual words, data and images. Ask only for material that is necessary and missing.
2. Create a visual system appropriate to that task. Write new geometry in `sketch/artwork.js`;
   it is arbitrary JavaScript producing SVG, not an enum of techniques. Expose the meaningful
   decisions in `sketch/project.json`: text, colors, dimensions, ranges, toggles and image slots.
3. Compose each requested format. A wide banner needs a different layout from a portrait, not
   a stretched poster. Keep important text editable, allow safe margins and respect long titles.
4. Run `node tools/build.mjs`. The pane reloads with the user's project and its own controls.
5. Run `node tools/export.mjs --seeds 3`. It exports every named format as real SVG and PNG,
   an editable project and a portable studio into `delivery/`, plus a verification report.
6. **Inspect those files.** Open the actual exported images, look at every format, check their
   text and composition against the request, fix defects, then export again. A deterministic
   program can produce bad art. A successful build is never a ready verdict.
7. Deliver the files and explain one useful next revision. Record user decisions and unresolved
   limitations in `sketch/DESIGN.md`. Update `.harness/verdict.json` honestly.

## Revisions and continuity

Preserve user-approved text, uploaded assets, dimensions and choices when revising. A new creative
request may justify a new program; a request to move a logo does not justify replacing everything.
The studio autosaves controls locally, has undo/redo, and can save a complete `.fieldwork.json`.
Browser drafts are not automatically written into source files. To incorporate a saved project,
run `node tools/import-project.mjs path/to/project.fieldwork.json` before editing. This keeps a
source backup in `.harness/history/`. Do not pretend to have read edits you cannot access.

When source changes and a browser draft exists, the studio offers the new version or the saved
draft. The old draft must not silently overwrite a new agent revision or disappear during reload.

## What this tool can and cannot deliver

- Arbitrary static SVG illustration and procedural geometry; real text, embedded images, named
  formats, editable vectors, PNGs, project source, portable HTML and reproducible SVG editions.
- The agent writes code; the person uses the studio and speaks in the Harness chat. Do not make
  them use a code editor. There is no fake AI prompt box or hidden remote generation service.
- SVG is RGB artwork, not a print shop's CMYK, bleed, font-outline or color-profile guarantee.
  Use the user's print specification or explain the remaining production step.
- System-font text can change on another computer. Use compatible installed fonts and verify on
  the target system, or explicitly arrange an outlined/embedded-font delivery when needed.
- Do not call this photo generation, a video editor, or a complete branding service. For a task
  that needs other real tools, integrate and verify those tools; don't simulate their output.

The authoring rebuild is listed in the Store for user testing. Remaining product validation is
recorded in `work/SUPERPOWERS.md` in the source repository; listing does not mark any artifact ready.
