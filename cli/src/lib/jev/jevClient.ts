/**
 * Jev 1.13, asked through OpenRouter's Decisions API: how ⌘B's router decides where a task goes
 * (lib/routeDecide.ts, docs/design/2026-10-09-auto-router.md). The only Jev in Harness.
 *
 * One POST answers several typed questions at once — which session, which project, which agent — in
 * about 0.6 s, for about $0.0002 on a desk of thirty sessions (measured 2026-10-10).
 *
 * A person with an OpenRouter key of their own asks with it: OPENROUTER_API_KEY, the account `ori login`
 * saved, or the credentials file at ~/.config/typesafe/credentials (or $TYPESAFE_CREDENTIALS). It is read
 * when a decision is asked for and never logged. Everyone else asks on Harness's key, through the backend
 * (backend/src/routes/jevRoute.ts): the owner chose to pay for these decisions (2026-10-11), and the key
 * cannot ship here because this code is public. That request is the core's to sign (`core.account.backend`):
 * the router holds no credential of its own.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveOpenRouterKey } from '../openrouter.js'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'
const TIMEOUT_MS = 8_000
const MAX_REPLY_BYTES = 128_000

export interface JevChoice { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface JevChoiceAnswer { choice: string; probabilities: Record<string, number> }
export type JevDecide = (state: unknown, questions: Record<string, JevChoice>, signal?: AbortSignal) => Promise<Record<string, JevChoiceAnswer>>

/** Why Jev did not answer, in words the router can log and the person can act on. */
export class JevUnavailable extends Error {
  constructor(readonly code: 'NO_KEY' | 'AUTH' | 'CREDITS' | 'BUSY' | 'UNAVAILABLE' | 'INVALID', message: string) { super(message) }
}

/** A read or write of the account's backend, signed in by the core (`CoreApi['account']['backend']`). A
 *  failure is an answer, never a throw: 401 signed out, 502 unreachable, 504 too slow. */
export type AccountBackend = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>

/** Harness's Jev, on the backend. */
export const HOSTED_JEV_PATH = '/api/route/jev'

/** The key, or null when this computer has none. */
export async function resolveJevKey(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const known = await resolveOpenRouterKey()
  if (known) return known
  const path = environment.TYPESAFE_CREDENTIALS || join(homedir(), '.config', 'typesafe', 'credentials')
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/.exec(line)
      const value = match?.[1].replace(/^(['"])(.*)\1$/, '$2')
      if (value) return value
    }
  } catch { /* no file */ }
  return null
}

/** What a reply's answers say: each one that is a choice with probabilities. */
function readAnswers(answers: unknown): Record<string, JevChoiceAnswer> {
  if (!answers || typeof answers !== 'object') throw new JevUnavailable('INVALID', 'Jev gave no answers')
  const out: Record<string, JevChoiceAnswer> = {}
  for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
    const answer = raw as { choice?: unknown; probabilities?: unknown } | null
    if (typeof answer?.choice !== 'string' || !answer.probabilities || typeof answer.probabilities !== 'object') continue
    out[id] = { choice: answer.choice, probabilities: answer.probabilities as Record<string, number> }
  }
  return out
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_REPLY_BYTES) throw new JevUnavailable('INVALID', 'Jev answered too much')
  try { return JSON.parse(text) } catch { throw new JevUnavailable('INVALID', 'Jev answered something that is not JSON') }
}

/** The backend's error code: the route's `{ error: { code } }`, or the core's own `{ error: 'CODE' }`. */
function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error
  if (typeof error === 'string') return error
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Why Harness's Jev did not answer, in the router's words. */
function hostedRefusal(status: number, code: string | undefined): JevUnavailable {
  if (code === 'NOT_SIGNED_IN') return new JevUnavailable('NO_KEY', 'sign in to Harness to use ⌘B')
  if (status === 401 || status === 403) return new JevUnavailable('AUTH', 'Harness could not confirm your sign-in')
  // Signed in, but the refresh could not be made just now: not a reason to tell anyone to sign in.
  if (code === 'AUTH_UNAVAILABLE') return new JevUnavailable('UNAVAILABLE', 'Harness could not refresh your sign-in')
  if (status === 429) return new JevUnavailable('BUSY', 'too many ⌘B decisions, try again in a minute')
  if (code === 'JEV_CREDITS') return new JevUnavailable('CREDITS', "Harness's Jev budget has run out")
  if (code === 'JEV_BUSY') return new JevUnavailable('BUSY', 'Jev is busy')
  if (code === 'BACKEND_TIMEOUT') return new JevUnavailable('UNAVAILABLE', "Harness's server did not answer in time")
  if (code === 'BACKEND_UNREACHABLE' || code === 'SERVICE_UNAVAILABLE' || code === 'GATEWAY_UNAVAILABLE') return new JevUnavailable('UNAVAILABLE', "Harness's server cannot be reached")
  // An older backend, before the route: the CLI self-updates on its own schedule and can arrive first.
  if (status === 404) return new JevUnavailable('UNAVAILABLE', "Harness's server cannot decide yet")
  return new JevUnavailable('UNAVAILABLE', `Harness's server answered ${status}`)
}

/** [work], or the reason [signal] gives once it fires: the caller's slot is freed when it stops waiting. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

export function createJevDecide(options: {
  key?: () => Promise<string | null>
  /** The account's backend, signed in by the core: Harness's key, for a computer with none of its own. */
  backend?: AccountBackend
  fetch?: typeof fetch
  /** What each answer cost, as OpenRouter reports it (USD) — what a person's own key is charged. */
  onCost?: (usd: number, inputTokens: number) => void
} = {}): JevDecide {
  return async (state, questions, signal) => {
    const key = await (options.key ?? resolveJevKey)()
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
    if (!key) {
      if (!options.backend) throw new JevUnavailable('NO_KEY', 'no OpenRouter key on this computer')
      // Nobody waiting already: ask nothing, since an asked decision is paid for whether or not it is read.
      if (abort.aborted) throw abort.reason
      const answer = await bounded(options.backend('POST', HOSTED_JEV_PATH, { state, questions }), abort)
      if (answer.status !== 200) throw hostedRefusal(answer.status, errorCode(answer.body))
      return readAnswers((answer.body.data as { answers?: unknown } | undefined)?.answers)
    }
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      signal: abort,
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://harness.autonomous.ai', 'X-Title': 'Harness router',
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw new JevUnavailable('AUTH', 'OpenRouter refused the key')
      if (response.status === 402) throw new JevUnavailable('CREDITS', 'the OpenRouter account is out of credit')
      if (response.status === 429) throw new JevUnavailable('BUSY', 'OpenRouter is busy')
      throw new JevUnavailable('UNAVAILABLE', `OpenRouter answered ${response.status}`)
    }
    const parsed = await readJson(response)
    const answers = readAnswers((parsed as { answers?: unknown } | null)?.answers)
    const usage = (parsed as { usage?: { cost?: unknown; input_tokens?: unknown } }).usage
    if (typeof usage?.cost === 'number') options.onCost?.(usage.cost, typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
    return answers
  }
}
