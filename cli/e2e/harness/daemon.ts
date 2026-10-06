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
  codexModel?: string
  /** The test's throwaway root: the engine runs no hooks from settings outside it. */
  root: string
  /** Where the engine notes each hook it ran. */
  hookLog: string
  version?: string
  without?: string[]
  startDelayMs?: number
  firstHookDelayMs?: number
  updateAvailable?: string
  /** Ask whether to trust a folder the engine's own config has no answer for, as the real CLIs do. */
  trustPrompt?: boolean
}

export interface DaemonOptions {
  /** Extra environment for the daemon. */
  env?: Record<string, string>
  /** V8 heap ceiling for the daemon process, MiB. Defaults to Node's own. */
  heapMiB?: number
  /** Models the fake engines report. */
  claudeModel?: string
  codexModel?: string
  /** Boot the core on its own (`__run`) instead of under harnessd's master (`__harnessd`). */
  noMaster?: boolean
  /** Start as a supervisor does, `harness start -f`: the master in the foreground, the core its child. */
  foreground?: boolean
  /** Run this bundle (an installed `cli.js`) instead of the checkout's source. */
  scriptPath?: string
  /** Keep the daemon's data folder here instead of under the throwaway root (a test volume). The fake
   *  engines read their hook credential from it, so it is set for them too. */
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
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no free port')
  return address.port
}

/** Inside `root`, or `root` itself. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The engines whose hooks a daemon under test may install: the two the fake engines stand in for. */
const HOOK_ENGINES = new Set(['claude', 'codex'])
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
    throw new Error(`HOOK_INSTALL_ENGINES is ${env.HOOK_INSTALL_ENGINES ?? 'unset'}: a daemon under test installs Claude Code's and Codex's hooks alone (claude,codex)`)
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
  try {
    const remembered = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR!, 'engine-homes.json'), 'utf8')) as Record<string, unknown>
    for (const [engine, homes] of Object.entries(remembered)) {
      for (const home of Array.isArray(homes) ? homes : []) check(`the ${engine} home remembered in engine-homes.json`, String(home))
    }
  } catch { /* none remembered yet */ }
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

export class IsolatedDaemon {
  child: ChildProcess | null = null
  private output = ''

  private constructor(
    readonly root: string,
    readonly tmux: IsolatedTmux,
    readonly port: number,
    readonly env: NodeJS.ProcessEnv,
    readonly options: DaemonOptions,
    /** What the fake engines' wrappers hand `fakeEngine.mjs` (updates.e2e.ts writes releases with it). */
    readonly engineConfig: EngineConfig,
  ) {}

  static async create(options: DaemonOptions = {}): Promise<IsolatedDaemon> {
    const beside = options.beside
    const tmux = beside?.tmux ?? await isolatedTmux()
    const root = tmux.root
    const port = options.port ?? await freePort()
    // What a daemon beside another keeps for itself; everything else is the computer's, and shared. Short
    // names: the socket lives in the data folder, and a Unix socket's path has room for 96 bytes.
    const own = beside ? join(root, `b${++besideCount}`) : root
    const dirs = {
      home: join(root, 'home'), data: options.dataDir ?? join(own, beside ? 'd' : 'data'), runtime: join(own, 'runtime'), auth: join(own, 'auth'),
      bin: join(own, 'bin'), dsh: join(own, 'dsh'), claudeProjects: join(root, 'claude', 'projects'), codexHome: join(root, 'codex'),
      projects: join(root, 'projects'),
    }
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    // A zsh user as most are, with a .zshrc of their own (empty: nothing of anyone's). With none, the zsh
    // of Debian, Ubuntu and Fedora opens its new-user setup menu in every terminal tile and every shell an
    // engine leaves behind, and a test typing into one types into the menu. The person with no startup
    // files at all has their own case (shells.e2e.ts). Appended, never truncated: a test's own stays.
    await writeFile(join(dirs.home, '.zshrc'), '', { flag: 'a' })
    const config: EngineConfig = {
      port, dataDir: dirs.data, claudeProjectsDir: dirs.claudeProjects, codexHome: dirs.codexHome,
      claudeModel: options.claudeModel, codexModel: options.codexModel,
      root, hookLog: join(own, 'fake-engine-hooks.log'),
      ...(options.trustPrompt ? { trustPrompt: true } : {}),
    }
    const engine = pathToFileURL(join(here, 'fakeEngine.mjs')).href
    for (const name of ['claude', 'codex']) {
      await writeFile(join(dirs.bin, name),
        `#!${process.execPath}\nimport(${JSON.stringify(engine)}).then((m) => m.run(${JSON.stringify(name)}, ${JSON.stringify(config)}))\n`,
        { mode: 0o755 })
    }
    const env: NodeJS.ProcessEnv = {
      ...tmux.env,
      NODE_ENV: 'test',
      HOME: dirs.home,
      // A login shell in a pane must not load anyone's zsh configuration.
      ZDOTDIR: dirs.home,
      PORT: String(port),
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
      ...options.env,
    }
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
  get socketPath(): string { return join(this.dataDir, `daemon-${this.port}.sock`) }
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
    // Checked at every start: a test writes a shell profile, or the data folder remembers a home, between them.
    assertHooksContained(this.root, this.env)
    const heap = this.options.heapMiB ? [`--max-old-space-size=${this.options.heapMiB}`] : []
    const entry = this.options.noMaster ? ['__run'] : this.options.foreground ? ['start', '-f'] : ['__harnessd']
    // Readiness is judged from what this start prints, never from an earlier boot's lines.
    const from = this.output.length
    // A test's own bundle (an old release), the run's bundle (`E2E_BUNDLE`, see bundle.ts), or the sources.
    const bundle = this.options.scriptPath ?? process.env.E2E_BUNDLE_PATH
    const script = bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']
    const child = spawn(process.execPath, [...heap, ...script, ...entry], {
      cwd: CLI_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    // The whole log, as files, for a failing test's CI artifacts (E2E_ARTIFACTS_DIR, artifacts.ts).
    const logName = `daemon-${this.port}.log`
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
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`).catch(() => null)
        return response?.ok ? true : null
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

  /** SIGTERM, then SIGKILL after `ms`. Resolves when the process is gone. */
  async stop(ms = 15_000): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    await exited
    clearTimeout(timer)
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
      artifactLog(`daemon-${this.port}-panes.txt`, text)
    } catch { /* no server any more: nothing on screen to keep */ }
  }

  async close(): Promise<void> {
    const core = this.options.noMaster ? null : this.corePid()
    // While the panes are still there: a daemon that stops can take its agents' panes with it.
    if (artifactsEnabled()) await this.keepPanes()
    await this.stop().catch(() => {})
    // Once the daemon has said all it will, and before the root (and the engines' hook log) is removed.
    let escaped: unknown = null
    try { this.assertHooksStayedInside() } catch (error) { escaped = error }
    // A failed test prints it after this close has removed the root.
    this.closedHookLog = this.hookLog()
    artifactLog(`daemon-${this.port}-engine-hooks.log`, this.closedHookLog)
    // A core whose master died during the test must not outlive it: 20 such cores, left by a run
    // whose masters crashed, spun on their closed output pipes for the rest of a parallel suite. Only
    // this test's core is killed — its pid, still running this daemon's entry, orphaned or ours.
    if (core && IsolatedDaemon.alive(core)) {
      const { stdout } = await exec('ps', ['-o', 'ppid=,command=', '-p', String(core)]).catch(() => ({ stdout: '' }))
      const [ppid, ...command] = stdout.trim().split(/\s+/)
      if (command.join(' ').includes('__run') && (ppid === '1' || Number(ppid) === this.pid)) {
        try { process.kill(core, 'SIGKILL') } catch { /* gone */ }
      }
    }
    // A daemon beside another shares its tmux server: that one closes it.
    if (!this.options.beside) await this.tmux.close()
    if (escaped) throw escaped
  }
}
