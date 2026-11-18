/**
 * `harness connections call CODE METHOD URL`: one REST request with a connected account's token, never
 * putting the token in shell arguments or the agent's view. Adapted from Autonomous Intern's connector
 * helper (Apache-2.0; see cli/src/lib/connectors/LICENSE).
 *
 * Exit codes: 0 success (2xx) · 1 HTTP error or network failure · 2 usage error · 3 not connected /
 * unusable credential · 4 host not allowed for this connector. On any failure nothing is written to
 * stdout, so a following `| jq` sees empty input instead of an error body it could mistake for a result.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import platformPath, { basename, extname, resolve, type PlatformPath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bearer, connectorsDir, ConnectorError, type Store, type Token } from './store.js'
import { ready } from './renew.js'

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

/**
 * Whether `file` is `dir` or inside it, by path segments: a prefix check on `dir + '/'` misses Windows' backslashes
 * and its case-insensitive names. `relative` is absolute when the two are on different drives.
 */
export function inside(dir: string, file: string, p: PlatformPath = platformPath): boolean {
  const rel = p.relative(dir, file)
  return rel === '' || !(rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel))
}

/** `~` before a separator is home; on posix a backslash is part of a name, so only Windows takes `~\`. */
export function expandHome(raw: string, home: string, p: PlatformPath = platformPath): string {
  return raw.replace(p.sep === '\\' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, home)
}

/**
 * A resolved Windows path through a share (`\\?\UNC\` resolves to `\\`): the fence compares local folders, and a share
 * may be any of them, as the local disk's admin share (`\\localhost\C$`) is. On posix, realpath reads `//` as `/`.
 */
export function unc(path: string, p: PlatformPath = platformPath): boolean {
  return p.sep === '\\' && path.startsWith('\\\\')
}

/**
 * Where credentials or configs live, under each home: HOME and USERPROFILE (Windows' HOME) are the caller's to set, so
 * `homes` brings the ones no variable moves. On Windows, apps keep theirs in AppData (browsers' profiles, sign-in caches).
 */
export function forbiddenDirs(env: NodeJS.ProcessEnv, homes: (string | undefined)[], p: PlatformPath = platformPath): string[] {
  const windows = p.sep === '\\'
  const all = [env.HOME, env.USERPROFILE, ...homes].filter((home): home is string => !!home)
  const names = ['.ssh', '.gnupg', '.config', '.local/share', '.harness', '.codex', '.claude', ...(windows ? ['AppData/Roaming', 'AppData/Local'] : [])]
  const appData = windows ? [env.APPDATA, env.LOCALAPPDATA].filter((dir): dir is string => !!dir) : []
  return [...new Set([connectorsDir(env), ...all.flatMap(home => names.map(dir => p.join(home, dir))), ...appData, '/etc', '/proc', '/sys'])]
}

/**
 * The account's own temporary folder on Windows, inside AppData\Local, where downloads and agents' files land. Never
 * TEMP or TMP, nor one under HOME or USERPROFILE: the caller sets those, and so could make the folder a link into AppData.
 */
export function tempDir(home: string | undefined, p: PlatformPath = platformPath): string | undefined {
  return home && p.sep === '\\' ? p.join(home, 'AppData', 'Local', 'Temp') : undefined
}

/**
 * Whether a folder of `forbidden` holds `file`, all three resolved. Inside the temporary folder only a forbidden folder
 * inside it fences the file: AppData\Local, which holds it, does not.
 */
export function fenced(file: string, forbidden: string[], temp: string | undefined, p: PlatformPath = platformPath): boolean {
  const inTemp = !!temp && inside(temp, file, p)
  return forbidden.some(dir => inside(dir, file, p) && (!inTemp || inside(temp, dir, p)))
}

/** The account's own home; an account with no passwd entry (a container's bare uid) has none, and `userInfo` throws. */
function accountHome(): string | undefined {
  try { return userInfo().homedir } catch { return undefined }
}

/** An `@path` upload: plain media or a document, never from where credentials or configs live. */
export function uploadPath(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = expandHome(raw, env.HOME || homedir())
  // The file system's own spelling (`native`): the JS realpath only follows links and keeps the spelling given, so
  // ~/.SSH on macOS, and SSH~1 (an 8.3 short name) or a \\?\ prefix on Windows, read ~/.ssh outside the fence.
  let real: string
  try { real = realpathSync.native(path) } catch { throw new CallFailure(2, `cannot read upload ${raw}`) }
  const native = (dir: string): string => { try { return realpathSync.native(dir) } catch { return resolve(dir) } }
  const account = accountHome()
  const forbidden = forbiddenDirs(env, [homedir(), account]).map(native)
  // Resolved as the file is, so both are in the file system's own spelling: TEMP on Windows CI is C:\Users\RUNNER~1\...
  const temp = tempDir(account)
  const stat = statSync(real)
  // A hard link's other names, which may be inside a forbidden folder, are found by no path the fence can check.
  if (unc(real) || fenced(real, forbidden, temp && native(temp)) || !stat.isFile() || stat.nlink > 1) {
    throw new CallFailure(2, `refusing to upload ${raw}: not a media file the helper may send`)
  }
  if (!UPLOAD_SUFFIXES.includes(extname(real).toLowerCase()) || !UPLOAD_SUFFIXES.includes(extname(path).toLowerCase())) {
    throw new CallFailure(2, `refusing to upload ${raw}: only ${UPLOAD_SUFFIXES.join(', ')} files`)
  }
  return real
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

function multipart(fields: [string, string][], env: NodeJS.ProcessEnv): { body: Buffer, type: string } {
  const boundary = randomUUID().replace(/-/g, '')
  const chunks: Buffer[] = []
  for (const [key, value] of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"`
    let content: Buffer
    if (value.startsWith('@')) {
      const path = uploadPath(value.slice(1), env)
      content = readFileSync(path)
      head += `; filename="${basename(path)}"\r\nContent-Type: application/octet-stream`
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
  else if (options.form.length) { const form = multipart(options.form, env); body = form.body; headers['Content-Type'] = form.type }
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
