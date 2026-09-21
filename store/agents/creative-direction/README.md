# Creative Direction — Forme

![Creative Direction logo](brand/logo.svg)

Turn a business brief and your own materials into a brand you can use: an original identity,
coordinated launch artwork, an editable website and a portable brand guide.

Describe the business, audience and things you need to launch. Give the agent any approved logo,
photographs, copy or licensed fonts. It authors the actual layouts and vector geometry; the
bakery shown on first launch is an editable example, not a menu of supported styles.

> I'm opening a neighborhood bakery called Morrow. Build an identity that feels warm and
> confident, with a bread label, opening poster, daily menu, social announcement and website.
> Show two genuinely different directions. Keep the prices editable across the whole kit.

> Use our supplied logo unchanged. Create a technical consultancy identity around it, including
> a proposal cover, services sheet, event announcement and responsive contact website.

Click any application to edit its real layers. Move elements, change type, add shapes or text,
and undo changes. Shared names, dates, prices, colors and typography update the connected layouts;
unlink a text layer when one application needs its own wording. Save an approved version to
compare later revisions with it. **Save to workspace** makes your canvas edits available to the
agent, with history and a choice when the source has changed in the meantime.

**Export brand kit** downloads editable SVG artwork, PNGs, transparent logo files, design tokens,
the original supplied images, licensed fonts, a brand guide, a static website and a portable studio.
Save/reopen the complete `.forme.json` project to continue elsewhere. Ask the agent for print
delivery to also produce dimensioned PDFs and a PDF guide.

The website is a responsive static page with your specified contact link. It has no checkout or
mailing-list service until those are actually built. Print exports are RGB; confirm bleed, color
profiles and production requirements with your printer. Layout checks flag overflowing copy,
but visual review and business approval still matter.

## Workspace and delivery

The workspace keeps editable source in `board/project.json`, local materials in `board/`, the
studio in `studio/` and portable tools in `tools/`. The local viewer saves explicitly to this
workspace; it does not overwrite the project merely because a saved file was opened.

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs --out delivery --scale 2
node tools/import-project.mjs saved.forme.json
```

Setup installs pinned browser tooling in the harness package and uses Chrome or a package-local
Chromium. The delivered studio and site work offline. No design service subscription is needed.
The agent's normal engine requirements still apply.

Authoring details: [project format](skills/direct/references/project.md).
The model accepts arbitrary vector layouts, up to 24 applications per direction, six directions,
and 36 MB of embedded project data. Fonts retain their redistribution licenses; bundled
DM Sans and Fraunces have [recorded provenance](template/board/fonts/provenance.json).

## Evidence

Three authored acceptance briefs exercise distinct work: the Morrow bakery, the Vectorial
consultancy with an unchanged supplied logo, and the Stillwater ceramics studio. They are fictional
fixtures, not customer commissions. Each includes six applications and a website, with targeted
revisions that preserve unrelated work. See [the rebuild evidence](../../../work/FORME-REBUILD.md)
for browser checks, independent file inspection and remaining product validation.

```sh
node --test store/agents/creative-direction/test/*.test.mjs
node store/agents/creative-direction/test/browser.mjs
node store/agents/creative-direction/test/acceptance.mjs
python3 store/agents/creative-direction/test/verify-delivery.py PATH_TO_RUN
```

Browser/export checks require Chrome/Chromium; independent PDF inspection requires Poppler.
Technical tools retain `ready:false` until the agent has inspected the actual delivered work.

## Credit and stewardship

The original [icon](brand/icon.svg), [PNG](brand/icon.png), [light logo](brand/logo.svg) and
[dark logo](brand/logo-dark.svg) appear in the studio and desktop identity system.
Original code and visual identity by OpenHarness contributors, maintained by Autonomous under
the [MIT license](LICENSE). Fonts retain their separate SIL Open Font Licenses.
