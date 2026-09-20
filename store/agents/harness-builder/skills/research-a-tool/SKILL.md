---
name: research-a-tool
description: Research the craft and the tool before building a harness — the work a person could not finish before, what they bring and take away, how the tool runs headless, what verifies it, which web viewers exist, licences — and write .builder/brief.md. Use at the research stage, and again whenever a later stage hits something the brief did not answer.
---

# Research a tool

Two failures start here. A harness written from memory of the tool is slop. A harness built for the
tool's features rather than for a person's work is a demo — which is how seven harnesses were
withdrawn from the Store (`$BUILDER_REFERENCE/work/SUPERPOWERS.md`). Find out what people actually
need finished in this craft, and how the tool really works *today*, at the version you will pin.

```bash
"$BUILDER" stage research active --note "Reading <Tool>'s docs and what people make with it"
```

## Sources, in this order

1. **What people in the craft are trying to finish**: the tool's gallery and showcase, its forum's
   "how do I…" questions, the freelance briefs people pay for in this domain. This is where the work
   is defined, and the brief's first section comes from here.
2. The tool's own documentation for the current release (the CLI reference, the scripting API).
3. Its source repository: the README, `--help` of the real binary, examples, the test suite (tests
   show the API as used, not as documented), the changelog for breaking changes.
4. Its package listings: PyPI / npm / conda-forge / GitHub releases for versions, platforms and
   checksums (`https://api.anaconda.org/package/conda-forge/<name>`, `https://pypi.org/pypi/<name>/json`).
5. Existing open-source web viewers or renderers for its formats.

Install nothing globally while researching. Try the binary in `.builder/scratch/`, at the pin you
will ship.

## The brief: `.builder/brief.md`

Answer every question, with a source link or the command you ran for each fact. Write "unknown" and
what you tried rather than guessing. Keep it facts and decisions, not prose: you read it at every
later stage, and Builder Studio shows it to the person.

**1. The work.** One sentence: *a person can now ___, which they could not before.* Then three real
jobs in this craft — the kind someone is paid for or blocked on — that this harness must be able to
finish. Not features of the tool; work with an outcome. If you cannot write that sentence without
using the tool's name, you have not found the work yet.

**2. What the person brings.** Their own material, concretely: text, logo, photographs, measurements,
a recording, a dataset, a parts list, an existing file to continue. How does it get into the
workspace, and in what formats? A harness whose only input is a prompt about a fictional subject is
the withdrawn kind.

**3. What they take away.** The files a person keeps, with formats and what opens them elsewhere
(SVG in Illustrator, STEP in Fusion, MIDI in a DAW, CSV in a spreadsheet, a folder of source in an
editor). Anything that only opens inside this harness is not a deliverable.

**4. Identity.** The upstream name exactly as its project writes it, the author or organization for
the tile, homepage, repository, licence (SPDX), the harness id (`<owner>/<folder>`, folder = the
upstream name in lower case), a category in a word or two, and a tagline of at most 80 characters in
the project's own words.

**5. How it is driven without a GUI.** CLI commands, a scripting API, a file format an agent can
write directly. Which is most reliable for an agent, and why.

**6. The stages of the work** as an expert does it, from nothing to done: each stage names what
exists at its end that a viewer could show. Four to eight. This becomes the viewer's progression and
the verdict's phases.

**7. What the person does in the pane.** The controls this craft needs while the work is live
(transport and per-part mute for music, brush and section for a score, pan and layer for a map), and
what they should be able to change directly — with the change saved back into the workspace so the
agent's next turn continues from it. Name the two or three edits that matter most.

**8. Toolchain.** The exact version to pin; how to get it on macOS arm64, macOS x86_64 and Linux
x86_64 without Homebrew or root (a PyPI wheel, conda-forge through micromamba, an official release
tarball with a checksum, an npm package); its size; what it needs at runtime (a browser? fonts? a
GPU?).

**9. Verification.** Everything that can say whether the output is right: compilers, validators,
linters, checkers, simulators, schema validation, round trips. What each catches and misses. What in
a typical request is measurable (sizes, counts, keys, extents, durations). What only judgment can
see. Include the craft's own rules of correctness — an instrument's range, a fabrication rule, a
legible type size — because those are what make the evaluation domain knowledge rather than "it
compiled".

**10. Viewer options.** Existing web renderers for the artifact (licence and size), which of the ten
shared viewers (`$BUILDER_REFERENCE/store/viewers/`) already handles it or could be upgraded, and
what a person would want to touch. Reuse or upgrade before building new.

**11. Risks.** Slow first runs, network at runtime, platform gaps, licence constraints, known
crashes in headless mode, anything that would make a brief impossible.

**12. Decision.** One paragraph: engine, how the agent drives the tool, the viewer (reuse, upgrade or
new), the evaluation method, and the three proof briefs — materially different jobs from section 1,
each written the way a person would ask, and each naming the material they bring.

## Done

Every question answered, the decision written, and the id, name, category, tagline and engine written
into `package/harness.json` and `package/store.json`.

```bash
"$BUILDER" stage research done --note "<the work it unlocks, how it is driven, viewer, evaluation>"
```
