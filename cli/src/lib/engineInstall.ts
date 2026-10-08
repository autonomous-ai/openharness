/**
 * Official install recipes for every engine Harness can launch.
 *
 * The command is shown in Desktop before Create is pressed, then runs inside the tmux pane on the
 * target machine. Keep every line tied to first-party documentation: a plausible package name that
 * installs successfully but does not provide the expected executable is worse than no recipe.
 */

import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isTerminalEngine, type AgentEngine, type ProcessEngine } from '../engines/types.js'

/** How to find the executable after the installer returns. */
export interface EngineInstallExecutable {
  /** Executable names published by the vendor, in preference order. */
  readonly names: readonly string[]
  /** Paths relative to the target user's home, used before a freshly edited PATH can be reloaded. */
  readonly homeRelativePaths?: readonly string[]
  /** Fixed system paths used by a vendor installer in a special mode, such as a root install. */
  readonly absolutePaths?: readonly string[]
  /** Resolve each name below `npm prefix -g` when the install method is npm. */
  readonly npmGlobal?: boolean
}

export interface EngineInstallRecipe {
  /** The first-party line a person would paste into a POSIX shell. */
  readonly command: string
  /**
   * A second first-party line, run only when [command] leaves no executable behind. For a vendor
   * whose native installer depends on one download host that some networks cannot reach.
   */
  readonly fallback?: string
  /** First-party documentation used to verify the command. */
  readonly source: string
  /** Ordered, source-owned ways to locate the binary after installation. */
  readonly executable: EngineInstallExecutable
}

/**
 * Exhaustive on purpose. Adding an engine without deciding how it is installed must fail typecheck
 * rather than silently creating another unsupported row in Desktop.
 */
export const ENGINE_INSTALL: Readonly<Record<ProcessEngine, EngineInstallRecipe>> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    source: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    executable: { names: ['claude'], npmGlobal: true, homeRelativePaths: ['.local/bin/claude'] },
  },
  codex: {
    command: 'npm install -g @openai/codex',
    source: 'https://github.com/openai/codex',
    executable: { names: ['codex'], npmGlobal: true, homeRelativePaths: ['.local/bin/codex'] },
  },
  cursor: {
    command: 'curl https://cursor.com/install -fsS | bash',
    source: 'https://docs.cursor.com/en/cli/installation',
    // `cursor-agent` is deliberately the canonical name. Grok also installs `agent`; using that
    // shared alias here could turn a requested Cursor pane into a Grok pane.
    executable: { names: ['cursor-agent'], homeRelativePaths: ['.local/bin/cursor-agent'] },
  },
  opencode: {
    // The native installer downloads one matching binary. npm installs both the
    // baseline and AVX2 Linux packages, doubling the installed footprint.
    command: 'curl -fsSL https://opencode.ai/install | bash',
    // OpenCode is the default agent, and its installer downloads the binary from GitHub Releases.
    // From a Vietnamese network on 2026-10-08, release-assets.githubusercontent.com timed out while
    // the npm registry answered, so a fresh user there could not start a first harness. The npm
    // package carries the same binaries as optional dependencies and needs no GitHub download.
    fallback: 'npm install -g opencode-ai',
    source: 'https://opencode.ai/docs',
    executable: { names: ['opencode'], npmGlobal: true, homeRelativePaths: ['.opencode/bin/opencode'] },
  },
  pi: {
    // pi.dev publishes the scoped package with --ignore-scripts. The unscoped package is unrelated
    // and does not provide the `pi` executable.
    command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    source: 'https://pi.dev/',
    executable: { names: ['pi'], npmGlobal: true },
  },
  hermes: {
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    source: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md',
    executable: {
      names: ['hermes'],
      homeRelativePaths: ['.local/bin/hermes'],
      absolutePaths: ['/usr/local/bin/hermes'],
    },
  },
  commandcode: {
    command: 'npm i -g command-code',
    source: 'https://commandcode.ai/docs',
    executable: { names: ['cmd', 'command-code'], npmGlobal: true },
  },
  devin: {
    command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    source: 'https://cli.devin.ai/reference/commands',
    executable: { names: ['devin'], homeRelativePaths: ['.local/bin/devin'] },
  },
  muse: {
    command: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    source: 'https://ai.meta.com/llama/',
    executable: { names: ['muse'], homeRelativePaths: ['.local/bin/muse'] },
  },
  amp: {
    command: 'curl -fsSL https://ampcode.com/install.sh | bash',
    source: 'https://ampcode.com/docs/cli',
    executable: { names: ['amp'], homeRelativePaths: ['.local/bin/amp', '.amp/bin/amp'] },
  },
  kilo: {
    command: 'npm install -g @kilocode/cli',
    source: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    executable: {
      names: ['kilo', 'kilocode'],
      npmGlobal: true,
      homeRelativePaths: ['.kilo/bin/kilo', '.local/bin/kilo'],
    },
  },
  grok: {
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    source: 'https://docs.x.ai/build/overview',
    executable: { names: ['grok'], homeRelativePaths: ['.grok/bin/grok', '.local/bin/grok'] },
  },
  agy: {
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    source: 'https://antigravity.google/docs/cli/install/',
    executable: { names: ['agy'], homeRelativePaths: ['.local/bin/agy'] },
  },
  copilot: {
    command: 'npm install -g @github/copilot',
    source: 'https://docs.github.com/en/copilot/get-started/cli-quickstart',
    executable: { names: ['copilot'], npmGlobal: true, homeRelativePaths: ['.local/bin/copilot'] },
  },
}

/** A terminal has nothing to install — the login shell is already there — hence `undefined`. */
export function engineInstallRecipe(engine: AgentEngine): EngineInstallRecipe | undefined {
  return isTerminalEngine(engine) ? undefined : ENGINE_INSTALL[engine]
}

/** Stable across managed Node upgrades and writable by this OS user, unlike shared Homebrew. */
export function npmEnginePrefix(): string {
  return join(homedir(), '.local')
}

/** The same candidates are used by launch, availability checks, and process discovery. */
export function engineInstallPaths(recipe: EngineInstallRecipe): string[] {
  return [...new Set([
    ...(recipe.executable.homeRelativePaths ?? []).map((path) => join(homedir(), path)),
    ...(recipe.executable.absolutePaths ?? []),
    ...(recipe.executable.npmGlobal
      ? recipe.executable.names.map((name) => join(npmEnginePrefix(), 'bin', name))
      : []),
  ])]
}

export const INSTALLABLE_ENGINES: ReadonlySet<AgentEngine> = new Set(
  Object.keys(ENGINE_INSTALL) as AgentEngine[],
)

/**
 * How long one engine's install may run with nobody watching (`harness engines install-missing`)
 * before it is killed and reported failed. A healthy one takes seconds: OpenCode's native installer
 * about fourteen, an npm package under a minute on a slow line. Ten minutes is for a network that is
 * merely bad; past it the install is hung (a download that stalled without closing).
 */
export const ENGINE_INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * How long the first of a recipe's two install lines may run before it is stopped and the second,
 * its `fallback`, runs instead. Only recipes with a fallback get one: a lone installer is left to
 * finish, since stopping it would leave nothing to try.
 *
 * OpenCode's native installer downloads from GitHub Releases, which a network in Vietnam could not
 * reach on 2026-10-08 (the reason for the fallback). A download that is accepted and then stalls has
 * no `--max-time` in the vendor's script to end it (found in the review of #1047): the installer
 * would never exit, the npm fallback never run, and the pane wait for good. A healthy native install
 * takes eight to fourteen seconds; two minutes leaves a slow line room before the fallback, which
 * carries the same binaries, takes over.
 */
export const ENGINE_INSTALL_PRIMARY_LIMIT_S = 120

/**
 * How long a pane waits for another install of its engine to finish before it gives up and says so.
 *
 * Long enough for the worst healthy case on the network the fallback exists for: the native
 * installer stopped at `ENGINE_INSTALL_PRIMARY_LIMIT_S`, then `npm install -g opencode-ai`, about a
 * minute; with a margin, five minutes. At two minutes, a new user's first harness on that network
 * would have given up, "not started", on a background install still on its healthy course (review
 * of #1047). Not
 * the background install's whole ten minutes: the daemon gives a new pane ten minutes in all to show
 * its engine (`watchNewPane`), and the pane's own install, if the other one failed, needs the rest.
 */
export const ENGINE_INSTALL_WAIT_S = 300

/**
 * A backstop, not a rule: a lock whose holder can be checked (its pid running with the start marker
 * it wrote) is held however long it takes, since a slow pane install past any bound is still an
 * install that a second one beside it would break. Only a holder whose start cannot be compared
 * (no marker written, or none readable now) and whose lock is older than this is taken over: past
 * the background install's own limit, such a pid is more likely reused than still installing.
 */
export const ENGINE_INSTALL_LOCK_MAX_AGE_S = 30 * 60

/** What the background install's script exits with when another install of the engine outlasted
 *  its wait (`ENGINE_INSTALL_WAIT_S`): not a failure of this engine's install, which never ran. */
export const BACKGROUND_INSTALL_BUSY_EXIT = 75

/**
 * Where the install locks live: one folder per engine being installed (`engineInstallLockPath`).
 *
 * Product-root state, under the home rather than a daemon's data folder, because what the lock
 * guards is shared by every process of this OS user: a pane of the release daemon, a pane of a dev
 * daemon and the desktop's background install (`harness engines install-missing`) all install into
 * the same `~/.local` or `~/.opencode`. Two npm installs of one package into one prefix at once
 * leave it half written, which is what the lock is for.
 */
export function engineInstallLockDir(): string {
  return join(homedir(), '.harness', 'run', 'engine-install')
}

/**
 * Who holds an install lock: the one line of its `owner` file, `<pid> <since> <kind> <start>`.
 *
 * `since` is when it was taken (epoch seconds, `ENGINE_INSTALL_LOCK_MAX_AGE_S`), `kind` is `pane`,
 * `background` or `run` (a whole `install-missing` run), and `start` is the holder's start marker
 * (`processLiveness.ts` `processStartMarker`), last because it holds spaces. A pid alone is not enough:
 * after a power loss the pid in a lock left behind can belong to an unrelated process, and the lock
 * would look held for good. The shell side writes and reads the same line (`installLockFunctions` in
 * engineLaunch.ts), so a pane and the background install judge each other's locks alike.
 */
export interface EngineLockOwner {
  readonly pid: number
  readonly since: number
  readonly kind: string
  readonly start: string
}

export function formatEngineLockOwner(owner: EngineLockOwner): string {
  return `${owner.pid} ${owner.since} ${owner.kind} ${owner.start}\n`
}

/** Null for an empty or malformed line: a holder between its `mkdir` and its write, or debris. */
export function parseEngineLockOwner(text: string): EngineLockOwner | null {
  const match = /^([1-9][0-9]*) ([0-9]+) ([a-z]+) ?(.*)$/.exec(text.replace(/\n+$/, ''))
  return match ? { pid: Number(match[1]), since: Number(match[2]), kind: match[3], start: match[4] } : null
}

/**
 * The lock for one recipe, named by the executable it installs (`opencode.lock`, `claude.lock`), so
 * a pane and the background install of the same engine find the same lock whichever of them built
 * the recipe. A test fixture names its executable by path; only a plain file name is used.
 */
export function engineInstallLockPath(recipe: EngineInstallRecipe): string {
  const name = basename(recipe.executable.names[0] ?? 'engine').replace(/[^A-Za-z0-9._-]/g, '_') || 'engine'
  return join(engineInstallLockDir(), `${name}.lock`)
}

/** The vendor names an install line uses (docs/naming-system.md keeps them intact). */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  opencode: 'OpenCode',
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
}

/** What an install line calls the engine: the vendor's name, else the command a person would type. */
export function engineInstallName(recipe: EngineInstallRecipe): string {
  const command = basename(recipe.executable.names[0] ?? '')
  return VENDOR_NAMES[command] ?? (command || 'the engine')
}
