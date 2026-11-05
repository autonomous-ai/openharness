/**
 * Claude Code and Codex in the Harness Team account (docs/plans/2026-10-24-swarm-team-account.md, Task 2).
 *
 * With the owner's home folder private, the engines installed under it are out of the team account's reach. Setup has
 * the team account install its own (./script.ts `TEAM_ENGINES`), with the vendors' npm packages, its own copy of
 * Harness's Node and a prefix in its own home, never as root. An engine it has not signed in spends the owner's
 * subscription through the owner's relay (./relay.ts): nothing of the owner's sign-ins is copied into it. One signed in
 * there (in a terminal on the team machine) still bills the account it is signed in with.
 *
 * The owner cannot look inside the team account's home, so the team daemon reports what it finds (installed, signed in)
 * in its status file, as it starts and every minute after, and `harness team status` reads it there.
 */
import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { engineAccount, type EngineAccount } from '../lib/engineAccount.js'
import { env } from '../config/env.js'
import { readTeamConfig, type TeamConfig } from './config.js'
import { receiveTeamModel } from './modelHandoff.js'
import { TEAM_USER } from './layout.js'
import type { EngineCopy } from './script.js'
import { readTeamStatus, writeTeamStatus, type TeamStatus } from './privacy.js'
import { teamRelayed } from './relay.js'

export type TeamEngine = 'claude' | 'codex'

export interface TeamEngineInfo {
  engine: TeamEngine
  name: string
  /** The vendor's npm package (lib/engineInstall.ts), installed by the team account under `~/.local`. */
  packageName: string
  /** What the owner runs in a terminal on the team machine to sign it in. */
  signIn: string
}

export const TEAM_ENGINES: readonly TeamEngineInfo[] = [
  { engine: 'claude', name: 'Claude Code', packageName: '@anthropic-ai/claude-code', signIn: 'claude' },
  { engine: 'codex', name: 'Codex', packageName: '@openai/codex', signIn: 'codex login --device-auth' },
]

/** Where else an owner's npm puts global packages on a Mac: Homebrew's Node, on Apple silicon and on Intel. */
export const SYSTEM_NPM_PREFIXES = ['/opt/homebrew', '/usr/local'] as const

/**
 * The owner's own installed Claude Code and Codex, for setup to copy into the team account instead of downloading them
 * again (#3169: npm was 4 min 18 s of a 4 min 35 s setup on this Mac; the copy 2.3 s). Read as the owner, before the
 * password. Each engine from the first place that has it as npm leaves it: Harness's own prefix (`~/.local`,
 * lib/engineInstall.ts), the Harness Node's, then [prefixes] (Homebrew's). Only a real folder holding that package by name,
 * with its command where its package.json says: an `npm link` to a source checkout is the owner's work, not an install.
 * An engine found nowhere is left to npm.
 *
 * And only what nobody but the owner or root could have changed (security review 1 of #3124): Homebrew's folders may
 * belong to another person on this Mac, and whoever can write a package decides what the Team account runs. So every
 * folder from / down to the package, and everything in it, must be the owner's ([uid]) or root's and writable by no one
 * else; a folder anyone can write passes only with the sticky bit (/tmp), where nobody else can swap what is in it.
 */
export function ownerEngineCopies(input: { home: string; nodeRuntimeDir: string | null; prefixes?: readonly string[]; uid?: number }): EngineCopy[] {
  const uid = input.uid ?? process.getuid?.()
  if (uid === undefined) return []
  const prefixes = [join(input.home, '.local'), ...input.nodeRuntimeDir ? [input.nodeRuntimeDir] : [], ...input.prefixes ?? SYSTEM_NPM_PREFIXES]
  const copies: EngineCopy[] = []
  for (const { engine, packageName } of TEAM_ENGINES) {
    for (const prefix of prefixes) {
      const copy = installedPackage(join(prefix, 'lib', 'node_modules', packageName), packageName, engine, uid)
      if (copy) { copies.push(copy); break }
    }
  }
  return copies
}

/** More than any engine's package holds (Claude Code and Codex together were 77 entries on 2026-11-05): past it, npm. */
const MOST_ENTRIES = 20_000

const ownedBy = (uid: number, stat: { uid: number }) => stat.uid === uid || stat.uid === 0
/** Writable by its group or others, without the sticky bit that keeps them from swapping what is in a folder. */
const openToOthers = (mode: number, folder: boolean) => (mode & 0o022) !== 0 && !(folder && (mode & 0o1000) !== 0)

/** Every folder above [dir], through its real path to /, the owner's or root's and closed to others. */
function aboveTrusted(dir: string, uid: number): boolean {
  for (let at = dirname(realpathSync(dir)); ; at = dirname(at)) {
    const stat = lstatSync(at)
    if (!ownedBy(uid, stat) || openToOthers(stat.mode, true)) return false
    if (dirname(at) === at) return true
  }
}

/** [dir] and everything in it, links included and never followed, the owner's or root's and closed to others. */
function treeTrusted(dir: string, uid: number): boolean {
  const folders = [dir]
  let seen = 0
  while (folders.length) {
    const folder = folders.pop()!
    for (const name of ['', ...readdirSync(folder)]) {
      if (++seen > MOST_ENTRIES) return false
      const path = name ? join(folder, name) : folder
      const stat = lstatSync(path)
      if (!ownedBy(uid, stat)) return false
      // A link's own mode means nothing; where it points is checked as the team account reads it.
      if (stat.isSymbolicLink()) continue
      if (openToOthers(stat.mode, stat.isDirectory())) return false
      if (name && stat.isDirectory()) folders.push(path)
    }
  }
  return true
}

function installedPackage(dir: string, packageName: string, bin: string, uid: number): EngineCopy | null {
  try {
    if (!lstatSync(dir).isDirectory()) return null
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown }
    if (manifest.name !== packageName) return null
    const named = typeof manifest.bin === 'string' ? manifest.bin
      : manifest.bin && typeof manifest.bin === 'object' ? (manifest.bin as Record<string, unknown>)[bin] : undefined
    if (typeof named !== 'string') return null
    const binPath = posix.normalize(named)
    if (binPath.startsWith('../') || binPath.startsWith('/') || binPath === '..' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(binPath)) return null
    // The command itself, not a link: where a link points is not the package's to say.
    if (!lstatSync(join(dir, binPath)).isFile()) return null
    accessSync(join(dir, binPath), constants.X_OK)
    if (!aboveTrusted(dir, uid) || !treeTrusted(dir, uid)) return null
    return { packageName, dir, bin, binPath }
  } catch { return null }
}

/** [relayed]: not signed in itself, it spends the owner's subscription through the owner's relay (team/relay.ts). */
export interface EngineReadiness { installed: boolean; signedIn: boolean | null; relayed?: boolean }
export type TeamEngines = { checkedAt: number } & Record<TeamEngine, EngineReadiness>

/** Where the team account's engines are: its npm prefix's bin folder, on its daemon's PATH (./script.ts). On Windows npm
 *  puts a command's `.cmd` in the prefix itself (./windowsScript.ts). */
export const teamEngineBin = (home: string, engine: TeamEngine, platform: NodeJS.Platform = 'darwin') =>
  platform === 'win32' ? win32.join(home, '.local', `${engine}.cmd`) : join(home, '.local', 'bin', engine)

export interface EngineCheckDeps {
  home: string
  /** Where the engines are kept, by system: a Mac's unless told (the real deps say this one's). */
  platform?: NodeJS.Platform
  executable(path: string): boolean
  account(engine: TeamEngine): Promise<EngineAccount>
  now(): number
  /** Whether the owner's relay is there for the team account's engines (team/relay.ts `teamRelayed`). */
  relayed?(): boolean
}

/** What the team account has of each engine: installed in its own home, and signed in (null when it cannot say). */
export async function checkTeamEngines(deps: EngineCheckDeps): Promise<TeamEngines> {
  const result = { checkedAt: deps.now() } as TeamEngines
  for (const { engine } of TEAM_ENGINES) {
    const installed = deps.executable(teamEngineBin(deps.home, engine, deps.platform))
    let signedIn: boolean | null = null
    try { signedIn = (await deps.account(engine)).signedIn } catch { /* cannot say */ }
    result[engine] = { installed, signedIn, ...(signedIn !== true && deps.relayed?.() ? { relayed: true } : {}) }
  }
  return result
}

export const realEngineCheckDeps = (home: string, env: NodeJS.ProcessEnv = process.env): EngineCheckDeps => ({
  home,
  platform: process.platform,
  executable: (path) => { try { accessSync(path, constants.X_OK); return true } catch { return false } },
  // Only presence is read, never a secret (lib/engineAccount.ts). The team daemon has no login shell of the owner's to read.
  account: (engine) => engineAccount(engine, { home, env, lastUsed: false }),
  now: () => Date.now(),
  relayed: teamRelayed,
})

/** How often the team daemon looks again: an engine signed in shows in `harness team status` within this long. */
export const ENGINE_RECHECK_MS = 60_000

export interface EngineReporterDeps {
  config(): TeamConfig | null
  user(): string
  check(config: TeamConfig): Promise<TeamEngines>
  read(path: string): TeamStatus | null
  write(path: string, update: Partial<Omit<TeamStatus, 'version'>>): void
  /** Windows: a model API its owner left (./modelHandoff.ts), taken at each look. */
  receive?(config: TeamConfig): void
  intervalMs?: number
}

/** Writes the team account's engines to its status file, while this daemon runs in the Harness Team account. */
export class TeamEngineReporter {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  constructor(private readonly deps: EngineReporterDeps) {}

  start(): void {
    if (this.timer || !this.inTeamAccount()) return
    this.timer = setInterval(() => { void this.report() }, this.deps.intervalMs ?? ENGINE_RECHECK_MS)
    this.timer.unref?.()
    void this.report()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private inTeamAccount(): TeamConfig | null {
    const config = this.deps.config()
    return config && config.user === this.deps.user() ? config : null
  }

  /** One look, written only when something changed; never two at once. Never throws. */
  report(): Promise<void> {
    this.running ??= (async () => {
      const config = this.inTeamAccount()
      if (!config) return
      this.deps.receive?.(config)
      const engines = await this.deps.check(config)
      const before = this.deps.read(config.statusFile)?.engines
      const same = before && TEAM_ENGINES.every(({ engine }) =>
        before[engine].installed === engines[engine].installed && before[engine].signedIn === engines[engine].signedIn
        && !before[engine].relayed === !engines[engine].relayed)
      // Unchanged, the file is left alone, but a stamp more than ten minutes old is renewed so status can say it is current.
      if (same && engines.checkedAt - before.checkedAt < 10 * ENGINE_RECHECK_MS) return
      this.deps.write(config.statusFile, { engines })
    })().catch(() => { /* the next look reports it */ }).finally(() => { this.running = null })
    return this.running
  }
}

export function teamEngineReporter(): TeamEngineReporter {
  return new TeamEngineReporter({
    config: () => readTeamConfig(),
    user: () => userInfo().username,
    check: (config) => checkTeamEngines(realEngineCheckDeps(config.home)),
    read: (path) => readTeamStatus(path),
    write: writeTeamStatus,
    ...(process.platform === 'win32' ? { receive: (config: TeamConfig) => receiveTeamModel({ home: config.home, dataDir: env.ADAPTER_DATA_DIR, now: Date.now,
      report: (update) => writeTeamStatus(config.statusFile, update) }) } : {}),
  })
}

/** What `harness team status` and setup say of the engines, and exactly how to sign them in, on [platform]'s computer. */
export function engineLines(engines: TeamEngines | undefined, ago: (at: number) => string, platform: NodeJS.Platform = 'darwin'): string[] {
  const computer = platform === 'darwin' ? 'this Mac' : 'this computer'
  if (!engines) {
    return ['  engines     ? not reported yet: the team daemon reports them once it runs']
  }
  const lines = TEAM_ENGINES.map(({ engine, name }, index) => {
    const e = engines[engine]
    const state = !e.installed ? '✗ not installed · harness team setup installs it'
      : e.signedIn === true ? '✓ installed · ✓ signed in'
        : e.relayed ? '✓ installed · ✓ uses your subscription'
          : e.signedIn === false ? '✓ installed · ✗ not signed in' : '✓ installed · ? sign-in unknown'
    return `  ${index === 0 ? 'engines' : '       '}     ${name.padEnd(12)}${state}`
  })
  lines.push(`              (checked ${ago(engines.checkedAt)})`)
  const unsigned = TEAM_ENGINES.filter(({ engine }) => engines[engine].installed && engines[engine].signedIn !== true && !engines[engine].relayed)
  if (unsigned.length) {
    lines.push('', `  To sign the team account's engines in, once: in Harness, open a terminal on ${computer}'s Harness Team machine`,
      '  (it is listed among your machines), and run there:')
    for (const { name, signIn } of unsigned) lines.push(`    ${signIn.padEnd(28)}${name}`)
    // A computer used over a terminal has no Harness app to open a terminal in (headless run, 2026-11-03): the same sign-in,
    // from the terminal the person is already in.
    if (platform !== 'win32') {
      lines.push(`  Or from a terminal on ${computer}, as ${TEAM_USER}:`)
      const terminal = unsigned.map(({ engine, name }) => ({
        command: `sudo -u ${TEAM_USER} -H bash -lc ${engine === 'claude' ? 'claude' : "'codex login --device-auth'"}`, name,
      }))
      const width = Math.max(...terminal.map(({ command }) => command.length)) + 3
      for (const { command, name } of terminal) lines.push(`    ${command.padEnd(width)}${name}`)
    }
    lines.push('  Your own sign-ins are not copied into the team account; each engine bills the account you sign in with.')
    // Why a server reads "not signed in" with a subscription on the account: the relay that lends it lives in this
    // computer's own daemon (team/relay.ts), so nothing is lent while that daemon is not running.
    lines.push("  An engine the account has not signed in uses your subscription through this computer's Harness while it runs;",
      '  when that is not running (harness start, or harness service install), there is nothing to lend.')
  }
  return lines
}
