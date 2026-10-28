/**
 * Where the Harness Team account lives on a Mac and on Linux (`teamLayout`), and the checks every value passes before
 * it goes into the privileged script (docs/plans/2026-10-24-swarm-team-account.md, Task 2;
 * docs/superpowers/plans/2026-10-28-harness-team-account-linux.md).
 *
 * The team account is a separate, standard macOS user that runs a second Harness daemon for Swarm work, so a
 * teammate's agent on this Mac cannot read the owner's files. It is listed in System Settings > Users & Groups
 * and named "Harness Team" on purpose: a hidden user with a LaunchDaemon is the persistence pattern endpoint
 * security tools and careful engineers treat as malware, and anyone auditing the Mac should find it at a glance.
 * macOS lists an account only when it has a password, so it gets a random one that nobody knows (./script.ts).
 */
import { isAbsolute, normalize } from 'node:path'

export const TEAM_USER = 'harnessteam'
export const TEAM_REAL_NAME = 'Harness Team'
/** The team daemon's control port. Not 18473 (the owner's daemon) or 18474 (a dev daemon beside it): the team
 *  daemon runs as its own OS user and would find another port anyway, but a fixed one is easier to audit. */
export const TEAM_PORT = 18493

export type TeamPlatform = 'darwin' | 'linux' | 'win32'

/** Where the team account and what setup makes live on one platform. Every caller reads its paths from here. */
export interface TeamLayout {
  platform: TeamPlatform
  home: string
  /** Root-owned: what setup made, read by the team daemon. Root's so a process in the team account cannot point its
   *  own privacy check somewhere else. */
  sharedDir: string
  /** Left in that folder by a setup that made it, so removal takes the folder away once it is empty, and never one
   *  made by anything else. */
  sharedMark: string
  configFile: string
  /** The team account's: where its daemon reports sign-in and the privacy check, for the owner's `harness team status`. */
  statusDir: string
  statusFile: string
  /** What runs the team daemon as the team account from boot, and the root-owned file that defines it. */
  service: { kind: 'launchd' | 'systemd' | 'taskscheduler'; label: string; file: string }
  /** The owner's folder for the subscription relay's hand-off (./relay.ts), per owner. */
  relayDir(owner: string): string
  /** The team account's primary group. */
  group: string
}

const MAC_SHARED = '/Library/Application Support/Harness'
const MAC_LABEL = 'ai.autonomous.harness.team'

const LAYOUTS: Record<TeamPlatform, TeamLayout> = {
  darwin: {
    platform: 'darwin',
    home: `/Users/${TEAM_USER}`,
    sharedDir: MAC_SHARED,
    sharedMark: `${MAC_SHARED}/.made-by-harness-team-setup`,
    configFile: `${MAC_SHARED}/team.json`,
    statusDir: `${MAC_SHARED}/Team`,
    statusFile: `${MAC_SHARED}/Team/status.json`,
    service: { kind: 'launchd', label: MAC_LABEL, file: `/Library/LaunchDaemons/${MAC_LABEL}.plist` },
    // /Users/Shared lets anyone make a folder; a macOS ACL lets the team account read this one.
    relayDir: (owner) => `/Users/Shared/.harness-team-relay-${owner}`,
    // Every local account on a Mac is in staff.
    group: 'staff',
  },
  // The Linux account follows the guest helper's tools (useradd, setfacl) and the daemon's own supervisor (systemd).
  linux: {
    platform: 'linux',
    home: `/home/${TEAM_USER}`,
    sharedDir: '/etc/harness',
    sharedMark: '/etc/harness/.made-by-harness-team-setup',
    configFile: '/etc/harness/team.json',
    statusDir: '/var/lib/harness/team',
    statusFile: '/var/lib/harness/team/status.json',
    service: { kind: 'systemd', label: 'harness-team.service', file: '/etc/systemd/system/harness-team.service' },
    // Made by setup for the owner (nobody else can make a folder under /var/lib/harness); an ACL lets the team account read it.
    relayDir: (owner) => `/var/lib/harness/team-relay-${owner}`,
    // Its own group, as useradd makes one: no other account shares it.
    group: TEAM_USER,
  },
  // docs/superpowers/plans/2026-10-28-harness-team-account-windows.md. Paths there pass checkWindowsPath, not checkPath.
  win32: {
    platform: 'win32',
    // The profile Windows makes for the account.
    home: `C:\\Users\\${TEAM_USER}`,
    sharedDir: 'C:\\ProgramData\\Harness',
    sharedMark: 'C:\\ProgramData\\Harness\\.made-by-harness-team-setup',
    configFile: 'C:\\ProgramData\\Harness\\team.json',
    statusDir: 'C:\\ProgramData\\Harness\\Team',
    statusFile: 'C:\\ProgramData\\Harness\\Team\\status.json',
    // A scheduled task at startup, as the team account: Task Scheduler keeps its definition in System32\Tasks.
    service: { kind: 'taskscheduler', label: '\\Harness\\Harness Team', file: 'C:\\Windows\\System32\\Tasks\\Harness\\Harness Team' },
    relayDir: (owner) => `C:\\ProgramData\\Harness\\team-relay-${owner}`,
    // A member of Users only, never Administrators.
    group: 'Users',
  },
}

/** This platform's layout, or null where there is no Harness Team account. */
export function teamLayout(platform: NodeJS.Platform): TeamLayout | null {
  return Object.hasOwn(LAYOUTS, platform) ? LAYOUTS[platform as TeamPlatform] : null
}

// The macOS values under the names every Mac caller has used since the account was made.
const MAC = LAYOUTS.darwin
export const TEAM_HOME = MAC.home
export const TEAM_LABEL = MAC.service.label
export const TEAM_PLIST = MAC.service.file
export const TEAM_SHARED_DIR = MAC.sharedDir
export const TEAM_SHARED_MARK = MAC.sharedMark
export const TEAM_CONFIG_FILE = MAC.configFile
export const TEAM_STATUS_DIR = MAC.statusDir
export const TEAM_STATUS_FILE = MAC.statusFile
/** A file in the owner's home, readable by everyone, so only the home folder's own mode keeps it from the team
 *  account. Directly in the home: ~/Library is 700 on its own, so a sentinel there would pass even with the home
 *  folder open. */
export const SENTINEL_NAME = '.harness-team-privacy'

/** The team account's own files, all inside its home. */
export function teamPaths(home: string = TEAM_HOME) {
  const harness = `${home}/.harness`
  const cli = `${harness}/cli`
  const data = `${cli}/data`
  return {
    home,
    harness,
    cli,
    cliJs: `${cli}/cli.js`,
    data,
    log: `${data}/harness.log`,
    runtime: `${harness}/runtime`,
    auth: `${harness}/auth`,
    session: `${harness}/auth/session.json`,
    /** Its daemon's computer id, at the product root as every daemon keeps it (config/env.ts). */
    computerId: `${harness}/computer-id`,
    bin: `${home}/.local/bin`,
    /** The single-use sign-in code setup hands over; the team daemon redeems it on its next start and deletes it. */
    handoff: `${harness}/team-handoff`,
  }
}

const USER = /^[a-z_][a-z0-9_.-]{0,31}$/
const SAFE_PATH = /^\/[A-Za-z0-9._@+ /-]{0,1023}$/
/** SAFE_PATH's characters, after a drive and with Windows' separator. */
const WINDOWS_PATH = /^[A-Za-z]:\\[A-Za-z0-9._@+ \\-]{0,1023}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WS_URL = /^wss?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,200})?$/
const HTTP_URL = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,200})?$/

export class TeamInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamInputError'
  }
}

/** A macOS short name: letters, digits and `_.-`, as `dscl` takes them. Never root. */
export function checkUser(user: string, what = 'account'): string {
  if (!USER.test(user) || user === 'root') throw new TeamInputError(`not a usable ${what} name: ${JSON.stringify(user)}`)
  return user
}

/** An absolute path of plain characters, normalized, with no `..`: it goes into a script run as root. */
export function checkPath(path: string, what = 'path'): string {
  if (!isAbsolute(path) || !SAFE_PATH.test(path) || normalize(path) !== path || path.split('/').includes('..')
    || (path.length > 1 && path.endsWith('/'))) {
    throw new TeamInputError(`the ${what} must be a plain absolute path: ${JSON.stringify(path)}`)
  }
  return path
}

/**
 * A Windows absolute path of plain characters (`X:\…`), for a script run elevated: no UNC share, no `\\?\` or `\\.\`
 * form, no forward slash, no quote, and no segment that is empty, `.` or `..`. A segment may not end in a dot or a space
 * either: Windows drops them, so the name would mean another one.
 */
export function checkWindowsPath(path: string, what = 'path'): string {
  const segments = path.slice(3).split('\\')
  if (!WINDOWS_PATH.test(path) || (path.length > 3 && segments.some((s) => s === '' || s.endsWith('.') || s.endsWith(' ')))) {
    throw new TeamInputError(`the ${what} must be a plain absolute Windows path: ${JSON.stringify(path)}`)
  }
  return path
}

/** One path segment (a runtime folder's name). */
export function checkName(name: string, what = 'name'): string {
  if (!NAME.test(name) || name === '.' || name === '..') throw new TeamInputError(`not a usable ${what}: ${JSON.stringify(name)}`)
  return name
}

/** A port the team daemon can bind that is neither the owner's daemon's nor a dev daemon's. */
export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 18473 || port === 18474) {
    throw new TeamInputError(`not a usable port for the team daemon: ${port}`)
  }
  return port
}

/**
 * The settings that choose which backend the team daemon signs in to, carried from the owner's environment when
 * set (a staging backend in the fresh-Mac VM rig), each checked. Anything else stays the team account's default.
 */
export function carriedBackendEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const carried: Record<string, string> = {}
  const ws = source.BACKEND_WS_URL?.trim()
  if (ws) {
    if (!WS_URL.test(ws)) throw new TeamInputError(`BACKEND_WS_URL is not a plain ws:// or wss:// address: ${JSON.stringify(ws)}`)
    carried.BACKEND_WS_URL = ws
  }
  const web = source.WEB_URL?.trim()
  if (web) {
    if (!HTTP_URL.test(web)) throw new TeamInputError(`WEB_URL is not a plain http:// or https:// address: ${JSON.stringify(web)}`)
    carried.WEB_URL = web
  }
  const autonomous = source.AUTONOMOUS_ENV?.trim()
  if (autonomous) {
    if (autonomous !== 'prod' && autonomous !== 'stag') throw new TeamInputError(`AUTONOMOUS_ENV must be prod or stag: ${JSON.stringify(autonomous)}`)
    carried.AUTONOMOUS_ENV = autonomous
  }
  // Never ADAPTER_UPDATE_DISABLE: an owner on a local build (`install-cli.sh --no-updates`) carried it into the team
  // account, whose daemon then never updated, and with nobody to update it by hand it stayed without what came after
  // (2026-10-27: no tmux of its own, so no teammate's agent could start there). The team account always takes releases.
  return carried
}

/** A handoff code as the shell checks it too: plain token characters only. */
export const HANDOFF_CODE = /^[A-Za-z0-9_-]{16,256}$/
