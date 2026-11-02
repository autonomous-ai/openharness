/**
 * The Harness Team account's privacy check (docs/plans/2026-10-24-swarm-team-account.md, Task 2), run by the team
 * daemon itself, as the team account: as its job starts (`harness team __start`) and while it serves a Swarm
 * (superTabs/machines.ts, at most every PRIVACY_RECHECK_MS).
 *
 * A second account alone is not private. On macOS every local account is in the group staff, a home folder is
 * `drwxr-x---` with that group by default, and `~/code` (755) or `~/.gitconfig` (644) inside it are readable by any
 * other account on the Mac. On Linux, Debian and Ubuntu before 21.04 make a home folder 755, readable by every account.
 * Setup makes the owner's home 700; this proves it, from the side that matters, every
 * time. Each probe must be refused with EACCES or EPERM. Reading it, or any other answer (a missing file means the
 * folder above it was searchable), fails the check, and the first failing item is what the machine reports.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TeamConfig } from './config.js'
import type { TeamEngines } from './engines.js'
import { WHOAMI_GROUPS_ARGS, runWindowsPrivacyCheck, windowsGroupSids } from './windowsTeam.js'

export type PrivacyItem =
  | 'sentinel' | 'home-listing' | 'gitconfig' | 'ssh' | 'projects' | 'keychain' | 'chrome' | 'safari' | 'firefox' | 'credentials' | 'edge'
  | 'standard-user'

export type PrivacyResult =
  | { passed: true; checkedAt: number }
  | { passed: false; item: PrivacyItem | 'unchecked'; detail: string; checkedAt: number }

interface Probe { item: PrivacyItem; what: string; kind: 'read' | 'list'; paths: string[] }

/** The folders people keep projects in: listing any of them must be refused. */
const PROJECT_FOLDERS = ['code', 'Code', 'Developer', 'Projects', 'projects', 'src', 'Documents']

/** What the check tries, in order. `what` is shown to people and sent with the machine's reading, so it names a
 *  place by `~`, never by the owner's absolute path (which carries their account name). The last three are where each
 *  system keeps the owner's secrets: the login keyring, and the browsers' profiles. */
export function privacyProbes(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>, platform: NodeJS.Platform = 'darwin'): Probe[] {
  const home = config.ownerHome
  const secrets: Probe[] = platform === 'linux'
    ? [
      // GNOME Keyring's and KWallet's files.
      { item: 'keychain', what: 'your login keyring folder', kind: 'list', paths: [`${home}/.local/share/keyrings`, `${home}/.local/share/kwalletd`] },
      { item: 'chrome', what: 'Chrome\'s profile folder', kind: 'list', paths: [`${home}/.config/google-chrome`] },
      { item: 'firefox', what: 'Firefox\'s profile folder', kind: 'list', paths: [`${home}/.mozilla`] },
    ]
    : [
      { item: 'keychain', what: 'your login Keychain folder', kind: 'list', paths: [`${home}/Library/Keychains`] },
      { item: 'chrome', what: 'Chrome\'s profile folder', kind: 'list', paths: [`${home}/Library/Application Support/Google/Chrome`] },
      { item: 'safari', what: 'Safari\'s folder', kind: 'list', paths: [`${home}/Library/Safari`] },
    ]
  return [
    { item: 'sentinel', what: 'the privacy sentinel in your home folder', kind: 'read', paths: [config.sentinel] },
    { item: 'home-listing', what: 'the list of files in your home folder', kind: 'list', paths: [home] },
    { item: 'gitconfig', what: '~/.gitconfig', kind: 'read', paths: [`${home}/.gitconfig`] },
    { item: 'ssh', what: '~/.ssh', kind: 'list', paths: [`${home}/.ssh`] },
    { item: 'projects', what: 'your project folders (~/code and the like)', kind: 'list', paths: PROJECT_FOLDERS.map((name) => `${home}/${name}`) },
    ...secrets,
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
  /** Which system's places to try: a Mac's unless told (the real deps say this one's). */
  platform?: NodeJS.Platform
  /** Linux: the ids of the groups whose members may become root (sudo, wheel, admin), which differ by distribution. */
  adminGids?(): number[]
  /** Windows: every group SID of this process's token, a deny-only Administrators included (./windowsTeam.ts). */
  groupSids?(): string[]
}

/** The administrator groups Linux distributions use: sudo (Debian, Ubuntu), wheel (Fedora, Arch), admin (older Ubuntu). */
const LINUX_ADMIN_GROUPS = ['sudo', 'wheel', 'admin']

/** The group ids in `getent group …`'s answer (`name:x:gid:members` a line); a line that is not one is skipped. */
export function adminGroupIds(stdout: string): number[] {
  return stdout.split('\n').map((line) => line.split(':')).filter((fields) => fields.length >= 3 && fields[2] !== '')
    .map((fields) => Number(fields[2])).filter((gid) => Number.isInteger(gid) && gid >= 0)
}

export const realPrivacyDeps: PrivacyDeps = {
  open: (path) => closeSync(openSync(path, 'r')),
  list: (path) => { readdirSync(path) },
  groups: () => process.getgroups?.() ?? [],
  now: () => Date.now(),
  platform: process.platform,
  // Through NSS, as the system itself looks groups up. getent exits 2 when one of them is missing, and prints the others.
  adminGids: () => adminGroupIds(spawnSync('getent', ['group', ...LINUX_ADMIN_GROUPS], { encoding: 'utf8', timeout: 5_000 }).stdout ?? ''),
  groupSids: () => windowsGroupSids(spawnSync('whoami', WHOAMI_GROUPS_ARGS, { encoding: 'utf8', timeout: 5_000, windowsHide: true }).stdout ?? ''),
}

/** The group macOS administrators are in. */
const ADMIN_GID = 80

const refused = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

export function runPrivacyCheck(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>, deps: PrivacyDeps = realPrivacyDeps): PrivacyResult {
  const platform = deps.platform ?? 'darwin'
  // Windows' places and rules (./windowsTeam.ts): every account may open a path it cannot list, so a missing place is
  // skipped there, and administrators are told by SID.
  if (platform === 'win32') return runWindowsPrivacyCheck(config, { open: deps.open, list: deps.list, groupSids: deps.groupSids ?? (() => []), now: deps.now })
  const checkedAt = deps.now()
  for (const probe of privacyProbes(config, platform)) {
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
  const admins = platform === 'linux' ? deps.adminGids?.() ?? [] : [ADMIN_GID]
  if (deps.groups().some((gid) => admins.includes(gid))) {
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
    result[engine] = { installed: e.installed, signedIn: e.signedIn as boolean | null, ...(e.relayed === true ? { relayed: true } : {}) }
  }
  return result
}

/** A status is well under 1 KiB: its one free text is capped at 300 characters. */
const STATUS_MAX_BYTES = 64 * 1024
/** Plenty for a small file and a Node start on a busy machine; a read still waiting then is being held (audit W4). */
const STATUS_READ_DEADLINE_MS = 5_000

/**
 * On Windows an open waits for an oplock the file's owner holds, for as long as it holds it, and the Team account owns this file
 * (audit W4): it would stop whoever opens it. So the open happens in a child, which can be killed: unlike a worker stuck in a
 * synchronous call, or a thread-pool thread every file operation shares. It keeps the same limits as the read below.
 */
const STATUS_CHILD_SOURCE = `const fs = require('fs'), max = ${STATUS_MAX_BYTES}
const fd = fs.openSync(process.argv[1], 'r'), stat = fs.fstatSync(fd)
if (!stat.isFile() || stat.size > max) process.exit(3)
const buffer = Buffer.alloc(max + 1)
let length = 0
for (let got = 1; got > 0 && length < buffer.length; length += got) got = fs.readSync(fd, buffer, length, buffer.length - length, null)
if (length > max) process.exit(3)
process.stdout.write(buffer.subarray(0, length))`
const statusChildArgs = (path: string): string[] => ['-e', STATUS_CHILD_SOURCE, '--', path]
/** No window, and none of this process's settings, NODE_OPTIONS among them. */
const statusChildOptions = () => ({ windowsHide: true, env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} })

/** For `harness team status` and setup, which wait for their answer. The daemon uses readTeamStatusOffThread. */
function readStatusInChild(path: string, deadlineMs: number): string {
  const result = spawnSync(process.execPath, statusChildArgs(path), { ...statusChildOptions(), timeout: deadlineMs, maxBuffer: STATUS_MAX_BYTES + 1,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) throw new Error('not a status file')
  return result.stdout
}

let statusChildRunning = false
export function resetStatusChild(): void { statusChildRunning = false }

export interface StatusReadOptions { platform?: NodeJS.Platform; deadlineMs?: number; spawn?: typeof spawn; log?: (line: string) => void }

/**
 * The status as the owner's daemon reads it about once a minute, never waiting on the file (audit W4). One child at a time: while a
 * killed one has not gone, a read answers no status, as an unreadable file does, rather than start another for the same stall.
 */
export async function readTeamStatusOffThread(path: string, options: StatusReadOptions = {}): Promise<TeamStatus | null> {
  if ((options.platform ?? process.platform) !== 'win32') return readTeamStatus(path)
  if (statusChildRunning) return null
  statusChildRunning = true
  const log = options.log ?? ((line: string) => console.log(`[team] ${line}`))
  const text = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let child: ChildProcess
    try {
      child = (options.spawn ?? spawn)(process.execPath, statusChildArgs(path), { ...statusChildOptions(), stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { statusChildRunning = false; resolve(null); return }
    const timer = setTimeout(() => {
      log(`the status file ${path} did not answer in ${options.deadlineMs ?? STATUS_READ_DEADLINE_MS} ms; reading on without it`)
      child.kill()
      resolve(null)
    }, options.deadlineMs ?? STATUS_READ_DEADLINE_MS)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > STATUS_MAX_BYTES) { child.kill(); resolve(null) } else chunks.push(chunk)
    })
    const done = (code: number | null) => { statusChildRunning = false; clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null) }
    child.once('error', () => done(null))
    child.once('close', done)
    child.unref?.()
  })
  return text === null ? null : readTeamStatus(path, () => text)
}

/**
 * The status file, which the Team account may replace with anything, and which the owner's daemon reads about once a minute
 * (superTabs/service.ts). A FIFO there blocked a plain read for good and stopped the owner's Swarm service at every restart; a
 * link to /dev/zero would run until memory is gone (audit M5). So: never through a link, never waiting on a FIFO, a plain file
 * only, and never more than the limit, whatever fstat said a moment ago. As ./handoff.ts reads its code. Throws otherwise.
 */
export function readStatusFile(path: string, platform: NodeJS.Platform = process.platform, deadlineMs: number = STATUS_READ_DEADLINE_MS): string {
  if (platform === 'win32') return readStatusInChild(path, deadlineMs)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > STATUS_MAX_BYTES) throw new Error('not a status file')
    const buffer = Buffer.alloc(STATUS_MAX_BYTES + 1)
    let length = 0
    for (let got = 1; got > 0 && length < buffer.length; length += got) got = readSync(fd, buffer, length, buffer.length - length, null)
    if (length > STATUS_MAX_BYTES) throw new Error('not a status file')
    return buffer.toString('utf8', 0, length)
  } finally { closeSync(fd) }
}

/** Free text from the status file, fit for the owner's terminal: the Team account wrote it, and `harness team status` prints it
 *  (audit L1). Without control characters, which carry escape codes, and format characters, which reorder or hide text. Cut
 *  after that, so padding cannot push the words out. */
const statusText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').slice(0, 300)

const ITEMS = new Set<string>(['sentinel', 'home-listing', 'gitconfig', 'ssh', 'projects', 'keychain', 'chrome', 'safari', 'firefox', 'credentials', 'edge',
  'standard-user', 'unchecked'])

function privacyOf(value: unknown): PrivacyResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.checkedAt !== 'number' || !Number.isFinite(v.checkedAt)) return undefined
  if (v.passed === true) return { passed: true, checkedAt: v.checkedAt }
  if (v.passed === false && typeof v.item === 'string' && ITEMS.has(v.item) && typeof v.detail === 'string') {
    return { passed: false, item: v.item as PrivacyItem, detail: statusText(v.detail), checkedAt: v.checkedAt }
  }
  return undefined
}

export function readTeamStatus(path: string, read: (path: string) => string = (at) => readStatusFile(at)): TeamStatus | null {
  let raw: unknown
  try { raw = JSON.parse(read(path)) } catch { return null }
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return null
  const value = raw as Record<string, unknown>
  const status: TeamStatus = { version: 1 }
  const signIn = value.signIn as Record<string, unknown> | undefined
  if (signIn && typeof signIn === 'object' && ['signed-in', 'failed', 'signed-out'].includes(String(signIn.state)) && typeof signIn.at === 'number') {
    status.signIn = { state: signIn.state as 'signed-in', at: signIn.at, ...(typeof signIn.detail === 'string' ? { detail: statusText(signIn.detail) } : {}) }
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
