/**
 * ⌘B's Jev decisions on Harness's own OpenRouter key.
 *
 *   POST /api/route/jev   SSO access token, { state, questions } → { answers }
 *
 * WHY. ⌘B asks Jev 1.13 (OpenRouter's Decisions API) where a typed task goes. The CLI used to need the
 * person's own OpenRouter key, so for nearly everyone ⌘B said "no OpenRouter key" and sent nothing. A
 * decision costs about $0.00017 (docs/design/2026-10-09-auto-router.md), so the owner chose to pay for
 * them (2026-10-11). The key cannot ship in the CLI: this repository is public and the CLI runs on every
 * user's computer. It stays here. A person with a key of their own still uses it directly
 * (cli/src/lib/jev/jevClient.ts); this route is for everyone else.
 *
 * WHAT IS FIXED HERE. The model and the endpoint: a caller sends the decision, never a model name, so
 * this key buys Jev decisions and nothing else. The size of a decision is bounded just above what the
 * router builds (cli/src/lib/routeDecide.ts: a message of up to 16,000 characters, and up to four
 * questions of at most 41 options of at most 600 characters), which is what bounds its price.
 *
 * WHAT IS NOT KEPT. The message and the session descriptions are relayed and dropped. The log carries the
 * account, the time, the cost and the token count, never the words. Every request is OpenRouter-titled
 * "Harness router": an unnamed app burned $60 on 2026-10-10 before anyone could tell which one it was.
 *
 * THE BUDGET is the key's credit limit on OpenRouter, with a daily ceiling across every account
 * (JEV_DAILY_DECISIONS) under it. Each account is capped too, so one account or one runaway client cannot
 * spend everyone's share: a person presses ⌘B, a loop does not. The caps count in Redis, shared by every
 * process and pod; a process-local count would multiply by both and reset on every deploy.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { validateBody } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const JEV_ROUTE_PATH = '/api/route/jev'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'
/** The CLI waits 8 s for Jev; one hop more, and this gives up first. */
const TIMEOUT_MS = 7_000
const MAX_REPLY_CHARS = 128_000

/** The router's message is at most 16,000 characters; the previous session's name rides beside it. */
const MAX_STATE_CHARS = 17_000
const MAX_STATE_KEYS = 4
/** The router asks target, topic, project and agent; 41 options at most (40 and "new"), each cut to 600. */
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 48
const MAX_OPTION_CHARS = 640
const MAX_INSTRUCTION_CHARS = 1_500
/** Bytes, for a request at those bounds in any script: enforced before the body is parsed. */
const MAX_BODY_BYTES = 512 * 1024

/** A shared count slower than this is a stalled Redis: three in a row must still leave the CLI its 8 s. */
const SHARED_COUNT_MS = 300
/** After one fails, count in this process for this long before trying the shared count again. */
const SHARED_RETRY_MS = 10_000

/** Per account: a burst of quick ⌘B presses passes, a client in a loop does not get far. */
const MINUTE_MS = 60_000
const PER_MINUTE = 30
const DAY_MS = 24 * 60 * 60_000
const PER_DAY = 1_000

/** The count after this one, in a fixed window named by the key; the ttl only cleans up. */
export type JevCounter = (key: string, ttlMs: number) => Promise<number>

/** A count in this process alone: tests, and the fallback when the shared one fails. */
export function localJevCounter(now: () => number = Date.now): JevCounter {
  const counts = new Map<string, { count: number; expiresAt: number }>()
  return async (key, ttlMs) => {
    const at = now()
    for (const [old, entry] of counts) if (entry.expiresAt <= at) counts.delete(old)
    const entry = counts.get(key) ?? { count: 0, expiresAt: at + ttlMs }
    entry.count++
    counts.set(key, entry)
    return entry.count
  }
}

/**
 * Whether one more decision may be asked: null when it may, or who is over. The account's caps are counted
 * first, so asks refused for one account never spend the day's shared ceiling.
 */
export async function jevAllowance(count: JevCounter, userId: string, now: number, ceiling: number): Promise<'account' | 'everyone' | null> {
  const minute = Math.floor(now / MINUTE_MS), day = Math.floor(now / DAY_MS)
  if (await count(`jev:m:${userId}:${minute}`, MINUTE_MS) > PER_MINUTE) return 'account'
  if (await count(`jev:d:${userId}:${day}`, DAY_MS) > PER_DAY) return 'account'
  if (await count(`jev:all:${day}`, DAY_MS) > ceiling) return 'everyone'
  return null
}

const own = (record: Record<string, unknown>, key: string): boolean => Object.hasOwn(record, key)

const choiceSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1).max(MAX_INSTRUCTION_CHARS),
  // One option is a real question: a desk with no sessions offers only "new".
  criteria: z
    .record(z.string().min(1).max(64), z.string().max(MAX_OPTION_CHARS))
    .refine((criteria) => {
      const count = Object.keys(criteria).length
      return count >= 1 && count <= MAX_OPTIONS
    }, `between 1 and ${MAX_OPTIONS} options`),
})

const jevBodySchema = z.object({
  // Characters as typed, not as JSON escapes them: a pasted 16,000-character stack trace is one message.
  state: z
    .record(z.string().max(64), z.string())
    .refine((state) => Object.keys(state).length <= MAX_STATE_KEYS, 'state has too many fields')
    .refine((state) => Object.values(state).reduce((sum, value) => sum + value.length, 0) <= MAX_STATE_CHARS, 'state is too long'),
  questions: z
    .record(z.string().min(1).max(64), choiceSchema)
    .refine((questions) => {
      const count = Object.keys(questions).length
      return count >= 1 && count <= MAX_QUESTIONS
    }, `between 1 and ${MAX_QUESTIONS} questions`),
})

export type JevBody = z.infer<typeof jevBodySchema>

export interface JevAnswer {
  choice: string
  probabilities: Record<string, number>
}

/**
 * Jev's answers, kept only where they answer a question that was asked with one of its own options.
 * Null when nothing usable came back.
 */
export function parseJevAnswers(raw: unknown, questions: JevBody['questions']): Record<string, JevAnswer> | null {
  const answers = (raw as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== 'object') return null
  const out: Record<string, JevAnswer> = {}
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    const question = own(questions, id) ? questions[id] : undefined
    const answer = value as { choice?: unknown; probabilities?: unknown } | null
    if (!question || typeof answer?.choice !== 'string' || !own(question.criteria, answer.choice)) continue
    if (!answer.probabilities || typeof answer.probabilities !== 'object') continue
    const probabilities: Record<string, number> = {}
    for (const [option, p] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (own(question.criteria, option) && typeof p === 'number' && Number.isFinite(p)) probabilities[option] = p
    }
    out[id] = { choice: answer.choice, probabilities }
  }
  return Object.keys(out).length > 0 ? out : null
}

export interface JevRouteOptions {
  /** Shared by every process (server.ts passes Redis); this process's own count when absent. */
  count?: JevCounter
  now?: () => number
}

/**
 * ORDINARY SSO GATING, as /api/route/agents: the daemon signs in as a person and presents that access
 * token; the middleware puts the account on `request.user`, which the caps count.
 */
export async function jevRouteRoutes(app: FastifyInstance, options: JevRouteOptions = {}): Promise<void> {
  const now = options.now ?? Date.now
  const local = localJevCounter(now)
  const shared = options.count ?? local
  // Redis down or stalled must mean neither uncapped nor a ⌘B that waits on it: count in this process, and
  // try the shared count again a little later (one log line per failure, not three per request).
  let sharedAfter = 0
  const count: JevCounter = async (key, ttlMs) => {
    if (now() < sharedAfter) return local(key, ttlMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        shared(key, ttlMs),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${SHARED_COUNT_MS} ms`)), SHARED_COUNT_MS) }),
      ])
    } catch (err) {
      sharedAfter = now() + SHARED_RETRY_MS
      logger.error('jev-route: shared count failed, counting in this process', { error: err instanceof Error ? err.message : String(err) })
      return local(key, ttlMs)
    } finally {
      clearTimeout(timer)
    }
  }

  app.post<{ Body: JevBody }>(JEV_ROUTE_PATH, { bodyLimit: MAX_BODY_BYTES, preHandler: [validateBody(jevBodySchema)] }, async (req, reply) => {
    // Fail CLOSED: an absent key must never read as "decide some other way" on a path that spends credit.
    if (!env.JEV_OPENROUTER_API_KEY) {
      logger.error('jev-route: JEV_OPENROUTER_API_KEY not configured — refusing')
      sendError(reply, 'Jev is not set up on this server', 'JEV_NOT_CONFIGURED', 503)
      return
    }
    // A caller that hangs up has nobody waiting on the answer: do not start, or stop paying for, its decision.
    // The daemon's own gateway holds its connection open for up to 20 s, so for ⌘B the real bound is
    // TIMEOUT_MS below; this is for a caller that does hang up.
    const gone = new AbortController()
    const onClose = () => { if (!reply.raw.writableFinished) gone.abort() }
    reply.raw.once('close', onClose)
    try {
      await decide(req, reply, gone.signal)
    } finally {
      reply.raw.off('close', onClose)
    }
  })

  async function decide(req: FastifyRequest<{ Body: JevBody }>, reply: FastifyReply, gone: AbortSignal): Promise<void> {
    const userId = req.user?.sub ?? ''
    const over = await jevAllowance(count, userId, now(), env.JEV_DAILY_DECISIONS)
    if (over === 'account') {
      sendError(reply, 'Too many ⌘B decisions; try again in a minute', 'RATE_LIMITED', 429)
      return
    }
    if (over === 'everyone') {
      logger.error('jev-route: daily ceiling reached', { ceiling: env.JEV_DAILY_DECISIONS })
      sendError(reply, "Harness's Jev budget for today has run out", 'JEV_CREDITS', 503)
      return
    }

    if (gone.aborted) return
    const started = Date.now()
    const { state, questions } = req.body
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), gone]),
        headers: {
          Authorization: `Bearer ${env.JEV_OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://harness.autonomous.ai',
          'X-Title': 'Harness router',
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
      })
      if (!res.ok) {
        await res.body?.cancel()
        logger.error('jev-route: OpenRouter refused', { userId, status: res.status, ms: Date.now() - started })
        // Out of credit is the one the owner must act on, and the CLI tells the person it is ours.
        if (res.status === 402) sendError(reply, 'Harness is out of Jev credit', 'JEV_CREDITS', 503)
        else if (res.status === 429) sendError(reply, 'Jev is busy', 'JEV_BUSY', 503)
        else sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
        return
      }
      const text = await res.text()
      let parsed: unknown = null
      if (text.length <= MAX_REPLY_CHARS) {
        try { parsed = JSON.parse(text) } catch { /* reported below */ }
      }
      const answers = parseJevAnswers(parsed, questions)
      if (!answers) {
        logger.error('jev-route: unusable answer', { userId, chars: text.length, ms: Date.now() - started })
        sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
        return
      }
      const usage = (parsed as { usage?: { cost?: unknown; input_tokens?: unknown } }).usage
      logger.info('jev-route', {
        userId,
        ms: Date.now() - started,
        questions: Object.keys(questions).length,
        cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
        tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
      })
      sendSuccess(reply, { answers })
    } catch (err) {
      logger.error('jev-route failed', { userId, ms: Date.now() - started, gone: gone.aborted, error: err instanceof Error ? err.name : String(err) })
      sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
    }
  }
}
