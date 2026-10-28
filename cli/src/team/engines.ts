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
import { accessSync, constants } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { engineAccount, type EngineAccount } from '../lib/engineAccount.js'
import { readTeamConfig, type TeamConfig } from './config.js'
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

/** [relayed]: not signed in itself, it spends the owner's subscription through the owner's relay (team/relay.ts). */
export interface EngineReadiness { installed: boolean; signedIn: boolean | null; relayed?: boolean }
export type TeamEngines = { checkedAt: number } & Record<TeamEngine, EngineReadiness>

/** Where the team account's engines are: its npm prefix's bin folder, on its daemon's PATH (./script.ts). */
export const teamEngineBin = (home: string, engine: TeamEngine) => join(home, '.local', 'bin', engine)

export interface EngineCheckDeps {
  home: string
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
    const installed = deps.executable(teamEngineBin(deps.home, engine))
    let signedIn: boolean | null = null
    try { signedIn = (await deps.account(engine)).signedIn } catch { /* cannot say */ }
    result[engine] = { installed, signedIn, ...(signedIn !== true && deps.relayed?.() ? { relayed: true } : {}) }
  }
  return result
}

export const realEngineCheckDeps = (home: string, env: NodeJS.ProcessEnv = process.env): EngineCheckDeps => ({
  home,
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
    // Only a Mac and a Linux computer have a Harness Team account: elsewhere nothing is read.
    config: () => process.platform === 'darwin' || process.platform === 'linux' ? readTeamConfig() : null,
    user: () => userInfo().username,
    check: (config) => checkTeamEngines(realEngineCheckDeps(config.home)),
    read: (path) => readTeamStatus(path),
    write: writeTeamStatus,
  })
}

/** What `harness team status` and setup say of the engines, and exactly how to sign them in. */
export function engineLines(engines: TeamEngines | undefined, ago: (at: number) => string): string[] {
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
    lines.push('', '  To sign the team account\'s engines in, once: in Harness, open a terminal on this Mac\'s Harness Team machine',
      '  (it is listed among your machines), and run there:')
    for (const { name, signIn } of unsigned) lines.push(`    ${signIn.padEnd(28)}${name}`)
    lines.push('  Your own sign-ins are not copied into the team account; each engine bills the account you sign in with.')
  }
  return lines
}
