# Files

A folder of the person's own, in a pane: a list of its files, Markdown read rendered or edited, text files
edited, pictures and PDFs shown. The agent beside it finds, summarises, writes and tidies those files with
them. It works the same on this computer and through the pane on another of their computers (an Intern 3
at home seen from a Mac), since the pane is the daemon's viewer.

- **Read and edit**: Markdown (`.md`) rendered, with an editor a click away; text, JSON, CSV, YAML, logs
  and source files in a plain editor. Save with the button or Cmd/Ctrl+S. A save made over a change the
  pane has not seen (the agent wrote the file meanwhile) is refused, and the person chooses whose to keep.
- **Look**: PNG, JPEG, GIF, WebP, SVG, BMP, AVIF pictures; PDFs in the browser's own reader.
- **Safe by construction**: the viewer serves the chosen folder and nothing outside it, hides dot-files and
  `node_modules`, writes only text files (at most 2 MB, atomically), and answers only its own page: every
  other request carries a token that page alone holds. A file opened on its own never runs as a page.
- **The folder stays the person's**: nothing is copied into it; only `.harness/verdict.json` is seeded.

No toolchain: the viewer is one Node file with no dependencies (`viewer.mjs`), and the page is one HTML
file (`app/index.html`).

## Credit and stewardship

Original work of the OpenHarness contributors, MIT licensed (`LICENSE`). It vendors nothing and fetches
nothing. Maintained in this repository by Autonomous; report problems in its issues.
