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

1. An agent on a Team account was assigned to build its task (a lasting mark on the task, kept by the server). A Team agent
   given only a step does not count, and neither does the project's coordinator. Opening the task, joining it, being named
   into it or posting there writes no code and marks nothing (#3304, `docs/plans/2026-11-05-team-written-follows-code-plan.md`):
   a push of the agent's own shows under 2.
2. GitHub shows a push by the app's bot of a commit in the pull request. This also catches a batch branch that the PM pushed with
   Team commits inside.
3. Its head has commits not on the default branch, and the activity log can't cover them (the log was too short, the read
   failed, or the commit came from a fork).

Code on the default branch has passed review and counts as clean.

## Tasks

### Task 1: the server's mark and refusal (backend)

Files: `backend/src/superTabs/commands.ts`, `machines.ts`, `model.ts`, new `backend/src/superTabs/teamWritten.ts`, tests beside them.

- `Conversation.teamWritten: true` is set when an agent on a Team account opens a task, is assigned to it, is added to it or is named
  into it, and it never clears. Any new mark tells every main-account member of the task and its steps to stop, finished steps
  included, and a post by another agent that names one of them is refused. A step reads its task's mark. A Team agent given only a step, or the project's coordinator, marks nothing.
- `work.assign`, `conversation.agent`, `agent.start` and `route.record` refuse an agent outside a Team account for a marked
  task or its step, with `TEAM_WRITTEN_WORK` and a reason that says where the work can go. Route candidates leave those
  machines out and say why.
- Tests, each failing on main: refused assign, join and start; a step of a marked task; the mark survives a re-route; an owner's
  own unmarked task is unchanged; an id from another project or a private chat reads as missing, as today.

### Task 2: who pushed it (backend, with a read for clients)

Files: new `backend/src/github/pushOrigin.ts`, `backend/src/github/app.ts`, `backend/src/superTabs/store.ts`.

- Given a project and a head commit, it reads the activity log with the app's token and answers `clean`, `team` or `unknown`.
  Results are cached by head commit only, with a bounded retry. `unknown` is never cached as clean.
- At a `work.assign`, an added agent, a Ready for review and a start that names a branch (a PM's too), the server reads the origin
  first and marks the task on `team`, and the mark stays even when the command that read it is refused. `unknown` refuses the main
  account without marking. A step that names no pull request reads `unknown`. This covers a Team push onto an owner's branch.
- The whole log is too long to walk: 2,000 events reached 3.3 days on this repository. So the read asks two narrow questions: who
  pushed the head, on its own branch (`ref=`), and which of these commits the app's bot ever pushed (`actor=`).
- The answer says only the verdict: no names and no branch titles. A project the caller can't read gets the same refusal as a
  missing one.
- Tests with `fakeGitHub.ts`: a bot push; a batch branch; a person's push; a forged author on a bot push; a failed, partial or
  too-short log (`unknown`); and a rate limit.

### Task 3: the launch (CLI)

Files: `cli/src/engines/claude/launch.ts`, `engines/codex/launch.ts`, `lib/engineLaunch.ts`, `core/agents/launches.ts`,
`core/agents/create.ts`, `superTabs/cloneTrust.ts`, `superTabs/start.ts`, `superTabs/inCore/teamPurge.ts`,
`desktop/lib/core/permission_modes.dart`.

- The server stamps `projectSettings: 'off'` on a start for a marked task. The host turns it into the permission mode
  `teamWritten`, which is kept on the agent's row, so a relaunch keeps it. A resume that asks for another mode is refused.
- Claude Code gets `--setting-sources user --strict-mcp-config`. Codex gets an engine home of its own, which trusts no project.
- A daemon that is not a Team daemon refuses a stamped start before anything is created.
- The server also reads the branch a start names: a bot's push moves the start to the Team account, and a branch GitHub cannot
  place stays out of the main account.

### What the real engines showed (2026-11-02, throwaway config folders, this Mac)

| Run | Result |
|---|---|
| Claude Code 2.1.316, trusted folder, no flags | Planted `settings.json`, `settings.local.json` and `.mcp.json` all ran. This is H2 happening. |
| Same folder, with the flags | None ran. |
| Same flags, no trust record | The session stops at the trust question. |
| Codex 0.165.0, untrusted folder | Project MCP server not loaded. |
| Codex, a worktree whose main repository is trusted | Loaded: a worktree takes its main repository's trust. |
| Same, with `-c projects."..".trust_level="untrusted"` | Still loaded: this does not turn it off. |
| Same worktree, an empty `CODEX_HOME` | Not loaded. |

**Change from the brief:** the brief asks for no folder trust. A Claude Code session with no trust record stops at a question nobody
sees, so Team-written work keeps its trust record, in the Team account only. The flags are the barrier, as the runs above show.

### Task 4: moved out of this change

The plan first had a `post-checkout` warning for main-account agents. It needs git settings injected into every main-account
session, and it can only warn. The server's check on assignment, start and Ready covers the workflow's own paths, so the warning is
left out here. What that leaves open is below.

### Task 5: docs and proof

- Update `docs/security/2026-11-02-team-account-boundary.md` with H2's status and what stays open.
- Run the full backend Super Tab integration suite, `npm run test:core` and the affected Desktop test.

## What this does not close

- **An agent told outside the workflow.** A main-account agent that runs `gh pr checkout` on a branch it was never assigned, for
  example because a chat message asked it to (M3), still runs that code as the owner. The server only controls who gets the work.
- **A push after the check.** A Team agent can push between a clean reading and the Reviewer's fetch. The next Ready reads again
  and tells every main-account member to stop, but by then one may have run the code.
- **A rewrite by a person or an owner's agent.** An owner's agent on its own project pushes with the owner's login, so GitHub shows
  it as a person. If a person or that agent rebases or cherry-picks a Team agent's commits, the new commits have new ids and the
  branch reads clean. A marked task keeps its mark; a new branch on another task does not get one.
- **Old pushes.** The scan of the bot's pushes stops a week before the older of the pull request and its oldest commit. A commit's
  date can be forged, which can only narrow this back to the pull request's own week.
- **The default branch.** It reads clean without a check, because it passed review. A Team token could push to it if the branch
  were unprotected. Here it is protected, and that protection is what this rests on.
- **The PM.** It is exempt as "never builds or runs it", but nothing enforces that. It builds batch branches in the main account, and
  a `Makefile` or `.claude` settings from a batch branch would run as the owner. The batch and `make merge-pr` must run from a
  default-branch checkout. That is a rule for the project's instructions, not something this code enforces.

Closing the first two takes a sandbox for every main-account agent, or a repository rule that keeps the app's bot to its own branch
prefix. The rule is the stronger next step. It needs a change to repository settings, so it is Ken's decision and not part of this
task.

## Work that needs the owner's tools or devices

A Team account has none of the owner's tools or devices, so firmware on a plugged-in device and other owner-only checks have no home
once a task is marked. This code offers no exception. The default is that such a task is reviewed in a Team account, merged, and then
checked on the owner's device, because code on the default branch has passed review. Scholes and Ken can decide otherwise.

## Design

- **Growth:** one boolean on a task, removed with the task. The origin cache keeps at most 1,000 heads in memory. A Codex agent's own
  home is deleted when the Swarm ends that agent.
- **Concurrency:** the mark is set inside the existing per-tab command transaction. GitHub reads run outside it, and their
  result is applied by a command that only ever adds the mark, so a late read can't clear one.
- **Read cost:** per new head, up to 3 pull request reads, 3 pages of the branch's log and 20 pages of the bot's pushes. A head with
  an answer is not read again, and an `unknown` is read again after a minute at most.
- **Scale:** at 10x pushes the activity log's 5,000-an-hour app limit warns first. A rate limit reads `unknown`, which fails closed
  and refuses main-account work, so the refusal count is the metric to log.
- **Compatibility:** an older CLI on a Team account ignores the stamp, so its session reads project settings there, with the Team
  account's rights and not the owner's. An older backend sends no stamp and refuses nothing, so the rule starts with the backend
  release. Desktop lists the new mode by name, and an older Desktop shows it as unknown.
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
