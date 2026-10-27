/**
 * A Harness Team account left on a build too old for its owner's subscriptions is brought up to date by its owner's
 * daemon, with nobody at the Mac.
 *
 * Setup copies the owner's CLI into the team account. An owner on a local build (a developer's) gave it that build, and
 * a local build never updated itself, so the account stayed on it (2026-10-27): no owner subscription relay, its engines
 * read signed out, and the Lead routed nothing there. Its updater now follows releases (lib/selfUpdate.ts
 * `followReleases`), but a team account already on such a build has the old updater, so the owner's daemon starts the
 * update there once: `harness update --force` as the team account, through the shell request its own apps use
 * (services/shell.ts `shell_open`) over the link to that machine. The team account's own Node and CLI, from the
 * root-owned config, run it. Nothing is written into the team account's home from outside.
 *
 * Asked only when the team account says so itself: its status file reports engines it has neither signed in nor reached
 * the owner's relay for, checked after this daemon published the relay, which a build that knows the relay never does.
 * At most once a day, remembered in this daemon's own folder.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TeamConfig } from './config.js'
import type { TeamStatus } from './privacy.js'
import { TEAM_ENGINES } from './engines.js'

/** How long after one try the owner's daemon may try again. */
export const TEAM_REFRESH_RETRY_MS = 24 * 60 * 60_000

export interface TeamRefreshDeps {
  config(): TeamConfig | null
  status(path: string): TeamStatus | null
  /** When this daemon last published the owner's relay (team/relay.ts), or null before it has. */
  publishedAt(): number | null
  /** The account's machines, from `GET /api/machines`: the team account of this Mac is among them. */
  machines(): Promise<Array<{ machineId: string; sessionKind?: string | null; hostMachineId?: string | null }>>
  /** This Mac's own machine id. */
  machineId(): string
  /** Runs [argv] in [cwd] as a terminal on [machineId], over the link (`shell_open`). */
  run(machineId: string, argv: string[], cwd: string): Promise<{ ok: boolean; error?: string }>
  lastTry(): number | null
  remember(at: number): void
  now(): number
  log(line: string): void
}

/** Whether the team account's own report says its build cannot use the owner's relay. */
export function teamBuildStale(status: TeamStatus | null, publishedAt: number | null): boolean {
  const engines = status?.engines
  if (!engines || publishedAt === null || engines.checkedAt < publishedAt) return false
  const installed = TEAM_ENGINES.filter(({ engine }) => engines[engine].installed)
  return installed.length > 0 && installed.every(({ engine }) => engines[engine].signedIn !== true && !engines[engine].relayed)
}

/** One look: updates the team account when its build is too old, at most once a day. Never throws. */
export async function refreshTeamAccount(deps: TeamRefreshDeps): Promise<void> {
  try {
    const config = deps.config()
    if (!config || !teamBuildStale(deps.status(config.statusFile), deps.publishedAt())) return
    const last = deps.lastTry()
    if (last !== null && deps.now() - last < TEAM_REFRESH_RETRY_MS && deps.now() >= last) return
    const here = deps.machineId()
    const team = (await deps.machines()).find((m) => m.sessionKind === 'team' && m.hostMachineId === here)
    if (!team) return
    deps.remember(deps.now())
    const answer = await deps.run(team.machineId, [config.node, config.cli, 'update', '--force'], config.home)
    deps.log(answer.ok
      ? 'team: the Harness Team account was on a build without this Mac\'s subscriptions; updating it'
      : `team: could not update the Harness Team account (${answer.error ?? 'no answer'}); trying again tomorrow`)
  } catch (error) {
    deps.log(`team: could not update the Harness Team account: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Where the owner's daemon remembers its last try, in its own data folder. */
export const teamRefreshFile = (dataDir: string) => join(dataDir, 'team-refresh.json')

export function readLastTry(file: string): number | null {
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch { return null }
}

export function writeLastTry(file: string, at: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const next = `${file}.${process.pid}.next`
  writeFileSync(next, `${JSON.stringify({ at })}\n`, { mode: 0o600 })
  renameSync(next, file)
}

/** A creation id `shell_open` takes (lib/agentCreationReceipt.ts `validCreationId`). */
export const refreshCreationId = () => `team-update-${randomUUID().replace(/-/g, '')}`
