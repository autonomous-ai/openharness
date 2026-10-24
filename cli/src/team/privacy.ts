/**
 * The Harness Team account's privacy check (docs/plans/2026-10-24-swarm-team-account.md, Task 2), run by the team
 * daemon itself, as the team account: as its job starts (`harness team __start`) and while it serves a Swarm
 * (superTabs/machines.ts, at most every PRIVACY_RECHECK_MS).
 *
 * A second account alone is not private. On macOS every local account is in the group staff, a home folder is
 * `drwxr-x---` with that group by default, and `~/code` (755) or `~/.gitconfig` (644) inside it are readable by any
 * other account on the Mac. Setup makes the owner's home 700; this proves it, from the side that matters, every
 * time. Each probe must be refused with EACCES or EPERM. Reading it, or any other answer (a missing file means the
 * folder above it was searchable), fails the check, and the first failing item is what the machine reports.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TeamConfig } from './config.js'
import type { TeamEngines } from './engines.js'

export type PrivacyItem =
  | 'sentinel' | 'home-listing' | 'gitconfig' | 'ssh' | 'projects' | 'keychain' | 'chrome' | 'safari' | 'standard-user'

export type PrivacyResult =
  | { passed: true; checkedAt: number }
  | { passed: false; item: PrivacyItem | 'unchecked'; detail: string; checkedAt: number }

interface Probe { item: PrivacyItem; what: string; kind: 'read' | 'list'; paths: string[] }

/** The folders people keep projects in: listing any of them must be refused. */
const PROJECT_FOLDERS = ['code', 'Code', 'Developer', 'Projects', 'projects', 'src', 'Documents']

/** What the check tries, in order. `what` is shown to people and sent with the machine's reading, so it names a
 *  place by `~`, never by the owner's absolute path (which carries their account name). */
export function privacyProbes(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>): Probe[] {
  const home = config.ownerHome
  return [
    { item: 'sentinel', what: 'the privacy sentinel in your home folder', kind: 'read', paths: [config.sentinel] },
    { item: 'home-listing', what: 'the list of files in your home folder', kind: 'list', paths: [home] },
    { item: 'gitconfig', what: '~/.gitconfig', kind: 'read', paths: [`${home}/.gitconfig`] },
    { item: 'ssh', what: '~/.ssh', kind: 'list', paths: [`${home}/.ssh`] },
    { item: 'projects', what: 'your project folders (~/code and the like)', kind: 'list', paths: PROJECT_FOLDERS.map((name) => `${home}/${name}`) },
    { item: 'keychain', what: 'your login Keychain folder', kind: 'list', paths: [`${home}/Library/Keychains`] },
    { item: 'chrome', what: 'Chrome\'s profile folder', kind: 'list', paths: [`${home}/Library/Application Support/Google/Chrome`] },
    { item: 'safari', what: 'Safari\'s folder', kind: 'list', paths: [`${home}/Library/Safari`] },
  ]
}

export interface PrivacyDeps {
  /** Opens and closes [path] for reading; throws as the system does. */
  open(path: string): void
  /** Lists [path]; throws as the system does. */
  list(path: string): void
  /** This process's group ids. */
  groups(): number[]
  now(): number
}

export const realPrivacyDeps: PrivacyDeps = {
  open: (path) => closeSync(openSync(path, 'r')),
  list: (path) => { readdirSync(path) },
  groups: () => process.getgroups?.() ?? [],
  now: () => Date.now(),
}

/** The group macOS administrators are in. */
const ADMIN_GID = 80

const refused = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

export function runPrivacyCheck(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>, deps: PrivacyDeps = realPrivacyDeps): PrivacyResult {
  const checkedAt = deps.now()
  for (const probe of privacyProbes(config)) {
    for (const path of probe.paths) {
      try {
        if (probe.kind === 'read') deps.open(path)
        else deps.list(path)
      } catch (error) {
        if (refused(error)) continue
        const code = (error as NodeJS.ErrnoException | null)?.code ?? 'an error'
        // ENOENT under a home folder at 700 cannot happen: the folder would have refused the search first.
        return { passed: false, item: probe.item, checkedAt,
          detail: `The team account was not refused ${probe.what} (it got ${code}), so your home folder is not private.` }
      }
      return { passed: false, item: probe.item, checkedAt, detail: `The team account could read ${probe.what}.` }
    }
  }
  if (deps.groups().includes(ADMIN_GID)) {
    return { passed: false, item: 'standard-user', checkedAt, detail: 'The team account is an administrator; it must be a standard user.' }
  }
  return { passed: true, checkedAt }
}

/** What the team daemon reports for the owner's `harness team status`, in the team account's status folder. */
export interface TeamStatus {
  version: 1
  signIn?: { state: 'signed-in' | 'failed' | 'signed-out'; at: number; detail?: string }
  privacy?: PrivacyResult
  /** Claude Code and Codex in the team account (./engines.ts). */
  engines?: TeamEngines
}

/** The `engines` field of the status file, or undefined when it is not one. */
export function enginesOf(value: unknown): TeamEngines | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.checkedAt !== 'number' || !Number.isFinite(v.checkedAt)) return undefined
  const result = { checkedAt: v.checkedAt } as TeamEngines
  for (const engine of ['claude', 'codex'] as const) {
    const e = v[engine] as Record<string, unknown> | undefined
    if (!e || typeof e !== 'object' || typeof e.installed !== 'boolean' || (typeof e.signedIn !== 'boolean' && e.signedIn !== null)) return undefined
    result[engine] = { installed: e.installed, signedIn: e.signedIn as boolean | null }
  }
  return result
}

const ITEMS = new Set<string>(['sentinel', 'home-listing', 'gitconfig', 'ssh', 'projects', 'keychain', 'chrome', 'safari', 'standard-user', 'unchecked'])

function privacyOf(value: unknown): PrivacyResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.checkedAt !== 'number' || !Number.isFinite(v.checkedAt)) return undefined
  if (v.passed === true) return { passed: true, checkedAt: v.checkedAt }
  if (v.passed === false && typeof v.item === 'string' && ITEMS.has(v.item) && typeof v.detail === 'string') {
    return { passed: false, item: v.item as PrivacyItem, detail: v.detail.slice(0, 300), checkedAt: v.checkedAt }
  }
  return undefined
}

export function readTeamStatus(path: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): TeamStatus | null {
  let raw: unknown
  try { raw = JSON.parse(read(path)) } catch { return null }
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return null
  const value = raw as Record<string, unknown>
  const status: TeamStatus = { version: 1 }
  const signIn = value.signIn as Record<string, unknown> | undefined
  if (signIn && typeof signIn === 'object' && ['signed-in', 'failed', 'signed-out'].includes(String(signIn.state)) && typeof signIn.at === 'number') {
    status.signIn = { state: signIn.state as 'signed-in', at: signIn.at, ...(typeof signIn.detail === 'string' ? { detail: signIn.detail.slice(0, 300) } : {}) }
  }
  const privacy = privacyOf(value.privacy)
  if (privacy) status.privacy = privacy
  const engines = enginesOf(value.engines)
  if (engines) status.engines = engines
  return status
}

/** Merge [update] into the status file, through a temporary file and a rename: the owner's reader never sees half. */
export function writeTeamStatus(path: string, update: Partial<Omit<TeamStatus, 'version'>>): void {
  const next: TeamStatus = { ...(readTeamStatus(path) ?? { version: 1 }), ...update, version: 1 }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.next`
  writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o644 })
  renameSync(temp, path)
}

/** How often a team daemon serving a Swarm checks again: a home folder opened again shows within this long. */
export const PRIVACY_RECHECK_MS = 5 * 60_000

/**
 * The privacy field of the machine's Super Tab reading (superTabs/machines.ts), which routing reads (Task 3):
 * - `account`: this daemon runs in the Harness Team account; `passed`, or the first item that failed.
 * - `dedicated`: the whole computer is for agents (`harness team on`), with no owner's files on it to protect.
 * The owner's own daemon reports nothing.
 */
export type PrivacyObservation =
  | { mode: 'account'; passed: true; checkedAt: number }
  | { mode: 'account'; passed: false; item: PrivacyItem | 'unchecked'; detail: string; checkedAt: number }
  | { mode: 'dedicated' }

export interface PrivacyObserverDeps {
  config(): TeamConfig | null
  /** The account this process runs as. */
  user(): string
  /** This computer's stored sign-in is a team session. */
  teamSession(): boolean
  check(config: TeamConfig): PrivacyResult
  writeStatus(path: string, update: Partial<Omit<TeamStatus, 'version'>>): void
  now(): number
}

export class TeamPrivacyObserver {
  private last: PrivacyResult | null = null
  constructor(private readonly deps: PrivacyObserverDeps) {}

  /** This daemon runs in the Harness Team account that setup made. */
  inTeamAccount(): TeamConfig | null {
    const config = this.deps.config()
    return config && config.user === this.deps.user() ? config : null
  }

  observe(): PrivacyObservation | null {
    const config = this.inTeamAccount()
    if (config) {
      const now = this.deps.now()
      if (!this.last || now - this.last.checkedAt >= PRIVACY_RECHECK_MS || now < this.last.checkedAt) {
        try {
          this.last = this.deps.check(config)
        } catch (error) {
          this.last = { passed: false, item: 'unchecked', checkedAt: now, detail: `The privacy check did not run: ${(error as Error).message}` }
        }
        // The owner's status line is a convenience; the reading is what routing trusts.
        try { this.deps.writeStatus(config.statusFile, { privacy: this.last }) } catch { /* reported next time */ }
      }
      return { mode: 'account', ...this.last }
    }
    return this.deps.teamSession() ? { mode: 'dedicated' } : null
  }
}
