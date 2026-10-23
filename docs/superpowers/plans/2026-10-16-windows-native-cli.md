# Windows Native CLI (sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows user, or a Windows machine used as a remote machine, installs the Harness CLI with one
PowerShell command and gets what a Mac gets: a daemon that starts at logon and keeps itself running, updates
and rolls back without ending agents, trusts only its own user's local calls, reports every engine's state
through hooks, and uninstalls cleanly.

**Architecture:** Mirror the Mac flow with Windows pieces. B1 publishes the Windows artifacts and adds a
per-user `install.ps1`, version folders with pointer files, `harness.exe` and a windowless `harness-launch.exe`.
B2 serves the daemon's HTTP API on a named pipe with per-request HMAC auth and proof. B3 runs harnessd under a
per-user scheduled task, stops it by protocol message (never signals, never `taskkill /T`), replaces the master
without exec, and self-updates over version folders. B4 turns hooks on with per-engine Windows runners. B5 adds
`harness uninstall` on every OS, a Windows install job in CI and the VM end to end.

**Tech Stack:**
- TypeScript (Node 22, vitest) in `cli/`; Windows PowerShell 5.1 for `install.ps1`, tested by vitest driving
  `powershell.exe`.
- Rust 2024 in `pty/` (`harness-launch` binary, `windows-sys`).
- GitHub Actions `windows-latest` and `windows-11-arm`; the UTM Windows 11 ARM64 VM.

**Spec:** `docs/superpowers/specs/2026-10-16-windows-native-cli-design.md` (sub-project A, which this builds
on: `docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md`)

## Global Constraints

- **Per-user, no administrator rights, no UAC prompt** for install, run, update and uninstall. Never touch the
  machine PATH or `HKLM` (reading `HKLM` for the CPU architecture is allowed).
- **mac/Linux do not change**, except the new `harness uninstall`. Version folders, pointers, `.cmd` launchers,
  the named pipe and Task Scheduler are win32-only branches. Full-suite baselines have pre-existing reds: compare
  against a clean `origin/main` worktree, never claim "all green".
- **No symlinks on Windows.** Pointers are files, written by temp file + rename, read with the
  "must resolve inside its root" check.
- **Layout:** `%USERPROFILE%\.harness\{bin\harness.exe, bin\harness-launch.exe, cli\<version>\, cli\current,
  cli\notify.mjs, cli\data\, runtime\node-<ver>-win32-<arch>\, runtime\current-node, runtime\pty\<ver>\,
  runtime\pty\current-pty}`.
- **Trust:** on Windows, reaching the pipe is never trust; only a pipe request with valid
  `X-Harness-Auth` is (`isTrustedLocal`). The token never travels. A client rejects a response without a valid
  `X-Harness-Proof`, and checks the daemon's pid (pid + start marker) before dialling.
- **harnessd rules** (`cli/src/harnessd/AGENTS.md`) hold: the master opens no sockets; the spawn protocol only
  grows; OS access is injected; 100% coverage per harnessd file; the master is replaced only before a core starts.
- **Never `taskkill /T`** on the daemon or a host: the pty host's parent is the core. End one verified process
  with `TerminateProcess` after the identity check.
- **Agents survive** a daemon restart, update, rollback and reinstall.
- **Publishing:** staging prefix `harness/staging/` only. Publishing to production manifests is a step the owner
  starts; no task does it.
- **Copy:** every message a person sees is a sentence a first-time user understands (Naming System,
  `docs/naming-system.md`).
- **`hn` is not ported**; `harness tui` says so on Windows.
- **VM:** `ssh admin@192.168.65.3`; never touch `C:\work\e2e` (a signed-in daemon) or the admin profile's
  engine settings without backup and restore.
- **Test-only exception:** B5.14 sets and removes Winlogon autologon in HKLM as admin.

## Review Focus

1. **A second Windows user on the same machine installs too** — gets their own task, pipe and daemon; neither
   sees the other's. Task names are machine-wide, so each user's task is `taskName(<user>)`,
   `Harness harnessd (<user>)` in the root folder. Test: B3.12's main text (`taskName` and its spec case, used by
   B3.13, B3.21, B5.9, B5.12 and B5.14); B5.14 Step 7 (scenario 6), where the second user installs and runs its own
   daemon.
2. **Arguments with `&`, `%`, `^`, `!`, `"` or spaces through `harness.exe`** reach the CLI unchanged when passed from cmd or
   Windows PowerShell 5.1 (it is an .exe, so cmd never re-parses them; PowerShell 5.1's own dropping of an inner
   `"` is pinned in the B1 notes), and nothing extra runs. Test: B1.8 Step 6 "Review Focus 2 and 3" (fix round 1).
3. **`irm | iex` under the default `Restricted` execution policy on Windows PowerShell 5.1** installs, and
   `harness` then runs from a Restricted PowerShell. Test: B1.8 Step 6 "Review Focus 2 and 3".
4. **Running the installer again over a live install** fails on no file in use and never restarts an agent. When
   the version changed and a daemon runs, install.ps1 moves the daemon to the new build by restarting it once
   (`harness stop`, then `harness start`; the terminal host and its agents are independent of it); the same version
   restarts nothing. Code and unit test: B3.15. Test: B5.14 Step 8 "Review Focus 4".
5. **Uninstalling a broken or half install** (no pointer, no daemon, no task) removes what is there and exits 0,
   with no error line and no new message. Pinned at the command level: B5.9 Step 6 "Review Focus 5". `harness.exe`
   without `cli\current` keeps telling the person to run the installer again; re-running install.ps1 repairs the
   install, and `harness uninstall` then works (B5.14 Step 9).

## Phases and order

B1 Distribution (B1.1–B1.13) → B2 IPC and trust (B2.1–B2.12) → B3 harnessd lifecycle and self-update
(B3.1–B3.21) → B4 Hooks and engines (B4.1–B4.16) → B5 Uninstall, Windows CI install job, E2E (B5.1–B5.14).
Each phase is testable on its own; within a phase, tasks run in order. Each phase ends with its notes:
decisions taken while planning, and open risks.

---

## Phase B1: Distribution and install

B1 makes the CLI installable on Windows with one PowerShell command. It covers the version-folder layout and its
pointer files, the managed Node for `win32-x64`/`win32-arm64`, the windowless `harness-launch.exe`, `install.ps1`
with `harness.cmd`, and the scripts and workflows that publish the Windows artifacts to a **staging** prefix.
Production publishing stays a manual owner step.

Conventions in this part:

- **VM sync:** `cli/scripts/windows-pty-e2e/vm-sync.sh --cli` copies the tree to `C:\work\oh` on
  `admin@192.168.65.3`. Run it before any VM command.
- **VM tests:** `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run <paths>"`.
  `C:\work\e2e` belongs to a signed-in daemon and is never touched. Scratch folders for this phase live under `C:\work\b1`.
- **Commits:** each task ends with a commit step. Follow the user's standing rule: leave changes uncommitted until
  the user asks for commits, then commit per task with the message given.

### Task B1.1: Pointer files and the Windows install layout (`installLayout.ts`)

**Files**
- Create: `cli/src/lib/windows/installLayout.ts`
- Create: `cli/src/lib/windows/installLayout.spec.ts`

**Interfaces**
- Consumes: nothing.
- Produces (exact, from the contract):
  - `readPointer(root: string, name: string): string | null`
  - `writePointer(root: string, name: string, value: string): void`. An optional 4th parameter
    `fs: PointerFs` exists for tests only.
  - `currentCli(rootDir: string): { version: string; dir: string; cliJs: string; notifyMjs: string } | null`
  - `CLI_POINTER = 'current'`, `STABLE_NOTIFY = 'notify.mjs'`
  - Also, for B3/B5: `LAUNCH_EXE = 'harness-launch.exe'`, `harnessLaunchPath(rootDir: string): string`
    (`<root>\bin\harness-launch.exe`), `isSingleSegment(value: string): boolean`.

- [ ] **Step 1: Write the failing test.** Create `cli/src/lib/windows/installLayout.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLI_POINTER, LAUNCH_EXE, STABLE_NOTIFY, currentCli, harnessLaunchPath, isSingleSegment, readPointer, writePointer, type PointerFs,
} from './installLayout.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-layout-'))
  roots.push(root)
  return root
}

/** A rename that fails with each code in [failures] in turn, then renames for real; and the waits between. */
function flaky(failures: string[]): PointerFs & { sleeps: number[]; calls: () => number } {
  const sleeps: number[] = []
  let calls = 0
  return {
    sleeps,
    calls: () => calls,
    sleep: (ms) => { sleeps.push(ms) },
    rename: (from, to) => {
      const code = failures[calls++]
      if (code) throw Object.assign(new Error(code), { code })
      renameSync(from, to)
    },
  }
}

describe('pointer files', () => {
  it('reads the first line, trimmed, whichever line ending wrote it', () => {
    const root = scratch()
    writeFileSync(join(root, 'crlf'), '1.2.3\r\n')
    writeFileSync(join(root, 'lf'), '  0.3.120-dev.abc123  \nignored\n')
    expect(readPointer(root, 'crlf')).toBe('1.2.3')
    expect(readPointer(root, 'lf')).toBe('0.3.120-dev.abc123')
  })

  it('has no answer for a missing or empty pointer', () => {
    const root = scratch()
    writeFileSync(join(root, 'empty'), '\r\n')
    expect(readPointer(root, 'missing')).toBeNull()
    expect(readPointer(root, 'empty')).toBeNull()
  })

  it('refuses a pointer that could name anything but one folder beside it', () => {
    const root = scratch()
    for (const value of ['..', '.', '../1.2.3', '1.2.3\\..\\x', 'a/b', 'a\\b', 'C:x', 'x..y', 'notify.mjs:stream']) {
      writeFileSync(join(root, 'p'), `${value}\r\n`)
      expect(readPointer(root, 'p'), value).toBeNull()
      expect(isSingleSegment(value), value).toBe(false)
    }
  })

  it('writes the value and CRLF, with no BOM, through a temporary file that does not stay', () => {
    const root = scratch()
    writePointer(root, 'current', '1.2.3')
    expect(readFileSync(join(root, 'current'))).toEqual(Buffer.from('1.2.3\r\n'))
    writePointer(root, 'current', '1.2.4')
    expect(readPointer(root, 'current')).toBe('1.2.4')
    expect(readdirSync(root)).toEqual(['current'])
  })

  it('retries a rename an antivirus scan or the indexer holds, waiting longer each time', () => {
    const root = scratch()
    const fs = flaky(['EPERM', 'EBUSY', 'EACCES'])
    writePointer(root, 'current', '1.2.3', fs)
    expect(readPointer(root, 'current')).toBe('1.2.3')
    expect(fs.sleeps).toEqual([25, 50, 100])
  })

  it('gives up after five attempts, throws, and leaves no temporary file', () => {
    const root = scratch()
    writeFileSync(join(root, 'current'), '1.2.2\r\n')
    const fs = flaky(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'])
    expect(() => writePointer(root, 'current', '1.2.3', fs)).toThrow('EBUSY')
    expect(fs.calls()).toBe(5)
    expect(readdirSync(root)).toEqual(['current'])
    expect(readPointer(root, 'current')).toBe('1.2.2')
  })

  it('does not retry a failure waiting cannot fix', () => {
    const root = scratch()
    const fs = flaky(['ENOENT'])
    expect(() => writePointer(root, 'current', '1.2.3', fs)).toThrow('ENOENT')
    expect(fs.calls()).toBe(1)
    expect(fs.sleeps).toEqual([])
  })

  it('refuses to write a pointer its readers would refuse', () => {
    const root = scratch()
    expect(() => writePointer(root, 'current', '..\\escape')).toThrow('one folder')
    expect(readdirSync(root)).toEqual([])
  })
})

describe('currentCli', () => {
  function installed(root: string, version: string): string {
    const dir = join(root, 'cli', version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cli.js'), '')
    writeFileSync(join(dir, 'notify.mjs'), '')
    writeFileSync(join(root, 'cli', CLI_POINTER), `${version}\r\n`)
    return dir
  }

  it('names the version folder cli\\current points at, and its two files', () => {
    const root = scratch()
    const dir = installed(root, '1.2.3')
    expect(currentCli(root)).toEqual({ version: '1.2.3', dir, cliJs: join(dir, 'cli.js'), notifyMjs: join(dir, STABLE_NOTIFY) })
  })

  it('has no answer without a pointer, or for a folder missing either file', () => {
    const root = scratch()
    expect(currentCli(root)).toBeNull()
    const dir = installed(root, '1.2.3')
    rmSync(join(dir, 'notify.mjs'))
    expect(currentCli(root)).toBeNull()
    writeFileSync(join(root, 'cli', CLI_POINTER), 'data\r\n')
    mkdirSync(join(root, 'cli', 'data'), { recursive: true })
    expect(currentCli(root)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a version folder that resolves outside cli\\', () => {
    const root = scratch()
    const outside = installed(scratch(), '9.9.9')
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside, join(root, 'cli', '9.9.9'))
    writeFileSync(join(root, 'cli', CLI_POINTER), '9.9.9\r\n')
    expect(currentCli(root)).toBeNull()
  })

  it('puts the windowless starter in bin\\', () => {
    expect(harnessLaunchPath(join('R', '.harness'))).toBe(join('R', '.harness', 'bin', LAUNCH_EXE))
    expect(LAUNCH_EXE).toBe('harness-launch.exe')
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/lib/windows/installLayout.spec.ts`.
  Expected: it fails with `Failed to resolve import "./installLayout.js"`.

- [ ] **Step 3: Implement.** Create `cli/src/lib/windows/installLayout.ts`:

```ts
/**
 * The Windows install layout (spec section 1). Every version gets a folder, and pointer files name the one in use.
 * Windows cannot replace a running file, and creating a symlink needs Developer Mode or a privilege.
 *
 *   %USERPROFILE%\.harness\
 *     bin\harness.cmd, bin\harness-launch.exe
 *     cli\<version>\cli.js, notify.mjs, package.json
 *     cli\current              the version in use: one line, one folder name
 *     cli\notify.mjs           the stable copy that hook command lines name (B4)
 *     runtime\current-node     node.exe's full path, as on a Mac (managedNodePath)
 *     runtime\pty\current-pty  the pty host's version folder (ptyHost/launch.ts currentPtyVersion)
 *
 * install.ps1 and the updater (B3) write these files. harness.cmd, harness-launch.exe (pty/src/launcher.rs) and
 * the desktop app read them. The pointer readers in Node and in Rust (harness-launch.exe) apply the rules this file
 * applies: one segment, resolved inside its root. harness.cmd cannot do the containment check in cmd; it relies on
 * `if not exist` checks of the files the pointers resolve to.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export const CLI_POINTER = 'current'
export const STABLE_NOTIFY = 'notify.mjs'
export const LAUNCH_EXE = 'harness-launch.exe'

/** `<root>\bin\harness-launch.exe`. install.ps1 copies it there from the pty payload. */
export function harnessLaunchPath(rootDir: string): string {
  return join(rootDir, 'bin', LAUNCH_EXE)
}

/**
 * A pointer names one folder beside it. That rules out `.`, any `..`, a separator, and a `:`. A `:` could be a
 * drive (`C:x`) or an NTFS stream (`notify.mjs:x`).
 */
export function isSingleSegment(value: string): boolean {
  return value !== '' && value !== '.' && !value.includes('..') && !/[\\/:\0]/.test(value)
}

/** `<root>\<name>`'s first line, trimmed. Null when it is missing, empty, or names more than one folder. */
export function readPointer(root: string, name: string): string | null {
  let text: string
  try {
    text = readFileSync(join(root, name), 'utf8')
  } catch {
    return null
  }
  const value = (text.split(/\r?\n/, 1)[0] ?? '').trim()
  return isSingleSegment(value) ? value : null
}

/** The two calls [writePointer] makes that tests replace. */
export interface PointerFs {
  rename: (from: string, to: string) => void
  sleep: (ms: number) => void
}

const defaultFs: PointerFs = {
  rename: renameSync,
  // Synchronous on purpose: a pointer write is a few milliseconds, and its callers are synchronous.
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}

/**
 * The codes Windows gives for a moment when an antivirus scan, the search indexer or a reader holds the file.
 * Waiting can fix those, and nothing else.
 */
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES'])
const ATTEMPTS = 5

/**
 * Point `<root>\<name>` at [value] by writing a temporary file and renaming it over the old one. A reader sees
 * either the old pointer or the new one, never half of one. The line ends in CRLF with no BOM: harness.cmd reads
 * it with `set /p`, which would keep a BOM as part of the value.
 */
export function writePointer(root: string, name: string, value: string, fs: PointerFs = defaultFs): void {
  if (!isSingleSegment(value)) throw new Error(`a pointer names one folder, not ${JSON.stringify(value)}`)
  const target = join(root, name)
  const temporary = join(root, `.${name}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(temporary, `${value}\r\n`)
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(temporary, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!RETRIED.has(code) || attempt >= ATTEMPTS) {
        rmSync(temporary, { force: true })
        throw error
      }
      fs.sleep(25 * 2 ** (attempt - 1))
    }
  }
}

export interface CurrentCli {
  version: string
  dir: string
  cliJs: string
  notifyMjs: string
}

/**
 * The CLI `cli\current` names: `<root>\cli\<version>\` with its cli.js and notify.mjs. Null when the pointer is
 * missing or bad, when a file is missing, or when a file resolves outside `cli\`. That last case is a junction or
 * symlink planted as a version folder.
 */
export function currentCli(rootDir: string): CurrentCli | null {
  const cliRoot = join(rootDir, 'cli')
  const version = readPointer(cliRoot, CLI_POINTER)
  if (!version) return null
  const dir = join(cliRoot, version)
  const cliJs = join(dir, 'cli.js')
  const notifyMjs = join(dir, STABLE_NOTIFY)
  if (!existsSync(cliJs) || !existsSync(notifyMjs)) return null
  try {
    const inside = realpathSync(cliRoot) + sep
    if (!realpathSync(cliJs).startsWith(inside) || !realpathSync(notifyMjs).startsWith(inside)) return null
  } catch {
    return null
  }
  return { version, dir, cliJs, notifyMjs }
}
```

- [ ] **Step 4: Run it and see it pass.** Run `cd cli && npx vitest run src/lib/windows/installLayout.spec.ts && npx tsc --noEmit`.
  Expected: all pass, and the typecheck is clean.

- [ ] **Step 5: Windows verification.** This spec is in `src/lib/windows`, which the Windows workflow already runs.
  On the VM, after `vm-sync.sh --cli`:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run src/lib/windows/installLayout.spec.ts"`.
  Expected: everything passes, and the symlink case is skipped. This is the case that shows NTFS rename-over works for
  `writePointer`.

- [ ] **Step 6: Commit.**
  `git add cli/src/lib/windows/installLayout.ts cli/src/lib/windows/installLayout.spec.ts`
  `git commit -m "feat(cli): the Windows install layout: version folders named by pointer files"`

### Task B1.2: The managed Node for Windows in `runtimeInstall.ts`

**Files**
- Modify: `cli/src/lib/runtimeInstall.ts`:
  - lines 24-29: `platformKey`.
  - lines 164-204: `ensureManagedArchive`, including the archive name at 194, the tar call at 196 and the pointer
    write at 225.
  - lines 207-210: `readOnly`.
  - line 271: Node's `binary`.
  - line 294: the grid guard.
- Modify: `cli/src/lib/runtimeInstall.spec.ts` (a new `describe` appended after line 688)
- Create: `cli/src/lib/windows/runtimeInstall.win.spec.ts` (real unpack, Windows only)

**Interfaces**
- Consumes: nothing from B1.1.
- Produces:
  - `platformKey(platform?: NodeJS.Platform, arch?: string): string | null`. It is now exported and returns
    `win32-x64` / `win32-arm64` on Windows.
  - `unpackCommand(archive: string, into: string, platform?: NodeJS.Platform, systemRoot?: string): { file: string; args: string[] }`.
    On Windows it is `%SystemRoot%\System32\tar.exe -xf`.
  - `runtimeLayout(platform?: NodeJS.Platform): { archiveSuffix: '.zip' | '.tar.gz'; nodeBinary: string; eol: string }`.
  - `ensureManagedRuntime` on win32 installs `runtime\node-<v>-win32-<arch>\node.exe` and writes `current-node`
    with CRLF. It never runs chmod there.
  - `ensureManagedGrid` returns null on win32 without fetching anything.

- [ ] **Step 1: Write the failing tests.** Append this to the end of `cli/src/lib/runtimeInstall.spec.ts`, after line 688:

```ts
describe('the managed runtimes on Windows', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-runtime-windows-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    mkdirSync(runtimeDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL', 'ADAPTER_GRID_RUNTIME_METADATA_URL', 'HARNESS_GRID_BIN']) {
      delete process.env[key]
    }
  })

  it('names the Windows platforms the way the manifests key them, and nothing it publishes nothing for', async () => {
    const { platformKey } = await load()
    expect(platformKey('win32', 'x64')).toBe('win32-x64')
    expect(platformKey('win32', 'arm64')).toBe('win32-arm64')
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('linux', 'x64')).toBe('linux-x64')
    expect(platformKey('win32', 'ia32')).toBeNull()
    expect(platformKey('freebsd', 'x64')).toBeNull()
  })

  it('unpacks with the tar.exe Windows ships, never a tar from PATH, and nodejs.org\'s tarball with /usr/bin/tar elsewhere', async () => {
    const { unpackCommand } = await load()
    expect(unpackCommand('C:\\r\\.node-staging-1\\node.zip', 'C:\\r\\.node-staging-1', 'win32', 'D:\\Windows')).toEqual({
      file: 'D:\\Windows\\System32\\tar.exe',
      args: ['-xf', 'C:\\r\\.node-staging-1\\node.zip', '-C', 'C:\\r\\.node-staging-1'],
    })
    // A scrubbed environment with no SystemRoot falls back to Windows' own folder, never to a relative tar.exe.
    expect(unpackCommand('a.zip', 'b', 'win32', '').file).toBe('C:\\Windows\\System32\\tar.exe')
    expect(unpackCommand('/r/node.tar.gz', '/r', 'darwin')).toEqual({ file: '/usr/bin/tar', args: ['-xzf', '/r/node.tar.gz', '-C', '/r'] })
  })

  it('lays Node out as nodejs.org ships it: a zip with node.exe at its root folder on Windows, bin/node in a tarball elsewhere', async () => {
    const { runtimeLayout } = await load()
    expect(runtimeLayout('win32')).toEqual({ archiveSuffix: '.zip', nodeBinary: 'node.exe', eol: '\r\n' })
    expect(runtimeLayout('darwin')).toEqual({ archiveSuffix: '.tar.gz', nodeBinary: join('bin', 'node'), eol: '\n' })
    expect(runtimeLayout('linux')).toEqual({ archiveSuffix: '.tar.gz', nodeBinary: join('bin', 'node'), eol: '\n' })
  })

  it('installs no grid on Windows: nothing is fetched and nothing is laid down, even with a pointer left behind', async () => {
    installedGrid('0.3.47', 'win32-x64', true)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { ensureManagedGrid } = await load()
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(await ensureManagedGrid()).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
```

  Then create `cli/src/lib/windows/runtimeInstall.win.spec.ts`. It does the real unpack, and the Windows workflow
  and the VM run it:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// nodejs.org's Windows zip shape (node-v<version>-win-<arch>/node.exe), unpacked by System32's tar.exe, as
// ensureManagedRuntime does on a real Windows computer. The archive holds a copy of the Node running this test,
// so the --version check before the pointer is written is real too.
describe.runIf(process.platform === 'win32')('ensureManagedRuntime on Windows', () => {
  let root = ''
  let runtimeDir = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-runtime-win-'))
    runtimeDir = join(root, '.harness', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    process.env.ADAPTER_RUNTIME_DIR = runtimeDir
    process.env.ADAPTER_RUNTIME_METADATA_URL = 'https://example.test/runtime/metadata.json'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    delete process.env.ADAPTER_RUNTIME_DIR
    delete process.env.ADAPTER_RUNTIME_METADATA_URL
  })

  it('downloads the zip, unpacks node.exe with Windows\' tar.exe, and records it with a CRLF pointer', async () => {
    const key = `win32-${process.arch}`
    const archiveRoot = `node-v22.0.0-win-${process.arch}`
    const source = join(root, 'src')
    mkdirSync(join(source, archiveRoot), { recursive: true })
    copyFileSync(process.execPath, join(source, archiveRoot, 'node.exe'))
    const zip = join(root, 'node.zip')
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', source, archiveRoot])
    const bytes = readFileSync(zip)
    const manifest = {
      node: { [key]: { version: 'v22.0.0', url: 'https://example.test/runtime/node.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, archiveRoot } },
    }
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('metadata.json')) return { ok: true, json: async () => manifest } as unknown as Response
      if (url.endsWith('.zip')) return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Response
      return { ok: false, status: 404 } as unknown as Response
    })
    vi.resetModules()
    const { ensureManagedRuntime } = await import('../runtimeInstall.js')

    const node = await ensureManagedRuntime()

    expect(node).toBe(join(runtimeDir, `node-v22.0.0-${key}`, 'node.exe'))
    expect(existsSync(node!)).toBe(true)
    expect(readFileSync(join(runtimeDir, 'current-node'), 'utf8')).toBe(`${node}\r\n`)
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith('.node-staging-'))).toEqual([])
  }, 180_000)
})
```

- [ ] **Step 2: Run them and see them fail.** Run `cd cli && npx vitest run src/lib/runtimeInstall.spec.ts -t "on Windows"`.
  Expected: these fail:
  - `platformKey is not a function`, and likewise for `unpackCommand` and `runtimeLayout`;
  - the grid case fails on `toBeNull` (the old `platformKey` has no win32 key, so nothing is fetched; the grid left
    installed is what comes back).

- [ ] **Step 3: Implement.** In `cli/src/lib/runtimeInstall.ts`:

  1. Replace lines 24-29 (the `platformKey` docblock and function) with:

```ts
/** `darwin-*` | `linux-*` | `win32-*` for arm64 and x64: the keys every runtime manifest uses. Null elsewhere. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const os = platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  return os && cpu ? `${os}-${cpu}` : null
}

/**
 * How a runtime's archive is unpacked. On Unix it is nodejs.org's `.tar.gz` with /usr/bin/tar. On Windows it is
 * the `.zip`, unpacked by the bsdtar that Windows has shipped in System32 since 1803, which reads zip. It is never
 * a `tar` found on PATH: Git for Windows puts GNU tar there, which cannot read a zip.
 */
export function unpackCommand(
  archive: string,
  into: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SystemRoot,
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args: ['-xf', archive, '-C', into] }
  return { file: '/usr/bin/tar', args: ['-xzf', archive, '-C', into] }
}

/**
 * What differs on Windows: nodejs.org's archive is a zip with `node.exe` at its root folder, not `bin/node`. The
 * pointer line ends in CRLF there, because harness.cmd reads it with `set /p`.
 */
export function runtimeLayout(platform: NodeJS.Platform = process.platform): { archiveSuffix: '.zip' | '.tar.gz'; nodeBinary: string; eol: string } {
  return platform === 'win32'
    ? { archiveSuffix: '.zip', nodeBinary: 'node.exe', eol: '\r\n' }
    : { archiveSuffix: '.tar.gz', nodeBinary: join('bin', 'node'), eol: '\n' }
}
```

  2. Line 3: change `import { dirname, join, sep } from 'node:path'` to `import { dirname, join, sep, win32 } from 'node:path'`.

  3. In `ensureManagedArchive`, insert `const layout = runtimeLayout()` right after line 169
     (`if (!key) return installed`). Then:
     - line 194: change ``const archive = join(staging, `${spec.name}.tar.gz`)`` to
       ``const archive = join(staging, `${spec.name}${layout.archiveSuffix}`)``.
     - line 196: change the tar call to

```ts
        const unpack = unpackCommand(archive, staging)
        if (!await finishesCleanly(unpack.file, unpack.args, 120_000)) return installed
```

  4. Line 207: change `if (spec.readOnly) {` to `if (spec.readOnly && process.platform !== 'win32') {`. Then add one
     comment line above it:
     `// Never on Windows: a read-only folder there cannot be removed by retireSuperseded, and nothing updates grid in place there (it is not installed).`

  5. Line 225: change ``writeFileSync(join(env.ADAPTER_RUNTIME_DIR, `current-${spec.name}`), `${binary}\n`, { mode: 0o600 })`` to
     ``writeFileSync(join(env.ADAPTER_RUNTIME_DIR, `current-${spec.name}`), `${binary}${layout.eol}`, { mode: 0o600 })``.

  6. Line 271 in `ensureManagedRuntime`: change `binary: join('bin', 'node'),` to `binary: runtimeLayout().nodeBinary,`.

  7. Line 294 in `ensureManagedGrid`: insert this before `if (process.env.HARNESS_GRID_BIN?.trim()) return null`:

```ts
  // Not on Windows (spec section 1): no grid is published for it, and an agent's pane there has no grid to run.
  if (process.platform === 'win32') return null
```

- [ ] **Step 4: Run them and see them pass.** Run `cd cli && npx vitest run src/lib/runtimeInstall.spec.ts && npx tsc --noEmit`.
  Expected: the whole file passes, including every existing darwin/linux case, which is unchanged.
  `runtimeInstall.win.spec.ts` is skipped on macOS.

- [ ] **Step 5: Windows verification.** On the VM:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run src/lib/windows/runtimeInstall.win.spec.ts src/lib/runtimeInstall.spec.ts -t \"on Windows\""`.
  Expected: the real-unpack case passes on arm64 and the three key/layout cases pass. The workflow covers x64:
  `src/lib/windows` is already on its path list.

- [ ] **Step 6: Commit.**
  `git add cli/src/lib/runtimeInstall.ts cli/src/lib/runtimeInstall.spec.ts cli/src/lib/windows/runtimeInstall.win.spec.ts`
  `git commit -m "feat(cli): the managed Node for win32-x64 and win32-arm64, unpacked by System32's tar.exe; no grid on Windows"`

### Task B1.3: The pty host reports the CLI release's version

**Files**
- Modify: `pty/src/cli.rs`:
  - lines 19-25: `version_line`.
  - lines 93-95: the serve log line.
  - line 257: `HostInfo.version`.
  - line 307: the test.
- Modify: `pty/Cargo.toml`, lines 1-4 (`default-run`, needed once B1.5 adds a second binary).

**Interfaces**
- Produces:
  - `harness_pty::cli::VERSION: &str`. It is `HARNESS_PTY_VERSION` at build time when that is set and not empty,
    otherwise `CARGO_PKG_VERSION`.
  - `harness_pty::cli::release_version(given: Option<&'static str>) -> &'static str`.
- Consumed by: B1.13 (`windows-pty.yml` release mode builds with `HARNESS_PTY_VERSION=<CLI version>`, so the version
  folder and A's discovery `version` agree with `current-pty`).

- [ ] **Step 1: Write the failing test.** In `pty/src/cli.rs`'s `mod tests`, replace the
  `version_line_is_json_with_protocol` test (lines 304-309) with:

```rust
    #[test]
    fn version_line_is_json_with_protocol() {
        let v: serde_json::Value = serde_json::from_str(&version_line()).unwrap();
        assert_eq!(v["version"], VERSION);
        assert_eq!(v["protocol"], PROTOCOL);
    }

    #[test]
    fn a_release_build_reports_the_cli_release_version() {
        // The release builds the host with the CLI's version, so its folder runtime\pty\<version>\ and the
        // `version` in its discovery file are the version current-pty names. A plain build keeps the crate's.
        assert_eq!(release_version(Some("0.3.120")), "0.3.120");
        assert_eq!(release_version(None), env!("CARGO_PKG_VERSION"));
        // An unset workflow input arrives as an empty string, never as a version.
        assert_eq!(release_version(Some("")), env!("CARGO_PKG_VERSION"));
    }
```

- [ ] **Step 2: Run it and see it fail.** Run `cd pty && cargo +stable test --locked cli::tests`.
  Expected: compile errors `cannot find value VERSION` and `cannot find function release_version`.

- [ ] **Step 3: Implement.** In `pty/src/cli.rs`, insert after line 17 (the `USAGE` constant):

```rust
/// The version this host reports. A release stamps it with the CLI's version (`HARNESS_PTY_VERSION`, set by
/// windows-pty.yml's release mode) instead of editing Cargo.toml, which would put the lockfile out of date for
/// `--locked`.
pub const VERSION: &str = release_version(option_env!("HARNESS_PTY_VERSION"));

pub const fn release_version(given: Option<&'static str>) -> &'static str {
    match given {
        Some(version) if !version.is_empty() => version,
        _ => env!("CARGO_PKG_VERSION"),
    }
}
```

  Then replace `env!("CARGO_PKG_VERSION")` with `VERSION` at line 22 (`version_line`), at line 94 (the
  `log::info!` call) and at line 257 (`version: VERSION.to_owned(),`). In `pty/Cargo.toml`, add
  `default-run = "harness-pty"` after line 4 (`edition = "2024"`), so `cargo run` keeps starting the host.

- [ ] **Step 4: Run it and see it pass.**
  Run `cd pty && cargo +stable test --locked cli::tests && HARNESS_PTY_VERSION=9.9.9 cargo +stable run --locked -q -- version`.
  Expected: the tests pass, and the command prints `{"version":"9.9.9","protocol":2}`. Then
  `cargo +stable run --locked -q -- version` prints `{"version":"0.1.0","protocol":2}`: cargo rebuilds when an
  `option_env!` variable changes.
  Also run `cargo +stable check --locked --target aarch64-pc-windows-msvc`. Expected: it is clean.

- [ ] **Step 5: Windows verification.** It runs through the workflow's `cargo test` in B1.10. On the VM:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && set HARNESS_PTY_VERSION=9.9.9&& cargo build --release && target\release\harness-pty.exe version"`.
  Expected: it prints `{"version":"9.9.9","protocol":2}`.

- [ ] **Step 6: Commit.**
  `git add pty/src/cli.rs pty/Cargo.toml`
  `git commit -m "feat(pty): a release build reports the CLI's version (HARNESS_PTY_VERSION)"`

### Task B1.4: `harness-launch`'s resolver and start policy (`pty/src/launcher.rs`)

**Files**
- Create: `pty/src/launcher.rs`
- Modify: `pty/src/lib.rs`: after line 8 (`pub mod logfile;`), add `pub mod launcher;`

**Interfaces**
- Consumes: `harness_pty::breakaway::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP}` (A).
- Produces:
  - `parse(&[OsString]) -> Result<Invocation, String>`, `default_root(env) -> Option<PathBuf>`,
    `resolve(root: &Path) -> Result<Resolved, String>`, `single_segment(&str) -> bool`.
  - `start(spawn: FnMut(u32) -> io::Result<u32>, warn: FnMut(String)) -> io::Result<u32>`,
    `log_failure(root, message)`.
  - `run(args: Vec<OsString>) -> i32`, with exit codes `EXIT_USAGE = 2`, `EXIT_UNRESOLVED = 3`, `EXIT_SPAWN = 4`.
  - Usage: `harness-launch [--root <dir>] -- <cli args...>`. The default root is `%USERPROFILE%\.harness` (`HOME`
    off Windows). The failure log is `<root>\cli\data\logs\launch.log`.

- [ ] **Step 1: Write the failing test.** Create `pty/src/launcher.rs`. In this step it holds only the test module,
  so the `use super::*` names do not exist yet:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::breakaway::DETACHED_PROCESS;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_a_root_and_takes_everything_after_the_separator_for_the_cli() {
        assert_eq!(
            parse(&os(&["--", "start", "--if-down"])).unwrap(),
            Invocation { root: None, args: os(&["start", "--if-down"]) }
        );
        assert_eq!(
            parse(&os(&["--root", "R", "--", "version"])).unwrap(),
            Invocation { root: Some(PathBuf::from("R")), args: os(&["version"]) }
        );
        // What follows `--` is the CLI's, even another `--root` or `--`.
        assert_eq!(parse(&os(&["--", "--root", "x", "--"])).unwrap().args, os(&["--root", "x", "--"]));
    }

    #[test]
    fn refuses_a_command_line_without_the_separator() {
        assert!(parse(&os(&[])).unwrap_err().contains("missing `--`"));
        assert!(parse(&os(&["start"])).unwrap_err().contains("unexpected argument"));
        assert!(parse(&os(&["--root"])).unwrap_err().contains("--root needs a folder"));
    }

    #[test]
    fn the_default_root_is_the_profiles_harness_folder() {
        let env = |key: &str| (key == "USERPROFILE").then(|| OsString::from("P"));
        assert_eq!(default_root(env), Some(PathBuf::from("P").join(".harness")));
        let unix = |key: &str| (key == "HOME").then(|| OsString::from("H"));
        assert_eq!(default_root(unix), Some(PathBuf::from("H").join(".harness")));
        assert_eq!(default_root(|_| None), None);
        assert_eq!(default_root(|_| Some(OsString::new())), None);
    }

    /// An install under `root`: a node.exe inside runtime\ named by current-node, and cli\<version>\cli.js
    /// named by cli\current, both written with CRLF as install.ps1 writes them.
    fn install(root: &Path, version: &str) -> PathBuf {
        let node_dir = root.join("runtime").join("node-v22.0.0-win32-x64");
        fs::create_dir_all(&node_dir).unwrap();
        let node = node_dir.join("node.exe");
        fs::write(&node, b"").unwrap();
        fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", node.display())).unwrap();
        let cli = root.join("cli").join(version);
        fs::create_dir_all(&cli).unwrap();
        fs::write(cli.join("cli.js"), b"").unwrap();
        fs::write(root.join("cli").join("current"), format!("{version}\r\n")).unwrap();
        node
    }

    #[test]
    fn resolves_the_node_and_the_cli_the_pointers_name() {
        let dir = tempfile::tempdir().unwrap();
        let node = install(dir.path(), "1.2.3");
        let resolved = resolve(dir.path()).unwrap();
        assert_eq!(resolved.node, node);
        assert_eq!(resolved.cli_js, dir.path().join("cli").join("1.2.3").join("cli.js"));
    }

    #[test]
    fn refuses_a_node_outside_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root, "1.2.3");
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = outside.path().join("node.exe");
        fs::write(&elsewhere, b"").unwrap();
        let current_node = root.join("runtime").join("current-node");
        fs::write(&current_node, elsewhere.display().to_string()).unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
        // A relative name is no better.
        fs::write(&current_node, "node.exe").unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
        // Nor is one that climbs out of runtime\ and back to a real file.
        let climbing = root.join("runtime").join("..").join("cli").join("1.2.3").join("cli.js");
        fs::write(&current_node, climbing.display().to_string()).unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
    }

    #[test]
    fn refuses_a_cli_pointer_that_names_more_than_one_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root, "1.2.3");
        for bad in ["..", "../1.2.3", "1.2.3\\..\\x", "a/b", "C:x", "  "] {
            fs::write(root.join("cli").join("current"), bad).unwrap();
            assert!(resolve(root).is_err(), "{bad:?}");
            assert!(!single_segment(bad.trim()), "{bad:?}");
        }
        assert!(single_segment("0.3.120-dev.abc123"));
    }

    #[test]
    fn says_which_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve(dir.path()).unwrap_err().contains("current-node"));
        install(dir.path(), "1.2.3");
        fs::remove_file(dir.path().join("cli").join("1.2.3").join("cli.js")).unwrap();
        assert!(resolve(dir.path()).unwrap_err().contains("cli.js"));
    }

    const DENIED: i32 = 5; // ERROR_ACCESS_DENIED

    #[test]
    fn starts_the_cli_outside_the_job_with_a_console_nobody_sees() {
        let mut flags = Vec::new();
        let pid = start(|f| { flags.push(f); Ok(7) }, |w| panic!("no warning expected: {w}")).unwrap();
        assert_eq!(pid, 7);
        assert_eq!(flags, [CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB]);
        // With DETACHED_PROCESS, Windows ignores CREATE_NO_WINDOW. The CLI would then have no console, and every
        // console program it starts would open a visible window of its own.
        assert_eq!(flags[0] & DETACHED_PROCESS, 0);
    }

    #[test]
    fn a_job_that_forbids_breakaway_gets_the_cli_inside_it_and_a_warning() {
        let mut flags = Vec::new();
        let mut warnings = Vec::new();
        let pid = start(
            |f| {
                flags.push(f);
                if f & CREATE_BREAKAWAY_FROM_JOB != 0 { Err(io::Error::from_raw_os_error(DENIED)) } else { Ok(9) }
            },
            |w| warnings.push(w),
        )
        .unwrap();
        assert_eq!(pid, 9);
        assert_eq!(flags, [CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("inside the job"), "{warnings:?}");
    }

    #[test]
    fn any_other_failure_is_reported_and_not_retried() {
        let mut calls = 0;
        let err = start(|_| { calls += 1; Err(io::Error::from(io::ErrorKind::NotFound)) }, |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(calls, 1);
    }

    #[test]
    fn a_failure_is_logged_in_the_data_folders_logs() {
        let dir = tempfile::tempdir().unwrap();
        log_failure(dir.path(), "first");
        log_failure(dir.path(), "second");
        let log = fs::read_to_string(dir.path().join("cli").join("data").join("logs").join("launch.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("harness-launch: first"), "{log}");
        assert!(lines[1].ends_with("harness-launch: second"), "{log}");
    }
}
```

  Add `pub mod launcher;` to `pty/src/lib.rs` after line 8.

- [ ] **Step 2: Run it and see it fail.** Run `cd pty && cargo +stable test --locked launcher`.
  Expected: compile errors such as `cannot find function parse`, `cannot find type Invocation` and
  `cannot find value CREATE_NO_WINDOW`.

- [ ] **Step 3: Implement.** Put the following above the test module in `pty/src/launcher.rs`:

```rust
//! `harness-launch` is how the CLI starts in the background on Windows (spec section 1, "Launchers"). Three things
//! use it: the scheduled task, `harness start` from a terminal, and a master handing over to its replacement.
//!
//! It resolves the installed Node and CLI from the pointer files that install.ps1 and the updater keep. It then
//! starts `node.exe <cli.js> <args>` with no visible window and outside any job, and exits 0 as soon as the CLI has
//! started. When it cannot, it exits non-zero and says why in `<root>\cli\data\logs\launch.log`: a GUI-subsystem
//! program has no console to say it on.
//!
//! It reads the pointers by the CLI's rules (cli/src/lib/windows/installLayout.ts):
//! - `cli\current` names one version folder;
//! - `runtime\current-node` names a node.exe inside `runtime\`, as on a Mac (`managedNodePath`).
//!
//! It builds and runs on Unix too, where it starts the CLI in a process group of its own, so `cargo test` covers
//! the resolver everywhere.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::breakaway::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP};

/// The CLI runs as a console program whose console nobody sees. It does not also get `DETACHED_PROCESS`, because
/// Windows ignores `CREATE_NO_WINDOW` beside it ("Process Creation Flags"). The CLI would then have no console at
/// all, and each console program it started without `windowsHide` would open a visible window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ERROR_ACCESS_DENIED: i32 = 5;

pub const USAGE: &str = "usage: harness-launch [--root <dir>] -- <cli args...>";
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNRESOLVED: i32 = 3;
pub const EXIT_SPAWN: i32 = 4;

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub root: Option<PathBuf>,
    pub args: Vec<OsString>,
}

/// `[--root <dir>] -- <cli args...>`. Everything after `--` belongs to the CLI and passes through unread.
pub fn parse(args: &[OsString]) -> Result<Invocation, String> {
    let mut root = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].to_str() {
            Some("--") => return Ok(Invocation { root, args: args[i + 1..].to_vec() }),
            Some("--root") => {
                let dir = args.get(i + 1).ok_or_else(|| format!("--root needs a folder\n{USAGE}"))?;
                root = Some(PathBuf::from(dir));
                i += 2;
            }
            _ => return Err(format!("unexpected argument {:?}\n{USAGE}", args[i])),
        }
    }
    Err(format!("missing `--` before the CLI's arguments\n{USAGE}"))
}

/// `%USERPROFILE%\.harness`, the folder install.ps1 installs into (`HOME` off Windows, for the tests).
pub fn default_root(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let home = env("USERPROFILE").or_else(|| env("HOME")).filter(|home| !home.is_empty())?;
    Some(PathBuf::from(home).join(".harness"))
}

#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub node: PathBuf,
    pub cli_js: PathBuf,
}

/// A pointer names one folder: never `.`, any `..`, a separator, or a `:` (a drive or an NTFS stream).
pub fn single_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && !value.contains("..") && !value.contains(['/', '\\', ':', '\0'])
}

fn read_pointer(file: &Path) -> Result<String, String> {
    let text = fs::read_to_string(file).map_err(|err| format!("cannot read {}: {err}", file.display()))?;
    let line = text.lines().next().unwrap_or("").trim().to_owned();
    if line.is_empty() {
        return Err(format!("{} is empty", file.display()));
    }
    Ok(line)
}

/// Whether `file` resolves inside `dir`. Both sides are compared resolved, so a `..`, a junction or a symlink that
/// leads out is caught. The case is the disk's own, on both sides.
fn contained(dir: &Path, file: &Path) -> bool {
    match (fs::canonicalize(dir), fs::canonicalize(file)) {
        (Ok(dir), Ok(file)) => file != dir && file.starts_with(&dir),
        _ => false,
    }
}

/// The node.exe and cli.js the install's pointers name, by the rules the CLI applies to them.
pub fn resolve(root: &Path) -> Result<Resolved, String> {
    let runtime = root.join("runtime");
    let pointer = runtime.join("current-node");
    let node = PathBuf::from(read_pointer(&pointer)?);
    if !node.is_absolute() {
        return Err(format!("{} names {}, which is not inside {}", pointer.display(), node.display(), runtime.display()));
    }
    if !node.is_file() {
        return Err(format!("the Node runtime {} that {} names is missing", node.display(), pointer.display()));
    }
    if !contained(&runtime, &node) {
        return Err(format!("{} names {}, which is not inside {}", pointer.display(), node.display(), runtime.display()));
    }
    let cli = root.join("cli");
    let version = read_pointer(&cli.join("current"))?;
    if !single_segment(&version) {
        return Err(format!("{} names {version:?}, which is not one version folder", cli.join("current").display()));
    }
    let cli_js = cli.join(&version).join("cli.js");
    if !cli_js.is_file() || !contained(&cli, &cli_js) {
        return Err(format!("the CLI {} that cli\\current names is missing", cli_js.display()));
    }
    Ok(Resolved { node, cli_js })
}

/// Start the CLI. The first attempt is outside the job this launcher runs in: an SSH session's job, or the task's,
/// ends every process in it when it closes. A job with no `BREAKAWAY_OK` refuses that with `ERROR_ACCESS_DENIED`
/// (a Harness pane's job is one). Then the CLI is started inside it, with a warning, as the pty host does
/// (breakaway.rs). Any other failure is the answer.
pub fn start(mut spawn: impl FnMut(u32) -> io::Result<u32>, mut warn: impl FnMut(String)) -> io::Result<u32> {
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    match spawn(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(pid) => Ok(pid),
        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            warn(format!("the job this launcher runs in refuses a breakaway ({err}): the CLI starts inside the job, and may end with it"));
            spawn(base)
        }
        Err(err) => Err(err),
    }
}

/// One line in `<root>\cli\data\logs\launch.log`, beside the daemon's own logs. A log that cannot be written is
/// not a second failure: the exit code still says it.
pub fn log_failure(root: &Path, message: &str) {
    let dir = root.join("cli").join("data").join("logs");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("launch.log")) {
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(file, "{seconds} harness-launch: {message}");
    }
}

/// Spawn `node.exe <cli.js> <args>` from the install's root with no stdio, so the CLI holds no handle of the
/// launcher's and the launcher can exit. It returns the CLI's pid.
fn spawn_cli(resolved: &Resolved, args: &[OsString], root: &Path, flags: u32) -> io::Result<u32> {
    let mut command = Command::new(&resolved.node);
    command
        .arg(&resolved.cli_js)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(flags);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = flags;
        command.process_group(0);
    }
    command.spawn().map(|child| child.id())
}

/// The program: 0 once the CLI has started. A usage error is 2 and goes unlogged: whatever called the launcher
/// wrongly sees the code, and with no `--root` there is no folder of the caller's to log in. 3 when the install
/// does not resolve, 4 when the CLI does not start; both are logged.
pub fn run(args: Vec<OsString>) -> i32 {
    let invocation = match parse(&args) {
        Ok(invocation) => invocation,
        Err(err) => {
            eprintln!("{err}");
            return EXIT_USAGE;
        }
    };
    let Some(root) = invocation.root.clone().or_else(|| default_root(|key| std::env::var_os(key))) else {
        eprintln!("harness-launch: no USERPROFILE, and no --root");
        return EXIT_UNRESOLVED;
    };
    let root = std::path::absolute(&root).unwrap_or(root);
    let resolved = match resolve(&root) {
        Ok(resolved) => resolved,
        Err(err) => {
            log_failure(&root, &err);
            return EXIT_UNRESOLVED;
        }
    };
    match start(|flags| spawn_cli(&resolved, &invocation.args, &root, flags), |warning| log_failure(&root, &warning)) {
        Ok(_) => 0,
        Err(err) => {
            log_failure(&root, &format!("could not start {} {}: {err}", resolved.node.display(), resolved.cli_js.display()));
            EXIT_SPAWN
        }
    }
}
```

- [ ] **Step 4: Run it and see it pass.**
  Run `cd pty && cargo +stable test --locked launcher && cargo +stable check --locked --target x86_64-pc-windows-msvc && cargo +stable check --locked --target aarch64-pc-windows-msvc`.
  Expected: all 11 launcher tests pass, and both Windows checks are clean.

- [ ] **Step 5: Windows verification.**
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && cargo test --locked launcher"`.
  Expected: everything passes. The containment cases run against NTFS paths with `\\?\` canonical forms and a
  drive prefix.

- [ ] **Step 6: Commit.**
  `git add pty/src/launcher.rs pty/src/lib.rs`
  `git commit -m "feat(pty): harness-launch's resolver and start policy: the pointers' Node and CLI, outside the job, no window"`

### Task B1.5: The `harness-launch` binary

**Files**
- Create: `pty/src/bin/harness-launch.rs`
- Modify: `pty/Cargo.toml`: after `[package]` (lines 1-5 once B1.3 is in), add two `[[bin]]` tables.
- Create: `pty/tests/harness_launch.rs` (every OS)
- Create: `pty/tests/harness_launch_job.rs` (Windows: a job that closes)

**Interfaces**
- Consumes: `harness_pty::launcher::run` (B1.4).
- Produces: the `harness-launch[.exe]` binary in `target/<profile>/`. It has the GUI subsystem on Windows
  (`#![windows_subsystem = "windows"]`). Usage: `harness-launch.exe [--root <dir>] -- <cli args...>`.

- [ ] **Step 1: Write the failing tests.** Create `pty/tests/harness_launch.rs`:

```rust
//! The real `harness-launch` binary. It starts the CLI the pointers name, with the arguments after `--` and from the
//! install's root, and exits without waiting for it. A broken install exits 3 and says why in launch.log; a command
//! line without `--` exits 2.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const LAUNCH: &str = env!("CARGO_BIN_EXE_harness-launch");

/// The fake CLI writes what it was given, and where it ran, to $HARNESS_LAUNCH_TEST_OUT.
const CLI_JS: &str = "const fs = require('node:fs')\n\
fs.writeFileSync(process.env.HARNESS_LAUNCH_TEST_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n";

/// A Node to run the fake CLI with: $NODE, or the first one on PATH. With none, the test is skipped on a Rust-only
/// machine, and fails when `CI` is set: Windows CI and the VM both have one, so a missing Node there is a broken
/// runner, not a reason to pass.
fn node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NODE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())
}

/// An install under `root`. Its Node is a hard link to the real one, or a copy, inside runtime\, as the
/// containment rule requires. The source is resolved first: Homebrew's `node` is a symlink, and a hard link to a
/// symlink would resolve outside runtime\.
fn install(root: &Path, node: &Path) {
    let node = fs::canonicalize(node).unwrap();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join(node.file_name().unwrap());
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    let cli = root.join("cli").join("1.2.3");
    fs::create_dir_all(&cli).unwrap();
    fs::write(cli.join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
}

/// The fake CLI's report, once it has written all of it.
fn report(out: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = fs::read_to_string(out) {
            if let Ok(value) = serde_json::from_str(&text) {
                return value;
            }
        }
        assert!(Instant::now() < deadline, "the CLI never ran");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn starts_the_cli_with_its_arguments_from_the_root_and_returns_at_once() {
    let Some(node) = node() else {
        assert!(std::env::var_os("CI").is_none(), "no node on PATH, and CI is set: the runner must have one");
        eprintln!("skipped: no node on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    install(root, &node);
    let out = root.join("out.json");
    let started = Instant::now();
    let status = Command::new(LAUNCH)
        .arg("--root")
        .arg(root)
        .args(["--", "start", "--if-down", "two words"])
        .env("HARNESS_LAUNCH_TEST_OUT", &out)
        .status()
        .unwrap();
    assert!(status.success(), "{status:?}");
    // It does not wait for what it started: that is a daemon.
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let report = report(&out);
    assert_eq!(report["args"], serde_json::json!(["start", "--if-down", "two words"]));
    assert_eq!(
        fs::canonicalize(report["cwd"].as_str().unwrap()).unwrap(),
        fs::canonicalize(root).unwrap()
    );
    assert!(!root.join("cli").join("data").join("logs").join("launch.log").exists());
}

#[test]
fn a_broken_install_exits_3_and_says_why_in_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new(LAUNCH).arg("--root").arg(dir.path()).args(["--", "version"]).status().unwrap();
    assert_eq!(status.code(), Some(3));
    let log = fs::read_to_string(dir.path().join("cli").join("data").join("logs").join("launch.log")).unwrap();
    assert!(log.contains("current-node"), "{log}");
}

#[test]
fn a_command_line_without_the_separator_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new(LAUNCH).arg("--root").arg(dir.path()).arg("version").status().unwrap();
    assert_eq!(status.code(), Some(2));
    assert!(!dir.path().join("cli").exists(), "a usage error is not logged");
}
```

  Create `pty/tests/harness_launch_job.rs`. It is Windows-only and uses the same job helpers as A's `breakaway.rs`:

```rust
//! Windows: a CLI that harness-launch starts outlives the job harness-launch was started in. That is an SSH session
//! (OpenSSH ends the session's job when it disconnects: A's E2E finding F16) or the scheduled task. A job that
//! refuses breakaway still gets its CLI, started inside it, with a warning in launch.log.
#![cfg(windows)]
use std::fs;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

const LAUNCH: &str = env!("CARGO_BIN_EXE_harness-launch");

/// The fake CLI says it started, then, three seconds later (after the test closed the job), that it is still alive.
const CLI_JS: &str = "const fs = require('node:fs')\n\
fs.writeFileSync(process.env.OUT + '.started', String(process.pid))\n\
setTimeout(() => fs.writeFileSync(process.env.OUT + '.alive', String(process.pid)), 3000)\n";

fn job(breakaway_ok: bool) -> OwnedHandle {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!job.is_null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | if breakaway_ok { JOB_OBJECT_LIMIT_BREAKAWAY_OK } else { 0 };
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
        OwnedHandle::from_raw_handle(job as _)
    }
}

fn resume(pid: u32) {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snap, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                assert!(!thread.is_null());
                ResumeThread(thread);
                CloseHandle(thread);
            }
            more = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
}

fn node() -> PathBuf {
    let path = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node.exe"))
        .find(|path| path.is_file())
        .expect("node.exe on PATH (setup-node in CI, Node on the VM)");
    fs::canonicalize(path).unwrap()
}

fn install(root: &Path) {
    let node = node();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join("node.exe");
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    fs::create_dir_all(root.join("cli").join("1.2.3")).unwrap();
    fs::write(root.join("cli").join("1.2.3").join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
}

/// Run harness-launch inside `job` (assigned while suspended, so it starts there), wait for it to exit 0 and for
/// the CLI to start, then close the job and report whether the CLI lived on.
fn cli_outlives(breakaway_ok: bool) -> (bool, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    install(root);
    let out = root.join("out");
    let job = job(breakaway_ok);
    let mut launcher = Command::new(LAUNCH)
        .arg("--root")
        .arg(root)
        .arg("--")
        .env("OUT", &out)
        .creation_flags(CREATE_SUSPENDED)
        .spawn()
        .unwrap();
    let ok = unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, launcher.as_raw_handle() as HANDLE) };
    assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
    resume(launcher.id());
    assert!(launcher.wait().unwrap().success());
    let started = PathBuf::from(format!("{}.started", out.display()));
    let deadline = Instant::now() + Duration::from_secs(20);
    while !started.exists() {
        assert!(Instant::now() < deadline, "the CLI never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(job); // KILL_ON_JOB_CLOSE: everything still in the job ends now.
    std::thread::sleep(Duration::from_secs(6));
    let alive = PathBuf::from(format!("{}.alive", out.display())).exists();
    let log = fs::read_to_string(root.join("cli").join("data").join("logs").join("launch.log")).unwrap_or_default();
    (alive, log)
}

#[test]
fn the_cli_outlives_a_job_that_allows_breakaway() {
    let (alive, log) = cli_outlives(true);
    assert!(alive, "the CLI ended with the launcher's job; launch.log: {log}");
    assert!(log.is_empty(), "{log}");
}

#[test]
fn a_job_that_refuses_breakaway_keeps_the_cli_and_the_log_says_so() {
    let (alive, log) = cli_outlives(false);
    assert!(!alive, "the CLI could only start inside the job, and ended with it");
    assert!(log.contains("starts inside the job"), "{log}");
}
```

- [ ] **Step 2: Run them and see them fail.** Run `cd pty && cargo +stable test --locked --test harness_launch`.
  Expected: a compile error, ``environment variable `CARGO_BIN_EXE_harness-launch` not defined``.

- [ ] **Step 3: Implement.** Create `pty/src/bin/harness-launch.rs`:

```rust
//! harness-launch.exe starts the Harness CLI in the background, outside any job, with no window
//! (harness_pty::launcher). It is a GUI-subsystem program on Windows, so starting it never opens a console window,
//! whether from the scheduled task or from a terminal.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(harness_pty::launcher::run(std::env::args_os().skip(1).collect()));
}
```

  In `pty/Cargo.toml`, add after the `[package]` table (after `default-run = "harness-pty"`) and before
  `[dependencies]`:

```toml
# The host, and the windowless starter install.ps1 puts in %USERPROFILE%\.harness\bin (src/launcher.rs).
[[bin]]
name = "harness-pty"
path = "src/main.rs"

[[bin]]
name = "harness-launch"
path = "src/bin/harness-launch.rs"
```

- [ ] **Step 4: Run them and see them pass.**
  Run `cd pty && cargo +stable test --locked --test harness_launch && cargo +stable test --locked && cargo +stable build --locked --release && ls target/release/harness-pty target/release/harness-launch`.
  Expected:
  - the three `harness_launch` tests pass on macOS;
  - the whole crate passes, against the baseline: compare with a clean `origin/main` worktree before calling
    anything new;
  - both binaries are listed;
  - `harness_launch_job.rs` compiles to nothing on macOS.

  Run `cargo +stable check --locked --target aarch64-pc-windows-msvc --bins --tests`. Expected: it is clean.

- [ ] **Step 5: Windows verification.**
  1. Run `ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && cargo test --locked --test harness_launch --test harness_launch_job"`.
     Expected: all five pass. This is the proof that the CLI leaves a closing job.
  2. Check the real SSH case: a CLI started from an SSH session survives the session's end (F16). From the Mac:

```bash
d=$(mktemp -d); mkdir -p "$d/launch/runtime/node-test" "$d/launch/cli/1.2.3"
printf 'C:\\work\\b1\\launch\\runtime\\node-test\\node.exe\r\n' > "$d/launch/runtime/current-node"
printf '1.2.3\r\n' > "$d/launch/cli/current"
printf "setTimeout(() => require('fs').writeFileSync('C:/work/b1/launch/alive', String(process.pid)), 15000)\n" > "$d/launch/cli/1.2.3/cli.js"
tar -cf - -C "$d" launch | ssh admin@192.168.65.3 "(if not exist C:\work\b1 mkdir C:\work\b1) & tar -xf - -C C:/work/b1"
ssh admin@192.168.65.3 "copy /y \"C:\Program Files\nodejs\node.exe\" C:\work\b1\launch\runtime\node-test\node.exe >nul & del C:\work\b1\launch\alive 2>nul & start /wait \"\" C:\work\oh\pty\target\release\harness-launch.exe --root C:\work\b1\launch -- && echo launched"
sleep 20
ssh admin@192.168.65.3 "type C:\work\b1\launch\alive & type C:\work\b1\launch\cli\data\logs\launch.log 2>nul"
```

     Expected: `launched` (start /wait passes on the exit code 0), then a pid from `alive`, and no launch.log. The CLI outlived the SSH session that
     started it. Record the output in the PR.

- [ ] **Step 6: Commit.**
  `git add pty/src/bin/harness-launch.rs pty/Cargo.toml pty/tests/harness_launch.rs pty/tests/harness_launch_job.rs`
  `git commit -m "feat(pty): harness-launch.exe, the windowless starter that puts the CLI outside the job"`

### Task B1.6: The pty payload carries `harness-launch.exe`

**Files**
- Modify: `cli/scripts/lib/ptyPayload.mjs`, lines 1-9 (doc) and 13-17 (`ptyPayloadSources`)
- Modify: `cli/src/ptyPayload.spec.ts`, lines 26-41

**Interfaces**
- Consumes: the `harness-launch.exe` binary (B1.5) at `pty/target/release/harness-launch.exe`.
- Produces: `ptyPayloadSources(ptyDir, arch)` returns, in this order: the host, the launcher, `conpty.dll`,
  `OpenConsole.exe`. `copyPtyPayload` copies the launcher when it was built.

- [ ] **Step 1: Write the failing test.** In `cli/src/ptyPayload.spec.ts`, replace lines 26-41 (from
  `const HOST = …` through the second `it`) with:

```ts
const HOST = 'target/release/harness-pty.exe'
const LAUNCHER = 'target/release/harness-launch.exe'

describe('the pty host beside a Windows bundle', () => {
  it('copies the host, the windowless launcher and the ConPTY payload for the build\'s architecture into dist/pty', () => {
    const repo = repository([HOST, LAUNCHER, 'vendor/conpty/arm64/conpty.dll', 'vendor/conpty/arm64/OpenConsole.exe', 'vendor/conpty/x64/conpty.dll'])
    expect(copyPtyPayload({ ...repo, platform: 'win32', arch: 'arm64' })).toEqual(['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe'])
    expect(readdirSync(join(repo.outDir, 'pty')).sort()).toEqual(['OpenConsole.exe', 'conpty.dll', 'harness-launch.exe', 'harness-pty.exe'])
  })

  it('copies only what is there: the host without a launcher or payload, nothing without the host', () => {
    const hostOnly = repository([HOST])
    expect(copyPtyPayload({ ...hostOnly, platform: 'win32', arch: 'x64' })).toEqual(['harness-pty.exe'])
    const payloadOnly = repository([LAUNCHER, 'vendor/conpty/x64/conpty.dll', 'vendor/conpty/x64/OpenConsole.exe'])
    expect(copyPtyPayload({ ...payloadOnly, platform: 'win32', arch: 'x64' })).toEqual([])
    expect(existsSync(join(payloadOnly.outDir, 'pty'))).toBe(false)
  })
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/ptyPayload.spec.ts`.
  Expected: the first case fails. It expected `harness-launch.exe` in the list and got
  `['harness-pty.exe', 'conpty.dll', 'OpenConsole.exe']`.

- [ ] **Step 3: Implement.** In `cli/scripts/lib/ptyPayload.mjs`:
  - In the doc comment (lines 1-9), change the first sentence to: "The Harness PTY host, the windowless
    `harness-launch.exe` (pty/src/launcher.rs) and the host's ConPTY payload, copied beside a Windows bundle in
    `<out>/pty/` for local Windows testing."
  - Change the last sentence to: "Releases publish the same four files as one zip per architecture
    (scripts/publish-pty-payload.sh), and install.ps1 lays them down per version under the runtime folder."
  - Replace lines 13-17 with:

```js
/** The files to copy, from the repository's `pty/` folder: the release host, the launcher, then the payload for [arch]. */
export function ptyPayloadSources(ptyDir, arch) {
  const release = join(ptyDir, 'target', 'release')
  const payload = join(ptyDir, 'vendor', 'conpty', arch === 'arm64' ? 'arm64' : 'x64')
  return [join(release, 'harness-pty.exe'), join(release, 'harness-launch.exe'), join(payload, 'conpty.dll'), join(payload, 'OpenConsole.exe')]
}
```

  `copyPtyPayload` (lines 20-32) needs no change: it still requires the host and copies the rest when present.

- [ ] **Step 4: Run it and see it pass.** Run `cd cli && npx vitest run src/ptyPayload.spec.ts`. Expected: all three cases pass.

- [ ] **Step 5: Windows verification.** On the VM, after `cargo build --release` in `C:\work\oh\pty`:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && set BUNDLE_OUT_DIR=C:\work\b1\bundle&& npm run bundle && dir C:\work\b1\bundle\pty"`.
  Expected: the folder lists `harness-pty.exe`, `harness-launch.exe`, `conpty.dll` and `OpenConsole.exe`.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/lib/ptyPayload.mjs cli/src/ptyPayload.spec.ts`
  `git commit -m "build(cli): the Windows pty payload carries harness-launch.exe"`

### Task B1.7: `install.ps1` foundations: host and platform checks, manifests, verified downloads, pointers, PATH

This task creates the installer file with its building blocks and their tests. B1.8 adds the install flow that
uses them.

**Testing decision for the PowerShell installer.** The tests are Vitest specs that run the real script with
`powershell.exe`, not Pester:
- They use Windows PowerShell 5.1, which is what a person's `irm | iex` runs on.
- They run on the VM and in the Windows workflow without installing a module. 5.1 ships Pester 3.4, and Pester 5
  would have to be installed on both.
- They use the same runner and isolation as the rest of the CLI's tests.

On every OS, PR CI included, a static half checks invariants of the source: it is pure ASCII, it never writes
machine-wide state, and it has exactly one manifest-base line. On Windows, a behaviour half dot-sources the script
in library mode (`HARNESS_INSTALL_LIBRARY=1`) and calls each function, and B1.8 runs whole installs. A test never
writes the real `HKCU\Environment`: `HARNESS_INSTALL_ENV_KEY` points PATH edits at a throwaway subkey.

**Files**
- Create: `cli/scripts/install.ps1`
- Create: `cli/src/scripts/installPs1.spec.ts`
- Modify: `.gitattributes` (repository root; it exists and marks design files binary): add the line endings of the
  Windows scripts. GitHub's Windows images check out with `core.autocrlf=true`; without a rule, `install.ps1`
  arrives there with CRLF.
- Modify (index line endings only, by renormalization): the tracked `.cmd` files in
  `cli/scripts/windows-pty-e2e/` and `cli/src/lib/windows/fixtures/`.

**Interfaces**
- Produces these PowerShell functions, for B1.8 and B5:
  - `Get-HarnessPlatform [-Architecture <s>]` returns `win32-x64` or `win32-arm64`.
  - `Test-HarnessHost [-Build <n>] [-SystemRoot <dir>]` returns the path of `tar.exe`.
  - `Get-HarnessJson <source>`, `Resolve-HarnessRef <ref> <manifestSource>`.
  - `Get-HarnessManifests -Manifest <s> -Platform <p> [-Base <url>]` returns `@{ cli|node|pty = @{ entry; source } }`.
  - `Save-HarnessVerified -Source -Destination -Sha256 -Size`, `Expand-HarnessZip -Tar -Archive -Destination`.
  - `Move-HarnessFile`, `Copy-HarnessFile`, `Write-HarnessPointer -Path -Value`.
  - `Add-HarnessUserPath -Directory [-SubKey]` returns whether it added the folder; `Send-HarnessEnvironmentChange`.
- Produces these script inputs:
  - flags `-Desktop`, `-Manifest <url|path>` (default `$env:HARNESS_INSTALL_MANIFEST`), `-NoService`;
  - the env seams `HARNESS_INSTALL_LIBRARY=1` (define, do not run) and `HARNESS_INSTALL_ENV_KEY` (a test subkey of
    HKCU instead of `Environment`).
- Produces the `-Manifest` document format: one JSON document with the keys `cli`, `node` and `pty`, each shaped as
  that key of its published manifest. An entry's `url` is `https://`. Only when the manifest is a local file may it
  be a path, relative to the manifest's folder. Without `-Manifest`, the installer reads the three published
  documents `<base>cli/metadata.json`, `<base>runtime/metadata.json` and `<base>pty/metadata.json`, where the base
  is `$HarnessManifestBase`.

- [ ] **Step 1: Write the failing test.** Create `cli/src/scripts/installPs1.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// vitest runs from cli/, so this is cli/scripts/install.ps1, the file published to the CDN.
const installer = join(process.cwd(), 'scripts', 'install.ps1')
const source = readFileSync(installer, 'utf8')

describe('install.ps1, as written', () => {
  it('is pure ASCII: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page', () => {
    const offending = source.split(/\r?\n/).flatMap((line, i) => (/[^\t\r\x20-\x7e]/.test(line) ? [`${i + 1}: ${line}`] : []))
    expect(offending).toEqual([])
  })

  it('has exactly one manifest-base line, the production one, for the staging upload to rewrite', () => {
    const lines = source.split(/\r?\n/).filter((line) => line.startsWith("$HarnessManifestBase = '"))
    expect(lines).toEqual(["$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"])
  })

  it('never writes machine-wide state: no machine PATH, no HKLM write, no elevation', () => {
    expect(source).not.toMatch(/'Machine'|\[EnvironmentVariableTarget\]::Machine|LocalMachine/)
    expect(source).not.toMatch(/-Verb\s+RunAs/i)
    for (const line of source.split(/\r?\n/).filter((l) => l.includes('HKLM:'))) expect(line).toContain('Get-ItemProperty')
  })

  it('runs its install only outside library mode, and never exits a session it was iex-ed into', () => {
    expect(source).toContain("if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {")
    expect(source).toContain('if ($HarnessScriptPath) { exit $harnessExit }')
  })
})

const windows = process.platform === 'win32'
const scratch: string[] = []
const subkeys: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  for (const key of subkeys) spawnSync('reg.exe', ['delete', `HKCU\\${key}`, '/f'], { encoding: 'utf8' })
})

/** Run [script] in Windows PowerShell 5.1 with the installer dot-sourced in library mode. */
function ps(script: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const text = `$ErrorActionPreference = 'Stop'; . '${installer}'; ${script}`
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: { ...process.env, HARNESS_INSTALL_LIBRARY: '1', ...env }, timeout: 120_000,
  })
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr }
}

/** The message a call throws, or `no error`. */
const thrown = (call: string) => ps(`try { ${call} | Out-Null; 'no error' } catch { $_.Exception.Message }`).stdout

describe.runIf(windows)('install.ps1 building blocks, in Windows PowerShell 5.1', () => {
  it('names this computer\'s platform from the native architecture, and refuses one Harness is not built for', () => {
    expect(ps("Get-HarnessPlatform -Architecture 'AMD64'").stdout).toBe('win32-x64')
    expect(ps("Get-HarnessPlatform -Architecture 'ARM64'").stdout).toBe('win32-arm64')
    expect(thrown("Get-HarnessPlatform -Architecture 'x86'")).toContain('not supported')
    expect(ps('Get-HarnessPlatform').stdout).toMatch(/^win32-(x64|arm64)$/)
  })

  it('refuses a Windows older than ConPTY, and a Windows without its own tar.exe', () => {
    expect(thrown('Test-HarnessHost -Build 17134')).toContain('Windows 10 version 1809 or later')
    const empty = mkdtempSync(join(tmpdir(), 'harness-ps1-root-'))
    scratch.push(empty)
    expect(thrown(`Test-HarnessHost -Build 22631 -SystemRoot '${empty}'`)).toContain('tar.exe')
    expect(ps('Test-HarnessHost').stdout.toLowerCase()).toBe(join(process.env.SystemRoot!, 'System32', 'tar.exe').toLowerCase())
  })

  it('trusts https:// and local files only, and resolves a local manifest\'s relative names against its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ref-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, '{}')
    expect(ps(`Resolve-HarnessRef 'cli.js' '${manifest}'`).stdout).toBe(join(dir, 'cli.js'))
    expect(ps(`Resolve-HarnessRef 'https://cdn.example/a.zip' '${manifest}'`).stdout).toBe('https://cdn.example/a.zip')
    expect(thrown(`Resolve-HarnessRef 'http://cdn.example/a.zip' '${manifest}'`)).toContain('https://')
    expect(thrown("Resolve-HarnessRef 'cli.js' 'https://cdn.example/metadata.json'")).toContain('not an https:// address')
    expect(thrown("Get-HarnessJson 'http://cdn.example/metadata.json'")).toContain('https://')
  })

  it('keeps a download only when its size and SHA-256 are the manifest\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-dl-'))
    scratch.push(dir)
    const file = join(dir, 'payload.bin')
    writeFileSync(file, 'harness')
    const sha = 'a'.repeat(64) // a valid shape, not this file's digest
    const real = ps(`(Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash.ToLowerInvariant()`).stdout
    const out = join(dir, 'out.bin')
    expect(ps(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 7; 'ok'`).stdout).toBe('ok')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 8`)).toContain('7 bytes, but the manifest says 8')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${sha}' -Size 7`)).toContain('failed its checksum')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 'nope' -Size 7`)).toContain('no valid SHA-256')
  })

  it('writes a pointer as its value and CRLF, with no BOM, and replaces one that is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ptr-'))
    scratch.push(dir)
    const pointer = join(dir, 'current')
    ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.3'`)
    ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.4'`)
    expect(readFileSync(pointer)).toEqual(Buffer.from('1.2.4\r\n'))
  })

  it('adds the bin folder to the user\'s PATH once, keeping the value\'s kind and what was there', () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    spawnSync('reg.exe', ['add', `HKCU\\${subkey}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%SystemRoot%\\fake', '/f'], { encoding: 'utf8' })
    const bin = 'C:\\Users\\someone\\.harness\\bin'
    expect(ps(`Add-HarnessUserPath -Directory '${bin}' -SubKey '${subkey}'`).stdout).toBe('True')
    expect(ps(`Add-HarnessUserPath -Directory '${bin}\\' -SubKey '${subkey}'`).stdout).toBe('False')
    const query = spawnSync('reg.exe', ['query', `HKCU\\${subkey}`, '/v', 'Path'], { encoding: 'utf8' }).stdout
    expect(query).toContain('REG_EXPAND_SZ')
    expect(query).toContain(`%SystemRoot%\\fake;${bin}`)
  })

  it('reads one -Manifest document for all three entries, and says which entry is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-man-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: { 'win32-x64': { version: '1.2.3' } } }))
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').node.entry.version`).stdout).toBe('v22.0.0')
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').pty.source`).stdout).toBe(manifest)
    const partial = join(dir, 'partial.json')
    writeFileSync(partial, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: {} }))
    expect(thrown(`Get-HarnessManifests -Manifest '${partial}' -Platform 'win32-x64'`)).toContain("no 'win32-x64' entry")
    expect(thrown(`Get-HarnessManifests -Manifest '${join(dir, 'missing.json')}' -Platform 'win32-x64'`)).toContain('missing.json')
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/scripts/installPs1.spec.ts`.
  Expected: on macOS the file fails to load, with `ENOENT: no such file or directory, open '.../scripts/install.ps1'`.

- [ ] **Step 3: Implement.** Create `cli/scripts/install.ps1`:

```powershell
# Harness CLI installer for Windows, served from https://cdn.autonomous.ai/harness/cli/install.ps1.
# Source of truth: THIS file, cli/scripts/install.ps1. It is published by cli/scripts/upload-install-ps1.sh (staging
# by default; production is the owner's step) and tested by cli/src/scripts/installPs1.spec.ts. It is the Windows
# counterpart of install.sh, step for step.
#
#   irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex
#   iex "& { $(irm https://cdn.autonomous.ai/harness/cli/install.ps1) } -Desktop"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Manifest C:\build\install-manifest.json -NoService
#
# It installs per user, with no administrator rights. Everything goes under %USERPROFILE%\.harness, and PATH is the
# user's own (HKCU\Environment), never the machine's. The file is pure ASCII on purpose: Windows PowerShell 5.1
# reads a script file without a BOM in the ANSI code page, so one non-ASCII character would garble it.
param(
  [switch]$Desktop,
  [string]$Manifest = $env:HARNESS_INSTALL_MANIFEST,
  [switch]$NoService
)

# The base under which the three published manifests live: cli/metadata.json, runtime/metadata.json and
# pty/metadata.json. upload-install-ps1.sh rewrites this one line for the staging copy.
$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'
# Set when this runs as a file (-File, or a saved copy). It is empty under `irm | iex`.
$HarnessScriptPath = $MyInvocation.MyCommand.Path

$HarnessCliVersionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
$HarnessPtyVersionPattern = '^\d+(\.\d+)*$'
$HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe')

function Get-HarnessPlatform {
  # The platform from the NATIVE architecture, read where Windows keeps it for the whole system. An x64
  # PowerShell emulated on an ARM64 computer reports AMD64 in its own environment, and would install the
  # emulated build.
  param([string]$Architecture)
  if (-not $Architecture) {
    $item = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction SilentlyContinue
    if ($item) { $Architecture = [string]$item.PROCESSOR_ARCHITECTURE }
    if (-not $Architecture) { $Architecture = [string]$env:PROCESSOR_ARCHITECTURE }
  }
  switch ($Architecture.ToUpperInvariant()) {
    'AMD64' { return 'win32-x64' }
    'ARM64' { return 'win32-arm64' }
    default { throw "This computer's processor ($Architecture) is not supported: Harness runs on 64-bit Windows, x64 or ARM64." }
  }
}

function Test-HarnessHost {
  # ConPTY, which the terminal host needs, arrived in Windows 10 1809 (build 17763). tar.exe, which unpacks the
  # downloads, has shipped in System32 since 1803. The path is fixed so a GNU tar on PATH is never used: it
  # cannot read a zip.
  param([int]$Build = [Environment]::OSVersion.Version.Build, [string]$SystemRoot = $env:SystemRoot)
  if ($Build -lt 17763) { throw "Harness needs Windows 10 version 1809 or later, and this computer runs build $Build. Update Windows, then run the installer again." }
  $tar = Join-Path $SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "Windows' own tar.exe is missing ($tar). It is part of Windows 10 1803 and later." }
  return $tar
}

function Test-HarnessUrl([string]$Value) { return $Value -match '^https://' }
function Test-HarnessScheme([string]$Value) { return $Value -match '^[A-Za-z][A-Za-z0-9+.-]*://' }

function Invoke-HarnessRetry {
  # Three tries for a network step, as install.sh's download() makes. A connection that drops in the middle
  # of a 30 MB runtime is common on Wi-Fi.
  param([scriptblock]$Action, [int]$Attempts = 3)
  for ($i = 1; ; $i++) {
    try { return & $Action } catch {
      if ($i -ge $Attempts) { throw }
      Write-Host "  Connection interrupted; retrying ($($i + 1)/$Attempts)..."
      Start-Sleep -Seconds 2
    }
  }
}

function Get-HarnessJson {
  param([string]$Source)
  if (Test-HarnessUrl $Source) {
    $response = Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -UseBasicParsing -TimeoutSec 60 -Headers @{ 'Cache-Control' = 'no-cache' } }
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    return $content | ConvertFrom-Json
  }
  if (Test-HarnessScheme $Source) { throw "Only https:// addresses are trusted, and $Source is not one." }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "The manifest $Source does not exist." }
  return (Get-Content -LiteralPath $Source -Raw -Encoding UTF8) | ConvertFrom-Json
}

function Resolve-HarnessRef {
  # Where an entry's file is. A published manifest names https:// addresses only. A local manifest (a test, or a
  # build of this tree) may also name files beside it.
  param([string]$Ref, [string]$ManifestSource)
  if (Test-HarnessUrl $Ref) { return $Ref }
  if (Test-HarnessScheme $Ref) { throw "Only https:// addresses are trusted, and $Ref is not one." }
  if (Test-HarnessUrl $ManifestSource) { throw "The manifest $ManifestSource names $Ref, which is not an https:// address." }
  if ([IO.Path]::IsPathRooted($Ref)) { return $Ref }
  return Join-Path (Split-Path -Parent $ManifestSource) $Ref
}

function Get-HarnessProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-HarnessManifests {
  # The three entries this computer needs, each with the document it came from: relative names in a local
  # manifest are resolved against that document. With -Manifest it is one document holding the cli, node and pty
  # keys. Otherwise it is the three published documents under $Base.
  param([string]$Manifest, [string]$Platform, [string]$Base = $HarnessManifestBase)
  if ($Manifest) {
    if (-not (Test-HarnessUrl $Manifest) -and -not (Test-HarnessScheme $Manifest)) {
      if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { throw "The manifest $Manifest does not exist." }
      $Manifest = (Resolve-Path -LiteralPath $Manifest).ProviderPath
    }
    $document = Get-HarnessJson $Manifest
    $sources = @{ cli = $Manifest; node = $Manifest; pty = $Manifest }
    $documents = @{ cli = $document; node = $document; pty = $document }
  } else {
    $sources = @{ cli = "${Base}cli/metadata.json"; node = "${Base}runtime/metadata.json"; pty = "${Base}pty/metadata.json" }
    $documents = @{}
    foreach ($name in 'cli', 'node', 'pty') { $documents[$name] = Get-HarnessJson $sources[$name] }
  }
  $cli = Get-HarnessProperty $documents.cli 'cli'
  $node = Get-HarnessProperty (Get-HarnessProperty $documents.node 'node') $Platform
  $pty = Get-HarnessProperty (Get-HarnessProperty $documents.pty 'pty') $Platform
  if (-not $cli) { throw "The CLI manifest ($($sources.cli)) has no 'cli' entry." }
  if (-not $node) { throw "The Node runtime manifest ($($sources.node)) has no '$Platform' entry: Harness is not published for this computer yet." }
  if (-not $pty) { throw "The terminal host manifest ($($sources.pty)) has no '$Platform' entry: Harness is not published for this computer yet." }
  return @{
    cli = @{ entry = $cli; source = $sources.cli }
    node = @{ entry = $node; source = $sources.node }
    pty = @{ entry = $pty; source = $sources.pty }
  }
}

function Save-HarnessVerified {
  # Download (or copy, for a local manifest), then keep the file only if its size and SHA-256 are the manifest's.
  # The manifest is the trust: the downloaded bytes are not, until they match it.
  param([string]$Source, [string]$Destination, [string]$Sha256, $Size)
  if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "The manifest gives no valid SHA-256 for $Source." }
  try {
    if (Test-HarnessUrl $Source) {
      Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -OutFile $Destination -UseBasicParsing -TimeoutSec 600 } | Out-Null
    } elseif (Test-HarnessScheme $Source) {
      throw "Only https:// addresses are trusted, and $Source is not one."
    } else {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
    $length = (Get-Item -LiteralPath $Destination).Length
    if ($null -ne $Size -and "$Size" -ne '' -and [int64]$Size -ne $length) {
      throw "$Source is $length bytes, but the manifest says ${Size}: the download is incomplete, or is not the published file."
    }
    $got = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $Sha256.ToLowerInvariant()) { throw "$Source failed its checksum (expected $Sha256, got $got): it is not the published file." }
  } catch {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Expand-HarnessZip {
  param([string]$Tar, [string]$Archive, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & $Tar -xf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Archive (tar.exe exit code $LASTEXITCODE)." }
}

function New-HarnessStaging {
  # The name the CLI's own sweep recognizes (.<name>-staging-<pid>-<time>, runtimeInstall.ts sweepStaging).
  # A folder left by an installer that was stopped is removed by the next daemon start.
  param([string]$Parent, [string]$Name)
  $dir = Join-Path $Parent ".$Name-staging-$PID-$([DateTime]::UtcNow.Ticks)"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Move-HarnessFile {
  # Rename over the destination, retried. An antivirus scan or the search indexer can hold a new file for a
  # moment, and a harness-launch.exe that is still exiting holds its own.
  param([string]$Source, [string]$Destination)
  for ($i = 1; ; $i++) {
    try {
      if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source, $Destination, $null) } else { [IO.File]::Move($Source, $Destination) }
      return
    } catch {
      if ($i -ge 5) { Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds (50 * $i)
    }
  }
}

function Copy-HarnessFile {
  param([string]$Source, [string]$Destination)
  $temp = "$Destination.tmp-$PID"
  Copy-Item -LiteralPath $Source -Destination $temp -Force
  Move-HarnessFile -Source $temp -Destination $Destination
}

function Write-HarnessPointer {
  # One line and CRLF, UTF-8 with no BOM, through a rename (installLayout.ts writePointer). harness.cmd reads it
  # with `set /p`, which would keep a BOM as part of the value.
  param([string]$Path, [string]$Value)
  $temp = "$Path.tmp-$PID"
  [IO.File]::WriteAllText($temp, "$Value`r`n", (New-Object Text.UTF8Encoding $false))
  Move-HarnessFile -Source $temp -Destination $Path
}

function Add-HarnessUserPath {
  # Add the folder to the user's PATH in HKCU\Environment once. The value keeps its kind (REG_EXPAND_SZ, normally)
  # and every entry already in it. An entry is compared expanded, case-insensitively and without a trailing
  # backslash, so %USERPROFILE%\.harness\bin counts as the same folder.
  param([string]$Directory, [string]$SubKey = 'Environment')
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($current -ne '') { try { $kind = $key.GetValueKind('Path') } catch { } }
    $entries = @($current -split ';' | Where-Object { $_ -ne '' })
    $wanted = $Directory.TrimEnd('\')
    foreach ($entry in $entries) {
      if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $wanted) { return $false }
    }
    $key.SetValue('Path', ((@($entries) + $wanted) -join ';'), $kind)
    return $true
  } finally { $key.Close() }
}

function Send-HarnessEnvironmentChange {
  # Tell Explorer, and through it every terminal started from now on, that the user's PATH changed. Add-Type
  # compiles a little C#, which Constrained Language Mode (some managed computers) forbids. That only means a
  # new terminal must be opened from a fresh Explorer, so it is a note and not a failure.
  try {
    if (-not ('Harness.NativeMethods' -as [type])) {
      Add-Type -Namespace Harness -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Harness.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Write-Host '  (Could not announce the PATH change; terminals opened after you sign in again will see it.)'
  }
}

# --- Install (Task B1.8) ---

# --- Run ---
if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {
  if (-not $Manifest) { $Manifest = $env:HARNESS_INSTALL_MANIFEST }
  $harnessExit = @(Install-Harness -Desktop:([bool]$Desktop) -Manifest $Manifest -NoService:([bool]$NoService))[-1]
  # Run as a file, the exit code is the result. Run by `irm | iex`, it never calls `exit`: that would close the
  # person's PowerShell window with the message still in it.
  if ($HarnessScriptPath) { exit $harnessExit }
  $global:LASTEXITCODE = $harnessExit
}
```

- [ ] **Step 4: Run it and see it pass.** Run `cd cli && npx vitest run src/scripts/installPs1.spec.ts`.
  Expected: on macOS the four static cases pass and the Windows block is skipped. The static cases split on
  `/\r?\n/`, so they hold for a CRLF checkout too.

- [ ] **Step 5: Pin the scripts' line endings.** Append to the root `.gitattributes`:

```
# Windows scripts. install.ps1 is published byte for byte and its spec reads it as LF; cmd needs CRLF to parse a
# batch file's labels reliably. Without these, core.autocrlf (GitHub's Windows images set it) decides.
*.ps1 text eol=lf
*.cmd text eol=crlf
```

  The tracked `.cmd` files (`cli/scripts/windows-pty-e2e/*.cmd`, `cli/src/lib/windows/fixtures/*.cmd`) are stored
  with CRLF in the index today; `text` stores them as LF and checks them out as CRLF, so renormalize them once:
  `git add --renormalize .gitattributes cli/scripts/windows-pty-e2e cli/src/lib/windows/fixtures pty/scripts`.
  Then run `git check-attr eol -- cli/scripts/install.ps1 cli/scripts/windows-pty-e2e/env.cmd` and
  `git ls-files --eol cli/scripts/windows-pty-e2e cli/src/lib/windows/fixtures`.
  Expected: `eol: lf` for `install.ps1` and `eol: crlf` for `env.cmd`; every listed `.cmd` shows `i/lf w/crlf` and
  every `.ps1` `i/lf w/lf`. The working-tree files keep their bytes; `git diff --cached --ignore-cr-at-eol --stat`
  lists only `.gitattributes` with changes.

- [ ] **Step 6: Windows verification.**
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run src/scripts/installPs1.spec.ts"`.
  Expected: all 11 cases pass in Windows PowerShell 5.1 on ARM64. The PATH case writes only under
  `HKCU\Software\HarnessInstallTest\<uuid>`, and `afterAll` deletes that subkey. Confirm with
  `reg query HKCU\Software\HarnessInstallTest`: it should report that the key is not found, or list no subkeys.

- [ ] **Step 7: Commit.**
  `git add .gitattributes cli/scripts/install.ps1 cli/src/scripts/installPs1.spec.ts`
  `git add --renormalize cli/scripts/windows-pty-e2e cli/src/lib/windows/fixtures pty/scripts`
  `git commit -m "feat(cli): install.ps1 foundations: host check, manifests, verified downloads, pointers, user PATH"`

### Task B1.8: `install.ps1` installs Node, the CLI and the pty payload, writes `harness.cmd`, and sets up PATH and the service

**Files**
- Modify: `cli/scripts/install.ps1`: replace the line `# --- Install (Task B1.8) ---` with the block below.
- Modify: `cli/src/scripts/installPs1.spec.ts`: append a new `describe.runIf(windows)` block and two static cases.

**Interfaces**
- Consumes: the B1.7 functions; `harness service install`, a B3 command (until B3, a failure there is a warning and
  not an install failure); `harness version`.
- Produces:
  - `Install-Harness -Desktop -Manifest -NoService` returns 0 or 1.
  - The layout of spec section 1, with `bin\harness.cmd` (contract) and `bin\harness-launch.exe` copied from
    `runtime\pty\<version>\`.
  - Pointers written with CRLF: `cli\current`, `runtime\current-node` (full path), `runtime\pty\current-pty`.
  - The stable `cli\notify.mjs`.
  - `harness.cmd` passes its arguments through `%*`, reads the pointers under code page 65001, and exits with
    node's exit code.

- [ ] **Step 1: Write the failing tests.** Append to `cli/src/scripts/installPs1.spec.ts`. First, in
  `describe('install.ps1, as written')`, add these two cases after the last `it`:

```ts
  it('writes a harness.cmd that only reads the two pointers and passes the arguments through untouched', () => {
    const template = source.slice(source.indexOf("$HarnessCmd = @'"), source.indexOf("'@", source.indexOf("$HarnessCmd = @'")))
    expect(template).toContain('set /p HARNESS_CLI_VERSION=<"%HARNESS_ROOT%\\cli\\current"')
    expect(template).toContain('set /p HARNESS_NODE=<"%HARNESS_ROOT%\\runtime\\current-node"')
    expect(template.match(/%\*/g)).toHaveLength(1)
    // The exit shares node's line, so cmd reads nothing more from a file `harness uninstall` deleted meanwhile.
    expect(template).toMatch(/%\* & exit \/b\s*$/m)
    expect(template).not.toContain('%ERRORLEVEL%')
    // No delayed expansion (`!`) and no parenthesised blocks: a profile folder named "Jo (work)" or with a `!`
    // must not change what cmd parses.
    expect(template).not.toContain('!')
    expect(template).not.toMatch(/\)\s*$/m)
  })

  it('never installs hn or tmux on Windows', () => {
    expect(source).not.toMatch(/harness-tui|tmux/i)
  })
```

  Then append this block at the end of the file:

```ts
describe.runIf(windows)('install.ps1, installing for real from a local manifest', () => {
  /**
   * A build of everything install.ps1 downloads:
   * - a Node zip of nodejs.org's shape, holding the Node running this test;
   * - a pty zip whose four files only need to exist (nothing here runs them);
   * - a CLI that answers `version` and echoes any other arguments as JSON.
   * Each manifest entry names its file relative to the manifest.
   */
  function build(platform: string, overrides: { cliSha?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-build-'))
    scratch.push(dir)
    const tar = join(process.env.SystemRoot!, 'System32', 'tar.exe')
    const archiveRoot = `node-v22.0.0-win-${platform.slice('win32-'.length)}`
    mkdirSync(join(dir, 'src', archiveRoot), { recursive: true })
    writeFileSync(join(dir, 'src', archiveRoot, 'node.exe'), readFileSync(process.execPath))
    spawnSync(tar, ['-a', '-cf', join(dir, 'node.zip'), '-C', join(dir, 'src'), archiveRoot])
    mkdirSync(join(dir, 'payload'))
    for (const name of ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe']) writeFileSync(join(dir, 'payload', name), name)
    spawnSync(tar, ['-a', '-cf', join(dir, 'pty.zip'), '-C', join(dir, 'payload'), 'harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe'])
    writeFileSync(join(dir, 'cli.js'), "const a = process.argv.slice(2); if (a[0] === 'version') console.log('9.8.7'); else { console.log(JSON.stringify(a)); process.exitCode = a.includes('fail') ? 7 : 0 }\n")
    writeFileSync(join(dir, 'notify.mjs'), 'export {}\n')
    const ref = (name: string) => {
      const bytes = readFileSync(join(dir, name))
      return { url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    }
    const cli = ref('cli.js')
    const manifest = {
      cli: { version: '9.8.7', cli: { ...cli, sha256: overrides.cliSha ?? cli.sha256 }, notify: ref('notify.mjs') },
      node: { [platform]: { version: 'v22.0.0', ...ref('node.zip'), archiveRoot } },
      pty: { [platform]: { version: '9.8.7', ...ref('pty.zip') } },
    }
    writeFileSync(join(dir, 'install-manifest.json'), JSON.stringify(manifest, null, 2))
    return join(dir, 'install-manifest.json')
  }

  /**
   * A fresh profile whose name has a space, a non-ASCII letter, a CJK character and an `&`: cmd quoting and
   * set /p's code page are what such a name breaks.
   */
  function profile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-home-'))
    scratch.push(dir)
    const home = join(dir, 'J\u00f6 \u65e5 & co')
    mkdirSync(home)
    return home
  }

  function install(home: string, manifest: string, subkey: string, extra: string[] = ['-NoService']) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Manifest', manifest, ...extra], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey }, timeout: 300_000,
    })
  }

  const platform = () => ps('Get-HarnessPlatform').stdout

  /**
   * The Path value under HKCU\<subkey>, as stored (not expanded). Not through `reg.exe query`: it prints to a pipe in
   * the OEM code page, which turns `\u00f6` and `\u65e5` into other bytes, so the profile path would never match.
   * PowerShell prints the value as base64 of its UTF-16 bytes, which no code page can change.
   */
  function userPathValue(subkey: string): string {
    const script = `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${subkey}'); $v = if ($k) { [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    return Buffer.from(run.stdout.trim(), 'base64').toString('utf16le')
  }

  it('lays the version folders, the pointers and both launchers down, and harness works through harness.cmd', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const key = platform()
    const run = install(home, build(key), subkey)
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)

    const root = join(home, '.harness')
    const node = join(root, 'runtime', `node-v22.0.0-${key}`, 'node.exe')
    expect(readFileSync(join(root, 'cli', 'current'), 'utf8')).toBe('9.8.7\r\n')
    expect(readFileSync(join(root, 'runtime', 'current-node'), 'utf8')).toBe(`${node}\r\n`)
    expect(readFileSync(join(root, 'runtime', 'pty', 'current-pty'), 'utf8')).toBe('9.8.7\r\n')
    expect(JSON.parse(readFileSync(join(root, 'cli', '9.8.7', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(readFileSync(join(root, 'cli', 'notify.mjs'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(root, 'bin', 'harness-launch.exe'), 'utf8')).toBe('harness-launch.exe')
    for (const name of ['harness-pty.exe', 'conpty.dll', 'OpenConsole.exe']) expect(readFileSync(join(root, 'runtime', 'pty', '9.8.7', name), 'utf8')).toBe(name)

    // How a person runs it: by name, from PowerShell, in a new window (PATH from the registry, as Explorer gives it).
    const command = join(root, 'bin', 'harness.cmd')
    const viaPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', `& '${command}' echo 'two words' '50%'; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(viaPowerShell.stdout.trim()).toBe('["echo","two words","50%"]')
    // And from cmd, with the exit code passed back.
    const viaCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" version"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    expect(viaCmd.stdout.trim()).toBe('9.8.7')
    const failing = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" fail"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    expect(failing.status).toBe(7)

    const path = userPathValue(subkey)
    expect(path.split(';')).toContain(join(root, 'bin'))
    expect(run.stdout).toContain('harness 9.8.7 installed')
  })

  it('runs again over itself: nothing downloaded twice, PATH not doubled, harness.cmd left as it is', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const manifest = build(platform())
    expect(install(home, manifest, subkey).status).toBe(0)
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    const before = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${command}').LastWriteTimeUtc.Ticks`], { encoding: 'utf8' }).stdout.trim()
    const again = install(home, manifest, subkey)
    expect(again.status, again.stdout).toBe(0)
    expect(again.stdout).not.toContain('Downloading')
    const after = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${command}').LastWriteTimeUtc.Ticks`], { encoding: 'utf8' }).stdout.trim()
    expect(after).toBe(before)
    const path = userPathValue(subkey)
    expect(path.split(';').filter((entry) => entry === join(home, '.harness', 'bin'))).toHaveLength(1)
  })

  it('says, in a sentence, which step failed, and points nothing at a CLI it did not verify', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const run = install(home, build(platform(), { cliSha: '0'.repeat(64) }), subkey)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('Harness could not be installed. The step that failed: Installing the Harness CLI.')
    expect(run.stdout).toContain('failed its checksum')
    expect(() => readFileSync(join(home, '.harness', 'cli', 'current'))).toThrow()
  })

  it('reports the failure and leaves the PowerShell it was iex-ed into running', () => {
    const missing = join(tmpdir(), `harness-missing-${randomUUID()}.json`)
    const text = `$env:HARNESS_INSTALL_MANIFEST = '${missing}'; Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, USERPROFILE: profile() }, timeout: 120_000 })
    expect(run.stdout).toContain('The step that failed: Reading the release manifests.')
    expect(run.stdout.trim().endsWith('after 1')).toBe(true)
  })
})
```

  Also add `import { createHash } from 'node:crypto'`: change the existing `import { randomUUID } from 'node:crypto'`
  to `import { createHash, randomUUID } from 'node:crypto'`.

- [ ] **Step 2: Run them and see them fail.** On macOS, run `cd cli && npx vitest run src/scripts/installPs1.spec.ts`.
  Expected: the harness.cmd static case fails, with `$HarnessCmd` not in the source. On the VM, after
  `vm-sync.sh --cli`, run `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/scripts/installPs1.spec.ts"`.
  Expected: the four install cases fail with `The term 'Install-Harness' is not recognized`.

- [ ] **Step 3: Implement.** In `cli/scripts/install.ps1`, replace the line `# --- Install (Task B1.8) ---` with:

```powershell
# --- Install ---

# bin\harness.cmd, the `harness` command. It holds no path itself: it finds the install from its own folder
# (%~dp0) and reads the two pointers the installer and the updater keep. Node and the CLI can therefore move on
# without rewriting it. A running batch file is re-read from disk by cmd line by line, so it is rewritten only
# when its bytes change. It uses no delayed expansion and no parenthesised blocks, so a `!` or `)` in a profile
# folder's name cannot change what cmd parses. The pointers are UTF-8, so they are read in code page 65001 and
# a non-ASCII profile name survives. The person's code page is restored before Node starts.
$HarnessCmd = @'
@echo off
rem Harness: the harness command, written by install.ps1. It runs the CLI that cli\current names on the Node
rem that runtime\current-node names. The arguments pass through untouched; nothing here parses them.
setlocal DisableDelayedExpansion
set "HARNESS_ROOT=%~dp0.."
set "HARNESS_CLI_VERSION="
set "HARNESS_NODE="
set "HARNESS_CODEPAGE="
for /f "tokens=2 delims=:." %%C in ('chcp') do set "HARNESS_CODEPAGE=%%C"
chcp 65001 >nul 2>&1
set /p HARNESS_CLI_VERSION=<"%HARNESS_ROOT%\cli\current"
set /p HARNESS_NODE=<"%HARNESS_ROOT%\runtime\current-node"
if defined HARNESS_CODEPAGE chcp %HARNESS_CODEPAGE% >nul 2>&1
if not defined HARNESS_CLI_VERSION goto broken
if not defined HARNESS_NODE goto broken
if not exist "%HARNESS_NODE%" goto broken
if not exist "%HARNESS_ROOT%\cli\%HARNESS_CLI_VERSION%\cli.js" goto broken
rem The exit is on node's line: cmd reads that line whole before running it, so nothing is read from this file once
rem node returns. `harness uninstall` deletes this file while it runs. `exit /b` keeps node's exit code.
"%HARNESS_NODE%" "%HARNESS_ROOT%\cli\%HARNESS_CLI_VERSION%\cli.js" %* & exit /b
:broken
echo Harness is not installed completely. Install it again: irm https://cdn.autonomous.ai/harness/cli/install.ps1 ^| iex 1>&2
exit /b 1
'@

function Test-HarnessPtyFolder([string]$Dir) {
  foreach ($name in $HarnessPtyFiles) { if (-not (Test-Path -LiteralPath (Join-Path $Dir $name) -PathType Leaf)) { return $false } }
  return $true
}

function Install-HarnessNode {
  # runtime\node-<version>-<platform>\node.exe, from nodejs.org's own zip (node-<version>-win-<arch>\node.exe).
  # current-node is written last, and only once node.exe has answered. The CLI, the desktop app and harness.cmd
  # all execute what it names.
  param([string]$Root, $Entry, [string]$Source, [string]$Tar, [string]$Platform)
  $version = [string]$Entry.version
  if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw "The Node runtime manifest names an unexpected version '$version'." }
  $archiveRoot = [string]$Entry.archiveRoot
  if ($archiveRoot -notmatch '^node-v\d+\.\d+\.\d+-win-(x64|arm64)$') { throw "The Node runtime manifest names an unexpected archive folder '$archiveRoot'." }
  $runtime = Join-Path $Root 'runtime'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $target = Join-Path $runtime "node-$version-$Platform"
  $node = Join-Path $target 'node.exe'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    Write-Host "  Downloading Node $version ($Platform)..."
    $staging = New-HarnessStaging $runtime 'node'
    try {
      $archive = Join-Path $staging 'node.zip'
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.url) $Source) -Destination $archive -Sha256 ([string]$Entry.sha256) -Size $Entry.size
      Expand-HarnessZip -Tar $Tar -Archive $archive -Destination $staging
      $unpacked = Join-Path $staging $archiveRoot
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'node.exe') -PathType Leaf)) { throw "The Node archive has no $archiveRoot\node.exe." }
      if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $unpacked -Destination $target }
    } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $said = & $node --version
  if ($LASTEXITCODE -ne 0) { throw "The Node runtime at $node does not run on this computer." }
  Write-HarnessPointer -Path (Join-Path $runtime 'current-node') -Value $node
  Write-Host "  OK Node $said -> $target"
}

function Install-HarnessCli {
  # cli\<version>\cli.js, notify.mjs and package.json, written into staging and renamed into place, then
  # cli\current and the stable cli\notify.mjs. A version folder whose cli.js already has the manifest's digest
  # is kept: it is that version, and a running daemon may be using it.
  param([string]$Root, $Entry, [string]$Source)
  $version = [string]$Entry.version
  if ($version -notmatch $HarnessCliVersionPattern) { throw "The CLI manifest names an unexpected version '$version'." }
  foreach ($part in 'cli', 'notify') { if (-not (Get-HarnessProperty $Entry $part)) { throw "The CLI manifest has no '$part' file." } }
  $cliRoot = Join-Path $Root 'cli'
  New-Item -ItemType Directory -Force -Path $cliRoot | Out-Null
  $target = Join-Path $cliRoot $version
  $installed = Join-Path $target 'cli.js'
  $current = (Test-Path -LiteralPath $installed -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $target 'notify.mjs') -PathType Leaf) -and ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ieq [string]$Entry.cli.sha256)
  if (-not $current) {
    Write-Host "  Downloading Harness $version..."
    $staging = New-HarnessStaging $cliRoot 'cli'
    try {
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.cli.url) $Source) -Destination (Join-Path $staging 'cli.js') -Sha256 ([string]$Entry.cli.sha256) -Size $Entry.cli.size
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.notify.url) $Source) -Destination (Join-Path $staging 'notify.mjs') -Sha256 ([string]$Entry.notify.sha256) -Size $Entry.notify.size
      # The bundle is an ES module, and Node decides that from the nearest package.json. install.sh writes the same file.
      [IO.File]::WriteAllText((Join-Path $staging 'package.json'), "{""type"":""module""}`n", (New-Object Text.UTF8Encoding $false))
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $staging -Destination $target
    } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } }
  }
  Write-HarnessPointer -Path (Join-Path $cliRoot 'current') -Value $version
  Copy-HarnessFile -Source (Join-Path $target 'notify.mjs') -Destination (Join-Path $cliRoot 'notify.mjs')
  Write-Host "  OK Harness $version -> $target"
  return $version
}

function Install-HarnessPty {
  # runtime\pty\<version>\ with the host, the launcher and ConPTY, then current-pty and bin\harness-launch.exe. A
  # complete version folder is never replaced: a host may be running from it, and a running .exe cannot be
  # overwritten on Windows (A's spec, host upgrade).
  param([string]$Root, $Entry, [string]$Source, [string]$Tar)
  $version = [string]$Entry.version
  if ($version -notmatch $HarnessPtyVersionPattern) { throw "The terminal host manifest names an unexpected version '$version'." }
  $ptyRoot = Join-Path $Root 'runtime\pty'
  New-Item -ItemType Directory -Force -Path $ptyRoot | Out-Null
  $target = Join-Path $ptyRoot $version
  if (-not (Test-HarnessPtyFolder $target)) {
    Write-Host "  Downloading the terminal host $version..."
    $staging = New-HarnessStaging $ptyRoot 'pty'
    try {
      $archive = Join-Path $staging 'pty.zip'
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.url) $Source) -Destination $archive -Sha256 ([string]$Entry.sha256) -Size $Entry.size
      $unpacked = Join-Path $staging 'payload'
      Expand-HarnessZip -Tar $Tar -Archive $archive -Destination $unpacked
      if (-not (Test-HarnessPtyFolder $unpacked)) { throw "The terminal host archive lacks one of $($HarnessPtyFiles -join ', ')." }
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $unpacked -Destination $target
    } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-HarnessPointer -Path (Join-Path $ptyRoot 'current-pty') -Value $version
  $bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Copy-HarnessFile -Source (Join-Path $target 'harness-launch.exe') -Destination (Join-Path $bin 'harness-launch.exe')
  Write-Host "  OK terminal host $version -> $target"
}

function Write-HarnessLaunchers {
  param([string]$Root)
  $bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $command = Join-Path $bin 'harness.cmd'
  $text = ($HarnessCmd -replace "`r?`n", "`r`n") + "`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($text)
  $same = (Test-Path -LiteralPath $command -PathType Leaf) -and ([Convert]::ToBase64String([IO.File]::ReadAllBytes($command)) -eq [Convert]::ToBase64String($bytes))
  if (-not $same) {
    $temp = "$command.tmp-$PID"
    [IO.File]::WriteAllBytes($temp, $bytes)
    Move-HarnessFile -Source $temp -Destination $command
  }
  return $command
}

function Add-HarnessPath {
  # The user's PATH for every new terminal, and this session's own PATH so `harness` works in this window now.
  # Under `irm | iex` that is the person's own session. HARNESS_INSTALL_ENV_KEY (tests only) moves the registry
  # write to a throwaway key and skips the broadcast.
  param([string]$Root)
  $bin = Join-Path $Root 'bin'
  $subKey = 'Environment'
  if ($env:HARNESS_INSTALL_ENV_KEY) { $subKey = $env:HARNESS_INSTALL_ENV_KEY }
  if (Add-HarnessUserPath -Directory $bin -SubKey $subKey) {
    if (-not $env:HARNESS_INSTALL_ENV_KEY) { Send-HarnessEnvironmentChange }
    Write-Host "  OK added $bin to your PATH"
  }
  if (-not (@($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin })) { $env:Path = "$env:Path;$bin" }
}

function Register-HarnessService {
  # The task that starts Harness at sign-in and keeps it running (harness service install, sub-project B3). A
  # computer whose policy forbids user tasks still has a working Harness, so a failure here is a sentence and
  # not a failed install.
  param([string]$Command)
  & $Command service install | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Harness could not set itself to start when you sign in (harness service install exited $LASTEXITCODE)."
    Write-Host "  It still works: run 'harness start' to connect this computer."
    return
  }
  & $Command status | ForEach-Object { Write-Host "  $_" }
}

function Write-HarnessDone {
  param([string]$Version, [switch]$Desktop, [switch]$NoService)
  Write-Host ''
  if ($Desktop) { Write-Host "  harness $Version installed."; return }
  Write-Host "  OK harness $Version installed."
  Write-Host ''
  Write-Host '  Set this computer up with three commands, in this order:'
  Write-Host ''
  Write-Host '      harness login                  # 1. sign in with your Autonomous account (opens a browser)'
  Write-Host '      harness start                  # 2. connect this computer as a machine (runs in the background)'
  Write-Host '      harness remote-password set    # 3. let your OTHER machines reach this one (asked once, kept)'
  Write-Host ''
  Write-Host '  Useful:'
  Write-Host '      harness status                 # is the daemon running, and which machine this is'
  Write-Host '      harness --help                 # everything else'
  Write-Host ''
  Write-Host '  harness works in this window now. Terminals that were already open see it once they are reopened.'
}

function Install-Harness {
  # install.sh's steps, in its order. Each step is named, so a failure says which one in a sentence a first-time
  # user can act on. Nothing outside %USERPROFILE%\.harness and the user's PATH is ever changed.
  param([switch]$Desktop, [string]$Manifest, [switch]$NoService)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1 downloads many times slower with the bar drawn
  $root = Join-Path $env:USERPROFILE '.harness'
  $step = 'Checking this computer'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $tar = Test-HarnessHost
    $platform = Get-HarnessPlatform
    Write-Host "Installing Harness for $platform into $root"

    $step = 'Reading the release manifests'
    $sources = Get-HarnessManifests -Manifest $Manifest -Platform $platform

    $step = 'Installing the Node runtime'
    Install-HarnessNode -Root $root -Entry $sources.node.entry -Source $sources.node.source -Tar $tar -Platform $platform
    $step = 'Installing the Harness CLI'
    $version = Install-HarnessCli -Root $root -Entry $sources.cli.entry -Source $sources.cli.source
    # The terminal host is installed in -Desktop mode too: the daemon the app starts runs its terminals on it.
    $step = 'Installing the terminal host'
    Install-HarnessPty -Root $root -Entry $sources.pty.entry -Source $sources.pty.source -Tar $tar
    $step = 'Writing the harness command'
    $command = Write-HarnessLaunchers -Root $root
    $step = 'Adding Harness to your PATH'
    Add-HarnessPath -Root $root
    $step = 'Checking the installed CLI'
    $said = [string](@(& $command version) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $said.Trim() -ne $version) { throw "harness version answered '$said' (exit code $LASTEXITCODE), not $version." }
    if (-not $Desktop -and -not $NoService) {
      $step = 'Starting Harness when you sign in'
      Register-HarnessService -Command $command
    }
  } catch {
    Write-Host ''
    Write-Host "Harness could not be installed. The step that failed: $step." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Nothing outside $root and your PATH was changed. Run the installer again, or send this message to Harness support."
    return 1
  }
  Write-HarnessDone -Version $version -Desktop:$Desktop -NoService:$NoService
  return 0
}
```

  The guard at the bottom (`# --- Run ---`) stays as B1.7 wrote it. `Install-Harness` writes only through
  `Write-Host` and returns a single integer. The guard takes the last value (`@(...)[-1]`), so a stray pipeline
  value can never become the exit code.

- [ ] **Step 4: Run them and see them pass.**
  1. On macOS, run `cd cli && npx vitest run src/scripts/installPs1.spec.ts`. Expected: the six static cases pass.
  2. On the VM, run
     `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/scripts/installPs1.spec.ts"`.
     Expected: all 17 cases pass (19 once Step 6 adds the Review Focus cases). The profile is named
     `Jo-umlaut CJK & co`.
  3. If the first install case fails on the `harness.cmd` reads, `set /p` under `chcp 65001` did not decode the
     pointer on this build. In that case:
     - record the observed bytes in the PR;
     - switch `Write-HarnessPointer` and `writePointer` to write `current-node` in the console's OEM code page
       instead;
     - do not mark the test as skipped.

- [ ] **Step 5: Windows verification.** The VM run in Step 4 is the Windows verification. It includes the
  `irm | iex`-shaped case: the script text is piped to `Invoke-Expression` in a live session. B1.9 Step 5 then
  installs real artifacts the same way.

- [ ] **Step 6: Review Focus 2 and 3 (before this task's commit).**
  - **Arguments through `harness.cmd` reach the CLI unchanged.** cmd re-parses `%*`; a person, the desktop's
    second runner tier, or a script may pass `&`, `%`, `^`, `!`, `"` or spaces. Every caller goes through
    `cmd.exe /d /s /c`: Node refuses to spawn a `.cmd` with `shell: false` (CVE-2024-27980), and PowerShell and
    Explorer hand a `.cmd` to cmd too. If cmd mangles one of the cases below (it can for `%` and `"`), do not add
    another wrapper (any batch file re-parses `%*`): keep the case as a pinned expectation of what cmd does, list
    the characters cmd cannot carry in the B1 notes, and make sure the desktop and the daemon never call
    `harness.cmd` (they run `node.exe cli.js` directly, the runner's first tier).
  - **`irm | iex` under the default execution policy.** Windows client editions default to `Restricted`, which
    `iex` of downloaded text is not subject to, but any `.ps1` the installer dot-sources or runs would be. The case
    installs into a throwaway profile, PATH key and local build (`HARNESS_INSTALL_ENV_KEY`,
    `HARNESS_INSTALL_MANIFEST`), so it never writes the real `HKCU\Environment` or reads a published manifest, and it
    runs `harness version` by the command's full path.

  Add both cases at the end of the `describe.runIf(windows)('install.ps1, installing for real from a local
  manifest', ...)` block B1.8 appended (they use its `build`, `profile`, `install` and `platform`):

```ts
  it('passes arguments through harness.cmd as every caller does, through cmd.exe /d /s /c: unchanged', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    expect(install(home, build(platform()), subkey).status).toBe(0)
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    // Each argument quoted the way the C runtime reads it back: in double quotes, an inner `"` as `\"`.
    const quote = (arg: string) => `"${arg.replace(/"/g, '\\"')}"`
    const through = (args: string[]) =>
      spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.map(quote).join(' ')}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    // [what is passed, what the CLI receives]. A case cmd cannot carry is pinned here as what cmd does, and its
    // characters are listed in the B1 notes.
    const cases: Array<[string[], string[]]> = [
      [['a b'], ['a b']],
      [['a&b'], ['a&b']],
      [['50%'], ['50%']],
      [['x^y'], ['x^y']],
      [['wow!'], ['wow!']],
      [['say "hi"'], ['say "hi"']],
    ]
    for (const [args, expected] of cases) {
      const run = through(args)
      expect(run.status, `${JSON.stringify(args)}: ${run.stderr}`).toBe(0)
      expect(JSON.parse(run.stdout.trim()), JSON.stringify(args)).toEqual(expected)
    }
  })

  it('installs by irm | iex under the Restricted execution policy, and harness then runs from a Restricted PowerShell', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const manifest = build(platform())
    const text = `Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey, HARNESS_INSTALL_MANIFEST: manifest }, timeout: 300_000,
    })
    expect(run.stdout.trim().endsWith('after 0'), `${run.stdout}\n${run.stderr}`).toBe(true)
    // The launcher is a .cmd, never a .ps1, so a Restricted PowerShell runs it.
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    const version = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `& '${command}' version; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout.trim()).toBe('9.8.7')
  })
```

  Run `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/scripts/installPs1.spec.ts"` after
  `vm-sync.sh --cli`. Expected: all 19 cases pass. If an argument case fails, set that case's expected list to
  what came back, write its characters in the B1 notes ("characters `harness.cmd` cannot carry"), and run again.
  On macOS the file still reports the six static cases.

- [ ] **Step 7: Commit.**
  `git add cli/scripts/install.ps1 cli/src/scripts/installPs1.spec.ts`
  `git commit -m "feat(cli): install.ps1 installs Node, the CLI and the pty payload, writes harness.cmd, and sets up PATH"`

### Task B1.9: An install manifest from a local build, and the VM install from real artifacts

**Files**
- Create: `cli/scripts/windows-install-manifest.mjs`
- Create: `cli/src/scripts/windowsInstallManifest.spec.ts`

**Interfaces**
- Consumes: the `-Manifest` document format (B1.7); the payload file list `PTY_FILES`, which matches install.ps1's
  `$HarnessPtyFiles` and `publish-pty-payload.sh`'s `FILES`.
- Produces:
  - Usage: `node scripts/windows-install-manifest.mjs --out <dir> --cli-dir <dir> --pty-dir <dir> --node-zip <node-vX.Y.Z-win-<arch>.zip> --version <cli version> [--pty-version <X.Y.Z>]`.
    It writes `<out>/install-manifest.json` with `cli.js`, `notify.mjs`, the Node zip and
    `harness-pty-<v>-win32-<arch>.zip` beside it.
  - Exports `installManifest(...)`, `zipCommand(zip, dir, platform?, systemRoot?)`, `PTY_FILES`.
  - B5's Windows install job uses it to install "this build".

- [ ] **Step 1: Write the failing test.** Create `cli/src/scripts/windowsInstallManifest.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain ESM with no declaration file
const { PTY_FILES, installManifest, zipCommand } = await import('../../scripts/windows-install-manifest.mjs') as {
  PTY_FILES: string[]
  installManifest: (input: Record<string, unknown>) => Record<string, any>
  zipCommand: (zip: string, dir: string, platform?: NodeJS.Platform, systemRoot?: string) => { file: string; args: string[]; cwd?: string }
}

const script = join(process.cwd(), 'scripts', 'windows-install-manifest.mjs')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the install manifest of a local build', () => {
  it('has the three keys install.ps1 -Manifest reads, each shaped as its published manifest, naming files beside it', () => {
    const doc = installManifest({
      version: '0.3.120-dev.abc123', cli: Buffer.from('cli'), notify: Buffer.from('notify'),
      nodeZipName: 'node-v22.23.2-win-arm64.zip', nodeZip: Buffer.from('node'),
      ptyVersion: '0.3.120', ptyZipName: 'harness-pty-0.3.120-win32-arm64.zip', ptyZip: Buffer.from('pty'),
    })
    expect(doc).toEqual({
      cli: { version: '0.3.120-dev.abc123', cli: { url: 'cli.js', sha256: sha('cli'), size: 3 }, notify: { url: 'notify.mjs', sha256: sha('notify'), size: 6 } },
      node: { 'win32-arm64': { version: 'v22.23.2', url: 'node-v22.23.2-win-arm64.zip', sha256: sha('node'), size: 4, archiveRoot: 'node-v22.23.2-win-arm64' } },
      pty: { 'win32-arm64': { version: '0.3.120', url: 'harness-pty-0.3.120-win32-arm64.zip', sha256: sha('pty'), size: 3 } },
    })
  })

  it('refuses a Node archive that is not nodejs.org\'s Windows zip, and a pty version the host reader would ignore', () => {
    const base = { version: '1.2.3', cli: Buffer.from(''), notify: Buffer.from(''), nodeZip: Buffer.from(''), ptyZipName: 'p.zip', ptyZip: Buffer.from(''), ptyVersion: '1.2.3' }
    expect(() => installManifest({ ...base, nodeZipName: 'node-v22.23.2-darwin-arm64.tar.gz' })).toThrow('nodejs.org')
    expect(() => installManifest({ ...base, nodeZipName: 'node-v22.23.2-win-x64.zip', ptyVersion: '1.2.3-dev.x' })).toThrow('pty version')
  })

  it('zips with the bsdtar Windows and macOS ship, and with Python on Linux, whose GNU tar cannot', () => {
    expect(zipCommand('C:\\o\\p.zip', 'C:\\p', 'win32', 'C:\\Windows')).toEqual({ file: 'C:\\Windows\\System32\\tar.exe', args: ['-a', '-cf', 'C:\\o\\p.zip', '-C', 'C:\\p', ...PTY_FILES] })
    expect(zipCommand('/o/p.zip', '/p', 'darwin')).toEqual({ file: '/usr/bin/tar', args: ['-a', '-cf', '/o/p.zip', '-C', '/p', ...PTY_FILES] })
    expect(zipCommand('/o/p.zip', '/p', 'linux')).toEqual({ file: 'python3', args: ['-m', 'zipfile', '-c', '/o/p.zip', ...PTY_FILES], cwd: '/p' })
    expect(PTY_FILES).toEqual(['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe'])
  })

  it.skipIf(process.platform === 'linux' && spawnSync('python3', ['--version']).status !== 0)('writes the manifest and every file it names, with the digests of the bytes on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-win-manifest-'))
    dirs.push(root)
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'cli.js'), 'cli')
    writeFileSync(join(root, 'dist', 'notify.mjs'), 'notify')
    mkdirSync(join(root, 'payload'))
    for (const name of PTY_FILES) writeFileSync(join(root, 'payload', name), name)
    writeFileSync(join(root, 'node-v22.23.2-win-x64.zip'), 'node')
    const out = join(root, 'out')
    const run = spawnSync(process.execPath, [script, '--out', out, '--cli-dir', join(root, 'dist'), '--pty-dir', join(root, 'payload'), '--node-zip', join(root, 'node-v22.23.2-win-x64.zip'), '--version', '1.2.3'], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(out, 'install-manifest.json'), 'utf8'))
    for (const ref of [doc.cli.cli, doc.cli.notify, doc.node['win32-x64'], doc.pty['win32-x64']]) {
      const bytes = readFileSync(join(out, ref.url))
      expect(ref.sha256).toBe(sha(bytes))
      expect(ref.size).toBe(bytes.length)
    }
    expect(doc.pty['win32-x64'].version).toBe('1.2.3')
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/scripts/windowsInstallManifest.spec.ts`.
  Expected: it fails with `Cannot find module '.../scripts/windows-install-manifest.mjs'`.

- [ ] **Step 3: Implement.** Create `cli/scripts/windows-install-manifest.mjs`:

```js
#!/usr/bin/env node
/**
 * An install manifest for `install.ps1 -Manifest`, made from a local build. Its inputs:
 * - the CLI bundle (dist/cli.js, dist/notify.mjs);
 * - a pty payload folder (harness-pty.exe, harness-launch.exe, conpty.dll, OpenConsole.exe);
 * - nodejs.org's Windows zip, as downloaded.
 * It writes <out>/install-manifest.json and puts every file it names beside it, by relative name, so the folder can
 * be copied to a Windows computer as it is. It is used by the VM checks and by the Windows workflow's install job
 * (B5). It publishes nothing.
 *
 *   node scripts/windows-install-manifest.mjs --out <dir> --cli-dir dist --pty-dir <dir> \
 *     --node-zip node-v22.23.2-win-arm64.zip --version 0.3.120 [--pty-version 0.3.120]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

/** The payload's files, as install.ps1 ($HarnessPtyFiles) and publish-pty-payload.sh (FILES) name them. */
export const PTY_FILES = ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe']
const NODE_ZIP = /^node-(v\d+\.\d+\.\d+)-win-(x64|arm64)\.zip$/
/** What ptyHost/launch.ts currentPtyVersion accepts as a version folder. */
const PTY_VERSION = /^\d+(\.\d+)*$/

const fileRef = (name, bytes) => ({ url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })

/** The document install.ps1 -Manifest reads: the cli, node and pty keys, each shaped as its published manifest's. */
export function installManifest({ version, cli, notify, nodeZipName, nodeZip, ptyVersion, ptyZipName, ptyZip }) {
  const match = NODE_ZIP.exec(nodeZipName)
  if (!match) throw new Error(`${nodeZipName} is not nodejs.org's Windows zip (node-vX.Y.Z-win-<x64|arm64>.zip)`)
  if (!PTY_VERSION.test(ptyVersion)) throw new Error(`pty version ${ptyVersion} is not a version folder name (digits and dots)`)
  const [, nodeVersion, arch] = match
  const platform = `win32-${arch}`
  return {
    cli: { version, cli: fileRef('cli.js', cli), notify: fileRef('notify.mjs', notify) },
    node: { [platform]: { version: nodeVersion, ...fileRef(nodeZipName, nodeZip), archiveRoot: nodeZipName.slice(0, -'.zip'.length) } },
    pty: { [platform]: { version: ptyVersion, ...fileRef(ptyZipName, ptyZip) } },
  }
}

/**
 * How the payload folder becomes a zip with its files at the root. Windows and macOS use bsdtar, which writes zip
 * (`-a` picks the format from the name). Linux uses Python's zipfile, because GNU tar cannot write zip.
 */
export function zipCommand(zip, dir, platform = process.platform, systemRoot = process.env.SystemRoot) {
  if (platform === 'win32') return { file: win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args: ['-a', '-cf', zip, '-C', dir, ...PTY_FILES] }
  if (platform === 'darwin') return { file: '/usr/bin/tar', args: ['-a', '-cf', zip, '-C', dir, ...PTY_FILES] }
  return { file: 'python3', args: ['-m', 'zipfile', '-c', zip, ...PTY_FILES], cwd: dir }
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' }, 'cli-dir': { type: 'string' }, 'pty-dir': { type: 'string' },
      'node-zip': { type: 'string' }, version: { type: 'string' }, 'pty-version': { type: 'string' },
    },
  })
  for (const name of ['out', 'cli-dir', 'pty-dir', 'node-zip', 'version']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  const { out, version } = values
  const ptyVersion = values['pty-version'] ?? /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? version
  const nodeZipName = basename(values['node-zip'])
  const arch = NODE_ZIP.exec(nodeZipName)?.[2]
  if (!arch) throw new Error(`${nodeZipName} is not nodejs.org's Windows zip (node-vX.Y.Z-win-<x64|arm64>.zip)`)
  const ptyZipName = `harness-pty-${ptyVersion}-win32-${arch}.zip`
  mkdirSync(out, { recursive: true })
  copyFileSync(join(values['cli-dir'], 'cli.js'), join(out, 'cli.js'))
  copyFileSync(join(values['cli-dir'], 'notify.mjs'), join(out, 'notify.mjs'))
  copyFileSync(values['node-zip'], join(out, nodeZipName))
  const zip = zipCommand(join(out, ptyZipName), values['pty-dir'])
  execFileSync(zip.file, zip.args, { cwd: zip.cwd, stdio: 'inherit' })
  const doc = installManifest({
    version,
    cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')),
    nodeZipName, nodeZip: readFileSync(join(out, nodeZipName)),
    ptyVersion, ptyZipName, ptyZip: readFileSync(join(out, ptyZipName)),
  })
  writeFileSync(join(out, 'install-manifest.json'), JSON.stringify(doc, null, 2) + '\n')
  console.log(join(out, 'install-manifest.json'))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main() } catch (error) { console.error(`error: ${error.message}`); process.exit(1) }
}
```

  `zipCommand` on Linux runs Python with `cwd` = the payload folder, but the zip path it is given is absolute
  (`join(out, …)`), so the output lands in `out`.

- [ ] **Step 4: Run it and see it pass.** Run `cd cli && npx vitest run src/scripts/windowsInstallManifest.spec.ts`.
  Expected: all four cases pass on macOS.

- [ ] **Step 5: Windows verification. A real install from real artifacts on the VM, in scratch profiles.**

```bash
# On the Mac: sync the tree, bundle the CLI from it, and copy the bundle to the VM.
cli/scripts/windows-pty-e2e/vm-sync.sh --cli
(cd cli && . scripts/lib/build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" npm run bundle)
VERSION="$(node cli/dist/cli.js version)"
CORE="$(printf '%s' "$VERSION" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
ssh admin@192.168.65.3 "(if not exist C:\work\b1\dist mkdir C:\work\b1\dist) & (if not exist C:\work\b1\payload mkdir C:\work\b1\payload)"
tar -cf - -C cli/dist cli.js notify.mjs | ssh admin@192.168.65.3 "tar -xf - -C C:/work/b1/dist"
# On the VM: build both binaries stamped with the version core, and gather the payload.
ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && set HARNESS_PTY_VERSION=$CORE&& cargo build --locked --release && copy /y target\release\harness-pty.exe C:\work\b1\payload && copy /y target\release\harness-launch.exe C:\work\b1\payload && copy /y target\release\harness.exe C:\work\b1\payload && copy /y vendor\conpty\arm64\conpty.dll C:\work\b1\payload && copy /y vendor\conpty\arm64\OpenConsole.exe C:\work\b1\payload"
# Fetch Node's official zip and check it against nodejs.org's SHASUMS256.txt for v22.23.2.
ssh admin@192.168.65.3 "curl.exe -fsSLo C:\work\b1\node-v22.23.2-win-arm64.zip https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-arm64.zip && certutil -hashfile C:\work\b1\node-v22.23.2-win-arm64.zip SHA256"
# expect: fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3
ssh admin@192.168.65.3 "node C:\work\oh\cli\scripts\windows-install-manifest.mjs --out C:\work\b1\manifest --cli-dir C:\work\b1\dist --pty-dir C:\work\b1\payload --node-zip C:\work\b1\node-v22.23.2-win-arm64.zip --version $VERSION"
# 1. As a file, in a fresh profile, with a throwaway PATH key, so the admin account's own setup is untouched.
ssh admin@192.168.65.3 "set USERPROFILE=C:\work\b1\profile&& set HARNESS_INSTALL_ENV_KEY=Software\HarnessB1Check&& powershell -NoProfile -ExecutionPolicy Bypass -File C:\work\oh\cli\scripts\install.ps1 -Manifest C:\work\b1\manifest\install-manifest.json -NoService"
ssh admin@192.168.65.3 "set USERPROFILE=C:\work\b1\profile&& C:\work\b1\profile\.harness\bin\harness.exe version && type C:\work\b1\profile\.harness\runtime\pty\current-pty && C:\work\b1\profile\.harness\runtime\pty\\$CORE\\harness-pty.exe version"
# 2. The way a person runs it: the script text through Invoke-Expression, its manifest from the environment.
ssh admin@192.168.65.3 "set USERPROFILE=C:\work\b1\profile-iex&& set HARNESS_INSTALL_ENV_KEY=Software\HarnessB1Check&& set HARNESS_INSTALL_MANIFEST=C:\work\b1\manifest\install-manifest.json&& powershell -NoProfile -Command \"Get-Content -Raw C:\work\oh\cli\scripts\install.ps1 | Invoke-Expression; Write-Output done\""
ssh admin@192.168.65.3 "reg delete HKCU\Software\HarnessB1Check /f"
```

  Expected:
  - both installs print the guide;
  - the first exits 0, and the second ends with `done`, because the session was not closed;
  - `harness.exe version` prints `$VERSION`;
  - `current-pty` holds `$CORE`;
  - the installed `harness-pty.exe version` prints `{"version":"<CORE>","protocol":2}`.

  Record the outputs in the PR.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/windows-install-manifest.mjs cli/src/scripts/windowsInstallManifest.spec.ts`
  `git commit -m "feat(cli): an install manifest from a local Windows build, for install.ps1 -Manifest"`

### Task B1.10: Runtime manifest merging, and publishing the pty payload to staging

**Files**
- Create: `cli/scripts/lib/runtimeManifest.mjs`
- Create: `cli/scripts/publish-pty-payload.sh`
- Create: `cli/src/scripts/runtimeManifest.spec.ts`
- Create: `cli/src/scripts/publishPtyPayload.spec.ts`

**Interfaces**
- Produces:
  - `runtimeManifest.mjs`:
    - exports `readDocument(path)`, `runtimeEntry({version,url,sha256,size,archiveRoot?})`,
      `mergePlatforms(document, name, entries)` and `mergeKey(document, key, value)`;
    - command lines `entry <file> <platform> <version> <url> <sha256> <size> [archiveRoot]`,
      `platforms <src> <dst> <name> <entries.json>` and `key <src> <dst> <key> <value.json>`.
  - `publish-pty-payload.sh <X.Y.Z> <win32-x64 dir> <win32-arm64 dir>`:
    - uploads `harness/pty/<v>/harness-pty-<v>-win32-<arch>.zip`, which is immutable;
    - merges `{ "pty": { "win32-x64": {version,url,sha256,size}, "win32-arm64": … } }` into `$METADATA_PATH`
      (default `harness/staging/pty/metadata.json`);
    - with `DRY_RUN=1` and `DRY_RUN_OUT=<dir>` it writes the zips and `metadata.json` there and touches no bucket.

- [ ] **Step 1: Write the failing tests.** Create `cli/src/scripts/runtimeManifest.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain ESM with no declaration file
const { mergeKey, mergePlatforms, runtimeEntry } = await import('../../scripts/lib/runtimeManifest.mjs') as {
  mergeKey: (doc: object, key: string, value: object) => Record<string, any>
  mergePlatforms: (doc: object, name: string, entries: object) => Record<string, any>
  runtimeEntry: (entry: Record<string, unknown>) => Record<string, unknown>
}

const script = join(process.cwd(), 'scripts', 'lib', 'runtimeManifest.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha = 'a'.repeat(64)

describe('the runtime manifests the publish scripts write', () => {
  it('replaces only the platforms a publish ships: the Mac\'s Node keys survive a Windows publish', () => {
    const before = { node: { 'darwin-arm64': { version: 'v22.23.2' }, 'win32-x64': { version: 'v22.0.0' } }, other: { kept: true } }
    const after = mergePlatforms(before, 'node', { 'win32-x64': { version: 'v22.23.2' }, 'win32-arm64': { version: 'v22.23.2' } })
    expect(after).toEqual({ node: { 'darwin-arm64': { version: 'v22.23.2' }, 'win32-x64': { version: 'v22.23.2' }, 'win32-arm64': { version: 'v22.23.2' } }, other: { kept: true } })
    expect(before.node['win32-x64'].version).toBe('v22.0.0')
    expect(mergePlatforms({ node: 'garbage' }, 'node', { 'win32-x64': {} })).toEqual({ node: { 'win32-x64': {} } })
  })

  it('replaces one top-level key whole, as the staging CLI manifest takes the released `cli` entry', () => {
    expect(mergeKey({ cli: { version: '1' }, commander: { version: 'c' } }, 'cli', { version: '2' })).toEqual({ cli: { version: '2' }, commander: { version: 'c' } })
  })

  it('accepts only an entry a daemon or the installer would trust', () => {
    const good = { version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: '10' }
    expect(runtimeEntry(good)).toEqual({ version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: 10 })
    expect(runtimeEntry({ ...good, archiveRoot: 'node-v1' })).toMatchObject({ archiveRoot: 'node-v1' })
    expect(() => runtimeEntry({ ...good, url: 'http://cdn.example/a.zip' })).toThrow('https')
    expect(() => runtimeEntry({ ...good, sha256: 'ABC' })).toThrow('sha256')
    expect(() => runtimeEntry({ ...good, size: '0' })).toThrow('size')
    expect(() => runtimeEntry({ ...good, version: '' })).toThrow('version')
  })

  it('does the same from the command line the shell scripts use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-runtime-manifest-'))
    dirs.push(dir)
    const entries = join(dir, 'entries.json')
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    expect(run('entry', entries, 'win32-x64', '1.2.3', 'https://cdn.example/a.zip', sha, '10').status).toBe(0)
    writeFileSync(join(dir, 'src.json'), JSON.stringify({ pty: { 'win32-arm64': { version: '1.2.2' } } }))
    expect(run('platforms', join(dir, 'src.json'), join(dir, 'dst.json'), 'pty', entries).status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'dst.json'), 'utf8'))).toEqual({
      pty: { 'win32-arm64': { version: '1.2.2' }, 'win32-x64': { version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: 10 } },
    })
    // A missing source is an empty manifest: the first publish to a new prefix.
    expect(run('platforms', join(dir, 'missing.json'), join(dir, 'fresh.json'), 'pty', entries).status).toBe(0)
    const bad = run('entry', entries, 'win32-x64', '1.2.3', 'http://plain', sha, '10')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('https')
  })
})
```

  Create `cli/src/scripts/publishPtyPayload.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'publish-pty-payload.sh')
const FILES = ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe']
const hasPython = spawnSync('python3', ['--version']).status === 0
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function payloads(missing?: string) {
  const root = mkdtempSync(join(tmpdir(), 'harness-pty-publish-'))
  dirs.push(root)
  for (const arch of ['x64', 'arm64']) {
    mkdirSync(join(root, arch))
    for (const name of FILES) if (!(arch === 'arm64' && name === missing)) writeFileSync(join(root, arch, name), `${arch}:${name}`)
  }
  return root
}

const run = (root: string, args: string[]) => spawnSync('bash', [script, ...args], {
  encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out'), METADATA_PATH: 'harness/staging/pty/metadata.json', GCS_BUCKET: 's3-autonomous-upgrade-3', CDN_ASSET_BASE_URL: 'https://cdn.autonomous.ai' },
})

describe.skipIf(process.platform === 'win32' || !hasPython)('publish-pty-payload.sh, as a dry run', () => {
  it('zips each architecture\'s four files at the root, and writes the pty key with their digests', () => {
    const root = payloads()
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')])
    expect(result.status, result.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    for (const key of ['win32-x64', 'win32-arm64']) {
      const zip = `harness-pty-1.2.3-${key}.zip`
      const bytes = readFileSync(join(root, 'out', zip))
      expect(doc.pty[key]).toEqual({ version: '1.2.3', url: `https://cdn.autonomous.ai/harness/pty/1.2.3/${zip}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
      const listing = spawnSync('python3', ['-m', 'zipfile', '-l', join(root, 'out', zip)], { encoding: 'utf8' }).stdout
      for (const name of FILES) expect(listing).toMatch(new RegExp(`^${name.replace('.', '\\.')}\\s`, 'm'))
    }
  })

  it('refuses a payload missing a file, and a version that is not a release', () => {
    const root = payloads('OpenConsole.exe')
    const missing = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('has no OpenConsole.exe')
    expect(run(payloads(), ['1.2.3-dev.x', 'a', 'b']).status).toBe(2)
  })
})
```

- [ ] **Step 2: Run them and see them fail.**
  Run `cd cli && npx vitest run src/scripts/runtimeManifest.spec.ts src/scripts/publishPtyPayload.spec.ts`.
  Expected: the first file fails to import `runtimeManifest.mjs`. In the second, `bash` exits 127 with
  `No such file or directory`.

- [ ] **Step 3: Implement.** Create `cli/scripts/lib/runtimeManifest.mjs`:

```js
#!/usr/bin/env node
/**
 * The shape every runtime manifest shares: `{ <name>: { <platform>: { version, url, sha256, size[, archiveRoot] } } }`
 * (runtimeInstall.ts artifactFor, install.ps1 Get-HarnessManifests). The publish scripts write it through one merge,
 * so a publish replaces only the platforms it ships, and every other platform and key stays: the Windows Node
 * publish must not touch the Mac's keys.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A manifest from disk. A missing, empty or malformed one is `{}`: the first publish to a new prefix. */
export function readDocument(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const value = raw.trim() ? JSON.parse(raw) : {}
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

/** One platform's entry, checked against what its readers trust: https only, a hex sha256, a real size. */
export function runtimeEntry({ version, url, sha256, size, archiveRoot }) {
  if (!version) throw new Error('an entry needs a version')
  if (!/^https:\/\//.test(String(url))) throw new Error(`an entry's url must be https: ${url}`)
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error(`an entry's sha256 must be 64 lowercase hex digits: ${sha256}`)
  const bytes = Number(size)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`an entry's size must be a positive number of bytes: ${size}`)
  const entry = { version: String(version), url: String(url), sha256: String(sha256), size: bytes }
  return archiveRoot ? { ...entry, archiveRoot: String(archiveRoot) } : entry
}

export function mergePlatforms(document, name, entries) {
  return { ...document, [name]: { ...(isObject(document[name]) ? document[name] : {}), ...entries } }
}

export function mergeKey(document, key, value) {
  return { ...document, [key]: value }
}

const write = (path, document) => writeFileSync(path, JSON.stringify(document, null, 2) + '\n')

function main([command, ...rest]) {
  if (command === 'entry') {
    const [file, platform, version, url, sha256, size, archiveRoot] = rest
    const document = readDocument(file)
    document[platform] = runtimeEntry({ version, url, sha256, size, archiveRoot })
    return write(file, document)
  }
  if (command === 'platforms') {
    const [src, dst, name, entriesFile] = rest
    return write(dst, mergePlatforms(readDocument(src), name, JSON.parse(readFileSync(entriesFile, 'utf8'))))
  }
  if (command === 'key') {
    const [src, dst, key, valueFile] = rest
    const value = JSON.parse(readFileSync(valueFile, 'utf8'))
    if (!isObject(value)) throw new Error(`${valueFile} does not hold an object`)
    return write(dst, mergeKey(readDocument(src), key, value))
  }
  throw new Error('usage: runtimeManifest.mjs entry <file> <platform> <version> <url> <sha256> <size> [archiveRoot] | platforms <src> <dst> <name> <entries.json> | key <src> <dst> <key> <value.json>')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`error: ${error.message}`); process.exit(1) }
}
```

  Create `cli/scripts/publish-pty-payload.sh` (then `chmod +x` it):

```bash
#!/usr/bin/env bash
# Publish the Windows pty payload that install.ps1 lays down in %USERPROFILE%\.harness\runtime\pty\<version>\.
# The payload is harness-pty.exe, harness-launch.exe and the ConPTY pair (conpty.dll, OpenConsole.exe). This script
# publishes:
#   - one zip per architecture, files at its root, under harness/pty/<version>/. These are immutable, like every
#     versioned artifact here: the CDN keeps the first bytes it saw.
#   - the `pty` key of a manifest. That is STAGING by default (harness/staging/pty/metadata.json), which the
#     staging install.ps1 reads.
# The production manifest (harness/pty/metadata.json) is the owner's step, once the staging E2E passes:
#   METADATA_PATH=harness/pty/metadata.json bash cli/scripts/publish-pty-payload.sh <version> <x64 dir> <arm64 dir>
# DRY_RUN=1 DRY_RUN_OUT=<dir> builds and checks the zips, writes them and the manifest into <dir>, and touches no bucket.
set -euo pipefail

VERSION="${1:-}"
X64_DIR="${2:-}"
ARM64_DIR="${3:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$X64_DIR" ] || [ -z "$ARM64_DIR" ]; then
  echo "usage: $0 <X.Y.Z> <win32-x64 payload dir> <win32-arm64 payload dir>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
METADATA_PATH="${METADATA_PATH:-harness/staging/pty/metadata.json}"
DRY_RUN="${DRY_RUN:-0}"
[[ "$METADATA_PATH" =~ ^harness/[a-z0-9/_.-]+\.json$ ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a manifest under harness/" >&2; exit 2; }
# The payload, as install.ps1 ($HarnessPtyFiles) checks it.
FILES=(harness-pty.exe harness-launch.exe conpty.dll OpenConsole.exe)

for command in node python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '{}' > "$WORK/entries.json"

for pair in "win32-x64=$X64_DIR" "win32-arm64=$ARM64_DIR"; do
  key="${pair%%=*}"
  dir="${pair#*=}"
  for file in "${FILES[@]}"; do
    [ -f "$dir/$file" ] || { echo "error: the $key payload in $dir has no $file" >&2; exit 1; }
  done
  zip="harness-pty-${VERSION}-${key}.zip"
  # Python's zipfile: the files at the zip's root, whatever OS this runs on (GNU tar cannot write zip).
  ( cd "$dir" && python3 -m zipfile -c "$WORK/$zip" "${FILES[@]}" )
  object="harness/pty/${VERSION}/${zip}"
  url="${CDN_ASSET_BASE_URL%/}/${object}"
  sha="$(sha256_of "$WORK/$zip")"
  size="$(wc -c < "$WORK/$zip" | tr -d ' ')"
  if [ "$DRY_RUN" != 1 ]; then
    if gcloud storage ls "gs://${GCS_BUCKET}/${object}" >/dev/null 2>&1; then
      echo "error: gs://${GCS_BUCKET}/${object} already exists. Versioned artifacts are immutable (the CDN keeps the first bytes); release a new version." >&2
      exit 1
    fi
    echo ">> uploading $zip ($size bytes)"
    gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$WORK/$zip" "gs://${GCS_BUCKET}/${object}"
  fi
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "$key" "$VERSION" "$url" "$sha" "$size"
done

if [ "$DRY_RUN" = 1 ]; then
  printf '{}' > "$WORK/metadata.json"
elif ! gcloud storage cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" 2>/dev/null; then
  echo "   (no existing ${METADATA_PATH}: creating it)"
  printf '{}' > "$WORK/metadata.json"
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" pty "$WORK/entries.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the zips and the manifest}"
  mkdir -p "$out"
  cp "$WORK"/harness-pty-*.zip "$out/"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: zips and manifest in $out"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published the pty payload $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
```

- [ ] **Step 4: Run them and see them pass.**
  Run `cd cli && chmod +x scripts/publish-pty-payload.sh && npx vitest run src/scripts/runtimeManifest.spec.ts src/scripts/publishPtyPayload.spec.ts && bash -n scripts/publish-pty-payload.sh`.
  Expected: all cases pass, and `bash -n` is silent.

- [ ] **Step 5: Windows verification.** Nothing here runs on Windows. B1.13's workflow run gives the real-bucket
  check: the staging manifest it writes is downloaded and each zip's digest is checked.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/lib/runtimeManifest.mjs cli/scripts/publish-pty-payload.sh cli/src/scripts/runtimeManifest.spec.ts cli/src/scripts/publishPtyPayload.spec.ts`
  `git commit -m "feat(cli): publish the Windows pty payload to a staging manifest; one merge for every runtime manifest"`

### Task B1.11: Node for Windows, republished after a signature check

**Files**
- Create: `cli/scripts/publish-node-runtime-windows.sh`
- Create: `cli/src/scripts/publishNodeRuntimeWindows.spec.ts`
- Create: `.github/workflows/release-node-runtime-windows.yml`

**Interfaces**
- Consumes: `runtimeManifest.mjs` (B1.10).
- Produces:
  - `publish-node-runtime-windows.sh <node X.Y.Z>`, which does three things:
    - checks `SHASUMS256.txt` against `SHASUMS256.txt.sig` with `gpgv`, using the Node release keyring pinned by
      commit and sha256;
    - checks each `node-v<v>-win-<arch>.zip` against the signed list;
    - uploads them to `harness/runtime/node/v<v>/` and merges `node.win32-x64` and `node.win32-arm64`
      (`archiveRoot: node-v<v>-win-<arch>`) into `$METADATA_PATH` (default `harness/staging/runtime/metadata.json`).
  - Overrides for tests: `NODE_DIST_BASE`, `NODE_RELEASE_KEYRING_URL`, `NODE_RELEASE_KEYRING_SHA256`, `DRY_RUN=1`,
    `DRY_RUN_OUT`.
  - The workflow `Node runtime for Windows` (workflow_dispatch: `node_version`, `metadata_path`).

- [ ] **Step 1: Write the failing test.** Create `cli/src/scripts/publishNodeRuntimeWindows.spec.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The real script against a fake nodejs.org (file://) and a fake gpgv. What is checked is what the script does
// with their answers. gpgv's own verification is gpg's, run for real by the workflow (Step 5).
const script = join(process.cwd(), 'scripts', 'publish-node-runtime-windows.sh')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(options: { signed?: boolean; tamper?: boolean; keyringSha?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-node-win-'))
  dirs.push(root)
  const dist = join(root, 'dist', 'v22.0.0')
  mkdirSync(dist, { recursive: true })
  const lines = ['x64', 'arm64'].map((arch) => {
    const name = `node-v22.0.0-win-${arch}.zip`
    writeFileSync(join(dist, name), `zip ${arch}`)
    return `${sha(options.tamper && arch === 'arm64' ? 'other bytes' : `zip ${arch}`)}  ${name}`
  })
  writeFileSync(join(dist, 'SHASUMS256.txt'), lines.join('\n') + '\n')
  writeFileSync(join(dist, 'SHASUMS256.txt.sig'), 'signature')
  writeFileSync(join(root, 'pubring.kbx'), 'keyring')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gpgv'), `#!/bin/sh\necho "$@" > "${join(root, 'gpgv-args')}"\nexit ${options.signed === false ? 1 : 0}\n`)
  chmodSync(join(bin, 'gpgv'), 0o755)
  const result = spawnSync('bash', [script, '22.0.0'], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out'),
      NODE_DIST_BASE: `file://${join(root, 'dist')}`, NODE_RELEASE_KEYRING_URL: `file://${join(root, 'pubring.kbx')}`,
      NODE_RELEASE_KEYRING_SHA256: options.keyringSha ?? sha('keyring'), METADATA_PATH: 'harness/staging/runtime/metadata.json',
      GCS_BUCKET: 's3-autonomous-upgrade-3', GCS_PUBLIC_BASE_URL: 'https://storage.googleapis.com/s3-autonomous-upgrade-3',
    },
  })
  return { root, result }
}

describe.skipIf(process.platform === 'win32')('publish-node-runtime-windows.sh, as a dry run', () => {
  it('publishes both Windows zips under the runtime manifest\'s win32 keys, with nodejs.org\'s archive root', () => {
    const { root, result } = fixture()
    expect(result.status, result.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    for (const arch of ['x64', 'arm64']) {
      expect(doc.node[`win32-${arch}`]).toEqual({
        version: 'v22.0.0',
        url: `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/runtime/node/v22.0.0/node-v22.0.0-win-${arch}.zip`,
        sha256: sha(`zip ${arch}`), size: `zip ${arch}`.length, archiveRoot: `node-v22.0.0-win-${arch}`,
      })
    }
    // gpgv checks the list against the pinned keyring: the detached signature, then the signed file.
    expect(readFileSync(join(root, 'gpgv-args'), 'utf8').trim()).toMatch(/^--keyring \S+\/pubring\.kbx \S+\/SHASUMS256\.txt\.sig \S+\/SHASUMS256\.txt$/)
  })

  it('refuses a checksum list whose signature does not verify', () => {
    const { result } = fixture({ signed: false })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not carry a valid signature from a Node release key')
  })

  it('refuses a zip that does not match the signed list', () => {
    const { result } = fixture({ tamper: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node-v22.0.0-win-arm64.zip does not match the signed SHASUMS256.txt')
  })

  it('refuses a keyring that is not the pinned one', () => {
    const { result } = fixture({ keyringSha: 'b'.repeat(64) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match its pinned sha256')
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/scripts/publishNodeRuntimeWindows.spec.ts`.
  Expected: each case fails. `bash` exits 127 (`No such file or directory`), and `metadata.json` cannot be read.

- [ ] **Step 3: Implement.** Create `cli/scripts/publish-node-runtime-windows.sh` (then `chmod +x` it):

```bash
#!/usr/bin/env bash
# Republish nodejs.org's Windows Node (node-v<version>-win-<arch>.zip) under the managed-runtime manifest's
# win32-x64 and win32-arm64 keys. install.ps1 and the CLI's ensureManagedRuntime read those keys. The macOS and
# Linux half is desktop/scripts/publish-managed-node-runtime.sh.
#
# This script also checks the signature on SHASUMS256.txt, using the Node release keyring pinned below by commit
# and digest. A tampered checksum list therefore cannot vouch for a tampered zip.
#
# It publishes to STAGING by default (harness/staging/runtime/metadata.json). Production is
# harness/runtime/metadata.json, which every installer and daemon reads, and publishing there is the owner's step:
#   METADATA_PATH=harness/runtime/metadata.json bash cli/scripts/publish-node-runtime-windows.sh 22.23.2
# The merge keeps every other key, the Mac's included.
# DRY_RUN=1 DRY_RUN_OUT=<dir> downloads and verifies, writes the manifest into <dir>, and touches no bucket.
set -euo pipefail
set +x

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <Node version, e.g. 22.23.2>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
PUBLIC_BASE="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/staging/runtime/metadata.json}"
NODE_DIST_BASE="${NODE_DIST_BASE:-https://nodejs.org/dist}"
# The pinned keyring is nodejs/release-keys at 481637f8 (2026-09-01): the active release keys as a gpg keyring.
# Moving the pin is a reviewed change, and both lines move together.
KEYRING_URL="${NODE_RELEASE_KEYRING_URL:-https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx}"
KEYRING_SHA256="${NODE_RELEASE_KEYRING_SHA256:-140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932}"
DRY_RUN="${DRY_RUN:-0}"
[[ "$METADATA_PATH" =~ ^harness/[a-z0-9/_.-]+\.json$ ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a manifest under harness/" >&2; exit 2; }

for command in curl gpgv node; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "$KEYRING_URL" -o "$WORK/pubring.kbx"
[ "$(sha256_of "$WORK/pubring.kbx")" = "$KEYRING_SHA256" ] || {
  echo "error: the Node release keyring at $KEYRING_URL does not match its pinned sha256" >&2
  exit 1
}
base="${NODE_DIST_BASE%/}/v${VERSION}"
curl -fsSL "$base/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
curl -fsSL "$base/SHASUMS256.txt.sig" -o "$WORK/SHASUMS256.txt.sig"
if ! gpgv --keyring "$WORK/pubring.kbx" "$WORK/SHASUMS256.txt.sig" "$WORK/SHASUMS256.txt" 2>"$WORK/gpgv.log"; then
  cat "$WORK/gpgv.log" >&2
  echo "error: SHASUMS256.txt for Node v$VERSION does not carry a valid signature from a Node release key" >&2
  exit 1
fi

printf '{}' > "$WORK/entries.json"
for arch in x64 arm64; do
  archive="node-v${VERSION}-win-${arch}.zip"
  curl -fsSL "$base/$archive" -o "$WORK/$archive"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$WORK/SHASUMS256.txt")"
  actual="$(sha256_of "$WORK/$archive")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo "error: the signed SHASUMS256.txt has no checksum for $archive" >&2; exit 1; }
  [ "$actual" = "$expected" ] || { echo "error: $archive does not match the signed SHASUMS256.txt" >&2; exit 1; }
  object="harness/runtime/node/v${VERSION}/${archive}"
  url="${PUBLIC_BASE%/}/${object}"
  size="$(wc -c < "$WORK/$archive" | tr -d ' ')"
  if [ "$DRY_RUN" != 1 ]; then
    if gcloud storage ls "gs://${GCS_BUCKET}/${object}" >/dev/null 2>&1; then
      # The same nodejs.org bytes may already be there from an earlier run. Different bytes never replace them.
      gcloud storage cp "gs://${GCS_BUCKET}/${object}" "$WORK/published.zip" >/dev/null 2>&1
      [ "$(sha256_of "$WORK/published.zip")" = "$actual" ] || {
        echo "error: gs://${GCS_BUCKET}/${object} exists with other bytes; versioned objects are immutable" >&2
        exit 1
      }
      echo ">> $archive is already published with these bytes"
    else
      echo ">> uploading $archive ($size bytes)"
      gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$WORK/$archive" "gs://${GCS_BUCKET}/${object}"
    fi
  fi
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "win32-$arch" "v$VERSION" "$url" "$actual" "$size" "node-v${VERSION}-win-${arch}"
done

if [ "$DRY_RUN" = 1 ]; then
  printf '{}' > "$WORK/metadata.json"
elif ! gcloud storage cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" 2>/dev/null; then
  echo "   (no existing ${METADATA_PATH}: creating it)"
  printf '{}' > "$WORK/metadata.json"
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" node "$WORK/entries.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the manifest}"
  mkdir -p "$out"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: manifest in $out/metadata.json"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published Node v${VERSION} for Windows to ${PUBLIC_BASE%/}/${METADATA_PATH}"
```

  Create `.github/workflows/release-node-runtime-windows.yml`:

```yaml
name: Node runtime for Windows

# Republish nodejs.org's Windows Node at the version the Mac runtime uses, after checking the signature on its
# SHASUMS256.txt (cli/scripts/publish-node-runtime-windows.sh). By hand, when the Node pin moves. The Mac pin is
# release.yml's and ci.yml's node-version. STAGING by default: production (harness/runtime/metadata.json) is the
# owner's step, once the staging E2E (docs/testing/windows-cli-e2e.md) has passed.

on:
  workflow_dispatch:
    inputs:
      node_version:
        description: 'Node version (X.Y.Z), the one the Mac runtime uses'
        required: true
        default: '22.23.2'
      metadata_path:
        description: 'Manifest to merge the win32 keys into. Staging unless the owner promotes.'
        required: true
        default: harness/staging/runtime/metadata.json

permissions:
  contents: read
  id-token: write   # the OIDC token the auth step exchanges, as in release.yml

concurrency:
  group: node-runtime-windows
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      GCS_BUCKET: s3-autonomous-upgrade-3
      NODE_VERSION: ${{ inputs.node_version }}
      METADATA_PATH: ${{ inputs.metadata_path }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22.23.2
      - name: Check the inputs
        run: |
          set -euo pipefail
          [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::node_version must be X.Y.Z"; exit 1; }
          [[ "$METADATA_PATH" =~ ^harness/[a-z0-9/_.-]+\.json$ ]] || { echo "::error::metadata_path must be a manifest under harness/"; exit 1; }
          command -v gpgv
      - name: Authenticate to GCP (workload identity federation)
        uses: google-github-actions/auth@c200f3691d83b41bf9bbd8638997a462592937ed # v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - uses: google-github-actions/setup-gcloud@e427ad8a34f8676edf47cf7d7925499adf3eb74f # v2
      - name: Verify and publish
        run: bash cli/scripts/publish-node-runtime-windows.sh "$NODE_VERSION"
      - name: Read back what an installer would read
        run: |
          set -euo pipefail
          curl -fsSL "https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}" -o manifest.json
          node -e '
            const fs = require("node:fs"), crypto = require("node:crypto")
            const main = async () => {
              const node = JSON.parse(fs.readFileSync("manifest.json", "utf8")).node || {}
              for (const key of ["win32-x64", "win32-arm64"]) {
                const entry = node[key]
                if (!entry || entry.version !== `v${process.env.NODE_VERSION}`) throw new Error(`${key}: ${JSON.stringify(entry)}`)
                const bytes = Buffer.from(await (await fetch(entry.url, { cache: "no-store" })).arrayBuffer())
                if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || bytes.length !== entry.size) throw new Error(`${key}: served bytes differ`)
                console.log(`  ${key}: ${entry.url} ok`)
              }
            }
            main().catch((error) => { console.error(`::error::${error.message}`); process.exit(1) })
          '
```

- [ ] **Step 4: Run it and see it pass.**
  Run `cd cli && chmod +x scripts/publish-node-runtime-windows.sh && npx vitest run src/scripts/publishNodeRuntimeWindows.spec.ts && bash -n scripts/publish-node-runtime-windows.sh`.
  Expected: all four cases pass. Also run `actionlint .github/workflows/release-node-runtime-windows.yml` if
  actionlint is installed (CI's process checks run it). Expected: clean.

- [ ] **Step 5: Windows and real-signature verification.**
  1. Start the workflow once with the defaults (`22.23.2`, staging): `gh workflow run "Node runtime for Windows" --ref <branch>`,
     then `gh run watch`. That run checks the real nodejs.org signature with the pinned keyring.
  2. Expected: green. The read-back step prints both `ok` lines. The staging manifest's `win32-arm64.sha256` is
     `fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3`, and `win32-x64.sha256` is
     `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` (nodejs.org's SHASUMS256.txt for v22.23.2).
  3. Report the run link in the PR.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/publish-node-runtime-windows.sh cli/src/scripts/publishNodeRuntimeWindows.spec.ts .github/workflows/release-node-runtime-windows.yml`
  `git commit -m "feat(cli): republish nodejs.org's Windows Node to staging after checking SHASUMS256's signature"`

### Task B1.12: Publishing `install.ps1` (staging by default)

**Files**
- Create: `cli/scripts/upload-install-ps1.sh`
- Create: `cli/src/scripts/uploadInstallPs1.spec.ts`
- Modify: `Makefile`, line 7 (`.PHONY`), and a new target after line 78 (`upload-cli-install-sh`'s recipe)

**Interfaces**
- Consumes: install.ps1's single `$HarnessManifestBase = '…'` line (B1.7).
- Produces:
  - `upload-install-ps1.sh [--production] [--print]`, with env `STAGING_PREFIX` (default `harness/staging`).
  - Staging uploads `<prefix>/cli/install.ps1` with the base rewritten to
    `https://storage.googleapis.com/<bucket>/<prefix>/`. That makes the E2E's install
    `irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex`.
  - `--production` uploads `harness/cli/install.ps1` unchanged. That is the owner step.
  - `make upload-cli-install-ps1 ARGS=…`.

- [ ] **Step 1: Write the failing test.** Create `cli/src/scripts/uploadInstallPs1.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'upload-install-ps1.sh')
const source = readFileSync(join(process.cwd(), 'scripts', 'install.ps1'), 'utf8')
const PRODUCTION = "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"

function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  delete base.GCS_BUCKET
  delete base.STAGING_PREFIX
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...base, ...env } })
}

/** The lines that differ between the source and what would be uploaded. */
const changed = (output: string) => {
  const before = source.split('\n')
  const after = output.split('\n')
  expect(after).toHaveLength(before.length)
  return before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]))
}

describe.skipIf(process.platform === 'win32')('upload-install-ps1.sh', () => {
  it('stages a copy that differs in one line only: the manifest base, moved under harness/staging/', () => {
    const result = run(['--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(changed(result.stdout)).toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/'"]])
  })

  it('publishes the file exactly as it is for production', () => {
    const result = run(['--production', '--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(source)
  })

  it('honours another staging prefix under harness/, and refuses anything else', () => {
    expect(changed(run(['--print'], { STAGING_PREFIX: 'harness/staging-dry-run' }).stdout))
      .toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging-dry-run/'"]])
    expect(run(['--print'], { STAGING_PREFIX: '../elsewhere' }).status).toBe(2)
    expect(run(['--bogus']).status).toBe(2)
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/scripts/uploadInstallPs1.spec.ts`.
  Expected: the status is 127, with `No such file or directory`.

- [ ] **Step 3: Implement.** Create `cli/scripts/upload-install-ps1.sh` (then `chmod +x` it):

```bash
#!/usr/bin/env bash
# Publish cli/scripts/install.ps1, the Windows installer (`irm ... | iex`), beside install.sh.
#
# STAGING by default: <prefix>/cli/install.ps1, with its manifest base rewritten to .../<prefix>/. The staging
# copy then installs the staging build:
#   irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex
# --production publishes harness/cli/install.ps1 exactly as it is. That is the owner's step, once the staging E2E
# (docs/testing/windows-cli-e2e.md) has passed. --print writes what would be uploaded to stdout and uploads nothing.
# Cache headers are upload-install-sh.sh's, for its reason: Cloudflare honours only no-cache/no-store here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
SCRIPT="$ROOT/scripts/install.ps1"
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
STAGING_PREFIX="${STAGING_PREFIX:-harness/staging}"
MODE=staging
PRINT=0
for arg in "$@"; do
  case "$arg" in
    --production) MODE=production ;;
    --print)      PRINT=1 ;;
    *) echo "error: unknown argument '$arg' (use --production and/or --print)" >&2; exit 2 ;;
  esac
done
[[ "$STAGING_PREFIX" =~ ^harness/[a-z0-9_-]+(/[a-z0-9_-]+)*$ ]] || { echo "error: STAGING_PREFIX '$STAGING_PREFIX' is not a folder under harness/" >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }
# Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page: one non-ASCII byte garbles it.
if LC_ALL=C grep -q $'[^\t -~]' "$SCRIPT"; then echo "error: install.ps1 must be pure ASCII" >&2; exit 1; fi
LINE_START="\$HarnessManifestBase = '"
count="$(awk -v start="$LINE_START" 'index($0, start) == 1 { n++ } END { print n + 0 }' "$SCRIPT")"
[ "$count" = 1 ] || { echo "error: install.ps1 must have exactly one line starting with $LINE_START (found $count)" >&2; exit 1; }

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
if [ "$MODE" = staging ]; then
  base="https://storage.googleapis.com/${GCS_BUCKET}/${STAGING_PREFIX}/"
  awk -v start="$LINE_START" -v base="$base" 'index($0, start) == 1 { print start base "'"'"'"; next } { print }' "$SCRIPT" > "$OUT"
  GCS_PATH="${STAGING_PREFIX}/cli/install.ps1"
else
  cp "$SCRIPT" "$OUT"
  GCS_PATH="harness/cli/install.ps1"
fi
if [ "$PRINT" = 1 ]; then cat "$OUT"; exit 0; fi

command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
echo ">> uploading install.ps1 ($MODE) -> gs://${GCS_BUCKET}/${GCS_PATH}"
gcloud storage cp --cache-control="no-cache, no-store, must-revalidate" --content-type="text/plain; charset=utf-8" "$OUT" "gs://${GCS_BUCKET}/${GCS_PATH}"
echo ">> published: https://cdn.autonomous.ai/${GCS_PATH}"
echo ">> verify the CDN edge serves it:  curl -fsSL https://cdn.autonomous.ai/${GCS_PATH} | grep HarnessManifestBase"
```

  In `Makefile`, add ` upload-cli-install-ps1` to the `.PHONY` list on line 7, right after
  `upload-cli-install-sh`. Then insert this after line 78 (`bash cli/scripts/upload-install-sh.sh`), with one blank
  line before it:

```make
## upload-cli-install-ps1: publish cli/scripts/install.ps1, the Windows installer (`irm ... | iex`), to STAGING:
## harness/staging/cli/install.ps1, which reads the staging manifests. ARGS="--production" is the owner's step once
## the staging E2E has passed (harness/cli/install.ps1 -> https://cdn.autonomous.ai/harness/cli/install.ps1).
## ARGS="--print" shows what would be uploaded.
upload-cli-install-ps1:
	bash cli/scripts/upload-install-ps1.sh $(ARGS)
```

- [ ] **Step 4: Run it and see it pass.**
  Run `cd cli && chmod +x scripts/upload-install-ps1.sh && npx vitest run src/scripts/uploadInstallPs1.spec.ts && cd .. && make upload-cli-install-ps1 ARGS=--print | grep HarnessManifestBase`.
  Expected: all three cases pass, and the make line prints the staging base.

- [ ] **Step 5: Windows verification.** The staged file is exercised by B1.13's workflow run (it uploads it) and by
  B5's E2E (`irm … | iex`). Locally, check the staged copy still parses as PowerShell on the VM:
  `bash cli/scripts/upload-install-ps1.sh --print | ssh admin@192.168.65.3 'powershell -NoProfile -Command "$t = [Console]::In.ReadToEnd(); $null = [scriptblock]::Create($t); Write-Output parses"'`.
  Expected: `parses`.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/upload-install-ps1.sh cli/src/scripts/uploadInstallPs1.spec.ts Makefile`
  `git commit -m "feat(cli): publish install.ps1, staging by default, with its manifest base rewritten"`

### Task B1.13: The Windows workflow builds the release payload; the CLI release publishes the Windows bits to staging

**Files**
- Modify: `.github/workflows/windows-pty.yml` (78 lines; replaced whole, below)
- Modify: `.github/workflows/release.yml`:
  - lines 83-85: the `version` job's outputs;
  - lines 105-108: the resolve step's output lines;
  - insert two jobs between line 301 (the end of `publish`) and line 303 (the `# The GitHub Release.` comment).

**Interfaces**
- Consumes:
  - `HARNESS_PTY_VERSION` (B1.3);
  - `harness-launch.exe` (B1.5);
  - `publish-pty-payload.sh` and `runtimeManifest.mjs key` (B1.10);
  - `upload-install-ps1.sh` (B1.12).
- Produces:
  - `windows-pty.yml` is callable (`workflow_call`) with inputs `version: string`, `release: boolean`. Each matrix
    leg uploads an artifact `harness-pty-windows-<arch>` holding the 4-file payload. The on-demand run also runs
    `src/scripts/installPs1.spec.ts`.
  - `release.yml` gains two jobs: `pty-build` (calls `windows-pty.yml` in release mode) and `windows-staging`.
    `windows-staging` publishes `<staging>/pty/metadata.json`, copies the released `cli` entry into
    `<staging>/cli/metadata.json`, and uploads the staging `install.ps1`.
  - The staging prefix is `harness/staging` for a real release and `harness/staging-dry-run` for a dry run.
  - The CLI `publish` job and the GitHub Release do not wait on either job.

- [ ] **Step 1: Write the failing check.** Workflows have no unit test here. Their checks are actionlint, which
  CI's process checks run, and one real run. Write the expectations as a spec that reads the YAML. Create
  `cli/src/scripts/windowsWorkflows.spec.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflows = join(process.cwd(), '..', '.github', 'workflows')
const read = (name: string) => readFileSync(join(workflows, name), 'utf8')

describe('the Windows release workflows', () => {
  it('lets the release call the Windows PTY workflow for a payload stamped with the CLI version', () => {
    const pty = read('windows-pty.yml')
    expect(pty).toMatch(/workflow_call:\n\s+inputs:\n\s+version:/)
    expect(pty).toContain('HARNESS_PTY_VERSION: ${{ inputs.version }}')
    expect(pty).toContain("if: ${{ !inputs.release }}")
    for (const file of ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe']) expect(pty).toContain(file)
    expect(pty).toContain('src/scripts/installPs1.spec.ts')
  })

  it('publishes the Windows bits to staging only, beside a CLI publish that never waits for them', () => {
    const release = read('release.yml')
    expect(release).toContain('uses: ./.github/workflows/windows-pty.yml')
    expect(release).toContain('staging_prefix=')
    expect(release).toMatch(/windows-staging:\n\s+needs: \[version, preflight, publish, pty-build\]/)
    expect(release).toMatch(/github-release:\n\s+needs: \[version, publish\]/)
    expect(release).not.toMatch(/METADATA_PATH=harness\/pty\/metadata\.json/)
    expect(release).not.toContain('upload-install-ps1.sh --production')
  })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`.
  Expected: both cases fail, because `workflow_call` and `windows-staging` are not present.

- [ ] **Step 3: Implement.** Replace `.github/workflows/windows-pty.yml` with:

```yaml
name: Windows PTY

# On demand (Actions -> Windows PTY -> Run workflow): build, test and contract-test the host, and run the Windows
# CLI specs, on each architecture's own runner.
# Called by release.yml with `release: true`: build the release payload only, stamped with the CLI's version
# (HARNESS_PTY_VERSION, pty/src/cli.rs), for the staging publish. A release is not a test suite
# (docs/validation-and-release.md); the staging E2E is the gate before production.
on:
  workflow_dispatch:
  workflow_call:
    inputs:
      version:
        description: 'The CLI release version the host reports (X.Y.Z)'
        type: string
        required: false
        default: ''
      release:
        description: 'Build the release payload only, without the tests'
        type: boolean
        required: false
        default: false

concurrency:
  # When called, github.workflow is the caller's name, so a release run never cancels an on-demand one, nor the reverse.
  group: windows-pty-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  windows-pty:
    strategy:
      fail-fast: false
      matrix:
        include:
          - runner: windows-latest
            target: x86_64-pc-windows-msvc
            arch: x64
            artifact: harness-pty-windows-x64
          - runner: windows-11-arm
            target: aarch64-pc-windows-msvc
            arch: arm64
            artifact: harness-pty-windows-arm64
    # Each runner builds and tests its own native target. Cross-building the other
    # target is dropped: it needs extra MSVC components and adds little signal.
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - uses: actions/setup-node@v7
        with:
          # Same runtime pin as release.yml / ci.yml.
          node-version: 22.23.2
          cache: npm
          cache-dependency-path: cli/package-lock.json
      # The pinned ConPTY payload (pty/scripts/fetch-conpty.ps1): its hash is checked on every run.
      - name: Fetch ConPTY payload
        if: hashFiles('pty/scripts/fetch-conpty.ps1') != ''
        shell: pwsh
        run: pwsh pty/scripts/fetch-conpty.ps1
      - name: Rust tests
        if: ${{ !inputs.release }}
        working-directory: pty
        run: cargo test --locked --target ${{ matrix.target }}
      - name: Build release
        working-directory: pty
        env:
          # Empty on an on-demand run, and then the crate's own version (release_version in pty/src/cli.rs).
          HARNESS_PTY_VERSION: ${{ inputs.version }}
        run: cargo build --locked --release --target ${{ matrix.target }}
      # The host loads conpty.dll (and through it OpenConsole.exe) from its own folder, as it ships in dist/pty/
      # (cli/scripts/lib/ptyPayload.mjs) and in runtime\pty\<version>\: put them there so what is tested is what ships.
      - name: Place the ConPTY payload beside the host
        shell: pwsh
        run: |
          $release = "pty/target/${{ matrix.target }}/release"
          Copy-Item "pty/vendor/conpty/${{ matrix.arch }}/conpty.dll", "pty/vendor/conpty/${{ matrix.arch }}/OpenConsole.exe" $release
          Get-ChildItem $release -Filter '*.dll'
          Get-ChildItem $release -Filter 'OpenConsole.exe'
      - name: Check the release payload
        if: ${{ inputs.release }}
        shell: pwsh
        env:
          VERSION: ${{ inputs.version }}
        run: |
          $release = "pty/target/${{ matrix.target }}/release"
          $said = & "$release/harness-pty.exe" version
          if ($said -notmatch ('"version":"' + [regex]::Escape($env:VERSION) + '"')) { throw "harness-pty.exe says $said, not $env:VERSION" }
          # A command line without `--` is a usage error (exit 2): the launcher runs, and it is a GUI-subsystem program.
          $launch = Start-Process -FilePath "$release/harness-launch.exe" -ArgumentList 'version' -Wait -PassThru
          if ($launch.ExitCode -ne 2) { throw "harness-launch.exe exited $($launch.ExitCode), not 2" }
      - name: CLI install
        if: ${{ !inputs.release }}
        working-directory: cli
        run: npm ci
      - name: Contract suite against the real host, and the Windows CLI specs
        if: ${{ !inputs.release }}
        working-directory: cli
        shell: pwsh
        env:
          RUN_TERMINAL_CONTRACT: "1"
          HARNESS_PTY_BIN: ${{ github.workspace }}\pty\target\${{ matrix.target }}\release\harness-pty.exe
        run: |
          $paths = @('src/lib/ptyHostBackend.contract.spec.ts', 'src/lib/ptyHost', 'src/lib/windows', 'src/scripts/installPs1.spec.ts')
          npx vitest run @paths --maxWorkers=1
      - name: Collect the payload
        shell: pwsh
        run: |
          $release = "pty/target/${{ matrix.target }}/release"
          New-Item -ItemType Directory -Force payload | Out-Null
          Copy-Item "$release/harness-pty.exe", "$release/harness-launch.exe", "$release/conpty.dll", "$release/OpenConsole.exe" payload/
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: payload/
          if-no-files-found: error
```

  In `.github/workflows/release.yml`:

  1. In the `version` job's `outputs` (lines 83-85), add `staging_prefix: ${{ steps.resolve.outputs.staging_prefix }}`.
  2. In the resolve step, after line 107 (`echo "metadata_path=$meta" >> "$GITHUB_OUTPUT"`), add:

```bash
          # Where the Windows bits go (sub-project B): a real release's staging, or a dry run's own. A dry run's
          # 9.9.9 must never appear in the staging manifest the E2E installs from.
          if [ "$meta" = harness/cli/metadata.json ]; then staging=harness/staging; else staging=harness/staging-dry-run; fi
          echo "staging_prefix=$staging" >> "$GITHUB_OUTPUT"
```

  3. Insert after line 301 (the last line of the `publish` job, `cmp cli/scripts/install.sh "$RUNNER_TEMP/cli-install.sh"`),
     with one blank line before:

```yaml
  # The Windows half (sub-project B). The pty payload (harness-pty.exe, harness-launch.exe and ConPTY) is built on
  # each architecture's own runner by the Windows PTY workflow. The payload, this release's `cli` entry and
  # install.ps1 then go to STAGING, never to production: production is the owner's step after the staging E2E
  # (docs/testing/windows-cli-e2e.md). These jobs are separate from `publish`, so a Windows failure never holds up
  # the macOS and Linux fleet's release. Like `publish`, they fail loudly, and the next version fixes them.
  pty-build:
    needs: version
    uses: ./.github/workflows/windows-pty.yml
    with:
      version: ${{ needs.version.outputs.version }}
      release: true

  windows-staging:
    needs: [version, preflight, publish, pty-build]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      VERSION: ${{ needs.version.outputs.version }}
      STAGING_PREFIX: ${{ needs.version.outputs.staging_prefix }}
      CLI_METADATA_PATH: ${{ needs.version.outputs.metadata_path }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22.23.2
      - uses: actions/download-artifact@v4
        with:
          pattern: harness-pty-windows-*
          path: .pty
      - name: Authenticate to GCP (workload identity federation)
        uses: google-github-actions/auth@c200f3691d83b41bf9bbd8638997a462592937ed # v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - uses: google-github-actions/setup-gcloud@e427ad8a34f8676edf47cf7d7925499adf3eb74f # v2
      - name: Publish the pty payload to staging
        run: METADATA_PATH="$STAGING_PREFIX/pty/metadata.json" bash cli/scripts/publish-pty-payload.sh "$VERSION" .pty/harness-pty-windows-x64 .pty/harness-pty-windows-arm64
      - name: Point the staging CLI manifest at this release
        run: |
          set -euo pipefail
          curl -fsSL "https://storage.googleapis.com/${GCS_BUCKET}/${CLI_METADATA_PATH}" -o released.json
          # shellcheck disable=SC2016
          node -e '
            const fs = require("node:fs")
            const cli = JSON.parse(fs.readFileSync("released.json", "utf8")).cli
            if (!cli || cli.version !== process.env.VERSION) throw new Error(`the released manifest is not ${process.env.VERSION}`)
            fs.writeFileSync("cli-entry.json", JSON.stringify(cli))
          '
          gcloud storage cp "gs://${GCS_BUCKET}/${STAGING_PREFIX}/cli/metadata.json" staging.json 2>/dev/null || printf '{}' > staging.json
          node cli/scripts/lib/runtimeManifest.mjs key staging.json staging.next.json cli cli-entry.json
          gcloud storage cp --cache-control="no-cache, no-store, must-revalidate" --content-type=application/json \
            staging.next.json "gs://${GCS_BUCKET}/${STAGING_PREFIX}/cli/metadata.json"
      - name: Publish install.ps1 to staging
        run: bash cli/scripts/upload-install-ps1.sh
      - name: Read staging back the way install.ps1 will
        run: |
          set -euo pipefail
          # shellcheck disable=SC2016
          node -e '
            const crypto = require("node:crypto")
            const base = `https://storage.googleapis.com/${process.env.GCS_BUCKET}/${process.env.STAGING_PREFIX}/`
            const json = async (path) => (await fetch(base + path, { cache: "no-store" })).json()
            const main = async () => {
              const cli = (await json("cli/metadata.json")).cli
              if (cli.version !== process.env.VERSION) throw new Error(`staging cli is ${cli.version}`)
              const pty = (await json("pty/metadata.json")).pty
              for (const key of ["win32-x64", "win32-arm64"]) {
                const entry = pty[key]
                if (entry.version !== process.env.VERSION) throw new Error(`${key} pty is ${entry.version}`)
                const bytes = Buffer.from(await (await fetch(entry.url, { cache: "no-store" })).arrayBuffer())
                if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || bytes.length !== entry.size) throw new Error(`${key}: served pty bytes differ`)
              }
              const runtime = await fetch(base + "runtime/metadata.json", { cache: "no-store" })
              const node = runtime.ok ? (await runtime.json()).node || {} : {}
              if (!node["win32-x64"] || !node["win32-arm64"]) console.log("::warning::staging has no Windows Node yet: run the Node runtime for Windows workflow")
              const script = await (await fetch(`https://cdn.autonomous.ai/${process.env.STAGING_PREFIX}/cli/install.ps1`, { cache: "no-store" })).text()
              if (!script.includes(`$HarnessManifestBase = '"'"'${base}'"'"'`)) console.log("::warning::the CDN does not serve the staging install.ps1 yet")
              console.log(`staging ${process.env.VERSION}: cli, pty x64 + arm64 verified`)
            }
            main().catch((error) => { console.error(`::error::${error.message}`); process.exit(1) })
          '
```

  `GCS_BUCKET` comes from the workflow-level `env` (line 77). `upload-install-ps1.sh` reads `STAGING_PREFIX` from
  the job env.

- [ ] **Step 4: Run it and see it pass.**
  Run `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts && cd .. && actionlint .github/workflows/windows-pty.yml .github/workflows/release.yml`.
  Expected: both cases pass, and actionlint is clean. Without actionlint locally, the PR's process checks run it.

- [ ] **Step 5: Windows verification, one run of each.** Mind the account's limit of 5 macOS jobs at once, and do
  not run heavy workflows side by side.
  1. On-demand mode on the branch: `gh workflow run "Windows PTY" --ref <branch>`, then `gh run watch`.
     Expected:
     - both legs are green;
     - they run `cargo test` (including `harness_launch` and `harness_launch_job`), the contract suite,
       `src/lib/windows` and `installPs1.spec.ts`;
     - the artifacts hold four files each.
  2. Release mode, as a dry run (it writes only `harness/staging-dry-run/` and the CLI's metadata-test.json):
     `gh workflow run Release --ref <branch> -f version=9.9.9 -f metadata_path=harness/cli/metadata-test.json`.
     Expected:
     - `pty-build` builds both payloads with `"version":"9.9.9"`;
     - `windows-staging` publishes and reads back `harness/staging-dry-run/`;
     - the GitHub Release job is skipped (a dispatch, not a tag).
     Afterwards, delete `gs://s3-autonomous-upgrade-3/harness/cli/9.9.9/`, `harness/pty/9.9.9/` and
     `harness/staging-dry-run/`, as release.yml's header asks for a dry run.
  3. Report both run links in the PR.

- [ ] **Step 6: Commit.**
  `git add .github/workflows/windows-pty.yml .github/workflows/release.yml cli/src/scripts/windowsWorkflows.spec.ts`
  `git commit -m "ci: the CLI release builds the Windows payload and publishes it, the cli entry and install.ps1 to staging"`

### Phase B1 notes

**Assumptions verified**
- Verified: nodejs.org's Windows zip unpacks to `node-v<v>-win-<arch>/node.exe`. Checked on
  `node-v22.23.2-win-arm64.zip`: its first entry is `node-v22.23.2-win-arm64/`, with 2,545 entries. Its
  SHASUMS256.txt lists `win-x64.zip` (`1177b413…f99f97`) and `win-arm64.zip` (`fec025a6…f3`), and
  `SHASUMS256.txt.sig` exists (HTTP 200).
- Verified: `nodejs/release-keys` HEAD is `481637f813e912c4aa3622d7964ab426c97b8e8d` (2026-09-01). Its
  `gpg-only-active-keys/pubring.kbx` is 21,011 bytes, sha256 `140f2ad5…285932`.
- Verified: macOS `/usr/bin/tar` is bsdtar 3.5.3 (libarchive 3.7.4), which reads and writes zip.
- Verified: the CLI manifest's `cli` entry is `{version, cli:{url,sha256,size}, notify:{url,sha256,size}}`
  (`merge-manifest.mjs`). install.sh writes `package.json {"type":"module"}` beside `cli.js`.
- Verified: A's `currentPtyVersion` accepts only `^\d+(\.\d+)*$`, which is why the pty version is the CLI's `X.Y.Z`.
  `ptyHostBinary` looks at `runtime/pty/<v>/harness-pty.exe` first.
- Verified (B1.8, VM, Win11 ARM64, Windows PowerShell 5.1): `irm | iex` under `-ExecutionPolicy Restricted`
  installs into a profile named `Jo-umlaut CJK & co`, and a Restricted PowerShell runs `harness.exe` there.
- Verified (B1.8): Windows' `tar.exe` reads its arguments in the ANSI code page, so a CJK letter in the profile path
  reached it as `?` and it could not open the archive. `Expand-HarnessZip` now moves the archive into the
  destination and runs tar there on an ASCII relative name (the working directory is passed in Unicode).
- Verified (B1.8, before harness.exe): a batch file cannot be the `harness` command. Every caller of a `.cmd` goes
  through `cmd /c` (Node, PowerShell, Explorer), which parses the arguments again, so an argument with `"` and then
  `&`, `|`, `<` or `>` ran commands of its own; `node ... %* & exit /b` also returned 0 rather than node's code, and
  a deleted running batch file printed "The batch file cannot be found." with every ending.
- Verified (B1.8 fix round 1): `SetConsoleCtrlHandler(NULL, TRUE)` is inherited, so a `harness.exe` that ignored
  Ctrl-C that way left node deaf to it; with no handler, `harness.exe` ended on Ctrl-C first (exit
  `STATUS_CONTROL_C_EXIT`). A handler that returns TRUE passes `harness_command_ctrl_c.rs`: node gets SIGINT and
  `harness.exe` exits with node's code. A process started in a new process group (an SSH session's may be) passes
  "ignore Ctrl-C" on to everything it starts; the test clears it before starting harness.exe.
- Verified (B1.8 fix round 1): `[IO.File]::Replace` over a running `.exe` succeeds by renaming the running file to
  `<name>~RF<hex>.TMP` beside it; a running exe can be renamed but not deleted. install.ps1 removes those leftovers
  (and its own `.<name>.old-*` fallback names) on the next install, once they have exited.
- Verified: `breakaway.rs` exports `CREATE_BREAKAWAY_FROM_JOB`, `DETACHED_PROCESS` and `CREATE_NEW_PROCESS_GROUP` on
  every OS. `pty/tests/breakaway.rs` has the job and suspended-start helpers that `harness_launch_job.rs` copies.
- Verified: the pty crate has no `[[bin]]` today (`src/main.rs` only), and `windows-sys` already enables `JobObjects`,
  `Threading` and `ToolHelp`. `windows-pty.yml` is workflow_dispatch only, and its artifact held only
  `harness-pty.exe`.
- Verified: `ensureManagedGrid` is reached from `cli.ts:1377` and `services/models.ts:66,83`. The new win32 guard
  covers all three. `retireSuperseded` runs only for `followsPin` (grid), so it never runs on Windows.

**Open risks**
- `harness uninstall` (B5.9) runs inside `harness.exe` when a person types it: that file cannot be deleted while it
  runs, only renamed. B5 must rename it aside or leave its removal to a process that outlives it.
- The pinned active keyring must contain the key that signed v22.23.2's SHASUMS256.txt. B1.11 Step 5's real run is
  the check. If it fails, move the pin forward (commit and digest together).
- Until B3, an installed Windows CLI runs from `cli\<ver>\cli.js`, not `ADAPTER_CLI_DIR\cli.js`, and the self-updater
  does not know that layout. `install.ps1`'s `harness service install` fails on win32 until B3, and is reported as a
  warning.
- Every CLI release now runs two Windows jobs, about 10-20 minutes each, plus the arm64 runner's queue. They do not
  block the CLI publish or the GitHub Release.
- The CLI's own `ensureManagedRuntime` on Windows reads the production runtime manifest, which has no win32 keys
  until the owner promotes them. That is harmless, since the installer already provisioned Node, but a `--repair` on
  Windows does nothing until promotion.
- Unsigned `harness-launch.exe` and `harness-pty.exe` may be slowed or blocked by SmartScreen or antivirus until D
  signs them. The E2E records this.
- Add-Type is blocked in Constrained Language Mode. The PATH broadcast is then skipped with a note, and new
  terminals see PATH after sign-in.

**Decisions**
- Decision: `harness-launch` uses `CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP`, without
  `DETACHED_PROCESS`. This departs from the contract and the spec. Windows documents that `CREATE_NO_WINDOW` is
  ignored beside `DETACHED_PROCESS`, and a daemon with no console would open a visible console window for every
  console child it starts without `windowsHide`. The B1.4 test pins this.
- Decision: `harness-launch` retries without breakaway only on `ERROR_ACCESS_DENIED`. That is the job refusing; any
  other spawn error is the answer, exit 4.
- Decision: usage errors (exit 2) are not logged. With no `--root` there is no install folder of the caller's to
  write in, and the caller sees the code.
- Decision: `runtime\current-node` keeps a full path, as on a Mac. `managedNodePath`, the desktop app and A's code
  read it unchanged. `readPointer`'s single-segment rule applies to `cli\current` and `current-pty` only.
- Decision: pointer files end in CRLF with no BOM, written by temp file and rename. The Rust reader
  (`launcher::resolve`) keeps a leading BOM in the value, and every reader trims the line end.
- Decision (B1.8 fix round 1, replaces `bin\harness.cmd`): the `harness` command is `bin\harness.exe`, a console
  program in the `pty/` crate (`src/command.rs`, `src/bin/harness.rs`). It finds the install as the folder above its
  own, resolves Node and the CLI with `launcher::resolve` (the containment rules harness-launch applies), runs
  `node.exe cli.js <its arguments>` with CreateProcessW in the same console, stdio, environment and working folder,
  leaves Ctrl-C and Ctrl-Break to node, and exits with node's code. A broken install prints one sentence naming
  PowerShell and the install command, and exits 3; a Node that does not start exits 4. install.ps1 copies it from
  `runtime\pty\<version>\` only when its bytes differ, and removes a `harness.cmd` an earlier install left.
- Decision: `-Manifest` is one document with the `cli`, `node` and `pty` keys, shaped as the published ones. Local
  relative paths are allowed only when the manifest is a local file. Without it, the installer reads the three
  published manifests under `$HarnessManifestBase`. That gives one local file for builds and tests, and no new
  production document.
- Decision: `HARNESS_INSTALL_MANIFEST` also sets `-Manifest`, because `irm | iex` cannot pass parameters. The staging
  copy of install.ps1 differs in its base line only, so `irm …/harness/staging/cli/install.ps1 | iex` installs
  staging with no parameters.
- Decision: the staging prefix is `harness/staging/` (`harness/staging-dry-run/` for release dry runs). Versioned
  artifacts use their real immutable paths (`harness/pty/<v>/`, `harness/runtime/node/v<v>/`), and only manifests
  differ between staging and production. Promotion then republishes no bytes.
- Decision: the pty manifest is `{ "pty": { "win32-x64": {version,url,sha256,size}, … } }`, nested like every other
  runtime manifest (`artifactFor(document, name, key)`). The zip has its four files at the root and no
  `archiveRoot`, per the contract's fields.
- Decision: the pty host's release version comes from the compile-time `HARNESS_PTY_VERSION`, not from editing
  `Cargo.toml`. Editing it would break `cargo build --locked`. `default-run = "harness-pty"` keeps `cargo run` working
  with two binaries.
- Decision: release mode of `windows-pty.yml` builds and checks the payload without running tests. Releases are not
  test suites here, and the staging E2E gates production. The on-demand run keeps the full tests and adds
  `installPs1.spec.ts`.
- Decision: Windows Node is published by its own script and manual workflow, not on every CLI release. The Node pin
  moves rarely. The signature is checked with `gpgv` against nodejs/release-keys pinned by commit and digest; the
  existing Mac script trusts SHASUMS256.txt over HTTPS only and is left unchanged.
- Decision: the installer's PowerShell tests are Vitest specs driving `powershell.exe` (Windows PowerShell 5.1):
  `-File` for whole installs, `-EncodedCommand` with library mode for functions, and a static half on every OS. They
  are not Pester: 5.1 ships Pester 3.4, the VM has no Pester 5, and the default `irm | iex` shell is 5.1.
  `HARNESS_INSTALL_ENV_KEY` keeps tests out of the real `HKCU\Environment`.
- Decision: `-Desktop` still installs the pty payload, and skips the service and the guide. The daemon the app
  starts needs its terminal host, as `--desktop` on a Mac still installs what the daemon runs on.
- Decision: in B1, a failed `harness service install` is a warning and not an install failure. B3 implements the
  Windows service, and the spec's mitigation says `harness start` works without the task. `harness version` is the
  mandatory check.
- Decision: install.ps1 never calls `exit` under `irm | iex`; it sets `$LASTEXITCODE` instead. An `exit` would
  close the person's PowerShell window with the error in it.
- Decision: install.ps1 reads the architecture from the system environment in HKLM, not from the process. An x64
  PowerShell emulated on ARM64 reports AMD64 in its own environment.
- Decision: `HARNESS_BIN_DIR`'s default (`~/.local/bin`) is unchanged in B1, because tui, hookSettings and tmuxOnPath
  read it. B3 and B5 address Windows' `.harness\bin` through `installLayout.harnessLaunchPath()`.
- Decision: `retireSuperseded` is untouched. It runs only for grid, which is off on Windows. Retiring Node and CLI
  folders on Windows belongs to B3's self-update.
- Decision: `harness tui` saying it is not available on Windows (spec decision 5) is not in B1's contract. It is
  owned by B4.16. The installer simply installs no hn.
- Decision: what the `harness` command can carry is listed here, and only here (no `harness help` change).
  Characters `harness.exe` cannot carry: none. It is a program, so no batch file parses the arguments a second time,
  and the CLI receives exactly the arguments Windows hands `harness.exe` (cargo: `harness_command.rs`, including
  `a&b`, `say "hi" & echo pwned > x`, `%OS%`, `50%`, `x^y`, `wow!`, `|<>` and an empty argument). What remains is
  the caller's own shell, as for any program (measured on the VM, pinned in `installPs1.spec.ts`):
  - cmd: the person's own `harness ...` line is parsed once by cmd, as usual. Quote `&|<>^` (`"a&b"`) or escape
    them with `^`; write `""` for a quote inside quotes; write `%^OS%` to keep `%OS%` from being expanded. Typed
    that way, every case arrives exactly, nothing else runs and no file is created.
  - Windows PowerShell 5.1: `harness 'a&b'` and `harness 'a & b | c > d'` arrive exactly. 5.1 passes an inner `"`
    to any program unescaped, so `harness 'say "hi" & echo pwned > x'` arrives as `say hi & echo pwned > x` (the
    quotes are lost; nothing runs). Write `\"` in 5.1 for a quote; PowerShell 7.3 and later need nothing.
  The desktop and the daemon run `node.exe cli.js` directly and never the command (checked at B1.8: nothing in
  `desktop/` or `cli/src` spawns it).


---

## Phase B2: IPC and trust

On Windows the daemon also serves its HTTP API and local WS on `\\.\pipe\harness-<32 hex>`, a new name on each
start, recorded with the core's pid in `daemon-<port>.json`. Reaching the pipe proves nothing. Each request proves
the daemon's token with an HMAC of a nonce, and each answer proves it back. The CLI's control calls and status use
the pipe after A's dead-process check. Separately, the hook credential and the token are refused on Windows when
they are links or resolve outside the profile. mac/Linux behavior does not change: no token is passed there, so the
Unix socket keeps its reachability trust.

All commands run from `cli/` unless they say otherwise. Line anchors were checked on `feat/windows-native-cli` at
`058e5a082`.

### Task B2.1: Pipe auth primitives

**Files**
- Create: `cli/src/lib/windows/pipeAuth.ts`
- Create: `cli/src/lib/windows/pipeAuth.spec.ts`

**Interfaces**
- Consumes: nothing.
- Produces (contract): `PIPE_AUTH_HEADER = 'x-harness-auth'`, `PIPE_PROOF_HEADER = 'x-harness-proof'`,
  `pipeAuthValue(token: Buffer, nonce: string): string`, `pipeProofValue(token: Buffer, nonce: string): string`,
  `checkPipeAuth(token: Buffer, header: string | undefined, seen: NonceWindow, pipeId?: string): { nonce: string } | null`,
  `class NonceWindow { constructor(capacity?: number); admit(nonce: string): boolean; readonly size: number }`.
- Produces (additions, used by B2.5–B2.12 and phase C): `newPipePath(): string`, `pipeIdOf(endpoint: string): string | null`,
  `newPipeNonce(endpoint: string): string`, `pipeProven(headers: IncomingHttpHeaders, token: Buffer, nonce: string): boolean`.

- [ ] **Step 1: failing test.** Create `cli/src/lib/windows/pipeAuth.spec.ts`:

```ts
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkPipeAuth, newPipeNonce, newPipePath, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeAuthValue, pipeIdOf,
  pipeProofValue, pipeProven,
} from './pipeAuth.js'

const token = Buffer.alloc(32, 7)
const hmac = (separator: number, nonce: string) =>
  createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')

describe('pipe auth', () => {
  it('names its headers in lower case, as Node reads them', () => {
    expect([PIPE_AUTH_HEADER, PIPE_PROOF_HEADER]).toEqual(['x-harness-auth', 'x-harness-proof'])
  })

  it('authenticates with an HMAC of the nonce and proves with another, never sending the token', () => {
    const nonce = 'ab'.repeat(32)
    expect(pipeAuthValue(token, nonce)).toBe(`${nonce}.${hmac(0x01, nonce)}`)
    expect(pipeProofValue(token, nonce)).toBe(hmac(0x00, nonce))
    expect(pipeAuthValue(token, nonce)).not.toContain(token.toString('hex'))
    expect(pipeProofValue(token, nonce)).not.toBe(pipeAuthValue(token, nonce).split('.')[1])
  })

  it('accepts an auth once, and only for the pipe whose id starts its nonce', () => {
    const id = 'c'.repeat(32)
    const nonce = newPipeNonce(`\\\\.\\pipe\\harness-${id}`)
    expect(nonce).toMatch(/^c{32}[0-9a-f]{32}$/)
    const seen = new NonceWindow()
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toEqual({ nonce })
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toBeNull()
    const other = newPipeNonce(`\\\\.\\pipe\\harness-${'d'.repeat(32)}`)
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen, id)).toBeNull()
    // No pipe named: any well-formed nonce.
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen)).toEqual({ nonce: other })
  })

  it('refuses a wrong token, a malformed header and none at all, and remembers none of them', () => {
    const seen = new NonceWindow()
    const nonce = newPipeNonce(`harness-${'e'.repeat(32)}`)
    const good = pipeAuthValue(token, nonce)
    for (const header of [undefined, '', 'x', nonce, `${nonce}.`, `${nonce}.${'0'.repeat(64)}`,
      pipeAuthValue(Buffer.alloc(32, 8), nonce), good.toUpperCase(), `${good} `, `${good}.00`]) {
      expect(checkPipeAuth(token, header, seen)).toBeNull()
    }
    expect(seen.size).toBe(0)
    expect(checkPipeAuth(token, good, seen)).toEqual({ nonce })
  })

  it('remembers a bounded number of nonces and forgets the oldest first', () => {
    const seen = new NonceWindow(2)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('b')).toBe(true)
    expect(seen.admit('a')).toBe(false)
    expect(seen.admit('c')).toBe(true)
    expect(seen.size).toBe(2)
    expect(seen.admit('a')).toBe(true)
  })

  it('takes a proof from an answer\'s headers only when it is this token\'s for this nonce', () => {
    const nonce = newPipeNonce(`harness-${'f'.repeat(32)}`)
    expect(pipeProven({ [PIPE_PROOF_HEADER]: pipeProofValue(token, nonce) }, token, nonce)).toBe(true)
    for (const headers of [{}, { [PIPE_PROOF_HEADER]: pipeProofValue(Buffer.alloc(32, 9), nonce) },
      { [PIPE_PROOF_HEADER]: pipeAuthValue(token, nonce).split('.')[1] }, { [PIPE_PROOF_HEADER]: 'zz' }]) {
      expect(pipeProven(headers, token, nonce)).toBe(false)
    }
  })

  it('names a new pipe with 128 random bits each time, and reads its id back', () => {
    const a = newPipePath(), b = newPipePath()
    expect(a).toMatch(/^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect(pipeIdOf(a)).toBe(a.slice(-32))
    // A Unix socket with a pipe's name stands in for one in the tests.
    expect(pipeIdOf(`/tmp/x/harness-${'0'.repeat(32)}`)).toBe('0'.repeat(32))
    expect(pipeIdOf('\\\\.\\pipe\\other')).toBeNull()
    expect(() => newPipeNonce('/tmp/daemon.sock')).toThrow(/not a Harness pipe/)
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/windows/pipeAuth.spec.ts`. It fails: `Failed to load url ./pipeAuth.js`.

- [ ] **Step 3: implementation.** Create `cli/src/lib/windows/pipeAuth.ts`:

```ts
/**
 * The credential of the daemon's Windows pipe (docs/superpowers/specs/2026-10-16-windows-native-cli-design.md §2).
 *
 * Node cannot set a named pipe's DACL. The default DACL lets every account open the pipe for reading, and once the
 * daemon is gone any account can create a pipe of that name. So reaching `\\.\pipe\harness-<id>` proves nothing,
 * unlike the Unix socket (lib/localSocket.ts). Each request proves the daemon's token instead, as the pty host's
 * hello does (ptyHost/protocol.ts). The client sends `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>` and the daemon
 * answers with HMAC-SHA256(token, 0x00‖nonce). The token never travels.
 *
 * The nonce starts with the pipe's id. An auth taken by whatever squatted on a dead daemon's name then opens
 * nothing at the next daemon's pipe, whose nonce window starts empty.
 *
 * Nothing here depends on the transport: the same checks run over a Unix socket in the tests on macOS and Linux.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const PIPE_AUTH_HEADER = 'x-harness-auth'
export const PIPE_PROOF_HEADER = 'x-harness-proof'

const HEX64 = /^[0-9a-f]{64}$/
const AUTH_RE = /^([0-9a-f]{64})\.([0-9a-f]{64})$/
const PIPE_ID_RE = /harness-([0-9a-f]{32})$/

function mac(token: Buffer, separator: number, nonce: string): string {
  return createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** What a client sends in `x-harness-auth` for [nonce]. */
export function pipeAuthValue(token: Buffer, nonce: string): string {
  return `${nonce}.${mac(token, 0x01, nonce)}`
}

/** What the daemon answers in `x-harness-proof` for [nonce]: only a process that knows the token can give it. */
export function pipeProofValue(token: Buffer, nonce: string): string {
  return mac(token, 0x00, nonce)
}

/** The nonces a daemon took most recently: an auth is accepted once. Bounded; the oldest is forgotten first. */
export class NonceWindow {
  private readonly seen = new Set<string>()
  constructor(readonly capacity = 4_096) {}

  /** Whether [nonce] is new here; it is remembered either way. */
  admit(nonce: string): boolean {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value as string)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

/**
 * The nonce of a valid `x-harness-auth` [header], or null. Valid: well formed, this token's HMAC, a nonce that begins
 * with [pipeId] when one is given, and not seen before. The HMAC is checked before the window, so refused headers
 * never fill it.
 */
export function checkPipeAuth(token: Buffer, header: string | undefined, seen: NonceWindow, pipeId?: string): { nonce: string } | null {
  if (typeof header !== 'string') return null
  const match = AUTH_RE.exec(header)
  if (!match) return null
  const nonce = match[1]!
  if (pipeId !== undefined && !nonce.startsWith(pipeId)) return null
  if (!sameHex(match[2]!, mac(token, 0x01, nonce))) return null
  return seen.admit(nonce) ? { nonce } : null
}

/** Whether an answer's [headers] prove [token] for [nonce]. */
export function pipeProven(headers: IncomingHttpHeaders, token: Buffer, nonce: string): boolean {
  const proof = headers[PIPE_PROOF_HEADER]
  return typeof proof === 'string' && HEX64.test(proof) && sameHex(proof, pipeProofValue(token, nonce))
}

/** A new pipe name for a daemon that is starting: `\\.\pipe\harness-<128 random bits as hex>`. */
export function newPipePath(): string {
  return `\\\\.\\pipe\\harness-${randomBytes(16).toString('hex')}`
}

/** The 32-hex id that ends a Harness pipe name, or null for an endpoint that is not one. */
export function pipeIdOf(endpoint: string): string | null {
  return PIPE_ID_RE.exec(endpoint)?.[1] ?? null
}

/** A nonce for one request to [endpoint]: its pipe id, then 128 random bits, as 64 hex digits. */
export function newPipeNonce(endpoint: string): string {
  const id = pipeIdOf(endpoint)
  if (!id) throw new Error(`${endpoint} is not a Harness pipe`)
  return id + randomBytes(16).toString('hex')
}
```

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/windows/pipeAuth.spec.ts` (7 passed).

- [ ] **Step 5: commit.**
  `git add cli/src/lib/windows/pipeAuth.ts cli/src/lib/windows/pipeAuth.spec.ts`
  `git commit -m "feat(cli): HMAC auth and proof for the daemon's Windows pipe"`

### Task B2.2: Windows location rule for credential files (hook credential)

**Files**
- Modify: `cli/src/lib/secureState.ts` (imports at lines 1-12; add the function after `requireInsideWindowsRoots`, lines 54-61)
- Modify: `cli/src/lib/secureState.spec.ts` (import at line 5; new `describe` at the end)
- Modify: `cli/src/lib/hookAuth.ts` (imports at line 4; `readHookCredential` at lines 22-43)
- Modify: `cli/src/lib/hookAuth.spec.ts` (imports at lines 1-6; new test before the FIFO test at line 64)
- Create: `cli/src/testing/windowsOpen.ts` (the "open as Windows does" test helper, shared with B2.3)

**Interfaces**
- Produces: `requireWindowsStateFile(file: string): void` in `secureState.ts` (throws). B2.3 consumes it.
- Produces (tests only): `windowsOpenFs(real)` and `asWindows(dataDir, body)` in `cli/src/testing/windowsOpen.ts`.
  B2.3 consumes them.

- [ ] **Step 1: failing tests.**

In `cli/src/lib/secureState.spec.ts`, add `requireWindowsStateFile` to the import on line 5, add
`symlinkSync` to the `node:fs` import on line 2, and add at the end of the file:

```ts
// Windows' open has no O_NOFOLLOW: a credential file is checked by itself before it is read (hookAuth.ts, the daemon
// token). The rule needs no Windows API, so it runs here too.
describe('requireWindowsStateFile', () => {
  it('takes a real file inside the state roots, and refuses a link or a file outside them', () => {
    const dir = mkdtempSync('/tmp/secure-file-')
    const outside = mkdtempSync('/tmp/secure-outside-')
    dirs.push(dir, outside)
    const configured = process.env.ADAPTER_DATA_DIR
    process.env.ADAPTER_DATA_DIR = dir
    try {
      const file = join(dir, 'daemon-token')
      writeFileSync(file, 'x')
      expect(() => requireWindowsStateFile(file)).not.toThrow()
      const link = join(dir, 'hook-credential')
      symlinkSync(file, link)
      expect(() => requireWindowsStateFile(link)).toThrow(/link or junction/)
      const far = join(outside, 'daemon-token')
      writeFileSync(far, 'x')
      expect(() => requireWindowsStateFile(far)).toThrow(/outside your user profile/)
      expect(() => requireWindowsStateFile(join(dir, 'missing'))).toThrow(/ENOENT/)
    } finally {
      if (configured === undefined) delete process.env.ADAPTER_DATA_DIR
      else process.env.ADAPTER_DATA_DIR = configured
    }
  })
})
```

Create `cli/src/testing/windowsOpen.ts`, the helper this spec and B2.3's `daemonToken.spec.ts` share:

```ts
/**
 * Specs that read a state file as Windows would: its platform, and its open without O_NOFOLLOW (fs.constants
 * leaves it out there). A spec mocks node:fs with [windowsOpenFs] and wraps its Windows part in [asWindows]:
 *
 *   vi.mock('node:fs', async (importOriginal) =>
 *     (await import('../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))
 *
 * The factory imports this module itself because vi.mock is hoisted above the spec's imports. It is the same module
 * instance the spec imports [asWindows] from, so the two share [state]. This file imports nothing, node:fs least of all.
 */
const state = { windowsOpen: false }

/** node:fs, with O_NOFOLLOW undefined while [asWindows] runs. */
export function windowsOpenFs<T extends typeof import('node:fs')>(real: T): T {
  // A copy: fs.constants' own properties cannot be redefined.
  const constants = Object.defineProperty({ ...real.constants }, 'O_NOFOLLOW', {
    enumerable: true, get: () => (state.windowsOpen ? undefined : real.constants.O_NOFOLLOW),
  }) as typeof real.constants
  return { ...real, constants, default: { ...real, constants } } as T
}

/** Run [body] as Windows would: its platform, its open, and [dataDir] as the configured data folder. */
export function asWindows(dataDir: string, body: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const configured = process.env.ADAPTER_DATA_DIR
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    process.env.ADAPTER_DATA_DIR = dataDir
    state.windowsOpen = true
    body()
  } finally {
    state.windowsOpen = false
    Object.defineProperty(process, 'platform', platform)
    if (configured === undefined) delete process.env.ADAPTER_DATA_DIR
    else process.env.ADAPTER_DATA_DIR = configured
  }
}
```

In `cli/src/lib/hookAuth.spec.ts`, change line 2 to
`import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'`, line 5
to `import { afterEach, describe, expect, it, vi } from 'vitest'`, and add after line 6:

```ts
import { asWindows } from '../testing/windowsOpen.js'

// Windows' open has no O_NOFOLLOW: asWindows says when to open as Windows does (src/testing/windowsOpen.ts).
vi.mock('node:fs', async (importOriginal) =>
  (await import('../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))
```

and, before the FIFO test (line 64):

```ts
  it('on Windows, refuses a credential that is a link, which Windows would open through', () => {
    const dir = mkdtempSync('/tmp/hook-auth-')
    const elsewhere = mkdtempSync('/tmp/hook-elsewhere-')
    dirs.push(dir, elsewhere)
    const planted = join(elsewhere, 'hook-credential')
    writeFileSync(planted, `${'A'.repeat(43)}\n`, { mode: 0o600 })
    symlinkSync(planted, hookCredentialPath(dir))
    asWindows(dir, () => {
      expect(readHookCredential(dir)).toBeNull()
      // Never replaced either: the link is not this daemon's to remove.
      expect(() => loadOrCreateHookCredential(dir)).toThrow(/EEXIST/)
    })
  })
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/secureState.spec.ts src/lib/hookAuth.spec.ts`.
  `secureState.spec.ts` fails: `requireWindowsStateFile is not a function`. The new hookAuth test fails with
  `expected 'AAAA…' to be null`: without O_NOFOLLOW the open follows the link.

- [ ] **Step 3: implementation.**

`cli/src/lib/secureState.ts`: add `lstatSync,` to the `node:fs` import list (lines 1-12, keep it sorted:
after `fsyncSync,`), and add after `requireInsideWindowsRoots` (after line 61):

```ts
/**
 * Windows: a state file a credential is read from (the hook credential, the daemon token, lib/windows/pipeAuth.ts).
 * The file must not be a link or junction itself (Node's lstat reports both as symbolic links), and resolved, it
 * must be inside the state roots. Windows' open has no O_NOFOLLOW (the constant is undefined there). So this check
 * is what keeps a link planted in the data folder from handing the daemon another file. Throws otherwise.
 */
export function requireWindowsStateFile(file: string): void {
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`state file ${file} is a link or junction; a credential is never read through one`)
  }
  requireInsideWindowsRoots(file, 'file')
}
```

`cli/src/lib/hookAuth.ts`: line 4 becomes
`import { requireWindowsStateFile, secureStateDirectory, syncStateDirectory } from './secureState.js'`, and in
`readHookCredential` replace lines 26-27:

```ts
    const file = hookCredentialPath(dataDir)
    // Windows: the file itself must be a real file in the profile (secureState.ts); its open follows links.
    if (process.platform === 'win32') requireWindowsStateFile(file)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
```

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/secureState.spec.ts src/lib/hookAuth.spec.ts src/hookServer.spec.ts`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/secureState.ts cli/src/lib/secureState.spec.ts cli/src/lib/hookAuth.ts cli/src/lib/hookAuth.spec.ts cli/src/testing/windowsOpen.ts`
  `git commit -m "fix(cli): on Windows a hook credential that is a link or outside the profile is refused"`

### Task B2.3: The daemon token file

**Files**
- Modify: `cli/src/lib/windows/pipeAuth.ts` (append)
- Create: `cli/src/lib/windows/daemonToken.spec.ts`

**Interfaces**
- Consumes: `requireWindowsStateFile` (B2.2), `readPrivateStateFile`, `secureStateDirectory`, `syncStateDirectory`;
  in its spec, `windowsOpenFs` and `asWindows` (B2.2, `cli/src/testing/windowsOpen.ts`).
- Produces (contract): `readDaemonToken(dataDir: string): Buffer | null`, `ensureDaemonToken(dataDir: string): Buffer`;
  plus `DAEMON_TOKEN_FILE = 'daemon-token'`, `daemonTokenPath(dataDir: string): string`. The file holds 64 lowercase
  hex digits and a newline (phase C's desktop reads it the same way).

- [ ] **Step 1: failing test.** Create `cli/src/lib/windows/daemonToken.spec.ts`:

```ts
// The daemon's token, on Unix and as Windows reads it (its platform and its open without O_NOFOLLOW). The real
// Windows file is checked in daemonPipe.real.spec.ts.
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asWindows } from '../../testing/windowsOpen.js'
import { daemonTokenPath, ensureDaemonToken, readDaemonToken } from './pipeAuth.js'

vi.mock('node:fs', async (importOriginal) =>
  (await import('../../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const scratch = (prefix = '/tmp/htoken-') => { const dir = mkdtempSync(prefix); dirs.push(dir); return dir }

describe.skipIf(process.platform === 'win32')('the daemon token', () => {
  it('is made once: 32 random bytes, as hex, owner-only, and read back', () => {
    const dir = scratch()
    expect(readDaemonToken(dir)).toBeNull()
    const token = ensureDaemonToken(dir)
    expect(token).toHaveLength(32)
    expect(ensureDaemonToken(dir).equals(token)).toBe(true)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    expect(statSync(daemonTokenPath(dir)).mode & 0o777).toBe(0o600)
    expect(ensureDaemonToken(scratch()).equals(token)).toBe(false)
  })

  it('replaces a token cut short, and refuses one another account could have written', () => {
    const dir = scratch()
    writeFileSync(daemonTokenPath(dir), 'ab12', { mode: 0o600 })
    expect(readDaemonToken(dir)).toBeNull()
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    chmodSync(daemonTokenPath(dir), 0o666)
    expect(readDaemonToken(dir)).toBeNull()
    expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
  })

  it('on Windows, is read where the profile protects it, never through a link', () => {
    const dir = scratch(), elsewhere = scratch()
    const planted = join(elsewhere, 'daemon-token')
    writeFileSync(planted, `${'1'.repeat(64)}\n`, { mode: 0o600 })
    asWindows(dir, () => {
      expect(ensureDaemonToken(dir)).toHaveLength(32)
    })
    rmSync(daemonTokenPath(dir))
    symlinkSync(planted, daemonTokenPath(dir))
    asWindows(dir, () => {
      expect(readDaemonToken(dir)).toBeNull()
      expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
    })
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/windows/daemonToken.spec.ts`. It fails:
  `daemonTokenPath is not a function`.

- [ ] **Step 3: implementation.** In `cli/src/lib/windows/pipeAuth.ts` add the imports

```ts
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPrivateStateFile, requireWindowsStateFile, secureStateDirectory, syncStateDirectory } from '../secureState.js'
```

and append:

```ts
export const DAEMON_TOKEN_FILE = 'daemon-token'
/** A whole token file: 64 hex digits and a newline. */
const TOKEN_FILE_BYTES = 65

export function daemonTokenPath(dataDir: string): string {
  return join(dataDir, DAEMON_TOKEN_FILE)
}

/**
 * The daemon's token in [dataDir], or null when there is none or it cannot be trusted. On Unix the folder and the file
 * pass secureState's owner and mode checks. On Windows the folder must be inside the profile, and the file must be a
 * real file there, not a link (requireWindowsStateFile). The profile's ACL is the protection, as for the hook
 * credential.
 */
export function readDaemonToken(dataDir: string): Buffer | null {
  try {
    secureStateDirectory(dataDir, false)
    const file = daemonTokenPath(dataDir)
    if (process.platform === 'win32') requireWindowsStateFile(file)
    const text = readPrivateStateFile(file, 128).trim()
    return HEX64.test(text) ? Buffer.from(text, 'hex') : null
  } catch {
    return null
  }
}

/** A token file a crash cut short between its create and its write: a regular file shorter than a whole one. */
function cutShort(file: string): boolean {
  try {
    const entry = lstatSync(file)
    return entry.isFile() && entry.size < TOKEN_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * The daemon's token, made on the first start: 32 random bytes, written owner-only with O_EXCL, so two starts at
 * once agree on one. A token cut short is replaced. Any other file that cannot be read as a token (a link, one
 * another account could write, one outside the profile) is refused: the daemon does not start on it.
 */
export function ensureDaemonToken(dataDir: string): Buffer {
  const existing = readDaemonToken(dataDir)
  if (existing) return existing
  secureStateDirectory(dataDir)
  const file = daemonTokenPath(dataDir)
  if (cutShort(file)) rmSync(file, { force: true })
  const token = randomBytes(32)
  let fd: number
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    const raced = readDaemonToken(dataDir)
    if (raced) return raced
    throw new Error(`the daemon token ${file} cannot be read or replaced: ${(error as Error).message}`)
  }
  try {
    writeFileSync(fd, `${token.toString('hex')}\n`)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncStateDirectory(dataDir)
  return token
}
```

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/windows/daemonToken.spec.ts src/lib/windows/pipeAuth.spec.ts`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/windows/pipeAuth.ts cli/src/lib/windows/daemonToken.spec.ts`
  `git commit -m "feat(cli): the daemon token for the Windows pipe, kept in the profile"`

### Task B2.4: One dead-process proof for the pty host and the daemon

A's `discoveredHostDead` (`cli/src/lib/ptyHost/launch.ts:160-179`) is tied to the pty host's discovery file. The CLI
needs the same proof for the pid in `daemon-<port>.json`. This task moves the proof into a small module that takes
the file. `launch.ts` re-exports the moved names, so no importer changes. The new module stays out of `launch.ts`'s
import graph (env, the pty client), which daemonEndpoint's importers (daemonState, the TUI) must not load.

**Files**
- Create: `cli/src/lib/processProof.ts`
- Create: `cli/src/lib/processProof.spec.ts`
- Modify: `cli/src/lib/ptyHost/launch.ts` (lines 7, 116-179)

**Interfaces**
- Produces: `pidAlive(pid: number): boolean`, `interface HostProcessRow`, `interface HostLiveness`,
  `startMarkerMs(marker: string): number | null`,
  `recordedProcessDead(file: string, pid: number, liveness: HostLiveness): Promise<boolean>`.
- Unchanged: `discoveredHostDead(home, discovery, liveness?)` and every export of `launch.ts`.

- [ ] **Step 1: failing test.** Create `cli/src/lib/processProof.spec.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordedProcessDead } from './processProof.js'

const filetime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('recordedProcessDead', () => {
  it('is proven by a pid that runs nothing, a table without it, or a process started after its file was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proof-'))
    dirs.push(dir)
    const file = join(dir, 'daemon-18473.json')
    writeFileSync(file, '{}')
    const row = (startMarker: string) => ({ pid: 42, executable: 'node.exe', startMarker })
    expect(await recordedProcessDead(file, 42, { alive: () => false })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [] })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row(filetime(Date.now() - 60_000))] })).toBe(false)
    // No proof: a table that cannot be read, a marker that cannot be read, a file that is not there.
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => null })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => { throw new Error('ps') } })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row('soon')] })).toBe(false)
    expect(await recordedProcessDead(join(dir, 'gone.json'), 42, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(false)
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/processProof.spec.ts`. It fails:
  `Failed to load url ./processProof.js`.

- [ ] **Step 3: implementation.** Create `cli/src/lib/processProof.ts` with lines 116-137 and 139-150 of `launch.ts`
  moved verbatim (`pidAlive`, `HostProcessRow`, `HostLiveness`, `startMarkerMs`, `START_SLACK_MS`, with their
  comments; line 138, `DEFAULT_LIVENESS`, stays in `launch.ts`),
  plus the generalized proof:

```ts
/**
 * Whether the process a file names is proven gone, before anything dials the endpoint the file names. Used for the
 * pty host's discovery file (ptyHost/launch.ts `discoveredHostDead`) and the daemon's record on Windows
 * (daemonEndpoint.ts `daemonPipe`). Once its process is gone, any user can create a pipe of the name the file gives.
 */
import { statSync } from 'node:fs'

/** Whether process [pid] exists (EPERM is one that does, another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A process table row, as far as the liveness proof reads it (processTable.ts `ProcessRow`). */
export interface HostProcessRow { pid: number; executable: string; startMarker: string }

/**
 * How a recorded process is proven dead: whether its pid runs, and, when given, the process table. Callers pass the
 * table on Windows only (ptyHostBackend.ts, daemonEndpoint.ts).
 */
export interface HostLiveness {
  alive(pid: number): boolean
  rows?: () => Promise<readonly HostProcessRow[] | null>
}

/** When a process started, in ms since the epoch, from its start marker (`w:<FILETIME>`, or a C-locale `lstart`). */
export function startMarkerMs(marker: string): number | null {
  const windows = /^w:(\d+)$/.exec(marker)
  // FILETIME: 100 ns intervals since 1601-01-01.
  if (windows) return Number(BigInt(windows[1]!) / 10_000n) - 11_644_473_600_000
  const parsed = Date.parse(marker)
  return Number.isFinite(parsed) ? parsed : null
}

/** A marker read to the second (`lstart`) may be up to this much early; a FILETIME is exact. */
const START_SLACK_MS = 2_000

/**
 * Whether the process [pid] that wrote [file] is proven dead. It is proven when the pid runs no process, when the
 * process table has no such pid, or when the process with that pid started after [file] was written (the pid has
 * been given to another process since). No proof (a table that cannot be read, a file that cannot be stat'ed) is not
 * death. The endpoint is dialled as before, and the caller's own check of what answers decides.
 */
export async function recordedProcessDead(file: string, pid: number, liveness: HostLiveness): Promise<boolean> {
  if (!liveness.alive(pid)) return true
  if (!liveness.rows) return false
  const rows = await liveness.rows().catch(() => null)
  if (!rows) return false
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return true
  let written: number
  try {
    written = statSync(file).mtimeMs
  } catch {
    return false
  }
  const started = startMarkerMs(row.startMarker)
  return started !== null && started > written + START_SLACK_MS
}
```

In `cli/src/lib/ptyHost/launch.ts`: delete lines 116-137 and 139-150 (moved). Keep line 138,
`const DEFAULT_LIVENESS: HostLiveness = { alive: (pid) => pidAlive(pid) }`, where it is: it is not moved, and
lines 163, 202, 303 and 326 use it (it now reads the imported `pidAlive` and `HostLiveness`). Remove `statSync` from
the line 7 import only if nothing else uses it; `removeUnusedPtyVersions` (line 375) still does, so it stays. Add after line 14:

```ts
import { pidAlive, recordedProcessDead, startMarkerMs, type HostLiveness, type HostProcessRow } from '../processProof.js'

// Moved to ../processProof.ts with the daemon's own record; still exported from here for the pty host's callers.
export { pidAlive, startMarkerMs, type HostLiveness, type HostProcessRow }
```

and replace the body of `discoveredHostDead` (lines 165-178) with:

```ts
  return recordedProcessDead(path.join(home, 'run', `pty-host-${discovery.protocol}.json`), discovery.pid, liveness)
```

Keep its doc comment (lines 152-159) as it is.

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/processProof.spec.ts src/lib/ptyHost/launch.spec.ts src/lib/ptyHostBackend.spec.ts && npx tsc --noEmit`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/processProof.ts cli/src/lib/processProof.spec.ts cli/src/lib/ptyHost/launch.ts`
  `git commit -m "refactor(cli): the dead-process proof takes any recorded file, for the daemon's record too"`

### Task B2.5: The daemon serves an authenticated pipe

**Files**
- Modify: `cli/src/lib/localSocket.ts` (header comment lines 1-12; imports lines 13-19; `trustedSockets` line 39;
  `isTrustedLocal` lines 48-53; `listenLocalSocket` lines 64-69)
- Create: `cli/src/lib/windows/pipeTransport.spec.ts`

**Interfaces**
- Consumes: B2.1.
- Produces: `listenLocalSocket(handler, path, options?: ListenLocalSocketOptions)` with
  `interface ListenLocalSocketOptions { token?: Buffer }`; `pipeProofOf(req: IncomingMessage): string | undefined`.
  `isTrustedLocal(req)` is true for a pipe request whose auth checked out (contract). Without `token` nothing changes.

- [ ] **Step 1: failing test.** Create `cli/src/lib/windows/pipeTransport.spec.ts`. On Windows it runs on a real
  pipe; elsewhere it runs on a Unix socket with a pipe's name. The Windows workflow runs `src/lib/windows`.

```ts
import { randomBytes } from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTrustedLocal, listenLocalSocket, pipeProofOf, type LocalSocketServer } from '../localSocket.js'
import { newPipeNonce, newPipePath, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeAuthValue, pipeProofValue } from './pipeAuth.js'

const dirs: string[] = []
const opened: LocalSocketServer[] = []
afterEach(async () => {
  for (const server of opened.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A real pipe on Windows; elsewhere a Unix socket with a pipe's name, which the auth layer cannot tell apart. */
function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hpipe-')
  dirs.push(dir)
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path, path: '/x', headers, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path, path: '/api/local-ws', agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.headers) })
    request.on('error', reject)
    request.end()
  })
}

describe('the daemon pipe', () => {
  it('serves a request that proves the token, trusts it, and answers with the proof', async () => {
    const path = endpoint(), token = randomBytes(32)
    let trusted: boolean | null = null
    opened.push(await listenLocalSocket((req, res) => { trusted = isTrustedLocal(req); res.end('hi') }, path, { token }))
    const nonce = newPipeNonce(path)
    const reply = await raw(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) })
    expect(reply).toMatchObject({ status: 200, body: 'hi' })
    expect(reply.headers[PIPE_PROOF_HEADER]).toBe(pipeProofValue(token, nonce))
    expect(trusted).toBe(true)
  })

  it('answers 401 to a request without auth, with another token, for another pipe or with a nonce used before', async () => {
    const path = endpoint(), token = randomBytes(32)
    let served = 0
    opened.push(await listenLocalSocket((_req, res) => { served++; res.end('hi') }, path, { token }))
    const used = newPipeNonce(path)
    expect((await raw(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, used) })).status).toBe(200)
    for (const headers of [{}, { [PIPE_AUTH_HEADER]: pipeAuthValue(randomBytes(32), newPipeNonce(path)) },
      { [PIPE_AUTH_HEADER]: pipeAuthValue(token, newPipeNonce(endpoint())) },
      { [PIPE_AUTH_HEADER]: pipeAuthValue(token, used) }]) {
      const reply = await raw(path, headers)
      expect(reply.status).toBe(401)
      expect(JSON.parse(reply.body)).toEqual({ error: 'PIPE_AUTH_REQUIRED' })
      expect(reply.headers[PIPE_PROOF_HEADER]).toBeUndefined()
    }
    expect(served).toBe(1)
  })

  it('drops an upgrade without auth before any other listener, and hands one with it on, trusted', async () => {
    const path = endpoint(), token = randomBytes(32)
    const pipe = await listenLocalSocket((_req, res) => res.end(), path, { token })
    opened.push(pipe)
    // Nothing else takes upgrades yet: even an authenticated one is closed, never left hanging.
    await expect(upgrade(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, newPipeNonce(path)) })).rejects.toThrow()
    const seen: Array<{ trusted: boolean; destroyed: boolean }> = []
    pipe.server.on('upgrade', (req: http.IncomingMessage, socket) => {
      seen.push({ trusted: isTrustedLocal(req), destroyed: socket.destroyed })
      if (!socket.destroyed) socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${PIPE_PROOF_HEADER}: ${pipeProofOf(req)}\r\n\r\n`)
    })
    await expect(upgrade(path)).rejects.toThrow()
    const nonce = newPipeNonce(path)
    expect((await upgrade(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) }))[PIPE_PROOF_HEADER]).toBe(pipeProofValue(token, nonce))
    expect(seen).toEqual([{ trusted: false, destroyed: true }, { trusted: true, destroyed: false }])
  })

  it('refuses to listen on a name that is not a Harness pipe', async () => {
    const dir = mkdtempSync('/tmp/hpipe-')
    dirs.push(dir)
    await expect(listenLocalSocket((_req, res) => res.end(), join(dir, 'daemon.sock'), { token: randomBytes(32) })).rejects.toThrow(/not a Harness pipe name/)
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/windows/pipeTransport.spec.ts`. Today's
  `listenLocalSocket` ignores the third argument and serves an ordinary Unix socket (on Windows the listen itself
  fails). The tests fail as follows: the first finds no proof header (`expected undefined to be '…'`); the second
  gets 200 where it expects 401; the third expects an upgrade to be dropped and it is not; the fourth gets no
  rejection for `daemon.sock`.

- [ ] **Step 3: implementation.** In `cli/src/lib/localSocket.ts`:

Lines 10-11 of the header comment become:

```ts
 * TCP stays: the CLI, engine hooks and scripts still use it, as do app builds that predate this. On Windows the
 * daemon serves a named pipe instead (`listenAuthenticated` below). Reaching that pipe is no credential, so every
 * request over it proves the daemon's token (lib/windows/pipeAuth.ts).
```

Imports (lines 13-19) become:

```ts
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { connect } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { chmodSync, linkSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkPipeAuth, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeIdOf, pipeProofValue } from './windows/pipeAuth.js'
```

After line 39 (`const trustedSockets = …`):

```ts
/** Requests over the daemon's pipe whose auth checked out, and the proof each answer to them carries. */
const pipeProofs = new WeakMap<IncomingMessage, string>()
```

`isTrustedLocal` (lines 48-53) becomes:

```ts
/** Whether this request (or raw socket) came in over the daemon's own Unix socket, or over its pipe with valid auth. */
export function isTrustedLocal(target: IncomingMessage | Socket | null | undefined): boolean {
  if (!target) return false
  if (pipeProofs.has(target as IncomingMessage)) return true
  const socket = 'socket' in target && target.socket ? target.socket : target as Socket
  return trustedSockets.has(socket)
}

/** The proof every answer to [req] must carry, for a request over the daemon's pipe whose auth checked out. */
export function pipeProofOf(req: IncomingMessage): string | undefined {
  return pipeProofs.get(req)
}

export interface ListenLocalSocketOptions {
  /**
   * The daemon's token (lib/windows/pipeAuth.ts). When given, `path` is a pipe (in the tests, a socket with a pipe's
   * name) whose every request must prove the token: Windows. Absent: the Unix socket, trusted by its file mode.
   */
  token?: Buffer
}
```

`listenLocalSocket`'s signature (line 69) becomes, with its first statement:

```ts
export async function listenLocalSocket(handler: http.RequestListener, path: string, options: ListenLocalSocketOptions = {}): Promise<LocalSocketServer> {
  if (options.token) return listenAuthenticated(handler, path, options.token)
```

and after `listenLocalSocket` (after line 117) add:

```ts
/**
 * The daemon's Windows pipe: the same handler, for requests that prove the token. Node cannot set a pipe's DACL,
 * and the default one lets every account open it for reading, so reaching the pipe is no credential. A request
 * without valid auth gets a 401 and never reaches the handler. An upgrade without valid auth is dropped here,
 * before the local WS server's listener (localWsServer.ts), which then finds its socket destroyed. Every answer
 * carries the proof; the local WS server adds it to a 101. There is no file to claim or remove: the name is new on
 * each start (localSocketListenPath), and a pipe goes with its last handle.
 */
function listenAuthenticated(handler: http.RequestListener, path: string, token: Buffer): Promise<LocalSocketServer> {
  const pipeId = pipeIdOf(path)
  if (!pipeId) return Promise.reject(new Error(`${path} is not a Harness pipe name`))
  const seen = new NonceWindow()
  const admit = (req: IncomingMessage): boolean => {
    const header = req.headers[PIPE_AUTH_HEADER]
    const auth = checkPipeAuth(token, typeof header === 'string' ? header : undefined, seen, pipeId)
    if (auth) pipeProofs.set(req, pipeProofValue(token, auth.nonce))
    return auth !== null
  }
  const server = http.createServer((req, res) => {
    if (!admit(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error: 'PIPE_AUTH_REQUIRED' }))
      return
    }
    res.setHeader(PIPE_PROOF_HEADER, pipeProofs.get(req)!)
    handler(req, res)
  })
  server.prependListener('upgrade', (req: IncomingMessage, socket: Duplex) => {
    // Alone, this listener would leave an upgrade nobody takes hanging: nothing serves upgrades here yet.
    if (!admit(req) || server.listenerCount('upgrade') === 1) socket.destroy()
  })
  const closeNow = (): void => {
    server.closeAllConnections()
    server.close()
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve({ server, path, close: async () => closeNow(), closeSync: closeNow })
    })
  })
}
```

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/windows/pipeTransport.spec.ts src/lib/localSocket.spec.ts src/hookServer.spec.ts src/localWsServer.spec.ts`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/localSocket.ts cli/src/lib/windows/pipeTransport.spec.ts`
  `git commit -m "feat(cli): the daemon's pipe serves only requests that prove its token"`

### Task B2.6: A client that checks the proof

**Files**
- Create: `cli/src/lib/windows/pipeClient.ts`
- Create: `cli/src/lib/windows/pipeClient.spec.ts`

**Interfaces**
- Consumes: B2.1, B2.5 (in the test).
- Produces: `interface PipeTarget { pipe: string; token: Buffer }`,
  `interface PipeRequest { method: string; path: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }`,
  `interface PipeReply { status: number; headers: IncomingHttpHeaders; body: string }`,
  `pipeRequest(target: PipeTarget, request: PipeRequest): Promise<PipeReply>`,
  `class PipeUnproven extends Error { code: 'PIPE_UNPROVEN' }`, `pipeAbsent(error: unknown): boolean`.
  B3 (stop over the pipe) and phase C consume these.

- [ ] **Step 1: failing test.** Create `cli/src/lib/windows/pipeClient.spec.ts`:

```ts
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenLocalSocket } from '../localSocket.js'
import { newPipePath } from './pipeAuth.js'
import { pipeAbsent, pipeRequest, PipeUnproven } from './pipeClient.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hpipe-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

describe('pipeRequest', () => {
  it('sends the request with its auth and returns the answer once the daemon has proven itself', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    let got = ''
    const server = await listenLocalSocket((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => { got = `${req.method} ${req.url} ${req.headers['content-type']} ${body}`; res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
    }, pipe, { token })
    cleanup.push(server.close)
    const reply = await pipeRequest({ pipe, token }, { method: 'POST', path: '/api/pair', headers: { 'content-type': 'application/json' }, body: '{"code":"x"}' })
    expect(reply.status).toBe(201)
    expect(reply.body).toBe('{"ok":true}')
    expect(reply.headers['content-type']).toBe('application/json')
    expect(got).toBe('POST /api/pair application/json {"code":"x"}')
  })

  it('rejects an answer without the proof: another token\'s daemon, or whatever took the name', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    const daemon = await listenLocalSocket((_req, res) => res.end('{}'), pipe, { token: randomBytes(32) })
    cleanup.push(daemon.close)
    await expect(pipeRequest({ pipe, token }, { method: 'GET', path: '/api/status' })).rejects.toBeInstanceOf(PipeUnproven)
    const squatted = endpoint()
    const squatter = http.createServer((_req, res) => res.end('{"pid":1}'))
    await new Promise<void>((resolve) => squatter.listen(squatted, resolve))
    cleanup.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))
    const error = await pipeRequest({ pipe: squatted, token }, { method: 'GET', path: '/api/status' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PipeUnproven)
    expect((error as PipeUnproven).code).toBe('PIPE_UNPROVEN')
    expect(pipeAbsent(error)).toBe(false)
  })

  it('says when nothing listens there, and refuses an answer past its size', async () => {
    const error = await pipeRequest({ pipe: endpoint(), token: randomBytes(32) }, { method: 'GET', path: '/' }).catch((e: unknown) => e)
    expect(pipeAbsent(error)).toBe(true)
    const pipe = endpoint(), token = randomBytes(32)
    const server = await listenLocalSocket((_req, res) => res.end('x'.repeat(2048)), pipe, { token })
    cleanup.push(server.close)
    await expect(pipeRequest({ pipe, token }, { method: 'GET', path: '/', maxBytes: 1024 })).rejects.toThrow(/too large/)
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/windows/pipeClient.spec.ts`. It fails:
  `Failed to load url ./pipeClient.js`.

- [ ] **Step 3: implementation.** Create `cli/src/lib/windows/pipeClient.ts`:

```ts
/**
 * One HTTP request to the daemon's Windows pipe (lib/localSocket.ts `listenAuthenticated`). It sends a fresh auth,
 * and takes the answer only when it proves the token. The request has reached whatever listens by then. That is
 * why callers first check that the daemon in the record is not proven gone (daemonEndpoint.ts `daemonPipe`).
 */
import http, { type IncomingHttpHeaders } from 'node:http'
import { newPipeNonce, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven } from './pipeAuth.js'

export interface PipeTarget { pipe: string; token: Buffer }
export interface PipeRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  /** 30 s by default. */
  timeoutMs?: number
  /** 4 MiB by default. */
  maxBytes?: number
}
export interface PipeReply { status: number; headers: IncomingHttpHeaders; body: string }

/** Something answered on the pipe without the daemon's proof: it is not this user's daemon. */
export class PipeUnproven extends Error {
  readonly code = 'PIPE_UNPROVEN'
  constructor(pipe: string) {
    super(`Something other than Harness answered on its local pipe (${pipe}). Restart Harness: harness stop && harness start`)
  }
}

/** Whether [error] is nothing listening at the endpoint, so the request never reached anything. */
export function pipeAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

export function pipeRequest(target: PipeTarget, request: PipeRequest): Promise<PipeReply> {
  const nonce = newPipeNonce(target.pipe)
  const maxBytes = request.maxBytes ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      socketPath: target.pipe,
      method: request.method,
      path: request.path,
      agent: false,
      headers: { ...request.headers, [PIPE_AUTH_HEADER]: pipeAuthValue(target.token, nonce) },
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    }, (response) => {
      // Before the body is read: an answer that is not the daemon's is never taken. Each reject comes before its
      // destroy, so the error the caller sees is this one, not the aborted response's.
      if (!pipeProven(response.headers, target.token, nonce)) {
        reject(new PipeUnproven(target.pipe))
        outgoing.destroy()
        return
      }
      let body = ''
      let bytes = 0
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes <= maxBytes) { body += chunk; return }
        reject(new Error(`the daemon's answer is too large (over ${maxBytes} bytes)`))
        outgoing.destroy()
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    outgoing.on('error', reject)
    outgoing.end(request.body)
  })
}
```

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/windows/pipeClient.spec.ts`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/windows/pipeClient.ts cli/src/lib/windows/pipeClient.spec.ts`
  `git commit -m "feat(cli): pipe client that takes only an answer proving the daemon token"`

### Task B2.7: The local WS proves the token in its 101

**Files**
- Modify: `cli/src/localWsServer.ts` (import line 9; after the `WebSocketServer` at lines 290-296)
- Modify: `cli/src/localWsServer.spec.ts` (imports lines 1-12; new test after the daemon-socket test ending at line 167)

**Interfaces**
- Consumes: `pipeProofOf` (B2.5), `PIPE_PROOF_HEADER` (B2.1).

- [ ] **Step 1: failing test.** In `cli/src/localWsServer.spec.ts` add the imports

```ts
import { randomBytes } from 'node:crypto'
import { newPipeNonce, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven } from './lib/windows/pipeAuth.js'
```

and after the test `'serves the same endpoint over the daemon socket, …'` (ends line 167):

```ts
  it('over the Windows pipe, proves the daemon token in the upgrade and drops one without auth', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const pipePath = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const token = randomBytes(32)
    const backend = new FakeBackend()
    const pipe = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, pipePath, { token })
    await start(backend, { localSocketServer: pipe.server })
    const createConnection = () => net.connect(pipePath)
    try {
      const nonce = newPipeNonce(pipePath)
      const ws = new WebSocket('ws://localhost/api/local-ws', { createConnection, headers: { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) } })
      const upgraded = new Promise<http.IncomingMessage>((resolve) => ws.once('upgrade', resolve))
      await onceOpen(ws)
      expect(pipeProven((await upgraded).headers, token, nonce)).toBe(true)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
      expect(await connected).toMatchObject({ type: 'connected', payload: { machineId, transport: 'local' } })
      ws.close()
      const stranger = new WebSocket('ws://localhost/api/local-ws', { createConnection })
      await expect(onceOpen(stranger)).rejects.toThrow()
    } finally {
      await local?.close()
      local = null
      await pipe.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/localWsServer.spec.ts -t "Windows pipe"`. It fails:
  `expected false to be true`. The 101 has no proof header.

- [ ] **Step 3: implementation.** In `cli/src/localWsServer.ts`, line 9 becomes
  `import { isTrustedLocal, pipeProofOf } from './lib/localSocket.js'` and add the import
  `import { PIPE_PROOF_HEADER } from './lib/windows/pipeAuth.js'`. After the `WebSocketServer` constructor (after
  line 296):

```ts
  // Over the Windows pipe every answer proves the daemon's token (lib/windows/pipeAuth.ts), and so does the 101: a
  // client drops a connection whose upgrade carries no proof. Nothing is added on TCP or the Unix socket.
  wss.on('headers', (headers, req) => {
    const proof = pipeProofOf(req)
    if (proof) headers.push(`${PIPE_PROOF_HEADER}: ${proof}`)
  })
```

Also extend the comment at lines 310-311 to say "…or, on Windows, the request proved the daemon's token over its pipe".

- [ ] **Step 4: run, expect pass.** `npx vitest run src/localWsServer.spec.ts`.

- [ ] **Step 5: commit.**
  `git add cli/src/localWsServer.ts cli/src/localWsServer.spec.ts`
  `git commit -m "feat(cli): the local WS upgrade over the Windows pipe carries the daemon's proof"`

### Task B2.8: The daemon record names the pipe; socket paths split by use

`localSocketPath()` on win32 returns the pipe the running daemon recorded (contract). Six callers assume a
filesystem socket: `ws+unix://` URLs, `existsSync`, and the services' socket. They move to `unixSocketPath()`, which
keeps today's meaning. It is identical on mac/Linux and null on Windows, so their behavior does not change on any OS.
The core's own listen (`core/main.ts:1935`) moves to `unixSocketPath()` too, until B2.10 gives it the listen path.

**Files**
- Create: `cli/src/lib/daemonRecord.ts`
- Modify: `cli/src/lib/daemonEndpoint.ts` (lines 1-30)
- Modify: `cli/src/lib/daemonEndpoint.spec.ts` (new test after line 70)
- Modify: `cli/src/lib/localSocket.ts` (lines 41-46)
- Modify: `cli/src/lib/localSocket.spec.ts` (imports lines 6-9; new test in `describe('localSocketPath')` after line 65)
- Modify: `cli/src/masterProcess.ts` (lines 23, 79), `cli/src/serviceProcess.ts` (lines 15, 83),
  `cli/src/serviceProcess.spec.ts` (line 7), `cli/src/messages/rpc.ts` (lines 9, 17),
  `cli/src/agentClient/daemon.ts` (lines 14, 60), `cli/src/core/main.ts` (lines 200, 1935)

**Interfaces**
- Produces: `daemonRecord.ts`: `interface DaemonRecord { port: number; pipe: string | null; pid: number | null }`,
  `interface DaemonPipeRecord { pipe: string; pid: number }`, `daemonRecordPath(dataDir, configuredPort): string`,
  `readDaemonRecord(dataDir, configuredPort): DaemonRecord | null`,
  `writeDaemonRecord(dataDir, configuredPort, port, pipe?: DaemonPipeRecord): void`.
- `saveDaemonPort(dataDir, configuredPort, port, pipe?: DaemonPipeRecord)` (new optional parameter).
- `localSocket.ts`: `unixSocketPath(dataDir, port, platform?)` (old `localSocketPath` body),
  `localSocketPath(dataDir, port, platform?)` (win32: recorded pipe), `localSocketListenPath(dataDir, port, platform?)`.

- [ ] **Step 1: failing tests.**

`cli/src/lib/daemonEndpoint.spec.ts`, add `readDaemonRecord` (from `./daemonRecord.js`) to the imports, and after line 70:

```ts
  it('records the Windows pipe and the core\'s pid beside the port, and reads only a pipe name back', () => {
    const dir = directory()
    const pipe = `\\\\.\\pipe\\harness-${'a'.repeat(32)}`
    saveDaemonPort(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(JSON.parse(readFileSync(join(dir, 'daemon-18473.json'), 'utf8'))).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(savedDaemonPort(dir, 18473)).toBe(24567)
    writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 24567, pipe: 'C:\\evil', pid: -1 }))
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe: null, pid: null })
    saveDaemonPort(dir, 18473, 24568)
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24568, pipe: null, pid: null })
    expect(readDaemonRecord(dir, 18474)).toBeNull()
  })
```

`cli/src/lib/localSocket.spec.ts`: add `localSocketListenPath, unixSocketPath` to the import on lines 6-9, add
`import { writeDaemonRecord } from './daemonRecord.js'` and `import { newPipePath } from './windows/pipeAuth.js'`,
and inside `describe('localSocketPath')` after line 65:

```ts
  it('on Windows, names the pipe the running daemon recorded, and a new pipe for each start', () => {
    const dir = shortDir()
    expect(localSocketPath(dir, 18473, 'win32')).toBeNull()
    const pipe = newPipePath()
    writeDaemonRecord(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(localSocketPath(dir, 18473, 'win32')).toBe(pipe)
    expect(localSocketPath(dir, 18474, 'win32')).toBeNull()
    // The filesystem socket the services and ws+unix clients use: none on Windows, the same everywhere else.
    expect(unixSocketPath(dir, 18473, 'win32')).toBeNull()
    expect(unixSocketPath(dir, 18473, 'darwin')).toBe(join(dir, LOCAL_SOCKET_NAME))
    expect(localSocketPath(dir, 18473, 'darwin')).toBe(join(dir, LOCAL_SOCKET_NAME))
    const first = localSocketListenPath(dir, 18473, 'win32')
    expect(first).toMatch(/^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/)
    expect(localSocketListenPath(dir, 18473, 'win32')).not.toBe(first)
    expect(localSocketListenPath(dir, 18473, 'linux')).toBe(join(dir, LOCAL_SOCKET_NAME))
  })
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/daemonEndpoint.spec.ts src/lib/localSocket.spec.ts`.
  The imports fail: `Failed to load url ./daemonRecord.js`.

- [ ] **Step 3: implementation.**

Create `cli/src/lib/daemonRecord.ts`:

```ts
/**
 * `daemon-<configured port>.json` in this user's data folder. It holds the TCP port the daemon actually bound
 * (another OS user's daemon may hold the configured one). On Windows it also holds the daemon's pipe and the core's
 * pid (lib/windows/pipeAuth.ts). Both are new on each start, so a client cannot derive them as it derives a Unix
 * socket's path. Written once the core is bound.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeIdOf } from './windows/pipeAuth.js'

export interface DaemonRecord { port: number; pipe: string | null; pid: number | null }
export interface DaemonPipeRecord { pipe: string; pid: number }

export function daemonRecordPath(dataDir: string, configuredPort: number): string {
  return join(dataDir, `daemon-${configuredPort}.json`)
}

/** The record, or null when there is none or its port is not one. A `pipe` that is no Harness pipe name reads as null. */
export function readDaemonRecord(dataDir: string, configuredPort: number): DaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(daemonRecordPath(dataDir, configuredPort), 'utf8')) as Record<string, unknown> | null
    const port = value?.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    const pipe = typeof value?.pipe === 'string' && pipeIdOf(value.pipe) ? value.pipe : null
    const pid = typeof value?.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null
    return { port, pipe, pid }
  } catch {
    return null // a first start, or an unreadable old record
  }
}

export function writeDaemonRecord(dataDir: string, configuredPort: number, port: number, pipe?: DaemonPipeRecord): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const target = daemonRecordPath(dataDir, configuredPort)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(pipe ? { port, pipe: pipe.pipe, pid: pipe.pid } : { port }) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}
```

`cli/src/lib/daemonEndpoint.ts` lines 1-30 become (the rest of the file is unchanged in this task):

```ts
import { request } from 'node:http'
import { lstatSync } from 'node:fs'
import { localSocketPath } from './localSocket.js'
import { readDaemonRecord, writeDaemonRecord, type DaemonPipeRecord } from './daemonRecord.js'

// The configured port names the private socket. TCP may use another port when a different OS
// user's daemon already holds that number; remember it in THIS user's data directory (lib/daemonRecord.ts).
export function savedDaemonPort(dataDir: string, configuredPort: number): number {
  return readDaemonRecord(dataDir, configuredPort)?.port ?? configuredPort
}

/** [pipe]: on Windows, the daemon's pipe and the core's pid, which a client cannot derive. */
export function saveDaemonPort(dataDir: string, configuredPort: number, port: number, pipe?: DaemonPipeRecord): void {
  writeDaemonRecord(dataDir, configuredPort, port, pipe)
}
```

`cli/src/lib/localSocket.ts`: add `import { readDaemonRecord } from './daemonRecord.js'` and `newPipePath` to the
`./windows/pipeAuth.js` import, then replace lines 41-46 with:

```ts
/** The daemon's Unix socket for `port` in this data directory, or null where there is none: Windows, or a path too long. */
export function unixSocketPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  const path = join(dataDir, localSocketName(port))
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES ? path : null
}

/**
 * Where a client reaches the daemon on `port` of this data directory, or null where there is nothing to reach. That
 * is its Unix socket; on Windows, the pipe the running daemon recorded in `daemon-<port>.json`, a new name on each
 * start. Reaching that pipe is no trust: every request there proves the daemon's token (lib/windows/pipeAuth.ts).
 * A caller that needs a filesystem socket (`ws+unix://`, the services) uses unixSocketPath.
 */
export function localSocketPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? readDaemonRecord(dataDir, port)?.pipe ?? null : unixSocketPath(dataDir, port, platform)
}

/** Where a daemon starting on `port` listens: its Unix socket, or on Windows a pipe of a new random name. */
export function localSocketListenPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? newPipePath() : unixSocketPath(dataDir, port, platform)
}
```

Callers that need a filesystem socket switch to `unixSocketPath` (import and call, nothing else):
- `cli/src/masterProcess.ts:23` `import { unixSocketPath } from './lib/localSocket.js'`;
  `:79` `env: masterEnv(process.env, unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT)),`. On Windows the services
  stay in the core's process, as today.
- `cli/src/serviceProcess.ts:15` `import { unixSocketPath } from './lib/localSocket.js'`;
  `:83` `const socketPath = unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT)`.
- `cli/src/serviceProcess.spec.ts:7` `vi.mock('./lib/localSocket.js', async (real) => ({ ...await real<object>(), unixSocketPath: () => local.socket }))`.
- `cli/src/messages/rpc.ts:9` `import { unixSocketPath } from '../lib/localSocket.js'`;
  `:17` `const socketPath = target.dataDir ? unixSocketPath(target.dataDir, target.port) : null`.
- `cli/src/agentClient/daemon.ts:14` `import { unixSocketPath } from '../lib/localSocket.js'`;
  `:60` `const path = unixSocketPath(where.dataDir, where.port)`.
- `cli/src/core/main.ts:200` adds `unixSocketPath` to the `../lib/localSocket.js` import; `:1935` becomes
  `}, { socketPath: unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT), allowPortFallback: true })`. Until B2.10 the core
  listens where it does today (a Unix socket, none on Windows). Left on `localSocketPath`, a Windows core would listen
  on the previous daemon's recorded pipe between this task and B2.10. Line 496 (`refuseServedDataFolder`) keeps
  `localSocketPath`: it asks the recorded pipe, which is B2.9's change.

- [ ] **Step 4: run, expect pass.**
  `npx vitest run src/lib/daemonEndpoint.spec.ts src/lib/localSocket.spec.ts src/masterProcess.spec.ts src/serviceProcess.spec.ts src/messages/rpc.spec.ts src/agentClient/daemon.spec.ts src/multiUserDaemon.spec.ts src/authCommand.spec.ts src/cliCommand.spec.ts && npx tsc --noEmit`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/daemonRecord.ts cli/src/lib/daemonEndpoint.ts cli/src/lib/daemonEndpoint.spec.ts cli/src/lib/localSocket.ts cli/src/lib/localSocket.spec.ts cli/src/masterProcess.ts cli/src/serviceProcess.ts cli/src/serviceProcess.spec.ts cli/src/messages/rpc.ts cli/src/agentClient/daemon.ts cli/src/core/main.ts`
  `git commit -m "feat(cli): the daemon record names the Windows pipe; filesystem-socket callers keep their path"`

### Task B2.9: Start-up asks the recorded pipe who serves the data folder, with auth

`refuseServedDataFolder(localSocketPath(...))` (`cli/src/core/main.ts:496`, `cli/src/cli.ts:1416`) now gets the
recorded pipe on Windows. An unauthenticated ask would get a 401. Anything that took the name could also answer as
"unknown" and keep the daemon from ever starting. The ask therefore sends the auth, and an answer without the proof
counts as nothing serving.

**Files**
- Modify: `cli/src/lib/localSocket.ts` (`askDataFolderServer` lines 181-205; after `SERVED_FOLDER_DEFAULTS` lines 207-213)
- Modify: `cli/src/lib/localSocket.spec.ts` (new `describe` at the end; imports)
- Modify: `cli/src/core/main.ts` (lines 200, 496), `cli/src/cli.ts` (lines 73, 1416)

**Interfaces**
- Produces: `askDataFolderServer(path, timeoutMs, token?: Buffer | null)`,
  `servedFolderDeps(dataDir: string, platform?: NodeJS.Platform): ServedFolderDeps`.
- Consumes: `readDaemonToken` (B2.3), `pipeIdOf` (B2.1), `pipeRequest`, `PipeUnproven`, `pipeAbsent` (B2.6).

- [ ] **Step 1: failing test.** In `cli/src/lib/localSocket.spec.ts` add the imports
  `import { randomBytes } from 'node:crypto'`, `import { createServer } from 'node:http'` (merge with line 1),
  `servedFolderDeps` (from `./localSocket.js`), and `ensureDaemonToken` (from `./windows/pipeAuth.js`). Then append:

```ts
describe('who serves a data folder, over the Windows pipe', () => {
  it('asks with the token, and takes only an answer that proves it', async () => {
    const dir = shortDir()
    const token = ensureDaemonToken(dir)
    const path = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const status = { pid: 4242, corePid: 4243 }
    opened.push(await listenLocalSocket((_req, res) => res.end(JSON.stringify(status)), path, { token }))
    expect(await askDataFolderServer(path, 1_000, token)).toEqual(status)
    // Another token: a 401 without the proof, which is not this data folder's daemon.
    expect(await askDataFolderServer(path, 1_000, randomBytes(32))).toBe('none')
    // Whatever took a dead daemon's name: no proof, so nothing serves, and start-up goes on.
    const squatted = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const squatter = createServer((_req, res) => res.end(JSON.stringify(status)))
    await new Promise<void>((resolve) => squatter.listen(squatted, resolve))
    try {
      expect(await askDataFolderServer(squatted, 1_000, token)).toBe('none')
    } finally {
      squatter.close()
    }
    expect(servedFolderDeps(dir, 'darwin').who).toBe(askDataFolderServer)
    expect(await servedFolderDeps(dir, 'win32').who(path, 1_000)).toEqual(status)
    // No token in that folder: no daemon has started there.
    expect(await servedFolderDeps(shortDir(), 'win32').who(path, 1_000)).toBe('none')
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/localSocket.spec.ts -t "Windows pipe"`. It fails:
  `servedFolderDeps is not a function`, and the first ask gets `'unknown'` from the 401.

- [ ] **Step 3: implementation.** In `cli/src/lib/localSocket.ts` add `pipeIdOf, readDaemonToken` to the
  `./windows/pipeAuth.js` import, and add `import { pipeAbsent, pipeRequest, PipeUnproven } from './windows/pipeClient.js'`
  (B2.6; `pipeClient.ts` imports only `pipeAuth.js`, so there is no cycle). The proof-checked request is B2.6's
  `pipeRequest`, not a second copy of its nonce, auth and proof handling. Replace `askDataFolderServer`
  (lines 181-205) with:

```ts
/** What a status answer says: a daemon and its master, or `unknown` when it does not say both pids. */
function folderServerOf(body: string): DataFolderServer {
  try {
    const status = JSON.parse(body) as { pid?: unknown; corePid?: unknown }
    const pid = Number(status.pid)
    // A daemon from before harnessd says no core of its own: it is its own master.
    const corePid = status.corePid === undefined ? pid : Number(status.corePid)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(corePid) && corePid > 0 ? { pid, corePid } : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Ask the daemon on a data folder's socket who it is. A socket that takes no connection serves nothing
 *  (no socket, a stale one, one that cannot be reached: start-up goes on, and the bind decides); one that
 *  takes it and does not say is `unknown`. With [token] the socket is the Windows pipe: see [askPipeServer]. */
export function askDataFolderServer(path: string, timeoutMs: number, token: Buffer | null = null): Promise<DataFolderServer> {
  if (token) return askPipeServer(path, timeoutMs, token)
  return new Promise((resolve) => {
    let connected = false
    // A connection of its own, never one kept alive from an earlier ask: that one may be to a daemon gone.
    const request = http.request({ socketPath: path, path: '/api/status', method: 'GET', timeout: timeoutMs, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { if (body.length < 65_536) body += chunk })
      response.on('end', () => resolve(folderServerOf(body)))
      response.on('error', () => resolve('unknown'))
    })
    request.on('socket', (socket: Socket) => socket.once('connect', () => { connected = true }))
    request.on('timeout', () => { request.destroy(); resolve(connected ? 'unknown' : 'none') })
    request.on('error', () => resolve(connected ? 'unknown' : 'none'))
    request.end()
  })
}

/**
 * The Windows pipe: the ask proves the token and takes only an answer with the daemon's proof (pipeClient.ts).
 * An answer without it serves nothing: whatever took a dead daemon's name must not keep this one down. So does a
 * name that is no Harness pipe, or nothing listening there. Anything else, once the ask reached a listener (no
 * answer in time, one too large), is `unknown`, as on a Unix socket.
 */
async function askPipeServer(pipe: string, timeoutMs: number, token: Buffer): Promise<DataFolderServer> {
  if (!pipeIdOf(pipe)) return 'none'
  try {
    const reply = await pipeRequest({ pipe, token }, { method: 'GET', path: '/api/status', timeoutMs, maxBytes: 65_536 })
    return folderServerOf(reply.body)
  } catch (error) {
    return error instanceof PipeUnproven || pipeAbsent(error) ? 'none' : 'unknown'
  }
}
```

The Unix path is lines 181-205 as they are, with the status parse moved into `folderServerOf`. The new parts are
the `token` parameter and `askPipeServer`.

After `SERVED_FOLDER_DEFAULTS` (line 213):

```ts
/**
 * What `refuseServedDataFolder` asks with for the daemon of [dataDir]. On Windows it asks with that folder's token,
 * and with no token there, nothing serves it (the core makes the token before it listens). Elsewhere it asks as it
 * always has.
 */
export function servedFolderDeps(dataDir: string, platform: NodeJS.Platform = process.platform): ServedFolderDeps {
  if (platform !== 'win32') return SERVED_FOLDER_DEFAULTS
  return {
    ...SERVED_FOLDER_DEFAULTS,
    who: (path, timeoutMs) => {
      const token = readDaemonToken(dataDir)
      return token ? askDataFolderServer(path, timeoutMs, token) : Promise.resolve('none')
    },
  }
}
```

`cli/src/core/main.ts:200` adds `servedFolderDeps` to the import, and line 496 becomes
`await refuseServedDataFolder(localSocketPath(env.ADAPTER_DATA_DIR, env.PORT), 1_000, servedFolderDeps(env.ADAPTER_DATA_DIR))`.
`cli/src/cli.ts:73` adds `servedFolderDeps` to the import, and line 1416 becomes the same call.
`startupOrder.spec.ts` looks for `await refuseServedDataFolder(` (line 168), which still matches.

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/localSocket.spec.ts src/startupOrder.spec.ts src/cliCommand.spec.ts && npx tsc --noEmit`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/localSocket.ts cli/src/lib/localSocket.spec.ts cli/src/core/main.ts cli/src/cli.ts`
  `git commit -m "feat(cli): start-up asks the recorded Windows pipe with auth and ignores an unproven answer"`

### Task B2.10: The core listens on the pipe and records it

**Files**
- Modify: `cli/src/hookServer.ts` (options lines 372-381; comment lines 416-417; listen line 1200)
- Modify: `cli/src/hookServer.spec.ts` (imports lines 1-11; new test after line 751 in `describe('the daemon socket')`)
- Modify: `cli/src/core/main.ts` (imports lines 200-201; before line 1848; lines 1935-1936)

**Interfaces**
- Produces: `HookServerOptions.pipeToken?: Buffer | null`.
- Consumes: `ensureDaemonToken` (B2.3), `localSocketListenPath` (B2.8), `saveDaemonPort(…, pipe)` (B2.8).

- [ ] **Step 1: failing test.** In `cli/src/hookServer.spec.ts` add `import { randomBytes } from 'node:crypto'` and
  `import { pipeRequest } from './lib/windows/pipeClient.js'`, and after the handoff test (ends line 751):

```ts
  it('over the Windows pipe, serves only requests that prove the token, and trusts those', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const token = randomBytes(32)
    const onAuthHandoff = vi.fn(async () => ({ status: 200, body: { success: true, data: { code: 'hnh_x', expiresIn: 90 } } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onAuthHandoff }, { socketPath, pipeToken: token })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      // The route a Unix socket's file mode guards: here the token is what lets it through.
      expect((await pipeRequest({ pipe: socketPath, token }, { method: 'POST', path: '/api/auth/handoff', headers: local })).status).toBe(200)
      expect(await viaSocket(socketPath, 'POST', '/api/auth/handoff', local)).toBe(401)
      expect(onAuthHandoff).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/hookServer.spec.ts -t "Windows pipe"`. The unknown
  `pipeToken` option is ignored, so the server listens as a plain Unix socket. The answer carries no proof, and the
  test fails with `PipeUnproven` (`npx tsc --noEmit` also reports the unknown property).

- [ ] **Step 3: implementation.**

`cli/src/hookServer.ts`, in `HookServerOptions` after `socketPath` (line 374):

```ts
  /** Windows: the daemon's token. When given, `socketPath` is a pipe whose every request proves it (lib/localSocket.ts). */
  pipeToken?: Buffer | null
```

Lines 416-417 become:

```ts
      // Over the daemon's own socket the filesystem already said who this is, and over its Windows pipe the request
      // proved the daemon's token; no browser can get to either. Everything else must prove it was addressed to
      // this loopback server.
```

Line 1200 becomes `listenLocalSocket(handle, socketPath, { token: options.pipeToken ?? undefined }).then(`.

`cli/src/core/main.ts`: line 200 imports `localSocketListenPath` in place of `unixSocketPath` (B2.8's, used only at
line 1935); add
`import { ensureDaemonToken } from '../lib/windows/pipeAuth.js'`. Before line 1848 (`const { server: hookServer, … } = await startHookServer(`):

```ts
  // Windows: the daemon's pipe takes only requests that prove this token (lib/windows/pipeAuth.ts). It is made on
  // the first start and kept in the data folder, in the profile.
  const pipeToken = process.platform === 'win32' ? ensureDaemonToken(env.ADAPTER_DATA_DIR) : null
```

Line 1935 (B2.8 left it on `unixSocketPath`) becomes
`}, { socketPath: localSocketListenPath(env.ADAPTER_DATA_DIR, env.PORT), pipeToken, allowPortFallback: true })`, and
line 1936 becomes:

```ts
  // On Windows the record also names the pipe and this core's pid: both are new on each start, so clients read them here.
  try { saveDaemonPort(env.ADAPTER_DATA_DIR, env.PORT, hookPort, pipeToken && localSocket ? { pipe: localSocket.path, pid: process.pid } : undefined) } catch (error) {
```

On Windows `allowPortFallback` now takes effect, as on mac: with a socket path present, a TCP port held by another
user moves this daemon to a port of its own.

- [ ] **Step 4: run, expect pass.** `npx vitest run src/hookServer.spec.ts src/multiUserDaemon.spec.ts src/startupOrder.spec.ts src/architecture.spec.ts && npx tsc --noEmit`.

- [ ] **Step 5: commit.**
  `git add cli/src/hookServer.ts cli/src/hookServer.spec.ts cli/src/core/main.ts`
  `git commit -m "feat(cli): on Windows the core serves its API on an authenticated pipe and records it"`

### Task B2.11: The CLI's status and control calls use the pipe

**Files**
- Modify: `cli/src/lib/daemonEndpoint.ts` (`localDaemonStatus` lines 32-60; comment on `legacyDaemonStatus` lines 62-64; new functions)
- Modify: `cli/src/lib/daemonEndpoint.spec.ts` (new `describe`)
- Modify: `cli/src/cli.ts` (imports lines 73-74; `daemonCall` lines 1604-1618)

**Interfaces**
- Produces: `daemonPipe(dataDir, configuredPort, liveness?: HostLiveness): Promise<PipeTarget | null>`;
  `interface LocalDaemonOptions { platform?: NodeJS.Platform; pipe?: (dataDir: string, configuredPort: number) => Promise<PipeTarget | null> }`;
  `localDaemonStatus(dataDir, configuredPort, options?: LocalDaemonOptions)`;
  `interface DaemonCallOptions extends LocalDaemonOptions { tcpPort: number; fetch?: typeof fetch }`;
  `localDaemonCall(dataDir, configuredPort, method: 'GET' | 'POST', path: string, body: unknown, options: DaemonCallOptions): Promise<Response>`.
  B3 (stop and restart over the pipe) consumes `daemonPipe` and `pipeRequest`.
- Consumes: `recordedProcessDead`, `pidAlive` (B2.4); `readDaemonToken` (B2.3); `pipeRequest`, `pipeAbsent` (B2.6); `readDaemonRecord` (B2.8).

- [ ] **Step 1: failing test.** In `cli/src/lib/daemonEndpoint.spec.ts` add the imports
  `import { randomBytes } from 'node:crypto'`, `daemonPipe, localDaemonCall` (from `./daemonEndpoint.js`),
  `ensureDaemonToken` (from `./windows/pipeAuth.js`), `PipeUnproven` (from `./windows/pipeClient.js`) and `vi`
  (from `vitest`). Then append:

```ts
describe('the daemon over its Windows pipe', () => {
  const alive = { alive: () => true }
  /** A data folder as the Windows core leaves it: a token, a record naming its pipe and pid, and the pipe served. */
  async function windowsDaemon(handler: Parameters<typeof listenLocalSocket>[0], port = 19418) {
    const dir = directory()
    const token = ensureDaemonToken(dir)
    const pipe = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const server = await listenLocalSocket(handler, pipe, { token })
    cleanup.push(server.close)
    saveDaemonPort(dir, port, 24567, { pipe, pid: process.pid })
    return { dir, token, pipe, port }
  }
  const options = { platform: 'win32' as const, pipe: (dir: string, port: number) => daemonPipe(dir, port, alive) }

  it('is found by its record and token, unless its process is proven gone', async () => {
    const { dir, token, pipe, port } = await windowsDaemon((_req, res) => res.end('{}'))
    const found = await daemonPipe(dir, port, alive)
    expect(found?.pipe).toBe(pipe)
    expect(found?.token.equals(token)).toBe(true)
    expect(await daemonPipe(dir, port, { alive: () => false })).toBeNull()
    expect(await daemonPipe(dir, port + 1, alive)).toBeNull()
    saveDaemonPort(dir, port, 24567)
    expect(await daemonPipe(dir, port, alive)).toBeNull()
    expect(await daemonPipe(directory(), port, alive)).toBeNull()
  })

  it('answers status over the pipe, and nothing for an answer without the proof', async () => {
    const { dir, port } = await windowsDaemon((_req, res) => res.end(JSON.stringify({ machineId: 'account-a' })))
    expect(await localDaemonStatus(dir, port, options)).toEqual({ machineId: 'account-a' })
    expect(await localDaemonStatus(directory(), port, options)).toBeNull()
    const foreign = await localDaemonStatus(dir, port, { platform: 'win32', pipe: async (d, p) => ({ ...(await daemonPipe(d, p, alive))!, token: randomBytes(32) }) })
    expect(foreign).toBeNull()
  })

  it('makes control calls over the pipe, falls back to TCP only where nothing is there, and never after an unproven answer', async () => {
    let got = ''
    const { dir, port, pipe } = await windowsDaemon((req, res) => {
      got = `${req.method} ${req.url} ${req.headers['x-adapter-local']}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const tcp = vi.fn(async () => new Response('{"tcp":true}', { status: 200 }))
    const call = (o: Partial<Parameters<typeof localDaemonCall>[5]> = {}) =>
      localDaemonCall(dir, port, 'POST', '/api/pair', { code: '1' }, { ...options, tcpPort: 1, fetch: tcp as typeof fetch, ...o })
    const over = await call()
    expect(await over.json()).toEqual({ ok: true })
    expect(got).toBe('POST /api/pair 1')
    expect(tcp).not.toHaveBeenCalled()
    // No pipe to reach: as on every other OS.
    expect(await (await call({ pipe: async () => null })).json()).toEqual({ tcp: true })
    expect(await (await call({ platform: 'darwin' })).json()).toEqual({ tcp: true })
    // A recorded pipe nothing listens on any more.
    const gone = join(directory(), `harness-${randomBytes(16).toString('hex')}`)
    expect(await (await call({ pipe: async () => ({ pipe: gone, token: randomBytes(32) }) })).json()).toEqual({ tcp: true })
    expect(tcp).toHaveBeenCalledTimes(3)
    await expect(call({ pipe: async () => ({ pipe, token: randomBytes(32) }) })).rejects.toBeInstanceOf(PipeUnproven)
    expect(tcp).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: run, expect failure.** `npx vitest run src/lib/daemonEndpoint.spec.ts`. It fails:
  `daemonPipe is not a function`.

- [ ] **Step 3: implementation.** In `cli/src/lib/daemonEndpoint.ts` add the imports

```ts
import { daemonRecordPath } from './daemonRecord.js'
import { pidAlive, recordedProcessDead, type HostLiveness } from './processProof.js'
import { readDaemonToken } from './windows/pipeAuth.js'
import { pipeAbsent, pipeRequest, type PipeTarget } from './windows/pipeClient.js'
```

(merge `daemonRecordPath` into the existing `./daemonRecord.js` import). Replace `localDaemonStatus` (lines 32-60) with:

```ts
/**
 * How the daemon of a Windows record is proven gone before its pipe is dialled: its pid, and the process table
 * harness-pty reads (A's proof, processProof.ts). The table is loaded only when asked, because it brings the pty
 * host's launcher, which no Unix client needs.
 */
const WINDOWS_LIVENESS: HostLiveness = {
  alive: pidAlive,
  rows: async () => (await import('./windows/processTable.js')).windowsProcessRows(null),
}

/**
 * The daemon's pipe and token for this data folder on Windows, or null when there is nothing to dial: no record of
 * a pipe and pid, no token, or the recorded process is proven gone. Once that process is gone, any user can create
 * a pipe of the recorded name.
 */
export async function daemonPipe(dataDir: string, configuredPort: number, liveness: HostLiveness = WINDOWS_LIVENESS): Promise<PipeTarget | null> {
  const record = readDaemonRecord(dataDir, configuredPort)
  if (!record?.pipe || !record.pid) return null
  const token = readDaemonToken(dataDir)
  if (!token) return null
  if (await recordedProcessDead(daemonRecordPath(dataDir, configuredPort), record.pid, liveness)) return null
  return { pipe: record.pipe, token }
}

export interface LocalDaemonOptions {
  platform?: NodeJS.Platform
  /** The daemon's pipe on Windows; `daemonPipe` by default. */
  pipe?: (dataDir: string, configuredPort: number) => Promise<PipeTarget | null>
}

function statusObject(statusCode: number | undefined, text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return statusCode === 200 && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

/**
 * A native client must reach this OS user's socket, never whoever happens to hold a TCP port. On Windows that is
 * the daemon's pipe, and only an answer that proves the token is taken.
 */
export async function localDaemonStatus(dataDir: string, configuredPort: number, options: LocalDaemonOptions = {}): Promise<Record<string, unknown> | null> {
  if ((options.platform ?? process.platform) === 'win32') {
    const target = await (options.pipe ?? daemonPipe)(dataDir, configuredPort)
    if (!target) return null
    try {
      const reply = await pipeRequest(target, { method: 'GET', path: '/api/status', timeoutMs: 2_000, maxBytes: 4 * 1024 * 1024 })
      return statusObject(reply.status, reply.body)
    } catch { return null }
  }
  const socketPath = localSocketPath(dataDir, configuredPort)
  if (!socketPath) return null
  try {
    const entry = lstatSync(socketPath)
    if (!entry.isSocket() || (process.geteuid && entry.uid !== process.geteuid()) || (entry.mode & 0o077) !== 0) return null
  } catch { return null }
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/api/status', signal: AbortSignal.timeout(2_000) }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        if (text.length > 4 * 1024 * 1024) req.destroy(new Error('status response too large'))
      })
      res.on('error', () => resolve(null))
      res.on('end', () => resolve(statusObject(res.statusCode, text)))
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

export interface DaemonCallOptions extends LocalDaemonOptions {
  /** The TCP port a call falls back to: the daemon's actual one (`savedDaemonPort`). */
  tcpPort: number
  fetch?: typeof fetch
}

/** Statuses a `Response` may not have a body with. */
const NULL_BODY = new Set([204, 205, 304])

/**
 * A control call to the running daemon (cli.ts `daemonCall`: `harness pair`, `harness devices`, …). On Windows it
 * goes over the daemon's pipe when there is one, and only an answer that proves the token is taken. It falls back
 * to loopback TCP, as on every other OS, when there is nothing to reach: no record, a daemon proven gone, or
 * nothing listening. A pipe that answers without the proof is not retried over TCP: whatever answered took the
 * daemon's name, and the caller is told so.
 */
export async function localDaemonCall(
  dataDir: string, configuredPort: number, method: 'GET' | 'POST', path: string, body: unknown, options: DaemonCallOptions,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-adapter-local': '1' } // passes the local API's CSRF gate
  if (body) headers['content-type'] = 'application/json'
  const text = body ? JSON.stringify(body) : undefined
  if ((options.platform ?? process.platform) === 'win32') {
    const target = await (options.pipe ?? daemonPipe)(dataDir, configuredPort)
    if (target) {
      try {
        const reply = await pipeRequest(target, { method, path, headers, body: text, timeoutMs: 60_000 })
        const type = reply.headers['content-type']
        return new Response(NULL_BODY.has(reply.status) ? null : reply.body,
          { status: reply.status, headers: typeof type === 'string' ? { 'content-type': type } : {} })
      } catch (error) {
        if (!pipeAbsent(error)) throw error
      }
    }
  }
  return (options.fetch ?? fetch)(`http://127.0.0.1:${options.tcpPort}${path}`, { method, headers, body: text })
}
```

Lines 62-63 (`legacyDaemonStatus`'s comment) become
`/** Read-only compatibility for CLI status with daemons that have neither a Unix socket nor a Windows pipe.`.

`cli/src/cli.ts`: line 74 becomes `import { legacyDaemonStatus, localDaemonCall, localDaemonStatus } from './lib/daemonEndpoint.js'`,
add `import { PipeUnproven } from './lib/windows/pipeClient.js'`, and `daemonCall` (lines 1604-1618) becomes:

```ts
/** Call the running daemon's control API: over its Windows pipe when it has one, else localhost. Exits with a friendly message if it's not up. */
async function daemonCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ res: Response; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await localDaemonCall(env.ADAPTER_DATA_DIR, env.PORT, method, path, body, { tcpPort: daemonPort() })
  } catch (error) {
    console.error(`\n  ✗ ${error instanceof PipeUnproven ? error.message : daemonUnreachableText((error as { cause?: unknown }).cause ?? error)}\n`)
    process.exit(1)
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { res, json }
}
```

`runningDaemonStatus` (line 1288) is unchanged: `localDaemonStatus` now reaches the pipe on Windows and
`legacyDaemonStatus` stays its fallback.

- [ ] **Step 4: run, expect pass.** `npx vitest run src/lib/daemonEndpoint.spec.ts src/multiUserDaemon.spec.ts src/cliCommand.spec.ts src/authCommand.spec.ts && npx tsc --noEmit`.

- [ ] **Step 5: commit.**
  `git add cli/src/lib/daemonEndpoint.ts cli/src/lib/daemonEndpoint.spec.ts cli/src/cli.ts`
  `git commit -m "feat(cli): on Windows, status and control calls go over the daemon's pipe after the dead-process check"`

### Task B2.12: Windows verification on a real pipe

**Files**
- Create: `cli/src/lib/windows/daemonPipe.real.spec.ts`

**Interfaces**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: write the Windows-only test.** Create `cli/src/lib/windows/daemonPipe.real.spec.ts`:

```ts
// The daemon's pipe on a real Windows named pipe: its API and local WS, each request proving the token, found by
// the record the core writes. Credentials that are links are refused. Windows only; the Windows workflow runs it with
// src/lib/windows, and on the VM:
//   cli/scripts/windows-pty-e2e/vm-sync.sh --cli
//   ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/lib/windows --maxWorkers=1"
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachLocalWsServer, type LocalWsBackend, type LocalWsServer } from '../../localWsServer.js'
import { daemonPipe, localDaemonCall, localDaemonStatus, saveDaemonPort } from '../daemonEndpoint.js'
import { hookCredentialPath, readHookCredential } from '../hookAuth.js'
import { listenLocalSocket } from '../localSocket.js'
import { daemonTokenPath, ensureDaemonToken, newPipeNonce, newPipePath, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven, readDaemonToken } from './pipeAuth.js'
import { pipeRequest } from './pipeClient.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function profileDir(): string {
  // %TEMP% is in the profile: the state roots (secureState.ts) take it.
  const dir = mkdtempSync(join(tmpdir(), 'hpipe-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const backend: LocalWsBackend = {
  registerLocalClient: () => true, unregisterLocalClient: async () => {}, handleLocalFrame: () => {}, handleLocalBinary: async () => {},
}

describe.skipIf(!WINDOWS)('the daemon pipe on Windows', () => {
  it('serves the API and the local WS to callers that prove the token, as the core records it', async () => {
    const dir = profileDir()
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    const pipePath = newPipePath()
    const pipe = await listenLocalSocket((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pid: process.pid })) }, pipePath, { token })
    const tcp = http.createServer((_req, res) => res.end())
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    const local: LocalWsServer = attachLocalWsServer(tcp, { machineId: 'machine-1', backend, localSocketServer: pipe.server })
    cleanup.push(pipe.close, () => new Promise<void>((resolve) => tcp.close(() => resolve())), local.close)
    saveDaemonPort(dir, 19418, 24567, { pipe: pipePath, pid: process.pid })

    // The real liveness: this pid, and the process table when harness-pty is there (HARNESS_PTY_BIN in the workflow).
    const target = await daemonPipe(dir, 19418)
    expect(target?.pipe).toBe(pipePath)
    expect(await localDaemonStatus(dir, 19418)).toEqual({ pid: process.pid })
    const viaPipe = await localDaemonCall(dir, 19418, 'GET', '/api/status', undefined,
      { tcpPort: 1, fetch: (async () => { throw new Error('TCP was used') }) as typeof fetch })
    expect(await viaPipe.json()).toEqual({ pid: process.pid })
    expect((await pipeRequest(target!, { method: 'GET', path: '/x' })).status).toBe(200)

    const nonce = newPipeNonce(pipePath)
    const ws = new WebSocket('ws://localhost/api/local-ws', { createConnection: () => net.connect(pipePath), headers: { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) } })
    const upgraded = await new Promise<http.IncomingMessage>((resolve, reject) => { ws.once('upgrade', resolve); ws.once('error', reject) })
    expect(pipeProven(upgraded.headers, token, nonce)).toBe(true)
    ws.close()
    const stranger = new WebSocket('ws://localhost/api/local-ws', { createConnection: () => net.connect(pipePath) })
    await expect(new Promise((resolve, reject) => { stranger.once('open', resolve); stranger.once('error', reject) })).rejects.toThrow()
  })

  it('refuses a second listener on a pipe name that is in use', async () => {
    const pipePath = newPipePath()
    const first = await listenLocalSocket((_req, res) => res.end(), pipePath, { token: Buffer.alloc(32, 1) })
    cleanup.push(first.close)
    await expect(listenLocalSocket((_req, res) => res.end(), pipePath, { token: Buffer.alloc(32, 2) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('refuses a hook credential or a token that is a link', (context) => {
    const dir = profileDir(), elsewhere = profileDir()
    writeFileSync(join(elsewhere, 'target'), `${'A'.repeat(43)}\n`)
    try {
      symlinkSync(join(elsewhere, 'target'), hookCredentialPath(dir), 'file')
      symlinkSync(join(elsewhere, 'target'), daemonTokenPath(dir), 'file')
    } catch (error) {
      // A file link needs Developer Mode or an elevated token; GitHub's runners have one.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip()
      throw error
    }
    expect(readHookCredential(dir)).toBeNull()
    expect(readDaemonToken(dir)).toBeNull()
  })
})
```

- [ ] **Step 2: run on mac, expect skip.** `npx vitest run src/lib/windows` (`daemonPipe.real.spec.ts` skipped; the
  other `src/lib/windows` specs pass, `pipeTransport`/`pipeClient` on a Unix socket).

- [ ] **Step 3: run on the VM.**
  `cli/scripts/windows-pty-e2e/vm-sync.sh --cli`, then
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npm ci && npx vitest run src/lib/windows --maxWorkers=1"`
  (skip `npm ci` when `node_modules` is current). Expected: `pipeAuth`, `pipeTransport`, `pipeClient` and
  `daemonPipe.real` pass on real pipes. `daemonToken.spec.ts` is skipped there (its Windows half is the real spec).
  Never touch `C:\work\e2e`.

- [ ] **Step 4: run on the Windows workflow (manual, once, on the pushed branch).**
  `gh workflow run windows-pty.yml --ref feat/windows-native-cli`. Its "Contract suite against the real host" step
  runs `src/lib/windows` on windows-latest (x64) and windows-11-arm, with `HARNESS_PTY_BIN` set, so the dead-process
  check reads the real process table. Record the run link in the PR.

- [ ] **Step 5: mac/Linux gates for the touched areas.**
  `npx tsc --noEmit && npx vitest run src/lib src/hookServer.spec.ts src/localWsServer.spec.ts src/multiUserDaemon.spec.ts src/masterProcess.spec.ts src/serviceProcess.spec.ts src/cliCommand.spec.ts src/authCommand.spec.ts src/startupOrder.spec.ts src/architecture.spec.ts src/messages src/agentClient && npm run test:core && npm run test:harnessd`.
  Compare red tests against a clean `origin/main` worktree; only pre-existing reds may remain.

- [ ] **Step 6: commit.**
  `git add cli/src/lib/windows/daemonPipe.real.spec.ts`
  `git commit -m "test(windows): the daemon pipe, its auth and its credentials on a real Windows pipe"`

### Phase B2 notes

- Verified: on win32 `localSocketPath()` was null (`localSocket.ts:43`), so every CLI call went over TCP. Only
  `/api/auth/handoff` (`hookServer.ts:1101`) and the WS `daemon_*` frames (`localWsServer.ts:692,710`) need
  `isTrustedLocal`. `daemonCall` (`cli.ts:1605`) is plain TCP fetch with `x-adapter-local`.
- Verified: A's hello uses SHA-256(token‖sep‖nonce) (`ptyHost/protocol.ts:139-153`). The contract asks for
  HMAC-SHA256 here, which this phase uses. The 0x01/0x00 split is the same as A's.
- Verified: ws 8.21 ignores a `socketPath` option (`node_modules/ws/lib/websocket.js:681`) but honors
  `createConnection`, which the tests use for WS over a pipe. `wss.on('headers')` adds headers to the 101.
- Verified: `fs.constants.O_NOFOLLOW` is non-configurable (so the tests copy `constants` instead of proxying it) and
  is absent on Windows. That is why the link check is needed on Windows.
- Verified: the Windows workflow already runs `src/lib/windows` (`.github/workflows/windows-pty.yml:69-70`), so the
  transport-agnostic specs there run on real pipes on both architectures.
- Risk: the request (headers and body) reaches whatever listens on the recorded pipe before the proof is checked.
  The dead-process check mitigates this. With no process table (no harness-pty) only the pid is checked, and a
  squatter on a reused pid would see one `harness pair` code. Its auth header opens nothing elsewhere: the nonce is
  bound to the dead pipe's id.
- Risk: the default pipe DACL also lets other users open it read-only, which uses up pipe instances (a local DoS).
  It is not a trust issue. B5 E2E item 6 checks the trust side with a second local user.
- Risk: `requireWindowsStateFile` relies on Node reporting junctions and symlinks as `isSymbolicLink()`. Other
  reparse tags (OneDrive placeholders) read as files and then pass on location alone.
- Risk: the core on Windows now fails to start if the pipe cannot be listened on (`allowPortFallback` rejects). A
  random 128-bit name makes a clash a squat or a bug, and both should be loud.
- Decision: `localSocketPath()` on win32 returns the pipe the running daemon recorded, not a fresh name per call. The
  listener gets a fresh one from the new `localSocketListenPath()`. Why: callers dial the path, and a name that
  changes on every call could not be dialled. "New per start" is per daemon start.
- Decision: the six filesystem-socket callers (services, `ws+unix://` clients) move to `unixSocketPath()`, which is
  null on win32. Why: on Windows the services stay in the core's process and `harness send` / agent verbs stay on
  TCP, exactly as today. Neither needs trust. Services over the pipe would need auth in `services/process.ts` and
  are not in B2.
- Decision: the nonce is `<pipe id (32 hex)><128 random bits>`, and the daemon accepts only nonces with its own
  pipe's id (`checkPipeAuth`'s optional 4th parameter). Why: the token persists across starts and each daemon's
  nonce window starts empty. Without the binding, an auth captured on a dead daemon's name could be replayed at the
  next daemon.
- Decision: a pipe request without valid auth gets a 401 and never reaches the handler. An upgrade without auth is
  destroyed. Why: no caller needs untrusted access over the pipe; that is what loopback TCP is for.
- Decision: the token file holds 64 lowercase hex digits and a newline, is created with O_EXCL, and a file cut
  short is replaced. Why: it must be readable by phase C's desktop, safe when two starts race, and must not leave a
  daemon unable to start after a torn write (the hook credential's EEXIST problem on Windows).
- Decision: `refuseServedDataFolder` on Windows dials the recorded pipe without the process-table check and
  trusts only a proven answer. Why: the request is a body-less GET, and an auth bound to the dead pipe's id gains
  a squatter nothing. Reading the table at every core start costs up to 3 s.
- Decision: `localDaemonCall` falls back to TCP only when the pipe is absent (no record or token, process proven
  gone, ENOENT/ECONNREFUSED). An unproven answer or a timeout is an error, never retried. Why: retrying a POST
  after something else took the name hides the squat. It could also repeat a call that a real but slow daemon did
  receive.
- Decision: only `daemonCall` and `localDaemonStatus` move to the pipe (what the spec names). The other loopback
  fetches in `cli.ts` (lines 1788-2079: remote password, trust-peer, group) and the WS clients stay on TCP. Why:
  none of them needs trust, and their behavior stays identical to mac.
- Decision: the record's `pipe` is accepted when it ends in `harness-<32 hex>`, without requiring the
  `\\.\pipe\` prefix. Why: the proof, not the name, is the check, and the mac tests use Unix sockets with that name.
- Decision: the dead-process proof moves to `lib/processProof.ts` and `launch.ts` re-exports it. Why: the daemon
  client must not import the pty host's launcher (env, client), and A's code keeps one proof, not two.


---

## Phase B3: harnessd lifecycle and self-update

harnessd runs on Windows the way it runs on a Mac, with no POSIX signals and no exec. A per-user scheduled task
starts it at logon and checks every 5 minutes (`harness start --if-down`). Stop goes over the trusted pipe and the
spawn protocol (`harnessd:stop`, `harnessd:shutdown`); when the daemon does not answer, the CLI ends only the
process it has identified (TerminateProcess, never `/T`). The master hands over to its replacement through
`harness-launch.exe` instead of exec. Updates go into version folders behind the `cli\current` pointer and roll
back by rewriting it. macOS and Linux behaviour does not change: every Windows branch is selected by
`process.platform === 'win32'` (or an injected platform) or by a dependency only Windows wiring passes.

Order: B3.1–B3.6 (protocol and graceful stop inside the daemon), B3.7–B3.10 (the CLI's side of stop, and the
spawn lock), B3.11–B3.15 (the launcher, Task Scheduler and starting), B3.16–B3.17 (self-update), B3.18–B3.20 (master
replacement and wiring), B3.21 (verification on Windows). Every task leaves `npm run typecheck` green.

Gates for the whole phase (run locally, record in the PR): `npm run test:harnessd` (100% per file),
`npm run test:core` (100% per file for `src/core`, `src/services`), the touched `src/lib` specs, and
`npm run test:e2e -- e2e/reexec.e2e.ts e2e/cli.e2e.ts` on mac against a clean `origin/main` baseline.

---

### Task B3.1: Spawn protocol 6, `harnessd:stop` and `harnessd:shutdown`

**Files**
- Modify: `cli/src/harnessd/protocol.ts:16-23` (protocol doc and constant), `:60-73` (`CoreMessage`),
  `:75-78` (`MasterMessage`), `:93-116` (guards)
- Modify: `cli/src/harnessd/protocol.spec.ts:5-38`

**Interfaces**
- Produces: `HARNESSD_PROTOCOL = 6`; `CoreMessage` gains `{ type: 'harnessd:stop' }`; `MasterMessage` gains
  `{ type: 'harnessd:shutdown' }`.
- Consumes: nothing.

- [ ] **Failing test.** In `protocol.spec.ts`, add rows to the two tables:

```ts
    // core message table (after the `harnessd:want` rows)
    [{ type: 'harnessd:stop' }, true],
    [{ type: 'harnessd:shutdown' }, false],
```

```ts
    // master message table (after the `harnessd:update` rows)
    [{ type: 'harnessd:shutdown' }, true],
    [{ type: 'harnessd:stop' }, false],
```

and a new case:

```ts
  it('is protocol 6: the core asks its master to stop, and the master asks a process to leave', () => {
    expect(HARNESSD_PROTOCOL).toBe(6)
  })
```

- [ ] Run `cd cli && npx vitest run src/harnessd/protocol.spec.ts`. Expected: 3 failures (`harnessd:stop` is false,
  `harnessd:shutdown` is false, protocol is 5).

- [ ] **Implementation.** `protocol.ts`:

```ts
/** 2: `ready`, the event-loop delay on the heartbeat, and the exit-code contract below. 3: `want`, and the
 *  master's updater: the master tells its core to hand over for a build its updater staged (`harnessd:update`).
 *  4: `want` for the devices' process too, which runs only once there is a device, for models', which runs
 *  only once grid is in use here or a request needs it, and for the gateway's, which runs once this machine is
 *  signed in, has anything paired or needs it; and `want` before `bound` (./services.ts `askedSince`).
 *  5: `want` for the viewers' process (the harness viewers and the Store), which runs once a harness is here, a
 *  request needs it or the release's own harnesses are to be put in place (core/viewersWake.ts).
 *  6: `stop`, the core asking its master to stop everything (`harness stop` on Windows, where the CLI has no signal
 *  to send the master), and `shutdown`, the master asking the core or a service to leave, where a signal cannot:
 *  on Windows Node's `kill` is TerminateProcess, whatever the signal, and nothing would be torn down. */
export const HARNESSD_PROTOCOL = 6
```

`CoreMessage`, after the `harnessd:want` member:

```ts
  /** Stop the services, this core and the master, and stay stopped (protocol 6): `harness stop` asked this core
   *  over its pipe (core/daemonStopRoute.ts). A master from before ignores it; the CLI then ends it. */
  | { type: 'harnessd:stop' }
```

`MasterMessage`:

```ts
export type MasterMessage =
  | { type: 'harnessd:status'; status: SupervisorStatus }
  /** The updater staged `version`: hand over for it, as a core whose own updater staged it did (exit 75). */
  | { type: 'harnessd:update'; version: string }
  /** Leave, as on SIGTERM (protocol 6): what the master says where it has no signal to send (Windows). A process
   *  from before ignores it, and is ended once its grace is over, as one that ignored SIGTERM was. */
  | { type: 'harnessd:shutdown' }
```

`isCoreMessage`, a case before `default`:

```ts
    case 'harnessd:stop':
      return true
```

`isMasterMessage`:

```ts
export function isMasterMessage(value: unknown): value is MasterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type === 'harnessd:update') return typeof message.version === 'string' && message.version.length > 0
  if (message.type === 'harnessd:shutdown') return true
  return message.type === 'harnessd:status' && !!message.status && typeof message.status === 'object'
}
```

- [ ] Run `npx vitest run src/harnessd/protocol.spec.ts` (pass), then `npm run typecheck`. Expected: one type error in
  `harnessd/coreLink.ts:118` (`message.version` does not exist on the shutdown member). Fix it in B3.4; to keep this
  commit green, add the guard now in `coreLink.ts` inside the `channel.on('message')` callback, before line 118:

```ts
      if (message.type === 'harnessd:shutdown') return // B3.4 gives it a listener
```

- [ ] Run `npm run typecheck && npx vitest run src/harnessd`. Expected: pass. The status tests use
  `protocol: HARNESSD_PROTOCOL`, so the bump changes no other expectation.
- [ ] Commit: `harnessd: protocol 6, harnessd:stop and harnessd:shutdown` —
  `git add cli/src/harnessd/protocol.ts cli/src/harnessd/protocol.spec.ts cli/src/harnessd/coreLink.ts`

---

### Task B3.2: The supervisor stops its core by message on Windows, and hears `harnessd:stop`

**Files**
- Modify: `cli/src/harnessd/supervisor.ts:31-73` (`SupervisorDeps`), `:406-469` (`onMessage`), `:606-617` (`end`)
- Modify: `cli/src/harnessd/supervisor.spec.ts` (new cases at the end of `describe('Supervisor')`)

**Interfaces**
- Produces: `SupervisorDeps.stopByMessage?: boolean`, `SupervisorDeps.stopRequested?(why: string): void`.
- Consumes: B3.1 messages.

- [ ] **Failing test.** Append inside `describe('Supervisor', …)` in `supervisor.spec.ts`:

```ts
  it('on Windows, asks the core to leave rather than signalling it, and ends it after the grace all the same', () => {
    const supervisor = make({}, { stopByMessage: true })
    supervisor.start()
    core().up()
    supervisor.stop('harness stop')
    expect(core().kills).toEqual([])
    expect(core().sent.at(-1)).toEqual({ type: 'harnessd:shutdown' })
    vi.advanceTimersByTime(options.stopGraceMs)
    expect(core().kills).toEqual(['SIGKILL'])
    core().exit(null, 'SIGKILL')
    expect(exited).toEqual([0])
  })

  it('on Windows, restarts a core over its memory budget by message too', () => {
    make({}, { stopByMessage: true }).start()
    core().up()
    core().beat(100 * MIB, 900 * MIB)
    expect(core().kills).toEqual([])
    expect(core().sent.at(-1)).toEqual({ type: 'harnessd:shutdown' })
    core().exit(0)
    vi.runOnlyPendingTimers()
    expect(cores).toHaveLength(2)
  })

  it('signals the core everywhere else, as before', () => {
    const supervisor = make()
    supervisor.start()
    core().up()
    supervisor.stop('SIGTERM')
    expect(core().kills).toEqual(['SIGTERM'])
    expect(core().sent.some((message) => message.type === 'harnessd:shutdown')).toBe(false)
  })

  it('stops everything when the core asks (harness stop over its pipe), through the master when it says how', () => {
    const asked: string[] = []
    const supervisor = make({}, { stopRequested: (why) => asked.push(why) })
    supervisor.start()
    core().up()
    core().say({ type: 'harnessd:stop' })
    expect(asked).toEqual(['the core asked to stop (harness stop)'])
    // Without a way to stop the rest, the supervisor stops its core and finishes itself.
    const alone = make()
    alone.start()
    core().up()
    core().say({ type: 'harnessd:stop' })
    expect(alone.status().state).toBe('stopping')
    expect(core().kills).toEqual(['SIGTERM'])
  })
```

- [ ] Run `npx vitest run src/harnessd/supervisor.spec.ts`. Expected: 3 failures (`stopByMessage` and `stopRequested`
  are not known; the core is signalled; `harnessd:stop` is ignored). "signals the core everywhere else, as before"
  already passes: it pins today's behavior.

- [ ] **Implementation.** `SupervisorDeps`, after `unasked?`:

```ts
  /**
   * Stop the core with `harnessd:shutdown` (./protocol.ts) rather than SIGTERM. Windows: Node's `kill` there is
   * TerminateProcess, whatever the signal, and a core ended that way never flushes its registry or closes its
   * servers. SIGKILL after the grace is TerminateProcess on the handle this master holds, so it can only end its
   * own child. Left out, signals, as on macOS and Linux.
   */
  stopByMessage?: boolean
  /**
   * The core asked to stop everything (`harnessd:stop`: `harness stop` reached it over its pipe). The master stops
   * its services beside the core, as on a signal (./master.ts); left out, the supervisor stops the core itself.
   */
  stopRequested?(why: string): void
```

`onMessage`, a case before `case 'harnessd:heartbeat'`:

```ts
      case 'harnessd:stop': {
        const why = 'the core asked to stop (harness stop)'
        if (this.deps.stopRequested) this.deps.stopRequested(why)
        else this.stop(why)
        return
      }
```

`end`:

```ts
  /** End the running core: SIGTERM (or SIGKILL), and SIGKILL if it outlives the grace. On Windows the SIGTERM is
   *  `harnessd:shutdown` (`stopByMessage`). */
  private end(why: 'stop' | 'restart', signal: NodeJS.Signals): void {
    const core = this.core!
    this.ending = why
    this.clearTimer('heartbeatTimer')
    this.clearTimer('readyTimer')
    // Every caller ends a core with SIGTERM; a second stop is SIGKILL through `stop`, never through here.
    if (this.deps.stopByMessage) core.send({ type: 'harnessd:shutdown' })
    else core.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] core outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      core.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }
```

- [ ] Run `npm run test:harnessd`. Expected: pass, `supervisor.ts` at 100%.
- [ ] Commit: `harnessd: stop the core by message on Windows; hear harnessd:stop` —
  `git add cli/src/harnessd/supervisor.ts cli/src/harnessd/supervisor.spec.ts`

---

### Task B3.3: Services stopped by message on Windows

**Files**
- Modify: `cli/src/harnessd/services.ts:35-47` (`ServiceSupervisorDeps`), `:261-270` (`Service.end`)
- Modify: `cli/src/harnessd/services.spec.ts` (new case)

**Interfaces**
- Produces: `ServiceSupervisorDeps.stopByMessage?: boolean`.

- [ ] **Failing test.** In `services.spec.ts`, let `FakeService` (`:10-24`) record what it is sent, and `make`
  (`:49-61`) take deps:

```ts
  readonly sent: unknown[] = []
  send(message: unknown): void { this.sent.push(message) }
```

```ts
  const make = (specs: ServiceSpec[] = [search], overrides: Partial<ServiceSupervisorOptions> = {}, env: Record<string, string> = {}, tell = true, more: Partial<ServiceSupervisorDeps> = {}) =>
    new ServiceSupervisor(specs, {
      // …as before…
      log: (line) => lines.push(line),
      ...more,
    }, { ...options, ...overrides }, env)
```

  (import `type ServiceSupervisorDeps`), then add to `describe('ServiceSupervisor')`:

```ts
  it('on Windows, asks each service to leave rather than signalling it, and ends it after the grace', () => {
    const supervisor = make([search], {}, {}, true, { stopByMessage: true })
    supervisor.start()
    const done = vi.fn()
    supervisor.stop(done)
    expect(latest().kills).toEqual([])
    expect(latest().sent).toEqual([{ type: 'harnessd:shutdown' }])
    vi.advanceTimersByTime(options.stopGraceMs)
    expect(latest().kills).toEqual(['SIGKILL'])
    latest().exit(null, 'SIGKILL')
    expect(done).toHaveBeenCalledOnce()
  })
```

- [ ] Run `npx vitest run src/harnessd/services.spec.ts`. Expected: fail (`kills` is `['SIGTERM']`).

- [ ] **Implementation.** `ServiceSupervisorDeps`, after `staged?`:

```ts
  /** Stop a service with `harnessd:shutdown` rather than SIGTERM: Windows, where Node's `kill` is TerminateProcess
   *  and the service's own stop never runs (./supervisor.ts `SupervisorDeps.stopByMessage`). */
  stopByMessage?: boolean
```

`Service.end`:

```ts
  private end(signal: NodeJS.Signals): void {
    const child = this.child!
    this.ending = true
    this.clearTimer('heartbeatTimer')
    // Called with SIGTERM only: a stop, or a restart for memory.
    if (this.deps.stopByMessage) child.send({ type: 'harnessd:shutdown' })
    else child.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] service ${this.spec.name} outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      child.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }
```

- [ ] Run `npm run test:harnessd`. Expected: pass at 100%.
- [ ] Commit: `harnessd: stop services by message on Windows` —
  `git add cli/src/harnessd/services.ts cli/src/harnessd/services.spec.ts`

---

### Task B3.4: The core's link: `stopAll()` and `onShutdown()`

**Files**
- Modify: `cli/src/harnessd/coreLink.ts:59-83` (`CoreLink`), `:110-121` (message listener), `:136-175` (returned link)
- Modify: `cli/src/harnessd/coreLink.spec.ts` (new cases in `describe('connectToMaster')`)

**Interfaces**
- Produces: `CoreLink.stopAll(): boolean`, `CoreLink.onShutdown(listener: () => void): void`.

- [ ] **Failing test.**

```ts
  it('asks its master to stop everything, and says when there is no master to ask', () => {
    const channel = new FakeChannel()
    expect(connectToMaster(channel, supervised).stopAll()).toBe(true)
    expect(channel.sent).toEqual([{ type: 'harnessd:stop' }])
    expect(connectToMaster(new FakeChannel(), {}).stopAll()).toBe(false)
  })

  it('hears the master ask it to leave, before or after it listens, once', async () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, supervised)
    const early = vi.fn()
    channel.say({ type: 'harnessd:shutdown' })
    link.onShutdown(early)
    await Promise.resolve()
    expect(early).toHaveBeenCalledOnce()
    const other = new FakeChannel()
    const late = vi.fn()
    const second = connectToMaster(other, supervised)
    second.onShutdown(late)
    other.say({ type: 'harnessd:shutdown' })
    other.say({ type: 'harnessd:shutdown' })
    expect(late).toHaveBeenCalledOnce()
    // Without a master it listens for nothing.
    const alone = vi.fn()
    connectToMaster(new FakeChannel(), {}).onShutdown(alone)
    expect(alone).not.toHaveBeenCalled()
  })
```

- [ ] Run `npx vitest run src/harnessd/coreLink.spec.ts`. Expected: fail (`stopAll` / `onShutdown` are not functions).

- [ ] **Implementation.** `CoreLink`, after `onUpdate`:

```ts
  /** Ask the master to stop everything and exit (`harnessd:stop`, protocol 6): `harness stop` on Windows. False
   *  when no master runs this core: the caller stops it alone. */
  stopAll(): boolean
  /** The master asks this core to leave (`harnessd:shutdown`): Windows, where it has no signal to send. Heard
   *  from the start, as `onUpdate` is, and once. */
  onShutdown(listener: () => void): void
```

In `connectToMaster`, replace the B3.1 guard and add state beside `update`:

```ts
  // Asked to leave before anything listened (a stop during start-up): remembered, as an update is.
  let shutdownAsked = false
  const shutdownListeners: Array<() => void> = []
  if (supervised) {
    channel.on('message', (message) => {
      if (!isMasterMessage(message)) return
      if (message.type === 'harnessd:status') { status = message.status; return }
      if (message.type === 'harnessd:shutdown') {
        if (shutdownAsked) return
        shutdownAsked = true
        for (const listener of shutdownListeners.splice(0)) listener()
        return
      }
      if (updateListener) updateListener(message.version)
      else update = message.version
    })
  }
```

(the existing `let update` / `let updateListener` declarations move above this block, unchanged). In the returned
object, after `onUpdate`:

```ts
    stopAll: () => {
      if (!supervised) return false
      send({ type: 'harnessd:stop' })
      return true
    },
    onShutdown: (listener) => {
      if (!supervised) return
      if (shutdownAsked) queueMicrotask(listener)
      else shutdownListeners.push(listener)
    },
```

- [ ] Run `npm run test:harnessd`. Expected: pass at 100%.
- [ ] Commit: `harnessd: the core's link asks its master to stop, and hears shutdown` —
  `git add cli/src/harnessd/coreLink.ts cli/src/harnessd/coreLink.spec.ts`

---

### Task B3.5: A service process leaves on `harnessd:shutdown`

**Files**
- Modify: `cli/src/services/process.ts:17` (import), `:164-166` (listeners in `hostServices`)
- Modify: `cli/src/services/process.spec.ts` (new case in `describe('the process the services run in')`)

**Interfaces**
- Consumes: B3.1 `isMasterMessage`, `harnessd:shutdown`.

- [ ] **Failing test.**

```ts
  it('stops what it runs when the master asks it to leave (Windows has no SIGTERM to send)', async () => {
    const channel = new FakeChannel()
    const running = host({ channel })
    const stop = vi.fn()
    running.add({ stop })
    channel.emit('message', { type: 'harnessd:status', status: {} })
    channel.emit('message', { type: 'harnessd:shutdown' })
    await vi.advanceTimersByTimeAsync(0)
    expect(stop).toHaveBeenCalledOnce()
    expect(exits).toEqual([0])
  })
```

- [ ] Run `npx vitest run src/services/process.spec.ts`. Expected: fail (`exits` is `[]`).

- [ ] **Implementation.** Import `isMasterMessage` from `'../harnessd/protocol.js'`. After
  `channel.once('disconnect', () => leave(0))`:

```ts
  // Windows: the master's stop is a message, as its SIGTERM is elsewhere (harnessd/services.ts `stopByMessage`).
  channel.on('message', (message) => { if (isMasterMessage(message) && message.type === 'harnessd:shutdown') leave(0) })
```

- [ ] Run `npm run test:core`. Expected: pass, `services/process.ts` at 100%.
- [ ] Commit: `services: leave on harnessd:shutdown` — `git add cli/src/services/process.ts cli/src/services/process.spec.ts`

---

### Task B3.6: The core serves `POST /api/daemon/stop` on its trusted endpoint, and leaves on shutdown

The route exists on Windows only. A Mac or Linux `harness stop` signals the master through its pid file, as before,
and a core there serves no such route (Global Constraints: mac/Linux change only by `harness uninstall`).

**Files**
- Create: `cli/src/core/daemonStopRoute.ts`, `cli/src/core/daemonStopRoute.spec.ts`
- Modify: `cli/src/hookServer.ts:158-163` (`HookHandlers`), `:1100-1104` (route beside `/api/auth/handoff`)
- Modify: `cli/src/hookServer.spec.ts` (new case after the handoff case, ~`:752`)
- Modify: `cli/src/core/main.ts:1911` (handler), `:2769` (shutdown), `:2913` (safe mode)

**Interfaces**
- Produces: route `POST /api/daemon/stop`, win32 only (trusted local endpoint + `x-adapter-local: 1`, else 403;
  202 `{ ok: true }`; no route, so 404, where no `onDaemonStop` is given);
  `HookHandlers.onDaemonStop?: () => Promise<PairOutcome>`;
  `daemonStopHandler(deps: DaemonStopDeps): () => Promise<PairOutcome>`;
  `daemonStopRoute(deps: DaemonStopDeps, platform?: NodeJS.Platform): { onDaemonStop?: () => Promise<PairOutcome> }`
  (the handler on win32, nothing elsewhere).
- Consumes: B3.4 `stopAll`, `onShutdown`; B2's `isTrustedLocal()` (true on Windows only for an authenticated pipe
  request, unchanged on mac).

- [ ] **Failing tests.** `cli/src/core/daemonStopRoute.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { daemonStopHandler, daemonStopRoute } from './daemonStopRoute.js'

describe('harness stop, as the core hears it', () => {
  it('answers first, then asks its master to stop everything', async () => {
    const later: Array<() => void> = []
    const askMaster = vi.fn(() => true)
    const stopHere = vi.fn()
    const handle = daemonStopHandler({ askMaster, stopHere, defer: (run) => later.push(run) })
    await expect(handle()).resolves.toEqual({ status: 202, body: { ok: true } })
    expect(askMaster).not.toHaveBeenCalled()
    later.forEach((run) => run())
    expect(askMaster).toHaveBeenCalledOnce()
    expect(stopHere).not.toHaveBeenCalled()
  })

  it('stops itself when no master runs it', async () => {
    const stopHere = vi.fn()
    const handle = daemonStopHandler({ askMaster: () => false, stopHere })
    await handle()
    await new Promise((done) => setImmediate(done))
    expect(stopHere).toHaveBeenCalledOnce()
  })

  it('is served on Windows only: a Mac or Linux core has no such route and stops by signal, as before', () => {
    const deps = { askMaster: () => true, stopHere: vi.fn() }
    expect(daemonStopRoute(deps, 'darwin')).toEqual({})
    expect(daemonStopRoute(deps, 'linux')).toEqual({})
    expect(daemonStopRoute(deps, 'win32').onDaemonStop).toBeTypeOf('function')
    expect(Object.keys(daemonStopRoute(deps))).toEqual(process.platform === 'win32' ? ['onDaemonStop'] : [])
  })
})
```

  In `hookServer.spec.ts`, after the handoff case:

```ts
  it('takes `harness stop` over the trusted endpoint only — never on the loopback port', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onDaemonStop = vi.fn(async () => ({ status: 202, body: { ok: true } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onDaemonStop }, { socketPath })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop', local)).toBe(202)
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop')).toBe(403)
      const port = (started.server.address() as { port: number }).port
      const tcp = await fetch(`http://127.0.0.1:${port}/api/daemon/stop`, { method: 'POST', headers: local })
      expect(tcp.status).toBe(403)
      expect(onDaemonStop).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no `harness stop` route where no handler is given: a Mac or Linux core, unchanged', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath })
    server = started.server
    try {
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop', { 'x-adapter-local': '1' })).toBe(404)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] Run `npx vitest run src/core/daemonStopRoute.spec.ts src/hookServer.spec.ts -t "harness stop"`. Expected: the
  module is missing; the first route case answers 404 where it expects 202. The no-handler case already passes: it
  pins today's 404.

- [ ] **Implementation.** `cli/src/core/daemonStopRoute.ts`:

```ts
/**
 * `harness stop` as the core hears it on Windows: POST /api/daemon/stop, on the daemon's pipe only (hookServer.ts).
 * Windows has no signals, so the CLI cannot ask the master as it does on a Mac (SIGTERM to the pid in the pid file);
 * it asks the core, which asks its master (`harnessd:stop`, harnessd/protocol.ts), which stops the services and
 * this core in order (`harnessd:shutdown`) and exits. A core no master runs stops itself.
 */
export interface DaemonStopDeps {
  /** Ask the master to stop everything (harnessd/coreLink.ts `stopAll`); false when there is none. */
  askMaster(): boolean
  /** This core's own stop, for a core no master runs. */
  stopHere(): void
  /** Run after the answer has gone out: the stop closes the server that carries it. */
  defer?: (run: () => void) => void
}

/** What the route answers: hookServer.ts `PairOutcome`'s shape, kept here so the core imports no server type. */
export interface DaemonStopAnswer { status: number; body: Record<string, unknown> }

export function daemonStopHandler(deps: DaemonStopDeps): () => Promise<DaemonStopAnswer> {
  const defer = deps.defer ?? ((run: () => void) => { setImmediate(run) })
  return async () => {
    defer(() => { if (!deps.askMaster()) deps.stopHere() })
    return { status: 202, body: { ok: true } }
  }
}

/**
 * The handler for the server's handlers object, on Windows only. Elsewhere `harness stop` signals the master (the
 * pid file), and the core serves no such route: hookServer.ts registers it only when the handler is given.
 */
export function daemonStopRoute(deps: DaemonStopDeps, platform: NodeJS.Platform = process.platform): { onDaemonStop?: () => Promise<DaemonStopAnswer> } {
  return platform === 'win32' ? { onDaemonStop: daemonStopHandler(deps) } : {}
}
```

  `hookServer.ts` `HookHandlers`, after `onAuthHandoff`:

```ts
  /** POST /api/daemon/stop — `harness stop` on Windows (core/daemonStopRoute.ts). Trusted local only: over TCP any
   *  process on the machine, another user's included, could stop this user's daemon. Given on Windows only; without
   *  it the route does not exist (404), as before on a Mac or Linux. */
  onDaemonStop?: () => Promise<PairOutcome>
```

  The route, after the `/api/auth/handoff` block:

```ts
      // Stopping the daemon ends every agent's link to it: like the phone code above, the daemon's own trusted
      // endpoint only (the owner's socket; on Windows its pipe, with the token's proof, lib/localSocket.ts).
      // Windows only: the route exists when its handler is given (core/daemonStopRoute.ts daemonStopRoute).
      if (req.method === 'POST' && url === '/api/daemon/stop' && handlers.onDaemonStop) {
        if (!trustedLocal || !localOk) { json(403, { error: 'FORBIDDEN' }); return }
        await proxied(handlers.onDaemonStop); return
      }
```

  `core/main.ts`: import `daemonStopRoute` from `'./daemonStopRoute.js'`. In the handlers object after
  `onAuthHandoff` (line 1911):

```ts
    ...daemonStopRoute({ askMaster: () => coreLink.stopAll(), stopHere: () => void shutdown('harness stop') }),
```

  After line 2769 (`coreLink.onMasterGone(...)`):

```ts
  // Windows: the master's stop is a message (harnessd/protocol.ts `harnessd:shutdown`), never a signal.
  coreLink.onShutdown(() => void shutdown('the harnessd master asked this core to stop'))
```

  After line 2913 (safe mode's `onMasterGone`):

```ts
  coreLink.onShutdown(() => leave('the harnessd master asked this core to stop — leaving safe mode', 0))
```

- [ ] Run `npm run test:core && npx vitest run src/hookServer.spec.ts && npm run typecheck`. Expected: pass,
  `core/daemonStopRoute.ts` at 100%.
- [ ] Commit: `core: harness stop over the trusted endpoint; leave on harnessd:shutdown` —
  `git add cli/src/core/daemonStopRoute.ts cli/src/core/daemonStopRoute.spec.ts cli/src/hookServer.ts cli/src/hookServer.spec.ts cli/src/core/main.ts`

---

### Task B3.7: `terminateVerified` and the daemon's processes identified in the table

**Files**
- Create: `cli/src/lib/windows/terminate.ts`, `cli/src/lib/windows/terminate.spec.ts`
- Create: `cli/src/lib/windows/daemonProcesses.ts`, `cli/src/lib/windows/daemonProcesses.spec.ts`

**Interfaces**
- Produces: `terminateVerified(pid: number, startMarker: string, deps?: TerminateDeps): Promise<'ended' | 'gone' | 'mismatch'>`;
  `identifyDaemonProcess(rows: readonly ProcessRow[], pid: number, claim: DaemonProcessClaim): string | null`.
- Consumes: A's `windowsProcessRows` (`lib/windows/processTable.ts:90`), `ProcessRow` (`lib/processTable.ts`),
  `startMarkerMs` (B2.4 moved it to `lib/processProof.ts`; `ptyHost/launch.ts` only re-exports it).

- [ ] **Failing tests.** `terminate.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import { terminateVerified, type TerminateDeps } from './terminate.js'

const row = (pid: number, startMarker: string): ProcessRow => ({ pid, parentPid: 1, executable: 'node.exe', startMarker, args: 'node cli.js __run' })

function deps(rows: ProcessRow[] | null, kill: TerminateDeps['kill'] = vi.fn()): TerminateDeps {
  return { rows: async () => rows, kill }
}

describe('ending one Windows process', () => {
  it('ends the process it was meant to, after checking it is still that process', async () => {
    const kill = vi.fn()
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], kill))).resolves.toBe('ended')
    expect(kill).toHaveBeenCalledWith(500)
  })

  it('ends nothing when the pid is gone, was given to another process, or cannot be identified', async () => {
    const kill = vi.fn()
    await expect(terminateVerified(500, 'w:1', deps([row(501, 'w:1')], kill))).resolves.toBe('gone')
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:2')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(500, 'w:1', deps(null, kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(500, 'w:1', { rows: async () => { throw new Error('no host') }, kill })).resolves.toBe('mismatch')
    await expect(terminateVerified(500, '', deps([row(500, '')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(process.pid, 'w:1', deps([row(process.pid, 'w:1')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(0, 'w:1', deps([], kill))).resolves.toBe('mismatch')
    expect(kill).not.toHaveBeenCalled()
  })

  it('reads a process that left between the check and the end as gone', async () => {
    const gone = vi.fn(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], gone))).resolves.toBe('gone')
    const refused = vi.fn(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], refused))).resolves.toBe('mismatch')
  })
})
```

  `daemonProcesses.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import { identifyDaemonProcess } from './daemonProcesses.js'

// 2026-10-16T00:00:00Z as a FILETIME marker.
const at = (ms: number): string => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
const T = Date.parse('2026-10-16T00:00:00Z')
const row = (over: Partial<ProcessRow>): ProcessRow => ({
  pid: 500, parentPid: 4, executable: 'node.exe', startMarker: at(T), args: 'C:\\n\\node.exe C:\\h\\cli\\0.5.0\\cli.js __harnessd', ...over,
})

describe('the daemon\'s processes, in the process table', () => {
  it('knows the master by its command and by having started before it claimed the pid file', () => {
    expect(identifyDaemonProcess([row({})], 500, { role: 'master', claimedAtMs: T + 5_000 })).toBe(at(T))
    expect(identifyDaemonProcess([row({ args: 'node cli.js start -f' })], 500, { role: 'master' })).toBe(at(T))
    expect(identifyDaemonProcess([row({ nativeArgv: ['node.exe', 'cli.js', '__harnessd'], args: '' })], 500, { role: 'master' })).toBe(at(T))
  })

  it('refuses a pid that runs something else, started after the claim, is missing, or has no readable start', () => {
    expect(identifyDaemonProcess([row({ args: 'notepad.exe' })], 500, { role: 'master' })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: at(T + 60_000) })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: 'garbage' })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({})], 501, { role: 'master' })).toBeNull()
  })

  it('knows the core by its command and its parent, the master', () => {
    const core = row({ pid: 600, parentPid: 500, args: 'node.exe cli.js __run' })
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 500 })).toBe(at(T))
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 501 })).toBeNull()
  })
})
```

- [ ] Run `npx vitest run src/lib/windows/terminate.spec.ts src/lib/windows/daemonProcesses.spec.ts`. Expected: modules
  missing.

- [ ] **Implementation.** `cli/src/lib/windows/terminate.ts`:

```ts
/**
 * Ending one Windows process harnessd started, and that one only: TerminateProcess, once the process table says the
 * pid is still the process that was meant (pid plus start marker, A's identity proof, ./processTable.ts). A pid
 * alone is not enough: Windows hands a freed pid to the next process quickly.
 *
 * Never `taskkill /T`. The pty host's parent is the core, and the agents are the host's: ending the core's tree ends
 * every agent (spec section 3, "Stop"). Node's `process.kill` on Windows is TerminateProcess on that pid alone,
 * whatever the signal, which is all this calls. What is left is the moment between the table's read and the call;
 * the pid would have to exit and be reissued inside it.
 */
import type { ProcessRow } from '../processTable.js'
import { windowsProcessRows } from './processTable.js'

export type TerminateOutcome = 'ended' | 'gone' | 'mismatch'

export interface TerminateDeps {
  /** The process table: A's host `ps` (./processTable.ts); null when it cannot be read. */
  rows(): Promise<readonly ProcessRow[] | null>
  /** TerminateProcess on [pid]. */
  kill(pid: number): void
}

export const defaultTerminateDeps: TerminateDeps = {
  rows: () => windowsProcessRows(null),
  kill: (pid) => { process.kill(pid, 'SIGKILL') },
}

/** End [pid] if it still started at [startMarker]: `ended`; `gone` when nothing runs as it; `mismatch` when it is
 *  another process now, or could not be identified (no table, no marker), and was left alone. */
export async function terminateVerified(pid: number, startMarker: string, deps: TerminateDeps = defaultTerminateDeps): Promise<TerminateOutcome> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !startMarker) return 'mismatch'
  const rows = await deps.rows().catch(() => null)
  if (!rows) return 'mismatch'
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return 'gone'
  if (row.startMarker !== startMarker) return 'mismatch'
  try {
    deps.kill(pid)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'mismatch'
  }
  return 'ended'
}
```

  `cli/src/lib/windows/daemonProcesses.ts`:

```ts
/**
 * Which row of the Windows process table is harnessd's master or its core, for a CLI that has only a pid from a file
 * (the pid file, the master's status file). Before anything is ended, the pid must run the daemon's command, and:
 * the master must have started before it claimed the pid file (it claims it once its core has bound; a process
 * that started later was given the pid since); the core must be the master's child. The row's start marker is what
 * `terminateVerified` then checks again, right before the end.
 */
import type { ProcessRow } from '../processTable.js'
import { startMarkerMs } from '../processProof.js'

export type DaemonRole = 'master' | 'core'

export interface DaemonProcessClaim {
  role: DaemonRole
  /** The core's: the master's pid. */
  parentPid?: number
  /** The master's: when the pid file was written, ms since the epoch. */
  claimedAtMs?: number
}

/** A FILETIME is exact; this covers a clock that moved and a file system's own rounding. */
const CLAIM_SLACK_MS = 2_000

function runsAs(argv: readonly string[], role: DaemonRole): boolean {
  if (role === 'core') return argv.includes('__run')
  // `harness start -f` runs the master in that process (masterProcess.ts startMasterInForeground).
  return argv.includes('__harnessd') || (argv.includes('start') && (argv.includes('-f') || argv.includes('--foreground')))
}

/** The start marker of [pid] when it is the daemon's [claim.role]; null when it is not, or cannot be shown to be. */
export function identifyDaemonProcess(rows: readonly ProcessRow[], pid: number, claim: DaemonProcessClaim): string | null {
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row || !row.startMarker) return null
  const argv = row.nativeArgv ?? row.args.split(/\s+/).filter(Boolean)
  if (!runsAs(argv, claim.role)) return null
  if (claim.parentPid !== undefined && row.parentPid !== claim.parentPid) return null
  if (claim.claimedAtMs !== undefined) {
    const started = startMarkerMs(row.startMarker)
    if (started === null || started > claim.claimedAtMs + CLAIM_SLACK_MS) return null
  }
  return row.startMarker
}
```

- [ ] Run the two specs. Expected: pass.
- [ ] Commit: `windows: terminateVerified and the daemon's processes in the table` —
  `git add cli/src/lib/windows/terminate.ts cli/src/lib/windows/terminate.spec.ts cli/src/lib/windows/daemonProcesses.ts cli/src/lib/windows/daemonProcesses.spec.ts`

---

### Task B3.8: Asking the daemon to stop over its pipe

**Files**
- Create: `cli/src/lib/windows/daemonStopCall.ts`, `cli/src/lib/windows/daemonStopCall.spec.ts`

**Interfaces**
- Produces: `askDaemonToStop(deps: StopCallDeps): Promise<boolean>`,
  `processStopCallDeps(dataDir: string, configuredPort: number): StopCallDeps`,
  `interface StopCallDeps { pipe(): Promise<PipeTarget | null>; request(target: PipeTarget, request: PipeRequest): Promise<PipeReply> }`,
  `DAEMON_STOP_PATH = '/api/daemon/stop'`, `STOP_CALL_TIMEOUT_MS = 3_000`.
- Consumes: B2.11 `daemonPipe(dataDir, configuredPort, liveness?): Promise<PipeTarget | null>`
  (`cli/src/lib/daemonEndpoint.ts`: the record's `pipe` and `pid`, the token, A's dead-process check); B2.6
  `pipeRequest`, `PipeTarget`, `PipeRequest`, `PipeReply`, `PipeUnproven` (`cli/src/lib/windows/pipeClient.ts`: the
  auth with a nonce bound to the pipe's id, and the proof check); B2.5 `listenLocalSocket(…, { token })` in the test;
  B3.6 route.

- [ ] **Failing test.** `daemonStopCall.spec.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenLocalSocket } from '../localSocket.js'
import { newPipePath } from './pipeAuth.js'
import { pipeRequest, PipeUnproven, type PipeReply, type PipeTarget } from './pipeClient.js'
import { askDaemonToStop, DAEMON_STOP_PATH, STOP_CALL_TIMEOUT_MS } from './daemonStopCall.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A real pipe on Windows; elsewhere a Unix socket with a pipe's name (as in pipeClient.spec.ts). */
function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hstop-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

const target: PipeTarget = { pipe: `\\\\.\\pipe\\harness-${'a'.repeat(32)}`, token: Buffer.alloc(32, 7) }
const reply = (status: number): PipeReply => ({ status, headers: {}, body: '{}' })

describe('harness stop over the pipe', () => {
  it('posts the stop as a local control call to the pipe daemonPipe found, and takes 202 as yes', async () => {
    const request = vi.fn(async () => reply(202))
    await expect(askDaemonToStop({ pipe: async () => target, request })).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(target, {
      method: 'POST', path: DAEMON_STOP_PATH, headers: { 'x-adapter-local': '1' }, timeoutMs: STOP_CALL_TIMEOUT_MS, maxBytes: 4_096,
    })
    await expect(askDaemonToStop({ pipe: async () => target, request: async () => reply(403) })).resolves.toBe(false)
  })

  it('asks nothing without a pipe, and takes no for an unproven answer, nothing listening, or a timeout', async () => {
    const request = vi.fn(async () => reply(202))
    await expect(askDaemonToStop({ pipe: async () => null, request })).resolves.toBe(false)
    await expect(askDaemonToStop({ pipe: async () => { throw new Error('unreadable record') }, request })).resolves.toBe(false)
    expect(request).not.toHaveBeenCalled()
    for (const error of [new PipeUnproven(target.pipe), Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }), new Error('The operation was aborted due to timeout')]) {
      await expect(askDaemonToStop({ pipe: async () => target, request: async () => { throw error } })).resolves.toBe(false)
    }
  })

  it('is taken only by the daemon that holds the token, on a real listener', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    const asked: string[] = []
    const server = await listenLocalSocket((req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers['x-adapter-local']}`)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }, pipe, { token })
    cleanup.push(server.close)
    await expect(askDaemonToStop({ pipe: async () => ({ pipe, token }), request: pipeRequest })).resolves.toBe(true)
    expect(asked).toEqual([`POST ${DAEMON_STOP_PATH} 1`])
    // Another token: the daemon answers 401 without the proof, and the handler never runs.
    await expect(askDaemonToStop({ pipe: async () => ({ pipe, token: randomBytes(32) }), request: pipeRequest })).resolves.toBe(false)
    expect(asked).toHaveLength(1)
  })
})
```

- [ ] Run `npx vitest run src/lib/windows/daemonStopCall.spec.ts`. Expected: module missing.

- [ ] **Implementation.** `cli/src/lib/windows/daemonStopCall.ts`:

```ts
/**
 * `harness stop` on Windows, the CLI's half: POST /api/daemon/stop to the core over the daemon's pipe, which asks its
 * master to stop everything (core/daemonStopRoute.ts). The pipe, its token and the dead-process check come from
 * lib/daemonEndpoint.ts `daemonPipe`; the auth (a nonce bound to the pipe's id) and the proof check from
 * ./pipeClient.ts `pipeRequest`. Reaching the pipe proves nothing on Windows, so only an answer with the token's
 * proof counts: a process that took the pipe's name after the daemon died is never believed.
 */
import { daemonPipe } from '../daemonEndpoint.js'
import { pipeRequest, type PipeReply, type PipeRequest, type PipeTarget } from './pipeClient.js'

export const DAEMON_STOP_PATH = '/api/daemon/stop'
/** The core answers at once and stops after: a pipe that holds the call longer is not the daemon. */
export const STOP_CALL_TIMEOUT_MS = 3_000

export interface StopCallDeps {
  /** The daemon's pipe and token (lib/daemonEndpoint.ts `daemonPipe`); null when there is none to dial. */
  pipe(): Promise<PipeTarget | null>
  /** One proven request (./pipeClient.ts `pipeRequest`): it rejects an answer without the token's proof. */
  request(target: PipeTarget, request: PipeRequest): Promise<PipeReply>
}

export function processStopCallDeps(dataDir: string, configuredPort: number): StopCallDeps {
  return { pipe: () => daemonPipe(dataDir, configuredPort), request: pipeRequest }
}

/** Whether the daemon took the stop: it answered 202, with the token's proof. */
export async function askDaemonToStop(deps: StopCallDeps): Promise<boolean> {
  const target = await deps.pipe().catch(() => null)
  if (!target) return false
  try {
    const reply = await deps.request(target, {
      method: 'POST', path: DAEMON_STOP_PATH, headers: { 'x-adapter-local': '1' }, timeoutMs: STOP_CALL_TIMEOUT_MS, maxBytes: 4_096,
    })
    return reply.status === 202
  } catch {
    // PipeUnproven (not this user's daemon), nothing listening, or no answer in time: not taken.
    return false
  }
}
```

- [ ] Run the spec. Expected: pass.
- [ ] Commit: `windows: ask the daemon to stop over its pipe` —
  `git add cli/src/lib/windows/daemonStopCall.ts cli/src/lib/windows/daemonStopCall.spec.ts`

---

### Task B3.9: `harness stop` on Windows: ask, wait, then end only what was identified

**Files**
- Modify: `cli/src/lib/daemonStop.ts:10-56` (imports, `StopDeps`, `defaultStopDeps`), `:72-96` (`stopDaemonProcess`)
- Modify: `cli/src/lib/daemonStop.spec.ts` (new `describe`)

**Interfaces**
- Produces: `StopDeps.windows?: WindowsStopDeps`; `WINDOWS_STOP_WAIT_MS = 8_000`; `ORPHAN_CORE_WAIT_MS = 5_000`.
- Consumes: B3.7 `terminateVerified`, `identifyDaemonProcess`; B3.8 `askDaemonToStop`; `waitGone`
  (`lib/platformDaemon.ts:176`); `readStatusFile` (`harnessd/master.ts:170`).

- [ ] **Failing test.** Append to `daemonStop.spec.ts`:

```ts
describe('stopDaemonProcess on Windows', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-stop-win-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.ADAPTER_DATA_DIR })

  const T = Date.parse('2026-10-16T00:00:00Z')
  const marker = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
  const master = { pid: 500, parentPid: 4, executable: 'node.exe', startMarker: marker(T), args: 'node.exe cli.js __harnessd' }
  const core = { pid: 600, parentPid: 500, executable: 'node.exe', startMarker: marker(T + 1_000), args: 'node.exe cli.js __run' }

  function windows(state: { pid: number | null; alive: Set<number>; killed: string[]; locked: number; released: number }, over: Partial<NonNullable<StopDeps['windows']>> = {}) {
    const ended: string[] = []
    const w: NonNullable<StopDeps['windows']> = {
      ask: async () => true,
      rows: async () => [master, core],
      terminate: async (pid, startMarker) => { ended.push(`${pid}:${startMarker}`); state.alive.delete(pid); return 'ended' },
      pidFileWrittenMs: () => T + 5_000,
      corePid: () => 600,
      ...over,
    }
    return { w, ended }
  }

  it('asks the core over its pipe and waits for the master to stop the rest — no signal, nothing ended', async () => {
    const { stopDaemonProcess } = await load()
    const state = { pid: 500, alive: new Set([500, 600]), killed: [] as string[], locked: 0, released: 0 }
    const { w, ended } = windows(state, { ask: async () => { state.alive.clear(); return true } })
    await expect(stopDaemonProcess(fakeDeps(state, { windows: w }))).resolves.toEqual({ pid: 500, stopped: true })
    expect(state.killed).toEqual([])
    expect(ended).toEqual([])
  })

  it('ends the master it identified, then a core left hung, each by itself — never by tree', async () => {
    const { stopDaemonProcess } = await load()
    const state = { pid: 500, alive: new Set([500, 600]), killed: [] as string[], locked: 0, released: 0 }
    const warned: string[] = []
    const { w, ended } = windows(state, { ask: async () => false })
    await stopDaemonProcess(fakeDeps(state, { windows: w, warn: (line) => warned.push(line) }))
    expect(ended).toEqual([`500:${marker(T)}`, `600:${marker(T + 1_000)}`])
    expect(state.killed).toEqual([])
    expect(warned).toEqual(['  ! the daemon did not take the stop over its pipe — ending it'])
  })

  it('ends nothing it could not identify: a pid given to another process, or no process table', async () => {
    const { stopDaemonProcess } = await load()
    for (const rows of [async () => [{ ...master, startMarker: marker(T + 60_000) }], async () => null]) {
      const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      const warned: string[] = []
      const { w, ended } = windows(state, { ask: async () => false, rows, corePid: () => null })
      await expect(stopDaemonProcess(fakeDeps(state, { windows: w, warn: (line) => warned.push(line) }))).resolves.toEqual({ pid: 500, stopped: false })
      expect(ended).toEqual([])
      expect(warned.at(-1)).toBe('  ! pid 500 could not be shown to be harnessd\'s master — it was left running')
    }
  })

  it('says so when the master changed between the look and the end', async () => {
    const { stopDaemonProcess } = await load()
    const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
    const warned: string[] = []
    const { w } = windows(state, { ask: async () => false, corePid: () => null, terminate: async () => 'mismatch' })
    await stopDaemonProcess(fakeDeps(state, { windows: w, warn: (line) => warned.push(line) }))
    expect(warned.at(-1)).toBe('  ! pid 500 is no longer harnessd\'s master — it was left running')
  })
})
```

- [ ] Run `npx vitest run src/lib/daemonStop.spec.ts`. Expected: the Windows cases fail (signals are sent).

- [ ] **Implementation.** `daemonStop.ts` imports:

```ts
import { rmSync, statSync } from 'fs'
import { env } from '../config/env.js'
import { readStatusFile } from '../harnessd/master.js'
import type { ProcessRow } from './processTable.js'
import { HARNESSD_REEXEC_FILE, HARNESSD_STATUS_FILE, PID_FILE, isAlive, readPid } from './daemonState.js'
import { readMarker, removeMarker } from '../harnessd/reexec.js'
import { acquireSpawnLock, describeSpawnLockFailure, describeSpawnLockOwner, SPAWN_LOCK_WAIT_MS } from './daemonSpawnLock.js'
import { PLATFORM_STOP_WAIT_MS, stopUnderPlatform, waitGone, type PlatformStop } from './platformDaemon.js'
import { identifyDaemonProcess } from './windows/daemonProcesses.js'
import { askDaemonToStop, processStopCallDeps } from './windows/daemonStopCall.js'
import { windowsProcessRows } from './windows/processTable.js'
import { terminateVerified, type TerminateOutcome } from './windows/terminate.js'
```

  `StopDeps`, after `stopPlatform?`:

```ts
  /** Windows has no signals: how the daemon is stopped there (`stopOnWindows`). Left out, signals. */
  windows?: WindowsStopDeps
}

export interface WindowsStopDeps {
  /** POST /api/daemon/stop over the pipe (./windows/daemonStopCall.ts): whether the daemon took it. */
  ask(): Promise<boolean>
  rows(): Promise<readonly ProcessRow[] | null>
  terminate(pid: number, startMarker: string): Promise<TerminateOutcome>
  /** When the pid file was written: the master claimed it after it started. */
  pidFileWrittenMs(): number | null
  /** The core the master's status file names. */
  corePid(masterPid: number): number | null
}

/** How long the master has to stop its core (2.5 s, then it ends it) and its services beside it, and exit. */
export const WINDOWS_STOP_WAIT_MS = 8_000
/** How long a core whose master was ended has to leave by itself: it stops once its master's channel closes. */
export const ORPHAN_CORE_WAIT_MS = 5_000

export function defaultWindowsStopDeps(): WindowsStopDeps {
  return {
    ask: () => askDaemonToStop(processStopCallDeps(env.ADAPTER_DATA_DIR, env.PORT)),
    rows: () => windowsProcessRows(null),
    terminate: (pid, startMarker) => terminateVerified(pid, startMarker),
    pidFileWrittenMs: () => { try { return statSync(PID_FILE).mtimeMs } catch { return null } },
    corePid: (masterPid) => readStatusFile(HARNESSD_STATUS_FILE, masterPid)?.corePid ?? null,
  }
}
```

  In `defaultStopDeps()`, after `stopPlatform`:

```ts
    ...(process.platform === 'win32' ? { windows: defaultWindowsStopDeps() } : {}),
```

  In `stopDaemonProcess`, replace the signal block (from `try { deps.kill(pid, 'SIGTERM') }` through the
  `return { pid, stopped: true }`) with:

```ts
    if (deps.windows) return await stopOnWindows(deps, deps.windows, pid)
    try { deps.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = deps.now() + STOP_GRACE_MS
    while (deps.now() < deadline && deps.isAlive(pid)) await deps.sleep(150)
    if (deps.isAlive(pid)) { try { deps.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    forgetPid(deps, pid)
    return { pid, stopped: true }
```

  and add below it:

```ts
/** Only if it is still OUR daemon's file: a stopped daemon removes its own pid on the way out, and a daemon that
 *  came up meanwhile — impossible under the lock, but cheap to respect — must not lose its record to us. */
function forgetPid(deps: StopDeps, pid: number): void {
  if (deps.readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
  if (!deps.isAlive(pid)) clearReexecMarker(pid)
}

/**
 * Windows: no SIGTERM to send. The core is asked over its pipe (POST /api/daemon/stop), and asks its master, which
 * stops the services and the core in order and exits. A daemon that does not take it, or does not go in time, is
 * ended one process at a time with TerminateProcess, and only a process identified first (./windows/daemonProcesses.ts):
 * the master, then a core its end left behind. Never by tree: the pty host's parent is the core, and every agent
 * lives under it.
 */
async function stopOnWindows(deps: StopDeps, windows: WindowsStopDeps, pid: number): Promise<{ pid: number; stopped: boolean }> {
  // Looked up before anything is asked: once the master goes, its core has no parent to be told by.
  const rows = await windows.rows().catch(() => null)
  const claimedAtMs = windows.pidFileWrittenMs()
  const master = rows ? identifyDaemonProcess(rows, pid, { role: 'master', ...(claimedAtMs !== null ? { claimedAtMs } : {}) }) : null
  const corePid = windows.corePid(pid)
  const core = rows && corePid !== null ? identifyDaemonProcess(rows, corePid, { role: 'core', parentPid: pid }) : null
  const asked = await windows.ask()
  if (!asked) deps.warn('  ! the daemon did not take the stop over its pipe — ending it')
  if (!asked || !await waitGone(deps, pid, WINDOWS_STOP_WAIT_MS)) {
    if (!master) {
      deps.warn(`  ! pid ${pid} could not be shown to be harnessd's master — it was left running`)
      return { pid, stopped: false }
    }
    if (await windows.terminate(pid, master) === 'mismatch') deps.warn(`  ! pid ${pid} is no longer harnessd's master — it was left running`)
  }
  if (core && corePid !== null && !await waitGone(deps, corePid, ORPHAN_CORE_WAIT_MS)) await windows.terminate(corePid, core)
  forgetPid(deps, pid)
  return { pid, stopped: !deps.isAlive(pid) }
}
```

- [ ] Run `npx vitest run src/lib/daemonStop.spec.ts`. Expected: pass; the existing cases are unchanged (no `windows`).
- [ ] Commit: `cli: harness stop on Windows asks the core, then ends only what it identified` —
  `git add cli/src/lib/daemonStop.ts cli/src/lib/daemonStop.spec.ts`

---

### Task B3.10: The spawn lock on Windows

The lock refuses any owner record whose mode is not 0700/0600 (`daemonSpawnLock.ts:142-147`). Windows reports
0o666/0o777, so a lock held by someone else reads as "not a lock this CLI made" and the waiter fails instead of
waiting. A crashed holder is never reclaimed either. A pid alone is the owner's identity there
(`processLiveness.ts:9`): a crashed holder's pid reused by another process would hold `--if-down` back forever.

**Files**
- Modify: `cli/src/lib/daemonSpawnLock.ts:138-164` (`readSpawnLockOwner`), new exports after `reclaimIfStale` (`:226`)
- Modify: `cli/src/lib/daemonSpawnLock.spec.ts` (new cases)

**Interfaces**
- Produces: `readSpawnLockOwner(platform?: NodeJS.Platform): SpawnLockOwner | null`;
  `spawnLockOwnerReused(owner: SpawnLockOwner, row: { startMarker: string } | null): boolean`;
  `releaseAbandonedSpawnLock(owner: SpawnLockOwner): boolean`.

- [ ] **Failing tests.**

```ts
  it('on Windows, reads an owner whatever its mode says: Windows reports 0666, and the profile\'s ACL is what protects it', async () => {
    const lock = await loadLock()
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({ pid: 4242, startMarker: '', token: 't', purpose: 'start', since: 1 }), { mode: 0o666 })
    spawnSync('chmod', ['0777', lockDir()])
    spawnSync('chmod', ['0666', ownerFile()])
    expect(() => lock.readSpawnLockOwner('darwin')).toThrow(/unsafe owner, mode, or type/)
    expect(lock.readSpawnLockOwner('win32')).toMatchObject({ pid: 4242, token: 't', purpose: 'start' })
  })

  it('knows a Windows owner whose pid now runs a process that started after it took the lock', async () => {
    const lock = await loadLock()
    const owner = { pid: 4242, startMarker: '', token: 't', purpose: 'start' as const, since: Date.parse('2026-10-16T00:00:00Z') }
    const at = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
    expect(lock.spawnLockOwnerReused(owner, { startMarker: at(owner.since - 1_000) })).toBe(false)
    expect(lock.spawnLockOwnerReused(owner, { startMarker: at(owner.since + 60_000) })).toBe(true)
    expect(lock.spawnLockOwnerReused(owner, null)).toBe(false)
    expect(lock.spawnLockOwnerReused(owner, { startMarker: 'unreadable' })).toBe(false)
  })

  it('releases an abandoned lock only while it is still the one that was judged', async () => {
    const lock = await loadLock()
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({ pid: 4242, startMarker: '', token: 't', purpose: 'start', since: 1 }), { mode: 0o600 })
    const judged = lock.readSpawnLockOwner()!
    expect(lock.releaseAbandonedSpawnLock({ ...judged, token: 'other' })).toBe(false)
    expect(existsSync(lockDir())).toBe(true)
    expect(lock.releaseAbandonedSpawnLock(judged)).toBe(true)
    expect(existsSync(lockDir())).toBe(false)
  })
```

- [ ] Run `npx vitest run src/lib/daemonSpawnLock.spec.ts`. Expected: 3 failures.

- [ ] **Implementation.** `readSpawnLockOwner`:

```ts
export function readSpawnLockOwner(platform: NodeJS.Platform = process.platform): SpawnLockOwner | null {
  const me = uid()
  // Windows has no modes worth the name (it reports 0666 or 0777) and no uid: the data folder is in the user's
  // profile, checked when the lock is made (secureStateDirectory), and its ACL is what keeps others out.
  const windows = platform === 'win32'
  try {
    const dir = lstatSync(SPAWN_LOCK_DIR)
    if (!dir.isDirectory() || dir.isSymbolicLink() || (!windows && ((me !== null && dir.uid !== me) || (dir.mode & 0o777) !== 0o700))) {
      throw new Error(`daemon spawn lock ${SPAWN_LOCK_DIR} has an unsafe owner, mode, or type`)
    }
    const file = lstatSync(ownerPath())
    if (!file.isFile() || file.isSymbolicLink() || (!windows && ((me !== null && file.uid !== me) || (file.mode & 0o777) !== 0o600))) {
      throw new Error(`daemon spawn lock owner ${ownerPath()} has an unsafe owner, mode, or type`)
    }
    // …the rest of the function is unchanged
```

  After `reclaimIfStale` (`:226`):

```ts
/**
 * Windows: whether the lock's owner pid now runs another process, one that started after the lock was taken. A pid
 * is all Windows gives the owner record (lib/processLiveness.ts), and Windows reuses pids quickly: a holder that
 * crashed left a lock its pid's next process "held" for good, and `harness start --if-down`, which the scheduled
 * task runs every five minutes, never started the daemon again. [row] is the pid's row in the process table, null
 * when there is none or the table could not be read; without a readable start there is no proof.
 */
export function spawnLockOwnerReused(owner: SpawnLockOwner, row: { startMarker: string } | null): boolean {
  if (!row) return false
  const started = startMarkerMs(row.startMarker)
  return started !== null && started > owner.since + 2_000
}

/** Remove a lock judged abandoned (`spawnLockOwnerReused`), only while it still names that owner. */
export function releaseAbandonedSpawnLock(owner: SpawnLockOwner): boolean {
  try {
    if (readSpawnLockOwner()?.token !== owner.token) return false
    rmSync(SPAWN_LOCK_DIR, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
```

  Import `startMarkerMs` from `'./processProof.js'` (B2.4; it keeps the pty host's launcher out of the lock's imports).

- [ ] Run `npx vitest run src/lib/daemonSpawnLock.spec.ts`. Expected: pass; the mac cases are unchanged.
- [ ] Commit: `cli: the spawn lock on Windows: no modes, and a reused pid is no owner` —
  `git add cli/src/lib/daemonSpawnLock.ts cli/src/lib/daemonSpawnLock.spec.ts`

---
### Task B3.11: Starting through `harness-launch.exe`

**Files**
- Create: `cli/src/lib/windows/launcher.ts`, `cli/src/lib/windows/launcher.spec.ts`

**Interfaces**
- Produces: `launchDetached(launcher: string, root: string, args: readonly string[], env: NodeJS.ProcessEnv, run?, timeoutMs?): Promise<LaunchOutcome>`.
- Consumes: B1's `harness-launch.exe [--root <dir>] -- <cli args...>`, exit 0 after spawn, non-zero with a line in
  `<root>\cli\data\logs\launch.log`; B1.1 `harnessLaunchPath(rootDir)`
  (`cli/src/lib/windows/installLayout.ts`), not redefined here: callers pass it the root, `dirname(env.ADAPTER_CLI_DIR)`.

- [ ] **Failing test.**

```ts
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { LAUNCH_TIMEOUT_MS, launchDetached, type LaunchRun } from './launcher.js'

function fakeRun(end: (child: EventEmitter) => void) {
  const runs: Array<{ file: string; args: readonly string[]; options: object }> = []
  const run: LaunchRun = (file, args, options) => {
    runs.push({ file, args, options })
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    queueMicrotask(() => end(child))
    return child as unknown as ChildProcess
  }
  return { run, runs }
}

describe('the windowless launcher', () => {
  it('is given its root and the CLI\'s arguments, hidden, with this environment, and has started them once it exits 0', async () => {
    const { run, runs } = fakeRun((child) => child.emit('exit', 0, null))
    await expect(launchDetached('C:\\h\\bin\\harness-launch.exe', 'C:\\h', ['start', '--if-down'], { A: '1' }, run)).resolves.toEqual({ ok: true })
    expect(runs).toEqual([{ file: 'C:\\h\\bin\\harness-launch.exe', args: ['--root', 'C:\\h', '--', 'start', '--if-down'], options: { env: { A: '1' }, windowsHide: true, stdio: 'ignore' } }])
  })

  it('says why it could not start them: an exit code and where it logged, a launcher that cannot run, one that hangs', async () => {
    const failed = await launchDetached('C:\\h\\bin\\harness-launch.exe', 'C:\\h', ['__harnessd'], {}, fakeRun((child) => child.emit('exit', 3, null)).run)
    expect(failed).toEqual({ ok: false, detail: `C:\\h\\bin\\harness-launch.exe exited 3 — see ${join('C:\\h', 'cli', 'data', 'logs', 'launch.log')}` })
    const missing = await launchDetached('L', 'C:\\h', [], {}, fakeRun((child) => child.emit('error', new Error('spawn L ENOENT'))).run)
    expect(missing).toEqual({ ok: false, detail: 'L could not be run: spawn L ENOENT' })
    const thrown = await launchDetached('L', 'C:\\h', [], {}, () => { throw new Error('EMFILE') })
    expect(thrown).toEqual({ ok: false, detail: 'L could not be run: EMFILE' })
    vi.useFakeTimers()
    try {
      // Cast, not annotated: assigned only in a callback, an annotated `null` stays narrowed to null (TS2339 below).
      let hung = null as (EventEmitter & { kill: ReturnType<typeof vi.fn> }) | null
      const pending = launchDetached('L', 'C:\\h', [], {}, fakeRun((child) => { hung = child as never }).run)
      await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({ ok: false, detail: `L did not return within ${LAUNCH_TIMEOUT_MS} ms` })
      expect(hung!.kill).toHaveBeenCalled()
      hung!.emit('exit', 0, null)
    } finally { vi.useRealTimers() }
  })
})
```

- [ ] Run `npx vitest run src/lib/windows/launcher.spec.ts`. Expected: module missing.

- [ ] **Implementation.** `cli/src/lib/windows/launcher.ts`:

```ts
/**
 * `bin\harness-launch.exe` (B1, pty/src/bin/harness-launch.rs): how every background start on Windows begins — the
 * scheduled task, `harness start` from a terminal, a master handing over to its replacement (spec section 1,
 * "Launchers"). It starts `node.exe <cli\current>\cli.js <args>` windowless and outside any job object, then exits:
 * a master Node started itself (`detached`) stayed in the terminal's job, and closing that terminal or the SSH session
 * ended it. Given `--root`, so a CLI on another ADAPTER_CLI_DIR starts its own build, never the profile's. Where the
 * launcher is: ./installLayout.ts `harnessLaunchPath(root)`, the root being the folder `cli\` is in.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** It resolves two pointers and starts a process: a launcher that has not returned by then is stuck. */
export const LAUNCH_TIMEOUT_MS = 30_000

export type LaunchOutcome = { ok: true } | { ok: false; detail: string }
export type LaunchRun = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; windowsHide: true; stdio: 'ignore' }) => ChildProcess

/** Start the CLI with [args] through [launcher]; resolves once the launcher has said whether it started it. */
export function launchDetached(
  launcher: string, root: string, args: readonly string[], env: NodeJS.ProcessEnv,
  run: LaunchRun = (file, argv, options) => spawn(file, [...argv], options), timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    let child: ChildProcess
    const timer = setTimeout(() => {
      settle({ ok: false, detail: `${launcher} did not return within ${timeoutMs} ms` })
      try { child.kill() } catch { /* gone */ }
    }, timeoutMs)
    try {
      child = run(launcher, ['--root', root, '--', ...args], { env, windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      settle({ ok: false, detail: `${launcher} could not be run: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    child.once('error', (error) => settle({ ok: false, detail: `${launcher} could not be run: ${error.message}` }))
    child.once('exit', (code) => settle(code === 0 ? { ok: true } : { ok: false, detail: `${launcher} exited ${code} — see ${join(root, 'cli', 'data', 'logs', 'launch.log')}` }))
  })
}
```

  The task XML (B3.12) passes the same `--root`.

- [ ] Run `npx vitest run src/lib/windows/launcher.spec.ts && npm run typecheck`. Expected: pass, and the typecheck is
  clean.
- [ ] Commit: `windows: start the CLI through harness-launch.exe` —
  `git add cli/src/lib/windows/launcher.ts cli/src/lib/windows/launcher.spec.ts`

---

### Task B3.12: The Task Scheduler platform

**Files**
- Modify: `cli/src/harnessd/platform.ts:15-18` (imports), `:20` (`PlatformName`), `:58-61` (`platformFor`), `:70-96`
  (`ServiceDefinition`, `checked`), new block after `:218` (task XML), `:228-274` (`PlatformDeps`,
  `defaultPlatformDeps`), `:324-549` (`PlatformService` branches)
- Modify: `cli/src/harnessd/platform.spec.ts:46-50` (win32 is now Task Scheduler), new `describe` blocks

**Interfaces**
- Produces: `PlatformName = 'launchd' | 'systemd' | 'taskscheduler'`; `taskName(user: string): string`
  (`Harness harnessd (<account>)`, in Task Scheduler's root folder; `<account>` is `user` after its last `\`);
  `TASK_REPEAT = 'PT5M'`; `TASK_FILE`, `TASK_STOPPED_FILE`; `PLATFORM_LABEL`; `taskSchedulerXml(opts: TaskDefinition): string`;
  `stoppedThisBoot(text: string | null, bootMs: number): boolean`; `ServiceDefinition.launcherPath?: string`;
  `PlatformDeps.user?`, `.dataDir?`, `.bootTime?`. `PlatformService.target` on Task Scheduler is
  `taskName(deps.user ?? userInfo().username)`: one source for the task's name and its XML's `<UserId>`.
- Consumes: B1's launcher usage `harness-launch.exe [--root <dir>] -- <cli args...>`.

- [ ] **Failing tests.** In `platform.spec.ts` change the first case's third expectation to
  `expect(platformFor('win32')).toBe('taskscheduler')` (and its title to `'is launchd on macOS, systemd on Linux,
  Task Scheduler on Windows, and none elsewhere'`, adding `expect(platformFor('freebsd')).toBeNull()`). Add
  `TASK_REPEAT, PLATFORM_LABEL, stoppedThisBoot, taskName, taskSchedulerXml` to the import, and `userInfo` to the
  `node:os` import, then:

```ts
const task = {
  launcherPath: 'C:\\Users\\Demo User\\.harness\\bin\\harness-launch.exe',
  root: 'C:\\Users\\Demo User\\.harness',
  home: 'C:\\Users\\Demo User',
  logFile: 'C:\\Users\\Demo User\\.harness\\cli\\data\\harness.log',
  user: 'DESKTOP-1\\Demo User',
}

describe('the scheduled task', () => {
  // Task names are machine-wide, and a task folder one user creates can refuse another standard user: a fixed
  // `\Harness\harnessd` would let only the first user on a computer install (Review Focus 1).
  it('is named per user, in the root folder', () => {
    expect(taskName('alice')).toBe('Harness harnessd (alice)')
    expect(taskName('DESKTOP-1\\Demo User')).toBe('Harness harnessd (Demo User)')
    expect(taskName('Nguy\u1ec5n V\u0103n A')).toBe('Harness harnessd (Nguy\u1ec5n V\u0103n A)')
    expect(taskName('bob')).not.toBe(taskName('alice'))
    expect(taskName('DESKTOP-1\\alice')).not.toContain('\\')
  })

  it('starts `harness start --if-down` at logon and every five minutes, once at a time, with no time limit', () => {
    const text = taskSchedulerXml(task)
    expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(text).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DESKTOP-1\\Demo User<\/UserId>\s*<\/LogonTrigger>/)
    expect(text).toMatch(new RegExp(`<TimeTrigger>[\\s\\S]*<Repetition>\\s*<Interval>${TASK_REPEAT}</Interval>\\s*<StopAtDurationEnd>false</StopAtDurationEnd>\\s*</Repetition>[\\s\\S]*</TimeTrigger>`))
    expect(text).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(text).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(text).toMatch(/<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/)
    expect(text).toContain('<Command>C:\\Users\\Demo User\\.harness\\bin\\harness-launch.exe</Command>')
    expect(text).toContain('<Arguments>--root &quot;C:\\Users\\Demo User\\.harness&quot; -- start --if-down</Arguments>')
    expect(text).toContain('<WorkingDirectory>C:\\Users\\Demo User</WorkingDirectory>')
    expect(text).toContain('<Description>harnessd, the Harness daemon. Its log: C:\\Users\\Demo User\\.harness\\cli\\data\\harness.log</Description>')
    // An XML comment may not hold two hyphens in a row: the whole text must parse as one.
    expect(text.match(/<!--([\s\S]*?)-->/g)!.every((comment) => !comment.slice(4, -3).includes('--'))).toBe(true)
    expect(taskSchedulerXml(task)).toBe(text)
  })

  it('escapes what XML would misread, and refuses a relative path, a path across lines or no user', () => {
    expect(taskSchedulerXml({ ...task, user: 'A&B <x>' })).toContain('<UserId>A&amp;B &lt;x&gt;</UserId>')
    expect(() => taskSchedulerXml({ ...task, launcherPath: 'bin\\harness-launch.exe' })).toThrow(/must be absolute/)
    expect(() => taskSchedulerXml({ ...task, home: 'C:\\a\nb' })).toThrow(/must be absolute/)
    expect(() => taskSchedulerXml({ ...task, root: 'C:\\a"b' })).toThrow(/cannot hold a quote/)
    expect(() => taskSchedulerXml({ ...task, user: '' })).toThrow(/the user it runs for/)
    expect(() => taskSchedulerXml({ ...task, user: 'a\nb' })).toThrow(/the user it runs for/)
  })

  it('remembers a stop for as long as this computer runs, and not past its next start', () => {
    const boot = Date.parse('2026-10-16T08:00:00Z')
    expect(stoppedThisBoot(JSON.stringify({ boot: boot + 3_000 }), boot)).toBe(true)
    expect(stoppedThisBoot(JSON.stringify({ boot: boot - 86_400_000 }), boot)).toBe(false)
    expect(stoppedThisBoot('not json', boot)).toBe(false)
    expect(stoppedThisBoot(JSON.stringify({}), boot)).toBe(false)
    expect(stoppedThisBoot(null, boot)).toBe(false)
  })
})

describe('PlatformService over schtasks', () => {
  const data = '/home/demo/.harness/cli/data'
  const definition = (): ServiceDefinition => ({
    nodePath: 'C:\\h\\runtime\\node\\node.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: task.logFile, home: task.home,
    env: {}, launcherPath: task.launcherPath,
  })
  const make = (answers: Record<string, CommandResult> = {}, files: Record<string, string> = {}) => {
    const made = stubDeps(answers, files, { user: task.user, dataDir: data, bootTime: () => 1_000 })
    return { ...made, service: new PlatformService('taskscheduler', made.deps) }
  }
  // The name as stubDeps records it: its arguments joined by spaces, unquoted, as spawnSync passes them.
  const NAME = taskName(task.user)

  it('keeps its definition in the data folder, registers it under this user\'s name, and knows it as this data folder\'s by its log', () => {
    const { service, files, calls } = make()
    expect(service.file).toBe(join(data, 'harnessd-task.xml'))
    expect(service.target).toBe(NAME)
    expect(NAME).toBe('Harness harnessd (Demo User)')
    expect(PLATFORM_LABEL[service.platform]).toBe('Task Scheduler')
    expect(service.write(definition())).toBe(true)
    expect(service.write(definition())).toBe(false)
    expect(service.ownedBy(task.logFile)).toBe(true)
    expect(service.ownedBy('C:\\other\\harness.log')).toBe(false)
    expect(service.current(definition())).toBe(true)
    expect(files[service.file]).toBe(taskSchedulerXml(task))
    expect(service.register()).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Create /TN ${NAME} /XML ${service.file} /F`])
  })

  it('runs the task to start, rewriting it first when it changed, and forgets a stop', () => {
    const { service, calls, files } = make({}, { [join(data, 'harnessd-stopped.json')]: '{"boot":1000}\n' })
    expect(service.start(true)).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Create /TN ${NAME} /XML ${service.file} /F`, `schtasks /Run /TN ${NAME}`])
    expect(files[join(data, 'harnessd-stopped.json')]).toBeUndefined()
    calls.length = 0
    expect(service.start(false)).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Run /TN ${NAME}`])
    const refused = make({ 'schtasks /Create': fail(1, 'ERROR: The task XML is malformed.') })
    expect(refused.service.start(true)).toEqual({ ok: false, detail: `schtasks /Create /TN ${NAME} /XML ${refused.service.file} /F failed (exit 1): ERROR: The task XML is malformed.` })
    expect(refused.calls).toHaveLength(1)
  })

  it('stops by writing the stop down — the task does not run the master, it starts it — and asks nothing', () => {
    const { service, calls, files } = make()
    expect(service.stop()).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(JSON.parse(files[join(data, 'harnessd-stopped.json')]!)).toEqual({ boot: 1_000 })
  })

  it('says what Task Scheduler has: registered and enabled, disabled, not there, or unreachable', () => {
    const enabled = make({ 'schtasks /Query': ok('<Task><Settings><Enabled>true</Enabled></Settings></Task>') })
    expect(enabled.service.inspect()).toMatchObject({ registered: true, state: 'enabled', pid: null, failed: false, unreachable: null })
    // schtasks may write its XML as UTF-16 into a pipe.
    const utf16 = make({ 'schtasks /Query': ok('<\u0000S\u0000e\u0000t\u0000t\u0000i\u0000n\u0000g\u0000s\u0000>\u0000<Enabled>false</Enabled></Settings>') })
    expect(utf16.service.inspect()).toMatchObject({ registered: true, state: 'disabled' })
    expect(make({ 'schtasks /Query': fail(1, 'ERROR: The system cannot find the file specified.') }).service.inspect()).toMatchObject({ registered: false, unreachable: null })
    const gone = make({ 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawn schtasks ENOENT' } })
    expect(gone.service.inspect().unreachable).toBe(`schtasks /Query /TN ${NAME} /XML could not be run: spawn schtasks ENOENT`)
    expect(gone.service.preflight()).toEqual({ ok: false, detail: `schtasks /Query /TN ${NAME} could not be run: spawn schtasks ENOENT — Task Scheduler could not be asked` })
    expect(enabled.service.preflight()).toEqual({ ok: true })
    expect(make({ 'schtasks /Query': fail(1) }).service.preflight()).toEqual({ ok: true })
  })

  it('unregisters by deleting the task and its files, and leaves the running daemon alone', () => {
    const { service, calls, files } = make({ 'schtasks /Query': ok('<Task/>') }, { [join(data, 'harnessd-task.xml')]: 'x', [join(data, 'harnessd-stopped.json')]: 'y' })
    expect(service.unregister()).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Query /TN ${NAME} /XML`, `schtasks /Delete /TN ${NAME} /F`])
    expect(files).toEqual({})
    const absent = make({ 'schtasks /Query': fail(1) }, { [join(data, 'harnessd-task.xml')]: 'x' })
    expect(absent.service.unregister()).toEqual({ ok: true })
    expect(absent.calls).toEqual([`schtasks /Query /TN ${NAME} /XML`])
    const refused = make({ 'schtasks /Query': ok('<Task/>'), 'schtasks /Delete': fail(1, 'ERROR: Access is denied.') })
    expect(refused.service.unregister()).toEqual({ ok: false, detail: `schtasks /Delete /TN ${NAME} /F failed (exit 1): ERROR: Access is denied.` })
    const discarded = make({}, { [join(data, 'harnessd-task.xml')]: 'x' })
    discarded.service.discard()
    expect(discarded.files).toEqual({})
    expect(discarded.calls).toEqual([])
  })

  it('cannot render a task without a launcher, and takes this process\'s user and the home\'s data folder by default', () => {
    const { service } = make()
    expect(() => service.render({ ...definition(), launcherPath: undefined })).toThrow(/must be absolute/)
    const plain = new PlatformService('taskscheduler', stubDeps({}).deps)
    expect(plain.file).toBe(join('/Users/demo', '.harness', 'cli', 'data', 'harnessd-task.xml'))
    // No user given: the name and the XML's user are both this process's, from the one source.
    expect(plain.target).toBe(taskName(userInfo().username))
    expect(plain.render(definition())).toContain(`<UserId>${userInfo().username}</UserId>`)
    // Without a clock of its own, the stop is written against this computer's boot.
    expect(plain.stop()).toEqual({ ok: true })
  })
})
```

  Also extend `'take this process\'s user, home and environment …'` in `describe('the default dependencies')`:

```ts
    const windows = defaultPlatformDeps({ env: { USERDOMAIN: 'DESKTOP-1', USERNAME: 'Demo' }, home: '/h', dataDir: '/h/data' })
    expect(windows.user).toBe('DESKTOP-1\\Demo')
    expect(windows.dataDir).toBe('/h/data')
    expect(defaultPlatformDeps({ env: { USERNAME: 'Demo' } }).user).toBe('Demo')
    expect(defaultPlatformDeps({ env: {} }).user).toBeUndefined()
    expect(Math.abs(windows.bootTime!() - (Date.now() - uptime() * 1000))).toBeLessThan(2_000)
```

  (import `uptime` from `node:os`).

- [ ] Run `npx vitest run src/harnessd/platform.spec.ts`. Expected: failures for every new case and the win32 line.

- [ ] **Implementation.** `platform.ts` imports:

```ts
import { homedir, uptime, userInfo } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
```

  Type and constants:

```ts
export type PlatformName = 'launchd' | 'systemd' | 'taskscheduler'

/** How each is named to a person. */
export const PLATFORM_LABEL: Record<PlatformName, string> = { launchd: 'launchd', systemd: 'systemd', taskscheduler: 'Task Scheduler' }
```

  `platformFor`:

```ts
/** The platform that would supervise harnessd on this operating system; null where none runs. */
export function platformFor(os: NodeJS.Platform): PlatformName | null {
  return os === 'darwin' ? 'launchd' : os === 'linux' ? 'systemd' : os === 'win32' ? 'taskscheduler' : null
}
```

  `platformFromEnv` is unchanged: a task's action carries no environment, so a master under Task Scheduler is not
  told (Decision below).

  `ServiceDefinition`, after `env`:

```ts
  /** Windows: `bin\harness-launch.exe`, what the scheduled task runs (lib/windows/installLayout.ts `harnessLaunchPath`). */
  launcherPath?: string
```

  After `systemdUnit` (line 218):

```ts
/**
 * Windows: the per-user task `Harness harnessd (<user name>)` in Task Scheduler's root folder (spec section 3, "Start
 * and keep running"). Task names are machine-wide, and a task folder one user creates can refuse another standard
 * user, so the name carries the user and there is no `\Harness\` folder. Task Scheduler does not run
 * the master as launchd and systemd do; it starts `harness start --if-down` through the windowless launcher at logon
 * and every five minutes, which starts the master when none runs (lib/startIfDown.ts) and does nothing otherwise. That
 * is what stands in for KeepAlive and Restart=: a master that dies is back within five minutes.
 *
 * No administrator rights: InteractiveToken runs it as the user, only while they are signed in, with no password stored.
 * IgnoreNew: a start still running when the next one is due is not doubled. No time limit, though each start lasts
 * seconds: the launcher exits once it has started the CLI, and the master it starts is outside the task's job.
 * The time trigger's start is fixed, so the same install writes the same text and `current` can compare it.
 */
/** The task of [user] (`DOMAIN\user` or a bare name): `Harness harnessd (<name>)`, the domain left out. */
export function taskName(user: string): string {
  return `Harness harnessd (${user.slice(user.lastIndexOf('\\') + 1)})`
}
export const TASK_REPEAT = 'PT5M'
/** In the data folder: the definition as written (schtasks registers it from there), and a stop to honour. */
export const TASK_FILE = 'harnessd-task.xml'
export const TASK_STOPPED_FILE = 'harnessd-stopped.json'

export interface TaskDefinition {
  launcherPath: string
  /** The `~\.harness` the launcher resolves its pointers in (`--root`). */
  root: string
  home: string
  logFile: string
  /** `DOMAIN\user`, whose logon starts it and as whom it runs. */
  user: string
}

export function taskSchedulerXml(opts: TaskDefinition): string {
  for (const [what, path] of [['launcher', opts.launcherPath], ['root', opts.root], ['home', opts.home], ['log', opts.logFile]] as const) {
    if (!win32.isAbsolute(path) || CONTROL.test(path)) throw new Error(`the ${what} path for the task must be absolute, on one line: ${JSON.stringify(path)}`)
  }
  // Quoted for the launcher's own command line: a quote inside cannot be.
  if (opts.root.includes('"')) throw new Error(`the root for the task cannot hold a quote: ${JSON.stringify(opts.root)}`)
  if (!opts.user || CONTROL.test(opts.user)) throw new Error(`the task needs the user it runs for: ${JSON.stringify(opts.user)}`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- harnessd, the Harness daemon, under Task Scheduler. Written by "harness service install" and removed by
     "harness service uninstall"; "harness service status" says what Task Scheduler has registered. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>harnessd, the Harness daemon. Its log: ${xml(opts.logFile)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(opts.user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>${TASK_REPEAT}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(opts.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(opts.launcherPath)}</Command>
      <Arguments>${xml(`--root "${opts.root}" -- start --if-down`)}</Arguments>
      <WorkingDirectory>${xml(opts.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** A stop written down since this computer last started (within two minutes of its boot time, which is read
 *  from the uptime and moves by a second or two). After a restart the logon trigger starts the daemon again,
 *  as launchd loads an agent booted out at the next login. */
export function stoppedThisBoot(text: string | null, bootMs: number): boolean {
  if (text === null) return false
  try {
    const { boot } = JSON.parse(text) as { boot?: unknown }
    return typeof boot === 'number' && Math.abs(boot - bootMs) < 120_000
  } catch {
    return false
  }
}

/** When this computer started, ms since the epoch. */
export const bootTimeMs = (): number => Date.now() - uptime() * 1000
```

  `PlatformDeps`, after `configHome?`:

```ts
  /** Windows: `DOMAIN\user`, the task's user. */
  user?: string
  /** Windows: the data folder, where the task's definition and a stop are written. `~/.harness/cli/data` when unset. */
  dataDir?: string
  /** When this computer started (`bootTimeMs`). */
  bootTime?: () => number
```

  `defaultPlatformDeps` gains `dataDir?: string` in its options and, in the returned object:

```ts
    ...(env.USERNAME ? { user: env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    bootTime: bootTimeMs,
```

  `PlatformService` (each branch first in its method, so the launchd and systemd paths read as before):

```ts
  private get dataDir(): string {
    return this.deps.dataDir ?? join(this.deps.home, '.harness', 'cli', 'data')
  }

  private get stoppedFile(): string {
    return join(this.dataDir, TASK_STOPPED_FILE)
  }

  /** Windows: the task's user, `DOMAIN\user`. One source for the task's name and its XML's UserId: the deps' user,
   *  else this process's. */
  private get taskUser(): string {
    return this.deps.user ?? userInfo().username
  }

  get file(): string {
    if (this.os) return OS_UNIT_FILE
    if (this.platform === 'taskscheduler') return join(this.dataDir, TASK_FILE)
    // …launchd / systemd as before
  }

  get target(): string {
    if (this.platform === 'taskscheduler') return taskName(this.taskUser)
    return this.platform === 'launchd' ? `gui/${this.deps.uid}/${LAUNCHD_LABEL}` : this.unit
  }

  render(definition: ServiceDefinition): string {
    if (this.platform === 'taskscheduler') {
      const launcherPath = definition.launcherPath ?? ''
      // The launcher is `<root>\bin\harness-launch.exe` (lib/windows/installLayout.ts `harnessLaunchPath`).
      return taskSchedulerXml({ launcherPath, root: win32.dirname(win32.dirname(launcherPath)), home: definition.home, logFile: definition.logFile, user: this.taskUser })
    }
    return this.platform === 'launchd' ? launchdPlist(definition) : systemdUnit(definition)
  }
```

  `ownedBy`, before the launchd/systemd return:

```ts
    if (this.platform === 'taskscheduler') return content.includes(`Its log: ${xml(logFile)}</Description>`)
```

  `inspect`, right after `const base = …` (line 387; the branch uses it):

```ts
    if (this.platform === 'taskscheduler') {
      const args = ['/Query', '/TN', this.target, '/XML']
      const result = this.deps.run('schtasks', args)
      const none = { ...base, registered: false, pid: null, state: null, failed: false, lastExit: null }
      if (result.error) return { ...none, unreachable: failure('schtasks', args, result) }
      if (result.status !== 0) return none
      // Written into a pipe, schtasks's XML may come as UTF-16: the tags read the same without the NULs.
      const text = result.stdout.replace(/\u0000/g, '')
      const disabled = /<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/.test(text)
      // No pid: the task starts the master and is done; the pid file names it.
      return { ...base, registered: true, pid: null, state: disabled ? 'disabled' : 'enabled', failed: false, lastExit: null }
    }
```

  `preflight`, first:

```ts
    if (this.platform === 'taskscheduler') {
      const args = ['/Query', '/TN', this.target]
      const result = this.deps.run('schtasks', args)
      return result.error ? { ok: false, detail: `${failure('schtasks', args, result)} — Task Scheduler could not be asked` } : { ok: true }
    }
```

  `register`, after the `os` check:

```ts
    // Registered and nothing more: the caller runs it once it has let go of the spawn lock, which the task's own
    // `harness start --if-down` takes (lib/serviceCommand.ts).
    if (this.platform === 'taskscheduler') return this.checked('schtasks', ['/Create', '/TN', this.target, '/XML', this.file, '/F'])
```

  `start`, first:

```ts
    if (this.platform === 'taskscheduler') {
      if (refreshed) {
        const created = this.register()
        if (!created.ok) return created
      }
      this.deps.removeFile(this.stoppedFile)
      return this.checked('schtasks', ['/Run', '/TN', this.target])
    }
```

  `stop`, first:

```ts
    if (this.platform === 'taskscheduler') {
      // The task does not run the master, so there is nothing of it to stop: `harness stop` stops the daemon itself
      // (lib/daemonStop.ts). Written down, so the five-minute starts leave it stopped until this computer starts again.
      this.deps.writeFile(this.stoppedFile, `${JSON.stringify({ boot: (this.deps.bootTime ?? bootTimeMs)() })}\n`)
      return { ok: true }
    }
```

  `unregister`, after the `os` check:

```ts
    if (this.platform === 'taskscheduler') {
      // The daemon keeps running: Task Scheduler only ever started it.
      if (this.inspect().registered) {
        const deleted = this.checked('schtasks', ['/Delete', '/TN', this.target, '/F'])
        if (!deleted.ok) return deleted
      }
      this.deps.removeFile(this.file)
      this.deps.removeFile(this.stoppedFile)
      return { ok: true }
    }
```

  `discard` is unchanged (it removes the file, and reloads only under systemd).

- [ ] **Review Focus 1 (a second Windows user on the same machine), in this task.** The per-user name above is the
  ruling: each user gets their own task (`taskName(<user>)`), pipe and daemon, and neither sees the other's. The
  callers in B3.13, B3.21, B5.9, B5.12 and B5.14 use `taskName(<user>)` (TypeScript) or
  `"Harness harnessd ($env:USERNAME)"` (the PowerShell checks); B3.15 names no task. Schtasks gets the name as one
  argument, unquoted in the code: spawnSync quotes an argument with spaces itself, and a literal quote would become
  part of the name. B5.14 scenario 6 installs a second user, and both tasks are listed by
  `schtasks /Query /FO LIST | findstr /C:"Harness harnessd ("`.
- [ ] Run `npm run test:harnessd && npm run typecheck`. Expected: `platform.ts` at 100%. Type errors in
  `serviceCommand.ts`/`platformDaemon.ts` do not appear (they only compare with `'launchd'`); if `PlatformState`
  consumers switch on the name, B3.13 handles them.
- [ ] Commit: `harnessd: the Task Scheduler platform` — `git add cli/src/harnessd/platform.ts cli/src/harnessd/platform.spec.ts`

---

### Task B3.13: `harness service` and the platform's start and stop with Task Scheduler

**Files**
- Modify: `cli/src/lib/platformDaemon.ts:19-28` (imports), `:86-99` (`platformDaemonDeps`), `:101-117`
  (`serviceDefinition`), `:185-194` (`describeState`), new exports after `:161`
- Modify: `cli/src/lib/serviceCommand.ts:42-52` (usage), `:80-130` (`installService`), `:132-157`, `:159-195`
- Modify: `cli/src/lib/platformDaemon.spec.ts`, `cli/src/lib/serviceCommand.spec.ts`

**Interfaces**
- Produces: `startThroughTask(definition, deps & { lockHeld(): boolean }, waitMs?): Promise<TaskStart>`;
  `TASK_RUN_WAIT_MS = 10_000`; `taskStoppedThisBoot(dataDir?: string): boolean`; `clearTaskStopped(dataDir?: string): void`;
  `serviceDefinition({ …, platform?, launcherPath? })`.
- Consumes: B3.12 (`taskName(user)`: every expectation names the task as `taskName(<user>)`, and the code as
  `service.target`); B1 `currentCli`, `harnessLaunchPath(rootDir)` (`cli/src/lib/windows/installLayout.ts`).

- [ ] **Failing tests.** `platformDaemon.spec.ts`:

```ts
describe('Windows', () => {
  it('runs the scheduled task\'s launcher on the build cli\\current names', () => {
    const made = serviceDefinition({ logFile: 'C:\\h\\cli\\data\\harness.log', platform: 'win32', source: {}, nodePath: 'C:\\h\\runtime\\node\\node.exe', home: 'C:\\Users\\d', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', launcherPath: 'C:\\h\\bin\\harness-launch.exe' })
    expect(made).toEqual({ nodePath: 'C:\\h\\runtime\\node\\node.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: 'C:\\h\\cli\\data\\harness.log', home: 'C:\\Users\\d', env: {}, launcherPath: 'C:\\h\\bin\\harness-launch.exe' })
    expect(serviceDefinition({ logFile: '/l', platform: 'darwin', source: {}, nodePath: '/n', scriptPath: '/s', home: '/h' })).not.toHaveProperty('launcherPath')
  })

  function taskDeps(over: { pids?: Array<number | null>; lockHeld?: boolean; run?: CommandResult } = {}) {
    const pids = [...(over.pids ?? [])]
    const clock = { now: 0 }
    const calls: string[] = []
    const files: Record<string, string> = {}
    const service = new PlatformService('taskscheduler', {
      run: (command, args) => { calls.push([command, ...args].join(' ')); return over.run ?? { status: 0, stdout: '', stderr: '' } },
      readFile: (path) => files[path] ?? null, writeFile: (path, content) => { files[path] = content }, removeFile: (path) => { delete files[path] },
      uid: 0, home: '/h', user: 'D\\u', dataDir: '/h/data',
    })
    return {
      calls,
      deps: {
        service, logFile: 'C:\\h\\cli\\data\\harness.log', readPid: () => (pids.length > 1 ? pids.shift()! : pids[0] ?? null), isAlive: () => true,
        masterPlatform: () => null, now: () => clock.now, sleep: async (ms: number) => { clock.now += ms }, lockHeld: () => over.lockHeld ?? false,
      },
    }
  }
  const definition = (): ServiceDefinition => ({ nodePath: 'C:\\n.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: 'C:\\h\\cli\\data\\harness.log', home: 'C:\\Users\\d', env: {}, launcherPath: 'C:\\h\\bin\\harness-launch.exe' })

  it('starts through the task and waits for the master it starts', async () => {
    const { deps, calls } = taskDeps({ pids: [null, null, 700] })
    await expect(startThroughTask(definition(), deps)).resolves.toEqual({ ok: true, pid: 700 })
    expect(calls).toEqual([`schtasks /Create /TN ${taskName('D\\u')} /XML /h/data/harnessd-task.xml /F`, `schtasks /Run /TN ${taskName('D\\u')}`])
  })

  it('says to start it directly when the task did not run (no signed-in session) or could not be run', async () => {
    await expect(startThroughTask(definition(), taskDeps({ pids: [null] }).deps)).resolves.toMatchObject({ ok: false, direct: true })
    await expect(startThroughTask(definition(), taskDeps({ run: { status: 1, stdout: '', stderr: 'ERROR: denied' } }).deps)).resolves.toMatchObject({ ok: false, direct: true })
  })

  it('keeps waiting while the task\'s own start holds the spawn lock, and reports one that never came up', async () => {
    await expect(startThroughTask(definition(), taskDeps({ pids: [null], lockHeld: true }).deps, 1_000)).resolves.toMatchObject({ ok: false, direct: false })
    const slow = taskDeps({ pids: [...Array(60).fill(null), 701], lockHeld: true })
    await expect(startThroughTask(definition(), slow.deps)).resolves.toEqual({ ok: true, pid: 701 })
  })

  it('names the platform as a person would', () => {
    expect(describeState({ platform: 'taskscheduler', file: 'f', target: taskName('D\\u'), installed: true, registered: false, pid: null, state: null, failed: false, lastExit: null, linger: null, unreachable: null })).toBe('not registered')
  })
})
```

  (Add `PlatformService, taskName, type CommandResult, type ServiceDefinition` from `'../harnessd/platform.js'` and
  `describeState, serviceDefinition, startThroughTask` from `'./platformDaemon.js'` to the spec's imports.)

  `serviceCommand.spec.ts` (a stub `run`; the fakes there are launchctl/systemctl only). Add `taskName` to its
  `'../harnessd/platform.js'` import (line 5). The task's user is `demo` (`USERNAME`), so its name is
  `taskName('demo')`, `Harness harnessd (demo)`:

```ts
describe('harness service with Task Scheduler', () => {
  function windows(over: { registered?: boolean; pid?: number | null; carried?: Record<string, string> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'service-task-'))
    const data = join(dir, 'data')
    const launcher = join(dir, 'bin', 'harness-launch.exe')
    const script = join(dir, 'cli', '0.5.0', 'cli.js')
    for (const file of [launcher, script]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '') }
    const calls: string[] = []
    let registered = over.registered ?? false
    let pid = over.pid ?? null
    const service = new PlatformService('taskscheduler', {
      ...defaultPlatformDeps({ env: { USERNAME: 'demo' }, home: dir, dataDir: data }),
      run: (command, args) => {
        const call = [command, ...args].join(' ')
        calls.push(call)
        if (call.startsWith('schtasks /Create')) registered = true
        if (call.startsWith('schtasks /Run')) pid = 4343
        if (call.startsWith('schtasks /Query')) return registered ? { status: 0, stdout: '<Settings><Enabled>true</Enabled></Settings>', stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR' }
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const out: string[] = []
    const err: string[] = []
    const locks: string[] = []
    const deps: ServiceCommandDeps = {
      service, logFile: 'C:\\d\\harness.log', readPid: () => pid, isAlive: (p) => p === pid, masterPlatform: () => null,
      now: () => 0, sleep: async () => {},
      definition: () => ({ nodePath: 'C:\\n\\node.exe', scriptPath: script, logFile: 'C:\\d\\harness.log', home: 'C:\\Users\\demo', env: over.carried ?? {}, launcherPath: launcher }),
      bundleExists: (path) => existsSync(path), ensureDir: () => {},
      stopDaemon: async () => { throw new Error('the task never stops the daemon') },
      withLock: async (purpose, fn) => { locks.push(purpose); const result = await fn(); locks.push(`${purpose} released`); return result },
      relaunch: async () => {}, out: (line) => out.push(line), err: (line) => err.push(line), tildify: (path) => path, startWaitMs: 1_000,
    }
    return { dir, calls, out, err, locks, deps }
  }

  it('registers the task under the lock, then runs it outside, never stopping the daemon that runs', async () => {
    const w = windows()
    try {
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(0)
      const name = taskName('demo')
      expect(w.calls.filter((call) => !call.startsWith('schtasks /Query'))).toEqual([expect.stringMatching(/harnessd-task\.xml \/F$/), `schtasks /Run /TN ${name}`])
      expect(w.calls.find((call) => call.startsWith('schtasks /Create'))!.startsWith(`schtasks /Create /TN ${name} /XML `)).toBe(true)
      expect(w.locks).toEqual(['start', 'start released'])
      expect(w.out[0]).toBe('✓ harnessd runs under Task Scheduler (pid 4343): it starts at logon, and again within 5 minutes if it stops.')
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('leaves a registered task and a running daemon as they are, and says what a shell setting will not reach', async () => {
    const w = windows({ registered: true, pid: 4040, carried: { ADAPTER_DATA_DIR: 'C:\\elsewhere' } })
    try {
      await serviceCommand(['install'], w.deps)
      await serviceCommand(['install'], w.deps)
      expect(w.calls.some((call) => call.startsWith('schtasks /Run'))).toBe(false)
      expect(w.out).toContain(`harnessd is registered with Task Scheduler already (${taskName('demo')}); nothing to change.`)
      expect(w.out).toContain('  ! the task starts harness with your Windows user environment, not this shell\'s: ADAPTER_DATA_DIR set only here does not reach it')
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('refuses without the launcher, and unregisters without touching the daemon', async () => {
    const w = windows({ registered: true, pid: 4040 })
    try {
      rmSync(join(w.dir, 'bin'), { recursive: true })
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(1)
      expect(w.err[0]).toMatch(/^✗ No installed CLI at .*harness-launch\.exe/)
      await expect(serviceCommand(['uninstall'], w.deps)).resolves.toBe(0)
      expect(w.calls).toContain(`schtasks /Delete /TN ${taskName('demo')} /F`)
      expect(w.out.at(-1)).toMatch(/Task Scheduler no longer runs harnessd/)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says what is registered', async () => {
    const w = windows({ registered: true })
    try {
      w.deps.service!.write(w.deps.definition())
      await serviceCommand(['status'], w.deps)
      expect(w.out).toEqual(['harnessd · Task Scheduler', '  status      ● registered (enabled) · starts at logon, and again within 5 minutes if it stops', expect.stringMatching(/^  task        /), `  target      ${taskName('demo')}`])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })
})
```

  (The existing mac assertions are unchanged because `PLATFORM_LABEL` keeps `launchd` and `systemd` as they were.)

- [ ] Run `npx vitest run src/lib/platformDaemon.spec.ts src/lib/serviceCommand.spec.ts`. Expected: failures.

- [ ] **Implementation.** `platformDaemon.ts` imports add `readFileSync, rmSync` from `node:fs`, `dirname` from
  `node:path`, `PLATFORM_LABEL, TASK_STOPPED_FILE, bootTimeMs, stoppedThisBoot` from `'../harnessd/platform.js'`,
  `currentCli, harnessLaunchPath` from `'./windows/installLayout.js'`.

  `platformDaemonDeps`: `service: platform ? new PlatformService(platform, defaultPlatformDeps({ dataDir: env.ADAPTER_DATA_DIR }), os) : null`.

  `serviceDefinition`:

```ts
export function serviceDefinition(options: {
  logFile: string; source?: NodeJS.ProcessEnv; nodePath?: string; scriptPath?: string; home?: string
  platform?: NodeJS.Platform; launcherPath?: string
}): ServiceDefinition {
  const source = options.source ?? process.env
  const carried: Record<string, string> = {}
  for (const name of CARRIED_ENV) {
    const value = source[name]
    if (value) carried[name] = value
  }
  // Windows: the build `cli\current` names (there is no cli\cli.js), started by the launcher beside it.
  const windows = (options.platform ?? process.platform) === 'win32'
  return {
    nodePath: options.nodePath ?? managedNodePath(),
    scriptPath: options.scriptPath ?? (windows ? currentCli(dirname(env.ADAPTER_CLI_DIR))?.cliJs : undefined) ?? join(env.ADAPTER_CLI_DIR, 'cli.js'),
    logFile: options.logFile,
    home: options.home ?? homedir(),
    env: carried,
    ...(windows ? { launcherPath: options.launcherPath ?? harnessLaunchPath(dirname(env.ADAPTER_CLI_DIR)) } : {}),
  }
}
```

  After `startUnderPlatform`:

```ts
/** How long `harness start` gives the scheduled task to start the master, or begin to, before it starts it itself. */
export const TASK_RUN_WAIT_MS = 10_000

export type TaskStart = { ok: true; pid: number } | { ok: false; direct: boolean; detail: string }

/**
 * Windows, the task registered: `harness start` runs it (`schtasks /Run`), so the master starts as the task starts it,
 * and waits. Not under the spawn lock: the task's `harness start --if-down` takes it, and would find it held and do
 * nothing. `direct`: the task did not start anything (Task Scheduler runs an InteractiveToken task only in a signed-in
 * Windows session, not in an SSH one), and the caller starts the master itself, as without the task.
 */
export async function startThroughTask(
  definition: ServiceDefinition, deps: PlatformDaemonDeps & { lockHeld(): boolean }, waitMs = PLATFORM_START_WAIT_MS,
): Promise<TaskStart> {
  const service = deps.service!
  const ran = service.start(service.write(definition))
  if (!ran.ok) return { ok: false, direct: true, detail: ran.detail }
  const quick = await waitForMaster(deps, TASK_RUN_WAIT_MS)
  if (quick !== null) return { ok: true, pid: quick }
  if (!deps.lockHeld()) return { ok: false, direct: true, detail: 'Task Scheduler did not start harnessd (it runs the task only in a signed-in Windows session)' }
  const pid = await waitForMaster(deps, waitMs)
  return pid !== null ? { ok: true, pid } : { ok: false, direct: false, detail: `harnessd did not come up within ${Math.round((TASK_RUN_WAIT_MS + waitMs) / 1000)}s` }
}

/** Whether `harness stop` stopped the daemon since this computer started, which the task's starts honour. */
export function taskStoppedThisBoot(dataDir: string = env.ADAPTER_DATA_DIR): boolean {
  let text: string | null = null
  try { text = readFileSync(join(dataDir, TASK_STOPPED_FILE), 'utf8') } catch { /* none */ }
  return stoppedThisBoot(text, bootTimeMs())
}

/** Any start but the task's own forgets a stop. */
export function clearTaskStopped(dataDir: string = env.ADAPTER_DATA_DIR): void {
  try { rmSync(join(dataDir, TASK_STOPPED_FILE), { force: true }) } catch { /* nothing to forget */ }
}
```

  `describeState`:

```ts
  if (!state.registered) parts.push(state.platform === 'launchd' ? 'not loaded' : state.platform === 'taskscheduler' ? 'not registered' : 'not enabled')
```

  `serviceCommand.ts`: import `PLATFORM_LABEL` from `'../harnessd/platform.js'` and `CARRIED_ENV, PLATFORM_START_WAIT_MS`
  from `'./platformDaemon.js'`. Usage lines 45-46:

```ts
  '  install    run harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows): it starts at login',
  '             and comes back if it dies. `harness start` and `harness stop` then go through the platform. Agents keep',
```

  (the mac and Linux lines read the same; the tests import `SERVICE_USAGE`). The error on line 68 becomes
  `'harness service runs harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows); this computer has none of them.'`
  In `installService`, `uninstallService`, `serviceStatus`: `const name = PLATFORM_LABEL[service.platform]`. First
  line of `installService`'s body: `if (deps.service!.platform === 'taskscheduler') return installTask(deps)`. Labels,
  each at its line's width: `:124` (5 characters)
  `service.platform === 'launchd' ? 'agent' : service.platform === 'taskscheduler' ? 'task ' : 'unit '`, and `:175`
  (6 characters, the status test's `^  task        `)
  `service.platform === 'launchd' ? 'agent ' : service.platform === 'taskscheduler' ? 'task  ' : 'unit  '`. `statusLine`, before the `!state.registered` branch's return:

```ts
  if (state.platform === 'taskscheduler') {
    return state.registered
      ? `● registered (${state.state}) · starts at logon, and again within 5 minutes if it stops`
      : '◍ written, not registered · `harness service install` registers it'
  }
```

  (placed after the `registered && !installed` line). The new function:

```ts
/**
 * Windows. Task Scheduler does not run the master, it starts it (harnessd/platform.ts), so nothing that runs is stopped:
 * the task is registered under the spawn lock, and run once outside it, when no daemon runs, because the task's own
 * `harness start --if-down` takes that lock and would find it held.
 */
async function installTask(deps: ServiceCommandDeps): Promise<number> {
  const service = deps.service!
  const definition = deps.definition()
  const launcher = definition.launcherPath ?? ''
  for (const needed of [launcher, definition.scriptPath]) {
    if (!deps.bundleExists(needed)) {
      deps.err(`✗ No installed CLI at ${deps.tildify(needed)}. Task Scheduler runs the installed CLI through bin\\harness-launch.exe: install it with install.ps1, then run this again.`)
      return 1
    }
  }
  const preflight = service.preflight()
  if (!preflight.ok) { deps.err(`✗ Task Scheduler cannot run harnessd here: ${preflight.detail}`); return 1 }
  const registered = await deps.withLock('start', async () => {
    const before = service.inspect()
    if (!service.write(definition) && before.registered) return 'already' as const
    const outcome = service.register()
    if (!outcome.ok) service.discard()
    return outcome
  })
  if (registered !== 'already' && !registered.ok) { deps.err(`✗ Task Scheduler would not take harnessd: ${registered.detail}`); return 1 }
  const running = deps.readPid()
  let up = running !== null && deps.isAlive(running) ? running : null
  if (up === null) {
    const started = service.start(false)
    if (!started.ok) { deps.err(`✗ Task Scheduler has harnessd, but would not run it: ${started.detail}`); return 1 }
    up = await waitForMaster(deps, deps.startWaitMs ?? PLATFORM_START_WAIT_MS)
    if (up === null) {
      deps.err('✗ Task Scheduler has harnessd, but it did not come up. It runs the task only in a signed-in Windows session: `harness start` starts it now.')
      deps.err(`  logs ${deps.tildify(deps.logFile)}   ·   harness service status`)
      return 1
    }
  }
  if (registered === 'already') deps.out(`harnessd is registered with Task Scheduler already (${service.target}); nothing to change.`)
  else {
    deps.out(`✓ harnessd runs under Task Scheduler (pid ${up}): it starts at logon, and again within 5 minutes if it stops.`)
    deps.out(`  task   ${service.target}`)
    deps.out('  undo: harness service uninstall')
  }
  const carried = Object.keys(definition.env).filter((name) => (CARRIED_ENV as readonly string[]).includes(name))
  // A task's action has no environment of its own (harnessd/platform.ts): what this shell sets does not reach it.
  if (carried.length) deps.out(`  ! the task starts harness with your Windows user environment, not this shell's: ${carried.join(', ')} set only here does not reach it`)
  return 0
}
```

- [ ] Run `npx vitest run src/lib/platformDaemon.spec.ts src/lib/serviceCommand.spec.ts && npm run typecheck`. Expected:
  pass; every existing launchd/systemd case passes unchanged.
- [ ] Commit: `cli: harness service with Task Scheduler` —
  `git add cli/src/lib/platformDaemon.ts cli/src/lib/platformDaemon.spec.ts cli/src/lib/serviceCommand.ts cli/src/lib/serviceCommand.spec.ts`

---

### Task B3.14: The installed copy on Windows is a version folder

`isInstalledCopy` compares the script with `~/.harness/cli/cli.js` (`installedCopy.ts:10-13`). That file does not
exist on Windows, so without this the master never runs the updater there (`masterProcess.ts:93`).

**Files**
- Modify: `cli/src/lib/installedCopy.ts`
- Create: `cli/src/lib/installedCopy.spec.ts` (the file has no spec today)

**Interfaces**
- Produces: `isInstalledCopy(scriptPath: string, cliDir: string, platform?: NodeJS.Platform): boolean`.

- [ ] **Failing test.**

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstalledCopy } from './installedCopy.js'

describe('the installed copy', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('is ~/.harness/cli/cli.js on macOS and Linux, by inode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'installed-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'cli.js'), '')
    symlinkSync(join(dir, 'cli.js'), join(dir, 'link.js'))
    expect(isInstalledCopy(join(dir, 'link.js'), dir, 'darwin')).toBe(true)
    writeFileSync(join(dir, 'other.js'), '')
    expect(isInstalledCopy(join(dir, 'other.js'), dir, 'linux')).toBe(false)
  })

  it('is a version folder\'s cli.js under cli\\ on Windows, compared as Windows compares paths', () => {
    const cli = 'C:\\Users\\d\\.harness\\cli'
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\0.5.0\\cli.js', cli, 'win32')).toBe(true)
    expect(isInstalledCopy('c:\\users\\D\\.HARNESS\\cli\\0.5.1-dev.ab12\\cli.js', cli, 'win32')).toBe(true)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\data\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\0.5.0\\other.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\work\\oh\\cli\\dist\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('D:\\cli\\0.5.0\\cli.js', cli, 'win32')).toBe(false)
  })
})
```

- [ ] Run `npx vitest run src/lib/installedCopy.spec.ts`. Expected: the Windows case fails.

- [ ] **Implementation.**

```ts
/**
 * Whether a script is the installed copy of the CLI, the one the updater replaces: `~/.harness/cli/cli.js` on macOS and
 * Linux; on Windows a version folder's, `~\.harness\cli\<version>\cli.js` (lib/windows/cliVersions.ts). A dev or repo
 * run (`tsx`, or `node dist/cli.js` from a checkout) never updates itself: it would swap the published bundle into
 * ~/.harness/cli and restart, hijacking the version being developed. Matched by inode, so a symlink or a realpath does
 * not fool it; by path when either cannot be read. Windows has no symlinks here (spec, Decision 4): by path, as Windows
 * compares them.
 */
import { statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { VERSION_FOLDER } from './windows/cliVersions.js'

export function isInstalledCopy(scriptPath: string, cliDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const parts = win32.relative(cliDir, scriptPath).split('\\')
    return parts.length === 2 && VERSION_FOLDER.test(parts[0]!) && parts[1]!.toLowerCase() === 'cli.js'
  }
  const installed = join(cliDir, 'cli.js')
  try { return statSync(scriptPath).ino === statSync(installed).ino } catch { return scriptPath === installed }
}
```

  `VERSION_FOLDER` comes from B3.16's `cliVersions.ts`; to keep this commit self-contained, create
  `cli/src/lib/windows/cliVersions.ts` here with only:

```ts
/** A build's folder name under cli\: its version, as the release names it (`0.5.0`, `0.5.1-dev.ab12`). */
export const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
```

  (`win32.relative` of a path on another drive is that absolute path, which splits into more than two parts.)

- [ ] Run the spec, then `npx vitest run src/masterProcess.spec.ts src/core`. Expected: pass.
- [ ] Commit: `cli: on Windows the installed copy is a version folder's cli.js` —
  `git add cli/src/lib/installedCopy.ts cli/src/lib/installedCopy.spec.ts cli/src/lib/windows/cliVersions.ts`

---

### Task B3.15: `harness start --if-down`, and starting on Windows

**Files**
- Create: `cli/src/lib/startIfDown.ts`, `cli/src/lib/startIfDown.spec.ts`
- Modify: `cli/src/cli.ts:999-1053` (`startCommand`), `:1447-1500` (`spawnDaemon`), `:2570-2577` (`case 'start'`), imports
- Modify: `cli/scripts/install.ps1` (`Install-Harness`, B1.8; two new functions before it) and
  `cli/src/scripts/installPs1.spec.ts` (one static case, one Windows block): re-running the installer over a live
  install moves the daemon to the new build (Review Focus 4)

**Interfaces**
- Produces: `startIfDown(deps: IfDownDeps): Promise<IfDown>`, `processIfDownDeps(): IfDownDeps`; the `--if-down` flag;
  in install.ps1, `Read-HarnessCurrentCli -Root <dir>` (`cli\current`'s version, or `''`) and
  `Restart-HarnessDaemon -Command <bin\harness.exe> -Before <v> -After <v>` (returns whether it restarted).
- Consumes: B3.7 `identifyDaemonProcess`; B3.10 `readSpawnLockOwner`, `spawnLockOwnerReused`,
  `releaseAbandonedSpawnLock`; B3.13 `startThroughTask`, `taskStoppedThisBoot`, `clearTaskStopped`,
  `installedPlatform`; B3.11 `launchDetached`; B1 `harnessLaunchPath(rootDir)` (`lib/windows/installLayout.ts`);
  B3.14 `isInstalledCopy`.

- [ ] **Failing test.** `cli/src/lib/startIfDown.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SpawnLockOwner } from './daemonSpawnLock.js'
import { startIfDown, type IfDownDeps } from './startIfDown.js'

const owner: SpawnLockOwner = { pid: 77, startMarker: '', token: 't', purpose: 'update', since: Date.now() - 4_000 }
const deps = (over: Partial<IfDownDeps> = {}): IfDownDeps => ({
  readPid: () => null, masterRuns: async () => false, lockOwner: () => null, ownerRuns: async () => true, stoppedThisBoot: () => false, ...over,
})

describe('harness start --if-down', () => {
  it('starts the daemon when nothing runs it, nobody is starting it and nobody stopped it', async () => {
    await expect(startIfDown(deps())).resolves.toEqual({ start: true })
    await expect(startIfDown(deps({ readPid: () => 500 }))).resolves.toEqual({ start: true })
    await expect(startIfDown(deps({ lockOwner: () => owner, ownerRuns: async () => false }))).resolves.toEqual({ start: true })
  })

  it('does nothing while a master runs, while the spawn lock is held, or after `harness stop`', async () => {
    await expect(startIfDown(deps({ readPid: () => 500, masterRuns: async (pid) => pid === 500 }))).resolves.toEqual({ start: false, why: 'it runs (pid 500)' })
    await expect(startIfDown(deps({ lockOwner: () => owner }))).resolves.toMatchObject({ start: false, why: expect.stringMatching(/^the daemon is being updated by pid 77/) })
    await expect(startIfDown(deps({ stoppedThisBoot: () => true }))).resolves.toEqual({ start: false, why: '`harness stop` stopped it since this computer started; `harness start` starts it again' })
    await expect(startIfDown(deps({ lockOwner: () => { throw new Error('not a lock') } }))).resolves.toEqual({ start: false, why: 'the daemon spawn lock is unusable (not a lock)' })
  })
})
```

- [ ] Run `npx vitest run src/lib/startIfDown.spec.ts`. Expected: module missing.

- [ ] **Implementation.** `cli/src/lib/startIfDown.ts`:

```ts
/**
 * `harness start --if-down`: what the scheduled task runs at logon and every five minutes on Windows
 * (harnessd/platform.ts `taskSchedulerXml`), in place of launchd's KeepAlive and systemd's Restart=. It starts the
 * daemon when none runs, and otherwise does nothing, silently: a master runs; someone holds the spawn lock (a start,
 * a stop, an update is under way, and waiting on it every five minutes would only pile up); or `harness stop`
 * stopped it since this computer started, which a person meant to last.
 */
import { statSync } from 'node:fs'
import { PID_FILE, isAlive, readPid } from './daemonState.js'
import {
  describeSpawnLockOwner, readSpawnLockOwner, releaseAbandonedSpawnLock, spawnLockOwnerReused, type SpawnLockOwner,
} from './daemonSpawnLock.js'
import { taskStoppedThisBoot } from './platformDaemon.js'
import { lockOwnerAlive, lockStartMarker } from './processLiveness.js'
import { identifyDaemonProcess } from './windows/daemonProcesses.js'
import { windowsProcessRows } from './windows/processTable.js'

export type IfDown = { start: true } | { start: false; why: string }

export interface IfDownDeps {
  readPid(): number | null
  /** Whether [pid] runs harnessd's master. */
  masterRuns(pid: number): Promise<boolean>
  /** The spawn lock's owner, null when it is free; throws for something that is not a lock. */
  lockOwner(): SpawnLockOwner | null
  ownerRuns(owner: SpawnLockOwner): Promise<boolean>
  stoppedThisBoot(): boolean
}

export async function startIfDown(deps: IfDownDeps): Promise<IfDown> {
  if (deps.stoppedThisBoot()) return { start: false, why: '`harness stop` stopped it since this computer started; `harness start` starts it again' }
  const pid = deps.readPid()
  if (pid !== null && await deps.masterRuns(pid)) return { start: false, why: `it runs (pid ${pid})` }
  let owner: SpawnLockOwner | null
  try {
    owner = deps.lockOwner()
  } catch (error) {
    return { start: false, why: `the daemon spawn lock is unusable (${error instanceof Error ? error.message : String(error)})` }
  }
  if (owner && await deps.ownerRuns(owner)) return { start: false, why: `the daemon is ${describeSpawnLockOwner(owner)}` }
  return { start: true }
}

/**
 * This computer's. On Windows a pid is checked against the process table: a pid file or a lock whose pid was given to
 * another process since must not stand for a running daemon, or the task would never start one again. A table that
 * cannot be read proves nothing either way, and the pid's liveness decides, as elsewhere.
 */
export function processIfDownDeps(platform: NodeJS.Platform = process.platform): IfDownDeps {
  const windows = platform === 'win32'
  return {
    readPid,
    masterRuns: async (pid) => {
      if (!isAlive(pid)) return false
      if (!windows) return true
      const rows = await windowsProcessRows(null)
      if (!rows) return true
      let claimedAtMs: number | undefined
      try { claimedAtMs = statSync(PID_FILE).mtimeMs } catch { /* claimed, then removed: no bound to check */ }
      return identifyDaemonProcess(rows, pid, { role: 'master', ...(claimedAtMs !== undefined ? { claimedAtMs } : {}) }) !== null
    },
    lockOwner: () => readSpawnLockOwner(),
    ownerRuns: async (owner) => {
      if (!lockOwnerAlive(owner.pid, lockStartMarker(owner))) return false
      if (!windows) return true
      const rows = await windowsProcessRows(null)
      const row = rows?.find((candidate) => candidate.pid === owner.pid) ?? null
      if (!spawnLockOwnerReused(owner, row)) return true
      releaseAbandonedSpawnLock(owner)
      return false
    },
    stoppedThisBoot: () => windows && taskStoppedThisBoot(),
  }
}
```

  `cli.ts` imports: `startIfDown, processIfDownDeps` from `'./lib/startIfDown.js'`; `clearTaskStopped, platformDaemonDeps,
  startThroughTask, waitForMaster` from `'./lib/platformDaemon.js'` (beside the existing names);
  `readSpawnLockOwner` from `'./lib/daemonSpawnLock.js'`; `launchDetached` from `'./lib/windows/launcher.js'`;
  `harnessLaunchPath` from `'./lib/windows/installLayout.js'`; `isInstalledCopy` from `'./lib/installedCopy.js'`; `dirname` from `path` if not imported.

  `case 'start'`: `startCommand(foreground, repair, flags.includes('--if-down')).catch(onError)`.

  `startCommand`:

```ts
async function startCommand(foreground: boolean, repair: boolean = false, ifDown: boolean = false): Promise<void> {
  // The scheduled task's start (Windows, lib/startIfDown.ts): nothing to do is the usual answer, and it is quiet.
  if (ifDown) {
    const decision = await startIfDown(processIfDownDeps())
    if (!decision.start) { console.log(`harness start --if-down: ${decision.why} — nothing to do`); process.exit(0) }
  }
  const session = readAuthSession()
  // …unchanged through the "running as another account" block…
    // Windows, the task registered: it starts the master, as the task would at logon; not under the spawn lock,
    // which its own `harness start --if-down` takes (lib/platformDaemon.ts startThroughTask).
    if (!ifDown && installedPlatform() === 'taskscheduler') {
      const started = await startThroughTask(serviceDefinition({ logFile: LOG_FILE }), { ...platformDaemonDeps(), lockHeld: () => readSpawnLockOwner() !== null })
      if (started.ok) return reportStarted(session, started.pid, 'Task Scheduler')
      if (!started.direct) {
        console.error(`\n✗ ${started.detail}`)
        console.error(`  logs   ${tildify(LOG_FILE)}   ·   harness service status`)
        process.exit(1)
      }
      console.log(`  ${started.detail} — starting it directly`)
    }
    await withSpawnLock('start', async () => {
    // …unchanged
```

  (`reportStarted` exits the process; the block sits right before `await withSpawnLock('start', …)` inside
  `if (!foreground)`.)

  `spawnDaemon`, from line 1459:

```ts
  // Opted in to launchd or systemd (`harness service install`): the platform runs the master, and one
  // spawned here would be a second supervisor beside it (lib/platformDaemon.ts). Task Scheduler only starts it.
  const platform = installedPlatform()
  if (platform && platform !== 'taskscheduler') {
    // …unchanged
  }
  const entry = process.env.HARNESS_NO_MASTER === '1' ? '__run' : '__harnessd'
  if (process.platform === 'win32') {
    // Any start but the task's own is a person asking for the daemon: a stop written down earlier is forgotten.
    clearTaskStopped()
    // The master starts through harness-launch.exe (lib/windows/launcher.ts), outside this terminal's job, so closing
    // it or an SSH session does not end it; the master writes its own log (masterProcess.ts). A build run from a
    // checkout is not what the launcher would start, and keeps the spawn below.
    if (entry === '__harnessd' && isInstalledCopy(SCRIPT_PATH, env.ADAPTER_CLI_DIR)) {
      const launched = await launchDetached(harnessLaunchPath(dirname(env.ADAPTER_CLI_DIR)), dirname(env.ADAPTER_CLI_DIR), ['__harnessd'], { ...process.env })
      if (!launched.ok) { console.error(`\n✗ ${launched.detail}`); console.error(`  logs   ${tildify(LOG_FILE)}`); process.exit(1) }
      const pid = await waitForMaster(platformDaemonDeps(), BIND_WAIT_MS)
      if (pid === null) {
        const fail = connectFailure(launchDeps.readLogSlice(logOffset), daemonPort())
        console.error(`\n✗ ${fail?.detail ?? `the daemon did not bind within ${BIND_WAIT_MS / 1000}s`}`)
        console.error(`  logs   ${tildify(LOG_FILE)}`)
        process.exit(1)
      }
      return reportStarted(session, pid)
    }
  }
  const logFd = openSync(LOG_FILE, 'a')
```

  and remove the old `const entry = …` line (`:1476`). macOS and Linux reach exactly the code they reached before.

- [ ] **Failing tests: the installer run again over a live install.** The master re-execs only before a core starts,
  and nothing tells it that `cli\current` moved, so a reinstall would leave the daemon on the old build until its next
  restart. Ruling: after the new pointer is written, when the CLI version changed and `harness status` reports a
  running daemon, install.ps1 runs `harness stop`, then `harness start`. Agents survive: the terminal host is
  independent of the daemon, and the new core reattaches them. In `cli/src/scripts/installPs1.spec.ts`, add inside
  `describe('install.ps1, as written', …)`:

```ts
  it('moves a running daemon to the new build when it is run again over an install', () => {
    expect(source).toContain('$before = Read-HarnessCurrentCli -Root $root')
    expect(source).toContain('$null = Restart-HarnessDaemon -Command $command -Before $before -After $version')
  })
```

  and append:

```ts
describe.runIf(windows)('install.ps1, run again over a live install', () => {
  /** A `harness` that logs each call, one per line, and reports the daemon as [state] to `status`. */
  function fakeHarness(state: string): { command: string; calls: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-restart-'))
    scratch.push(dir)
    const log = join(dir, 'calls.log')
    const command = join(dir, 'harness.cmd')
    writeFileSync(command, ['@echo off', `echo %*>>"${log}"`, `if "%1"=="status" echo    status     ${state}`, 'exit /b 0', ''].join('\r\n'))
    return { command, calls: () => { try { return readFileSync(log, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } catch { return [] } } }
  }
  const last = (text: string) => text.split(/\r?\n/).at(-1)

  it('restarts a running daemon once when the version changed: stop, then start', () => {
    const harness = fakeHarness('running - backend connected')
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.0' -After '1.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('True')
    expect(run.stdout).toContain('Moving the running Harness from 1.0.0 to 1.0.1')
    expect(harness.calls()).toEqual(['status', 'stop', 'start'])
  })

  it('leaves the daemon alone on the same version, on a first install, and when no daemon runs', () => {
    const same = fakeHarness('running - backend connected')
    expect(ps(`Restart-HarnessDaemon -Command '${same.command}' -Before '1.0.1' -After '1.0.1'`).stdout).toBe('False')
    expect(ps(`Restart-HarnessDaemon -Command '${same.command}' -Before '' -After '1.0.1'`).stdout).toBe('False')
    expect(same.calls()).toEqual([])
    const stopped = fakeHarness('stopped')
    expect(ps(`Restart-HarnessDaemon -Command '${stopped.command}' -Before '1.0.0' -After '1.0.1'`).stdout).toBe('False')
    expect(stopped.calls()).toEqual(['status'])
  })

  it('reads the version cli\\current names, and none before a first install', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ps1-current-'))
    scratch.push(root)
    expect(ps(`Read-HarnessCurrentCli -Root '${root}'`).stdout).toBe('')
    mkdirSync(join(root, 'cli'))
    writeFileSync(join(root, 'cli', 'current'), '1.0.0\r\n')
    expect(ps(`Read-HarnessCurrentCli -Root '${root}'`).stdout).toBe('1.0.0')
  })
})
```

  Run `cd cli && npx vitest run src/scripts/installPs1.spec.ts`. Expected on macOS: the new static case fails (the
  two lines are not in the source); the Windows block is skipped.

- [ ] **Implementation: install.ps1.** In `cli/scripts/install.ps1`, add before `function Install-Harness {`:

```powershell
function Read-HarnessCurrentCli {
  # The version cli\current names, or '' before a first install.
  param([string]$Root)
  $pointer = Join-Path $Root 'cli\current'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return '' }
  return ([string](Get-Content -LiteralPath $pointer -TotalCount 1)).Trim()
}

function Restart-HarnessDaemon {
  # Run again over a live install, the installer moves the daemon to the new build. The master re-execs only before
  # a core starts, and nothing tells it that cli\current moved, so the daemon is restarted once: harness stop, then
  # harness start. Agents keep running: the terminal host is independent of the daemon, and the new core reattaches
  # them. Nothing happens on the same version, on a first install, or when no daemon runs.
  param([string]$Command, [string]$Before, [string]$After)
  if (-not $Before -or $Before -eq $After) { return $false }
  $statusLine = @(& $Command status) | Where-Object { $_ -match '^\s*status\s' } | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or -not $statusLine -or $statusLine -match 'stopped|out of reach') { return $false }
  Write-Host "  Moving the running Harness from $Before to $After (your agents keep running)..."
  & $Command stop | ForEach-Object { Write-Host "  $_" }
  & $Command start | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Write-Host "  Harness did not start again on version ${After}. Run 'harness start'." }
  return $true
}
```

  In `Install-Harness` (B1.8), the two CLI lines become:

```powershell
    $step = 'Installing the Harness CLI'
    # The version a running daemon may be on, read before the pointer moves (Restart-HarnessDaemon below).
    $before = Read-HarnessCurrentCli -Root $root
    $version = Install-HarnessCli -Root $root -Entry $sources.cli.entry -Source $sources.cli.source
```

  and right after the `harness version` check (`if ($LASTEXITCODE -ne 0 -or $said.Trim() -ne $version) { throw … }`):

```powershell
    $step = 'Moving the running Harness to the new build'
    # $null: Install-Harness returns a single integer (the guard takes the last value).
    $null = Restart-HarnessDaemon -Command $command -Before $before -After $version
```

  No stderr redirection on the native calls: under `$ErrorActionPreference = 'Stop'`, Windows PowerShell 5.1 turns a
  redirected stderr line into a terminating error. `${After}` is braced because `$After:` would parse as a drive
  variable.

- [ ] Run `npx vitest run src/lib/startIfDown.spec.ts src/scripts/installPs1.spec.ts && npm run typecheck && npm test -- src/lib`.
  Expected: pass; on macOS `installPs1.spec.ts` reports its seven static cases. On the VM, after `vm-sync.sh --cli`:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/scripts/installPs1.spec.ts"`. Expected: all
  22 cases pass (B1.8's 19, the new static case and the three cases above). B1.8's "runs again over itself" case still
  passes: the version is the same, so nothing is restarted.
- [ ] Mac regression: `npm run test:e2e -- e2e/cli.e2e.ts` (the forced launchd/systemd platform path) matches its
  baseline.
- [ ] Commit: `cli: harness start --if-down, and the Windows start paths` —
  `git add cli/src/lib/startIfDown.ts cli/src/lib/startIfDown.spec.ts cli/src/cli.ts cli/scripts/install.ps1 cli/src/scripts/installPs1.spec.ts`

---
### Task B3.16: Self-update over version folders, and rollback by pointer

**Files**
- Modify: `cli/src/lib/windows/cliVersions.ts` (from B3.14's one constant to the folder mechanics)
- Create: `cli/src/lib/windows/cliVersions.spec.ts`
- Modify: `cli/src/lib/selfUpdate.ts:17-22` (imports), `:69-79` (`Pending`, `readPending`), `:350-398` (`stage`),
  `:414-424` (`restore`), `:433-442` (`settleRolledBack`), `:496-523` (options), `:567`, `:609`, `:618`
- Modify: `cli/src/lib/selfUpdate.spec.ts` (mock at the top, new `describe`)

**Interfaces**
- Produces: `stage(dir, cliBuf, notifyBuf, version?, platform?)`, `restore(dir, platform?)`, `settleRolledBack(dir, platform?)`,
  `startSelfUpdater({ …, platform? })`; `cliVersions.ts`: `VERSION_FOLDER`, `isVersionFolder`, `writeVersionFolder`,
  `replaceFile`, `switchTo`, `versionsOnDisk`.
- Consumes: B1 `currentCli(rootDir)`, `writePointer(root, name, value)`, `CLI_POINTER`, `STABLE_NOTIFY`
  (`cli/src/lib/windows/installLayout.ts`). `dir` stays `env.ADAPTER_CLI_DIR` (`~\.harness\cli`); the root B1 reads
  pointers under is `dirname(dir)`.

- [ ] **Failing tests.** `cli/src/lib/windows/cliVersions.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VERSION_FOLDER, isVersionFolder, replaceFile, switchTo, versionsOnDisk, writeVersionFolder } from './cliVersions.js'

const dirs: string[] = []
const cliDir = () => { const root = mkdtempSync(join(tmpdir(), 'cli-versions-')); dirs.push(root); const cli = join(root, 'cli'); mkdirSync(cli); return cli }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the CLI\'s version folders', () => {
  it('are named after a release\'s version and hold its cli.js and notify.mjs', () => {
    expect(['0.5.0', '0.5.1-dev.ab12', '1.2.3+build'].every((name) => VERSION_FOLDER.test(name))).toBe(true)
    expect(['data', 'current', '..', '0.5', '0.5.0\\x', '.0.5.0.1.tmp'].some((name) => VERSION_FOLDER.test(name))).toBe(false)
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    mkdirSync(join(cli, '0.4.0'))
    mkdirSync(join(cli, 'data'))
    expect(isVersionFolder(cli, '0.5.0')).toBe(true)
    expect(isVersionFolder(cli, '0.4.0')).toBe(false)
    expect(versionsOnDisk(cli)).toEqual(['0.5.0'])
    expect(versionsOnDisk(join(cli, 'none'))).toEqual([])
  })

  it('are written whole, through a folder beside them, with the module package metadata', () => {
    const cli = cliDir()
    expect(writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))).toBe(join(cli, '0.5.0'))
    expect(readdirSync(join(cli, '0.5.0')).sort()).toEqual(['cli.js', 'notify.mjs', 'package.json'])
    expect(readFileSync(join(cli, '0.5.0', 'package.json'), 'utf8')).toBe('{"type":"module"}\n')
    expect(readdirSync(cli)).toEqual(['0.5.0'])
    expect(() => writeVersionFolder(cli, '..\\evil', Buffer.from(''), Buffer.from(''))).toThrow(/not a version a folder can be named after/)
  })

  it('keep a folder that already holds these bytes, and move one with other bytes aside', () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    expect(readdirSync(cli)).toEqual(['0.5.0'])
    writeVersionFolder(cli, '0.5.0', Buffer.from('other'), Buffer.from('notify'))
    expect(readFileSync(join(cli, '0.5.0', 'cli.js'), 'utf8')).toBe('other')
    expect(readdirSync(cli).filter((name) => name.endsWith('.old'))).toHaveLength(1)
  })

  it('leave nothing behind when the write fails', () => {
    const cli = cliDir()
    writeFileSync(join(cli, 'blocker'), '')
    expect(() => writeVersionFolder(join(cli, 'blocker'), '0.5.0', Buffer.from(''), Buffer.from(''))).toThrow()
    expect(readdirSync(cli)).toEqual(['blocker'])
  })

  it('switch by moving cli\\current and refreshing the stable notify.mjs the hooks name', () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify 0.5.0'))
    switchTo(cli, '0.5.0')
    expect(readFileSync(join(cli, 'current'), 'utf8').trim()).toBe('0.5.0')
    expect(readFileSync(join(cli, 'notify.mjs'), 'utf8')).toBe('notify 0.5.0')
    // A notify.mjs a running hook holds is left for later: the pointer, which is what runs, has moved.
    const log = vi.fn()
    writeVersionFolder(cli, '0.5.1', Buffer.from('cli'), Buffer.from('notify 0.5.1'))
    rmSync(join(cli, 'notify.mjs'))
    mkdirSync(join(cli, 'notify.mjs'))
    switchTo(cli, '0.5.1', log)
    expect(readFileSync(join(cli, 'current'), 'utf8').trim()).toBe('0.5.1')
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[update\] the hooks' notify\.mjs could not be refreshed yet/))
  })
})

describe('replacing a file a hook may hold', () => {
  it('tries again while Windows says the file is busy, and gives up on anything else', () => {
    const cli = cliDir()
    const file = join(cli, 'notify.mjs')
    let busy = 2
    const rename = vi.fn((from: string, to: string) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      writeFileSync(to, readFileSync(from)); rmSync(from)
    })
    replaceFile(file, Buffer.from('new'), rename, 3, 0)
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(rename).toHaveBeenCalledTimes(3)
    const denied = vi.fn(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    expect(() => replaceFile(file, Buffer.from('x'), denied, 2, 0)).toThrow('EACCES')
    expect(denied).toHaveBeenCalledTimes(2)
    const missing = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    expect(() => replaceFile(file, Buffer.from('x'), missing, 5, 0)).toThrow('ENOENT')
    expect(missing).toHaveBeenCalledTimes(1)
    expect(readdirSync(cli)).toEqual(['notify.mjs'])
  })
})
```

  `selfUpdate.spec.ts`: at the top, after the imports,

```ts
// The pointer file's writer (B1), with a switch to make it fail.
const pointer = vi.hoisted(() => ({ fail: false }))
vi.mock('./windows/installLayout.js', async (real) => {
  const actual = await real<typeof import('./windows/installLayout.js')>()
  return { ...actual, writePointer: (...args: Parameters<typeof actual.writePointer>) => { if (pointer.fail) throw new Error('EPERM'); actual.writePointer(...args) } }
})
```

  and a new `describe`:

```ts
describe('self-update on Windows, over version folders', () => {
  afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; pointer.fail = false })
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const read = (cli: string, ...parts: string[]) => readFileSync(join(cli, ...parts), 'utf8')
  const layout = (current: string) => {
    const cli = join(tempDir(), 'cli')
    mkdirSync(join(cli, current), { recursive: true })
    writeFileSync(join(cli, current, 'cli.js'), `cli ${current}`)
    writeFileSync(join(cli, current, 'notify.mjs'), `notify ${current}`)
    writeFileSync(join(cli, 'current'), `${current}\n`)
    return cli
  }
  const stageWin = (cli: string, version: string) => stage(cli, Buffer.from(`cli ${version}`), Buffer.from(`notify ${version}`), version, 'win32')

  it('stages a build into its own folder and points cli\\current at it, never touching the build that runs', () => {
    const cli = layout('0.5.0')
    stageWin(cli, '0.5.1')
    expect(read(cli, '0.5.1', 'cli.js')).toBe('cli 0.5.1')
    expect(read(cli, 'current').trim()).toBe('0.5.1')
    expect(read(cli, 'notify.mjs')).toBe('notify 0.5.1')
    expect(read(cli, '0.5.0', 'cli.js')).toBe('cli 0.5.0')
    expect(existsSync(join(cli, 'cli.js'))).toBe(false)
    expect(readdirSync(cli).filter((name) => name.startsWith('.'))).toEqual([])
    // The bundle a master fingerprints is the one cli\current names: the update is still to be judged.
    expect(unjudgedUpdate(cli, sha('cli 0.5.1'))).toBe('0.5.1')
  })

  it('rolls back by pointing cli\\current at the build before, and remembers the one that failed', () => {
    const cli = layout('0.5.0')
    stageWin(cli, '0.5.1')
    restore(cli, 'win32')
    expect(read(cli, 'current').trim()).toBe('0.5.0')
    expect(read(cli, 'notify.mjs')).toBe('notify 0.5.0')
    expect(rejectedVersions(cli)).toEqual(['0.5.1'])
    expect(existsSync(join(cli, 'update-pending.json'))).toBe(false)
    // Nothing to go back to: the failure is still remembered.
    const fresh = layout('0.6.0')
    writeFileSync(join(fresh, 'update-pending.json'), JSON.stringify({ version: '0.6.0', sha256: sha('cli 0.6.0') }))
    restore(fresh, 'win32')
    expect(read(fresh, 'current').trim()).toBe('0.6.0')
    expect(rejectedVersions(fresh)).toEqual(['0.6.0'])
  })

  it('rolls back to the last build kept when a newer one was staged during probation', () => {
    const cli = layout('0.5.0')
    stageWin(cli, '0.5.1')
    stageWin(cli, '0.5.2')
    restore(cli, 'win32')
    expect(read(cli, 'current').trim()).toBe('0.5.0')
    stageWin(cli, '0.5.3')
    confirm(cli)
    stageWin(cli, '0.5.4')
    restore(cli, 'win32')
    expect(read(cli, 'current').trim()).toBe('0.5.3')
  })

  it('needs the version, and puts the pending note back when the pointer cannot be moved', () => {
    const cli = layout('0.5.0')
    expect(() => stage(cli, Buffer.from(''), Buffer.from(''), undefined, 'win32')).toThrow(/needs its version/)
    pointer.fail = true
    expect(() => stageWin(cli, '0.5.1')).toThrow('EPERM')
    expect(existsSync(join(cli, 'update-pending.json'))).toBe(false)
    writeFileSync(join(cli, 'update-pending.json'), '{"version":"0.4.9"}\n')
    expect(() => stageWin(cli, '0.5.1')).toThrow('EPERM')
    expect(read(cli, 'update-pending.json')).toBe('{"version":"0.4.9"}\n')
    expect(read(cli, 'current').trim()).toBe('0.5.0')
  })

  it('settles a build rolled back without remembering it, against the build cli\\current names', () => {
    const cli = layout('0.5.0')
    stageWin(cli, '0.5.1')
    expect(settleRolledBack(cli, 'win32')).toBeNull()
    writeFileSync(join(cli, 'current'), '0.5.0\n')
    expect(settleRolledBack(cli, 'win32')).toBe('0.5.1')
    expect(rejectedVersions(cli)).toEqual(['0.5.1'])
    rmSync(join(cli, 'current'))
    writeFileSync(join(cli, 'update-pending.json'), JSON.stringify({ version: '0.5.2', sha256: 'x' }))
    expect(settleRolledBack(cli, 'win32')).toBe('0.5.2')
  })
})
```

- [ ] Run `npx vitest run src/lib/windows/cliVersions.spec.ts src/lib/selfUpdate.spec.ts`. Expected: the new cases fail.

- [ ] **Implementation.** `cli/src/lib/windows/cliVersions.ts`, whole:

```ts
/**
 * The CLI's version folders on Windows (spec section 1, "Layout"; section 3, "Self-update and rollback"): each build
 * in `cli\<version>\`, the one in use named by the pointer file `cli\current` (./installLayout.ts), and beside them the
 * stable `cli\notify.mjs` the hooks' command lines name. On a Mac an update swaps files in place by rename and keeps
 * `.prev` hard links to roll back to. Windows cannot replace a file a running process holds, and has no symlinks
 * without Developer Mode, so a build is never touched once written: an update writes a new folder and moves the
 * pointer, a rollback moves it back.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_POINTER, STABLE_NOTIFY, writePointer } from './installLayout.js'

/** A build's folder name under cli\: its version, as the release names it (`0.5.0`, `0.5.1-dev.ab12`). */
export const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const CLI = 'cli.js'
const NOTIFY = 'notify.mjs'
const PACKAGE = 'package.json'
const RUNTIME_PACKAGE = `${JSON.stringify({ type: 'module' })}\n`
/** A hook reads notify.mjs for a moment; Defender scans a new file for longer. */
export const REPLACE_TRIES = 5
export const REPLACE_PAUSE_MS = 100

export function isVersionFolder(cliDir: string, version: string): boolean {
  return VERSION_FOLDER.test(version) && existsSync(join(cliDir, version, CLI)) && existsSync(join(cliDir, version, NOTIFY))
}

/** Every build on disk, in no order. */
export function versionsOnDisk(cliDir: string): string[] {
  try { return readdirSync(cliDir).filter((name) => isVersionFolder(cliDir, name)) } catch { return [] }
}

function sameBytes(file: string, bytes: Buffer): boolean {
  try { return readFileSync(file).equals(bytes) } catch { return false }
}

/**
 * Write [version]'s folder whole: into a folder beside it, renamed into place, so nothing ever runs half a build. One
 * already there with these bytes is kept (a build staged again after a rollback, or by `harness update`); one with
 * other bytes is moved aside, never written into, since a process may be running from it (the retirement removes it,
 * lib/selfUpdate.ts `retireCliVersions`).
 */
export function writeVersionFolder(cliDir: string, version: string, cliBuf: Buffer, notifyBuf: Buffer): string {
  if (!VERSION_FOLDER.test(version)) throw new Error(`not a version a folder can be named after: ${JSON.stringify(version)}`)
  const folder = join(cliDir, version)
  if (sameBytes(join(folder, CLI), cliBuf) && sameBytes(join(folder, NOTIFY), notifyBuf)) return folder
  const temporary = join(cliDir, `.${version}.${process.pid}.tmp`)
  try {
    mkdirSync(cliDir, { recursive: true })
    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(temporary)
    writeFileSync(join(temporary, PACKAGE), RUNTIME_PACKAGE)
    writeFileSync(join(temporary, CLI), cliBuf)
    writeFileSync(join(temporary, NOTIFY), notifyBuf)
    if (existsSync(folder)) renameSync(folder, join(cliDir, `.${version}.${Date.now()}.old`))
    renameSync(temporary, folder)
  } catch (error) {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* not this call's to clear */ }
    throw error
  }
  return folder
}

const pause = (ms: number): void => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Replace [file] whole, by a file beside it and a rename, tried again while Windows says it is busy (a hook has it
 *  open, or an antivirus scan). */
export function replaceFile(
  file: string, bytes: Buffer, rename: (from: string, to: string) => void = renameSync, tries = REPLACE_TRIES, pauseMs = REPLACE_PAUSE_MS,
): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, bytes)
  for (let attempt = 1; ; attempt++) {
    try {
      rename(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= tries || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        rmSync(temporary, { force: true })
        throw error
      }
      pause(pauseMs * attempt)
    }
  }
}

/**
 * Make [version] the build in use: `cli\current` first (what the next master and core start from), then the stable
 * notify.mjs. A notify.mjs a hook keeps busy past the retries is left as it was, and said: the hooks keep reporting
 * through the one before, as they do through any notify.mjs, until the next switch.
 */
export function switchTo(cliDir: string, version: string, log: (line: string) => void = (line) => console.error(line)): void {
  writePointer(cliDir, CLI_POINTER, version)
  try {
    replaceFile(join(cliDir, STABLE_NOTIFY), readFileSync(join(cliDir, version, NOTIFY)))
  } catch (error) {
    log(`[update] the hooks' notify.mjs could not be refreshed yet (${error instanceof Error ? error.message : String(error)}) — they keep the one before until the next update`)
  }
}
```

  `selfUpdate.ts` imports:

```ts
import { dirname, join } from 'path'
import { currentCli } from './windows/installLayout.js'
import { isVersionFolder, switchTo, writeVersionFolder } from './windows/cliVersions.js'
```

  `Pending` and `readPending`:

```ts
/** The update a stage left to be kept or rolled back: its version, the sha256 of the cli.js it put in place, and
 *  (Windows) the version to roll back to. */
interface Pending { version: string; sha256: string | null; previous: string | null }

function readPending(dir: string): Pending | null {
  const pending = readJson(join(dir, PENDING)) as { version?: unknown; sha256?: unknown; previous?: unknown } | null
  if (typeof pending?.version !== 'string') return null
  return {
    version: pending.version,
    sha256: typeof pending.sha256 === 'string' ? pending.sha256 : null,
    previous: typeof pending.previous === 'string' ? pending.previous : null,
  }
}

/** The cli.js the daemon starts from now: here on macOS and Linux; on Windows the build `cli\current` names. */
function liveCli(dir: string, platform: NodeJS.Platform): string | null {
  return platform === 'win32' ? currentCli(dirname(dir))?.cliJs ?? null : join(dir, CLI)
}

const liveSha256 = (dir: string, platform: NodeJS.Platform): string | null => {
  const file = liveCli(dir, platform)
  return file === null ? null : fileSha256(file)
}
```

  `stage` gains `platform: NodeJS.Platform = process.platform` and, as its first line,
  `if (platform === 'win32') { stageVersion(dir, cliBuf, notifyBuf, version); return }`. Below it:

```ts
/**
 * Windows: the build goes into its own folder and `cli\current` moves to it (./windows/cliVersions.ts); nothing that
 * runs is touched. The pending note names the build to roll back to, as `.prev` holds it on a Mac: the build in use,
 * or, while that build is itself an update still being judged, the last one kept — a rollback goes back to a build
 * that proved itself, not to one that never did. The note is written before the pointer moves, as on a Mac before the
 * swap; if the pointer cannot be moved, the note goes back to what it was.
 */
function stageVersion(dir: string, cliBuf: Buffer, notifyBuf: Buffer, version?: string): void {
  if (!version) throw new Error('a Windows install stages a build into its own version folder, which needs its version')
  const live = currentCli(dirname(dir))
  const pending = readPending(dir)
  const judged = live !== null && !!pending?.sha256 && pending.sha256 === fileSha256(live.cliJs)
  const previous = judged ? pending!.previous : live?.version ?? null
  writeVersionFolder(dir, version, cliBuf, notifyBuf)
  const note = join(dir, PENDING)
  const before = readText(note)
  writeJson(note, { version, sha256: sha256(cliBuf), at: Date.now(), ...(previous && previous !== version ? { previous } : {}) })
  try {
    switchTo(dir, version)
  } catch (error) {
    try {
      if (before === null) rmSync(note, { force: true })
      else writeWhole(note, before)
    } catch { /* the pointer did not move: the build in use is unchanged either way */ }
    throw error
  }
}
```

  `restore`:

```ts
export function restore(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') restoreVersion(dir)
  else {
    for (const name of [CLI, NOTIFY]) {
      const prev = join(dir, `${name}.prev`)
      if (existsSync(prev)) { try { renameSync(prev, join(dir, name)) } catch { /* ignore */ } }
    }
  }
  // …the rejected list and the pending note, unchanged
}

/** Windows: `cli\current` back to the build the pending note names. */
function restoreVersion(dir: string): void {
  const previous = readPending(dir)?.previous
  if (!previous || !isVersionFolder(dir, previous)) return
  try { switchTo(dir, previous) } catch { /* the rejected list below still keeps the failed build from coming back */ }
}
```

  `settleRolledBack(dir: string, platform: NodeJS.Platform = process.platform)`: its first check becomes
  `if (!pending?.sha256 || pending.sha256 === liveSha256(dir, platform)) return null`.

  `startSelfUpdater` options gain `platform?: NodeJS.Platform` (doc: "Whose layout `dir` has; this process's when left
  out."); inside, `const platform = opts.platform ?? process.platform`; line 567:
  `const unremembered = settleRolledBack(opts.dir, platform)`; line 609:
  `if (opts.stageWhileJudged === false && unjudgedUpdate(opts.dir, liveSha256(opts.dir, platform))) {`; line 618:
  `stage(opts.dir, ready.cliBuf, ready.notifyBuf, ready.version, platform)`.

  `confirm` and `unjudgedUpdate` are unchanged: the master fingerprints the build `cli\current` names (B3.19), and
  confirm drops the note (and `.prev` files that are not there).

- [ ] Run `npx vitest run src/lib/selfUpdate.spec.ts src/lib/windows/cliVersions.spec.ts && npm run typecheck`. Expected:
  pass; every mac case is unchanged.
- [ ] Commit: `cli: self-update and rollback over version folders on Windows` —
  `git add cli/src/lib/windows/cliVersions.ts cli/src/lib/windows/cliVersions.spec.ts cli/src/lib/selfUpdate.ts cli/src/lib/selfUpdate.spec.ts`

---

### Task B3.17: Older versions retired once nothing runs from them

**Files**
- Modify: `cli/src/lib/windows/cliVersions.ts` (add `retireUnused`), `cli/src/lib/windows/cliVersions.spec.ts`
- Modify: `cli/src/lib/selfUpdate.ts` (add `retireCliVersions`), `cli/src/lib/selfUpdate.spec.ts`
- Modify: `cli/src/services/updaterProcess.ts:25-46`, `cli/src/services/updaterProcess.spec.ts`

**Interfaces**
- Produces: `retireUnused(cliDir, keep, deps: RetireDeps): Promise<string[]>`, `processRetireDeps(): RetireDeps`;
  `retireCliVersions(dir, deps: RetireDeps): Promise<string[]>`; `UpdaterServiceDeps.retire?: () => Promise<unknown>`;
  `processUpdaterDeps(platform?)`.
- Consumes: A's `windowsProcessRows`.

- [ ] **Failing tests.** `cliVersions.spec.ts`:

```ts
describe('retiring older builds', () => {
  const rows = (...args: string[]) => async () => args.map((line, i) => ({ pid: 100 + i, parentPid: 1, executable: 'node.exe', startMarker: 'w:1', args: line }))

  it('removes builds and leftovers outside the ones to keep, unless a process runs from one', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.5.1', '0.5.2', '0.4.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    mkdirSync(join(cli, '.0.3.0.1.old'))
    mkdirSync(join(cli, '.0.5.3.999.tmp'))
    const stale = join(cli, '.0.5.4.998.tmp')
    mkdirSync(stale)
    utimesSync(stale, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000))
    mkdirSync(join(cli, 'data'))
    const removed = await retireUnused(cli, new Set(['0.5.2', '0.5.1']), {
      rows: rows(`node ${join(cli, '0.4.0', 'cli.js')} __run`), remove: (path) => rmSync(path, { recursive: true, force: true }), log: () => {},
    })
    expect(removed.sort()).toEqual(['.0.3.0.1.old', '.0.5.4.998.tmp', '0.5.0'])
    expect(readdirSync(cli).sort()).toEqual(['.0.5.3.999.tmp', '0.4.0', '0.5.1', '0.5.2', 'data'])
  })

  it('removes nothing it cannot see is unused, and tries again later what it cannot remove yet', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.4.0', '0.3.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    const log = vi.fn()
    expect(await retireUnused(cli, new Set(['0.5.0']), { rows: async () => null, remove: () => { throw new Error('no') }, log })).toEqual([])
    expect(log).toHaveBeenCalledWith('[update] the process table could not be read — the older CLI builds stay for now')
    const removed = await retireUnused(cli, new Set(['0.5.0']), {
      rows: rows(), log,
      remove: (path) => { if (path.endsWith('0.4.0')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); rmSync(path, { recursive: true }) },
    })
    expect(removed).toEqual(['0.3.0'])
    expect(log).toHaveBeenLastCalledWith('[update] 0.4.0 could not be removed yet (EBUSY) — trying again later')
    expect(await retireUnused(join(cli, 'none'), new Set(), { rows: rows(), remove: () => {}, log })).toEqual([])
  })
})
```

  (import `utimesSync` and `retireUnused`.) `selfUpdate.spec.ts`, in the Windows `describe`:

```ts
  it('keeps the build in use and the one to roll back to, and retires the rest', async () => {
    const cli = layout('0.5.0')
    for (const version of ['0.4.0', '0.4.1', '0.4.2']) stageWin(cli, version)
    writeFileSync(join(cli, 'current'), '0.5.0\n')
    rmSync(join(cli, 'update-pending.json'))
    writeFileSync(join(cli, 'update-rejected.json'), '["0.4.2"]\n')
    const remove = (path: string) => rmSync(path, { recursive: true, force: true })
    expect((await retireCliVersions(cli, { rows: async () => [], remove, log: () => {} })).sort()).toEqual(['0.4.0', '0.4.2'])
    expect(versionsOnDisk(cli).sort()).toEqual(['0.4.1', '0.5.0'])
    // On probation, the build to roll back to is the pending note's.
    stageWin(cli, '0.5.1')
    expect(await retireCliVersions(cli, { rows: async () => [], remove, log: () => {} })).toEqual(['0.4.1'])
    // No pointer: nothing proves which build is in use.
    rmSync(join(cli, 'current'))
    expect(await retireCliVersions(cli, { rows: async () => [], remove, log: () => {} })).toEqual([])
  })
```

  (import `retireCliVersions` from `./selfUpdate.js` and `versionsOnDisk` from `./windows/cliVersions.js`.)
  `updaterProcess.spec.ts`, in `describe('the updater in its own process')`:

```ts
  it('on Windows, retires the older CLI builds as it starts, says when that fails, and does nothing of the kind elsewhere', async () => {
    const retire = vi.fn(async () => [])
    const m = make()
    runUpdaterService(undefined, { ...m.deps, retire })
    expect(retire).toHaveBeenCalledOnce()
    for (const thrown of [new Error('boom'), 'plain']) {
      const failing = make()
      runUpdaterService(undefined, { ...failing.deps, retire: async () => { throw thrown } })
      await new Promise((done) => setImmediate(done))
      expect(failing.calls).toContain(`[update] retiring older CLI builds failed: ${thrown instanceof Error ? thrown.message : thrown}`)
    }
    expect(processUpdaterDeps('linux').retire).toBeUndefined()
    // Here, with no cli\current in the test's CLI folder, it proves nothing in use and removes nothing.
    await expect(processUpdaterDeps('win32').retire!()).resolves.toEqual([])
  })
```

  (`make()` is the spec's factory at `:23-37`; it returns `{ deps, calls, … }`.)

- [ ] Run the three specs. Expected: failures.

- [ ] **Implementation.** `cliVersions.ts`, append (and import `statSync`, `ProcessRow` type from `'../processTable.js'`):

```ts
export interface RetireDeps {
  rows(): Promise<readonly ProcessRow[] | null>
  remove(path: string): void
  log(line: string): void
}

/** A folder a stage is still writing is left alone for this long. */
const STAGING_GRACE_MS = 60 * 60_000
/** A build moved aside by `writeVersionFolder`, and a folder a stage writes before its rename. */
const SET_ASIDE = /^\..+\.old$/
const STAGING = /^\..+\.tmp$/

/**
 * Remove every build but [keep], and the folders a stage set aside (`.old`) or left (`.tmp`, once it is an hour old),
 * once no process runs from one: a core or a service of the build before may still be running from its folder, and a
 * pane's `harness` command line names one too. Without a process table nothing is removed. A folder Windows will not
 * remove yet (a file in it still open) is said and tried again at the next pass.
 */
export async function retireUnused(cliDir: string, keep: ReadonlySet<string>, deps: RetireDeps): Promise<string[]> {
  let names: string[]
  try { names = readdirSync(cliDir) } catch { return [] }
  const now = Date.now()
  const candidates = names.filter((name) => {
    if (keep.has(name)) return false
    if (isVersionFolder(cliDir, name) || SET_ASIDE.test(name)) return true
    if (!STAGING.test(name)) return false
    try { return now - statSync(join(cliDir, name)).mtimeMs > STAGING_GRACE_MS } catch { return false }
  })
  if (!candidates.length) return []
  const rows = await deps.rows()
  if (!rows) { deps.log('[update] the process table could not be read — the older CLI builds stay for now'); return [] }
  const lines = rows.flatMap((row) => [row.args, ...(row.nativeArgv ?? [])]).map((arg) => arg.toLowerCase())
  const removed: string[] = []
  for (const name of candidates) {
    const folder = join(cliDir, name).toLowerCase()
    if (lines.some((line) => line.includes(`${folder}\\`) || line.includes(`${folder}/`))) continue
    try {
      deps.remove(join(cliDir, name))
      removed.push(name)
    } catch (error) {
      deps.log(`[update] ${name} could not be removed yet (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}) — trying again later`)
    }
  }
  return removed
}
```

  `selfUpdate.ts`, after `confirm` (import `retireUnused, versionsOnDisk, type RetireDeps` too):

```ts
/**
 * Windows: remove the builds no longer needed (./windows/cliVersions.ts `retireUnused`). Kept: the build in use, and
 * the one a rollback would go back to — the pending note's while an update is on probation, otherwise the newest
 * other build that was not rolled back. Without a pointer, nothing: nothing proves which build is in use.
 */
export async function retireCliVersions(dir: string, deps: RetireDeps): Promise<string[]> {
  const current = currentCli(dirname(dir))
  if (!current) return []
  const rejected = new Set(rejectedVersions(dir))
  const others = versionsOnDisk(dir).filter((version) => version !== current.version && !rejected.has(version))
    .sort((a, b) => (semverGt(a, b) ? -1 : semverGt(b, a) ? 1 : 0))
  const pending = readPending(dir)
  const previous = pending?.previous && pending.previous !== current.version ? pending.previous : others[0]
  return retireUnused(dir, new Set([current.version, ...(previous ? [previous] : [])]), deps)
}
```

  `updaterProcess.ts`:

```ts
export interface UpdaterServiceDeps {
  // …as before
  /** Windows: retire the older CLI builds (lib/selfUpdate.ts `retireCliVersions`), once as the updater starts — it
   *  starts again after every build it stages, and with every master. Left out elsewhere. */
  retire?: () => Promise<unknown>
}

export const processUpdaterDeps = (platform: NodeJS.Platform = process.platform): UpdaterServiceDeps => ({
  // …tell, exit, startCli, startHn, log as before
  ...(platform === 'win32' ? { retire: () => retireCliVersions(env.ADAPTER_CLI_DIR, processRetireDeps()) } : {}),
})
```

  and in `runUpdaterService`, before the final `deps.log(...)`:

```ts
  // Never in the way of the update itself: a pass that fails is the next start's to repeat.
  void deps.retire?.().catch((error: unknown) => deps.log(`[update] retiring older CLI builds failed: ${error instanceof Error ? error.message : String(error)}`))
```

  (imports: `retireCliVersions` beside `startSelfUpdater`, `processRetireDeps` from `'../lib/windows/cliVersions.js'`.)
  In `cliVersions.ts`, beside `RetireDeps` (import `rmSync`, and `windowsProcessRows` from `'./processTable.js'`):

```ts
/** This computer's: A's process table, a removal of the whole folder, the daemon log. */
export const processRetireDeps = (): RetireDeps => ({
  rows: () => windowsProcessRows(null),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  log: (line) => console.log(line),
})
```

- [ ] Run `npm run test:core && npx vitest run src/lib/selfUpdate.spec.ts src/lib/windows/cliVersions.spec.ts`. Expected:
  pass, `updaterProcess.ts` at 100%.
- [ ] Commit: `cli: retire older CLI builds on Windows once nothing runs from them` —
  `git add cli/src/lib/windows/cliVersions.ts cli/src/lib/windows/cliVersions.spec.ts cli/src/lib/selfUpdate.ts cli/src/lib/selfUpdate.spec.ts cli/src/services/updaterProcess.ts cli/src/services/updaterProcess.spec.ts`

---

### Task B3.18: The master hands over where there is no exec

**Files**
- Modify: `cli/src/harnessd/supervisor.ts:79-92` (`ResumeState.handover?`)
- Modify: `cli/src/harnessd/reexec.ts:78-93` (`decodeResume`), `:96-126` (marker), `:193-221` (`ReexecDeps`, new
  `HandOverDeps`), `:224-307` (`createReexec`)
- Modify: `cli/src/harnessd/reexec.spec.ts` (new cases)

**Interfaces**
- Produces: `ResumeState.handover?: { from: number; token: string }`; `ReexecMarker.handover?: string`;
  `HandOverDeps { lock; launch; readPid; alive; sleep; token; leave }`; `ReexecDeps.handOver?: HandOverDeps`;
  `HANDOVER_WAIT_MS = 30_000`, `HANDOVER_POLL_MS = 250`.

- [ ] **Failing tests.** In `reexec.spec.ts`, extend the decode/marker cases:

```ts
  it('hands on who handed over, and reads nothing it does not know as a handover', () => {
    const handed = state({ claimed: true, handover: { from: 4242, token: 'tok' } })
    expect(decodeResume(encodeResume(handed))).toEqual(handed)
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 'x', token: 'tok' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 1, token: '' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: null }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 0, token: 'tok' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 1, token: 7 } }))).toBeNull()
  })
```

```ts
  it('reads a marker\'s handover token, and refuses one that is not text', () => {
    const file = join(dir, 'harnessd-reexec.json')
    writeMarker(file, { pid: 1, from: null, to: 'b', at: 2, handover: 'tok' })
    expect(readMarker(file)).toEqual({ pid: 1, from: null, to: 'b', at: 2, handover: 'tok' })
    writeFileSync(file, JSON.stringify({ pid: 1, from: null, to: 'b', at: 2, handover: 7 }))
    expect(readMarker(file)).toBeNull()
  })
```

  (put the second in `describe('which bundle')`, which has `dir`.) Then a new `describe`:

```ts
describe('handing over, where there is no exec (Windows)', () => {
  let calls: string[]
  let outcomes: ReexecOutcome[]
  let stopping: boolean
  let launched: NodeJS.ProcessEnv[]
  const clock = { now: 1_000 }
  const make = (over: Partial<HandOverDeps> = {}, more: Partial<ReexecDeps> = {}) => createReexec({
    own: 'old', current: () => 'new', nodePath: '/opt/node', execArgv: [], scriptPath: 'C:\\h\\cli\\0.5.1\\cli.js', env: { KEEP: '1' }, pid: 4242,
    execve: null, exists: () => true,
    probe: () => ({ result: Promise.resolve({ ok: true, detail: PROBE_ANSWER }), cancel: () => {} }),
    stopChildren: (done) => { calls.push('stop children'); done() },
    startChildren: () => calls.push('start children'),
    writeMarker: (marker) => calls.push(`marker ${JSON.stringify(marker)}`),
    removeMarker: () => calls.push('remove marker'),
    stopping: () => stopping, now: () => clock.now, log: (line) => calls.push(line),
    handOver: {
      lock: async () => { calls.push('lock'); return () => calls.push('unlock') },
      launch: async (env) => { launched.push(env); return null },
      readPid: () => 4242, alive: (pid) => pid === 5151,
      sleep: async (ms) => { clock.now += ms },
      token: () => 'tok',
      leave: () => calls.push('leave'),
      ...over,
    },
    ...more,
  })
  const run = async (reexec: ReturnType<typeof make>['reexec']) => {
    reexec(state(), (outcome) => outcomes.push(outcome))
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done))
  }
  const REEXECUTING = '[harnessd] the bundle on disk is not this master\'s code — re-executing on it'

  beforeEach(() => { calls = []; outcomes = []; stopping = false; launched = []; clock.now = 1_000 })

  it('starts the new master through the launcher with its state, and leaves once it holds the pid file', async () => {
    let pid = 4242
    await run(make({ readPid: () => pid, sleep: async (ms) => { clock.now += ms; pid = 5151 } }).reexec)
    expect(decodeResume(launched[0]![RESUME_ENV])).toEqual({ ...state(), reexecs: 1, unproven: 1, claimed: true, handover: { from: 4242, token: 'tok' } })
    expect(launched[0]!.KEEP).toBe('1')
    expect(calls).toEqual([
      REEXECUTING, 'stop children', 'lock', `marker ${JSON.stringify({ pid: 4242, from: 'old', to: 'new', at: 1_000, handover: 'tok' })}`,
      '[harnessd] handed over to the new master (pid 5151) — leaving', 'unlock', 'leave',
    ])
    expect(outcomes).toEqual([])
  })

  it('lets go of the spawn lock as it leaves, once the new master holds the pid file, and not before', async () => {
    // The replacement never takes the lock again: the old master's release, after the pid file names the new one, is
    // what frees it. Released earlier, a `harness stop` could land on a master on its way out.
    let pid = 4242
    const pidWhenReleased: Array<number | null> = []
    await run(make({
      readPid: () => pid,
      sleep: async (ms) => { clock.now += ms; if (clock.now >= 2_000) pid = 5151 },
      lock: async () => { calls.push('lock'); return () => { pidWhenReleased.push(pid); calls.push('unlock') } },
    }).reexec)
    expect(pidWhenReleased).toEqual([5151])
    expect(calls.slice(-3)).toEqual(['[harnessd] handed over to the new master (pid 5151) — leaving', 'unlock', 'leave'])
    expect(calls.filter((call) => call === 'unlock')).toHaveLength(1)
  })

  it('keeps this master when the new one does not take over in time, taking its marker back first', async () => {
    // Nothing in the pid file, then a pid that runs nothing, then this master's own: none is a successor.
    await run(make({ readPid: () => (clock.now < 10_000 ? null : clock.now < 20_000 ? 6000 : 4242) }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', `[harnessd] the new master did not take over within ${HANDOVER_WAIT_MS} ms — keeping this master`, 'start children'])
    expect(outcomes).toEqual(['kept'])
    expect(clock.now - 1_000).toBeGreaterThanOrEqual(HANDOVER_WAIT_MS)
  })

  it('leaves after all when the new one claimed the pid file as it gave up', async () => {
    await run(make({ readPid: () => (calls.includes('remove marker') ? 5151 : 4242) }).reexec)
    expect(calls.slice(-3)).toEqual(['remove marker', 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('keeps this master when the spawn lock is busy, the marker will not write, the bundle is gone or the launcher fails', async () => {
    await run(make({ lock: async () => null }).reexec)
    expect(calls.slice(-2)).toEqual(['[harnessd] the daemon spawn lock is busy — keeping this master', 'start children'])
    calls = []
    await run(make({}, { writeMarker: () => { throw new Error('ENOSPC') } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (ENOSPC) — keeping this master', 'start children'])
    calls = []
    // A throw that is not an Error still names itself in the log (the catch's String(error) branch).
    await run(make({}, { writeMarker: () => { throw 'EROFS' } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (EROFS) — keeping this master', 'start children'])
    calls = []
    await run(make({}, { exists: () => false }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', '[harnessd] C:\\h\\cli\\0.5.1\\cli.js is not there to hand over to — keeping this master', 'start children'])
    calls = []
    await run(make({ launch: async () => 'exit 3' }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', '[harnessd] could not start the new master (exit 3) — keeping this master', 'start children'])
    expect(outcomes).toEqual(['kept', 'kept', 'kept', 'kept', 'kept'])
  })

  it('does no more once the master is stopping', async () => {
    await run(make({ lock: async () => { stopping = true; return () => calls.push('unlock') } }).reexec)
    expect(calls.slice(-1)).toEqual(['unlock'])
    calls = []
    await run(make({ lock: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-1)).toEqual(['stop children'])
    calls = []
    stopping = false
    await run(make({ launch: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-2)).toEqual(['remove marker', 'unlock'])
    calls = []
    stopping = false
    await run(make({ sleep: async () => { stopping = true } }).reexec)
    expect(calls.includes('leave') || calls.includes('start children')).toBe(false)
    expect(outcomes).toEqual([])
  })
})
```

  (import `HANDOVER_WAIT_MS, type HandOverDeps` from `./reexec.js`.)

- [ ] Run `npx vitest run src/harnessd/reexec.spec.ts`. Expected: failures (no handover; with `execve: null` the master
  is "kept" before the probe).

- [ ] **Implementation.** `supervisor.ts` `ResumeState`, after `unproven`:

```ts
  /** Windows, which has no exec: the master that handed over to this process, and the token its marker carries
   *  (./reexec.ts `HandOverDeps`). This process claims the pid file and the marker as it starts (./master.ts). */
  handover?: { from: number; token: string }
```

  `reexec.ts` `decodeResume`'s condition gains:

```ts
      && (value.handover === undefined || (!!value.handover && Number.isInteger(value.handover.from) && value.handover.from > 0
        && typeof value.handover.token === 'string' && value.handover.token.length > 0))
```

  `ReexecMarker` gains `/** Windows: the handover this marker belongs to (`HandOverDeps.token`). */ handover?: string`; `readMarker`'s condition gains
  `&& (marker.handover === undefined || typeof marker.handover === 'string')`.

  After `ReexecDeps`'s `log`, add `handOver?: HandOverDeps` with:

```ts
  /**
   * Windows has no exec (`process.execve` is not there): the replacement is a new process, started through
   * harness-launch.exe, and this master leaves once it holds the pid file. Still only in the gap before a core starts,
   * the services stopped and reaped first (./AGENTS.md rule 6). Left out, `execve`.
   */
  handOver?: HandOverDeps
}

/** How long the replacement has to start and claim the pid file: Node loading cli.js, under an antivirus scan. */
export const HANDOVER_WAIT_MS = 30_000
export const HANDOVER_POLL_MS = 250

export interface HandOverDeps {
  /**
   * The daemon spawn lock (lib/daemonSpawnLock.ts), held from before the replacement starts until this master leaves,
   * so a `harness stop` waits for the handover to finish rather than stop the master on its way out while the new one
   * comes up, and the scheduled task's `harness start --if-down` does nothing meanwhile. Null when it is busy.
   */
  lock(): Promise<(() => void) | null>
  /** Start `__harnessd` on the bundle on disk with [env]; null once it is started, why not otherwise. */
  launch(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Who the pid file names now, and whether that runs. */
  readPid(): number | null
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
  /** A fresh token naming this handover in the marker and the state handed on. */
  token(): string
  /** This master's end: the replacement holds the pid file. The spawn lock is released just before (./reexec.ts). */
  leave(): void
}
```

  In `createReexec`: the `execve` check becomes `if (!deps.execve && !deps.handOver) {`; after the probe answered
  (just after the `if (!ok) { … }` block), add `if (deps.handOver) { void handOver(deps.handOver, next, state, now, carryOn); return }`.
  Inside `createReexec`, before `return {`:

```ts
  const successor = (h: HandOverDeps): number | null => {
    const pid = h.readPid()
    return pid !== null && pid !== deps.pid && h.alive(pid) ? pid : null
  }

  /**
   * Windows. The marker names this handover's token: the replacement takes it (and the pid file) only while it still
   * does (./master.ts), and this master takes it back when it gives up waiting, so a replacement that comes up late
   * leaves rather than run beside this one. One that claimed the pid file as this master gave up keeps the machine.
   */
  const handOver = async (h: HandOverDeps, next: string, state: ResumeState, at: number, carryOn: (outcome: ReexecOutcome) => void): Promise<void> => {
    const release = await h.lock()
    if (deps.stopping()) { release?.(); return }
    if (!release) {
      deps.log('[harnessd] the daemon spawn lock is busy — keeping this master')
      carryOn('kept')
      return
    }
    const token = h.token()
    const keep = (why: string): void => {
      deps.removeMarker()
      release()
      deps.log(`[harnessd] ${why} — keeping this master`)
      carryOn('kept')
    }
    // The replacement holds the pid file: this master lets go of the spawn lock and leaves. The replacement never
    // takes the lock again, so this release is what frees it, and it comes only once the pid file names a live
    // successor: until then a `harness stop` waits rather than land on a master on its way out.
    const leave = (): void => {
      release()
      h.leave()
    }
    try {
      deps.writeMarker({ pid: deps.pid, from: deps.own, to: next, at, handover: token })
    } catch (error) {
      release()
      deps.log(`[harnessd] could not leave the re-execution marker (${error instanceof Error ? error.message : String(error)}) — keeping this master`)
      carryOn('kept')
      return
    }
    if (!deps.exists(deps.scriptPath)) { keep(`${deps.scriptPath} is not there to hand over to`); return }
    const env = {
      ...deps.env,
      [RESUME_ENV]: encodeResume({ ...state, reexecs: state.reexecs + 1, unproven: state.unproven + 1, claimed: true, handover: { from: deps.pid, token } }),
    }
    const failed = await h.launch(env)
    if (deps.stopping()) { deps.removeMarker(); release(); return }
    if (failed !== null) { keep(`could not start the new master (${failed})`); return }
    const deadline = deps.now() + HANDOVER_WAIT_MS
    for (;;) {
      const pid = successor(h)
      if (pid !== null) {
        deps.log(`[harnessd] handed over to the new master (pid ${pid}) — leaving`)
        leave()
        return
      }
      if (deps.now() >= deadline) break
      await h.sleep(HANDOVER_POLL_MS)
      // A stop meanwhile is the master's own exit to finish (./master.ts removes the marker it still names).
      if (deps.stopping()) return
    }
    deps.removeMarker()
    if (successor(h) !== null) { leave(); return }
    release()
    deps.log(`[harnessd] the new master did not take over within ${HANDOVER_WAIT_MS} ms — keeping this master`)
    carryOn('kept')
  }
```

  (`carryOn` is the existing closure inside `reexec`; pass it as written.)

- [ ] Run `npm run test:harnessd`. Expected: pass, `reexec.ts` and `supervisor.ts` at 100%.
- [ ] Commit: `harnessd: hand over to the replacement master where there is no exec` —
  `git add cli/src/harnessd/reexec.ts cli/src/harnessd/reexec.spec.ts cli/src/harnessd/supervisor.ts`

---

### Task B3.19: The master's Windows wiring: the current build, takeover, stop by message, its own output

**Files**
- Modify: `cli/src/harnessd/master.ts:27-72` (`MasterConfig`), `:242-411` (`runMaster`)
- Modify: `cli/src/harnessd/master.spec.ts` (new cases in `describe('runMaster')`)
- Modify: `cli/src/harnessd/AGENTS.md` rules 5 and 6

**Interfaces**
- Produces: `MasterConfig.currentScript?: () => string | null`, `.handOver?: Omit<HandOverDeps, 'leave'>`,
  `.stopByMessage?: boolean`, `.output?: number`.
- Consumes: B3.2, B3.3, B3.18.

- [ ] **Failing tests.** In `describe('runMaster')` (helpers `until`, `jsonLines`, `dir` are there):

```ts
  it('starts the core from the build it is told is current, read before every start, and from its own without one (Windows: cli\\current)', async () => {
    const ran = join(dir, 'ran')
    const write = (name: string) => {
      const file = join(dir, name)
      writeFileSync(file, `
        require('node:fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(name)} + '\\n')
        process.send({ type: 'harnessd:bound', protocol: ${HARNESSD_PROTOCOL}, port: 1 })
        process.send({ type: 'harnessd:ready' })
        setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }), 50)
        process.on('SIGTERM', () => process.exit(0))
        if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => process.exit(1), 100)
      `)
      return file
    }
    const own = write('own.cjs')
    let current: string | null = null
    const signals = new Map<string, () => void>()
    const exits: number[] = []
    const supervisor = runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: own, pidFile: join(dir, 'adapter.pid'), restoreUpdate: () => {}, confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '10' },
      currentScript: () => current,
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    await until('the first core', () => existsSync(ran))
    current = write('second.cjs')
    await until('the core started again', () => readFileSync(ran, 'utf8').split('\n').length >= 3)
    expect(readFileSync(ran, 'utf8')).toBe('own.cjs\nsecond.cjs\n')
    await until('running', () => supervisor.status().state === 'running')
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
  })

  it('starts the services and the core from the current build when it has one, never from the lean bundle', async () => {
    // Windows: cli\current names the build. A service process runs from it too (spawnService's currentScript branch),
    // and is not recorded as a lean start; the core is told no lean CLI.
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const body = (who: string) => `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, from: ${JSON.stringify(who)}, cli: process.env.${LEAN_CORE_SCRIPT_ENV} ?? null }) + '\\n')
      if (role === '__run') { process.send({ type: 'harnessd:bound', protocol: ${HARNESSD_PROTOCOL}, port: 1 }); process.send({ type: 'harnessd:ready' }) }
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `
    const own = join(dir, 'cli.cjs')
    const lean = join(dir, 'lean.cjs')
    const current = join(dir, 'current.cjs')
    writeFileSync(own, body('own'))
    writeFileSync(lean, body('lean'))
    writeFileSync(join(dir, LEAN_CORE_ENTRY), body('lean core').replace("require('node:fs')", "await import('node:fs')"))
    writeFileSync(current, body('current'))
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: own, serviceScriptPath: lean, pidFile,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'search' }, currentScript: () => current,
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      const roles = (): Array<Record<string, string>> => jsonLines(seen)
      await until('the core and the service', () => roles().length >= 2)
      expect(roles().sort((a, b) => a.role.localeCompare(b.role))).toEqual([
        { role: '__run', from: 'current', cli: null }, { role: 'service:search', from: 'current', cli: null },
      ])
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
  })

  it('on Windows, stops its core by message, and stops everything when the core asks, writing its children\'s output where told', async () => {
    const heard = join(dir, 'heard')
    const output = join(dir, 'output.log')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      const fs = require('node:fs')
      console.log('the core speaks')
      process.send({ type: 'harnessd:bound', protocol: ${HARNESSD_PROTOCOL}, port: 1 })
      process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }), 50)
      process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(heard)}, 'SIGTERM\\n'); process.exit(0) })
      process.on('message', (m) => { if (m.type === 'harnessd:shutdown') { fs.appendFileSync(${JSON.stringify(heard)}, 'shutdown\\n'); process.exit(0) } })
      setTimeout(() => process.send({ type: 'harnessd:stop' }), 200)
    `)
    const fd = openSync(output, 'a')
    const exits: number[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile: join(dir, 'adapter.pid'), restoreUpdate: () => {}, confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_SERVICES: 'none' }, stopByMessage: true, output: fd,
      exit: (code) => exits.push(code), onSignal: () => {},
    })
    await until('the master to finish', () => exits.length > 0)
    closeSync(fd)
    expect(exits).toEqual([0])
    expect(readFileSync(heard, 'utf8')).toBe('shutdown\n')
    expect(readFileSync(output, 'utf8')).toContain('the core speaks')
  })

  it('takes over from the master that handed over: the marker and the pid file are this process\'s from its start', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const markerFile = join(dir, 'harnessd-reexec.json')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      process.send({ type: 'harnessd:bound', protocol: ${HARNESSD_PROTOCOL}, port: 1 })
      process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    writeFileSync(pidFile, '999999\n')
    writeMarker(markerFile, { pid: 999999, from: 'a', to: fingerprint(core)!, at: 1, handover: 'tok' })
    const resume: ResumeState = { restarts: 0, lastExit: null, lastExitReason: null, update: null, claimed: true, reexecs: 1, unproven: 1, handover: { from: 999999, token: 'tok' } }
    const signals = new Map<string, () => void>()
    const exits: number[] = []
    const updates: string[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile, reexecMarkerFile: markerFile,
      restoreUpdate: () => updates.push('restore'), confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_SERVICES: 'none', [RESUME_ENV]: encodeResume(resume) },
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`)
    expect(readMarker(markerFile)).toMatchObject({ pid: process.pid, handover: 'tok' })
    await until('its core to come up, which ends the marker', () => !existsSync(markerFile))
    expect(updates).toEqual([])
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(existsSync(pidFile)).toBe(false)
  })

  it('leaves at once, starting nothing, when the master that handed over stopped waiting for it', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const markerFile = join(dir, 'harnessd-reexec.json')
    const ran = join(dir, 'ran')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`)
    const resume: ResumeState = { restarts: 0, lastExit: null, lastExitReason: null, update: 'pending', claimed: true, reexecs: 1, unproven: 1, handover: { from: 999999, token: 'tok' } }
    const unwritable = join(dir, 'missing', 'adapter.pid')
    for (const [marker, file] of [
      [null, pidFile], [{ pid: 999999, from: 'a', to: 'b', at: 1, handover: 'other' }, pidFile], [{ pid: 999999, from: 'a', to: 'b', at: 1, handover: 'tok' }, unwritable],
    ] as const) {
      if (marker) writeMarker(markerFile, { ...marker })
      const exits: number[] = []
      const updates: string[] = []
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile: file, reexecMarkerFile: markerFile,
        restoreUpdate: () => updates.push('restore'), confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'none', [RESUME_ENV]: encodeResume(resume) },
        exit: (code) => exits.push(code), onSignal: () => {},
      })
      expect(exits).toEqual([0])
      expect(updates).toEqual([])
    }
    // Handed over to, with no marker file to take over at all.
    const alone: number[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile, restoreUpdate: () => {}, confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_SERVICES: 'none', [RESUME_ENV]: encodeResume(resume) },
      exit: (code) => alone.push(code), onSignal: () => {},
    })
    expect(alone).toEqual([0])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(ran)).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
  })

  it('hands over through the launcher when the bundle on disk is another, and leaves once the new master holds the pid file', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const markerFile = join(dir, 'harnessd-reexec.json')
    const own = join(dir, 'own.cjs')
    const next = join(dir, 'next.cjs')
    writeFileSync(own, '// this master\'s bundle')
    writeFileSync(next, `if (process.argv[2] === '__harnessd-probe') { console.log(${JSON.stringify(PROBE_ANSWER)}); process.exit(0) }`)
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const launched: NodeJS.ProcessEnv[] = []
    const exits: number[] = []
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: own, pidFile, reexecMarkerFile: markerFile, restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'none' }, currentScript: () => next, execve: null,
        handOver: {
          lock: async () => () => {},
          launch: async (env) => { launched.push(env); writeFileSync(pidFile, `${sleeper.pid}\n`); return null },
          readPid: () => Number(readFileSync(pidFile, 'utf8')) || null,
          alive: (pid) => pid === sleeper.pid,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          token: () => 'tok',
        },
        exit: (code) => exits.push(code), onSignal: () => {},
      })
      await until('the old master to leave', () => exits.length > 0)
      expect(exits).toEqual([0])
      expect(decodeResume(launched[0]![RESUME_ENV])?.handover).toEqual({ from: process.pid, token: 'tok' })
      expect(readMarker(markerFile)).toMatchObject({ pid: process.pid, to: fingerprint(next), handover: 'tok' })
    } finally { sleeper.kill() }
  })
```

  (imports: `closeSync, openSync` from `node:fs`; `LEAN_CORE_ENTRY`, `LEAN_CORE_SCRIPT_ENV`, `vi` and `jsonLines` are
  already in the spec, for the lean-bundle cases.)

- [ ] Run `npx vitest run src/harnessd/master.spec.ts -t "Windows|current|takes over|leaves at once|hands over"`. Expected:
  failures (unknown config, the core runs from `scriptPath`).

- [ ] **Implementation.** `MasterConfig`, after `updater?`:

```ts
  /** The file the core, the services and a replacement start from, when it is not `scriptPath`: on Windows the build
   *  `cli\current` names (lib/windows/installLayout.ts `currentCli`), read before every start. An update is judged on
   *  it. Null falls back on `scriptPath`. The lean bundle is not used with it (../masterProcess.ts). */
  currentScript?: () => string | null
  /** Windows: how this master hands over to its replacement (./reexec.ts `HandOverDeps`; `leave` is this file's). */
  handOver?: Omit<HandOverDeps, 'leave'>
  /** Windows: stop the core and the services with `harnessd:shutdown` (./supervisor.ts `stopByMessage`). */
  stopByMessage?: boolean
  /** Where the core's and the services' output goes, a file descriptor: on Windows the launcher gives a master
   *  none, so it opens the daemon's log itself (../masterProcess.ts). Their own output otherwise. */
  output?: number
```

  Import `writeMarker` and `type HandOverDeps` from `'./reexec.js'`. In `runMaster`, replace `const bundle = () =>
  fingerprint(config.scriptPath)` with:

```ts
  // What the next core, service or replacement starts from: the current build (Windows), else this master's bundle.
  const script = (): string => config.currentScript?.() ?? config.scriptPath
  const bundle = () => fingerprint(script())
  const output = config.output ?? 'inherit'
```

  After `const markerFile = config.reexecMarkerFile` and `const alive = …`:

```ts
  // Started by a master handing over (Windows, ./reexec.ts): the marker and the pid file become this process's before
  // anything reads them, as an exec would have kept them; or, when that master gave up waiting and took its marker
  // back, this one leaves at once, having started nothing and rolled nothing back.
  const takeOver = (handover: { from: number; token: string }): boolean => {
    const marker = markerFile ? readMarker(markerFile) : null
    if (!markerFile || !marker || marker.handover !== handover.token) {
      log(`[harnessd] the master that started this one (pid ${handover.from}) stopped waiting for it — leaving`)
      return false
    }
    try {
      writeMarker(markerFile, { ...marker, pid: process.pid })
      writeFileSync(config.pidFile, `${process.pid}\n`)
    } catch (error) {
      log(`[harnessd] could not take over from pid ${handover.from} (${(error as Error).message}) — leaving`)
      return false
    }
    log(`[harnessd] took over from the master before it (pid ${handover.from})`)
    return true
  }
  const tookOver = resume?.handover ? takeOver(resume.handover) : true
  if (markerFile && tookOver) {
```

  (the existing `if (markerFile) { recoverFailedReexec(…) }` now opens with this line.) `const unjudged = resume ?
  null : …` is unchanged (a handed-over master has `resume`).

  `spawnService`:

```ts
    spawnService: (spec, extra) => {
      // From the lean bundle when it can be (./leanServices.ts); with a current build (Windows), from that.
      const file = config.currentScript ? script() : lean.scriptFor(spec.name)
      const handle = coreHandle(spawn(named(`harnessd-${spec.name}`), [...coreExecArgv(config.execArgv, spec.heapLimitMiB), file, '__service', spec.services.join(',')], {
        env: { ...env, ...extra },
        stdio: ['ignore', output, output, 'ipc'],
      }))
      if (!config.currentScript) lean.started(spec.name, file, handle)
      return handle
    },
```

  and add `stopByMessage: config.stopByMessage,` to the `ServiceSupervisor` deps. `spawnCore`:

```ts
    spawnCore: (extra) => {
      const leanCore = config.currentScript ? null : lean.scriptFor(CORE)
      const file = leanCore ?? script()
      const handle = coreHandle(spawn(named('harnessd-core'), [...execArgv, file, '__run'], {
        env: {
          ...env, ...extra, HARNESSD_SERVICE_TOKEN: token, ...serviceProcessesEnv(specs, process.pid),
          ...(leanCore !== null && leanCore !== config.scriptPath ? { [LEAN_CORE_SCRIPT_ENV]: config.scriptPath } : {}),
        },
        stdio: ['ignore', output, output, 'ipc'],
      }))
      if (leanCore !== null) lean.started(CORE, leanCore, handle)
      return handle
    },
```

  `createReexec` call: replace `scriptPath: config.scriptPath,` with `get scriptPath() { return script() },` and add
  after `log,`:

```ts
    // This master's end once its replacement holds the pid file: nothing of the daemon's left to stop.
    ...(config.handOver ? { handOver: { ...config.handOver, leave: () => { stopTrimming(); exit(0) } } } : {}),
```

  Above `supervisor = new Supervisor({`:

```ts
  // A stop, from a signal or from the core (`harnessd:stop`, `harness stop` on Windows): the services go beside the
  // core, inside the same grace `harness stop` gives the whole daemon.
  const stopAll = (why: string): void => {
    stopping = true
    reexec?.cancel()
    services.stop(() => {})
    supervisor!.stop(why)
  }
```

  In the `Supervisor` deps add `stopByMessage: config.stopByMessage,` and `stopRequested: stopAll,`. The signal loop
  becomes `for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) onSignal(signal, () => stopAll(signal))`.
  The end:

```ts
  if (!tookOver) {
    stopTrimming()
    exit(0)
    return supervisor
  }
  supervisor.start()
```

  `harnessd/AGENTS.md`: rule 5, after "launchd or systemd runs the master in the foreground,": add "or, on Windows,
  Task Scheduler starts `harness start --if-down` at logon and every five minutes (`platform.ts`
  `taskSchedulerXml`), which starts a master when none runs;". Rule 6, append: "Windows has no exec: there the
  master starts its replacement through `harness-launch.exe` and leaves once it holds the pid file
  (`reexec.ts` `HandOverDeps`), under the spawn lock (released as the old master leaves; the replacement does not take
  it) and with a token in the marker, so a replacement that comes
  up after the old master gave up leaves rather than run beside it. Windows has no SIGTERM either: the master stops
  its children with `harnessd:shutdown` (`stopByMessage`)."

- [ ] Run `npm run test:harnessd && npm run typecheck`. Expected: pass, `master.ts` at 100% (the `currentScript` and
  lean branches of `spawnCore` and `spawnService` (the current-build case runs a service with `currentScript` set; the
  existing lean cases run one without), `output` given and not, `tookOver` both ways, `handOver` given and not are all
  run).
- [ ] Commit: `harnessd: the master's Windows wiring` —
  `git add cli/src/harnessd/master.ts cli/src/harnessd/master.spec.ts cli/src/harnessd/AGENTS.md`

---

### Task B3.20: `masterProcess.ts`: lean bundle off, and the Windows master configured

**Files**
- Modify: `cli/src/masterProcess.ts:12-27` (imports), `:68-101` (`startMaster`), `:124-141` (`BundleMasterDeps`),
  `:157-168` (`processBundleDeps`), `:178-184` (`startMasterFromBundle`)
- Modify: `cli/src/masterProcess.spec.ts`
- Modify: `cli/AGENTS.md:28` (the process table's "Started" for the master)

**Interfaces**
- Produces: `windowsMaster(scriptPath: string, deps?: WindowsMasterDeps): Partial<MasterConfig>`;
  `startMaster(start, exit?, platform?, windows?)`; `BundleMasterDeps.platform?`.
- Consumes: B1 `currentCli`, `harnessLaunchPath(rootDir)`; B3.10 spawn lock; B3.11 `launchDetached`; B3.14
  `isInstalledCopy`; B3.19 config.

- [ ] **Failing tests.** In `masterProcess.spec.ts`:

```ts
describe('the master on Windows', () => {
  beforeEach(() => { leanBundle.read.mockReset().mockReturnValue(LEAN) })

  it('runs from cli.js alone: the lean bundle relies on hard links, which Windows does not give it', () => {
    const { given, calls } = deps({ platform: 'win32' })
    startMasterFromBundle('C:\\h\\cli\\0.5.0\\cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js' }])
    expect(calls.probes).toEqual([])
    expect(calls.execs).toEqual([])
  })

  const windowsDeps = (over: Partial<WindowsMasterDeps> = {}) => {
    const seen = { launches: [] as unknown[][], redirected: [] as number[] }
    // Posix paths: the test runs on macOS, and the path module there splits on `/` (the Windows comparison
    // itself, `isInstalledCopy`, reads either separator).
    const given: WindowsMasterDeps = {
      cliDir: '/h/cli',
      currentCli: () => ({ cliJs: '/h/cli/0.5.1/cli.js' }),
      exists: () => true,
      openLog: () => 42,
      redirect: (fd) => { seen.redirected.push(fd) },
      isTTY: false,
      launch: async (...args) => { seen.launches.push(args); return { ok: false, detail: 'exit 3' } },
      lock: async () => () => {},
      readPid: () => null, alive: () => false,
      ...over,
    }
    return { given, seen }
  }

  it('stops by message, starts its children from cli\\current, writes the daemon log itself and hands over through the launcher', async () => {
    const { given, seen } = windowsDeps()
    const config = windowsMaster('/h/cli/0.5.0/cli.js', given)
    expect(config.stopByMessage).toBe(true)
    expect(config.output).toBe(42)
    expect(seen.redirected).toEqual([42])
    expect(config.currentScript!()).toBe('/h/cli/0.5.1/cli.js')
    await expect(config.handOver!.launch({ A: '1' })).resolves.toBe('exit 3')
    expect(seen.launches).toEqual([[join('/h', 'bin', 'harness-launch.exe'), '/h', ['__harnessd'], { A: '1' }]])
    const ok = windowsDeps({ launch: async () => ({ ok: true }) })
    await expect(windowsMaster('/h/cli/0.5.0/cli.js', ok.given).handOver!.launch({})).resolves.toBeNull()
    expect(config.handOver!.token()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps a checkout\'s build, has no launcher to hand over through, and writes nothing for a terminal', () => {
    const dev = windowsMaster('/work/oh/cli/dist/cli.js', windowsDeps().given)
    expect(dev.currentScript).toBeUndefined()
    expect(dev.handOver).toBeUndefined()
    expect(windowsMaster('/h/cli/0.5.0/cli.js', windowsDeps({ exists: () => false }).given).handOver).toBeUndefined()
    const terminal = windowsDeps({ isTTY: true })
    expect(windowsMaster('/h/cli/0.5.0/cli.js', terminal.given).output).toBeUndefined()
    expect(terminal.seen.redirected).toEqual([])
    expect(windowsMaster('/h/cli/0.5.0/cli.js', windowsDeps({ currentCli: () => null }).given).currentScript!()).toBeNull()
  })

  it('is what startMaster runs on Windows, and nothing of it elsewhere', () => {
    runMaster.mockClear()
    startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => ({ stopByMessage: true }))
    expect(runMaster.mock.calls[0]![0]).toMatchObject({ stopByMessage: true, scriptPath: '/cli/cli.js' })
    startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'darwin', () => { throw new Error('never on macOS') })
    expect(runMaster.mock.calls[1]![0]).not.toHaveProperty('stopByMessage')
  })
})
```

  (add `windowsMaster` to the names destructured from `await import('./masterProcess.js')` at the top, and add
  `import type { WindowsMasterDeps } from './masterProcess.js'` beside the static imports: a type cannot be
  destructured from a dynamic import, and a type-only import loads nothing before the mocks. `join` from `node:path`
  is there.)

- [ ] Run `npx vitest run src/masterProcess.spec.ts`. Expected: failures.

- [ ] **Implementation.** `masterProcess.ts` imports add `randomBytes` from `node:crypto`, `openSync, writeSync` from
  `node:fs`, `dirname` from `node:path`, `format` from `node:util`, `type MasterConfig` from `'./harnessd/master.js'`,
  `acquireSpawnLock` from `'./lib/daemonSpawnLock.js'`, `isAlive, readPid` from `'./lib/daemonState.js'`, `currentCli`
  and `harnessLaunchPath` from `'./lib/windows/installLayout.js'`, `launchDetached` from `'./lib/windows/launcher.js'`.

```ts
export interface WindowsMasterDeps {
  cliDir: string
  currentCli(root: string): { cliJs: string } | null
  exists(path: string): boolean
  /** The daemon's log, opened to append. */
  openLog(): number
  /** This process's console, written to [fd] from now on. */
  redirect(fd: number): void
  /** The master runs in a terminal (`harness start -f`), which shows its output. */
  isTTY: boolean
  launch: typeof launchDetached
  lock(): Promise<(() => void) | null>
  readPid(): number | null
  alive(pid: number): boolean
}

/** How long a master about to hand over waits for the spawn lock: a start or a stop under way finishes in seconds. */
export const HANDOVER_LOCK_WAIT_MS = 5_000

export const processWindowsMasterDeps = (): WindowsMasterDeps => ({
  cliDir: env.ADAPTER_CLI_DIR,
  currentCli: (root) => currentCli(root),
  exists: existsSync,
  openLog: () => openSync(DAEMON_LOG_FILE, 'a'),
  redirect: (fd) => {
    for (const name of ['log', 'info', 'warn', 'error'] as const) {
      console[name] = (...args: unknown[]) => { try { writeSync(fd, `${format(...args)}\n`) } catch { /* a full disk costs the line */ } }
    }
  },
  isTTY: !!process.stdout.isTTY,
  launch: launchDetached,
  lock: async () => { try { return await acquireSpawnLock('handoff', { waitMs: HANDOVER_LOCK_WAIT_MS }) } catch { return null } },
  readPid,
  alive: isAlive,
})

/**
 * The master on Windows (spec section 3). It stops its children by message: there is no SIGTERM there. It writes the
 * daemon's log itself, and gives its children that log for their output: harness-launch.exe starts it with no output
 * at all. The installed copy starts its children, and hands over, on the build `cli\current` names: an update writes a
 * new version folder rather than replacing the master's own cli.js. A build from a checkout keeps its own file, and
 * hands over to nothing (no launcher would start it).
 */
export function windowsMaster(scriptPath: string, deps: WindowsMasterDeps = processWindowsMasterDeps()): Partial<MasterConfig> {
  const installed = isInstalledCopy(scriptPath, deps.cliDir, 'win32')
  const root = dirname(deps.cliDir)
  const launcher = harnessLaunchPath(root)
  let output: number | undefined
  if (!deps.isTTY) {
    output = deps.openLog()
    deps.redirect(output)
  }
  return {
    stopByMessage: true,
    ...(output !== undefined ? { output } : {}),
    ...(installed ? { currentScript: () => deps.currentCli(root)?.cliJs ?? null } : {}),
    ...(installed && deps.exists(launcher) ? {
      handOver: {
        lock: deps.lock,
        launch: async (handed: NodeJS.ProcessEnv) => {
          const outcome = await deps.launch(launcher, root, ['__harnessd'], handed)
          return outcome.ok ? null : outcome.detail
        },
        readPid: deps.readPid,
        alive: deps.alive,
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        token: () => randomBytes(16).toString('hex'),
      },
    } : {}),
  }
}
```

  `startMaster`:

```ts
export function startMaster(
  start: MasterStart, exit: (code: number) => void = (code) => process.exit(code),
  platform: NodeJS.Platform = process.platform, windows: () => Partial<MasterConfig> = () => windowsMaster(start.scriptPath),
): ReturnType<typeof runMaster> {
  ensureUtf8Locale()
  dropAgentSessionEnv()
  const { serviceScriptPath } = start
  return runMaster({
    env: masterEnv(process.env, unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT)),
    nodePath: baseNode(process.execPath),
    execArgv: process.execArgv,
    runtimeDir: env.ADAPTER_RUNTIME_DIR,
    ...(platform === 'win32' ? windows() : {}),
    ...start,
    // …the rest unchanged
```

  `BundleMasterDeps` gains `/** This operating system (Windows: no lean bundle). */ platform?: NodeJS.Platform`;
  `processBundleDeps` sets `platform: process.platform`; `startMasterFromBundle`, after `fromBundle` is declared:

```ts
  // The lean bundle's claims and its services' identity rely on hard links of the managed node (harnessd/AGENTS.md
  // rules 7 and 8), which a Windows install does not make: there the master and everything it starts run from cli.js.
  if (deps.platform === 'win32') { fromBundle(null); return }
```

  `cli/AGENTS.md` line 28, the master's "Started" cell: "by `harness start`, `harness start -f`, or launchd or systemd
  after `harness service install`; on Windows through `harness-launch.exe`, and by Task Scheduler's
  `harness start --if-down` after `harness service install`".

- [ ] Run `npx vitest run src/masterProcess.spec.ts && npm run typecheck && npm run test:harnessd`. Expected: pass.
- [ ] Commit: `cli: the master on Windows: no lean bundle, cli\current, its own log, handover through the launcher` —
  `git add cli/src/masterProcess.ts cli/src/masterProcess.spec.ts cli/AGENTS.md`

---

### Task B3.21: Verify on Windows

Unit tests on mac cover every decision. This task proves the parts that only Windows can show: TerminateProcess
ends one process, not its tree; schtasks takes the task XML and reports its state; and the whole lifecycle works on
a real install. Prerequisites: B1 (installer, `harness-launch.exe`, local manifest) and B2 (pipe) are on the branch.

**Files**
- Create: `cli/src/lib/windows/terminate.real.spec.ts`, `cli/src/lib/windows/taskScheduler.real.spec.ts`
- Create: `docs/testing/windows-cli-e2e.md`, with a "B3 lifecycle" section only (B5.14 adds its scenarios to it)

- [ ] **Real specs.** `terminate.real.spec.ts`:

```ts
// TerminateProcess ends the one process: its child lives on. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/terminate.real.spec.ts
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processExists } from '../processLiveness.js'
import { windowsProcessRows } from './processTable.js'
import { terminateVerified } from './terminate.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN

describe.skipIf(!enabled)('TerminateProcess on Windows', () => {
  it('ends the process it identified and never its child: the pty host outlives a core ended this way', async () => {
    const parent = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      console.log(child.pid)
      setTimeout(() => {}, 60000)
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    const childPid = Number(await new Promise<string>((resolve) => parent.stdout!.once('data', (chunk) => resolve(String(chunk).trim()))))
    try {
      const rows = await windowsProcessRows(null)
      const marker = rows!.find((row) => row.pid === parent.pid)!.startMarker
      await expect(terminateVerified(parent.pid!, 'w:1')).resolves.toBe('mismatch')
      await expect(terminateVerified(parent.pid!, marker)).resolves.toBe('ended')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(processExists(parent.pid!)).toBe(false)
      expect(processExists(childPid)).toBe(true)
      await expect(terminateVerified(parent.pid!, marker)).resolves.toBe('gone')
    } finally {
      try { process.kill(childPid) } catch { /* gone */ }
      parent.kill()
    }
  }, 30_000)
})
```

  `taskScheduler.real.spec.ts`:

```ts
// The task XML as Task Scheduler takes it, under a throwaway name (never a user's own taskName(<user>),
// `Harness harnessd (<user>)`). Windows only:
//   cd cli && npx vitest run src/lib/windows/taskScheduler.real.spec.ts
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { taskSchedulerXml } from '../../harnessd/platform.js'

describe.skipIf(process.platform !== 'win32')('the scheduled task on Windows', () => {
  it('is taken by schtasks as written, enabled, with its two triggers, and removed again', () => {
    const name = `\\HarnessTest\\b3-${randomBytes(4).toString('hex')}`
    const dir = mkdtempSync(join(tmpdir(), 'task-'))
    const file = join(dir, 'task.xml')
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME!
    writeFileSync(file, taskSchedulerXml({
      launcherPath: join(process.env.SystemRoot!, 'System32', 'whoami.exe'), root: dir, home: dir, logFile: join(dir, 'harness.log'), user,
    }))
    const run = (...args: string[]) => spawnSync('schtasks', args, { encoding: 'utf8' })
    try {
      const created = run('/Create', '/TN', name, '/XML', file, '/F')
      expect(created.status, created.stderr).toBe(0)
      const shown = run('/Query', '/TN', name, '/XML')
      expect(shown.status).toBe(0)
      const text = shown.stdout.replace(/\u0000/g, '')
      expect(text).toMatch(/<LogonTrigger>/)
      expect(text).toMatch(/<Interval>PT5M<\/Interval>/)
      expect(text).toMatch(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
      expect(text).toMatch(/<Settings>[\s\S]*<Enabled>true<\/Enabled>/)
    } finally {
      run('/Delete', '/TN', name, '/F')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] Sync and run on the VM (never `C:\work\e2e`):

```bash
VM_SSH=admin@192.168.65.3 VM_DIR=C:/work/oh cli/scripts/windows-pty-e2e/vm-sync.sh --cli
ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && cargo +stable build"
ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npm ci && set HARNESS_PTY_BIN=C:\work\oh\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/terminate.real.spec.ts src/lib/windows/taskScheduler.real.spec.ts src/lib/windows/launch.real.spec.ts"
```

  Expected: both new specs pass (2 tests); A's launch spec still passes. If `schtasks /Create` rejects the UTF-8
  file ("The task XML is malformed"), switch `PlatformService.write` for `taskscheduler` to UTF-16LE with a BOM
  (`Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])`) and its `readFile` to decode a BOM,
  with a unit test for each, and run the spec again.

- [ ] **Lifecycle on a real install**, as a fresh local user, so the signed-in daemon's profile is never touched.
  As admin on the VM (PowerShell through `-EncodedCommand`, as `vm-sync.sh`'s notes describe):

```powershell
$pw = ConvertTo-SecureString ([guid]::NewGuid().ToString() + 'aA1!') -AsPlainText -Force
New-LocalUser -Name hb3 -Password $pw -NoPasswordExpiration
New-Item -ItemType Directory -Force C:\Users\hb3\.ssh | Out-Null   # after hb3's first logon creates the profile
Copy-Item C:\Users\admin\.ssh\authorized_keys C:\Users\hb3\.ssh\authorized_keys
icacls C:\Users\hb3\.ssh\authorized_keys /inheritance:r /grant hb3:F /grant SYSTEM:F
```

  Then as `hb3` (`ssh hb3@192.168.65.3`): install with B1's installer from the local manifest of this build, the
  `install-manifest.json` that B1.9's `cli/scripts/windows-install-manifest.mjs` writes (as in B1.9 Step 5):
  `install.ps1 -Manifest <out>\install-manifest.json -NoService`. Then run, recording each result in
  `docs/testing/windows-cli-e2e.md` under "B3 lifecycle":
  1. `harness start` → started; `tasklist /FI "IMAGENAME eq node.exe" /V` shows the master and the core; the
     master's parent is gone (started through the launcher); closing the SSH session and reconnecting leaves both
     running.
  2. Start a PowerShell agent; `harness stop` → "machine stopped"; the daemon log shows
     `[harnessd] the core asked to stop (harness stop) — stopping` and `[harnessd] core stopped (code 0)`; `harness-pty`
     and the agent's process are still in `tasklist`.
  3. `harness start`; `taskkill /PID <core pid> /F` (the core alone) → the master logs a crash and starts a core again;
     the agent is reattached (`harness status`).
  4. `harness service install` → the task is registered under hb3's own name, `taskName('hb3')`
     (`schtasks /Query /TN "Harness harnessd (hb3)"`); over SSH the
     `/Run` does not start it (no signed-in session), and `harness start` says "starting it directly".
  5. Sign in as `hb3` on the VM's console (UTM window), then end the master (`taskkill /PID <master pid> /F`): within
     5 minutes the task's `harness start --if-down` brings it back (`harness status`, and the log's start line).
  6. `harness stop`, wait past the next 5-minute mark → still stopped (`harnessd-stopped.json` honoured); reboot and
     sign in → the daemon is back at logon.
  7. Self-update with two local builds N and N+1 (an update manifest `{ "cli": … }` naming N+1 by absolute http URLs,
     served to `ADAPTER_UPDATE_URL`, as selfUpdate.ts `fetchManifest` reads it). B5.13's `serve-updates.sh` comes
     later, so serve them here with Node on the VM, from the folder holding the builds and `metadata.json`:
     `node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>f.createReadStream(p.join(process.argv[1],decodeURIComponent(q.url.split('?')[0]))).on('error',()=>{s.statusCode=404;s.end()}).pipe(s)).listen(8765,'127.0.0.1')" C:\work\b3\updates`
     and set `ADAPTER_UPDATE_URL=http://127.0.0.1:8765/metadata.json` for `hb3`'s daemon (`setx`, then restart it): the updater stages
     `cli\<N+1>\`, `cli\current` reads N+1, `cli\notify.mjs` is N+1's, the log shows the handover (`[harnessd] handed
     over to the new master (pid …) — leaving`, then `took over from the master before it`), the pid file names
     the new master, the agent survives. Then a build N+2 whose core exits at start: rolled back,
     `cli\current` reads N+1, `update-rejected.json` lists N+2. Restart the updater (`harness restart` or a master
     restart): `cli\<N>\` is removed once nothing runs from it.
  8. Clean up: `harness service uninstall`, `harness stop`, and as admin `Remove-LocalUser hb3` and remove
     `C:\Users\hb3`.

- [ ] Commit: `windows: real checks for TerminateProcess and the task, and the B3 lifecycle on the VM` —
  `git add cli/src/lib/windows/terminate.real.spec.ts cli/src/lib/windows/taskScheduler.real.spec.ts docs/testing/windows-cli-e2e.md`

---

### Phase B3 notes

Verified assumptions (read in the code on this branch):
- Node's `kill` on Windows is TerminateProcess on that pid alone, whatever the signal; the master's `child.kill` acts on
  its own handle, so the master needs no identity check for its children (`master.ts:213`, `coreHandle`).
- The master claims the pid file only when its core binds (`supervisor.ts:414`), so "started before the pid file was
  written" is a valid proof that a pid is still the master (B3.7), the same proof A uses for the pty host
  (`ptyHost/launch.ts:160-187`).
- The spawn lock rejected every Windows owner record on mode (`daemonSpawnLock.ts:142-147`), so contention failed and a
  crashed holder was never reclaimed there. B3.10 fixes this, because `--if-down` depends on it.
- `isInstalledCopy` could never be true on Windows, so the master's updater did not run there (`masterProcess.ts:93`).
  B3.14 fixes it.
- `harnessd/` is held to 100% per file (`vitest.harnessd.config.ts`); `masterProcess.ts`, `lib/` and `cli.ts` are not,
  but each new branch has a unit test anyway.
- The core already listens to its master from module start (`core/main.ts:341`), so a `harnessd:shutdown` sent during
  start-up is not lost (B3.4 remembers it as `onUpdate` does).

Open risks:
- `schtasks /Create /XML` and a UTF-8 file: B3.21 checks it on the VM, and the fallback (UTF-16LE + BOM) is written out.
- An InteractiveToken task runs only in a signed-in session. A remote machine nobody signs in to does not start the
  daemon at boot (the spec's own E2E step 2 checks "back at logon"). S4U ("whether logged on or not, no password")
  needs "Log on as a batch job", which standard users lack. This is for the owner to decide, and is recorded in the
  E2E doc.
- TerminateProcess after a table read leaves a window of milliseconds in which a pid could exit and be reissued. A
  race-free `harness-pty terminate --pid --start-marker` (same handle for the check and the kill) is a small A-side
  follow-up if review wants it.
- A master handing over and a late replacement could, in a window of microseconds (the old one takes its marker back
  just as the new one rewrites it), both run. The second core's bind fails (EADDRINUSE), and the next `harness stop`
  ends both. Accepted, and noted in `reexec.ts`.
- The master's log on Windows is opened with append; `trimLogFile` rewrites the log in place while the master and its
  children hold it open. That works on NTFS with Node's default share mode, but has not been measured; check it in
  B3.21 step 7 (log size after trimming).
- B2's server puts `X-Harness-Proof` on every authenticated pipe response, including handler routes such as
  `/api/daemon/stop`: B2.5 sets it with `res.setHeader` before the handler runs, so a handler's `writeHead` merges it,
  and B2.10's test reaches the `/api/auth/handoff` route through `pipeRequest`, which rejects an answer without it.
  B3.8 asks through the same `pipeRequest`, and its real-listener test answers with `writeHead(202, …)`. A missing
  header would show as "did not take the stop", and the CLI would then terminate the identified master.

Decisions where the spec is silent:
- Decision: `harness stop` with the task registered writes `harnessd-stopped.json` (the boot time), and `--if-down`
  honours it until the next boot; any other start clears it — why: without it the 5-minute trigger undoes every
  `harness stop`, and launchd's equivalent (bootout) also lasts until the next login.
- Decision: a core that stops for good (`CORE_EXIT_STOP`: revoked, busy) is not marked stopped, so the task starts it
  again within 5 minutes — why: a revoked core comes back signed out and serves locally; a busy one retries the
  other computer's hold, which is what a person would do; marking it would need the master to know it runs under the
  task, which a task's action cannot tell it.
- Decision: the task's action carries `--root "<~\.harness>"` and its log path in `<Description>` (how `ownedBy` knows
  the task belongs to this data folder) — why: a task has no environment block, so this is the only way to bind it to
  one install. CARRIED_ENV values set only in the shell are reported as not reaching it, not refused.
- Decision: `harness start` with the task registered runs it (`schtasks /Run`) outside the spawn lock, and starts the
  master directly when nothing started within 10 s and nobody holds the lock — why: the task's own start takes that
  lock (under it, both would wait on each other), and over SSH Task Scheduler does not run an InteractiveToken task.
- Decision: `harness service install` on Windows registers under the lock and runs the task once outside it, and never
  stops a running daemon — why: the task starts masters but does not run them, so there is no second supervisor to
  hand over to.
- Decision: the master is not told it runs under Task Scheduler (`platformFromEnv` unchanged), and the status file
  carries no platform on Windows — why: a task's action has no environment; `harness service status` reports the
  task.
- Decision: stopping is a new route `POST /api/daemon/stop` on the trusted endpoint (trusted + `x-adapter-local`),
  answered 202 before the core asks its master — why: the spec names "asks the core over the pipe", and this mirrors
  `/api/auth/handoff`'s guard. The route exists on win32 only (`daemonStopRoute`); on mac and Linux there is no such
  route (404, as before) and `harness stop` still signals.
- Decision: the master sends `harnessd:shutdown` to any core or service whatever its protocol, and ends it after the
  usual grace — why: one that does not know the message is then ended just as TerminateProcess ended it before, 2.5 s
  later. Gating on protocol would add a branch with no benefit.
- Decision: the handover runs under the spawn lock (purpose `handoff`, 5 s wait) with a random token in the marker and
  the resume state; the replacement takes the pid file and the marker as its first act, or leaves when the token no
  longer matches; the old master waits 30 s, and releases the spawn lock as it leaves, once the replacement has
  written the pid file (`reexec.ts` `leave`); the replacement does not take the lock again — why: spec section 3 has
  the replacement "taken the spawn lock and written the pid file" before the old one exits; the old master's lock,
  held until the pid file names its successor, gives the same guarantee without a second acquisition (which the old
  master's own hold would block), and the lock is never left held by a master that has gone. A pid file that names a
  live master at every instant keeps `harness start` from starting a second one, and the lock keeps `harness stop`
  from landing mid-handover.
- Decision: the resume state handed over says `claimed: true`, and the replacement writes the pid file itself at start —
  why: under exec the pid file stayed valid through the swap; this keeps that property with a new pid.
- Decision: on Windows the master opens the daemon log itself (append) and gives it to its children's stdout and
  stderr, unless its stdout is a terminal — why: `harness-launch.exe` starts the master with no output, and the
  contract gives the launcher no log option.
- Decision: the Windows retirement of older builds runs in the updater's process at its start, from the process table,
  and keeps the build in use plus the rollback target (the pending note's, else the newest build not rejected) — why:
  the updater restarts after every stage and with every master, it may block on a 3 s table read without harm, and
  "the two newest" in the spec read literally would keep a rejected build over the good one before it.
- Decision: `currentCli` is called with `dirname(ADAPTER_CLI_DIR)` and `writePointer` with `ADAPTER_CLI_DIR` (pointer
  `cli\current`) — why: B1's contract names `cli\current` relative to the root it is given; `ADAPTER_CLI_DIR` stays
  `~\.harness\cli`, as the contract's environment facts say.
- Decision: the notify.mjs refresh after the pointer moves is retried 5 times over 1.5 s, and is logged (not fatal) if a
  hook still holds it — why: the pointer is what the daemon runs; hooks report through any notify.mjs, and the next
  switch refreshes it.
- Decision: the core on Windows keeps the master's Node, and a Node runtime update reaches the core with the next master
  (a handover through the launcher, which resolves `runtime\current-node`) — why: the spec says "the next master and
  core use it", and switching a core's Node without its master would make the two run different Node versions until
  the master is replaced.
- Decision: a core started without a master by an older release's handoff (`core/main.ts:308` `startMasterHere`) is
  left as it is on Windows — why: no Windows release before B3 could leave one, and `HARNESS_NO_MASTER=1` asks for no
  updates.


---

## Phase B4: Hooks and engines

B4 turns engine hooks on for Windows. Each engine declares what runs its hook on win32 (`argv`, `bash`, `cmd`,
`powershell`) and the hook line is quoted for that runner. `notify.mjs` and the JS plugins name a pty host pane through
`HARNESS_PANE`, and the hook server accepts that hint. The hook file writers get Windows paths. B4 also pins the
engine homes, fixes or refuses OpenCode on Arm and Command Code, words the two new error codes in the desktop and mobile
apps, and removes the last `DISABLE_HOOK_INSTALL=true` the Windows run depends on.

Conventions in this part (the same as B1):

- **VM sync:** `cli/scripts/windows-pty-e2e/vm-sync.sh --cli` copies the tree to `C:\work\oh` on `admin@192.168.65.3`.
  Run it before any VM command.
- **VM tests:** `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run <paths>"`.
  Scratch folders for this phase live under `C:\work\b4`. `C:\work\e2e` and its signed-in daemon are never touched
  (Global Constraints), not even stopped.
- **B4's own install (`C:\work\b4`).** B4.12, B4.13 and B4.15 drive engines on a daemon of their own: the E2E recipe of
  `docs/testing/windows-pty-e2e.md`, with every path moved from `C:\work\e2e` to `C:\work\b4`, its own data folder
  (`C:\work\b4\data`, from `env.cmd`) and port 18475 (18473 may be `C:\work\e2e`'s, and 18474 is B5's test user's).
  "Build and copy the B4 install" means, on the Mac from the repository root, after `vm-sync.sh --cli` and the VM's
  `cargo build --release` (recipe steps 1-2):

```bash
VM=admin@192.168.65.3
(cd cli && . scripts/lib/build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" npm run bundle)
b4=$(mktemp -d)
cp cli/scripts/windows-pty-e2e/*.cmd cli/scripts/windows-pty-e2e/*.ps1 "$b4/"
sed -i '' 's/C:\\work\\e2e/C:\\work\\b4/g' "$b4"/*.cmd "$b4"/*.ps1
printf 'set PORT=18475\r\n' >> "$b4/env.cmd"
cli/scripts/windows-pty-e2e/build.sh "$b4" >/dev/null
# The driver's defaults, in the bundle: its state, project and computer-id paths, and the port it dials.
sed -i '' -e 's/C:\\\\work\\\\e2e/C:\\\\work\\\\b4/g' -e 's/127\.0\.0\.1:18473/127.0.0.1:18475/g' "$b4/e2e.mjs"
grep -l 'work\\\\e2e\|work\\e2e\|:18473' "$b4"/* || echo "no C:\\work\\e2e and no 18473 left"
ssh $VM "if not exist C:\work\b4\dist\pty mkdir C:\work\b4\dist\pty & if not exist C:\work\b4\proj mkdir C:\work\b4\proj"
tar -cf - -C "$b4" . | ssh $VM "tar -xf - -C C:/work/b4"
tar -cf - -C cli/dist . | ssh $VM "tar -xf - -C C:/work/b4/dist"
ssh $VM "copy /y C:\work\oh\pty\target\release\harness-pty.exe C:\work\b4\dist\pty\ & copy /y C:\work\oh\pty\vendor\conpty\arm64\conpty.dll C:\work\b4\dist\pty\ & copy /y C:\work\oh\pty\vendor\conpty\arm64\OpenConsole.exe C:\work\b4\dist\pty\"
```

  Expected: `no C:\work\e2e and no 18473 left`. "Start the B4 daemon" is
  `ssh $VM "powershell -NoProfile -ExecutionPolicy Bypass -File C:\work\b4\launch.ps1"` (recipe step 6), and
  `ssh $VM "C:\work\b4\cli.cmd status"` then shows it running with state `C:\work\b4\data` (`env.cmd` gives it
  `PORT=18475`). "Stop the B4
  daemon" is `ssh $VM "C:\work\b4\stop.cmd"`. The scenarios run as `C:\work\b4\run.cmd <command>`.
- **PowerShell over SSH:** `powershell -NoProfile -EncodedCommand <utf16le-b64>` (the VM's SSH shell is `cmd`).
- **Commits:** each task ends with a commit step. Follow the user's standing rule: leave changes uncommitted until the
  user asks for commits, then commit per task with the message given and the session's attribution trailers.
- **mac/Linux:** every Windows branch is behind `process.platform === 'win32'` or an injected `platform`. The POSIX hook
  line is byte for byte what it is today, and `hook-installers.golden.json` is not re-recorded. The plugin templates
  are the one intended byte change on mac (Task B4.9). That re-record is stated in its commit.

### Task B4.1: Hook runners and `quoteHookCommand`

**Files**
- Modify: `cli/src/engines/kit/notifyHooks.ts:33-70` (`shellQuote`, `command`): add `HookRunner`, `quoteHookCommand`,
  `hookArgv`. `command` becomes `quoteHookCommand(runner, hookArgv(...))`.
- Modify: `cli/src/engines/kit/notifyHooks.spec.ts` (append).

**Interfaces**
- Consumes: `HookPreparationHeld` (`kit/nativeHookFiles.ts:10`).
- Produces (contract): `type HookRunner = 'argv' | 'bash' | 'cmd' | 'powershell'`,
  `quoteHookCommand(runner: HookRunner, argv: string[]): string | string[]`. Also
  `hookArgv(port, engine, codexHome?, hermesHome?, environment?): string[]`, and
  `command(port, engine, codexHome?, hermesHome?, environment?, runner: Exclude<HookRunner, 'argv'> = 'bash'): string`.
  Existing callers pass no `runner`, so the POSIX line is unchanged.

- [ ] **Step 1: Write the failing test.** Append to `cli/src/engines/kit/notifyHooks.spec.ts`, and change its first two
  lines to:

```ts
import { describe, expect, it } from 'vitest'
import { command, hookArgv, isManagedHookCommand, quoteHookCommand } from './notifyHooks.js'
import { HookPreparationHeld } from './nativeHookFiles.js'
```

```ts
describe('quoteHookCommand', () => {
  const argv = ['C:\\Program Files\\Harness\\node.exe', 'C:\\Users\\Thảo Nguyễn\\.harness\\cli\\notify.mjs',
    '--port', '18473', '--data-dir', 'C:\\Users\\Thảo Nguyễn\\.harness\\cli\\data', '--engine', 'codex']

  it('hands the list itself to a runner that starts the program (Claude Code exec form)', () => {
    expect(quoteHookCommand('argv', argv)).toEqual(argv)
  })

  it('quotes for bash as every POSIX release has: words bare, everything else single-quoted', () => {
    expect(quoteHookCommand('bash', ['/opt/n o/node', "/it's/notify.mjs", '--port', '19473', '--engine', 'codex']))
      .toBe("'/opt/n o/node' '/it'\\''s/notify.mjs' --port 19473 --engine codex")
  })

  it('quotes for cmd.exe with double quotes', () => {
    expect(quoteHookCommand('cmd', argv)).toBe('"C:\\Program Files\\Harness\\node.exe" "C:\\Users\\Thảo Nguyễn\\.harness\\cli\\notify.mjs"'
      + ' --port 18473 --data-dir "C:\\Users\\Thảo Nguyễn\\.harness\\cli\\data" --engine codex')
  })

  it('quotes for PowerShell with single quotes after the call operator', () => {
    expect(quoteHookCommand('powershell', ['C:\\a b\\node.exe', "C:\\O'Brien\\notify.mjs", '--port', '1']))
      .toBe("& 'C:\\a b\\node.exe' 'C:\\O''Brien\\notify.mjs' --port 1")
  })

  it.each([
    ['cmd', 'C:\\100%\\data'], ['cmd', 'C:\\wow!\\data'], ['cmd', 'C:\\a"b'], ['cmd', 'C:\\data\\'],
    ['powershell', 'C:\\a"b'], ['powershell', 'C:\\a\u2019b'],
    ['bash', 'line\nbreak'], ['argv', 'nul\0'],
  ] as const)('refuses what %s would read as something other than one argument: %j', (runner, value) => {
    expect(() => quoteHookCommand(runner, ['C:\\node.exe', value])).toThrow(HookPreparationHeld)
  })

  it('builds the POSIX command line from the same argument list as before', () => {
    expect(command(19473, 'codex')).toBe(quoteHookCommand('bash', hookArgv(19473, 'codex')))
    expect(hookArgv(19473, 'codex').slice(2, 4)).toEqual(['--port', '19473'])
    expect(hookArgv(19473, 'codex').slice(-2)).toEqual(['--engine', 'codex'])
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/notifyHooks.spec.ts`
  Expected: FAIL. TypeScript/vitest reports `quoteHookCommand` and `hookArgv` are not exported.

- [ ] **Step 3: Implement.** In `cli/src/engines/kit/notifyHooks.ts`, replace lines 33-70 (from `function shellQuote`
  through the end of `command`) with:

```ts
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What runs an engine's hook command. Each engine declares it for Windows (facets/hooks.ts `HookSettings.win32Runner`,
 * nativeHookSettings.ts `NativeHookSettings.win32Runner`). Off Windows every engine runs its hooks in a POSIX shell (`bash`).
 * - `argv`: the engine starts the program with its arguments and no shell (Claude Code's exec form, `command` + `args`).
 * - `bash`: a POSIX shell reads the line.
 * - `cmd`: `cmd.exe /C` reads it (Codex 0.162 runs `%COMSPEC% /C "<line>"`; Command Code runs it through Node's `shell: true`).
 * - `powershell`: PowerShell reads it (Copilot CLI's `command` fills its `powershell` field on Windows).
 */
export type HookRunner = 'argv' | 'bash' | 'cmd' | 'powershell'

const BARE_WORD = /^[A-Za-z0-9_-]+$/
const refuse = (reason: string): never => { throw new HookPreparationHeld(`a hook argument ${reason}`) }

/**
 * [argv] as [runner] takes it: the list itself for `argv`; for the others, one line that [runner] splits back into
 * exactly these arguments. Words (`--port`, `18473`, `codex`) stay bare and everything else is quoted, so the POSIX
 * line is byte for byte what every release wrote. An argument a runner would read as anything but itself is refused,
 * never escaped. The line holds only Harness's own paths and flags, so a path with such a character holds the hook
 * install with a reason.
 */
export function quoteHookCommand(runner: HookRunner, argv: string[]): string | string[] {
  if (!argv.length) refuse('list is empty')
  for (const arg of argv) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) refuse('holds a line break or NUL, which no hook runner passes whole')
  }
  switch (runner) {
    case 'argv': return [...argv]
    case 'bash': return argv.map((arg) => BARE_WORD.test(arg) ? arg : shellQuote(arg)).join(' ')
    case 'cmd': return argv.map((arg) => {
      // cmd.exe expands %…% (and !…! with delayed expansion) even inside quotes, and a quote ends them. A trailing
      // backslash would escape the closing quote for the program's own parser (CommandLineToArgvW's rules).
      if (/["%!]/.test(arg)) refuse('holds " % or !, which cmd.exe reads inside quotes')
      if (arg.endsWith('\\')) refuse('ends in a backslash, which would escape its closing quote')
      return BARE_WORD.test(arg) ? arg : `"${arg}"`
    }).join(' ')
    case 'powershell': return `& ${argv.map((arg) => {
      // Inside single quotes PowerShell reads only a quote, typographic ones too. Windows PowerShell 5.1 passes a
      // double quote inside an argument to a native program unescaped.
      if (/["\u2018\u2019\u201a\u201b]/.test(arg)) refuse('holds a double or typographic quote, which PowerShell passes on differently')
      return BARE_WORD.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
    }).join(' ')}`
  }
}

type NotifyEngine = 'claude' | 'codex' | 'cursor' | 'hermes' | 'commandcode' | 'devin' | 'grok' | 'agy' | 'copilot'

/** notify.mjs's argument list for [engine]: the managed Node, the script, and Harness's own flags. No user input. */
export function hookArgv(
  port: number,
  engine: NotifyEngine,
  // Only ever non-default for 'codex': a per-agent CODEX_HOME profile gets its OWN hooks.json, and
  // that file's baked --codex-home must match where it actually lives (see installCodexHooks).
  codexHome: string = env.CODEX_HOME,
  // Same rule for Hermes, and it was broken the same way: a `hermes -p <name>` profile has its own
  // config.yaml, and the block in it carried the DEFAULT home — so the hook looked the session up in
  // a store it was not in (openharness#191). See installHermesHooks.
  hermesHome: string = env.HERMES_HOME,
  environment?: Readonly<Record<string, string>>,
): string[] {
  const homes = environment ? nativeHookLocations(environment) : { ...env, CURSOR_HOME: cursorDataDir() }
  return [
    // Absolute, never the bare word `node`. This string is executed later by the ENGINE, in a shell
    // whose PATH is none of our business — and since the product ships its own Node, a computer with
    // no `node` on PATH is normal. See managedNodePath(); a changed interpreter is picked up by the
    // same drift comparison each installer already does for a changed path or port.
    managedNodePath(),
    HOOK_SCRIPT,
    '--port', String(port),
    '--data-dir', env.ADAPTER_DATA_DIR,
    '--claude-projects-dir', homes.CLAUDE_PROJECTS_DIR,
    '--codex-home', environment ? homes.CODEX_HOME : codexHome,
    '--grok-home', homes.GROK_HOME,
    '--cursor-home', homes.CURSOR_HOME,
    '--hermes-home', environment ? homes.HERMES_HOME : hermesHome,
    '--commandcode-home', homes.COMMANDCODE_HOME,
    '--devin-home', homes.DEVIN_HOME,
    '--agy-home', homes.AGY_HOME,
    '--copilot-home', homes.COPILOT_HOME,
    ...(engine !== 'claude' ? ['--engine', engine] : []),
  ]
}

/** The hook line for a shell runner: POSIX `bash` everywhere but Windows, where the caller names its engine's runner. */
export function command(
  port: number,
  engine: NotifyEngine,
  codexHome: string = env.CODEX_HOME,
  hermesHome: string = env.HERMES_HOME,
  environment?: Readonly<Record<string, string>>,
  runner: Exclude<HookRunner, 'argv'> = 'bash',
): string {
  return quoteHookCommand(runner, hookArgv(port, engine, codexHome, hermesHome, environment)) as string
}
```

- [ ] **Step 4: Run it and see it pass, with the POSIX goldens unchanged.**
  `cd cli && npx vitest run src/engines/kit/notifyHooks.spec.ts src/engines/hookInstallers.golden.spec.ts src/engines/otherHooks.golden.spec.ts src/engines/kit/hookSettings.spec.ts`
  Expected: PASS, and neither golden asks to be recorded. A golden diff here means the `bash` quoting changed bytes.
  Fix the quoting, not the fixture.

- [ ] **Step 5: Commit.**
  `git add cli/src/engines/kit/notifyHooks.ts cli/src/engines/kit/notifyHooks.spec.ts`
  `git commit -m "feat(hooks): quote a hook line for the runner that reads it"`

### Task B4.2: Recognize the hooks Harness writes on Windows

**Files**
- Modify: `cli/src/engines/kit/notifyHooks.ts:22-31` (`CommandHook` gains `args?`, and is exported) and `:72-114`
  (`isManagedHookCommand`, `isOurs`). The literal parser is split into `posixWords` and `managedArgs`. Add
  `windowsWords` and `isManagedHook`.
- Modify: `cli/src/engines/kit/notifyHooks.spec.ts` (append).

**Interfaces**
- Consumes: `quoteHookCommand` (B4.1).
- Produces: `isManagedHookCommand(value: unknown, platform?: NodeJS.Platform): boolean`. It also accepts the `cmd` and
  `powershell` lines, on win32 only.
  `isManagedHook(hook: { command?: unknown; args?: unknown } | null | undefined, platform?): boolean` also accepts exec
  form (`command` + `args`), on win32 only.
  `isOurs(block)` uses `isManagedHook`. On mac/Linux every input gets the answer it gets today.

- [ ] **Step 1: Write the failing test.** Append to `cli/src/engines/kit/notifyHooks.spec.ts`, and add `isManagedHook,
  isOurs` to its import from `./notifyHooks.js`:

```ts
describe('the hooks Harness writes on Windows', () => {
  const cmdLine = '"C:\\Program Files\\Harness\\node.exe" "C:\\Users\\u\\.harness\\cli\\notify.mjs" --port 18473'
    + ' --data-dir "C:\\Users\\u\\.harness\\cli\\data" --engine codex'
  const psLine = "& 'C:\\Users\\u\\.harness\\runtime\\node\\node.exe' 'C:\\Users\\u\\.harness\\cli\\notify.mjs' --port 18473"
    + " --data-dir 'C:\\Users\\u\\.harness\\cli\\data' --engine copilot --copilot-event sessionStart"

  it('recognizes its cmd.exe and PowerShell lines on Windows only', () => {
    expect(isManagedHookCommand(cmdLine, 'win32')).toBe(true)
    expect(isManagedHookCommand(psLine, 'win32')).toBe(true)
    expect(isManagedHookCommand(cmdLine, 'darwin')).toBe(false)
    expect(isManagedHookCommand(psLine, 'linux')).toBe(false)
  })

  it('recognizes every line quoteHookCommand writes', () => {
    const argv = ["C:\\O'Brien & co\\node.exe", 'C:\\h (x)\\notify.mjs', '--port', '1', '--data-dir', 'C:\\h\\data', '--engine', 'commandcode']
    expect(isManagedHookCommand(quoteHookCommand('cmd', argv), 'win32')).toBe(true)
    expect(isManagedHookCommand(quoteHookCommand('powershell', argv), 'win32')).toBe(true)
  })

  it.each([
    cmdLine + ' & calc',
    cmdLine.replace('--port 18473', '--port %PORT%'),
    '"C:\\tools\\other.exe" "C:\\Users\\u\\notify.mjs" --port 1 --data-dir "C:\\d"',
    '"C:\\node.exe" "relative\\notify.mjs" --port 1 --data-dir "C:\\d"',
    psLine + '; Remove-Item C:\\',
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir $env:TEMP",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' --data-dir 'C:\\e'",
  ])('claims no other Windows line: %s', (line) => {
    expect(isManagedHookCommand(line, 'win32')).toBe(false)
  })

  it('recognizes Claude Code exec form (command and args) on Windows only', () => {
    const hook = { type: 'command', command: 'C:\\h\\node.exe', args: ['C:\\h\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\h\\data'] }
    expect(isManagedHook(hook, 'win32')).toBe(true)
    expect(isManagedHook({ ...hook, args: [...hook.args, '--evil'] }, 'win32')).toBe(false)
    expect(isManagedHook({ ...hook, args: 'C:\\h\\notify.mjs' }, 'win32')).toBe(false)
    expect(isManagedHook(hook, 'darwin')).toBe(false)
    expect(isOurs({ hooks: [hook] })).toBe(process.platform === 'win32')
  })

  it('answers a POSIX hook as before, on every platform', () => {
    const line = "'/fixture/node' '/fixture/notify.mjs' --data-dir '/fixture/harness' --port 19473 --engine codex"
    expect(isManagedHookCommand(line, 'darwin')).toBe(true)
    expect(isManagedHook({ type: 'command', command: line }, 'linux')).toBe(true)
    // An `args` beside a POSIX line is ignored off Windows, as it always was.
    expect(isManagedHook({ type: 'command', command: line, args: ['x'] }, 'darwin')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/notifyHooks.spec.ts`
  Expected: FAIL. `isManagedHook` is not exported, and the `win32` cases answer `false`.

- [ ] **Step 3: Implement.** In `notifyHooks.ts`, change the path import (line 3) to
  `import { basename, dirname, isAbsolute, join, win32 } from 'node:path'`. Replace lines 22-26 with:

```ts
export interface CommandHook {
  type: string
  command: string
  /** Exec form: the program in `command`, these its arguments, no shell (Claude Code on Windows, B4.6). */
  args?: string[]
  timeout?: number
}
```

  Replace lines 72-114 (from the `isManagedHookCommand` comment through `isOurs`) with:

```ts
/** The words of a POSIX shell line as `sh` splits it; null for anything but literal words. */
function posixWords(value: string): string[] | null {
  const args: string[] = []
  let word = '', active = false, quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) { quote = ''; continue }
      if (quote === '"' && /[$`\\]/.test(char)) return null
      word += char; continue
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === '\\') {
      if (++index === value.length || /[\r\n]/.test(value[index])) return null
      word += value[index]; active = true; continue
    }
    if (/[\r\n]/.test(char)) return null
    if (/[ \t]/.test(char)) { if (active) { args.push(word); word = ''; active = false }; continue }
    if (/[;&|<>$`(){}*?\[\]~#]/.test(char)) return null
    word += char; active = true
  }
  if (quote) return null
  if (active) args.push(word)
  return args
}

const CMD_WORD = /"([^"%!]*)"|([A-Za-z0-9_-]+)/y
const POWERSHELL_WORD = /'((?:[^'\u2018\u2019\u201a\u201b]|'')*)'|([A-Za-z0-9_-]+)/y

/** Words separated by one space, each matching [word] whole; null otherwise. */
function separatedWords(text: string, word: RegExp, unquote: (quoted: string) => string): string[] | null {
  const words: string[] = []
  let at = 0
  while (at < text.length) {
    if (words.length) { if (text[at] !== ' ') return null; at++ }
    word.lastIndex = at
    const match = word.exec(text)
    if (!match) return null
    words.push(match[1] !== undefined ? unquote(match[1]) : match[2])
    at = word.lastIndex
  }
  return words.length ? words : null
}

/** The words of a Windows hook line as quoteHookCommand writes it: cmd.exe's (`"…"`) or PowerShell's (`& '…'`). */
function windowsWords(value: string): string[] | null {
  if (/[\0\r\n]/.test(value)) return null
  if (value.startsWith('& ')) return separatedWords(value.slice(2), POWERSHELL_WORD, (quoted) => quoted.replace(/''/g, "'"))
  return separatedWords(value, CMD_WORD, (quoted) => quoted)
}

const LEGACY_SCRIPT = /\/\.harness\/cli\/(?:hook\/)?notify\.mjs$/
const NODE = /^(?:node|nodejs)(?:\.exe)?$/
const WINDOWS_NODE = /^(?:node|nodejs)(?:\.exe)?$/i
const NATIVE_PATH = { basename, isAbsolute }

/** Harness's protocol: a literal Node, an absolute notify.mjs, and only Harness's flags, each once. */
function managedArgs(args: string[], path: Pick<typeof win32, 'basename' | 'isAbsolute'>, node: RegExp, legacy: boolean): boolean {
  if (!node.test(path.basename(args[0] ?? '')) || !path.isAbsolute(args[1] ?? '') || path.basename(args[1] ?? '') !== 'notify.mjs') return false
  // The original positional protocol was installed only under Harness's own
  // CLI directory. Later commands identify the data root explicitly.
  if (legacy && args.length === 4 && LEGACY_SCRIPT.test(args[1])
    && /^\d+$/.test(args[2]) && /^(?:claude|codex)$/.test(args[3])) return true
  const flags = new Map<string, string>()
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!/^--(?:port|data-dir|claude-projects-dir|(?:codex|grok|cursor|hermes|commandcode|devin|agy|copilot)-home|engine|event|agy-event|copilot-event)$/.test(key)
      || value === undefined || flags.has(key)) return false
    flags.set(key, value)
  }
  return /^\d+$/.test(flags.get('--port') ?? '') && path.isAbsolute(flags.get('--data-dir') ?? '')
}

/** Accept only a literal Node invocation with Harness's protocol arguments.
 * A foreign script sharing the notify.mjs basename is not ours to remove. On Windows, the cmd.exe and PowerShell
 * lines quoteHookCommand writes are literal invocations too. */
export function isManagedHookCommand(value: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof value !== 'string' || value.length > 64 * 1024) return false
  const words = posixWords(value)
  if (words && managedArgs(words, NATIVE_PATH, NODE, true)) return true
  if (platform !== 'win32') return false
  const windows = windowsWords(value)
  return !!windows && managedArgs(windows, win32, WINDOWS_NODE, false)
}

/** One hook of an engine's settings: a line, or on Windows exec form (Claude Code's `command` + `args`). */
export function isManagedHook(hook: { command?: unknown; args?: unknown } | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!hook || typeof hook !== 'object') return false
  if (hook.args === undefined || platform !== 'win32') return isManagedHookCommand(hook.command, platform)
  return typeof hook.command === 'string' && Array.isArray(hook.args) && hook.args.length <= 64
    && hook.args.every((arg) => typeof arg === 'string' && !/[\0\r\n]/.test(arg))
    && managedArgs([hook.command, ...hook.args as string[]], win32, WINDOWS_NODE, false)
}

export function isOurs(block: HookBlock): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some(hook => isManagedHook(hook))
}
```

- [ ] **Step 4: Run it and see it pass, with every recognizer user unchanged.**
  `cd cli && npx vitest run src/engines/kit/notifyHooks.spec.ts src/engines/kit/hookReview.spec.ts src/engines/kit/nativeHookYaml.spec.ts src/engines/hookInstallers.golden.spec.ts src/engines/otherHooks.golden.spec.ts`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  `git add cli/src/engines/kit/notifyHooks.ts cli/src/engines/kit/notifyHooks.spec.ts`
  `git commit -m "feat(hooks): recognize the cmd.exe, PowerShell and exec-form hooks Harness writes on Windows"`

### Task B4.3: `NativePaths` walks Windows paths and refuses reparse points

This is the root cause of F9's "the configuration directory exceeds its path limit". `NativePaths.walk` splits only on
`/`. A path like `C:\Users\…` becomes the single component `\:\Users\…`, which `lstat` reports missing. Then
`directoryPath` (`nativeHookFiles.ts:61-72`) runs `dirname` up to `C:\` and stays there for 256 rounds.

**Files**
- Modify: `cli/src/engines/kit/nativePaths.ts`. Changes: line 4 (imports), `:36-38` (constructor), `:87-95`
  (`retainOutside`), `:97-132` (`walk`, which delegates to a new `walkWindows`), and `:136-146` (`within`).
- Create: `cli/src/engines/kit/nativePaths.windows.spec.ts`

**Interfaces**
- Consumes: nothing.
- Produces: `new NativePaths(budget, platform?: NodeJS.Platform)`. The default is `process.platform`; the existing 20
  call sites are unchanged. On win32 only drive-absolute paths (`C:\…`, either slash) are accepted. Components are
  joined with `\`, and the drive letter is upper-cased. A component Node reports as a symbolic link (a symlink, or a
  junction, which the VM probe confirmed Node reports as `isSymbolicLink()`) throws `IdentityReadUnavailable` with
  "reparse point". It is never followed.

- [ ] **Step 1: Write the failing test.** Create `cli/src/engines/kit/nativePaths.windows.spec.ts`:

```ts
// NativePaths on Windows paths, on any OS: the file system is a fixture of what Node's lstat answers on NTFS
// (the Windows VM, 2026-10-16: files 0o100666, folders 0o40666, uid 0, a junction reported as a symbolic link).
import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityReadUnavailable } from './identityScan.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths } from './nativePaths.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>(), lstatSync: vi.fn(), readlinkSync: vi.fn() }))

type Kind = 'dir' | 'file' | 'link'
const tree = new Map<string, { kind: Kind; ino: number; target?: string }>([
  ['C:\\', { kind: 'dir', ino: 1 }],
  ['C:\\Users', { kind: 'dir', ino: 2 }],
  ['C:\\Users\\u', { kind: 'dir', ino: 3 }],
  ['C:\\Users\\u\\.claude', { kind: 'dir', ino: 4 }],
  ['C:\\Users\\u\\.claude\\settings.json', { kind: 'file', ino: 5 }],
  ['C:\\Users\\u\\dotfiles', { kind: 'link', ino: 6, target: 'D:\\dotfiles\\' }],
])
const stat = (kind: Kind, ino: number) => ({
  dev: 7n, ino: BigInt(ino), mode: kind === 'dir' ? 0o40666n : 0o100666n, uid: 0n, size: 0n, mtimeNs: 1n, ctimeNs: 1n,
  isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link',
})
beforeEach(() => {
  vi.mocked(fs.lstatSync).mockImplementation(((path: string) => {
    const node = tree.get(String(path))
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return stat(node.kind, node.ino)
  }) as never)
  vi.mocked(fs.readlinkSync).mockImplementation(((path: string) => tree.get(String(path))!.target!) as never)
})
afterEach(() => { vi.mocked(fs.lstatSync).mockReset(); vi.mocked(fs.readlinkSync).mockReset() })
const paths = () => new NativePaths(new NativeEvidenceBudget(), 'win32')

describe('NativePaths on Windows', () => {
  it('walks a drive path component by component from its root', () => {
    const walker = paths()
    expect(walker.resolveSync('C:\\Users\\u\\.claude\\settings.json')?.path).toBe('C:\\Users\\u\\.claude\\settings.json')
    expect(walker.snapshot().map((fact) => fact.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\u', 'C:\\Users\\u\\.claude', 'C:\\Users\\u\\.claude\\settings.json'])
  })

  it('reads a lower-case drive and forward slashes as the same path', () => {
    expect(paths().resolveSync('c:/Users/u/.claude/settings.json')?.path).toBe('C:\\Users\\u\\.claude\\settings.json')
  })

  it('reports a missing leaf as absent when absence is allowed', () => {
    const walker = paths()
    expect(walker.resolveSync('C:\\Users\\u\\.claude\\hooks.json', true)).toBeNull()
    expect(walker.absentLeaf('C:\\Users\\u\\.claude\\hooks.json')).toBe(true)
    expect(() => paths().resolveSync('C:\\Users\\u\\.claude\\hooks.json')).toThrow(IdentityReadUnavailable)
  })

  it('refuses a link or junction on the way instead of following it', () => {
    expect(() => paths().resolveSync('C:\\Users\\u\\dotfiles\\settings.json', true)).toThrow(/reparse point/)
    expect(fs.readlinkSync).toHaveBeenCalledTimes(1)
  })

  it.each(['\\\\server\\share\\settings.json', '\\\\?\\C:\\Users\\u', 'C:relative\\settings.json', '/Users/u/.claude'])(
    'refuses a path that is not on a drive: %s', (path) => {
      expect(() => paths().resolveSync(path, true)).toThrow(IdentityReadUnavailable)
    })

  it('stops a membership walk at the drive root', () => {
    const walker = paths()
    walker.resolveSync('C:\\Users\\u\\.claude\\settings.json')
    expect(walker.within('C:\\Users\\u\\.claude\\settings.json', [stat('dir', 99) as never])).toBe(false)
    expect(walker.within('C:\\Users\\u\\.claude\\settings.json', [stat('dir', 3) as never])).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/nativePaths.windows.spec.ts`
  Expected: FAIL. The constructor ignores `'win32'`, the walk asks `lstat` for `\:\Users…`, and the first test gets `null`.

- [ ] **Step 3: Implement.** In `nativePaths.ts`:

  Line 4: `import { dirname, isAbsolute, join, win32 } from 'node:path'`.

  Lines 36-38 (class head and constructor):

```ts
export class NativePaths {
  private readonly parts = new Map<string, Part>()
  constructor(private readonly budget: NativeEvidenceBudget, private readonly platform: NodeJS.Platform = process.platform) {}
```

  In `retainOutside` (lines 87-95), the filter and the fresh walker:

```ts
    const separator = this.platform === 'win32' ? '\\' : '/'
    const retained = [...this.parts].filter(([path]) => path !== removedPath && !path.startsWith(removedPath + separator))
    return () => {
      const fresh = new NativePaths(new NativeEvidenceBudget(), this.platform)
```

  At the top of `walk` (line 98, before the POSIX checks):

```ts
    if (this.platform === 'win32') return yield* this.walkWindows(path, missingOkay)
```

  After `walk` (after line 132), add:

```ts
  /**
   * A Windows path: drive-absolute only (`C:\…`), never a UNC share, a device path (`\\?\`, `\\.\`) or a drive-relative
   * one. NTFS gives Node no owner or mode bits to trust a hook file by. What protects it is the profile's ACL and the
   * route itself, so no step may be a reparse point: a symlink or a junction, both of which Node reports as a
   * symbolic link. One is refused, never followed (spec section 4). `..` is then lexical.
   */
  private *walkWindows(path: string, missingOkay: boolean): Generator<string, Location, Part> {
    if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) {
      return nativeUnavailable('a native location is invalid or exceeds its limit')
    }
    const steps = [`${path[0].toUpperCase()}:\\`]
    for (const part of path.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (steps.length > 256) return nativeUnavailable('the native path component limit was reached')
      if (part === '.') continue
      if (part === '..') { if (steps.length > 1) steps.pop(); continue }
      steps.push(win32.join(steps.at(-1)!, part))
    }
    let info: BigIntStats | null = null
    for (const [index, next] of steps.entries()) {
      this.budget.step()
      let proof = this.parts.get(next)
      if (!proof) {
        proof = yield next
        this.parts.set(next, proof)
      }
      info = proof.info
      if (!info) return missingOkay ? null : nativeUnavailable('a native location is missing')
      if (proof.target !== undefined) return nativeUnavailable('a native location on Windows is a reparse point (a link or junction), which Harness does not follow')
      if (index < steps.length - 1 && !info.isDirectory()) return nativeUnavailable('a native path ancestor is not a directory')
    }
    this.budget.step()
    return { path: steps.at(-1)!, info: info! }
  }
```

  In `within` (lines 136-146), the loop's root test and parent step:

```ts
  within(path: string, roots: readonly BigIntStats[]): boolean {
    const keys = new Set(roots.map(nativeFileKey))
    const parentOf = this.platform === 'win32' ? win32.dirname : dirname
    for (let parent = parentOf(path);;) {
      this.budget.step()
      const part = this.parts.get(parent)
      if (part?.info && !part.target && part.info.isDirectory() && keys.has(nativeFileKey(part.info))) return true
      // The root (`/`, or a drive's `C:\`) is its own parent.
      if (parentOf(parent) === parent) return false
      if (!part?.info || part.target !== undefined || !part.info.isDirectory()) return nativeUnavailable('the native directory ancestry is incomplete')
      parent = parentOf(parent)
    }
  }
```

- [ ] **Step 4: Run it and the other NativePaths users.**
  `cd cli && npx vitest run src/engines/kit/nativePaths.windows.spec.ts src/engines/kit src/engines/nativeLaunchLocations.spec.ts src/engines/nativeLaunch.spec.ts`
  Expected: PASS. A failure outside the new file is a POSIX regression. Compare it with a clean `origin/main` worktree
  before you blame this task (the known `exactTranscript.spec.ts` reds are pre-existing).

- [ ] **Step 5: Commit.**
  `git add cli/src/engines/kit/nativePaths.ts cli/src/engines/kit/nativePaths.windows.spec.ts`
  `git commit -m "fix(hooks): walk Windows paths from their drive and refuse reparse points"`

### Task B4.4: `nativeHookFiles` on Windows: unchanged-file flush, rename over a held file, the drive root

The VM probe (Node 24, NTFS, 2026-10-16) gave these results:
- `fsync` on a read-only fd is `EPERM`; on an `O_RDWR` fd it works.
- `fsync` on a directory fd is `EPERM`.
- `rename` onto a file another process holds open is `EPERM`.
- `link` works.
- `fs.constants.O_NOFOLLOW`, `O_DIRECTORY` and `O_NONBLOCK` are undefined, so they OR as 0.

**Files**
- Create: `cli/src/engines/kit/windowsFiles.ts`
- Create: `cli/src/engines/kit/windowsFiles.spec.ts`
- Modify: `cli/src/engines/kit/nativeHookFiles.ts`:
  - `:37-44`: `syncDirectoryChain` stops at any root.
  - `:140-152`: the equal-content flush.
  - `:181`: `renameSync` becomes `await renameReplacing`.

**Interfaces**
- Consumes: nothing.
- Produces:
  - `renameReplacing(from: string, to: string, deps?: RenameDeps): Promise<void>`.
  - `unchangedFlushFlags(mode: number, platform?): number | null`.
  - `journalFlushFlags(platform?): number`. B4.5 uses this one.

- [ ] **Step 1: Write the failing test.** Create `cli/src/engines/kit/windowsFiles.spec.ts`:

```ts
import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { journalFlushFlags, renameReplacing, unchangedFlushFlags } from './windowsFiles.js'

const held = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

describe('renameReplacing', () => {
  it('retries a Windows rename onto a file another process has open, then lands', async () => {
    let calls = 0
    const rename = vi.fn(() => { if (++calls < 3) throw held() })
    const waits: number[] = []
    await renameReplacing('a.tmp', 'settings.json', { platform: 'win32', rename, wait: async (ms) => { waits.push(ms) } })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([25, 50])
  })

  it('gives up after its attempts with the last error', async () => {
    const rename = vi.fn(() => { throw held() })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {}, attempts: 4 })).rejects.toMatchObject({ code: 'EPERM' })
    expect(rename).toHaveBeenCalledTimes(4)
  })

  it('never retries off Windows, or for an error a held file does not cause', async () => {
    const posix = vi.fn(() => { throw held() })
    await expect(renameReplacing('a', 'b', { platform: 'darwin', rename: posix, wait: async () => {} })).rejects.toMatchObject({ code: 'EPERM' })
    expect(posix).toHaveBeenCalledTimes(1)
    const missing = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename: missing, wait: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('asks its owner before each retry', async () => {
    const rename = vi.fn(() => { throw held() })
    const check = vi.fn(() => { throw new Error('the preparation expired') })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {}, check })).rejects.toThrow('the preparation expired')
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('flush flags', () => {
  it('reopens an unchanged file read-write on Windows, where only a writable handle flushes', () => {
    expect(unchangedFlushFlags(0o666, 'win32')).toBe(constants.O_RDWR)
    expect(unchangedFlushFlags(0o444, 'win32')).toBeNull()
    expect(journalFlushFlags('win32')).toBe(constants.O_RDWR)
  })

  it('keeps the POSIX read-only, no-follow open', () => {
    const posix = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    expect(unchangedFlushFlags(0o644, 'darwin')).toBe(posix)
    expect(unchangedFlushFlags(0o444, 'linux')).toBe(posix)
    expect(journalFlushFlags('darwin')).toBe(posix)
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/windowsFiles.spec.ts`
  Expected: FAIL with `Failed to resolve import "./windowsFiles.js"`.

- [ ] **Step 3: Implement.** Create `cli/src/engines/kit/windowsFiles.ts`:

```ts
/**
 * What the hook file writers (nativeHookFiles.ts, homeAdoption.ts) do differently on Windows, as measured on the Windows
 * VM (Node 24, NTFS, 2026-10-16): fsync on a read-only handle is EPERM (FlushFileBuffers needs a writable one), and a
 * rename onto a file another process has open is EPERM until that process lets go (an engine reading its settings).
 */
import { constants, renameSync } from 'node:fs'

const HELD = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface RenameDeps {
  platform?: NodeJS.Platform
  rename?: (from: string, to: string) => void
  wait?: (ms: number) => Promise<void>
  /** Tries in all, the first included. */
  attempts?: number
  /** The writer's owner still authorizes another try (HookPreparationAttempt.check). */
  check?: () => void
}

/** [from] renamed over [to]. On Windows a held target is tried again, 25 ms more each time (0.7 s for 8 tries). */
export async function renameReplacing(from: string, to: string, deps: RenameDeps = {}): Promise<void> {
  const { platform = process.platform, rename = renameSync, attempts = 8, check } = deps
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  for (let tried = 1; ; tried++) {
    try { rename(from, to); return } catch (error) {
      if (platform !== 'win32' || tried >= attempts || !HELD.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      check?.()
      await wait(25 * tried)
    }
  }
}

const POSIX_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * The flags to reopen an unchanged settings file for its flush. On Windows it is opened read-write, which neither
 * writes nor truncates it. A read-only file there is not reopened (null): it is not one Harness can write, and its
 * bytes are already what Harness wants.
 */
export function unchangedFlushFlags(mode: number, platform: NodeJS.Platform = process.platform): number | null {
  if (platform !== 'win32') return POSIX_READ
  return (mode & 0o200) === 0 ? null : constants.O_RDWR
}

/** The flags to reopen a journal record Harness wrote itself, for its flush: read-write on Windows. */
export function journalFlushFlags(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? constants.O_RDWR : POSIX_READ
}
```

  In `cli/src/engines/kit/nativeHookFiles.ts`:
  - Add `import { renameReplacing, unchangedFlushFlags } from './windowsFiles.js'` after line 8. Remove `renameSync`
    from the line-4 import.
  - Lines 39-40 (`syncDirectoryChain`):

```ts
    attempt.check(); await syncDirectory(path, attempt)
    // The root (`/`, or a drive's `C:\`) is its own parent. Compared with `/` alone, Windows never ended (F9).
    if (dirname(path) === path) return
```

  - Lines 140-152 (the `content === next` branch of `replace`):

```ts
      if (content === next) {
        // A previous rename may have succeeded before directory sync failed.
        // Equality alone cannot turn that uncertainty into a durable success.
        const flags = unchangedFlushFlags(mode)
        if (flags !== null) {
          const fd = openSync(target, flags)
          try {
            if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed before sync')
            await attempt.flush(fd)
            if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed during sync')
          } finally { closeSync(fd) }
        }
        await syncDirectoryChain(dirname(target), attempt)
        verify()
        return { verify }
      }
```

  - Line 181: `else await renameReplacing(temporary, actual, { check: attempt.check })`.

- [ ] **Step 4: Run it and see it pass, with the writer's own suite.**
  `cd cli && npx vitest run src/engines/kit/windowsFiles.spec.ts src/engines/kit/nativeHookFiles.spec.ts src/engines/nativeHookPreparation.spec.ts src/engines/hookInstallers.golden.spec.ts`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  `git add cli/src/engines/kit/windowsFiles.ts cli/src/engines/kit/windowsFiles.spec.ts cli/src/engines/kit/nativeHookFiles.ts`
  `git commit -m "fix(hooks): write settings on Windows: flush through a writable handle, retry a held rename, stop at the drive root"`

### Task B4.5: The engine-home adoption journal on Windows

On NTFS every file reads `0o100666` and every folder `0o40666`, with uid 0. `inspect` (`homeAdoption.ts:28-32`) refuses
all of them ("unsafe owner, type or write permission"). `merge`/`parse` (`:69`, `:99`) take only `/`-rooted homes, and
`seal` flushes a read-only fd (`:248-252`), which is EPERM.

**Files**
- Modify: `cli/src/engines/kit/homeAdoption.ts`:
  - `:28-32`: `inspect`, exported for its test as `inspectJournalEntry`.
  - `:69` and `:99`: `homeIsAbsolute`.
  - `:248`: `journalFlushFlags`.
- Modify: `cli/src/engines/kit/homeAdoption.spec.ts` (append one `describe`).

**Interfaces**
- Consumes: `journalFlushFlags` (B4.4).
- Produces:
  - `homeIsAbsolute(home: string, platform?: NodeJS.Platform): boolean`. POSIX: it starts with `/`. Windows: it starts
    with `X:\`.
  - `inspectJournalEntry(info: BigIntStats, directory?: boolean, platform?: NodeJS.Platform): void`. On win32 it checks
    the type only. A link or junction is neither file nor folder to `lstat`, so it is still refused.

- [ ] **Step 1: Write the failing test.** Append to `cli/src/engines/kit/homeAdoption.spec.ts`, and add `homeIsAbsolute,
  inspectJournalEntry` to its import from `./homeAdoption.js`:

```ts
describe('the adoption journal on Windows', () => {
  const ntfs = (kind: 'file' | 'dir' | 'link') => ({
    dev: 1n, ino: 2n, uid: 0n, size: 10n, mtimeNs: 1n, ctimeNs: 1n, mode: kind === 'dir' ? 0o40666n : 0o100666n,
    isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link',
  }) as unknown as fs.BigIntStats

  it('trusts a file and folder NTFS reports with no owner and every write bit, on Windows only', () => {
    expect(() => inspectJournalEntry(ntfs('file'), false, 'win32')).not.toThrow()
    expect(() => inspectJournalEntry(ntfs('dir'), true, 'win32')).not.toThrow()
    expect(() => inspectJournalEntry(ntfs('file'), false, 'linux')).toThrow(/unsafe owner, type or write permission/)
  })

  it('still refuses a link or junction on Windows', () => {
    expect(() => inspectJournalEntry(ntfs('link'), false, 'win32')).toThrow(/unsafe owner, type or write permission/)
    expect(() => inspectJournalEntry(ntfs('link'), true, 'win32')).toThrow(/unsafe owner, type or write permission/)
  })

  it('takes a Windows home on Windows and a POSIX home elsewhere', () => {
    expect(homeIsAbsolute('C:\\Users\\u\\.claude-work', 'win32')).toBe(true)
    expect(homeIsAbsolute('c:/Users/u/.codex-2', 'win32')).toBe(true)
    expect(homeIsAbsolute('\\\\server\\share\\.claude', 'win32')).toBe(false)
    expect(homeIsAbsolute('/Users/u/.claude', 'win32')).toBe(false)
    expect(homeIsAbsolute('/Users/u/.claude', 'darwin')).toBe(true)
    expect(homeIsAbsolute('C:\\Users\\u\\.claude', 'linux')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/homeAdoption.spec.ts`
  Expected: FAIL. `inspectJournalEntry` and `homeIsAbsolute` are not exported.

- [ ] **Step 3: Implement.** In `homeAdoption.ts`:
  - Add `import { journalFlushFlags } from './windowsFiles.js'` after line 10.
  - Replace lines 28-32 with:

```ts
/**
 * A journal entry is a plain file or folder of this account's that no one else can write. Windows: NTFS gives Node no
 * owner (uid 0) and reports every file 0o100666 and folder 0o40666, so only the type is checked. The data folder's place in
 * the profile (secureState.ts `windowsStateRoots`) is what protects it there. A link or junction is neither to lstat,
 * so it is still refused.
 */
export function inspectJournalEntry(info: BigIntStats, directory = false, platform: NodeJS.Platform = process.platform): void {
  if (!(directory ? info.isDirectory() : info.isFile())) throw unavailable('has an unsafe owner, type or write permission')
  if (platform === 'win32') return
  if ((typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
    || (info.mode & 0o022n)) throw unavailable('has an unsafe owner, type or write permission')
}
const inspect = (info: BigIntStats, directory = false): void => inspectJournalEntry(info, directory)

/** A home folder as the catalog stores it: absolute, as this platform spells one. */
export function homeIsAbsolute(home: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(home) : home.startsWith('/')
}
```

  - Line 69 (in `merge`) and line 99 (in `parse`): replace `!home.startsWith('/')` with `!homeIsAbsolute(home)`.
  - Line 248 (in `seal`): `const fd = openSync(entry.path, journalFlushFlags())`.

- [ ] **Step 4: Run it, the process variant, and the adoption users.**
  `cd cli && npx vitest run src/engines/kit/homeAdoption.spec.ts src/engines/kit/homeAdoption.process.spec.ts src/core/engines src/lib/engineHomes.spec.ts`
  Expected: PASS. The existing journal tests run on the POSIX branch unchanged.

- [ ] **Step 5: Commit.**
  `git add cli/src/engines/kit/homeAdoption.ts cli/src/engines/kit/homeAdoption.spec.ts`
  `git commit -m "fix(hooks): keep the engine-home adoption journal on NTFS"`

### Task B4.6: Each engine's Windows runner, and the installers that use it

The runner for each engine on Windows is below. Each row was verified on 2026-10-16.

| Engine | win32 runner | Evidence |
|---|---|---|
| Claude Code | `argv` (exec form: `command` = `node.exe`, `args`) | `claude.exe` 2.1.300 on the VM holds the schema tip "For exec form (no shell), set `command` to the executable and `args` to its arguments". Docs: shell form runs Git Bash, or PowerShell when Git Bash is missing, so no one quoting serves both. |
| Codex | `cmd` | codex-rs `hooks/src/engine/command_runner.rs` at `rust-v0.162.1`: `%COMSPEC%` (fallback `cmd.exe`) `/C`, then `raw_arg("\"<line>\"")` |
| Copilot CLI | `powershell` | docs.github.com hooks reference: `command` is "copied to both `bash` and `powershell`"; on Windows the CLI uses `powershell` |
| Command Code | `cmd` | `command-code@1.82.3` `dist/cli.mjs`: `hookShell()` is undefined on win32, so `spawn(command, [], { shell: true })` runs `cmd.exe /d /s /c` |
| OpenCode, Kilo, Pi | none needed | in-process JS plugins (B4.9) |
| Cursor, Devin, Grok, agy, Hermes | not declared | not installable through Harness on Windows (`curl … \| bash` recipes) and runner unverified, so no hooks there |

**Files**
- Modify: `cli/src/engines/facets/hooks.ts:1,36-83`. Import the `HookRunner` type, and add `win32Runner?` to
  `HookSettings` after `commandNamesHome`.
- Modify: `cli/src/engines/claude/hookContract.ts:40` (`win32Runner: 'argv'`) and
  `cli/src/engines/codex/hookContract.ts:36` (`win32Runner: 'cmd'`).
- Modify: `cli/src/engines/kit/hookSettings.ts:16,28-47,174-229`. Add `notifyHookEntry`, write exec form, skip
  Messages/allowance on win32.
- Modify: `cli/src/engines/kit/nativeHookSettings.ts:1-17,32-33`. Add the `win32Runner` field and skip when it is absent.
- Modify: `cli/src/engines/copilot/contract.ts:33-51` (`"win32Runner": "powershell"`) and
  `cli/src/engines/commandcode/contract.ts:41-60` (`"win32Runner": "cmd"`).
- Modify: `cli/src/engines/nativeHooks.ts:37-39`. Hermes gets no hooks on win32.
- Modify: `cli/src/engines/kit/notifyHooks.ts:11-20`. `HOOK_SCRIPT` names the stable `cli\notify.mjs` in the Windows
  installed layout. Add `hookScriptCandidates`, `hooksNotOnWindows` and `identitySettings` (a hook preparation's
  identity stays byte for byte what it is today off Windows: no `win32Runner` in it).
- Create: `cli/src/engines/kit/windowsHooks.spec.ts`

**Interfaces**
- Consumes: `quoteHookCommand`, `hookArgv`, `HookRunner` (B4.1), `isOurs` (B4.2). From B1: `STABLE_NOTIFY`
  (`cli/src/lib/windows/installLayout.ts`). From A: `insideWindowsRoots` (`cli/src/lib/secureState.ts:41`).
- Produces:
  - `HookSettings.win32Runner?: HookRunner` and `NativeHookSettings.win32Runner?: Exclude<HookRunner, 'argv'>` (contract:
    declared per engine in the hook contracts).
  - `notifyHookEntry(settings: HookSettings, argv: string[], platform?): { command: string; args?: string[] } | null`.
  - `installNativeHookSettings(rule, port, options?, platform?)`.
  - `hookScriptCandidates(cliDir, script, platform?, cliRoot?): string[]`.
  - `hooksNotOnWindows(engine: string): true`. It logs `[hooks] <engine> hooks are not installed on Windows yet`.
  - `identitySettings(settings, platform?)`: the settings as a preparation's identity names them, without
    `win32Runner` off Windows.

- [ ] **Step 1: Write the failing test.** Create `cli/src/engines/kit/windowsHooks.spec.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGY_HOOK_SETTINGS } from '../agy/contract.js'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { COMMANDCODE_HOOK_SETTINGS } from '../commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from '../copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from '../cursor/contract.js'
import { DEVIN_HOOK_SETTINGS } from '../devin/contract.js'
import { GROK_HOOK_SETTINGS } from '../grok/contract.js'
import { notifyHookEntry } from './hookSettings.js'
import { installNativeHookSettings } from './nativeHookSettings.js'
import { hookScriptCandidates, identitySettings } from './notifyHooks.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const argv = ['C:\\h\\node.exe', 'C:\\h\\cli\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\h\\cli\\data']

describe('the hook each engine runs on Windows', () => {
  it('is declared for every engine whose hooks Harness installs there, and for no other', () => {
    expect(claude.settings.win32Runner).toBe('argv')
    expect(codex.settings.win32Runner).toBe('cmd')
    expect(COPILOT_HOOK_SETTINGS.win32Runner).toBe('powershell')
    expect(COMMANDCODE_HOOK_SETTINGS.win32Runner).toBe('cmd')
    for (const rule of [CURSOR_HOOK_SETTINGS, DEVIN_HOOK_SETTINGS, GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS]) expect('win32Runner' in rule).toBe(false)
  })

  it('writes Claude Code exec form on Windows: node.exe and its arguments, no shell', () => {
    expect(notifyHookEntry(claude.settings, argv, 'win32')).toEqual({ command: argv[0], args: argv.slice(1) })
  })

  it('writes Codex a line cmd.exe reads', () => {
    expect(notifyHookEntry(codex.settings, argv, 'win32'))
      .toEqual({ command: '"C:\\h\\node.exe" "C:\\h\\cli\\notify.mjs" --port 18473 --data-dir "C:\\h\\cli\\data"' })
  })

  it('keeps the POSIX line for both off Windows', () => {
    const posix = ['/h/node', '/h/notify.mjs', '--port', '1']
    expect(notifyHookEntry(claude.settings, posix, 'darwin')).toEqual({ command: "'/h/node' '/h/notify.mjs' --port 1" })
    expect(notifyHookEntry(codex.settings, posix, 'linux')).toEqual({ command: "'/h/node' '/h/notify.mjs' --port 1" })
  })

  it('installs nothing for an engine with no Windows runner, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installNativeHookSettings({ ...GROK_HOOK_SETTINGS, file: join(dir, 'grok', 'hooks', 'harness.json') }, 19473, {}, 'win32')).toBe(true)
    expect(existsSync(join(dir, 'grok'))).toBe(false)
    expect(log).toHaveBeenCalledWith('[hooks] grok hooks are not installed on Windows yet')
  })
})

describe('a hook preparation\'s identity', () => {
  // installHookSettings and installNativeHookSettings name a preparation by JSON.stringify of the settings, among
  // others. Off Windows that string must be byte for byte what it was before win32Runner existed (mac/Linux unchanged).
  it('is the settings without win32Runner off Windows, byte for byte, and the whole declaration on Windows', () => {
    const { win32Runner: _claude, ...claudeBefore } = claude.settings
    const { win32Runner: _copilot, ...copilotBefore } = COPILOT_HOOK_SETTINGS
    expect(JSON.stringify(identitySettings(claude.settings, 'darwin'))).toBe(JSON.stringify(claudeBefore))
    expect(JSON.stringify(identitySettings(codex.settings, 'linux'))).not.toContain('win32Runner')
    expect(JSON.stringify(identitySettings(COPILOT_HOOK_SETTINGS, 'darwin'))).toBe(JSON.stringify(copilotBefore))
    expect(JSON.stringify(identitySettings(CURSOR_HOOK_SETTINGS, 'darwin'))).toBe(JSON.stringify(CURSOR_HOOK_SETTINGS))
    expect(identitySettings(COPILOT_HOOK_SETTINGS, 'win32')).toBe(COPILOT_HOOK_SETTINGS)
    expect(JSON.stringify(identitySettings(claude.settings, 'win32'))).toContain('"win32Runner":"argv"')
  })
})

describe('the notify.mjs a hook line names', () => {
  const root = 'C:\\Users\\u\\.harness\\cli'
  it('is the stable cli\\notify.mjs when the CLI runs from its Windows install', () => {
    expect(hookScriptCandidates(`${root}\\0.5.0`, `${root}\\0.5.0\\cli.js`, 'win32', root)[0]).toBe(`${root}\\notify.mjs`)
  })
  it('is the sibling for a CLI run from anywhere else, and always off Windows', () => {
    expect(hookScriptCandidates('C:\\work\\e2e\\dist', 'C:\\work\\e2e\\dist\\cli.js', 'win32', root)[0]).toBe(join('C:\\work\\e2e\\dist', 'notify.mjs'))
    expect(hookScriptCandidates('/Users/u/.harness/cli', '/Users/u/.harness/cli/cli.js', 'darwin', '/Users/u/.harness/cli'))
      .toEqual(['/Users/u/.harness/cli/notify.mjs', '/Users/u/.harness/cli/notify.mjs', join('/Users/u/.harness/cli', '..', '..', '..', 'hook', 'notify.mjs')])
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/kit/windowsHooks.spec.ts`
  Expected: FAIL. `notifyHookEntry` and `hookScriptCandidates` are not exported, and `win32Runner` is undefined.

- [ ] **Step 3: Implement.**

  `cli/src/engines/facets/hooks.ts`: add `import type { HookRunner } from '../kit/notifyHooks.js'` after line 4. After
  `commandNamesHome: boolean` (line 54) add:

```ts
  /**
   * What runs this engine's hooks on Windows (kit/notifyHooks.ts `HookRunner`), as its own source or docs say. Absent:
   * Harness installs no hooks for it there. Off Windows every engine's hooks run in a POSIX shell.
   */
  win32Runner?: HookRunner
```

  `cli/src/engines/claude/hookContract.ts`: after `commandNamesHome: false,` (line 40) add:

```ts
    // Windows: exec form, `command` (the managed node.exe) and `args`, run without a shell. In shell form Claude Code runs
    // Git Bash, or PowerShell when Git Bash is missing, and no one quoting serves both. Claude Code 2.1.300's schema
    // tip says: "For exec form (no shell), set `command` to the executable and `args` to its arguments".
    win32Runner: 'argv',
```

  `cli/src/engines/codex/hookContract.ts`: after `commandNamesHome: true,` (line 36) add:

```ts
    // Windows: `%COMSPEC% /C "<line>"`, the line given verbatim (codex-rs hooks/src/engine/command_runner.rs `build_command`,
    // rust-v0.162.1). `commandWindows` would override `command` there; Harness writes `command`, quoted for cmd.exe.
    win32Runner: 'cmd',
```

  `cli/src/engines/kit/notifyHooks.ts`. Add these imports:
  - `import { insideWindowsRoots } from '../../lib/secureState.js'`.
  - `import { STABLE_NOTIFY } from '../../lib/windows/installLayout.js'`.

  Replace lines 17-20 with:

```ts
const cliDir = dirname(fileURLToPath(import.meta.url))

/**
 * Where notify.mjs is, best first. Windows' installed layout (lib/windows/installLayout.ts) keeps one CLI folder per
 * version, with a stable `cli\notify.mjs` beside them that the updater refreshes. The hook lines name that one, so
 * they do not change at each update, and Codex does not ask to review them again.
 */
export function hookScriptCandidates(dir: string, script: string | undefined, platform: NodeJS.Platform = process.platform,
  cliRoot: string = env.ADAPTER_CLI_DIR): string[] {
  const stable = platform === 'win32' && insideWindowsRoots(dir, [cliRoot]) ? [win32.join(cliRoot, STABLE_NOTIFY)] : []
  return [...stable, join(dir, 'notify.mjs'), ...(script ? [join(dirname(script), 'notify.mjs')] : []), join(dir, '..', '..', '..', 'hook', 'notify.mjs')]
}
export const HOOK_SCRIPT = hookScriptCandidates(cliDir, process.argv[1]).find(existsSync) ?? join(cliDir, '..', '..', '..', 'hook', 'notify.mjs')

/** An engine that declares no Windows hook runner gets no hooks there. That is said once per install and is not a failure. */
export function hooksNotOnWindows(engine: string): true {
  console.log(`[hooks] ${engine} hooks are not installed on Windows yet`)
  return true
}

/**
 * A hook rule as a preparation's identity names it (`runHookPreparation`'s `identity`: a refresh and a launch with
 * the same one share a preparation). Off Windows `win32Runner` is left out, so the identity is byte for byte what it
 * was before Windows hooks: mac and Linux do not change. The other keys keep their order.
 */
export function identitySettings<T extends { win32Runner?: unknown }>(settings: T, platform: NodeJS.Platform = process.platform): T | Omit<T, 'win32Runner'> {
  if (platform === 'win32') return settings
  const { win32Runner: _runner, ...rest } = settings
  return rest
}
```

  `cli/src/engines/kit/hookSettings.ts`:
  - Line 16 becomes
    `import { HOOK_SCRIPT, hookArgv, hooksNotOnWindows, identitySettings, isOurs, foreignHookBlocks, quoteHookCommand, type CommandHook, type Settings } from './notifyHooks.js'`.
    Off Windows `entry.command` is the POSIX line `command(...)` gave before (B4.1), and `identitySettings` drops
    `win32Runner`, so the identity string is unchanged there.
  - Line 21 becomes `export type HookEngine = Parameters<typeof hookArgv>[1]`.
  - Replace lines 28-47 (`installHookSettings`) with:

```ts
/**
 * The hook of ours that [settings]' engine runs, as its runner on [platform] takes [argv]. That is one line, or, for an
 * engine that starts a program itself (Claude Code's exec form on Windows), the program and its `args`. Null on
 * Windows for an engine that declares no runner there.
 */
export function notifyHookEntry(settings: HookSettings, argv: string[], platform: NodeJS.Platform = process.platform): { command: string; args?: string[] } | null {
  const runner = platform === 'win32' ? settings.win32Runner : 'bash'
  if (!runner) return null
  const quoted = quoteHookCommand(runner, argv)
  return Array.isArray(quoted) ? { command: quoted[0], args: quoted.slice(1) } : { command: quoted }
}

export async function installHookSettings(engine: HookEngine, settings: HookSettings, port: number, home: string = defaultHookHome(settings), options: NativeHookOptions = {}): Promise<boolean> {
  const files = [join(home, settings.file), ...(settings.reviewed ? [join(home, settings.reviewed.file)] : [])]
  const entry = notifyHookEntry(settings, hookArgv(port, engine, settings.commandNamesHome ? home : undefined, undefined, options.environment))
  if (!entry) return hooksNotOnWindows(engine)
  // A startup refresh and a launch share the entire installation. Releasing the
  // reservation between notify and Messages let each revoke the other's second
  // stage, so a healthy launch could be held by the daemon's own refresh.
  try {
    return await runHookPreparation(files, async attempt => {
      await installNotifyHooks(settings, port, home, entry, attempt)
      const required = files.map(file => inspectHookFile(file))
      const verifyRequired = () => { attempt.verify(); for (const file of required) file.verify() }
      // Windows: Agent Messages' block is a POSIX shell line, and the allowance names the POSIX launcher. Neither is
      // installed there yet (Phase B4 notes).
      if (process.platform !== 'win32' && (settings.inbox || settings.allow)) await installMessagesBlock(settings, home, attempt, verifyRequired)
      return true
    }, { ...options, identity: JSON.stringify([engine, identitySettings(settings), port, home, entry.args ? [entry.command, entry.args] : entry.command, env.HARNESS_AGENT_MESSAGES_DIR]) })
  } catch (err) {
    console.error(settings.messages.failed.replace(/\{(file|script|port)\}/g, (_, name: string) =>
      name === 'file' ? files[0] : name === 'script' ? HOOK_SCRIPT : String(port)), err)
    return false
  }
}
```

  - Replace `installNotifyHooks` (lines 174-229) with:

```ts
async function installNotifyHooks(settings: HookSettings, port: number, home: string, entry: { command: string; args?: string[] }, attempt: HookPreparationAttempt): Promise<boolean> {
  const file = join(home, settings.file)
  const say = (line: string): string => line.replace(/\{(file|script|port)\}/g, (_, name: string) =>
    name === 'file' ? file : name === 'script' ? HOOK_SCRIPT : String(port))
  // A hook already there is the current one when its line is, and in exec form its arguments too.
  const sameHook = (hook: CommandHook | undefined): boolean => hook?.command === entry.command
    && (entry.args === undefined || JSON.stringify(hook.args) === JSON.stringify(entry.args))
  const { messages } = settings
  const observed = inspectHookFile(file)
  const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
    throw new HookPreparationHeld('the hook settings do not have the declared object shape')
  }
  current.hooks ??= {}
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const { event, matcher } of settings.events) {
    if (current.hooks[event] !== undefined && !Array.isArray(current.hooks[event])) throw new HookPreparationHeld('a hook event is not a list')
    const blocks = current.hooks[event] ?? []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and keep every
    // non-ours block untouched.
    const foreign = foreignHookBlocks(blocks)
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1) changed = true // none yet, or duplicates to drop
    const existing = ours[0]
    if (existing) {
      // A prior block with a different command (moved checkout / dev↔dist / changed port / interpreter) is
      // overwritten in place by the canonical one below.
      const existingHook = settings.upToDate.command === 'first-ours'
        ? existing.hooks?.find((h) => isOurs({ hooks: [h] }))
        : existing.hooks?.[0]
      if (!sameHook(existingHook)) { changed = true; updated = true }
      if (settings.upToDate.matcher && existing.matcher !== matcher) changed = true
    }
    current.hooks[event] = [...foreign, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: entry.command, ...(entry.args ? { args: entry.args } : {}), timeout: settings.timeout }] }]
  }

  const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
  const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings) : null
  reviewed?.verify()
  if (!changed) {
    const published = await observed.replace(next, attempt)
    console.log(say(messages.current))
    // Installed by an earlier start, or by a release before the engine asked: recorded now, as the file has it.
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    return true
  }

  const published = await observed.replace(next, attempt)
  console.log(say(updated && messages.updated ? messages.updated : messages.installed))
  console.log(say(messages.after))
  const approval = await reviewed?.commit(attempt)
  published.verify(); approval?.verify()
  return true
}
```

  `cli/src/engines/kit/nativeHookSettings.ts`:
  - Line 2 becomes `import { command, hooksNotOnWindows, identitySettings, isOurs, isManagedHookCommand, foreignHookBlocks, type HookRunner, type Settings, type HookBlock } from './notifyHooks.js'`.
  - Line 80: the identity becomes `identity: JSON.stringify([identitySettings(rule, platform), port, cmd])`: Copilot's and
    Command Code's rules now declare `win32Runner`, which must not change their identity off Windows.
  - In `NativeHookSettings` (after `failClosed?: boolean`, line 15) add:

```ts
  /** What runs this engine's hooks on Windows (kit/notifyHooks.ts `HookRunner`). Absent: no hooks there. */
  win32Runner?: Exclude<HookRunner, 'argv'>
```

  - Lines 32-33 become:

```ts
export async function installNativeHookSettings(rule: NativeHookSettings, port: number, options: NativeHookOptions = {}, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'win32' && !rule.win32Runner) return hooksNotOnWindows(rule.engine)
  const cmd = command(port, rule.engine, undefined, undefined, options.environment, platform === 'win32' ? rule.win32Runner! : 'bash')
```

  `cli/src/engines/copilot/contract.ts`: after `"eventFlag": "--copilot-event",` (line 44) add
  `"win32Runner": "powershell",`. Add this comment above the object: `// Windows: Copilot CLI copies \`command\` to its
  \`powershell\` field and runs that (docs.github.com, hooks configuration reference).`

  `cli/src/engines/commandcode/contract.ts`: after `"timeout": 5,` (line 50) add `"win32Runner": "cmd",`. Add this
  comment above the object: `// Windows: Command Code runs a hook with Node's \`spawn(command, [], { shell: true })\`,
  i.e. \`cmd.exe /d /s /c\` (command-code 1.82.3 dist/cli.mjs \`hookShell\`).`

  `cli/src/engines/nativeHooks.ts`:
  - Line 15 becomes `import { command, hooksNotOnWindows } from './kit/notifyHooks.js'`.
  - Lines 37-39 become:

```ts
// Windows: Hermes installs only through `curl … | bash`, and what runs its shell hooks there is unverified: none.
export const installHermesHooks = (port: number, selectedHome?: string, options?: NativeHookOptions): Promise<boolean> =>
  process.platform === 'win32' ? Promise.resolve(hooksNotOnWindows('hermes')) : installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home, options?.environment), selectedHome,
    { ...options, createMissing: !!selectedHome && !!options?.environment })
```

- [ ] **Step 4: Run it, the installers and their goldens.**
  `cd cli && npx vitest run src/engines/kit/windowsHooks.spec.ts src/engines/kit/hookSettings.spec.ts src/engines/kit src/engines/hooks.spec.ts src/engines/hookInstallers.golden.spec.ts src/engines/otherHooks.golden.spec.ts src/engines/nativeDescriptors.golden.spec.ts src/core/engines`
  Expected: PASS, and no golden re-recorded. If a golden records the settings objects themselves, the new
  `win32Runner` key shows up as a diff. Re-record that golden only with its documented flag, and name it in the commit.

- [ ] **Step 5: Typecheck.** `cd cli && npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit.**
  `git add cli/src/engines/facets/hooks.ts cli/src/engines/claude/hookContract.ts cli/src/engines/codex/hookContract.ts cli/src/engines/kit/hookSettings.ts cli/src/engines/kit/nativeHookSettings.ts cli/src/engines/kit/notifyHooks.ts cli/src/engines/copilot/contract.ts cli/src/engines/commandcode/contract.ts cli/src/engines/nativeHooks.ts cli/src/engines/kit/windowsHooks.spec.ts`
  `git commit -m "feat(hooks): install each engine's hooks for the runner it uses on Windows"`

### Task B4.7: The hook server accepts a pty host pane hint

`validHookBody` (`hookServer.ts:248-265`) rejects any hint whose backend is not `tmux` or `herdr`. It answers 400
"invalid hook body". `normalizedRuntimeHints` (`:286-298`) keeps only tmux hints. The core already resolves `ptyhost`
hints (`core/engines/hooks.ts:127-135`, `validTerminalRuntime`).

**Files**
- Modify: `cli/src/hookServer.ts:248-265,286-298`
- Modify: `cli/src/hookServer.spec.ts`. Add rows to the `it.each` at `:205-211`, plus one new `it`.

**Interfaces**
- Consumes: `HookTerminalHint` (`lib/terminalTypes.ts:35`, which already has the `ptyhost` shape).
- Produces: the hook wire accepts
  `runtimeHints: [{ backend: 'ptyhost', instance: /^p\d{1,4}$/, paneId: /^%\d{1,9}$/ }]` with no other field. B4.8 and
  B4.9 send it.

- [ ] **Step 1: Write the failing test.** In `cli/src/hookServer.spec.ts`, add these rows to the `it.each` list of
  'rejects malformed or unknown hook fields before process resolution' (after line 207):

```ts
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1', paneId: '%1', extra: true }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'host', paneId: '%1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1', paneId: '1' }] }],
```

  After 'accepts a Herdr hint from a hook installed by an earlier build…' add:

```ts
  it('resolves a hook from a pty host pane (Windows) by its instance and pane', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'claude',
        sessionId: '7f3b1c2e-0a4d-4e5f-9a6b-1c2d3e4f5a6b',
        runtimeHints: [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }],
        callerPid: 4242,
      }),
    })

    expect(response.status).toBe(200)
    expect(resolveHookAgent).toHaveBeenCalledWith({
      engine: 'claude', tmuxPane: undefined, runtimeHints: [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }], callerPid: 4242,
      onWait: expect.any(Function),
    })
  })
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/hookServer.spec.ts`
  Expected: the new `it` FAILS with status 400 (`invalid hook body`). The new rows pass already, because today every
  ptyhost hint is rejected.

- [ ] **Step 3: Implement.** In `hookServer.ts`, insert before the `herdr` branch at line 256:

```ts
      } else if (hint.backend === 'ptyhost') {
        // A Harness pty host pane, as its shell names itself (`HARNESS_PANE=<instance>:%N`, hook/notify.mjs): the
        // instance and the pane, nothing else.
        if (Object.keys(hint).some((field) => !['backend', 'instance', 'paneId'].includes(field))
          || typeof hint.instance !== 'string' || !/^p\d{1,4}$/.test(hint.instance)
          || typeof hint.paneId !== 'string' || !/^%\d{1,9}$/.test(hint.paneId)) return false
```

  Replace the loop body of `normalizedRuntimeHints` (line 290):

```ts
    for (const hint of body.runtimeHints) {
      if (hint?.backend === 'tmux' && /^%\d+$/.test(hint.paneId)) hints.push({ backend: 'tmux', paneId: hint.paneId })
      else if (hint?.backend === 'ptyhost' && /^p\d{1,4}$/.test(hint.instance) && /^%\d{1,9}$/.test(hint.paneId)) {
        hints.push({ backend: 'ptyhost', instance: hint.instance, paneId: hint.paneId })
      }
    }
```

- [ ] **Step 4: Run it and see it pass, with the core's resolver.**
  `cd cli && npx vitest run src/hookServer.spec.ts src/core/engines/hooks.spec.ts`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  `git add cli/src/hookServer.ts cli/src/hookServer.spec.ts`
  `git commit -m "feat(hooks): accept a hook's pty host pane hint"`

### Task B4.8: `notify.mjs` names a pty host pane and reads its credential on Windows

Today `main()` returns when `TMUX_PANE` is unset (`hook/notify.mjs:1622-1623`). `readHookCredential` (`:398-416`)
needs mode `0o600` and a `0o700` folder, so on NTFS it returns `''`, and every hook would be 401.

**Files**
- Modify: `cli/hook/notify.mjs`:
  - `:39`: the path import.
  - `:398-421`: `readHookCredential`, plus new `readWindowsHookCredential`, `ptyHostPane` and `terminalHookFields`.
  - `:1622-1623`: `main`.
- Modify: `cli/src/hookNotify.spec.ts`. In `runHook` (line 79), drop an inherited `HARNESS_PANE`, and add one
  `describe`.

**Interfaces**
- Consumes: the B4.7 wire. From A: `HARNESS_PANE=<instance>:%N` (`pty/src/panes.rs:348-351`).
- Produces: a hook from a pty host pane posts
  `runtimeHints: [{ backend: 'ptyhost', instance, paneId }]` with no `tmuxPane`, and `TMUX_PANE` still wins when it is
  set. On win32 the credential is read when it is a plain file whose real path lies inside the profile or inside the
  hook's `--data-dir`. The offline registry fallback stays tmux-only.

- [ ] **Step 1: Write the failing test.** In `cli/src/hookNotify.spec.ts`, after `const env = { ...process.env }`
  (line 79) add `delete env.HARNESS_PANE`. Append:

```ts
describe('hook notify in a Harness pty host pane (Windows)', () => {
  const sessionStart = () => {
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    return { ...recordings.claude.input, hook_event_name: 'SessionStart' }
  }

  it('names its pane by HARNESS_PANE when there is no TMUX_PANE', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { HARNESS_PANE: 'p3:%1007' }, input: sessionStart() })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
    expect(requests[0].body.runtimeHints).toEqual([{ backend: 'ptyhost', instance: 'p3', paneId: '%1007' }])
    expect(requests[0].body.tmuxPane).toBeUndefined()
  })

  it('keeps naming a tmux pane by TMUX_PANE, and ignores a HARNESS_PANE that is not one', async () => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%42', env: { HARNESS_PANE: 'p3:%1007' }, input: sessionStart() })
    expect(requests[0].body.runtimeHints).toEqual([{ backend: 'tmux', paneId: '%42' }])
    const bad = await collect()
    await runHook({ port: bad.port, env: { HARNESS_PANE: 'p3:1007' }, input: sessionStart() })
    expect(bad.requests).toEqual([])
  })

  it('reads its credential on Windows, where NTFS reports no owner and no private mode', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adapter-hook-win-')); tmpDirs.push(dataDir)
    writeFileSync(join(dataDir, 'hook-credential'), `${'b'.repeat(43)}\n`, { mode: 0o644 })
    const preload = join(dataDir, 'win32.mjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
    const { port, requests } = await collect({}, 'b'.repeat(43))
    await runHook({ port, dataDir, env: { HARNESS_PANE: 'p1:%1', NODE_OPTIONS: `--import ${preload}` }, input: sessionStart() })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
  })

  it('refuses a linked credential on Windows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adapter-hook-win-')); tmpDirs.push(dataDir)
    const elsewhere = mkdtempSync(join(tmpdir(), 'adapter-hook-other-')); tmpDirs.push(elsewhere)
    writeFileSync(join(elsewhere, 'token'), `${'b'.repeat(43)}\n`)
    symlinkSync(join(elsewhere, 'token'), join(dataDir, 'hook-credential'))
    const preload = join(dataDir, 'win32.mjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
    const { port, requests } = await collect({}, 'b'.repeat(43))
    await runHook({ port, dataDir, env: { HARNESS_PANE: 'p1:%1', NODE_OPTIONS: `--import ${preload}` }, input: sessionStart() })
    expect(requests).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/hookNotify.spec.ts -t "pty host pane"`
  Expected: FAIL. With no `TMUX_PANE`, the hook returns before it posts, so `requests` is empty.

- [ ] **Step 3: Implement.** In `cli/hook/notify.mjs`:
  - Line 39 becomes `import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'`.
  - In `readHookCredential` (lines 398-416), after `const dataDir = paths().dataDir` add:

```js
    if (process.platform === 'win32') return readWindowsHookCredential(dataDir, join(dataDir, 'hook-credential'))
```

  - Replace `terminalHookFields` (lines 418-422) with:

```js
/**
 * Mirrors secureState.ts's Windows rules (`windowsStateRoots`, `requireInsideWindowsRoots`) and hookAuth.ts on Windows:
 * NTFS gives Node no owner or mode bits, so the credential must be a plain file (not a link or junction, which lstat
 * does not call a file), with a real path inside the profile or the data folder this hook was installed with.
 */
function readWindowsHookCredential(dataDir, file) {
  const roots = [homedir(), dataDir].flatMap((root) => { try { return [realpathSync.native(root)] } catch { return [] } })
  const inside = (target) => roots.some((root) => {
    const rel = win32.relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel))
  })
  const link = lstatSync(file)
  if (!link.isFile() || link.size > 128 || !inside(realpathSync.native(file))) return ''
  const value = readFileSync(file, 'utf8').trim()
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
}

/**
 * A Harness pty host pane names itself `HARNESS_PANE=<instance>:%N` (pty/src/panes.rs), as a tmux pane has
 * `TMUX_PANE`. It is read only when there is no TMUX_PANE: a tmux pane inside a pty host pane is still the tmux pane.
 */
function ptyHostPane(environment = process.env) {
  if (environment.TMUX_PANE) return null
  const match = /^(p\d{1,4}):(%\d{1,9})$/.exec(environment.HARNESS_PANE || '')
  return match ? { instance: match[1], paneId: match[2] } : null
}
const PTY_PANE = ptyHostPane()

function terminalHookFields(tmuxPane) {
  const runtimeHints = []
  if (tmuxPane) runtimeHints.push({ backend: 'tmux', paneId: tmuxPane })
  else if (PTY_PANE) runtimeHints.push({ backend: 'ptyhost', instance: PTY_PANE.instance, paneId: PTY_PANE.paneId })
  return { tmuxPane, runtimeHints, callerPid: process.ppid }
}
```

  - In `main()`, replace line 1623 (`if (!tmuxPane) return`) with:

```js
  // A pane is required: tmux's, or a pty host's (Windows). Routing to another daemon and the offline registry
  // fallback read tmux; from a pty host pane they find nothing and the daemon's own scan reconciles.
  if (!tmuxPane && !PTY_PANE) return
```

- [ ] **Step 4: Run it and see it pass, with the rest of the hook's suite.**
  `cd cli && npx vitest run src/hookNotify.spec.ts src/coreIsolation.spec.ts`
  Expected: PASS. A failure in the earlier cases means a test inherited `HARNESS_PANE`; check the `delete` in `runHook`.

- [ ] **Step 5: Windows check.** This runs as part of B4.15's E2E: a Claude Code pane's `SessionStart` binds a
  `sessionId`.

- [ ] **Step 6: Commit.**
  `git add cli/hook/notify.mjs cli/src/hookNotify.spec.ts`
  `git commit -m "feat(hooks): notify.mjs names a pty host pane and reads its credential on Windows"`

### Task B4.9: The OpenCode, Kilo and Pi plugins name a pty host pane

These plugins run in the engine's own process, so no hook runner is involved. Each one reads only `TMUX_PANE`:
- `kilo/contract.ts:30,32,52`
- `opencode/contract.ts:70,72,92` (1.x) and `:137,139,165` (2.x TUI)
- `pi/contract.ts:37,42,68`

Amp is not changed (it is not installable on Windows).

**Files**
- Modify: `cli/src/engines/kilo/contract.ts:30-32,52`, `cli/src/engines/opencode/contract.ts:70-72,92,137-139,165`,
  `cli/src/engines/pi/contract.ts:37-42,68`
- Create: `cli/src/engines/pluginPaneHints.spec.ts`
- Modify: `cli/.gitignore` (add `src/.tmp/`, where the spec renders the plugins)
- Modify (re-record): `cli/src/engines/__fixtures__/other-hooks.golden.json`

**Interfaces**
- Consumes: the B4.7 wire. From the kit: `nativePluginSource` (`kit/nativePlugin.ts:15`).
- Produces: the installed plugin files gain the `HARNESS_PANE` fallback on every OS. With `TMUX_PANE` set, their
  behavior is unchanged. This is the one intended byte change on mac/Linux: each plugin file is rewritten once by the
  next start.

- [ ] **Step 1: Write the failing test.** Create `cli/src/engines/pluginPaneHints.spec.ts`. The rendered plugins are
  written under `cli/src/.tmp/`, inside the project so vitest transforms the Pi extension's TypeScript, and outside
  `src/engines`, which `architecture.spec.ts` walks and `tsc` compiles while specs run in parallel. `.tmp` is
  git-ignored (add `src/.tmp/` to `cli/.gitignore`), and a dot folder is outside `tsconfig.json`'s `src/**/*`
  include:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KILO_PLUGIN } from './kilo/contract.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { PI_EXTENSION } from './pi/contract.js'

const TOKEN = 'c'.repeat(43)
let dir = ''
let fetch: ReturnType<typeof vi.fn>
beforeEach(() => {
  const tmp = join(import.meta.dirname, '..', '.tmp')
  mkdirSync(tmp, { recursive: true })
  dir = mkdtempSync(join(tmp, 'plugin-pane-'))
  writeFileSync(join(dir, 'hook-credential'), `${TOKEN}\n`)
  fetch = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetch)
  vi.stubEnv('TMUX_PANE', '')
  vi.stubEnv('HARNESS_PANE', 'p2:%1003')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

async function load(rule: NativePlugin, name: string): Promise<any> {
  const file = join(dir, name)
  writeFileSync(file, nativePluginSource(rule, { port: '19473', credential: JSON.stringify(join(dir, 'hook-credential')), version: '"test"' }))
  return import(pathToFileURL(file).href)
}
const posted = () => JSON.parse((fetch.mock.calls[0] as [string, { body: string }])[1].body)
const PTY_HINT = [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }]

describe('a plugin in a Harness pty host pane (Windows)', () => {
  it.each([[KILO_PLUGIN, 'kilo.mjs'], [OPENCODE_LEGACY_PLUGIN, 'opencode.mjs']] as const)('posts its pane by HARNESS_PANE: %#', async (rule, name) => {
    const plugin = await load(rule, name)
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
    expect(posted()).toMatchObject({ sessionId: 'ses_1', runtimeHints: PTY_HINT })
    expect(posted().tmuxPane).toBeUndefined()
  })

  it('posts the OpenCode 2 TUI session by HARNESS_PANE', async () => {
    const plugin = await load(OPENCODE_TUI_PLUGIN, 'tui.mjs')
    const stop = plugin.default.setup({ ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_2' }) } }, data: { session: { get: async () => ({}) } } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    stop?.()
    expect(posted()).toMatchObject({ sessionId: 'ses_2', runtimeHints: PTY_HINT })
  })

  it('posts the Pi session by HARNESS_PANE', async () => {
    const plugin = await load(PI_EXTENSION, 'pi.ts')
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {}
    plugin.default({ on: (name: string, run: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[name] = run } })
    await handlers.session_start({}, { sessionManager: { getSessionFile: () => null, getSessionId: () => 'pi-1' }, cwd: '/work' })
    expect(posted()).toMatchObject({ sessionId: 'pi-1', runtimeHints: PTY_HINT })
  })

  it('still posts a tmux pane by TMUX_PANE alone', async () => {
    vi.stubEnv('TMUX_PANE', '%7')
    const plugin = await load(KILO_PLUGIN, 'kilo-tmux.mjs')
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_3' } } } })
    expect(posted()).toMatchObject({ tmuxPane: '%7', runtimeHints: [{ backend: 'tmux', paneId: '%7' }] })
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/pluginPaneHints.spec.ts`
  Expected: the four pty host cases FAIL because `fetch` is never called. The tmux case passes.

- [ ] **Step 3: Implement.** The templates are TS template literals, so a regex backslash is written `\\d`.

  `kilo/contract.ts` lines 30-32 and `opencode/contract.ts` lines 70-72 (1.x) both become:

```ts
    const pane = process.env.TMUX_PANE
    // A Harness pty host pane (Windows) names itself HARNESS_PANE=<instance>:%N, and has no TMUX_PANE.
    const ptyPane = pane ? null : /^(p\\d{1,4}):(%\\d{1,9})$/.exec(process.env.HARNESS_PANE || "")
    const token = hookToken()
    if ((!pane && !ptyPane) || !token || !sessionID || seen.has(sessionID)) return
```

  In the same two templates, after the `runtimeHints` line `...(pane ? [{ backend: "tmux", paneId: pane }] : []),`
  (kilo :52, opencode :92) add:

```ts
            ...(ptyPane ? [{ backend: "ptyhost", instance: ptyPane[1], paneId: ptyPane[2] }] : []),
```

  `opencode/contract.ts` lines 137-139 (the TUI) become:

```ts
    const pane = process.env.TMUX_PANE
    const ptyPane = pane ? null : /^(p\\d{1,4}):(%\\d{1,9})$/.exec(process.env.HARNESS_PANE || "")
    const router = ctx && ctx.ui && ctx.ui.router
    if ((!pane && !ptyPane) || !router || typeof router.current !== "function") return
```

  and line 165 becomes:

```ts
            runtimeHints: pane ? [{ backend: "tmux", paneId: pane }] : [{ backend: "ptyhost", instance: ptyPane[1], paneId: ptyPane[2] }],
```

  `pi/contract.ts`: line 37 becomes the two lines below. Line 42 becomes `if ((!pane && !ptyPane) || !token) return;`.

```ts
    const pane = process.env.TMUX_PANE;
    const ptyPane = pane ? null : /^(p\\d{1,4}):(%\\d{1,9})$/.exec(process.env.HARNESS_PANE || "");
```

  After line 68 add:

```ts
            ...(ptyPane ? [{ backend: "ptyhost", instance: ptyPane[1], paneId: ptyPane[2] }] : []),
```

- [ ] **Step 4: Run it, then re-record the golden of what lands in an engine's files.**
  `cd cli && npx vitest run src/engines/pluginPaneHints.spec.ts`. Expected: PASS.
  `cd cli && npx vitest run src/engines/*.golden.spec.ts`. Expected: only `otherHooks.golden.spec.ts` fails, on the
  plugin bytes.
  `cd cli && RECORD_OTHER_ENGINES_GOLDEN=1 npx vitest run src/engines/otherHooks.golden.spec.ts`, then
  `git diff --stat cli/src/engines/__fixtures__`. Expected: only `other-hooks.golden.json` changes, and its diff is
  exactly the added lines above. Then run `cd cli && npx vitest run src/engines/*.golden.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit** (the commit says the golden was re-recorded on purpose).
  `git add cli/.gitignore cli/src/engines/kilo/contract.ts cli/src/engines/opencode/contract.ts cli/src/engines/pi/contract.ts cli/src/engines/pluginPaneHints.spec.ts cli/src/engines/__fixtures__/other-hooks.golden.json`
  `git commit -m "feat(hooks): the OpenCode, Kilo and Pi plugins name a pty host pane" -m "Re-records other-hooks.golden.json: the plugin files gain the HARNESS_PANE fallback (unchanged behavior under tmux)."`

### Task B4.10: Hook files on real Windows

**Files**
- Create: `cli/src/lib/windows/hookFiles.real.spec.ts`. It sits in `src/lib/windows`, which the Windows workflow
  already runs (`.github/workflows/windows-pty.yml`, the "Contract suite against the real host, and the Windows CLI
  specs" step as B1.13 rewrote it).

**Interfaces**
- Consumes: B4.3–B4.6 as built.
- Produces: no product interface. It is evidence that the walk, the writers, the recognizers and the runners hold on
  NTFS.

- [ ] **Step 1: Write the test.** Create `cli/src/lib/windows/hookFiles.real.spec.ts`:

```ts
// Hook files on real Windows (Phase B4): the path walk, the writers, the recognizers, and the lines run the way Codex,
// Command Code and Copilot run them. Windows only. It writes only below its own temporary folder, with explicit homes:
// os.homedir() is USERPROFILE there, which vitest.setup.ts does not redirect, so no engine default is used.
//   cd cli && npx vitest run src/lib/windows/hookFiles.real.spec.ts
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { engineHooks } from '../../engines/hooks.js'
import { createHomeAdopter, readAdoptedHomes } from '../../engines/kit/homeAdoption.js'
import { NativeEvidenceBudget } from '../../engines/kit/nativeEvidence.js'
import { inspectHookFile, runHookPreparation } from '../../engines/kit/nativeHookFiles.js'
import { NativePaths } from '../../engines/kit/nativePaths.js'
import { isOurs, quoteHookCommand } from '../../engines/kit/notifyHooks.js'

const enabled = process.platform === 'win32'
const root = enabled ? mkdtempSync(join(tmpdir(), 'hook-files-')) : ''
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

;(enabled ? describe : describe.skip)('hook files on Windows', () => {
  it('walks a drive path, and refuses a junction on the way rather than following it', () => {
    const real = join(root, 'real'), link = join(root, 'junction')
    mkdirSync(real)
    writeFileSync(join(real, 'settings.json'), '{}')
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, real])
    expect(new NativePaths(new NativeEvidenceBudget()).resolveSync(join(real, 'settings.json'))?.path).toBe(join(real, 'settings.json'))
    expect(() => new NativePaths(new NativeEvidenceBudget()).resolveSync(join(link, 'settings.json'), true)).toThrow(/reparse point/)
  })

  it('installs Claude Code exec form and a Codex line for cmd.exe, and finds both current the second time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const claudeHome = join(root, 'claude'), codexHome = join(root, 'codex')
      expect(await engineHooks.claude.installIn(19473, claudeHome)).toBe(true)
      expect(await engineHooks.codex.installIn(19473, codexHome)).toBe(true)
      const claude = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'))
      const hook = claude.hooks.SessionStart[0].hooks[0]
      expect(hook.command).toMatch(/\\node\.exe$/i)
      expect(hook.args[0]).toMatch(/\\notify\.mjs$/)
      expect(isOurs({ hooks: [hook] })).toBe(true)
      expect(claude.hooks.PostToolUse).toBeUndefined()
      const codex = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
      expect(codex.hooks.SessionStart[0].hooks[0].command).toMatch(/^"[^"]+node\.exe" "[^"]+notify\.mjs" --port 19473 /i)
      expect(isOurs(codex.hooks.SessionStart[0])).toBe(true)
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('trusted_hash')
      const before = [readFileSync(join(claudeHome, 'settings.json'), 'utf8'), readFileSync(join(codexHome, 'hooks.json'), 'utf8')]
      expect(await engineHooks.claude.installIn(19473, claudeHome)).toBe(true)
      expect(await engineHooks.codex.installIn(19473, codexHome)).toBe(true)
      expect([readFileSync(join(claudeHome, 'settings.json'), 'utf8'), readFileSync(join(codexHome, 'hooks.json'), 'utf8')]).toEqual(before)
      expect(log).toHaveBeenCalledWith('[hooks] Claude session + turn (Stop/StopFailure) hooks already installed')
    } finally { log.mockRestore() }
  })

  it('replaces a settings file another process has open', async () => {
    mkdirSync(join(root, 'held'))
    const file = join(root, 'held', 'settings.json')
    writeFileSync(file, '{}\n')
    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); setTimeout(() => {}, 400)`], { stdio: 'ignore' })
    try {
      await new Promise((done) => setTimeout(done, 150))
      await runHookPreparation([file], async (attempt) => (await inspectHookFile(file).replace('{"ok":true}\n', attempt)).verify())
      expect(readFileSync(file, 'utf8')).toBe('{"ok":true}\n')
    } finally { holder.kill() }
  })

  it('passes every argument whole through the cmd.exe and PowerShell lines', () => {
    const dir = join(root, 'Thảo & co (1)'), script = join(dir, 'echo.mjs')
    mkdirSync(dir)
    // Base64, so PowerShell's re-encoding of a native program's output cannot change what is compared.
    writeFileSync(script, "process.stdout.write(Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'))\n")
    const argv = [process.execPath, script, '--port', '19473', '--data-dir', join(dir, 'data'), '--engine', 'codex']
    const read = (out: string) => JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'))
    const cmdLine = quoteHookCommand('cmd', argv) as string
    // Codex 0.162: %COMSPEC% /C "<line>", the line given verbatim.
    const codex = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/C', `"${cmdLine}"`], { windowsVerbatimArguments: true, encoding: 'utf8' })
    expect(read(codex.stdout)).toEqual(argv.slice(2))
    // Command Code: Node's spawn with shell: true (cmd.exe /d /s /c).
    expect(read(spawnSync(cmdLine, { shell: true, encoding: 'utf8' }).stdout)).toEqual(argv.slice(2))
    const copilot = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', quoteHookCommand('powershell', argv) as string], { encoding: 'utf8' })
    expect(read(copilot.stdout)).toEqual(argv.slice(2))
  })

  it('adopts a moved Claude Code home with a Windows path', () => {
    const file = join(root, 'engine-homes.json'), home = join(root, 'claude-work')
    expect(createHomeAdopter(file).adopt({ claude: [home], codex: [] }).claude).toContain(home)
    expect(readAdoptedHomes(file).homes.claude).toContain(home)
  })
})
```

- [ ] **Step 2: Run it on mac.** `cd cli && npx vitest run src/lib/windows/hookFiles.real.spec.ts`. Expected: 5 skipped.

- [ ] **Step 3: Run it on the VM.**
  `cli/scripts/windows-pty-e2e/vm-sync.sh --cli`
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/lib/windows/hookFiles.real.spec.ts"`
  Expected: 5 passed. When a case fails, fix its task (B4.3, B4.4, B4.5 or B4.6) with a unit test that reproduces the
  VM's answer, then run this again. Do not loosen this spec. If the second `installIn` rewrites `config.toml` every
  time, Codex's review record is not stable on Windows; B4.15 decides that.

- [ ] **Step 4: Commit.**
  `git add cli/src/lib/windows/hookFiles.real.spec.ts`
  `git commit -m "test(windows): hook files, recognizers and runners on real Windows"`

### Task B4.11: The engine homes on Windows

The defaults in `env.ts` (`:146-213`) are `join(homedir(), …)` on every OS. The VM shows that these are also where
each engine lives on Windows:
- OpenCode 1.19.0 has `~\.config\opencode` and `~\.local\share\opencode`, with nothing under `%APPDATA%`.
- Kilo, Pi, Copilot and Command Code left `~\.config\kilo`, `~\.pi`, `~\.copilot` and `~\.commandcode` (the
  2026-10-15 cleanup list).
- Claude's file is `~\.claude\settings.json` (F15).

So the table pins this, and no default changes.

**Files**
- Create: `cli/src/engines/windowsHomes.ts`
- Create: `cli/src/engines/windowsHomes.spec.ts`

**Interfaces**
- Consumes: `env` (`config/env.ts`), `hookContracts` (`engines/hooks.ts:13`), the `win32Runner` declarations (B4.6).
- Produces: `WINDOWS_ENGINE_HOMES`, a per-engine table (spec section 4), read by its test and by B4.15's VM check.

- [ ] **Step 1: Write the failing test.** Create `cli/src/engines/windowsHomes.spec.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { hookContracts } from './hooks.js'
import { WINDOWS_ENGINE_HOMES } from './windowsHomes.js'

describe('engine homes on Windows', () => {
  it('has an entry for every engine Harness reaches through hooks or a plugin on Windows', () => {
    const hooked = [
      ...Object.entries(hookContracts).filter(([, contract]) => contract.settings.win32Runner).map(([engine]) => engine),
      ...[COPILOT_HOOK_SETTINGS, COMMANDCODE_HOOK_SETTINGS].map((rule) => rule.engine),
      'opencode', 'kilo', 'pi',
    ]
    expect(Object.keys(WINDOWS_ENGINE_HOMES).sort()).toEqual([...new Set(hooked)].sort())
  })

  it.each(Object.entries(WINDOWS_ENGINE_HOMES))('%s: the daemon default is that folder in the profile', (_engine, home) => {
    expect(env[home.setting]).toBe(join(homedir(), ...home.folder))
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  `cd cli && npx vitest run src/engines/windowsHomes.spec.ts`
  Expected: FAIL with `Failed to resolve import "./windowsHomes.js"`.

- [ ] **Step 3: Implement.** Create `cli/src/engines/windowsHomes.ts`:

```ts
/**
 * Where each engine Harness reaches on Windows keeps the folder its hooks or plugin go in, relative to the profile
 * (`%USERPROFILE%`, what os.homedir() returns there), as measured on the Windows VM. env.ts's defaults already name each one:
 * these engines read their homes from the profile on Windows as on a Mac, none from %APPDATA%. A new entry, or an
 * engine release that moves its home, is measured on the VM first (Task B4.15's check), then written here.
 */
import type { Env } from '../config/env.js'

export interface WindowsEngineHome {
  /** The daemon setting that names it (config/env.ts). */
  setting: keyof Env & ('CLAUDE_PROJECTS_DIR' | 'CODEX_HOME' | 'OPENCODE_PLUGIN_DIR' | 'KILO_PLUGIN_DIR' | 'PI_HOME' | 'COPILOT_HOME' | 'COMMANDCODE_HOME')
  /** Below the profile. */
  folder: readonly string[]
  /** What was measured, and when. */
  verified: string
}

export const WINDOWS_ENGINE_HOMES = {
  claude: { setting: 'CLAUDE_PROJECTS_DIR', folder: ['.claude', 'projects'], verified: 'Claude Code 2.1.300: ~\\.claude\\settings.json (VM, 2026-10-15)' },
  codex: { setting: 'CODEX_HOME', folder: ['.codex'], verified: 'Codex 0.162.1: ~\\.codex (VM, 2026-10-15)' },
  opencode: { setting: 'OPENCODE_PLUGIN_DIR', folder: ['.config', 'opencode', 'plugin'], verified: 'OpenCode 1.19.0: ~\\.config\\opencode, ~\\.local\\share\\opencode, none in %APPDATA% (VM, 2026-10-16)' },
  kilo: { setting: 'KILO_PLUGIN_DIR', folder: ['.config', 'kilo', 'plugin'], verified: 'Kilo 7.8.12: ~\\.config\\kilo, ~\\.local\\share\\kilo (VM, 2026-10-15)' },
  pi: { setting: 'PI_HOME', folder: ['.pi'], verified: 'Pi 1.2.0: ~\\.pi (VM, 2026-10-15)' },
  copilot: { setting: 'COPILOT_HOME', folder: ['.copilot'], verified: 'Copilot CLI 1.0.98: ~\\.copilot, logs in %LOCALAPPDATA%\\copilot (VM, 2026-10-15)' },
  commandcode: { setting: 'COMMANDCODE_HOME', folder: ['.commandcode'], verified: 'Command Code 1.82.3: ~\\.commandcode (VM, 2026-10-15)' },
} as const satisfies Record<string, WindowsEngineHome>
```

- [ ] **Step 4: Run it and see it pass.**
  `cd cli && npx vitest run src/engines/windowsHomes.spec.ts`. Expected: PASS. Then on the VM:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/engines/windowsHomes.spec.ts"`. Expected: PASS.
  This proves the defaults resolve under the real profile.

- [ ] **Step 5: Plugin folders, measured.** These folders were not measured on 2026-10-15. They are checked in B4.15
  step 6, after a run: `dir %USERPROFILE%\.config\opencode\plugin %USERPROFILE%\.config\kilo\plugin %USERPROFILE%\.pi\agent\extensions`.
  Decision rule: the session binding in B4.15 is the proof that the engine loaded the plugin from that folder.
  - If the engine binds, the entry stands. Update its `verified` text with the version and date.
  - If it does not bind and the engine's own config shows another folder, add a `process.platform === 'win32'`
    default for that setting in `env.ts` and `nativeLocations.ts`, with a test, and rerun B4.15.

- [ ] **Step 6: Commit.**
  `git add cli/src/engines/windowsHomes.ts cli/src/engines/windowsHomes.spec.ts`
  `git commit -m "docs(engines): pin each engine's home on Windows, as measured"`

### Task B4.12: OpenCode on Windows on Arm (investigate, then fix or refuse)

F14: OpenCode 1.19.0's Arm build exits at its TUI because `bun:ffi` is unavailable in that build. The root cause and
the fix are unknown. This task measures first, then lands the change the decision rule picks.

**Files**
- Modify: `cli/src/lib/windows/launch.ts`. After `:26-35`, add `WindowsEngineUnavailable`, `peMachine` and
  `windowsEngineUnavailable`. In `:76-101`, the `WindowsEngineArgvOptions.machine` option, and `windowsEngineArgv`
  checks the program it resolved.
- Modify: `cli/src/lib/windows/launch.spec.ts` (append).
- Modify: `docs/testing/windows-pty-e2e.md:405-406,428` (F14 and its known limit: the outcome).
- Create: `cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log`

**Interfaces**
- Consumes: `WindowsLaunchRefused`/`windowsLaunchRefusal` (`launch.ts:26,107`). Create, fork, resume, restart and
  restore map these to `ENGINE_LAUNCH_REFUSED` (`core/agents/create.ts:343`, `fork.ts:174`,
  `resumeAgentService.ts:311`, `restartAgent.ts:131`, `restoreLaunch.ts:45`).
- Produces: `class WindowsEngineUnavailable extends WindowsLaunchRefused`,
  `peMachine(file: string, read?): 'x64' | 'arm64' | 'x86' | null`, and
  `windowsEngineUnavailable(engine: string, program: string, machine?): string | null`. B4.13 uses them.

- [ ] **Step 1: Investigate on the VM.** Record every command and its output in
  `cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log`.
  1. `ssh admin@192.168.65.3 "npm view opencode-ai version & %APPDATA%\npm\opencode.cmd --version"`. This gives the
     latest version and the installed one (1.19.0).
  2. Latest native Arm build:
     - Run `ssh admin@192.168.65.3 "npm i -g opencode-ai@latest"`.
     - Then run it interactively: `ssh -t admin@192.168.65.3 "cd /d C:\work\b4 && opencode"`. Wait 15 s, then
       Ctrl+C. Record whether the TUI draws, or the exact error (the `bun:ffi` line).
  3. The x64 build under Windows on Arm's emulation:
     - Unpack it with
       `ssh admin@192.168.65.3 "mkdir C:\work\b4\oc-x64 & cd /d C:\work\b4\oc-x64 && npm pack opencode-windows-x64@<latest> && tar -xf opencode-windows-x64-<latest>.tgz"`.
     - Then run `ssh -t admin@192.168.65.3 "cd /d C:\work\b4 && C:\work\b4\oc-x64\package\bin\opencode.exe"`. Record
       whether the TUI draws.
  4. Whether npm can install the x64 build on Arm: `ssh admin@192.168.65.3 "npm i -g opencode-ai@latest --cpu=x64"`.
     Then read the PE machine of `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`:
     `powershell -NoProfile -Command "$b=[IO.File]::ReadAllBytes('%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe'); $o=[BitConverter]::ToInt32($b,60); '{0:X}' -f [BitConverter]::ToUInt16($b,$o+4)"`.
     `8664` is x64 and `AA64` is Arm.
  5. Restore what the VM had: `npm i -g opencode-ai@1.19.0`, then `rmdir /s /q C:\work\b4\oc-x64`.

- [ ] **Step 2: Decide** (write the outcome as the log's last line):
  - **A.** The latest Arm build draws its TUI. Nothing in Harness is changed except the note: F14 and the known
    limit say "fixed in OpenCode `<version>`; update OpenCode". Skip to Step 7.
  - **B.** The Arm build fails, the x64 build draws under emulation, and step 1.4 leaves an x64 `opencode.exe`.
    Harness refuses the Arm build with the exact install command (Steps 3–6, text B).
  - **C.** Anything else. Harness reports OpenCode unavailable on Windows on Arm (Steps 3–6, text C).

- [ ] **Step 3: Write the failing test.** Append to `cli/src/lib/windows/launch.spec.ts`, and add `peMachine,
  WindowsEngineUnavailable, windowsEngineUnavailable` to its import from `./launch.js`:

```ts
describe('an engine whose Windows build cannot run', () => {
  const pe = (machine: number): Buffer => {
    const bytes = Buffer.alloc(0x100)
    bytes.write('MZ', 0, 'latin1'); bytes.writeUInt32LE(0x80, 0x3c)
    bytes.write('PE\0\0', 0x80, 'latin1'); bytes.writeUInt16LE(machine, 0x84)
    return bytes
  }

  it('reads the machine a program is built for from its PE header', () => {
    expect(peMachine('x', () => pe(0xaa64))).toBe('arm64')
    expect(peMachine('x', () => pe(0x8664))).toBe('x64')
    expect(peMachine('x', () => Buffer.from('#!/bin/sh\n'))).toBeNull()
    expect(peMachine('x', () => { throw new Error('gone') })).toBeNull()
  })

  it('refuses the Arm build of OpenCode before a pane opens, in words for the person', () => {
    const exe = touch(join(folder(), 'opencode.exe'))
    let refused: unknown
    try { windowsEngineArgv('opencode', [exe], { platform: 'win32', machine: () => 'arm64' }) } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(WindowsEngineUnavailable)
    expect(windowsLaunchRefusal(refused)).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: windowsEngineUnavailable('opencode', exe, () => 'arm64') })
    expect((refused as Error).message).toMatch(/OpenCode/)
  })

  it('starts its x64 build, any other engine, and a version probe as before', () => {
    const exe = touch(join(folder(), 'opencode.exe'))
    expect(windowsEngineArgv('opencode', [exe, '--help'], { platform: 'win32', machine: () => 'x64' })).toEqual([exe, '--help'])
    expect(windowsEngineArgv('codex', [exe], { platform: 'win32', machine: () => 'arm64' })).toEqual([exe])
    expect(windowsEngineArgv('the engine', [exe, '--version'], { platform: 'win32', machine: () => 'arm64' })).toEqual([exe, '--version'])
  })
})
```

- [ ] **Step 4: Run it and see it fail.**
  `cd cli && npx vitest run src/lib/windows/launch.spec.ts`
  Expected: FAIL. `peMachine` and `WindowsEngineUnavailable` are not exported.

- [ ] **Step 5: Implement.** In `launch.ts`:
  - Add `closeSync, openSync, readSync` to the line-15 `node:fs` import.
  - After `WindowsBatchLaunchRefused` (line 35) add the code below. Use text C as written. For outcome B, replace the
    detail with text B, and the comment's "C" with "B". Text B lives here in the plan only, never in the code:

    `'OpenCode\'s Arm build for Windows stops before its screen opens. Install its x64 build, which Windows on Arm '
    + 'runs: <the command step 1.4 proved>, then try again.'`

```ts
/** An engine whose Windows build cannot run here, refused before any pane opens (outcome of Task B4.12). */
export class WindowsEngineUnavailable extends WindowsLaunchRefused {
  constructor(readonly engine: string, detail: string) {
    super(detail)
    this.name = 'WindowsEngineUnavailable'
  }
}

/** The machine a Windows program is built for, from its PE header (`IMAGE_FILE_HEADER.Machine`); null if it is not one. */
export function peMachine(file: string, read: (file: string) => Buffer = readHead): 'x64' | 'arm64' | 'x86' | null {
  let head: Buffer
  try { head = read(file) } catch { return null }
  if (head.length < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') return null
  const header = head.readUInt32LE(0x3c)
  if (header + 6 > head.length || head.toString('latin1', header, header + 4) !== 'PE\0\0') return null
  switch (head.readUInt16LE(header + 4)) {
    case 0x8664: return 'x64'
    case 0xaa64: return 'arm64'
    case 0x14c: return 'x86'
    default: return null
  }
}

function readHead(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const bytes = Buffer.alloc(4096)
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0))
  } finally { closeSync(fd) }
}

/**
 * Why [engine] cannot run as [program] on Windows, in words for the person, or null. Measured on the Windows VM
 * (Task B4.12, cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log): outcome C.
 */
export function windowsEngineUnavailable(engine: string, program: string, machine: (file: string) => ReturnType<typeof peMachine> = peMachine): string | null {
  if (engine === 'opencode' && /\.exe$/i.test(program) && machine(program) === 'arm64') {
    return 'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.'
  }
  return null
}
```

  - In `WindowsEngineArgvOptions` (lines 76-80) add:
    `/** The PE machine of a program (tests). */ machine?: (file: string) => ReturnType<typeof peMachine>`.
  - In `windowsEngineArgv` (lines 87-101), check every resolved program:

```ts
export function windowsEngineArgv(engine: string, argv: readonly string[], options: WindowsEngineArgvOptions = {}): string[] {
  const { environment = process.env, platform = process.platform, read = (file) => readFileSync(file, 'utf8'), machine = peMachine } = options
  const [command = '', ...args] = argv
  if (platform !== 'win32') return [...argv]
  const runs = (resolved: string[]): string[] => {
    const unavailable = windowsEngineUnavailable(engine, resolved[0]!, machine)
    if (unavailable) throw new WindowsEngineUnavailable(engine, unavailable)
    return resolved
  }
  const program = windowsLaunchCommand(command, environment, platform)
  if (!BATCH.test(program)) return runs([program, ...args])
  let shim: NpmShimTarget | null = null
  try { shim = exists(program) ? parseNpmCmdShim(read(program), dirname(program)) : null } catch { shim = null }
  if (shim?.kind === 'exe' && exists(shim.program)) return runs([shim.program, ...args])
  if (shim?.kind === 'node' && exists(shim.script)) {
    const beside = join(dirname(program), 'node.exe')
    const node = exists(beside) ? beside : windowsLaunchCommand('node', environment, platform)
    if (/\.exe$/i.test(node)) return runs([node, ...shim.nodeArgs, shim.script, ...args])
  }
  if (args.some((arg) => CMD_METACHARACTERS.test(arg))) throw new WindowsBatchLaunchRefused(engine, program)
  return runs([program, ...args])
}
```

  The version probe passes `'the engine'` as its engine (`nativeVersion.ts:55`, `nativeLaunch.ts:81`). So inspection
  and readiness are never refused; only the launch argv built for `opencode` is.

- [ ] **Step 6: Run it and the launch users.**
  `cd cli && npx vitest run src/lib/windows/launch.spec.ts src/lib/engineLaunch.spec.ts src/core/agents src/engines/nativeLaunch.spec.ts`
  Expected: PASS.

- [ ] **Step 7: Windows check and record.**
  - Outcomes B and C:
    - Build and copy the B4 install, and start (or restart) the B4 daemon (B4 conventions; `C:\work\e2e` is not
      touched), then run `ssh admin@192.168.65.3 "C:\work\b4\run.cmd create opencode"`.
    - Expected: `create opencode → ENGINE_LAUNCH_REFUSED OpenCode does not run on Windows on Arm yet…` (or text B),
      and no new pane in `run.cmd list`.
    - Append the output to `evidence/opencode-arm64.log`, then stop the B4 daemon (`C:\work\b4\stop.cmd`).
  - In `docs/testing/windows-pty-e2e.md`, edit F14 (line 405-406) and the last known limit (line 428) to state the
    outcome, the version measured, and what a person sees. For outcome A, give the version that works.

- [ ] **Step 8: Commit.**
  `git add cli/src/lib/windows/launch.ts cli/src/lib/windows/launch.spec.ts cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log docs/testing/windows-pty-e2e.md`
  `git commit -m "fix(windows): say why OpenCode cannot start on Windows on Arm, before a pane opens"`
  (outcome A: `git add` only the evidence and the doc, with
  `git commit -m "docs(windows): OpenCode on Windows on Arm, measured"`).

### Task B4.13: Command Code on Windows (F7, then verify or refuse)

F7: `ENGINE_CLI_COMMANDS.commandcode` is `cmd` (`engineBin.ts:31`). The launch search
(`launchExecutable.ts:76-78`) joins `cmd` with every PATH entry and adds `.exe`, so `C:\Windows\System32\cmd.exe` is
found before npm's shim. The package also installs `command-code`, `commandcode` and `cmdc` (`package.json` `bin`,
1.82.3). Its process signature already tells `cmd.exe` apart: `programName` keeps `cmd.exe` (`processTable.ts:78`), and
the entrypoint `command-code\dist\index.mjs` matches (`:583`).

**Files**
- Modify: `cli/src/lib/engineBin.ts:466-468` (`engineBin('commandcode')` on win32)
- Modify: `cli/src/engines/kit/launchExecutable.ts:76-78`. Extract `launchSearchNames`, which never searches for `cmd`
  on win32.
- Modify: `cli/src/lib/engineBin.spec.ts` (append), and create `cli/src/engines/kit/launchSearchNames.spec.ts`.
- Modify: `docs/testing/windows-pty-e2e.md:381-385` (F7: outcome).
- Create: `cli/scripts/windows-pty-e2e/evidence/commandcode.log`

**Interfaces**
- Consumes: `WindowsEngineUnavailable`/`windowsEngineUnavailable` (B4.12), the Command Code `cmd` runner (B4.6).
- Produces: `launchSearchNames(command: string, recipeNames: readonly string[], platform?): string[]`.

- [ ] **Step 1: Write the failing tests.** Append to `cli/src/lib/engineBin.spec.ts` (import `engineBin` from
  `./engineBin.js` if the file does not already):

```ts
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try { return run() } finally { Object.defineProperty(process, 'platform', original) }
}

it('starts Command Code by its own name on Windows, where cmd is the command processor (F7)', () => {
  expect(onPlatform('win32', () => engineBin('commandcode'))).toBe('command-code')
  expect(onPlatform('darwin', () => engineBin('commandcode'))).toBe('cmd')
})
```

  Create `cli/src/engines/kit/launchSearchNames.spec.ts`:

```ts
import { expect, it } from 'vitest'
import { launchSearchNames } from './launchExecutable.js'

it('never looks for an engine named cmd on Windows, where that finds C:\\Windows\\System32\\cmd.exe (F7)', () => {
  expect(launchSearchNames('command-code', ['cmd', 'command-code'], 'win32')).toEqual(['command-code'])
  expect(launchSearchNames('CMD', ['command-code'], 'win32')).toEqual(['command-code'])
})

it('searches every name elsewhere, the command first', () => {
  expect(launchSearchNames('cmd', ['cmd', 'command-code'], 'darwin')).toEqual(['cmd', 'command-code'])
  expect(launchSearchNames('claude', ['claude'], 'win32')).toEqual(['claude'])
})
```

- [ ] **Step 2: Run them and see them fail.**
  `cd cli && npx vitest run src/lib/engineBin.spec.ts src/engines/kit/launchSearchNames.spec.ts`
  Expected: FAIL. `engineBin` answers `cmd` on win32, and `launchSearchNames` is not exported.

- [ ] **Step 3: Implement.**
  - `engineBin.ts` lines 467-468 become:

```ts
    // command-code's package `bin` lists `cmd` first and its README uses it. On Windows `cmd` is the command processor,
    // found on PATH before npm's shim (the Windows VM, F7): there it is `command-code`, from the same package.
    case 'commandcode': return env.COMMANDCODE_PATH || (process.platform === 'win32' ? 'command-code' : ENGINE_CLI_COMMANDS.commandcode)
```

  - `launchExecutable.ts`. Replace line 78 (`const names = …`) with
    `const names = launchSearchNames(command, recipe?.executable.names ?? [])`. Add above `captureLaunchExecutable`:

```ts
/**
 * The names a launch looks for on PATH, the command first. On Windows `cmd` is never one: it names the command processor
 * (C:\Windows\System32\cmd.exe, ahead of npm's folder on PATH), which every Command Code launch ran instead (F7).
 */
export function launchSearchNames(command: string, recipeNames: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set([command, ...recipeNames])].filter((name) => platform !== 'win32' || name.toLowerCase() !== 'cmd')
}
```

- [ ] **Step 4: Run them and the launch users.**
  `cd cli && npx vitest run src/lib/engineBin.spec.ts src/engines/kit/launchSearchNames.spec.ts src/engines/kit src/lib/engineLaunch.spec.ts src/engines/launchArgv.golden.spec.ts src/engines/launchShapes.golden.spec.ts`
  Expected: PASS, and no golden change (they record POSIX launches).

- [ ] **Step 5: Verify on the VM.** Record the output in `cli/scripts/windows-pty-e2e/evidence/commandcode.log`.
  1. `ssh admin@192.168.65.3 "npm i -g command-code@latest"` (it needs Node ≥ 22; the VM has 24.20.0).
  2. Build and copy the B4 install, and restart the B4 daemon (B4 conventions; `C:\work\e2e` is not touched). This
     task runs after B4.15 step 1, so hooks are on.
  3. `ssh admin@192.168.65.3 "C:\work\b4\run.cmd create commandcode"`, then
     `C:\work\b4\run.cmd screen <id>` after 15 s, and `C:\work\b4\run.cmd list`.
  4. `type %USERPROFILE%\.commandcode\settings.json`. Expected: `SessionStart`/`PreToolUse`/`Stop` blocks whose
     command starts with `"…node.exe" "…notify.mjs"`.
  5. Clean-up: `C:\work\b4\run.cmd delete <id>`, then `npm uninstall -g command-code`, then
     `rmdir /s /q %USERPROFILE%\.commandcode`, then stop the B4 daemon (`C:\work\b4\stop.cmd`).

- [ ] **Step 6: Decide.**
  - The screen shows Command Code's own interface (not `Microsoft Windows [Version …`) and `launch` is `ready`: F7 is
    fixed.
    - If `sessionId` is set in `list`, the `cmd` hooks are verified.
    - If it is not, and Command Code shows a sign-in screen, write "hooks not verified: needs a Command Code
      sign-in". That is not a failure of this task.
  - The interface does not start on Windows for a reason inside Command Code: a crash in its own code, shown on the
    screen. Then add a `commandcode` case to `windowsEngineUnavailable` (B4.12) with that reason in a person's words.
    The test is `windowsEngineArgv('commandcode', [nodeExe, script], { platform: 'win32' })` throwing
    `WindowsEngineUnavailable` (an npm `node` shim; the check keys on the engine, not the PE machine). Then run Step 4
    again.
  - Edit F7 in `docs/testing/windows-pty-e2e.md` (lines 381-385) with the outcome.

- [ ] **Step 7: Commit.**
  `git add cli/src/lib/engineBin.ts cli/src/lib/engineBin.spec.ts cli/src/engines/kit/launchExecutable.ts cli/src/engines/kit/launchSearchNames.spec.ts cli/scripts/windows-pty-e2e/evidence/commandcode.log docs/testing/windows-pty-e2e.md`
  (plus `cli/src/lib/windows/launch.ts cli/src/lib/windows/launch.spec.ts` if refused)
  `git commit -m "fix(windows): start Command Code, not cmd.exe (F7)"`

### Task B4.14: Desktop and mobile word `PTY_HOST_UNAVAILABLE` and `ENGINE_LAUNCH_REFUSED`

Create, fork, resume, restart, restore and retarget answer these codes (`terminalBackend.ts:159-175`,
`windows/launch.ts:107`, `restartAgent.ts:131`, `core/agents/retarget.ts:75`). Both apps show them as "has not
confirmed the new harness yet" or "Could not start harness: PTY_HOST_UNAVAILABLE". Both are refused before any pane
opens. `PTY_HOST_UNAVAILABLE`'s detail is written for the log (for example "harness-pty is not installed"), so it is
not shown. `ENGINE_LAUNCH_REFUSED`'s detail is written for the person (`WindowsLaunchRefused` messages), so it is
shown.

**Files**
- Modify: `desktop/lib/state/app_state.dart`:
  - `:12217-12219`: `_creationFailureMessage`.
  - `:12488-12521`: `refusedBeforeLaunch`.
  - `:13602-13621`: `_restartFailure`.
- Modify: `desktop/lib/state/retarget_refusal.dart:38-39`
- Modify: `mobile/lib/state/app_state.dart`:
  - `:4357-4359`: `_creationFailureMessage`.
  - `:4464-4475`: `refusedBeforeLaunch`.
  - `:4865-4873`: `_resumeFailure`.
- Modify: `mobile/lib/state/retarget_refusal.dart:26`
- Modify (tests): `desktop/test/swarm_async_test.dart:78-132`, `desktop/test/agent_pause_state_test.dart`,
  `desktop/test/retarget_refusal_test.dart:101-120`, `mobile/test/app_state_agent_rpcs_test.dart:299-303`,
  `mobile/test/phone_resume_agent_test.dart`

**Interfaces**
- Consumes: the two codes and their details, as the daemon sends them.
- Produces: copy only. It follows the naming system: "Harness" is the product, "harness" an agent, and "terminal" the
  shell pane.

- [ ] **Step 1: Write the failing tests.**

  `desktop/test/swarm_async_test.dart`: add to the `for (final (code, detail, expected) in [...])` table (before the
  `SPAWN_FAILED` row, line 128):

```dart
    // Windows: the terminal service did not answer. Its own reason is for the
    // log; the person gets the one thing to do.
    (
      'PTY_HOST_UNAVAILABLE',
      'harness-pty is not installed',
      'Harness could not open a terminal on Test host. Run harness start on that computer, then try again.',
    ),
    (
      'ENGINE_LAUNCH_REFUSED',
      'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.',
      'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.',
    ),
```

  `desktop/test/agent_pause_state_test.dart`: add inside `main()` after the 'a resume that never reached the daemon…'
  test:

```dart
  test('a resume the terminal service could not take says what to do', () async {
    app.stateOf('m')!.agents = [
      Agent.fromJson((inventory()['agents'] as List).single),
    ];
    final resume = app.resumeAgent('m', 'a0');
    connection.restartReplies.single.complete({
      'creationId': connection.requests.single['creationId'],
      'state': 'failed',
      'failure': {
        'code': 'PTY_HOST_UNAVAILABLE',
        'detail': 'harness-pty is not installed',
      },
    });
    expect(
      (await resume).error,
      'Harness could not open a terminal on this machine. Run harness start on it, then try again.',
    );
  });
```

  `desktop/test/retarget_refusal_test.dart`: add `'PTY_HOST_UNAVAILABLE', 'ENGINE_LAUNCH_REFUSED',` to the `codes`
  list (after `'TMUX_FAILED',`, line 108).

  `mobile/test/app_state_agent_rpcs_test.dart`: add two rows to the table at lines 299-303. `refusal(code)` sends no
  detail, so each row checks the fallback sentence:

```dart
      ('PTY_HOST_UNAVAILABLE', 'could not open a terminal'),
      ('ENGINE_LAUNCH_REFUSED', 'cannot start on'),
```

  `mobile/test/phone_resume_agent_test.dart`: add inside `main()`:

```dart
  test('a resume the terminal service could not take says what to do', () async {
    final conn = _ResumeConn()
      ..answer = (_, payload) => {
        'creationId': payload['creationId'],
        'state': 'failed',
        'failure': {'code': 'PTY_HOST_UNAVAILABLE', 'detail': 'harness-pty is not installed'},
      };
    final app = stoppedApp(conn);
    addTearDown(app.dispose);

    expect(
      (await app.resumeAgent('m', 'b')).error,
      'Harness could not open a terminal on this machine. Run harness start on it, then try again.',
    );
  });
```

- [ ] **Step 2: Run them and see them fail.**
  `cd desktop && flutter test test/swarm_async_test.dart test/agent_pause_state_test.dart test/retarget_refusal_test.dart`
  `cd mobile && flutter test test/app_state_agent_rpcs_test.dart test/phone_resume_agent_test.dart`
  Expected: FAIL. The desktop creation rows get "Test host has not confirmed the new harness yet…". The resume gets
  "harness-pty is not installed". The retarget rows contain the code itself.

- [ ] **Step 3: Implement.**

  Desktop `_creationFailureMessage`, after the `'TMUX_UNAVAILABLE' =>` case (line 12219):

```dart
    // Windows: the terminal service (the pty host) did not answer. Its own
    // reason is written for the log; the person needs the one fix.
    'PTY_HOST_UNAVAILABLE' =>
      'Harness could not open a terminal on $machine. '
          'Run harness start on that computer, then try again.',
    // Refused before any pane opened, in words the machine wrote for the
    // person (an engine Windows cannot start as asked).
    'ENGINE_LAUNCH_REFUSED' =>
      detail ?? 'This engine cannot start on $machine. Nothing was started.',
```

  Desktop `refusedBeforeLaunch`: after `'TMUX_UNAVAILABLE',` (line 12506) add
  `'PTY_HOST_UNAVAILABLE',` and `'ENGINE_LAUNCH_REFUSED',`.

  Desktop `_restartFailure` (lines 13602-13608) becomes:

```dart
  String _restartFailure(
    String code,
    Object? detail, {
    bool resuming = false,
  }) => code == 'PTY_HOST_UNAVAILABLE'
      // Its detail is written for the log.
      ? 'Harness could not open a terminal on this machine. Run harness start on it, then try again.'
      : detail is String && detail.isNotEmpty
      ? detail
      : switch (code) {
          'ENGINE_LAUNCH_REFUSED' =>
            'This engine cannot start on this machine. Nothing was stopped.',
```

  (The rest of the switch is unchanged.)

  Desktop `retarget_refusal.dart`, after the `'TMUX_UNAVAILABLE' || 'TMUX_FAILED' =>` case (line 39):

```dart
    'PTY_HOST_UNAVAILABLE' =>
      "This machine's terminals did not answer. Run harness start there, then try again.",
    'ENGINE_LAUNCH_REFUSED' =>
      detail ?? "$engineLabel cannot start on this machine with the new model.",
```

  Mobile `_creationFailureMessage`, after the `'TMUX_UNAVAILABLE' =>` case (line 4359):

```dart
        'PTY_HOST_UNAVAILABLE' =>
          'Harness could not open a terminal on $machine. '
              'Run harness start on that computer, then try again.',
        'ENGINE_LAUNCH_REFUSED' =>
          detail ?? 'This engine cannot start on $machine. Nothing was started.',
```

  Mobile `refusedBeforeLaunch`: after `'TMUX_UNAVAILABLE',` (line 4470) add `'PTY_HOST_UNAVAILABLE',` and
  `'ENGINE_LAUNCH_REFUSED',`.

  Mobile `_resumeFailure` (lines 4865-4867) becomes:

```dart
  String _resumeFailure(String code, Object? detail) =>
      code == 'PTY_HOST_UNAVAILABLE'
      ? 'Harness could not open a terminal on this machine. Run harness start on it, then try again.'
      : detail is String && detail.isNotEmpty
      ? detail
      : switch (code) {
```

  Mobile `retarget_refusal.dart`: the same two cases as desktop, after line 26's case.

- [ ] **Step 4: Run them and see them pass, plus the analyzers.**
  `cd desktop && flutter test test/swarm_async_test.dart test/agent_pause_state_test.dart test/retarget_refusal_test.dart test/stopped_harness_test.dart && flutter analyze lib/state`
  `cd mobile && flutter test test/app_state_agent_rpcs_test.dart test/phone_resume_agent_test.dart && flutter analyze lib/state`
  Expected: PASS, no analyzer issues.

- [ ] **Step 5: Commit.**
  `git add desktop/lib/state/app_state.dart desktop/lib/state/retarget_refusal.dart desktop/test/swarm_async_test.dart desktop/test/agent_pause_state_test.dart desktop/test/retarget_refusal_test.dart mobile/lib/state/app_state.dart mobile/lib/state/retarget_refusal.dart mobile/test/app_state_agent_rpcs_test.dart mobile/test/phone_resume_agent_test.dart`
  `git commit -m "feat(apps): say what to do when a Windows machine's terminals or an engine launch refuse"`

### Task B4.15: Hooks on in the Windows run: Claude Code, Codex, OpenCode and Kilo report their state

No product code forces `DISABLE_HOOK_INSTALL` on win32 (`env.ts:255` defaults to `false`). The Windows run turns it on
in `cli/scripts/windows-pty-e2e/env.cmd:9`. Spec section 4 sets the gate: hooks stop being off once the E2E shows the
four engines reporting.

**Files**
- Modify: `cli/scripts/windows-pty-e2e/env.cmd:9` (remove `set DISABLE_HOOK_INSTALL=true`)
- Modify: `cli/scripts/windows-pty-e2e/scenarios.mts` (append the `hooks` scenario)
- Create: `cli/src/lib/windows/hooksOn.spec.ts`
- Create: `cli/scripts/windows-pty-e2e/evidence/hooks.log`
- Modify: `docs/testing/windows-pty-e2e.md:7` (recipe step 7), `:421-422` (known limit), `:369-374` (F5/F6: what
  hooks change)

**Interfaces**
- Consumes: everything above. From B1: `cli/scripts/install.ps1`.
- Produces: the guard that nothing Windows ships or tests with turns hooks off, plus the E2E evidence spec section 6
  item 5 asks for (local half; B5 runs it from the Mac desktop).

- [ ] **Step 1: Write the failing guard.** Create `cli/src/lib/windows/hooksOn.spec.ts`:

```ts
// Engine hooks are on for Windows (spec section 4): neither the installer nor the Windows run turns them off.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['../../../scripts/install.ps1', '../../../scripts/windows-pty-e2e/env.cmd'])('%s leaves engine hooks on', (file) => {
  expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).not.toMatch(/DISABLE_HOOK_INSTALL/)
})
```

  `cd cli && npx vitest run src/lib/windows/hooksOn.spec.ts`. Expected: FAIL on `env.cmd`. `install.ps1` from B1
  already passes; if it fails, B1 sets the flag and that is a B1 defect to fix there.

- [ ] **Step 2: Turn hooks on.** Delete line 9 of `cli/scripts/windows-pty-e2e/env.cmd`. Run the guard again: PASS.

- [ ] **Step 3: Add the scenario.** Append to `cli/scripts/windows-pty-e2e/scenarios.mts`:

```ts
/**
 * Phase B4: each engine's hook (or plugin) binds the conversation of a pane on the pty host, through HARNESS_PANE and the
 * hook credential. `run.cmd hooks [engine…]`. The default is the four spec section 6 names.
 */
export async function hooks({ c, args, create, waitReady }: Ctx) {
  const engines = args.length ? args : ['claude', 'codex', 'opencode', 'kilo']
  for (const engine of engines) {
    await attempt(`${engine}: its hook binds the pane's conversation`, async () => {
      const agent = await create(engine)
      if (!agent) throw new Error('create refused (see the line above)')
      await waitReady(agent.id)
      const s = await c.open(agent.id, 120, 40)
      if (engine === 'claude' || engine === 'codex') await enginePrompt(c, s, engine)
      else await sleep(15_000)
      // Claude and Codex bind at SessionStart; the plugins bind when their engine creates a session, at the first prompt.
      c.input(s, 'Reply with the single word ok.\r')
      const row = await c.poll(`${engine} sessionId`, 120_000, async () => { const r = await c.row(agent.id); return r?.sessionId ? r : undefined })
      c.close(s)
      return `agent ${agent.id.slice(0, 8)} session ${row.sessionId} status ${row.status}`
    })
  }
  summary()
}
```

- [ ] **Step 4: Run it on the VM.**
  1. Back up the person's engine settings first, because the run writes Harness's hooks into the admin profile's real
     engine homes:
     `ssh admin@192.168.65.3 "mkdir C:\work\b4\backup & copy %USERPROFILE%\.claude\settings.json C:\work\b4\backup\ & copy %USERPROFILE%\.codex\hooks.json C:\work\b4\backup\ & copy %USERPROFILE%\.codex\config.toml C:\work\b4\backup\"`.
     A `hooks.json` that does not exist is fine; note which copies failed.
  2. Install Kilo: `npm install -g @kilocode/cli --allow-scripts=@kilocode/cli`.
     - OpenCode as B4.12 decided:
       - Outcome A: the version that works.
       - Outcome B: the x64 install command.
       - Outcome C: OpenCode is checked on windows-latest instead (step 5).
  3. `cli/scripts/windows-pty-e2e/vm-sync.sh --cli`. Build and copy the B4 install (B4 conventions: the bundle, the
     scripts with this task's `env.cmd`, and `e2e.mjs`, all under `C:\work\b4`), and start the B4 daemon with
     `C:\work\b4\launch.ps1`. `C:\work\e2e` is not touched.
  4. `ssh admin@192.168.65.3 "C:\work\b4\run.cmd hooks > C:\work\b4\hooks.out 2>&1 & type C:\work\b4\hooks.out"`.
     Copy the output to `cli/scripts/windows-pty-e2e/evidence/hooks.log`, together with the `[hooks]` lines of
     `C:\work\b4\daemon.log`. Expected:
     - `SUMMARY 4/4 passed`. Outcome C on the arm64 VM is 3/3 with `hooks claude codex kilo`, and OpenCode in step 5.
     - The daemon log shows "installed Claude session + turn … hooks" and "recorded Harness's own Codex hooks as
       reviewed".
     - No "hooks are not installed on Windows" line for these four.
     - No `unmatched … hook` lines for the bound agents.
  5. If OpenCode cannot run on the arm64 VM (outcome C), write that in `hooks.log`, and hand the OpenCode binding
     check to B5's windows-latest (x64) install job. B5 creates an OpenCode agent there and checks its `sessionId`.
     This phase's evidence then names three engines. Otherwise record "OpenCode verified on the VM".
  6. Checks to record in `hooks.log`:
     - **Codex review.** The Codex pane shows no "Hooks need review". If it does, `codex app-server` `hooks/list` names
       the key Codex expects. Compare it with the record in `config.toml`. If they differ, spell `settingsFile` for
       win32 in `prepareReviewed` (`kit/hookReview.ts`) the way Codex does, with a unit test, and run step 4 again.
     - **F5/F6.** Stop (`C:\work\b4\run.cmd delete <claude id>`) is no longer refused, and resume reopens the
       conversation (`C:\work\b4\run.cmd resume <id>`, `resumed: true`). F5 and F6 needed a bound `sessionId`.
     - **Plugin folders.** `dir %USERPROFILE%\.config\opencode\plugin %USERPROFILE%\.config\kilo\plugin` (B4.11 step 5).
  7. Clean up:
     - Delete the agents.
     - Restore the backups, and `del` any engine file that did not exist before.
     - `npm uninstall -g @kilocode/cli`.
     - `rmdir /s /q %USERPROFILE%\.config\kilo %USERPROFILE%\.local\share\kilo`.
     - Stop the B4 daemon with `C:\work\b4\stop.cmd`.
     - `C:\work\e2e` was never touched: record its daemon's pid before step 3 and after this step (the same).

- [ ] **Step 5: Record.** In `docs/testing/windows-pty-e2e.md`:
  - Recipe step 7: drop `DISABLE_HOOK_INSTALL=true` from the list.
  - Known limits, first bullet (line 421-422): replace it with "Hooks are on (sub-project B, Phase B4); see
    `evidence/hooks.log`".
  - Add one line under F5 and F6 with what step 4.6 showed.

- [ ] **Step 6: Commit.**
  `git add cli/scripts/windows-pty-e2e/env.cmd cli/scripts/windows-pty-e2e/scenarios.mts cli/src/lib/windows/hooksOn.spec.ts cli/scripts/windows-pty-e2e/evidence/hooks.log docs/testing/windows-pty-e2e.md`
  `git commit -m "test(windows): hooks on; Claude Code, Codex, OpenCode and Kilo bind their panes' conversations"`

### Task B4.16: `harness tui` says it is not available on Windows

Spec decision 5: `hn` is not ported. Today `tuiCommand` would try to download a Windows `harness-tui` that is
never published and fail with a download error. On win32 it says, in one sentence, that the terminal app is not
available on Windows yet, and points to the desktop app; `--where` prints `(not available on Windows)`.

**Files:**
- Modify: `cli/src/tui/index.ts:104-128` (`tuiCommand`)
- Test: `cli/src/tui/index.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier phases.
- Produces: `TUI_UNAVAILABLE_ON_WINDOWS: string` (exported, the sentence); `tuiCommand(argv, opts)` gains
  `opts.platform?: NodeJS.Platform` (default `process.platform`).

- [ ] **Step 1: Write the failing test.** Append to the `describe('harness tui launcher', …)` block in
  `cli/src/tui/index.spec.ts`:

```ts
  it('says the terminal app is not available on Windows, and starts or downloads nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await tuiCommand([], { port: 19418, platform: 'win32' })).toBe(1)
    expect(await tuiCommand(['--install'], { port: 19418, platform: 'win32' })).toBe(1)
    expect(errors.mock.calls.flat().join('\n')).toContain(TUI_UNAVAILABLE_ON_WINDOWS)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localDaemonStatus).not.toHaveBeenCalled()
  })

  it('answers --where on Windows without looking for a binary', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await tuiCommand(['--where'], { port: 19418, platform: 'win32' })).toBe(0)
    expect(logs).toHaveBeenCalledWith('(not available on Windows)')
  })
```

  and add `TUI_UNAVAILABLE_ON_WINDOWS` to the `./index.js` import at the top of the spec.

- [ ] **Step 2: Run it to see it fail.**
  Run: `cd cli && npx vitest run src/tui/index.spec.ts`
  Expected: FAIL — `TUI_UNAVAILABLE_ON_WINDOWS` is not exported (TypeScript/undefined), and `tuiCommand` spawns.

- [ ] **Step 3: Implement.** In `cli/src/tui/index.ts`, above `tuiCommand`:

```ts
/** `hn` is not built for Windows (spec B, decision 5): said once, in place of a download that cannot succeed. */
export const TUI_UNAVAILABLE_ON_WINDOWS =
  'The Harness terminal app (hn) is not available on Windows yet. Use the Harness desktop app, or `harness` commands.'
```

  and change the signature and first lines of `tuiCommand`:

```ts
export async function tuiCommand(
  argv: string[],
  opts: { port: number; dataDir?: string; identity?: () => string; platform?: NodeJS.Platform },
): Promise<number> {
  if ((opts.platform ?? process.platform) === 'win32') {
    if (argv[0] === '--where') { console.log('(not available on Windows)'); return 0 }
    console.error(`  ✗ ${TUI_UNAVAILABLE_ON_WINDOWS}`)
    return 1
  }
  if (argv[0] === '--install' || argv[0] === 'install') {
```

  (the rest of the function is unchanged). `cli.ts:2677` needs no change: it passes no `platform`.

- [ ] **Step 4: Run it to see it pass.**
  Run: `cd cli && npx vitest run src/tui/index.spec.ts && npx tsc --noEmit -p .`
  Expected: PASS; typecheck clean.

- [ ] **Step 5: Windows check.** After `vm-sync.sh --cli`:
  `ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && node dist\cli.js tui"` (or the built bundle the VM uses)
  Expected: the sentence, exit code 1, no download attempt in the output.

- [ ] **Step 6: Commit.**

```bash
git add cli/src/tui/index.ts cli/src/tui/index.spec.ts
git commit -m "feat(cli): harness tui says the terminal app is not available on Windows"
```

### Phase B4 notes

**Verified while writing this part (2026-10-16)**
- F9's real cause: `NativePaths.walk` (`nativePaths.ts:100`) splits only on `/`, so `directoryPath` loops on `C:\`
  256 times. `syncDirectoryChain` stops only at `/`, so it would loop the same way.
- VM probe (Node 24.20.0, NTFS):
  - fsync: on a read-only fd it is EPERM, on `O_RDWR` it works, and on a directory fd it is EPERM.
  - Modes: files read 0o100666, folders 0o40666, and the uid is 0.
  - A junction: `isSymbolicLink()` is true, `readlink` gives its target.
  - `rename` onto a file another process holds open is EPERM. `link` works.
  - `O_NOFOLLOW`, `O_DIRECTORY` and `O_NONBLOCK` are undefined.
- `claude.exe` 2.1.300 on the VM holds the exec-form schema tip (`command` + `args`) and a hook `shell` enum
  `["bash","powershell"]`. Claude's docs say shell form runs Git Bash, else PowerShell. Git for Windows is on the VM,
  but `bash` is not on PATH.
- Codex `rust-v0.162.1`: hooks run through `%COMSPEC% /C` with `raw_arg("\"<line>\"")`. `commandWindows` overrides
  `command`. The hash is over the resolved `command`, with `command_windows: None`. `HARNESS_PANE` is not in Codex's
  non-inheritable list.
- `command-code@1.82.3`: `hookShell()` is undefined on win32, which means Node `shell: true`. The `bin` names are
  `cmd`, `cmdc`, `command-code` and `commandcode`.
- Copilot docs: `command` fills `powershell` on Windows. `exec`/`args` exist in the CLI, but nothing was run.
- OpenCode 1.19.0 on the VM has `~\.config\opencode` and `~\.local\share\opencode`, and no `%APPDATA%` folder. npm
  `opencode-ai` 1.19.1 is current, and it ships `opencode-windows-x64` and `opencode-windows-arm64`.
- `validHookBody` rejects every `ptyhost` hint today. The core resolver already handles them.
- `notify.mjs` returns `''` for the credential on NTFS (mode and folder checks), so Windows hooks would have been 401.
- `os.homedir()` is `USERPROFILE` on Windows, and `vitest.setup.ts` redirects only `HOME`.
- No product code forces `DISABLE_HOOK_INSTALL`. Only the E2E `env.cmd` does.

**Open risks**
- **Codex's hook-review key on Windows.** A different spelling of the real path in the key would make Codex ask to
  review Harness's hooks. Checked in B4.15 step 6, with a fix rule.
- **Claude Code's oldest version with exec form is unknown.** An older Claude Code that ignores `args` would run
  `node.exe` with no script until the 5 s timeout. Claude Code updates itself; B5's E2E records the version.
- **Copilot under PowerShell 7 or 5.1.** `& '…'` works in both. It is untested on the VM (Copilot needs a GitHub
  sign-in to fire hooks).
- **Junction refusal.** A person whose `~\.claude` is a junction (for example, dotfiles) gets hooks held with
  "reparse point". The spec rule says so; the log line names it.
- **The plugin byte change** rewrites the OpenCode, Kilo and Pi plugin files once on every Mac and Linux machine.
- **Codex's `cmd /C` and a node path with `&`.** It is inside quotes, so it is safe. It is tested in B4.10, with a
  folder name that has `&` and parentheses.

**Decisions where the spec is silent**
- Decision: Claude Code's Windows runner is `argv` (exec form), not `bash`. Why: shell form runs Git Bash or, without it,
  PowerShell, and no single quoting serves both. Exec form needs no quoting, and `node.exe` is a real executable.
- Decision: Codex and Command Code use `cmd`, and Copilot uses `powershell`. Why: each is what that engine's own source
  or docs run (table in B4.6).
- Decision: Cursor, Devin, Grok, agy and Hermes declare no Windows runner, so no hooks are installed for them there,
  with one log line. Why: they cannot be installed through Harness on Windows, and their runners are unverified.
- Decision: the OpenCode, Kilo and Pi plugin fallback to `HARNESS_PANE` ships on every OS. Why: behavior under tmux is
  unchanged, and a mac pty host (opt-in `TERMINAL_BACKENDS=ptyhost`) gains it too. Amp is left as it is, because it is
  not on Windows.
- Decision: Agent Messages' inbox block and Harness's command allowance are not installed on Windows. Why: the inbox
  line is POSIX shell, and the allowance names `~/.local/bin/harness` while B1's launcher is `bin\harness.exe`. This is
  left for a later change.
- Decision: `nativeInstall.ts` keeps F2's win32 refusal unchanged. Why: install-first runs POSIX recipes
  (`buildEngineInstallationArgv` already throws on win32) and kills a process group. Its file writes reach Windows only
  through the shared writers, which B4.3–B4.4 fix.
- Decision: Windows hook forms are recognized only when the platform is win32. Why: the mac/Linux recognizers must give
  every input the answer they give today.
- Decision: the hook line names the stable `cli\notify.mjs` when the CLI runs from its installed Windows layout. Why:
  version folders change at each update, and a changed line makes Codex ask for review again.
- Decision: on Windows a read-only unchanged settings file is not flushed. Why: only a writable handle can be flushed
  there, and Harness did not write that file.
- Decision: `notify.mjs` on Windows trusts a credential inside the profile or inside the `--data-dir` its own line
  names. Why: that line sits in the person's profile, and the E2E data folder is outside the profile.
- Decision: the apps hide `PTY_HOST_UNAVAILABLE`'s detail and show `ENGINE_LAUNCH_REFUSED`'s. Why: the first is
  written for the log, and the second for the person.
- Decision: "stop forcing `DISABLE_HOOK_INSTALL`" means removing it from `env.cmd` and guarding `install.ps1`. Why: no
  product code sets it.
- Decision: if OpenCode cannot run on the arm64 VM (B4.12 outcome C), B5's windows-latest (x64) job checks its hook
  binding. Why: the only VM is Arm, and the x64 runner has OpenCode's working build.
- Decision: `vitest.setup.ts` does not redirect `USERPROFILE`. Why: `engineStart.real.spec.ts` needs the signed-in
  engines in the real profile, so the B4 real spec uses explicit temporary homes instead.


---

## Phase B5: Uninstall, Windows CI install job, E2E

`harness uninstall [--yes] [--keep-data]` on every OS (spec §5): it stops every harness through the running daemon,
takes the daemon out of its login service, stops it and the terminal host, removes the hooks with the installers' own
recognizers, removes the PATH entry and launchers, then the files (on Windows in a detached `cmd.exe` that waits for the
CLI to exit). The manual Windows workflow becomes `windows.yml` with an install job, and the VM end to end (spec §6) runs
as new local users and is recorded in `docs/testing/windows-cli-e2e.md`, beside real uninstall runs on macOS and Linux.

All paths are relative to the repository root. `cli/` commands run from `cli/`.

### Task B5.1: The installer's PATH lines in shell startup files

**Files**
- Create: `cli/src/lib/uninstall/rcFiles.ts`
- Create: `cli/src/lib/uninstall/rcFiles.spec.ts`
- Read (no change): `cli/scripts/install.sh:174-207`. `marker='# added by harness installer'` (line 177),
  `add_path_line='export PATH="$HOME/.local/bin:$PATH"'` (line 176), `ensure_rc` writes `printf '\n%s\n%s\n'`
  (line 182), the fish branch writes `printf '\n%s\nfish_add_path %s\n' "$marker" "$HOME/.local/bin"` (line 204).
  The lines already carry a marker comment, so install.sh needs no change. That marker is the only form since the
  installer moved here (`git log -S"# added by" -- cli/scripts/install.sh`: one form, commit `90dabd0ed`).

**Interfaces**
- Consumes: nothing from other phases.
- Produces: `RC_MARKER`, `SH_PATH_LINE`, `fishPathLine(home: string): string`,
  `rcFiles(home: string): RcFile[]`, `withoutHarnessPathLines(text: string, line: string): RcEdit`,
  `removeHarnessPathLines(home: string): RcOutcome[]`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/rcFiles.spec.ts`:

```ts
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RC_MARKER, SH_PATH_LINE, fishPathLine, rcFiles, removeHarnessPathLines, withoutHarnessPathLines } from './rcFiles.js'

const installed = (before: string) => `${before}\n${RC_MARKER}\n${SH_PATH_LINE}\n`

describe('withoutHarnessPathLines', () => {
  it('takes out the marker, the line under it and the blank line the installer put before them', () => {
    const edit = withoutHarnessPathLines(installed('alias ll="ls -l"\n'), SH_PATH_LINE)
    expect(edit).toEqual({ text: 'alias ll="ls -l"\n', removed: 1, changedByPerson: 0 })
  })

  it('leaves an empty file empty when the installer made it', () => {
    expect(withoutHarnessPathLines(installed(''), SH_PATH_LINE)).toEqual({ text: '', removed: 1, changedByPerson: 0 })
  })

  it('keeps a marker whose next line the person changed, and every other line', () => {
    const text = `export A=1\n\n${RC_MARKER}\nexport PATH="$HOME/.local/bin:/opt/x:$PATH"\nexport B=2\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 1 })
  })

  it('takes out every pair, and nothing between them', () => {
    const text = `${installed('a\n')}b\n\n${RC_MARKER}\n${SH_PATH_LINE}\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text: 'a\nb\n', removed: 2, changedByPerson: 0 })
  })

  it('reads the fish line with the home the installer expanded', () => {
    const text = `set -x A 1\n\n${RC_MARKER}\nfish_add_path /Users/u/.local/bin\n`
    expect(withoutHarnessPathLines(text, fishPathLine('/Users/u')).text).toBe('set -x A 1\n')
  })
})

describe('install.sh', () => {
  it('writes the lines this module removes', () => {
    const script = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'install.sh'), 'utf8')
    expect(script).toContain(`marker='${RC_MARKER}'`)
    expect(script).toContain(`add_path_line='${SH_PATH_LINE}'`)
    expect(script).toContain(`printf '\\n%s\\n%s\\n' "$marker" "$add_path_line"`)
    expect(script).toContain(`printf '\\n%s\\nfish_add_path %s\\n' "$marker" "$HOME/.local/bin"`)
  })
})

describe('removeHarnessPathLines', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('edits every startup file the installer wrote to, through a link without replacing it', () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-files-'))
    dirs.push(home)
    writeFileSync(join(home, '.zshrc'), installed('alias ll="ls -l"\n'), { mode: 0o640 })
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(join(home, 'dotfiles', 'bashrc'), installed('export A=1\n'))
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'))
    mkdirSync(join(home, '.config', 'fish'), { recursive: true })
    writeFileSync(join(home, '.config', 'fish', 'config.fish'), `\n${RC_MARKER}\n${fishPathLine(home)}\n`)
    writeFileSync(join(home, '.profile'), 'export UNTOUCHED=1\n')

    const outcomes = removeHarnessPathLines(home)

    expect(outcomes.map((o) => [o.file, o.removed])).toEqual([
      [join(home, '.zshrc'), 1], [join(home, '.bashrc'), 1], [join(home, '.config', 'fish', 'config.fish'), 1],
    ])
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n')
    expect(lstatSync(join(home, '.zshrc')).mode & 0o777).toBe(0o640)
    expect(readlinkSync(join(home, '.bashrc'))).toBe(join(home, 'dotfiles', 'bashrc'))
    expect(readFileSync(join(home, 'dotfiles', 'bashrc'), 'utf8')).toBe('export A=1\n')
    expect(readFileSync(join(home, '.config', 'fish', 'config.fish'), 'utf8')).toBe('')
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe('export UNTOUCHED=1\n')
  })

  it('names every file it looks at', () => {
    expect(rcFiles('/h').map((f) => f.file)).toEqual([
      '/h/.zshrc', '/h/.bashrc', '/h/.bash_profile', '/h/.bash_login', '/h/.profile', '/h/.config/fish/config.fish',
    ])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/rcFiles.spec.ts`
Expected: FAIL, `Failed to load url ./rcFiles.js` (the module does not exist).

- [ ] **Step 3: Implement** `cli/src/lib/uninstall/rcFiles.ts`:

```ts
/**
 * The PATH lines cli/scripts/install.sh adds to a shell's startup files (`ensure_rc`, `ensure_path_rc`), found by the
 * marker comment it writes above them, and taken out again by `harness uninstall`.
 *
 * Only the installer's exact pair goes: the marker and, on the next line, the line it wrote. A marker whose next line
 * the person changed is theirs now, and stays, as does every other line of the file.
 */
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** install.sh `marker`. */
export const RC_MARKER = '# added by harness installer'
/** install.sh `add_path_line`, for the sh family. */
export const SH_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
/** install.sh's fish line, with the home it expanded when it wrote it. */
export function fishPathLine(home: string): string {
  return `fish_add_path ${home}/.local/bin`
}

export interface RcFile { file: string; line: string }

/** Every startup file install.sh may have written to, whichever shell the person uses now. */
export function rcFiles(home: string): RcFile[] {
  return [
    ...['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => ({ file: join(home, name), line: SH_PATH_LINE })),
    { file: join(home, '.config', 'fish', 'config.fish'), line: fishPathLine(home) },
  ]
}

export interface RcEdit { text: string; removed: number; changedByPerson: number }

/** [text] without the installer's pairs, and the blank line it printed before each one. */
export function withoutHarnessPathLines(text: string, line: string): RcEdit {
  const lines = text.split('\n')
  const out: string[] = []
  let removed = 0
  let changedByPerson = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== RC_MARKER) { out.push(lines[i]); continue }
    if (lines[i + 1] !== line) { changedByPerson++; out.push(lines[i]); continue }
    // `printf '\n%s\n%s\n'`: the blank line before the marker is the installer's too.
    if (out.length > 0 && out[out.length - 1] === '') out.pop()
    removed++
    i++
  }
  return { text: out.join('\n'), removed, changedByPerson }
}

export interface RcOutcome { file: string; removed: number; changedByPerson: number; failed?: string }

/**
 * Take the installer's lines out of each startup file in [home]. A file that is a link is written through the link:
 * the installer's `>>` followed it, and a rename would replace somebody's dotfiles link with a copy.
 */
export function removeHarnessPathLines(home: string): RcOutcome[] {
  const outcomes: RcOutcome[] = []
  for (const { file, line } of rcFiles(home)) {
    let text: string
    let link: boolean
    let mode: number
    try {
      const info = lstatSync(file)
      link = info.isSymbolicLink()
      mode = info.mode & 0o777
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const edit = withoutHarnessPathLines(text, line)
    if (edit.removed === 0) {
      if (edit.changedByPerson) outcomes.push({ file, removed: 0, changedByPerson: edit.changedByPerson })
      continue
    }
    try {
      if (link) writeFileSync(file, edit.text)
      else {
        const temporary = `${file}.harness-uninstall-${process.pid}`
        writeFileSync(temporary, edit.text, { mode })
        renameSync(temporary, file)
      }
      outcomes.push({ file, removed: edit.removed, changedByPerson: edit.changedByPerson })
    } catch (error) {
      outcomes.push({ file, removed: 0, changedByPerson: edit.changedByPerson, failed: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall/rcFiles.spec.ts && npx tsc --noEmit`
Expected: 8 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/uninstall/rcFiles.ts cli/src/lib/uninstall/rcFiles.spec.ts
git commit -m "feat(cli): find and remove the installer's PATH lines in shell startup files"
```

### Task B5.2: Which launchers in `~/.local/bin` are Harness's

**Files**
- Modify: `cli/src/lib/launchers.ts` (add three exports after `ensureHnLauncher`, line 82; `EXEC_LINE` line 13 and
  `shellQuote` lines 84-86 are reused, the import on line 8 gains `readlinkSync`, line 9 gains `isAbsolute, relative, resolve`).
- Create: `cli/src/lib/launchers.spec.ts`

**Interfaces**
- Consumes: the launcher shapes `install.sh:735` (`exec '<node>' '<cli.js>' "$@"`), `install.sh:746` (hn:
  `exec '<bin>/harness' tui "$@"`), `install-cli.sh:178,188` (`exec "<node>" "<cli.js>" "$@"`), and the tmux link
  `install.sh:423` (`ln -sfn "$tmux_target/bin/tmux" "$BIN_DIR/tmux"`, the target under `~/.harness/runtime`).
- Produces: `isOwnHarnessLauncher(content: string, cliJs: string): boolean`,
  `isOwnHnLauncher(content: string, launcher: string): boolean`,
  `ownedBinEntries(binDir: string, cliJs: string, root: string): string[]`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/launchers.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isOwnHarnessLauncher, isOwnHnLauncher, ownedBinEntries } from './launchers.js'

const cli = '/Users/u/.harness/cli/cli.js'

describe('isOwnHarnessLauncher', () => {
  it('knows the three shapes that shipped', () => {
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '${cli}' "$@"\n`, cli)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "/n/node" "${cli}" "$@"\n`, cli)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\n# pinned\nADAPTER_UPDATE_DISABLE=true; export ADAPTER_UPDATE_DISABLE\nexec "/n/node" "${cli}" "$@"\n`, cli)).toBe(true)
  })

  it('is not somebody else\'s harness', () => {
    expect(isOwnHarnessLauncher('#!/bin/sh\nexec /opt/other/harness "$@"\n', cli)).toBe(false)
    expect(isOwnHarnessLauncher('#!/bin/sh\necho hi\n', cli)).toBe(false)
  })
})

describe('isOwnHnLauncher', () => {
  it('is only the exact delegation the installer writes', () => {
    expect(isOwnHnLauncher(`#!/bin/sh\nexec '/u/.local/bin/harness' tui "$@"\n`, '/u/.local/bin/harness')).toBe(true)
    expect(isOwnHnLauncher(`#!/bin/sh\nexec '/u/.local/bin/harness' tui "$@"\necho\n`, '/u/.local/bin/harness')).toBe(false)
  })
})

describe('ownedBinEntries', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('lists harness, hn and the managed tmux link, and nothing else in the folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const root = join(home, '.harness')
    const cliJs = join(root, 'cli', 'cli.js')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(root, 'runtime', 'tmux-3.7c', 'bin'), { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '/n/node' '${cliJs}' "$@"\n`)
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '${join(bin, 'harness')}' tui "$@"\n`)
    symlinkSync(join(root, 'runtime', 'tmux-3.7c', 'bin', 'tmux'), join(bin, 'tmux'))
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
    expect(ownedBinEntries(bin, cliJs, root)).toEqual([join(bin, 'harness'), join(bin, 'hn'), join(bin, 'tmux')])
  })

  it('leaves a tmux link to another tmux, and a harness that runs another bundle', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync('/opt/homebrew/bin/tmux', join(bin, 'tmux'))
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '/n/node' '/elsewhere/cli.js' "$@"\n`)
    expect(ownedBinEntries(bin, join(home, '.harness', 'cli', 'cli.js'), join(home, '.harness'))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/launchers.spec.ts`
Expected: FAIL, `isOwnHarnessLauncher is not a function` (not exported).

- [ ] **Step 3: Implement.** In `cli/src/lib/launchers.ts` change the imports (lines 8-9) to:

```ts
import { accessSync, constants, linkSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
```

and insert after `ensureHnLauncher` (after line 82, before `function shellQuote`):

```ts
/** Whether [content] is a `harness` launcher of ours: its one exec line runs [cliJs], in any of the shapes
 *  ensureLauncher knows (the same test it applies before it rewrites one). */
export function isOwnHarnessLauncher(content: string, cliJs: string): boolean {
  const exec = EXEC_LINE.exec(content)
  return !!exec && exec[0].includes(cliJs)
}

/** Whether [content] is the `hn` that the installer or ensureHnLauncher wrote, which hands everything to [launcher]. */
export function isOwnHnLauncher(content: string, launcher: string): boolean {
  return content === `#!/bin/sh\nexec ${shellQuote(launcher)} tui "$@"\n`
}

/**
 * The entries of the bin folder that are Harness's, for `harness uninstall`: the `harness` launcher that runs this
 * install's bundle, the `hn` that hands to it, and the `tmux` link install.sh points at the managed tmux under [root].
 * Anything else there, a `harness` or `hn` somebody else wrote included, is not ours to remove: the folder is shared
 * with Claude Code's installer, uv, pipx and the person's own scripts.
 */
export function ownedBinEntries(binDir: string, cliJs: string, root: string): string[] {
  const owned: string[] = []
  const regular = (path: string): string | null => {
    try { return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : null } catch { return null }
  }
  const launcher = join(binDir, 'harness')
  const harness = regular(launcher)
  if (harness !== null && isOwnHarnessLauncher(harness, cliJs)) owned.push(launcher)
  const hn = regular(join(binDir, 'hn'))
  if (hn !== null && isOwnHnLauncher(hn, launcher)) owned.push(join(binDir, 'hn'))
  try {
    const tmux = join(binDir, 'tmux')
    if (lstatSync(tmux).isSymbolicLink()) {
      const target = relative(root, resolve(binDir, readlinkSync(tmux)))
      if (target && !target.startsWith('..') && !isAbsolute(target)) owned.push(tmux)
    }
  } catch { /* no tmux link */ }
  return owned
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/launchers.spec.ts src/lib/runtimeInstall.spec.ts src/coreProcess.spec.ts && npx tsc --noEmit`
Expected: all pass (the two existing suites that cover `ensureLauncher`/`ensureHnLauncher` are unchanged).

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/launchers.ts cli/src/lib/launchers.spec.ts
git commit -m "feat(cli): tell Harness's launchers in ~/.local/bin from everybody else's"
```

### Task B5.3: Harness's folder out of the Windows user PATH

**Files**
- Create: `cli/src/lib/windows/powershell.ts`
- Create: `cli/src/lib/uninstall/windowsPath.ts`
- Create: `cli/src/lib/uninstall/windowsPath.spec.ts`
- Create: `cli/src/lib/uninstall/windowsPath.real.spec.ts` (runs on Windows only)

**Interfaces**
- Consumes (B1): `install.ps1` adds `%USERPROFILE%\.harness\bin` to `HKCU\Environment` `Path` (spec §1 step 4). The
  remover matches the folder whether B1 wrote it expanded or as `%USERPROFILE%\.harness\bin`, any case, with or
  without a trailing backslash or quotes.
- Produces: `powershellPath(env?): string`, `encodedCommandArgs(script: string): string[]`,
  `withUtf8Output(script: string): string` (every script `runPowershell` runs prints UTF-8),
  `type PowershellRun = (script: string, inputs?: Record<string, string>) => PowershellResult`, `runPowershell`;
  `expandWindowsVariables(entry, env)`, `withoutPathEntry(value: string, folder: string, env): string | null`,
  `removeUserPathEntry(folder: string, run: PowershellRun, env?, name?): PathRemoval`,
  `type PathRemoval = { state: 'removed' | 'absent'; folder: string } | { state: 'failed'; folder: string; detail: string }`.
  No earlier phase adds a PowerShell runner under `cli/src/lib/windows/` (B1's installer specs drive `powershell.exe`
  from their own test code), so this task owns `powershell.ts`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/windowsPath.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { encodedCommandArgs, powershellPath, withUtf8Output, type PowershellResult } from '../windows/powershell.js'
import { expandWindowsVariables, removeUserPathEntry, withoutPathEntry } from './windowsPath.js'

const env = { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const bin = 'C:\\Users\\u\\.harness\\bin'

describe('withoutPathEntry', () => {
  it('drops the folder however it was written, and keeps every other entry as written', () => {
    expect(withoutPathEntry(`%LOCALAPPDATA%\\Microsoft\\WindowsApps;${bin};C:\\tools`, bin, env))
      .toBe('%LOCALAPPDATA%\\Microsoft\\WindowsApps;C:\\tools')
    expect(withoutPathEntry('C:\\tools;%USERPROFILE%\\.harness\\bin', bin, env)).toBe('C:\\tools')
    expect(withoutPathEntry('C:\\tools;"c:\\users\\U\\.HARNESS\\bin\\";;D:\\x', bin, env)).toBe('C:\\tools;;D:\\x')
  })

  it('is null when the folder is not there, and empty when it was the only entry', () => {
    expect(withoutPathEntry('C:\\tools;C:\\Users\\u\\.harness\\bin2', bin, env)).toBeNull()
    expect(withoutPathEntry(bin, bin, env)).toBe('')
  })

  it('reads %NAME% as Windows does, and leaves a name it does not know', () => {
    expect(expandWindowsVariables('%userprofile%\\x;%NOPE%\\y', env)).toBe('C:\\Users\\u\\x;%NOPE%\\y')
  })
})

describe('powershell', () => {
  it('runs Windows PowerShell by its full path, with the script encoded', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const args = encodedCommandArgs('Write-Output "é"')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toBe('Write-Output "é"')
  })

  it('makes every script print UTF-8, so a non-ASCII PATH entry reaches Node unchanged', () => {
    // Into a pipe, Windows PowerShell writes the console's OEM code page: a profile named `Jö` would come back changed.
    expect(withUtf8Output('Write-Output 1')).toBe('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\nWrite-Output 1')
  })
})

describe('removeUserPathEntry', () => {
  const ok = (stdout: string): PowershellResult => ({ status: 0, stdout, stderr: '' })
  function runner(...answers: PowershellResult[]) {
    const calls: Array<{ script: string; inputs: Record<string, string> }> = []
    return { calls, run: (script: string, inputs: Record<string, string> = {}) => { calls.push({ script, inputs }); return answers.shift()! } }
  }

  it('writes the value back without the folder, as the kind it was, and says so', () => {
    const r = runner(ok(JSON.stringify({ value: `C:\\tools;${bin}`, kind: 'ExpandString' })), ok(''))
    expect(removeUserPathEntry(bin, r.run, env)).toEqual({ state: 'removed', folder: bin })
    expect(r.calls[0].inputs).toEqual({ HARNESS_PATH_NAME: 'Path' })
    expect(r.calls[1].inputs).toEqual({ HARNESS_PATH_NAME: 'Path', HARNESS_PATH_VALUE: 'C:\\tools', HARNESS_PATH_KIND: 'ExpandString' })
    expect(r.calls[1].script).toContain('SendMessageTimeout')
  })

  it('writes nothing when the folder is not on it, or there is no user PATH', () => {
    const absent = runner(ok(JSON.stringify({ value: 'C:\\tools', kind: 'String' })))
    expect(removeUserPathEntry(bin, absent.run, env)).toEqual({ state: 'absent', folder: bin })
    expect(absent.calls).toHaveLength(1)
    const none = runner(ok(JSON.stringify({ value: null, kind: 'None' })))
    expect(removeUserPathEntry(bin, none.run, env)).toEqual({ state: 'absent', folder: bin })
  })

  it('says what failed, and never edits a value of another kind', () => {
    expect(removeUserPathEntry(bin, runner({ status: 1, stdout: '', stderr: 'denied' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not read your PATH (denied)' })
    expect(removeUserPathEntry(bin, runner(ok(JSON.stringify({ value: bin, kind: 'MultiString' }))).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'your PATH is a MultiString value, which Harness does not edit' })
    expect(removeUserPathEntry(bin, runner(ok(JSON.stringify({ value: bin, kind: 'String' })), { status: 5, stdout: '', stderr: 'no' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not write your PATH (no)' })
  })
})
```

and `cli/src/lib/uninstall/windowsPath.real.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runPowershell } from '../windows/powershell.js'
import { removeUserPathEntry } from './windowsPath.js'

// The real registry, on Windows only: a value of this test's own beside Path, never Path itself.
describe.runIf(process.platform === 'win32')('removeUserPathEntry on this account', () => {
  it('removes the folder from an ExpandString value and keeps its other entries unexpanded', () => {
    const name = `HarnessUninstallTest${process.pid}`
    const set = runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('${name}', '%USERPROFILE%\\x;%USERPROFILE%\\.harness\\bin', [Microsoft.Win32.RegistryValueKind]::ExpandString)`)
    expect(set.status, set.stderr).toBe(0)
    try {
      expect(removeUserPathEntry(`${process.env.USERPROFILE}\\.harness\\bin`, runPowershell, process.env, name).state).toBe('removed')
      const read = runPowershell(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); [Console]::Out.Write($k.GetValue('${name}', '', 'DoNotExpandEnvironmentNames') + '|' + $k.GetValueKind('${name}'))`)
      expect(read.stdout).toBe('%USERPROFILE%\\x|ExpandString')
    } finally {
      runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).DeleteValue('${name}', $false)`)
    }
  })

  it('removes a folder under a non-ASCII profile, and keeps a non-ASCII entry byte for byte', () => {
    const name = `HarnessUninstallTestU${process.pid}`
    const profile = 'C:\\Users\\J\u00f6 \u65e5'
    const kept = `${profile}\\tools`
    const inputs = { HARNESS_TEST_NAME: name, HARNESS_TEST_VALUE: `${kept};${profile}\\.harness\\bin` }
    const set = runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue($env:HARNESS_TEST_NAME, $env:HARNESS_TEST_VALUE, [Microsoft.Win32.RegistryValueKind]::ExpandString)`, inputs)
    expect(set.status, set.stderr).toBe(0)
    try {
      expect(removeUserPathEntry(`${profile}\\.harness\\bin`, runPowershell, process.env, name).state).toBe('removed')
      const read = runPowershell(`[Console]::Out.Write([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue($env:HARNESS_TEST_NAME, '', 'DoNotExpandEnvironmentNames'))`, inputs)
      expect(read.stdout).toBe(kept)
    } finally {
      runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).DeleteValue($env:HARNESS_TEST_NAME, $false)`, inputs)
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/windowsPath.spec.ts`
Expected: FAIL, `Failed to load url ../windows/powershell.js`.

- [ ] **Step 3: Implement** `cli/src/lib/windows/powershell.ts`:

```ts
/**
 * A short PowerShell script run from the CLI on Windows: Windows PowerShell 5.1 by its full path (every Windows has
 * it, and a `powershell` earlier on PATH is not ours to run), the script as -EncodedCommand (UTF-16LE, base64) so
 * nothing in it is quoted twice by cmd and PowerShell, and its inputs in environment variables, never in its text.
 */
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

export const POWERSHELL_TIMEOUT_MS = 30_000

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function encodedCommandArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/**
 * [script], printing UTF-8. Into a pipe Windows PowerShell 5.1 writes the console's OEM code page, which Node would
 * decode as UTF-8: a PATH entry under a profile named `Jö` or `日` would never match, and one written back would hold
 * U+FFFD. Every script runPowershell runs starts with this line.
 */
export function withUtf8Output(script: string): string {
  return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`
}

export interface PowershellResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type PowershellRun = (script: string, inputs?: Record<string, string>) => PowershellResult

export const runPowershell: PowershellRun = (script, inputs = {}) => {
  const result = spawnSync(powershellPath(), encodedCommandArgs(withUtf8Output(script)), {
    env: { ...process.env, ...inputs }, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}
```

and `cli/src/lib/uninstall/windowsPath.ts`:

```ts
/**
 * `harness uninstall` on Windows: Harness's bin folder out of the user's PATH (`HKCU\Environment`), where install.ps1
 * put it (spec section 1, step 4). Never the machine PATH, which Harness never touches.
 *
 * The value is read raw (DoNotExpandEnvironmentNames) and written back as the kind it was: a round trip through
 * .NET's Environment API expands every %VARIABLE% in the person's other entries and stores them as plain strings.
 * Then WM_SETTINGCHANGE, so a terminal opened afterwards no longer has the folder.
 */
import { win32 } from 'node:path'
import type { PowershellRun } from '../windows/powershell.js'

/** How Windows compares PATH folders: case-insensitively, quotes and trailing separators aside. */
function folderKey(entry: string): string {
  return win32.normalize(entry.trim().replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '').toLowerCase()
}

/** %NAME% read from [env] as Windows does (names are case-insensitive); an unknown name stays as written. */
export function expandWindowsVariables(entry: string, env: NodeJS.ProcessEnv): string {
  const byName = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
  return entry.replace(/%([^%;]+)%/g, (whole, name: string) => byName.get(name.toLowerCase()) ?? whole)
}

/** [value] without the entries that name [folder], every other entry exactly as written; null when none names it. */
export function withoutPathEntry(value: string, folder: string, env: NodeJS.ProcessEnv): string | null {
  const target = folderKey(folder)
  const parts = value.split(';')
  const kept = parts.filter((part) => part.trim() === '' || folderKey(expandWindowsVariables(part, env)) !== target)
  return kept.length === parts.length ? null : kept.join(';')
}

const READ = String.raw`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$v = if ($k) { $k.GetValue($env:HARNESS_PATH_NAME, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$kind = if ($null -ne $v) { $k.GetValueKind($env:HARNESS_PATH_NAME).ToString() } else { 'None' }
[Console]::Out.Write((ConvertTo-Json -Compress @{ value = $v; kind = $kind }))`

const WRITE = String.raw`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ([string]::IsNullOrEmpty($env:HARNESS_PATH_VALUE)) { $k.DeleteValue($env:HARNESS_PATH_NAME, $false) }
else { $k.SetValue($env:HARNESS_PATH_NAME, $env:HARNESS_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]$env:HARNESS_PATH_KIND) }
Add-Type -Namespace HarnessUninstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
$r = [System.UIntPtr]::Zero
[void][HarnessUninstall.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$r)`

export type PathRemoval =
  | { state: 'removed' | 'absent'; folder: string }
  | { state: 'failed'; folder: string; detail: string }

const why = (result: { error?: Error; stderr: string; status: number | null }): string =>
  result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)

/** Take [folder] out of the user's PATH (value [name]; tests use one of their own). */
export function removeUserPathEntry(folder: string, run: PowershellRun, env: NodeJS.ProcessEnv = process.env, name = 'Path'): PathRemoval {
  const read = run(READ, { HARNESS_PATH_NAME: name })
  if (read.error || read.status !== 0) return { state: 'failed', folder, detail: `could not read your PATH (${why(read)})` }
  let current: { value: string | null; kind: string }
  try { current = JSON.parse(read.stdout) } catch { return { state: 'failed', folder, detail: 'could not read your PATH (an answer that is not JSON)' } }
  if (current.value === null) return { state: 'absent', folder }
  if (current.kind !== 'String' && current.kind !== 'ExpandString') {
    return { state: 'failed', folder, detail: `your PATH is a ${current.kind} value, which Harness does not edit` }
  }
  const next = withoutPathEntry(current.value, folder, env)
  if (next === null) return { state: 'absent', folder }
  const written = run(WRITE, { HARNESS_PATH_NAME: name, HARNESS_PATH_VALUE: next, HARNESS_PATH_KIND: current.kind })
  if (written.error || written.status !== 0) return { state: 'failed', folder, detail: `could not write your PATH (${why(written)})` }
  return { state: 'removed', folder }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall/windowsPath.spec.ts src/lib/uninstall/windowsPath.real.spec.ts && npx tsc --noEmit`
Expected: 8 pass, the real spec skipped on the Mac; typecheck clean.

- [ ] **Step 5: Windows verification (VM)**

Run: `cli/scripts/windows-pty-e2e/vm-sync.sh --cli && ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && (if not exist node_modules npm ci) && npx vitest run src/lib/uninstall/windowsPath"`
Expected: 10 pass, the two real cases included (the non-ASCII one is the code page check). Afterwards
`ssh admin@192.168.65.3 "reg query HKCU\Environment"` shows no `HarnessUninstallTest*` value.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/windows/powershell.ts cli/src/lib/uninstall/windowsPath.ts cli/src/lib/uninstall/windowsPath.spec.ts cli/src/lib/uninstall/windowsPath.real.spec.ts
git commit -m "feat(cli): remove Harness's folder from the Windows user PATH"
```

### Task B5.4: What goes, and the last step on Windows

**Files**
- Create: `cli/src/lib/uninstall/removal.ts`
- Create: `cli/src/lib/uninstall/removal.spec.ts`
- Create: `cli/src/lib/uninstall/removal.real.spec.ts` (runs on Windows only)

**Interfaces**
- Consumes: `PowershellRun` (B5.3); the layout of `~\.harness` (spec §1, B1: `bin\`, `cli\<version>\`, `cli\current`,
  `cli\notify.mjs`, `cli\data\`, `runtime\`, `runtime\pty\`).
- Produces: `type RootEntry = { name: string; dir: boolean }`, `type RemovalTarget = { path: string; dir: boolean }`,
  `type RemovalPlan = { root: string; remove: RemovalTarget[]; kept: string[]; removeRoot: boolean }`,
  `DESKTOP_STATE`, `PROGRAM`, `removalPlan(input): RemovalPlan`, `listEntries(dir): RootEntry[]`,
  `removeNow(plan): string[]`, `finalRemovalScript({ pid, plan, log, systemRoot }): string`,
  `scheduleFinalRemoval(plan, deps: FinalRemovalDeps): FinalRemoval`, `finalRemovalDeps(): FinalRemovalDeps`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/removal.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalRemovalScript, listEntries, removalPlan, removeNow, scheduleFinalRemoval, type FinalRemovalDeps, type RootEntry } from './removal.js'

const d = (name: string): RootEntry => ({ name, dir: true })
const f = (name: string): RootEntry => ({ name, dir: false })
const mac = { platform: 'darwin' as const, root: '/u/.harness', cliDir: '/u/.harness/cli', dataDir: '/u/.harness/cli/data' }
const entries = [d('auth'), d('bin'), d('cli'), f('computer-id'), d('desktop-app-v2'), d('dsh'), d('runtime'), d('pty'), d('tui')]
const cliEntries = [f('cli.js'), f('notify.mjs'), f('package.json'), d('data')]

describe('removalPlan', () => {
  it('takes the whole root but the desktop app\'s own state', () => {
    const plan = removalPlan({ ...mac, entries, cliEntries, keepData: false })
    expect(plan.remove.map((t) => t.path)).toEqual(['auth', 'bin', 'cli', 'computer-id', 'dsh', 'runtime', 'pty', 'tui'].map((n) => `/u/.harness/${n}`))
    expect(plan.kept).toEqual(['desktop-app-v2'])
    expect(plan.removeRoot).toBe(false)
    expect(removalPlan({ ...mac, entries: entries.filter((e) => e.name !== 'desktop-app-v2'), cliEntries, keepData: false }).removeRoot).toBe(true)
  })

  it('with --keep-data takes the program only', () => {
    const plan = removalPlan({ ...mac, entries, cliEntries, keepData: true })
    expect(plan.remove).toEqual([
      { path: '/u/.harness/bin', dir: true }, { path: '/u/.harness/runtime', dir: true }, { path: '/u/.harness/pty', dir: true },
      { path: '/u/.harness/cli/cli.js', dir: false }, { path: '/u/.harness/cli/notify.mjs', dir: false }, { path: '/u/.harness/cli/package.json', dir: false },
    ])
    expect(plan.kept).toEqual(['auth', 'computer-id', 'desktop-app-v2', 'dsh', 'tui', 'cli/data'])
    expect(plan.removeRoot).toBe(false)
  })

  it('uses Windows paths for a Windows root, version folders and pointers included', () => {
    const plan = removalPlan({
      platform: 'win32', root: 'C:\\Users\\u\\.harness', cliDir: 'C:\\Users\\u\\.harness\\cli', dataDir: 'C:\\Users\\u\\.harness\\cli\\data',
      entries: [d('bin'), d('cli'), d('runtime')], cliEntries: [d('0.5.1'), d('0.5.2'), f('current'), f('notify.mjs'), d('data')], keepData: true,
    })
    expect(plan.remove.map((t) => t.path)).toEqual([
      'C:\\Users\\u\\.harness\\bin', 'C:\\Users\\u\\.harness\\runtime', 'C:\\Users\\u\\.harness\\cli\\0.5.1',
      'C:\\Users\\u\\.harness\\cli\\0.5.2', 'C:\\Users\\u\\.harness\\cli\\current', 'C:\\Users\\u\\.harness\\cli\\notify.mjs',
    ])
    expect(plan.kept).toEqual(['cli\\data'])
  })

  it('leaves a CLI folder that is not the product root\'s (ADAPTER_CLI_DIR set elsewhere)', () => {
    const plan = removalPlan({ ...mac, cliDir: '/opt/harness-cli', entries: [d('bin'), d('auth')], cliEntries, keepData: true })
    expect(plan.remove.map((t) => t.path)).toEqual(['/u/.harness/bin'])
  })
})

describe('removeNow', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('removes the plan and the root, and says what is left', () => {
    const home = mkdtempSync(join(tmpdir(), 'removal-'))
    dirs.push(home)
    const root = join(home, '.harness')
    mkdirSync(join(root, 'cli', 'data'), { recursive: true })
    writeFileSync(join(root, 'cli', 'cli.js'), '')
    writeFileSync(join(root, 'computer-id'), 'x')
    const plan = removalPlan({ platform: 'darwin', root, cliDir: join(root, 'cli'), dataDir: join(root, 'cli', 'data'), entries: listEntries(root), cliEntries: listEntries(join(root, 'cli')), keepData: false })
    expect(removeNow(plan)).toEqual([])
    expect(existsSync(root)).toBe(false)
  })
})

describe('finalRemovalScript', () => {
  const plan = {
    root: 'C:\\Users\\u 100%\\.harness', removeRoot: true, kept: [],
    remove: [{ path: 'C:\\Users\\u 100%\\.harness\\bin', dir: true }, { path: 'C:\\Users\\u 100%\\.harness\\cli\\current', dir: false }],
  }
  const script = finalRemovalScript({ pid: 4321, plan, log: 'C:\\T\\harness-uninstall-4321.log', systemRoot: 'C:\\Windows' })

  it('waits for this process, then removes each path and the root, with every % doubled', () => {
    const lines = script.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(lines).toContain('"C:\\Windows\\System32\\tasklist.exe" /FI "PID eq 4321" /NH 2>nul | "C:\\Windows\\System32\\find.exe" " 4321 " >nul')
    expect(lines).toContain('rmdir /s /q "C:\\Users\\u 100%%\\.harness\\bin" 2>nul')
    expect(lines).toContain('del /f /q "C:\\Users\\u 100%%\\.harness\\cli\\current" 2>nul')
    expect(lines).toContain('rmdir /s /q "C:\\Users\\u 100%%\\.harness" 2>nul')
    expect(lines.indexOf(':remove')).toBeGreaterThan(lines.indexOf(':wait'))
  })

  it('lists what stayed in its log, escaped for echo, and deletes itself without cmd reading it again', () => {
    expect(script).toContain('if exist "C:\\Users\\u 100%%\\.harness\\bin" >>"C:\\T\\harness-uninstall-4321.log" echo C:\\Users\\u 100%%\\.harness\\bin')
    expect(script.trimEnd().endsWith('(goto) 2>nul & del "%~f0"')).toBe(true)
  })
})

describe('scheduleFinalRemoval', () => {
  const plan = { root: 'C:\\U\\.harness', remove: [], kept: [], removeRoot: true }
  function deps(overrides: Partial<FinalRemovalDeps> = {}) {
    const written: string[] = []
    const spawned: string[][] = []
    const scripts: Array<Record<string, string>> = []
    const base: FinalRemovalDeps = {
      pid: 77, tempDir: 'C:\\T', systemRoot: 'C:\\Windows', now: () => 1000,
      write: (path) => { written.push(path) },
      powershell: (_script, inputs = {}) => { scripts.push(inputs); return { status: 0, stdout: '', stderr: '' } },
      spawnDetached: (file, args) => { spawned.push([file, ...args]) },
      ...overrides,
    }
    return { base, written, spawned, scripts }
  }

  it('starts cmd.exe through WMI, outside this process\'s job', () => {
    const t = deps()
    expect(scheduleFinalRemoval(plan, t.base)).toEqual({ ok: true, script: 'C:\\T\\harness-uninstall-77-1000.cmd', log: 'C:\\T\\harness-uninstall-77-1000.log', via: 'wmi' })
    expect(t.written).toEqual(['C:\\T\\harness-uninstall-77-1000.cmd'])
    expect(t.scripts[0]).toEqual({ HARNESS_CMD: 'C:\\Windows\\System32\\cmd.exe', HARNESS_UNINSTALL_SCRIPT: 'C:\\T\\harness-uninstall-77-1000.cmd', HARNESS_UNINSTALL_CWD: 'C:\\T' })
    expect(t.spawned).toEqual([])
  })

  it('falls back to a detached spawn when WMI refuses, and reports a script it could not write', () => {
    const t = deps({ powershell: () => ({ status: 3, stdout: '', stderr: 'Win32_Process.Create returned 2' }) })
    expect(scheduleFinalRemoval(plan, t.base)).toMatchObject({ ok: true, via: 'spawn' })
    expect(t.spawned).toEqual([['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '""C:\\T\\harness-uninstall-77-1000.cmd""']])
    const unwritable = deps({ write: () => { throw new Error('EACCES') } })
    expect(scheduleFinalRemoval(plan, unwritable.base)).toEqual({ ok: false, detail: 'could not write C:\\T\\harness-uninstall-77-1000.cmd: EACCES' })
  })
})
```

and `cli/src/lib/uninstall/removal.real.spec.ts`:

```ts
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalRemovalDeps, listEntries, removalPlan, scheduleFinalRemoval } from './removal.js'

// The real last step, on Windows only: a cmd.exe that waits for a process (a node.exe standing in for the CLI, holding
// a file open in the tree) to exit, then removes the tree and itself.
describe.runIf(process.platform === 'win32')('the last step of harness uninstall', () => {
  it('removes the tree once the process has exited, and leaves no script or log', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'final-removal-')), '.harness')
    mkdirSync(join(root, 'cli', '0.5.1'), { recursive: true })
    writeFileSync(join(root, 'cli', '0.5.1', 'cli.js'), '')
    writeFileSync(join(root, 'cli', 'current'), '0.5.1\n')
    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(join(root, 'cli', 'current'))}, 'r'); setTimeout(() => {}, 3000)`], { stdio: 'ignore' })
    const plan = removalPlan({ platform: 'win32', root, cliDir: join(root, 'cli'), dataDir: join(root, 'cli', 'data'), entries: listEntries(root), cliEntries: listEntries(join(root, 'cli')), keepData: false })
    const scheduled = scheduleFinalRemoval(plan, { ...finalRemovalDeps(), pid: holder.pid! })
    expect(scheduled.ok).toBe(true)
    const deadline = Date.now() + 30_000
    while (existsSync(root) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
    expect(existsSync(root)).toBe(false)
    await new Promise((r) => setTimeout(r, 1000))
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(`harness-uninstall-${holder.pid}-`))).toEqual([])
  }, 40_000)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/removal.spec.ts`
Expected: FAIL, `Failed to load url ./removal.js`.

- [ ] **Step 3: Implement** `cli/src/lib/uninstall/removal.ts`:

```ts
/**
 * The files `harness uninstall` removes, and how. `~/.harness` holds both the program (bin, runtime, pty, the CLI's
 * bundles) and the person's data (sign-in, this computer's identity, history, settings, hn's state): without
 * --keep-data both go, with it the program only. The desktop app keeps its own state in the same root
 * (`desktop-app-v2`); that is the app's, which its own uninstall removes, and never this command's.
 *
 * mac and Linux delete a running program's files at once. Windows cannot delete the node.exe the CLI runs from, nor a
 * folder a process has open, so there the files go in a cmd.exe that waits for the CLI's process to exit, started
 * through WMI so that it is outside the CLI's job: an SSH session (OpenSSH ends every process of its job at the end of
 * the session, docs/testing/windows-pty-e2e.md F16) or a terminal closing would end it half way.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runPowershell, type PowershellRun } from '../windows/powershell.js'

export interface RootEntry { name: string; dir: boolean }
export interface RemovalTarget { path: string; dir: boolean }
export interface RemovalPlan { root: string; remove: RemovalTarget[]; kept: string[]; removeRoot: boolean }

/** The desktop app's own state in the product root. */
export const DESKTOP_STATE = /^desktop-app/
/** The program, as --keep-data reads the root: the rest of it is the person's data. */
export const PROGRAM = new Set(['bin', 'runtime', 'pty'])

export interface PlanInput {
  platform: NodeJS.Platform
  root: string
  entries: readonly RootEntry[]
  cliDir: string
  cliEntries: readonly RootEntry[]
  dataDir: string
  keepData: boolean
}

export function removalPlan(o: PlanInput): RemovalPlan {
  const p = o.platform === 'win32' ? win32 : posix
  const at = (dir: string) => (entry: RootEntry): RemovalTarget => ({ path: p.join(dir, entry.name), dir: entry.dir })
  if (!o.keepData) {
    const kept = o.entries.filter((e) => DESKTOP_STATE.test(e.name)).map((e) => e.name)
    return { root: o.root, remove: o.entries.filter((e) => !DESKTOP_STATE.test(e.name)).map(at(o.root)), kept, removeRoot: kept.length === 0 }
  }
  // The CLI's folder is the program's only when it is the root's own `cli` (ADAPTER_CLI_DIR can name another).
  const cliHere = p.resolve(o.cliDir) === p.resolve(o.root, 'cli')
  const data = p.resolve(o.dataDir)
  const isData = (entry: RootEntry) => p.resolve(o.cliDir, entry.name) === data
  return {
    root: o.root,
    remove: [...o.entries.filter((e) => PROGRAM.has(e.name)).map(at(o.root)), ...(cliHere ? o.cliEntries.filter((e) => !isData(e)).map(at(o.cliDir)) : [])],
    kept: [
      ...o.entries.filter((e) => !PROGRAM.has(e.name) && !(cliHere && e.name === 'cli')).map((e) => e.name),
      ...(cliHere && o.cliEntries.some(isData) ? [p.join('cli', p.basename(data))] : []),
    ],
    removeRoot: false,
  }
}

/** Every entry of [dir]; none when it is missing. A link is not a folder: removing it removes the link. */
export function listEntries(dir: string): RootEntry[] {
  try { return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() })) } catch { return [] }
}

/** mac and Linux: the plan, carried out now. Returns what is still there. */
export function removeNow(plan: RemovalPlan): string[] {
  const all = [...plan.remove.map((t) => t.path), ...(plan.removeRoot ? [plan.root] : [])]
  for (const path of all) { try { rmSync(path, { recursive: true, force: true }) } catch { /* reported below */ } }
  return all.filter((path) => existsSync(path))
}

/** How long the script waits for the CLI to exit (one try a second), and how often it tries a path that is busy. */
export const WAIT_TRIES = 120
export const REMOVE_PASSES = 10

/** A path inside double quotes in a batch file: cmd expands % even there. */
const quoted = (path: string): string => `"${path.replace(/%/g, '%%')}"`
/** A path as `echo` prints it: % doubled and cmd's operators escaped. */
const echoed = (path: string): string => path.replace(/%/g, '%%').replace(/[\^&|<>()]/g, (c) => `^${c}`)

/**
 * The cmd.exe script of the last step: wait for [pid] (the CLI) to exit, then remove each path, retrying a busy one
 * (an antivirus scan, a process still letting go) a few times, list what stayed in [log], and delete itself.
 * Every tool by its full path; `(goto) 2>nul & del` deletes the script without cmd reading it again afterwards.
 */
export function finalRemovalScript(o: { pid: number; plan: RemovalPlan; log: string; systemRoot: string }): string {
  const tool = (name: string) => quoted(win32.join(o.systemRoot, 'System32', name))
  const targets = [...o.plan.remove, ...(o.plan.removeRoot ? [{ path: o.plan.root, dir: true }] : [])]
  return [
    '@echo off',
    `${tool('chcp.com')} 65001 >nul`,
    'set tries=0',
    ':wait',
    `${tool('tasklist.exe')} /FI "PID eq ${o.pid}" /NH 2>nul | ${tool('find.exe')} " ${o.pid} " >nul`,
    'if errorlevel 1 goto remove',
    'set /a tries+=1',
    `if %tries% GEQ ${WAIT_TRIES} goto remove`,
    `${tool('PING.EXE')} -n 2 127.0.0.1 >nul`,
    'goto wait',
    ':remove',
    'set pass=0',
    ':again',
    ...targets.map((t) => (t.dir ? `rmdir /s /q ${quoted(t.path)} 2>nul` : `del /f /q ${quoted(t.path)} 2>nul`)),
    'set left=0',
    ...targets.map((t) => `if exist ${quoted(t.path)} set left=1`),
    'if %left%==0 goto done',
    'set /a pass+=1',
    `if %pass% GEQ ${REMOVE_PASSES} goto report`,
    `${tool('PING.EXE')} -n 3 127.0.0.1 >nul`,
    'goto again',
    ':report',
    `>${quoted(o.log)} echo Harness could not remove these after harness uninstall (a program still had them open):`,
    ...targets.map((t) => `if exist ${quoted(t.path)} >>${quoted(o.log)} echo ${echoed(t.path)}`),
    ':done',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n')
}

export interface FinalRemovalDeps {
  pid: number
  tempDir: string
  systemRoot: string
  now(): number
  write(path: string, text: string): void
  powershell: PowershellRun
  spawnDetached(file: string, args: string[], cwd: string): void
}

export type FinalRemoval = { ok: true; script: string; log: string; via: 'wmi' | 'spawn' } | { ok: false; detail: string }

const START_OUTSIDE_JOB = String.raw`$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$command = '"' + $env:HARNESS_CMD + '" /d /s /c ""' + $env:HARNESS_UNINSTALL_SCRIPT + '""'
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $env:HARNESS_UNINSTALL_CWD; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { [Console]::Error.Write("Win32_Process.Create returned $($result.ReturnValue)"); exit 3 }`

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function scheduleFinalRemoval(plan: RemovalPlan, deps: FinalRemovalDeps): FinalRemoval {
  const stamp = `${deps.pid}-${deps.now()}`
  const script = win32.join(deps.tempDir, `harness-uninstall-${stamp}.cmd`)
  const log = win32.join(deps.tempDir, `harness-uninstall-${stamp}.log`)
  try { deps.write(script, finalRemovalScript({ pid: deps.pid, plan, log, systemRoot: deps.systemRoot })) }
  catch (error) { return { ok: false, detail: `could not write ${script}: ${message(error)}` } }
  const cmd = win32.join(deps.systemRoot, 'System32', 'cmd.exe')
  const started = deps.powershell(START_OUTSIDE_JOB, { HARNESS_CMD: cmd, HARNESS_UNINSTALL_SCRIPT: script, HARNESS_UNINSTALL_CWD: deps.tempDir })
  if (!started.error && started.status === 0) return { ok: true, script, log, via: 'wmi' }
  // A computer where WMI is off: detached from this console, though still in this process's job.
  try {
    deps.spawnDetached(cmd, ['/d', '/s', '/c', `""${script}""`], deps.tempDir)
    return { ok: true, script, log, via: 'spawn' }
  } catch (error) {
    return { ok: false, detail: `could not start the last step (${message(error)})` }
  }
}

/** This computer's. */
export function finalRemovalDeps(): FinalRemovalDeps {
  return {
    pid: process.pid,
    tempDir: tmpdir(),
    systemRoot: process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
    now: () => Date.now(),
    write: (path, text) => writeFileSync(path, text, 'utf8'),
    powershell: runPowershell,
    spawnDetached: (file, args, cwd) => {
      spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
    },
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall/removal.spec.ts src/lib/uninstall/removal.real.spec.ts && npx tsc --noEmit`
Expected: 9 pass, the real spec skipped on the Mac; typecheck clean.

- [ ] **Step 5: Windows verification (VM)**

Run: `cli/scripts/windows-pty-e2e/vm-sync.sh --cli && ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/lib/uninstall/removal"`
Expected: 10 pass including "removes the tree once the process has exited". Then check that
`ssh admin@192.168.65.3 "dir %TEMP%\harness-uninstall-*"` reports `File Not Found`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/uninstall/removal.ts cli/src/lib/uninstall/removal.spec.ts cli/src/lib/uninstall/removal.real.spec.ts
git commit -m "feat(cli): plan what harness uninstall removes; on Windows, remove it after the CLI exits"
```

### Task B5.5: Hooks out of the engines' JSON settings

**Files**
- Create: `cli/src/engines/kit/hookRemoval.ts`
- Create: `cli/src/engines/kit/hookRemoval.spec.ts`
- Modify: `cli/src/engines/kit/hookSettings.ts`. `function harnessRules(` becomes `export function harnessRules(`, and
  `const RULES_HEADER =` becomes `export const RULES_HEADER =` (find each by name: B4.6 moved both from today's lines
  113 and 160). No other change.

**Interfaces**
- Consumes: the recognizers `isOurs`, `isManagedHookCommand`, `foreignHookBlocks` (`engines/kit/notifyHooks.ts:74-133`),
  `isMessagesBlock` (`engines/kit/messagesHook.ts:124`), `inspectHookFile` and `runHookPreparation`
  (`engines/kit/nativeHookFiles.ts:76,327`), each with B4's Windows branches. Also B4's
  `quoteHookCommand(runner: HookRunner, argv: string[]): string | string[]`: the recognizer must accept every form it
  produces. The Windows-only cases below fail until it does.
- Produces: `type HookFileRemoval = { file: string; removed: number; failed?: string; kept?: string }`,
  `type JsonHookRemoval = { schema: 'nested' | 'entries' | 'file' | 'named'; block?: string; messages?: boolean; allowList?: readonly [string, string]; allowRules?: readonly string[]; ownedFile?: boolean }`,
  `withoutHarnessHooks(text: string | null, rule: JsonHookRemoval): JsonHookOutcome`,
  `removeJsonHooks(file: string, rule: JsonHookRemoval): Promise<HookFileRemoval>`,
  `removeOwnedFile(file: string, owned: (content: string) => boolean): Promise<HookFileRemoval>`.

- [ ] **Step 1: Write the failing test** `cli/src/engines/kit/hookRemoval.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { messagesCommand } from './messagesHook.js'
import { quoteHookCommand } from './notifyHooks.js'
import { removeJsonHooks, removeOwnedFile, withoutHarnessHooks } from './hookRemoval.js'

const OURS = "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port 18473 --data-dir '/home/u/.harness/cli/data'"
const MESSAGES = messagesCommand('/home/u/.harness/agent-messages', '/opt/harness/node/bin/node')
const block = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 5 }] })
const parsed = (outcome: ReturnType<typeof withoutHarnessHooks>) => (outcome.kind === 'write' ? JSON.parse(outcome.text) : outcome)

describe('withoutHarnessHooks', () => {
  it('takes Claude Code\'s blocks, the messages block and Harness\'s rules out, and keeps the person\'s', () => {
    const text = JSON.stringify({
      model: 'opus',
      hooks: {
        SessionStart: [block(OURS)],
        Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] }, block(OURS)],
        PostToolUse: [block(MESSAGES)],
      },
      permissions: { allow: ['Bash(npm test)', 'Bash(harness ps:*)'], deny: ['Bash(rm:*)'] },
    })
    const outcome = withoutHarnessHooks(text, { schema: 'nested', messages: true, allowList: ['permissions', 'allow'], allowRules: ['Bash(harness ps:*)'] })
    expect(outcome).toMatchObject({ kind: 'write', removed: 4 })
    expect(parsed(outcome)).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] }] },
      permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm:*)'] },
    })
  })

  it('keeps somebody else\'s hook that shares a block with ours, and the block\'s matcher', () => {
    const text = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: OURS }, { type: 'command', command: '/x/y' }] }] } })
    expect(parsed(withoutHarnessHooks(text, { schema: 'nested' }))).toEqual({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/x/y' }] }] } })
  })

  it('reads the flat schemas: entries, a named block, and a file of Harness\'s own', () => {
    expect(parsed(withoutHarnessHooks(JSON.stringify({ version: 1, hooks: { stop: [{ command: OURS }, { command: '/x' }] } }), { schema: 'entries' })))
      .toEqual({ version: 1, hooks: { stop: [{ command: '/x' }] } })
    expect(parsed(withoutHarnessHooks(JSON.stringify({ other: {}, harness: { Stop: [{ type: 'command', command: `${OURS} --agy-event Stop` }] } }), { schema: 'named', block: 'harness' })))
      .toEqual({ other: {} })
    expect(withoutHarnessHooks(JSON.stringify({ version: 1, hooks: { agentStop: [{ type: 'command', command: `${OURS} --copilot-event agentStop` }] } }), { schema: 'file', ownedFile: true }))
      .toEqual({ kind: 'delete', removed: 1 })
  })

  it('changes nothing in a file without Harness\'s hooks, or no file', () => {
    expect(withoutHarnessHooks(JSON.stringify({ hooks: { Stop: [block('/x')] } }), { schema: 'nested' })).toEqual({ kind: 'unchanged' })
    expect(withoutHarnessHooks(null, { schema: 'nested' })).toEqual({ kind: 'unchanged' })
  })

  it('refuses a file it cannot read as settings', () => {
    expect(() => withoutHarnessHooks('{ not json', { schema: 'nested' })).toThrow()
    expect(() => withoutHarnessHooks('[]', { schema: 'nested' })).toThrow('the settings do not have the declared object shape')
  })
})

describe('removeJsonHooks and removeOwnedFile', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'hook-removal-')); dirs.push(dir); return dir }

  it('rewrites the settings file, and reports one it cannot read without touching it', async () => {
    const dir = home()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [block(OURS), block('/x')] } }))
    expect(await removeJsonHooks(join(dir, 'settings.json'), { schema: 'nested' })).toEqual({ file: join(dir, 'settings.json'), removed: 1 })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ hooks: { Stop: [block('/x')] } })
    writeFileSync(join(dir, 'broken.json'), '{ broken')
    const broken = await removeJsonHooks(join(dir, 'broken.json'), { schema: 'nested' })
    expect(broken.removed).toBe(0)
    expect(broken.failed).toBeTruthy()
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{ broken')
  })

  it('deletes a file of Harness\'s own, and keeps one of another author', async () => {
    const dir = home()
    mkdirSync(join(dir, 'hooks'))
    writeFileSync(join(dir, 'hooks', 'harness.json'), JSON.stringify({ hooks: { SessionStart: [block(OURS)] } }))
    expect(await removeJsonHooks(join(dir, 'hooks', 'harness.json'), { schema: 'nested', ownedFile: true })).toEqual({ file: join(dir, 'hooks', 'harness.json'), removed: 1 })
    expect(existsSync(join(dir, 'hooks', 'harness.json'))).toBe(false)
    writeFileSync(join(dir, 'plugin.js'), '// mine\n')
    expect(await removeOwnedFile(join(dir, 'plugin.js'), (content) => content.startsWith('// session-register'))).toEqual({ file: join(dir, 'plugin.js'), removed: 0, kept: 'another author’s file' })
    expect(existsSync(join(dir, 'plugin.js'))).toBe(true)
  })
})

// B4's Windows command lines: every runner's form must be recognized as Harness's, on Windows, where they are written.
describe.runIf(process.platform === 'win32')('Windows hook runners', () => {
  const argv = ['C:\\Users\\u\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe', 'C:\\Users\\u\\.harness\\cli\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\Users\\u\\.harness\\cli\\data']
  for (const runner of ['argv', 'bash', 'cmd', 'powershell'] as const) {
    it(`removes a command written for the ${runner} runner`, () => {
      const quoted = quoteHookCommand(runner, argv)
      // As B4.6's notifyHookEntry writes it: exec form is the program in `command` and the rest in `args`.
      const hook = Array.isArray(quoted) ? { type: 'command', command: quoted[0], args: quoted.slice(1) } : { type: 'command', command: quoted }
      const text = JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } })
      expect(withoutHarnessHooks(text, { schema: 'nested' })).toEqual({ kind: 'write', text: '{\n  "hooks": {}\n}\n', removed: 1 })
    })
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/engines/kit/hookRemoval.spec.ts`
Expected: FAIL, `Failed to load url ./hookRemoval.js`.

- [ ] **Step 3: Implement.** Apply the two `export` edits in `hookSettings.ts`, then create
`cli/src/engines/kit/hookRemoval.ts`:

```ts
/**
 * `harness uninstall`'s half of the hook installers (hookSettings.ts, nativeHookSettings.ts, nativePlugin.ts): Harness's
 * entries out of an engine's settings, found by the same recognizers the installers use to keep their own apart from
 * everybody else's (notifyHooks.ts `isOurs`, `isManagedHookCommand`; messagesHook.ts `isMessagesBlock`). Nothing they do
 * not recognize is touched; a file that cannot be read as the settings it should be is reported, never rewritten.
 * Each file is written as the installers write it: inspected, staged and published under its own preparation.
 */
import { HookPreparationHeld, inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { isMessagesBlock } from './messagesHook.js'
import { foreignHookBlocks, isManagedHookCommand, isOurs, type HookBlock } from './notifyHooks.js'

export interface HookFileRemoval {
  file: string
  /** How many of Harness's entries (hooks, rules, approvals, or the file itself) went. */
  removed: number
  /** Why the file was left as it was. */
  failed?: string
  /** A file at a path of ours that is somebody else's. */
  kept?: string
}

export interface JsonHookRemoval {
  schema: 'nested' | 'entries' | 'file' | 'named'
  /** `named`: the member Harness's events are in. */
  block?: string
  /** Agent Messages' block (Claude Code's and Codex's settings). */
  messages?: boolean
  /** Harness's permission rules, in the list at this path (`permissions.allow`). */
  allowList?: readonly [string, string]
  allowRules?: readonly string[]
  /** The file is Harness's own (`hooks/harness.json`): deleted once nothing of anybody else's is left in it. */
  ownedFile?: boolean
}

export type JsonHookOutcome = { kind: 'unchanged' } | { kind: 'write'; text: string; removed: number } | { kind: 'delete'; removed: number }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function withoutHarnessHooks(text: string | null, rule: JsonHookRemoval): JsonHookOutcome {
  if (text === null) return { kind: 'unchanged' }
  const settings: unknown = JSON.parse(text)
  if (!object(settings)) throw new HookPreparationHeld('the settings do not have the declared object shape')
  const owns = (block: HookBlock) => isOurs(block) || (rule.messages === true && isMessagesBlock(block))
  const member = rule.schema === 'named' ? rule.block! : 'hooks'
  const events = settings[member]
  let removed = 0
  if (events !== undefined) {
    if (!object(events)) throw new HookPreparationHeld(`the ${member} member is not an object`)
    for (const [event, list] of Object.entries(events)) {
      if (!Array.isArray(list)) continue
      let kept: unknown[]
      if (rule.schema === 'nested') {
        const blocks = list as HookBlock[]
        removed += blocks.reduce((n, b) => n + (Array.isArray(b?.hooks) ? b.hooks.filter((hook) => owns({ hooks: [hook] })).length : 0), 0)
        kept = foreignHookBlocks(blocks, owns)
      } else {
        kept = list.filter((entry) => !(object(entry) && isManagedHookCommand(entry.command)))
        removed += list.length - kept.length
      }
      if (kept.length) events[event] = kept
      else if (kept.length !== list.length) delete events[event]
    }
    if (rule.schema === 'named' && Object.keys(events).length === 0) delete settings[member]
  }
  if (rule.allowList && rule.allowRules?.length) {
    const [table, name] = rule.allowList
    const lists = settings[table]
    if (object(lists) && Array.isArray(lists[name])) {
      const ours = new Set(rule.allowRules)
      const rules = lists[name] as unknown[]
      const kept = rules.filter((r) => !(typeof r === 'string' && ours.has(r)))
      removed += rules.length - kept.length
      lists[name] = kept
    }
  }
  if (removed === 0) return { kind: 'unchanged' }
  const hooksLeft = object(settings.hooks) ? Object.keys(settings.hooks).length : 0
  if (rule.ownedFile && hooksLeft === 0 && Object.keys(settings).every((key) => key === 'hooks' || key === 'version')) return { kind: 'delete', removed }
  return { kind: 'write', text: JSON.stringify(settings, null, 2) + '\n', removed }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Harness's entries out of one settings file. */
export async function removeJsonHooks(file: string, rule: JsonHookRemoval): Promise<HookFileRemoval> {
  try {
    return await runHookPreparation([file], async (attempt) => {
      const observed = inspectHookFile(file)
      const outcome = withoutHarnessHooks(observed.content, rule)
      if (outcome.kind === 'unchanged') return { file, removed: 0 }
      const published = outcome.kind === 'delete' ? await observed.remove(attempt) : await observed.replace(outcome.text, attempt)
      published.verify()
      return { file, removed: outcome.removed }
    }, { identity: JSON.stringify(['uninstall', file]) })
  } catch (error) {
    return { file, removed: 0, failed: message(error) }
  }
}

/** A file Harness writes whole (a plugin, a rules file): deleted when [owned] recognizes it, kept otherwise. */
export async function removeOwnedFile(file: string, owned: (content: string) => boolean): Promise<HookFileRemoval> {
  try {
    return await runHookPreparation([file], async (attempt) => {
      const observed = inspectHookFile(file)
      if (observed.content === null) return { file, removed: 0 }
      if (!owned(observed.content)) return { file, removed: 0, kept: 'another author’s file' }
      ;(await observed.remove(attempt)).verify()
      return { file, removed: 1 }
    }, { identity: JSON.stringify(['uninstall', file]) })
  } catch (error) {
    return { file, removed: 0, failed: message(error) }
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/engines/kit/hookRemoval.spec.ts src/engines/kit/hookSettings.spec.ts src/engines/kit/hookReview.spec.ts && npx tsc --noEmit`
Expected: the 7 new tests pass (the Windows runner block skipped); the existing hook suites are unchanged.

- [ ] **Step 5: Windows verification (VM)**

Run: `cli/scripts/windows-pty-e2e/vm-sync.sh --cli && ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/engines/kit/hookRemoval.spec.ts"`
Expected: 11 pass, including the 4 runner cases. If one fails, B4's recognizer does not accept that runner's form.
Fix it in `notifyHooks.ts` (B4's code) with that case as its test, before going on.

- [ ] **Step 6: Commit**

```bash
git add cli/src/engines/kit/hookRemoval.ts cli/src/engines/kit/hookRemoval.spec.ts cli/src/engines/kit/hookSettings.ts
git commit -m "feat(engines): take Harness's hooks and rules out of an engine's JSON settings"
```

### Task B5.6: Every engine's hooks, plugins and YAML blocks

**Files**
- Modify: `cli/src/engines/kit/nativeHookYaml.ts`. Add `removeNativeYamlHooks` after `installNativeYamlHooks`
  (lines 118-143, so after line 143). It reuses `stripOwnedBlocks` (lines 78-112) and the hook-line parse that `installIn`
  (line 145) does at lines 168-177.
- Create: `cli/src/engines/removeHooks.ts`
- Create: `cli/src/engines/removeHooks.spec.ts`

**Interfaces**
- Consumes: B5.5's `removeJsonHooks`, `removeOwnedFile`, `HookFileRemoval`; the declarations
  `hookContracts` (`engines/hooks.ts:14`), `GROK_/AGY_/COPILOT_/CURSOR_/COMMANDCODE_/DEVIN_HOOK_SETTINGS`,
  `KILO_PLUGIN`, `PI_EXTENSION`, `AMP_PLUGIN`, `OPENCODE_LEGACY_PLUGIN`, `OPENCODE_TUI_PLUGIN`, `HERMES_HOOK_SETTINGS`
  (each engine's `contract.ts`); `durableEngineHomes()` (`lib/engineHomes.ts:248`); `nativeHookHomes`
  (`engines/kit/nativeHookHomes.ts:5`); `nativePluginSource` (`engines/kit/nativePlugin.ts:15`); B4's Windows engine home
  table (the paths these declarations resolve to on win32).
- Produces: `removeNativeYamlHooks(rule: NativeYamlHooks, homes: readonly string[]): Promise<HookFileRemoval[]>`,
  `type HookTargets`, `defaultHookTargets(dataDir?, adopted?): HookTargets`, `pluginOwned(rule: NativePlugin): (content: string) => boolean`,
  `removeEngineHooks(targets: HookTargets): Promise<HookFileRemoval[]>`.

- [ ] **Step 1: Write the failing test** `cli/src/engines/removeHooks.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { RULES_HEADER } from './kit/hookSettings.js'
import { nativePluginSource } from './kit/nativePlugin.js'
import { defaultHookTargets, pluginOwned, removeEngineHooks, type HookTargets } from './removeHooks.js'

const OURS = "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port 18473 --data-dir '/home/u/.harness/cli/data'"
const values = { port: '18473', credential: '"/home/u/.harness/cli/data/hook-credential"', version: '"0.5.0"' }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function machine(): { root: string; targets: HookTargets } {
  const root = mkdtempSync(join(tmpdir(), 'remove-hooks-'))
  dirs.push(root)
  const at = (...parts: string[]) => join(root, ...parts)
  return {
    root,
    targets: {
      claude: { homes: [at('claude')], allowRules: ['Bash(harness ps:*)'] },
      codex: { homes: [at('codex'), at('codex-profile')] },
      native: [{ ...CURSOR_HOOK_SETTINGS, file: at('cursor', 'hooks.json') }],
      plugins: [{ ...KILO_PLUGIN, file: at('kilo', 'plugin', 'launcher-register.js') }, { ...OPENCODE_TUI_PLUGIN, file: at('opencode', 'plugins', 'launcher-register', 'tui.js') }],
      hermes: { rule: { ...HERMES_HOOK_SETTINGS, home: at('hermes') }, homes: [at('hermes')] },
    },
  }
}
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

describe('removeEngineHooks', () => {
  it('takes Harness out of every engine\'s files and leaves everything else', async () => {
    const { root, targets } = machine()
    write(join(root, 'claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OURS }] }] }, permissions: { allow: ['Bash(harness ps:*)', 'Bash(ls)'] } }))
    write(join(root, 'codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: OURS }] }] } }))
    write(join(root, 'codex', 'rules', 'harness.rules'), `${RULES_HEADER}prefix_rule(pattern=["harness"], decision="allow")\n`)
    write(join(root, 'codex-profile', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: OURS }] }] } }))
    write(join(root, 'cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: OURS }, { command: '/mine' }] } }))
    write(targets.plugins[0].file, nativePluginSource(targets.plugins[0], values))
    write(targets.plugins[1].file, nativePluginSource(targets.plugins[1], values))
    write(join(root, 'hermes', 'config.yaml'), `model: x\n\n${HERMES_HOOK_SETTINGS.begin}\nhooks:\n  on_session_start:\n    - command: ${JSON.stringify(`${OURS} --engine hermes`)}\n      timeout: 10\n${HERMES_HOOK_SETTINGS.end}\n`)
    write(join(root, 'hermes', 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: 'on_session_start', command: `${OURS} --engine hermes` }, { event: 'x', command: '/mine' }] }))

    const outcomes = await removeEngineHooks(targets)

    expect(outcomes.filter((o) => o.failed)).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'))).toEqual({ hooks: {}, permissions: { allow: ['Bash(ls)'] } })
    expect(JSON.parse(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8'))).toEqual({ hooks: {} })
    expect(existsSync(join(root, 'codex', 'rules', 'harness.rules'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'codex-profile', 'hooks.json'), 'utf8'))).toEqual({ hooks: {} })
    expect(JSON.parse(readFileSync(join(root, 'cursor', 'hooks.json'), 'utf8'))).toEqual({ version: 1, hooks: { stop: [{ command: '/mine' }] } })
    expect(existsSync(targets.plugins[0].file)).toBe(false)
    expect(existsSync(dirname(targets.plugins[1].file)), 'the plugin\'s own folder goes with it').toBe(false)
    expect(readFileSync(join(root, 'hermes', 'config.yaml'), 'utf8')).toBe('model: x\n')
    expect(JSON.parse(readFileSync(join(root, 'hermes', 'shell-hooks-allowlist.json'), 'utf8'))).toEqual({ approvals: [{ event: 'x', command: '/mine' }] })
    expect(outcomes.reduce((n, o) => n + o.removed, 0)).toBe(10)
  })

  it('keeps a plugin somebody else wrote at Harness\'s path', async () => {
    const { targets } = machine()
    write(targets.plugins[0].file, '// my own plugin\n')
    const outcomes = await removeEngineHooks(targets)
    expect(outcomes).toContainEqual({ file: targets.plugins[0].file, removed: 0, kept: 'another author’s file' })
    expect(existsSync(targets.plugins[0].file)).toBe(true)
  })
})

describe('pluginOwned', () => {
  it('reads ownership from the generated first line, which names no argument', () => {
    const source = nativePluginSource(KILO_PLUGIN, values)
    expect(source.slice(0, source.indexOf('\n'))).not.toContain('18473')
    expect(pluginOwned(KILO_PLUGIN)(source)).toBe(true)
    expect(pluginOwned(KILO_PLUGIN)(source.replace('Kilo', 'Mine'))).toBe(false)
  })
})

describe('defaultHookTargets', () => {
  it('adds every adopted home and every profile a harness was started with', () => {
    const data = mkdtempSync(join(tmpdir(), 'targets-'))
    dirs.push(data)
    writeFileSync(join(data, 'registry.json'), JSON.stringify([{ codexHome: '/p/codex-a' }, { codexHome: '/p/codex-a', hermesHome: '/p/hermes-b' }, { codexHome: 'relative' }]))
    const targets = defaultHookTargets(data, () => ({ claude: ['/moved/claude'], codex: ['/moved/codex'] }))
    expect(targets.claude.homes.slice(1)).toEqual(['/moved/claude'])
    expect(targets.codex.homes.slice(1)).toEqual(['/moved/codex', '/p/codex-a'])
    expect(targets.hermes.homes).toContain('/p/hermes-b')
    expect(defaultHookTargets(data, () => { throw new Error('locked') }).unread).toBe('locked')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/engines/removeHooks.spec.ts`
Expected: FAIL, `Failed to load url ./removeHooks.js`.

- [ ] **Step 3: Implement.** Append to `cli/src/engines/kit/nativeHookYaml.ts` (after `installNativeYamlHooks`),
adding `import type { HookFileRemoval } from './hookRemoval.js'` to its imports:

```ts
/**
 * `harness uninstall`: every block this installer owns (`stripOwnedBlocks`: the delimited one and a bare one an older
 * release left), and Harness's approvals, out of each home's files. A foreign `hooks:` mapping is left alone, as the
 * installer leaves it.
 */
export async function removeNativeYamlHooks(rule: NativeYamlHooks, homes: readonly string[]): Promise<HookFileRemoval[]> {
  const outcomes: HookFileRemoval[] = []
  for (const home of homes) {
    const configPath = join(home, rule.homes.file)
    const allowlistPath = join(home, rule.allowlist)
    try {
      outcomes.push(...await runHookPreparation([configPath, allowlistPath], async (attempt) => {
        const done: HookFileRemoval[] = []
        const observed = inspectHookFile(configPath)
        if (observed.content !== null) {
          const config = observed.content
          const original = parseDocument(config, { strict: true, uniqueKeys: false, prettyErrors: false })
          if (original.errors.length || (original.contents !== null && !isMap(original.contents))) {
            throw new HookPreparationHeld('the YAML configuration is not a complete mapping')
          }
          const hookLines = new Set<number>()
          if (isMap(original.contents)) for (const pair of original.contents.items) {
            if (isScalar(pair.key) && pair.key.value === 'hooks' && pair.key.range) hookLines.add(config.slice(0, pair.key.range[0]).split('\n').length - 1)
          }
          const { cleaned, removed } = stripOwnedBlocks(rule, config, hookLines)
          if (removed > 0) {
            ;(await observed.replace(cleaned.replace(/\s*$/, '\n'), attempt)).verify()
            done.push({ file: configPath, removed })
          }
        }
        const approvals = inspectHookFile(allowlistPath)
        if (approvals.content !== null) {
          const data = JSON.parse(approvals.content) as { approvals?: Array<{ command?: string }> }
          if (data && typeof data === 'object' && Array.isArray(data.approvals)) {
            const kept = data.approvals.filter((a) => !(typeof a?.command === 'string' && isManagedHookCommand(a.command)
              && rule.ownership.every((fragment) => a.command!.includes(fragment))))
            if (kept.length !== data.approvals.length) {
              ;(await approvals.replace(JSON.stringify({ ...data, approvals: kept }, null, 2) + '\n', attempt)).verify()
              done.push({ file: allowlistPath, removed: data.approvals.length - kept.length })
            }
          }
        }
        return done
      }, { identity: JSON.stringify(['uninstall', rule.begin, home]) }))
    } catch (error) {
      outcomes.push({ file: configPath, removed: 0, failed: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}
```

Create `cli/src/engines/removeHooks.ts`:

```ts
/**
 * Every hook, plugin and rule Harness installed into an engine's files (engines/hooks.ts, nativeHooks.ts,
 * core/engines/hooks.ts OTHER_INSTALLERS), for `harness uninstall`: the homes core installs into (each engine's own,
 * the homes the person moved and Harness adopted, the profiles a harness was started with), each file on its own, so
 * one that cannot be read or written is reported and the rest still go.
 */
import { readFileSync, rmdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { durableEngineHomes } from '../lib/engineHomes.js'
import type { HomeCatalog } from './kit/homeCatalog.js'
import { hookContracts } from './hooks.js'
import { removeJsonHooks, removeOwnedFile, type HookFileRemoval } from './kit/hookRemoval.js'
import { defaultHookHome, harnessRules, RULES_HEADER } from './kit/hookSettings.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import type { NativeHookSettings } from './kit/nativeHookSettings.js'
import { removeNativeYamlHooks, type NativeYamlHooks } from './kit/nativeHookYaml.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { PI_EXTENSION } from './pi/contract.js'

export interface HookTargets {
  claude: { homes: string[]; allowRules: string[] }
  codex: { homes: string[] }
  native: readonly NativeHookSettings[]
  plugins: readonly NativePlugin[]
  hermes: { rule: NativeYamlHooks; homes: string[] }
  /** Why the adopted homes could not be read: only each engine's own home is cleaned then. */
  unread?: string
}

const unique = (paths: string[]): string[] => [...new Set(paths)]

/** The CODEX_HOME and Hermes profiles harnesses were started with (registry rows' `codexHome`, `hermesHome`). */
function profileHomes(dataDir: string): { codex: string[]; hermes: string[] } {
  try {
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8')) as unknown
    if (!Array.isArray(rows)) return { codex: [], hermes: [] }
    const pick = (key: 'codexHome' | 'hermesHome') => rows.flatMap((row) => {
      const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined
      return typeof value === 'string' && isAbsolute(value) ? [value] : []
    })
    return { codex: unique(pick('codexHome')), hermes: unique(pick('hermesHome')) }
  } catch {
    return { codex: [], hermes: [] }
  }
}

/** This computer's, as the daemon would install them now. */
export function defaultHookTargets(dataDir: string = env.ADAPTER_DATA_DIR, adopted: () => HomeCatalog = durableEngineHomes): HookTargets {
  let moved: HomeCatalog = { claude: [], codex: [] }
  let unread: string | undefined
  try { moved = adopted() } catch (error) { unread = error instanceof Error ? error.message : String(error) }
  const profiles = profileHomes(dataDir)
  const claude = hookContracts.claude.settings
  const allowRules = claude.allow && 'list' in claude.allow ? harnessRules(claude.allow.rules).flat() : []
  return {
    claude: { homes: unique([defaultHookHome(claude), ...moved.claude]), allowRules },
    codex: { homes: unique([defaultHookHome(hookContracts.codex.settings), ...moved.codex, ...profiles.codex]) },
    native: [GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS, COPILOT_HOOK_SETTINGS, CURSOR_HOOK_SETTINGS, COMMANDCODE_HOOK_SETTINGS, DEVIN_HOOK_SETTINGS],
    plugins: [KILO_PLUGIN, PI_EXTENSION, AMP_PLUGIN, OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN],
    hermes: { rule: HERMES_HOOK_SETTINGS, homes: unique([...nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home), ...profiles.hermes]) },
    ...(unread ? { unread } : {}),
  }
}

/** A plugin is Harness's when it starts with the generated first line (nativePlugin.ts `prepareNativePlugin`). */
export function pluginOwned(rule: NativePlugin): (content: string) => boolean {
  const source = nativePluginSource(rule, { port: '0', credential: '""', version: '""' })
  const first = source.slice(0, source.indexOf('\n') + 1)
  return (content) => first.length > 1 && content.startsWith(first)
}

export async function removeEngineHooks(targets: HookTargets): Promise<HookFileRemoval[]> {
  const out: HookFileRemoval[] = []
  const claude = hookContracts.claude.settings
  const codex = hookContracts.codex.settings
  for (const home of targets.claude.homes) {
    out.push(await removeJsonHooks(join(home, claude.file), {
      schema: 'nested', messages: true,
      ...(claude.allow && 'list' in claude.allow ? { allowList: claude.allow.list, allowRules: targets.claude.allowRules } : {}),
    }))
  }
  for (const home of targets.codex.homes) {
    out.push(await removeJsonHooks(join(home, codex.file), { schema: 'nested', messages: true }))
    if (codex.allow && 'file' in codex.allow) out.push(await removeOwnedFile(join(home, codex.allow.file), (content) => content.startsWith(RULES_HEADER)))
  }
  for (const rule of targets.native) {
    out.push(await removeJsonHooks(rule.file, { schema: rule.schema, ...(rule.block ? { block: rule.block } : {}), ownedFile: basename(rule.file) === 'harness.json' }))
  }
  for (const rule of targets.plugins) {
    const removed = await removeOwnedFile(rule.file, pluginOwned(rule))
    out.push(removed)
    // OpenCode 2's plugin is a folder of Harness's own (plugins/launcher-register/): it goes once empty.
    if (removed.removed && basename(dirname(rule.file)) === 'launcher-register') { try { rmdirSync(dirname(rule.file)) } catch { /* not empty */ } }
  }
  out.push(...await removeNativeYamlHooks(targets.hermes.rule, targets.hermes.homes))
  if (targets.unread) out.push({ file: 'the homes Harness adopted', removed: 0, failed: targets.unread })
  return out.filter((o) => o.removed || o.failed || o.kept)
}
```

`HarnessAllowance.list` is a `readonly [string, string]` (`facets/hooks.ts:119-121`), which is `allowList`'s type.

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/engines/removeHooks.spec.ts src/engines/kit/nativeHookYaml.spec.ts src/engines/kit/hookRemoval.spec.ts && npx tsc --noEmit && npx vitest run src/architecture.spec.ts`
Expected: all pass. The architecture spec passes because nothing under `core/` imports `removeHooks.ts`.

- [ ] **Step 5: Windows verification (VM)**

Run: `cli/scripts/windows-pty-e2e/vm-sync.sh --cli && ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/engines/removeHooks.spec.ts"`
Expected: 4 pass (the plugin and YAML writes go through B4's Windows file writers).

- [ ] **Step 6: Commit**

```bash
git add cli/src/engines/kit/nativeHookYaml.ts cli/src/engines/removeHooks.ts cli/src/engines/removeHooks.spec.ts
git commit -m "feat(engines): find and remove every hook, plugin and rule Harness installed"
```

### Task B5.7: End the terminal host's panes, then the host

**Files**
- Create: `cli/src/lib/uninstall/ptyHosts.ts`
- Create: `cli/src/lib/uninstall/ptyHosts.spec.ts`

**Interfaces**
- Consumes: A's `discoverHosts`, `reachPtyHost`, `discoveredHostDead` (`lib/ptyHost/launch.ts`), and `pidAlive`,
  `HostLiveness` (B2.4 moved them to `lib/processProof.ts`; `launch.ts` re-exports them, as imported below),
  the ops `inventory`, `kill`, `shutdown` (`lib/ptyHost/protocol.ts:192-211`, `SHUTDOWN_PROTOCOL` line 20;
  `pty/src/panes.rs:566-586,777-787`: `kill` takes the pane out of the table at once and gives it its grace in the
  background; `shutdown` is refused while any pane is left), `windowsProcessRows` (`lib/windows/processTable.ts:90`);
  B3's `terminateVerified(pid: number, startMarker: string): Promise<'ended' | 'gone' | 'mismatch'>`
  (`lib/windows/terminate.ts`).
- Produces: `PANE_GRACE_MS`, `HOST_EXIT_WAIT_MS`, `type PtyHostEnd`, `type PtyHostsDeps`, `endPtyHosts(deps): Promise<PtyHostEnd[]>`,
  `ptyHostsDeps(home?): PtyHostsDeps`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/ptyHosts.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { PtyHostDiscovery } from '../ptyHost/client.js'
import { endPtyHosts, PANE_GRACE_MS, type HostClient, type PtyHostsDeps } from './ptyHosts.js'

const discovery = (pid: number, protocol = 2): PtyHostDiscovery => ({ protocol, instance: `p${protocol}`, endpoint: 'e', pid, version: '0.5.0', token: 't' })

function host(panes: string[], options: { refuseFirstShutdown?: boolean; exitsOnShutdown?: boolean; protocol?: number } = {}) {
  const calls: string[] = []
  let alive = true
  let refused = !options.refuseFirstShutdown
  const table = new Set(panes)
  const client: HostClient = {
    protocol: options.protocol ?? 2,
    pid: 100,
    close: () => { calls.push('close') },
    call: (async (op: { op: string; pane?: string }) => {
      calls.push(op.pane ? `${op.op} ${op.pane}` : op.op)
      if (op.op === 'inventory') return { state: 'ok', value: { panes: [...table].map((pane) => ({ pane })) } }
      if (op.op === 'kill') { table.delete(op.pane!); return { state: 'ok', value: {} } }
      if (op.op === 'shutdown') {
        if (!refused) { refused = true; table.add('%9'); return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'host still has panes (1)' } }
        if (options.exitsOnShutdown !== false) alive = false
        return { state: 'ok', value: {} }
      }
      return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'no' }
    }) as HostClient['call'],
  }
  return { client, calls, alive: () => alive, kill: () => { alive = false } }
}

function deps(h: ReturnType<typeof host> | null, overrides: Partial<PtyHostsDeps> = {}): { deps: PtyHostsDeps; slept: number[]; ended: string[] } {
  const slept: number[] = []
  const ended: string[] = []
  return {
    slept, ended,
    deps: {
      platform: 'win32',
      discover: () => [discovery(100)],
      reach: async () => (h ? { client: h.client } : { unreachable: 'nothing answers' }),
      alive: (pid) => pid === 100 && (h ? h.alive() : true),
      dead: async () => false,
      rows: async () => [{ pid: 100, parentPid: 1, executable: 'C:\\Users\\u\\.harness\\runtime\\pty\\0.5.0\\harness-pty.exe', startMarker: 'w:1', args: '' }],
      terminate: async (pid, marker) => { ended.push(`${pid} ${marker}`); h?.kill(); return 'ended' },
      signal: (pid) => { ended.push(`SIGTERM ${pid}`); h?.kill() },
      sleep: async (ms) => { slept.push(ms) },
      ...overrides,
    },
  }
}

describe('endPtyHosts', () => {
  it('kills each pane, gives them their grace, then shuts the host down', async () => {
    const h = host(['%1', '%2'])
    const t = deps(h)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'kill %2', 'shutdown', 'close'])
    expect(t.slept).toContain(PANE_GRACE_MS)
    expect(t.ended).toEqual([])
  })

  it('goes round once more when a pane appeared before the shutdown', async () => {
    const h = host(['%1'], { refuseFirstShutdown: true })
    expect(await endPtyHosts(deps(h).deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'shutdown', 'inventory', 'kill %9', 'shutdown', 'close'])
  })

  it('ends a host that cannot be reached by its pid and start marker on Windows, after checking it is the host', async () => {
    const t = deps(null)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(t.ended).toEqual(['100 w:1'])
    const other = deps(null, { rows: async () => [{ pid: 100, parentPid: 1, executable: 'C:\\x\\notepad.exe', startMarker: 'w:2', args: '' }] })
    expect(await endPtyHosts(other.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'left', detail: 'nothing answers, and pid 100 is not a harness-pty process' }])
    expect(other.ended).toEqual([])
  })

  it('leaves a host proven dead or gone alone, and signals one on Unix', async () => {
    expect(await endPtyHosts(deps(null, { dead: async () => true }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    expect(await endPtyHosts(deps(null, { alive: () => false }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    let up = true
    const unix = deps(null, { platform: 'darwin', alive: () => up, signal: (pid) => { unix.ended.push(`SIGTERM ${pid}`); up = false } })
    expect(await endPtyHosts(unix.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(unix.ended).toEqual(['SIGTERM 100'])
  })

  it('ends a protocol 1 host, which has no shutdown, once its panes are gone', async () => {
    const h = host(['%1'], { protocol: 1 })
    const t = deps(h, { discover: () => [discovery(100, 1)] })
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 1, panes: 1, how: 'ended' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'close'])
    expect(t.ended).toEqual(['100 w:1'])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/ptyHosts.spec.ts`
Expected: FAIL, `Failed to load url ./ptyHosts.js`.

- [ ] **Step 3: Implement** `cli/src/lib/uninstall/ptyHosts.ts`:

```ts
/**
 * `harness uninstall`'s end of the Harness terminal host (pty/, A): the panes the daemon could not stop as harnesses
 * (a terminal, an agent whose stop was refused), then the host. Each pane is killed with the op the daemon uses, which
 * gives it its grace, then the host is asked to shut down, which it does only with no pane left. A host that does not
 * answer, or speaks a protocol without `shutdown`, is ended by its pid: on Windows only after the process table says
 * that pid is a harness-pty with a start marker, with B3's identity-checked TerminateProcess, never a tree kill.
 */
import { env } from '../../config/env.js'
import type { PtyHostClient, PtyHostDiscovery } from '../ptyHost/client.js'
import { discoverHosts, discoveredHostDead, pidAlive, reachPtyHost, type HostLiveness } from '../ptyHost/launch.js'
import { SHUTDOWN_PROTOCOL } from '../ptyHost/protocol.js'
import type { ProcessRow } from '../processTable.js'
import { windowsProcessRows } from '../windows/processTable.js'
import { terminateVerified } from '../windows/terminate.js'

/** As long as `harness stop` gives the daemon (daemonStop.ts STOP_GRACE_MS). */
export const PANE_GRACE_MS = 3_000
export const HOST_EXIT_WAIT_MS = 5_000

export type HostClient = Pick<PtyHostClient, 'call' | 'close' | 'protocol' | 'pid'>
type HostRow = Pick<ProcessRow, 'pid' | 'executable' | 'startMarker'> & Partial<ProcessRow>

export interface PtyHostsDeps {
  platform: NodeJS.Platform
  discover(): PtyHostDiscovery[]
  reach(protocol: number): Promise<{ client: HostClient } | { unreachable: string }>
  alive(pid: number): boolean
  /** A's proof that the discovery file's host has gone (its pid now belongs to a later process). */
  dead(discovery: PtyHostDiscovery): Promise<boolean>
  rows(): Promise<readonly HostRow[] | null>
  terminate(pid: number, startMarker: string): Promise<'ended' | 'gone' | 'mismatch'>
  signal(pid: number): void
  sleep(ms: number): Promise<void>
}

export interface PtyHostEnd { pid: number; protocol: number; panes: number; how: 'shut down' | 'ended' | 'gone' | 'left'; detail?: string }

async function gone(deps: PtyHostsDeps, pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; deps.alive(pid); waited += 100) {
    if (waited >= ms) return false
    await deps.sleep(100)
  }
  return true
}

export async function endPtyHosts(deps: PtyHostsDeps): Promise<PtyHostEnd[]> {
  const ended: PtyHostEnd[] = []
  for (const discovery of deps.discover()) {
    const { pid, protocol } = discovery
    if (!deps.alive(pid) || await deps.dead(discovery)) { ended.push({ pid, protocol, panes: 0, how: 'gone' }); continue }
    let panes = 0
    let why = 'it did not exit'
    const reached = await deps.reach(protocol)
    if ('client' in reached) {
      const client = reached.client
      try {
        for (let round = 0; round < 2; round++) {
          const inventory = await client.call({ op: 'inventory' })
          const rows = inventory.state === 'ok' ? inventory.value.panes : []
          for (const row of rows) if ((await client.call({ op: 'kill', pane: row.pane, graceMs: PANE_GRACE_MS })).state === 'ok') panes++
          if (rows.length) await deps.sleep(PANE_GRACE_MS)
          if (client.protocol < SHUTDOWN_PROTOCOL) break
          // A pane made between the inventory and the shutdown is refused, and gets one more round.
          if ((await client.call({ op: 'shutdown' })).state === 'ok') break
        }
      } finally {
        client.close()
      }
      if (await gone(deps, pid, HOST_EXIT_WAIT_MS)) { ended.push({ pid, protocol, panes, how: 'shut down' }); continue }
      if (client.protocol < SHUTDOWN_PROTOCOL) why = `its protocol (${client.protocol}) has no shutdown`
    } else {
      why = reached.unreachable
    }
    ended.push({ pid, protocol, panes, ...await force(deps, pid, why) })
  }
  return ended
}

async function force(deps: PtyHostsDeps, pid: number, why: string): Promise<Pick<PtyHostEnd, 'how' | 'detail'>> {
  if (deps.platform === 'win32') {
    const row = (await deps.rows())?.find((candidate) => candidate.pid === pid)
    if (!row?.startMarker) return { how: 'left', detail: `${why}, and its start time could not be read` }
    if (!/(^|[\\/])harness-pty(\.exe)?$/i.test(row.executable)) return { how: 'left', detail: `${why}, and pid ${pid} is not a harness-pty process` }
    const outcome = await deps.terminate(pid, row.startMarker)
    return outcome === 'mismatch' ? { how: 'left', detail: `${why}; pid ${pid} changed while it was being ended` } : { how: outcome === 'gone' ? 'gone' : 'ended' }
  }
  deps.signal(pid)
  return await gone(deps, pid, HOST_EXIT_WAIT_MS) ? { how: 'ended' } : { how: 'left', detail: `${why}, and it outlived SIGTERM` }
}

/** This computer's hosts, in HARNESS_PTY_DIR. */
export function ptyHostsDeps(home: string = env.HARNESS_PTY_DIR): PtyHostsDeps {
  const rows = () => windowsProcessRows(null)
  const liveness: HostLiveness = process.platform === 'win32' ? { alive: pidAlive, rows } : { alive: pidAlive }
  return {
    platform: process.platform,
    discover: () => discoverHosts(home),
    reach: async (protocol) => {
      const result = await reachPtyHost(home, protocol, liveness)
      return 'client' in result ? { client: result.client } : { unreachable: 'incompatible' in result ? result.incompatible : result.unavailable }
    },
    alive: pidAlive,
    dead: (discovery) => discoveredHostDead(home, discovery, liveness),
    rows,
    terminate: terminateVerified,
    signal: (pid) => { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall/ptyHosts.spec.ts && npx tsc --noEmit`
Expected: 5 pass; typecheck clean.

- [ ] **Step 5: Windows verification (workflow, after B5.11)**

Task B5.11 adds `src/lib/uninstall` to the Windows workflow's contract-suite paths, so this spec runs there with the
real host present. The end-to-end proof is scenario 7 of B5.14 and the CI install job (B5.12): after
`harness uninstall`, no `harness-pty.exe` is left.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/uninstall/ptyHosts.ts cli/src/lib/uninstall/ptyHosts.spec.ts
git commit -m "feat(cli): end the terminal host's panes and the host for harness uninstall"
```

### Task B5.8: Stop every harness through the running daemon

**Files**
- Create: `cli/src/lib/uninstall/agents.ts`
- Create: `cli/src/lib/uninstall/agents.spec.ts`

**Interfaces**
- Consumes: `Daemon` and `openDaemon(where)`, `whereFor(pane)` (`agentClient/daemon.ts:29-34,50,67`); the requests
  `agents_list` and `agent_delete { agentId }` (Stop Harness, `backendSocket.ts:1128-1130`). On Windows `openDaemon`
  connects over loopback TCP: B2.8 moved `agentClient/daemon.ts` to `unixSocketPath`, which is null there, and agent
  verbs need no trust (B2 notes).
- Produces: `AGENT_STOP_TIMEOUT_MS`, `AGENTS_AT_ONCE`, `type AgentsStopped = { stopped: number; failed: Array<{ name: string; error: string }>; unreachable?: string }`,
  `stopEveryAgent(open: () => Promise<Daemon>): Promise<AgentsStopped>`.

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/agents.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Daemon } from '../../agentClient/daemon.js'
import { stopEveryAgent } from './agents.js'

function daemon(agents: Array<Record<string, unknown>>, answers: Record<string, Record<string, unknown>> = {}) {
  const requests: string[] = []
  let closed = false
  const line: Daemon = {
    machineId: 'm',
    close: () => { closed = true },
    request: async (type, payload = {}) => {
      requests.push(type === 'agent_delete' ? `${type} ${payload.agentId}` : type)
      if (type === 'agents_list') return { agents }
      return answers[String(payload.agentId)] ?? { ok: true }
    },
  }
  return { line, requests, closed: () => closed }
}

describe('stopEveryAgent', () => {
  it('stops each harness the daemon lists, and says which would not stop', async () => {
    const d = daemon([{ id: 'aaaaaaaa-1', name: 'codex-auth' }, { id: 'bbbbbbbb-2' }, { id: 'cccccccc-3', name: 'pwsh' }],
      { 'bbbbbbbb-2': { error: 'IDENTITY_UNAVAILABLE', detail: 'the native ps probe did not complete' } })
    expect(await stopEveryAgent(async () => d.line)).toEqual({ stopped: 2, failed: [{ name: 'bbbbbbbb', error: 'IDENTITY_UNAVAILABLE: the native ps probe did not complete' }] })
    expect(d.requests.sort()).toEqual(['agent_delete aaaaaaaa-1', 'agent_delete bbbbbbbb-2', 'agent_delete cccccccc-3', 'agents_list'])
    expect(d.closed()).toBe(true)
  })

  it('reports a daemon it cannot reach, and asks nothing', async () => {
    expect(await stopEveryAgent(async () => { throw new Error('connect ECONNREFUSED') })).toEqual({ stopped: 0, failed: [], unreachable: 'connect ECONNREFUSED' })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/agents.spec.ts`
Expected: FAIL, `Failed to load url ./agents.js`.

- [ ] **Step 3: Implement** `cli/src/lib/uninstall/agents.ts`:

```ts
/**
 * `harness uninstall` ends every agent (spec section 5): through the running daemon, as Stop Harness does, because the
 * daemon knows which process is each harness's and checks its identity before it ends one. Done first, while there is a
 * daemon to ask. A harness it would not stop is reported; on Windows the terminal host's step then ends its pane.
 */
import type { Daemon } from '../../agentClient/daemon.js'

export const AGENT_STOP_TIMEOUT_MS = 60_000
/** As many at once as hermes' hook homes are prepared (nativeHookYaml.ts): enough to be quick, few enough not to pile up. */
export const AGENTS_AT_ONCE = 4

export interface AgentsStopped { stopped: number; failed: Array<{ name: string; error: string }>; unreachable?: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const label = (agent: Record<string, unknown>): string => (typeof agent.name === 'string' && agent.name ? agent.name : String(agent.id).slice(0, 8))

export async function stopEveryAgent(open: () => Promise<Daemon>): Promise<AgentsStopped> {
  let daemon: Daemon
  try { daemon = await open() } catch (error) { return { stopped: 0, failed: [], unreachable: message(error) } }
  try {
    const listed = await daemon.request('agents_list', { includeStopped: false })
    const agents = (Array.isArray(listed.agents) ? listed.agents as Array<Record<string, unknown>> : []).filter((a) => typeof a.id === 'string')
    let stopped = 0
    const failed: AgentsStopped['failed'] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < agents.length) {
        const agent = agents[next++]
        try {
          const reply = await daemon.request('agent_delete', { agentId: agent.id }, AGENT_STOP_TIMEOUT_MS)
          if (reply.error) failed.push({ name: label(agent), error: `${reply.error}${typeof reply.detail === 'string' && reply.detail ? `: ${reply.detail}` : ''}` })
          else stopped++
        } catch (error) {
          failed.push({ name: label(agent), error: message(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AGENTS_AT_ONCE, agents.length) }, worker))
    return { stopped, failed }
  } catch (error) {
    return { stopped: 0, failed: [], unreachable: message(error) }
  } finally {
    daemon.close()
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall/agents.spec.ts && npx tsc --noEmit`
Expected: 2 pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/uninstall/agents.ts cli/src/lib/uninstall/agents.spec.ts
git commit -m "feat(cli): stop every harness through the daemon for harness uninstall"
```

### Task B5.9: `harness uninstall`

**Files**
- Create: `cli/src/lib/uninstall/command.ts`
- Create: `cli/src/lib/uninstall/command.spec.ts`
- Create: `cli/src/lib/uninstall/deps.ts` (this computer's wiring, outside the unit test)
- Modify: `cli/src/cli.ts`. Add a usage line after line 133 (`harness reset ...`) and a `case 'uninstall':`
  after the `case 'reset':` block (lines 2765-2767).

**Interfaces**
- Consumes: B5.1-B5.8; `platformDaemonDeps()` (`lib/platformDaemon.ts:84`) and its `PlatformService`
  `inspect()`, `unregister()`, `os` (`harnessd/platform.ts:324-520`). B3 adds `'taskscheduler'` there:
  `unregister()` deletes this user's task, `taskName(<user>)` (`Harness harnessd (<user>)`), and `stopDaemonProcess()` (`lib/daemonStop.ts:73`) stops a Windows
  master over the pipe. Also `withSpawnLock` (`lib/daemonSpawnLock.ts:318`), `readPid`, `isAlive`
  (`lib/daemonState.ts:31,38`), `AUTH_DIR` (`lib/authSession.ts:53`), `warnIfGridSignInRemains`
  (`lib/gridCredentials.ts:86`), `env.HARNESS_BIN_DIR`, `ADAPTER_CLI_DIR`, `ADAPTER_DATA_DIR`, `HARNESS_PTY_DIR`.
  B1.8's launcher is `bin\harness.exe` (no batch file): Windows cannot delete it while it runs, only rename it,
  so its removal belongs to the final detached step that waits for the CLI and harness.exe to exit (B5.4).
- Produces: `UNINSTALL_USAGE`, `type UninstallDeps`, `uninstallCommand(argv: readonly string[], deps: UninstallDeps): Promise<number>`,
  `uninstallDeps(options: { tildify: (path: string) => string; ask: (question: string) => Promise<string> }): Promise<UninstallDeps>`;
  the CLI command `harness uninstall [--yes|-y] [--keep-data]` (exit 0 done, 1 refused or incomplete, 2 usage).

- [ ] **Step 1: Write the failing test** `cli/src/lib/uninstall/command.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNINSTALL_USAGE, uninstallCommand, type UninstallDeps } from './command.js'

function fake(overrides: Partial<UninstallDeps> = {}) {
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  let running = true
  const deps: UninstallDeps = {
    platform: 'darwin', cwd: '/Users/u/code', root: '/Users/u/.harness', home: '/Users/u',
    cliDir: '/Users/u/.harness/cli', dataDir: '/Users/u/.harness/cli/data', authDir: '/Users/u/.harness/auth',
    isTTY: false, harnessOs: false,
    ask: async () => { calls.push('ask'); return 'n' },
    daemonPid: () => (running ? 4242 : null),
    alive: (pid) => running && pid === 4242,
    stopAgents: async () => { calls.push('agents'); return { stopped: 2, failed: [] } },
    service: { name: 'launchd', present: () => true, unregister: () => { calls.push('service'); return { ok: true } } },
    withLock: async (fn) => { calls.push('lock'); return fn() },
    stopDaemon: async () => { calls.push('stop'); running = false; return { pid: 4242, stopped: true } },
    endPtyHosts: async () => { calls.push('pty'); return [] },
    removeHooks: async () => { calls.push('hooks'); return [{ file: '/Users/u/.claude/settings.json', removed: 5 }] },
    removeLaunchers: () => { calls.push('launchers'); return ['/Users/u/.local/bin/harness', '/Users/u/.local/bin/hn'] },
    removePathEntry: () => { calls.push('path'); return { kind: 'rc', edits: [{ file: '/Users/u/.zshrc', removed: 1, changedByPerson: 0 }], keptFor: [] } },
    listEntries: (dir) => (dir === '/Users/u/.harness' ? [{ name: 'auth', dir: true }, { name: 'cli', dir: true }, { name: 'runtime', dir: true }] : [{ name: 'cli.js', dir: false }, { name: 'data', dir: true }]),
    exists: () => true,
    removeNow: (plan) => { calls.push(`files ${plan.remove.map((t) => t.path.replace('/Users/u/.harness/', '')).join(',')}${plan.removeRoot ? ' +root' : ''}`); return [] },
    scheduleFinalRemoval: (plan) => { calls.push(`final ${plan.remove.length}${plan.removeRoot ? ' +root' : ''}`); return { ok: true, script: 'C:\\T\\h.cmd', log: 'C:\\T\\h.log', via: 'wmi' } },
    afterword: () => { calls.push('afterword') },
    out: (line) => { out.push(line) },
    err: (line) => { err.push(line) },
    tildify: (path) => path.replace('/Users/u', '~').replace('C:\\Users\\u', '~'),
    ...overrides,
  }
  return { deps, calls, out, err }
}

describe('harness uninstall', () => {
  it('with --yes: harnesses, service, daemon, terminal host, hooks, launchers, PATH, files, in that order', async () => {
    const t = fake()
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.calls).toEqual(['agents', 'lock', 'service', 'stop', 'pty', 'hooks', 'launchers', 'path', 'files auth,cli,runtime +root', 'afterword'])
    expect(t.out).toContain('✓ stopped 2 harnesses')
    expect(t.out).toContain('✓ removed the Harness daemon from launchd: it no longer starts at login')
    expect(t.out).toContain('✓ removed the PATH line Harness added to ~/.zshrc')
    expect(t.out.at(-1)).toBe('Harness is uninstalled.')
  })

  it('asks first in a terminal, and removes nothing on no', async () => {
    const t = fake({ isTTY: true })
    expect(await uninstallCommand([], t.deps)).toBe(1)
    expect(t.calls).toEqual(['ask'])
    expect(t.out).toContain('  · deletes ~/.harness: your sign-in, this computer\'s identity, history and settings (--keep-data keeps them)')
    expect(t.out.at(-1)).toBe('Nothing was removed.')
    const yes = fake({ isTTY: true, ask: async () => 'y' })
    expect(await uninstallCommand([], yes.deps)).toBe(0)
  })

  it('refuses without a terminal or --yes, an unknown option, and Harness OS', async () => {
    const t = fake()
    expect(await uninstallCommand([], t.deps)).toBe(1)
    expect(t.err).toEqual(['✗ harness uninstall asks before it removes anything. Run it in a terminal, or add --yes. Nothing was removed.'])
    expect(await uninstallCommand(['--force'], fake().deps)).toBe(2)
    const os = fake({ harnessOs: true })
    expect(await uninstallCommand(['--yes'], os.deps)).toBe(1)
    expect(os.calls).toEqual([])
  })

  it('with --keep-data removes the program and keeps the data', async () => {
    const t = fake()
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(0)
    expect(t.calls).toContain('files runtime,cli/cli.js')
    expect(t.out.at(-1)).toBe('Harness is uninstalled. Your sign-in and history are kept for the next install.')
  })

  it('deletes nothing when the service or the daemon would not go', async () => {
    const service = fake({ service: { name: 'systemd', present: () => true, unregister: () => ({ ok: false, detail: 'systemctl --user disable harnessd.service: exit 1' }) } })
    expect(await uninstallCommand(['--yes'], service.deps)).toBe(1)
    expect(service.calls).toEqual(['agents', 'lock'])
    expect(service.err).toEqual(['✗ systemd would not let go of the Harness daemon: systemctl --user disable harnessd.service: exit 1. Nothing was deleted: run harness uninstall again once it has stopped.'])
    const stuck = fake({ stopDaemon: async () => ({ pid: 4242, stopped: true }) })
    expect(await uninstallCommand(['--yes'], stuck.deps)).toBe(1)
    expect(stuck.calls).not.toContain('hooks')
  })

  it('reports what it could not do, and still does the rest', async () => {
    const t = fake({
      stopAgents: async () => ({ stopped: 1, failed: [{ name: 'claude-x', error: 'IDENTITY_UNAVAILABLE' }] }),
      removeHooks: async () => [{ file: '/Users/u/.codex/hooks.json', removed: 0, failed: 'the settings file is read-only' }],
      removePathEntry: () => ({ kind: 'rc', edits: [], keptFor: ['claude', 'uv'] }),
    })
    expect(await uninstallCommand(['-y'], t.deps)).toBe(1)
    expect(t.calls).toContain('files auth,cli,runtime +root')
    expect(t.out).toContain('· kept the PATH line in your shell\'s startup file: ~/.local/bin also holds claude, uv, which need it')
    expect(t.err).toEqual([
      '✗ Harness is uninstalled, except:',
      '  · claude-x did not stop (IDENTITY_UNAVAILABLE)',
      '  · Harness\'s hooks are still in ~/.codex/hooks.json (the settings file is read-only): remove the entries that run notify.mjs',
    ])
  })

  it('on Windows: refuses inside ~\\.harness, and leaves the files to the last step', async () => {
    const win = {
      platform: 'win32' as const, root: 'C:\\Users\\u\\.harness', home: 'C:\\Users\\u', cliDir: 'C:\\Users\\u\\.harness\\cli',
      dataDir: 'C:\\Users\\u\\.harness\\cli\\data', authDir: 'C:\\Users\\u\\.harness\\auth', service: { name: 'Task Scheduler', present: () => true, unregister: () => ({ ok: true as const }) },
      removePathEntry: () => ({ kind: 'windows' as const, result: { state: 'removed' as const, folder: 'C:\\Users\\u\\.harness\\bin' } }),
      listEntries: (dir: string) => (dir === 'C:\\Users\\u\\.harness' ? [{ name: 'bin', dir: true }, { name: 'cli', dir: true }] : []),
    }
    const inside = fake({ ...win, cwd: 'c:\\users\\u\\.harness\\cli' })
    expect(await uninstallCommand(['--yes'], inside.deps)).toBe(1)
    expect(inside.calls).toEqual([])
    const t = fake({ ...win, cwd: 'C:\\Users\\u' })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.calls).not.toContain('launchers')
    expect(t.calls).toContain('final 2 +root')
    expect(t.out).toContain('✓ removed ~\\.harness\\bin from your PATH')
    expect(t.out).toContain('✓ ~\\.harness goes once this command has exited (anything left is listed in C:\\T\\h.log)')
  })

  it('prints its usage', async () => {
    const t = fake()
    expect(await uninstallCommand(['--help'], t.deps)).toBe(0)
    expect(t.out).toEqual([UNINSTALL_USAGE])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/lib/uninstall/command.spec.ts`
Expected: FAIL, `Failed to load url ./command.js`.

- [ ] **Step 3: Implement** `cli/src/lib/uninstall/command.ts`:

```ts
/**
 * `harness uninstall [--yes] [--keep-data]`: Harness off this computer, on every OS (spec section 5).
 *
 * The order is not the order a person would list the parts in:
 *  1. the harnesses, through the running daemon, which knows which process is each one's, while it is there to ask;
 *  2. the login service, before the daemon: launchd's KeepAlive and the scheduled task's five-minute trigger would
 *     otherwise start it again in the middle;
 *  3. the daemon, then whatever the terminal host still runs;
 *  4. the hooks, once no daemon is left to write them back on its next start;
 *  5. the launchers and the PATH entry, then the files. On Windows a program cannot delete the node.exe it runs from,
 *     so the files go in a cmd.exe that waits for this process to exit (removal.ts).
 * A service that would not go, or a daemon that would not stop, ends it before anything is deleted: what was left
 * would start a program that is no longer there. Everything after that is reported, and the rest is still done.
 */
import { posix, win32 } from 'node:path'
import type { HookFileRemoval } from '../../engines/kit/hookRemoval.js'
import type { AgentsStopped } from './agents.js'
import type { PtyHostEnd } from './ptyHosts.js'
import { RC_MARKER, type RcOutcome } from './rcFiles.js'
import { DESKTOP_STATE, removalPlan, type FinalRemoval, type RemovalPlan, type RootEntry } from './removal.js'
import type { PathRemoval } from './windowsPath.js'

export const UNINSTALL_USAGE = [
  'Usage: harness uninstall [--yes] [--keep-data]',
  '',
  '  Removes Harness from this computer: stops every harness and the Harness daemon, takes it out of the login',
  '  service, removes the hooks it added to your agents, its commands and PATH entry, and ~/.harness.',
  '',
  '  --yes, -y     do not ask first',
  '  --keep-data   keep your sign-in, this computer\'s identity, history and settings for a later install',
].join('\n')

const KNOWN = new Set(['--yes', '-y', '--keep-data'])

export interface UninstallService {
  name: string
  present(): boolean
  unregister(): { ok: true } | { ok: false; detail: string }
}

export type PathStep = { kind: 'windows'; result: PathRemoval } | { kind: 'rc'; edits: RcOutcome[]; keptFor: string[] }

export interface UninstallDeps {
  platform: NodeJS.Platform
  cwd: string
  home: string
  /** ~/.harness, the product root (config/env.ts). */
  root: string
  cliDir: string
  dataDir: string
  authDir: string
  isTTY: boolean
  /** Harness OS: its package owns the CLI (lib/platformDaemon.ts osDaemonUnit). */
  harnessOs: boolean
  ask(question: string): Promise<string>
  daemonPid(): number | null
  alive(pid: number): boolean
  stopAgents(): Promise<AgentsStopped>
  service: UninstallService | null
  withLock<T>(fn: () => Promise<T>): Promise<T>
  stopDaemon(): Promise<{ pid: number | null; stopped: boolean }>
  endPtyHosts(): Promise<PtyHostEnd[]>
  removeHooks(): Promise<HookFileRemoval[]>
  /** mac and Linux: the launchers in ~/.local/bin (on Windows they are in ~\.harness\bin, with the rest). */
  removeLaunchers(): string[]
  removePathEntry(): PathStep
  listEntries(dir: string): RootEntry[]
  exists(path: string): boolean
  removeNow(plan: RemovalPlan): string[]
  scheduleFinalRemoval(plan: RemovalPlan): FinalRemoval
  /** What stays that is not Harness's to remove (grid's own sign-in). */
  afterword(): void
  out(line: string): void
  err(line: string): void
  tildify(path: string): string
}

function inside(root: string, path: string, windows: boolean): boolean {
  const p = windows ? win32 : posix
  let [base, at] = [p.resolve(root), p.resolve(path)]
  if (windows) [base, at] = [base.toLowerCase(), at.toLowerCase()]
  return at === base || at.startsWith(base + p.sep)
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

function whatItDoes(deps: UninstallDeps, daemon: number | null, keepData: boolean): string[] {
  const root = deps.tildify(deps.root)
  return [
    'harness uninstall removes Harness from this computer:',
    ...(daemon !== null ? [`  · stops every harness running here, then the Harness daemon (pid ${daemon})`] : []),
    ...(deps.service?.present() ? [`  · takes the Harness daemon out of ${deps.service.name}, so it no longer starts at login`] : []),
    '  · removes the hooks Harness added to Claude Code, Codex and your other agents\' settings',
    deps.platform === 'win32'
      ? `  · removes ${deps.tildify(win32.join(deps.root, 'bin'))} from your PATH`
      : '  · removes the harness and hn commands, and the PATH line the installer added',
    keepData
      ? `  · deletes the program in ${root}, and keeps your sign-in, this computer's identity, history and settings there`
      : `  · deletes ${root}: your sign-in, this computer's identity, history and settings (--keep-data keeps them)`,
    '',
  ]
}

export async function uninstallCommand(argv: readonly string[], deps: UninstallDeps): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) { deps.out(UNINSTALL_USAGE); return 0 }
  const unknown = argv.find((arg) => !KNOWN.has(arg))
  if (unknown !== undefined) { deps.err(`Unknown option for harness uninstall: ${unknown}\n\n${UNINSTALL_USAGE}`); return 2 }
  const yes = argv.includes('--yes') || argv.includes('-y')
  const keepData = argv.includes('--keep-data')
  const windows = deps.platform === 'win32'
  if (deps.harnessOs) { deps.err('✗ Harness is part of this Harness operating system, which keeps it installed. Nothing was removed.'); return 1 }
  if (windows && inside(deps.root, deps.cwd, true)) {
    deps.err(`✗ This terminal is in ${deps.tildify(deps.cwd)}, which the uninstall removes, and Windows cannot delete a folder a terminal is in. Run \`cd ~\`, then run it again.`)
    return 1
  }
  const daemon = deps.daemonPid()
  if (!yes) {
    if (!deps.isTTY) { deps.err('✗ harness uninstall asks before it removes anything. Run it in a terminal, or add --yes. Nothing was removed.'); return 1 }
    for (const line of whatItDoes(deps, daemon, keepData)) deps.out(line)
    const answer = (await deps.ask('  Remove Harness from this computer? [y/N] ')).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') { deps.out('Nothing was removed.'); return 1 }
  }
  const problems: string[] = []

  if (daemon !== null) {
    const agents = await deps.stopAgents()
    if (agents.unreachable) problems.push(`could not ask the Harness daemon to stop its harnesses (${agents.unreachable})`)
    if (agents.stopped) deps.out(`✓ stopped ${plural(agents.stopped, 'harness', 'harnesses')}`)
    for (const failed of agents.failed) problems.push(`${failed.name} did not stop (${failed.error})`)
  }

  const halted = await deps.withLock(async () => {
    if (deps.service?.present()) {
      const removed = deps.service.unregister()
      if (!removed.ok) return `${deps.service.name} would not let go of the Harness daemon: ${removed.detail}`
      deps.out(`✓ removed the Harness daemon from ${deps.service.name}: it no longer starts at login`)
    }
    const stopped = await deps.stopDaemon()
    if (stopped.pid !== null && deps.alive(stopped.pid)) return `the Harness daemon (pid ${stopped.pid}) did not stop`
    if (stopped.pid !== null) deps.out(`✓ stopped the Harness daemon (pid ${stopped.pid})`)
    return null
  })
  if (halted) { deps.err(`✗ ${halted}. Nothing was deleted: run harness uninstall again once it has stopped.`); return 1 }

  for (const host of await deps.endPtyHosts()) {
    if (host.how === 'left') problems.push(`the Harness terminal host (pid ${host.pid}) is still running: ${host.detail}`)
    else if (host.panes) deps.out(`✓ ended ${plural(host.panes, 'terminal')} in the Harness terminal host`)
  }

  const hooks = await deps.removeHooks()
  for (const hook of hooks) {
    if (hook.removed) deps.out(`✓ removed Harness's hooks from ${deps.tildify(hook.file)}`)
    if (hook.failed) problems.push(`Harness's hooks are still in ${deps.tildify(hook.file)} (${hook.failed}): remove the entries that run notify.mjs`)
    if (hook.kept) deps.out(`· kept ${deps.tildify(hook.file)}: it is ${hook.kept}`)
  }

  if (!windows) for (const launcher of deps.removeLaunchers()) deps.out(`✓ removed ${deps.tildify(launcher)}`)

  const path = deps.removePathEntry()
  if (path.kind === 'windows') {
    if (path.result.state === 'removed') deps.out(`✓ removed ${deps.tildify(path.result.folder)} from your PATH`)
    if (path.result.state === 'failed') problems.push(`${deps.tildify(path.result.folder)} is still on your PATH: ${path.result.detail}`)
  } else {
    for (const edit of path.edits) {
      if (edit.removed) deps.out(`✓ removed the PATH line Harness added to ${deps.tildify(edit.file)}`)
      if (edit.failed) problems.push(`could not edit ${deps.tildify(edit.file)} (${edit.failed}): remove the line "${RC_MARKER}" and the line under it`)
      if (edit.changedByPerson) deps.out(`· kept a "${RC_MARKER}" line in ${deps.tildify(edit.file)}: the line under it was changed, so it is yours now`)
    }
    if (path.keptFor.length) {
      const named = path.keptFor.slice(0, 3).join(', ') + (path.keptFor.length > 3 ? ' and more' : '')
      deps.out(`· kept the PATH line in your shell's startup file: ~/.local/bin also holds ${named}, which need it`)
    }
  }

  const plan = removalPlan({
    platform: deps.platform, root: deps.root, entries: deps.listEntries(deps.root),
    cliDir: deps.cliDir, cliEntries: deps.listEntries(deps.cliDir), dataDir: deps.dataDir, keepData,
  })
  const root = deps.tildify(deps.root)
  if (windows) {
    const final = deps.scheduleFinalRemoval(plan)
    if (final.ok) deps.out(`✓ ${keepData ? `the program in ${root}` : root} goes once this command has exited (anything left is listed in ${final.log})`)
    else problems.push(`could not remove ${root}: ${final.detail}`)
  } else {
    const left = deps.removeNow(plan)
    for (const stayed of left) problems.push(`could not remove ${deps.tildify(stayed)}`)
    if (!left.length) deps.out(keepData ? `✓ removed the program from ${root}` : `✓ removed ${root}`)
  }
  if (plan.kept.some((name) => DESKTOP_STATE.test(name))) {
    deps.out(`· kept the Harness desktop app's own settings in ${root}: the app sets Harness up again when it starts. Remove the app to remove them.`)
  }
  if (!keepData) {
    for (const dir of [deps.dataDir, deps.authDir]) {
      if (!inside(deps.root, dir, windows) && deps.exists(dir)) deps.out(`· left ${deps.tildify(dir)}: it is outside ${root} (ADAPTER_DATA_DIR or HARNESS_AUTH_DIR names it); delete it yourself if it is Harness's`)
    }
  }
  deps.afterword()

  if (problems.length) {
    deps.err('✗ Harness is uninstalled, except:')
    for (const problem of problems) deps.err(`  · ${problem}`)
    return 1
  }
  deps.out(keepData ? 'Harness is uninstalled. Your sign-in and history are kept for the next install.' : 'Harness is uninstalled.')
  return 0
}
```

Create `cli/src/lib/uninstall/deps.ts`:

```ts
/** This computer's side of `harness uninstall` (command.ts): every module it needs, loaded only when it runs. */
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { env } from '../../config/env.js'
import { openDaemon, whereFor } from '../../agentClient/daemon.js'
import { AUTH_DIR } from '../authSession.js'
import { isAlive, readPid } from '../daemonState.js'
import { describeSpawnLockOwner, withSpawnLock } from '../daemonSpawnLock.js'
import { stopDaemonProcess } from '../daemonStop.js'
import { warnIfGridSignInRemains } from '../gridCredentials.js'
import { ownedBinEntries } from '../launchers.js'
import { platformDaemonDeps } from '../platformDaemon.js'
import { runPowershell } from '../windows/powershell.js'
import { stopEveryAgent } from './agents.js'
import type { UninstallDeps } from './command.js'
import { endPtyHosts, ptyHostsDeps } from './ptyHosts.js'
import { removeHarnessPathLines } from './rcFiles.js'
import { finalRemovalDeps, listEntries, removeNow, scheduleFinalRemoval } from './removal.js'
import { removeUserPathEntry } from './windowsPath.js'

const SERVICE_NAMES: Record<string, string> = { launchd: 'launchd', systemd: 'systemd', taskscheduler: 'Task Scheduler' }

export async function uninstallDeps(options: { tildify: (path: string) => string; ask: (question: string) => Promise<string> }): Promise<UninstallDeps> {
  const home = homedir()
  // config/env.ts adapterRootDir: the product root, which no setting moves.
  const root = join(home, '.harness')
  const platform = platformDaemonDeps()
  const service = platform.service
  return {
    platform: process.platform, cwd: process.cwd(), home, root,
    cliDir: env.ADAPTER_CLI_DIR, dataDir: env.ADAPTER_DATA_DIR, authDir: AUTH_DIR,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    harnessOs: service?.os === true,
    ask: options.ask,
    daemonPid: () => { const pid = readPid(); return pid !== null && isAlive(pid) ? pid : null },
    alive: isAlive,
    stopAgents: () => stopEveryAgent(() => openDaemon(whereFor(undefined))),
    service: service && !service.os ? {
      name: SERVICE_NAMES[service.platform] ?? service.platform,
      // Only this data folder's (the test stopUnderPlatform applies): a launchd job of the same label loaded from another
      // home, the person's real one when this runs with a throwaway HOME, is not this install's to remove.
      present: () => {
        if (service.ownedBy(platform.logFile)) return true
        const pid = platform.readPid()
        return pid !== null && platform.isAlive(pid) && platform.masterPlatform(pid) === service.platform
      },
      unregister: () => service.unregister(),
    } : null,
    withLock: (fn) => withSpawnLock('stop', fn, { onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`) }),
    stopDaemon: () => stopDaemonProcess(),
    endPtyHosts: () => endPtyHosts(ptyHostsDeps()),
    removeHooks: async () => {
      const { defaultHookTargets, removeEngineHooks } = await import('../../engines/removeHooks.js')
      return removeEngineHooks(defaultHookTargets())
    },
    removeLaunchers: () => {
      const owned = ownedBinEntries(env.HARNESS_BIN_DIR, join(env.ADAPTER_CLI_DIR, 'cli.js'), root)
      for (const path of owned) rmSync(path, { force: true })
      return owned
    },
    removePathEntry: () => {
      if (process.platform === 'win32') return { kind: 'windows', result: removeUserPathEntry(win32.join(root, 'bin'), runPowershell) }
      // The lines put ~/.local/bin on PATH, which other installers share (Claude Code's, uv, pipx): kept while it holds their commands.
      const others = listEntries(join(home, '.local', 'bin')).map((entry) => entry.name).filter((name) => !name.startsWith('.'))
      return others.length ? { kind: 'rc', edits: [], keptFor: others } : { kind: 'rc', edits: removeHarnessPathLines(home), keptFor: [] }
    },
    listEntries,
    exists: existsSync,
    removeNow,
    scheduleFinalRemoval: (plan) => scheduleFinalRemoval(plan, finalRemovalDeps()),
    afterword: () => warnIfGridSignInRemains(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    tildify: options.tildify,
  }
}
```

In `cli/src/cli.ts`:

1. After line 133 (`  harness reset                stop the adapter and clear local CLI state`), add:

```
  harness uninstall            remove Harness from this computer: harnesses, daemon, hooks, PATH and ~/.harness
                               (asks first; --yes skips it, --keep-data keeps your sign-in and history)
```

2. After the `case 'reset':` block (lines 2765-2767), add:

```ts
  case 'uninstall':
    // Loaded only here: the engines' hook declarations and the Windows helpers are not every command's. Exits as soon
    // as it is done, because on Windows the last step waits for this process to end before it deletes its node.exe.
    Promise.all([import('./lib/uninstall/command.js'), import('./lib/uninstall/deps.js')])
      .then(async ([{ uninstallCommand }, { uninstallDeps }]) => uninstallCommand(rest, await uninstallDeps({ tildify, ask: askLine })))
      .then((code) => process.exit(code))
      .catch(onError)
    break
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/lib/uninstall && npx tsc --noEmit && npx vitest run src/architecture.spec.ts`
Expected: every `src/lib/uninstall` spec passes (the real ones skipped on the Mac); typecheck clean; architecture spec
unchanged.

- [ ] **Step 5: Smoke from the sources, in a throwaway home**

Run:
```bash
cd cli && T=$(mktemp -d) && mkdir -p "$T/home/.harness/cli/data" "$T/home/.local/bin" && \
  printf '\n# added by harness installer\nexport PATH="$HOME/.local/bin:$PATH"\n' > "$T/home/.zshrc" && \
  env -i HOME="$T/home" PATH="/usr/bin:/bin" SHELL=/bin/zsh PORT=18497 TMUX_TMPDIR="$T" "$(command -v node)" --import tsx src/cli.ts uninstall --yes; \
  echo "exit=$?"; ls -la "$T/home"; cat "$T/home/.zshrc"
```
Expected: `✓ removed the PATH line Harness added to ~/.zshrc`, `✓ removed ~/.harness`, `Harness is uninstalled.`, `exit=0`;
`$T/home` has no `.harness`, and `.zshrc` is empty. Run `npx tsx --version` first if `--import tsx` is unknown. With an
older tsx, use `npx tsx src/cli.ts uninstall --yes` under the same `env -i` and `PATH` that holds node.

- [ ] **Step 6: Review Focus 5 — uninstall of a broken or half install (before this task's commit).** An install
  that failed midway, or one whose daemon is down, task missing and `cli\current` gone, must still uninstall: exit 0,
  no error line and no new message, and what is there removed. This is pinned at the command level. `harness.exe`
  itself cannot run without `cli\current`: it tells the person to run the installer again and exits 3 (B1.8). Re-running install.ps1 repairs a half install, and `harness uninstall` then works (B5.14 checks that end to
  end). Add to `cli/src/lib/uninstall/command.spec.ts`, inside `describe('harness uninstall')`:

```ts
  it('uninstalls a half install: no daemon, no task, no terminal host, no cli\\current, only bin\\ and runtime\\', async () => {
    const half = {
      platform: 'win32' as const, cwd: 'C:\\Users\\u', root: 'C:\\Users\\u\\.harness', home: 'C:\\Users\\u',
      cliDir: 'C:\\Users\\u\\.harness\\cli', dataDir: 'C:\\Users\\u\\.harness\\cli\\data', authDir: 'C:\\Users\\u\\.harness\\auth',
      daemonPid: () => null, alive: () => false,
      service: { name: 'Task Scheduler', present: () => false, unregister: () => { throw new Error('there is no task to unregister') } },
      stopDaemon: async () => ({ pid: null, stopped: false }),
      endPtyHosts: async () => [],
      removeHooks: async () => [],
      removePathEntry: () => ({ kind: 'windows' as const, result: { state: 'absent' as const, folder: 'C:\\Users\\u\\.harness\\bin' } }),
      // cli\ is gone with its pointer: only bin\ and runtime\ are left.
      listEntries: (dir: string) => (dir === 'C:\\Users\\u\\.harness' ? [{ name: 'bin', dir: true }, { name: 'runtime', dir: true }] : []),
      exists: () => false,
    }
    let planned: string[] = []
    const t = fake({
      ...half,
      scheduleFinalRemoval: (plan) => { planned = plan.remove.map((target) => target.path.split('\\').at(-1)!); return { ok: true, script: 'C:\\T\\h.cmd', log: 'C:\\T\\h.log', via: 'wmi' } },
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.err).toEqual([])
    // Each step that found nothing said nothing: no harness, task, daemon, terminal host, hook or PATH line.
    expect(t.out).toEqual(['✓ ~\\.harness goes once this command has exited (anything left is listed in C:\\T\\h.log)', 'Harness is uninstalled.'])
    expect(t.calls).toEqual(['lock', 'afterword'])
    expect(planned.sort()).toEqual(['bin', 'runtime'])
    // A daemon that does not answer but whose pid is alive still ends it before anything is deleted (the existing rule).
    const stuck = fake({
      ...half, daemonPid: () => 4242, alive: (pid) => pid === 4242,
      stopAgents: async () => ({ stopped: 0, failed: [], unreachable: 'no answer' }),
      stopDaemon: async () => ({ pid: 4242, stopped: false }),
    })
    expect(await uninstallCommand(['--yes'], stuck.deps)).toBe(1)
    expect(stuck.calls.some((call) => call.startsWith('final'))).toBe(false)
    expect(stuck.err).toEqual(['✗ the Harness daemon (pid 4242) did not stop. Nothing was deleted: run harness uninstall again once it has stopped.'])
  })
```

Run: `cd cli && npx vitest run src/lib/uninstall/command.spec.ts`
Expected: pass. The case pins what Step 3 already does; if it fails, `uninstallCommand` prints or errors on a step
that found nothing, and that is the defect to fix.

- [ ] **Step 7: Commit**

```bash
git add cli/src/lib/uninstall/command.ts cli/src/lib/uninstall/command.spec.ts cli/src/lib/uninstall/deps.ts cli/src/cli.ts
git commit -m "feat(cli): harness uninstall"
```

### Task B5.10: End to end on mac and Linux (the e2e suite)

**Files**
- Modify: `cli/e2e/cli.e2e.ts`. Add one `it.each` inside `describe('harness start, stop and status from the installed bundle')`
  (lines 111-315), after its last test (`ignores a %s definition written for another data folder`, lines 298-314),
  before the `})` on line 315. It reuses `install`, `allow`, `harness`, `said`, `create`, `pidOf`, `platformPid`,
  `seen`, `alive`, `until`, `LocalClient` (lines 15-110, 125-166).

**Interfaces**
- Consumes: B5.9's command from the installed bundle; `e2e/harness/fakePlatform.mjs` (fake launchctl and systemctl,
  `HARNESSD_TEST_PLATFORM`).
- Produces: the e2e proof that, under launchd and under systemd, `harness uninstall --yes` removes the definition,
  stops the master, stops the harness, removes Harness's Claude Code and Codex hooks but keeps a foreign one, removes
  the launchers and the PATH line, and removes `~/.harness`.

- [ ] **Step 1: Write the failing test.** Add:

```ts
  it.each(['launchd', 'systemd'] as const)('harness uninstall under %s: the harness, the service, the daemon, the hooks, the commands, the PATH line and ~/.harness go; a foreign hook stays', async (platform) => {
    const m = await install(platform)
    allow(m, 'platform')
    const home = m.daemon.env.HOME!
    // What install.sh leaves beside the bundle: the launchers and the PATH line (cli/scripts/install.sh ensure_rc).
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '${m.node}' '${m.cli}' "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '${join(bin, 'harness')}' tui "$@"\n`, { mode: 0o755 })
    writeFileSync(join(home, '.zshrc'), 'alias ll="ls -l"\n\n# added by harness installer\nexport PATH="$HOME/.local/bin:$PATH"\n')
    // Somebody else's hook beside the ones the daemon installs.
    const settings = join(home, '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    const foreign = { hooks: [{ type: 'command', command: '/usr/bin/true' }] }
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [foreign] } }))

    expect((await harness(m, 'service', 'install')).status).toBe(0)
    const master = pidOf(m)!
    seen.add(master)
    const client = await LocalClient.connect(m.daemon)
    await create(m, client, 'before-uninstall')
    client.close()
    await until('the hooks to be in Claude Code\'s settings', () => readFileSync(settings, 'utf8').includes('notify.mjs'), 30_000)

    const run = await harness(m, 'uninstall', '--yes')
    expect(run.status, said(run)).toBe(0)
    expect(run.stdout).toContain('✓ stopped 1 harness')
    expect(run.stdout).toContain(`✓ removed the Harness daemon from ${platform}`)
    expect(existsSync(m.definition)).toBe(false)
    await until('the master to go', () => !alive(master), 15_000)
    expect(platformPid(m)).toBeNull()
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toEqual([foreign])
    expect(readFileSync(settings, 'utf8')).not.toContain('notify.mjs')
    expect(existsSync(join(m.daemon.env.CODEX_HOME!, 'hooks.json')) ? readFileSync(join(m.daemon.env.CODEX_HOME!, 'hooks.json'), 'utf8') : '').not.toContain('notify.mjs')
    expect(existsSync(join(bin, 'harness'))).toBe(false)
    expect(existsSync(join(bin, 'hn'))).toBe(false)
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n')
    expect(existsSync(join(home, '.harness'))).toBe(false)
    // This test's data folder is outside the home (IsolatedDaemon): named, and left.
    expect(run.stdout).toContain(`· left ${m.daemon.dataDir}`)
  })
```

The imports it needs (`dirname`, `join`, `mkdirSync`, `writeFileSync`, `readFileSync`, `existsSync`, `LocalClient`)
are already at lines 16-23.

- [ ] **Step 2: Run it to see it fail (before B5.9 is in the bundle) or pass (after)**

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t "harness uninstall under"`
Expected with B5.1-B5.9 committed: 2 pass (launchd, systemd). On a tree without B5.9, it fails at
`run.status` with `Unknown command: uninstall`. That is the check that the test exercises the command.

- [ ] **Step 3: Run the e2e files that share its harness**

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts e2e/eagerHooks.e2e.ts`
Expected: pass, or the same failures as on a clean `origin/main` worktree for the same command (record both lists in the
PR, per the baseline rule).

- [ ] **Step 4: Commit**

```bash
git add cli/e2e/cli.e2e.ts
git commit -m "test(e2e): harness uninstall under launchd and systemd"
```

### Task B5.11: `windows-pty.yml` becomes `windows.yml`

**Files**
- Rename: `.github/workflows/windows-pty.yml` → `.github/workflows/windows.yml` (`git mv`). This is the file as B1.13
  rewrote it (callable with `workflow_call`, release mode, the four-file payload).
- Modify: `.github/workflows/windows.yml` (name, header comment, concurrency group, the contract-suite paths)
- Modify: `.github/workflows/release.yml` (B1.13's `pty-build` job: `uses: ./.github/workflows/windows-pty.yml`)
- Modify: `cli/src/scripts/windowsWorkflows.spec.ts` (B1.13: the two references to `windows-pty.yml`)
- Modify: `pty/src/cli.rs` (B1.3's doc comment on `VERSION`, which names `windows-pty.yml`)
- Modify: `.github/workflows/ci.yml:90` (actionlint's list)
- Modify: `docs/superpowers/specs/2026-10-16-windows-native-cli-design.md:36,135,273` (the file name: "Current
  state", "Publishing" and "Testing"'s Rust line; not line 274, "`windows-pty.yml` becomes `windows.yml`", which
  stays), and
  `docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md:341`
  (`"Windows PTY" (.github/workflows/windows-pty.yml)` → `"Windows" (.github/workflows/windows.yml, formerly windows-pty.yml)`)
- `scripts/ci-plan.py`: no change. It names no workflow file (checked: `grep -n windows scripts/ci-plan.py` is empty),
  and workflow changes are covered by the plan job's actionlint and process checks (`ci-plan.py:26-27`).

**Interfaces**
- Consumes: B1.13's `windows-pty.yml` (inputs `version`, `release`; job `windows-pty`; artifact
  `harness-pty-windows-<arch>` holding `harness-pty.exe`, `harness-launch.exe`, `conpty.dll`, `OpenConsole.exe`) and
  `release.yml`'s `pty-build` job; B1.3's comment in `pty/src/cli.rs`.
- Produces: workflow `Windows` (`windows.yml`: `workflow_dispatch`, and `workflow_call` from `release.yml`), job
  `windows-pty` (unchanged id and artifacts). Its on-demand run also runs `src/lib/uninstall` and
  `src/engines/kit/hookRemoval.spec.ts`.

- [ ] **Step 1: Rename and edit**

```bash
git mv .github/workflows/windows-pty.yml .github/workflows/windows.yml
```

In `windows.yml`: `name: Windows PTY` → `name: Windows`; in the header comment `Actions -> Windows PTY -> Run workflow`
→ `Actions -> Windows -> Run workflow`; `group: windows-pty-${{ github.workflow }}-${{ github.ref }}` →
`group: windows-${{ github.workflow }}-${{ github.ref }}`; in "Contract suite against the real host, and the Windows
CLI specs" replace the `$paths` line with:

```powershell
          $paths = @('src/lib/ptyHostBackend.contract.spec.ts', 'src/lib/ptyHost', 'src/lib/windows', 'src/scripts/installPs1.spec.ts', 'src/lib/uninstall', 'src/engines/kit/hookRemoval.spec.ts')
```

The upload step is unchanged: B1.13's "Collect the payload" already ships `harness-launch.exe` with the host.

In `release.yml`, the `pty-build` job: `uses: ./.github/workflows/windows-pty.yml` → `uses: ./.github/workflows/windows.yml`,
and in the comment above it `by the Windows PTY workflow` → `by the Windows workflow`.

In `cli/src/scripts/windowsWorkflows.spec.ts`: `const pty = read('windows-pty.yml')` → `const pty = read('windows.yml')`,
and `expect(release).toContain('uses: ./.github/workflows/windows-pty.yml')` →
`expect(release).toContain('uses: ./.github/workflows/windows.yml')`.

In `pty/src/cli.rs`, the doc comment on `VERSION`: `set by windows-pty.yml's release mode` → `set by windows.yml's
release mode`.

In `ci.yml` line 90 replace `.github/workflows/windows-pty.yml` with `.github/workflows/windows.yml`.

- [ ] **Step 2: Lint and test**

Run: `GOTOOLCHAIN=go1.26.8 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml .github/workflows/windows.yml .github/workflows/release.yml`
Expected: no output, exit 0.
Run: `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts && cd ../pty && cargo +stable check --locked`
Expected: both cases pass; the check is clean.
Run: `git grep -n "windows-pty.yml" -- ':!docs/superpowers/plans'`
Expected: two hits: the A spec's "formerly windows-pty.yml", and the B spec's "`windows-pty.yml` becomes
`windows.yml`" (line 274).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/windows.yml .github/workflows/release.yml .github/workflows/ci.yml cli/src/scripts/windowsWorkflows.spec.ts pty/src/cli.rs docs/superpowers/specs/2026-10-16-windows-native-cli-design.md docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md
git commit -m "ci: the Windows workflow is windows.yml, and runs the uninstall specs"
```

### Task B5.12: The Windows install job

**Files**
- Create: `cli/scripts/windows-ci/check-install.ps1`
- Create: `cli/scripts/windows-ci/check-uninstall.ps1`
- Modify: `.github/workflows/windows.yml` (add job `install`)

**Interfaces**
- Consumes (B1): `node cli/scripts/windows-install-manifest.mjs --out <dir> --cli-dir <dir> --pty-dir <dir> --node-zip <node-vX.Y.Z-win-<arch>.zip> --version <v> [--pty-version <X.Y.Z>]`
  (B1.9), which zips the payload folder and writes `<out>/install-manifest.json`: B1.7's `-Manifest` document, one JSON
  file with the `cli`, `node` and `pty` keys, its files beside it by relative name. `cli/scripts/install.ps1 -Manifest <path>`
  (B1.7, B1.8). B1.13's `windows-pty` job and its `harness-pty-windows-<arch>` artifacts, and its `release` input
  (B5.11 renamed the file to `windows.yml`). Also from B1: `bin\harness.exe`, the user PATH entry; from B3: this user's task
  `taskName(<user>)`, `Harness harnessd (<user>)` in the root folder (B3.12; the checks name it
  `"Harness harnessd ($env:USERNAME)"`). From B5.9: `harness uninstall --yes`.
- Produces: the job `install` on windows-latest (x64) and windows-11-arm (arm64), on-demand runs only;
  `check-install.ps1 -Version <v>` and `check-uninstall.ps1 [-WaitSeconds n] [-HookFiles a,b]`, which the VM end to end
  (B5.14) runs too.

- [ ] **Step 1: Write the checks and the job.** No manifest builder here: B1.9's script is the one for a local build.

`cli/scripts/windows-ci/check-install.ps1`:

```powershell
# Run as the user who installed Harness with install.ps1 (the Windows workflow's install job; the VM end to end,
# docs/testing/windows-cli-e2e.md scenario 1). Checks what the install promises: the version, the scheduled task, the
# user PATH entry, a running daemon, and a PowerShell harness on the terminal host. Prints each check; exits 1 on the first that fails.
param([Parameter(Mandatory)][string]$Version, [string]$Project = (Join-Path $env:TEMP 'harness-check-proj'))
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.harness'
$harness = Join-Path $root 'bin\harness.exe'
function Fail([string]$message) { Write-Host "FAIL $message"; exit 1 }

$v = ((& $harness version) | Select-Object -First 1).Trim()
if ($v -ne $Version) { Fail "harness version says '$v', expected '$Version'" }
Write-Host "ok   version $v"

# This user's own task, in the root folder (harnessd/platform.ts taskName: the account name without its domain).
$task = "Harness harnessd ($env:USERNAME)"
schtasks.exe /Query /TN $task /FO LIST /V | Out-Host
if ($LASTEXITCODE -ne 0) { Fail "the task '$task' is not registered" }
Write-Host "ok   task $task"

$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$bin = (Join-Path $root 'bin').ToLower()
$onPath = @($raw -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim('"').TrimEnd('\').ToLower() -eq $bin })
if ($onPath.Count -ne 1) { Fail "the user PATH names $bin $($onPath.Count) times: $raw" }
Write-Host "ok   PATH has $bin"

$deadline = (Get-Date).AddSeconds(90)
do { $status = (& $harness status) -join "`n"; if ($status -match 'running') { break }; Start-Sleep 2 } while ((Get-Date) -lt $deadline)
if ($status -notmatch 'running') { Fail "the daemon is not running:`n$status" }
Write-Host $status

New-Item -ItemType Directory -Force $Project | Out-Null
$created = (& $harness new terminal $Project --json) -join "`n" | ConvertFrom-Json
if (-not $created.ok -or -not $created.agent.id) { Fail "harness new terminal answered: $($created | ConvertTo-Json -Compress)" }
$deadline = (Get-Date).AddSeconds(30)
do { $hosts = @(Get-CimInstance Win32_Process -Filter "Name='harness-pty.exe'"); if ($hosts.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
if (-not $hosts.Count) { Fail 'no harness-pty.exe runs after creating a terminal' }
$shells = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.ParentProcessId -in $hosts.ProcessId })
Write-Host "ok   terminal $($created.agent.id) on harness-pty pid $($hosts[0].ProcessId) ($($shells.Count) shell(s) under it)"
```

`cli/scripts/windows-ci/check-uninstall.ps1`:

```powershell
# Run as the user who installed Harness, after `harness uninstall --yes` (the Windows workflow's install job; the VM
# end to end, docs/testing/windows-cli-e2e.md scenario 7). Waits for the last step, the cmd.exe that removes ~\.harness
# once the CLI has exited, then lists everything of Harness's that is left, and exits 1 when anything is.
# -HookFiles: engine files Harness wrote outside ~\.harness (plugins), comma-separated, which must be gone.
param([int]$WaitSeconds = 120, [string]$HookFiles = '')
$root = Join-Path $env:USERPROFILE '.harness'
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Test-Path $root) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
$left = @()
if (Test-Path $root) { $left += "files: $root holds " + ((Get-ChildItem -Force -Recurse $root | Select-Object -First 20 | ForEach-Object FullName) -join ', ') }
$task = "Harness harnessd ($env:USERNAME)"   # harnessd/platform.ts taskName
schtasks.exe /Query /TN $task 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $left += "task: $task is still registered" }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
$bin = (Join-Path $root 'bin').ToLower()
foreach ($entry in ($raw -split ';')) {
  if ([Environment]::ExpandEnvironmentVariables($entry).Trim('"').TrimEnd('\').ToLower() -eq $bin) { $left += "PATH: $entry is still on the user PATH" }
}
foreach ($p in Get-CimInstance Win32_Process) {
  if ($p.ExecutablePath -and $p.ExecutablePath.ToLower().StartsWith($root.ToLower())) { $left += "process: $($p.Name) $($p.ProcessId) runs from $($p.ExecutablePath)" }
}
foreach ($f in Get-ChildItem -Path $env:TEMP -Filter 'harness-uninstall-*' -ErrorAction SilentlyContinue) {
  $left += "temp: $($f.FullName)" + $(if ($f.Extension -eq '.log') { ': ' + (Get-Content $f.FullName -Raw) } else { '' })
}
foreach ($settings in @('.claude\settings.json', '.codex\hooks.json') | ForEach-Object { Join-Path $env:USERPROFILE $_ }) {
  if ((Test-Path $settings) -and ((Get-Content $settings -Raw) -match 'notify\.mjs')) { $left += "hooks: $settings still runs notify.mjs" }
}
foreach ($file in ($HookFiles -split ',' | Where-Object { $_ })) { if (Test-Path $file) { $left += "hooks: $file is still there" } }
if ($left.Count) { $left | ForEach-Object { Write-Host "LEFT $_" }; exit 1 }
Write-Host 'clean: no file, task, PATH entry, process or hook of Harness is left'
```

Add to `.github/workflows/windows.yml`, after the `windows-pty` job:

```yaml
  # install.ps1 as a person runs it, from a manifest of this build's own files: the runtime, the CLI and the pty payload
  # (spec section 6). Then what the install promises, and `harness uninstall --yes` leaving nothing.
  install:
    needs: windows-pty
    # Not when release.yml calls this workflow for the release payload (B1.13): a release is not a test suite.
    if: ${{ !inputs.release }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - runner: windows-latest
            arch: x64
            artifact: harness-pty-windows-x64
          - runner: windows-11-arm
            arch: arm64
            artifact: harness-pty-windows-arm64
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 30
    env:
      NODE_VERSION: v22.23.2
      CLI_VERSION: 0.0.0-dev.ci${{ github.run_id }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22.23.2
          cache: npm
          cache-dependency-path: cli/package-lock.json
      - uses: actions/download-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ runner.temp }}/pty-payload
      - name: Bundle the CLI
        working-directory: cli
        shell: pwsh
        env:
          ADAPTER_VERSION: ${{ env.CLI_VERSION }}
        run: |
          npm ci
          npm run bundle
      - name: Fetch Node for Windows, checked against nodejs.org's SHASUMS256.txt
        shell: pwsh
        run: |
          $zip = "node-$env:NODE_VERSION-win-${{ matrix.arch }}.zip"
          Invoke-WebRequest "https://nodejs.org/dist/$env:NODE_VERSION/$zip" -OutFile "$env:RUNNER_TEMP\$zip"
          $sums = (Invoke-WebRequest "https://nodejs.org/dist/$env:NODE_VERSION/SHASUMS256.txt").Content
          $want = (($sums -split "`n") | Where-Object { $_ -match " $([regex]::Escape($zip))$" }) -replace ' .*', ''
          $got = (Get-FileHash "$env:RUNNER_TEMP\$zip" -Algorithm SHA256).Hash.ToLower()
          if (-not $want -or $got -ne $want) { throw "$zip is $got, SHASUMS256.txt says '$want'" }
      - name: Write the install manifest of this build (B1's windows-install-manifest.mjs)
        shell: pwsh
        run: |
          # Built on demand without HARNESS_PTY_VERSION, the host reports the crate's version (pty/src/cli.rs), so its
          # version folder is named the same.
          $ptyVersion = (Select-String -Path pty/Cargo.toml -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
          node cli/scripts/windows-install-manifest.mjs --out "$env:RUNNER_TEMP\manifest" --cli-dir cli/dist `
            --pty-dir "$env:RUNNER_TEMP\pty-payload" --node-zip "$env:RUNNER_TEMP\node-$env:NODE_VERSION-win-${{ matrix.arch }}.zip" `
            --version $env:CLI_VERSION --pty-version $ptyVersion
          if ($LASTEXITCODE -ne 0) { throw "windows-install-manifest.mjs exited $LASTEXITCODE" }
          Get-Content "$env:RUNNER_TEMP\manifest\install-manifest.json"
      - name: Install with Windows PowerShell, as a person does
        shell: pwsh
        run: |
          # No update may replace the build under test (a local build never auto-updates, and this pins it anyway).
          [Environment]::SetEnvironmentVariable('ADAPTER_UPDATE_DISABLE', 'true', 'User')
          powershell.exe -NoProfile -ExecutionPolicy Bypass -File cli\scripts\install.ps1 -Manifest "$env:RUNNER_TEMP\manifest\install-manifest.json"
          if ($LASTEXITCODE -ne 0) { throw "install.ps1 exited $LASTEXITCODE" }
          # install.ps1 does not start the daemon itself: a task Task Scheduler would not run leaves it down, and the
          # installer says to run `harness start` (B1.8). That starts it directly through harness-launch.exe (B3.15).
          $harness = "$env:USERPROFILE\.harness\bin\harness.exe"
          if (((& $harness status) -join "`n") -notmatch 'running') {
            Write-Host '::notice::the scheduled task did not start harnessd here; starting it with harness start'
            & $harness start
            if ($LASTEXITCODE -ne 0) { throw "harness start exited $LASTEXITCODE" }
          }
      - name: Check the install
        shell: pwsh
        run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File cli\scripts\windows-ci\check-install.ps1 -Version $env:CLI_VERSION
      - name: Keep the logs before the uninstall removes them
        if: always()
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\logs" | Out-Null
          foreach ($dir in @("$env:USERPROFILE\.harness\cli\data", "$env:USERPROFILE\.harness\pty\logs")) {
            if (Test-Path $dir) { Get-ChildItem $dir -Filter '*.log' -Recurse | Copy-Item -Destination "$env:RUNNER_TEMP\logs" }
          }
      - name: Uninstall, and check nothing is left
        shell: pwsh
        run: |
          Set-Location $env:USERPROFILE
          & "$env:USERPROFILE\.harness\bin\harness.exe" uninstall --yes
          if ($LASTEXITCODE -ne 0) { throw "harness uninstall exited $LASTEXITCODE" }
          powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:GITHUB_WORKSPACE\cli\scripts\windows-ci\check-uninstall.ps1"
          if ($LASTEXITCODE -ne 0) { throw 'harness uninstall left something behind' }
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: install-logs-${{ matrix.arch }}
          path: ${{ runner.temp }}/logs
```

- [ ] **Step 2: Lint**

Run: `GOTOOLCHAIN=go1.26.8 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/windows.yml && cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts src/scripts/windowsInstallManifest.spec.ts`
Expected: actionlint silent; B1's workflow and manifest specs still pass.

- [ ] **Step 3: Windows verification (workflow, once, after the branch is pushed)**

Run: `gh workflow run windows.yml --ref feat/windows-native-cli && sleep 5 && gh run list --workflow windows.yml --limit 1`, then
`gh run watch <id> --exit-status`.
Expected: `windows-pty` (2 jobs) and `install` (2 jobs) green. In each install log: `ok   version 0.0.0-dev.ci<run>`,
`ok   task Harness harnessd (<the runner's user>)`, `ok   PATH has …`, `● running`, `ok   terminal … on harness-pty pid …`, then
`clean: no file, task, PATH entry, process or hook of Harness is left`. Record the run link in the PR. If the hosted
runner's session cannot run a logon task, record the reason from the "Install" step (install.ps1's warning, then the
`::notice::` line) and check that `harness start` started the daemon directly through `harness-launch.exe` (B3.15,
spec §3 risks). That fallback is still a pass; a failed install is a fail.

- [ ] **Step 4: Commit**

```bash
git add cli/scripts/windows-ci/check-install.ps1 cli/scripts/windows-ci/check-uninstall.ps1 .github/workflows/windows.yml
git commit -m "ci(windows): install this build with install.ps1, check it, uninstall it and check nothing is left"
```

### Task B5.13: Tools for the VM end to end

**Files**
- Modify: `cli/scripts/windows-pty-e2e/driver.mts:12-14` (the machine id) and `:43` (the port)
- Modify: `cli/scripts/windows-pty-e2e/e2e.mts:7` (the state file) and `:14` (the default folder)
- Create: `cli/scripts/windows-cli-e2e/vm.sh`
- Create: `cli/scripts/windows-cli-e2e/first-login.sh`
- Create: `cli/scripts/windows-cli-e2e/run.cmd`
- Create: `cli/scripts/windows-cli-e2e/procs.ps1`
- Create: `cli/scripts/windows-cli-e2e/trust-probe.mjs`
- Create: `cli/scripts/windows-cli-e2e/approve-qr.mts`
- Create: `cli/scripts/windows-cli-e2e/serve-updates.sh`

**Interfaces**
- Consumes: A's driver (`cli/scripts/windows-pty-e2e/driver.mts`, `e2e.mts`, `build.sh`); B2's header name
  `x-harness-auth` and its value `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>`, the nonce being the pipe's 32-hex id and
  32 random hex digits (B2.1); `controlPlaneAuth`, `postJson` (`cli/src/lib/controlPlane.ts:53,63`); the backend route
  `POST /api/auth/qr/approve {code}` (`backend/src/routes/qrSignIn.ts:113`); the QR link `…/signin#k=<code>`
  (`cli/src/lib/qrSignIn.ts:17`) and the `--json` events `qr {url}`, `confirm {email}`, `result` (`cli/src/cli.ts:612,621`).
- Produces: the driver's `E2E_PORT`, `E2E_STATE`, `E2E_MACHINE_ID`, `E2E_PROJECT` overrides (unset, A's defaults are
  unchanged); the scripts above, used by B5.14.

- [ ] **Step 1: Driver overrides.** In `driver.mts` replace lines 12-14 with:

```ts
export function machineId(): string {
  // Signed in, the daemon answers as the account's machine, not this computer's id (cli.ts wantedDaemonIdentity).
  return process.env.E2E_MACHINE_ID ?? readFileSync(process.env.ADAPTER_COMPUTER_ID_FILE ?? 'C:\\work\\e2e\\computer-id', 'utf8').trim()
}
```

and line 43 with:

```ts
  async connect(url = `ws://127.0.0.1:${process.env.E2E_PORT ?? '18473'}/api/local-ws`): Promise<this> {
```

In `e2e.mts` line 7: `const STATE = process.env.E2E_STATE ?? 'C:\\work\\e2e\\state.json'`; line 14:
`async function create(engine: string, cwd = process.env.E2E_PROJECT ?? 'C:\\work\\e2e\\proj', extra: Record<string, unknown> = {}) {`.

Run: `cd cli && scripts/windows-pty-e2e/build.sh "$(mktemp -d)"`
Expected: it prints the path of `e2e.mjs`; esbuild reports no error.

- [ ] **Step 2: Create the scripts.** `cli/scripts/windows-cli-e2e/vm.sh`:

```bash
#!/usr/bin/env bash
# vm.sh <user> <script.ps1|file> [args…]: copy a script to the Windows VM as <user> (into %USERPROFILE%\e2e\) and, for a
# .ps1, run it there with Windows PowerShell and [args…]. Keeps the VM's cmd shell out of the quoting
# (docs/testing/windows-cli-e2e.md). VM_HOST names another machine (default 192.168.65.3).
set -euo pipefail
user=$1 file=$2
shift 2
host=${VM_HOST:-192.168.65.3}
ssh -o BatchMode=yes "$user@$host" "if not exist e2e mkdir e2e" >/dev/null
scp -q -o BatchMode=yes "$file" "$user@$host:e2e/"
case "$file" in
  *.ps1) exec ssh -o BatchMode=yes "$user@$host" "powershell -NoProfile -ExecutionPolicy Bypass -File e2e\\$(basename "$file") $*" ;;
esac
```

`cli/scripts/windows-cli-e2e/first-login.sh`:

```bash
#!/usr/bin/env bash
# first-login.sh <user> <password>: the first SSH sign-in of a new local Windows account, by password, which creates its
# profile and installs this Mac's public key (VM_KEY, default ~/.ssh/id_ed25519.pub) for it, so every later command
# signs in by key. The account must not be an administrator: sshd reads administrators' keys from ProgramData.
set -euo pipefail
user=$1 password=$2 host=${VM_HOST:-192.168.65.3}
key=$(cat "${VM_KEY:-$HOME/.ssh/id_ed25519.pub}")
ps="\$d = Join-Path \$env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force \$d | Out-Null
\$f = Join-Path \$d 'authorized_keys'
Set-Content -Path \$f -Value '$key' -Encoding ascii
icacls.exe \$f /inheritance:r /grant \"\${env:USERNAME}:F\" /grant 'SYSTEM:F' | Out-Null
whoami"
encoded=$(printf '%s' "$ps" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
SSH_PASSWORD=$password expect -c "
  set timeout 90
  spawn ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no $user@$host powershell -NoProfile -EncodedCommand $encoded
  expect {
    \"password:\" { send \"\$env(SSH_PASSWORD)\r\"; exp_continue }
    eof
  }
"
ssh -o BatchMode=yes "$user@$host" whoami
```

`cli/scripts/windows-cli-e2e/run.cmd` (copied to `%USERPROFILE%\e2e\`, beside `e2e.mjs`):

```bat
@echo off
rem The PTY driver (cli\scripts\windows-pty-e2e) against THIS user's installed daemon: run.cmd <command> [args].
rem E2E_PORT and E2E_MACHINE_ID may be set by the caller; the defaults are the install's.
if not defined E2E_PORT set E2E_PORT=18474
set E2E_STATE=%USERPROFILE%\e2e\state.json
set E2E_PROJECT=%USERPROFILE%\proj
set ADAPTER_COMPUTER_ID_FILE=%USERPROFILE%\.harness\computer-id
if not exist "%E2E_PROJECT%" mkdir "%E2E_PROJECT%"
"C:\Program Files\nodejs\node.exe" "%USERPROFILE%\e2e\e2e.mjs" %*
```

`cli/scripts/windows-cli-e2e/procs.ps1` (run as `admin`, which sees every user's processes):

```powershell
# procs.ps1 -User <name>: the Harness processes of one local user (master, core, services, terminal host, ConPTY, shells,
# engines): pid, parent, start time and command line, oldest first.
param([Parameter(Mandatory)][string]$User)
$ProgressPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|harness-pty|harness-launch|OpenConsole|powershell|pwsh|claude|codex|opencode|kilo)\.exe$' } |
  Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $User } |
  Sort-Object CreationDate |
  Select-Object ProcessId, ParentProcessId, Name, @{ n = 'Start'; e = { $_.CreationDate.ToString('HH:mm:ss') } }, @{ n = 'Cmd'; e = { $c = $_.CommandLine; if ($c.Length -gt 110) { $c.Substring(0, 110) } else { $c } } } |
  Format-Table -AutoSize | Out-String -Width 220
```

`cli/scripts/windows-cli-e2e/trust-probe.mjs` (run as the second user with the system Node):

```js
// node trust-probe.mjs <owner-profile> <port>: run on the Windows machine as ANOTHER standard user than the daemon's
// owner. It tries what such a user can reach of the owner's daemon and prints one line per attempt, what came back.
// The owner's files must be unreadable and every trusted call refused (docs/testing/windows-cli-e2e.md, scenario 6).
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const [profile, port] = process.argv.slice(2)
if (!profile || !port) { console.error('usage: node trust-probe.mjs <owner-profile> <port>'); process.exit(2) }
const line = (what, result) => console.log(`${what}: ${result}`)
const call = (options, body) => new Promise((resolve) => {
  const req = request(options, (res) => {
    let text = ''
    res.on('data', (chunk) => { text += chunk })
    res.on('end', () => resolve(`${res.statusCode} ${text.slice(0, 160)}`))
  })
  req.on('error', (error) => resolve(`error ${error.code ?? error.message}`))
  req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  req.end(body)
})

const data = join(profile, '.harness', 'cli', 'data')
for (const file of [join(data, `daemon-${port}.json`), join(data, 'daemon-token'), join(data, 'hook-credential')]) {
  try { readFileSync(file); line(`read ${file}`, 'READABLE') } catch (error) { line(`read ${file}`, `refused ${error.code}`) }
}
const pipes = readdirSync('\\\\.\\pipe\\').filter((name) => name.startsWith('harness-'))
line('harness pipes this user can list', pipes.join(' ') || 'none')
const body = '{}'
const headers = { 'content-type': 'application/json', 'x-adapter-local': '1' }
for (const pipe of pipes) {
  const socketPath = `\\\\.\\pipe\\${pipe}`
  line(`${pipe} POST /api/auth/handoff, no proof`, await call({ socketPath, method: 'POST', path: '/api/auth/handoff', headers }, body))
  // B2's nonce form (pipeAuth.ts newPipeNonce): this pipe's id, then 128 random bits. Only the HMAC is wrong.
  const nonce = pipe.slice(-32) + randomBytes(16).toString('hex')
  const forged = `${nonce}.${createHmac('sha256', randomBytes(32)).update(Buffer.concat([Buffer.from([1]), Buffer.from(nonce)])).digest('hex')}`
  line(`${pipe} POST /api/auth/handoff, forged proof`, await call({ socketPath, method: 'POST', path: '/api/auth/handoff', headers: { ...headers, 'x-harness-auth': forged } }, body))
}
line('loopback POST /api/auth/handoff', await call({ host: '127.0.0.1', port: Number(port), method: 'POST', path: '/api/auth/handoff', headers: { ...headers, host: `127.0.0.1:${port}` } }, body))
```

`cli/scripts/windows-cli-e2e/approve-qr.mts` (run on the Mac, with the Mac's own sign-in):

```ts
// npx tsx scripts/windows-cli-e2e/approve-qr.mts <user@host>: sign the Windows user in to the account this Mac is
// signed in to. It runs `harness login --qr --json` there over SSH, approves the QR's code with this Mac's session (any
// signed-in session may), and answers the sign-in's confirmation. Prints every event.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { controlPlaneAuth, postJson } from '../../src/lib/controlPlane.js'

const destination = process.argv[2]
if (!destination) { console.error('usage: approve-qr.mts <user@host>'); process.exit(2) }
const child = spawn('ssh', ['-o', 'BatchMode=yes', destination, 'harness login --qr --json'], { stdio: ['pipe', 'pipe', 'inherit'] })
let result: Record<string, unknown> | null = null
for await (const text of createInterface({ input: child.stdout! })) {
  console.log(text)
  let event: Record<string, unknown>
  try { event = JSON.parse(text) } catch { continue }
  if (event.type === 'qr' && typeof event.url === 'string') {
    const code = decodeURIComponent(new URL(event.url).hash.replace(/^#k=/, ''))
    const { headers } = await controlPlaneAuth()
    console.log(`approved: ${JSON.stringify(await postJson('/api/auth/qr/approve', { code }, headers))}`)
  }
  if (event.type === 'confirm') child.stdin!.write('yes\n')
  if (event.type === 'result') { result = event; break }
}
child.stdin!.end()
process.exitCode = result?.status === 'ok' || result?.status === 'success' ? 0 : 1
```

`cli/scripts/windows-cli-e2e/serve-updates.sh`:

```bash
#!/usr/bin/env bash
# The update server the Windows end to end updates from (docs/testing/windows-cli-e2e.md, scenarios 3 and 4): this
# Mac, at http://$VM_BIND:$VM_PORT/ (default 192.168.65.1:8799, the VM's way to the Mac), serving $SITE.
#   serve-updates.sh build <version>         bundle this tree as <version> into $SITE/<version>/
#   serve-updates.sh break-canary <version>  the same, made to fail `node cli.js version`: the canary rejects it
#   serve-updates.sh break-core <version>    the same, made to fail only as the core (`__run`): it passes the canary
#                                            and dies on probation, so the master rolls back
#   serve-updates.sh offer <version>         point $SITE/cli/metadata.json (key `cli`) at <version>
#   serve-updates.sh serve                   serve $SITE until stopped
set -euo pipefail
site=${SITE:?set SITE to a folder for the update server}
bind=${VM_BIND:-192.168.65.1}
port=${VM_PORT:-8799}
cli="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/cli"
# A statement at the top of a bundle, after its `#!/usr/bin/env node` line: before it, the shebang would be line 2,
# a SyntaxError, and break-core would fail the canary instead of dying on probation.
prepend() { node -e 'const [f, s] = process.argv.slice(1); const fs = require("fs"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^(#![^\n]*\n)?/, (m) => m + s + "\n"))' "$1" "$2"; }
case "${1:-}" in
  build|break-canary|break-core)
    version=$2 out="$site/$2"
    mkdir -p "$out"
    (cd "$cli" && ADAPTER_VERSION="$version" BUNDLE_OUT_DIR="$out" npm run --silent bundle >/dev/null)
    [ "$1" = break-canary ] && prepend "$out/cli.js" 'process.exit(3);'
    [ "$1" = break-core ] && prepend "$out/cli.js" 'if (process.argv[2] === "__run") process.exit(1);'
    shasum -a 256 "$out/cli.js" "$out/notify.mjs" ;;
  offer)
    version=$2 out="$site/$2"
    mkdir -p "$site/cli"
    node -e '
      const [dir, version, base] = process.argv.slice(1), fs = require("fs"), crypto = require("crypto")
      const ref = (name) => { const b = fs.readFileSync(`${dir}/${name}`); return { url: `${base}/${name}`, sha256: crypto.createHash("sha256").update(b).digest("hex"), size: b.length } }
      console.log(JSON.stringify({ cli: { version, cli: ref("cli.js"), notify: ref("notify.mjs") } }, null, 2))
    ' "$out" "$version" "http://$bind:$port/$version" > "$site/cli/metadata.json"
    cat "$site/cli/metadata.json" ;;
  serve)
    exec python3 -m http.server "$port" --bind "$bind" --directory "$site" ;;
  *)
    sed -n '2,9p' "$0" >&2; exit 2 ;;
esac
```

- [ ] **Step 3: Check them**

Run: `chmod +x cli/scripts/windows-cli-e2e/*.sh && bash -n cli/scripts/windows-cli-e2e/vm.sh cli/scripts/windows-cli-e2e/first-login.sh cli/scripts/windows-cli-e2e/serve-updates.sh && node --check cli/scripts/windows-cli-e2e/trust-probe.mjs && cd cli && npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck scripts/windows-cli-e2e/approve-qr.mts`
Expected: no output. If the `tsc` call cannot resolve `../../src/lib/controlPlane.js`, check the file with
`npx tsx --tsconfig tsconfig.json -e "import('./scripts/windows-cli-e2e/approve-qr.mts')"`. That call exits 2 with the
usage line, which shows the module loaded.
Run: `SITE=$(mktemp -d) cli/scripts/windows-cli-e2e/serve-updates.sh build 9.9.1 && SITE=… cli/scripts/windows-cli-e2e/serve-updates.sh offer 9.9.1`
(same `SITE`). Expected: two sha256 lines, then a manifest whose `cli.cli.url` is `http://192.168.65.1:8799/9.9.1/cli.js`.
Run: `S=$(mktemp -d) && SITE=$S cli/scripts/windows-cli-e2e/serve-updates.sh break-core 9.9.2 >/dev/null && head -2 "$S/9.9.2/cli.js"`.
Expected: line 1 is `#!/usr/bin/env node` and line 2 is `if (process.argv[2] === "__run") process.exit(1);`: the
shebang stays first, so the broken build still passes the canary (`node cli.js version`) and dies only as the core.

- [ ] **Step 4: Commit**

```bash
git add cli/scripts/windows-pty-e2e/driver.mts cli/scripts/windows-pty-e2e/e2e.mts cli/scripts/windows-cli-e2e
git commit -m "test(windows): tools for the CLI end to end on the VM"
```

### Task B5.14: The end to end on the VM, and uninstall on macOS and Linux

**Files**
- Modify: `docs/testing/windows-cli-e2e.md` (B3.21 created it with its "B3 lifecycle" section, which stays)
- Create: `cli/scripts/windows-cli-e2e/evidence/<step>.log` (one per step below; no credential, token or password in any)

**Interfaces**
- Consumes: everything above, and all of B1-B4 on this branch. B1 provides the staging publish (B1.13's `release.yml`
  jobs `pty-build` and `windows-staging`, B1.11's Node for Windows, B1.12's `upload-install-ps1.sh`). The staging
  `install.ps1` is `https://cdn.autonomous.ai/harness/staging/cli/install.ps1`; its `$HarnessManifestBase` already names
  the staging manifests, so it installs staging with no `-Manifest` (B1 notes). B3 provides the
  task, self-update over version folders, probation and rollback. B2 provides the pipe and the token. B4 provides the
  hook runners and the engine homes.
- Produces: `docs/testing/windows-cli-e2e.md`, which follows `docs/testing/windows-pty-e2e.md`'s structure: date,
  branch and build, how it was driven, evidence, a summary table, the setup recipe, the results of each scenario,
  fixes made during the run (each its own commit with a test), findings not fixed, known limits, and clean-up.

The procedure. Each step's output goes to `cli/scripts/windows-cli-e2e/evidence/<step>.log` (append with `| tee -a`).
Record the wall-clock time of every step (start, end) in the doc: implementation, validation and waiting are reported
separately (AGENTS.md).

- [ ] **Step 0: Inputs and preflight (Mac)**

```bash
cd "$(git rev-parse --show-toplevel)"
export VM=192.168.65.3 EV=cli/scripts/windows-cli-e2e/evidence SCR=<this session's scratchpad>
mkdir -p "$EV"
# Two standard users. Their passwords stay in the scratchpad, never in the repository.
printf 'hxe2e %s\nhxe2e2 %s\n' "$(openssl rand -base64 18 | tr -d '/+=')" "$(openssl rand -base64 18 | tr -d '/+=')" > "$SCR/vm-users.txt"
P1=$(awk '$1=="hxe2e"{print $2}' "$SCR/vm-users.txt"); P2=$(awk '$1=="hxe2e2"{print $2}' "$SCR/vm-users.txt")
# B1's staging publish of this branch: run it as B1.13 says, and record its run link and version in the doc.
export STAGING_INSTALL_URL=https://cdn.autonomous.ai/harness/staging/cli/install.ps1
curl -fsSL "$STAGING_INSTALL_URL" | grep HarnessManifestBase | tee "$EV/preflight.log"   # expect …/harness/staging/
ssh admin@$VM "netstat -ano | findstr LISTENING | findstr :1847" | tee -a "$EV/preflight.log"
ssh admin@$VM "ver & whoami & powershell -NoProfile -Command \"(Get-CimInstance Win32_OperatingSystem).Caption\"" | tee -a "$EV/preflight.log"
```
Record: the Windows build, whether `C:\work\e2e`'s daemon listens on 18473 (it is not touched in any step), and the
staging release (version and run link). Because 18473 may be taken by that daemon, the new user's daemon runs on **18474**.

- [ ] **Step 1: New local users with clean profiles**

```bash
ssh admin@$VM "net user hxe2e $P1 /add && net user hxe2e2 $P2 /add && net localgroup Users" | tee "$EV/users.log"
cli/scripts/windows-cli-e2e/first-login.sh hxe2e "$P1" | tee -a "$EV/users.log"
cli/scripts/windows-cli-e2e/first-login.sh hxe2e2 "$P2" | tee -a "$EV/users.log"
ssh hxe2e@$VM "setx PORT 18474 & setx ADAPTER_UPDATE_URL http://192.168.65.1:8799/cli/metadata.json & dir %USERPROFILE%" | tee -a "$EV/users.log"
```
Expected: both accounts in `Users` and not in `Administrators`; `whoami` answers `<computer>\hxe2e` and `…\hxe2e2` by key;
`%USERPROFILE%` of hxe2e has no `.harness`. `PORT` and `ADAPTER_UPDATE_URL` are user variables, which the task's
processes inherit. They are test settings, not Harness's, and Step 9 removes them.

- [ ] **Step 2: Scenario 1. Install from staging with `irm`**

```bash
cmd='irm '"$STAGING_INSTALL_URL"' | iex'
enc=$(printf '%s' "$cmd" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
time ssh hxe2e@$VM "powershell -NoProfile -EncodedCommand $enc" | tee "$EV/s1-install.log"
N=$(ssh hxe2e@$VM "harness version" | tr -d '\r'); echo "N=$N" | tee -a "$EV/s1-install.log"
# Over SSH there is no signed-in session, so the task cannot run, and install.ps1 starts nothing itself (B1.8): start
# the daemon as the installer's guide says, as the CI install job does (B5.12). Step 3 shows the task at logon.
ssh hxe2e@$VM "harness status | findstr running || harness start" | tee -a "$EV/s1-install.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e cli/scripts/windows-ci/check-install.ps1 -Version "$N" | tee "$EV/s1-check.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/s1-check.log"
ssh admin@$VM "powershell -NoProfile -Command \"Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 30 | Where-Object Id -in 1116,1117 | Format-List TimeCreated,Message\"" | tee "$EV/s1-defender.log"
ssh hxe2e@$VM "tree /F %USERPROFILE%\.harness\bin %USERPROFILE%\.harness\cli & type %USERPROFILE%\.harness\cli\current" | tee "$EV/s1-layout.log"
```
Record: the install's duration and its output (each step named, no error); `check-install` all `ok`; the process tree
(the master `node.exe` under `svchost`/`taskhostw`, not under the SSH session's `sshd`, and `harness-pty.exe`); any
Defender or SmartScreen detection; the layout (`cli\<N>\`, `cli\current` = N, `cli\notify.mjs`, `bin\harness.exe`,
`bin\harness-launch.exe`).
Pass: every check `ok`, and the daemon survives closing the SSH session. Check that with
`ssh hxe2e@$VM "harness status"` in a new connection.

- [ ] **Step 3: Scenario 2. Reboot: the daemon is back at logon, and the 5-minute trigger brings back a dead master**

```bash
# Sign hxe2e in at boot (Winlogon autologon), so the logon trigger fires as it does for a person at the screen.
ssh admin@$VM "reg add \"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\" /v AutoAdminLogon /t REG_SZ /d 1 /f && reg add \"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\" /v DefaultUserName /t REG_SZ /d hxe2e /f && reg add \"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\" /v DefaultPassword /t REG_SZ /d $P1 /f && shutdown /r /t 5"
until ssh -o ConnectTimeout=5 admin@$VM "echo up" 2>/dev/null; do sleep 5; done
for i in $(seq 1 36); do ssh hxe2e@$VM "harness status" | grep -q running && break; sleep 5; done
ssh hxe2e@$VM "harness status" | tee "$EV/s2-reboot.log"
ssh admin@$VM "powershell -NoProfile -Command \"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime\"" | tee -a "$EV/s2-reboot.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/s2-reboot.log"
# The 5-minute trigger: end the master (admin may), and wait for it to come back.
MASTER=$(ssh hxe2e@$VM "harness status" | tr -d '\r' | awk '/^ *pid /{print $2; exit}')
ssh admin@$VM "taskkill /PID $MASTER /F" | tee "$EV/s2-trigger.log"
date | tee -a "$EV/s2-trigger.log"
for i in $(seq 1 80); do ssh hxe2e@$VM "harness status" | grep -q running && break; sleep 5; done
date | tee -a "$EV/s2-trigger.log"; ssh hxe2e@$VM "harness status" | tee -a "$EV/s2-trigger.log"
ssh admin@$VM "reg delete \"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\" /v DefaultPassword /f & reg add \"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\" /v AutoAdminLogon /t REG_SZ /d 0 /f"
```
Record: the time from boot to `● running`; the master's new pid; the time from `taskkill` to `● running` (at most 5
minutes plus the start). Also reboot once **without** autologon and record whether the daemon runs with nobody signed
in (`procs.ps1 -User hxe2e` from admin). The spec wants a remote machine back after a reboot "with nobody signed in to
a terminal". Note which Task Scheduler logon type B3 chose, and whether that holds with nobody signed in to Windows.
Pass: back at logon, and back within the trigger's period. The no-logon result is recorded either way: a finding if not
up.

- [ ] **Step 4: Scenario 3. Update to N+1 while harnesses run: they survive**

```bash
# On the Mac, in a terminal of its own: the update server.
export SITE="$SCR/updates"; cli/scripts/windows-cli-e2e/serve-updates.sh serve
# In this terminal: the driver for hxe2e, and two harnesses.
cli/scripts/windows-pty-e2e/build.sh "$SCR" && cli/scripts/windows-cli-e2e/vm.sh hxe2e "$SCR/e2e.mjs" && cli/scripts/windows-cli-e2e/vm.sh hxe2e cli/scripts/windows-cli-e2e/run.cmd
ssh hxe2e@$VM "e2e\run.cmd create terminal" | tee "$EV/s3-before.log"     # → TERM id
ssh admin@$VM "copy C:\Users\admin\.claude\.credentials.json C:\Users\hxe2e\.claude\.credentials.json"   # after hxe2e's Claude Code is installed (Step 6 installs it; run Step 6's installs first if needed)
ssh hxe2e@$VM "e2e\run.cmd create claude" | tee -a "$EV/s3-before.log"    # → CLAUDE id
ssh hxe2e@$VM "e2e\run.cmd type <TERM> \"Write-Output ('BEFORE_' + (40+2))\r\" 3000" | tee -a "$EV/s3-before.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/s3-before.log"
# N+1: the next patch version after N (N's x.y.z with z+1; semverGt compares x.y.z only).
N1=<N's x.y.(z+1)>
export SITE="$SCR/updates"; cli/scripts/windows-cli-e2e/serve-updates.sh build "$N1" && cli/scripts/windows-cli-e2e/serve-updates.sh offer "$N1" | tee "$EV/s3-offer.log"
for i in $(seq 1 60); do v=$(ssh hxe2e@$VM "harness version" | tr -d '\r'); [ "$v" = "$N1" ] && break; sleep 10; done
date; ssh hxe2e@$VM "harness version & harness status & type %USERPROFILE%\.harness\cli\current & dir %USERPROFILE%\.harness\cli & certutil -hashfile %USERPROFILE%\.harness\cli\notify.mjs SHA256" | tee "$EV/s3-after.log"
ssh hxe2e@$VM "e2e\run.cmd list" | tee -a "$EV/s3-after.log"
ssh hxe2e@$VM "e2e\run.cmd type <TERM> \"Write-Output ('AFTER_' + (40+2))\r\" 3000" | tee -a "$EV/s3-after.log"
ssh hxe2e@$VM "e2e\run.cmd screen <CLAUDE>" | tee -a "$EV/s3-after.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/s3-after.log"
ssh hxe2e@$VM "findstr /i \"update staged probation handoff\" %USERPROFILE%\.harness\cli\data\harness.log" | tee -a "$EV/s3-after.log"
```
Pass: `harness version` = N+1, `cli\current` = N+1, the stable `cli\notify.mjs` hash = N+1's `notify.mjs` (from
`s3-offer.log`); the same two ids and panes; `AFTER_42`; Claude's screen intact; `harness-pty.exe` keeps its pid and
start time. The master and core pids change as B3 says (record both before and after).

- [ ] **Step 5: Scenario 4. A failing build is rolled back**

```bash
N2=<N1's z+1>; N3=<N2's z+1>
cli/scripts/windows-cli-e2e/serve-updates.sh break-canary "$N2" && cli/scripts/windows-cli-e2e/serve-updates.sh offer "$N2" | tee "$EV/s4-canary.log"
sleep 180; ssh hxe2e@$VM "harness version & type %USERPROFILE%\.harness\cli\current & dir %USERPROFILE%\.harness\cli & findstr /i canary %USERPROFILE%\.harness\cli\data\harness.log" | tee -a "$EV/s4-canary.log"
cli/scripts/windows-cli-e2e/serve-updates.sh break-core "$N3" && cli/scripts/windows-cli-e2e/serve-updates.sh offer "$N3" | tee "$EV/s4-probation.log"
for i in $(seq 1 60); do ssh hxe2e@$VM "findstr /i \"rolled rollback rejected\" %USERPROFILE%\.harness\cli\data\harness.log" | grep -qi "$N3" && break; sleep 10; done
ssh hxe2e@$VM "harness version & harness status & type %USERPROFILE%\.harness\cli\current & type %USERPROFILE%\.harness\cli\update-rejected.json & dir %USERPROFILE%\.harness\cli" | tee -a "$EV/s4-probation.log"
ssh hxe2e@$VM "e2e\run.cmd list & e2e\run.cmd type <TERM> \"Write-Output ('ROLLBACK_' + (40+2))\r\" 3000" | tee -a "$EV/s4-probation.log"
```
Pass: the canary-failing N+2 never becomes `cli\current` (it stays N+1, and the log names the canary failure). The
probation-failing N+3 becomes `cli\current`, its core dies, and the master rewrites `cli\current` to N+1. N+3 is in
`update-rejected.json`, `harness status` runs N+1, the harnesses are still listed and `ROLLBACK_42` comes back. The
`cli\` folder keeps the two newest good versions; older ones are retired (record the listing). Record how long the
rollback took from the offer.

- [ ] **Step 6: Scenario 5. Hooks of Claude Code, Codex, OpenCode and Kilo report to the Mac desktop, as a remote machine**

```bash
# Engines for hxe2e (per-user installs), and the credentials of the VM's admin account (the user's own) for the two that need them.
ssh hxe2e@$VM "powershell -NoProfile -Command \"irm https://claude.ai/install.ps1 | iex\"" | tee "$EV/s5-engines.log"
ssh hxe2e@$VM "npm install -g @openai/codex opencode-ai && npm install -g --allow-scripts=@kilocode/cli @kilocode/cli" | tee -a "$EV/s5-engines.log"
ssh admin@$VM "copy C:\Users\admin\.claude\.credentials.json C:\Users\hxe2e\.claude\ & mkdir C:\Users\hxe2e\.codex & copy C:\Users\admin\.codex\auth.json C:\Users\hxe2e\.codex\ & icacls C:\Users\hxe2e\.claude\.credentials.json /grant hxe2e:F & icacls C:\Users\hxe2e\.codex\auth.json /grant hxe2e:F"
# Sign hxe2e's daemon in to the Mac's account, then restart it on the session.
(cd cli && npx tsx scripts/windows-cli-e2e/approve-qr.mts hxe2e@$VM) | tee "$EV/s5-login.log"
ssh hxe2e@$VM "harness stop & harness start & harness status & harness auth status --json" | tee -a "$EV/s5-login.log"
ssh hxe2e@$VM "type %USERPROFILE%\.claude\settings.json & type %USERPROFILE%\.codex\hooks.json" | tee "$EV/s5-hookfiles.log"
```
Then, on the Mac, open the Harness desktop app. The VM appears as a remote machine named after the VM's computer name.
Make four harnesses on it, Claude Code, Codex, OpenCode and Kilo, in `C:\Users\hxe2e\proj`. Send each
`Reply with only the number: what is 6 times 7?`. The executor drives the app with computer use, or asks the
person to do these four creates and reads the result back. For each tile, record: it shows working while the
engine answers, and idle (or done) with `42` afterwards. Save a screenshot of each to
`cli/scripts/windows-cli-e2e/evidence/s5-desktop-<engine>.png`. On the VM:

```bash
ssh hxe2e@$VM "set E2E_MACHINE_ID=<the VM's machine id, from harness auth status --json or harness machines --json>& e2e\run.cmd list" | tee "$EV/s5-rows.log"
ssh hxe2e@$VM "findstr /i \"[hook\" %USERPROFILE%\.harness\cli\data\harness.log" | tee -a "$EV/s5-rows.log"
```
Pass, per engine: the row has a `sessionId` (the hook bound the conversation), its hook lines are in the log, and the
desktop tile's state followed the turn. Record the hook runner each engine used (B4's declaration, as in
`s5-hookfiles.log`) and the plugin file paths of OpenCode and Kilo (they are Step 9's `-HookFiles`). An engine that does
not run on this VM (OpenCode on ARM64 if B4 could not fix it, F14) is recorded with its exact error, as a finding.
Also resume Claude Code once (`e2e\run.cmd delete <id>` then `e2e\run.cmd resume <id>`). It must come back `resumed: true`:
hooks fix A's F6.

- [ ] **Step 7: Scenario 6. A second user installs too, and cannot make a trusted call to the first**

```bash
# hxe2e2 installs as well (Review Focus 1): its own task, pipe and daemon beside hxe2e's. Its own port, and no update
# from anywhere during the run.
ssh hxe2e2@$VM "setx PORT 18476 & setx ADAPTER_UPDATE_DISABLE true" | tee "$EV/s6-second-user.log"
ssh hxe2e2@$VM "powershell -NoProfile -EncodedCommand $enc" | tee -a "$EV/s6-second-user.log"
ssh hxe2e2@$VM "harness status | findstr running || harness start" | tee -a "$EV/s6-second-user.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e2 cli/scripts/windows-ci/check-install.ps1 -Version "$N" | tee -a "$EV/s6-second-user.log"
# Both tasks, each named for its user (harnessd/platform.ts taskName), in the root folder.
ssh admin@$VM "schtasks /Query /FO LIST | findstr /C:\"Harness harnessd (\"" | tee -a "$EV/s6-second-user.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e2 cli/scripts/windows-cli-e2e/trust-probe.mjs
ssh hxe2e2@$VM "\"C:\Program Files\nodejs\node.exe\" e2e\trust-probe.mjs C:\Users\hxe2e 18474" | tee "$EV/s6-other-user.log"
ssh hxe2e@$VM "harness status" | tee -a "$EV/s6-other-user.log"
# hxe2e2 goes again; hxe2e's daemon and task are not touched by it.
ssh hxe2e2@$VM "cd /d %USERPROFILE% & harness uninstall --yes" | tee -a "$EV/s6-second-user.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e2 cli/scripts/windows-ci/check-uninstall.ps1 | tee -a "$EV/s6-second-user.log"
ssh hxe2e@$VM "harness status & schtasks /Query /TN \"Harness harnessd (hxe2e)\"" | tee -a "$EV/s6-second-user.log"
ssh hxe2e2@$VM "reg delete HKCU\Environment /v PORT /f & reg delete HKCU\Environment /v ADAPTER_UPDATE_DISABLE /f"
```
Pass, second user: hxe2e2's `check-install` is all `ok` with `ok   task Harness harnessd (hxe2e2)`; `schtasks` lists
both `\Harness harnessd (hxe2e)` and `\Harness harnessd (hxe2e2)`; after hxe2e2's uninstall its `check-uninstall` prints
`clean`, while hxe2e's daemon still runs and its task `Harness harnessd (hxe2e)` is still registered.
Pass, trust: every `read …` line is `refused EPERM` or `EACCES`. Every `POST /api/auth/handoff` over a pipe answers a refusal
(401 or 403). The loopback one answers `403`. hxe2e's own trusted path still works: `harness status` reports through
the pipe, and the desktop's Add Phone code works as in Step 6. Record each status code and the pipe names the
other user could list. If anything is `READABLE`, or a trusted call succeeds, stop. Record only "fail, reported" in
the doc and tell the owner, with the evidence kept out of the repository. The repository is public, and a security
finding is reported tersely, without exploit text.

- [ ] **Step 8: Review Focus 4 — the installer run again over a live install.** People re-run the one-line installer
  to "fix" or update. Ruling (B3.15): when the CLI version changed and `harness status` reports a running daemon,
  install.ps1 moves the daemon to the new build by restarting it once, `harness stop` then `harness start`. Agents keep
  running: the terminal host is independent of the daemon, and the new core reattaches them. The same version
  restarts nothing. As hxe2e, with its daemon on N+1 (Steps 4-5) and a PowerShell agent printing a counter. Stop the
  Mac's update server first (Ctrl-C in its terminal), so no update lands during this step.

```bash
ssh hxe2e@$VM "e2e\run.cmd create terminal" | tee "$EV/rf4-reinstall.log"     # → COUNTER id
ssh hxe2e@$VM "e2e\run.cmd type <COUNTER> \"1..100000 | % { 'COUNT_' + \$_; Start-Sleep 1 }\r\" 3000" | tee -a "$EV/rf4-reinstall.log"
ssh hxe2e@$VM "harness version & harness status" | tee -a "$EV/rf4-reinstall.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/rf4-reinstall.log"
# 1. The installer again, over the live install, onto another version: staging's N, while the daemon runs N+1.
time ssh hxe2e@$VM "powershell -NoProfile -EncodedCommand $enc" | tee -a "$EV/rf4-reinstall.log"
ssh hxe2e@$VM "harness version & harness status & dir %USERPROFILE%\.harness\cli & e2e\run.cmd list & e2e\run.cmd screen <COUNTER>" | tee -a "$EV/rf4-reinstall.log"
sleep 5; ssh hxe2e@$VM "e2e\run.cmd screen <COUNTER>" | tee -a "$EV/rf4-reinstall.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/rf4-reinstall.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e cli/scripts/windows-ci/check-install.ps1 -Version "$N" | tee -a "$EV/rf4-reinstall.log"
# 2. Once more, the same version: nothing to move.
ssh hxe2e@$VM "powershell -NoProfile -EncodedCommand $enc" | tee -a "$EV/rf4-reinstall.log"
ssh hxe2e@$VM "harness status" | tee -a "$EV/rf4-reinstall.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/rf4-reinstall.log"
```
Pass: no install fails on a file in use (no "being used by another process" in either run). Run 1 prints
`Moving the running Harness from <N+1> to <N> (your agents keep running)...`, then `harness version` and
`harness status` say N, and the master and core pids changed exactly once (`procs.ps1` before and after). `cli\<N>\`
and `cli\<N+1>\` are both there. The COUNTER terminal keeps its id, its `COUNT_` number is higher on the second
screen than on the first and never went back to 1, and `harness-pty.exe` keeps its pid and start time. `check-install`
is all `ok`, so PATH holds one Harness entry. Run 2 prints no `Moving` line, and the master pid is the same before and
after. Record both runs under "Reinstall over a live install" in the doc (Step 12).

- [ ] **Step 9: Scenario 7. Uninstall leaves nothing**

```bash
ssh hxe2e@$VM "cd /d %USERPROFILE% & harness uninstall --yes" | tee "$EV/s7-uninstall.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e cli/scripts/windows-ci/check-uninstall.ps1 -HookFiles "<OpenCode and Kilo plugin paths from Step 6>" | tee "$EV/s7-check.log"
cli/scripts/windows-cli-e2e/vm.sh admin cli/scripts/windows-cli-e2e/procs.ps1 -User hxe2e | tee -a "$EV/s7-check.log"
ssh hxe2e@$VM "reg query HKCU\Environment & type %USERPROFILE%\.claude\settings.json & type %USERPROFILE%\.codex\hooks.json" | tee -a "$EV/s7-check.log"
ssh hxe2e@$VM "reg delete HKCU\Environment /v PORT /f & reg delete HKCU\Environment /v ADAPTER_UPDATE_URL /f"
```
Pass: the uninstall prints each step and `Harness is uninstalled.`, exit 0, and no error after the CLI exits
(`harness.exe` is renamed or removed by the final detached step, never deleted while it runs). `check-uninstall` prints `clean`. `procs.ps1` lists nothing. The user PATH keeps every other entry
(npm's `%APPDATA%\npm` included). The engine settings files hold no `notify.mjs`, and Codex's
`rules\harness.rules` is gone. Then a second round: install again (Step 2's command) and
`harness uninstall --yes --keep-data`. Check that `cli\data`, `auth` and `computer-id` stay and that the program
(`bin`, `runtime`, the `cli\<version>` folders) is gone. Then uninstall fully with
`harness uninstall --yes` and run `check-uninstall` again.

A half install is repaired by running install.ps1 again, and `harness uninstall` then works (Review Focus 5; B5.9
pins the command itself). A third round:

```bash
ssh hxe2e@$VM "powershell -NoProfile -EncodedCommand $enc" | tee "$EV/s7-half.log"
# Half an install: its pointer gone. harness.exe says to install again, and exits 3 (B1.8).
ssh hxe2e@$VM "del %USERPROFILE%\.harness\cli\current & harness version & echo exit=%ERRORLEVEL%" | tee -a "$EV/s7-half.log"
ssh hxe2e@$VM "powershell -NoProfile -EncodedCommand $enc" | tee -a "$EV/s7-half.log"
ssh hxe2e@$VM "cd /d %USERPROFILE% & harness uninstall --yes" | tee -a "$EV/s7-half.log"
cli/scripts/windows-cli-e2e/vm.sh hxe2e cli/scripts/windows-ci/check-uninstall.ps1 | tee -a "$EV/s7-half.log"
```
Pass: `harness version` prints `Harness is not installed completely. Install it again: …` with `exit=1`; the second
install succeeds over the half install (`cli\current` = N again); the uninstall prints `Harness is uninstalled.`; and
`check-uninstall` prints `clean`.

- [ ] **Step 10: Uninstall on macOS (this Mac, a throwaway home) and Linux (a container)**

macOS, with real launchd only when no Harness job is loaded for this user. The job's label is shared, so with the
person's own Harness job loaded, `harness service install` and `uninstall` here would act on it. Then the launchd half
is skipped entirely, and the uninstall is tested with no service (`HARNESSD_PLATFORM` unset, as `env -i` leaves it);
the doc says which ran:

```bash
if launchctl print gui/$(id -u)/ai.autonomous.harness.harnessd >/dev/null 2>&1; then
  LAUNCHD=0; echo "a Harness job is loaded for this user: the launchd half is skipped; uninstall runs with no service" | tee "$EV/mac-launchd.log"
else
  LAUNCHD=1; echo "no Harness job is loaded: the launchd half runs" | tee "$EV/mac-launchd.log"
fi
T=$(mktemp -d /tmp/hx-uninstall.XXXX); mkdir -p "$T/home" "$T/tmux"
run() { env -i HOME="$T/home" PATH="$T/home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/zsh TMUX_TMPDIR="$T/tmux" PORT=18491 "$@"; }
run bash -c 'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash' | tee "$EV/mac-install.log"
(cd cli && . scripts/lib/build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" BUNDLE_OUT_DIR="$T/dist" npm run --silent bundle)
cp "$T/dist/cli.js" "$T/dist/notify.mjs" "$T/home/.harness/cli/"
if [ "$LAUNCHD" = 1 ]; then run harness service install; else run harness start; fi | tee "$EV/mac-run.log"
run harness new terminal "$T/home" --json | tee -a "$EV/mac-run.log"
run harness uninstall --yes | tee -a "$EV/mac-run.log"
( ls -la "$T/home" "$T/home/.local/bin"; cat "$T/home/.zshrc"; ls "$T/home/Library/LaunchAgents" 2>&1; pgrep -fl "$T/home" || echo "no process" ) | tee -a "$EV/mac-run.log"
[ "$LAUNCHD" = 1 ] && launchctl print gui/$(id -u)/ai.autonomous.harness.harnessd 2>&1 | head -1 | tee -a "$EV/mac-run.log"
rm -rf "$T"
```

Linux (Ubuntu 24.04 container, a non-root user; no systemd user manager, so the service half is the e2e suite's):

```bash
docker run -d --name hx-uninstall ubuntu:24.04 sleep infinity
docker exec hx-uninstall sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils >/dev/null && useradd -m -s /bin/bash hx'
docker exec -u hx hx-uninstall bash -lc 'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash' | tee "$EV/linux-install.log"
(cd cli && . scripts/lib/build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" BUNDLE_OUT_DIR="$SCR/linux-dist" npm run --silent bundle)
docker cp "$SCR/linux-dist/cli.js" hx-uninstall:/home/hx/.harness/cli/cli.js && docker cp "$SCR/linux-dist/notify.mjs" hx-uninstall:/home/hx/.harness/cli/notify.mjs
docker exec -u root hx-uninstall chown hx:hx /home/hx/.harness/cli/cli.js /home/hx/.harness/cli/notify.mjs
docker exec -u hx hx-uninstall bash -lc 'harness start && harness new terminal ~ --json && harness uninstall --yes; echo exit=$?; ls -la ~ ~/.local/bin; grep -n "harness installer" ~/.bashrc ~/.profile; pgrep -u hx -a node || echo "no process"' | tee "$EV/linux-run.log"
docker rm -f hx-uninstall
```
Pass on both: `Harness is uninstalled.`, exit 0. No `~/.harness`. No `harness`/`hn`/`tmux` in `~/.local/bin` (the folder
itself stays). No `# added by harness installer` line. No Harness process. On the Mac, no plist in
`Library/LaunchAgents`, and, when the launchd half ran, `launchctl print` says the job is not found. Record the harness
count the uninstall stopped, how long it took, and (from `mac-launchd.log`) whether the launchd half ran or was
skipped, in the doc's "Uninstall on macOS and Linux" section.

- [ ] **Step 11: Clean-up on the VM, and the account**

```bash
ssh admin@$VM "net user hxe2e /delete & net user hxe2e2 /delete & powershell -NoProfile -Command \"Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like '*\hxe2e*' } | Remove-CimInstance\" & (schtasks /Query /FO LIST | findstr /C:\"Harness harnessd (\" || echo no Harness task left)" | tee "$EV/cleanup.log"
harness machines --json | tee -a "$EV/cleanup.log"     # find the VM's machine signed in in Step 6
harness machines delete <that id> --yes | tee -a "$EV/cleanup.log"
rm -f "$SCR/vm-users.txt"
```
Record that `C:\work\e2e` was not touched (its daemon's pid before Step 1 and after this step), the users and profiles
are gone, no `Harness harnessd (<user>)` task is left (`no Harness task left`), and the machine is gone from the account.

- [ ] **Step 12: Write `docs/testing/windows-cli-e2e.md`.** Use these sections, filled from the evidence, and keep
  B3.21's "B3 lifecycle" section after "Known limits":

```markdown
# Windows CLI: end-to-end results

Date: <date>. Branch `feat/windows-native-cli`. Build `<N>` from staging (`<STAGING_INSTALL_URL>`), updates `<N+1>`,
`<N+2>` (canary-failing), `<N+3>` (failing on probation) served from the Mac. This is Task B5.14 of the plan; the
spec's testing section is [§6 of the design](../superpowers/specs/2026-10-16-windows-native-cli-design.md#6-testing).

**How it was driven.** <the VM (build, CPUs), two new standard users hxe2e and hxe2e2, SSH by key, the driver on
hxe2e's loopback on port 18474, the Mac's update server, the Mac desktop app for scenario 5.>

**Evidence.** [`cli/scripts/windows-cli-e2e/evidence/`](../../cli/scripts/windows-cli-e2e/evidence/), one log per step:
`preflight`, `users`, `s1-*`, `s2-*`, `s3-*`, `s4-*`, `s5-*`, `s6-other-user`, `s7-*`, `mac-*`, `linux-*`, `cleanup`. No
password, token or credential is in them.

## Summary

| # | Scenario | Result | Time |
|---|---|---|---|
| 1 | Install from staging with `irm`, as a new standard user | | |
| 2 | Reboot: back at logon; a dead master back within the 5-minute trigger; with nobody signed in | | |
| 3 | Update to N+1 with a terminal and Claude Code running: both survive | | |
| 4 | Canary-failing N+2 never used; N+3 failing on probation rolled back | | |
| 5 | Claude Code, Codex, OpenCode and Kilo hooks report to the Mac desktop (remote) | | |
| 6 | Another local user: no file readable, no trusted call accepted | | |
| 7 | Uninstall: no task, no PATH entry, no files, no process, no hook; --keep-data keeps the data; a half install repaired, then uninstalled | | |
| RF4 | Reinstall over a live install: one restart onto the new build, agents keep running; the same version restarts nothing | | |
| — | Uninstall on macOS (launchd, or no service when a Harness job is loaded) and Linux | | |
| — | Windows workflow run (`windows.yml`, install job) | <run link> | |

## Setup recipe
## Scenario results
### Scenario 1 … ### Scenario 7
### Reinstall over a live install
<Step 8: both runs, the `Moving the running Harness …` line, the master and core pids before and after, the
COUNTER screens, `harness-pty.exe`'s pid.>
### Uninstall on macOS and Linux
<whether the launchd half ran, or was skipped because a Harness job was loaded (the uninstall then ran with no service).>
## Fixes made during the run
## Findings not fixed
## Known limits
## Clean-up done
```

Each scenario section states what was run, what came back, and the pass condition from its step, with the figures (pids,
versions, durations, status codes). A failure is a failure: a fix made during the run gets its own commit with a
test that fails without it, as A's F1-F4 did. Then the scenario is run again and both runs are recorded. A finding
not fixed is numbered (G1, G2, …) with what was seen and where in the code it comes from.

- [ ] **Step 13: Commit**

```bash
git add docs/testing/windows-cli-e2e.md cli/scripts/windows-cli-e2e/evidence
git commit -m "docs: Windows CLI end-to-end results, and uninstall on macOS and Linux"
```

### Phase B5 notes

**Verified while writing this part**
- `install.sh` already marks its PATH lines: `marker='# added by harness installer'` (line 177). `ensure_rc` writes
  `\n<marker>\n<line>\n` (line 182), and fish writes `fish_add_path <expanded home>/.local/bin` (line 204). It is the
  only marker form in this repository's history, so install.sh needs no task.
- There is no hook-removal path today, only recognizers: `isOurs`, `isManagedHookCommand` and `foreignHookBlocks`
  (`notifyHooks.ts:74-133`), `isMessagesBlock` (`messagesHook.ts:124`), `stripOwnedBlocks` for Hermes
  (`nativeHookYaml.ts:78`), the plugin first-line ownership check (`nativePlugin.ts:24-27`) and `removeNativePlugin`
  for OpenCode 1's plugin (`nativePlugin.ts:74`). B5.5 and B5.6 build removal on them and add no new recognizer.
- `shutdown` is refused while the host has any pane (`pty/src/panes.rs:777-787`). `kill` takes the pane out of the
  table at once and gives it its grace in the background (`panes.rs:566-586`). Hence kill, wait for the grace, then
  shut down.
- `ci-plan.py` names no workflow file. Before B1, the only reference to `windows-pty.yml` outside docs is actionlint's
  list (`ci.yml:90`); B1.13 adds `release.yml`'s `pty-build`, `windowsWorkflows.spec.ts` and B1.3's comment in
  `pty/src/cli.rs`, which B5.11 renames too.
- The e2e harness already runs `harness service` against fake launchctl and systemctl under a throwaway home
  (`e2e/cli.e2e.ts:125-166`). B5.10 reuses it, so uninstall under both platforms needs no new rig.
- `fetchManifest` accepts `http:` URLs, while `artifactFor` (runtimes) refuses anything but `https:`
  (`runtimeInstall.ts:46`). The VM's update server can therefore serve CLI builds over plain HTTP, but not runtimes.

**Open risks**
- B5.12 writes its manifest with B1.9's `windows-install-manifest.mjs` (relative file names beside the manifest, which
  B1.7 allows for a local file), so the job tests B1's own builder and reader together.
- B1.8's launcher is `bin\harness.exe`. Windows can rename a running exe but not delete it, and an overwritten one
  leaves `harness.exe~RF*.TMP` beside it: the final detached removal step (B5.4) runs after the CLI and harness.exe
  exit, and removes such leftovers too. B5.14's uninstall scenario checks nothing is left.
- Hosted runners may not run a logon task in their session. B5.12 Step 3 states what passes then: the reported fallback.
- If the scheduled task fires only at an interactive logon, a rebooted remote machine with nobody signed in stays down.
  B5.14 Step 3 measures this rather than assuming it. That behaviour is B3's choice of logon type.
- On a shared computer, any local user can use loopback TCP's limited trust (as on mac). Scenario 6 checks only that no
  trusted call and no owner file is reachable. Any wider finding is reported privately (public repository).
- On mac and Linux, a harness that Stop Harness refuses keeps running in the person's tmux after the uninstall. It is
  reported by name, and the tmux server is never killed (it is theirs, and is shared with their own sessions).

**Decisions**
- Decision: the order is harnesses, service, daemon, terminal host, hooks, launchers, PATH, files. The spec lists the
  daemon first. The harnesses are stopped through the running daemon, which knows their processes. The service goes
  before the daemon, so that neither launchd's KeepAlive nor the task's 5-minute trigger brings the daemon back
  mid-uninstall.
- Decision: "agents end" means Stop Harness (`agent_delete`) for every row through the daemon, on every OS, then the
  terminal host's leftover panes. The person's tmux server is never killed, because it is shared with their own
  sessions.
- Decision: a service that will not unregister, or a daemon that will not stop, aborts before anything is deleted.
  Leftover state would launch a program that is gone. Any other step's failure is reported, the rest is still done,
  and the exit code is 1.
- Decision: the shell PATH line stays when `~/.local/bin` still holds other commands (Claude Code's native installer,
  uv, pipx put theirs there). Removing the line would break them, and the folder is not Harness's.
- Decision: a startup file that is a symlink is edited in place, so a dotfiles link is not replaced with a copy.
- Decision: `--keep-data` removes only the program (`bin`, `runtime`, `pty`, everything in `cli` except the data
  folder). It keeps every other product-root folder (auth, computer-id, connections, dsh, memory, tui, logs). State is
  spread over them, and a reinstall must find the same machine and sign-in.
- Decision: entries named `desktop-app*` are never removed. They are the desktop app's own state, and the output says
  that the app sets Harness up again.
- Decision: a data or auth folder outside `~/.harness` (ADAPTER_DATA_DIR, HARNESS_AUTH_DIR) is named and left alone. A
  custom path could be any folder.
- Decision: `harness uninstall` refuses on Harness OS. The OS package owns the CLI there, as `harness service` refuses.
- Decision: on Windows it refuses when the terminal's cwd is inside `~\.harness`. Windows cannot delete a folder a
  process is in.
- Decision: the Windows last step is started through WMI `Win32_Process.Create`, outside the CLI's job, falling back
  to a detached spawn. A plain detached child dies with an SSH session (A's F16). The script waits at most 120 s for the
  CLI's pid, retries busy paths ten times, writes leftovers to `%TEMP%\harness-uninstall-<pid>-<t>.log` and deletes
  itself.
- Decision: the Windows PATH entry is removed by reading the raw value (DoNotExpandEnvironmentNames) and writing it
  back as its own kind, then sending WM_SETTINGCHANGE. .NET's Environment API would expand and flatten the person's
  other `%VAR%` entries. A value of another kind (MultiString) is reported, not edited.
- Decision: Codex's `hooks.state` trusted-hash records in `config.toml` are left. They name hooks that no longer exist,
  and editing the person's TOML for inert entries is not worth the risk. Harness's whole-file `rules/harness.rules`
  is removed.
- Decision: Claude Code's `permissions.allow` entries that equal Harness's generated rules are removed. They name the
  `harness` command, which no longer exists, and only exact matches go.
- Decision: a JSON hook file named `harness.json` (Grok's, Copilot's) is deleted whole once nothing of anybody else's
  is left in it. An emptied startup file or settings file is left in place, empty.
- Decision: the VM's updates come from an HTTP server on the Mac, not the staging bucket. Broken builds (canary,
  probation) must not be published, even to staging. Only the base install comes from staging, as the spec asks.
- Decision: the VM test user's daemon runs on port 18474. `C:\work\e2e`'s signed-in daemon may hold 18473, and it is
  never touched.
- Decision: the reboot scenario signs the user in with Winlogon autologon, set and removed by admin, and also runs once
  without it. The logon trigger needs a logon, and the no-logon result answers the spec's remote-machine case.


---

