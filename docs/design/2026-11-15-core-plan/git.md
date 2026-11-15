# Git out of the daemon core: where it stands

Package: audit section 2, the "Git" row (docs/design/2026-11-12-core-audit.md) and security item 5 (`git clone` inside
`agent_create`). Read first: the plan's rules and lessons (../2026-11-15-core-plan.md), cli/AGENTS.md "Protect the core",
cli/src/core/AGENTS.md, cli/src/services/AGENTS.md.

## Step 1: a create's folder and a purge's worktree (done, #4319, branch `core-git-2`)

The core runs no git for a create or a purge; the workspaces service in the edge host does.

- `lib/projectFolder.ts` (core) keeps the parse, `projectsRoot`, the types and `prepareNewFolder` (a new empty folder: no
  git, so a phone's New Project works with the edge host down). `lib/gitProjectFolder.ts` (edge only) has the clone, the
  worktree and the branch (`prepareGitFolder`, `gitFolderAnswer`, `gitProjectFolderOf`). A clone's folder is named from
  the re-parsed address, never the request's `name`.
- `lib/worktreeDeletion.ts` (edge only now) takes plain data (`WorkspaceTarget`, the other harnesses' folders) and
  answers `reviewWorktree`/`removeWorktree` in words, never a throw.
- `core/api.ts` `WorkspacesPort`: `ready`, `prepareFolder`, `describeWorkspace`, `reviewWorktree`, `removeWorktree`, with
  `WORKSPACES_FALLBACKS` and `WORKSPACES_OFF`. "Not answered" is `SERVICE_UNAVAILABLE`.
- `core/workspacesLink.ts` asks with `serviceLinks.call` and deadlines (60 min backstop for a folder, 20 s a review,
  45 s a removal), checks every answer's shape, and asks nothing until the process says `folders` on its connection.
- `core/agents/launches.ts`: a create whose folder needs git, with workspaces not ready, is held (`held.service ===
  'workspaces'`) before its effect is claimed; one in flight when the edge host goes fails `SERVICE_UNAVAILABLE` in words.
  A worktree's folder is trust-recorded only inside `<projectsRoot>/worktrees/`.
- `lib/purgeAgentService.ts`: a delete that removes a worktree reviews it again through workspaces before the stop:
  workspaces down, or the worktree changed, refuses it with the harness running and nothing removed.
- Evidence: `e2e/workspacesFolders.e2e.ts` (git, ssh and du shims log their parent pid). Before, on main, the core ran
  clone, worktree add, switch, du, worktree remove; after, the core ran only the frame's reads (`rev-parse`, `config
  --get`), and the edge host the rest.

Open, said in the pull request:

- Under an old edge host (a new core under a master that did not re-exec), creates that need git stay held until the
  edge host runs this build, and worktree reviews answer unavailable.
- A clone's progress in the window needs `lib/agentCreationReceipt.ts` (package 9's). Until then the core waits at most
  60 minutes for a folder, and the edge host stops a stalled clone itself (2 min without progress, a worktree's checkout
  10 min).
- Creates, renames and removals in one repository now take turns in the one edge process (`inRepositoryTurn`).

## Step 2: frames' git facts (after package 2's frame parts land)

Do NOT build a frame cache of your own in the core: it waits for package 2's generic per-agent frame parts.

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
- What the core's process still runs after step 1, all on the frame path: lib/agentProject.ts `git` (`rev-parse`,
  `config --get`, `symbolic-ref`) and lib/sshHosts.ts `ssh -G` (a remote's SSH alias).
- Measurement rig ready: tools/workspacesGitFacts.e2e.ts (git/ssh/du shims logging $PPID, ten agents,
  a window asking agents_list like the desktop, JSON numbers, "the core started none" assertion that is red on main).
  Run: `TMPDIR=/tmp E2E_BUNDLE=1 GIT_FACTS_REST_SECONDS=120 GIT_FACTS_LIST_EVERY_SECONDS=15 npx vitest run --config
  vitest.e2e.config.ts e2e/workspacesGitFacts.e2e.ts -t 'ten agents'` from a copy in cli/e2e. Desktop asks
  `agents_list {includeStopped:true}` every 60 s (app_state.dart agentSyncInterval).
