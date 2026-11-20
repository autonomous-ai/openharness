/**
 * `harness connections call CODE METHOD URL`: one REST request with a connected account's token, never
 * putting the token in shell arguments or the agent's view. Adapted from Autonomous Intern's connector
 * helper (Apache-2.0; see cli/src/lib/connectors/LICENSE).
 *
 * Exit codes: 0 success (2xx) · 1 HTTP error or network failure · 2 usage error · 3 not connected /
 * unusable credential · 4 host not allowed for this connector. On any failure nothing is written to
 * stdout, so a following `| jq` sees empty input instead of an error body it could mistake for a result.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import platformPath, { type PlatformPath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { harnessRoots, legacyHarnessHome } from '../../config/harnessHome.js'
import { bearer, connectorsDir, ConnectorError, type Store, type Token } from './store.js'
import { ready } from './renew.js'
import { appDataFolders } from '../windows/knownFolders.js'

const TIMEOUT_MS = 60_000
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Services signed in through the gateway hold an ordinary OAuth token for their REST API. A service signed
 * in from this computer (MCP OAuth) holds a token for its MCP server instead: agents use its MCP tools.
 * A credential is only ever sent to one of these hosts (exactly, or a subdomain).
 */
export const OFFICIAL_HOSTS: Record<string, string[]> = {
  gmail: ['googleapis.com'], google_calendar: ['googleapis.com'], google_drive: ['googleapis.com'],
  github: ['api.github.com'], slack: ['slack.com'], asana: ['app.asana.com'], hubspot: ['api.hubapi.com'],
  'figma-api-app': ['api.figma.com'],
}
const UPLOAD_SUFFIXES = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.mp4', '.mov', '.webm', '.mp3', '.m4a', '.wav', '.ogg', '.pdf', '.txt', '.md', '.csv']

export class CallFailure extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

export interface Output { out: (text: string) => void, err: (text: string) => void }

export function hostAllowed(code: string, host: string): boolean {
  return (OFFICIAL_HOSTS[code] ?? []).some(allowed => host === allowed || host.endsWith('.' + allowed))
}

/** `~` before a separator is home; on posix a backslash is part of a name, so only Windows takes `~\`. */
export function expandHome(raw: string, home: string, p: PlatformPath = platformPath): string {
  return raw.replace(p.sep === '\\' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, home)
}

/**
 * A Windows path through a share, as given or resolved: the fence compares local folders, and a share may be any of
 * them, as the local disk's admin share (`\\localhost\C$`) is. Two separators of either kind start a share or a device
 * path, and Windows passes `\??\` on as the NT path it is. Of those only a drive's `\\?\C:\` is local: Windows takes a
 * `..` in `\\.\C:\..\UNC\host\share` back to the `\\.\` prefix, but never normalizes `\\?\`. On posix, realpath reads
 * `//` as `/`.
 */
export function unc(path: string, p: PlatformPath = platformPath): boolean {
  return p.sep === '\\' && /^[\\/]([\\/]|\?\?[\\/])/.test(path) && !/^\\\\\?\\[a-z]:\\/i.test(path)
}

/**
 * Where credentials or configs live, under each home: HOME and USERPROFILE (Windows' HOME) are the caller's to set, so
 * `homes` brings the ones no variable moves. On Windows, apps keep theirs in AppData (browsers' profiles, sign-in caches).
 */
export function forbiddenDirs(env: NodeJS.ProcessEnv, homes: (string | undefined)[], p: PlatformPath = platformPath,
  platform: NodeJS.Platform = process.platform): string[] {
  const windows = p.sep === '\\'
  const all = [env.HOME, env.USERPROFILE, ...homes].filter((home): home is string => !!home)
  const names = ['.ssh', '.gnupg', '.config', '.local/share', '.codex', '.claude', ...(windows ? ['AppData'] : [])]
  // Windows' path module gets Windows' roots on any platform; elsewhere the platform's own rule, so Linux's never runs on macOS.
  // A ~/.harness beside the moved Linux roots too: a stray an old build made after the move holds what it wrote there.
  const os = windows ? 'win32' : platform
  const harness = (home: string): string[] => [...harnessRoots(home, os), legacyHarnessHome(home, os)]
  const appData = windows ? [env.APPDATA, env.LOCALAPPDATA].filter((dir): dir is string => !!dir) : []
  return [...new Set([connectorsDir(env, p, os), ...all.flatMap(home => [...names.map(dir => p.join(home, dir)), ...harness(home)]), ...appData, '/etc', '/proc', '/sys'])]
}

/**
 * The temporary folders left open inside the fenced AppData, where downloads and agents' files land: the account's own on
 * Windows, and `Temp` under each Local AppData the registry names, as AppData moved elsewhere keeps its own. Never TEMP or
 * TMP, nor one under HOME or USERPROFILE: the caller sets those, and so could make the folder a link into AppData. The
 * registry is not the caller's to shape.
 */
export function tempDirs(home: string | undefined, local: string[], p: PlatformPath = platformPath): string[] {
  return [...(home && p.sep === '\\' ? [p.join(home, 'AppData', 'Local', 'Temp')] : []), ...local.map(dir => p.join(dir, 'Temp'))]
}

export interface Identity { dev: bigint, ino: bigint }
export type Verdict = 'open' | 'fenced' | 'unknown'

/** `statSync(path, { bigint: true })`'s dev and ino, following links; undefined when it cannot be read. */
export function identity(path: string): Identity | undefined {
  try {
    const { dev, ino } = statSync(path, { bigint: true })
    return { dev, ino }
  } catch { return undefined }
}

/**
 * Each folder's identity, read by its absolute path; one on a share is dropped unread, one not named or not there
 * skipped. Reading a folder on a share connects to it and may wait on the network. A relative name is read from the
 * working folder, which may be on a share, so its absolute path is the one checked and read; the name as given is
 * checked too, as `resolve()` turns `\??\UNC\…` into a path on the working drive.
 */
export function identities(dirs: (string | undefined)[], identify: (path: string) => Identity | undefined = identity,
  p: PlatformPath = platformPath): Identity[] {
  return dirs.flatMap(dir => {
    if (!dir) return []
    const path = p.resolve(dir)
    const id = unc(dir, p) || unc(path, p) ? undefined : identify(path)
    return id ? [id] : []
  })
}

/**
 * Whether a folder of `forbidden` holds `real`, walked from the file itself up to the root. Folders are told apart by
 * identity, never by path: another case, an 8.3 short name, a `\\?\` prefix, a `subst` drive, a link and a case-folded
 * folder on Linux each spell one folder in a way a compare of paths reads as another. Inside a temporary folder only a
 * forbidden folder inside it fences the file: AppData, which holds Windows' own, does not. So each folder is asked
 * "forbidden?" before "temporary?", and a forbidden folder that is a temporary one still fences. A folder that cannot be
 * read, or has the number 0 some file systems give every file, cannot be told from a forbidden one. The root is the
 * exception: Windows' FAT driver gives a drive's root the number 0 and every other folder its own, so the root is told
 * apart by its device. The file itself comes first, so a file system with no numbers is still refused.
 */
export function walk(real: string, identify: (path: string) => Identity | undefined, forbidden: Identity[], temps: Identity[],
  p: PlatformPath = platformPath): Verdict {
  const among = (ids: Identity[], id: Identity): boolean => ids.some(other => other.dev === id.dev && other.ino === id.ino)
  for (let path = real; ; path = p.dirname(path)) {
    const id = identify(path)
    if (!id || (id.ino === 0n && p.dirname(path) !== path)) return 'unknown'
    if (among(forbidden, id)) return 'fenced'
    if (among(temps, id) || p.dirname(path) === path) return 'open'
  }
}

/** The account's own home; an account with no passwd entry (a container's bare uid) has none, and `userInfo` throws. */
function accountHome(): string | undefined {
  try { return userInfo().homedir } catch { return undefined }
}

/**
 * An `@path` upload: plain media or a document, never from where credentials or configs live. The bytes are read from
 * the descriptor that was checked, so a path swapped for another file between the check and the read sends nothing of
 * that file. A writer that renames the forbidden folders themselves while this runs is not kept out: it could copy the
 * file out of them anyway.
 */
export function uploadFile(raw: string, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = () => undefined): { name: string, content: Buffer } {
  const refused = (): CallFailure => new CallFailure(2, `refusing to upload ${raw}: not a media file the helper may send`)
  const media = (path: string): void => {
    if (!UPLOAD_SUFFIXES.includes(platformPath.extname(path).toLowerCase())) throw new CallFailure(2, `refusing to upload ${raw}: only ${UPLOAD_SUFFIXES.join(', ')} files`)
    // Before Windows 11 a reserved name is the device whatever its extension or folder (COM1.txt is the serial port), and
    // a stat opens it as an open does.
    if (platformPath.sep === '\\' && /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|:|$)/i.test(platformPath.basename(path))) throw refused()
  }
  const read = <T>(step: () => T): T => { try { return step() } catch { throw new CallFailure(2, `cannot read upload ${raw}`) } }
  const given = expandHome(raw, env.HOME || homedir())
  // Windows opens a share to resolve a path through it. A relative path is on a share when the working folder is, so its
  // absolute form is checked too; the text as given as well, as `resolve()` turns `\??\UNC\…` into a path on the working
  // drive. The resolved path is checked again below: a link may lead there. Only this check reads the absolute form: the
  // file is opened by the path as given, where a `..` after a link climbs from the link's target, as the kernel reads it.
  if (unc(given) || unc(platformPath.resolve(given))) throw refused()
  // Nothing is opened that is not named as media or a document.
  media(given)
  // Nor what is not a file, links followed: opening a device acts on it, as a serial port's DTR line toggles and resets
  // the board behind it.
  if (!read(() => statSync(given)).isFile()) throw refused()
  // An open for reading waits for a FIFO's writer, one put here since the stat too; O_NONBLOCK returns at once. Windows
  // has no such flag.
  const fd = read(() => openSync(given, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)))
  try {
    const open = read(() => fstatSync(fd, { bigint: true }))
    if (!open.isFile()) throw refused()
    // Links followed, so the walk climbs the folders that hold the file, not a link's. The file system's own answer
    // (`native`) is where it found the file: on Windows a mapped drive resolves to its share.
    const real = read(() => realpathSync.native(given))
    // Refused before the walk, which reads each folder above the file: nothing on a share is read.
    if (unc(real)) throw refused()
    media(real)
    // The path names another file than the open one: it moved after the open, and the walk would check the wrong one.
    // A hard link's other names, which may be inside a forbidden folder, are found by no path the fence can check. They
    // are counted here, after realpath: one made since the open may be the name realpath took, outside that folder.
    let named: BigIntStats | undefined
    try { named = statSync(real, { bigint: true }) } catch { named = undefined }
    if (!named || named.dev !== open.dev || named.ino !== open.ino || named.nlink > 1n) throw refused()
    const account = accountHome()
    // Asked only now, so a path refused by its own checks starts no process. A failed read refuses nothing: the AppData
    // under each home stays fenced, and the line says a moved one may not be.
    const known = appDataFolders(account, failure => warn(`upload check: ${failure}; a moved AppData folder may not be fenced`))
    const forbidden = identities([...forbiddenDirs(env, [homedir(), account]), ...known.roaming, ...known.local])
    const verdict = walk(real, identity, forbidden, identities(tempDirs(account, known.local)))
    if (verdict === 'unknown') throw new CallFailure(2, `cannot check upload ${raw}`)
    if (verdict === 'fenced') throw refused()
    return { name: platformPath.basename(real), content: read(() => readFileSync(fd)) }
  } finally { closeSync(fd) }
}

interface Options { query: [string, string][], json: string | null, data: [string, string][], form: [string, string][], header: [string, string][] }

function pair(value: string, sep: string, flag: string): [string, string] {
  const at = value.indexOf(sep)
  if (at < 0) throw new CallFailure(2, `${flag} expects K${sep}V, got ${JSON.stringify(value)}`)
  return [value.slice(0, at).trim(), sep === '=' ? value.slice(at + 1) : value.slice(at + 1).trim()]
}

export function parseCallArgs(args: string[], stdin: () => string): Options {
  const options: Options = { query: [], json: null, data: [], form: [], header: [] }
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    if (i + 1 >= args.length) throw new CallFailure(2, `${flag} needs a value`)
    const value = args[i + 1]
    if (flag === '--query') options.query.push(pair(value, '=', flag))
    else if (flag === '--data') options.data.push(pair(value, '=', flag))
    else if (flag === '--form') options.form.push(pair(value, '=', flag))
    else if (flag === '--header') options.header.push(pair(value, ':', flag))
    else if (flag === '--json') options.json = value === '-' ? stdin() : value
    else throw new CallFailure(2, `unknown option ${flag}`)
  }
  if ([options.json !== null, options.data.length > 0, options.form.length > 0].filter(Boolean).length > 1) throw new CallFailure(2, 'use only one of --json, --data, --form')
  return options
}

function multipart(fields: [string, string][], env: NodeJS.ProcessEnv, warn: (line: string) => void): { body: Buffer, type: string } {
  const boundary = randomUUID().replace(/-/g, '')
  const chunks: Buffer[] = []
  for (const [key, value] of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"`
    let content: Buffer
    if (value.startsWith('@')) {
      const file = uploadFile(value.slice(1), env, warn)
      content = file.content
      head += `; filename="${file.name}"\r\nContent-Type: application/octet-stream`
    } else content = Buffer.from(value)
    chunks.push(Buffer.from(head + '\r\n\r\n'), content, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` }
}

function scrub(text: string, secret?: string): string {
  if (!secret) return text
  for (const form of new Set([secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/g, '+')])) text = text.split(form).join('[credential]')
  return text
}

const scrubToken = (text: string, token: Token): string => scrub(scrub(text, token.access_token), token.refresh_token)

export async function call(vault: Store, code: string, method: string, url: string, args: string[], io: Output,
  env: NodeJS.ProcessEnv = process.env, stdin = () => readFileSync(0, 'utf8')): Promise<number> {
  const options = parseCallArgs(args, stdin)
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new CallFailure(4, `refusing ${JSON.stringify(url)}: only https:// URLs are allowed`) }
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw new CallFailure(4, `refusing ${JSON.stringify(url)}: only https:// URLs are allowed`)
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new CallFailure(4, `refusing ${JSON.stringify(url)}: no user info or custom port in the URL`)
  if (!OFFICIAL_HOSTS[code]) throw new CallFailure(4, `${code}: the helper has no official API host for this connector — use its MCP tools if it has them`)
  if (!hostAllowed(code, parsed.hostname)) throw new CallFailure(4, `refusing to send the ${code} credential to ${parsed.hostname}; allowed: ${OFFICIAL_HOSTS[code].join(', ')}`)
  let token: Token
  try { token = await ready(vault, code) } catch (error) { throw new CallFailure(3, (error as Error).message) }
  if (token.source && token.source !== 'gateway') throw new CallFailure(3, `${code}: this account's token is for its MCP server; use the agent's ${code} tools`)
  for (const [key, value] of options.query) parsed.searchParams.append(key, value)
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Harness-Connections' }
  for (const [key, value] of options.header) {
    if (['authorization', 'host', 'proxy-authorization', 'cookie'].includes(key.toLowerCase())) throw new CallFailure(2, `do not pass ${key}; the helper sets it (or it is not allowed)`)
    headers[key] = value
  }
  headers.Authorization = bearer(token)
  let body: Buffer | string | undefined
  if (options.json !== null) { body = options.json; headers['Content-Type'] ??= 'application/json' }
  else if (options.data.length) { body = new URLSearchParams(options.data).toString(); headers['Content-Type'] ??= 'application/x-www-form-urlencoded' }
  else if (options.form.length) { const form = multipart(options.form, env, io.err); body = form.body; headers['Content-Type'] = form.type }
  let response: Response
  try {
    response = await fetch(parsed, { method: method.toUpperCase(), headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    io.err(`request to ${parsed.hostname} failed: ${(error as Error).name}`)
    return 1
  }
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length > MAX_RESPONSE_BYTES) { io.err('Response is too large. Use a smaller page size.'); return 1 }
  const text = raw.toString('utf8')
  if (response.status < 200 || response.status >= 300) {
    io.err(`HTTP ${response.status} from ${parsed.hostname}`)
    if (response.status >= 300 && response.status < 400) io.err('redirect not followed: the credential is only sent to the official host')
    else if (text.trim()) io.err(scrubToken(text, token))
    if (response.status === 401) io.err('credential refused; reconnect in harness connections')
    return 1
  }
  if (text) io.out(scrubToken(text, token) + (text.endsWith('\n') ? '' : '\n'))
  else if (response.status === 204) io.out('{}\n')
  return 0
}

export { ConnectorError }
