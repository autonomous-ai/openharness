# Hermes bound from its terminal record Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave; each task commits its failing
> test, then the code). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS and Linux a Hermes agent is bound to its session, and followed through `/new`, `/resume`, a branch
and a compression split, from the record Hermes v0.21.6+ keeps for its own terminal, in a sandbox and out of one; such
a Hermes gets no Harness hook, and the ones earlier releases wrote are removed.

**Architecture:** The existing bind pass (every 5 s, `core/agents/bind.ts`) asks a new core module,
`core/agents/hermesTerminal.ts`, what the agent's terminal record says; that module reads
`<home>/terminal-sessions/<terminal id>` through engine-neutral kit mechanics and Hermes's declared rules, and bind
commits through the existing `registry.register` paths (first bind, and the rotation the Copilot `/resume` switch
uses). The home comes from the process's own environment by Hermes's rule; on Linux a process in another mount
namespace has its home and folder translated to the daemon's view through `mountinfo`. The Hermes hook installer
decides per home: a Hermes v0.21.6+ has Harness's hooks removed with the uninstaller's own removal; an older or unknown
Hermes, and a home whose `config.yaml` says `display.interface: tui`, keep today's hook unchanged. A relaunch names a
Hermes home only when the process itself set `HERMES_HOME`.

**Tech Stack:** TypeScript (`cli/src`: daemon core, engines kit, lib), vitest, `node:sqlite` (Node 24), tmux, the pty
host, `/proc` on Linux.

**Spec:** [docs/plans/2026-11-12-sandbox-hooks-design.md](2026-11-12-sandbox-hooks-design.md). Read it with this plan,
and `AGENTS.md`, `cli/AGENTS.md`, `cli/src/core/AGENTS.md`, `docs/naming-system.md`. Hermes's own behavior was read from
its source at `7a96259b1e` (v0.23.1 line; `hermes_cli/terminal_breadcrumbs.py`, `hermes_constants.py`) and at tag
`v0.21.6`.

## Where this plan departs from the spec

One place. Spec §1 says a relaunch never exports a home worked out from `HOME`; spec Design 1 says no new registry
field. Both cannot hold: every restart, resume and fork exports the row's `hermesHome` today
(`engines/nativeLaunch.ts:176`), a stopped agent is resumed after its process and the daemon that saw it are gone, and
the path alone does not say whether the process named it. So this plan stores one bit:

- **`RegisteredSession.hermesHomeDerived?: true`** (Task 13): the row's home is not the value of the process's own
  `HERMES_HOME`. It is set with the home, carried with it, read by the relaunch alone and sent to no client. A row
  without it is exported as today, so rows an older release saved, profile homes and homes found by session id behave
  as they do now.
- Spec Design 1 needs the same line. It is the open question at the end of this plan.

## Global Constraints

- Platforms: macOS and Linux change; Windows behaves as today (`follow` answers `'none'` there, hooks are installed
  for every version). CLI and daemon only. No new dependency, switch, setting, socket, route, token, timer or watcher.
- Which Hermes keeps its hook (spec §4), off Windows: one older than v0.21.6, one whose version cannot be read (said
  once), and a home set to the TUI keep today's hook, byte for byte. Every other home has Harness's hooks removed. No
  hook code is removed by this change. The code that keeps a hook is marked `#4207, remove on or after 2026-12-07`.
- A home is set to the TUI when `<home>/config.yaml` is a mapping whose `display.interface` is a string that, trimmed
  and lower-cased, is `tui` (Hermes's own rule, `hermes_cli/main.py` `_config_default_interface_early`). A config that
  is missing, not a regular file, over 1 MiB or not such YAML is not. A per-run `hermes --tui` or `HERMES_TUI=1` is
  not looked for: in a home set to the CLI such a run is bound once by the repair, its switches are not followed, and
  the fallback line says so once.
- A relaunch (restart, resume, fork) exports `HERMES_HOME` only for a row whose home is the value of the process's own
  `HERMES_HOME`, as today; never for a home worked out from `HOME`, or one translated to another path.
- Out of scope: a device wrapper named `hermes` that stays the parent of its sandbox (no `exec`). One line in the
  README (Task 11).
- Nothing is written, created or run in the agent's home or sandbox on Harness's behalf, except removing Harness's
  own hook entries from `config.yaml` and `shell-hooks-allowlist.json`. Harness never writes or deletes a terminal
  record.
- Version floor: `0.21.6`, compared as three numbers. Version source: `hermes --version` of the executable the launch
  runs, first line `Hermes Agent v<a>.<b>.<c> (<date>)`, asked once per installed file and kept for the daemon's life.
- Record read: at most 4096 bytes, a regular file (not a symlink), JSON with a string `session_id` matching
  `HERMES_HISTORY_ID_RE` and a finite numeric `ts` (epoch seconds). It counts only if `ts * 1000 >= process start -
  5000` (the repair's `START_SLACK_MS`).
- Terminal ids, Hermes's own rule: `tty-<s(pane tty)>` first, then for a tmux pane `tmux_pane-<s(pane id)>`;
  `s(x)` strips outer whitespace, then outer `/`, maps every character outside `[A-Za-z0-9._-]` to `-`, keeps 120.
  `/dev/pts/3` is `tty-dev-pts-3`, `/dev/ttys004` is `tty-dev-ttys004`, `%5` is `tmux_pane--5`.
- Exact copy from the spec: `[discovery] <agent> hermes runs in a sandbox · followed from its terminal record` ·
  `[discovery] <agent> hermes keeps no terminal record · its session switches are not followed` ·
  the hold `Hermes runs in a sandbox whose folder Harness cannot see`.
- Copy this plan adds (the spec left it open): `[discovery] <agent> hermes terminal record ignored · <reason>` with the
  reasons `not a regular file`, `oversized`, `malformed`, `unreadable`, `older than its process`,
  `its session is not in its store`, `its session is not a pane's own` ·
  `[discovery] <agent> switched hermes session <old> → <new>` ·
  `[hooks] removed Harness's Hermes hooks → <file>` ·
  `[hooks] could not remove Harness's Hermes hooks from <file> · <why>` ·
  `[hooks] Hermes's version could not be read · its session hooks are kept`.
- New registry values: `source: 'hermes-terminal'`, `hookEvent: 'HermesTerminal'`. Readers, from a search of the code:
  no code branches on a `source` value (it is carried by `registry.ts` 826/1153/1335/1452/1573/2289,
  `core/agents/forget.ts:95`, `lib/stopAgentService.ts:149`, `lib/stoppedAgents.ts:131`, `core/main.ts:1372`);
  `hookEvent` is read at `core/agents/bind.ts:205` (`=== 'SessionStart'`) and in `hookServer.ts` for a hook's own
  body (629, 665-666, 763, 855, 862, 867, 883), and is not stored. Neither reaches the wire.
- New registry field: `hermesHomeDerived?: true`, read at `engines/nativeLaunch.ts:176` only. It reaches no client and
  no log line.
- `[discovery]` lines carry no path, record content or session text. Tests never touch the real `~/.hermes`,
  `~/.harness`, daemon (18473) or tmux server, and never run the developer's own `hermes`. No fixed sleeps.
- Idle daemon work (AGENTS.md standard 4): for a settled Hermes agent a pass makes one `lstat` per terminal name (two
  for a tmux pane) and no other read; Task 9 pins it and the pull request states it. A pane's tty is one
  `paneInfo` per Hermes process; a version is one `hermes --version` per installed file; a home's `config.yaml` is
  read for its interface once per install of that home (at most 64 profiles and the default) and once when its first
  record is seen.
- `cli/src/core/**` stays at 100% per file: every branch a task adds there is covered by that task's own spec.
- Architecture (`src/architecture.spec.ts`): `core/agents/bind.ts`, `lib/terminalAgentDiscovery.ts`,
  `engines/identities.ts`, `engines/nativeHooks.ts` and the kit reach nothing under `engines/hermes/` but
  `contract.ts`, and import nothing dynamically.
- Every command below runs from `cli/`. Every task ends with two commits: its failing tests, then its code.

## Decisions this plan makes where the spec left room

- **Where it lives.** Rules in `engines/hermes/contract.ts`; mechanics in the kit (`kit/terminalRecord.ts`,
  `kit/processHome.ts`); the eager doors in `engines/identities.ts`; the pass's judgment in
  `core/agents/hermesTerminal.ts`; commits stay in `bind.ts`.
- **A pane's tty** comes from the door every backend already has, `TerminalBackend.paneInfo(runtime).tty` (tmux
  `#{pane_tty}`, the pty host's pty name), asked once per Hermes process and kept in memory. No new stored field.
- **A fresh record never falls back.** While a record of this process names a session that cannot be bound yet, the
  repair does not run: it could only bind a session the terminal is not on.
- **A waiting record** is asked of the store on each of 24 passes, then once a minute (the repair's own rhythm).
- **A resumed row is confirmed by its record.** `registry.register` fails a resumed row that reports another
  conversation until something has confirmed it (`lastHookAt === 0`); without hooks nothing would, and a later `/new`
  would fail the agent. A record naming the row's own session registers it once.
- **Both paths untranslatable means held.** A sandboxed process whose home or folder has no path in the daemon's view
  is held (spec §2 read for both).
- **The sandbox line** is said when a sandboxed agent's first record is read, so it is never said beside the fallback
  line.
- **Per-agent memory** is dropped lazily: at 256 entries the agents the registry no longer has go, and if 256 remain
  the map is cleared (one more read and line per agent).
- **Hooks are decided per home.** One install can keep the hook of a TUI home and remove it from the CLI homes beside
  it. A TUI home keeps its hook when a record is seen there too (a `hermes --cli` run): the home is still set to the
  TUI, and the next install would write the hook back.
- **The mark covers a translated home.** A home a sandboxed process named by a path the daemon had to translate is
  marked as a home worked out from `HOME` is: the path on the row is the daemon's, not the value the process set.
- **A lost mark is learned again.** An older daemon (a rollback) drops the mark when it saves the row and exports the
  home as it always did; this release marks the row again when it next sees its process.

## Review Focus

Failure modes the spec implies that are most likely to bite, each pinned by a test in the task that owns the code:

1. **A tty number is reused.** A record an earlier Hermes left in the same tty, or one written for another pane's
   earlier process, must bind nothing; the pane's own later record must. Tasks 4 and 9.
2. **The first message is typed before the pass binds** (up to 5 s after a launch or `/new`, where a hook bound at
   once). The conversation must still show that message. Task 12 (end to end).
3. **A resumed or restarted agent.** The record names the resumed session first, then another after `/new`: the agent
   follows, and is never failed as `RESUME_SESSION_MISMATCH`. An agent whose home Harness worked out comes back with
   no `HERMES_HOME` of Harness's, after a daemon restart too, while a profile agent still gets its own. Tasks 9, 12
   and 13.
4. **A sandbox hands Harness a file that is not a plain small one** (a record that is a symlink to another agent's or
   to `/etc/passwd`, a FIFO, 10 MB of JSON, a session id of another home; a `config.yaml` that is a FIFO or 10 MB).
   Nothing is read past its limit, no record is followed, nothing binds, and the pass is not held up. Tasks 4, 7
   and 8.
5. **A Hermes that keeps no record: older, unknown, or a home set to the TUI.** Its hook line stays byte for byte,
   every existing hook spec and golden passes unedited, a TUI home beside CLI homes keeps its hook while theirs go,
   and a machine with no Hermes at all is asked nothing. Task 11.

## Files

| File | What changes | Task |
|---|---|---|
| `cli/src/engines/hermes/contract.ts` | the home rule, the terminal record, the version rule and floor, the interface setting, the hold and the lines; later `HERMES_PROFILE` goes | 1, 7 |
| `cli/src/engines/kit/processHome.ts` (new) | a process's home from its environment, Hermes's rule; whether it named one | 2 |
| `cli/src/lib/mountView.ts` (new) | `mountinfo` parsed, a path translated to the daemon's view | 3 |
| `cli/src/engines/kit/terminalRecord.ts` (new) | terminal names, the stamp, the bounded read | 4 |
| `cli/src/engines/kit/nativeVersion.ts` | a three-number release, one answer per installed file for any reading | 5 |
| `cli/src/lib/processMounts.ts` (new) | a process's mount namespace, its mounts and folder, kept per process | 6 |
| `cli/src/engines/identities.ts` | `probeHermesHome` by Hermes's rule; the record and store doors; later the sandbox | 7, 10 |
| `cli/src/engines/hermes/home.ts` | `hermesHomeFromEnv` goes (unused outside its spec) | 7 |
| `cli/src/engines/hermesRecord.ts` (new), `cli/vitest.setup.ts` | whether a Hermes keeps a record; whether a home is set to the TUI; the homes seen keeping a record | 8 |
| `cli/src/engines/kit/yamlSetting.ts` (new) | one string setting of a YAML file, read within a limit | 8 |
| `cli/src/core/agents/hermesTerminal.ts` (new), `cli/src/lib/sessionRepair.ts` | what a pass does with a record; `START_SLACK_MS` exported | 9 |
| `cli/src/lib/terminalAgentDiscovery.ts`, `cli/src/core/agents/discovery.ts` | `DiscoveredTerminalAgent.sandbox` and `.hermesHomeDerived`, the folder in the daemon's view, the mark told to the registry | 10 |
| `cli/src/engines/nativeHooks.ts`, `kit/nativeLocations.ts`, `nativeLaunch.ts` | install or remove per home, by version and interface; removal on a record seen | 11 |
| `cli/src/engines/README.md`, `docs/engines.md` | how Hermes is followed, the minimum version, the compatibility date, the TUI, the relaunch, the wrapper | 11 |
| `cli/src/core/agents/bind.ts`, `cli/src/core/main.ts` | the Hermes branch of the pass, the hold, the fallback line, wiring | 12 |
| `cli/e2e/hermesTerminalRecord.e2e.ts`, `cli/e2e/harness/fakeHermes.mjs` (new) | the real daemon, a fake Hermes, a sandbox on Linux | 12 |
| `cli/src/lib/registry.ts`, `cli/src/engines/nativeLaunch.ts` | `hermesHomeDerived` stored and carried; a relaunch does not export a marked home | 13 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 Contract · 2 Home from an environment · 3 Mount view · 4 Terminal record · 5 Release version · 13 A home Harness worked out is not exported |
| 2 | 6 Process mounts · 7 Home and record doors · 8 Which Hermes keeps a record · 9 The pass's judgment |
| 3 | 10 Sandbox on the discovery path · 11 Hooks by version and interface |
| 4 | 12 Bind, wiring, end to end · 14 Temporary workflow for the Linux sandbox check |

Task 13 was added after the first draft and keeps its number so the others keep theirs; it is written after Task 5.

---

### Task 1: Contract

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Modify: `cli/src/engines/hermes/contract.ts`
- Test: `cli/src/engines/hermes/contract.spec.ts` (create)

**Interfaces (produces):** all `as const`, with a comment naming the Hermes source each was read from.
- `HERMES_HOME_RULE = { variable: 'HERMES_HOME', folder: '.hermes', windowsFolder: 'hermes', suffix: 'HERMES_DATA_DIR_SUFFIX' }`
- `HERMES_VERSION = { output: /Hermes Agent v(\d+)\.(\d+)\.(\d+)/, args: ['--version'], timeoutMs: 5_000 }`
- `HERMES_RECORD_SINCE = [0, 21, 6]`
- `HERMES_TERMINAL_RECORD = { directory: 'terminal-sessions', maxBytes: 4096, id: HERMES_HISTORY_ID_RE, names: [{ of: 'tty', prefix: 'tty-' }, { of: 'tmuxPane', prefix: 'tmux_pane-' }], unsafe: /[^A-Za-z0-9._-]/gu, keep: 120, session: 'session_id', time: 'ts' }`
- `HERMES_INTERFACE = { file: 'config.yaml', section: 'display', key: 'interface', tui: 'tui', maxBytes: 1 << 20 }`
  (`hermes_cli/main.py` `_config_default_interface_early`: the TUI writes no terminal record)
- `HERMES_SANDBOX_HOLD = 'Hermes runs in a sandbox whose folder Harness cannot see'`
- `HERMES_TERMINAL_SAID = { sandbox: 'hermes runs in a sandbox · followed from its terminal record', fallback: 'hermes keeps no terminal record · its session switches are not followed', ignored: (reason: string) => \`hermes terminal record ignored · ${reason}\` }`
- `HERMES_HOOKS_SAID = { removed: "[hooks] removed Harness's Hermes hooks → {file}", kept: "[hooks] could not remove Harness's Hermes hooks from {file} · {reason}", unknown: "[hooks] Hermes's version could not be read · its session hooks are kept" }`

- [ ] **Step 1: Write the failing test** (`contract.spec.ts`)

```ts
it('reads the three numbers of a Hermes version, and none of an unknown one', () => {
  expect(HERMES_VERSION.output.exec('Hermes Agent v0.23.1 (2026.11.11)')?.slice(1, 4)).toEqual(['0', '23', '1'])
  expect(HERMES_VERSION.output.exec('Hermes Agent v0.21.6 (2026.9.24) · upstream 1a2b3c4')?.slice(1, 4)).toEqual(['0', '21', '6'])
  expect(HERMES_VERSION.output.exec('Hermes Agent vunknown (2026.9.24)')).toBeNull()
  expect(HERMES_VERSION.output.exec('1.0.0')).toBeNull()
  expect(HERMES_RECORD_SINCE).toEqual([0, 21, 6])
})
it('declares the record Hermes keeps per terminal', () => {
  expect(HERMES_TERMINAL_RECORD).toMatchObject({ directory: 'terminal-sessions', maxBytes: 4096, keep: 120, session: 'session_id', time: 'ts' })
  expect(HERMES_TERMINAL_RECORD.names).toEqual([{ of: 'tty', prefix: 'tty-' }, { of: 'tmuxPane', prefix: 'tmux_pane-' }])
  expect('dev/pts/3'.replace(HERMES_TERMINAL_RECORD.unsafe, '-')).toBe('dev-pts-3')
  expect(HERMES_TERMINAL_RECORD.id.test('local-' + 'a'.repeat(64))).toBe(true)
})
it('declares where a home says which interface it starts', () => {
  expect(HERMES_INTERFACE).toEqual({ file: 'config.yaml', section: 'display', key: 'interface', tui: 'tui', maxBytes: 1 << 20 })
})
it('says what the spec says', () => {
  expect(HERMES_SANDBOX_HOLD).toBe('Hermes runs in a sandbox whose folder Harness cannot see')
  expect(HERMES_TERMINAL_SAID.sandbox).toBe('hermes runs in a sandbox · followed from its terminal record')
  expect(HERMES_TERMINAL_SAID.fallback).toBe('hermes keeps no terminal record · its session switches are not followed')
  expect(HERMES_TERMINAL_SAID.ignored('malformed')).toBe('hermes terminal record ignored · malformed')
})
```

- [ ] **Step 2:** `npx vitest run src/engines/hermes/contract.spec.ts` → FAIL (no such exports).
- [ ] **Step 3:** Add the declarations. `HERMES_PROFILE` stays until Task 7.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/architecture.spec.ts` → PASS.
- [ ] **Step 5:** Commit.

### Task 2: A process's home from its environment

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/engines/kit/processHome.ts`
- Test: `cli/src/engines/kit/processHome.spec.ts` (create)

**Interfaces (produces):**
- `interface ProcessHomeRule { variable: string; folder: string; windowsFolder: string; suffix: string }`
- `homeFromEnvironment(rule: ProcessHomeRule, environment: Readonly<Record<string, string>>, platform: NodeJS.Platform): string | undefined`:
  the home a process started with `environment` uses, or `undefined` when the environment alone cannot say.
- `homeIsNamed(rule: ProcessHomeRule, environment: Readonly<Record<string, string>>): boolean`: whether the process
  set the variable itself (looked up upper-cased, trimmed, not empty), so its home is not worked out from `HOME`.

**The rule** (`hermes_constants.py` `hermes_root_for_environment`, `_platform_default_hermes_home`,
`get_process_hermes_home`; the signature does not determine it):

1. Names are looked up upper-cased. The user's folder is `USERPROFILE` on `win32`, else `HOME`, trimmed.
2. The variable, trimmed, empty: the platform default. Off Windows `<HOME>/<folder><suffix value>`; on `win32`
   `<LOCALAPPDATA>\<windowsFolder><suffix value>` when `LOCALAPPDATA` (trimmed) is set, else
   `<USERPROFILE>\AppData\Local\<windowsFolder><suffix value>`. The suffix is taken as it is. No user's folder where
   one is needed: `undefined`.
3. Set: `%NAME%`, `${NAME}` and `$NAME` (`/%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z0-9_-]+)/g`) are replaced from the
   environment, a name it does not have: `undefined`. A leading `~` alone or before `/` or `\` is the user's folder
   (none: `undefined`). The result must be absolute for `platform` (`path.posix` or `path.win32`), at most 4096
   characters, with no control character, else `undefined`. Trailing separators are dropped.

- [ ] **Step 1: Write the failing tests**

```ts
const rule = { variable: 'HERMES_HOME', folder: '.hermes', windowsFolder: 'hermes', suffix: 'HERMES_DATA_DIR_SUFFIX' }
const home = (environment: Record<string, string>, platform: NodeJS.Platform = 'linux') => homeFromEnvironment(rule, environment, platform)
it('is the platform default under the process\'s own HOME', () => {
  expect(home({ HOME: '/home/agent' })).toBe('/home/agent/.hermes')
  expect(home({ HOME: '/home/agent', HERMES_DATA_DIR_SUFFIX: '-dev' })).toBe('/home/agent/.hermes-dev')
  expect(home({ HOME: '/h', HERMES_HOME: '   ' })).toBe('/h/.hermes')
  expect(home({ HOME: '/Users/a' }, 'darwin')).toBe('/Users/a/.hermes')
})
it('is HERMES_HOME when it names an absolute folder, expanded from the same environment', () => {
  expect(home({ HOME: '/h', HERMES_HOME: '/data/p/profiles/work/' })).toBe('/data/p/profiles/work')
  expect(home({ HOME: '/h', HERMES_HOME: '~/alt' })).toBe('/h/alt')
  expect(home({ HOME: '/h', HERMES_HOME: '$HOME/x' })).toBe('/h/x')
  expect(home({ HOME: '/h', ROOT: '/r', HERMES_HOME: '${ROOT}/x' })).toBe('/r/x')
})
it('is unknown when the environment alone cannot say', () => {
  for (const environment of [{}, { HERMES_HOME: '~/x' }, { HOME: '/h', HERMES_HOME: 'relative' }, { HOME: '/h', HERMES_HOME: '$NOPE/x' },
    { HOME: '/h', HERMES_HOME: '/bad\u0000path' }, { HOME: '/h', HERMES_HOME: '/' + 'a'.repeat(4097) }]) expect(home(environment)).toBeUndefined()
})
it('follows Windows\'s rule there', () => {
  expect(home({ USERPROFILE: 'C:\\Users\\a', LOCALAPPDATA: 'D:\\Local' }, 'win32')).toBe('D:\\Local\\hermes')
  expect(home({ USERPROFILE: 'C:\\Users\\a' }, 'win32')).toBe('C:\\Users\\a\\AppData\\Local\\hermes')
  expect(home({ userprofile: 'C:\\Users\\a', Hermes_Home: '%USERPROFILE%\\h' }, 'win32')).toBe('C:\\Users\\a\\h')
  expect(home({ HOME: '/h' }, 'win32')).toBeUndefined()
})
it('tells a home the process named from one worked out from HOME', () => {
  expect(homeIsNamed(rule, { HOME: '/h', HERMES_HOME: '/data/p' })).toBe(true)
  expect(homeIsNamed(rule, { HOME: '/h', Hermes_Home: 'C:\\h' })).toBe(true)
  for (const environment of [{ HOME: '/h' }, { HOME: '/h', HERMES_HOME: '' }, { HOME: '/h', HERMES_HOME: '   ' }]) expect(homeIsNamed(rule, environment)).toBe(false)
})
```

- [ ] **Step 2:** `npx vitest run src/engines/kit/processHome.spec.ts` → FAIL (no module).
- [ ] **Step 3:** Implement `homeFromEnvironment` and `homeIsNamed`. They read nothing but their arguments.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

### Task 3: Mount view

**Depends on:** nothing. **Effort:** xhigh (it decides which host files the daemon reads for a sandbox).

**Files:**
- Create: `cli/src/lib/mountView.ts`
- Test: `cli/src/lib/mountView.spec.ts` (create)

**Interfaces (produces):**
- `interface Mount { device: string; root: string; point: string }` (`mountinfo` fields 3, 4 and 5).
- `parseMountinfo(text: string): Mount[]`: one per line that has the ` - ` separator and those fields; `\NNN` octal
  escapes (`\040` a space, `\134` a backslash) are undone in `root` and `point`; other lines are skipped.
- `hostPath(path: string, theirs: readonly Mount[], ours: readonly Mount[]): string | null`.

**`hostPath`** (the signature does not determine it):

1. `path` not absolute, or with a `..` part: `null`.
2. The holder of a path in a list: the mount whose `point` is the path or an ancestor of it, by whole path parts; the
   longest `point` wins, and among equal points the last in the list (the one mounted on top).
3. `inside` is the holder's `root` joined with the path's remainder under its `point`: the path within that
   filesystem.
4. Candidates in `ours`: same `device`, `root` equal to `inside` or an ancestor of it; longest `root` first, then
   later in the list first.
5. For a candidate, `host` is its `point` joined with `inside`'s remainder under its `root`. It is the answer only if
   the holder of `host` in `ours` is that candidate (nothing is mounted over it). No candidate passes: `null`.

- [ ] **Step 1: Write the failing tests**

```ts
const ours = parseMountinfo('25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n40 25 8:17 / /data rw - ext4 /dev/sdb1 rw\n26 25 0:22 / /tmp rw - tmpfs tmpfs rw\n')
const remapped = parseMountinfo('90 80 8:1 / / rw - ext4 /dev/sda1 rw\n91 90 8:17 /agents/a1 /home/agent rw - ext4 /dev/sdb1 rw\n'
  + '92 90 8:17 /work/p1 /work rw - ext4 /dev/sdb1 rw\n93 90 0:71 / /tmp rw - tmpfs tmpfs rw\n')
it('translates a path to itself when the sandbox mounts it where the daemon does', () => {
  expect(hostPath('/data/agents/a1/.hermes', ours, ours)).toBe('/data/agents/a1/.hermes')
})
it('rebuilds the daemon\'s path of a remapped folder', () => {
  expect(hostPath('/home/agent/.hermes', remapped, ours)).toBe('/data/agents/a1/.hermes')
  expect(hostPath('/home/agent', remapped, ours)).toBe('/data/agents/a1')
  expect(hostPath('/work/src', remapped, ours)).toBe('/data/work/p1/src')
})
it('has no answer for a filesystem the daemon does not mount, or one it has covered', () => {
  expect(hostPath('/tmp/agent/.hermes', remapped, ours)).toBeNull()   // a private tmpfs: device 0:71
  const covered = [...ours, ...parseMountinfo('41 40 0:50 / /data/agents rw - tmpfs tmpfs rw\n')]
  expect(hostPath('/home/agent/.hermes', remapped, covered)).toBeNull()
})
it('takes the mount on top, the deepest root, and escaped names', () => {
  const stacked = [...remapped, ...parseMountinfo('94 90 0:72 / /work rw - tmpfs tmpfs rw\n')]
  expect(hostPath('/work/src', stacked, ours)).toBeNull()
  const twice = [...ours, ...parseMountinfo('42 25 8:17 /agents /srv/agents rw - ext4 /dev/sdb1 rw\n')]
  expect(hostPath('/home/agent/.hermes', remapped, twice)).toBe('/srv/agents/a1/.hermes')
  expect(parseMountinfo('50 25 8:33 /my\\040disk /mnt/my\\040disk rw - ext4 /dev/sdc1 rw\n')).toEqual([{ device: '8:33', root: '/my disk', point: '/mnt/my disk' }])
  expect(parseMountinfo('garbage\n\n')).toEqual([])
})
it('refuses a path that is not absolute or climbs', () => {
  expect(hostPath('home/agent', remapped, ours)).toBeNull()
  expect(hostPath('/home/agent/../x', remapped, ours)).toBeNull()
})
```

- [ ] **Step 2:** `npx vitest run src/lib/mountView.spec.ts` → FAIL (no module).
- [ ] **Step 3:** Implement both functions, pure, with `node:path` `posix` only.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

### Task 4: Terminal record

**Depends on:** nothing. **Effort:** xhigh (it reads a file a sandbox controls).

**Files:**
- Create: `cli/src/engines/kit/terminalRecord.ts`
- Test: `cli/src/engines/kit/terminalRecord.spec.ts` (create)

**Interfaces (produces):** it names no engine; a rule is passed in.
- `interface TerminalRecordRule { directory: string; maxBytes: number; id: RegExp; names: readonly { of: 'tty' | 'tmuxPane'; prefix: string }[]; unsafe: RegExp; keep: number; session: string; time: string }`
- `interface Terminal { tty: string | null; tmuxPane: string | null }`
- `terminalRecordNames(rule, terminal: Terminal): string[]`: one name per identity the terminal has, in the rule's
  order: `prefix + s(value)`, `s` as in Global Constraints (`value.trim()`, outer `/` removed, `unsafe` → `-`, first
  `keep` characters).
- `terminalRecordStamp(rule, home: string, names: readonly string[]): Promise<string>`: one `lstat` per name;
  `<ino>:<size>:<mtimeMs>` per file, `-` for one that is absent or cannot be read, joined with `|`.
- `type TerminalRecordRead = { state: 'none' } | { state: 'ignored'; reason: 'not a regular file' | 'oversized' | 'malformed' | 'unreadable' | 'stale' } | { state: 'record'; sessionId: string; at: number }`
  (`at` in epoch ms).
- `readTerminalRecord(rule, home: string, names: readonly string[], sinceMs: number): Promise<TerminalRecordRead>`.

**The read** (per name, in order): `lstat`; absent: next name. Not a regular file (a symlink, a folder, a FIFO):
`not a regular file`. `size > maxBytes`: `oversized`. Open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (each `?? 0`
where the platform has none), `fstat` it again (regular, same `ino` and `dev`, within the size, else as above), read at
most `maxBytes + 1` bytes (more than `maxBytes` read: `oversized`), close. Any other error: `unreadable`. Parse as JSON
after dropping a leading byte-order mark; it must be an object whose `[rule.session]` is a string matching `rule.id`
and whose `[rule.time]` is a finite number, else `malformed`. `time * 1000 < sinceMs`: `stale`. The first name with a
record that passes is the answer; otherwise the first reason met; otherwise `none`.

- [ ] **Step 1: Write the failing tests** (a throwaway home under `mkdtempSync`; `rule` is a literal copy of Task 1's)

```ts
it('names a terminal as Hermes does', () => {
  expect(terminalRecordNames(rule, { tty: '/dev/pts/3', tmuxPane: '%5' })).toEqual(['tty-dev-pts-3', 'tmux_pane--5'])
  expect(terminalRecordNames(rule, { tty: '/dev/ttys004', tmuxPane: null })).toEqual(['tty-dev-ttys004'])
  expect(terminalRecordNames(rule, { tty: ' /a b/ ', tmuxPane: null })).toEqual(['tty-a-b'])
  expect(terminalRecordNames(rule, { tty: '/' + 'x'.repeat(200), tmuxPane: null })[0]).toHaveLength(4 + 120)
  expect(terminalRecordNames(rule, { tty: null, tmuxPane: null })).toEqual([])
})
it('reads the record of this process', async () => {
  write('tty-dev-pts-3', { session_id: ID, cwd: '/work', ts: 1_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'], 995_000)).toEqual({ state: 'record', sessionId: ID, at: 1_000_000 })
})
it('passes over a record an earlier process left in the same tty for the pane\'s own', async () => {
  write('tty-dev-pts-3', { session_id: OLD, ts: 900 }); write('tmux_pane--5', { session_id: ID, ts: 1_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'], 995_000)).toEqual({ state: 'record', sessionId: ID, at: 1_000_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 995_000)).toEqual({ state: 'ignored', reason: 'stale' })
})
it.each([
  ['a symlink to another record', () => { write('other', { session_id: ID, ts: 1_000 }); symlinkSync(join(dir, 'other'), join(dir, 'tty-dev-pts-3')) }, 'not a regular file'],
  ['a folder', () => mkdirSync(join(dir, 'tty-dev-pts-3')), 'not a regular file'],
  ['a FIFO', () => execFileSync('mkfifo', [join(dir, 'tty-dev-pts-3')]), 'not a regular file'],
  ['more than 4 KB', () => writeFileSync(join(dir, 'tty-dev-pts-3'), JSON.stringify({ session_id: ID, ts: 1_000, pad: 'x'.repeat(5000) })), 'oversized'],
  ['not JSON', () => writeFileSync(join(dir, 'tty-dev-pts-3'), '{'), 'malformed'],
  ['an id no Hermes session has', () => write('tty-dev-pts-3', { session_id: '../../etc/passwd', ts: 1_000 }), 'malformed'],
  ['no time', () => write('tty-dev-pts-3', { session_id: ID }), 'malformed'],
  ['an array', () => writeFileSync(join(dir, 'tty-dev-pts-3'), '[]'), 'malformed'],
])('ignores %s', async (_name, make, reason) => {
  make()
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'ignored', reason })
})
it('has nothing to say of a home with no record, and reads a byte-order mark as Hermes does', async () => {
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'none' })
  writeFileSync(join(dir, 'tty-dev-pts-3'), '\ufeff' + JSON.stringify({ session_id: ID, ts: 1 }))
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toMatchObject({ state: 'record' })
})
it('stamps what is there, and changes when Hermes replaces the file', async () => {
  expect(await terminalRecordStamp(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'])).toBe('-|-')
  write('tty-dev-pts-3', { session_id: ID, ts: 1 }); const first = await terminalRecordStamp(rule, home, ['tty-dev-pts-3'])
  rmSync(join(dir, 'tty-dev-pts-3')); write('tty-dev-pts-3', { session_id: ID, ts: 2 })
  expect(await terminalRecordStamp(rule, home, ['tty-dev-pts-3'])).not.toBe(first)
})
```

The FIFO case is skipped on `win32`.

- [ ] **Step 2:** `npx vitest run src/engines/kit/terminalRecord.spec.ts` → FAIL (no module).
- [ ] **Step 3:** Implement the three functions with `node:fs/promises`. Nothing is written, ever.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

### Task 5: Release version

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/engines/kit/nativeVersion.ts`
- Test: `cli/src/engines/kit/nativeVersion.spec.ts`

**Interfaces (produces):**
- `type Release = readonly [number, number, number]`
- `parseRelease(rule: VersionRule, output: string): Release | null`: the rule's groups 1 to 3 as numbers.
- `releaseAtLeast(release: Release, floor: Release): boolean`.
- `probedVersion<T>(read: (output: string) => T | null, probe: VersionProbe, memo: Map<string, T | null>): Promise<T | null>`:
  what `majorVersion` does today, for any reading: one answer per installed file (by `probe.identity()`), a failed
  read kept as `null`, a file replaced while it was asked not kept. `majorVersion(rule, probe, memo)` becomes
  `probedVersion(output => parseMajor(rule, output), probe, memo)` and behaves as it did.

- [ ] **Step 1: Write the failing tests**

```ts
const rule = { output: /Hermes Agent v(\d+)\.(\d+)\.(\d+)/, args: ['--version'], timeoutMs: 5_000 }
it('reads a release and compares it', () => {
  expect(parseRelease(rule, 'Hermes Agent v0.21.6 (2026.9.24)')).toEqual([0, 21, 6])
  expect(parseRelease(rule, 'Hermes Agent vunknown')).toBeNull()
  expect(releaseAtLeast([0, 21, 6], [0, 21, 6])).toBe(true)
  expect(releaseAtLeast([0, 21, 5], [0, 21, 6])).toBe(false)
  expect(releaseAtLeast([0, 20, 99], [0, 21, 6])).toBe(false)
  expect(releaseAtLeast([1, 0, 0], [0, 21, 6])).toBe(true)
})
it('asks an installed file once, and keeps that it could not be read', async () => {
  const memo = new Map<string, Release | null>(); let reads = 0
  const probe = { identity: () => 'file-a', read: async () => { reads++; return 'Hermes Agent v0.23.1 (2026.11.11)' } }
  expect(await probedVersion(output => parseRelease(rule, output), probe, memo)).toEqual([0, 23, 1])
  expect(await probedVersion(output => parseRelease(rule, output), probe, memo)).toEqual([0, 23, 1])
  expect(reads).toBe(1)
  const broken = { identity: () => 'file-b', read: async () => { reads++; throw new Error('timeout') } }
  expect(await probedVersion(output => parseRelease(rule, output), broken, memo)).toBeNull()
  expect(await probedVersion(output => parseRelease(rule, output), broken, memo)).toBeNull()
  expect(reads).toBe(2)
})
it('does not keep the answer of a file replaced while it was asked', async () => {
  const memo = new Map<string, Release | null>(); let identity = 'before'
  const probe = { identity: () => identity, read: async () => { identity = 'after'; return 'Hermes Agent v0.23.1' } }
  expect(await probedVersion(output => parseRelease(rule, output), probe, memo)).toBeNull()
  expect(memo.size).toBe(0)
})
```

- [ ] **Step 2:** `npx vitest run src/engines/kit/nativeVersion.spec.ts` → FAIL (no such exports).
- [ ] **Step 3:** Add the three; move `majorVersion`'s body into `probedVersion`.
- [ ] **Step 4:** `npx vitest run src/engines/kit/nativeVersion.spec.ts src/engines/nativeVersion.golden.spec.ts src/engines/launchControl.eager.spec.ts` → PASS.
- [ ] **Step 5:** Commit.

### Task 13: A home Harness worked out is not exported

**Depends on:** nothing (and on the open question's answer). **Effort:** xhigh (stored data; what a relaunch exports).

**Files:**
- Modify: `cli/src/lib/registry.ts`, `cli/src/engines/nativeLaunch.ts` (`NativeLaunchSource` and the `HERMES_HOME`
  line of `inspectNativeLaunch`, line 176)
- Test: `cli/src/lib/registry.hermesHome.spec.ts` (create), `cli/src/engines/nativeLaunch.spec.ts`

**Interfaces (produces):**
- `RegisteredSession.hermesHomeDerived?: true`, with a comment that says why: `hermesHome` is Harness's own path of
  the home (worked out from the process's `HOME`, or translated from a sandbox's view), not the value of the
  process's `HERMES_HOME`; a relaunch exports no `HERMES_HOME` for it, since the relaunched process works out the
  same home, in its own view.
- `registry.setHermesHome(agentId: string, hermesHome: string, derived = false): boolean`. The home is fill-only as
  today. With `derived`, a row with no home takes the home and the mark; a row that already has this same home and no
  mark takes the mark (one an older daemon saved over); a row with another home is left as it is. `false` when
  nothing changed, and nothing is saved then.
- `registry.register(input)`: `input.hermesHomeDerived?: true`. The rebuilt row has the mark when it keeps the home
  the row had with it, or when the input brings the home with the mark; a home that replaces another comes without.
- Loading (`load`, `strictPersistedRow`): the mark is kept only as `true` beside a `hermesHome`; anything else is
  dropped. A row an older release saved has none.
- `NativeLaunchSource.hermesHomeDerived?: true`. `inspectNativeLaunch` sets `selected.HERMES_HOME` from
  `source.hermesHome` only when the mark is absent; what the launch's own shell says stays as it is.
- The mark reaches no client frame and no log line.

- [ ] **Step 1: Write the failing tests**

`registry.hermesHome.spec.ts` (a registry of its own in a throwaway folder, set up as `registry.observation.spec.ts`
sets its up, with `engine: 'hermes'`; `readRows()` reads the saved file; `reload()` imports the module afresh and
loads the same file):

```ts
const HOME = '/data/agents/a1/.hermes'
it('keeps the mark with the home through a save, a load and a rebind', async () => {
  expect(registry.setHermesHome(id, HOME, true)).toBe(true)
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect(readRows()[0]).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect((await reload()).byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100000_aaaaaa' })                       // a bind rebuilds the row
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100001_bbbbbb', hermesHome: HOME })       // the repair names the same home
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
})
it('leaves a home the process named unmarked, as a row an older release saved is', async () => {
  registry.setHermesHome(id, '/h/.hermes/profiles/work')
  expect(registry.byAgent(id)).not.toHaveProperty('hermesHomeDerived')
  expect(readRows()[0]).not.toHaveProperty('hermesHomeDerived')
  expect((await reload()).byAgent(id)).not.toHaveProperty('hermesHomeDerived')
})
it('takes the mark with a home a bind brings, and drops it when another home replaces that one', () => {
  registry.register({ ...bind, sessionId: '20261112_100000_aaaaaa', hermesHome: HOME, hermesHomeDerived: true })
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100001_bbbbbb', hermesHome: '/h/.hermes/profiles/work' })
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: '/h/.hermes/profiles/work' })
  expect(registry.byAgent(id)).not.toHaveProperty('hermesHomeDerived')
})
it('marks again a row an older daemon saved over, and never moves a row to another home', () => {
  registry.setHermesHome(id, HOME)                                              // the home, no mark
  expect(registry.setHermesHome(id, HOME, true)).toBe(true)
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect(registry.setHermesHome(id, HOME, true)).toBe(false)                    // nothing to change, nothing saved
  expect(registry.setHermesHome(id, '/elsewhere/.hermes', true)).toBe(false)
  expect(registry.byAgent(id)!.hermesHome).toBe(HOME)
})
it('drops a mark that has no home, or is not true', async () => {
  /* the saved row edited to { hermesHome: null, hermesHomeDerived: true }, then to { hermesHome: HOME, hermesHomeDerived: 'yes' }:
     after reload() the row has no hermesHomeDerived either time; strictPersistedRow of each answers a row without it */ })
```

`nativeLaunch.spec.ts` (its fixture's launch shell says `HERMES_HOME: '/fixture/hermes'`):

```ts
it('exports a Hermes home the process named, and never one Harness worked out', async () => {
  const named = await inspectNativeLaunch('hermes', { hermesHome: '/data/profiles/work' })
  expect(named.ok && named.launch.environment.HERMES_HOME).toBe('/data/profiles/work')
  const derived = await inspectNativeLaunch('hermes', { hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
  expect(derived.ok && derived.launch.environment.HERMES_HOME).toBe('/fixture/hermes')   // the launch shell's own, untouched
})
```

- [ ] **Step 2:** `npx vitest run src/lib/registry.hermesHome.spec.ts src/engines/nativeLaunch.spec.ts` → FAIL (the mark
  is not kept; the marked home is exported).
- [ ] **Step 3:** Implement. Every place `registry.ts` writes or carries `hermesHome` decides the mark with it.
- [ ] **Step 4:** Those, plus `npx vitest run src/lib/registry.spec.ts src/lib/registry.observation.spec.ts src/lib/registry.binding.spec.ts src/lib/registry.fingerprint.spec.ts src/lib/registry.saveMerge.spec.ts src/lib/stoppedAgents.spec.ts`
  → PASS, none of them edited.
- [ ] **Step 5:** Commit.

---

### Task 6: Process mounts

**Depends on:** Task 3. **Effort:** xhigh.

**Files:**
- Create: `cli/src/lib/processMounts.ts`
- Test: `cli/src/lib/processMounts.spec.ts` (create)

**Interfaces:**
- Consumes: `parseMountinfo`, `hostPath` (Task 3); `processEnvCacheKey` (`lib/processEnv.ts`).
- Produces:
  - `type ProcessView = { state: 'same' } | { state: 'unreadable' } | { state: 'sandbox'; cwd: string | null; toHost(path: string): string | null }`
  - `processView(identity: ProcessIdentity, platform: NodeJS.Platform = process.platform, proc = '/proc'): Promise<ProcessView>`
  - `clearProcessViews(): void` (a test's).

**What it reads:** not `linux`: `same`, nothing read. `readlink(<proc>/<pid>/ns/mnt)` and `readlink(<proc>/self/ns/mnt)`:
either fails: `unreadable`; equal: `same`. Different: `<proc>/<pid>/mountinfo` and `<proc>/self/mountinfo`, each at
most 1 MiB, and `readlink(<proc>/<pid>/cwd)`; `toHost` is `hostPath` over the two, and answers `null` for every path
when either file could not be read whole. `same` and `sandbox` are kept per process (`processEnvCacheKey`), 256
entries, cleared whole at the limit; `unreadable` is never kept.

- [ ] **Step 1: Write the failing tests** (a fixture tree under `mkdtempSync`: `self/ns/mnt` and `<pid>/ns/mnt` are
  symlinks to `mnt:[4026531841]` and `mnt:[4026532999]`, `mountinfo` files hold Task 3's `ours` and `remapped` texts,
  `<pid>/cwd` is a symlink to `/work/src`; `beforeEach(clearProcessViews)`)

```ts
const identity = { pid: 4242, startMarker: '2026-11-12T10:00:00Z', executable: 'python3' }
it('reads nothing off Linux', async () => { expect(await processView(identity, 'darwin', '/nonexistent')).toEqual({ state: 'same' }) })
it('is the daemon\'s own view in the daemon\'s namespace', async () => { link(4242, 'mnt:[4026531841]'); expect(await processView(identity, 'linux', proc)).toEqual({ state: 'same' }) })
it('translates a sandboxed process\'s paths, and names its folder as it names it', async () => {
  const view = await processView(identity, 'linux', proc)
  expect(view).toMatchObject({ state: 'sandbox', cwd: '/work/src' })
  if (view.state !== 'sandbox') throw new Error('unreachable')
  expect(view.toHost('/home/agent/.hermes')).toBe('/data/agents/a1/.hermes')
  expect(view.toHost('/tmp/x')).toBeNull()
})
it('cannot translate when a mountinfo is unreadable or oversized, and cannot tell when the namespace is', async () => {
  rmSync(join(proc, '4242', 'mountinfo'))
  expect((await processView(identity, 'linux', proc) as { toHost(p: string): string | null }).toHost('/home/agent')).toBeNull()
  clearProcessViews(); rmSync(join(proc, '4242', 'ns', 'mnt'))   // the view above was kept
  expect(await processView(identity, 'linux', proc)).toEqual({ state: 'unreadable' })
})
it('reads a process once, and another process again', async () => { /* readlink/readFile spies: 2nd call for the same identity reads nothing; a new startMarker reads again; an unreadable answer is asked again */ })
```

- [ ] **Step 2:** `npx vitest run src/lib/processMounts.spec.ts` → FAIL (no module).
- [ ] **Step 3:** Implement with `node:fs/promises`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

### Task 7: The home and record doors

**Depends on:** Tasks 1, 2, 4. **Effort:** high.

**Files:**
- Modify: `cli/src/engines/identities.ts`, `cli/src/engines/hermes/contract.ts` (`HERMES_PROFILE` goes),
  `cli/src/engines/hermes/home.ts` (`hermesHomeFromEnv` and its imports go)
- Test: `cli/src/engines/identities.hermes.spec.ts` (create), `cli/src/engines/hermes/home.spec.ts` (the
  `hermesHomeFromEnv` cases go), `cli/src/lib/terminalAgentDiscovery.hermesHome.spec.ts`

**Interfaces:**
- Consumes: Task 1's declarations, `homeFromEnvironment` (Task 2), Task 4's three functions,
  `readStoreSessionSource`, `isInteractiveSource` (`kit/storeSource.ts`), `IdentityReadUnavailable`.
- Produces, all in `engines/identities.ts`:
  - `probeHermesHome(identity, engine)`: unchanged signature and three answers. Now
    `homeFromEnvironment(HERMES_HOME_RULE, env, process.platform)`: `undefined` stays `undefined`; the daemon's default
    (`env.HERMES_HOME`, compared through real paths as `profileFromEnv` compares) is `null`; else the path.
  - `hermesTerminalNames(terminal: Terminal): string[]`, `hermesTerminalStamp(home, names): Promise<string>`,
    `readHermesTerminal(home, names, sinceMs): Promise<TerminalRecordRead>`: Task 4's, with `HERMES_TERMINAL_RECORD`.
  - `hermesSessionKind(home: string, sessionId: string): Promise<'own' | 'waiting' | 'other'>`:
    `readStoreSessionSource({ ...HERMES_SOURCE, id: HERMES_HISTORY_ID_RE }, hermesDbPath(home), sessionId)` (so every id
    a record may name is read from the store, an editor's uuid too): `null` is `waiting`; a source is `own` when
    `isInteractiveSource(HERMES_SOURCE, source)`, else `other`; unavailable throws
    `new IdentityReadUnavailable('the Hermes session source is unavailable')`.

- [ ] **Step 1: Write the failing tests** (`identities.hermes.spec.ts`: `readProcessEnv` mocked; a throwaway home with
  a real `state.db` made with `node:sqlite`, columns `id, source, created_source, cwd, started_at`)

```ts
it('finds the home of a Hermes that only has a HOME of its own', async () => {
  readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' })
  expect(await probeHermesHome(identity, 'hermes')).toBe('/sandbox/agent/.hermes')
})
it('answers null for the daemon\'s own home, undefined for what it cannot tell, and null for another engine', async () => {
  readProcessEnv.mockResolvedValue({ HOME: dirname(env.HERMES_HOME) }); expect(await probeHermesHome(identity, 'hermes')).toBeNull()
  readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: 'relative' }); expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
  readProcessEnv.mockResolvedValue(null); expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
  expect(await probeHermesHome(identity, 'claude')).toBeNull()
})
it.each([
  ['a CLI session', '20261112_100000_aaaaaa', 'cli', null, 'own'],
  ['a sub-agent', '20261112_100001_bbbbbb', 'subagent', null, 'other'],
  ['a 0.23 CLI session', 'local-' + 'a'.repeat(64), 'local', 'cli', 'own'],
  ['a 0.23 session not stamped yet', 'local-' + 'b'.repeat(64), 'local', 'unknown', 'waiting'],
  ['a 0.23 editor session', 'local-' + 'c'.repeat(64), 'local', 'acp', 'other'],
  ['an editor\'s uuid session', '11111111-2222-4333-8444-555555555555', 'acp', null, 'other'],
])('reads %s from the home\'s own store', async (_name, id, source, created, kind) => {
  insert(id, source, created); expect(await hermesSessionKind(home, id)).toBe(kind)
})
it('waits for a session or a store that is not there yet, and refuses to judge a store it cannot read', async () => {
  expect(await hermesSessionKind(home, '20261112_100009_cccccc')).toBe('waiting')
  expect(await hermesSessionKind(join(home, 'no-such-home'), '20261112_100009_cccccc')).toBe('waiting')
  writeFileSync(join(broken, 'state.db'), 'not a database')
  await expect(hermesSessionKind(broken, '20261112_100009_cccccc')).rejects.toBeInstanceOf(IdentityReadUnavailable)
})
it('names and reads a record by Hermes\'s declared rule', async () => {
  expect(hermesTerminalNames({ tty: '/dev/pts/3', tmuxPane: '%5' })).toEqual(['tty-dev-pts-3', 'tmux_pane--5'])
  /* a record written under <home>/terminal-sessions/tty-dev-pts-3 is read by readHermesTerminal and changes hermesTerminalStamp */
})
```

`terminalAgentDiscovery.hermesHome.spec.ts` gains: `readProcessEnv` answering `{ HOME: '/sandbox/agent' }` gives the
agent `hermesHome: '/sandbox/agent/.hermes'`; its existing cases stay as they are.

- [ ] **Step 2:** `npx vitest run src/engines/identities.hermes.spec.ts src/lib/terminalAgentDiscovery.hermesHome.spec.ts` → FAIL.
- [ ] **Step 3:** Implement. Remove `HERMES_PROFILE`, `hermesHomeFromEnv` and the spec cases of the latter.
- [ ] **Step 4:** Those two, plus `npx vitest run src/engines/hermes/home.spec.ts src/engines/hermesIdentity.golden.spec.ts src/architecture.spec.ts` → PASS.
- [ ] **Step 5:** Commit.

### Task 8: Which Hermes keeps a record

**Depends on:** Tasks 1, 5. **Effort:** xhigh (it reads a `config.yaml` a sandbox controls).

**Files:**
- Create: `cli/src/engines/hermesRecord.ts`, `cli/src/engines/kit/yamlSetting.ts`
- Modify: `cli/vitest.setup.ts`
- Test: `cli/src/engines/hermesRecord.spec.ts` (create), `cli/src/engines/kit/yamlSetting.spec.ts` (create)

**Interfaces:**
- Consumes: `HERMES_VERSION`, `HERMES_RECORD_SINCE`, `HERMES_HOOKS_SAID`, `HERMES_INTERFACE` (Task 1); `parseRelease`,
  `releaseAtLeast`, `probedVersion`, `nativeVersionProbe` (Task 5, kit); `captureLaunchExecutable`
  (`kit/launchExecutable.ts`); `nativeProcessEnvironment` (`kit/nativeLocations.ts`); `parseDocument` (`yaml`, as
  `kit/nativeHookYaml.ts` uses it).
- Produces:
  - `readYamlSetting(file: string, section: string, key: string, maxBytes: number): Promise<string | null>`
    (`kit/yamlSetting.ts`; it names no engine): the string at `<section>.<key>` of a YAML mapping, as written. `null`
    for everything else, and it never throws. The file is opened `O_RDONLY | O_NONBLOCK` (`?? 0` where the platform
    has none) and followed through a symlink, as the engine reads its own config; after `fstat` it must be a regular
    file of at most `maxBytes`, and at most `maxBytes + 1` bytes are read (more read: `null`). The text is parsed with
    `parseDocument(text, { uniqueKeys: false, prettyErrors: false })`; a parse error, a root or a section that is not a
    mapping, or a value that is not a string: `null`.
  - `hermesHomeIsTui(home: string): Promise<boolean>` (`hermesRecord.ts`): `readYamlSetting(join(home,
    HERMES_INTERFACE.file), HERMES_INTERFACE.section, HERMES_INTERFACE.key, HERMES_INTERFACE.maxBytes)`, trimmed and
    lower-cased, is `HERMES_INTERFACE.tui`. Nothing is kept: a person may change the setting between two installs.
  - `interface HermesVersionDeps { capture: typeof captureLaunchExecutable; probe: typeof nativeVersionProbe }`
  - `hermesKeepsRecord(executable?: { command: string }, environment?: Readonly<Record<string, string>>, deps?: HermesVersionDeps): Promise<boolean | null>`:
    `true` for v0.21.6+, `false` for older, `null` when the version cannot be told. With no `executable`, the one a
    launch would run: `deps.capture('hermes')`, its `executable` and `environment` when `state === 'ready'`, else
    `null`. The probe runs `HERMES_VERSION.args` under `nativeProcessEnvironment(environment)` (the daemon's own when
    none), once per installed file (`probedVersion`, a module-level memo). `null` says `HERMES_HOOKS_SAID.unknown`
    with `console.log`, once per installed file (once in all when there is no file).
  - `rememberRecordHome(home: string): boolean`: true the first time this daemon's life (a set of at most 256 homes,
    cleared whole at the limit). `isRecordHome(home: string): boolean`. `forgetHermesRecord(): void` (a test's).

**`vitest.setup.ts`**, beside the `agentTmp` mock and for its reason: the computer running the suite may have a Hermes
of its own, and no spec may run it. `vi.mock('./src/engines/hermesRecord.js', …)` keeps the real module and wraps
`hermesKeepsRecord` so that a call with no `deps` answers `false` (an older Hermes: every hook spec and golden stays
as it was), and a call with `deps` runs the real one.

- [ ] **Step 1: Write the failing tests** (`beforeEach(forgetHermesRecord)`; `log` spies `console.log`)

```ts
const probeOf = (identity: string | null, said: string | Error) => vi.fn(() => ({ command: () => '/bin/hermes', identity: () => identity,
  read: vi.fn(async () => { if (said instanceof Error) throw said; return said }) }))
const ready = vi.fn(async () => ({ state: 'ready', executable: { command: '/bin/hermes', identity: 'f', current: () => true }, environment: { HOME: '/h', PATH: '/bin' } }))
it.each([['Hermes Agent v0.21.5 (2026.10.7)', false], ['Hermes Agent v0.21.6 (2026.9.24)', true], ['Hermes Agent v0.23.1 (2026.11.11)', true], ['Hermes Agent v1.0.0', true]])(
  'answers for %s', async (said, keeps) => {
    expect(await hermesKeepsRecord({ command: '/bin/hermes' }, { HOME: '/h' }, { capture: ready, probe: probeOf(said, said) })).toBe(keeps)
    expect(ready).not.toHaveBeenCalled()
  })
it('asks the Hermes a launch would run when none is given', async () => {
  const probe = probeOf('f', 'Hermes Agent v0.23.1 (2026.11.11)')
  expect(await hermesKeepsRecord(undefined, undefined, { capture: ready, probe })).toBe(true)
  expect(probe).toHaveBeenCalledWith(HERMES_VERSION, expect.any(Function), expect.objectContaining({ HOME: '/h', PATH: '/bin' }))
})
it('does not know a Hermes it cannot find, cannot run or cannot read, and says so once', async () => {
  const held = vi.fn(async () => ({ state: 'held', detail: 'x' }))
  expect(await hermesKeepsRecord(undefined, undefined, { capture: held, probe: probeOf(null, '') })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('g', new Error('timeout')) })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('h', 'Hermes Agent vunknown') })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('h', 'Hermes Agent vunknown') })).toBeNull()
  expect(log.mock.calls.filter(([line]) => line === HERMES_HOOKS_SAID.unknown)).toHaveLength(3)   // no file, file g, file h: once each
})
it('asks an installed file once', async () => { /* two calls, same identity: read called once */ })
it('remembers a home seen keeping a record', () => {
  expect(isRecordHome('/h/.hermes')).toBe(false); expect(rememberRecordHome('/h/.hermes')).toBe(true)
  expect(rememberRecordHome('/h/.hermes')).toBe(false); expect(isRecordHome('/h/.hermes')).toBe(true)
})
it('answers "older" in this suite when a spec passes no deps, and runs nothing', async () => {
  expect(await hermesKeepsRecord()).toBe(false)
})
it.each([['display:\n  interface: tui\n', true], ['display:\n  interface: " TUI "\n', true], ['display: {interface: Tui}\n', true],
  ['display:\n  interface: cli\n', false], ['model: x\n', false], ['display: tui\n', false], ['display:\n  interface: [tui]\n', false]])(
  'reads whether a home is set to the TUI from %j', async (text, tui) => {
    writeFileSync(join(home, 'config.yaml'), text); expect(await hermesHomeIsTui(home)).toBe(tui)
  })
it('takes a home with no config, or one it cannot read, for the CLI', async () => {
  expect(await hermesHomeIsTui(join(home, 'no-such-home'))).toBe(false)
  mkdirSync(join(home, 'config.yaml')); expect(await hermesHomeIsTui(home)).toBe(false)
})
```

`kit/yamlSetting.spec.ts` (a throwaway folder; `read = (text) => { writeFileSync(file, text); return readYamlSetting(file, 'display', 'interface', 1 << 20) }`):

```ts
it('reads one string setting as it is written', async () => {
  expect(await read('model: x\ndisplay:\n  interface: " TUI "\n  skin: dark\n')).toBe(' TUI ')
  expect(await read('display: {interface: cli}\n')).toBe('cli')
})
it.each(['', 'model: x\n', 'display: tui\n', 'display:\n  interface: [tui]\n', 'display:\n  interface: 1\n', 'display:\n  interface: tui\n  bad: [\n', '- display\n'])(
  'reads nothing from %j', async (text) => { expect(await read(text)).toBeNull() })
it('reads nothing from a file that is missing, a folder, a FIFO or over its limit, and is not held up by one', async () => {
  expect(await readYamlSetting(join(dir, 'none.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
  mkdirSync(join(dir, 'folder.yaml')); expect(await readYamlSetting(join(dir, 'folder.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
  execFileSync('mkfifo', [join(dir, 'fifo.yaml')]); expect(await readYamlSetting(join(dir, 'fifo.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
  writeFileSync(file, 'display:\n  interface: tui\n' + '#'.repeat(64)); expect(await readYamlSetting(file, 'display', 'interface', 64)).toBeNull()
})
it('follows a symlink to a config, as the engine does', async () => {
  writeFileSync(join(dir, 'real.yaml'), 'display:\n  interface: tui\n'); symlinkSync(join(dir, 'real.yaml'), join(dir, 'link.yaml'))
  expect(await readYamlSetting(join(dir, 'link.yaml'), 'display', 'interface', 1 << 20)).toBe('tui')
})
```

The FIFO case is skipped on `win32`.

- [ ] **Step 2:** `npx vitest run src/engines/hermesRecord.spec.ts src/engines/kit/yamlSetting.spec.ts` → FAIL (no modules).
- [ ] **Step 3:** Implement the two modules and the setup mock. Nothing is written, ever.
- [ ] **Step 4:** Same command, plus `npx vitest run src/architecture.spec.ts src/config/envIsolation.spec.ts src/leanEntry.spec.ts` → PASS.
- [ ] **Step 5:** Commit.

### Task 9: The pass's judgment

**Depends on:** Tasks 1, 4. **Effort:** xhigh (evidence ordering under the bind pass).

**Files:**
- Create: `cli/src/core/agents/hermesTerminal.ts`
- Modify: `cli/src/lib/sessionRepair.ts` (`export const START_SLACK_MS`)
- Test: `cli/src/core/agents/hermesTerminal.spec.ts` (create)

**Interfaces:**
- Consumes: `HERMES_TERMINAL_SAID` (Task 1); `Terminal`, `TerminalRecordRead` (Task 4, types); `START_SLACK_MS`;
  `terminalRouteKey` (`lib/terminalRuntime.ts`); `sid` (`lib/log.ts`).
- Produces:

```ts
export interface HermesTerminalDeps {
  platform: NodeJS.Platform
  defaultHome: string
  registry: Pick<typeof registry, 'byAgent'>
  paneInfo: (runtime: TerminalRuntimeRef) => Promise<TerminalPaneInfo | null>
  names: (terminal: Terminal) => string[]
  stamp: (home: string, names: readonly string[]) => Promise<string>
  read: (home: string, names: readonly string[], sinceMs: number) => Promise<TerminalRecordRead>
  /** Throws when the store cannot be read. */
  kind: (home: string, sessionId: string) => Promise<'own' | 'waiting' | 'other'>
  /** Told each time an agent's process is first seen keeping a record in a home. */
  recordSeen: (home: string) => void
  now: () => number
}
export type HermesObserved = Pick<DiscoveredTerminalAgent, 'processIdentity' | 'runtimes' | 'primaryRuntimeKey' | 'hermesHome'> & { sandboxed: boolean }
export interface HermesPass { current: () => boolean; mayClaim: (sessionId: string) => boolean; hold: (error: unknown) => void }
export type HermesFollow = 'none' | 'wait' | { sessionId: string; hermesHome?: string }
export function createHermesTerminal(deps: HermesTerminalDeps): {
  follow(agent: RegisteredSession, observed: HermesObserved, pass: HermesPass): Promise<HermesFollow>
  fellBack(agentId: string): void
}
```

`'none'`: this process has no record, the caller goes on as before. `'wait'`: a record is there and nothing is to be
done this pass. A session: bind or switch to it now, with no `await` before the commit.

**`follow`** (the signature does not determine it). State is one entry per agent: the process it is for
(`pid:startMarker`), the terminal, the last stamp with its reading, whether it is settled and with which answer, the
count of store asks and the time of the last, and what was said. A new process starts the entry again and keeps what
was said. At 256 entries, those whose agent `registry.byAgent` no longer has are dropped; if 256 remain, all are.

1. `platform === 'win32'`: `'none'`, nothing asked.
2. The terminal, once per process: `tty` is `paneInfo(runtime).tty` of the observed primary runtime
   (`runtimes.find(r => terminalRouteKey(r) === primaryRuntimeKey) ?? runtimes[0]`), `null` when empty or unanswered
   (then asked again next pass); `tmuxPane` is that runtime's `paneId` when its `backend` is `'tmux'`. No names:
   `'none'`.
3. `home = agent.hermesHome ?? observed.hermesHome ?? defaultHome`. `stamp(home, names)`. Unchanged and settled: the
   settled answer, and nothing else is read.
4. Changed: `read(home, names, startedAtMs - START_SLACK_MS)` with `startedAtMs = Date.parse(startMarker)` (not
   finite: `'none'`). `none`: settled `'none'`. `ignored`: said once (`stale` reads `older than its process`), settled
   `'none'`.
5. A record: `recordSeen(home)` once per entry, and for a sandboxed agent `HERMES_TERMINAL_SAID.sandbox` once. Then:
   - it names the agent's own session: `{ sessionId }` while the row is `resumeOnly` with `lastHookAt === 0`, else
     settled `'wait'`;
   - `!pass.mayClaim(sessionId)`: `'wait'`;
   - past 24 asks for this stamp and less than 60 000 ms since the last: `'wait'`;
   - `kind(home, sessionId)` throws: `pass.hold(error)` for an agent with no session, nothing for one with a session;
     `'wait'`;
   - `!pass.current()`: `'wait'`. `waiting`: said once (`its session is not in its store`), `'wait'`. `other`: said
     once (`its session is not a pane's own`), settled `'wait'`;
   - `own`: `stamp` again; changed: `'wait'`. `!pass.current() || !pass.mayClaim(sessionId)`: `'wait'`. Else
     `{ sessionId }`, with `hermesHome: home` when the row has none and `home !== defaultHome`.

Lines are `console.log(\`[discovery] ${sid(agent.agentId)} ${text}\`)`. `fellBack` says `HERMES_TERMINAL_SAID.fallback`
once per agent, and nothing on `win32` (hooks follow a switch there).

- [ ] **Step 1: Write the failing tests** (deps are `vi.fn`s; `S = '20261112_100000_aaaaaa'`; the observed process
  started at `2026-11-12T10:00:00Z` on runtime `{ backend: 'tmux', paneId: '%5' }`, `paneInfo` answering
  `{ tty: '/dev/pts/3', … }`)

```ts
it('is not asked on Windows', async () => { /* platform 'win32' → 'none'; paneInfo, stamp not called */ })
it('names the pane by its tty and, for tmux, its pane id, once per process', async () => {
  /* names called with { tty: '/dev/pts/3', tmuxPane: '%5' }; a ptyhost runtime → tmuxPane null; paneInfo null → 'none', asked again next pass;
     two passes of one process → paneInfo called once */ })
it('binds an unbound agent to the session its record names', async () => {
  expect(await t.follow(agent({ sessionId: '' }), observed(), pass)).toEqual({ sessionId: S })
  expect(deps.read).toHaveBeenCalledWith('/home/u/.hermes', ['tty-dev-pts-3', 'tmux_pane--5'], Date.parse('2026-11-12T10:00:00Z') - 5_000)
  expect(deps.recordSeen).toHaveBeenCalledExactlyOnceWith('/home/u/.hermes')
})
it('carries a home that is not the default and not yet on the row', async () => { /* observed.hermesHome '/sandbox/agent/.hermes' → { sessionId: S, hermesHome: '/sandbox/agent/.hermes' }; a row that has it → no hermesHome */ })
it('switches a bound agent', async () => { expect(await t.follow(agent({ sessionId: OLD, lastHookAt: 1 }), observed(), pass)).toEqual({ sessionId: S }) })
it('makes its lstats and nothing else once settled', async () => { /* second pass, same stamp, agent now on S: 'wait'; read and kind each called once in all */ })
it('confirms a resumed row once', async () => { /* agent { sessionId: S, resumeOnly: true, lastHookAt: 0 } → { sessionId: S }, kind not called; lastHookAt 5 → 'wait' */ })
it('never falls back while a record of this process waits for its row', async () => { /* kind 'waiting' → 'wait', said once: 'hermes terminal record ignored · its session is not in its store' */ })
it('asks the store on 24 passes, then once a minute', async () => { /* 24 follows → kind 24 times; 25th at +5 s → not called; at +60 001 ms → called */ })
it('says once why a record is ignored, and lets the fallback run', async () => { /* read → ignored 'stale': 'none' twice, one line '… ignored · older than its process' */ })
it('binds nothing a sub-agent or an editor made', async () => { /* kind 'other' → 'wait', settled, one line '… its session is not a pane\'s own' */ })
it('holds an unbound agent whose store cannot be read, and leaves a bound one as it is', async () => { /* kind rejects: pass.hold called for sessionId '', not for a bound agent; both 'wait' */ })
it('waits when the record changed while the store was read', async () => { /* stamp 'a' then 'b' → 'wait'; the next pass reads again */ })
it('waits when a later agent holds the session, without asking the store', async () => { /* mayClaim false → 'wait', kind not called */ })
it('waits when the pane changed hands while the store was read', async () => { /* current false after kind → 'wait' */ })
it('says once that a sandboxed agent is followed from its record', async () => { /* sandboxed: true → one line HERMES_TERMINAL_SAID.sandbox over two passes; false → none */ })
it('starts again for a new process and keeps what it said', async () => { /* new startMarker: paneInfo and read asked again; an ignored reason said before is not said again */ })
it('keeps at most 256 agents, dropping those the registry no longer has', async () => { /* 256 agents gone from byAgent, then one more: the first is read afresh */ })
it('says the fallback once, and never on Windows', () => {
  t.fellBack('a1'); t.fellBack('a1'); expect(lines('keeps no terminal record')).toHaveLength(1)
  windows.fellBack('a1'); expect(lines('keeps no terminal record')).toHaveLength(1)
})
```

- [ ] **Step 2:** `npx vitest run src/core/agents/hermesTerminal.spec.ts` → FAIL (no module).
- [ ] **Step 3:** Implement. No timer, no watcher, no file access of its own.
- [ ] **Step 4:** `npx vitest run src/core/agents/hermesTerminal.spec.ts --coverage --coverage.include=src/core/agents/hermesTerminal.ts`
  → PASS, 100% in every column; `npx vitest run src/architecture.spec.ts` → PASS.
- [ ] **Step 5:** Commit.

---

### Task 10: The sandbox on the discovery path

**Depends on:** Tasks 2, 6, 7, 13. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/engines/identities.ts`, `cli/src/lib/terminalAgentDiscovery.ts`,
  `cli/src/core/agents/discovery.ts` (the Hermes home line of `onObserved`, line 220)
- Test: `cli/src/engines/identities.hermes.spec.ts`, `cli/src/lib/terminalAgentDiscovery.hermesHome.spec.ts`,
  `cli/src/core/agents/discovery.spec.ts`

**Interfaces:**
- Consumes: `processView` (Task 6), `probeHermesHome` (Task 7), `homeIsNamed` (Task 2),
  `registry.setHermesHome(agentId, hermesHome, derived)` (Task 13).
- Produces:
  - `probeHermesHomeDerived(identity: ProcessIdentity, engine: AgentEngine): Promise<boolean>`
    (`engines/identities.ts`): whether the home `probeHermesHome` answers is Harness's own working out, not the value
    of the process's `HERMES_HOME`. `true` when the process's environment is read and
    `!homeIsNamed(HERMES_HOME_RULE, env)`, or when its view is a `sandbox` whose `toHost` of the home it names is
    another path. `false` for another engine, an unreadable environment, and a home the process named by the path
    Harness reads it at.
  - `DiscoveredTerminalAgent.hermesHomeDerived?: true`: set in `probeTerminalAgents`, after `agent.hermesHome`, when
    that is a path and `probeHermesHomeDerived` says so.
  - `core/agents/discovery.ts` `onObserved`: the registry is told the home when the row has none, as today, and told
    the mark when the row has this same home without it:
    `observed.hermesHome && (!current.hermesHome || (observed.hermesHomeDerived && !current.hermesHomeDerived && current.hermesHome === observed.hermesHome))`,
    calling `registry.setHermesHome(current.agentId, observed.hermesHome, true)` for a marked home and
    `registry.setHermesHome(current.agentId, observed.hermesHome)` otherwise.
  - `probeHermesHome`: for a `sandbox` view the home is `view.toHost(home)` before it is compared with the default; no
    translation: `undefined`. `same` and `unreadable` views: as Task 7 left it.
  - `probeHermesSandbox(identity: ProcessIdentity, engine: AgentEngine): Promise<{ cwd: string; hostCwd: string } | 'unseen' | undefined>`:
    `undefined` for another engine and for a view that is not `sandbox`; `'unseen'` when the environment is unreadable,
    the home is unknown, the view has no `cwd`, or either has no path in the daemon's view; else its folder as it names
    it and as the daemon sees it.
  - `DiscoveredTerminalAgent.sandbox?: { cwd: string } | 'unseen'`: set only for a Hermes process in another mount
    namespace. `{ cwd }` is the folder as the process names it, for comparisons with what Hermes wrote, and the
    agent's `cwd` is then the daemon's path of it. `'unseen'`: `cwd` stays the pane's.
  - In `probeTerminalAgents`, after `agent.hermesHome`: `hermesHomeDerived`, then `sandbox` and the folder.

- [ ] **Step 1: Write the failing tests** (`processView` mocked)

```ts
// identities.hermes.spec.ts
it('translates a sandboxed Hermes\'s home to the daemon\'s view', async () => {
  readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
  processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace('/home/agent', '/data/agents/a1').replace(/^\/work/, '/data/work/p1') })
  expect(await probeHermesHome(identity, 'hermes')).toBe('/data/agents/a1/.hermes')
  expect(await probeHermesSandbox(identity, 'hermes')).toEqual({ cwd: '/work', hostCwd: '/data/work/p1' })
})
it('cannot see a sandbox whose home or folder has no path here', async () => {
  processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
  expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
  expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
  processView.mockResolvedValue({ state: 'sandbox', cwd: null, toHost: (p: string) => p }); expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
})
it('is no sandbox in the daemon\'s namespace, when it cannot tell, or for another engine', async () => {
  for (const state of ['same', 'unreadable'] as const) { processView.mockResolvedValue({ state }); expect(await probeHermesSandbox(identity, 'hermes')).toBeUndefined() }
  expect(await probeHermesSandbox(identity, 'claude')).toBeUndefined(); expect(processView).toHaveBeenCalledTimes(2)
})
it('marks a home it worked out, and not one the process named by the path Harness reads it at', async () => {
  processView.mockResolvedValue({ state: 'same' })
  readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' }); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(true)
  readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: '/data/p/profiles/work' }); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false)
  processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p })
  expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false)                 // the same path on both sides
  processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace('/data/p', '/host/p') })
  expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(true)                  // the row holds the daemon's path, not what it set
  readProcessEnv.mockResolvedValue(null); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false)
  expect(await probeHermesHomeDerived(identity, 'claude')).toBe(false)
})
// terminalAgentDiscovery.hermesHome.spec.ts
it('gives a sandboxed Hermes the daemon\'s path of its folder, and keeps the one it names', async () => {
  /* the Hermes agent: cwd '/data/work/p1', sandbox { cwd: '/work' }, hermesHome '/data/agents/a1/.hermes', hermesHomeDerived true;
     the Claude agent beside it: no sandbox, no hermesHomeDerived */ })
it('marks a sandbox it cannot see and leaves the pane\'s folder', async () => { /* sandbox 'unseen', cwd as the pane said, hermesHome undefined */ })
it('marks a home worked out from HOME, and not a profile the process named', async () => {
  /* readProcessEnv { HOME: '/sandbox/agent' } → hermesHome '/sandbox/agent/.hermes', hermesHomeDerived true;
     { HOME: '/h', HERMES_HOME: '/h/.hermes/profiles/work' } → that home, no hermesHomeDerived */ })
// core/agents/discovery.spec.ts
it('tells the registry a home Harness worked out, and marks a row that has that home without the mark', async () => {
  /* observed { hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true } on a row with no home:
     setHermesHome called with ('a1', '/data/agents/a1/.hermes', true);
     on a row { hermesHome: '/data/agents/a1/.hermes' }: called the same; on a row that has the mark, or another home: not called.
     The existing case (a named home on a row with none → ('a1', '/hermes')) passes unedited. */ })
```

- [ ] **Step 2:** `npx vitest run src/engines/identities.hermes.spec.ts src/lib/terminalAgentDiscovery.hermesHome.spec.ts src/core/agents/discovery.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Those, plus `npx vitest run src/lib/terminalAgentDiscovery.spec.ts src/lib/terminalAgentDiscovery.engines.spec.ts src/architecture.spec.ts` → PASS;
  `npx vitest run src/core/agents/discovery.spec.ts --coverage --coverage.include=src/core/agents/discovery.ts` → 100% in every column.
- [ ] **Step 5:** Commit.

### Task 11: Hooks by version and interface

**Depends on:** Tasks 1, 8. **Effort:** xhigh (it edits a person's engine configuration).

**Files:**
- Modify: `cli/src/engines/nativeHooks.ts`, `cli/src/engines/kit/nativeLocations.ts`
  (`NativeHookOptions.executable?: { command: string }`), `cli/src/engines/nativeLaunch.ts` (the Hermes line of
  `prepareHooks` passes `{ ...options, executable }`), `cli/src/engines/README.md`, `docs/engines.md`
- Test: `cli/src/engines/nativeHooks.hermes.spec.ts` (create), `cli/src/engines/nativeLaunch.spec.ts`,
  `cli/e2e/eagerHooks.e2e.ts`

**Interfaces:**
- Consumes: `hermesKeepsRecord`, `hermesHomeIsTui`, `rememberRecordHome`, `isRecordHome` (Task 8);
  `HERMES_HOOKS_SAID` (Task 1); `removeNativeYamlHooks` (`kit/nativeHookYaml.ts`), `nativeHookHomes`.
- Produces, in `engines/nativeHooks.ts`:
  - `installHermesHooks(port, selectedHome?, options?, platform?)`: same signature, now `async`.
  - `removeHermesHooks(homes: readonly string[]): Promise<void>`: `removeNativeYamlHooks(HERMES_HOOK_SETTINGS, homes)`
    (the managed block, a bare one an older release left, Harness's approvals, the pane names in
    `terminal.client_env_passthrough`); for each outcome `removed > 0` says `HERMES_HOOKS_SAID.removed`
    (`console.log`), `failed` or `kept` says `HERMES_HOOKS_SAID.kept` (`console.warn`) once per file for the daemon's
    life. It never throws.
  - `hermesRecordSeen(home: string): Promise<void>`: the first time for this home (`rememberRecordHome(home)` true),
    and unless `await hermesHomeIsTui(home)`, `await removeHermesHooks([home])`. It never rejects.

**`installHermesHooks`, off Windows, before anything it does today.** "Today's body for a home" is today's code with
that home as `selectedHome` (the `requireHookScript` check, then `installNativeYamlHooks` with today's command and
options); it lives under this comment, the one mark of the compatibility path:
`// Compatibility for a Hermes that keeps no terminal record: one older than v0.21.6, or a home set to its TUI.`
`// #4207, remove on or after 2026-12-07 (60 days after v0.21.6), with what only it reaches.`

1. `homes` is `[selectedHome]`, else `nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)`.
2. Nothing to decide when no home of `homes` has a `config.yaml` and none would be made (`selectedHome` with
   `options.environment`): today's body runs, and no version is asked (a computer without Hermes starts no process).
3. `keeps = await hermesKeepsRecord(options?.executable, options?.environment)`; `null` counts as
   `!!selectedHome && isRecordHome(selectedHome)`.
4. Not `keeps` (older, or unknown): today's body, unchanged, for `selectedHome` as it was given (one call, so its
   lines and their order are today's).
5. `keeps`: the homes set to the TUI (`hermesHomeIsTui`, asked of each home in order) keep their hook; the others
   lose it. `await removeHermesHooks(the others)`; then today's body for each TUI home, in order, one after another.
   The answer is `true` when every TUI home's install answered `true` (and `true` with no TUI home: a launch needs no
   hook, and one that cannot be removed does not hold it).

On `win32` nothing above runs.

- [ ] **Step 1: Write the failing tests** (`nativeHooks.hermes.spec.ts`: a throwaway `HERMES_HOME`; `nativeHooks.js`
  and `hermesRecord.js` loaded together after `vi.resetModules()`, as `lib/hooks.spec.ts` loads its installers, so each
  case starts with nothing remembered; `hermesKeepsRecord` is the suite's mock, set per case)

```ts
const PERSON = 'model: anthropic/claude\nterminal:\n  client_env_passthrough: ["MY_VAR"]\n'
it('leaves a v0.21.6+ home without Harness\'s hooks, as the person wrote it', async () => {
  writeFileSync(config, PERSON); await installHermesHooks(18473)                       // older: installed, as today
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(readFileSync(config, 'utf8')).toBe(PERSON)
  expect(JSON.parse(readFileSync(allowlist, 'utf8')).approvals).toEqual([])
  expect(logs.filter((line) => line.startsWith("[hooks] removed Harness's Hermes hooks → "))).toHaveLength(2)   // config.yaml and the allowlist
  logs.length = 0; expect(await installHermesHooks(18473)).toBe(true); expect(logs).toEqual([])
})
it('writes nothing into a v0.21.6+ launch\'s home, not even its first config', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  expect(await installHermesHooks(18473, fresh, { environment: { HOME: root, HERMES_HOME: fresh }, executable: { command: '/bin/hermes' } })).toBe(true)
  expect(existsSync(join(fresh, 'config.yaml'))).toBe(false)
  expect(hermesKeepsRecord).toHaveBeenCalledWith({ command: '/bin/hermes' }, { HOME: root, HERMES_HOME: fresh })
})
it('keeps an older Hermes\'s hook, and an unknown one\'s', async () => {
  for (const keeps of [false, null]) { vi.mocked(hermesKeepsRecord).mockResolvedValue(keeps); writeFileSync(config, PERSON)
    expect(await installHermesHooks(18473)).toBe(true); expect(readFileSync(config, 'utf8')).toContain('--engine hermes') }
})
it('takes a home seen keeping a record for v0.21.6+ while the version is unknown', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(null); rememberRecordHome(home); writeFileSync(config, WITH_BLOCK)
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })).toBe(true)
  expect(readFileSync(config, 'utf8')).not.toContain(HERMES_HOOK_SETTINGS.begin)
})
it('asks no version of a computer with no Hermes config, or on Windows', async () => {
  rmSync(config, { force: true }); await installHermesHooks(18473); expect(hermesKeepsRecord).not.toHaveBeenCalled()
  writeFileSync(config, PERSON); await installHermesHooks(18473, undefined, undefined, 'win32'); expect(hermesKeepsRecord).not.toHaveBeenCalled()
})
it('says once that it could not remove a hook, and does not hold the launch', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true); writeFileSync(config, WITH_BLOCK); chmodSync(home, 0o555)
  expect(await installHermesHooks(18473)).toBe(true); expect(await installHermesHooks(18473)).toBe(true)
  expect(warns.filter((line) => line.startsWith("[hooks] could not remove Harness's Hermes hooks from "))).toHaveLength(1)
})
it('removes the hooks of a home the first time a record is seen there', async () => {
  writeFileSync(config, WITH_BLOCK); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).not.toContain(HERMES_HOOK_SETTINGS.begin)
  writeFileSync(config, WITH_BLOCK); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)   // once per home
})
it('keeps the hook of a home set to the TUI, byte for byte, and removes it from the CLI home beside it', async () => {
  writeFileSync(config, PERSON + TUI); writeFileSync(profileConfig, PERSON)
  await installHermesHooks(18473)                                            // older: both installed, as today
  const older = readFileSync(config, 'utf8')
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  writeFileSync(config, PERSON + TUI)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(readFileSync(config, 'utf8')).toBe(older)                           // the hook an older Hermes gets
  expect(readFileSync(profileConfig, 'utf8')).toBe(PERSON)
})
it('keeps a TUI launch\'s hook, and answers what its install answers', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true); writeFileSync(config, PERSON + TUI)
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home }, executable: { command: '/bin/hermes' } })).toBe(true)
  expect(readFileSync(config, 'utf8')).toContain('--engine hermes')
  writeFileSync(config, PERSON + TUI + 'hooks:\n  on_session_start: []\n')   // the person's own hooks: mapping, which today's install leaves and reports
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } }))
    .toBe(await olderInstallOf(PERSON + TUI + 'hooks:\n  on_session_start: []\n'))
})
it('leaves a TUI home\'s hook when a record is seen there, and when its version is unknown', async () => {
  writeFileSync(config, WITH_BLOCK + TUI); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(null)                        // unknown, in a home seen keeping a record
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })).toBe(true)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
})
```

`WITH_BLOCK` is what `installHermesHooks(18473)` leaves for an older Hermes; `TUI` is `'display:\n  interface: tui\n'`;
`profileConfig` is `<home>/profiles/work/config.yaml`; `olderInstallOf(text)` writes `text` to `config` and answers
what `installHermesHooks` answers for it with `hermesKeepsRecord` answering `false`. The read-only case is skipped
for root.
`nativeLaunch.spec.ts` gains: a Hermes launch's `prepareHooks` calls `installHermesHooks` with its `executable`.
`e2e/eagerHooks.e2e.ts`: `d.env.HERMES_PATH` names a script of the test's own that answers `--version` with
`Hermes Agent v0.21.5 (2026.10.7)`, so the daemon never runs the computer's Hermes and its Hermes expectation stands.

- [ ] **Step 2:** `npx vitest run src/engines/nativeHooks.hermes.spec.ts src/engines/nativeLaunch.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Those, plus the proof that an older Hermes's files are byte for byte today's, with no edit to any of
  them: `npx vitest run src/lib/hooks.spec.ts src/engines/otherHooks.golden.spec.ts src/engines/hookInstallers.golden.spec.ts src/core/engines/hookStartup.golden.spec.ts src/engines/nativeHookPreparation.spec.ts src/engines/removeHooks.spec.ts src/engines/kit/windowsHooks.spec.ts src/architecture.spec.ts`
  → PASS.
- [ ] **Step 5: Docs.** `cli/src/engines/README.md`, Stage B, one paragraph, each of these in a sentence:
  - an engine that writes down which session a terminal is on needs neither a hook nor a scan; Hermes v0.21.6+ with
    its default CLI is followed from `<HERMES_HOME>/terminal-sessions/<terminal id>` on macOS and Linux, and that is
    the minimum for following without a hook;
  - an older Hermes, and a home whose `config.yaml` says `display.interface: tui` (the TUI writes no record), keep
    the hook until 2026-12-07 or later (#4207); Windows keeps hooks;
  - a run that writes no record in a home set to the CLI (`hermes --tui`, `HERMES_TUI=1`,
    `session.terminal_continue: false`) is bound once and its session switches are not followed;
  - a restart, resume or fork names a Hermes home only when the process itself set `HERMES_HOME`; a home worked out
    from its `HOME` is worked out again by the new process;
  - a wrapper named `hermes` must `exec` what it starts: Harness reads the shallowest process that reads as Hermes,
    and a wrapper that stays the parent is read in place of the Hermes inside its sandbox.

  `docs/engines.md`, the Hermes row: `its terminal record (v0.21.6+) or hooks, + SQLite`.
- [ ] **Step 6:** Commit.

---

### Task 12: Bind, wiring, end to end

**Depends on:** Tasks 9, 10, 11, 13. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/agents/bind.ts`, `cli/src/core/main.ts`
- Create: `cli/e2e/hermesTerminalRecord.e2e.ts`, `cli/e2e/harness/fakeHermes.mjs`
- Test: `cli/src/core/agents/bind.spec.ts`, the new end-to-end file

**Interfaces:**
- Consumes: `createHermesTerminal`, `HermesFollow` (Task 9); `DiscoveredTerminalAgent.sandbox` and
  `.hermesHomeDerived` (Task 10); `hermesRecordSeen` (Task 11); `hermesTerminalNames`, `hermesTerminalStamp`,
  `readHermesTerminal`, `hermesSessionKind` (Task 7); `HERMES_SANDBOX_HOLD` (Task 1); `registry.register`'s
  `hermesHomeDerived` (Task 13).
- Produces: `BindDeps.hermesTerminal?: ReturnType<typeof createHermesTerminal>`. Absent, the pass is today's (the
  other specs that build a binding pass none).

**`bindObservedAgent`**, for `observed.engine === 'hermes'` with `hermesTerminal`, after the OpenClaw block and before
`if (agent.sessionId)`:

1. `observed.sandbox === 'unseen'`: `registry.setIdentityHold(agent.agentId, HERMES_SANDBOX_HOLD)`; when it changed,
   `console.log(\`[discovery] ${sid(agent.agentId)} binding held · ${HERMES_SANDBOX_HOLD}\`)` and
   `announceSession(agent)`. Return.
2. `agent.identityHold === HERMES_SANDBOX_HOLD`: clear it, `announceSession(agent)`, return (the next pass binds: a
   changed hold ends this pass's `current()`).
3. `followed = await hermesTerminal.follow(agent, { ...observed, sandboxed: !!observed.sandbox }, { current, mayClaim, hold })`.
   `'wait'`, or `!current()`: return.
4. A session, agent bound: when it differs from the agent's, the `switched hermes session` line; then
   `commit({ engine: 'hermes', sessionId, cwd: observed.cwd, source: 'hermes-terminal', runtimes, primaryRuntimeKey, processIdentity, hookEvent: 'HermesTerminal' })`
   and `followRegistered` when `isNew`, as the Copilot switch does. Return.
5. A session, agent unbound: it takes the place of `observed.resumeSessionId` with `source = 'hermes-terminal'`, skips
   the transcript lookup, and goes through the existing tail (`mayClaim`, the previous owner told, `commit` with
   `hermesHome` when `follow` gave one, and with it `hermesHomeDerived: true` when `observed.hermesHomeDerived`;
   `followRegistered`, the `bound hermes session` line). `hookEvent` is `'HermesTerminal'`.
6. `'none'`: today's code. The repair compares with what Hermes wrote, so `findLiveSession` is given
   `observed.sandbox.cwd` when `observed.sandbox` is an object, else `observed.cwd`; the row still takes
   `observed.cwd`. After a `process-repair` bind of a Hermes agent, `hermesTerminal.fellBack(agentId)`.

**`main.ts`** (wiring only): `createHermesTerminal({ platform: process.platform, defaultHome: env.HERMES_HOME, registry, paneInfo: (runtime) => terminals.backendFor(runtime)?.paneInfo(runtime) ?? Promise.resolve(null), names: hermesTerminalNames, stamp: hermesTerminalStamp, read: readHermesTerminal, kind: hermesSessionKind, recordSeen: (home) => { void hermesRecordSeen(home) }, now: Date.now })`,
passed to `createBinding` as `hermesTerminal`.

**`e2e/harness/fakeHermes.mjs`**: `fakeHermesScript(options): string`, the text of a `hermes` the test writes to
`d.env.HERMES_PATH`. It keeps its own argv (no `process.title`, so `ps` shows its environment on macOS). `--version`
prints `options.version` and exits. Otherwise, as Hermes v0.23 does: its home is `HERMES_HOME` or `<HOME>/.hermes`;
it makes `state.db` (`sessions(id TEXT PRIMARY KEY, source TEXT, created_source TEXT, cwd TEXT, started_at REAL)` and
the `messages` table of `e2e/hermesAdmission.e2e.ts`); it names its terminal as `get_terminal_id()` does (the output
of `tty` with its stdin, else `tmux_pane-<s(TMUX_PANE)>`); it creates a session `local-<sha256 hex>` with
`source = 'local'`, `created_source = 'cli'`, then writes `<home>/terminal-sessions/<id>` as
`{"session_id":…,"cwd":…,"ts":<seconds>}` through a temporary file and a rename. It then follows a script file
(`options.script`, JSON lines the test appends, read on `fs.watch`): `{"new":true}` (a new session, then the record),
`{"resume":"<id>"}`, `{"say":"<text>"}` (a user row and an assistant row in the session), `{"link":"<path>"}` (its
record replaced by a symlink to that path), `{"pad":<bytes>}` (its record rewritten that large).
`options.record: false` writes no record (the TUI). Each start it writes `<its home>/started.json` as
`{"given": <FAKE_GIVEN_HERMES_HOME, else "">}`: the `HERMES_HOME` the launch exported.
`options.home` (a folder; every platform) makes the file a `/bin/sh` wrapper that answers `--version` itself and
otherwise sets `FAKE_GIVEN_HERMES_HOME="${HERMES_HOME-}"` and `HOME=<the folder>`, unsets `HERMES_HOME` and `exec`s
the fake: a Hermes that only has a `HOME` of its own.
`options.sandbox` (`'same' | 'remapped' | 'unseen'`, Linux) is that wrapper with
`exec unshare --user --map-root-user --mount --pid --fork -- /bin/sh -c '<mounts>; exec <node> <the fake> "$@"'` in
place of its last step: every variant mounts a private tmpfs on `/tmp`, with `HOME` the agent's folder and
`HERMES_HOME` unset;
`remapped` binds the agent's folder at `/tmp/home` and the work folder at `/tmp/work`, runs from `/tmp/work` with
`HOME=/tmp/home`, and mounts its own `devpts` on `/dev/pts` (so `tty` fails and the record is `tmux_pane-…`);
`unseen` puts `HOME` on the private tmpfs.

- [ ] **Step 1: Write the failing tests**

`bind.spec.ts` (a `hermesTerminal` of `vi.fn`s passed through `setup`):

```ts
it('holds a Hermes whose sandbox it cannot see, once, and asks nothing', async () => {
  /* observed({ engine: 'hermes', sandbox: 'unseen' }) twice: setIdentityHold(…, HERMES_SANDBOX_HOLD) changed once, announceSession once,
     follow and findLiveSession not called, register not called */ })
it('lets the hold go when the sandbox is seen again, and binds on the next pass', async () => { /* row.identityHold = HERMES_SANDBOX_HOLD → cleared, announced, follow not called this pass */ })
it('binds an unbound Hermes to the session its record names, without the repair', async () => {
  follow.mockResolvedValue({ sessionId: 'S', hermesHome: '/data/agents/a1/.hermes' })
  await run.binding.bindObservedAgent(observed({ engine: 'hermes', cwd: '/data/work/p1' }))
  expect(findLiveSession).not.toHaveBeenCalled()
  expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ engine: 'hermes', sessionId: 'S', hermesHome: '/data/agents/a1/.hermes',
    cwd: '/data/work/p1', source: 'hermes-terminal', hookEvent: 'HermesTerminal' }))
  expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).not.toHaveProperty('hermesHomeDerived')
})
it('marks the home it binds with when Harness worked that home out', async () => {
  follow.mockResolvedValue({ sessionId: 'S', hermesHome: '/data/agents/a1/.hermes' })
  await run.binding.bindObservedAgent(observed({ engine: 'hermes', hermesHomeDerived: true }))
  expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true }))
  follow.mockResolvedValue({ sessionId: 'T' })                                  // no home given: no mark of its own
  await run.binding.bindObservedAgent(observed({ engine: 'hermes', hermesHomeDerived: true }))
  expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).not.toHaveProperty('hermesHomeDerived')
})
it('tells the agent the session was taken from', async () => { /* bySession('S') is another agent: input.forget, deviceInput.forget, announceSession for it */ })
it('switches a bound Hermes through the rotation, and attaches the new session', async () => { /* agent on 'old', follow { sessionId: 'S' }: the switched line, register with source 'hermes-terminal', attachSession when isNew */ })
it('confirms a resumed Hermes without a switch', async () => { /* agent on 'S', follow { sessionId: 'S' }: register called, no switched line, no attach (isNew false) */ })
it('does nothing while a record waits', async () => { /* follow 'wait': no register, no findLiveSession */ })
it('drops what it was told when the pane changed hands meanwhile', async () => { /* byProcess answers another row after follow: no register */ })
it('falls back to the repair with the folder the sandbox names, binds the daemon\'s path of it, and says so once', async () => {
  follow.mockResolvedValue('none'); vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found' } as never)
  await run.binding.bindObservedAgent(observed({ engine: 'hermes', cwd: '/data/work/p1', sandbox: { cwd: '/work' } }))
  expect(findLiveSession).toHaveBeenCalledWith('hermes', '/work', expect.any(Number), expect.anything())
  expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/data/work/p1', source: 'process-repair' }))
  expect(fellBack).toHaveBeenCalledExactlyOnceWith('a1')
})
it('leaves the other engines and a binding with no hermesTerminal as they were', async () => { /* claude: follow and fellBack not called; the existing Hermes repair case passes unedited */ })
```

`e2e/hermesTerminalRecord.e2e.ts` (each case: `IsolatedDaemon.create()`, `d.env.HERMES_HOME = join(d.root, 'hermes')`,
`d.env.HERMES_PATH` the fake, `d.env.HOOK_INSTALL_ENGINES = 'hermes'`; state is read with `agents_list`, the client's
frames, `session_get` and `d.log()`, waited for with `until`, never slept for):

```ts
it('binds a Hermes v0.23 from its terminal record, follows /new, and writes no hook', async () => {
  /* config.yaml seeded with the person's lines and the managed block, allowlist and pane names an earlier release wrote.
     After start: config.yaml is the person's lines again; the log has "[hooks] removed Harness's Hermes hooks → ".
     agent_create hermes → the row's sessionId is the fake's first session; no "[hooks] … session-start" line; the log has "bound hermes session".
     {"say":"hello"} appended at once, before the bind: session_get of the agent shows "hello" (Review Focus 2).
     {"new":true} → the row's sessionId is the second session, a session_reset frame names the first, the log has "switched hermes session"
     (a branch and a compression split write the record the same way).
     A second Hermes agent in the same home and folder binds its own session; neither takes the other's.
     config.yaml still has no managed block. */ })
it('follows a resumed Hermes through /new without failing it', async () => {
  /* create, stop (agent_delete), agent_resume → the fake is started with --resume <first>: its record names <first>;
     {"new":true} → the row follows to the new session and its launch never reads failed (Review Focus 3). */ })
it('binds nothing from a record an earlier process left, binds once by the repair, and says switches are not followed', async () => {
  /* fake with record: false; <home>/terminal-sessions/<the pane's tty name> pre-written for another session with ts 60 s before.
     The row binds the session this process made; the log has "hermes keeps no terminal record · its session switches are not followed"
     and "hermes terminal record ignored · older than its process". */ })
it('ignores a record that is a symlink, and one of 10 MB, and keeps the session it has', async () => {
  /* {"link":"<another agent's record>"} then {"pad":10485760}: the row's sessionId does not move; the log has
     "hermes terminal record ignored · not a regular file" and "… · oversized" once each; the next pass is not late (agents_list answers). */ })
it('keeps an older Hermes\'s hook', async () => { /* version 'Hermes Agent v0.21.5 (2026.10.7)': after start config.yaml has the managed block for this daemon's port */ })
it('keeps the hook of a home set to the TUI', async () => {
  /* a v0.23 fake with record: false; config.yaml is the person's lines and "display:\n  interface: tui\n".
     After start config.yaml has the managed block for this daemon's port, and no "[hooks] removed" line names it.
     agent_create hermes → the row binds the session the fake made (the fake fires no hook, so by the repair);
     config.yaml still has the block after the bind. */ })
it('follows a Hermes that only has a HOME of its own, and starts it again without naming that home', async () => {
  /* options.home = <agent folder> under d.root, its .hermes/config.yaml seeded with Harness's block.
     Bound from the record in <agent>/.hermes/terminal-sessions; the saved row (registry.json in the daemon's data folder) has
     hermesHome <agent>/.hermes and hermesHomeDerived true; the block is gone from that config.yaml.
     first = started.json's "given". agent_restart → started.json is written again with "given" equal to first and not <agent>/.hermes;
     the row binds the restarted fake's session. d.restart(), then agent_restart once more: the same (the mark was saved). */ })
describe.runIf(process.platform === 'linux' && unshareWorks())('in a sandbox', () => {
  it('binds and follows a Hermes whose home and folder are where the daemon sees them', async () => {
    /* sandbox 'same', the agent's folder under d.root seeded with a config.yaml carrying Harness's block:
       bound from tty-dev-pts-N; "hermes runs in a sandbox · followed from its terminal record" once; the saved row
       (registry.json in the daemon's data folder) has hermesHome <agent>/.hermes and hermesHomeDerived true; the block is gone from
       that config.yaml; {"new":true} is followed. */ })
  it('binds a Hermes whose home, folder and /dev/pts are remapped', async () => {
    /* sandbox 'remapped': bound from tmux_pane--N; the saved row's cwd is the work folder's path on the host, its hermesHome the agent
       folder's .hermes on the host, with hermesHomeDerived true. agent_restart → started.json's "given" is what the first start was
       given, never that host path; the restarted fake is bound again from its record. */ })
  it('holds a Hermes whose home is on a filesystem of the sandbox\'s own, and leaves its pane working', async () => {
    /* sandbox 'unseen': the log has "binding held · Hermes runs in a sandbox whose folder Harness cannot see" once, the saved row has it as
       identityHold and no session; d.capture(pane) shows the fake's prompt. */ })
})
it.runIf(process.env.HARNESS_E2E_REQUIRE_SANDBOX === '1')('ran the sandbox cases', () => {
  expect(process.platform === 'linux' && unshareWorks()).toBe(true)
})
```

`unshareWorks()` is `spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true']).status === 0`.

- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` → the new cases FAIL;
  `npx vitest run --config vitest.e2e.config.ts e2e/hermesTerminalRecord.e2e.ts` → FAIL at the first bind.
- [ ] **Step 3:** Implement `bind.ts`, the wiring and the fake.
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts src/engines/otherIdentity.golden.spec.ts src/engines/kit/storePool.spec.ts src/lib/registry.binding.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`
  → PASS; the end-to-end command of Step 2, plus `e2e/hermesAdmission.e2e.ts` → PASS on this computer.
- [ ] **Step 5:** Commit.

### Task 14: Temporary workflow for the Linux sandbox check (TEMPORARY, removed before the pull request)

**Files:** `.github/workflows/tmp-sandbox-hooks.yml` (new). Nothing else.

**Depends on:** nothing (it runs Task 12's `e2e/hermesTerminalRecord.e2e.ts` once both are on the branch). **Effort:**
medium. **No red test:** one commit, per ken15dev's temporary-workflow rule.

Verification check 3 (Hermes inside `unshare`) has no workflow that can run it: `cli-e2e.yml` runs on Linux runners
whose AppArmor refuses unprivileged user namespaces, so its sandbox group skips. This file runs it on GitHub instead of
a box of Ken's.

- `on: push: branches: ['0xken15/sandbox-hooks']` only (no `pull_request`, no `workflow_dispatch`, no schedule).
- `permissions: contents: read`; no secrets; nothing that releases, publishes, deploys, uploads or writes outside its
  own run.
- `concurrency: { group: tmp-sandbox-hooks-${{ github.ref }}, cancel-in-progress: true }`.
- One job, matrix `runner: [ubuntu-24.04, ubuntu-24.04-arm]` (the device is ARM64), `timeout-minutes: 30`,
  `fail-fast: false`. Steps:
  1. `actions/checkout` and `actions/setup-node` with the same Node pin and npm cache settings `cli-e2e.yml` uses
     (`CLI_NODE_VERSION`), then `npm ci` in `cli/` as `cli-e2e.yml` does.
  2. `sudo apt-get install -y tmux` if `cli-e2e.yml` installs it that way (copy its step).
  3. `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (this runner only), then the probe
     `unshare --user --map-root-user --mount --pid --fork true` must exit 0.
  4. From `cli/`: `mkdir -p ~/e2e-tmp && TMPDIR=~/e2e-tmp HARNESS_E2E_REQUIRE_SANDBOX=1 npx vitest run --config
     vitest.e2e.config.ts e2e/hermesTerminalRecord.e2e.ts`.
- A file comment says it is temporary, for #4194's Linux sandbox check, removed before the pull request.

Commit: `ci(tmp): run the Hermes sandbox end-to-end check on Linux x64 and ARM64 (temporary, #4194)`.

## Verification

None of these touches production, the developer's own `~/.hermes` or `~/.harness`, daemon (18473) or tmux server: every
daemon is the harness's `IsolatedDaemon` (a throwaway home, data folder and port, a private tmux server), every
`hermes` is the fake, and the computer's own Hermes is never run (`HERMES_PATH` names the fake in each case).

**1. Local gates PR CI does not run** (from `cli/`, on the final head, recorded in the pull request):
- `npm run test:core`: `src/core/agents/bind.ts`, `src/core/agents/hermesTerminal.ts` and
  `src/core/agents/discovery.ts` at 100% in every file.
- `npm run test:resume`: `lib/sessionRepair.ts` is in its area (one constant exported), and it runs the stopped and
  resumed rows that now carry `hermesHomeDerived`.
- `npm run typecheck`.

**2. End to end on the Mac, outside a sandbox** (the developer's Mac, from `cli/`):
`npx vitest run --config vitest.e2e.config.ts e2e/hermesTerminalRecord.e2e.ts e2e/hermesAdmission.e2e.ts e2e/eagerHooks.e2e.ts`.
A person should see the seven non-sandbox cases of `hermesTerminalRecord` pass (bound from `tty-dev-ttysNNN`, `/new`
followed, no hook written, the fallback said once, an older Hermes's hook kept, a TUI home's hook kept, a Hermes with
a `HOME` of its own followed and restarted with no `HERMES_HOME` of Harness's, after a daemon restart too), the
sandbox group reported skipped, and the other two files green.

**3. End to end on Linux, inside a sandbox**, on GitHub through Task 14's temporary workflow
(`.github/workflows/tmp-sandbox-hooks.yml`, x64 and ARM64 runners, run by pushing the feature branch). Both legs must
pass with `ran the sandbox cases` passing, not skipped. If the runners refuse `unshare` even after the sysctl, fall
back to a disposable box as below. The box route (a disposable Linux box, never one that serves people):
- The box: x86-64 or ARM64 Linux with Node 24, tmux, git and util-linux, and this branch checked out with
  `npm ci` run in `cli/`. First ask it: `unshare --user --map-root-user --mount --pid --fork true; echo $?` must print
  `0`.
- `machine-remote-1` and `machine-remote-2` are Docker containers and may refuse (`unshare: unshare failed: Operation
  not permitted`). Then do not change them. Start a new disposable container from the same image with
  `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` and ask again; if that refuses too, use a
  disposable Linux VM (Lima or UTM on the Mac; on Ubuntu 24.04 run
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` in the VM first). Remove the container or VM after.
  If no box allows it, report the check as not run; do not call it passed.
- Run, from `cli/` on the box, with the test's root outside `/tmp` (the sandbox covers `/tmp` with its own):
  `mkdir -p ~/e2e-tmp && TMPDIR=~/e2e-tmp HARNESS_E2E_REQUIRE_SANDBOX=1 npx vitest run --config vitest.e2e.config.ts e2e/hermesTerminalRecord.e2e.ts`.
- A person should see all cases pass, the three sandbox cases among them: a Hermes under
  `unshare --user --mount --pid --fork` with a private `/tmp` and its own `HOME` bound from `tty-dev-pts-N` and
  followed through `/new`, with `hermes runs in a sandbox · followed from its terminal record` once and Harness's
  block gone from the agent's `config.yaml`; the remapped one bound from `tmux_pane--N` with the host's paths on its
  row, and restarted without the host's path of its home in its environment; the unseen one held with `Hermes runs in a sandbox whose folder Harness cannot see` and its pane still
  answering. `ran the sandbox cases` must pass, not skip.

**4. The suite on GitHub:** one run of **Actions → CLI end to end → Run workflow** on the branch (Linux runners; their
AppArmor may skip the sandbox group, which check 3 covers).

**Windows:** no end-to-end check. Nothing it runs changes: `follow` answers `'none'`, hooks are installed for every
version, and the daemon reads no process environment there (`lib/processEnv.ts`), so §1's Windows rule is reached by
Task 2's unit cases only and no row is marked `hermesHomeDerived` there. Tasks 9 and 11 pin both with
`platform: 'win32'`.

## Follow-up

Removing the compatibility path is #4207, on or after 2026-12-07.

## Open question

1. **Answer 2 (a relaunch never exports a home worked out from `HOME`) needs one stored bit, and spec Design 1 says
   "no new registry field".** This plan adds `RegisteredSession.hermesHomeDerived?: true` (Task 13, and the lines of
   Tasks 2, 10 and 12 that set it). Confirm it, and spec Design 1 (Growth) says "one optional registry field,
   `hermesHomeDerived`" in place of "no new registry field". The alternative with nothing stored keeps the mark in
   memory per live process: it is lost when the daemon restarts, and a stopped sandboxed agent resumed after that is
   started with the daemon's path of its home, which the answer forbids. Until this is answered Task 13 does not
   start; no other Wave 1 task waits for it.
