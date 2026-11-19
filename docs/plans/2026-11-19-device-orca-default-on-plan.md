# The Orca plugin is set up by default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Status:** approved by the PM (2026-11-19). Q1 and Q2 at the end are answered as recommended.

**Goal:** The devices process installs, approves (only for the pinned access) and keeps current Harness Device's
plugin for Orca with no click; `harness device orca enable|disable` take it away or bring it back; the Harness Device
app loses everything about Orca's plugin.

**Architecture:**
- **One function sets the plugin up, for both callers.** `orcaSetUp(deps, { force })` (`devices/orcaPlugin.ts`) replaces
  `orcaConnect`; it passes `--approve` only when `withinApproved` says everything Orca lists is in the pinned set.
- **The devices' pass is a new file beside the editors'.** `cable/orcaPluginSetup.ts` reads the removal and the record,
  calls `orcaSetUp`, records `orca` or `orcaHeld` in `dial-setup.json` and counts the tally. `services/devices.ts` only
  builds it and calls it at start, attach and Orca's settle.
- **The command keeps three words.** `status`, `enable`, `disable` (`deviceClaude/command.ts`); `connect` is gone.
- **The Harness Device app is thinner.** Its Orca row, screen, runs and types go; `tabs.rs`'s Orca in front stays.
- **Nothing in the daemon core.** Every file is the devices process's, the `harness` command's, the app's or a test's.

**Tech Stack:** TypeScript (Node, Vitest 4) in `cli/`; Rust (Tauri 2) and plain TypeScript (Vitest) in `device-app/`.

**Spec:** [docs/plans/2026-11-19-device-orca-default-on-design.md](2026-11-19-device-orca-default-on-design.md). It
replaces parts of [#4446's design](2026-11-18-connect-orca-design.md). Its "Decided (Diego and the PM, 2026-11-19)",
1 to 7, and the PM's decisions in the brief are not reopened here.

## Base

- **Written against** `feat/device-orca-default-on` at `36c4c41a3c` (`main` with #4488). Tasks name code by name, never
  by line. If a name below is gone, stop and report.
- A task that names a failing test is two commits: the test, red, then the change. The message given is the second's.
  A task marked "one commit" changes no behavior and has no red test.
- **Dependencies.** The worktree has no `cli/node_modules` and no `device-app/ui/node_modules`: clone or install them
  as the implementer's definition says (`npm ci` in `device-app/ui`). For Rust, one `CARGO_TARGET_DIR` outside the
  repository (device-app/AGENTS.md).
- **Per task:** `cd cli && npx tsc --noEmit -p .` and only the Vitest files the task names; for `device-app/`, the
  commands the task names. No task starts a real app or a real `orca`.
- **Other branches** (`fix/dial-chatgpt-ring-and-follow`, `fix/dial-tmux-in-terminal-app`) edit `cli/src/cable/` and
  `cli/src/services/devices.ts`: this branch's `devices.ts` edit is Task 6 alone, a few lines at three call sites.

## File structure

| File | Change | Task |
|---|---|---|
| `cli/src/devices/dialSkillFiles.ts` | `DialRemoved.orca`; `DialSetupRecord.orca`, `.orcaHeld`; header | 1 |
| `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialSetup.ts` | `orca()`, `recordOrca()`, `recordOrcaHeld()` | 1 |
| `cli/src/devices/orcaPlugin.ts` | `ORCA_APPROVED`, `withinApproved` (2); `orcaSetUp`, `orcaRemove`, `carriedVersion` (3); new `orcaStatus` states, `orcaConnect` and the window-only bounds deleted, header (5) | 2, 3, 5 |
| `cli/src/testing/fakeOrcaCli.ts` | `plugin uninstall`; the plugin's state (`reset`, `holds`, `disable`, `entry`) | 3 |
| `cli/src/cable/orcaPluginSetup.ts` (new) | the devices' pass | 4 |
| `cli/src/deviceClaude/command.ts` | `orca status|enable|disable`, `connect` gone, usage | 5 |
| `cli/src/devices/orcaPluginFolder.ts` | header only: the devices' process writes the folder too | 5 |
| `cli/src/services/devices.ts` | `DevicesDeps.orcaPlugin`; the setup built and called at start, attach and settle | 6 |
| `cli/e2e/deviceOrcaConnect.e2e.ts` → `cli/e2e/deviceOrca.e2e.ts` | the command from the built CLI (5); the devices process at a dial's attach (6) | 5, 6 |
| `device-app/src-tauri/src/*.rs` | Orca's runs, types, state, row and redaction gone; `orca_cli.rs` deleted | 7 |
| `device-app/ui/src/*`, `desktop/design/desktop-design-system.md` | the Orca screen and its strings gone; the design doc follows | 8 |
| `device-app/AGENTS.md`, `plugins/harness-device-orca/README.md`, `cli/AGENTS.md`, `docs/cli.md` | the docs | 9 |

Each `*.ts` above has its `*.spec.ts` beside it in the same task. Nothing under `cli/src/core/` or `cli/src/harnessd/`
changes; `cli/src/architecture.coreFiles.txt` gains no line. `cli/src/cli.ts`, `cli/src/cable/hosts/orca.ts`,
`plugins/harness-device-orca/src/` and `device-app/src-tauri/src/tabs.rs` are not edited.

## Global Constraints

- **The pinned access (spec, "The approved access"):** execution `trusted-worker`; capability kinds `workspace:read`;
  contributions `panels/Harness Device`, `statusBarItems/Dial`, `events/workspace.changed` (kind `/` name, a panel by
  its `title`, a status bar item by `text || id`, an event by its `on`); no `replacements`. A capability is an object
  with only `kind` and `description`. `data.pluginKey` is `inspect`'s key and `data.version` the carried
  `orca-plugin.json`'s version.
- **`--approve` only from `orcaSetUp`,** only with the fingerprint of the refusal it just read, held to
  `^ap1-[0-9a-f]{32}$`, only when `withinApproved`, at most once a call.
- **Records:** `dial-setup.json` `orca?: string` and `orcaHeld?: string`, versions held to `VERSION`
  (`^[0-9A-Za-z.+-]{1,64}$`), written only by the devices process through `dialHomeSetup`. `dial-skill.json`
  `removed.orca` (`true` or absent), written only by `harness device orca enable|disable`. `orcaConnected` stays as it
  is; `enable` writes it on `on`.
- **Bounds on Orca:** `status` 5 s (`ORCA_STATUS_MS`), `inspect` and `list` 10 s (`ORCA_READ_MS`), each install-type run
  and `uninstall` 60 s (`ORCA_CHANGE_MS`), each answer read to 256 KiB (`ORCA_ANSWER_MAX_BYTES`), only named fields.
  The devices' wait after a failed pass: `3_600_000` ms.
- **Logs (spec 7; root AGENTS rule 7):** the devices' only lines are the tally's, `[device] orca plugin · orca ·
  <kind>[ · <reason>]` and its day line, kinds from `SETUP_COUNTS`, reasons `access`, `timeout`, `failed`, `folder`,
  `save`, `error`. Never a path, key, grant, fingerprint, errno or Orca's message. A caught error is logged as
  `errorKind(err)` (`cli/src/lib/log.ts`) if it is logged at all; `src/architecture.failureLogs.spec.ts` (#4488) stays
  green. The command prints its JSON line on stdout and, as today, `orca plugin folder: <code>` on stderr.
- **Paths:** the plugin's folder is `harnessPath('orca-plugin', …)` (`cli/src/config/harnessHome.ts`) and nothing else;
  `src/config/harnessHome.guard.spec.ts` stays green.
- **Never this computer's Orca:** no test, check or task runs the real `orca`, reads its config or plugin list, or opens
  `/Applications/Orca.app`. Specs use `src/testing/fakeOrcaCli.ts` or an in-memory `run`; `devices.spec.ts` never
  builds `orcaPluginRun()` unmocked; end-to-end daemons find the fake through `bin/orca` → the harness's launcher and
  `HARNESS_ORCA_APP_BIN` (`e2e/harness/daemon.ts`). No real-app gate. No screenshot, in any task.
- **Platforms:** macOS and Linux run the setup; Windows runs nothing (no devices listener for the plugin). The device app
  on macOS (its Linux build is compiled by PR CI).
- **Repo rules:** a test that fails first, at the layer where the behavior lives; no fixed sleeps; comments say why;
  names per `docs/naming-system.md` (**Orca**, **Harness Device**, **VS Code**, **Claude Code**); English only; 100% per
  file for `cli/src/services/` (`npm run test:core`).

## Decisions the spec left to the plan

1. **The command's lines follow the editors'** (spec: "as the editors' words do"): `{"orca":"<state>"}`, plus
   `"error":"<code>"` when there is one. `on`'s `did` is never printed.
2. **`disable` with no Orca to ask** (no `orca`, Windows, a run from the sources, an Orca below the plugin's engines,
   which cannot hold it): `{"orca":"off"}`, exit 0, nothing to uninstall. An Orca that is installed and not reachable:
   `{"orca":"off","error":"not-running"}`, exit 1 (spec). A timed-out uninstall: `"timeout"`; any other: `"failed"`.
3. **A refusal whose fingerprint is off its pattern is `failed`, not `held`:** it is an answer Harness cannot read, so the
   devices try again in an hour; `held` is kept for access outside the pin.
4. **`replacements` absent or an empty array is "no replacements";** `capabilities` and `contributions` absent read as
   empty; present, each must be an array.
5. **`enable`'s `on` with `orcaConnected` not saved:** the line says `on`, stderr says `Could not save the dial
   setting.`, exit 1, as `disable` does for its mark.
6. **The tally** is `createEngineTally('[device] orca plugin', ['orca'], SETUP_COUNTS, log)`.
7. **The pass takes `setUp`, `remove` and `version` as functions,** built by `orcaPluginParts(plugin)` in
   `orcaPluginSetup.ts`, so its spec runs in memory and `devices.ts` grows by one construction and three calls.
8. **`DevicesDeps.orcaPlugin` is `OrcaPluginRun & { folder: string }`:** a spec's folder is under its throwaway data
   folder, so `devices.spec.ts` never writes the developer's own `~/.harness/orca-plugin`.
9. **At an attach the Orca pass runs after Cursor's;** at start, beside the editors' passes after Orca's homes are read.
10. **The devices-process end-to-end check is `deviceOrca.e2e.ts`'s second `describe`:** a daemon from the sources
    carries no plugin files, so it runs the bundle the file already builds (`IsolatedDaemon.create({ scriptPath })`).
    Each end-to-end case lands in the task whose change turns it green (5 and 6), so it is red first and no commit
    leaves `deviceOrcaConnect.e2e.ts` calling a `connect` that is gone.
11. **Two docs beyond the spec's list name the removed flow:** `desktop/design/desktop-design-system.md` (root AGENTS:
    the doc changes with its gallery) and `docs/cli.md`'s `harness device` rows.
12. **The README's by-hand install lines go:** their premise was "without the app"; the CLI now does it with no app.
13. **A disable owed after an install that raced it** is retried at the passes after its hour, as the editors' `undo`.

## Review Focus

1. **Orca's real refusal carries more than a fake's** (`executionDescription`, `contentIdentity`, `why`, `nextSteps`,
   `action`, `isDev`, a capability's `description`): it must still be within the pin. Task 2,
   `"Orca 1.4.262's whole refusal is within it"`.
2. **A copy change in the plugin or a scoped capability** (panel retitled, status bar text changed, `workspace:read`
   with a scope field): held, nothing approved, counted `failed · access` once a version. Task 2 (`more access is
   not`), Task 4 (`held is recorded once`).
3. **A pending install from the person's own checkout:** Harness never runs `enable <key>` on it; it installs from its
   own folder. Task 3 (`pending from another folder`).
4. **Orca quits between `status` and the install:** `failed · timeout`, nothing recorded, an hour's wait; an attach or
   a settle within it runs nothing. Task 3 (`past the deadline`), Task 4 (`the failed hour`).
5. **`harness device orca enable` while the devices' pass installs:** the second run sees `approval_stale` or `ok`;
   neither approves more than the pin, and a second refusal is never followed by a third run. Task 3 (`a second
   refusal is failed`).

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | Dial records: `orca`, `orcaHeld`, `removed.orca` | none | xhigh |
| 2 | The access Harness approves: `withinApproved` | none | xhigh |
| 3 | `orcaSetUp`, `orcaRemove`, and the fake's state | 1, 2 | xhigh |
| 4 | The devices' pass: `cable/orcaPluginSetup.ts` | 1, 3 | xhigh |
| 5 | `harness device orca status|enable|disable`, `connect` gone, end to end from the built CLI | 1, 3 | high |
| 6 | Devices: the pass at start, attach and Orca's settle, end to end at a dial's attach | 1, 4, 5 | high |
| 7 | Harness Device app (Rust): no Orca | none | high |
| 8 | Harness Device app (window) and the design doc: no Orca screen | none | high |
| 9 | Docs | none | medium |

**Longest chain:** 1 → 3 → 4 → 6, and 1 → 3 → 5 → 6 (four). Tasks 1, 2, 7, 8 and 9 start at once; 4 and 5 run
side by side.

**Task 6 waits for Task 5** for one real reason: both write `cli/e2e/deviceOrca.e2e.ts` (5 renames and rewrites it,
6 adds its second `describe`), and 6's case runs `harness device orca disable|enable`.

**Tasks that share files** (never two of a group at once; each group is ordered by its dependencies):
- `cli/src/devices/orcaPlugin.ts` and its spec: 2, 3, 5.
- `cli/src/testing/fakeOrcaCli.ts`: 3 (Tasks 5 and 6 use it unchanged).
- `cli/e2e/deviceOrca.e2e.ts`: 5, 6.

---

### Task 1: Dial records: `orca`, `orcaHeld`, `removed.orca`

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts`, `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialSetup.ts`
- Test: `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/cable/dialHomeSetup.spec.ts`, `cli/src/cable/dialSetup.spec.ts`

**Interfaces — Produces:**

```ts
// dialSkillFiles.ts
export interface DialRemoved { claude?: true; codex?: true; vscode?: true; cursor?: true; orca?: true }
export interface DialSetupRecord { dial: boolean; plugin?: string; vscode?: string; cursor?: string; orca?: string; orcaHeld?: string; homes: DialSkillHomes; pluginHomes: string[] }
// dialHomeSetup.ts (DialHomeSetup), passed through by dialSetup.ts (DialSetup)
/** A dial attached here once, the version that set Orca's plugin up or found it removed, and the version held for
 *  asking more access; undefined until the record could be read. */
orca(): { dial: boolean; version?: string; held?: string } | undefined
recordOrca(version: string): boolean      // false: not saved, and the record is as before
recordOrcaHeld(version: string): boolean
```

- [ ] **Step 1: Write the failing tests.**
  - `dialSkillFiles.spec.ts`, in `'what disable removed'`: `it('removed.orca: only true is a removal; saved and cleared
    beside the editors\', and every write keeps orcaConnected')`: a file `{"removed":{"orca":1},"orcaConnected":true}`
    reads `readRemoved(dataDir)` `{}`; `writeRemoved(dataDir, 'orca', true)` gives `{ removed: { orca: true },
    orcaConnected: true }`; with `vscode` removed too, both are kept; `writeRemoved(dataDir, 'orca', false)` leaves
    `{ removed: { vscode: true }, orcaConnected: true }`; `writeRemoved(dataDir, 'orca', true, ['/a/skills'])` writes no
    `homes`.
  - `dialSkillFiles.spec.ts`, in `'the devices\' record of a dial\'s setup'`: `it('dial-setup.json keeps orca and
    orcaHeld as it keeps cursor: a version, or nothing')`: `writeSetup` with `orca: '0.6.70', orcaHeld: '0.6.71'` reads
    back equal; for each of `true, 660, '', '../x', '0.6.60 beta', 'v'.repeat(65)` in either field the read drops that
    field; `writeSetup` with either field `'0.6.60 beta'` is `'EINVAL'` and writes nothing.
  - `dialHomeSetup.spec.ts`, with the file's `rig()`: `it('Orca\'s plugin: its version and its held version are kept
    in the record beside the dial and the editors\'')`: `orca()` is `undefined` before a read; after `started()` it is
    `{ dial: true }`; `recordOrca('0.6.70')` and `recordOrcaHeld('0.6.71')` are `true` and `orca()` is
    `{ dial: true, version: '0.6.70', held: '0.6.71' }`; `readSetup(dataDir)` keeps `vscode` written before;
    `recordOrca('0.6.72 beta')` is `false` and nothing changes, in memory or on disk.
  - `dialSetup.spec.ts`, beside `'Cursor\'s version is recorded beside VS Code\'s…'`: `it('Orca\'s versions pass
    through the dial setup\'s record')`: `r.setup.orca()`, `recordOrca`, `recordOrcaHeld` as above, `readSetup` matches.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts src/cable/dialHomeSetup.spec.ts
  src/cable/dialSetup.spec.ts -t "orca|Orca"`. Expected: FAIL (`orca` is not read, `recordOrca` is not a function).
- [ ] **Step 3: Implement.** `removedOf` reads `marks.orca === true`; `rewriteSetting` keeps `removed` when any key is
  set; `setupOf` and `writeSetup`'s `EINVAL` check take `orca` and `orcaHeld` as they take `cursor`;
  `dialHomeSetup.ts` adds the three members as `cursor()`/`recordCursor()` are built (`known` gates `orca()`), and
  `dialSetup.ts` passes them through. The header of `dialSkillFiles.ts` names `removed.orca`, `orca` and `orcaHeld`, and
  says `orcaConnected` is set by an `enable` (or 0.1.9's connect); `writeOrcaConnected`'s comment says "is not set up
  again", not "offered".
- [ ] **Step 4: Run** the Step 2 command without `-t`, and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial records: Orca's plugin version, held version and removal`.

### Task 2: The access Harness approves: `withinApproved`

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/devices/orcaPlugin.ts`
- Test: `cli/src/devices/orcaPlugin.spec.ts`

**Interfaces — Produces:**

```ts
/** What Diego agreed Harness may approve for the person (2026-11-19). A change here is that decision, reviewed. */
export const ORCA_APPROVED: {
  readonly execution: 'trusted-worker'
  readonly capabilities: readonly string[]   // ['workspace:read']
  readonly contributions: readonly string[]  // ['panels/Harness Device', 'statusBarItems/Dial', 'events/workspace.changed']
}
/** Whether an approval's `data` asks for nothing beyond ORCA_APPROVED, for [key] at [version]. */
export function withinApproved(data: unknown, key: string, version: string): boolean
```

- [ ] **Step 1: Write the failing tests** in a new `describe('withinApproved')`, using the file's `approval()` and
  `KEY`, and `readOrcaPluginBundle` from `../../scripts/lib/orcaPluginBundle.mjs` as `command.spec.ts` imports it:

```ts
/** The grants Orca lists for a manifest, by pluginContributionSummary's rules (spec, "The approved access"). */
const grantsOf = (manifest: any) => ({
  execution: manifest.execution,
  capabilities: manifest.capabilities.map(({ kind }: { kind: string }) => ({ kind, description: 'Orca words it' })),
  contributions: [
    ...(manifest.contributes.panels ?? []).map((p: any) => ({ kind: 'panels', name: p.title })),
    ...(manifest.contributes.statusBarItems ?? []).map((s: any) => ({ kind: 'statusBarItems', name: s.text || s.id })),
    ...(manifest.contributes.events ?? []).map((e: any) => ({ kind: 'events', name: e.on })),
  ],
})

it('the grants Orca would list for the shipped orca-plugin.json are within it: a manifest that adds access fails here', () => {
  const manifest = JSON.parse(JSON.parse(readOrcaPluginBundle('1.2.3'))['orca-plugin.json'])
  expect(withinApproved({ pluginKey: KEY, version: '1.2.3', approvalFingerprint: FINGERPRINT, grants: grantsOf(manifest) }, KEY, '1.2.3')).toBe(true)
})

it("Orca 1.4.262's whole refusal is within it", () => {
  expect(withinApproved(approval('approval_required').error.data, KEY, '1.2.3')).toBe(true)
})
```

  - `it.each` `'more access is not: %s'`, each `withinApproved(data with one change, KEY, '1.2.3') === false`: execution
    `'trusted-host'`; a second capability `{ kind: 'agent:read', description: 'x' }`; `{ kind: 'workspace:read',
    description: 'x', scope: { workspaces: '*' } }`; a contribution `{ kind: 'commands', name: 'Harness' }`; the panel
    as `{ kind: 'panels', name: 'Dial' }`; `replacements: [{ command: 'x', action: 'open' }]`.
  - `it('no replacements: absent or empty')`: `replacements: []` is within.
  - `it.each` `'a field of another shape is not: %s'`: `data` `null`; `grants` a string; `capabilities` an object; a
    capability `'workspace:read'`; `contributions` `{}`; a contribution with no `name`; `execution` `1`.
  - `it('another key or version is not')`: `pluginKey: 'local.other'`; `version: '1.2.4'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPlugin.spec.ts -t withinApproved`. Expected: FAIL
  (`withinApproved` is not exported).
- [ ] **Step 3: Implement** `ORCA_APPROVED` and `withinApproved` in `orcaPlugin.ts` beside `ORCA_FINGERPRINT`, with the
  comment saying why a capability with any other key is refused (Orca counts a capability by its whole object). Nothing
  else in the file changes in this task.
- [ ] **Step 4: Run** `npx vitest run src/devices/orcaPlugin.spec.ts && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `Orca plugin: the access Harness may approve for the person`.

### Task 3: `orcaSetUp`, `orcaRemove`, and the fake's state

**Depends on:** 1 (`readSetup(...).orca`), 2 (`withinApproved`). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/devices/orcaPlugin.ts`, `cli/src/testing/fakeOrcaCli.ts`
- Test: `cli/src/devices/orcaPlugin.spec.ts`

**Interfaces — Consumes:** Task 1's `readSetup(dataDir).orca`; Task 2's `withinApproved`, `ORCA_FINGERPRINT`.

**Interfaces — Produces:**

```ts
// orcaPlugin.ts. ORCA_CONNECT_MS becomes ORCA_CHANGE_MS (60_000); orcaConnect uses it until Task 5 deletes orcaConnect.
export const ORCA_CHANGE_MS = 60_000
/** The version in the orca-plugin.json cli.js carries; null in a run from the sources. */
export function carriedVersion(run: Pick<OrcaPluginRun, 'files'>): string | null
export type OrcaSetUp =
  | { orca: 'on'; did?: 'set up' | 'updated' }   // did: none when it was current and nothing ran
  | { orca: 'held' }
  | { orca: 'off' }
  | { orca: 'absent'; error: 'not-running' | 'old' | 'other' }   // 'other': Q1, decided
  | { orca: 'failed'; error: 'timeout' | 'failed' | 'folder' }
export function orcaSetUp(deps: OrcaPluginDeps, opts: { force: boolean }): Promise<OrcaSetUp>
export type OrcaRemove = { orca: 'off' } | { orca: 'off'; error: 'not-running' | 'timeout' | 'failed' }
export function orcaRemove(deps: OrcaPluginDeps): Promise<OrcaRemove>

// testing/fakeOrcaCli.ts
export type FakeOrcaWord = 'status' | 'plugin inspect' | 'plugin list' | 'plugin install' | 'plugin update' | 'plugin enable' | 'plugin uninstall'
export interface FakeOrcaPlugin { key: string; version: string; fingerprint: string; grants: Record<string, unknown> }
// FakeOrcaCli gains:
/** No answers and no plugin: every word exits 1. */
reset(): void
/** From now on an Orca that runs, at 1.4.262, holding [plugin]'s approvals: `status` and `plugin inspect` answer so;
 *  `plugin install <folder>`, `update <key>` and `enable <key>` without `--approve <fingerprint>` exit 3
 *  `approval_required` (data: pluginKey, name, version, approvalFingerprint, grants), and with it exit 0 and leave the
 *  entry `running` at [version] from the folder `install` was handed, by its real path (`update` and `enable` keep the
 *  entry's); `plugin uninstall <key>` removes it; `plugin list` lists it. A word given an `answer` answers that. */
holds(plugin: FakeOrcaPlugin): void
/** The person turned it off in Orca: the entry lists `status: disabled`. */
disable(): void
/** What `plugin list` lists now; undefined with no entry. */
entry(): Record<string, unknown> | undefined
```

What `orcaSetUp` decides (the spec's "Setting it up", which the signature does not determine):

- `find(deps, force)`: "set up before" is `readSetup(dataDir).orca` set, or `readOrcaConnected(dataDir).connected`;
  `orcaHeld` alone is not. Without `force`, a record that cannot be read is `absent · not-running`, as today; with
  `force` neither record is read. `approve` and a `disabled` entry carry `ours` (`fromFolder`) as `behind` does. An
  entry `isDev`, `errored` or `invalid` is `absent · other` (Q1, decided; today's rule 1 and 6 say `absent`). Below
  `engines.orca`: `absent · old`. No `orca`, Windows, not reachable, from the sources: `absent · not-running`. The
  folder not written: `failed · folder` (the `err` line as today).
- The word: `offer`, and `behind` not `ours` → `install <folder>`; `behind` `ours` → `update <key>`; `approve` →
  `enable <key>` when `ours`, else `install <folder>`; `off` without `force` → `{ orca: 'off' }`; `off` with `force`:
  a disabled entry → `enable <key>` when `ours`, else `install <folder>`; no entry → `install <folder>`; `current` →
  `{ orca: 'on' }`. `did` is `'set up'` when no entry was listed, else `'updated'`.
- The answer: `ok` → `on`. `approval_required` or `approval_stale`: `withinApproved(data, key, version)` false → `held`;
  fingerprint off `ORCA_FINGERPRINT` → `failed · failed`; else the same arguments once more with `--approve <fp>`, whose
  answer is `on` for `ok` and `failed · failed` for any other. A run past `ORCA_CHANGE_MS` → `finished()` → `on` or
  `failed · timeout`. Anything else → `failed · failed`. Orca's message is never read.
- `orcaRemove`: Windows, sources, no `orca`, or below the engines → `{ orca: 'off' }` with only `status` run; not
  reachable → `not-running`; the folder written (as `find` does) and `inspect`ed for the key; no entry with that key →
  `{ orca: 'off' }`; else `plugin uninstall <key> --json` within `ORCA_CHANGE_MS`: `ok` → `off`, past it → `timeout`,
  else `failed`.

- [ ] **Step 1: Write the failing tests.** `setup()` calls `orca.reset()` first; the `connect` and `orcaStatus` cases
  set their answers as today. New `describe('orcaSetUp')`, each with `orca.holds({ key: KEY, version: '1.2.3',
  fingerprint: FINGERPRINT, grants: <the pinned grants of approval()> })` unless it says otherwise; `folder` is
  `setup()`'s, real path:
  - `'not installed: installed from the folder, refused, then approved with Orca\'s fingerprint'`:
    `{ orca: 'on', did: 'set up' }`; `calls()` is `['status --json', \`plugin inspect ${folder} --json\`,
    'plugin list --json', \`plugin install ${folder} --json\`, \`plugin install ${folder} --approve ${FINGERPRINT} --json\`]`;
    `orca.entry()` `{ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } }` (subset).
  - `'installed from the folder at another version: updated, refused, approved'`: an entry at `1.2.2` from `folder`
    (`answer('plugin list', …)` then `holds` keeps it) → `plugin update local.harness-device --json`, then with
    `--approve` → `did: 'updated'`.
  - `'an update that asks for nothing new goes through with no --approve'`: `answer('plugin update', installed(folder))`
    → `{ orca: 'on', did: 'updated' }`, no call holds `--approve`.
  - `'pending from the folder: enabled, then approved'` and `'pending from another folder (a person\'s checkout):
    installed from the folder, never enabled'`: the second has no call starting `plugin enable`.
  - `'more access: held, and nothing approved'`: `grants` with `{ kind: 'agent:read', … }` added → `{ orca: 'held' }`;
    no call holds `--approve`; an installed entry keeps its version.
  - `'a refusal for another key or version: held'`.
  - `'a second refusal is failed, never a third run'`: `answer('plugin install', approval('approval_stale'), 3)` →
    `{ orca: 'failed', error: 'failed' }`; exactly two `plugin install` calls.
  - `'a fingerprint off its pattern: failed, nothing approved'`.
  - `"Orca's other errors are failed, and its message is never read"`: an error whose message holds
    `/SECRET-PATH-MARKER` → `failed · failed`, and `JSON.stringify(result)` holds no marker.
  - `'past the deadline: on when Orca lists it as asked, else timeout'`, as the file's `'past its deadline'` cases build
    their slow `run`.
  - `'removed: off with nothing run after the list'` for no entry and `dial-setup.json` `orca` set
    (`writeSetup`), for no entry and `orcaConnected`, and for a `disabled` entry; `'orcaHeld alone is not set up
    before: installed'`.
  - `'with force: a disabled entry from the folder is enabled, one from another folder installed, a missing one
    installed'`, each approved.
  - `'no Orca to ask'`: Windows, `files: () => null`, `orca: () => null`, not reachable → `absent · not-running`, with at
    most `status` run; `1.4.247` → `absent · old`; an entry `isDev`, `errored`, `invalid` → `absent · other` (Q1).
  - `'a folder that cannot be written: failed · folder, its code said through err alone'`.
  - `'a record that cannot be read, without force: absent · not-running, nothing installed'`.
  - `'current: on, nothing run after the list'`.
  - New `describe('orcaRemove')`: `'uninstalls the entry with the plugin\'s key'` (last call
    `plugin uninstall local.harness-device --json`, `entry()` undefined, `{ orca: 'off' }`); `'no entry: off, no
    uninstall'`; `'not reachable: off · not-running'`; `'no Orca to ask: off, nothing but status'`; `'past its deadline:
    off · timeout'`; `"Orca's error: off · failed"`.
  - `it('carriedVersion: the manifest\'s version, null from the sources')`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPlugin.spec.ts`. Expected: FAIL (`orcaSetUp`,
  `orcaRemove`, `orca.holds` missing).
- [ ] **Step 3: Implement** the fake's state in its shell script (files in its folder, the folder's real path through
  `cd … && pwd -P`, the word list gaining `uninstall`), then `find(deps, force)`, `orcaSetUp`, `orcaRemove` and
  `carriedVersion` in `orcaPlugin.ts`. `orcaConnect` and `orcaStatus` keep their behaviour.
- [ ] **Step 4: Run** `npx vitest run src/devices/orcaPlugin.spec.ts src/deviceClaude/command.spec.ts &&
  npx tsc --noEmit -p .`. Expected: PASS (the command's `connect` cases are unchanged).
- [ ] **Step 5: Commit** `Orca plugin: set up and removed for the person, approving only the pinned access`.

### Task 4: The devices' pass: `cable/orcaPluginSetup.ts`

**Depends on:** 1 (`DialRemoved.orca`), 3 (`orcaSetUp`, `orcaRemove`, `carriedVersion`). **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/orcaPluginSetup.ts`
- Test: `cli/src/cable/orcaPluginSetup.spec.ts`

**Interfaces — Produces:**

```ts
export interface OrcaPluginSetupDeps {
  platform: NodeJS.Platform
  /** The carried orca-plugin.json's version; null in a run from the sources. */
  version(): string | null
  /** orcaSetUp(plugin, { force: false }). */
  setUp(): Promise<OrcaSetUp>
  /** orcaRemove(plugin). */
  remove(): Promise<OrcaRemove>
  /** dial-skill.json's removals, read anew at each call. */
  removed(): Read<DialRemoved>
  /** dial-skill.json's orcaConnected (0.1.9's click, or an enable), read anew. */
  connected(): Read<{ connected: boolean }>
  /** dialSetup's orca(). */
  recorded(): { dial: boolean; version?: string; held?: string } | undefined
  record(version: string): boolean
  recordHeld(version: string): boolean
  after(ms: number, run: () => void): void
  /** One event in the day's tally; [reason] a fixed word. */
  count(kind: SetupCount, reason?: string): void
}
/** One pass at a time; never rejects. */
export interface OrcaPluginSetup { pass(): Promise<void> }
export function createOrcaPluginSetup(deps: OrcaPluginSetupDeps): OrcaPluginSetup
/** The Orca half of the deps, on the real orcaSetUp, orcaRemove and carriedVersion. */
export function orcaPluginParts(plugin: OrcaPluginDeps): Pick<OrcaPluginSetupDeps, 'platform' | 'version' | 'setUp' | 'remove'>
```

The pass, in order (the spec's "The devices' pass"; shape and `undo` as `vscodeExtensionSetup.ts`):
1. Windows, a pass running, or a waiting hour: return. `version()` null: return.
2. `removed()` or `connected()` unread, or `recorded()` undefined: return. `removed().orca`: an owed undo runs, then
   return.
3. `recorded.version` or `recorded.held` equals the version: return, with no Orca run.
4. No `recorded.version`, not `connected`, and not `recorded.dial`: return.
5. `setUp()`:
   - `on`: `removed()` read again; `orca` → `remove()` (owed until it ends `off` with no error; a failure counts its
     reason and waits the hour); unread → nothing; else `record(version)`, and count `did` when there is one.
   - `off`: `record(version)`, count `left removed`.
   - `held`: `recordHeld(version)`, count `failed · access`.
   - `absent · not-running`: nothing. `absent · old` or `· other`: the hour, nothing counted.
   - `failed`: count `failed · <error>` and the hour.
   - A record not saved: `failed · save` and the hour. A throw: `failed · error`, never its message, and the hour.
6. The hour: `after(3_600_000, …)` clears the wait and runs a pass.

- [ ] **Step 1: Write the failing tests**, in memory as `vscodeExtensionSetup.spec.ts` builds its `rig()`: `setUp` and
  `remove` are `vi.fn`s answering from a queue (default `{ orca: 'on', did: 'set up' }` and `{ orca: 'off' }`),
  `version` `'9.9.9'`, the records in memory, `after` keeps its timers. `describe('Harness Device\'s plugin for Orca,
  set up from the devices\' process')`:
  - `'a dial attached here: set up once, recorded at this version and counted set up'` (`counted` `[['set up']]`,
    record `'9.9.9'`, a second pass calls `setUp` no more).
  - `'no dial yet: nothing runs, nothing is recorded; set up before by orcaConnected, it is brought current'`.
  - `'recorded at this version, or held at it: no Orca run'`.
  - `'recorded at another version: brought current and counted updated'`.
  - `'removed by harness device orca disable: nothing runs, at this version or another'`.
  - `'uninstalled or disabled in Orca (off): recorded, left removed counted once a version'`.
  - `'a disable that lands during the install: removed again, nothing recorded'` (removal set inside `setUp`); and
    `'the removal it owes is tried again after its hour when it fails'`.
  - `'a removal that cannot be read after the install: nothing undone, nothing recorded'`.
  - `'held is recorded once, as orcaHeld, never as the version, and counted failed · access'`.
  - `'Orca not running: nothing recorded or counted, and the next pass runs'`; `'Orca too old, or a plugin Orca keeps
    as it is: an hour, nothing counted'` (Q1 for the second).
  - `'the failed hour: counted with its reason; a pass within it runs nothing; the hour runs one'`.
  - `'a record not saved: failed · save, and an hour'`; `'a throw: failed · error, never its words'` (the thrown
    `Error('EACCES /SECRET-MARKER')`; no `counted` entry holds `SECRET`).
  - `'unread removals, an unread orcaConnected or a record not yet read: nothing'`.
  - `'Windows, and a run from the sources: nothing'`.
  - `'one pass at a time: one asked while another sets up runs nothing'`.
  - `'orcaPluginParts: the carried version, null from the sources'` (with an `OrcaPluginDeps` whose `files()` is null,
    then a manifest at `1.2.3`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/orcaPluginSetup.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `orcaPluginSetup.ts`, its header saying why (the spec's "Why" and decisions 2, 4, 6) and
  naming `vscodeExtensionSetup.ts` as its model. It logs nothing.
- [ ] **Step 4: Run** the Step 2 command, `npx vitest run src/architecture.failureLogs.spec.ts` and
  `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `Devices: Orca's plugin set up once a dial has attached, kept current, the person's removal kept`.

### Task 5: `harness device orca status|enable|disable`, `connect` gone, end to end from the built CLI

**Depends on:** 1 (`writeRemoved(…, 'orca', …)`, `orcaHeld`), 3 (`orcaSetUp`, `orcaRemove`, the fake's state).
**Effort:** high.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/devices/orcaPlugin.ts`, `cli/src/devices/orcaPluginFolder.ts`
  (header only)
- Test: `cli/src/deviceClaude/command.spec.ts`, `cli/src/devices/orcaPlugin.spec.ts`
- Rename and rewrite: `cli/e2e/deviceOrcaConnect.e2e.ts` → `cli/e2e/deviceOrca.e2e.ts` (`git mv` in the red commit)

**Interfaces — Produces:**

```ts
// orcaPlugin.ts
export type OrcaPluginState = 'on' | 'off' | 'held' | 'setup' | 'absent'
export function orcaStatus(deps: OrcaPluginDeps): Promise<{ orca: OrcaPluginState }>
// Deleted: orcaConnect, OrcaConnect, OrcaConnectError, ORCA_GRANTS_MAX, ORCA_GRANT_MAX_CHARS, UNSHOWN, line(),
// grantLines(), approval(). ORCA_FINGERPRINT stays, no longer exported.
```

`orcaStatus`, first rule that holds (Q2, decided): `removed.orca` → `off`, asking Orca nothing; `find()` absent (any
reason) → `absent`; `find()` off → `off`; current → `on`; `dial-setup.json` `orcaHeld` is the carried version → `held`;
anything else → `setup`. The folder is written before Orca is asked about it, as today.

Lines (Decision 1): `status` → `{"orca":"<state>"}` (pretty without `--json`), exit 0 always. `enable` → `writeRemoved
(dataDir, 'orca', false)` first (not saved: `Could not save the dial setting.` on stderr, exit 1, nothing run), then
`orcaSetUp({ force: true })` → `{"orca":"on"}` and `writeOrcaConnected` (exit 0; not saved: Decision 5),
`{"orca":"held"}`, `{"orca":"absent","error":"<code>"}`, `{"orca":"failed","error":"<code>"}`, each exit 1. `disable`
→ `writeRemoved(dataDir, 'orca', true)` first, then `orcaRemove` whatever the save did → its line; exit 1 for an
`error` or a mark not saved. `connect`, and any other word, prints the usage on stderr, exit 1. `link` is unchanged.

`DEVICE_USAGE`, exactly: its first line's `and VS Code and Cursor to follow it` becomes `and VS Code, Cursor and Orca
to follow it`, and after the two Cursor lines:

```
  harness device orca enable             set Orca up again: Harness's plugin in it
  harness device orca disable            remove Harness's plugin; Harness leaves it removed
```

- [ ] **Step 1: Write the failing tests.**
  - `command.spec.ts`: `describe('harness device orca status and connect')` becomes `describe('harness device orca
    status, enable and disable')`, on the file's one fake with `fake.holds(…)` (pinned grants, `1.2.3`, `FP`):
    `'status follows Orca and the records: setup, on, off, held, absent'` (exit 0 each); `'enable installs with Orca\'s
    fingerprint, prints on, records orcaConnected and clears the removal'`; `'enable while Orca is not running: absent
    · not-running, exit 1'`; `'enable with more access than the pin: held, exit 1, no --approve'`; `'enable after a
    removal installs again'`; `'disable marks it removed, then uninstalls: off, exit 0'`; `'disable with Orca not
    running: the removal saved, off · not-running, exit 1'`; `'disable with no Orca on this computer: off, exit 0'`;
    `'a mark that cannot be saved: said on stderr, exit 1'`, for both words; `'connect is gone: the usage, exit 1, Orca
    asked nothing'`, for `connect`, `connect --json` and `connect --approve <FP> --json`.
  - `command.spec.ts`'s usage case lists the two new lines and the new first line.
  - `orcaPlugin.spec.ts`: `'each rule, in order'` becomes the five states; the `describe('connect')` cases and the
    bounds cases (`the grants' bounds`, `a line with a character it cannot show`, `an approval with no grant left`)
    are deleted.
  - `deviceOrca.e2e.ts` (renamed), keeping its bundle (`E2E_BUNDLE_PATH`, else one built in `beforeAll`), `machine()`,
    `pluginFolder()`, `record()` and `modes()`, with a `PINNED` grants constant (the pinned set in Orca 1.4.262's
    shape) handed to `orca.holds(…)` at the build's version. `describe('harness device orca, from the built CLI')`:
    - `'status, enable, disable and enable again, against an Orca that holds the plugin\'s approvals'`: `status
      --json` is `{"orca":"setup"}\n` exit 0 and the build's plugin is written private at the build's version (the
      file's `modes()` check, kept); `enable` is `{"orca":"on"}\n` exit 0, the calls end `plugin install <folder>
      --json`, `plugin install <folder> --approve <FP> --json`, and `record(d)` has `orcaConnected: true` and no
      `removed`; `status` `on`; `disable` is `{"orca":"off"}\n` exit 0, its last call `plugin uninstall
      local.harness-device --json`, `orca.entry()` undefined, `record(d).removed` `{ orca: true }`; `status` `off`;
      `enable` is `on` again.
    - `'more access than the pin: enable holds it and approves nothing'`: `PINNED` plus `{ kind: 'agent:read', … }` →
      `{"orca":"held"}\n` exit 1; no call holds `--approve`.
    - `'an Orca that is not running is absent, and nothing is written'`, kept as it is.
    - `'connect is gone: the usage, exit 1, Orca asked nothing'`.
    The file's header says what it checks now and names this spec.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts src/devices/orcaPlugin.spec.ts` and
  `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceOrca.e2e.ts`. Expected: FAIL
  (`enable` prints the usage; `status` prints `offer`).
- [ ] **Step 3: Implement.** `runDeviceCommand` routes `orca <word>` as it routes the editors' words, `link` first;
  `orcaCommand(verb, json, deps)` builds `OrcaPluginDeps` as today. Rewrite `command.ts`'s header and the comment
  above `DEVICE_USAGE` (`orca status` stays out of the usage, as the editors' `status`), `orcaPlugin.ts`'s header (it
  runs in the `harness` command's process and in the devices' process, never the core's), and
  `orcaPluginFolder.ts`'s header (the command and the devices write the folder, each into its own staging folder).
- [ ] **Step 4: Run** the Step 2 commands, `npx vitest run src/architecture.failureLogs.spec.ts
  src/config/harnessHome.guard.spec.ts`, `npx tsc --noEmit -p .`, and `grep -rn "orcaConnect\|ORCA_GRANTS_MAX\|
  connect_orca" src e2e` (no hit). Expected: PASS.
- [ ] **Step 5: Commit** `harness device orca: enable and disable; connect is gone`.

### Task 6: Devices: the pass at start, attach and Orca's settle, end to end at a dial's attach

**Depends on:** 1 (`skill.orca()`, `recordOrca`, `recordOrcaHeld`), 4 (`createOrcaPluginSetup`, `orcaPluginParts`),
5 (`deviceOrca.e2e.ts`, and the `disable`/`enable` words its case runs). **Effort:** high.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`, `cli/e2e/deviceOrca.e2e.ts` (a second `describe`)

**Interfaces — Consumes (end to end):** `IsolatedDaemon.create({ scriptPath, env })` (`e2e/harness/daemon.ts`),
`Desk` (`e2e/harness/desk.ts`), `FakeDial` (`e2e/harness/fakeDial.ts`), the file's `fakeOrcaCli` written through the
daemon's `bin/orca` link into its launcher, and the environment `devicesProcess.e2e.ts`'s `fresh()` sets
(`CABLE_DISABLE: 'false'`, `HARNESSD_TEST_DIAL_PORT`, the service backoff variables).

**Interfaces — Produces:** `DevicesDeps.orcaPlugin?: OrcaPluginRun & { folder: string }` ("For this service's tests:
Orca's CLI, the plugin's files and its folder; this computer's `orca` and `harnessPath('orca-plugin', homedir())` when
unset").

The edit, whole: one tally `createEngineTally('[device] orca plugin', ['orca'], SETUP_COUNTS, log)`; `orcaSetup = skill ?
createOrcaPluginSetup({ ...orcaPluginParts({ ...(deps.orcaPlugin ?? { ...orcaPluginRun(), folder:
harnessPath('orca-plugin', homedir()) }), dataDir: core.dataDir, err: () => {} }), removed: () =>
readRemoved(core.dataDir), connected: () => readOrcaConnected(core.dataDir), recorded: () => skill.orca(), record: (v)
=> skill.recordOrca(v), recordHeld: (v) => skill.recordOrcaHeld(v), after: timerIn('orcaPlugin'), count: (kind,
reason) => orcaCount('orca', kind, reason) }) : null` beside `cursorSetup`, with a comment (why `err` says nothing: the
reason `folder` is counted, its errno never logged); `part.call('orcaPlugin', () => orcaSetup.pass())` in the start's
`orcaHomes.refresh().then` after Cursor's, in `watching(on)` after Cursor's, and in `appSettled` for `app === 'orca'`
whenever `orcaSetup` exists (not gated on `observed`).

- [ ] **Step 1: Write the failing tests.** A `fakeOrcaPlugin({ running, installed })` beside `fakeVscode()`: an
  in-memory `OrcaPluginRun & { folder }` whose `run` records each run's arguments and answers `status` (reachable at
  `1.4.262` when `running`), `plugin inspect` (`local.harness-device`), `plugin list` (the entry, its `reference`
  `realpathSync(folder)`: a throwaway data folder under macOS's `/var` is `/private/var`), install-type runs (exit 3
  `approval_required` with the pinned grants, version `9.9.9`, `ap1-` + 32 hex; with `--approve` that fingerprint,
  exit 0 and an entry); `files()` a manifest at `9.9.9`, `engines.orca` `>=1.4.248`; `folder` `join(dataDir,
  'orca-plugin')`. `start()` gains `orcaPlugin?: … | null`, defaulting to `fakeOrcaPlugin({ running: false }).deps`,
  so no case runs this computer's `orca`. New `describe('Harness Device\'s plugin for Orca, set up from the devices\'
  own process (cable/orcaPluginSetup.ts)')`:
  - `'a dial\'s first attach installs it, approves the pinned access, records it and counts it set up'`: nothing runs at
    start; after `seen.host.watching!(true)`, the runs end `plugin install <folder> --json`, `plugin install <folder>
    --approve <fp> --json`; `readSetup(dataDir).orca` `'9.9.9'`; the tally lines `['[device] orca plugin · orca · set
    up']` and the day line `/^\[device\] orca plugin · day \d{4}-\d\d-\d\d · orca set up 1 updated 0 failed 0 left
    removed 0$/`; a replug runs nothing more.
  - `'set up before at another version: brought current at the start, a dial here or not'` (`writeSetup` with
    `orca: '0.0.1'`, an entry at `0.0.1` from the folder) → `plugin update`, `updated`.
  - `it.each` over `HARNESS_DEVICE_OBSERVED` unset and set: `'Orca settling in front runs a pass (%s)'`: Orca not
    running at the attach (`status` alone), then running, then `seen.host.appSettled!('orca')` → installed.
  - `'in the core\'s process (no listener): nothing, at a start, an attach or a settle'`.
  - `'unset: this computer\'s orca, the folder in Harness\'s data root, the core\'s data folder'`:
    `vi.spyOn(orcaPluginModule, 'orcaPluginRun')` returns a not-running fake, `vi.spyOn(orcaPluginSetupModule,
    'orcaPluginParts')` keeps its argument; `start({ orcaPlugin: null, … })`; the argument's `folder` is
    `harnessPath('orca-plugin', homedir())` and `dataDir` the spec's; nothing is written there.
  - `'a folder that cannot be written: failed · folder; no line holds its path or its code'` (`folder` under a regular
    file: `ENOTDIR`).
  - `'a throw there costs the dial nothing'` (`faults: ['fleet', 'orcaPlugin']` → `'[devices] orcaPlugin failed ·
    Error'`, the dial setup's start still runs).
  - `deviceOrca.e2e.ts`, `describe('the devices process sets the plugin up')`, one daemon on the file's bundle
    (`scriptPath`): `it('a dial\'s attach installs and approves the plugin with no command; after a disable a replug
    asks Orca nothing; enable brings it back')`:
    - Before `d.start()`, the fake `holds(PINNED)` at the build's version. Plug `E2E-A`; `until('the plugin set up',
      …)` reads `dial-setup.json`'s `orca` equal to that version (60 s).
    - The fake's calls hold `plugin install <folder> --json`, then `plugin install <folder> --approve <FP> --json`;
      `orca.entry()` runs from the folder.
    - `d.log()` holds `[device] orca plugin · orca · set up`; no line holds `FP`, the folder, `local.harness-device`
      or the `workspace:read` description.
    - `harness device orca disable` from the bundle with `d.env` prints `{"orca":"off"}`. Note the calls' length;
      unplug and plug `E2E-A`, send `{ t: 'agents.list' }` and wait for its `agents.end`: the calls since hold no
      `status --json` and no `plugin install|update|enable`. (A removed pass returns before its first `await`, in the
      attach's own moment; this order catches a pass that asks Orca, and Task 4's spec pins the rule exactly.)
    - `harness device orca enable` prints `{"orca":"on"}`; the entry is back.
    - `onTestFailed` prints the daemon log's last 200 lines, as `devicesProcess.e2e.ts` does.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "plugin for Orca"` and
  `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceOrca.e2e.ts -t "devices process"`.
  Expected: FAIL (nothing installs; the record never holds `orca`).
- [ ] **Step 3: Implement** the edit above. Nothing else in `devices.ts` changes.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts && npx tsc --noEmit -p . && npm run test:core`, and
  the whole `e2e/deviceOrca.e2e.ts`. Expected: PASS, `src/services/devices.ts` at 100% (lines, branches, functions,
  statements).
- [ ] **Step 5: Commit** `Devices: Orca's plugin set up at the start, at each attach and when Orca settles in front`.

### Task 7: Harness Device app (Rust): no Orca

**Depends on:** none. **Effort:** high.

**Files:**
- Delete: `device-app/src-tauri/src/orca_cli.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (`pub mod orca_cli`), `types.rs` (`Screen::Orca`; `Phase::Asking`,
  `Approve`, `Done`; `View.update`; `Action::ConnectOrca`; `MenuAction::Orca`; `AppState.orca`; `OrcaState`,
  `Fingerprint`, `OrcaStatus`, `OrcaError`, `OrcaAnswer`; `Event::OrcaConnect`, `OrcaStatus`; `Effect::RunOrcaConnect`,
  `RunOrcaStatus`), `app.rs` (the Orca constants, fields, runs, `Silent`, the menu-open and CLI-version asks, the row's
  and the action's arms, `orca_*` fns, `relaunch_waits`'s Orca clause), `runner.rs` (the two effect arms), `model.rs`
  (the row), `main.rs` (the `orca` menu id), `cli.rs` (`name()`'s `--approve` redaction)
- Test: the `#[cfg(test)]` modules of those files. `tabs.rs`, `tabs_macos.rs` and `front*.rs` keep their Orca (the app
  in front).

- [ ] **Step 1: Write the failing tests:**
  - `model.rs`: `no_orca_row_in_any_state`: for every `states()`, no menu item's `{:?}` contains `"Orca"`.
  - `runner.rs`: `from_start_to_dial_connected` expects the calls `["--version", "auth status --json", "hardware
    watch --json"]`, waiting on the dial, the sign-in and the version alone.
  - `app.rs`: `the_menu_opening_runs_nothing_of_orca`: a found app, past five minutes, `Event::MenuOpened`: no effect's
    `{:?}` contains `"Orca"`; and `a_new_cli_version_runs_nothing_of_orca`.
  - `cli.rs`: `a_run_is_named_by_every_argument`: `name(&["x", "--approve", "y"])` is `"harness x --approve y"`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: FAIL (the four above).
- [ ] **Step 3: Implement** the removal. Every test that only exercised Orca goes (`the_orca_row_sits_under…`,
  `an_orca_run_delays_the_relaunch`, `from_the_row_to_orca_connected`, the Orca screen's, `types.rs`'s Orca JSON
  cases, `cli.rs`'s connect naming case); `states()` loses its Orca loop.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked --lib` (on a Mac, which compiles the macOS code PR
  CI does not), and `grep -rni "orca" src | grep -v "tabs"` (only comments that name Orca as an app in front, or none).
  Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: no Orca row, run or screen state; the devices set the plugin up`.

### Task 8: Harness Device app (window) and the design doc: no Orca screen

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `device-app/ui/src/api.ts` (`Screen` loses `'orca'`, `Phase` loses `'asking' | 'approve' | 'done'`, `View`
  loses `update`, `Action` loses `'connect_orca'`), `screens.ts` (the Orca faces, the grants list, the focus exception),
  `gallery.ts` (the six Orca states and their constants), `styles.css` (`.grants` and its scrollbar)
- Modify: `desktop/design/desktop-design-system.md`, the Harness Device section: "sign-in is the one thing it offers";
  "Claude Code, Codex and Orca need no setting"; two screens, Install and Sign in; the two Orca bullets go; the menu
  sketch loses `Connect Orca…`; the gallery sentence loses "except on the Orca screen".
- Test: `device-app/ui/src/gallery.test.ts`, `device-app/ui/src/screens.test.ts`

- [ ] **Step 1: Write the failing test:** `gallery.test.ts`'s `CONTRACT_PAIRS` loses the four `orca.*` pairs and
  `expect(STATES).toHaveLength(8)`.
- [ ] **Step 2: Run** `cd device-app/ui && npm ci && npm test -- gallery`. Expected: FAIL (14 states).
- [ ] **Step 3: Implement** the removal; `screens.test.ts` loses its `orca:` cases and the table's `orca` rows, and its
  focus case says the primary button has the focus on every screen that has one.
- [ ] **Step 4: Run** `cd device-app/ui && npm run typecheck && npm test && npm run build && npm run gallery`, then
  `grep -rni "orca" src` (no hit). Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device window: no Orca screen; the design doc follows`.

### Task 9: Docs

**Depends on:** none. **Effort:** medium. **One commit, no red test.**

**Files:**
- Modify: `device-app/AGENTS.md`: the intro loses the `Connect Orca…` sentence and says "It has no row for Claude Code,
  Codex or Orca: the devices service sets them up"; "the window's two screens"; Fixed arguments loses `device orca
  status --json` and `device orca connect --json`, says "one of four action names (`retry`, `sign_in`, `later`,
  `cancel`)", and "One argument is not fixed text" (the zip), the fingerprint sentences gone; One log loses "Nothing
  Orca lists is logged…".
- Modify: `plugins/harness-device-orca/README.md`: Install becomes, in these words: "Harness sets this plugin up for
  you once a dial has attached on this computer and Orca runs, and keeps it current as Harness updates. Harness
  approves this plugin in Orca for you, with read-only access to your workspaces. Remove it in Orca, or run `harness
  device orca disable`, and Harness will not install it again; `harness device orca enable` brings it back. An update
  that asks for more access is not approved." The by-hand `orca plugin install` lines and "Without the app" go; the
  Orca and platform line stays.
- Modify: `cli/AGENTS.md`, the devices row: after Cursor's clause, one clause: "Harness Device's plugin for Orca
  (`plugins/harness-device-orca`), set up as the extension is, at the process's start, at each attach, when Orca
  settles in front and an hour after a failed pass (`cable/orcaPluginSetup.ts`, `devices/orcaPlugin.ts`): installed
  once a dial has attached here and Orca runs, through Orca's own `orca plugin install`, `update` or `enable`, up to
  60 s each, approved with `--approve` only when everything Orca lists is the pinned access (a trusted worker,
  `workspace:read`, its panel, its status bar item and `workspace.changed`) and held otherwise, recorded under `orca`
  or `orcaHeld` in `dial-setup.json`, brought current after each CLI update, and never installed again once the person
  removed it in Orca or `harness device orca disable` marked it removed in `dial-skill.json`". Only that clause is
  added to the line, so a rebase over another branch's edit of the row stays small.
- Modify: `docs/cli.md`: a row after the editors': `` `harness device orca enable` · `disable` `` | "From the first dial
  plugged in on this computer, the devices service installs Harness Device's plugin into Orca by itself, approving
  for you only its read-only access to your workspaces, and keeps it current as Harness updates; an update that asks
  for more access is not approved. These take that away or bring it back: `disable` uninstalls it, and Harness leaves
  it removed · `enable` clears that and installs it. Each prints one JSON line, `{"orca":"on"}` or `{"orca":"off"}`."

- [ ] **Step 1:** Make the four edits.
- [ ] **Step 2:** `grep -rn "Connect Orca\|orca connect\|connect_orca" device-app cli/AGENTS.md docs/cli.md plugins
  desktop/design` shows no hit outside `docs/plans/`.
- [ ] **Step 3: Commit** `Docs: Orca's plugin is set up by default`.

---

## Questions the PM answered (2026-11-19, on Diego's behalf): both as recommended

1. **Q1. An entry Orca lists as a development install (`isDev`), `errored` or `invalid`.** #4446's rules 1 and 6 make
   it `absent`; the spec's pass handles `absent · not-running` by passing again at every start, attach and Orca
   settle, which here runs `status`, `inspect` and `list` (about a second of Orca's CLI) each time Orca comes to the
   front, for as long as the entry stays so (a developer's own dev install stays so). Recommended: a third reason,
   `absent · other`, handled as `old` is (nothing counted or recorded, an hour's wait), and printed by `enable` as
   `{"orca":"absent","error":"other"}`. Tasks 3 and 4 carry this, marked; the other choice is `not-running`'s handling.
2. **Q2. Which state `harness device orca status` says when two hold.** The spec defines the five states but not their
   order. Recommended, first that holds: `off` for `removed.orca` (read before Orca is asked, so Orca is not run), then
   `absent`, then `off` for Orca's own removal, then `on`, `held`, `setup`. So a removed plugin with Orca closed says
   `off`, and a held one with Orca closed says `absent`. Task 5 carries this, marked.

## Verification

**Isolation for every check below** (cli/AGENTS.md rule 6; `e2e/harness/daemon.ts`): each daemon or command runs under
an `IsolatedDaemon` root, a throwaway `HOME`, data folder, port and private tmux server; its `orca` is
`src/testing/fakeOrcaCli.ts` written through `bin/orca` into the harness's own launcher, which is also
`HARNESS_ORCA_APP_BIN`, so neither `PATH` nor `/Applications/Orca.app` reaches this Mac's Orca. No check reads this
Mac's Orca config or plugin list, starts the real Harness Device app, or takes a screenshot. No account is used.

1. **End to end, the command and the devices process (macOS, this Mac, locally):**
   `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceOrca.e2e.ts` (it builds its own
   bundle; with `E2E_BUNDLE=1` it uses the run's). A person sees both `describe`s pass: `status`, `enable`, `disable`
   from the built `cli.js`, and a fake dial's attach (`e2e/harness/desk.ts`, `fakeDial.ts`) installing and approving
   the plugin with no command, a replug after `disable` installing nothing.
2. **The attach and settle paths the pass joins (macOS, locally):** `cd cli && E2E_BUNDLE=1 TMPDIR=/tmp npx vitest run
   --config vitest.e2e.config.ts e2e/devicesProcess.e2e.ts e2e/dialOrcaFocus.e2e.ts e2e/deviceOrcaHomes.e2e.ts`: from
   the bundle the pass is live and meets the harness's stub `orca` (exit 1, `absent`), and each file passes as before.
3. **Linux, on GitHub:** Actions → **CLI end to end** → Run workflow on `feat/device-orca-default-on`, once
   (`gh workflow run cli-e2e.yml --ref feat/device-orca-default-on`), after the final review. `e2e-summary` green with
   `e2e/deviceOrca.e2e.ts` and `e2e/devicesProcess.e2e.ts` among the files; the run link goes in the pull request. No
   temporary workflow: the repo's own runs these files.
4. **Local gates PR CI does not run** (`docs/validation-and-release.md`), from a clean tree at the final commit:
   `cd cli && npm run typecheck && npm run test:core` (`src/services/devices.ts` at 100%), then
   `python3 scripts/local-checks.py --run`, its `harness-local-checks` fence pasted into the pull request body before
   the push that opens it. PR CI runs `cli-typecheck`, `cli-tests` and `device-app-checks` (Linux).
5. **Harness Device on macOS** (PR CI compiles only its Linux code): `cd device-app/ui && npm ci && npm run typecheck
   && npm test && npm run build`, then `cd device-app/src-tauri && cargo test --locked --lib`, on a Mac.
6. **The gallery (a person's eye, the reviewer's):** `cd device-app/ui && npm run gallery && open gallery.html`: Install
   and Sign in in each state, light and dark, the primary button focused, no Orca screen.
7. **The Harness Device app end to end:** none. The change only removes its Orca row, screen and runs; the model and
   runner tests cover the menu in every state and the CLI words the app runs, and running a second copy beside this
   Mac's installed Harness Device app (same bundle id) would touch the person's own.
8. **A real Orca:** none, by the PM's decision (no real-app gate, never this Mac's Orca). The pin and the fakes follow
   Orca 1.4.262's shapes as the spec read them; after release, the tally line in a person's exported log
   (`[device] orca plugin · orca · set up`, or `failed · access`) is the first real reading, and that log is theirs to
   share.
