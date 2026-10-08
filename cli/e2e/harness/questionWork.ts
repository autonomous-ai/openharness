/**
 * Questions as a workload: an agent asks, a window answers through `question_response`, and the answer
 * the engine took is read back from its own transcript. Shared by the opt-in performance run
 * (perf.e2e.ts, `PERF_QUESTIONS`) and the soak (endurance.e2e.ts).
 *
 * The fake engines draw what the real CLIs draw (fakeEngine.mjs): a single choice (`!ask`), Claude Code's
 * "Type something." row (a typed answer to `!ask`), Claude Code's multiSelect with its review (`!askmany`)
 * and a permission prompt (`!permit`). Codex's recorded request_user_input has no free-text row and no
 * checkboxes, so Codex answers choices and permissions only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, LocalClient } from './client.js'

export type QuestionEngine = 'claude' | 'codex'
export type QuestionKind = 'select' | 'multi' | 'text' | 'permit'
export const QUESTION_KINDS: Record<QuestionEngine, QuestionKind[]> = {
  claude: ['select', 'multi', 'text', 'permit'],
  codex: ['select', 'permit'],
}

export interface QuestionOutcome {
  engine: QuestionEngine
  kind: QuestionKind
  token: string
  requestId: string | null
  answer: string | null
  /** What the engine says once it has the answer: the transcript's last word on that turn. */
  expected: string | null
  /** performance.now() when the first answer was sent. */
  sentAt: number | null
  /** Answer sent → its `question_response_result` (core answers once the dialog is gone or submitted). */
  resultMs: number | null
  /** Answer sent → `commander_question_close` for it, when one came by the time the turn ended. */
  closeMs: number | null
  /** Answer sent → the turn's `turn_ended` (the engine took the answer and finished). */
  endedMs: number | null
  attempts: number
  errors: string[]
  ok: boolean
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const isTurnEnd = (agentId: string) => (frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId

function prompt(kind: QuestionKind, token: string): { content: string; command: string } {
  const command = `printf ${token || 'hi'}`
  if (kind === 'multi') return { content: `!askmany ${token}`.trim(), command }
  if (kind === 'permit') return { content: `!permit ${command}`, command }
  return { content: `!ask ${token}`.trim(), command }
}

function answerFor(engine: QuestionEngine, kind: QuestionKind, n: number, options: string[], command: string): { answer: string; expected: string } {
  if (kind === 'permit') {
    const yes = n % 2 === 0
    return { answer: options[yes ? 0 : 2] ?? options[0], expected: yes ? `ran ${command}` : `did not run ${command}` }
  }
  if (kind === 'multi') {
    const answer = n % 2 === 0 ? 'Cheese, Basil' : 'Ham'
    return { answer, expected: `you chose ${answer}` }
  }
  if (kind === 'text') {
    const answer = `hot chocolate ${n}`
    return { answer, expected: `you chose ${answer}` }
  }
  const choices = engine === 'codex' ? ['Coffee', 'Tea', 'None of the above'] : ['Coffee', 'Tea']
  const answer = choices[n % choices.length]
  return { answer, expected: `you chose ${answer}` }
}

/**
 * One question: the prompt that asks it, the question as the window hears it, and the answer sent back
 * under its request id. A refused answer is retried (`retries`) as a new intent, a second later: what a
 * person does when the app says the answer did not go in. Never throws; what went wrong is in `errors`.
 */
export async function askAndAnswer(client: LocalClient, agent: { id: string; engine: QuestionEngine }, kind: QuestionKind, n: number,
  options: { token?: string; askMs?: number; resultMs?: number; endMs?: number; retries?: number } = {}): Promise<QuestionOutcome> {
  const token = options.token ?? ''
  const { content, command } = prompt(kind, token)
  const outcome: QuestionOutcome = { engine: agent.engine, kind, token, requestId: null, answer: null, expected: null,
    sentAt: null, resultMs: null, closeMs: null, endedMs: null, attempts: 0, errors: [], ok: false }
  const asked = client.next(frame => frame.type === 'commander_question' && frame.agentId === agent.id, options.askMs ?? 60_000, `question (${kind} ${token})`)
  const ended = client.next(isTurnEnd(agent.id), options.endMs ?? 120_000, `turn_ended (${kind} ${token})`).then(() => performance.now())
  ended.catch(() => {})
  client.send('message', { agentId: agent.id, content })
  let question: Record<string, any>
  try { question = (await asked).payload ?? {} } catch (error) {
    outcome.errors.push(`asked: ${error instanceof Error ? error.message : String(error)}`)
    return outcome
  }
  const shaped = (question.questions as Array<{ q: string; options: string[] }> | undefined)?.[0]
  if (!shaped || typeof question.requestId !== 'string') {
    outcome.errors.push(`asked: unreadable question ${JSON.stringify(question).slice(0, 200)}`)
    ended.catch(() => {})
    return outcome
  }
  const { answer, expected } = answerFor(agent.engine, kind, n, shaped.options ?? [], command)
  Object.assign(outcome, { requestId: question.requestId, answer, expected })
  const closed = client.next(frame => frame.type === 'commander_question_close' && frame.agentId === agent.id
    && frame.payload?.requestId === question.requestId, (options.endMs ?? 120_000) + 5_000, 'commander_question_close')
    .then(() => performance.now(), () => null)
  let closeAt: number | null | undefined
  void closed.then(at => { closeAt = at })
  for (let attempt = 0; attempt <= (options.retries ?? 0); attempt++) {
    if (attempt) await sleep(1_000)
    outcome.attempts++
    const result = client.next(frame => frame.type === 'question_response_result' && frame.payload?.requestId === question.requestId,
      options.resultMs ?? 45_000, `question_response_result (${kind} ${token})`)
    const at = performance.now()
    outcome.sentAt ??= at
    client.send('question_response', { requestId: question.requestId, agentId: agent.id, answers: { [shaped.q]: answer } })
    try {
      const reply = (await result).payload ?? {}
      if (reply.error === undefined) { outcome.resultMs = performance.now() - outcome.sentAt; outcome.ok = true; break }
      outcome.errors.push(`answer ${attempt + 1}: ${String(reply.error)} ${String(reply.detail ?? reply.message ?? '').slice(0, 160)}`.trim())
    } catch (error) {
      outcome.errors.push(`answer ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Never answered: the dialog is still up and the turn cannot end. The caller stops asking this agent.
  if (!outcome.ok) return outcome
  try { outcome.endedMs = (await ended) - outcome.sentAt! } catch (error) {
    outcome.ok = false
    outcome.errors.push(`ended: ${error instanceof Error ? error.message : String(error)}`)
  }
  await sleep(0)
  outcome.closeMs = typeof closeAt === 'number' ? closeAt - outcome.sentAt! : null
  return outcome
}

/** The answers a question turn can end on, as the fake engines write them (fakeEngine.mjs `finish`). */
const QUESTION_OUTCOME = /^(?:you chose .+|ran printf .+|did not run printf .+|\(question cancelled\))$/s

function transcripts(directory: string, sessionId: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return transcripts(path, sessionId)
    return entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`) ? [path] : []
  })
}

/** What an agent's engine recorded as the end of each question turn, in order, from its transcript. */
export function engineAnswers(root: string, engine: QuestionEngine, sessionId: string): string[] {
  const files = transcripts(engine === 'claude' ? join(root, 'claude', 'projects') : join(root, 'codex', 'sessions'), sessionId)
  const found: string[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let record: Record<string, any>
      try { record = JSON.parse(line) } catch { continue }
      const text = engine === 'claude'
        ? record.type === 'assistant' && record.message?.stop_reason === 'end_turn' ? record.message?.content?.[0]?.text : undefined
        : record.type === 'event_msg' && record.payload?.type === 'task_complete' ? record.payload?.last_agent_message : undefined
      if (typeof text === 'string' && QUESTION_OUTCOME.test(text)) found.push(text)
    }
  }
  return found
}

/** The answers that went in against what the engine took: none lost, none taken twice, none out of order. */
export function compareAnswers(expected: string[], seen: string[]): { expected: number; seen: number; equal: boolean; lost: number; duplicated: number; firstDifference: number | null } {
  const count = (list: string[]) => list.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())
  const want = count(expected), got = count(seen)
  let lost = 0, duplicated = 0
  for (const [value, n] of want) lost += Math.max(0, n - (got.get(value) ?? 0))
  for (const [value, n] of got) duplicated += Math.max(0, n - (want.get(value) ?? 0))
  const length = Math.max(expected.length, seen.length)
  let firstDifference: number | null = null
  for (let i = 0; i < length; i++) if (expected[i] !== seen[i]) { firstDifference = i; break }
  return { expected: expected.length, seen: seen.length, equal: firstDifference === null, lost, duplicated, firstDifference }
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** Count, p50 and p95 of each latency, overall and by engine and kind. */
export function summarizeAnswers(outcomes: QuestionOutcome[]) {
  const stats = (list: QuestionOutcome[]) => {
    const pick = (key: 'resultMs' | 'endedMs' | 'closeMs') => list.map(o => o[key]).filter((v): v is number => typeof v === 'number')
    const result = pick('resultMs'), ended = pick('endedMs'), close = pick('closeMs')
    return {
      count: list.length, ok: list.filter(o => o.ok).length, errors: list.reduce((sum, o) => sum + o.errors.length, 0),
      retried: list.filter(o => o.attempts > 1).length,
      resultMs: { n: result.length, p50: percentile(result, 0.5), p95: percentile(result, 0.95), max: result.length ? Math.max(...result) : null },
      endedMs: { n: ended.length, p50: percentile(ended, 0.5), p95: percentile(ended, 0.95) },
      closeMs: { n: close.length, p50: percentile(close, 0.5), p95: percentile(close, 0.95) },
    }
  }
  const groups = (key: (o: QuestionOutcome) => string) => Object.fromEntries([...new Set(outcomes.map(key))].sort()
    .map(name => [name, stats(outcomes.filter(o => key(o) === name))]))
  return { all: stats(outcomes), byEngine: groups(o => o.engine), byKind: groups(o => `${o.engine}:${o.kind}`) }
}
