/**
 * Where an old Harness Team account's config is, on a Mac, Linux and Windows, and the checks every value in it passes
 * (team/config.ts). Setup, which wrote it root-owned, was removed on 2026-11-10; the config stays on computers set up
 * before, until the person removes the account, and names what is to go. While it is there, the account's own boot job
 * ends at once (./bootGuard.ts).
 */
import { isAbsolute, normalize, win32 } from 'node:path'

/** The Team config on each platform where there was a Harness Team account. */
export const TEAM_CONFIG_FILES: Readonly<Record<'darwin' | 'linux' | 'win32', string>> = {
  darwin: '/Library/Application Support/Harness/team.json',
  linux: '/etc/harness/team.json',
  win32: 'C:\\ProgramData\\Harness\\team.json',
}
export const TEAM_CONFIG_FILE = TEAM_CONFIG_FILES.darwin

const USER = /^[a-z_][a-z0-9_.-]{0,31}$/
const SAFE_PATH = /^\/[A-Za-z0-9._@+ /-]{0,1023}$/
/** SAFE_PATH's characters, after a drive and with Windows' separator. */
const WINDOWS_PATH = /^[A-Za-z]:\\[A-Za-z0-9._@+ \\-]{0,1023}$/
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

/** MAX_PATH less the terminating NUL: the longest path every Windows API takes without the `\\?\` prefix. */
const MAX_PATH = 259

/**
 * A Windows absolute path of plain characters (`X:\…`), for a script run elevated: no UNC share, no `\\?\` or `\\.\`
 * form, no forward slash, no quote, nothing cmd.exe expands or splits on (`%`, `!`, `&`…: the team task's actions run
 * through it), normalized, and no segment that is empty, `.` or `..`. A segment may not end in a dot or a space either:
 * Windows drops them, so the name would mean another one.
 */
export function checkWindowsPath(path: string, what = 'path'): string {
  const segments = path.slice(3).split('\\')
  if (!WINDOWS_PATH.test(path) || path.length > MAX_PATH || win32.normalize(path) !== path
    || (path.length > 3 && segments.some((s) => s === '' || s === '.' || s === '..' || s.endsWith('.') || s.endsWith(' ')))) {
    throw new TeamInputError(`the ${what} must be a plain absolute Windows path: ${JSON.stringify(path)}`)
  }
  return path
}

/** A local Windows account's name as Windows takes it (20 characters at most), in plain characters, never `DOMAIN\`. */
const WINDOWS_USER = /^[A-Za-z0-9_.-](?:[A-Za-z0-9_. -]{0,18}[A-Za-z0-9_-])?$/
export function checkWindowsUser(user: string, what = 'account'): string {
  if (!WINDOWS_USER.test(user)) throw new TeamInputError(`not a usable ${what} name: ${JSON.stringify(user)}`)
  return user
}

/** This platform's checks of a path and of an account name: Windows' on Windows, the POSIX ones elsewhere. */
export const pathCheck = (platform: NodeJS.Platform) => platform === 'win32' ? checkWindowsPath : checkPath
export const userCheck = (platform: NodeJS.Platform) => platform === 'win32' ? checkWindowsUser : checkUser

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

