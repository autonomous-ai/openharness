---
name: design-the-evaluation
description: Decide and build how the harness's output is judged — the tool's own verifier, checks of the brief's measurable claims, a fresh-context model review, or honestly none — and write it into the verdict as a feed. Use at the evaluation stage and whenever a proof passes something that is visibly wrong.
---

# Design the evaluation

Coding has an easy evaluation: it compiles and the tests pass. Other domains need one chosen with
care, and some have none. The one rule: **never claim more than you check.**

```bash
"$BUILDER" stage evaluation active --note "Choosing how <tool> output is judged"
```

## The four methods

Declare one or more, strongest first.

| Method | When | What it must do |
|---|---|---|
| `tool` | The domain has a verifier: a compiler, validator, checker, simulator | Run it on every change; map its errors and warnings to findings with the file and line or the element they point at |
| `checks` | The request contains measurable claims | Extract the claims (the brief's list: sizes, counts, keys, extents, durations) and measure the output against each; a failed claim is an error finding naming the claim and the measured value |
| `review` | Quality only a person or a model can judge: legibility, composition, musicality | A fresh-context reviewer grades snapshots of the output against a written rubric; advisory unless declared a gate |
| `none` | Nothing trustworthy verifies this domain | Say so in the verdict's summary: the output was produced and the person is the judge |

Most good harnesses combine `tool` with `checks`, and add `review` where taste matters.

Two things belong in `tool` that are easy to miss, and they are what make an evaluation domain
knowledge rather than "it compiled":

- **The craft's own rules.** A violin cannot play below G3. A trace narrower than the fab's minimum
  will not be made. Type under 6 pt will not read in print. An export at 72 dpi will not print at A2.
  The brief's research lists these; check them and name them the way the craft does.
- **The deliverable leaves.** Re-open every exported file with an independent reader and confirm
  what a recipient would need: the PDF's page count and page size, the SVG's viewBox and that it
  parses, the audio's duration and sample rate, the mesh's solid count, the CSV's rows and header.
  A file the harness wrote but cannot re-open is not finished work.

## The verdict is a feed

`.harness/verdict.json` (the contract: `$BUILDER_REFERENCE/store/spec/README.md`) is rewritten on every
change by the viewer and on demand by the harness's check command. It carries, in addition to the
spec's fields, what was evaluated:

```json
{
  "spec": 1,
  "ready": false,
  "summary": "Bars 1–16 · 2 warnings",
  "findings": [{ "severity": "warning", "kind": "range", "message": "Violin note C3 is below its range", "ref": "score.ly:42" }],
  "artifact": "score.pdf",
  "phases": [{ "id": "melody", "name": "Melody", "state": "done" }, { "id": "harmony", "name": "Harmony", "state": "active" }],
  "evaluation": [
    { "method": "tool", "by": "LilyPond 2.24.4", "passed": true, "gate": true },
    { "method": "checks", "by": "brief: key, time, 16 bars", "passed": false, "gate": true, "detail": "12 of 16 bars" },
    { "method": "review", "by": "engraving rubric", "passed": true, "gate": false }
  ],
  "updatedAt": "2026-09-17T20:00:00Z"
}
```

- `ready` is true only when every entry with `gate: true` passed and no finding is an error.
- `phases` are the brief's stages; the state of each comes from what exists and what passed.
- `findings` say what to fix, precisely enough that the agent can fix it without asking.
- An entry with `method: "none"` has `passed: null` and `gate: false`, and stands alone.
- `passed: null` on any other method means it has not run yet: the pane says "not run yet", never
  "passed".

Harness shows these to the person: the pane's status tooltip lists each entry as a line
("✓ Verified by LilyPond 2.24.4", "✗ Checked against brief: key, 16 bars — 12 of 16 bars"), so write
`by` as the words that finish "Verified by …", "Checked against …", "Reviewed against …", and keep
`detail` to one line a person can act on.

## Say it on the store page too

`package/store.json` declares the same methods before anyone runs the harness, and the product page
shows them under the name:

```json
"evaluation": [
  { "method": "tool", "by": "the LilyPond compiler" },
  { "method": "checks", "by": "the request: key, meter, bars" },
  { "method": "review", "by": "an engraving rubric" }
]
```

One to four entries, `method` and `by` only (`passed` and `gate` belong to a run, in the verdict).
`"$BUILDER" check` holds the page to the proofs: a method the page declares that no proof's verdict
reported is an error, and one the verdicts report that the page leaves out is a warning.

## The checker script

`toolchain/check` (executable) does the whole evaluation for the workspace it is run in, writes the
verdict, prints one line per finding, and exits 0 only when `ready`. The viewer calls the same code on
every change. Build it with the tool's own machinery (its compiler's diagnostics, its validator's
report), not by scraping a screenshot.

## Checks from the request

The harness's agent writes what the user asked for, as measurable claims, into `brief.json` in the
workspace the moment it understands the request (the harness's `AGENTS.md` says so):
`{"claims": [{"id": "bars", "expect": 16}, {"id": "key", "expect": "D minor"}]}`. The checker
measures each claim it knows how to measure and reports the rest as `info: not checked`.

## The model review, portable across engines

A review is performed by the harness's agent, not by a script that calls a model API.

1. The checker (or the agent) takes snapshots of the output (`toolchain/snapshot`, or the viewer's
   `?snapshot=1`), into `.harness/review/`.
2. The rubric lives in the harness at `skills/<name>/review-rubric.md`: five to eight criteria, each
   with what a pass looks like, specific to the domain.
3. The agent asks a **fresh-context reviewer** that sees only the rubric and the snapshots, never the
   conversation: on Claude Code a subagent; on an engine without subagents, its non-interactive mode in
   a clean session (`claude -p`, `codex exec`). The reviewer writes `.harness/review/result.json`:
   `{"passed": bool, "criteria": [{"id", "passed", "note"}]}`.
4. The checker folds the result into `evaluation` and `findings`.

Write this in the harness's skill as steps any engine can follow.

## Done

The methods chosen and written in `.builder/decisions.md` with why; `toolchain/check` runs them and
writes the verdict; the viewer re-runs it on every change; a deliberately broken input produces the
right finding and `ready: false`; a correct one produces `ready: true`.

```bash
"$BUILDER" stage evaluation done --note "<methods>: <what gates ready>"
```
