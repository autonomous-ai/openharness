/**
 * The local gate (`npm run test:vscode` in cli/): the extension, packed as `harness device vscode enable` packs it, in a
 * real VS Code downloaded into a temporary root and run with its own user data, extensions and home, against the
 * devices' real listener and VS Code half (vscodeTerminals.ts). Never the developer's VS Code, its settings, its
 * extensions or their daemon: everything it starts or writes is under the root, which it removes. On a Mac the copy
 * carries a bundle id of its own; after the run LaunchServices forgets it, its own preferences, caches and HTTP storage
 * go, and the run fails if the developer's VS Code's preferences changed (throwawayApp.ts). On Windows the devices
 * listen on a pipe, and the extension reaches them through the real `harness.exe` (HARNESS_EXE_BIN), in an install
 * under the throwaway's profile whose CLI answers `device vscode link`. The clean-up kills what the throwaway still runs
 * and runs each of its steps whatever the others did (cleanup.ts); a run clears the roots of runs that ended without
 * theirs (Ctrl+C).
 *
 * The driver (driver/run.cjs) runs as VS Code's extension tests and is the gate's hands: it makes the terminals and says
 * which is active. What the extension reports, and what it does with a `show`, is read at the listener. A page key's
 * bytes are read from a fake alt-screen app's record (driver/altScreenApp.cjs): never Claude Code itself.
 */
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron'
import { exec, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unwatchFile, watch, watchFile, writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vscodeStreams, type VscodeTerminals } from '../../../cli/src/cable/hosts/vscodeTerminals.js'
import { DEVICES_TOKEN_FILE, devicesRecordPath } from '../../../cli/src/devices/listenerPipe.js'
import { buildVersion, packVsix, recordVersion, type VscodeExtensionFiles } from '../../../cli/src/devices/vscodeExtension.js'
import { CLI_POINTER, writePointer } from '../../../cli/src/lib/windows/installLayout.js'
import { newPipePath, readDaemonToken } from '../../../cli/src/lib/windows/pipeAuth.js'
import { openDevicesListener, REFUSED, type DevicesListener, type ListenerStream } from '../../../cli/src/services/devicesListener.js'
import { cleanUp, within } from './cleanup.js'
import {
  assertCmdSafe,
  assertRebranded,
  assertUnchanged,
  forgetPreferences,
  GATE_TMP,
  killThrowaway,
  rebrand,
  removeOwnFolders,
  rootName,
  stamp,
  startedAt,
  sweepLeftovers,
  throwawayProcesses,
  unregister,
  VSCODE_PREFERENCES,
  vscodeOutside,
  type Stamp,
} from './throwawayApp.js'

// @ts-expect-error — plain ESM with no declaration file
const { readVscodeExtensionBundle } = await import('../../../cli/scripts/lib/vscodeExtensionBundle.mjs') as {
  readVscodeExtensionBundle: (version: string) => Promise<string>
}

/** Each wait's bound, inside the test's: a VS Code on a loaded Mac takes tens of seconds to start. */
const UNTIL_MS = 120_000
/** Each clean-up step's bound: the steps all fit in the hook's 300 s. */
const CLEAN_UP_MS = 30_000
const WINDOWS = process.platform === 'win32'
const DRIVER = fileURLToPath(new URL('driver', import.meta.url))

// Run from a VS Code terminal, these name that VS Code's own handles, and a launch or CLI that inherits them could
// reach it. `__CFBundleIdentifier` names the app the gate was started from, and `TERM_PROGRAM*` the terminal: the
// throwaway is neither.
const INHERITED = ['VSCODE_', 'ELECTRON_', 'TERM_PROGRAM']
for (const name of Object.keys(process.env)) {
  if (name === '__CFBundleIdentifier' || INHERITED.some((prefix) => name.startsWith(prefix))) delete process.env[name]
}

let root: string
let executable: string
/** The Mac's app bundle, rebranded before any launch. */
let app: string | undefined
let preferences: Stamp | undefined
let userData: string
let extensions: string
let home: string
let files: VscodeExtensionFiles
let listener: DevicesListener | null = null
let control: Server | undefined
let driver: Socket | undefined
let launched: Promise<number> | undefined
/** Each reported shell's start, by its pid: the clean-up kills a shell only while it is that process. */
const shellStarts = new Map<number, string>()
let exited: number | Error | undefined
let unwatchLogs: (() => void) | undefined
const answers: { resolve: (line: Record<string, unknown>) => void; reject: (error: Error) => void }[] = []
const opened: { window: string; stream: ListenerStream }[] = []
const states: { terminals: number[]; active: number | null }[] = []
const log: string[] = []

/** Waits are told of each change here: each one checks again as something happens, never on a clock. */
const waiters = new Set<() => void>()
const changed = (): void => {
  for (const check of [...waiters]) check()
}

function until<T>(what: string, found: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const bound = setTimeout(() => {
      waiters.delete(check)
      reject(new Error(`timed out waiting for ${what}; devices log: ${log.join(' | ')}`))
    }, UNTIL_MS)
    const check = (): void => {
      let value: T | undefined
      try {
        value = found()
      } catch (error) {
        clearTimeout(bound)
        waiters.delete(check)
        return reject(error)
      }
      if (value === undefined) return
      clearTimeout(bound)
      waiters.delete(check)
      resolve(value)
    }
    waiters.add(check)
    check()
  })
}

/** One line to the driver, and its answer within UNTIL_MS: a failed ask, or the driver's connection closing, rejects it. */
function ask(what: 'terminals' | 'active' | 'app', args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
    answers.push({ resolve, reject })
    driver!.write(`${JSON.stringify({ ask: what, ...args })}\n`)
  })
  return within(answer, UNTIL_MS, `the driver's answer to ${what}`)
}

const inside = (path: string): boolean => {
  const from = relative(root, path)
  // On Windows a path on another drive comes back absolute.
  return !from.startsWith('..') && !isAbsolute(from)
}

const MINUTE_LINE = /in the last minute: .*, (\d+) page keys, (\d+) scroll lines, (\d+) dropped$/gm

/** The extension's output channel, which VS Code writes to a file under the user data's logs. */
function channelFile(): string {
  const logs = join(userData, 'logs')
  const named = readdirSync(logs, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('Harness Device.log'))
  if (named.length !== 1) throw new Error(`${named.length} Harness Device output files`)
  return join(logs, named[0]!)
}

/** The extension's own counts, summed over every minute line of its output channel. */
function scrollCounts(file: string): { keys: number; lines: number; dropped: number } {
  const sums = { keys: 0, lines: 0, dropped: 0 }
  const text = readFileSync(file, 'utf8')
  for (const [, keys, lines, dropped] of text.matchAll(MINUTE_LINE)) {
    sums.keys += Number(keys)
    sums.lines += Number(lines)
    sums.dropped += Number(dropped)
  }
  return sums
}

/** @vscode/test-electron 2.5 names the Mac binary `Electron`: VS Code 1.110 renamed it to the product's name, and later
 *  releases dropped the old name's link. The bundle's Info.plist names it, as macOS reads it. */
function macExecutable(named: string): string {
  if (process.platform !== 'darwin') return named
  const contents = dirname(dirname(named))
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^</]+)<\/string>/.exec(readFileSync(join(contents, 'Info.plist'), 'utf8'))?.[1]
  return name === undefined ? named : join(contents, 'MacOS', name)
}

/** What VS Code, its CLI and its shells get as their home and PATH: the throwaway's, and the system's programs alone. */
function throwawayEnv(): Record<string, string> {
  if (!WINDOWS) return { HOME: home, PATH: '/usr/bin:/bin' }
  return {
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  }
}

/** The launcher the extension runs first, at its home's path, answering `device vscode link` with `link` and anything
 *  else with exit 1, as a running daemon with a dial plugged in answers. On Windows the real harness.exe, in an install
 *  (lib/windows/installLayout.ts) whose Node is the gate's own: it runs only a Node inside the install's runtime folder. */
function writeLauncher(link: string): void {
  if (!WINDOWS) {
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(launcher, `#!/bin/sh\n[ "$*" = "device vscode link" ] || exit 1\necho '${link}'\n`)
    chmodSync(launcher, 0o755)
    return
  }
  const install = join(home, '.harness')
  mkdirSync(join(install, 'bin'), { recursive: true })
  copyFileSync(process.env.HARNESS_EXE_BIN!, join(install, 'bin', 'harness.exe'))
  const node = join(install, 'runtime', 'node.exe')
  mkdirSync(dirname(node))
  copyFileSync(process.execPath, node)
  writeFileSync(join(install, 'runtime', 'current-node'), `${node}\r\n`)
  mkdirSync(join(install, 'cli', 'gate'), { recursive: true })
  writeFileSync(join(install, 'cli', 'gate', 'cli.js'),
    `if (process.argv.slice(2).join(' ') !== 'device vscode link') process.exit(1)\nconsole.log(${JSON.stringify(link)})\n`)
  writePointer(join(install, 'cli'), CLI_POINTER, 'gate')
}

describe('the extension in a real, throwaway VS Code', () => {
  let streams: VscodeTerminals
  let shells: number[]

  beforeAll(async () => {
    if (WINDOWS && !process.env.HARNESS_EXE_BIN) {
      throw new Error('HARNESS_EXE_BIN names no harness.exe: build it with `cd pty && cargo build --release --bins`, and set it to pty\\target\\release\\harness.exe')
    }
    // The root's own name, under GATE_TMP, is of letters, digits and -.
    if (WINDOWS) assertCmdSafe({ 'the temp folder (TEMP)': GATE_TMP, 'the gate\'s driver': DRIVER })
    if (process.platform === 'darwin') preferences = stamp(VSCODE_PREFERENCES)
    root = mkdtempSync(join(GATE_TMP, rootName(process.pid)))
    const cleared = await sweepLeftovers()
    if (cleared.length) console.warn(`cleared ${cleared.length} roots of gate runs that ended without their clean-up`)
    userData = join(root, 'user-data')
    extensions = join(root, 'extensions')
    home = join(root, 'home')
    executable = macExecutable(await downloadAndUnzipVSCode({ cachePath: join(root, 'vscode'), version: 'stable' }))
    for (const path of [executable, userData, extensions, home]) expect(inside(path), 'a path outside the gate\'s root').toBe(true)
    if (process.platform === 'darwin') {
      app = dirname(dirname(dirname(executable)))
      rebrand(app)
    }
  })

  afterAll(async () => {
    // The driver's run ends with its connection, and VS Code with it.
    driver?.destroy()
    unwatchLogs?.()
    control?.close()
    const ended = (): Promise<unknown> | undefined => launched?.catch(() => {})
    await cleanUp([
      ['VS Code\'s exit', ended],
      ['the throwaway\'s processes', async () => {
        const killed = await killThrowaway(root, shellStarts)
        if (killed.length) console.warn(`killed the throwaway's processes still running: ${killed.join(', ')}`)
      }],
      ['the throwaway\'s end', async () => {
        await ended()
        const left = throwawayProcesses(root).length
        if (left) throw new Error(`${left} of the throwaway's processes still running`)
      }],
      ['the devices\' listener', () => listener?.close()],
      ['LaunchServices', () => {
        if (app !== undefined) unregister(app)
      }],
      // What was killed may still be letting go of its files.
      ['the root', () => rmSync(root, { recursive: true, force: true, maxRetries: 5 })],
      ['the throwaway\'s preferences', () => {
        if (app !== undefined) forgetPreferences()
      }],
      ['the throwaway\'s caches', () => {
        if (app !== undefined) removeOwnFolders()
      }],
      ['the developer\'s VS Code\'s preferences', () => {
        if (preferences === undefined) return
        try {
          assertUnchanged(VSCODE_PREFERENCES, preferences)
        } catch (error) {
          throw new Error(`${(error as Error).message}; ${vscodeOutside(root)}`)
        }
      }],
    ], CLEAN_UP_MS)
  })

  it('installs the packed .vsix with the throwaway\'s own CLI, and its record reads as status reads it', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../../../cli/package.json', import.meta.url), 'utf8')) as { version: string }
    files = JSON.parse(await readVscodeExtensionBundle(version)) as VscodeExtensionFiles
    const vsix = join(root, 'harness-device.vsix')
    writeFileSync(vsix, packVsix(files))
    const cli = resolveCliPathFromVSCodeExecutablePath(executable)
    expect(inside(cli)).toBe(true)
    mkdirSync(home)
    // A profile's own folders, which Windows' programs expect in it.
    if (WINDOWS) for (const folder of ['Local', 'Roaming']) mkdirSync(join(home, 'AppData', folder), { recursive: true })
    if (app !== undefined) assertRebranded(app)
    const args = ['--install-extension', vsix, '--force', '--user-data-dir', userData, '--extensions-dir', extensions]
    // The gate's PATH: the CLI is a script that finds its shell's tools there.
    const env = { ...process.env, ...throwawayEnv(), PATH: process.env.PATH }
    // On Windows the CLI is code.cmd, which only a shell runs (CVE-2024-27980), as @vscode/test-electron runs it; the
    // root's paths hold nothing cmd.exe splits or runs (assertCmdSafe, before the root is made).
    if (WINDOWS) await promisify(exec)(`"${cli}" ${args.map((arg) => `"${arg}"`).join(' ')}`, { env, windowsHide: true })
    else await promisify(execFile)(cli, args, { env })
    expect(recordVersion(readFileSync(join(extensions, 'extensions.json'), 'utf8'))).toBe(buildVersion({ files: () => files }))
  })

  it('reports the shells of two terminals on one vscode stream', async () => {
    streams = vscodeStreams({
      // No agent is listed, so no process table is read.
      processes: () => Promise.resolve([]),
      changed: () => {},
      now: () => performance.now(),
      after: (ms, run) => {
        const timer = setTimeout(run, ms).unref()
        return () => clearTimeout(timer)
      },
      log: (line) => log.push(line),
      // No stroke is guarded here, and nothing of this machine is read: the gate sends its page line itself.
      fullscreen: () => Promise.resolve(false),
      foreground: () => Promise.resolve(undefined),
    })
    const { vscode, 'vscode-state': state } = streams.handlers
    const dataDir = join(root, 'h')
    const socket = join(dataDir, 'devices.sock')
    const pipe = WINDOWS ? { path: newPipePath(), dataDir } : undefined
    // The listener makes only the daemon's own folder; this one is the account's alone, as the devices' is. On Windows
    // the pipe's token makes it, inside the profile.
    if (!WINDOWS) mkdirSync(dataDir, { mode: 0o700 })
    listener = await openDevicesListener({
      path: WINDOWS ? null : socket,
      pipe,
      handlers: {
        vscode: {
          ...vscode,
          open: (message, stream) => {
            const result = vscode.open(message, stream)
            if (result !== REFUSED) {
              opened.push({ window: message.window as string, stream })
              stream.ended.addEventListener('abort', changed)
            }
            changed()
            return result
          },
        },
        'vscode-state': {
          ...state,
          handle: (message, gone) => {
            const result = state.handle(message, gone)
            if (result !== REFUSED) states.push(message as (typeof states)[number])
            changed()
            return result
          },
        },
      },
      log: (line) => log.push(line),
    })
    expect(listener, log.join(' | ')).not.toBeNull()

    writeLauncher(JSON.stringify(pipe
      ? {
        daemon: true,
        devicesPipe: pipe.path,
        devicesToken: readDaemonToken(dataDir, DEVICES_TOKEN_FILE)!.toString('hex'),
        devicesReady: true,
        devicesRecord: devicesRecordPath(dataDir),
      }
      : { daemon: true, devicesSocket: socket, devicesReady: true }))

    const controlPath = WINDOWS ? `\\\\.\\pipe\\harness-gate-${randomBytes(16).toString('hex')}` : join(root, 'c.sock')
    control = createServer((connection) => {
      driver = connection
      let held = ''
      connection.setEncoding('utf8')
      connection.on('data', (chunk) => {
        held += chunk
        for (let end = held.indexOf('\n'); end !== -1; end = held.indexOf('\n')) {
          const line = JSON.parse(held.slice(0, end)) as Record<string, unknown>
          held = held.slice(end + 1)
          const asked = answers.shift()
          if (typeof line.error === 'string') asked?.reject(new Error(`the driver: ${line.error}`))
          else asked?.resolve(line)
        }
      })
      connection.on('close', () => {
        for (const { reject } of answers.splice(0)) reject(new Error('the driver\'s connection closed'))
      })
      changed()
    })
    await new Promise<void>((listening) => control!.listen(controlPath, listening))

    if (app !== undefined) assertRebranded(app)
    launched = runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: DRIVER,
      extensionTestsPath: join(DRIVER, 'run.cjs'),
      // The secrets in memory: the keychain's VS Code item is the developer's VS Code's too.
      launchArgs: ['--user-data-dir', userData, '--extensions-dir', extensions, '--use-inmemory-secretstorage', '--disable-telemetry'],
      extensionTestsEnv: { ...throwawayEnv(), HARNESS_GATE_CONTROL: controlPath },
    })
    launched.then((code) => { exited = code }, (error: Error) => { exited = error }).finally(changed)

    await until('the driver', () => {
      if (driver === undefined && exited !== undefined) throw new Error(`VS Code ended before its driver connected: ${String(exited)}`)
      return driver
    })
    shells = (await ask('terminals')).terminals as number[]
    expect(shells).toHaveLength(2)
    for (const shell of shells) {
      const started = await startedAt(shell)
      if (started !== undefined) shellStarts.set(shell, started)
    }
    await until('one vscode stream', () => (opened.length ? true : undefined))
    await until('a state listing both shells', () =>
      states.some(({ terminals }) => shells.every((shell) => terminals.includes(shell))) || undefined)
    expect(opened).toHaveLength(1)
  })

  it('a show selects the terminal it names', async () => {
    for (let show = 0; show < 2; show++) {
      // The terminal not active, so only the show can make it active; the second show names the other one.
      const shell = (await ask('active')).active === shells[0] ? shells[1]! : shells[0]!
      expect(streams.show({ window: opened[0]!.window, shell }, false)).toBe(true)
      await until(`a state whose active is the shown shell`, () => (states.at(-1)?.active === shell ? true : undefined))
      expect((await ask('active')).active).toBe(shell)
    }
  })

  // VS Code's API does not say where a terminal is scrolled: the extension's count says whether its scroll command ran.
  // Each sum comes a minute after that minute's first event, so the two steps take up to two minutes.
  it('a scroll line runs VS Code\'s scroll command on the active terminal, and nothing on one not active', async () => {
    const active = (await ask('active')).active as number
    const inactive = shells.find((shell) => shell !== active)!
    const file = channelFile()
    // The file, not its folder: a recursive watch of the logs heard none of the extension's writes on a Mac. On Windows
    // a watch hears no write to a file another process holds open (none of 5 on the VM, 2026-11-20): its size is read.
    if (WINDOWS) {
      watchFile(file, { interval: 250 }, changed)
      unwatchLogs = () => unwatchFile(file, changed)
    } else {
      const watcher = watch(file, changed)
      unwatchLogs = () => watcher.close()
    }
    const counted = (lines: number, dropped: number): true | undefined => {
      const sums = scrollCounts(file)
      return sums.lines === lines && sums.dropped === dropped ? true : undefined
    }
    expect(streams.scroll({ window: opened[0]!.window, shell: active }, -3)).toBe(true)
    await until('3 scroll lines and 0 dropped', () => counted(3, 0))
    // After the first line ran: the devices replace a line that waits with one for another shell.
    expect(streams.scroll({ window: opened[0]!.window, shell: inactive }, 2)).toBe(true)
    await until('3 scroll lines and 1 dropped', () => counted(3, 1))
  })

  // Claude Code's fullscreen view moves on PageUp and PageDown: a page line must reach a terminal as those keys' bytes
  // alone, never wrapped as a paste (ESC[200~), which the app turned on as Claude Code does.
  it('a page line presses one PageUp per page in the active terminal, and nothing else reaches it', async () => {
    const window = opened[0]!.window
    const record = join(root, 'app.bin')
    expect(inside(record)).toBe(true)
    writeFileSync(record, '')
    const app = (await ask('app', { node: process.execPath, script: fileURLToPath(new URL('driver/altScreenApp.cjs', import.meta.url)), record })).app as number
    const started = await startedAt(app)
    if (started !== undefined) shellStarts.set(app, started)
    await until('a state listing the app', () => (states.some(({ terminals }) => terminals.includes(app)) ? true : undefined))
    expect(streams.show({ window, shell: app }, false)).toBe(true)
    await until('a state whose active is the app', () => (states.at(-1)?.active === app ? true : undefined))
    expect(streams.scroll({ window, shell: app }, -45, true)).toBe(true)
    await until('5 page keys', () => (scrollCounts(channelFile()).keys === 5 ? true : undefined))
    expect(readFileSync(record)).toEqual(Buffer.from('\x1b[5~'.repeat(5)))
  })

  it('VS Code exits with code 0, and the stream ends gone', async () => {
    driver!.end(`${JSON.stringify({ ask: 'exit' })}\n`)
    expect(await within(launched!, UNTIL_MS, 'VS Code\'s exit')).toBe(0)
    await until('the stream\'s end', () => (opened[0]!.stream.ended.aborted ? true : undefined))
    expect(opened[0]!.stream.ended.reason).toBe('gone')
  })
})
