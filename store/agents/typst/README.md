# Typst, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[Typst](https://typst.app): describe a document in the chat pane, watch the PDF take shape in the
Doc Viewer pane as Typst compiles it on every save. Runs on Claude Code.

The pane also holds an exact draft for review. Select words or pin an area, leave **Change / Keep /
Question** notes, and keep the PDF with its feedback as a portable packet. Compare a later compile
without losing the draft you reviewed; quoted notes can follow unchanged words onto another page.
Ask the agent to read `.harness/doc-reviews/<id>/review.md` and carry those decisions into the next
Typst revision. [How document review works](../../viewers/doc-viewer/README.md#carry-the-review-into-the-next-draft).

- `harness.json` — the manifest: engine, template, skill, toolchain, `viewer.use: autonomous/doc-viewer`.
- `skills/typst/` — the Typst skill (ours): the language, the commands, the rules.
- `toolchain/setup.sh` downloads the pinned Typst release binary into `bin/` (see `TYPST_VERSION`);
  `doctor.sh`; `init-workspace.sh` compiles the template; `verdict.py` turns Typst's diagnostics into
  the pane header.
- `template/` — a fresh workspace: `main.typ`, `assets/`, `out/`.

## Credit and stewardship

Typst is Typst GmbH's — Laurenz Mädje and Martin Haug — [typst/typst](https://github.com/typst/typst),
Apache-2.0 (`LICENSE-typst`). Nothing of it is changed here; the compiler is downloaded as they
release it. This folder is the Harness wrapper — the manifest, a skill, the template, the
toolchain and the verdict — written by Autonomous to bring Typst into Harness. We did that work on
the project's behalf, to bootstrap the catalogue.

If you maintain Typst and want to own its Harness package, it is yours: open an issue on
[OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Typst belong upstream, bugs in the
wrapper belong here, and a newer Typst is a bump of `TYPST_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without typst
```
