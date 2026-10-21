# Windows Native PTY Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Harness daemon a second terminal backend: a Rust PTY host (`harness-pty`) that holds
ConPTY panes on Windows outside the daemon's lifetime. Agents then run natively on Windows with the
same create, restart, stream, capture and resume behavior they have on tmux.

**Architecture:** First, a behavior-preserving refactor removes direct tmux calls from the daemon's
agent code, so every pane operation goes through `TerminalBackend`. Then a Rust host, built on the
vendored `alacritty_terminal`, serves panes over a local socket or named pipe, and a new
`PtyHostBackend` speaks to it. The host builds on Unix too, so one contract suite tests both backends
on Linux CI. Windows-only pieces (Job Objects, named pipe, process table) come last, followed by
upgrade drain and E2E.

**Tech Stack:**
- TypeScript (Node, vitest) in `cli/`.
- Rust 2024: `alacritty_terminal` 0.26 vendored, `serde_json`, `windows-sys`, `polling`.
- GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md`

## Global Constraints

- **Platforms:** mac/Linux keep tmux as the default backend. `ptyhost` is the default only on
  `win32`. `TERMINAL_BACKENDS` still overrides.
- **Persistence:** panes must survive a daemon restart and upgrade. A host upgrade must never kill an
  agent: the daemon speaks protocol N and N−1, and a bump drains.
- **Pane ids:** host pane ids are `%<n>`, the same shape as tmux. This keeps `PANE_RE`, the
  `tmuxPane` wire field (`lib/agentFrame.ts:83`) and handoff validation unchanged. The id is unique
  per host instance; the route key includes the backend and instance.
- **Error semantics:** "we could not look" is never "nothing is there".
  - An unreachable host gives `unavailable`, never an empty inventory.
  - A request never sent gives `not_started`; a request sent with no reply gives `possibly_executed`.
  - A bad token or protocol gives `incompatible`.
- **Capture output** must be byte-compatible with
  `tmux capture-pane -p [-e] -J [-S -<n>]` (`cli/src/lib/tmuxCapture.ts:14`). Engine detection
  heuristics are tuned to it.
- **Stream keyframes** are built with the existing pure `synthesizeTmuxSnapshot`
  (`cli/src/lib/tmuxStream.ts:342`).
- **Reuse from Orca** (https://github.com/stablyai/orca, MIT): attribute in
  `THIRD_PARTY_NOTICES` and in a header comment of each adapted file.
- **Commits:** do not commit unless the user has authorized commits for this run. Otherwise each
  "Checkpoint" step means: stage the files and leave them uncommitted.
- **CI:** PR CI runs Linux unit checks only. Windows checks run in the manual "Windows PTY" workflow
  (Task 22). Record locally run gates in the PR (AGENTS.md).
- **Docs and code comments in English.**

## Review Focus

1. **Daemon restarted while a pane streams.** The new daemon must reattach and the viewer gets a fresh
   keyframe. The stream must not be dropped, and output must not be duplicated. Test: Task 15
   "reattach after client reconnect".
2. **Host killed under a running agent.** Runtimes go `gone` and resume relaunches. Liveness must
   never read `unknown` forever, and the inventory must not be read as empty. Test: Task 15 "host
   death marks runtimes gone".
3. **Slow viewer on a chatty pane** (a build log). The subscriber overflows, is dropped and
   resubscribes with a keyframe, and the host's memory stays bounded. Test: Task 11 "overflow drops
   subscriber".
4. **Very large paste or non-ASCII input** (Vietnamese, CJK, emoji) through `pasteRaw`/`typeLiteral`.
   It must arrive intact and bracketed exactly as on tmux. Test: Task 14 contract case "paste
   unicode".
5. **PID reuse on Windows.** A recycled pid with a matching creation time but outside the pane's Job
   must validate `gone`. Test: Task 19 "pid outside job is gone".

---

## File Structure

**TypeScript (`cli/src/`)**

| File | Status | Responsibility |
|---|---|---|
| `lib/processTable.ts` | new | `ProcessRow`, the process table read (per platform source), argv/engine matching moved out of `tmux.ts` |
| `lib/paneEngineProcess.ts` | new | "which process in this pane is the engine" on top of `backend.rootProcess` + `processTable` |
| `lib/processSignals.ts` | new | `terminateProcess(identity, {graceful})` per platform |
| `lib/terminalBackend.ts` | modify | adds `releaseHold`, `paneState`, `paneInfo`, `rootProcess`, `prepare`, `capabilities` |
| `lib/terminalTypes.ts` | modify | `TerminalBackendName = 'tmux' \| 'ptyhost'`, `PtyRuntimeRef`, `TerminalPaneState`, `TerminalPaneInfo`, `TerminalBackendCapabilities` |
| `lib/terminalRuntime.ts` | modify | route/instance/placement keys per backend |
| `lib/tmuxBackend.ts` | modify | implements the new methods by delegating to `tmux.ts` |
| `lib/ptyHost/protocol.ts` | new | wire types shared with Rust (mirrors `pty/src/protocol.rs`) |
| `lib/ptyHost/client.ts` | new | control and stream connections, hello, request ids, timeouts, error mapping |
| `lib/ptyHost/launch.ts` | new | locate binary, discovery file, spawn detached, connect, drain |
| `lib/ptyHost/stream.ts` | new | `PtyHostStream implements TerminalStreamHandle` |
| `lib/ptyHostBackend.ts` | new | `PtyHostBackend implements TerminalBackend<PtyRuntimeRef>` |
| `lib/windows/processTable.ts` | new | runs `harness-pty ps --json`, maps rows |
| `lib/windows/treeKill.ts` | new | `taskkill /T /F` fallback with root identity (adapted from Orca) |
| `lib/windows/shell.ts` | new | default shell for a plain pane: `pwsh` → `powershell` → `cmd` (adapted from Orca) |
| `lib/terminalBackend.contract.ts` | new | shared contract suite |
| `lib/tmuxBackend.contract.spec.ts`, `lib/ptyHostBackend.contract.spec.ts` | new | run the suite per backend |
| `config/terminalConfig.ts` | modify | accept `ptyhost`; platform default |
| `core/main.ts` | modify | build backends generically, `prepare()` each |

**Rust**

| Path | Status | Responsibility |
|---|---|---|
| `term/` (`harness-term`) | new crate | tmux-compatible capture over an alacritty `Grid`, moved from `tui/src/capture.rs` |
| `tui/` | modify | depends on `harness-term`; `capture.rs` becomes a thin wrapper |
| `tui/vendor/alacritty_terminal/src/tty/windows/conpty.rs` + `tty/mod.rs` | modify | Windows spawn: `CREATE_SUSPENDED` + assign to a caller-provided Job + resume |
| `pty/` (`harness-pty`) | new crate | the host |
| `pty/src/protocol.rs` | new | request/response/event types, NDJSON and binary framing |
| `pty/src/pane.rs` | new | one pane: tty, reader thread, `Term`, output sequence, held/exit state |
| `pty/src/panes.rs` | new | pane table, ids, owner tag, titles |
| `pty/src/stream.rs` | new | subscribers, snapshot cut, backpressure |
| `pty/src/server.rs` | new | accept loop, hello/token, dispatch |
| `pty/src/transport/unix.rs`, `transport/windows.rs` | new | Unix socket, named pipe with owner DACL |
| `pty/src/discovery.rs` | new | `run/pty-host-<protocol>.json` |
| `pty/src/job.rs` | new (Windows) | Job Object per pane, pid list, terminate |
| `pty/src/ps.rs` | new (Windows) | process table for `ps --json` and `processes` |
| `pty/src/main.rs` | new | `serve`, `ps --json`, `version` |

**CI and scripts**

- `.github/workflows/windows-pty.yml` (new, manual).
- `cli/build-bundle.mjs` (modify): ship `harness-pty` beside `dist/` for local Windows testing.
- `THIRD_PARTY_NOTICES` (modify).

---

## Phase 1: Backend-neutral daemon (tmux only, no behavior change)

### Task 1: Move the process table out of `tmux.ts`

**Files:**
- Create: `cli/src/lib/processTable.ts`
- Modify: `cli/src/lib/tmux.ts` (remove the moved code and re-export nothing; callers move)
- Modify: every importer listed by Step 1's grep
- Test: `cli/src/lib/processRows.spec.ts` and the other existing specs (imports updated only)

**Interfaces:**
- Produces, from `lib/processTable.ts`, with exactly the signatures they have today in `tmux.ts`:
  - `ProcessRow`, `parseProcessRow`, `liveProcessRows`, `processRows`, `processArgs`;
  - `launchArgs`, `processLaunchArgs`, `withStartTicks`, `createDeletedImageMemo`,
    `enrichProcessRows`, `processTreePids`, `argvTokens`;
  - `ENGINE_PROCESS_SIGNATURES`, `EngineProcessMatchEvidence`, `EngineProcessMatch`,
    `engineProcessMatch`, `engineProcessMatchScore`, `ambiguousAgentProcess`;
  - `bypassPermissionActive`, `permissionModeFromArgv`, `resumeSessionId`, `LSTART_MARKER_RE`,
    plus the private helpers they use (`selectEngineProcess` is exported now, because Task 2 needs it).
- Adds `setProcessTableSource(source: () => Promise<ProcessRow[] | null>): void`, used by Task 19
  on Windows. The default source is the existing `ps` reader.

- [ ] **Step 1: List importers**

Run: `cd cli && grep -rln "from '\(\.\./\)*\(lib/\)\?tmux\.js'\|from '\./tmux\.js'" src | sort`
Save the list in the PR description; every file on it is revisited in Step 4.

- [ ] **Step 2: Write the failing test**

Append to `cli/src/lib/processRows.spec.ts`:

```ts
import * as table from './processTable.js'

describe('processTable module', () => {
  it('owns the process table API', () => {
    for (const name of ['processRows', 'parseProcessRow', 'argvTokens', 'engineProcessMatch',
      'resumeSessionId', 'selectEngineProcess', 'setProcessTableSource'] as const) {
      expect(typeof table[name]).toBe('function')
    }
  })

  it('reads through an injected source', async () => {
    const row = { pid: 7, parentPid: 1, executable: 'x', startMarker: 'w:1', args: 'x' }
    table.setProcessTableSource(async () => [row])
    try {
      expect(await table.processRows()).toEqual([row])
    } finally {
      table.setProcessTableSource(null)
    }
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/processRows.spec.ts`
Expected: FAIL, `Cannot find module './processTable.js'`.

- [ ] **Step 4: Move the code**

1. Cut lines 62–560 of `tmux.ts` (from `export interface ProcessRow` through `processTreePids`) and
   lines 683–1015 (from `ENGINE_PROCESS_SIGNATURES` through `resumeSessionId`), plus `LSTART_MARKER_RE`
   (1124–1125), into `processTable.ts`. Bring their imports with them.
2. Leave in `tmux.ts`: the tmux-server helpers (`isNoTmuxServerError`, `rememberTmuxServer`,
   `reviveRemovedTmuxSocket`, `forgetTmuxServer`), the pane functions (`lookupPaneEngineProcess`
   onward) and the send/paste functions. `tmux.ts` now imports from `./processTable.js`.
3. Export `selectEngineProcess`.
4. Replace the body of `processRows` with the injectable source:

```ts
type ProcessTableSource = () => Promise<ProcessRow[] | null>
let source: ProcessTableSource | null = null

/** Windows reads its table from harness-pty (lib/windows/processTable.ts); tests inject rows. */
export function setProcessTableSource(next: ProcessTableSource | null): void {
  source = next
  processRowsInFlight = null
}

export function processRows(): Promise<ProcessRow[] | null> {
  if (processRowsInFlight) return processRowsInFlight
  processRowsInFlight = (source ?? readProcessRows)().finally(() => { processRowsInFlight = null })
  return processRowsInFlight
}
```

5. Update every importer from Step 1 to import the moved names from `processTable.js`. Rewrite the
   import line only; touch no other code.

- [ ] **Step 5: Verify**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/lib/processRows.spec.ts && npm run test:core && npm run test:resume`
Expected: typecheck clean; all PASS with coverage thresholds unchanged.

- [ ] **Step 6: Checkpoint**

```bash
git add cli/src && git commit -m "refactor(cli): move the process table out of tmux.ts"
```

### Task 2: Pane operations on `TerminalBackend`

**Files:**
- Modify: `cli/src/lib/terminalTypes.ts`, `cli/src/lib/terminalBackend.ts`, `cli/src/lib/tmuxBackend.ts`
- Create: `cli/src/lib/paneEngineProcess.ts`
- Modify callers: `core/agents/create.ts`, `newPane.ts`, `restart.ts`, `retarget.ts`, `swap.ts`,
  `discovery.ts`, `fork.ts`, `externalResume.ts`, `core/terminals/open.ts`, `requests.ts`,
  `sessions.ts`, `lib/resumeAgentService.ts`, `core/main.ts`
- Test: `cli/src/lib/tmuxBackend.spec.ts`, `cli/src/lib/paneEngineProcess.spec.ts`

**Interfaces:**
- Consumes `processRows`, `enrichProcessRows`, `processTreePids` and `selectEngineProcess` from Task 1.
- Produces, in `terminalTypes.ts`:

```ts
export interface TerminalPaneState {
  dead: boolean
  exitStatus: number | null
  /** Foreground command name, as tmux #{pane_current_command}. */
  command: string
  /** Engine exit status recorded by the launch wrapper; null before. */
  engineExit: number | null
}
export type TerminalPaneRead = TerminalPaneState | 'gone' | 'unknown'
export interface TerminalPaneInfo { command: string; path: string; pid: number | null; tty: string }
export interface TerminalBackendCapabilities {
  /** Per-session environment for new panes (tmux >= TMUX_SESSION_ENV_MIN; always on ptyhost). */
  sessionEnv: boolean
}
```

- Produces, in `TerminalBackend`, all required:

```ts
releaseHold(runtime: Ref, current?: () => boolean): Promise<void>
paneState(runtime: Ref): Promise<TerminalPaneRead>
paneInfo(runtime: Ref): Promise<TerminalPaneInfo | null>
/** The pane's own root process, 'missing' when the backend says the pane does not exist, null when it could not ask. */
rootProcess(runtime: Ref): Promise<number | 'missing' | null>
```

- Produces, in `paneEngineProcess.ts`:

```ts
export type PaneProcessLookup =
  | { ok: true; identity: ProcessIdentity }
  | { ok: false; unknown: boolean; reason: string }
export function lookupPaneEngineProcess(backend: TerminalBackend, runtime: TerminalRuntimeRef,
  engine: AgentEngine): Promise<PaneProcessLookup>
export function resolvePaneEngineProcess(backend: TerminalBackend, runtime: TerminalRuntimeRef,
  engine: AgentEngine): Promise<ProcessIdentity | null>
export function checkSessionRuntime(backend: TerminalBackend, session: RegisteredSession): Promise<RuntimeCheck>
```

- [ ] **Step 1: Write the failing tests**

`cli/src/lib/paneEngineProcess.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
import { setProcessTableSource } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'

const runtime = { backend: 'tmux' as const, paneId: '%1' }
function backendWithRoot(root: number | 'missing' | null): TerminalBackend {
  return { rootProcess: async () => root } as unknown as TerminalBackend
}

describe('lookupPaneEngineProcess', () => {
  it('says gone when the backend has no such pane', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot('missing'), runtime, 'claude')
    expect(found).toEqual({ ok: false, unknown: false, reason: 'tmux:%1 has no pane' })
  })

  it('says unknown when the backend could not be asked', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot(null), runtime, 'claude')
    expect(found).toMatchObject({ ok: false, unknown: true })
  })

  it('finds the engine below the pane root', async () => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'm10', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'claude', startMarker: 'm11', args: 'claude' },
    ])
    try {
      const found = await lookupPaneEngineProcess(backendWithRoot(10), runtime, 'claude')
      expect(found).toMatchObject({ ok: true, identity: { pid: 11, startMarker: 'm11' } })
    } finally { setProcessTableSource(null) }
  })
})
```

Add to `tmuxBackend.spec.ts`, following its existing fake-`run` pattern:

```ts
it('rootProcess maps "can\'t find pane" to missing', async () => {
  const backend = backendWithTmux((args, done) => done(Object.assign(new Error('x'), { stderr: "can't find pane: %9" }), '', "can't find pane: %9"))
  expect(await backend.rootProcess({ backend: 'tmux', paneId: '%9' })).toBe('missing')
})
```

Use the spec's existing helper for the fake executor. If that helper has another name, rename the
call above to match.

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/lib/paneEngineProcess.spec.ts src/lib/tmuxBackend.spec.ts`
Expected: FAIL, module or method not found.

- [ ] **Step 3: Implement**

1. In `tmuxBackend.ts`, add the four methods:
   - `releaseHold` → `clearPaneRemainOnExit(runtime.paneId, current)`;
   - `paneState` → `tmuxPaneState(runtime.paneId)`;
   - `paneInfo` → `tmuxPaneInfo(runtime.paneId)`;
   - `rootProcess` → the existing private `panePidLookup` in `tmux.ts`, exported as
     `tmuxPanePid(pane): Promise<number | 'missing' | null>`.
2. Create `paneEngineProcess.ts` by moving `lookupPaneEngineProcess`, `resolvePaneEngineProcess`
   and `checkSessionRuntime` from `tmux.ts`, rewriting their pane access through the backend:

```ts
export async function lookupPaneEngineProcess(backend: TerminalBackend, runtime: TerminalRuntimeRef,
  engine: AgentEngine): Promise<PaneProcessLookup> {
  const label = terminalRuntimeLabel(runtime)
  const rootPid = await backend.rootProcess(runtime)
  if (rootPid === 'missing') return { ok: false, unknown: false, reason: `${label} has no pane` }
  if (!rootPid) return { ok: false, unknown: true, reason: `${label} could not be resolved` }
  const rows = await processRows()
  if (!rows) return { ok: false, unknown: true, reason: 'the process table could not be read' }
  const enriched = await enrichProcessRows(rows, processTreePids(rows, [rootPid]))
  const process = selectEngineProcess(enriched, rootPid, engine)
  if (!process) return { ok: false, unknown: false, reason: `no ${engine} process under ${label}` }
  return { ok: true, identity: processIdentityOf(process) }
}
```

   `checkSessionRuntime(backend, session)` keeps its body. It reads the session's primary runtime
   through `primaryRuntime(session)` (Task 4 adds it; until then use
   `session.runtimes.find(r => r.backend === 'tmux')!`).
3. Update each caller in the Files list to take the backend from
   `terminals.backendFor(runtime)` (or the `TerminalBackend` it already receives) instead of
   importing from `tmux.js`. Where `newPane.ts`/`swap.ts` call `resolvePaneEngineProcess(paneId,
   engine)`, call `resolvePaneEngineProcess(backend, runtime, engine)`.
4. Delete the moved functions from `tmux.ts`. Keep the `tmuxPaneState`/`tmuxPaneInfo`/
   `clearPaneRemainOnExit` exports, because `tmuxBackend.ts` still uses them.

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/lib src/core && npm run test:core && npm run test:resume && npm run test:tmux-real`
Expected: all PASS, and `grep -rn "from '.*tmux\.js'" src/core src/lib/resumeAgentService.ts` lists
nothing.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "refactor(cli): pane operations go through TerminalBackend"
```

### Task 3: `prepare()` and `capabilities` replace tmux bootstrap and version gates

**Files:**
- Modify: `cli/src/lib/terminalBackend.ts`, `tmuxBackend.ts`, `core/main.ts:519-575`,
  `core/agents/create.ts`, `lib/launchOverrides.ts`, `lib/resumeAgentService.ts`
- Test: `cli/src/lib/tmuxBackend.spec.ts`

**Interfaces:**
- Produces, in `TerminalBackend`:

```ts
/** Ready the backend at daemon start. A failure is a state: the daemon keeps running without it. */
prepare(context: { ownedPanes: ReadonlyMap<string, AgentEngine> }): Promise<{ state: 'ready' } | { state: 'unavailable'; reason: string; code: string }>
capabilities(): Promise<TerminalBackendCapabilities>
```

- `TmuxBackend.prepare` does the following, moved from `main.ts`:
  - `ensureTmuxOnPath`; when tmux is absent it returns `{ state: 'unavailable', code: 'TMUX_UNAVAILABLE', reason }`;
  - `adoptLegacyHarnessSessions`;
  - `unsetServerEnvironment(isHarnessdVariable || isAgentSessionVariable)`;
  - the first `inventory()` log line.
- `TmuxBackend.capabilities` returns `{ sessionEnv: await tmuxSupportsSessionEnv() }`.

- [ ] **Step 1: Write the failing test**

```ts
it('prepare reports tmux absent as unavailable, not a throw', async () => {
  const backend = new TmuxBackend(() => DEFAULT_HOST_THEME, { ensureOnPath: async () => ({ state: 'absent', reason: 'no tmux' }) })
  expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'unavailable', code: 'TMUX_UNAVAILABLE', reason: 'no tmux' })
})
```

(The second constructor argument is an optional `{ ensureOnPath }` seam, defaulting to
`ensureTmuxOnPath`.)

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/tmuxBackend.spec.ts -t prepare`
Expected: FAIL, `prepare is not a function`.

- [ ] **Step 3: Implement**

1. Move the `main.ts` block (from `const tmuxPathPromise` through the `tmuxStartup` log) into
   `TmuxBackend.prepare`, keeping the log lines verbatim.
2. In `main.ts`, build backends from the configured names and prepare each:

```ts
const candidates: TerminalBackend[] = []
if (terminalConfig.backends.includes('tmux')) candidates.push(new TmuxBackend(() => hostTheme))
const ownedPanes = new Map(registry.list().flatMap((s) => s.runtimes.map((r) => [r.paneId, s.engine] as const)))
const prepared = await Promise.all(candidates.map(async (backend) => ({ backend, result: await backend.prepare({ ownedPanes }) })))
const terminalBackends = prepared.filter((p) => p.result.state === 'ready').map((p) => p.backend)
const terminalUnavailable = prepared.find((p) => p.result.state === 'unavailable')?.result ?? null
```

3. Replace the existing `tmuxBackend` variable passed into the agent services with
   `createBackend: TerminalBackend | null = terminalBackends[0] ?? null`, the backend new panes are
   made on.
4. Replace `tmuxUnavailable` with `terminalUnavailable?.reason`, and the `TMUX_UNAVAILABLE` code
   with `terminalUnavailable?.code`. The tmux path still yields the same code string, so wire
   behavior is unchanged.
5. In `create.ts` and `launchOverrides.ts`, replace `tmuxSupportsSessionEnv()` and
   `TMUX_SESSION_ENV_MIN` checks with `(await backend.capabilities()).sessionEnv`. Keep the error
   text that names the minimum tmux version inside `TmuxBackend`.
6. In `resumeAgentService.ts`, replace `listTmuxPanes()` with `backend.inventory()` and read
   `roots[].runtime.paneId`.

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npm run test:core && npm run test:resume && npm run test:harnessd && npm run test:tmux-real`
Expected: PASS. Then start a dev daemon (`make install-cli` per CONTRIBUTING) and confirm the
startup log lines `[terminal] enabled backends: tmux` and `[terminal] tmux: available` appear in
the same order as before.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "refactor(cli): backends prepare themselves and report capabilities"
```

### Task 4: Runtime refs and route keys for more than one backend

**Files:**
- Modify: `cli/src/lib/terminalTypes.ts`, `terminalRuntime.ts`, `registry.ts:351,528-660`,
  `config/terminalConfig.ts`, `config/env.ts:263`, `core/engines/hooks.ts`
- Test: `cli/src/lib/terminalRuntime.spec.ts`, `cli/src/lib/registry.spec.ts`,
  `cli/src/config/terminalConfig.spec.ts`

**Interfaces:**
- Produces:

```ts
export type TerminalBackendName = 'tmux' | 'ptyhost'
export interface PtyRuntimeRef { backend: 'ptyhost'; paneId: string; /** host instance, e.g. "p3" (protocol 3) */ instance: string }
export type TerminalRuntimeRef = TmuxRuntimeRef | PtyRuntimeRef
export type HookTerminalHint = { backend: 'tmux'; paneId: string } | { backend: 'ptyhost'; paneId: string; instance: string }
```

- `terminalRouteKey`:
  - tmux: `tmux\0<paneId>` (unchanged);
  - ptyhost: `ptyhost\0<instance>\0<paneId>`.
- `terminalInstanceId`:
  - tmux: `'tmux:default'`;
  - ptyhost: `ptyhost:<instance>`.
- `terminalRuntimeLabel`: `ptyhost:<instance>:<paneId>`.
- `primaryRuntime(session: RegisteredSession): TerminalRuntimeRef`, in `terminalRuntime.ts`.
- Registry:
  - `tmuxProjection` becomes `paneProjection`: the primary runtime's `paneId`, whatever its backend;
  - `validTerminalRuntime` accepts `ptyhost` with `/^%\d+$/` panes and `/^p\d{1,4}$/` instances.
- `parseTerminalBackends(value?: string, platform = process.platform)`: accepts `ptyhost`. With no
  value, it returns `['ptyhost']` on `win32` and `['tmux']` elsewhere. `ALL_TERMINAL_BACKENDS`
  becomes `defaultTerminalBackends(platform)`.

- [ ] **Step 1: Write the failing tests**

```ts
// terminalRuntime.spec.ts
it('keys ptyhost runtimes by instance and pane', () => {
  const r = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%4' }
  expect(terminalRouteKey(r)).toBe('ptyhost\u0000p1\u0000%4')
  expect(terminalInstanceId(r)).toBe('ptyhost:p1')
  expect(terminalRouteKey({ backend: 'tmux', paneId: '%4' })).toBe('tmux\u0000%4')
})

// terminalConfig.spec.ts
it('defaults to ptyhost on Windows only', () => {
  expect(parseTerminalBackends(undefined, 'win32')).toEqual(['ptyhost'])
  expect(parseTerminalBackends(undefined, 'darwin')).toEqual(['tmux'])
  expect(parseTerminalBackends('ptyhost', 'linux')).toEqual(['ptyhost'])
})

// registry.spec.ts
it('round-trips a ptyhost row and projects its pane', () => {
  const row = sessionRow({ runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%2' }] })
  const saved = roundTrip(row)
  expect(saved.runtimes).toEqual([{ backend: 'ptyhost', instance: 'p1', paneId: '%2' }])
  expect(saved.tmuxPane).toBe('%2')
})
```

`sessionRow`/`roundTrip` are the existing helpers in `registry.spec.ts`. Use whatever names that
spec already uses for building a row and saving/loading it.

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/terminalRuntime.spec.ts src/config/terminalConfig.spec.ts src/lib/registry.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// terminalRuntime.ts
export function terminalRouteKey(runtime: TerminalRuntimeRef): string {
  const pane = assertKeyPart(runtime.paneId, 'pane id')
  return runtime.backend === 'tmux'
    ? `tmux${SEP}${pane}`
    : `ptyhost${SEP}${assertKeyPart(runtime.instance, 'pty host instance')}${SEP}${pane}`
}
export function terminalInstanceId(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux' ? 'tmux:default' : `ptyhost:${runtime.instance}`
}
export function terminalRuntimeLabel(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux' ? `tmux:${runtime.paneId}` : `ptyhost:${runtime.instance}:${runtime.paneId}`
}
export function primaryRuntime(session: Pick<RegisteredSession, 'runtimes'>): TerminalRuntimeRef {
  return session.runtimes[0]
}
```

Then:
- update the registry projection and validation as specified;
- make `hooks.ts` accept the union hint;
- narrow with `runtime.backend === 'tmux'` everywhere `tsc` now complains, which is only where code
  is truly tmux-specific (`tmuxBackend.ts`, `tmuxStream.ts`, `tmuxAgentDiscovery.ts`).

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npm test -- src/lib src/core src/config && npm run test:core && npm run test:resume`
Expected: PASS. Registry golden files are unchanged, because tmux rows serialize identically.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "refactor(cli): runtime refs and route keys for more than one backend"
```

### Task 5: `processSignals.ts` for agent processes

**Files:**
- Create: `cli/src/lib/processSignals.ts`
- Modify (agent-process kills only): `lib/stopAgentService.ts`, `core/agents/swap.ts`,
  `lib/tmux.ts` (its 3 kills), `lib/sessionSearch/externals/support.ts`
- Test: `cli/src/lib/processSignals.spec.ts`

Daemon/service kills (`daemonStop.ts`, `harnessd/*`, `cli.ts`, `dsh/*`) belong to sub-project B
and stay as they are.

**Interfaces:**

```ts
export type TerminateResult = 'signalled' | 'gone' | 'failed'
export interface ProcessTerminator { terminate(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult> }
/** Unix: SIGTERM (graceful) or SIGKILL after re-checking identity. Windows: replaced in Task 19. */
export function terminateProcess(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult>
export function setProcessTerminator(next: ProcessTerminator | null): void
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { terminateProcess } from './processSignals.js'
import { setProcessTableSource } from './processTable.js'

describe('terminateProcess (unix)', () => {
  it('does not signal a pid whose identity changed', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    setProcessTableSource(async () => [{ pid: 50, parentPid: 1, executable: 'x', startMarker: 'NEW', args: 'x' }])
    try {
      expect(await terminateProcess({ pid: 50, executable: 'x', startMarker: 'OLD' }, { graceful: true })).toBe('gone')
      expect(kill).not.toHaveBeenCalled()
    } finally { setProcessTableSource(null); kill.mockRestore() }
  })

  it('sends SIGTERM when graceful and identity matches', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    setProcessTableSource(async () => [{ pid: 51, parentPid: 1, executable: 'x', startMarker: 'S', args: 'x' }])
    try {
      expect(await terminateProcess({ pid: 51, executable: 'x', startMarker: 'S' }, { graceful: true })).toBe('signalled')
      expect(kill).toHaveBeenCalledWith(51, 'SIGTERM')
    } finally { setProcessTableSource(null); kill.mockRestore() }
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/processSignals.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { ProcessIdentity } from './terminalTypes.js'
import { processRows } from './processTable.js'
import { sameProcessIdentity } from './terminalRuntime.js'

export type TerminateResult = 'signalled' | 'gone' | 'failed'
export interface ProcessTerminator { terminate(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult> }

const unixTerminator: ProcessTerminator = {
  async terminate(identity, { graceful }) {
    const rows = await processRows()
    if (!rows) return 'failed'
    if (!rows.some((row) => sameProcessIdentity(row, identity))) return 'gone'
    try { process.kill(identity.pid, graceful ? 'SIGTERM' : 'SIGKILL'); return 'signalled' }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed' }
  },
}

let terminator: ProcessTerminator | null = null
export function setProcessTerminator(next: ProcessTerminator | null): void { terminator = next }
export function terminateProcess(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult> {
  return (terminator ?? unixTerminator).terminate(identity, options)
}
```

Replace each listed `process.kill(pid, 'SIGTERM'|'SIGKILL')` on an agent process with
`terminateProcess(identity, { graceful })`. Each of those sites already holds the identity it
verified. Where a site holds only a pid that came from a fresh row, pass that row.

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/lib/processSignals.spec.ts src/lib/stopAgentService.spec.ts src/core/agents/swap.spec.ts && npm run test:resume && npm run test:tmux-real`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "refactor(cli): agent process termination through processSignals"
```

### Task 6: Backend contract suite, run against tmux

**Files:**
- Create: `cli/src/lib/terminalBackend.contract.ts`, `cli/src/lib/tmuxBackend.contract.spec.ts`
- Modify: `cli/package.json` (adds `test:terminal-contract`)

**Interfaces:**
- Produces `runTerminalBackendContract(name: string, make: () => Promise<{ backend: TerminalBackend; cleanup(): Promise<void> }>): void`,
  used again in Task 15.

- [ ] **Step 1: Write the suite**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const SHELL = process.platform === 'win32' ? ['powershell.exe', '-NoLogo', '-NoProfile'] : ['/bin/sh']

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((r) => setTimeout(r, 50))
  }
}

export function runTerminalBackendContract(name: string, make: () => Promise<{ backend: TerminalBackend; cleanup(): Promise<void> }>): void {
  describe(`TerminalBackend contract: ${name}`, () => {
    let backend: TerminalBackend
    let cleanup: () => Promise<void>
    beforeAll(async () => { ({ backend, cleanup } = await make()) })
    afterAll(async () => { await cleanup() })

    async function pane(): Promise<TerminalRuntimeRef> {
      const created = await backend.create({ command: SHELL, cwd: process.cwd() })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      return created.runtime
    }
    const text = async (r: TerminalRuntimeRef) => {
      const read = await backend.capture(r, { mode: 'recent_unwrapped', historyLines: 50, ansi: false })
      return read.state === 'succeeded' ? read.value : ''
    }

    it('creates a pane that inventory lists and kill removes', async () => {
      const r = await pane()
      const inv = await backend.inventory()
      expect(inv.state).toBe('available')
      if (inv.state === 'available') expect(inv.roots.some((root) => root.runtime.paneId === r.paneId)).toBe(true)
      expect((await backend.kill(r)).state).toBe('succeeded')
      expect(await until(() => backend.paneState(r), (s) => s === 'gone')).toBe('gone')
    })

    it('submitText reaches the program and capture shows it', async () => {
      const r = await pane()
      await backend.submitText(r, 'echo contract-$((40+2))')
      expect(await until(() => text(r), (t) => t.includes('contract-42'))).toContain('contract-42')
      await backend.kill(r)
    })

    it('paste unicode arrives intact', async () => {
      const r = await pane()
      const sample = 'Tiếng Việt 漢字 😀'
      await backend.submitText(r, `echo '${sample}'`)
      expect(await until(() => text(r), (t) => t.split('\n').some((l) => l.trim() === sample))).toContain(sample)
      await backend.kill(r)
    })

    it('holdOpen keeps a pane whose process exited, respawn reuses it, releaseHold lets it go', async () => {
      const r = await pane()
      expect((await backend.holdOpen!(r)).state).toBe('succeeded')
      await backend.submitText(r, 'exit')
      const held = await until(() => backend.paneState(r), (s) => typeof s === 'object' && s.dead)
      expect(held).toMatchObject({ dead: true })
      expect((await backend.respawn!(r, { command: SHELL })).state).toBe('succeeded')
      expect(await until(() => backend.paneState(r), (s) => typeof s === 'object' && !s.dead)).toMatchObject({ dead: false })
      await backend.releaseHold(r)
      await backend.submitText(r, 'exit')
      expect(await until(() => backend.paneState(r), (s) => s === 'gone')).toBe('gone')
    })

    it('rootProcess names a live pid and says missing for an unknown pane', async () => {
      const r = await pane()
      expect(typeof await backend.rootProcess(r)).toBe('number')
      await backend.kill(r)
      await until(() => backend.paneState(r), (s) => s === 'gone')
      expect(await backend.rootProcess(r)).toBe('missing')
    })

    it('stream: snapshot then live output, resize, close', async () => {
      const r = await pane()
      const chunks: Uint8Array[] = []
      const opened = await backend.openStream!(r, { engine: 'terminal' }, { cols: 100, rows: 30 }, {
        onData: (b) => chunks.push(b), onClose: () => {},
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return
      const stream = opened.value
      stream.beginSnapshot()
      const snap = await stream.snapshot()
      expect(snap.state).toBe('succeeded')
      stream.endSnapshot()
      await stream.writeRaw(new TextEncoder().encode('echo live-$((1+1))\r'))
      await until(async () => Buffer.concat(chunks).toString(), (t) => t.includes('live-2'))
      expect(Buffer.concat(chunks).toString()).toContain('live-2')
      expect((await stream.resize({ cols: 80, rows: 24 })).state).toBe('succeeded')
      await stream.close()
      await backend.kill(r)
    })
  })
}
```

`tmuxBackend.contract.spec.ts`:

```ts
import { describe } from 'vitest'
import { runTerminalBackendContract } from './terminalBackend.contract.js'
import { TmuxBackend } from './tmuxBackend.js'
import { DEFAULT_HOST_THEME } from './hostTheme.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && process.platform !== 'win32'
;(enabled ? runTerminalBackendContract : () => describe.skip('tmux contract', () => {}))('tmux', async () => {
  const backend = new TmuxBackend(() => DEFAULT_HOST_THEME)
  await backend.prepare({ ownedPanes: new Map() })
  return { backend, cleanup: async () => {} }
})
```

`package.json`:
`"test:terminal-contract": "RUN_TERMINAL_CONTRACT=1 vitest run src/lib/tmuxBackend.contract.spec.ts src/lib/ptyHostBackend.contract.spec.ts --maxWorkers=1"`

- [ ] **Step 2: Run against tmux**

Run: `cd cli && npm run test:terminal-contract`
Expected: PASS for tmux. The ptyhost spec file does not exist yet, so vitest reports "No test files"
for it. That is fine.

If a tmux case fails, the contract is wrong, not tmux: fix the case to describe what tmux does today.

- [ ] **Step 3: Checkpoint**

```bash
git add cli/src cli/package.json && git commit -m "test(cli): terminal backend contract suite, run against tmux"
```

---

## Phase 2: `harness-term` and `harness-pty` on Unix

### Task 7: Extract `harness-term` from `tui/src/capture.rs`

**Files:**
- Create: `term/Cargo.toml`, `term/src/lib.rs`, `term/src/capture.rs`
- Modify: `tui/Cargo.toml`, `tui/src/capture.rs`
- Test: `term/src/capture.rs` (the moved tests), `cargo test` in `tui/`

**Interfaces:**
- Produces:
  - `harness_term::capture::{Flags2, history(grid: &Grid<Cell>, top: i32, bottom: i32, f: Flags2) -> String, line_bounds(grid: &Grid<Cell>, value: Option<&str>, start: bool, parse: impl Fn(&str) -> Option<i64>) -> i32, cell_style, cell_style_change}`;
  - `harness_term::capture::capture_pane(grid: &Grid<Cell>, history_lines: Option<u32>, ansi: bool) -> String`,
    which does exactly `capture-pane -p [-e] -J [-S -n]`.

- [ ] **Step 1: Create the crate**

`term/Cargo.toml`:

```toml
[package]
name = "harness-term"
version = "0.1.0"
edition = "2024"

[dependencies]
alacritty_terminal = "0.26.0"

[patch.crates-io]
alacritty_terminal = { path = "../tui/vendor/alacritty_terminal" }
vte = { path = "../tui/vendor/vte" }
```

Move `tui/src/capture.rs` to `term/src/capture.rs`, then:
- change `history(pane: &Pane, …)` to `history(grid: &Grid<Cell>, …)` (its body used only
  `pane.term.grid()`);
- change `line_of` to `line_bounds(grid, value, start, parse)`, where `parse` replaces the call to
  `crate::commands::strtonum`;
- add:

```rust
/// What `tmux capture-pane -p [-e] -J [-S -<n>]` prints (cli/src/lib/tmuxCapture.ts): joined, untrimmed,
/// from `n` lines into the history (bounded 20..=300 like the daemon) or the visible screen alone.
pub fn capture_pane(grid: &Grid<Cell>, history_lines: Option<u32>, ansi: bool) -> String {
    let screen = grid.screen_lines() as i32;
    let top = match history_lines {
        Some(n) => -(n.clamp(20, 300) as i32).max(-(grid.history_size() as i32)),
        None => 0,
    };
    let flags = Flags2 { join: true, sequences: ansi, escape: false, empty_cells: false, trim: false };
    history(grid, top, screen - 1, flags)
}
```

Add a test that writes known output into a `Term` and checks `capture_pane` against
`tmux capture-pane -p -J` semantics:

```rust
#[test]
fn capture_pane_joins_wrapped_lines() {
    use alacritty_terminal::term::{Config, Term, test::TermSize};
    use alacritty_terminal::vte::ansi::Processor;
    let mut term = Term::new(Config::default(), &TermSize::new(10, 5), alacritty_terminal::event::VoidListener);
    let mut parser: Processor = Processor::new();
    parser.advance(&mut term, b"0123456789abc\r\nnext");
    let out = capture_pane(term.grid(), None, false);
    assert!(out.starts_with("0123456789abc\nnext\n"), "{out:?}");
}
```

- [ ] **Step 2: Point `tui` at it**

In `tui/Cargo.toml`, add `harness-term = { path = "../term" }`. Then reduce `tui/src/capture.rs` to
wrappers that keep its old signatures:

```rust
pub use harness_term::capture::{Flags2, cell_style, cell_style_change};
use crate::pane::Pane;
pub fn history(pane: &Pane, top: i32, bottom: i32, f: Flags2) -> String { harness_term::capture::history(pane.term.grid(), top, bottom, f) }
pub fn line_of(pane: &Pane, value: Option<&str>, start: bool) -> i32 {
    harness_term::capture::line_bounds(pane.term.grid(), value, start,
        |v| crate::commands::strtonum(v, i32::MIN as i64, i16::MAX as i64).ok())
}
```

- [ ] **Step 3: Verify**

Run: `cd term && cargo test && cd ../tui && cargo test`
Expected: PASS. The moved capture tests now run in `term`.

- [ ] **Step 4: Checkpoint**

```bash
git add term tui && git commit -m "refactor(tui): tmux-compatible capture as the harness-term crate"
```

### Task 8: `harness-pty` protocol and framing

**Files:**
- Create: `pty/Cargo.toml`, `pty/src/main.rs`, `pty/src/lib.rs`, `pty/src/protocol.rs`
- Create: `cli/src/lib/ptyHost/protocol.ts` (TypeScript mirror)
- Test: unit tests in `protocol.rs`; `cli/src/lib/ptyHost/protocol.spec.ts`

**Interfaces:**
- `PROTOCOL: u32 = 1`.
- Control connection: one JSON object per line.
  - Request: `{"id":n,"op":"…",…}`.
  - Response: `{"id":n,"ok":true,…}` or `{"id":n,"ok":false,"code":"…","reason":"…"}`.
  - Unsolicited event: `{"event":"exit","pane":"%3","status":0}` or `{"event":"title",…}`.
- Hello, the first line on any connection: `{"hello":{"token":"…","protocol":1,"role":"control"|"stream","clientId":"…"}}`.
  The answer is `{"hello":{"ok":true,"instance":"p1","version":"0.1.0","pid":123}}`, or
  `{"hello":{"ok":false,"code":"incompatible","reason":"…"}}` followed by a close.
- Stream connection, after hello: binary frames `[u8 kind][u32 BE len][payload]`.
  - Client → host: `kind 1` subscribe (JSON `{"pane":"%3","cols":100,"rows":30,"readOnly":false}`),
    `kind 2` input bytes, `kind 3` paste (UTF-8 text), `kind 4` resize (JSON), `kind 5` snapshot
    (JSON options), `kind 6` pause, `kind 7` resume.
  - Host → client: `kind 16` output (`[u64 BE seq][bytes]`), `kind 17` snapshot (JSON, see Task 11),
    `kind 18` closed (JSON `{"reason":"…"}`), `kind 19` ack (JSON `{"for":n,"ok":bool,"reason"?:…}`).
- Ops, with their fields:

| Op | Fields | Reply |
|---|---|---|
| `create` | `command: string[]`, `cwd?`, `env?`, `cols`, `rows`, `owner`, `label?`, `hold: bool` | `{pane}` |
| `kill` | `pane`, `graceMs` | `{}` |
| `inventory` | — | `{panes: [{pane, rootPid, cwd, title, dead}]}` |
| `titles` | — | `{titles: {pane: title}}` |
| `paneState` | `pane` | `{state: {dead, exitStatus, command, engineExit, heldToken} \| "gone"}` |
| `paneInfo` | `pane` | `{info: {command, path, pid, tty} \| null}` |
| `capture` | `pane`, `historyLines?`, `ansi`, `visible` | `{text}` |
| `write` | `pane`, `data` (base64) | `{}` |
| `paste` | `pane`, `text`, `bracketed` | `{}` |
| `key` | `pane`, `key` (tmux key name) | `{}` |
| `setTitle` | `pane`, `title` | `{}` |
| `holdOpen` | `pane`, `token?` (UUID recorded as the held token) | `{}` |
| `releaseHold` | `pane` | `{}` |
| `respawn` | `pane`, `command`, `cwd?`, `env?`, `expectedHeldToken?` | `{}` |
| `jobPids` | `pane` | `{pids: number[]}` |
| `processes` | — | `{rows: ProcessRowJson[]}` |
| `setEngineExit` | `pane`, `status` | `{}` |

- Error codes: `no_pane`, `bad_request`, `spawn_failed`, `held_mismatch`, `unsupported`, `internal`.

- [ ] **Step 1: Write the failing Rust test**

`pty/src/protocol.rs` (tests at the bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Output, &[0, 0, 0, 0, 0, 0, 0, 7, b'h', b'i']).unwrap();
        let (kind, payload) = read_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(kind, Kind::Output);
        assert_eq!(&payload[8..], b"hi");
    }
    #[test]
    fn rejects_oversize_frame() {
        let mut buf = vec![16u8];
        buf.extend_from_slice(&(MAX_FRAME + 1).to_be_bytes());
        assert!(read_frame(&mut buf.as_slice()).is_err());
    }
    #[test]
    fn parses_create_request() {
        let r: Request = serde_json::from_str(r#"{"id":1,"op":"create","command":["sh"],"cols":80,"rows":24,"owner":"o","hold":true}"#).unwrap();
        assert!(matches!(r.op, Op::Create { ref command, cols: 80, rows: 24, hold: true, .. } if command == &vec!["sh".to_string()]));
    }
}
```

- [ ] **Step 2: Run to fail**

Run: `cd pty && cargo test protocol`
Expected: compile error, items not defined.

- [ ] **Step 3: Implement**

`pty/Cargo.toml`:

```toml
[package]
name = "harness-pty"
version = "0.1.0"
edition = "2024"

[dependencies]
alacritty_terminal = "0.26.0"
harness-term = { path = "../term" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
base64 = "0.22"
uuid = { version = "1", features = ["v4"] }
polling = "3"
log = "0.4"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Security", "Win32_Security_Authorization", "Win32_Storage_FileSystem", "Win32_System_Pipes", "Win32_System_IO", "Win32_System_JobObjects", "Win32_System_Threading", "Win32_System_Diagnostics_ToolHelp", "Win32_System_ProcessStatus", "Win32_UI_Shell", "Wdk_System_Threading"] }

[patch.crates-io]
alacritty_terminal = { path = "../tui/vendor/alacritty_terminal" }
vte = { path = "../tui/vendor/vte" }
```

`pty/src/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};

pub const PROTOCOL: u32 = 1;
pub const MAX_FRAME: u32 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind { Subscribe = 1, Input = 2, Paste = 3, Resize = 4, Snapshot = 5, Pause = 6, Resume = 7,
    Output = 16, SnapshotReply = 17, Closed = 18, Ack = 19 }

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        use Kind::*;
        Some(match v { 1 => Subscribe, 2 => Input, 3 => Paste, 4 => Resize, 5 => Snapshot, 6 => Pause, 7 => Resume,
            16 => Output, 17 => SnapshotReply, 18 => Closed, 19 => Ack, _ => return None })
    }
}

pub fn write_frame(w: &mut impl Write, kind: Kind, payload: &[u8]) -> io::Result<()> {
    let mut head = [0u8; 5];
    head[0] = kind as u8;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)
}

/// `Ok(None)` at a clean end of stream.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(Kind, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let kind = Kind::from_u8(head[0]).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unknown frame kind"))?;
    let len = u32::from_be_bytes(head[1..].try_into().unwrap());
    if len > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large")) }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    Ok(Some((kind, payload)))
}

#[derive(Debug, Deserialize)]
pub struct Hello { pub token: String, pub protocol: u32, pub role: Role, #[serde(rename = "clientId")] pub client_id: String }
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role { Control, Stream }
#[derive(Debug, Deserialize)]
pub struct HelloLine { pub hello: Hello }

#[derive(Debug, Deserialize)]
pub struct Request { pub id: u64, #[serde(flatten)] pub op: Op }

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Create { command: Vec<String>, cwd: Option<String>, #[serde(default)] env: HashMap<String, String>, cols: u16, rows: u16, owner: String, label: Option<String>, hold: bool },
    Kill { pane: String, #[serde(rename = "graceMs", default = "default_grace")] grace_ms: u64 },
    Inventory,
    Titles,
    PaneState { pane: String },
    PaneInfo { pane: String },
    Capture { pane: String, #[serde(rename = "historyLines")] history_lines: Option<u32>, ansi: bool, visible: bool },
    Write { pane: String, data: String },
    Paste { pane: String, text: String, bracketed: bool },
    Key { pane: String, key: String },
    SetTitle { pane: String, title: String },
    HoldOpen { pane: String, token: Option<String> },
    ReleaseHold { pane: String },
    Respawn { pane: String, command: Vec<String>, cwd: Option<String>, #[serde(default)] env: HashMap<String, String>, #[serde(rename = "expectedHeldToken")] expected_held_token: Option<String> },
    JobPids { pane: String },
    Processes,
    SetEngineExit { pane: String, status: i32 },
}
fn default_grace() -> u64 { 2_000 }

#[derive(Debug, Serialize)]
pub struct Failure<'a> { pub id: u64, pub ok: bool, pub code: &'a str, pub reason: String }
impl<'a> Failure<'a> { pub fn new(id: u64, code: &'a str, reason: impl Into<String>) -> Self { Failure { id, ok: false, code, reason: reason.into() } } }
```

`pty/src/lib.rs`: `pub mod protocol;` (later tasks add modules).
`pty/src/main.rs`: `fn main() { harness_pty::cli::main() }`. For now, a stub `cli` module that
prints `version` and exits 2 for unknown commands.

`cli/src/lib/ptyHost/protocol.ts` mirrors the same names:
- `PTY_PROTOCOL = 1`;
- the `FrameKind` enum;
- `encodeFrame(kind, payload): Buffer`;
- `FrameReader`, a class that accumulates chunks and yields `{kind, payload}`, rejecting frames over
  8 MiB;
- `PtyOp` as a discriminated union with the table's fields.

Its spec:

```ts
it('decodes frames split across chunks', () => {
  const frame = encodeFrame(FrameKind.Output, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 104, 105]))
  const reader = new FrameReader()
  expect(reader.push(frame.subarray(0, 3))).toEqual([])
  const [out] = reader.push(frame.subarray(3))
  expect(out.kind).toBe(FrameKind.Output)
  expect(Buffer.from(out.payload.subarray(8)).toString()).toBe('hi')
})
```

- [ ] **Step 4: Verify**

Run: `cd pty && cargo test protocol && cd ../cli && npx vitest run src/lib/ptyHost/protocol.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add pty cli/src/lib/ptyHost && git commit -m "feat(pty): harness-pty protocol and framing"
```

### Task 9: A pane: tty, reader thread, grid, output sequence

**Files:**
- Create: `pty/src/pane.rs`
- Test: tests in `pane.rs` (Unix)

**Interfaces:**

```rust
pub struct PaneSpec { pub command: Vec<String>, pub cwd: Option<PathBuf>, pub env: HashMap<String, String>, pub cols: u16, pub rows: u16 }
pub enum PaneEvent { Output { seq: u64, bytes: Arc<[u8]> }, Exited { status: Option<i32> }, Title(String) }
pub struct Pane { /* private */ }
impl Pane {
    pub fn spawn(id: String, spec: PaneSpec, history_limit: usize, sink: Sender<(String, PaneEvent)>) -> io::Result<Pane>;
    pub fn write(&self, bytes: &[u8]) -> io::Result<()>;
    pub fn resize(&self, cols: u16, rows: u16);
    /// Under one lock: the grid's capture and the sequence number of the last output it contains.
    pub fn capture(&self, history_lines: Option<u32>, ansi: bool) -> (String, u64);
    pub fn meta(&self) -> PaneMeta;            // mirrors tmuxStream.ts PaneMeta fields
    pub fn root_pid(&self) -> Option<u32>;
    pub fn title(&self) -> String;
    pub fn cwd(&self) -> Option<String>;       // OSC 7, else spawn cwd
    pub fn kill(&self, grace: Duration);       // Unix: SIGHUP to group, then SIGKILL. Windows: Task 16.
}
#[derive(Serialize)] pub struct PaneMeta { pub cols: u16, pub rows: u16, pub alternate_on: bool, pub cursor_x: u16, pub cursor_y: u16,
    pub cursor_visible: bool, pub mouse_standard: bool, pub mouse_button: bool, pub mouse_all: bool, pub mouse_utf8: bool, pub mouse_sgr: bool }
```

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    fn wait_for(rx: &std::sync::mpsc::Receiver<(String, PaneEvent)>, pred: impl Fn(&PaneEvent) -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if let Ok((_, ev)) = rx.recv_timeout(Duration::from_millis(100)) { if pred(&ev) { return true } }
        }
        false
    }

    #[test]
    fn output_reaches_grid_and_sink_with_increasing_seq() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%1".into(), PaneSpec { command: vec!["/bin/sh".into(), "-c".into(), "printf hello; sleep 1".into()],
            cwd: None, env: HashMap::new(), cols: 40, rows: 10 }, 1000, tx).unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Output { .. })));
        let (text, seq) = pane.capture(None, false);
        assert!(text.starts_with("hello"), "{text:?}");
        assert!(seq >= 1);
    }

    #[test]
    fn exit_is_reported_with_status() {
        let (tx, rx) = channel();
        let _pane = Pane::spawn("%2".into(), PaneSpec { command: vec!["/bin/sh".into(), "-c".into(), "exit 3".into()],
            cwd: None, env: HashMap::new(), cols: 40, rows: 10 }, 1000, tx).unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Exited { status: Some(3) })));
    }
}
```

- [ ] **Step 2: Run to fail**

Run: `cd pty && cargo test pane`
Expected: compile error.

- [ ] **Step 3: Implement**

Use `alacritty_terminal::tty::new(&Options { shell: Some(Shell::new(cmd[0], cmd[1..])), working_directory, env, drain_on_exit: true, .. }, WindowSize { num_lines: rows, num_cols: cols, cell_width: 1, cell_height: 1 }, 0)`.

Then:
- Keep the `Term<Listener>` in `Arc<Mutex<…>>`, together with `seq: u64` in the same mutex, so a
  capture and its sequence number are read atomically.
- The reader thread follows `vendor/alacritty_terminal/src/event_loop.rs` as the reference model:
  - register the pty with a `polling::Poller`;
  - on readable, read up to 64 KiB;
  - lock, `processor.advance(&mut term, &buf)`, `seq += 1`, unlock;
  - send `PaneEvent::Output { seq, bytes }`.
- On `pty.next_child_event()`, send `Exited { status }` from `ChildEvent::Exited(status)`.
- The `Listener` (an `EventListener`) does two things:
  - turns `Event::Title`/`ResetTitle` into `PaneEvent::Title`;
  - answers `Event::PtyWrite(text)` by writing back to the pty. Terminal query replies (DA1, DSR)
    must reach the program, as tmux answers them.
- The grid's scrollback comes from `Config { scrolling_history: history_limit, .. }`.
- OSC 7 cwd: `alacritty_terminal` does not surface OSC 7. Scan output bytes for `ESC ] 7 ; file://host/path (BEL|ST)`
  with a small state machine in `pane.rs` (`Osc7Scanner`) and keep the last path. Unit-test the
  scanner on split chunks.
- `meta()` reads:
  - `term.mode()`: `ALT_SCREEN`, `SHOW_CURSOR`, `MOUSE_REPORT_CLICK`, `MOUSE_DRAG`,
    `MOUSE_MOTION`, `UTF8_MOUSE`, `SGR_MOUSE`;
  - `term.grid().cursor.point`.
- On Unix, `kill` sends `SIGHUP` to the child's process group (`libc::kill(-pgid, SIGHUP)`), waits
  `grace`, then `SIGKILL`.

- [ ] **Step 4: Verify**

Run: `cd pty && cargo test pane`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add pty && git commit -m "feat(pty): pane with grid, output sequence and exit status"
```

### Task 10: Server, control ops, Unix socket, discovery

**Files:**
- Create: `pty/src/panes.rs`, `pty/src/server.rs`, `pty/src/transport/mod.rs`,
  `pty/src/transport/unix.rs`, `pty/src/discovery.rs`, `pty/src/cli.rs`
- Test: `pty/tests/control.rs` (integration test, Unix)

**Interfaces:**
- `harness-pty serve --home <HARNESS_HOME> [--history-limit N]` does the following:
  - writes `<home>/run/pty-host-<PROTOCOL>.json` = `{"protocol":1,"instance":"p1","endpoint":"<socket path or pipe name>","pid":…,"version":"…","token":"<uuid>"}`
    with mode 0600 on Unix (DACL on Windows, Task 17);
  - listens on `<home>/run/pty-host-1.sock` on Unix;
  - exits 0 when another host already owns the endpoint.
- Ids: `%<n>` from a per-instance counter starting at 1.
- Owner tag: kept per pane and returned in `inventory`.
- Held panes: a pane created or `holdOpen`ed with `hold=true` that exits stays in the table with
  `dead: true` and its last grid. Without hold, an exited pane is removed.
- `respawn` is allowed only on a dead held pane. When `expectedHeldToken` is given, it must equal
  the token recorded by `holdOpen`; on a mismatch it returns `held_mismatch`.
  - It spawns a new child into the same pane id, keeps the grid (scrollback survives, as tmux
    `respawn-pane` does) and resets `engineExit`.
  - The token comes from `holdOpen`'s optional `token`, and `paneState` returns it as
    `heldToken`. `PtyHostBackend.isHeld(runtime, token)` compares it, mirroring
    `TmuxBackend.isHeld`, which uses `heldPaneFormat` from `lib/nativePaneHold.ts`.
- `key` maps tmux key names to bytes. Reuse the mapping table from `tui/src/input.rs` (`encode_key`)
  by moving the key-name → bytes table into `harness-term` as `harness_term::keys::bytes_for(name, app_cursor: bool)`.
  `tui` keeps calling it from there.
- `paste` with `bracketed: true` writes `ESC[200~ text ESC[201~` only when the pane's
  `BRACKETED_PASTE` mode is on. Otherwise it writes the text. Control characters are neutralized the
  same way as `neutralizePasteControls` in `tmux.ts`; port that function's rule into
  `harness_term::paste::neutralize`.

- [ ] **Step 1: Write the failing integration test**

```rust
// pty/tests/control.rs
#![cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

struct Host { child: Child, home: tempfile::TempDir }
impl Drop for Host { fn drop(&mut self) { let _ = self.child.kill(); } }

fn start() -> (Host, serde_json::Value) {
    let home = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_harness-pty")).args(["serve", "--home"]).arg(home.path()).spawn().unwrap();
    let file = home.path().join("run/pty-host-1.json");
    let end = Instant::now() + Duration::from_secs(5);
    while !file.exists() { assert!(Instant::now() < end, "no discovery file"); std::thread::sleep(Duration::from_millis(20)) }
    let disc: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    (Host { child, home }, disc)
}

fn connect(disc: &serde_json::Value) -> (UnixStream, BufReader<UnixStream>) {
    let s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, r#"{{"hello":{{"token":"{}","protocol":1,"role":"control","clientId":"t"}}}}"#, disc["token"].as_str().unwrap()).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new(); r.read_line(&mut line).unwrap();
    assert!(line.contains(r#""ok":true"#), "{line}");
    (w, r)
}

fn call(w: &mut UnixStream, r: &mut BufReader<UnixStream>, req: &str) -> serde_json::Value {
    writeln!(w, "{req}").unwrap();
    loop {
        let mut line = String::new(); r.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v.get("id").is_some() { return v }
    }
}

#[test]
fn rejects_bad_token() {
    let (_h, disc) = start();
    let mut s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    writeln!(s, r#"{{"hello":{{"token":"nope","protocol":1,"role":"control","clientId":"t"}}}}"#).unwrap();
    let mut line = String::new(); BufReader::new(s).read_line(&mut line).unwrap();
    assert!(line.contains(r#""code":"incompatible""#), "{line}");
}

#[test]
fn create_capture_kill() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(&mut w, &mut r, r#"{"id":1,"op":"create","command":["/bin/sh"],"cols":80,"rows":24,"owner":"t","hold":false}"#);
    let pane = created["pane"].as_str().unwrap().to_string();
    assert!(pane.starts_with('%'));
    call(&mut w, &mut r, &format!(r#"{{"id":2,"op":"write","pane":"{pane}","data":"ZWNobyBoaS0kKCg0MCsyKSkK"}}"#)); // "echo hi-$((40+2))\n"
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(&mut w, &mut r, &format!(r#"{{"id":3,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#));
        if cap["text"].as_str().unwrap().contains("hi-42") { break }
        assert!(Instant::now() < end, "no output: {cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    call(&mut w, &mut r, &format!(r#"{{"id":4,"op":"kill","pane":"{pane}","graceMs":200}}"#));
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let st = call(&mut w, &mut r, &format!(r#"{{"id":5,"op":"paneState","pane":"{pane}"}}"#));
        if st["state"] == "gone" { break }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn second_host_exits_cleanly() {
    let (h, _disc) = start();
    let status = Command::new(env!("CARGO_BIN_EXE_harness-pty")).args(["serve", "--home"]).arg(h.home.path()).status().unwrap();
    assert!(status.success());
}
```

Add `tempfile = "3"` under `[dev-dependencies]`.

- [ ] **Step 2: Run to fail**

Run: `cd pty && cargo test --test control`
Expected: FAIL (no `serve`).

- [ ] **Step 3: Implement**

- **`server.rs`:**
  - one thread per connection;
  - the first line must be a valid hello with the discovery token and `protocol == PROTOCOL`,
    otherwise reply `incompatible` and close;
  - control connections loop: read line → `Request` → dispatch to `Panes` → write the reply line;
  - unsolicited `exit`/`title` events from the pane sink are broadcast to every control connection,
    behind a writer mutex per connection.
- **`panes.rs`:**
  - `Mutex<HashMap<String, PaneEntry>>`, where `PaneEntry { pane: Pane, owner, label, hold, held_token, dead: Option<i32>, engine_exit: Option<i32> }`;
  - a dispatcher thread consumes the `(id, PaneEvent)` channel, updates `dead`, and removes the
    entry when it is not held.
- **`transport/unix.rs`:**
  - bind `UnixListener` on the socket path;
  - if the path exists, try to connect first: if that succeeds, another host is alive and we exit 0;
    if it fails, unlink and bind;
  - `chmod 0600`.
- **`discovery.rs`:** write to `*.tmp`, set permissions, then `rename` (atomic replace).
- **`cli.rs`:** `serve`, `version` (prints `{"version":"…","protocol":1}`) and `ps --json` (Task 18;
  on Unix it prints `{"unsupported":true}` and exits 3).

- [ ] **Step 4: Verify**

Run: `cd pty && cargo test`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add pty term tui && git commit -m "feat(pty): host server, control ops and discovery"
```

### Task 11: Stream connections: subscribe, snapshot cut, backpressure

**Files:**
- Create: `pty/src/stream.rs`
- Modify: `pty/src/server.rs`
- Test: `pty/tests/stream.rs`

**Interfaces:**
- Subscribe: `Kind::Subscribe {"pane","cols","rows","readOnly"}`.
  - When `cols`/`rows` differ from the pane's size and `readOnly` is false, the pane is resized
    first (tmux resizes to the attached client the same way).
  - The host replies `Ack`, then streams `Output [seq][bytes]` frames for every output after the
    subscription.
- Snapshot: `Kind::Snapshot {"id":n,"history":"none"|"conversation","historyLines":N}`. The reply is
  `SnapshotReply {"id":n,"seq":S,"capture":"…","history":"…","meta":PaneMeta}`.
  - `capture` is the visible screen, `capture_pane(grid, None, true)`.
  - `history`, when requested, is `capture_pane` of the history lines only, with `-e`.
  - `seq` is the sequence number of the last output contained in that grid.
  - Output frames with `seq <= S` that the client receives after this reply are already in the
    snapshot. The client drops them (Task 14).
- Input:
  - `Input` writes bytes, unless `readOnly`;
  - `Paste` writes a bracketed paste (rule from Task 10);
  - `Resize` resizes the pane and grid;
  - `Pause`/`Resume` stop and restart delivery to *this* subscriber; output keeps reaching the grid.
- Backpressure:
  - each subscriber has a bounded queue (`4 * 1024 * 1024` bytes, counted by payload length);
  - when an enqueue would exceed it, the host sends `Closed {"reason":"overflow"}` and drops the
    subscriber;
  - paused subscribers count toward the same limit.
- Pane exit: subscribers get `Closed {"reason":"exited"}`, unless the pane is held, in which case
  the stream stays open (a respawn continues it).

- [ ] **Step 1: Write the failing tests**

Move `Host`, `start()`, `connect()` and `call()` from `control.rs` into `pty/tests/common/mod.rs`
(`mod common;` in both test files). Then add `pty/tests/stream.rs`:

```rust
#![cfg(unix)]
mod common;
use common::{call, connect, start};
use harness_pty::protocol::{read_frame, write_frame, Kind};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

fn stream(disc: &serde_json::Value) -> UnixStream {
    let mut s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    writeln!(s, r#"{{"hello":{{"token":"{}","protocol":1,"role":"stream","clientId":"t"}}}}"#, disc["token"].as_str().unwrap()).unwrap();
    let mut line = String::new();
    BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
    assert!(line.contains(r#""ok":true"#), "{line}");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s
}

fn subscribe(s: &mut UnixStream, pane: &str) {
    write_frame(s, Kind::Subscribe, format!(r#"{{"pane":"{pane}","cols":80,"rows":24,"readOnly":false}}"#).as_bytes()).unwrap();
    let (kind, _) = read_frame(s).unwrap().unwrap();
    assert_eq!(kind, Kind::Ack);
}

fn create(w: &mut UnixStream, r: &mut BufReader<UnixStream>, script: &str, hold: bool) -> String {
    let req = serde_json::json!({"id": 1, "op": "create", "command": ["/bin/sh", "-c", script], "cols": 80, "rows": 24, "owner": "t", "hold": hold});
    call(w, r, &req.to_string())["pane"].as_str().unwrap().to_string()
}

/// Reads frames until `until` returns true for the text gathered so far. Returns (frames, text).
fn read_until(s: &mut UnixStream, until: impl Fn(&str) -> bool) -> (Vec<(Kind, Vec<u8>)>, String) {
    let mut frames = Vec::new();
    let mut text = String::new();
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        let Some((kind, payload)) = read_frame(s).unwrap() else { break };
        if kind == Kind::Output { text.push_str(&String::from_utf8_lossy(&payload[8..])) }
        frames.push((kind, payload));
        if until(&text) { break }
    }
    (frames, text)
}

#[test]
fn snapshot_seq_cuts_output() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create(&mut w, &mut r, "sleep 0.3; i=1; while [ $i -le 200 ]; do echo line-$i; i=$((i+1)); done; sleep 3", false);
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("line-50"));
    write_frame(&mut s, Kind::Snapshot, br#"{"id":1,"history":"conversation","historyLines":300}"#).unwrap();
    let mut cut = None;
    let mut snapshot_text = String::new();
    let mut after = String::new();
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end && !(snapshot_text.contains("line-200") || after.contains("line-200")) {
        let (kind, payload) = read_frame(&mut s).unwrap().unwrap();
        match kind {
            Kind::SnapshotReply => {
                let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                cut = Some(v["seq"].as_u64().unwrap());
                snapshot_text = format!("{}{}", v["history"].as_str().unwrap(), v["capture"].as_str().unwrap());
            }
            Kind::Output if cut.is_some() => {
                let seq = u64::from_be_bytes(payload[..8].try_into().unwrap());
                if seq > cut.unwrap() { after.push_str(&String::from_utf8_lossy(&payload[8..])) }
            }
            _ => {}
        }
    }
    let total = format!("{snapshot_text}{after}");
    assert_eq!(total.matches("line-200").count(), 1, "{total}");
}

#[test]
fn overflow_drops_subscriber() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create(&mut w, &mut r, "sleep 0.3; yes 0123456789012345678901234567890123456789 | head -c 20000000; sleep 5", false);
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    std::thread::sleep(Duration::from_secs(2)); // do not read: the queue fills past 4 MiB
    let mut closed = None;
    while let Ok(Some((kind, payload))) = read_frame(&mut s) {
        if kind == Kind::Closed { closed = Some(String::from_utf8_lossy(&payload).to_string()); break }
    }
    assert!(closed.as_deref().is_some_and(|c| c.contains("overflow")), "{closed:?}");
    let mut again = stream(&disc);
    subscribe(&mut again, &pane);
    write_frame(&mut again, Kind::Snapshot, br#"{"id":2,"history":"none","historyLines":0}"#).unwrap();
    let (frames, _) = read_until(&mut again, |_| false);
    assert!(frames.iter().any(|(k, _)| *k == Kind::SnapshotReply));
}

#[test]
fn held_pane_keeps_stream_across_respawn() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create(&mut w, &mut r, "sleep 0.3; echo first; exit 0", true);
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("first"));
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let st = call(&mut w, &mut r, &serde_json::json!({"id": 2, "op": "paneState", "pane": pane}).to_string());
        if st["state"]["dead"] == true { break }
        assert!(Instant::now() < end, "{st}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let req = serde_json::json!({"id": 3, "op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", "echo second; sleep 1"]});
    assert_eq!(call(&mut w, &mut r, &req.to_string())["ok"], true);
    let (_, text) = read_until(&mut s, |t| t.contains("second"));
    assert!(text.contains("second"), "{text}");
}
```

- [ ] **Step 2: Run to fail**

Run: `cd pty && cargo test --test stream`
Expected: FAIL.

- [ ] **Step 3: Implement**

`stream.rs`:
- `Subscriber { pane, queue: Mutex<VecDeque<Frame>>, queued_bytes: AtomicUsize, paused: AtomicBool, writer thread }`;
- `Panes` keeps a `Vec<Weak<Subscriber>>` per pane;
- the dispatcher pushes each `Output` to the subscribers of that pane, or marks a subscriber
  overflowed when it is over the limit;
- the writer thread drains the queue to the socket, skipping drains while paused.

Snapshot runs on the connection's reader thread: call `pane.capture(…)` under the pane lock, which
returns `(text, seq)` atomically.

- [ ] **Step 4: Verify**

Run: `cd pty && cargo test`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add pty && git commit -m "feat(pty): stream subscriptions with snapshot cut and backpressure"
```

---

## Phase 3: `PtyHostBackend`

### Task 12: Host client and launch

**Files:**
- Create: `cli/src/lib/ptyHost/client.ts`, `cli/src/lib/ptyHost/launch.ts`
- Test: `cli/src/lib/ptyHost/client.spec.ts`

**Interfaces:**

```ts
export interface PtyHostDiscovery { protocol: number; instance: string; endpoint: string; pid: number; version: string; token: string }
export type PtyHostCallResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; code: string; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }
export class PtyHostClient {
  static connect(discovery: PtyHostDiscovery, timeoutMs?: number): Promise<PtyHostClient | { incompatible: string } | null>
  readonly instance: string
  call<T>(op: PtyOp, timeoutMs?: number): Promise<PtyHostCallResult<T>>
  openStream(): Promise<PtyHostStreamConnection | null>
  onEvent(listener: (event: { event: 'exit' | 'title'; pane: string; status?: number; title?: string }) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}
export function ptyHostBinary(): string | null   // HARNESS_PTY_BIN env, else <runtime>/pty/<version>/harness-pty[.exe], else beside dist/
export function readDiscovery(home: string, protocol: number): PtyHostDiscovery | null
export function ensurePtyHost(home: string): Promise<{ client: PtyHostClient } | { unavailable: string; code: 'PTY_HOST_UNAVAILABLE' }>
```

Rules for `call`:
- if the connection is closed before the write, the result is `not_started`;
- if the write happened and no reply arrived before the timeout (default 5 s) or the connection
  closed, the result is `possibly_executed`;
- a reply with `ok: false` is `rejected`, except `code: 'no_pane'`, which is `not_started`.

`ensurePtyHost`:
1. Read the discovery file and connect.
2. If the endpoint is unreachable, spawn `harness-pty serve --home <home>` detached:
   - Windows: `{ detached: true, windowsHide: true, stdio: 'ignore' }` plus
     `CREATE_BREAKAWAY_FROM_JOB`, which the host applies to itself by re-execing (Task 17);
   - Unix: `{ detached: true, stdio: 'ignore' }` then `unref()`.
3. Wait up to 5 s for the discovery file to change pid, then connect.
4. If the binary is missing, return `{ unavailable, code: 'PTY_HOST_UNAVAILABLE' }`.

- [ ] **Step 1: Write the failing tests**

Use a fake host: a `net.Server` on a temp socket that answers hello and echoes canned replies.

```ts
it('maps a write with no reply to possibly_executed', async () => {
  const fake = await fakeHost({ onRequest: () => {} /* never reply */ })
  const client = await PtyHostClient.connect(fake.discovery) as PtyHostClient
  const result = await client.call({ op: 'write', pane: '%1', data: 'aA==' }, 100)
  expect(result).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
  await fake.close()
})

it('maps a closed connection before write to not_started', async () => {
  const fake = await fakeHost({ onRequest: () => {} })
  const client = await PtyHostClient.connect(fake.discovery) as PtyHostClient
  client.close()
  expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  await fake.close()
})

it('reports a bad token as incompatible', async () => {
  const fake = await fakeHost({ token: 'right' })
  const result = await PtyHostClient.connect({ ...fake.discovery, token: 'wrong' })
  expect(result).toEqual({ incompatible: expect.stringContaining('token') })
  await fake.close()
})
```

`fakeHost` lives in the spec file. It is a `net.createServer` on
`path.join(tmpdir(), 'pty-<uuid>.sock')`, parsing NDJSON lines and answering hello with
`{"hello":{"ok":true,"instance":"p1","version":"test","pid":1}}`, or with `incompatible` when the
token differs.

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/ptyHost/client.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `client.ts` and `launch.ts` as specified. Use `net.connect(endpoint)`;
Node accepts `\\.\pipe\…` names on Windows, so one code path serves both.

- [ ] **Step 4: Verify**

Run: `cd cli && npx vitest run src/lib/ptyHost`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src/lib/ptyHost && git commit -m "feat(cli): pty host client and launcher"
```

### Task 13: `PtyHostBackend` control methods

**Files:**
- Create: `cli/src/lib/ptyHostBackend.ts`
- Test: `cli/src/lib/ptyHostBackend.spec.ts`

**Interfaces:**
- `class PtyHostBackend implements TerminalBackend<PtyRuntimeRef>`, constructed as
  `new PtyHostBackend({ home, launch = ensurePtyHost })`.
- `name = 'ptyhost'`, `instanceId = 'ptyhost:<instance>'`. The instance is set by `prepare()`.
- Mapping:
  - `create` → `create` op with `owner: harnessPaneOwner()`, `hold: true` (the agent services call
    `releaseHold` once the pane is a real agent, as with tmux), `cols: 200, rows: 50`, and the
    shell default from `lib/windows/shell.ts` when `request.command` is absent (Task 20; until then
    `$SHELL` or `/bin/sh` on Unix).
  - `kill` checks `current?.()` immediately before the call; `graceMs: 2000`.
  - `inventory` → roots `{ runtime: { backend: 'ptyhost', instance, paneId }, rootPid, cwd }`. A
    failed or unreachable call gives `unavailable`.
  - `titles` → keys from `terminalRouteKey`.
  - `validate` follows `TmuxBackend.validate`'s semantics. It uses `lookupPaneEngineProcess(this, …)`
    and `sameProcessIdentity`; on Windows it also requires `jobPids` membership (Task 19).
  - `capture` takes the mode:
    - `visible`: `visible: true`;
    - `recent_unwrapped`: `historyLines`;
    - `detection`: `historyLines: 40, ansi: false`.

    This matches `TmuxBackend.capture`; read its mode handling and mirror it exactly.
  - `typeLiteral` → `write` (UTF-8 base64).
  - `submitText` has the same timing as `sendToTmux` in `tmux.ts`:
    1. paste bracketed;
    2. wait `INJECT_PASTE_DELAY_BASE_MS` scaled by length (reuse the constants; export them from
       `tmux.ts` into a new `lib/submitTiming.ts`);
    3. call `beforeEnter` and withhold Enter on a reason;
    4. check `allowed`;
    5. `key Enter`.
  - `sendKey` maps the logical key to the tmux name (reuse `TMUX_KEYS` from `tmuxBackend.ts`,
    exported) and calls `key`.
  - `setTitle`, `notify`: `setTitle`. `notify` returns `TERMINAL_ACTION_SUCCEEDED`, because the
    daemon's own notifications cover it; ptyhost has no status line.
  - `holdOpen(runtime)` → `holdOpen` with a fresh UUID token, recorded so `respawn`'s
    `expectedHeldToken` matches.
  - `isHeld(runtime, token): Promise<boolean | 'unknown'>` → `paneState`, then
    `state.dead && state.heldToken === token`. A failed call gives `'unknown'`. It has the same
    signature as `TmuxBackend.isHeld`, which the adoption path calls.
  - `respawn`, `releaseHold`, `paneState`, `paneInfo`: direct.
  - `rootProcess` → `paneInfo`'s pid, or `'missing'` on `no_pane`.
  - `capabilities()` → `{ sessionEnv: true }`.
  - `prepare` → `ensurePtyHost`. It returns `unavailable` with code `PTY_HOST_UNAVAILABLE`, or
    `incompatible` mapped to unavailable with the reason.

- [ ] **Step 1: Write the failing tests**

Unit tests against a stub client:

```ts
function backendWith(replies: Record<string, unknown>) {
  const calls: PtyOp[] = []
  const client = { instance: 'p1', call: async (op: PtyOp) => { calls.push(op); return replies[op.op] ?? { state: 'ok', value: {} } },
    onEvent: () => () => {}, onClose: () => () => {}, close() {} }
  const backend = new PtyHostBackend({ home: '/tmp/h', launch: async () => ({ client: client as unknown as PtyHostClient }) })
  return { backend, calls }
}

it('inventory unavailable when the host call fails', async () => {
  const { backend } = backendWith({ inventory: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
  await backend.prepare({ ownedPanes: new Map() })
  expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'timeout' })
})

it('rootProcess says missing for no_pane', async () => {
  const { backend } = backendWith({ paneInfo: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'x' } })
  await backend.prepare({ ownedPanes: new Map() })
  expect(await backend.rootProcess({ backend: 'ptyhost', instance: 'p1', paneId: '%3' })).toBe('missing')
})

it('submitText withholds Enter when beforeEnter objects', async () => {
  const { backend, calls } = backendWith({})
  await backend.prepare({ ownedPanes: new Map() })
  const result = await backend.submitText({ backend: 'ptyhost', instance: 'p1', paneId: '%1' }, 'hi', { beforeEnter: async () => 'dialog' })
  expect(result).toMatchObject({ state: 'unknown', reason: 'enter_withheld:dialog' })
  expect(calls.some((c) => c.op === 'key')).toBe(false)
})
```

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/ptyHostBackend.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/lib/ptyHostBackend.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "feat(cli): PtyHostBackend control methods"
```

### Task 14: `PtyHostStream` with keyframes from `synthesizeTmuxSnapshot`

**Files:**
- Create: `cli/src/lib/ptyHost/stream.ts`
- Modify: `cli/src/lib/tmuxStream.ts` (export `PaneMeta`, `synthesizeTmuxSnapshot` is already
  exported), `cli/src/lib/ptyHostBackend.ts` (`openStream`)
- Test: `cli/src/lib/ptyHost/stream.spec.ts`

**Interfaces:**
- `PtyHostStream implements TerminalStreamHandle<PtyRuntimeRef>`:
  - `beginSnapshot()` starts buffering live output instead of forwarding it.
  - `snapshot(options)` sends the `Snapshot` frame and awaits `SnapshotReply`. It builds the keyframe:

    ```ts
    const meta: PaneMeta = { sessionId: '$0', windowId: '@0', windowPanes: 1, windowWidth: m.cols, windowHeight: m.rows,
      paneWidth: m.cols, paneHeight: m.rows, alternateOn: m.alternate_on, cursorX: m.cursor_x, cursorY: m.cursor_y,
      cursorVisible: m.cursor_visible, mouseStandard: m.mouse_standard, mouseButton: m.mouse_button,
      mouseAll: m.mouse_all, mouseUtf8: m.mouse_utf8, mouseSgr: m.mouse_sgr }
    const capture = normalizeTmuxCaptureLines(Buffer.from(reply.capture))
    const history = options?.tuiOwnsScrollback ? Buffer.alloc(0) : Buffer.from(reply.history)
    const historyRows = options?.conversationHistory ? rewrapHistory(history, m.cols) : undefined
    const bytes = synthesizeTmuxSnapshot(capture, meta, history, historyRows)
    ```

    `rewrapHistory` is whatever `tmuxStream.ts` calls from `historyRewrap.ts` for
    `conversationHistory`; use the same call. It records `cut = reply.seq`. When
    `options.repaint` is set, it waits for the print as `tmuxStream.ts` does (`printInProgress`)
    before requesting the snapshot.
  - `endSnapshot()` forwards the buffered outputs whose `seq > cut`, in order, then resumes direct
    forwarding.
  - `writeRaw` sends an `Input` frame; `pasteRaw`, a `Paste` frame; `resize`, a `Resize` frame.
    Each awaits `Ack` within 2 s; no ack gives `possibly_executed`.
  - `scroll(dir, lines)` writes PageUp/PageDown bytes `tuiScrollPageCount(lines)` times, as tmux does.
  - `pauseOutput`/`resumeOutput`/`close` map to `Pause`/`Resume` and socket end.
  - A `Closed` frame calls `sink.onClose(reason)`.

- [ ] **Step 1: Write the failing tests**

Against a fake stream connection (an in-memory duplex that the test drives):

```ts
it('drops output already contained in the snapshot', async () => {
  const { stream, host, sink } = await openFakeStream()
  host.output(1, 'a'); host.output(2, 'b')
  stream.beginSnapshot()
  const pending = stream.snapshot()
  host.output(3, 'c')                         // arrives during the snapshot
  host.snapshotReply({ seq: 2, capture: 'ab', history: '', meta: META })
  expect((await pending).state).toBe('succeeded')
  host.output(4, 'd')
  stream.endSnapshot()
  // a and b were forwarded live before beginSnapshot; c was held during it and is after the cut (seq 3 > 2); d is live again.
  expect(sink.text()).toBe('abcd')
})

it('reports overflow as close', async () => {
  const { host, sink } = await openFakeStream()
  host.closed('overflow')
  expect(sink.closedWith).toBe('overflow')
})
```

`openFakeStream` builds `PtyHostStream` over a `PassThrough` pair and gives the test helpers that
encode frames with `encodeFrame`.

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/ptyHost/stream.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified; `PtyHostBackend.openStream` opens a stream connection,
subscribes and returns the handle.

- [ ] **Step 4: Verify**

Run: `cd cli && npx vitest run src/lib/ptyHost src/lib/terminalStreamManager.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add cli/src && git commit -m "feat(cli): pty host streams with tmux-compatible keyframes"
```

### Task 15: Wire `ptyhost` into the daemon; run the contract on Linux

**Files:**
- Modify: `cli/src/core/main.ts` (backend construction from Task 3), `cli/src/config/env.ts`
- Create: `cli/src/lib/ptyHostBackend.contract.spec.ts`
- Modify: `.github/workflows/ci.yml`, in the existing CLI Linux job: build `pty` and run
  `test:terminal-contract` for ptyhost only. This runs only when `pty/`, `term/` or the listed TS
  files change, following the planner's component rules (see `docs/validation-and-release.md#pr-ci`
  for how a component's paths are declared).
- Modify: `cli/src/lib/ptyHostBackend.ts` (host death handling)

**Interfaces:**
- `config/env.ts` adds `HARNESS_PTY_DIR: text(join(adapterRootDir, 'pty'))`, next to
  `HARNESS_LOGS_DIR` (line 219). This is the host's `--home`; the host writes `run/` and
  `logs/pty-host.log` under it.
- `main.ts` adds `if (terminalConfig.backends.includes('ptyhost')) candidates.push(new PtyHostBackend({ home: env.HARNESS_PTY_DIR }))`.
- On client `onClose`, the backend:
  1. marks itself disconnected (`inventory` gives `unavailable`);
  2. schedules a reconnect: first through `ensurePtyHost`, then with backoff 1 s, 2 s, 4 s … max 30 s;
  3. when the reconnected host has a different pid than before (the host died), calls
     `this.onHostReplaced?.()`.
- The coordinator's reconcile then sees the old runtimes absent from `inventory()` (new host, no
  panes) and marks them `gone`, which feeds the existing resume path.

- [ ] **Step 1: Write the contract spec and the death test**

```ts
// ptyHostBackend.contract.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTerminalBackendContract } from './terminalBackend.contract.js'
import { PtyHostBackend } from './ptyHostBackend.js'
import { readDiscovery } from './ptyHost/launch.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && !!process.env.HARNESS_PTY_BIN
const home = mkdtempSync(join(tmpdir(), 'pty-contract-'))
;(enabled ? runTerminalBackendContract : () => describe.skip('ptyhost contract', () => {}))('ptyhost', async () => {
  const backend = new PtyHostBackend({ home })
  expect((await backend.prepare({ ownedPanes: new Map() })).state).toBe('ready')
  return { backend, cleanup: async () => { const d = readDiscovery(home, 1); if (d) process.kill(d.pid) } }
})

;(enabled ? describe : describe.skip)('ptyhost lifecycle', () => {
  it('host death marks runtimes gone', async () => {
    const h = mkdtempSync(join(tmpdir(), 'pty-death-'))
    const backend = new PtyHostBackend({ home: h })
    await backend.prepare({ ownedPanes: new Map() })
    const created = await backend.create({ command: ['/bin/sh'] })
    if (created.state !== 'succeeded') throw new Error('create')
    const before = readDiscovery(h, 1)!
    process.kill(before.pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 300))
    expect((await backend.inventory()).state).toBe('unavailable')
    // reconnect spawns a new host with no panes
    await new Promise((r) => setTimeout(r, 2_500))
    const inv = await backend.inventory()
    expect(inv.state).toBe('available')
    if (inv.state === 'available') expect(inv.roots).toEqual([])
    expect(await backend.paneState(created.runtime)).toBe('gone')
    process.kill(readDiscovery(h, 1)!.pid)
  })

  it('reattach after client reconnect keeps the pane and streams', async () => {
    const h = mkdtempSync(join(tmpdir(), 'pty-reattach-'))
    const first = new PtyHostBackend({ home: h })
    await first.prepare({ ownedPanes: new Map() })
    const created = await first.create({ command: ['/bin/sh'] })
    if (created.state !== 'succeeded') throw new Error('create')
    first.dispose()                                   // simulates the daemon exiting
    const second = new PtyHostBackend({ home: h })    // the restarted daemon
    await second.prepare({ ownedPanes: new Map() })
    const inv = await second.inventory()
    expect(inv.state === 'available' && inv.roots.some((r) => r.runtime.paneId === created.runtime.paneId)).toBe(true)
    process.kill(readDiscovery(h, 1)!.pid)
  })
})
```

`dispose()` closes the client without touching the host. Add it to `PtyHostBackend`.

- [ ] **Step 2: Run to fail**

Run: `cd pty && cargo build && cd ../cli && HARNESS_PTY_BIN=../pty/target/debug/harness-pty npm run test:terminal-contract`
Expected: FAIL for the lifecycle cases until the reconnect is implemented. Contract cases that fail
show where the host diverges from tmux. Fix the host, not the contract.

- [ ] **Step 3: Implement** the reconnect/backoff, `dispose`, and the `main.ts` wiring.

- [ ] **Step 4: Verify**

Run: `cd cli && HARNESS_PTY_BIN=../pty/target/debug/harness-pty npm run test:terminal-contract && npm run test:core && npm run test:resume`
Expected: PASS for both backends.

Then run a daemon on Linux (the docker box `machine-remote-1` per the team's recipe) with
`TERMINAL_BACKENDS=ptyhost HARNESS_PTY_BIN=…`, create a shell agent from the Mac desktop, type in it
and restart the daemon. The agent keeps its id and the tile reattaches.

- [ ] **Step 5: Checkpoint**

```bash
git add cli pty .github/workflows/ci.yml && git commit -m "feat(cli): ptyhost backend in the daemon, contract on Linux CI"
```

---

### Task 15b: Open restart, swap, restore and adoption to every backend

*Added during execution (2026-10-15).* Task 13's review found that every restart-shaped path is still gated to
tmux: `core/agents/restart.ts` answers `RESTART_UNSUPPORTED_BACKEND` for a row without a tmux runtime,
`swap.ts`/`retarget.ts` take `TmuxBackend`/`TmuxRuntimeRef`, restore runs only on tmux (`core/main.ts` restore
wiring) and `newPane.ts` checks the native hold only on tmux. The spec requires restart, fork, swap and resume
on Windows. Task 4 also carried three sites that still read `tmuxPane` as a tmux pane id.

**Files:**
- Modify: `cli/src/lib/terminalBackend.ts` (`isHeld?` joins the optional restart primitives)
- Modify: `cli/src/core/agents/restart.ts`, `swap.ts`, `retarget.ts`, `newPane.ts`, `externalResume.ts`,
  `cli/src/lib/restartAgent.ts`, `cli/src/lib/restoreAgents.ts`, `cli/src/core/main.ts` (restore and
  external-resume wiring, `paneRuntime`, `onTerminalHandoff`), `cli/src/core/terminals/sessions.ts`,
  `cli/src/core/terminals/requests.ts`, `cli/src/messages/service.ts`
- Test: the specs of each modified module; `cli/src/lib/ptyHostBackend.restart.spec.ts` (new, real host)

**Interfaces:**
- `TerminalBackend` gains `isHeld?(runtime: Ref, token: string): Promise<boolean | 'unknown'>` (TmuxBackend and
  PtyHostBackend already implement it).
- A backend can restart when it implements `holdOpen` and `respawn`; the gate is that capability, never the
  backend name. The error for a backend without them stays `RESTART_UNSUPPORTED_BACKEND`.
- Every restart-shaped path takes `TerminalBackend` and the session's own runtime (`primaryRuntime` or the
  runtime the row was placed on), never a hand-built `{ backend: 'tmux', paneId }`.
- `paneRuntime(pane)` in `main.ts` is replaced by the session's runtime; the messages inbox and terminal handoff
  key on `terminalRouteKey(runtime)` instead of the bare pane id, so equal `%N` ids on two backends never collide.

- [ ] **Step 1: Write the failing tests**
  - restart/swap/retarget specs: a row whose only runtime is `{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }`
    with a fake backend that implements `holdOpen`/`respawn` restarts through that backend (the fake records the
    calls; tmux is never asked); a fake backend without them still answers `RESTART_UNSUPPORTED_BACKEND`.
  - restoreAgents/newPane specs: the native-hold check (`isHeld`) is asked of the row's own backend.
  - sessions/requests specs: `visitStatus` and `terminal_info` ask the row's own backend.
  - messages/service spec: two rows with `%3` on different backends get distinct inbox keys.
  - `ptyHostBackend.restart.spec.ts` (runs only with `HARNESS_PTY_BIN`): create a pane running `/bin/sh`, holdOpen,
    kill the shell's pid, respawn with `/bin/sh -c 'echo again; exec /bin/sh'` — the same pane id now shows
    `again` and the earlier output is still in its scrollback.
- [ ] **Step 2: Run to fail** — `cd cli && npx vitest run <the specs above>`; expected: FAIL.
- [ ] **Step 3: Implement** as specified. Keep every tmux behavior and reason string unchanged.
- [ ] **Step 4: Verify** — `cd cli && npx tsc --noEmit && npm run test:core && npm run test:resume && npm run test:tmux-real && npx vitest run src/architecture.spec.ts`, and the real-host spec with `HARNESS_PTY_BIN=../pty/target/debug/harness-pty`. Baseline failures only.
- [ ] **Step 5: Checkpoint** — commit `feat(cli): restart, swap, restore and adoption on every backend`.

### Task 15c: Resume and stop on every backend

*Added during execution (2026-10-15).* After Task 15b, `cli/src/lib/resumeAgentService.ts` still looks for a
tmux runtime (resume answers `TMUX_UNAVAILABLE` on ptyhost) and `cli/src/lib/stopAgentService.ts` closes only tmux
panes. The spec requires resume and stop on Windows. `core/engines/hooks.ts:126` is also uncovered (pre-existing,
hidden while baseline failures stopped the coverage report).

**Files:**
- Modify: `cli/src/lib/resumeAgentService.ts`, `cli/src/lib/stopAgentService.ts`, their wiring in `cli/src/core/main.ts`
- Test: `cli/src/lib/resumeAgentService.spec.ts`, `cli/src/lib/stopAgentService.spec.ts`, `cli/src/core/engines/hooks.spec.ts`,
  `cli/src/lib/ptyHostBackend.restart.spec.ts` (extend with resume/stop against the real host)

**Interfaces:**
- Both services take the session's own runtime and `terminals.backendFor(runtime)`; the tmux path keeps its calls,
  order, authority checks and reason strings. A row with no runtime on a configured backend keeps today's
  "unavailable" answer; the error code names the backend that is missing (`TMUX_UNAVAILABLE` stays for tmux rows).

- [ ] **Step 1: Write the failing tests** — a ptyhost-only row resumes through its backend (inventory, `checkSessionRuntime`
  with its runtime, respawn with the resume command) and stops through its backend (kill / held-pane close), with tmux
  never asked; a mixed row still uses tmux for tmux work; `hooks.ts:126` covered.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — `npx tsc --noEmit && npm run test:core && npm run test:resume && npm run test:tmux-real`, the real-host spec, and a full-suite comparison with the baseline.
- [ ] **Step 5: Checkpoint** — commit `feat(cli): resume and stop on every backend`.

---

## Phase 4: Windows

### Task 16: Job Object per pane (vendored alacritty patch + `job.rs`)

**Files:**
- Modify: `tui/vendor/alacritty_terminal/src/tty/mod.rs` (Windows-only `Options` field),
  `tui/vendor/alacritty_terminal/src/tty/windows/conpty.rs` (spawn suspended, assign, resume)
- Create: `pty/src/job.rs`
- Modify: `pty/src/pane.rs` (Windows kill path), `pty/src/panes.rs` (`jobPids`)
- Test: `pty/src/job.rs` tests (`cfg(windows)`), `pty/tests/control.rs` Windows variants

**Interfaces:**
- `alacritty_terminal::tty::Options` gets `#[cfg(windows)] pub job: Option<isize>`, a raw
  `HANDLE`. With `Some`, conpty spawns the child with `CREATE_SUSPENDED` added to its creation
  flags, calls `AssignProcessToJobObject(job, pi.hProcess)`, then `ResumeThread(pi.hThread)`. If
  the assignment fails, it terminates the child and returns the error.
- `pub struct Job` in `job.rs`:
  - `Job::new() -> io::Result<Job>`: `CreateJobObjectW(null, null)`, with no kill-on-close limit;
  - `Job::handle(&self) -> isize`;
  - `pids(&self) -> io::Result<Vec<u32>>`: `QueryInformationJobObject(JobObjectBasicProcessIdList)`,
    growing the buffer until it fits;
  - `terminate(&self, code: u32) -> io::Result<()>`.
- Windows `Pane::kill(grace)`:
  1. drop the `Pty`, whose `Drop` calls `ClosePseudoConsole`, which sends `CTRL_CLOSE_EVENT`;
  2. poll `job.pids()` every 50 ms until empty or `grace` has passed;
  3. `job.terminate(1)`.
- A respawned pane gets a new `Job`.

- [ ] **Step 1: Write the failing Windows tests**

```rust
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn job_lists_children_and_terminates_tree() {
        let (tx, _rx) = std::sync::mpsc::channel();
        // cmd starts a child powershell that sleeps; both must be in the job.
        let pane = crate::pane::Pane::spawn("%1".into(), crate::pane::PaneSpec {
            command: vec!["cmd.exe".into(), "/c".into(), "powershell -NoProfile -Command Start-Sleep 30".into()],
            cwd: None, env: Default::default(), cols: 80, rows: 24 }, 1000, tx).unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while pane.job_pids().unwrap().len() < 2 { assert!(std::time::Instant::now() < end); std::thread::sleep(std::time::Duration::from_millis(100)) }
        pane.kill(std::time::Duration::from_millis(200));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !pane.job_pids().unwrap().is_empty() { assert!(std::time::Instant::now() < end); std::thread::sleep(std::time::Duration::from_millis(50)) }
    }
}
```

- [ ] **Step 2: Run on Windows to fail**

On the Windows VM (Task 23 setup) or through the workflow (Task 22):
`cd pty && cargo test job` gives a compile error, because `job_pids` is not defined.

- [ ] **Step 3: Implement** the patch and `job.rs` as specified. Note the vendored patch in
`tui/THIRD_PARTY_NOTICES.md` next to the existing alacritty patch note. Confirm `tui` still builds
on mac/Linux, where the field is `cfg(windows)` only.

- [ ] **Step 4: Verify**

Run: `cd pty && cargo test` on Windows, and `cd tui && cargo test` on the Mac.
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add tui/vendor tui/THIRD_PARTY_NOTICES.md pty && git commit -m "feat(pty): a Job Object per pane on Windows"
```

### Task 17: Named pipe transport with owner-only DACL and breakaway

**Files:**
- Create: `pty/src/transport/windows.rs`
- Modify: `pty/src/transport/mod.rs`, `pty/src/discovery.rs` (Windows ACL), `pty/src/cli.rs`
- Test: `pty/tests/control.rs` (transport-agnostic helpers: on Windows, connect via
  `std::fs::OpenOptions` to the pipe name)

**Interfaces:**
- Pipe name: `\\.\pipe\harness-pty-<16 hex of SHA-256(user SID string + "\0" + canonical home)>-p<PROTOCOL>`.
- First instance: `CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 64K, 64K, 0, &sa)`.
  - `ERROR_ACCESS_DENIED` on the first instance means another host owns the name: exit 0.
  - Each accepted client gets a new instance created without `FIRST_PIPE_INSTANCE`.
- Security attributes: the DACL is built from SDDL `D:P(A;;GA;;;<user SID>)`
  (`ConvertStringSecurityDescriptorToSecurityDescriptorW`). The same descriptor protects the
  discovery file (`SetFileSecurityW` after writing, before the rename).
- Breakaway: at the start of `serve`:
  - if `IsProcessInJob(GetCurrentProcess(), NULL)` is true, re-exec itself with
    `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and exit 0;
  - if the breakaway is denied (`ERROR_ACCESS_DENIED`), log a warning and continue in the job. The
    daemon's death may then take the host with it; harnessd (sub-project B) avoids this in
    production.

- [ ] **Step 1: Write the failing test**

Make the `control.rs` helpers transport-agnostic (`connect(disc)` returns
`Box<dyn ReadWrite>`). On Windows, open the pipe with `OpenOptions::new().read(true).write(true).open(endpoint)`.
Gate `rejects_bad_token`, `create_capture_kill` and `second_host_exits_cleanly` on `cfg(any(unix, windows))`;
on Windows they use `cmd.exe` in place of `/bin/sh`.

- [ ] **Step 2: Run on Windows to fail**

Run: `cd pty && cargo test --test control`
Expected: FAIL (no Windows transport).

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Verify**

Run on Windows: `cd pty && cargo test`. Then confirm the DACL by hand:
`powershell -c "(Get-Acl \\.\pipe\harness-pty-…).Access"` lists only the user. Record the output in
the PR.

- [ ] **Step 5: Checkpoint**

```bash
git add pty && git commit -m "feat(pty): named pipe transport with an owner-only DACL"
```

### Task 18: Windows process table (`ps --json`, `processes`)

**Files:**
- Create: `pty/src/ps.rs`
- Modify: `pty/src/cli.rs`, `pty/src/panes.rs` (the `processes` op)
- Test: `ps.rs` tests (`cfg(windows)`)

**Interfaces:**
- `pub fn snapshot() -> io::Result<Vec<ProcessRowJson>>`, where
  `#[derive(Serialize)] struct ProcessRowJson { pid: u32, parentPid: u32, executable: String, startMarker: String, args: String, nativeArgv: Vec<String>, imagePath: Option<String> }`
  (serde renames to camelCase).
- Sources:
  - `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)`, then `Process32FirstW`/`NextW`, for pid, parent
    and exe file name;
  - per pid, `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`:
    - `GetProcessTimes` gives the creation `FILETIME`, so `startMarker = format!("w:{}", u64 filetime)`;
    - `QueryFullProcessImageNameW` gives `imagePath`;
  - with `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ`,
    `NtQueryInformationProcess(ProcessCommandLineInformation = 60)` gives `args`, and
    `CommandLineToArgvW` gives `nativeArgv`.
- A process that cannot be opened (another user's, or protected) keeps pid, parent, executable and
  `startMarker: ""`. The TS side drops rows with an empty marker, because they can never be an
  identity.
- `harness-pty ps --json` prints `{"rows":[…]}`. The `processes` op returns the same.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(all(test, windows))]
#[test]
fn snapshot_contains_self_with_command_line() {
    let rows = snapshot().unwrap();
    let me = rows.iter().find(|r| r.pid == std::process::id()).expect("self row");
    assert!(me.start_marker.starts_with("w:"));
    assert!(me.args.contains("harness_pty") || me.args.contains("ps-"), "{}", me.args);
    assert_eq!(me.native_argv.first().map(|s| s.ends_with(".exe")), Some(true));
}
```

- [ ] **Step 2: Run on Windows to fail**

Run: `cd pty && cargo test ps`
Expected: compile error.

- [ ] **Step 3: Implement** as specified. Declare `NtQueryInformationProcess` through `windows-sys`'s
`Wdk_System_Threading` feature.

- [ ] **Step 4: Verify**

Run on Windows: `cd pty && cargo test ps && cargo run -- ps --json | findstr harness-pty`
Expected: PASS; the JSON lists itself.

- [ ] **Step 5: Checkpoint**

```bash
git add pty && git commit -m "feat(pty): Windows process table"
```

### Task 19: TypeScript Windows process control

**Files:**
- Create: `cli/src/lib/windows/processTable.ts`, `cli/src/lib/windows/treeKill.ts`
- Modify:
  - `cli/src/lib/ptyHostBackend.ts`: on win32, `prepare()` calls `setProcessTableSource` and
    `setProcessTerminator`; `validate` checks Job membership.
  - `cli/hook/notify.mjs`: its `processRows()` on win32 runs `harness-pty ps --json`.
  - `THIRD_PARTY_NOTICES`.
- Test: `cli/src/lib/windows/processTable.spec.ts`, `cli/src/lib/windows/treeKill.spec.ts`,
  `cli/src/lib/ptyHostBackend.spec.ts`

**Interfaces:**
- `windowsProcessRows(client: PtyHostClient | null): Promise<ProcessRow[] | null>`:
  - uses the `processes` op when a client is connected, else `execFile(ptyHostBinary(), ['ps', '--json'])`
    (3 s timeout);
  - maps JSON to `ProcessRow` and drops rows with an empty `startMarker`;
  - returns `null` on any failure, never `[]`.
- `windowsTerminator(backend: PtyHostBackend): ProcessTerminator`:
  1. If the identity's pid is in some pane's `jobPids`, it asks the host to `kill` that pane only
     when the pid is the pane's root. For a non-root process it uses `treeKill`.
  2. Otherwise it calls `treeKill(identity)`.
- `treeKill(identity, run = execFile)`, adapted from Orca's `windows-process-tree-kill.ts` and
  `windows-pty-root-identity.ts`:
  - re-read the table;
  - return `gone` when no row has the same identity;
  - otherwise run `taskkill /PID <pid> /T` (graceful) or `/T /F`;
  - exit code 128 ("not found") means `gone`.
- `PtyHostBackend.validate` on win32: after the identity match, it calls `jobPids(pane)`. If the pid
  is not in the list, the result is `{ state: 'gone', reason: 'process is not in the pane job' }`.

- [ ] **Step 1: Write the failing tests**

```ts
// windows/processTable.spec.ts
it('maps host rows and drops unidentifiable ones', async () => {
  const client = { call: async () => ({ state: 'ok', value: { rows: [
    { pid: 4, parentPid: 0, executable: 'System', startMarker: '', args: '', nativeArgv: [] },
    { pid: 900, parentPid: 4, executable: 'claude.exe', startMarker: 'w:133', args: 'claude.exe --resume x', nativeArgv: ['claude.exe', '--resume', 'x'] },
  ] } }) } as unknown as PtyHostClient
  expect(await windowsProcessRows(client)).toEqual([
    { pid: 900, parentPid: 4, executable: 'claude.exe', startMarker: 'w:133', args: 'claude.exe --resume x', nativeArgv: ['claude.exe', '--resume', 'x'] },
  ])
})
it('returns null, not [], when the read fails', async () => {
  const client = { call: async () => ({ state: 'unknown', dispatch: 'possibly_executed', reason: 't' }) } as unknown as PtyHostClient
  expect(await windowsProcessRows(client)).toBeNull()
})

// windows/treeKill.spec.ts
it('does not kill a recycled pid', async () => {
  const run = vi.fn()
  setProcessTableSource(async () => [{ pid: 9, parentPid: 1, executable: 'x', startMarker: 'w:2', args: '' }])
  try { expect(await treeKill({ pid: 9, executable: 'x', startMarker: 'w:1' }, { graceful: false }, run)).toBe('gone') }
  finally { setProcessTableSource(null) }
  expect(run).not.toHaveBeenCalled()
})

// ptyHostBackend.spec.ts
it('pid outside job is gone', async () => {
  const { backend } = backendWith({ jobPids: { state: 'ok', value: { pids: [1, 2] } } })
  await backend.prepare({ ownedPanes: new Map() })
  setProcessTableSource(async () => [
    { pid: 10, parentPid: 1, executable: 'pwsh', startMarker: 'w:1', args: 'pwsh' },
    { pid: 11, parentPid: 10, executable: 'claude.exe', startMarker: 'w:5', args: 'claude.exe' },
  ])
  try {
    const v = await backend.validateOn('win32', { backend: 'ptyhost', instance: 'p1', paneId: '%1' },
      { engine: 'claude', processIdentity: { pid: 11, executable: 'claude.exe', startMarker: 'w:5' } })
    expect(v).toEqual({ state: 'gone', reason: 'process is not in the pane job' })
  } finally { setProcessTableSource(null) }
})
```

`validateOn(platform, …)` is the testable core of `validate`; `validate` calls it with
`process.platform`. The `paneInfo` reply in `backendWith` must give `pid: 10` for this test.

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/lib/windows src/lib/ptyHostBackend.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified, with the Orca attribution header:
`// Adapted from stablyai/orca src/main/windows/windows-process-tree-kill.ts (MIT).`

- [ ] **Step 4: Verify**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/lib/windows src/lib/ptyHostBackend.spec.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git add cli THIRD_PARTY_NOTICES && git commit -m "feat(cli): Windows process table, identity and termination"
```

### Task 20: Default shell and ConPTY payload on Windows

**Files:**
- Create: `cli/src/lib/windows/shell.ts`
- Modify: `cli/src/lib/ptyHostBackend.ts` (default command), `cli/build-bundle.mjs` (copy
  `harness-pty.exe`, `conpty.dll` and `OpenConsole.exe` into `dist/pty/` when present)
- Create: `pty/scripts/fetch-conpty.ps1`, which downloads the `Microsoft.Windows.Console.ConPTY`
  NuGet package at a pinned version, verifies its SHA-256 and extracts `conpty.dll` and
  `OpenConsole.exe` for x64 and arm64 into `pty/vendor/conpty/<arch>/`. Record the version and hash
  in the script.
- Test: `cli/src/lib/windows/shell.spec.ts`

**Interfaces:**
- `defaultWindowsShell(find = binaryOnPath): string[]` returns the first match of:
  1. `['pwsh.exe', '-NoLogo']`;
  2. `['powershell.exe', '-NoLogo']`;
  3. `[process.env.ComSpec ?? 'cmd.exe']`.

  It is adapted from Orca's `windows-shell-fallback-chain.ts`; Git Bash and full env/PATH handling
  are sub-project B.
- The host loads `conpty.dll` from the exe's directory. The vendored alacritty already searches
  PATH and the exe dir (`conpty.rs:38`).

- [ ] **Step 1: Write the failing test**

```ts
it('prefers pwsh, then Windows PowerShell, then cmd', () => {
  expect(defaultWindowsShell((b) => b === 'pwsh.exe' ? 'C:/pwsh.exe' : null)).toEqual(['pwsh.exe', '-NoLogo'])
  expect(defaultWindowsShell((b) => b === 'powershell.exe' ? 'C:/ps.exe' : null)).toEqual(['powershell.exe', '-NoLogo'])
  expect(defaultWindowsShell(() => null)).toEqual([process.env.ComSpec ?? 'cmd.exe'])
})
```

- [ ] **Step 2: Run to fail, implement, verify**

Run: `cd cli && npx vitest run src/lib/windows/shell.spec.ts`
Expected: FAIL, then PASS after implementing.

Then on Windows:
1. `pwsh pty/scripts/fetch-conpty.ps1`;
2. `cargo build --release`;
3. copy into `dist/pty/`;
4. create a pane and confirm in the host log the line `Using conpty.dll for pseudoconsole`, which
   the vendored code logs.

- [ ] **Step 3: Checkpoint**

```bash
git add cli pty/scripts && git commit -m "feat(cli): Windows default shell and bundled ConPTY"
```

---

## Phase 5: Upgrade drain

### Task 21: Protocol N/N−1 and drain across host instances

**Files:**
- Modify: `cli/src/lib/ptyHost/launch.ts`, `cli/src/lib/ptyHostBackend.ts`, `cli/src/core/main.ts`
- Modify: `pty/src/cli.rs` (`--protocol` is fixed at build time; `version` prints it)
- Test: `cli/src/lib/ptyHost/drain.spec.ts`

**Interfaces:**
- The daemon declares `SUPPORTED_PTY_PROTOCOLS = [PTY_PROTOCOL - 1, PTY_PROTOCOL].filter((p) => p >= 1)`.
- `discoverHosts(home): PtyHostDiscovery[]` reads every `run/pty-host-<p>.json` with `p` supported.
- At `prepare()`, `main.ts` builds one `PtyHostBackend` per discovered host:
  - the instance named for the newest protocol is the **create** backend (new panes);
  - older ones are **drain** backends: listed, streamed and controlled, never chosen for `create`;
  - when no host for `PTY_PROTOCOL` exists, start one.
- A drain backend whose `inventory()` is empty for two consecutive reconcile passes is told to
  shut down: the `shutdown` op is added to the protocol at the version that introduces drain, and the
  host replies, then exits. The backend is then removed through
  `TerminalBackendCoordinator.replaceBackends`.
- After the shutdown, `runtime/pty/<version>/` directories not used by any running host (by
  discovery pid liveness) are deleted.

- [ ] **Step 1: Write the failing test**

```ts
it('creates on the newest host and keeps older panes on the old one', async () => {
  const home = tmpHome()
  writeDiscovery(home, { protocol: PTY_PROTOCOL - 1, instance: `p${PTY_PROTOCOL - 1}`, ...fakeHostAt(oldHost) })
  writeDiscovery(home, { protocol: PTY_PROTOCOL, instance: `p${PTY_PROTOCOL}`, ...fakeHostAt(newHost) })
  const { create, drain } = await prepareHosts(home)
  expect(create.instanceId).toBe(`ptyhost:p${PTY_PROTOCOL}`)
  expect(drain.map((b) => b.instanceId)).toEqual([`ptyhost:p${PTY_PROTOCOL - 1}`])
})

it('shuts a drained host down after two empty passes', async () => {
  const { drain, step } = await drainFixture({ oldPanes: [] })
  await step(); expect(drain[0].shutdownCalled).toBe(false)
  await step(); expect(drain[0].shutdownCalled).toBe(true)
})
```

This test runs only when `PTY_PROTOCOL >= 2`. To exercise it now, bump `PROTOCOL` in Rust and TS
to 2 in this task and add the `shutdown` op. That bump is itself the first real drain.

- [ ] **Step 2: Run to fail, implement, verify**

Run: `cd cli && npx vitest run src/lib/ptyHost/drain.spec.ts && HARNESS_PTY_BIN=../pty/target/debug/harness-pty npm run test:terminal-contract`
Expected: FAIL, then PASS.

Manual check on Linux:
1. Run a protocol-1 host build with one shell pane.
2. Start the protocol-2 daemon. The old pane still streams and new panes land on `p2`.
3. Exit the old pane. The `p1` host exits within two reconcile passes.

- [ ] **Step 3: Checkpoint**

```bash
git add cli pty && git commit -m "feat(pty): drain old hosts on a protocol bump"
```

---

## Phase 6: Validation

### Task 22: Manual "Windows PTY" workflow

**Files:**
- Create: `.github/workflows/windows-pty.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Windows PTY
on:
  workflow_dispatch:
jobs:
  windows-pty:
    strategy:
      matrix:
        target: [x86_64-pc-windows-msvc]
    runs-on: windows-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.target }},aarch64-pc-windows-msvc" }
      - uses: actions/setup-node@v4
        with: { node-version-file: cli/.nvmrc }
      - name: Fetch ConPTY payload
        run: pwsh pty/scripts/fetch-conpty.ps1
      - name: Rust tests
        working-directory: pty
        run: cargo test
      - name: Build release (x64 and arm64)
        working-directory: pty
        run: |
          cargo build --release --target x86_64-pc-windows-msvc
          cargo build --release --target aarch64-pc-windows-msvc
      - name: CLI install
        working-directory: cli
        run: npm ci
      - name: Contract suite against the real host
        working-directory: cli
        env:
          RUN_TERMINAL_CONTRACT: "1"
          HARNESS_PTY_BIN: ${{ github.workspace }}\pty\target\x86_64-pc-windows-msvc\release\harness-pty.exe
        run: npx vitest run src/lib/ptyHostBackend.contract.spec.ts src/lib/windows src/lib/ptyHost --maxWorkers=1
      - uses: actions/upload-artifact@v4
        with:
          name: harness-pty-windows
          path: |
            pty/target/x86_64-pc-windows-msvc/release/harness-pty.exe
            pty/target/aarch64-pc-windows-msvc/release/harness-pty.exe
```

If `cli/.nvmrc` does not exist, use the Node version the CLI release workflow pins.

- [ ] **Step 2: Run it once**

Run: `gh workflow run windows-pty.yml --ref feat/windows-native-pty`, then `gh run watch`.
Expected: green. Report the run link in the PR. Do not rerun for flakes; investigate them.

- [ ] **Step 3: Checkpoint**

```bash
git add .github/workflows/windows-pty.yml && git commit -m "ci: manual Windows PTY workflow"
```

### Task 23: E2E on a Windows 11 ARM64 VM, and the performance baseline

**Files:**
- Create: `docs/testing/windows-pty-e2e.md`, which records the VM setup recipe, each scenario's
  result, engine status and numbers.

- [ ] **Step 1: VM setup** (record each command in the doc)

1. Create a Windows 11 ARM64 VM in UTM on the Mac. Install Node at the CLI's version, Git for
   Windows (Claude Code needs it), Claude Code and Codex.
2. Build the CLI bundle on the Mac (`cd cli && npm run build`) and copy `dist/` to the VM.
3. Use the `harness-pty.exe` arm64 artifact from Task 22, plus `conpty.dll`/`OpenConsole.exe`.
4. Start the daemon on the VM: `node dist/cli.js daemon` with `HARNESS_PTY_BIN` set. Link it to
   the Mac as a machine with the same flow used for the docker boxes.

- [ ] **Step 2: Scenarios**

Run each and record pass/fail with evidence (log excerpt or screenshot):

1. Create Claude Code, Codex and PowerShell agents from the Mac desktop. Type, paste 30 KB of text,
   paste Vietnamese/CJK/emoji, and resize the tile.
2. Restart the daemon (stop/start the process). Agent ids are kept and tiles reattach.
3. Drain: install a protocol-bumped build. Old agents keep streaming, new agents use the new host,
   and the old host exits after its panes close.
4. `taskkill /F /PID <host pid>`: the agents show stopped, then resume relaunches each engine on its
   conversation.
5. In a PowerShell agent run `Start-Process powershell -ArgumentList '-c','Start-Sleep 600'`, then
   close the agent. `Get-Process powershell` shows no leftover.
6. `Set-Date (Get-Date).AddHours(3)` (admin), then wait one reconcile. No agent gets a new id. Set
   the date back.
7. For every other engine in `cli/src/engines`, try create and record "works", "works with caveat"
   or "does not run on Windows".

- [ ] **Step 3: Performance baseline**

With 0, 4 and 8 idle agents, and with 1 agent streaming `Get-ChildItem -Recurse C:\Windows`, record
host CPU % (`Get-Counter '\Process(harness-pty)\% Processor Time'` over 60 s) and working set. Do
the same for tmux on the Mac with the same agent counts (`ps -o %cpu,rss -p <tmux server pid>`).
Put both in the table in the doc.

- [ ] **Step 4: Checkpoint**

```bash
git add docs/testing/windows-pty-e2e.md && git commit -m "docs: Windows PTY E2E results and baseline"
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §1 Architecture | 8–11, 13–15 |
| §2 Coupling | 1–4 |
| §3 Process control | 5, 16, 18, 19 |
| §4 Lifecycle | 10 (single instance, discovery), 12 (spawn), 15 (crash → gone → resume), 17 (pipe, breakaway), 21 (drain) |
| §5 Testing | 6, 15, 22, 23 |
| Orca reuse | 19 (tree kill, identity), 20 (shell chain) |

Shell and env detection beyond the default shell is sub-project B, as the spec says.

**Additions found while planning,** written back into the spec:
- `%N` pane ids for wire compatibility;
- `harness-term` extracted from `tui/src/capture.rs` for byte-compatible capture;
- keyframes reuse `synthesizeTmuxSnapshot`;
- the vendored alacritty patch for suspended spawn into the Job;
- the agent-process `process.kill` sites are 22, not about 60; daemon kills move to B.
