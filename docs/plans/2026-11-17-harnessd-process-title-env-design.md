# harnessd's processes show their environment in their command line

Date: 2026-11-17. Branch: `fix/harnessd-process-title-env`. Platforms: macOS (the leak), Linux and Windows (the same
change, no visible effect). Component: `cli/` (the daemon's master and service processes). Not in the core.

## Problem

`pgrep -fl harnessd` on a Mac lists the daemon's processes with environment variables after the name:
`harnessd NVM_INC=… CLAUDE_CODE_MESSAGING_TOKEN=…`. Any tool that reads a process's arguments this way, and any log, bug
report or chat that quotes such a listing, carries the daemon's secrets.

## Cause

Two lines set Node's `process.title`:

- `cli/src/harnessd/master.ts:281` `process.title = 'harnessd'` (the master).
- `cli/src/serviceProcess.ts:107` `process.title = \`harnessd-${title}\`` (every service process: the devices process,
  `edge`, `search`, `models` and the rest).

On Unix, libuv writes the title over the start of the process's original argument area and fills the rest of that area
with NUL bytes. On macOS the kernel hands readers that area (`KERN_PROCARGS2`) as `argc`, the exec path, the argument
strings and then the environment strings. `ps -o command` counts every NUL as the end of an argument and stops inside
the blanked area. `pgrep -f` skips empty strings, so after the title it takes the next `argc - 1` strings, which are
the environment's first variables.

Reproduced on this Mac with a process the test started itself (`node -e 'process.title="x"' a b`, a sentinel variable
in its environment): `ps` shows `x`, `pgrep -fl` shows `x` and two environment variables. Without the title, both show
the real arguments. In a Linux container `/proc/<pid>/cmdline` shows the title and NUL bytes only. On Windows the title
names the console window, which a detached daemon does not have.

The arguments Harness gives these processes carry no environment values: the master starts the core as
`harnessd-core <execArgv> <cli.js> __run` and each service as `harnessd-<name> <execArgv> <cli.js> __service <names>`
(`master.ts:397`, `master.ts:457`); `harness start` starts the master as `harnessd <cli.js> __harnessd`
(`cli.ts:1725`). The Rust processes (`pty`, `tui`, `device-app`) set no title. The e2e fake engine
(`cli/e2e/harness/fakeEngine.mjs`) sets one, but it is a test stand-in for a lab's CLI, not a Harness process.

## Decision (PM, 2026-11-17)

1. **Remove both `process.title` lines.** The names people see already come from the executable: each process is
   started through a hard link of the managed Node named after it (`libexec/harnessd/harnessd`, `harnessd-core`,
   `harnessd-<service>`, `harnessd/processName.ts`). Activity Monitor, `top`, `ps -c`, `pgrep -x` and the footprint
   e2e's `nameOf` (basename of the command's first word) read that name. One way to name a process: the hard link.
   - Lost: a daemon run on a Node outside the managed runtime (a developer's) shows as `node …/cli.js __service search`
     instead of `harnessd-search`. Its arguments still say what it is.
2. **Tests.**
   - **End to end, the red test:** a real daemon (`IsolatedDaemon`, master, core and service processes) started with a
     sentinel variable in its environment. The arguments of every process under the master, read the way `pgrep -fl`
     reads them, never contain the sentinel's value. Fails on macOS before the fix. The e2e suite does not run on pull
     requests; the tester runs it on this Mac.
   - **Unit (PR CI):** `runMaster` and `startServiceProcess` leave `process.title` as they found it. The existing
     assertions `expect(process.title).toBe('harnessd-search' | 'harnessd-edge')` in `serviceProcess.spec.ts` turn
     around, and `master.spec.ts`'s save-and-restore of the title goes.
   - **Architecture (PR CI), code over prompts:** no file under `cli/src` assigns `process.title`, with the reason in
     the test's comment. Test files and `cli/e2e` are outside what it reads.
3. **Out of scope, its own item (PM opens it):** `harness start` gives the daemon a copy of its whole environment
   (`cli.ts:1727` `env: { ...process.env }`), which is why a Claude Code session's `CLAUDE_CODE_MESSAGING_TOKEN` is in
   the daemon at all. This change keeps it out of the command line; it stays in the daemon's environment.

## The end-to-end suite depends on the title (PM, 2026-11-17: fixed in this pull request)

A daemon under test runs on a Node outside the managed runtime, so its processes have no name link and the title is
what named them. Thirteen e2e files rely on that: eleven find a service's pids by a command that is exactly
`harnessd-<name>` (or assert `toBe('harnessd')`), and two (`nothingOrphaned` in `reexec.e2e.ts` and
`updateHostile.e2e.ts`) missed the master and the services only because the title hid their path. They move to the
processes' real arguments (`__harnessd`, `__run`, `__service <names>`) in this pull request, or the nightly CLI end to
end goes red from the merge on. One hand-started run of the repo's "CLI end to end" workflow on the final head covers
them on Linux.

## Also changed

Comments that name the title as what names the process: `serviceProcess.ts` (the removed block's own comment),
`harnessd/processName.ts`'s header if it mentions the title, and the footprint e2e's header and `nameOf` comment
(`cli/e2e/footprint.e2e.ts`). `master.spec.ts`'s comment "runMaster titles the process it runs in" goes with its
save-and-restore.

## Data, security, measures

- Nothing is stored, synced or exposed; this removes an exposure.
- No new path, so no new measure.
- The tests use a sentinel value, never a real variable, and read only processes they started.

## Verification

- Red then green: the e2e test on macOS (this Mac) before and after the fix, and the unit and architecture tests.
- `npm run test:harnessd` (the master's specs) and the specs of the files changed.
- Manual, by the user on their own Mac after the release (not a gate of this pull request): `pgrep -fl harnessd` shows names and arguments only.

## Token exposure

`CLAUDE_CODE_MESSAGING_TOKEN` belongs to the Claude Code session whose shell ran `harness start`. On macOS
`KERN_PROCARGS2` is readable only by the same user and root, who could already read the environment (`ps -E`), so the
exposure is anything that saved or shared a `pgrep -f` listing. The final report recommends rotating it: end that Claude
Code session (its token goes with it) and restart the daemon from a shell that does not carry it.
