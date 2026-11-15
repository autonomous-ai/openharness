# Git out of the daemon core: where it stands (paused 2026-11-15)

Package: audit section 2, the "Git" row (docs/design/2026-11-12-core-audit.md) and security item 5 (`git clone` inside
`agent_create`). Read first: the plan's rules and lessons (../2026-11-15-core-plan.md), cli/AGENTS.md "Protect the core",
cli/src/core/AGENTS.md, cli/src/services/AGENTS.md.

## Where the work is

- Worktree: `.claude/worktrees/core-git-1`, branch `core-git-1`, PUSHED to origin
  (no PR). Rebased onto origin/main b5070936bb. Two WIP commits: f6085609bf (sources) and 5013a10437 (specs, part).
- `cli/node_modules` is a real `npm ci` in that worktree (the main checkout's lacks yaml, pngjs and slugify: the e2e
  bundle build fails on a symlink to it).
- Sources typecheck. Specs still to fix are listed under "Next steps", minus those marked done.

## Since the first pause (2026-11-15, second session)

- The lead: keep the 60-minute backstop and the edge host's own stall stop for clone progress in this PR; showing
  progress in the window comes after the loop agent's create-receipt PR (the lead will say when).
- Done: `lib/autonomous-device/storeRuntime.ts` uses `prepareNewFolder` (new folders only).
- Done: `testing/socketCore.ts` `bindLaunchRequests` takes `workspaces` (default null = off) and exports
  `preparingWorkspaces(prepare)` and `prepared(cwd, more)` for specs.
- Done: `backendSocket.spec.ts` (the five project-folder cases fake workspaces; the trust case answers a worktree under
  `projectsRoot()/worktrees/`; `prepareNewFolder` spied for `new`).
- Done but NOT yet run: `core/agents/launches.spec.ts` (module mock `prepareNewFolder`; `setup()` returns a fake
  `workspaces` with `ready`/`prepareFolder` vi.fns; folder cases rewritten; new tests: held while workspaces not ready
  then made once (`held.service === 'workspaces'`), held on a picked model while workspaces are off (`workspaces: () =>
  null`), failed `SERVICE_UNAVAILABLE` when nothing can hold it; trust only inside `<projectsRoot>/worktrees/`). It
  typechecks (tsc showed no launches.spec errors after the pause), but it has not been run yet: run
  `npx vitest run src/core/agents/launches.spec.ts` first.

## The lead's direction (mid-task)

1. Do the create's folder (clone, worktree, branch naming) and the purge's worktree removal first. That is PR 1
   (`core-git-1`), in progress.
2. Frames' git facts (agentProject, sessionGitContext, sessionGitHistory, the scm describe) wait for the browser
   agent's generic per-agent frame-parts shape to land on main; the lead says when. Do NOT build a frame cache of your
   own in the core. That is a later PR (`core-git-2`).

## What the WIP commit does (PR 1)

The core runs no git for creates and purges; the workspaces service (edge host) does it.

- `lib/projectFolder.ts` (core): only parsing (`parseProjectFolder`), `projectsRoot`, `ProjectFolderError`, the types
  (`ProjectFolder` = `NewProjectFolder | GitProjectFolder`) and `prepareNewFolder` (a new empty folder: no git, stays
  in the core so a phone's New Project works with the edge host down).
- `lib/gitProjectFolder.ts` (new, edge only; a `git mv` copy of the old file, history kept): `prepareGitFolder` (clone,
  worktree via the scm seam, branch), clone helpers (`cloneRepository`, `cloneFailure`, `RepositoryAccessError`,
  `RepositoryHostKeyError`, `CLONE_STALL_MS`, `CLONE_LOOK_MS`), `gitFolderAnswer` (the port's answer: never throws) and
  `gitProjectFolderOf` (checks the payload off the link). The clone's destination is named from the re-parsed address
  (`repository.name`), never the request's `name`.
- `lib/worktreeDeletion.ts`: takes plain data, `(target: WorkspaceTarget, others: string[])` instead of
  `RegisteredSession`s; adds `reviewWorktree`/`removeWorktree`, which answer `{ok, review|reason}` instead of throwing.
- `core/api.ts`: `WorkspacesPort` gains `ready()`, `prepareFolder(project, {cloneFallback})`,
  `describeWorkspace(target, others)`, `reviewWorktree(target, others)`, `removeWorktree(review, target, others,
  discard)`; types `PreparedFolder`, `WorktreeAnswer`; `WORKSPACES_UNAVAILABLE`, `WORKSPACES_FALLBACKS`,
  `WORKSPACES_OFF`. Refusals are answers, never throws. "Not answered" is `SERVICE_UNAVAILABLE` (already in the product
  usage 'unavailable' set, so no change to the usage contract or its backend copy).
- `core/workspacesLink.ts`: asks with `serviceLinks.call` and deadlines (`PREPARE_FOLDER_MS` 60 min backstop,
  `WORKTREE_REVIEW_MS` 20 s, `WORKTREE_REMOVE_MS` 45 s); validates every answer's shape (`folderAnswer`,
  `inspectionAnswer`, `reviewAnswer`); asks nothing of a process until it says `folders` on its connection (a process
  from before ignores unknown requests and would hold a create an hour); `disconnected()` resets that.
- `services/workspaces.ts`: the port's new members (inline and in its process). `services/workspacesProcess.ts`:
  handlers `prepareFolder`, `describeWorkspace`, `reviewWorktree`, `removeWorktree` (payloads checked), and
  `core.query('folders')` on every connection.
- `core/agents/launches.ts`: `executeCreate` makes a `new` folder itself and asks workspaces for the rest; a create
  whose folder needs git and finds workspaces not `ready()` is HELD before its effect is claimed
  (`WORKSPACES_HOLD`, service `workspaces`; native-create-v1 and model-create-v1 paths), so an edge-host restart never
  fails a create. In flight when the edge host goes: failed with `SERVICE_UNAVAILABLE` and a detail the window shows.
  A worktree's folder is trust-recorded only inside `<projectsRoot>/worktrees/` (the folder is workspaces' word).
  New dep `workspaces: () => WorkspacesPort | null`.
- `lib/purgeAgentService.ts`: dep `worktrees()` (the port) instead of importing worktreeDeletion. Before the first
  step that changes anything (the stop), a delete that removes a worktree re-reviews it through workspaces
  (`unchanged`): workspaces down or the worktree changed refuses with the harness running and nothing removed.
- `core/agents/lifecycle.ts`: dep `workspaces`, passed as `worktrees: () => workspaces() ?? WORKSPACES_OFF`.
- `core/main.ts`: three local edits (the link gets `call`; `disconnected` calls `workspacesLink.disconnected()`;
  launches get `workspaces: () => ports.workspaces`; lifecycle gets `workspaces: () => ports.workspaces`).

## Next steps for PR 1, in order

1. Fix the rest of the specs (tsc lists them; backendSocket.spec.ts and launches.spec.ts are done, see above):
   launchRequests.golden.spec.ts,
   nativeCreate.spec.ts, lifecycle.spec.ts (add `workspaces`), serviceHost.spec.ts (WorkspacesPort fakes need the new
   members), core/workspacesLink.spec.ts (new call arg; test folders/ready, each answer validator, disconnected),
   engines/otherLaunch.golden.spec.ts, lib/gitProject.spec.ts and scm/gitScmProject.spec.ts (prepareGitFolder;
   `new` case -> prepareNewFolder), lib/gitStub.spec.ts and lib/worktreeDeletion.spec.ts (new signatures: `others` is
   other harnesses' cwds, excluding self), lib/projectFolder.spec.ts (split: parse/new stay; lines ~93-469, the clone
   tests, move to lib/gitProjectFolder.spec.ts with `prepareGitFolder`), lib/purgeAgentService.spec.ts,
   lib/purgeAtFolderTrust.spec.ts, lib/nativeHistoryDeletion.spec.ts, lib/nativeHistoryAuthority.spec.ts (they spy on
   the worktreeDeletion module: pass `worktrees: () => ({ describeWorkspace: inspectWorkspace, reviewWorktree,
   removeWorktree })` or vi.fn fakes; add the pre-check test: refused before the stop when review fails/changes),
   services/workspacesProcess.spec.ts and services/workspaces.spec.ts (new handlers, `folders` query on connect).
   The golden specs (launchRequests.golden, otherLaunch.golden, nativeCreate) only need `workspaces: () => null` in
   their deps; lifecycle.spec.ts needs `workspaces`.
2. lib/productUsageSignals.spec.ts scans `projectFolder.ts` for error codes: add `gitProjectFolder.ts` to its list.
3. `cli/src/architecture.coreFiles.txt`: delete `lib/worktreeDeletion.ts`; `lib/gitProjectFolder.ts` must NOT appear
   (edge only). Run `src/architecture.spec.ts` and `src/leanEntry.spec.ts`. Note core files/lines before (547 lines in
   the list today) and after.
4. Red-then-green: a test that fails on origin/main. Best at e2e: with `git`/`ssh`/`du` shims on the daemon's PATH
   that log `$PPID` (pattern in tools/workspacesGitFacts.e2e.ts `shims()`), a worktree, a clone and a
   branch create, and a worktree purge, start no child of the core pid. Clone without GitHub: write the test home's
   `~/.gitconfig` with `[url "file:///<bare repo>/"] insteadOf = https://github.com/e2e/`.
5. New e2e (e.g. `cli/e2e/workspacesFolders.e2e.ts`, patterns from e2e/serviceProcesses.e2e.ts and
   e2e/workspacesProcess.e2e.ts): create flows (worktree, clone, branch) answer `pending` then created; purge of a
   worktree (agent_purge inspect includeWorktree -> delete choices both, and agent_worktree_delete inspect -> delete);
   failure isolation: edge host killed with a long restart backoff -> a worktree create is held
   (`agent_create_status` pending, `held.service === 'workspaces'`), agents work, core never restarts, then it
   finishes when the edge host is back; hung (SIGSTOP, HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS=2000) during a create ->
   failed SERVICE_UNAVAILABLE, named; parked (`workspaces.crash`, PARK_CRASHES=3) -> create held, purge's worktree
   choice unavailable with a reason and a worktree delete refused before the stop. No e2e covers these flows today.
6. Existing e2e to run: workspacesProcess.e2e.ts, creationPaths.e2e.ts, folders.e2e.ts, ends.e2e.ts (purge),
   compat.e2e.ts (agent_worktree_delete in the request list), enginehomes.e2e.ts (projectSource new). Use
   `TMPDIR=/tmp E2E_BUNDLE=1` (no `timeout` command on this Mac). Never edit sources while an e2e runs.
7. The children list for the PR body. Before (origin/main), every git/du/ssh child the core's process can start:
   lib/agentProject.ts `git` (frames); lib/sshHosts.ts `ssh -G` (frames' alias, and clones); lib/gitProject.ts `git`,
   `git worktree add` (spawn), `taskkill` on Windows (creates); lib/projectFolder.ts `git clone` (spawn),
   `git config remote.origin.fetch`, `git remote get-url origin` (creates); lib/worktreeDeletion.ts `git`, `du -sk`
   (purges); lib/branchNaming.ts loaded but run only in workspaces. After PR 1: only agentProject's `git` and
   sshHosts' `ssh -G`, both on the frame path, which core-git-2 removes. (gitProject.ts, branchNaming.ts, sshHosts.ts
   stay in the core's file list until core-git-2: agentFrame -> scm/scmProjects -> GitScmProject imports them.)
8. Docs, only my rows: the audit doc's Git row (mark the create and purge half done, with core files/lines), and the
   texts that describe workspaces: cli/AGENTS.md edge row, cli/src/services/AGENTS.md (the "A service the core only
   gives commands to" paragraph is no longer true: it now answers folder and worktree asks), cli/src/core/AGENTS.md
   (`workspacesLink.ts`).
9. Gates: `npx tsc --noEmit -p .`; `npm run test:core` (100% per file for src/core and src/services: workspacesLink.ts,
   launches.ts, lifecycle.ts, workspaces.ts, workspacesProcess.ts); `python3 scripts/local-checks.py --list <paths>`
   (cli/src/lib files may need cli-portability); the e2e above; then `/code-review high` on the diff, fix, commit,
   `python3 scripts/local-checks.py --run --base origin/main`, draft PR with receipts in the body, then ready.

## Open points to decide or check

- Under an old edge host (new core, master that did not re-exec), creates needing git stay held until the edge host
  runs this build, and worktree reviews answer unavailable. Same kind of degradation as earlier moves (engine probe,
  forgetTold). Say it in the PR.
- The lead's "reports progress": there is no channel to the window after a create's claim without touching
  lib/agentCreationReceipt.ts (another agent's). The core keeps its own bound with the 60-minute backstop; the edge
  host's own bounds (clone stall 2 min, worktree add 10 min) and its connection closing end real stalls. Progress
  notices would only duplicate the master's heartbeat. Say so in the report; ask the lead if they want a progress
  notice anyway.
- Between PR 1 and nothing else: creates, renames and removals now all take `inRepositoryTurn` in the one edge
  process (before, renames were already in another process than creates).

## core-git-2 (later, after the frame-parts shape lands)

- Frames' `project` and `gitContext` from facts the workspaces service sets on the shared shape, pushed on change.
  The service computes them as today (agentProject cached reader, sessionGitContext, sessionGitHistory store, the
  SessionGitContextReader versions) for the agents the core tells it of; keep the 15 s/60 s freshness rules.
- Then agentProject.ts, sessionGitContext.ts, sessionGitHistory.ts, sshHosts.ts, branchNaming.ts, gitProject.ts,
  scm/gitScmProject.ts and agentNames' branch half leave the core; split the scm seam so the core keeps only
  scm/types.ts and the launch half (`scmLaunchEnv`, `prepareInstructionWrites`); move `validGitPath` out of
  gitProject.ts (parseProjectFolder needs it) and `insideGitCheckout` with agentProject.
- Placeholder before a report: `project` = `{kind:'none', name: basename(cwd), cwd, root/remote/branch null}`,
  gitContext `{state:'workspace', current: that, checkouts: [], …}` (what today's code says of a plain folder: the
  quietest display). Desktop needs `project.cwd` for Fork/Clone, so never `project: null` for a valid cwd.
- Measurement rig ready: tools/workspacesGitFacts.e2e.ts (git/ssh/du shims logging $PPID, ten agents,
  a window asking agents_list like the desktop, JSON numbers, "the core started none" assertion that is red on main).
  The before run on main was not finished (the first bundle build failed on the symlinked node_modules; fixed since).
  Run: `TMPDIR=/tmp E2E_BUNDLE=1 GIT_FACTS_REST_SECONDS=120 GIT_FACTS_LIST_EVERY_SECONDS=15 npx vitest run --config
  vitest.e2e.config.ts e2e/workspacesGitFacts.e2e.ts -t 'ten agents'` from a copy in cli/e2e. Desktop asks
  `agents_list {includeStopped:true}` every 60 s (app_state.dart agentSyncInterval).
