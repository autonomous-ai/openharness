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
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
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

export interface WindowsDaemon {
  dataDir: string
  /** What `PORT` is set to: it names the daemon's pipe record. */
  port: number
  env: NodeJS.ProcessEnv
  dial: FakeDial
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

export async function startWindowsDaemon(options: { env?: Record<string, string> } = {}): Promise<WindowsDaemon> {
  const bundle = process.env.E2E_BUNDLE_PATH
  if (!bundle) throw new Error('E2E_BUNDLE_PATH is not set: run with E2E_BUNDLE=1 through vitest.e2e.windows.config.ts')
  const ptyHost = process.env.HARNESS_PTY_BIN
  if (!ptyHost) throw new Error('HARNESS_PTY_BIN is not set: name the harness-pty.exe built from pty/')

  const root = mkdtempSync(join(tmpdir(), 'harness-dial-win-'))
  const profile = join(root, PROFILE_NAME)
  const dirs = {
    profile, local: join(profile, 'AppData', 'Local'), roaming: join(profile, 'AppData', 'Roaming'), tmp: join(profile, 't'),
    data: join(profile, '.harness', 'data'), runtime: join(profile, '.harness', 'runtime'), auth: join(profile, '.harness', 'auth'),
    dsh: join(profile, '.harness', 'dsh'), routes: join(profile, '.harness', 'hook-routes'),
    claudeProjects: join(profile, '.claude', 'projects'), codexHome: join(profile, '.codex'), work: join(root, 'work'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const standIn = JSON.stringify(pathToFileURL(STAND_IN).href)
  for (const mode of ['watch', 'open', 'probe']) {
    writeFileSync(join(dirs.work, `${mode}.js`), `process.argv.splice(2, 0, ${JSON.stringify(mode)}); import(${standIn})\n`)
  }
  const missing = join(root, 'missing')
  const endpoint = `\\\\.\\pipe\\harness-e2e-${randomBytes(8).toString('hex')}`
  const port = await freePort()
  const env = daemonEnvironment(process.env, {
    NODE_ENV: 'test',
    HOME: dirs.profile,
    USERPROFILE: dirs.profile,
    LOCALAPPDATA: dirs.local,
    APPDATA: dirs.roaming,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    PORT: String(port),
    // A bridge port of its own, never the account's daemon's (daemon.ts says why).
    HARNESS_CONNECTIONS_PORT: '0',
    ADAPTER_DATA_DIR: dirs.data,
    ADAPTER_RUNTIME_DIR: dirs.runtime,
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    HARNESS_AUTH_DIR: dirs.auth,
    DSH_DIR: dirs.dsh,
    CLAUDE_PROJECTS_DIR: dirs.claudeProjects,
    CODEX_HOME: dirs.codexHome,
    HARNESS_HOOK_ROUTES_DIR: dirs.routes,
    HARNESS_PTY_BIN: ptyHost,
    // Signed out, and alone: nothing reaches beyond the machine, and no engine, editor or hook of the account is used.
    BACKEND_WS_URL: 'ws://127.0.0.1:9',
    WEB_URL: 'http://127.0.0.1:9',
    HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    ADAPTER_UPDATE_DISABLE: 'true',
    ANALYTICS_ENABLED: 'false',
    DISABLE_GRID_INSTALL: 'true',
    DISABLE_HOOK_INSTALL: 'true',
    CLAUDE_PATH: join(missing, 'claude.exe'),
    CODEX_PATH: join(missing, 'codex.exe'),
    HARNESS_VSCODE_BIN: join(missing, 'code.cmd'),
    HARNESS_CURSOR_BIN: join(missing, 'cursor.cmd'),
    // The stand-in dial: never flashed, found on its own port, and served through the stand-in for harness-serial.exe.
    CABLE_DISABLE: 'false',
    CABLE_FW_DISABLE: 'true',
    HARNESSD_TEST_DIAL_PORT: 'COM77',
    HARNESS_SERIAL_BIN: process.execPath,
    FAKE_SERIAL_LINES: JSON.stringify([JSON.stringify({ console: true, ports: [] })]),
    FAKE_SERIAL_OPEN: `bridge:${endpoint}`,
    ...options.env,
  })

  const dial = await FakeDial.listen(endpoint, { settings: SETTINGS })
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
    await dial.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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
  return { dataDir: dirs.data, port, env, dial, harness, log: () => output, close }
}
