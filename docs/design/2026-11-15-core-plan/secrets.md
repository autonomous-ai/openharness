# Core secrets package: notes to finish from

Package 6 of [the plan](../2026-11-15-core-plan.md): the secrets the core holds, and what it takes unchecked (audit
[security](../2026-11-12-core-audit.md#security) 9, 7 and 6, and section 1's `lib/apiConnectionMetadata.ts` row). One
pull request a step, each on a branch of its own (`core-secrets-1` is step 1's), worktrees at
`.claude/worktrees/<branch>` from a fresh `origin/main`, with `npm ci` in the worktree's `cli/`.

Secrets and tokens never appear in logs, errors, tests or pull request text: tests use fake keys.

## Step 1, security 9: the saved APIs' note only in a workspace Harness made (branch `core-secrets-1`)

Found: `lib/apiInstructions.ts` `prepareApiInstructions` appended its "Saved APIs" block to the instruction file
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) of any folder a start, a relaunch or a fork ran in, once any API was saved:
the person's own repository too. Its comment promised only workspaces Harness made; the code checked only that an API
was saved. `lib/apiInstructions.spec.ts` showed it: 5 of its 6 cases failed on main.

Fixed:
- The note goes only into a folder below the projects root (`lib/projectFolder.ts` `projectsRoot`: `~/harnesses`,
  `~/projects` on Harness OS), where New Project, clones and worktrees (`<root>/worktrees/<repo>/<name>`) go. Both are
  resolved on disk first, so a link in the root to a folder of the person's is that folder. The root itself is no
  workspace. Compared with the platform's `relative` and `sep`, so Windows' `..\` and other drives count as outside.
- For a folder the person chose, the saved-API store is not read at all (step 2 wants a launch to read no keys).
- The check is in `prepareApiInstructions`, a default parameter, so every caller has it: `core/main.ts` (create,
  relaunch, fork), `testing/launchShapes.ts` and `testing/gridAssignmentShapes.ts`. No new file in the core's process.
- The three goldens that record the note (`launch-prep`, `launch-shapes`, `grid-assignment-shapes`) are unchanged:
  their specs name a projects root that holds their workspaces.
- `e2e/storeProcess.e2e.ts`: of the two harnesses held through a Store outage, the one in `~/harnesses` gets the note
  after recovery and the one in a folder of the person's does not.
- `docs/api-connections.md` says where the note goes.

Left, and why:
- A note written into a person's folder before this fix stays there: removing it would be writing into their folder
  again. The person can delete the block (it starts with `<!-- harness:apis -->`).
- A harness in a folder the person chose is no longer told of saved APIs at start. `harness api list` works there as
  before. Telling it some other way (the launch's own instructions, as `lib/agentAttribution.ts` does for Claude Code
  and Codex) is a product call: a proposal for the PM, not this package.
- Clones and worktrees in `~/harnesses` still get the note in a tracked `AGENTS.md` or `CLAUDE.md`, which an agent may
  commit. That is the behaviour the comment and the docs describe; changing it is also a product call.

Found beside, not this package: `lib/pathContainment.ts` `within` tests `'../'` only. On Windows `relative` answers
`..\`, so any folder on the home's drive counts as inside it (`C:\Windows\System32` inside `C:\Users\a`), for the folder
browser (`lib/fsBrowse.ts`) and `lib/gitProject.ts`. A security fix of its own, with a Windows test.

## Step 2: the saved APIs' keys in a file of their own

Not started. Section 1's row: the saved-API store is parsed at every launch, keys included, to learn whether one
exists (`lib/apiConnectionMetadata.ts`). The keys move to a file of their own, apart from what a launch reads, with the
migration and the rollback.

## Step 3, security 7: keys the core holds without need

Not started: a grid's API key on the registry row and in each stopped agent's file (`lib/registry.ts`,
`lib/stoppedAgents.ts`); the whole environment of up to 256 agent processes cached (`lib/processEnv.ts`); an
OpenRouter key cached and never read (`lib/gatewayRuntime.ts`); a connected service's secret through the core in the
clear (`lib/connectors/vaultOps.ts`).

## Step 4, security 6: what models, the Store and shared machines may set

Not started: launch arguments, environment and files from models, the Store and shared machines are checked for shape
only (`core/modelsLink.ts`, `storeLink.ts`, `sharedMachinesLink.ts`). Each link enforces a declared allowlist.
