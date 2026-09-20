# Store presentation assets

`workshop-overview.svg` presents Coding first, with all fourteen supported agents. The remaining
cards follow the shared taxonomy in `store/browse-categories.json` and show a selection of the
listed harnesses. Counts exclude packages whose `store.json` sets `listed: false`.

Run `node store/tools/presentation.mjs` from the repository root to regenerate the overview,
README catalog, and desktop category mapping. `--check` detects stale output.

Marks come unchanged from `.github/assets/engines/`, `desktop/assets/engine-icons/`, and
`store/branding/`; their source notices remain in those directories. Cursor, OpenCode, and KiCad
sit on dark tiles so their pale artwork remains visible. Roundtable, Jev Browser, and Godogen
use the original SVG package icons documented in `store/branding/README.md`. Featured entries
must have actual artwork; the generator fails rather than showing a letter placeholder.

`showcase.gif` shows six real outputs, one screenshot per slide, at 1600 × 1260. The original
1600 × 1000 screenshot is kept whole, with a caption panel below it. Each caption includes the
harness name and complete original prompt from its package's `store.json`. Slides stay for
6–10 seconds according to prompt length; the current loop is 45 seconds. `showcase-poster.png`
is the first slide as a still image. Individual source screenshots and prompts are also linked
in the README for readers who prefer a static view.

Regenerate with `node store/tools/showcase.mjs`. It requires Node, FFmpeg, and the release-pinned
Flutter SDK with the desktop dependencies resolved. `FLUTTER_BIN` and `FFMPEG_BIN` override the
executables. The frame renderer is `desktop/tool/render_readme_showcase.dart`; the selection is
`store/readme-showcase.json`. Source screenshots are never modified.

After regeneration, inspect the overview at README size, especially logo contrast and labels.
Inspect every slideshow frame for readable, unclipped prompts, and verify frame durations and
the infinite-loop flag before committing the resulting assets.
