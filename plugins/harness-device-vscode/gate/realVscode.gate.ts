/**
 * The local gate (`npm run test:vscode` in cli/): the extension, packed as `harness device vscode enable` packs it, in a
 * real VS Code downloaded into a temporary root and run with its own user data, extensions and home, against the
 * devices' real listener and VS Code half (vscodeTerminals.ts). Never the developer's VS Code, its settings, its
 * extensions or their daemon: everything it starts or writes is under the root, which it removes. On a Mac the copy
 * carries a bundle id of its own, LaunchServices forgets it after the run, and the run fails if the developer's VS Code's
 * preferences changed (throwawayApp.ts).
 *
 * The driver (driver/run.cjs) runs as VS Code's extension tests and is the gate's hands: it makes the terminals and says
 * which is active. What the extension reports, and what it does with a `show`, is read at the listener.
 */
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vscodeStreams, type VscodeTerminals } from '../../../cli/src/cable/hosts/vscodeTerminals.js'
import { buildVersion, packVsix, recordVersion, type VscodeExtensionFiles } from '../../../cli/src/devices/vscodeExtension.js'
import { openDevicesListener, REFUSED, type DevicesListener, type ListenerStream } from '../../../cli/src/services/devicesListener.js'
import { assertRebranded, assertUnchanged, rebrand, stamp, unregister, VSCODE_PREFERENCES, type Stamp } from './throwawayApp.js'

// @ts-expect-error — plain ESM with no declaration file
const { readVscodeExtensionBundle } = await import('../../../cli/scripts/lib/vscodeExtensionBundle.mjs') as {
  readVscodeExtensionBundle: (version: string) => Promise<string>
}

/** Each wait's bound, inside the test's: a VS Code on a loaded Mac takes tens of seconds to start. */
const UNTIL_MS = 120_000

// Run from a VS Code terminal, these name that VS Code's own handles, and a launch or CLI that inherits them could
// reach it.
for (const name of Object.keys(process.env)) if (name.startsWith('VSCODE_') || name.startsWith('ELECTRON_')) delete process.env[name]

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
let exited: number | Error | undefined
const answers: ((line: Record<string, unknown>) => void)[] = []
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

/** One line to the driver, and its answer. */
function ask(what: 'terminals' | 'active'): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    answers.push(resolve)
    driver!.write(`${JSON.stringify({ ask: what })}\n`)
  })
}

const inside = (path: string): boolean => !relative(root, path).startsWith('..')

/** @vscode/test-electron 2.5 names the Mac binary `Electron`: VS Code 1.110 renamed it to the product's name, and later
 *  releases dropped the old name's link. The bundle's Info.plist names it, as macOS reads it. */
function macExecutable(named: string): string {
  if (process.platform !== 'darwin') return named
  const contents = dirname(dirname(named))
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^</]+)<\/string>/.exec(readFileSync(join(contents, 'Info.plist'), 'utf8'))?.[1]
  return name === undefined ? named : join(contents, 'MacOS', name)
}

describe('the extension in a real, throwaway VS Code', () => {
  let streams: VscodeTerminals
  let shells: number[]

  beforeAll(async () => {
    preferences = stamp(VSCODE_PREFERENCES)
    // Short and in /tmp: the devices' socket goes in it, and a Unix socket's path has 96 bytes.
    root = mkdtempSync('/tmp/harness-vscode-gate-')
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
    control?.close()
    await launched?.catch(() => {})
    await listener?.close()
    if (app !== undefined) unregister(app)
    rmSync(root, { recursive: true, force: true })
    if (preferences !== undefined) assertUnchanged(VSCODE_PREFERENCES, preferences)
  })

  it('installs the packed .vsix with the throwaway\'s own CLI, and its record reads as status reads it', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../../../cli/package.json', import.meta.url), 'utf8')) as { version: string }
    files = JSON.parse(await readVscodeExtensionBundle(version)) as VscodeExtensionFiles
    const vsix = join(root, 'harness-device.vsix')
    writeFileSync(vsix, packVsix(files))
    const cli = resolveCliPathFromVSCodeExecutablePath(executable)
    expect(inside(cli)).toBe(true)
    mkdirSync(home)
    if (app !== undefined) assertRebranded(app)
    await promisify(execFile)(cli, ['--install-extension', vsix, '--force', '--user-data-dir', userData, '--extensions-dir', extensions], {
      env: { ...process.env, HOME: home },
    })
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
    })
    const { vscode, 'vscode-state': state } = streams.handlers
    const socket = join(root, 'h', 'devices.sock')
    // The listener makes only the daemon's own folder; this one is the account's alone, as the devices' is.
    mkdirSync(join(root, 'h'), { mode: 0o700 })
    listener = await openDevicesListener({
      path: socket,
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

    // `harness device vscode link`, and nothing else, as a running daemon with a dial plugged in answers it.
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    const link = JSON.stringify({ daemon: true, devicesSocket: socket, devicesReady: true })
    writeFileSync(launcher, `#!/bin/sh\n[ "$*" = "device vscode link" ] || exit 1\necho '${link}'\n`)
    chmodSync(launcher, 0o755)

    const controlPath = join(root, 'c.sock')
    control = createServer((connection) => {
      driver = connection
      let held = ''
      connection.setEncoding('utf8')
      connection.on('data', (chunk) => {
        held += chunk
        for (let end = held.indexOf('\n'); end !== -1; end = held.indexOf('\n')) {
          answers.shift()?.(JSON.parse(held.slice(0, end)) as Record<string, unknown>)
          held = held.slice(end + 1)
        }
      })
      changed()
    })
    await new Promise<void>((listening) => control!.listen(controlPath, listening))

    if (app !== undefined) assertRebranded(app)
    launched = runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: fileURLToPath(new URL('driver', import.meta.url)),
      extensionTestsPath: fileURLToPath(new URL('driver/run.cjs', import.meta.url)),
      // The secrets in memory: the keychain's VS Code item is the developer's VS Code's too.
      launchArgs: ['--user-data-dir', userData, '--extensions-dir', extensions, '--use-inmemory-secretstorage', '--disable-telemetry'],
      extensionTestsEnv: { HOME: home, PATH: '/usr/bin:/bin', HARNESS_GATE_CONTROL: controlPath },
    })
    launched.then((code) => { exited = code }, (error: Error) => { exited = error }).finally(changed)

    await until('the driver', () => {
      if (driver === undefined && exited !== undefined) throw new Error(`VS Code ended before its driver connected: ${String(exited)}`)
      return driver
    })
    shells = (await ask('terminals')).terminals as number[]
    expect(shells).toHaveLength(2)
    await until('one vscode stream', () => (opened.length ? true : undefined))
    await until('a state listing both shells', () =>
      states.some(({ terminals }) => shells.every((shell) => terminals.includes(shell))) || undefined)
    expect(opened).toHaveLength(1)
  })

  it('a show selects the terminal it names', async () => {
    for (const shell of [shells[1]!, shells[0]!]) {
      expect(streams.show({ window: opened[0]!.window, shell }, false)).toBe(true)
      await until(`a state whose active is the shown shell`, () => (states.at(-1)?.active === shell ? true : undefined))
      expect((await ask('active')).active).toBe(shell)
    }
  })

  it('VS Code exits with code 0, and the stream ends gone', async () => {
    driver!.end(`${JSON.stringify({ ask: 'exit' })}\n`)
    expect(await launched).toBe(0)
    await until('the stream\'s end', () => (opened[0]!.stream.ended.aborted ? true : undefined))
    expect(opened[0]!.stream.ended.reason).toBe('gone')
  })
})
