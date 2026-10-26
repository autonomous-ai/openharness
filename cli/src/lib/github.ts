/** GitHub CLI reads shared by Tasks and the Swarm pull requests pane. No prompts; every subprocess is bounded. */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { warmLoginShellEnvironment } from './loginShellEnv.js'
import { MessageError } from '../messages/model.js'
import { cleanText } from './cleanText.js'
export type CiState = 'passing' | 'failing' | 'pending' | 'none'
export type Run = (args: string[]) => Promise<{ stdout: string }>

/** GitHub's `mergeStateStatus` words; anything else (a new one, a missing field) is `UNKNOWN` rather than shown as is. */
export const MERGE_STATES = ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE']

const exec = promisify(execFile)

/** Where gh is installed when the daemon's PATH does not have it: Homebrew on Apple silicon and on Intel, Linuxbrew, and
 *  a user install. */
export const GH_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(homedir(), '.local', 'bin')]

/**
 * gh's full path, or null. The daemon is started by launchd or the app, not a shell, so its PATH is the bare system one:
 * a Mac with gh from Homebrew was told "Install the GitHub CLI (gh) on this computer" beside a working `gh` in every
 * terminal (2026-10-17), as tmux once was (lib/tmuxOnPath.ts). So: the daemon's PATH, then the usual install folders,
 * then the PATH the person's own login shell gives, which is spawned only when the first two have no gh.
 */
export async function findGh(env: NodeJS.ProcessEnv = process.env, dirs: readonly string[] = GH_DIRS,
  shellPath: () => Promise<string | undefined> = async () => (await warmLoginShellEnvironment()).PATH): Promise<string | null> {
  return resolveBinaryOnPath('gh', env) ?? resolveBinaryOnPath('gh', { PATH: dirs.join(delimiter) })
    ?? resolveBinaryOnPath('gh', { PATH: (await shellPath()) ?? '' })
}

// Found once and kept; a gh still missing is looked for again at the next read, so installing it needs no restart.
let ghPath: string | null = null

/** `gh` with no prompt and no wait for one: a terminal login question would hang the run until its timeout. */
export const ghRun: Run = async (args) => {
  // Refused under a test runner, whatever the caller: a real `gh` would read the developer's own GitHub login and search
  // public GitHub with it. Tests inject a `Run`; production never has VITEST set.
  if (process.env.VITEST) throw Object.assign(new Error('The real gh is not run in tests.'), { stderr: 'The real gh is not run in tests.' })
  ghPath ??= await findGh()
  if (!ghPath) throw Object.assign(new Error('gh was not found'), { code: 'ENOENT', stderr: '' })
  return { stdout: (await exec(ghPath, args, { timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout }
}

/** Test seam: forget the gh that was found. */
export function resetGhPath(): void { ghPath = null }

/** What a failed run means to the person, as a `MessageError`; the stderr shown is `gh`'s own, cleaned and cut. */
export function ghError(error: unknown): MessageError {
  const e = (error ?? {}) as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  if (e.code === 'ENOENT') return new MessageError('GH_MISSING', 'The GitHub CLI (gh) is not installed on this computer.')
  if (/gh auth login|not logged in|authentication/i.test(stderr)) return new MessageError('GH_SIGNED_OUT', 'gh is not signed in on this computer: run `gh auth login`.')
  if (/rate limit|secondary rate|HTTP 403|HTTP 429/i.test(stderr)) return new MessageError('RATE_LIMITED', 'GitHub is limiting this computer\'s requests. Try again in a minute.')
  // A search too large for the buffer kills the child too, but it is not a slow GitHub: asking again would fail the same way.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new MessageError('GH_FAILED', 'GitHub returned too many or too large results.')
  if (e.killed === true || e.signal === 'SIGKILL') return new MessageError('TIMEOUT', 'GitHub did not answer in time.')
  return new MessageError('GH_FAILED', cleanText(stderr, 200) || 'gh failed.')
}

const failedCheck = (word: string): boolean => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(word)
const checkWord = (check: Record<string, unknown>): string => String(check.conclusion || check.state || '').toUpperCase()
export interface CiCounts { passed: number; failed: number; pending: number; total: number }
/** Skipped and neutral runs are not checks a person must wait for. Commit statuses have state rather than conclusion. */
export function ciCounts(rollup: unknown): CiCounts {
  const counts = { passed: 0, failed: 0, pending: 0, total: 0 }
  for (const check of Array.isArray(rollup) ? rollup : []) {
    if (!check || typeof check !== 'object') continue
    const word = checkWord(check)
    if (['SKIPPED', 'NEUTRAL'].includes(word)) continue
    counts.total++
    if (word === 'SUCCESS') counts.passed++
    else if (failedCheck(word)) counts.failed++
    else counts.pending++
  }
  return counts
}

/** One pull request's CI from its checks: a check run has `status` and `conclusion`, a commit status has `state`. */
export function ciOf(rollup: unknown): CiState {
  const checks = Array.isArray(rollup) ? rollup.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object') : []
  if (!checks.length) return 'none'
  const word = (v: unknown): string => String(v ?? '').toUpperCase()
  const failing = (c: Record<string, unknown>): boolean => failedCheck(checkWord(c))
  // A check that says nothing we know is not yet a pass.
  const settled = (c: Record<string, unknown>): boolean => !!c.conclusion || word(c.status) === 'COMPLETED' || ['SUCCESS', 'FAILURE', 'ERROR'].includes(word(c.state))
  const pending = (c: Record<string, unknown>): boolean => !settled(c)
  return checks.some(failing) ? 'failing' : checks.some(pending) ? 'pending' : 'passing'
}

/** Run `work` over `items`, at most `limit` at once. */
export async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item)
  }))
}

