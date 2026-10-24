/**
 * `harness git-credential`: git's credential helper for a Swarm agent doing another person's project work
 * (docs/swarm-github-app.md). git runs it as the helper for github.com (lib/swarmGitHub.ts):
 *
 * - `get` reads git's request and answers `username=x-access-token` and `password=<token>` with the Harness GitHub App
 *   token of the calling agent's task, only when the request is for https://github.com and the task's own repository.
 *   Anything else gets no answer, and git goes on without one.
 * - `store` and `erase` are read and ignored: the token is the backend's to keep and revoke.
 * - `trailers` prints the attribution trailers for the agent's commits, one per line (the commit hooks' fallback).
 *
 * The calling agent is found as `harness super-tab` finds it: its tmux pane, in the daemon's list of agents. The token is
 * written to git alone, on stdout, and never logged.
 */
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, type Frame } from '../agentClient/model.js'
import { identifier, object } from './wire.js'

const USAGE = 'harness git-credential [--port N --machine ID] get|store|erase|trailers'
const TIMEOUT_MS = 15_000

export interface GitCredentialDeps {
  where?: () => Where
  open?: typeof openDaemon
  pane?: string
  /** All of standard input (git's request). */
  input?: () => Promise<string>
  print?: (text: string) => void
  warn?: (text: string) => void
}

/** git's request: `key=value` lines up to a blank line. A `url` fills in what it names. */
export function parseCredentialRequest(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const clean = line.replace(/\r$/, '')
    if (!clean) break
    const at = clean.indexOf('=')
    if (at > 0) fields[clean.slice(0, at)] = clean.slice(at + 1)
  }
  if (fields.url) {
    try {
      const url = new URL(fields.url)
      fields.protocol ??= url.protocol.replace(/:$/, '')
      fields.host ??= url.host
      if (fields.path === undefined && url.pathname.length > 1) fields.path = decodeURIComponent(url.pathname.slice(1))
    } catch { /* not a URL: the other fields stand */ }
  }
  return fields
}

/** `owner/name` of the repository a github.com request names, or null for any other host or no path. */
export function requestedRepository(fields: Record<string, string>): string | null {
  if (fields.protocol !== 'https' || fields.host?.toLowerCase() !== 'github.com' || !fields.path) return null
  const parts = fields.path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  return parts.length === 2 && parts.every(part => /^[A-Za-z0-9._-]+$/.test(part)) ? parts.join('/').toLowerCase() : null
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The calling agent's token answer from its daemon: `{ ok, value }`, or `{ error, detail }`. */
async function askToken(where: Where, deps: GitCredentialDeps): Promise<Record<string, unknown>> {
  let daemon: Daemon | null = null
  try {
    daemon = await (deps.open ?? openDaemon)(where)
    const listed = await daemon.request('agents_list', {}, TIMEOUT_MS)
    const caller = callerOf(Array.isArray(listed.agents) ? listed.agents as Frame[] : [], deps.pane ?? process.env.TMUX_PANE, where.machineId)
    if (!caller) return { error: 'NOT_A_SWARM_AGENT', detail: 'git asked for a GitHub token outside a Swarm agent\'s harness.' }
    return await daemon.request('super_tabs', { action: 'githubToken', harnessId: caller.agentId }, TIMEOUT_MS)
  } catch (error) {
    return { error: 'DAEMON_UNREACHABLE', detail: error instanceof Error ? error.message : String(error) }
  } finally { daemon?.close() }
}

export async function gitCredentialCommand(argv: readonly string[], deps: GitCredentialDeps = {}): Promise<number> {
  const print = deps.print ?? (text => process.stdout.write(text))
  const warn = deps.warn ?? (text => process.stderr.write(`${text}\n`))
  const where = { ...(deps.where ?? (() => whereFor(process.env.TMUX_PANE)))() }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') where.port = Number(argv[++i])
    else if (argv[i] === '--machine') where.machineId = argv[++i] ?? ''
    else positional.push(argv[i]!)
  }
  const [action] = positional
  if (positional.length !== 1 || !['get', 'store', 'erase', 'trailers'].includes(action!) || !Number.isInteger(where.port)
    || where.port < 1 || where.port > 65535 || !identifier(where.machineId)) {
    warn(USAGE)
    return 2
  }
  if (action === 'trailers') {
    const answer = await askToken(where, deps)
    const trailers = object(answer.value).trailers
    if (answer.ok === true && Array.isArray(trailers)) print(trailers.filter(t => typeof t === 'string').map(t => `${t}\n`).join(''))
    return 0
  }
  const request = parseCredentialRequest(await (deps.input ?? readAll)())
  if (action !== 'get') return 0
  const wanted = requestedRepository(request)
  // Another host, plain http, or no path to check the repository against: not this helper's to answer.
  if (!wanted) return 0
  const answer = await askToken(where, deps)
  const value = object(answer.value)
  if (answer.ok !== true || typeof value.token !== 'string' || typeof value.repository !== 'string') {
    warn(`harness: no GitHub token for ${wanted}: ${String(answer.detail ?? answer.error ?? 'the Harness server did not answer')}`)
    return 0
  }
  if (value.repository.toLowerCase() !== wanted) {
    warn(`harness: this agent's GitHub token is for ${value.repository}, its task's repository, not ${wanted}.`)
    return 0
  }
  // The token can push to any branch nothing protects: said on every use, so the agent tells its Lead, who tells the people.
  if (value.defaultBranchProtected === false) {
    const branch = typeof value.defaultBranch === 'string' ? value.defaultBranch : 'the default branch'
    warn(`harness: ${branch} of ${value.repository} does not require a pull request, so this token could push to it directly. Push to your own branch and open a pull request.`)
  }
  const expiry = Date.parse(String(value.expiresAt))
  print(`username=x-access-token\npassword=${value.token}\n${Number.isFinite(expiry) ? `password_expiry_utc=${Math.floor(expiry / 1000)}\n` : ''}`)
  return 0
}
