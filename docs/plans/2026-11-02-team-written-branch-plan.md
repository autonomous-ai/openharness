# A branch a Team agent wrote never runs as the owner: implementation plan

Task #2025, audit finding H2 (`docs/security/2026-11-02-team-account-boundary.md`). Requested by Scholes.

**Goal:** code a Team agent wrote is built, run and read only in a Team account, with its project settings off. It never
runs with the main account's rights.

**Approach:** three layers. The server decides who may take the work. GitHub's record says who pushed. The launch turns
project settings off.

## What the code does today

- A Team agent's GitHub token may write to the whole repository (`backend/src/github/app.ts:14`). GitHub has no per-branch
  token, so it can push to any unprotected branch, including an owner's agent's pull request.
- Commit authors and trailers can be forged. They can show a branch is Team-written, but never that it is safe.
- GitHub's activity log can't be forged by the pusher. `GET /repos/R/activity` names each push's actor, its ref and its
  before and after commits. Read on 2026-11-02: `harness-for-autonomous[bot]` made 8 of the last 100 pushes, and people's
  own logins made the rest.
- Most Reviewers start on the default branch and then run `gh pr checkout` themselves, so a check at start alone misses the
  normal path.
- A trust record is not the real barrier. Claude Code also accepts a Yes given to the main repository for its worktrees
  (`engines/claude/launch.ts`). What keeps the settings out is the launch flags.
- `--setting-sources local` is not enough here: a branch can commit `.claude/settings.local.json`. Harness's hooks are in the
  person's user settings, so `user` keeps them and drops everything the branch carries.
- All 8 Macs in this Swarm have a Team account beside them at this reading, so routing there is possible today.

## The rule

A branch is **Team-written** when any of these holds. It is trusted only when the check reads clean, and a failed read counts
as Team-written:

1. Its task, or the task its step belongs to, ever had an agent on a Team account assigned or joined (a lasting mark on the
   task, kept by the server).
2. GitHub shows a push by the app's bot whose commit is an ancestor of the branch's head and not on the default branch. This
   also catches a batch branch that the PM pushed with Team commits inside.
3. Its head has commits not on the default branch, and the activity log can't cover them (the log was too short, the read
   failed, or the commit came from a fork).

Code on the default branch has passed review and counts as clean.

## Tasks

### Task 1: the server's mark and refusal (backend)

Files: `backend/src/superTabs/commands.ts`, `machines.ts`, `model.ts`, new `backend/src/superTabs/teamWritten.ts`, tests beside them.

- `Conversation.teamWritten: true` is set by `work.assign` and `conversation.agent` when the agent is `onTeamAccount`, and it
  never clears. A step reads its task's mark.
- `work.assign`, `conversation.agent`, `agent.start` and `route.record` refuse an agent outside a Team account for a marked
  task or its step, with `TEAM_WRITTEN_WORK` and a reason that says where the work can go. Route candidates leave those
  machines out and say why.
- Tests, each failing on main: refused assign, join and start; a step of a marked task; the mark survives a re-route; an owner's
  own unmarked task is unchanged; an id from another project or a private chat reads as missing, as today.

### Task 2: who pushed it (backend, with a read for clients)

Files: new `backend/src/github/pushOrigin.ts`, a route beside `backend/src/routes/superTabs`, a `branch-origin` read in the CLI.

- Given a project and a head commit, it reads the activity log with the app's token and answers `clean`, `team` or `unknown`.
  Results are cached by head commit only, with a bounded retry. `unknown` is never cached as clean.
- When a task gets a `review` status or a linked pull request, the server reads the origin and sets the mark from rule 2 or 3.
  This covers a Team push onto an owner's branch.
- The answer says only the verdict: no names and no branch titles. A project the caller can't read gets the same refusal as a
  missing one.
- Tests with `fakeGitHub.ts`: a bot push; a batch branch; a person's push; a forged author on a bot push; a failed, partial or
  too-short log (`unknown`); and a rate limit.

### Task 3: the launch (CLI)

Files: `cli/src/engines/facets/launch.ts`, `engines/claude/launch.ts`, `engines/codex/launch.ts`, `engines/launchPrep.ts`,
`core/agents/launches.ts`, `core/agents/create.ts`, `superTabs/cloneTrust.ts`, `superTabs/start.ts`.

- The backend stamps `projectSettings: 'off'` on a start for a marked task. It is kept on the agent's row, so a resume or
  relaunch keeps it, and a daemon restart can't drop it.
- Claude gets `--setting-sources user --strict-mcp-config`. Codex gets no `trust_level` record, so its project layer stays out.
- All three trust writers skip such a worktree: launch, create and the clone repair sweep. The repair sweep runs on a timer, so
  a skip in launch alone would be undone a minute later.
- Before building, try with the real binaries in a throwaway `CLAUDE_CONFIG_DIR` and `CODEX_HOME` whether an untrusted folder
  stops at a question. If it does, the session starts in an empty folder Harness makes and the checkout sits beneath it.
- The main account refuses: a daemon that is not a Team daemon rejects a start stamped `off`, and rejects a `branchRef` whose
  origin is `team` or `unknown` unless it is on the default branch.
- Tests: the launch line for each engine; a planted `.claude/settings.json`, `settings.local.json` and `.mcp.json` not read;
  `folderTrust.record` not called on any of the three paths; a resume keeps the flags; the main-account refusal; an old backend
  without the stamp, where the CLI still refuses by origin.

### Task 4: the normal path, `gh pr checkout` (CLI)

Files: `cli/src/lib/swarmGitHub.ts`, new `cli/src/superTabs/branchGuard.ts`, role text in `cli/src/lib/swarmSkills.ts`.

- A Swarm agent in the main account gets a `post-checkout` hook through the same `core.hooksPath` chain the session hooks
  already use, so a repository's own hooks still run. When its head leaves the default branch, the hook asks for the origin. On
  `team` or `unknown` it prints a plain refusal: do not install, build, test or run this; hand the task to a Team account. The
  task's agent is told and the task is marked.
- Reviewer and Tester role text say the same, and say to run the origin read before building.
- Tests: a real git checkout in a fixture runs the hook; the repository's own hook still runs; a failed read prints the refusal.

### Task 5: docs and proof

- Update `docs/security/2026-11-02-team-account-boundary.md` with H2's status and what stays open.
- `cli/src/team/boundary.spec.ts` gets an H2 block: the end-to-end path of a planted settings file and `.mcp.json` with a marker
  file, which stays unwritten.
- Run the full backend Super Tab integration suite, `npm run test:core` and `npm run test:harnessd`.

## What this does not close

The hook warns; it can't stop a shell. An agent in the main account that ignores the refusal, or fetches with plain `git fetch`
and runs a test without checking out, still runs the code as the owner. Between a clean reading and the Reviewer's fetch, a Team
agent can also push. Closing these fully takes a sandbox for every main-account agent, or a repository rule that stops the app's
bot pushing outside its own branch prefix. The second is the stronger next step, and it needs Ken's change to repository settings,
so it is a separate decision and not part of this task.

M3 (a chat message that tells an owner's agent to check out a branch) stays its own finding. Tasks 2 and 4 narrow it.

## Design

- **Growth:** one boolean on a task, removed with the task. The origin cache is bounded in memory by head commit.
- **Concurrency:** the mark is set inside the existing per-tab command transaction. GitHub reads run outside it, and their
  result is applied by a command that only ever adds the mark, so a late read can't clear one.
- **Read cost:** one activity read per new head, none for a head already read, paged only as far as the merge base.
- **Scale:** at 10x pushes the activity log's 5,000-an-hour app limit warns first. A rate limit reads `unknown`, which fails closed
  and refuses main-account work, so the refusal count is the metric to log.
- **Compatibility:** an older CLI ignores the stamp and an older backend sends none. The server's refusal holds for the first and
  the CLI's origin check for the second. A new start for a marked task needs a CLI with this change on Team accounts.
- **Migration and rollback:** no migration. Tasks open today carry no mark until an assignment or a reading sets it. Rollback
  removes the refusal, and the mark is harmless left behind.
- **Audience:** the server enforces who takes the work. The verdict carries no names or titles.
- **Identity:** the mark comes from the Swarm's own record of the account and GitHub's record of the pusher, never from commit
  authors or the machine owner's login.
- **Failure:** `unknown` refuses, with a reason that names the Team account as the way forward. Nothing passes silently.
- **Platforms:** the rule is the same wherever a Team account runs. A machine with no Team account can't take a marked task.

## Privacy, concurrency and lifecycle cases to test

- Access lost: a read in flight when project access ends gets dropped, and the answer is the same refusal as a missing project.
- Stale results: a reading for an old head can't change a newer head's answer, and a late reading can't clear a mark.
- Failed first read that recovers: `unknown` becomes `clean`, and the refusal lifts on the next read with no stuck state.
- Agent id or name reused across projects: the mark follows the task, never the agent's name.
- Data at a limit: a task at its size limit still saves with the mark.
