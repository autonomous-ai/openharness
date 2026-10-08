import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { listenLocalSocket, localSocketPath } from './lib/localSocket.js'
import { fakePlatform } from './testing/fakePlatform.js'
import { alive, SpawnedRuns } from './testing/spawnedRuns.js'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dirs: string[] = []
const children: ChildProcess[] = []
const servers: Server[] = []
/**
 * Every CLI run, each in a process group of its own, ended with everything it started at teardown and
 * at its deadline (testing/spawnedRuns.ts). Twelve `cli.ts start` runs of this file that never exited
 * were found nine hours later, one spinning a core: tsx runs the CLI in a child of its own, a dev-mode
 * start becomes the daemon, and nothing killed either when a test timed out. The daemon a run's pid
 * file names counts as the run's when it is this checkout's CLI.
 */
const runs = new SpawnedRuns((command) => command.includes(CLI_SOURCE))
// A worker that exits with a run still going (a cancelled run) takes the run's group with it.
process.once('exit', () => runs.killAllSync())

afterEach(async () => {
  const { leftBehind, survivors } = await runs.endAll()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // The guard: a run that left a process behind fails the test that ran it, even though teardown has
  // ended it by now. Otherwise the next leak is found the way the last one was, hours later.
  if (survivors.length) throw new Error(`processes this test started would not die:\n${survivors.join('\n')}`)
  if (leftBehind.length) throw new Error(`a CLI run left processes behind:\n${leftBehind.join('\n')}`)
})

/** A throwaway HOME for one CLI run; every path the CLI writes is under it. */
function freshRoot(): string {
  // Keep the private socket below macOS's sockaddr_un path limit.
  const root = mkdtempSync('/tmp/hn-cli-command-')
  dirs.push(root)
  return root
}

function envFor(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_UPDATE_DISABLE: 'true',
    // HOME does not isolate tmux's /tmp socket. Never discover or attach to the
    // developer's real panes during a CLI startup test.
    TERMINAL_BACKENDS: 'tmux',
    TMUX: '',
    TMUX_TMPDIR: root,
    DISABLE_GRID_INSTALL: 'true',
    DISABLE_HOOK_INSTALL: 'true',
    // Nothing listens on port 1. A `start` asks the daemon on PORT which account it serves and would
    // otherwise ask this machine's REAL daemon — and the backend is where a start that decided to
    // (re)start goes next, which must never be the production one.
    PORT: '1',
    BACKEND_WS_URL: 'http://127.0.0.1:1',
    ...extra,
  }
}

/**
 * How long one CLI run may take before it is ended as a hang. Every run here is the CLI itself under tsx:
 * node, then cli.ts and everything it imports, before the command runs. About 2 s on a quiet Mac; past the
 * old 15 s for `harness join` in a full unit run under load (12 busy loops, load 110), where it only prints
 * a refusal. A hang still ends, its group with it; only later.
 */
const CLI_RUN_MS = 45_000
/** A test that makes one such run: room for the run's own deadline and its teardown. */
const ONE_RUN_TEST_MS = CLI_RUN_MS + 15_000

/** `harness [args]` under a throwaway HOME, to the end. Never blocking this process: a test that also
 *  SERVES the CLI something (a manifest on the loopback) has to keep its own event loop free while the
 *  child asks for it. One that has not ended within CLI_RUN_MS is ended, everything it started with it,
 *  and comes back with `timedOut`. */
async function runAsync(root: string, args: string[], extra: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { status, stdout, stderr, timedOut } = await runs.complete(root, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT, env: envFor(root, extra), label: `harness ${args.join(' ')}`, ms: CLI_RUN_MS,
  })
  return { status, stdout, stderr, timedOut }
}

function run(...args: string[]) {
  return runAsync(freshRoot(), args, {})
}

/** A signed-in computer: `start` refuses without one, before it looks at anything else. */
function seedSession(root: string): void {
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(join(root, 'auth', 'session.json'), JSON.stringify({
    version: 1, accessToken: 'tok', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
    autonomousEnv: 'prod', computerId: 'a'.repeat(32), machineId: 'm_seeded', updatedAt: Date.now(),
  }))
}

/** A daemon that is up, as `start` sees one: a pid file naming a live process. A child that idles,
 *  never this process — a `start` that finds the daemon on another account stops it. */
function seedRunningDaemon(root: string): { pid: number; exited: Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'adapter.pid'), `${child.pid}\n`)
  return { pid: child.pid ?? -1, exited: new Promise((resolve) => child.once('exit', () => resolve())) }
}

/** The daemon's status through this user's private socket, plus its occupied TCP control port. */
async function daemonStatusServer(root: string, machineId: string): Promise<number> {
  const handler: RequestListener = (_req, res) => {
    res.setHeader('content-type', 'application/json')
    // A daemon says its pid (and, under a master, the master's), as every release with the socket has:
    // start-up tells a live daemon from the core of a master that is gone by it (lib/localSocket.ts).
    res.end(JSON.stringify({ machineId, version: '0.0.0-test', sessions: [], pid: process.pid, corePid: process.pid }))
  }
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const dir = join(root, 'data')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const privateServer = await listenLocalSocket(handler, localSocketPath(dir, port)!)
  servers.push(privateServer.server)
  return port
}

describe('CLI login/start command contract', () => {
  it('starts without a saved session, serving this computer only, and never opens SSO', async () => {
    // An account buys the OTHER machines; everything on this computer — discovery, terminals, hooks,
    // the cabled dial — is served by the daemon over the loopback and needs none. Refusing to start
    // without one put a browser sign-in in front of every local thing the product does on day one.
    //
    // Run in its own process group and killed as one: a dev-mode start becomes the daemon itself, and
    // tsx wraps it in a child of its own.
    const root = freshRoot()
    const started = runs.start(root, [TSX, CLI_SOURCE, 'start'], {
      cwd: CLI_ROOT,
      label: 'harness start (signed out)',
      env: envFor(root, {
        // The kernel reserves a free port atomically; a random choice can hit another test.
        PORT: '0',
        DISABLE_HOOK_INSTALL: 'true', CABLE_DISABLE: 'true', DISABLE_GRID_INSTALL: 'true',
        // Startup's sign-in contract does not need a runtime download or the developer's Grid.
        HARNESS_GRID_BIN: join(root, 'grid-unavailable'),
      }),
    })
    const said = () => started.stdout + started.stderr
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !/serving this computer only|Sign in to Harness in your browser/.test(said())) {
      await new Promise((r) => setTimeout(r, 100))
    }
    try {
      expect(said()).toContain('not signed in — serving this computer only')
      expect(said()).not.toContain('Sign in to Harness in your browser')
      expect(said()).not.toContain('dialing')   // no backend leg is attempted without a session
    } finally {
      // Running is what this start should be doing; ended here, it is not a leak.
      await runs.end(started)
    }
  }, 40_000)

  it('rejects the removed join command with the two-step migration', async () => {
    const result = await run('join')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('`harness join` has been removed.')
    expect(result.stderr).toContain('`harness login`, then `harness start`')
  }, ONE_RUN_TEST_MS)

  it('no longer has an analytics command (usage metering upload was removed)', async () => {
    const result = await run('analytics')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown command: analytics')
  }, ONE_RUN_TEST_MS)

  it('returns a nonzero status for an unknown command', async () => {
    const result = await run('not-a-command')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown command: not-a-command')
  }, ONE_RUN_TEST_MS)
})

describe('the processes this spec starts', () => {
  // The guard's own test: what teardown above relies on, shown on runs built to leak. Each uses a
  // SpawnedRuns of its own, so the leaks it makes on purpose are not this file's teardown's to report.
  const idle = `['-e', 'setInterval(() => {}, 1000)']`

  it('a run that exits leaving processes behind is caught, and teardown ends every one', async () => {
    const guard = new SpawnedRuns((command) => command.includes('--guard-daemon'))
    const root = freshRoot()
    mkdirSync(join(root, 'data'), { recursive: true })
    // Three ways a run leaves a process: a child in its group, a child in a session of its own that
    // names the root, and a daemon in a session of its own that only the pid file names.
    const script = `
      const { spawn } = require('node:child_process')
      const kept = spawn(process.execPath, ${idle}, { stdio: 'ignore' })
      const orphan = spawn(process.execPath, [...${idle}, ${JSON.stringify(root)}], { stdio: 'ignore', detached: true })
      const daemon = spawn(process.execPath, [...${idle}, '--', '--guard-daemon'], { stdio: 'ignore', detached: true })
      require('node:fs').writeFileSync(${JSON.stringify(join(root, 'data', 'adapter.pid'))}, daemon.pid + '\\n')
      console.log(JSON.stringify([kept.pid, orphan.pid, daemon.pid]))
      for (const child of [kept, orphan, daemon]) child.unref()
    `
    const result = await guard.complete(root, ['-e', script], { label: 'leaky' })
    expect(result.status, result.stderr).toBe(0)
    const pids = JSON.parse(result.stdout) as number[]
    expect(pids.every(alive)).toBe(true)
    expect(guard.belonging(result.run).map((row) => row.pid).sort()).toEqual([...pids].sort())

    const { leftBehind, survivors } = await guard.endAll()
    expect(leftBehind).toHaveLength(3)
    expect(survivors).toEqual([])
    expect(pids.filter(alive)).toEqual([])
  }, 30_000)

  it('a run that does not end is ended at its deadline, with what it started, and is no leak', async () => {
    const guard = new SpawnedRuns()
    const root = freshRoot()
    const script = `
      const child = require('node:child_process').spawn(process.execPath, ${idle}, { stdio: 'ignore' })
      console.log(child.pid)
      setInterval(() => {}, 1000)
    `
    const result = await guard.complete(root, ['-e', script], { ms: 2_000 })
    expect(result.timedOut).toBe(true)
    expect(alive(Number(result.stdout.trim()))).toBe(false)
    expect(alive(result.run.pgid)).toBe(false)
    expect(await guard.endAll()).toEqual({ leftBehind: [], survivors: [] })
  }, 30_000)
})

describe('start --repair beside a running daemon', () => {
  // The managed runtimes live beside the bundle, not in it, and the daemon reads `current-grid` on every
  // resolve — so a grid laid down here is the one its next spawn runs, with no restart. `--repair` is the
  // one place a person WATCHES that provisioning; beside a live daemon it used to exit at "already
  // running" before reaching it, and the only way to follow a new pin was a restart.
  const key = `${process.platform}-${process.arch}`

  /** Serves a grid manifest that pins 9.9.9 to an archive nobody can fetch: the download is refused at
   *  once, which is a best-effort skip inside ensureManagedGrid — and the "installing" line has already
   *  said the step was reached, which is the whole of what this contract is about. */
  async function withManifest<T>(body: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ grid: { [key]: {
        version: '9.9.9', url: 'https://127.0.0.1:1/grid.tar.gz', sha256: '0'.repeat(64), archiveRoot: `grid-9.9.9-${key}`,
      } } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      return await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata.json`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  const noNode = 'http://127.0.0.1:9/metadata.json'   // refused at once: the Node runtime is not what is under test

  it('provisions the managed grid for the daemon that is up, and still leaves the daemon itself alone', async () => {
    const root = freshRoot()
    seedSession(root)
    seedRunningDaemon(root)
    const result = await withManifest((manifest) => runAsync(root, ['start', '--repair'], {
      ADAPTER_RUNTIME_DIR: join(root, 'runtime'), ADAPTER_RUNTIME_METADATA_URL: noNode, ADAPTER_GRID_RUNTIME_METADATA_URL: manifest,
    }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`installing the Harness grid runtime (9.9.9, ${key})`)
    expect(result.stdout).toContain('already running')
    expect(result.stdout).not.toContain('updated to v')   // no bundle staging beside a live daemon
  }, ONE_RUN_TEST_MS)

  it('a plain start beside a running daemon touches nothing', async () => {
    const root = freshRoot()
    seedSession(root)
    seedRunningDaemon(root)
    const result = await withManifest((manifest) => runAsync(root, ['start'], {
      ADAPTER_RUNTIME_DIR: join(root, 'runtime'), ADAPTER_RUNTIME_METADATA_URL: noNode, ADAPTER_GRID_RUNTIME_METADATA_URL: manifest,
    }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already running')
    expect(result.stdout).not.toContain('installing the Harness grid runtime')
  }, ONE_RUN_TEST_MS)
})

describe('start beside a daemon that serves another account', () => {
  // A forced login stops the daemon and waits for the browser, and a start that landed in that window
  // used to bring a daemon up on the OLD session (closed under the spawn lock now — loginForceRace.spec.ts).
  // "Already running" is what kept it there: `auth status` named the new machine, the socket served the
  // old one. However a daemon ends up on the wrong account, this is where it is noticed — `start` asks
  // the live daemon which machine it serves before leaving it alone.

  it('stops it and starts over on the session that is on disk', async () => {
    const root = freshRoot()
    seedSession(root)                                  // machineId m_seeded
    const daemon = seedRunningDaemon(root)
    const port = await daemonStatusServer(root, 'm_other')

    const result = await runAsync(root, ['start'], { PORT: String(port) })

    expect(result.stdout).toContain(`machine running (pid ${daemon.pid}) as another account — restarting it`)
    expect(result.stdout).not.toContain('already running')
    await daemon.exited
    expect(existsSync(join(root, 'data', 'adapter.pid'))).toBe(false)
    // The restart goes on to boot a daemon inline (a repo run) — which refuses to displace this
    // fixture's still-live private socket. Past the point under test; the backend is never
    // consulted (start no longer resolves the machine when the session already names one).
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('resolve-computer')
  }, ONE_RUN_TEST_MS)

  it('starts without the backend: a session that already names its machine never calls it', async () => {
    // Offline is the case this exists for. The backend here is port 1 — refused instantly — and the
    // only thing that stops the boot is this fixture's live private socket, AFTER the point
    // where `start` used to abort on the resolve. No "Failed to start adapter: fetch failed".
    const root = freshRoot()
    seedSession(root)
    const port = await daemonStatusServer(root, 'm_other')

    const result = await runAsync(root, ['start'], { PORT: String(port) })

    expect(result.stderr).not.toContain('fetch failed')
    expect(result.stdout + result.stderr).not.toContain('resolve-computer')
    expect(result.stdout).toContain('dev mode — running in the foreground')
  }, ONE_RUN_TEST_MS)

  it('starts without the backend even when the session has no machine id yet, on the computer id', async () => {
    const root = freshRoot()
    mkdirSync(join(root, 'auth'), { recursive: true })
    writeFileSync(join(root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: 'tok', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
      autonomousEnv: 'prod', computerId: 'a'.repeat(32), updatedAt: Date.now(),
    }))
    const port = await daemonStatusServer(root, 'm_other')

    const result = await runAsync(root, ['start'], { PORT: String(port) })

    expect(result.stdout).toContain('machine id not resolved yet')
    expect(result.stdout).toContain('dev mode — running in the foreground')
  }, ONE_RUN_TEST_MS)

  it('leaves one that serves this session alone', async () => {
    const root = freshRoot()
    seedSession(root)
    const daemon = seedRunningDaemon(root)
    const port = await daemonStatusServer(root, 'm_seeded')

    const result = await runAsync(root, ['start'], { PORT: String(port) })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already running')
    expect(existsSync(join(root, 'data', 'adapter.pid'))).toBe(true)
    await expect(Promise.race([daemon.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 300))]))
      .resolves.toBe('alive')
  }, ONE_RUN_TEST_MS)
})

describe('harness service, through the CLI', () => {
  // The whole command as a person runs it, on a throwaway home with fake launchctl or systemctl ALONE
  // on PATH: nothing can reach this machine's launchd or systemd, or the person's daemon.
  const platform = process.platform === 'darwin' ? 'launchd' : 'systemd'
  const standIns: number[] = []
  afterEach(() => { for (const pid of standIns.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } })

  /** A process standing in for the master the platform starts. Not this test's child, so it is reaped
   *  the moment the fake platform stops it. */
  function standIn(): number {
    const spawned = spawnSync(process.execPath, ['-e', `
      const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      c.unref(); console.log(c.pid)
    `], { encoding: 'utf8' })
    const pid = Number(spawned.stdout.trim())
    standIns.push(pid)
    return pid
  }

  it.skipIf(platform === 'systemd' && process.platform !== 'linux')('installs, reports, stops through the platform and uninstalls', async () => {
    const root = freshRoot()
    const master = standIn()
    const fake = fakePlatform(join(root, 'bin'), { pidFile: join(root, 'data', 'adapter.pid'), nextPid: master, killable: [master] })
    mkdirSync(join(root, 'cli'), { recursive: true })
    writeFileSync(join(root, 'cli', 'cli.js'), '// the installed bundle\n')
    const extra = { PATH: fake.bin, XDG_CONFIG_HOME: join(root, '.config') }
    const file = platform === 'launchd'
      ? join(root, 'Library', 'LaunchAgents', 'ai.autonomous.harness.harnessd.plist')
      : join(root, '.config', 'systemd', 'user', 'harnessd.service')

    const before = await runAsync(root, ['service', 'status', '--json'], extra)
    expect(before.status, before.stderr).toBe(0)
    expect(JSON.parse(before.stdout)).toMatchObject({ supported: true, platform, file, installed: false, registered: false })

    const install = await runAsync(root, ['service', 'install'], extra)
    expect(install.status, install.stderr).toBe(0)
    expect(install.stdout).toContain(`✓ harnessd runs under ${platform} (pid ${master})`)
    expect(readFileSync(file, 'utf8')).toContain(join(root, 'data', 'harness.log'))
    expect(readFileSync(file, 'utf8')).toContain(join(root, 'cli', 'cli.js'))

    const status = await runAsync(root, ['service', 'status'], extra)
    expect(status.stdout).toContain(`● running (pid ${master})`)

    // What the master writes when the platform runs it; `harness status` names its supervisor.
    writeFileSync(join(root, 'data', 'harnessd-status.json'), JSON.stringify({ state: 'running', masterPid: master, platform }))
    const machine = await runAsync(root, ['status'], extra)
    expect(machine.stdout).toMatch(new RegExp(`supervisor +${platform} · starts at login, comes back if it dies`))

    const stop = await runAsync(root, ['stop'], extra)
    expect(stop.stdout).toContain(`machine stopped (pid ${master})`)
    expect(fake.calls().map((call) => call.join(' '))).toContainEqual(platform === 'launchd'
      ? expect.stringMatching(/^launchctl bootout gui\/\d+\/ai\.autonomous\.harness\.harnessd$/)
      : 'systemctl --user kill --kill-who=main --signal=SIGTERM harnessd.service')
    expect(fake.state().pid).toBeNull()

    const uninstall = await runAsync(root, ['service', 'uninstall'], extra)
    expect(uninstall.status, uninstall.stderr).toBe(0)
    expect(uninstall.stdout).toContain(`no longer runs harnessd`)
    expect(uninstall.stdout).not.toContain('starting it the usual way')
    expect(existsSync(file)).toBe(false)
  }, 6 * ONE_RUN_TEST_MS) // six runs, one after another
})
