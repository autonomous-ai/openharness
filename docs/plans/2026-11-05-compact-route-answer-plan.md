# Compact route answer Implementation Plan

> Way of working: this project's Engineer role (project instructions, Engineer): the plan is the pull request's first
> commit, then each task's failing test is committed before the code that passes it. No Execution Handoff.

**Goal:** A route answer the coordinator reads is a few thousand characters, not ~45,000 (task #3294, Ken 2026-11-05):
the Routing section and the revision instead of the whole instructions, one compact line per candidate, a short
left-out list. A 40-candidate answer is under 8,000 characters.

**Architecture:** `routeTask` (cli/src/superTabs/routeCommand.ts) keeps building the structured answer it builds today,
and the decision it records for Details is unchanged. A new pure function, `routeAnswer(answer, options)`, renders that
structured answer into what `harness super-tab route` prints: the instructions' Routing section and revision (the whole
text with `--full-instructions`, none with `--instructions-read N` while N is still current), one line per candidate,
a machines map (id, start folder, room) said once per machine instead of on every row, one line per left-out machine.
`command.ts` parses the two flags and prints `routeAnswer(...)` instead of the structured object.

**Tech Stack:** TypeScript, vitest (cli).

**Spec:** task #3294 brief. Every engine on every machine stays listed (Ken, 2026-11-03).

## Global Constraints

- CLI only: the answer is built in the CLI; the backend record (`route.record`) is unchanged.
- Swarm code stays out of cli/src/core.
- Every candidate the record holds is still in the answer, with what a start or an assignment needs: its id, agentId,
  machine id, engine, model, effort, grid model and name, start folder.
- The skill text that names the route answer's fields (cli/src/lib/swarmTools.ts) says the new shape and flags.

## Review Focus

- Nothing the coordinator needs to start or assign is lost from a row (machine id and cwd through the machines map).
- The Routing section is found in real instructions (`## Routing` up to the next `## ` heading); instructions without one
  fall back to the whole text, never to nothing.
- `--instructions-read N` leaves the text out only when N is the current revision.

## Tasks

### Task 1: the size test and the compact renderer

**Files:** cli/src/superTabs/routeCommand.ts, cli/src/superTabs/routeCommand.spec.ts, cli/src/superTabs/route.ts

**Interfaces:** `routeAnswer(answer: Json, options?: { fullInstructions?: boolean; instructionsRead?: number }): Json`;
`routingSection(text: string): string | null`; `quotaLine(...)` in route.ts.

- [ ] Failing test: a 40-candidate route answer (10 machines, both engines, new and idle rows, PM-account notes,
      long plug-in notes, 20 left-out machines) rendered by `routeAnswer` with the instructions read is under 8,000
      characters, and every row still says its id, machine, engine, model, effort and agentId.
- [ ] Failing test: instructions come back as the Routing section and revision only; the whole text with
      `fullInstructions`; only the revision when `instructionsRead` is the current revision; the Routing section again
      when it is not.
- [ ] Implement `routingSection`, the compact quota line, the candidate line, the machines map and the left-out lines.

### Task 2: the flags and the printed answer

**Files:** cli/src/superTabs/command.ts, cli/src/superTabs/command.spec.ts

- [ ] Failing test: `route GROUP JSON --full-instructions` and `--instructions-read 74` parse; anything else is refused;
      the printed route answer is the compact one.
- [ ] Implement the parse and print `routeAnswer`.

### Task 3: the skill text

**Files:** cli/src/lib/swarmTools.ts, cli/src/lib/swarmSkills.ts (if it names a changed field)

- [ ] Say the answer's shape and the two flags in the `route` lines; the coordinator passes the revision it read.
