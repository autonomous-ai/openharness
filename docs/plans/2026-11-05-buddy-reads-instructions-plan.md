# A Buddy reads its person's project instructions: plan

**Goal:** A Buddy runs the instructions read (`instructions PROJECT`) for any project its person reads, read-only, the
same document its person reads. Task #3024, asked by Leo (11-05): his Buddy, asked which of lamp's rules its PM skipped,
said it could not read lamp's instructions.

**Architecture:** The read is `SuperTabStore.instructions` (backend `superTabs/store.ts`). A person's one Buddy for the
whole Swarm already reads every project its person reads there, through `canReadProject`. A Buddy of one project (a
project session, or a project chat's Buddy) reads only its own project, so another project's document was refused. The
read authorises a Buddy by its person instead (`buddyPerson`: the person, at the membership they added it in, reading
the project now), for this read alone. Nothing else changes: the Buddy still gets no notes, no built-in PM schedule and no
history; `instructions.save` and `note.add` stay outside its commands (`buddies.ts BUDDY_COMMANDS`); its other reads stay
with its project. The Buddy skill (cli `lib/swarmSkills.ts`) names the read, by the id `status` lists, and says it is
read-only: before, it named no such read and said the Swarm refuses every other command.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB (backend); vitest.

**Spec:** the task's brief (#3024).

## Global Constraints

- The Buddy guard: two independent security reviews before merge.
- A project the person cannot read is refused in the same words as one that does not exist.
- Swarm code stays out of `cli/src/core`.

## Review Focus

- `projects.ts buddyReadsInstructions`: the agent is the actor's own (machine owner), it is a Buddy, and its person reads
  the project at the Buddy's membership generation.
- Nothing widens beyond the document: notes, the built-in schedule, history and saves.

## Tasks

### 1. A Buddy reads another project's instructions its person reads

Files: `backend/integration/superTabInstructions.test.ts`, `backend/src/superTabs/projects.ts`,
`backend/src/superTabs/store.ts`.

- [ ] Failing tests: a session of one project reads another project its person reads, the text alone; the person's one
      Buddy reads each project they read; a project the person cannot read is refused as a missing one, and once they
      leave a project its Buddy reads none of it; saves, notes and history stay refused.
- [ ] Code: `buddyReadsInstructions` in `projects.ts`, used by `store.ts instructions` for a Buddy.

### 2. The Buddy skill names the read

Files: `cli/src/lib/swarmSkills.spec.ts`, `cli/src/lib/swarmSkills.ts`.

- [ ] Failing test: the skill's "Read the project's work" names `instructions PROJECT` by the id status lists, read-only.
- [ ] Code: the skill line.
