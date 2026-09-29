# Daemons review pages

Open [index.html](index.html) directly from disk. The previews embed their styles, scripts,
and data; no server, account, external fonts, or artifact host is needed. These repo files
are the review pages. Keep future reviews local too.

| Page | What to review |
|---|---|
| [tim-life.html](tim-life.html) | Desktop + USB companion: all egg stages, baby/growing/mature Tim, four seeded individuals and 21 emotions. Play a hatch or a workday; check pause, reduced motion, and Experimental off. |
| [eggs.html](eggs.html) | All nine shell stages, including rocking; eight egg kinds; correct status sprites; progress and eligible rarities; a seekable opening with pause, resume, replay, and reset. |
| [traits.html](traits.html) | Ten species, six examples each, with current art, trait odds, flags, sample seeds, and status sprites. Filter by species, trait, or text. |
| [lookbook.html](lookbook.html) | The reviewed terminal world: zoo, moods, growth, twelve tims, and the same egg player. Current individual rules replace the old duplicate-to-XP simulator. Later voice/memory examples are labeled as illustrative. |
| [overnight/index.html](overnight/index.html) | The historical 26–27 September build report. Original screenshots and counts stay dated; the report links to the later handoff. Images open at full size. |

Motion follows the system preference, can be paused, stops while the page is hidden, and
avoids repainting offscreen art. The art fits its available width using measured font cells.
Each page has local navigation, a skip link, keyboard focus, and no external asset requests.

The Tim integration page is built separately from the existing review set:

```sh
node daemons/companion/generate.mjs
node daemons/companion/review.mjs
node daemons/companion/check-review.mjs
```

It uses the CLI's production clip provider and embeds the Jgs font with its OFL
notice. Its offline DOM check uses the same `tools/node_modules/linkedom` install
as the checks below. Actual firmware pixel rendering and desktop-to-USB replay
are documented in [the integration notes](../../docs/research/2026-09-28-desktop-device-companion.md).

## Editing and building

Edit the HTML templates, CSS, and JavaScript in `tools/`, then rebuild the standalone pages:

```sh
node daemons/review/tools/build.mjs
node daemons/review/tools/build.mjs --check
```

Commit both the sources and the generated HTML. The build uses `roster.json`, `plates.json`,
the actual reference colour functions and sprite renderer, and the models in `daemons/plates/`.
It keeps the originally selected sample seeds. Samples are examples, not server-issued serials.
“1 in N” covers colour, markings, extra, and eyes within a species; shape, temperament, species
rarity, and shiny are separate.

Sample art is re-rendered when the roster or model inputs change. Otherwise the build reuses
the embedded frames; `--rebake` forces a fresh render. Run the canonical generator first when
changing the roster or models. This review build does not edit the canonical
`daemons/lookbook.html` or generated client contracts.

## Checks

Node builds require no packages. The DOM regression checks use one pinned development dependency:

```sh
npm ci --prefix daemons/review/tools --ignore-scripts
npm test --prefix daemons/review/tools
```

Checks cover local links and labels, unique IDs, embedded script execution, all egg kinds and
eligible rarities, earning gates, timed playback, pause/resume/reset/seek, reduced motion,
head-first emergence, trait filtering, and the current reference data and material colours.
The DOM harness uses simulated time and font metrics. It does **not** establish browser layout
or pixel-level appearance. Browser visual inspection was blocked by the local-file URL policy
during this polish pass; that remains an explicit verification limitation.

## Original prototypes

`src/` preserves the scripts used during the original review. They are historical references,
not inputs to the current build:

- `src/eggs/`: early shell models, material shader, preview CLI, and nine-stage sheet.
- `src/traits/`: early species models, sample selection, catalogue data, and one-liner checks.
- `src/lookbook/`: early templates and injectors for the additional lookbook sections.

Their `REPO`, `SCRATCH`, and `FLUTTER_BIN` paths are placeholders. New work should use the
current models and `tools/build.mjs`, so reviews stay in step with the implementation.
