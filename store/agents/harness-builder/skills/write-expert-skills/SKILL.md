---
name: write-expert-skills
description: Write the harness's own AGENTS.md and skills — the expert workflow for the tool, every command run and proven, portable across Claude Code and Codex. Use at the skills stage and whenever a proof shows the harness's agent doing the wrong thing.
---

# Write expert skills

The harness's agent knows only what its `AGENTS.md` and skills tell it. A fresh agent with those files
and nothing else must work like an expert with the tool, and keep the viewer moving while it does.

```bash
"$BUILDER" stage skills active --note "Writing the <tool> workflow"
```

## `package/AGENTS.md` (the harness's own)

Model it on `$BUILDER_REFERENCE/store/agents/marp/AGENTS.md`, the Store's clearest one. In order:

1. **One paragraph of role**: what every message from the user is, what they get back, and that the
   viewer is already open next to the terminal and redraws as files change. "You never start a viewer,
   never print a URL, never open a browser."
2. **Where things are**: the workspace layout, the skill to read before the first save, the toolchain
   commands (through the env var, never a bare interpreter), and the verdict (written by the check,
   never by hand).
3. **How to work so the pane moves**, as numbered steps: the first visible save within a minute
   (infer and choose, do not ask first), then each stage of the work saved as it lands, the check after
   each pass, questions only for what cannot be inferred and only after the first save.
4. **What good looks like** in this domain: the concrete rules an expert holds to (a keynote headline is
   eight words or fewer; a chart has a title that states the finding). These come from the brief's
   research, not from taste.
5. **Author the brief; never impose the example.** Say plainly what the harness is and is not — "a
   score editor, not a style picker" — and that the template's example is one authored answer, whose
   palette, layout, key and wording carry no authority over the next brief. Tell the agent to start
   from the person's actual subject and material (their text, logo, measurements, recording, data),
   to use it rather than redraw it, and to ask only for material that is necessary and missing.
   `$BUILDER_REFERENCE/store/agents/creative-direction/AGENTS.md` opens this way; read it.
6. **Continue, do not restart.** Read the current source before each revision, change what was asked,
   keep what the person approved, and keep the previous complete version so nothing they accepted is
   lost. Say where their edits from the pane land and how to tell a saved change from a draft.

## Skills (`package/skills/<name>/SKILL.md`)

- One skill per real body of craft, usually one or two: the tool's dialect and patterns, and the
  workflow. Frontmatter `name` (kebab-case, the folder name) and `description` (what it is and when to
  use it: the engine decides to load it from this line).
- **Commands that were run.** Every command in a skill is one you executed in `.builder/scratch/` or a
  proof workspace against the pinned toolchain, and it worked. Paste real output where it helps.
- **The recipe, not the reference.** The order of operations, the three to ten patterns that cover most
  requests, the idioms that avoid the tool's sharp edges, the failure messages and their fixes.
- **Helper scripts** (`skills/<name>/scripts/` or `toolchain/`) where the raw API is long or
  error-prone: one command that does a whole stage correctly beats a page of instructions. Test them.
- **Examples** the agent can copy: a small complete input for each pattern.

## Portable across engines

- Only `AGENTS.md` and `SKILL.md`; Harness links skills into `.claude/skills/` for Claude Code and
  `.agents/skills/` for Codex. Refer to a skill by name, not by path.
- No engine-only syntax (slash commands, subagent tool names, hooks) without a sentence saying what to
  do on an engine that lacks it.
- Tools run through the harness's scripts and env vars, so any engine that can run a shell can use them.

## Done

`AGENTS.md` and the skills are written, every command in them ran, and a quick read-through as a
fresh agent finds nothing that assumes knowledge they do not give. The proof stage is the real test.

```bash
"$BUILDER" stage skills done --note "<N> skills: <names>; <M> helper scripts"
```
