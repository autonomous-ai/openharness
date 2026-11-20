/**
 * A daemon under test on Windows, with a stand-in dial (dialWindows.e2e.ts). `IsolatedDaemon` (daemon.ts) needs tmux,
 * zsh and Unix sockets, none of which Windows has, so this is a harness of its own, sealed the same way: a throwaway
 * root holds the profile, the data folder and every engine home; it is signed out, sets no hook up, and names engines
 * and editors that are not there, so nothing of the account it runs as is read or changed.
 *
 * The dial: `HARNESS_SERIAL_BIN` names a program, so the serial stand-in (src/cable/__fixtures__/fakeHarnessSerial.mjs)
 * runs as one, the run's own `node.exe`. The daemon starts it as `node.exe watch`, `node.exe open COM77` and
 * `node.exe probe COM77`, and Node reads `watch`, `open` and `probe` as scripts in its working folder: three one-line
 * files there put their name back in `argv` and run the stand-in. Its `open` carries the port to the `FakeDial` this
 * serves on a pipe of the run's (`FAKE_SERIAL_OPEN=bridge:`), and its `watch` says the person is at the screen, which
 * the dial's discovery waits for. No product code knows about any of it.
 *
 * The daemon runs from the run's bundle (`E2E_BUNDLE=1`, bundle.ts) and the pty host `HARNESS_PTY_BIN` names, both
 * required.
 *
 * The hand-check desk (scripts/windows-dial-e2e/desk.mts) starts it two more ways: on a real dial, through the signed
 * harness-serial.exe it names, sealed as here; and, for the VM's test user only, with that account's own profile,
 * engines, editors and apps, and Harness's folders kept in one folder of its own.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { daemonEnvironment } from '../../src/testing/daemonEnvironment.js'
import { artifactLog } from './artifacts.js'
import { CLI_ROOT, listeningPort, until } from './daemon.js'
import { SETTINGS } from './desk.js'
import { FakeDial } from './fakeDial.js'

const exec = promisify(execFile)

/** The profile's folder: spaces, Vietnamese letters, `'`, `&` and `%`, each of which a shell or a quoting rule could
 *  break (the plan's Review Focus 3). Every path the daemon is given is under it. */
export const PROFILE_NAME = "Nguyễn Văn A' & 100%"

const STAND_IN = join(CLI_ROOT, 'src', 'cable', '__fixtures__', 'fakeHarnessSerial.mjs')

export interface WindowsDaemonOptions {
  env?: Record<string, string>
  /** What `PORT` is set to; a free port when unset. */
  port?: number
  /**
   * Where Harness's folders are kept, in place of a throwaway root, and kept after `close`. The account's own profile,
   * engines, editors and apps are then used, and its hooks set up: the VM's test user only.
   */
  own?: string
  /** What the stand-in dial's greeting names (`appFilter: 'v1'`, …), as a firmware that speaks them does. */
  capabilities?: Record<string, string>
  /** Each piece of what the daemon prints, as it comes. */
  onOutput?: (text: string) => void
  /** Run once Harness's folders are made, before the daemon starts: a sign-in or a pets folder put in place. What it
   *  throws is thrown back, and nothing is started. */
  prepare?: (folders: { auth: string; devices: string }) => void | Promise<void>
}

/** A real dial on [port], run through [serialBin], a signed harness-serial.exe, in place of the stand-in. Always sealed. */
export interface RealDialOptions extends Omit<WindowsDaemonOptions, 'own' | 'capabilities'> {
  dial: { port: string; serialBin: string }
}

/** What a daemon of the account reads of its profile and apps, passed on as they are when it is not sealed (`own`). */
const ACCOUNT_NAMES = ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'USERNAME']

export interface WindowsDaemon<Dial extends FakeDial | null = FakeDial> {
  dataDir: string
  /** The throwaway root, or the `own` folder. */
  root: string
  /** What `PORT` is set to: it names the daemon's pipe record. */
  port: number
  env: NodeJS.ProcessEnv
  dial: Dial
  /** `harness <args>` from the run's bundle, as a shell of this daemon's runs it. */
  harness(args: string[]): Promise<{ code: number | null; stdout: string }>
  /** Everything the daemon has printed so far. */
  log(): string
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no free port')
  return address.port
}

export function startWindowsDaemon(options?: WindowsDaemonOptions): Promise<WindowsDaemon>
export function startWindowsDaemon(options: RealDialOptions): Promise<WindowsDaemon<null>>
export async function startWindowsDaemon(options: WindowsDaemonOptions | RealDialOptions = {}): Promise<WindowsDaemon<FakeDial | null>> {
  const bundle = process.env.E2E_BUNDLE_PATH
  if (!bundle) throw new Error('E2E_BUNDLE_PATH is not set: run with E2E_BUNDLE=1 through vitest.e2e.windows.config.ts')
  const ptyHost = process.env.HARNESS_PTY_BIN
  if (!ptyHost) throw new Error('HARNESS_PTY_BIN is not set: name the harness-pty.exe built from pty/')

  const real = 'dial' in options ? options.dial : null
  const own = 'own' in options ? options.own : undefined
  const root = own ?? mkdtempSync(join(tmpdir(), 'harness-dial-win-'))
  const discard = (): void => { if (!own) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
  const profile = own ? process.env.USERPROFILE ?? homedir() : join(root, PROFILE_NAME)
  // Harness's folders are where they are on a person's computer, the profile's `.harness`, unless they are kept in `own`.
  const harnessDir = own ?? join(profile, '.harness')
  const sealed = {
    local: join(profile, 'AppData', 'Local'), roaming: join(profile, 'AppData', 'Roaming'), tmp: join(profile, 't'),
    claudeProjects: join(profile, '.claude', 'projects'), codexHome: join(profile, '.codex'),
  }
  const dirs = {
    data: join(harnessDir, 'data'), runtime: join(harnessDir, 'runtime'), auth: join(harnessDir, 'auth'),
    dsh: join(harnessDir, 'dsh'), routes: join(harnessDir, 'hook-routes'), devices: join(harnessDir, 'devices'), work: join(root, 'work'),
  }
  for (const dir of [...Object.values(dirs), ...(own ? [] : Object.values(sealed))]) mkdirSync(dir, { recursive: true })
  const endpoint = `\\\\.\\pipe\\harness-e2e-${randomBytes(8).toString('hex')}`
  if (!real) {
    const standIn = JSON.stringify(pathToFileURL(STAND_IN).href)
    for (const mode of ['watch', 'open', 'probe']) {
      writeFileSync(join(dirs.work, `${mode}.js`), `process.argv.splice(2, 0, ${JSON.stringify(mode)}); import(${standIn})\n`)
    }
  }
  const missing = join(root, 'missing')
  // The profile, every engine home and every editor: the root's, which name engines and editors that are not there, or
  // the account's own.
  const homes: Record<string, string> = own
    ? { HOME: profile, ...Object.fromEntries(ACCOUNT_NAMES.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : [])), DISABLE_HOOK_INSTALL: 'false' }
    : {
        HOME: profile,
        USERPROFILE: profile,
        LOCALAPPDATA: sealed.local,
        APPDATA: sealed.roaming,
        TEMP: sealed.tmp,
        TMP: sealed.tmp,
        CLAUDE_PROJECTS_DIR: sealed.claudeProjects,
        CODEX_HOME: sealed.codexHome,
        DISABLE_HOOK_INSTALL: 'true',
        CLAUDE_PATH: join(missing, 'claude.exe'),
        CODEX_PATH: join(missing, 'codex.exe'),
        HARNESS_VSCODE_BIN: join(missing, 'code.cmd'),
        HARNESS_CURSOR_BIN: join(missing, 'cursor.cmd'),
      }
  // The stand-in dial, found on its own port and served through the stand-in for harness-serial.exe; or a real one, on
  // the port named and through the harness-serial.exe named.
  const dialEnv: Record<string, string> = real
    ? { HARNESSD_TEST_DIAL_PORT: real.port, HARNESS_SERIAL_BIN: real.serialBin }
    : {
        HARNESSD_TEST_DIAL_PORT: 'COM77',
        HARNESS_SERIAL_BIN: process.execPath,
        FAKE_SERIAL_LINES: JSON.stringify([JSON.stringify({ console: true, ports: [] })]),
        FAKE_SERIAL_OPEN: `bridge:${endpoint}`,
      }
  const port = options.port ?? await freePort()
  const env = daemonEnvironment(process.env, {
    NODE_ENV: 'test',
    ...homes,
    PORT: String(port),
    // A bridge port of its own, never the account's daemon's (daemon.ts says why).
    HARNESS_CONNECTIONS_PORT: '0',
    ADAPTER_DATA_DIR: dirs.data,
    ADAPTER_RUNTIME_DIR: dirs.runtime,
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    HARNESS_AUTH_DIR: dirs.auth,
    HARNESS_DEVICES_DIR: dirs.devices,
    DSH_DIR: dirs.dsh,
    HARNESS_HOOK_ROUTES_DIR: dirs.routes,
    HARNESS_PTY_BIN: ptyHost,
    // Signed out, and alone: nothing reaches beyond the machine.
    BACKEND_WS_URL: 'ws://127.0.0.1:9',
    WEB_URL: 'http://127.0.0.1:9',
    HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    ADAPTER_UPDATE_DISABLE: 'true',
    ANALYTICS_ENABLED: 'false',
    DISABLE_GRID_INSTALL: 'true',
    CABLE_DISABLE: 'false',
    ...dialEnv,
    ...options.env,
    // The dial is never flashed: after the caller's own, so nothing turns it off.
    CABLE_FW_DISABLE: 'true',
  })

  try {
    await options.prepare?.({ auth: dirs.auth, devices: dirs.devices })
  } catch (error) {
    discard()
    throw error
  }
  const dial = real ? null : await FakeDial.listen(endpoint, { settings: SETTINGS, capabilities: 'capabilities' in options ? options.capabilities : undefined })
  let output = ''
  const logName = `daemon-${port}.log`
  // On Windows a start keeps the whole environment it is given (lib/startEnvironment.ts): no env file is needed.
  const child: ChildProcess = spawn(process.execPath, [bundle, 'start', '-f'], {
    cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const take = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output += text
    artifactLog(logName, text)
    options.onOutput?.(text)
  }
  child.stdout!.on('data', take)
  child.stderr!.on('data', take)
  const exited = new Promise<void>((done) => child.once('exit', () => done()))

  const harness = (args: string[]): Promise<{ code: number | null; stdout: string }> => new Promise((resolve, reject) => {
    const run = spawn(process.execPath, [bundle, ...args], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    run.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    run.stderr!.on('data', (chunk: Buffer) => artifactLog(`harness-${port}.log`, chunk.toString('utf8')))
    const timer = setTimeout(() => run.kill(), 60_000)
    run.once('error', (error) => { clearTimeout(timer); reject(error) })
    run.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout }) })
  })

  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await harness(['stop']).catch(() => null)
      const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 15_000))])
      // What a stop did not end: the master and its whole tree, the core and the services under it.
      if (!stopped) await exec('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => null)
      await exited
    }
    await dial?.close()
    discard()
  }

  const died = exited.then((): never => { throw new Error(`the daemon exited while starting:\n${output.slice(-4000)}`) })
  died.catch(() => {}) // observed below while starting; afterwards an exit is the test's business
  try {
    await Promise.race([
      died,
      (async () => {
        await until('the daemon to answer on its port', async () => {
          const said = listeningPort(output)
          if (said === null) throw new Error('the daemon has not said which port it listens on yet')
          const response = await fetch(`http://127.0.0.1:${said}/api/health`, { signal: AbortSignal.timeout(5_000) })
          return response.ok
        }, 90_000, 200)
        await until('the daemon to finish starting', () => /\[cli\] ready/.test(output), 60_000, 100)
      })(),
    ])
  } catch (error) {
    await close()
    throw error
  }
  return { dataDir: dirs.data, root, port, env, dial, harness, log: () => output, close }
}
