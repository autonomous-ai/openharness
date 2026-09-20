---
name: prove-it
description: Prove the harness on three real prompts (easy, medium, hard for its domain) by running a fresh engine agent that knows only the harness's own AGENTS.md and skills, watching the viewer frame by frame, and fixing the harness until all three pass and look good. Use at the proof stage, and after any change to skills, viewer or evaluation.
---

# Prove it

You wrote the harness, so you cannot test it by imagining a user. A **fresh agent** that knows only
the harness's `AGENTS.md` and skills can. Every failure in a proof is a bug in the harness: fix the
harness, not the proof, and never hand-edit a proof's output to make it pass.

```bash
"$BUILDER" stage proof active --note "Proving on three prompts"
```

## The three briefs

From the brief's section 1 — the work this harness unlocks — three **materially different real
jobs**, not three sizes of the same one. Different subject, different material, different deliverable.
If the harness can only do the first, you have built a demo.

- **easy**: one clear job, the core of the craft, finished end to end.
- **medium**: a job the way someone actually asks, with **their own material** in it — text they
  supply, a logo, a measurement, a recording, a CSV. Attach it into the proof workspace as a real
  file, the way a person would.
- **hard**: a job that pushes the craft's depth and ends in a deliverable someone would send to a
  client, a printer, a fabricator or a bandmate.

Write them as a person would: one or two sentences, concrete, naming what they want and what they
brought. Never an instruction about the harness itself.

**Then a fourth run: the revision.** Take the hard proof's workspace, ask for a change the way a
person would ("keep the type and the layout, make the second panel about the new supplier"), and
confirm it changed what was asked and preserved everything else. A harness that cannot revise makes
one-shot output, and nobody finishes real work in one shot.

## Run a proof

```bash
"$BUILDER" proof run easy --prompt "Make a bar chart of monthly rainfall in Seattle with the wettest month highlighted."
```

It materializes a workspace from the package exactly as Harness does (template, init, `AGENTS.md`, skills
linked for the engine), starts the harness's viewer on a free port (shown live in Builder Studio),
then runs a fresh agent in that workspace with the prompt: `claude -p` in auto permission mode, or
`codex exec` with automatic review. Use `--engine` for the engine you are running on (Claude Code:
`claude`; Codex: `codex`); skills are linked where that engine reads them. While it
runs, it snapshots the viewer every few seconds into `.builder/proofs/easy/frames/` and records the
verdict after each change. At the end it writes `.builder/proofs/easy/result.json` (the prompt, the
final verdict, the agent's last message, timings, the frame list) and `viewer.png`.

`"$BUILDER" proof run` takes minutes. Run the three proofs one at a time, reviewing each before
starting the next, so a fix learned from `easy` improves `medium`.

**Do not touch `package/` while a proof runs.** The agent is using that harness as you edit it: a
half-written module takes its run down, and the result belongs to a harness that never existed. The
runner fingerprints the package at the start, and a run whose package changed is marked `void` —
it cannot be passed, only run again. Keep the fixes in your head (or in `.builder/decisions.md`)
until the run ends.

## Review a proof, as the person watching

Read `result.json`, the agent's log (`agent.log`), and **look at the frames in order** (read the PNGs):

1. **Did the pane move early?** The first frame with real content should come within a minute or two.
   A pane that stays empty until the end fails, whatever the result.
2. **Did every stage appear?** Match the frames to the brief's stages.
3. **Is the final result good?** Would the tool's own community be happy with it? Judge it against the
   brief's gallery examples, not against "it rendered".
4. **Is the viewer delightful at the end?** Try the interactions in the live viewer yourself with
   `"$BUILDER" snapshot` at a few states, or read the viewer's page to confirm the controls exist.
   Judge the final frame at its real pixel size: a result that fills half the pane, or whose labels
   you have to squint at, fails this point however correct it is.
5. **Did the evaluation tell the truth?** `ready: true` on a visibly wrong result is an evaluation bug;
   `ready: false` on a good result is too.
6. **Did the agent struggle?** Retries, wrong commands, reading the toolchain source, asking what to do:
   each is a gap in `AGENTS.md` or a skill.
7. **Was it authored, or selected?** Read the agent's log: did it compose this brief's answer, or
   reach for the template's example and change its words? Two proofs that look like the shipped
   example with different text mean the harness only knows one answer — the withdrawn kind
   (`$BUILDER_REFERENCE/work/SUPERPOWERS.md`). Compare the three results side by side; they should not
   look like the same thing three times.
8. **Did it use what the person brought?** In the medium proof, their file must be *in* the result —
   their words, their logo, their numbers — not politely acknowledged and ignored.
9. **Does the deliverable leave?** Open the exported files yourself, outside the harness: the PDF's
   pages and dimensions, the SVG in a renderer, the audio's duration, the CSV's rows, the mesh in
   another reader. Record what you opened and what you found. A file that only opens here is not a
   deliverable.

Write the review into `.builder/proofs/<id>/review.md`: pass or fail on each point, and the fixes.

## Fix, then prove again

Mark the stage you are fixing active (`skills`, `viewer`, `evaluation`), fix the harness, mark it done,
and rerun the same proof. Repeat until all three pass every point. Record each fix in
`.builder/decisions.md`: these are the lessons that make the next harness better.

```bash
"$BUILDER" proof pass easy --note "<one line: what it made>"     # or: proof fail easy --note "<why>"
```

## The revision run

After `hard` passes, prove that the work can continue. Run a fourth proof in a workspace that already
holds the hard proof's result:

```bash
"$BUILDER" proof run revision --prompt "<the change, as a person would ask it>" --from hard
```

`--from` copies the finished workspace instead of starting from the template, so the agent meets the
work already in progress, exactly as the person's second turn does. Review it on two points beyond
the list above: **what was asked changed**, and **what was approved survived** — their text, their
colours, their geometry, their takes, byte for byte where it should be. Compare the frames before and
after. Losing the person's earlier work is the worst failure a harness has, worse than a poor result.

## Done

Three materially different briefs passed with written reviews, the revision preserved the approved
work, the deliverables opened outside Harness, and the final frames are good enough for the Store.

```bash
"$BUILDER" stage proof done --note "easy, medium, hard and the revision passed; <N> fixes along the way"
```
