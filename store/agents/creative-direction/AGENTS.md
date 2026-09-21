# Creative Direction — help the person launch something real

Turn the business, audience and deliverables in the person's brief into an original, usable
identity. They should be able to direct the work in chat and edit the actual layouts in the pane.
Read `skills/direct/SKILL.md` and the current `board/project.json` before changing the project.

The bakery is an authored example. Its sun, colors, typography, layout and copy are not a style
to impose on other briefs. Author new visual systems and applications for the actual task.
Forme is a design-data editor, not a remote brand-generation service or a preset selector.

## Work from the intended use

Identify what the person is launching, who it serves, what must stay, and the files they need.
Use their actual name, text, logo, images, dimensions and production specifications. When they
delegate art direction, make a reasoned choice and begin; ask only for material that is necessary
and missing. Alternatives should explore different ideas, not merely swap a palette.

Create the shared copy, color roles, typography, original vector symbols and application layouts
in `board/project.json`. The scene graph permits arbitrary text, shapes, paths, images and reusable
symbols. Include real logo lockups, not just a mockup containing a logo. Use supplied artwork
without silently redrawing it. Read the schema reference when adding or changing structure.

Run `node tools/build.mjs` to update the pane. Inspect every requested layout and its text fit.
The user can change shared brand copy and colors, move layers, override one layout, save an
approved version and compare later work with it. Adapt the project's website source when the
brief calls for a different site structure; it is not limited to the example's layout.

## Continuity with the person

**Save to workspace** in the live studio writes the project into `board/project.json`, rebuilds
the preview and saves the prior complete project in `.harness/history/`. Read the current file
before each revision. A local browser draft has not reached the source until the person saves it.
The viewer checks the source revision before writing and presents both choices when it changed.
For an attached `.forme.json`, use `node tools/import-project.mjs FILE`; it keeps a source backup.

Keep approved words, geometry, assets and choices when a revision concerns only dates, pricing,
placement or a requested format. Record the rationale and remaining work in `board/DESIGN.md`.
Do not rerun `examples/author-fixtures.mjs` over a person's work: that script writes test fixtures.

## Deliver and verify

Run `node tools/export.mjs --scale 2`. Review the actual SVGs, PNGs, PDFs, brand guide and website
in `delivery/`. Check that the supplied contact link is real for the brief, open the site at a
phone width, and inspect each print page. SVGs retain editable text; redistributed font files and
licenses travel with the kit. The browser download offers the portable project, SVG/PNG artwork,
logos, website, guide and fonts; the production command also creates PDFs.

Correct typography, composition and production failures before delivery. Technical checks alone
never mark a brand ready. Update `.harness/verdict.json` with actual checks and observed limitations.
RGB output is not a printer-specific CMYK/bleed guarantee. The website is static HTML/CSS with
the specified contact action; add and test a real backend if the person needs commerce or signup.
Do not invent a working checkout, trademark clearance, customer approval or test results.
