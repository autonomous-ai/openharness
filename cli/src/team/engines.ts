/**
 * Claude Code and Codex in the Harness Team account (docs/plans/2026-10-24-swarm-team-account.md, Task 2).
 *
 * With the owner's home folder private, the engines installed under it are out of the team account's reach. Setup has
 * the team account install its own (./script.ts `TEAM_ENGINES`), with the vendors' npm packages, its own copy of
 * Harness's Node and a prefix in its own home, never as root. Nothing of the owner's sign-ins is copied into it, and
 * nothing spends the owner's subscription for it (anh Dee, 2026-11-07): an engine signed in there (in a terminal on the
 * team machine) bills the account it is signed in with, and one not signed in shows its own sign-in.
 *
 * The owner cannot look inside the team account's home, so the team daemon reports what it finds (installed, signed in)
 * in its status file, as it starts and every minute after, and `harness team status` reads it there.
 */
import { accessSync, constants } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, dirname, join, win32 } from 'node:path'
import { engineAccount, type EngineAccount } from '../lib/engineAccount.js'
import { env } from '../config/env.js'
import { readTeamConfig, type TeamConfig } from './config.js'
import { receiveTeamModel } from './modelHandoff.js'
import { readTeamStatus, writeTeamStatus, type TeamStatus } from './privacy.js'

export type TeamEngine = 'claude' | 'codex'

export interface TeamEngineInfo {
  engine: TeamEngine
  name: string
  /** What the owner runs in a terminal on the team machine to sign it in. */
  signIn: string
}

export const TEAM_ENGINES: readonly TeamEngineInfo[] = [
  { engine: 'claude', name: 'Claude Code', signIn: 'claude' },
  { engine: 'codex', name: 'Codex', signIn: 'codex login --device-auth' },
]

export interface EngineReadiness { installed: boolean; signedIn: boolean | null }
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
}

/** What the team account has of each engine: installed in its own home, and signed in (null when it cannot say). */
export async function checkTeamEngines(deps: EngineCheckDeps): Promise<TeamEngines> {
  const result = { checkedAt: deps.now() } as TeamEngines
  for (const { engine } of TEAM_ENGINES) {
    const installed = deps.executable(teamEngineBin(deps.home, engine, deps.platform))
    let signedIn: boolean | null = null
    try { signedIn = (await deps.account(engine)).signedIn } catch { /* cannot say */ }
    result[engine] = { installed, signedIn }
  }
  return result
}

export const realEngineCheckDeps = (home: string, env: NodeJS.ProcessEnv = process.env): EngineCheckDeps => ({
  home,
  platform: process.platform,
  executable: (path) => { try { accessSync(path, constants.X_OK); return true } catch { return false } },
  // The engine's own CLI says whether it is signed in (lib/engineAccount.ts), asked where the team's copy is: its home's bin,
  // which the daemon's PATH need not name. The team daemon has no login shell of the owner's to read.
  account: (engine) => engineAccount(engine, { home, lastUsed: false,
    env: { ...env, PATH: [dirname(teamEngineBin(home, engine as TeamEngine, process.platform)), env.PATH].filter(Boolean).join(delimiter) } }),
  now: () => Date.now(),
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
        before[engine].installed === engines[engine].installed && before[engine].signedIn === engines[engine].signedIn)
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
