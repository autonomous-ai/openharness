# Team account: private temp folder, safe status read, clean status output, trusted removal

Task #2019, from the audit in PR #2538 (`docs/security/2026-11-02-team-account-boundary.md`): M1, M5, L1 and L3.

**Goal:** the owner's agents stop leaving files where a Team account reads or plants them; the Team account's status file
cannot hang the owner's processes or write to the owner's terminal; `team remove` acts on nothing the Team account wrote.

## Decisions

- **Which agents.** Every engine agent of the owner's daemon on a computer with a Team account, Mac and Linux. Not person
  terminals, not Windows (its temp folder is already per-account), not the Team account's own agents, not a computer without
  a Team account: nobody else is on that one, and it should not change.
- **Where.** `<data folder>/agent-tmp`, mode 0700. Inside the data folder because a wide Buddy's guard already closes that
  folder, so it cannot read other agents' temporary files (`lib/buddyGuard.ts`).
- **Buddy keeps the system's folder.** The same guard would refuse it writes in the new one, and that folder is `/tmp` where the daemon has no `TMPDIR`. This gap stays open: closing it means changing the guard, which is its own task.
- **How it reaches an agent.** The pane's environment, in the two places every launch passes: `core/agents/create.ts` and
  `lib/launchOverrides.ts` (relaunch, resume, fork, swap). The launch's own variables win over it.
- **Read paths.** `lib/pathContainment.ts` `tempRoots` adds the folder, or an agent's file there could no longer be previewed.
- **L3 differs from the brief.** The brief asks for an id the owner's daemon records at setup. The backend already records
  this: the owner's sign-in names its Mac when it mints the team code, and the team machine gets that `hostMachineId`, which
  no team session can set. `team remove` now takes off the team machines hosted on this computer's machine. That needs no new
  file, also covers accounts set up before this change, and does not stop working if the Team account deletes its id file.
  A team machine with no host link is left, and the person is told to remove it. The removal scripts stop reading the Team
  account's id file as root, since nothing uses it.

## Design

- **Growth:** at most once a day, on an agent's launch, a top-level entry with nothing changed in 7 days (by the newer of mtime and ctime) is deleted; a link
  is deleted, never followed. `/tmp` itself is never touched.
- **Concurrency:** one folder per daemon, created idempotently. A sweep races only with files older than 7 days.
- **Read cost:** one small root-owned config read per launch; the sweep stops walking a tree at its first recent file.
- **Scale:** 10x agents means 10x temporary files for 7 days at most. The first sign is disk use of this folder.
- **Compatibility:** older CLIs ignore all of it. Running agents get the folder at their next start.
- **Migration + rollback:** none; rolling back leaves a folder the home already keeps private.
- **Audience:** the 0700 mode and the owner's home; `team status` shows the mode.
- **Identity:** the folder's owner must be this user, or it is not used. `team remove` trusts the backend's record.
- **Failure:** if the folder cannot be made or is not private, the agent still starts on the system's folder, the daemon logs
  it, and `team status` shows it with ✗.
- **Platforms:** Mac and Linux get the folder. Windows is unchanged; its status read and removal share the same code.

## Steps (each test first)

1. `team/privacy.ts`: read the status file with `O_NOFOLLOW | O_NONBLOCK`, plain files up to 64 KiB. Tests: a real FIFO, a
   link, a folder, an oversized file.
2. `team/privacy.ts`: remove control and format characters from each `detail` as it is read. Test: escape codes, C1, bidi.
3. `team/command.ts`: `team remove` by host link. Tests: another Mac's team machine, a team machine with no link, this
   computer's own machine, no machine id here. Drop the id reading from the three removal scripts.
4. `lib/agentTmp.ts`: the folder, who gets it and the sweep. Tests: real modes, a link in its place, another owner, the sweep.
5. Wire it into `create.ts`, `launchOverrides.ts`, `tempRoots`, and `team status` (with `--json`).
6. Tell the agents: one line in the skills' "Shared machines and secrets", with `mktemp -d`, which works whether or not `TMPDIR` is set; the message-file error names the actual folder.
