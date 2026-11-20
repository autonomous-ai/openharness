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
 *
 * It runs on a copy of the worker's Node alone in its folder (e2e/harness/testNode.ts), so it finds no engine beside
 * its Node.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isolatedTmux, type IsolatedTmux } from '../../src/testing/isolatedTmux.js'
import { artifactLog, artifactsEnabled } from './artifacts.js'
import { daemonEnvironment } from '../../src/testing/daemonEnvironment.js'
import { writeExecutable } from '../../src/testing/executableFixture.js'
import { GH_FORBIDDEN_STUB } from '../../src/testing/ghStub.js'
import { hooks as claudeHooks } from '../../src/engines/claude/hookContract.js'
import { hooks as codexHooks } from '../../src/engines/codex/hookContract.js'
import { readAdoptedHomes } from '../../src/engines/kit/homeAdoption.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { endRootProcesses } from '../../src/testing/rootProcesses.js'
import { assertSocketPathFits } from '../../src/testing/socketPathRoom.js'
import { alive, processTable } from '../../src/testing/spawnedRuns.js'
import { assertNodeAlone } from '../../src/testing/testNode.js'
import { SYSTEM_FOLDERS } from '../../src/testing/testPath.js'
import { forgetGroup, forgetTmux, leaderGone, watchGroup, watchTmux } from './reaper.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
export const CLI_ROOT = resolve(here, '../..')
/** tsx by its path: a bare `--import tsx` resolves from the working folder, and a daemon's is not always this checkout. */
export const TSX_LOADER = pathToFileURL(createRequire(join(CLI_ROOT, 'package.json')).resolve('tsx')).href
/** The sources' CLI, runnable from any folder. */
export const SOURCES_CLI: readonly string[] = ['--import', TSX_LOADER, join(CLI_ROOT, 'src', 'cli.ts')]

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
  /** The hook events this release does not have: it never runs a hook for one (Codex 0.144.0: `['Interrupt']`). */
  withoutHooks?: string[]
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
  /** The file under [root] where `codex queue` notes its calls: `codex-queue` when unset (harness/codexAppCli.ts). */
  queueLedger?: string
}

export interface DaemonOptions {
  /** Extra environment for the daemon. */
  env?: Record<string, string>
  /** More lines for the env file a start through `harness start` reads (`shellEnv`): what reaches that daemon only
   *  through the file, as it does on a person's computer. */
  envFile?: Record<string, string>
  /** V8 heap ceiling for the daemon process, MiB. Defaults to Node's own. */
  heapMiB?: number
  /** Models the fake engines report. */
  claudeModel?: string
  /** The release the fake Claude Code reports (fakeEngine.mjs's own by default, older than its plugin needs). */
  claudeVersion?: string
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
  /** Run the daemon on this Node instead of the run's own (`E2E_NODE_PATH`): a managed Node under the runtime folder.
   *  It must be alone in its folder too. */
  node?: string
  /** Run this bundle (an installed `cli.js`, its `notify.mjs` beside it: `assertHookScriptBeside`) instead of
   *  the checkout's source. */
  scriptPath?: string
  /** Start from the sources with no process-image helper, even under `E2E_BUNDLE` (whose build embeds it): a build
   *  that ships without the helper (identityHoldVisible.e2e.ts). */
  withoutProcessImages?: boolean
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
  /** The folder the daemon's process is started in, as the folder of the shell that ran `harness start`. It must exist
   *  at each start. `CLI_ROOT` when unset. */
  startFolder?: string
  /** The fake engines ask whether to trust a folder their config has no answer for (fakeEngine.mjs). */
  trustPrompt?: boolean
  /** The fake engines send Claude Code's kitty graphics query on start, then set a title (fakeEngine.mjs). */
  graphicsQuery?: { title: string; titleAfterMs: number }
}

/** The port a daemon is configured with: its `PORT`, which names its socket, its record and its artifacts. It is free
 *  when picked and closed before the daemon binds it, so another process can take it first (cli-e2e run 43568618113,
 *  shard 2). For a daemon with a socket that is harmless: it then listens on another port and says which, and the
 *  harness reads that one (`listeningPort`). One with no socket cannot move (hookServer.ts) and fails to start
 *  (noSocket.e2e.ts's first case). */
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

/** The pids of the master's `[harnessd] service <name> started (pid N)` lines in [log], in order and once each, that
 *  are still [master]'s children in [table]: a pid it logged can be a stranger's once that process has gone. */
export function loggedServicePids(log: string, name: string, master: number | null, table: ReadonlyArray<{ pid: number; ppid: number }>): number[] {
  if (master === null) return []
  const children = new Set(table.filter((row) => row.ppid === master).map((row) => row.pid))
  const logged = [...log.matchAll(new RegExp(`\\[harnessd\\] service ${name} started \\(pid (\\d+)\\)`, 'g'))].map((match) => Number(match[1]))
  return [...new Set(logged)].filter((pid) => children.has(pid))
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

/** The lines each engine's install may end on, from its own contract. */
const HOOK_INSTALL_MESSAGES = { claude: claudeHooks.settings.messages, codex: codexHooks.settings.messages }
type HookInstallEngine = keyof typeof HOOK_INSTALL_MESSAGES
/**
 * A line saying how [engine]'s hook install went: any line its contract declares but `after`, which only follows one
 * of them, `{…}` standing for anything. Any outcome counts, a failed write or a malformed file too: the install is
 * over, and what came of it is the test's to judge.
 */
const installOutcome = (engine: HookInstallEngine): RegExp => new RegExp(Object.entries(HOOK_INSTALL_MESSAGES[engine])
  .filter(([key]) => key !== 'after').flatMap(([, said]) => [said ?? []].flat())
  .map((template) => template.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
  .join('|'))
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

/** The shell of every tile, the same on every machine and never the developer's choice: under theirs, a bash, fish or
 *  tcsh user ran every tile in it, and bash and fish run path_helper too. CI installs zsh and macOS ships it. No second
 *  shell to fall back to: that would be a second rule to keep true. */
const TILE_SHELL = '/bin/zsh'

/** How many daemons have been started beside another in this process: each gets its own folder. */
let besideCount = 0

/** The executable a daemon finds for [name]: the fake engine, run with [config]. A test that wants one engine of a daemon
 *  to behave otherwise writes it over the daemon's own, before it starts. It keeps the worker's Node, since a fake engine
 *  looks up no engine. */
export const fakeEngineShim = (name: 'claude' | 'codex', config: EngineConfig & Record<string, unknown>): string =>
  `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(here, 'fakeEngine.mjs')).href)}).then((m) => m.run(${JSON.stringify(name)}, ${JSON.stringify(config)}))\n`

export class IsolatedDaemon {
  child: ChildProcess | null = null
  private output = ''
  /** Where the last start's lines begin in `output`. */
  private startedAt = 0
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
    /** Where the fake open notes each run's arguments. */
    private readonly opensLog: string,
    /** The names of the settings the harness gives every daemon, before a test's own (`shellEnv`). */
    private readonly settingNames: readonly string[],
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
      home: tmux.env.HOME!, data: options.dataDir ?? join(own, beside ? 'd' : 'data'), runtime: join(own, 'runtime'), auth: join(own, 'auth'),
      bin: join(own, 'bin'), dsh: join(own, 'dsh'), claudeProjects: join(root, 'claude', 'projects'), codexHome: join(root, 'codex'),
      projects: join(root, 'projects'), tmp: join(own, 't'),
    }
    try {
      if (!existsSync(TILE_SHELL)) throw new Error(`${TILE_SHELL} is required: a daemon under test runs its tiles under zsh`)
      // A data folder the harness gives a daemon under a TMPDIR too long for its socket falls back to one under the
      // test's home, as long, and the test failed later with `EINVAL connect` and no word of why: refused here, before
      // anything is made in the root. A test's own data folder is not measured: where it sits is that test's subject
      // (noSocket.e2e.ts passes one too long on purpose).
      if (options.dataDir === undefined) assertSocketPathFits(join(dirs.data, `daemon-${port}.sock`))
    } catch (error) {
      // A daemon beside another made nothing yet, and the root it shares is the other's.
      if (!beside) {
        await tmux.close()
        forgetTmux(tmux.socket)
      }
      throw error
    }
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    // A tile's login zsh gets back the PATH it was handed. macOS's /etc/zprofile runs path_helper, which puts
    // /etc/paths (/usr/local/bin first) and /etc/paths.d ahead of it, so `claude` or `codex` typed into a tile was the
    // developer's real engine, under their login (audit of 2026-11-15; seven cases of enginehomes.e2e.ts on a
    // developer's Mac). .zshenv is read before /etc/zprofile and notes the PATH; .zprofile is read right after it and
    // sets it again, before any .zshrc and any later .zprofile line a test writes, which keep the last word. Noted, not
    // written here: a daemon beside another shares this home and has a bin of its own. Not exported, so no child sees
    // it. A test that types an engine's name appends to these two files and never truncates them. Only zsh is covered:
    // a test that types one under bash or tcsh sets its PATH back itself.
    if (!beside) {
      await writeFile(join(dirs.home, '.zshenv'), 'HARNESS_E2E_PATH=$PATH\n', { flag: 'a' })
      await writeFile(join(dirs.home, '.zprofile'), '[[ -n $HARNESS_E2E_PATH ]] && PATH=$HARNESS_E2E_PATH\n', { flag: 'a' })
    }
    const config: EngineConfig = {
      port, dataDir: dirs.data, claudeProjectsDir: dirs.claudeProjects, codexHome: dirs.codexHome,
      claudeModel: options.claudeModel, codexModel: options.codexModel, modelControlGate: options.modelControlGate,
      ...(options.preserveProcessArgs ? { preserveProcessArgs: true } : {}),
      ...(options.submissionGate ? { submissionGate: true } : {}),
      root, hookLog: join(own, 'fake-engine-hooks.log'),
      ...(options.trustPrompt ? { trustPrompt: true } : {}),
      ...(options.graphicsQuery ? { graphicsQuery: options.graphicsQuery } : {}),
    }
    for (const name of ['claude', 'codex'] as const) {
      const shimConfig = { ...config, ...(name === 'claude' && options.claudeVersion ? { version: options.claudeVersion } : {}) }
      await writeFile(join(dirs.bin, name), fakeEngineShim(name, shimConfig), { mode: 0o755 })
    }
    // A daemon never finds the developer's own gh (shared tabs' tasks run it): a stub that refuses, until a test writes its own.
    await writeFile(join(dirs.bin, 'gh'), GH_FORBIDDEN_STUB, { mode: 0o755 })
    // Engine probes and usage readers must not consult the person's macOS
    // Keychain merely because the fixture itself runs on a Mac.
    await writeFile(join(dirs.bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
    // Nor does it run anything as root or as another account: a guest's harness goes through `sudo -n` and the guest
    // helper (lib/guestAccounts.ts), which may be installed on the Mac the tests run on. Refused, as for an owner who
    // never turned guest access on.
    await writeFile(join(dirs.bin, 'sudo'), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n', { mode: 0o755 })
    // Nor does it ask this computer's scheme handlers: on Linux a link opens only once xdg-mime names the scheme's app
    // (cable/hosts/appLink.ts), and one that prints nothing names none, so no link reaches the developer's own apps.
    await writeFile(join(dirs.bin, 'xdg-mime'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // Nor does a tap raise a window on the developer's own X display. A daemon with no DISPLAY finds the lowest X server
    // socket of root's or this account's in /tmp/.X11-unix (cable/hosts/linuxDesktop.ts), whatever its home, and
    // /usr/bin's wmctrl is on its PATH: a wmctrl that refuses, until an X11 desk of the test's own links the real one
    // (harness/x11Desk.ts).
    await writeFile(join(dirs.bin, 'wmctrl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    // Nor does its open scan see a file held outside its root. The scan reads every `codex` on the computer
    // (sessionSearch/externals/support.ts) and the devices write the dial skill into each Codex home whose rollout one
    // holds: every daemon with a dial attached wrote it into another test's Codex homes, and deviceDialSkill.e2e.ts
    // failed whenever the other dial files ran beside it, and into the developer's real ones too (2026-11-19). Found by
    // name, first on its PATH. Only the open files the scan reads (-Fpn) lose the names outside the root. A process's
    // folder (-d cwd) is kept: adoption reads it to place an engine process with no record, and one it cannot read may
    // hold any conversation. lsof's other callers (process images, held files) see the computer as it is. A computer
    // with no lsof has no scan to hide. Admitted before the daemon runs it: the scan gives lsof 3 s, and macOS checks a
    // new executable on its first exec. It exits with lsof's status, never awk's: the scan tells lsof's empty match (1,
    // nothing said) from a failure.
    const lsof = SYSTEM_FOLDERS.map((folder) => join(folder, 'lsof')).find((file) => existsSync(file))
    if (lsof) writeExecutable(join(dirs.bin, 'lsof'), `#!/bin/sh
case " $* " in
  *" -d cwd "*) exec '${lsof}' "$@" ;;
  *" -Fpn "*)
    exec 4>&1
    status=$({ { '${lsof}' "$@" 3>&- 4>&-; echo $? >&3; } | awk -v root='${root}/' 'substr($0, 1, 1) != "n" || index($0, "n" root) == 1' >&4 3>&- 4>&-; } 3>&1)
    exit "$status" ;;
  *) exec '${lsof}' "$@" ;;
esac
`)
    // Nor does it ever reach the real Orca app on the Mac the tests run on, which every session here may be running
    // inside: a listed Orca agent asks Orca for a list. A launcher is an `orca` whose real path is in Orca's install
    // (devices/orcaHomes.ts), so the stub sits in one, linked from bin, and it is the Orca app's own too
    // (HARNESS_ORCA_APP_BIN), which a daemon on a Mac runs with no launcher on its PATH: never /Applications'. Refused,
    // until a test writes its own through the link (harness/fakeOrca.ts).
    const orcaLauncher = join(own, 'orca-app', 'resources', 'bin', 'orca')
    await mkdir(dirname(orcaLauncher), { recursive: true })
    await writeFile(orcaLauncher, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await symlink(orcaLauncher, join(dirs.bin, 'orca'))
    // A pick on the dial brings that app forward with `open -b` (services/devices), and dialAppFilter.e2e.ts taps and
    // picks VS Code and Ghostty: with the real open, a dial test on a Mac would bring the developer's own apps forward.
    // Out of bin: the devices run open by its path, never by name. One line of arguments per run, for `opens()`.
    const fakeOpen = join(own, 'fake-open')
    const opensLog = join(own, 'opens.log')
    await writeFile(fakeOpen, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opensLog}'\n`, { mode: 0o755 })
    const settings = {
      NODE_ENV: 'test',
      HOME: dirs.home,
      // Its profile, under that home too. On Windows os.homedir() follows USERPROFILE, not HOME, so every default
      // under it was the developer's real profile (audit of 2026-11-15).
      // No XDG_* is named: a daemon inherits none (src/testing/daemonEnvironment.ts), so each falls under this home.
      // Naming XDG_CONFIG_HOME would also move Cursor's config folder to .config/cursor (engines/cursor/contract.ts).
      USERPROFILE: dirs.home,
      LOCALAPPDATA: join(dirs.home, 'AppData', 'Local'),
      APPDATA: join(dirs.home, 'AppData', 'Roaming'),
      // A login shell in a pane must not load anyone's zsh configuration.
      ZDOTDIR: dirs.home,
      // Its tiles' shell, not the developer's: a test that wants another names it in its own env.
      SHELL: TILE_SHELL,
      PORT: String(port),
      // A bridge port of its own: on 51793, the developer's daemon's, one daemon under test left running took the
      // port from it, and another asked `lsof` every 5.5 s which account held it (2026-11-11).
      HARNESS_CONNECTIONS_PORT: '0',
      // Its temporary folder, and its children's: an agent in its pane took the worker's, and every screenshot of
      // `harness browser` (1 MiB) outlived its test there. One letter: the daemon puts no socket here, and tmux has its
      // own (TMUX_TMPDIR), but a child's socket in it must fit too.
      TMPDIR: dirs.tmp,
      // The same folder for Windows' os.tmpdir(), which reads these and not TMPDIR: with neither, a daemon there fell
      // back to %SystemRoot%\temp, outside its root (PM, 2026-11-15).
      TEMP: dirs.tmp, TMP: dirs.tmp,
      // Its tmux server's folder, by name (src/testing/isolatedTmux.ts): the daemon's bare tmux calls must reach the
      // fixture's private server, whatever else it inherits.
      TMUX_TMPDIR: tmux.env.TMUX_TMPDIR,
      ADAPTER_DATA_DIR: dirs.data,
      ADAPTER_RUNTIME_DIR: dirs.runtime,
      ADAPTER_COMPUTER_ID: 'e2e-computer-0000-0000-000000000001',
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      HARNESS_AUTH_DIR: dirs.auth,
      DSH_DIR: dirs.dsh,
      CLAUDE_PATH: join(dirs.bin, 'claude'),
      CODEX_PATH: join(dirs.bin, 'codex'),
      // /usr/local/bin/hermes is the one recipe path outside any home (lib/engineInstall.ts), and a daemon looks at the
      // recipe's paths only when no override is set: one that installs Hermes hooks ran that file's --version
      // (engines/hermesRecord.ts). Missing until a test writes its own Hermes here.
      HERMES_PATH: join(dirs.bin, 'hermes'),
      CLAUDE_PROJECTS_DIR: dirs.claudeProjects,
      CODEX_HOME: dirs.codexHome,
      // Its fakes and stubs first, then the fixture's linked tools and the system's folders (src/testing/testPath.ts),
      // never the worker's PATH: the developer's folders are absolute, so the throwaway home hid none of them, and
      // every engine but the two pinned ones was theirs (audit of 2026-11-15).
      PATH: `${dirs.bin}:${tmux.env.PATH}`,
      // Signed out, and nothing reaches beyond the machine.
      BACKEND_WS_URL: 'ws://127.0.0.1:9',
      WEB_URL: 'http://127.0.0.1:9',
      // Nor the Store's catalog on GitHub (dsh/catalog.ts): a published one turned a fixture registry of two into the
      // live shelf of 23. Named here: the worker's own (vitest.setup.ts) is not inherited.
      HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
      // Nor grid's release server: removed roots on one Mac kept a 19 MB runtime/grid-0.3.63-darwin-arm64 each
      // (2026-11-14). Grid's set-up on a grid feature's first use (services/models.ts installCli: the picker's Set up,
      // a Get, a Use) installs the managed grid, and a managed grid already here follows its pin on every models start.
      // With no manifest to read, installCli goes on to grid's public installer: that is switched off too.
      ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/grid.json',
      DISABLE_GRID_INSTALL: 'true',
      // Nor the developer's grid login: their GRID_HOME's session would name their grid and fetch its models from
      // their control plane, and their HARNESS_GRID_BIN would skip the set-up above (empty counts as unset).
      GRID_HOME: join(dirs.home, '.grid'),
      GRID_CONTROL_PLANE_URL: 'http://127.0.0.1:9',
      HARNESS_GRID_BIN: '',
      HARNESS_OPEN_BIN: fakeOpen,
      HARNESS_ORCA_APP_BIN: orcaLauncher,
      // Nor does a fake dial's attach install Harness's VS Code extension into the developer's VS Code or Cursor
      // (cable/vscodeExtensionSetup.ts): /Applications is the computer's, whatever the home, so the devices look for VS
      // Code's `code` and Cursor's `cursor` here alone, in place of /Applications, ~/Applications and PATH. Missing
      // until a test writes its own.
      HARNESS_VSCODE_BIN: join(own, 'vscode', 'code'),
      HARNESS_CURSOR_BIN: join(own, 'cursor', 'cursor'),
      // Nor does a word to a ChatGPT app session reach the developer's ChatGPT app (cable/hosts/codexQueue.ts):
      // /Applications is the computer's, whatever the home, so the devices look for the app's own Codex CLI here alone,
      // in place of /Applications and ~/Applications. Missing until a test writes its own (harness/codexAppCli.ts).
      HARNESS_CODEX_APP_BIN: join(own, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      // Nor does a fake dial's attach start the ChatGPT app's source on the developer's app (services/devices.ts):
      // /Applications is the computer's, whatever the home, so the devices look here in its place; ~/Applications is
      // already the throwaway home's. Missing until a test writes its own, so no e2e file passes or fails by whether
      // this Mac has the ChatGPT app.
      HARNESS_APPLICATIONS_DIR: join(own, 'Applications'),
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
    }
    const env = daemonEnvironment(tmux.env, { ...settings, ...options.env })
    return new IsolatedDaemon(root, tmux, port, env, options, config, opensLog, Object.keys(settings))
  }

  /** What the fake engines noted of every hook they ran (fakeEngine.mjs `hookLog`); kept once the root is gone. */
  hookLog(): string {
    try { return readFileSync(this.engineConfig.hookLog, 'utf8') } catch { return this.closedHookLog }
  }
  private closedHookLog = ''

  /** The arguments of every run of the fake open, in order: none while it has not run. */
  opens(): string[][] {
    try { return readFileSync(this.opensLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')) } catch { return [] }
  }

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
  /** The service process [name]'s pids (`search`, `edge`, `models`, `gateway`, `devices`, `agentBrowser`), started by
   *  its own master, by the pid it logged, and still its child. Not by name: no process sets a title, and a daemon under
   *  test runs on a Node with no name link, so `ps` shows `node` for every one of them. */
  servicePids(name: string): number[] { return loggedServicePids(this.output, name, this.pid, processTable()) }

  /** `ready: 'port'` returns as soon as the port answers, the way a client sees a restarting daemon;
   *  `'none'` as soon as the process is started. */
  async start(options: { ready?: 'none' | 'port' | 'wired' } = {}): Promise<void> {
    if (this.child) throw new Error('already running')
    // Checked at every start: a test writes a shell profile, or the data folder remembers a home, between them,
    // and a test may name its script after `create` (`masterIpcExit.e2e.ts`).
    assertHooksContained(this.root, this.env)
    if (this.options.scriptPath) assertHookScriptBeside(this.options.scriptPath)
    // An installed bundle may embed a helper of its own, and a test's own launcher starts what it says.
    if (this.options.withoutProcessImages && (this.options.scriptPath || this.options.launch)) {
      throw new Error('withoutProcessImages runs the sources; it cannot run a given bundle or launcher')
    }
    // The product looks for npm-installed engines beside the Node the daemon runs on (lib/engineLaunch.ts
    // `npmRuntimeBins`), and on a developer's Mac the worker's Node was in the version manager's folder with their real
    // engines, which freshMachineEngines.e2e.ts's daemon found "already installed" (audit of 2026-11-16,
    // docs/plans/2026-11-16-e2e-isolation-3-design.md). No fallback to the worker's Node: it would reopen that without a
    // word. Checked at every start, so a test's own Node is held to it too. The master starts the core and the services
    // on the same Node, and the hooks are written with it.
    const node = this.options.node || process.env.E2E_NODE_PATH
    if (!node) throw new Error('E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts')
    assertNodeAlone(node)
    const heap = this.options.heapMiB ? [`--max-old-space-size=${this.options.heapMiB}`] : []
    const entry = this.options.noMaster ? ['__run'] : this.options.foreground ? ['start', '-f'] : ['__harnessd']
    // Readiness is judged from what this start prints, never from an earlier boot's lines.
    const from = this.startedAt = this.output.length
    // A test's own bundle (an old release), the run's bundle (`E2E_BUNDLE`, see bundle.ts), or the sources.
    const bundle = this.options.withoutProcessImages ? undefined : this.options.scriptPath ?? process.env.E2E_BUNDLE_PATH
    // From the sources on macOS, the helper a release embeds comes in by a preload (processImages.ts): without it the
    // daemon held every Codex read for good. The master passes its flags on to the core and the services.
    const preload = this.options.withoutProcessImages ? undefined : process.env.E2E_PROCESS_IMAGES_PRELOAD
    const script = bundle ? [bundle] : [...(preload ? ['--import', preload] : []), ...SOURCES_CLI]
    // A process group of its own, which the core and the services join: one signal reaches all of them, whether or
    // not the master is still there, and the worker's reaper (reaper.ts) ends it should the worker go without closing it.
    const env = this.options.foreground ? await this.shellEnv() : this.env
    const child = spawn(node, this.options.launch ?? [...heap, ...script, ...entry], {
      cwd: this.options.startFolder ?? CLI_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], ...ownProcessGroup(),
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
        // names the last one (`until`): no port said yet, a refused connection, or an answer that is not healthy. Each
        // ask has a deadline of its own: `until` checks its 60 s only between asks, and a fetch nobody answers waits 300 s.
        const port = saidPort(this.output.slice(from))
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error(`port ${port} answered /api/health with ${response.status}`)
        return true
      }, 60_000, 200)
      await until('the daemon socket', () => existsSync(this.socketPath), 10_000)
      // The port answers ~1,100 lines of startup before every handler is wired (see the startup-race
      // test); this line is printed once they are.
      if (options.ready !== 'port') {
        await until('the daemon to finish starting', () => /\[cli\] ready/.test(this.output.slice(from)), 60_000, 100)
        // The hooks it has installed so far: the rest come after it says it is ready (`hooksInstalled`).
        this.assertHooksStayedInside()
      }
    })()])
  }

  /**
   * Resolves once the last start's log says how the install of each of [engines]' hooks went, then checks they stayed
   * inside the root. A daemon installs them after it says it is ready, by design (src/startupOrder.spec.ts), and a
   * launch of its own waits for its engine's; an engine a test runs by hand, or a daemon it stops, right after start
   * does not.
   */
  async hooksInstalled(engines: readonly HookInstallEngine[]): Promise<void> {
    const outcomes = engines.map(installOutcome)
    await until(`the daemon to install the hooks of ${engines.join(', ')}`, () => {
      const lines = this.output.slice(this.startedAt).split('\n')
      return outcomes.every((outcome) => lines.some((line) => outcome.test(line)))
    }, 60_000, 100)
    this.assertHooksStayedInside()
  }

  /**
   * The environment of a shell that runs `harness start` or `harness start -f` for this daemon. Such a start keeps only
   * an allowlist of it (docs/plans/2026-11-17-daemon-minimal-env-design.md), so the harness's settings the allowlist
   * leaves out, and the test's `envFile`, go in the file HARNESS_ENV_FILE names, as a person's would. A test's `env`
   * never does: a variable it sets to see a start drop it stays dropped.
   */
  async shellEnv(): Promise<NodeJS.ProcessEnv> {
    // Loaded here, not at the top: lib/startEnvironment.ts loads config/env.ts, which reads and checks the worker's
    // environment as it loads, and the files that never start a daemon this way keep loading only what they did.
    const { startEnvFile } = await import('../../src/testing/startEnvFile.js')
    const file = join(dirname(this.engineConfig.hookLog), 'start.env')
    await writeFile(file, startEnvFile(this.env, this.settingNames, this.options.envFile))
    return { ...this.env, HARNESS_ENV_FILE: file }
  }

  /** The environment of the shell [pane] runs, as that shell sees it, written to `<root>/<name>.env`. */
  async paneEnvironment(pane: string, name: string): Promise<Record<string, string>> {
    const file = join(this.root, `${name}.env`)
    // The shell creates the file before env writes it, so it shows up empty first: written aside and moved into place whole.
    await this.tmux.run('send-keys', '-t', pane, `env > ${file}.tmp && mv ${file}.tmp ${file}`, 'Enter')
    await until(`${name}'s shell to write its environment`, () => existsSync(file) || null, 20_000, 100)
    const env: Record<string, string> = {}
    // A line with no `=` is the rest of a value that spans lines: not a variable of its own.
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
    }
    return env
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
