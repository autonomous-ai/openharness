# Core secrets package: notes to finish from

Package 6 of [the plan](../2026-11-15-core-plan.md): the secrets the core holds, and what it takes unchecked (audit
[security](../2026-11-12-core-audit.md#security) 9, 7 and 6, and section 1's `lib/apiConnectionMetadata.ts` row). One
pull request a step, each on a branch of its own (`core-secrets-1` is step 1's, `core-secrets-2` step 2's), worktrees at
`.claude/worktrees/<branch>` from a fresh `origin/main`, with `npm ci` in the worktree's `cli/`.

Secrets and tokens never appear in logs, errors, tests or pull request text: tests use fake keys.

## Step 1, security 9: the saved APIs' note only in a project folder Harness made (branch `core-secrets-1`)

Found: `lib/apiInstructions.ts` `prepareApiInstructions` appended its "Saved APIs" block to the instruction file
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) of any folder a start, a relaunch or a fork ran in, once any API was saved:
the person's own repository too. Its comment promised only workspaces Harness made; the code checked only that an API
was saved. `lib/apiInstructions.spec.ts` showed it: 6 of its 10 cases failed on main, and `e2e/storeProcess.e2e.ts` too.

Fixed:
- The note goes only into a project folder Harness made: directly inside the projects root (`lib/projectFolder.ts`
  `projectsRoot`: `~/harnesses`, `~/projects` on Harness OS), as the trust checks read it (`core/agents/create.ts`), and
  no Git checkout. A clone or a worktree is a repository's, and an agent may commit the note in its tracked
  `AGENTS.md`; worktrees are also not directly inside (`<root>/worktrees/<repo>/<name>`). Nor `<root>/worktrees` itself:
  Claude Code reads a `CLAUDE.md` in every folder above it, so a note there would reach every worktree.
- Both paths are resolved first with `realpathSync.native` (the case as on disk; the JS one keeps a typed case on a
  Mac), so a link in the root to a folder of the person's is that folder. A root that is not there holds no project
  folder; any other failure throws, and the caller logs its `[apis]` line, as before.
- For a folder the person chose, the saved-API store is not read at all (step 2 wants a launch to read no keys).
- The check is in `prepareApiInstructions`, a default parameter, so every caller has it: `core/main.ts` (create,
  relaunch, fork). `testing/launchShapes.ts` takes the root from each spec (`LaunchWorld.projectsRoot`, required).
  No new file in the core's process.
- The three goldens that record the note (`launch-prep`, `launch-shapes`, `grid-assignment-shapes`) are unchanged:
  their specs name a projects root that holds their workspaces.
- `e2e/storeProcess.e2e.ts`: the two harnesses held through a Store outage are in `~/harnesses` and get the note only
  after recovery, as before; a plain harness started in a folder of the person's gets none.
- `docs/api-connections.md` says where the note goes.

Left, and why:
- A note written into a person's folder, a clone or a worktree before this fix stays there: removing it would be
  writing into their folder again. The block starts with `<!-- harness:apis -->`.
- A harness in a folder the person chose, a clone or a worktree is no longer told of saved APIs at start. `harness api
  list` works there as before. Telling it some other way (the launch's own instructions, as `lib/agentAttribution.ts`
  does for Claude Code and Codex) is a product call: a proposal for the PM, not this package.
- A Store harness's bootstrap (`dsh/runtime.ts` `installBootstrap`, `migrateHarnessInstructions`) still writes into
  the folder the harness runs in, the person's too: that is how its instructions reach its engine. Not this audit row.
- On Harness OS, Desktop makes local projects in `~/harnesses` (`desktop/lib/core/project_folder.dart`) while the CLI's
  root is `~/projects`; the trust checks already disagree the same way. Not changed here.

Found beside, not this package: `lib/pathContainment.ts` `within` tests `'../'` only. On Windows `relative` answers
`..\`, so any folder on the home's drive counts as inside it (`C:\Windows\System32` inside `C:\Users\a`), for the folder
browser (`lib/fsBrowse.ts`) and `lib/gitProject.ts`. A security fix of its own, with a Windows test.

## Step 2: the saved APIs' keys apart from what a launch reads (branch `core-secrets-2`, on top of step 1)

Found: every launch's note (`lib/apiInstructions.ts`) asked `ApiConnectionMetadata.list()`, which parsed the whole
store, `api-connections/connections.json`, keys included, to learn whether an API was saved.

Done:
- `api-connections/list.json`: the saved APIs without their keys (`{ version: 1, connections: [metadata] }`, 0600). A
  launch reads only that, through `ApiConnectionMetadata.saved()`, and checks it strictly: a list with anything more
  than the metadata (a key above all) is refused. The core never opens the store.
- The store keeps the list in step (`lib/apiConnections.ts`): written after every save and removal, and rewritten
  whenever a read finds it missing or different. A list that cannot be written is logged (`[apis]`), never thrown:
  the store is already saved, and the next read writes it.
- The store's own checked reader (`readApiConnectionStore`, with the keys' schema) moved into `lib/apiConnections.ts`,
  out of the core's process. The engine probe (`lib/engineAccount.ts`, edge host and gateway) keeps that checked read
  of the store: switching it to the list would change its answer for a store not read since the update.
- Why the keys did not move instead: every build since September reads `connections.json` with its keys, and the
  master puts the last build back when a new one fails. A file that lost its keys would leave that build with no
  saved API, and every agent on one unable to restart.

Migration: an older build's store has no list. `saved()` then takes the store's being there, unread, for a saved API
(it holds one, or did), until the store is first read in this build: models reads it as it starts
(`rememberSavedApis`), and so do the Models panel, `harness api` and every launch on an API's model. That fallback
goes on 2026-12-15. `e2e/storeProcess.e2e.ts` writes such a store by hand and still gets the note.

Rollback: an older build reads and writes `connections.json` as before and never reads the list. Back on this build,
the store's next read rewrites the list from the store. Until then a launch may read a list an older build left
stale; the note is only guidance, and `harness api list` reads the store itself.

## Step 3, security 7: keys the core holds without need

Not started: a grid's API key on the registry row and in each stopped agent's file (`lib/registry.ts`,
`lib/stoppedAgents.ts`); the whole environment of up to 256 agent processes cached (`lib/processEnv.ts`); an
OpenRouter key cached and never read (`lib/gatewayRuntime.ts`); a connected service's secret through the core in the
clear (`lib/connectors/vaultOps.ts`).

## Step 4, security 6: what models, the Store and shared machines may set

Not started: launch arguments, environment and files from models, the Store and shared machines are checked for shape
only (`core/modelsLink.ts`, `storeLink.ts`, `sharedMachinesLink.ts`). Each link enforces a declared allowlist.
