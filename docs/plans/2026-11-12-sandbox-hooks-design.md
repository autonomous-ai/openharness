# Hermes without hooks: bound from its own terminal record, in a sandbox and out

Issue: #4194, its first ask ("a hook mode for sandboxed agents"). The second ask (a count of background commands in
`harness show` and `watch`) is a separate feature and not part of this design.

## Intent

A device (ARM64 Linux) runs Hermes inside a sandbox: its own user, mount and pid namespaces, a private `/tmp`, `HOME`
set to the agent's own folder, and only that folder and a work folder visible. Inside it there is no Harness CLI, no
Node of Harness's, no `~/.harness`, no daemon socket and no tmux socket. Every hook Harness writes for Hermes fails
there (`on_session_start`, `pre_llm_call`), once per session and once per LLM call, and the device keeps a stand-in in
the sandbox to quiet them.

The issue asked for an inbox the sandbox writes and the daemon reads. Reading the code and Hermes's source changed the
answer:

- The Hermes hook does one job. It tells the daemon which Hermes session id a pane is on (`hook/notify.mjs` posts only
  `POST /api/hook/session-start`). Turns, working and idle, and tools come from Hermes's own `state.db`
  (`engines/hermes/reader.ts`), never from hooks.
- Hermes already writes that fact down itself. Since v0.21.6 (`hermes_cli/terminal_breadcrumbs.py`), every time its
  CLI sets a terminal's session (a new session, `/new`, a branch, a resume, a compression split, a gateway client
  adopting a session) Hermes writes `<HERMES_HOME>/terminal-sessions/<terminal id>`, atomically, as
  `{"session_id": …, "cwd": …, "ts": …}`. Its TUI (opt-in, `display.interface: tui`) writes none. The terminal id is
  `tty-<sanitized tty path of stdin, else of stdout>` (for example
  `tty-dev-pts-3`), else the first of `ZELLIJ_PANE_ID`, `TMUX_PANE`, … as `<name lowercased>-<sanitized value>` (for
  example `tmux_pane--5` for `%5`; sanitizing maps every character outside `[A-Za-z0-9._-]` to `-`, after stripping
  outer `/` and whitespace, and keeps 120 characters). Hermes uses it for a bare `hermes -c` in the same terminal; it
  is on by default (`session.terminal_continue`, default true).
- Harness knows each pane's tty and pane id. So the daemon can read, from a file in the agent's own Hermes home, which
  session that pane is on, exactly, with nothing running in the sandbox and nothing sent to the daemon.

So, for Hermes v0.21.6 or newer on macOS and Linux, Harness stops writing Hermes hooks and binds Hermes from that
record, in a sandbox and out of one. With no hook in the agent's config, nothing can fail in the sandbox. Hermes older
than v0.21.6 (published 2026-10-08) and a home set to the TUI keep today's hook as a compatibility path, removed on or
after 2026-12-07 (#4207).

**Rejected: the inbox.** It adds a new way for processes outside Harness to feed the daemon, with a folder to create,
mount, bound, clean and authenticate and a format to keep compatible, to carry one session id Hermes already writes
down. Reading the record has none of that surface: the daemon reads, read-only, a small file the agent's own Hermes
writes in its own home.

**Rejected: guarding the hook line** (`/bin/sh -c '[ -x node ] || exit 0; exec …'`). Every installer, uninstaller and
hook review (Codex's included) recognises Harness's lines by their first word being Node; a guarded line reads as
someone else's, so a rollback would hold Hermes launches (`HookPreparationHeld`) and double other engines' hooks. It
also needs `/bin/sh` inside the sandbox, which is not promised.

## Goals

1. A Hermes agent is bound to its session, and follows it through `/new`, `/resume`, a branch and a compression split,
   from Hermes's terminal record, on macOS and Linux, in a sandbox and out of one.
2. For Hermes v0.21.6 and newer, Harness writes no Hermes hooks on macOS and Linux, and removes the ones earlier
   releases wrote, so a sandboxed Hermes runs no Harness hook at all. The device can drop its stand-in once its pinned
   Harness has this and its Hermes is v0.21.6 or newer. Hermes older than v0.21.6 (published 2026-10-08, 35 days
   before this design) keeps today's hook as a compatibility path until 2026-12-07 (§4).
3. The daemon says once per agent, in its log, that the agent runs in a sandbox and is followed from its terminal
   record, once per home that it removed Harness's old Hermes hooks there, and once when a Hermes's version cannot be
   read (its hook is then kept).
4. Outside a sandbox a person sees the same binding as today.

## Non-goals

- No inbox, no new socket, route, token or file the sandbox writes for Harness.
- Windows keeps its Hermes hooks: Hermes has no terminal identity there (no tty path, and none of its terminal
  variables names a Harness pane), and there is no namespace sandbox to protect.
- OpenClaw: Harness writes no hooks for it, so nothing fails for it. The issue's mention of OpenClaw is asked about on
  #4194.
- Other engines in a sandbox.
- A sandboxed Hermes older than v0.21.6, or set to the TUI, keeps today's failing hook; the device runs v0.21.6+ with
  the default CLI.
- A device wrapper named `hermes` that stays the parent of the sandbox (does not `exec`): discovery takes the
  shallowest process that reads as Hermes, so it would take the wrapper, with the host's view. The README and #4194
  ask the wrapper to `exec` its sandbox launcher.
- The background-command count (the issue's second ask).

## Anti-goals

- Anything that sends a credential, a token or any of Harness's state into the sandbox.
- A binding that guesses. A record that is stale, from another process, or names a session the store does not hold as
  an interactive session, binds nothing.
- A daemon that polls harder: no new timer or watcher. The work rides the existing bind pass (every 5 s).

## Assumptions about the device (asked on #4194, not yet confirmed)

- The device's script calls `harness new`; the pane Harness opens runs `hermes`, and the device's wrapper puts it in
  the sandbox. The Hermes process is a descendant of a Harness pane and visible to the daemon's process scan from the
  host.
- The sandbox runs as the same host account as the daemon (an unprivileged `unshare --user` maps the caller's uid), so
  the daemon can read the process's `/proc/<pid>/environ`, `ns/mnt` and `mountinfo`, and the agent's files. If it runs
  as another host account, Harness can read neither the store nor the record, and an inbox would not help either: the
  reader itself needs `state.db`.
- The terminal record names the pane: either the sandbox shows the pane's tty at the same `/dev/pts/N` (a host `/dev`
  mounted in), or it keeps `TMUX_PANE` in the environment. If neither, Hermes writes no record and Harness binds the
  first session by the store's cwd and start time as today (§3, fallback), without following switches.
- Paths: designed to work either way. The likely case is that the agent's folder and the work folder are mounted at
  the same paths; when they are remapped, Harness translates them (§2).

## Design

### 1. The Hermes home a process uses

Today `probeHermesHome` (`engines/identities.ts`) takes `HERMES_HOME` from the process's environment and, when it is
unset, assumes the daemon's own default home. A sandboxed Hermes with `HOME` set to its agent folder and no
`HERMES_HOME` keeps its store in `<HOME>/.hermes`, so Harness reads the wrong store.

Change: compute the home the way Hermes does for a process environment (`hermes_constants.py`
`hermes_root_for_environment`): `HERMES_HOME` when set and absolute (a `profiles/<name>` under it as today); else the
platform default from that environment's own `HOME` (`<HOME>/.hermes<HERMES_DATA_DIR_SUFFIX>`; on Windows
`%LOCALAPPDATA%\hermes<suffix>`, else `<USERPROFILE>\AppData\Local\hermes<suffix>`). A home that differs from the
daemon's default is recorded on the row (`RegisteredSession.hermesHome`) as a profile home is today, and every reader
of the agent's home gets it from there. A relaunch (restart, resume, fork) exports `HERMES_HOME` only when the process
itself set it, as today; a home derived from `HOME` is not exported, since the relaunched process derives the same
home from the same `HOME`, in its own view (a path the daemon translated would be wrong inside a remapped sandbox).

### 2. Paths seen from a sandbox (Linux only)

When the Hermes process is in another mount namespace than the daemon (`/proc/<pid>/ns/mnt` differs), the home and cwd
it names are in the sandbox's view. A pure helper (`src/lib/`) translates such a path to the daemon's view through the
process's `/proc/<pid>/mountinfo` and the daemon's own: the mount holding the path, the daemon's mount of the same
device whose root covers that mount's root, and the rebuilt host path. A path that is the same on both sides
translates to itself. The translated path goes on the row and stays valid after the sandboxed process exits.

No translation (a tmpfs, a filesystem the daemon does not mount, an unreadable `mountinfo`): the agent is held with a
reason a person can read ("Hermes runs in a sandbox whose folder Harness cannot see"), logged once, and not bound. Its
pane and terminal work as today. Comparisons with what Hermes wrote (a row's `cwd`) are made in the sandbox's view,
where Hermes wrote it.

### 3. Binding and following from the terminal record

On the existing bind pass, for each Hermes agent on macOS or Linux:

1. Its terminal ids: `tty-<sanitized pane tty>` and, for a tmux pane, `tmux_pane-<sanitized pane id>`, sanitized with
   Hermes's own rule. Hermes writes the tty one when the process has a tty, so it is read first.
2. Read `<home>/terminal-sessions/<id>`, only when its modification time or size changed since this agent last read
   it (one `lstat` per terminal id per pass otherwise, two for a tmux pane). Bounded: at most 4 KB read, a regular file (not a symlink), JSON with a
   string `session_id` matching `HERMES_HISTORY_ID_RE` and a numeric `ts`. Anything else is ignored and logged once
   per agent with the reason, never the content.
3. It counts only if `ts` is at or after the process's start (less the existing start slack): a tty number is reused,
   and a record from an earlier process in the same tty must not bind the new one.
4. The session must exist in the same home's store as an interactive session (the creator rules the repair and the
   hook admission already use; a sub-agent never qualifies) and pass `mayClaim` (not bound to another live agent that
   started later). Until the row exists (Hermes writes the record as the session is created), the agent waits for the
   next pass.
5. Unbound agent: bind it (`source: 'hermes-terminal'`). Bound to another session: switch through the existing
   rotation path, as the Copilot `/resume` switch does, so the reader, recaps and apps see a session change exactly
   as they saw one from a hook.

Fallback (no record: Hermes's TUI, `session.terminal_continue: false`, a sandbox that shows neither the tty nor
`TMUX_PANE`, or an older Hermes whose hook never arrives): the existing `process-repair` binds the first session by home, cwd and start time, as it does
today when a hook never arrives. Switches are not followed then; the agent stays on its session until its process
restarts. The daemon logs this once per agent.

A ptyhost pane on macOS or Linux uses the tty of its pty as its terminal id; if the daemon cannot name that tty, the
fallback applies.

### 4. No Hermes hooks on macOS and Linux for Hermes v0.21.6+

- The Hermes hook installer (`installHermesHooks`, `HERMES_HOOK_SETTINGS`) and the launch's hook preparation install
  nothing for Hermes v0.21.6+ off Windows (older or unknown Hermes, and a home set to the TUI: the compatibility path
  below). The version is `hermes --version` of the executable the launch runs, asked once per installed file and
  cached; a home where the bind pass has read a record counts as v0.21.6+ while the version is unknown. Instead they
  remove Harness's managed block from each Hermes `config.yaml` they visit
  (the default home, its profiles, a launch's home, and the home of each Hermes agent the bind pass finds), Harness's
  entries in `shell-hooks-allowlist.json`, and the pane names Harness added to `terminal.client_env_passthrough`,
  using the removal the uninstaller already does (`removeHooks.ts`). Lines Harness did not write are left alone, as
  today. Logged once per home.
- No hook code is removed by this change: Windows reaches all of `hookServer.ts`'s Hermes code and `notify.mjs`'s
  Hermes path, and so does the compatibility path, which is marked with its removal date and #4207.
- Windows is unchanged: its hooks are written and work as today.
- Compatibility path, Hermes older than v0.21.6 (or unknown, or a home whose `config.yaml` says
  `display.interface: tui`, whose TUI writes no record) on macOS and Linux: Hermes keeps no terminal record before v0.21.6,
  which was published 2026-10-08, too recently to drop those users' following of `/new` and `/resume`. For a home whose
  Hermes is older, Harness keeps writing today's hook, byte for byte (a guarded line would break recognition and
  rollback, above). The version comes from the cheapest exact source Harness already has, cached; an unknown version
  keeps today's behavior (the hook is written) and is logged once. The record-based binding runs for every Hermes agent
  regardless: a record present proves v0.21.6+. The compatibility path is marked in code for removal on or after
  2026-12-07 (60 days after v0.21.6), tracked in #4207. A sandboxed Hermes older than v0.21.6 keeps today's
  failing hook; the device should run v0.21.6 or newer.

### 5. Seen once

Logged once per agent, with no paths, content or session text:
- `[discovery] <agent> hermes runs in a sandbox · followed from its terminal record` when its process is in another
  mount namespace;
- `[discovery] <agent> hermes keeps no terminal record · its session switches are not followed` for the fallback;
- the hold reason of §2 when a path cannot be translated.

## Design (docs/feature-design-rules.md)

1. **Growth.** No new stored record. One new optional registry field, `RegisteredSession.hermesHomeDerived?: true`,
   on a row whose `hermesHome` Harness worked out (from `HOME`, or translated from a sandbox) rather than read from
   the process's `HERMES_HOME`, so a relaunch after a daemon restart still does not export it (§1); it lives and dies
   with its row. In memory, per agent: the last
   record `stat` (mtime, size) and the "logged once" marks, dropped when the agent leaves the registry, like the
   repair's attempt counters in `bind.ts`. Also in memory: the set of homes seen keeping a record (at most 256) and
   each installed Hermes executable's version. Hermes prunes its own records after 30 days; Harness never writes or deletes
   them.
2. **Concurrency.** Binding and switching go through the existing `commit` and `mayClaim` under the bind pass's
   `current()` guard, which re-checks that the pane still holds the same process before writing. The pass reads the
   record, then the store, then re-reads the record's `stat` before committing; a record that changed in between waits
   for the next pass (core rule 7: evidence older than the state it would undo is not used). A hook and the record can
   both name a session for one agent only off Windows, for an older, unknown or TUI Hermes; both go through
   `registry.register`, so the second changes nothing.
3. **Read cost.** Per Hermes agent per pass: one `stat` of a file under 4 KB; on change, one read of at most 4 KB and
   one indexed point read of the session's row (`id = ?`) in the store the reader already polls every second. The
   mount helper reads two `mountinfo` files (a few KB) once per process, cached by process identity. One
   `hermes --version` per installed executable, cached; one `paneInfo` per Hermes process. Hermes writes a CLI
   session's row on its first turn, so a record waiting for its store row costs one `lstat` each of `<home>/state.db-wal`
   and `<home>/state.db` (mtime, size) per pass, and the store is asked again on the first pass after either changed,
   with no cap: nothing while neither changed. A store that cannot be read is asked again the same way.
4. **Scale (10x).** 10x Hermes agents is 10x one `stat` per 5 s pass. The metric that warns first is the bind pass's
   duration, already logged when slow.
5. **Compatibility.** No wire or API change. A previous release ignores `hermesHomeDerived` and exports the home on a
   relaunch, as it does today for every recorded home: right where paths match, wrong only in a remapped sandbox. New `source`/`hookEvent` value `hermes-terminal` on registered sessions;
   the plan lists every reader of `source` and `hookEvent` from a search of the code. An older daemon on the same
   machine (a rollback) reinstalls its own hooks on its next start, which it recognises as its own; this release
   removes them again on its next start. Hermes older than v0.21.6 keeps today's hook until 2026-12-07 (§4), so
   nobody loses following of `/new` and `/resume` in this release; after the compatibility path goes, the minimum
   Hermes version for following on macOS and Linux is v0.21.6 with the default CLI, stated in the engine's README.
6. **Migration and rollback.** The only migration is removing Harness's own Hermes hook entries for Hermes v0.21.6 or
   newer, through the existing
   uninstaller. Rolling back reinstalls them (the previous release's own install). No data changes.
7. **Audience.** Nothing new is exposed. The session bound is the one the agent's own Hermes names for its own pane,
   in a home the same account owns; it reaches the same readers (the owner's apps) as a hook-bound session.
8. **Identity.** The daemon reads as its own account, read-only, files the agent's Hermes writes. Nothing runs in the
   sandbox on Harness's behalf and no credential enters it. A sandbox cannot make Harness bind another agent's session:
   the record is read only from the agent's own home and only under its own pane's terminal ids, its session must be
   in that same home's store and interactive, and a session another live agent holds is not taken.
9. **Failure.** Record missing: the fallback, logged once. Record malformed, oversized, a symlink, stale or naming a
   session that is not a pane's own: ignored, logged once with the reason; the agent keeps its current session. A
   session not in the store yet: waited for, unlogged (Design 3). Store unreadable: the existing hold. Path
   untranslatable: the §2 hold, logged once; the pane works. An old hook still in a config Harness cannot write
   (read-only mount): Hermes's own warning stays until the device removes it; Harness logs once that it
   could not remove it.
10. **Platforms.** Linux: everything, including the mount translation and the sandbox log. macOS: §1, §3, §4 and §5
    without mount namespaces. macOS and Linux keep hooks for an older, unknown or TUI Hermes. Windows: §1 (its
    `LOCALAPPDATA` rule, reached by unit tests only today, as the daemon reads no process environment there); hooks
    stay as they are.

## Left to the builder

- Where the record reading lives (`engines/hermes/`, declared the way the engine contracts are) and its tests.
- How the daemon learns a pane's tty (tmux `#{pane_tty}`; a ptyhost pane's pty path) and whether that needs a new
  cached field.
- Fixtures: Hermes homes with records for `/new`, `/resume`, compression, a stale record from an earlier process, a
  symlinked or oversized record, two agents in one home; `mountinfo` texts for same-path, remapped and untranslatable
  mounts.
- The end-to-end check: a fake `hermes` (writing a store and a record as Hermes v0.23 does) in a Harness pane, run under
  `unshare --user --mount --pid --fork` with a private `/tmp` and `HOME`, on a disposable Linux box; and the same fake
  outside a sandbox on macOS.
