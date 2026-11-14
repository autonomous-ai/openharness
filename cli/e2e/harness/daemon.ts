/**
 * A daemon under test: the real daemon from this checkout, booted under a throwaway home with its own
 * data directory, port, private tmux server and fake Claude Code and Codex engines, signed out and with
 * every optional feature that reaches beyond the machine turned off. Nothing it does can touch the
 * person's own daemon, tmux server, transcripts or credentials.
 *
 * It installs Claude Code's and Codex's hooks as it does on a person's computer, into the throwaway home
 * and CODEX_HOME, and the fake engines run them (fakeEngine.mjs): the real `hook/notify.mjs` carries
 * every hook event to the daemon, with its deadline and its offline registry writes. Before a daemon
 * starts, every folder it could install hooks into is checked to be inside the test's root
 * (`assertHooksContained`), and every file it says it wrote is checked again once it is up.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isolatedTmux, type IsolatedTmux } from '../../src/testing/isolatedTmux.js'
import { artifactLog, artifactsEnabled } from './artifacts.js'
import { daemonEnvironment } from '../../src/testing/daemonEnvironment.js'
import { GH_FORBIDDEN_STUB } from '../../src/testing/ghStub.js'
import { readAdoptedHomes } from '../../src/engines/kit/homeAdoption.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { endRootProcesses } from '../../src/testing/rootProcesses.js'
import { assertSocketPathFits } from '../../src/testing/socketPathRoom.js'
import { alive } from '../../src/testing/spawnedRuns.js'
import { forgetGroup, forgetTmux, leaderGone, watchGroup, watchTmux } from './reaper.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
export const CLI_ROOT = resolve(here, '../..')

/** What a fake engine's wrapper hands `fakeEngine.mjs` `run()`: where it writes, and which release it is. */
export interface EngineConfig {
  port: number
  dataDir: string
  claudeProjectsDir: string
  codexHome: string
  claudeModel?: string
  /** Pause model commands at a disposable file gate for worker failure tests. */
  modelControlGate?: boolean
  /** Note every submitted prompt and hold a `!latestart` turn's start at a file gate (submission tests). */
  submissionGate?: boolean
  codexModel?: string
  /** Keep the real interpreter/entrypoint argv, so macOS ps can also read the fixture environment. */
  preserveProcessArgs?: boolean
  /** The test's throwaway root: the engine runs no hooks from settings outside it. */
  root: string
  /** Where the engine notes each hook it ran. */
  hookLog: string
  version?: string
  without?: string[]
  startDelayMs?: number
  /** Hold a descriptor the daemon's process reader cannot classify for this long once started (Codex 0.162.1's first seconds). */
  unreadableDescriptorMs?: number
  /** Hold startup before the transcript opens until this disposable path's .release file exists. */
  startupGate?: string
  firstHookDelayMs?: number
  updateAvailable?: string
  /** Ask whether to trust a folder the engine's own config has no answer for, as the real CLIs do. */
  trustPrompt?: boolean
  /** Send Claude Code's kitty graphics query on start, then set this title [titleAfterMs] later (fakeEngine.mjs). */
  graphicsQuery?: { title: string; titleAfterMs: number }
}

export interface DaemonOptions {
  /** Extra environment for the daemon. */
  env?: Record<string, string>
  /** V8 heap ceiling for the daemon process, MiB. Defaults to Node's own. */
  heapMiB?: number
  /** Models the fake engines report. */
  claudeModel?: string
  /** Pause model commands at a disposable file gate for worker failure tests. */
  modelControlGate?: boolean
  /** Note every submitted prompt and hold a `!latestart` turn's start at a file gate (submission tests). */
  submissionGate?: boolean
  codexModel?: string
  /** Process-evidence tests need the real entrypoint; Node's process.title hides its env on macOS. */
  preserveProcessArgs?: boolean
  /** Boot the core on its own (`__run`) instead of under harnessd's master (`__harnessd`). */
  noMaster?: boolean
  /** Start as a supervisor does, `harness start -f`: the master in the foreground, the core its child. */
  foreground?: boolean
  /** Start with these arguments to node instead (a launcher the test provides), in the daemon's environment. */
  launch?: string[]
  /** Run the daemon on this Node instead of the test's own: a managed Node under the runtime folder. */
  node?: string
  /** Run this bundle (an installed `cli.js`, its `notify.mjs` beside it: `assertHookScriptBeside`) instead of
   *  the checkout's source. */
  scriptPath?: string
  /** Keep the daemon's data folder here instead of under the throwaway root (a test volume). The fake
   *  engines read their hook credential from it, so it is set for them too. Its socket path is never measured:
   *  where it sits is the test's subject (noSocket.e2e.ts passes one too long on purpose). */
  dataDir?: string
  /** Run beside this daemon, as a dev daemon runs beside the release one on one computer: its home, its
   *  tmux server, the engines' transcript folders and the projects, with a data folder, port and engines
   *  of its own (`dataDir` and `port` can name the other's instead). Closing it leaves the shared tmux
   *  server to the daemon it runs beside. */
  beside?: IsolatedDaemon
  /** Ask for this port instead of a free one: a daemon started on another daemon's port. */
  port?: number
  /** The fake engines ask whether to trust a folder their config has no answer for (fakeEngine.mjs). */
  trustPrompt?: boolean
  /** The fake engines send Claude Code's kitty graphics query on start, then set a title (fakeEngine.mjs). */
  graphicsQuery?: { title: string; titleAfterMs: number }
}

/** The port a daemon is configured with: its `PORT`, which names its socket, its record and its artifacts. It is free
 *  when picked and closed before the daemon binds it, so another process can take it first (cli-e2e run 43568618113,
 *  shard 2). That is harmless: the daemon then listens on another port and says which, and the harness reads that one
 *  (`listeningPort`). */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no free port')
  return address.port
}

/** The port in the last `[hooks] listening on 127.0.0.1:<n> (` line of a daemon's output (hookServer.ts), or null
 *  before it said one. The last, so a core started again on another port is followed. The bracket after the number is
 *  part of the match on purpose: output arrives in chunks, and a line cut inside its port would read as a shorter one. */
export function listeningPort(output: string): number | null {
  const said = [...output.matchAll(/\[hooks\] listening on 127\.0\.0\.1:(\d+) \(/g)]
  return said.length ? Number(said[said.length - 1][1]) : null
}

/** listeningPort of [output]; before the daemon said one, an error by name rather than a guess. */
function saidPort(output: string): number {
  const port = listeningPort(output)
  if (port === null) throw new Error('the daemon has not said which port it listens on yet')
  return port
}

/** Inside `root`, or `root` itself. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Native-hook acceptance may opt in only with every destination explicitly under its private root. */
const NATIVE_HOOK_PATHS: Record<string, readonly string[]> = {
  cursor: ['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'], opencode: ['OPENCODE_PLUGIN_DIR'],
  kilo: ['KILO_PLUGIN_DIR'], pi: ['PI_HOME'], amp: ['AMP_PLUGIN_DIR', 'AMP_SESSIONS_DIR'],
  hermes: ['HERMES_HOME'], devin: ['DEVIN_CONFIG_PATH'], commandcode: ['COMMANDCODE_HOME'],
  grok: ['GROK_HOME'], agy: ['AGY_CONFIG_DIR'], copilot: ['COPILOT_HOME'],
}
const HOOK_ENGINES = new Set(['claude', 'codex', ...Object.keys(NATIVE_HOOK_PATHS)])
/** The shell profiles a login shell in a pane reads, where a person moves an engine's home. */
const PROFILES = { ZDOTDIR: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'], HOME: ['.bash_profile', '.bash_login', '.profile', '.bashrc'] }

/**
 * Refuse to start a daemon that could install hooks anywhere but inside the test's root. Claude Code's go
 * into `$HOME/.claude/settings.json` and into every moved home (CLAUDE_CONFIG_DIR, in the daemon's
 * environment, in the login shell's profile, or remembered in `engine-homes.json`); Codex's into
 * `$CODEX_HOME/hooks.json` and every moved CODEX_HOME. Any of them outside the root would be the person's
 * own settings, and their engines would then call a daemon that is gone when the test ends. Throws,
 * naming the setting.
 */
export function assertHooksContained(root: string, env: NodeJS.ProcessEnv): void {
  if (env.DISABLE_HOOK_INSTALL === 'true') return
  const engines = (env.HOOK_INSTALL_ENGINES ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  if (!engines.length || engines.some((name) => !HOOK_ENGINES.has(name))) {
    throw new Error(`HOOK_INSTALL_ENGINES is ${env.HOOK_INSTALL_ENGINES ?? 'unset'}: a daemon under test must name supported hook engines with isolated destinations`)
  }
  const refuse = (what: string, path: string | undefined): never => {
    throw new Error(`${what} is ${path ?? 'unset'}: a daemon under test installs hooks only inside ${root}`)
  }
  const check = (what: string, path: string | undefined): void => {
    if (!path || !isAbsolute(path) || !inside(root, path)) refuse(what, path)
  }
  check('HOME', env.HOME)
  check('CODEX_HOME', env.CODEX_HOME)
  if (env.CLAUDE_CONFIG_DIR !== undefined) check('CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR)
  check('ZDOTDIR', env.ZDOTDIR)
  for (const engine of engines) for (const name of NATIVE_HOOK_PATHS[engine] ?? []) check(name, env[name])
  // OpenCode's TUI plugin is a sibling of its legacy plugin directory.
  if (engines.includes('opencode')) check('OpenCode plugin parent', dirname(env.OPENCODE_PLUGIN_DIR!))
  // Not a hook, but what routes every hook: a record outside the root would send the person's hooks here.
  if (env.HARNESS_HOOK_ROUTES_DIR !== undefined) check('HARNESS_HOOK_ROUTES_DIR', env.HARNESS_HOOK_ROUTES_DIR)
  for (const [folder, names] of Object.entries(PROFILES) as Array<[keyof typeof PROFILES, string[]]>) {
    for (const name of names) {
      const file = join(env[folder]!, name)
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { continue }
      for (const match of text.matchAll(/(?:^|[\s;])(?:export\s+)?(CLAUDE_CONFIG_DIR|CODEX_HOME)=("([^"]*)"|'([^']*)'|([^\s;]*))/gm)) {
        const value = match[3] ?? match[4] ?? match[5]
        // A value built from another variable cannot be checked from here, so it is not allowed.
        if (value.includes('$') || value.includes('~')) refuse(`${match[1]} in ${file}`, value)
        check(`${match[1]} in ${file}`, value)
      }
    }
  }
  // Incomplete published records can be recovered during boot; an unreadable catalog cannot
  // justify starting a daemon whose recovered destinations have not passed containment.
  const file = join(env.ADAPTER_DATA_DIR!, 'engine-homes.json')
  let remembered: ReturnType<typeof readAdoptedHomes>['homes']
  try { remembered = readAdoptedHomes(file).homes }
  catch (error) {
    // A malformed legacy catalog cannot be imported or repaired by adoption. Published journal
    // intent can recover at boot, so its destinations must pass the guard before starting.
    if (existsSync(file + '.adoptions') || existsSync(file + '.adopted') || existsSync(file + '.confirmations')) throw error
    return
  }
  for (const [engine, homes] of Object.entries(remembered)) {
    for (const home of homes) check(`the ${engine} home remembered in engine-homes.json`, home)
  }
}

/**
 * A daemon whose `cli.js` has no `notify.mjs` beside it refuses every hook install
 * (`engines/kit/notifyHooks.ts` `requireHookScript`), and its test then fails far from the cause: six tests
 * of the nightly run of 2026-11-12 failed on `NATIVE_LAUNCH_HELD` or a hook timeout. It never copies the
 * file, which would hide a layout no build produces.
 */
export function assertHookScriptBeside(scriptPath: string): void {
  if (existsSync(join(dirname(scriptPath), 'notify.mjs'))) return
  throw new Error(`${scriptPath} has no notify.mjs beside it: its daemon refuses every hook install (lay it out with buildWithLean)`)
}

/**
 * The files a daemon's log says it installed hooks or plugins into, found them already in, or left alone.
 * The update line names the hook script first and the file it rewrote after ` in `.
 */
export function hookFilesNamed(log: string): string[] {
  const files: string[] = []
  for (const line of log.split('\n')) {
    if (!line.includes('[hooks]')) continue
    const named = line.includes('updated (path/port changed)') ? / in (\/\S+)\s*$/.exec(line) : /(?:→|unchanged:) (\/\S+)/.exec(line)
    if (named) files.push(named[1])
  }
  return files
}

export const until = async <T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000, every = 100): Promise<T> => {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) { last = error }
    await new Promise((done) => setTimeout(done, every))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`)
}

/** How many daemons have been started beside another in this process: each gets its own folder. */
let besideCount = 0

/** The executable a daemon finds for [name]: the fake engine, run with [config]. A test that wants one engine of a daemon
 *  to behave otherwise writes it over the daemon's own, before it starts. */
export const fakeEngineShim = (name: 'claude' | 'codex', config: EngineConfig & Record<string, unknown>): string =>
  `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(here, 'fakeEngine.mjs')).href)}).then((m) => m.run(${JSON.stringify(name)}, ${JSON.stringify(config)}))\n`

export class IsolatedDaemon {
  child: ChildProcess | null = null
  private output = ''
  /** Every start not yet closed: each master leads a process group, numbered by its pid (`start`). */
  private readonly groups = new Set<ChildProcess>()

  private constructor(
    readonly root: string,
    readonly tmux: IsolatedTmux,
    /** What `PORT` is set to: it names the daemon's socket (`daemon-<n>.sock`), its record and its artifacts. */
    readonly configuredPort: number,
    readonly env: NodeJS.ProcessEnv,
    readonly options: DaemonOptions,
    /** What the fake engines' wrappers hand `fakeEngine.mjs` (updates.e2e.ts writes releases with it). */
    readonly engineConfig: EngineConfig,
  ) {}

  static async create(options: DaemonOptions = {}): Promise<IsolatedDaemon> {
    const beside = options.beside
    const tmux = beside?.tmux ?? await isolatedTmux()
    // Stopped by the worker's reaper should this worker go before `close` (reaper.ts).
    if (!beside) watchTmux(tmux.socket, tmux.root)
    const root = tmux.root
    const port = options.port ?? await freePort()
    // What a daemon beside another keeps for itself; everything else is the computer's, and shared. Short
    // names: the socket lives in the data folder, and a Unix socket's path has room for 96 bytes.
    const own = beside ? join(root, `b${++besideCount}`) : root
    const dirs = {
      home: join(root, 'home'), data: options.dataDir ?? join(own, beside ? 'd' : 'data'), runtime: join(own, 'runtime'), auth: join(own, 'auth'),
      bin: join(own, 'bin'), dsh: join(own, 'dsh'), claudeProjects: join(root, 'claude', 'projects'), codexHome: join(root, 'codex'),
      projects: join(root, 'projects'), tmp: join(own, 't'),
    }
    // A data folder the harness gives a daemon under a TMPDIR too long for its socket falls back to one under the
    // test's home, as long, and the test failed later with `EINVAL connect` and no word of why: refused here, before
    // anything is made in the root. A test's own data folder is not measured: where it sits is that test's subject
    // (noSocket.e2e.ts passes one too long on purpose).
    if (options.dataDir === undefined) {
      try {
        assertSocketPathFits(join(dirs.data, `daemon-${port}.sock`))
      } catch (error) {
        // A daemon beside another made nothing yet, and the root it shares is the other's.
        if (!beside) {
          await tmux.close()
          forgetTmux(tmux.socket)
        }
        throw error
      }
    }
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    // A zsh user as most are, with a .zshrc of their own (empty: nothing of anyone's). With none, the zsh
    // of Debian, Ubuntu and Fedora opens its new-user setup menu in every terminal tile and every shell an
    // engine leaves behind, and a test typing into one types into the menu. The person with no startup
    // files at all has their own case (shells.e2e.ts). Appended, never truncated: a test's own stays.
    await writeFile(join(dirs.home, '.zshrc'), '', { flag: 'a' })
    const config: EngineConfig = {
      port, dataDir: dirs.data, claudeProjectsDir: dirs.claudeProjects, codexHome: dirs.codexHome,
      claudeModel: options.claudeModel, codexModel: options.codexModel, modelControlGate: options.modelControlGate,
      ...(options.preserveProcessArgs ? { preserveProcessArgs: true } : {}),
      ...(options.submissionGate ? { submissionGate: true } : {}),
      root, hookLog: join(own, 'fake-engine-hooks.log'),
      ...(options.trustPrompt ? { trustPrompt: true } : {}),
      ...(options.graphicsQuery ? { graphicsQuery: options.graphicsQuery } : {}),
    }
    for (const name of ['claude', 'codex'] as const) await writeFile(join(dirs.bin, name), fakeEngineShim(name, config), { mode: 0o755 })
    // A daemon never finds the developer's own gh (shared tabs' tasks run it): a stub that refuses, until a test writes its own.
    await writeFile(join(dirs.bin, 'gh'), GH_FORBIDDEN_STUB, { mode: 0o755 })
    // Engine probes and usage readers must not consult the person's macOS
    // Keychain merely because the fixture itself runs on a Mac.
    await writeFile(join(dirs.bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
    // Nor does it run anything as root or as another account: a guest's harness goes through `sudo -n` and the guest
    // helper (lib/guestAccounts.ts), which may be installed on the Mac the tests run on. Refused, as for an owner who
    // never turned guest access on.
    await writeFile(join(dirs.bin, 'sudo'), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n', { mode: 0o755 })
    const env = daemonEnvironment(tmux.env, {
      NODE_ENV: 'test',
      HOME: dirs.home,
      // A login shell in a pane must not load anyone's zsh configuration.
      ZDOTDIR: dirs.home,
      PORT: String(port),
      // A bridge port of its own: on 51793, the developer's daemon's, one daemon under test left running took the
      // port from it, and another asked `lsof` every 5.5 s which account held it (2026-11-11).
      HARNESS_CONNECTIONS_PORT: '0',
      // Its temporary folder, and its children's: an agent in its pane took the worker's, and every screenshot of
      // `harness browser` (1 MiB) outlived its test there. One letter: the daemon puts no socket here, and tmux has its
      // own (TMUX_TMPDIR), but a child's socket in it must fit too.
      TMPDIR: dirs.tmp,
      ADAPTER_DATA_DIR: dirs.data,
      ADAPTER_RUNTIME_DIR: dirs.runtime,
      ADAPTER_COMPUTER_ID: 'e2e-computer-0000-0000-000000000001',
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      HARNESS_AUTH_DIR: dirs.auth,
      DSH_DIR: dirs.dsh,
      CLAUDE_PATH: join(dirs.bin, 'claude'),
      CODEX_PATH: join(dirs.bin, 'codex'),
      CLAUDE_PROJECTS_DIR: dirs.claudeProjects,
      CODEX_HOME: dirs.codexHome,
      PATH: `${dirs.bin}:${process.env.PATH}`,
      // Signed out, and nothing reaches beyond the machine.
      BACKEND_WS_URL: 'ws://127.0.0.1:9',
      WEB_URL: 'http://127.0.0.1:9',
      // Nor grid's release server: removed roots on one Mac kept a 19 MB runtime/grid-0.3.63-darwin-arm64 each, from
      // swarmV4Journey.e2e.ts, whose Swarm grid sends models a `grid_swarm_sync` at each of its starts, and grid's set-up
      // (services/models.ts installCli) installs the managed grid. With no manifest to read, installCli goes on to
      // grid's public installer: that is switched off too.
      ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/grid.json',
      DISABLE_GRID_INSTALL: 'true',
      // Claude Code's and Codex's hooks, installed as on a person's computer, into this home and CODEX_HOME
      // (assertHooksContained), and run by the fake engines. Every other engine's installer writes into
      // folders these tests have no engine for.
      DISABLE_HOOK_INSTALL: 'false',
      HOOK_INSTALL_ENGINES: 'claude,codex',
      // Where each daemon records its data folder and port for the hooks of its panes (lib/hookRoutes.ts):
      // under the home, as on a person's computer, so daemons beside each other share it.
      HARNESS_HOOK_ROUTES_DIR: join(dirs.home, '.harness', 'hook-routes'),
      ADAPTER_UPDATE_DISABLE: 'true',
      ANALYTICS_ENABLED: 'false',
      RECAP_FORCE: 'false',
      RECAP_WITHOUT_DEVICE: 'false',
      CABLE_DISABLE: 'true',
      CABLE_FW_DISABLE: 'true',
      TERMINAL_BACKENDS: 'tmux',
      TMUX_REAP_INTERVAL_MS: '5000',
      TERMINAL_RECONCILE_INTERVAL_MS: '5000',
      // The Swarm switch (harnessd/services.ts), as the run was started with: `HARNESS_SWARM=off npm run test:e2e` runs
      // every daemon of the suite with the Swarm off. A test's own env still decides.
      ...(process.env.HARNESS_SWARM !== undefined ? { HARNESS_SWARM: process.env.HARNESS_SWARM } : {}),
      ...options.env,
    })
    // A Claude Code home moved in the environment this run was started from is the person's: the daemon
    // would adopt it and install its hooks there (lib/engineHomes.ts). Only a test may move one.
    if (!options.env || !('CLAUDE_CONFIG_DIR' in options.env)) delete env.CLAUDE_CONFIG_DIR
    return new IsolatedDaemon(root, tmux, port, env, options, config)
  }

  /** What the fake engines noted of every hook they ran (fakeEngine.mjs `hookLog`); kept once the root is gone. */
  hookLog(): string {
    try { return readFileSync(this.engineConfig.hookLog, 'utf8') } catch { return this.closedHookLog }
  }
  private closedHookLog = ''

  /** Throws when the daemon said it put hooks outside the root, or an engine refused hooks found there. */
  private assertHooksStayedInside(): void {
    const outside = hookFilesNamed(this.output).filter((file) => !inside(this.root, file))
    if (outside.length) throw new Error(`the daemon under test wrote hooks outside ${this.root}: ${[...new Set(outside)].join(', ')}`)
    const refused = this.hookLog().split('\n').filter((line) => line.includes('REFUSED'))
    if (refused.length) throw new Error(`a fake engine refused to run hooks (test root ${this.root}):\n${refused.join('\n')}`)
  }

  get dataDir(): string { return this.env.ADAPTER_DATA_DIR! }
  get computerId(): string { return this.env.ADAPTER_COMPUTER_ID! }
  get socketPath(): string { return join(this.dataDir, `daemon-${this.configuredPort}.sock`) }
  /** The port its control server answers on, as the daemon last said it: not the configured one, which another process
   *  may have taken first. The last line, so a core the master starts again on another port is followed, as
   *  `corePid()` follows it. */
  get port(): number { return saidPort(this.output) }
  get projectsDir(): string { return join(this.root, 'projects') }
  /** The process `harness start` would have started: the master, or a core run on its own. */
  get pid(): number | null { return this.child?.pid ?? null }

  /** The core the master is running now (the last one it said it started). */
  corePid(): number | null {
    if (this.options.noMaster) return this.pid
    const started = [...this.output.matchAll(/\[harnessd\] core started \(pid (\d+)\)/g)]
    return started.length ? Number(started[started.length - 1][1]) : null
  }

  /** How many cores the master has started since this daemon object first started one. */
  coresStarted(): number {
    return [...this.output.matchAll(/\[harnessd\] core started/g)].length
  }
  log(): string { return this.output }

  /** `ready: 'port'` returns as soon as the port answers, the way a client sees a restarting daemon;
   *  `'none'` as soon as the process is started. */
  async start(options: { ready?: 'none' | 'port' | 'wired' } = {}): Promise<void> {
    if (this.child) throw new Error('already running')
    // Checked at every start: a test writes a shell profile, or the data folder remembers a home, between them,
    // and a test may name its script after `create` (`masterIpcExit.e2e.ts`).
    assertHooksContained(this.root, this.env)
    if (this.options.scriptPath) assertHookScriptBeside(this.options.scriptPath)
    const heap = this.options.heapMiB ? [`--max-old-space-size=${this.options.heapMiB}`] : []
    const entry = this.options.noMaster ? ['__run'] : this.options.foreground ? ['start', '-f'] : ['__harnessd']
    // Readiness is judged from what this start prints, never from an earlier boot's lines.
    const from = this.output.length
    // A test's own bundle (an old release), the run's bundle (`E2E_BUNDLE`, see bundle.ts), or the sources.
    const bundle = this.options.scriptPath ?? process.env.E2E_BUNDLE_PATH
    const script = bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']
    // A process group of its own, which the core and the services join: one signal reaches all of them, whether or
    // not the master is still there, and the worker's reaper (reaper.ts) ends it should the worker go without closing it.
    const child = spawn(this.options.node ?? process.execPath, this.options.launch ?? [...heap, ...script, ...entry], {
      cwd: CLI_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], ...ownProcessGroup(),
    })
    this.child = child
    if (child.pid) {
      this.groups.add(child)
      watchGroup(child.pid)
      child.once('exit', () => leaderGone(child.pid!))
    }
    // The whole log, as files, for a failing test's CI artifacts (E2E_ARTIFACTS_DIR, artifacts.ts).
    const logName = `daemon-${this.configuredPort}.log`
    artifactLog(logName, `---- ${new Date().toISOString()} start (pid ${child.pid}, ${script.at(-1)} ${entry.join(' ')}, data ${this.dataDir})\n`)
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.output += text
      artifactLog(logName, text)
    }
    child.stdout!.on('data', take)
    child.stderr!.on('data', take)
    const exited = new Promise<never>((_, reject) => child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      reject(new Error(`daemon exited during boot (${signal ?? code}):\n${this.output.slice(-4000)}`))
    }))
    exited.catch(() => {}) // observed below while booting; afterwards an exit is the test's business
    if (options.ready === 'none') return
    await Promise.race([exited, (async () => {
      await until('the daemon to answer on its port', async () => {
        // The port this start said, never an earlier boot's: a start can move it. Every miss throws, so the timeout
        // names the last one (`until`): no port said yet, a refused connection, or an answer that is not healthy.
        const port = saidPort(this.output.slice(from))
        const response = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (!response.ok) throw new Error(`port ${port} answered /api/health with ${response.status}`)
        return true
      }, 60_000, 200)
      await until('the daemon socket', () => existsSync(this.socketPath), 10_000)
      // The port answers ~1,100 lines of startup before every handler is wired (see the startup-race
      // test); this line is printed once they are.
      if (options.ready !== 'port') {
        await until('the daemon to finish starting', () => /\[cli\] ready/.test(this.output.slice(from)), 60_000, 100)
        // Its hooks are installed before it says it is ready.
        this.assertHooksStayedInside()
      }
    })()])
  }

  /** SIGTERM, then SIGKILL to its whole process group after `ms`. Resolves when the process is gone. */
  async stop(ms = 15_000): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => IsolatedDaemon.killGroup(child), ms)
    await exited
    clearTimeout(timer)
  }

  /**
   * SIGKILL what is left of [leader]'s process group. While a group has members no new process gets its number; once
   * the leader has exited, a process with its pid is a stranger leading a group of its own, and ours is empty.
   */
  static killGroup(leader: ChildProcess): void {
    const pgid = leader.pid
    const exited = leader.exitCode !== null || leader.signalCode !== null
    if (!pgid || (exited && alive(pgid))) return
    try { process.kill(-pgid, 'SIGKILL') } catch { /* empty */ }
  }

  /** A crash of every one of its processes at once, the core and the services with the master: no shutdown path runs in any. */
  async crash(): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ }
    await exited
  }

  /** The way a crash ends it: no shutdown path runs. */
  async kill(): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGKILL')
    await exited
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Resident memory of the core, MiB. */
  async rssMiB(): Promise<number> {
    const pid = this.corePid()
    if (!pid) return 0
    const { stdout } = await exec('ps', ['-o', 'rss=', '-p', String(pid)]).catch(() => ({ stdout: '0' }))
    return Number(stdout.trim()) / 1024
  }

  /** Whether a process is alive (signal 0). */
  static alive(pid: number | null): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /** What the daemon's pane shows, plain text. */
  async capture(pane: string): Promise<string> {
    return this.tmux.run('capture-pane', '-p', '-t', pane)
  }

  hookCredential(): string {
    return readFileSync(join(this.dataDir, 'hook-credential'), 'utf8').trim()
  }

  /** Credentials for this daemon's loopback TCP API; its Unix socket needs none. */
  localHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, 'X-Harness-Local': this.hookCredential() }
  }

  /**
   * What every pane on this daemon's tmux server shows, for a failing test's artifacts: its command, how
   * it started, and its screen with some history. A pane is the one thing the daemon's log cannot say:
   * the suite's first Linux run failed on a setup menu zsh drew in every agent's pane, and the logs said
   * only that no engine ever appeared.
   */
  private async keepPanes(): Promise<void> {
    try {
      const panes = await this.tmux.run('list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_dead}\t#{pane_current_command}\t#{pane_start_command}')
      let text = ''
      for (const line of panes.split('\n').filter(Boolean)) {
        const screen = await this.tmux.run('capture-pane', '-p', '-J', '-S', '-200', '-t', line.split('\t')[0]).catch((error) => String(error))
        text += `==== ${line}\n${screen}\n`
      }
      artifactLog(`daemon-${this.configuredPort}-panes.txt`, text)
    } catch { /* no server any more: nothing on screen to keep */ }
  }

  async close(): Promise<void> {
    // While the panes are still there: a daemon that stops can take its agents' panes with it.
    if (artifactsEnabled()) await this.keepPanes()
    await this.stop().catch(() => {})
    // Once the daemon has said all it will, and before the root (and the engines' hook log) is removed.
    let escaped: unknown = null
    try { this.assertHooksStayedInside() } catch (error) { escaped = error }
    // A failed test prints it after this close has removed the root.
    this.closedHookLog = this.hookLog()
    artifactLog(`daemon-${this.configuredPort}-engine-hooks.log`, this.closedHookLog)
    // A core or service whose master died during the test must not outlive it: 20 such cores, left by a
    // run whose masters crashed, spun on their closed output pipes for the rest of a parallel suite. They
    // are in their master's process group, every start's.
    for (const leader of this.groups) {
      IsolatedDaemon.killGroup(leader)
      forgetGroup(leader.pid!)
    }
    this.groups.clear()
    // A daemon beside another shares its tmux server and its root: that one closes them.
    let left: string[] = []
    if (!this.options.beside) {
      // The server names the root on its own command line: stopped first, its panes with it, so the sweep meets only
      // what left the daemon's groups.
      await this.tmux.run('kill-server').catch(() => { /* already gone */ })
      // The census of 2026-11-14 found 14 fake `codex app-server` pairs outliving their runs: a Codex rate-limit read
      // runs in a process group of its own (lib/codexRateLimits.ts), out of reach of the daemon's groups. Ended before
      // the root is removed, so nothing that names it writes into it as it goes.
      left = await endRootProcesses(this.root)
      await this.tmux.close()
      forgetTmux(this.tmux.socket)
    }
    if (escaped) throw escaped
    if (left.length) throw new Error(`a daemon under test left processes that would not end (root ${this.root}): ${left.join('; ')}`)
  }
}
