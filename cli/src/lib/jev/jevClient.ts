/**
 * Jev 1.13, asked through OpenRouter's Decisions API: how ⌘B's router decides where a task goes
 * (lib/routeDecide.ts, docs/design/2026-10-09-auto-router.md). The only Jev in Harness.
 *
 * One POST answers several typed questions at once — which session, which project, which agent — in
 * about 0.6 s, for about $0.0002 on a desk of thirty sessions (measured 2026-10-10).
 *
 * The key is the person's OpenRouter key: OPENROUTER_API_KEY, the account `ori login` saved, or the
 * credentials file at ~/.config/typesafe/credentials (or $TYPESAFE_CREDENTIALS). It is read when a
 * decision is asked for and never logged.
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

export function createJevDecide(options: {
  key?: () => Promise<string | null>
  fetch?: typeof fetch
  /** What each answer cost, as OpenRouter reports it (USD) — what a person's key is charged. */
  onCost?: (usd: number, inputTokens: number) => void
} = {}): JevDecide {
  return async (state, questions, signal) => {
    const key = await (options.key ?? resolveJevKey)()
    if (!key) throw new JevUnavailable('NO_KEY', 'no OpenRouter key on this computer')
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
    const text = await response.text()
    if (text.length > MAX_REPLY_BYTES) throw new JevUnavailable('INVALID', 'Jev answered too much')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new JevUnavailable('INVALID', 'Jev answered something that is not JSON') }
    const answers = (parsed as { answers?: unknown } | null)?.answers
    if (!answers || typeof answers !== 'object') throw new JevUnavailable('INVALID', 'Jev gave no answers')
    const usage = (parsed as { usage?: { cost?: unknown; input_tokens?: unknown } }).usage
    if (typeof usage?.cost === 'number') options.onCost?.(usage.cost, typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
    const out: Record<string, JevChoiceAnswer> = {}
    for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
      const answer = raw as { choice?: unknown; probabilities?: unknown } | null
      if (typeof answer?.choice !== 'string' || !answer.probabilities || typeof answer.probabilities !== 'object') continue
      out[id] = { choice: answer.choice, probabilities: answer.probabilities as Record<string, number> }
    }
    return out
  }
}
