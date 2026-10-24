/**
 * Where the Harness Team account lives on a Mac, and the checks every value passes before it goes into the
 * privileged script (docs/plans/2026-10-24-swarm-team-account.md, Task 2).
 *
 * The team account is a separate, standard macOS user that runs a second Harness daemon for Swarm work, so a
 * teammate's agent on this Mac cannot read the owner's files. It is visible in System Settings > Users & Groups
 * and named "Harness Team" on purpose: a hidden user with a LaunchDaemon is the persistence pattern endpoint
 * security tools and careful engineers treat as malware, and anyone auditing the Mac should find it at a glance.
 */
import { isAbsolute, normalize } from 'node:path'

export const TEAM_USER = 'harnessteam'
export const TEAM_REAL_NAME = 'Harness Team'
export const TEAM_HOME = `/Users/${TEAM_USER}`
/** The team daemon's control port. Not 18473 (the owner's daemon) or 18474 (a dev daemon beside it): the team
 *  daemon runs as its own OS user and would find another port anyway, but a fixed one is easier to audit. */
export const TEAM_PORT = 18493
export const TEAM_LABEL = 'ai.autonomous.harness.team'
export const TEAM_PLIST = `/Library/LaunchDaemons/${TEAM_LABEL}.plist`
/** Root-owned: what setup made, read by the team daemon. Root's so a process in the team account cannot point its
 *  own privacy check somewhere else. */
export const TEAM_SHARED_DIR = '/Library/Application Support/Harness'
export const TEAM_CONFIG_FILE = `${TEAM_SHARED_DIR}/team.json`
/** The team account's: where its daemon reports sign-in and the privacy check, for the owner's `harness team status`. */
export const TEAM_STATUS_DIR = `${TEAM_SHARED_DIR}/Team`
export const TEAM_STATUS_FILE = `${TEAM_STATUS_DIR}/status.json`
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
    bin: `${home}/.local/bin`,
    /** The single-use sign-in code setup hands over; the team daemon redeems it on its next start and deletes it. */
    handoff: `${harness}/team-handoff`,
  }
}

const USER = /^[a-z_][a-z0-9_.-]{0,31}$/
const SAFE_PATH = /^\/[A-Za-z0-9._@+ /-]{0,1023}$/
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
  const updates = source.ADAPTER_UPDATE_DISABLE?.trim()
  if (updates === 'true' || updates === '1') carried.ADAPTER_UPDATE_DISABLE = 'true'
  return carried
}

/** A handoff code as the shell checks it too: plain token characters only. */
export const HANDOFF_CODE = /^[A-Za-z0-9_-]{16,256}$/
