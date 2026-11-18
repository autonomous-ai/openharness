import { randomUUID } from 'node:crypto'
import { AgentClientError, connectSocket, DEFAULT_TIMEOUT_MS, type ClientSocket, type Connect, type Where } from './daemon.js'

export interface QuestionListener {
  begin(generation: string): void
  question(generation: string, frame: Record<string, unknown>): void
  end(generation: string): void
  unavailable(code: string): void
}
export interface QuestionAnswerBudget { reserve(payload: unknown): (() => void) | null }
export interface QuestionObservation {
  ready: Promise<void>
  answer(agentId: string, requestId: string, answers: Record<string, string>, current: () => boolean): Promise<boolean>
  close(): void
}
type PendingAnswer = { resolve(ok: boolean): void; release(): void; current(): boolean; timer: ReturnType<typeof setTimeout>; active: boolean }

/** One owner-tool question connection. Answers use the observed socket once; its consumer owns reconnection. */
export function observeQuestions(where: Where, listener: QuestionListener, connect: Connect = connectSocket, budget?: QuestionAnswerBudget): QuestionObservation {
  let socket: ClientSocket | undefined
  let closed = false, complete = false, selected = false, began = false
  let generation: string | undefined
  const requestId = randomUUID()
  const pending = new Map<string, PendingAnswer>()
  const settle = (entry: PendingAnswer, ok: boolean): void => {
    if (!entry.active) return
    entry.active = false
    clearTimeout(entry.timer)
    entry.resolve(ok)
  }
  const released = (): void => {
    for (const entry of pending.values()) { settle(entry, false); entry.release() }
    pending.clear()
  }
  let resolve!: () => void, reject!: (error: Error) => void
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  const fail = (code: string, notify = true): void => {
    if (closed) return
    closed = true
    clearTimeout(deadline)
    // A logical timeout or close request does not prove a buffered effect left this socket.
    for (const entry of pending.values()) settle(entry, false)
    if (!complete) reject(new AgentClientError(code, 'Question observation is unavailable.'))
    socket?.close()
    if (notify) listener.unavailable(code)
  }
  const deadline = setTimeout(() => fail('QUESTION_OBSERVATION_TIMEOUT'), DEFAULT_TIMEOUT_MS)
  deadline.unref?.()
  void (async () => {
    try {
      const connected = await connect(where)
      if (closed) { connected.close(); return }
      socket = connected
      connected.on('open', () => {
        if (!closed) connected.send(JSON.stringify({ type: 'machine_select', payload: { machineId: where.machineId, localProtocolVersion: 1, tool: true, questionProtocol: 1 } }))
      })
      connected.on('error', () => fail('QUESTION_OBSERVATION_UNAVAILABLE'))
      connected.on('close', code => { released(); fail(code === 1013 ? 'QUESTION_OBSERVATION_BACKPRESSURE' : 'QUESTION_OBSERVATION_UNAVAILABLE') })
      connected.on('message', (raw, binary) => {
        if (closed || binary) return
        let parsed: unknown
        try { parsed = JSON.parse(raw.toString()) } catch { fail('QUESTION_OBSERVATION_PROTOCOL'); return }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail('QUESTION_OBSERVATION_PROTOCOL'); return }
        const frame = parsed as { type?: unknown; payload?: unknown }
        if (typeof frame.type !== 'string' || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) {
          fail('QUESTION_OBSERVATION_PROTOCOL'); return
        }
        const payload = frame.payload as Record<string, unknown>
        if (frame.type === 'question_response_result') {
          const entry = typeof payload.requestId === 'string' ? pending.get(payload.requestId) : undefined
          if (entry) {
            settle(entry, payload.ok === true && entry.current())
            pending.delete(payload.requestId as string)
            // A correlated reply proves this exact request was read, even for a refusal.
            entry.release()
          }
          return
        }
        if (frame.type === 'machine_select_error' || frame.type === 'frame_too_large') { fail('QUESTION_OBSERVATION_UNAVAILABLE'); return }
        if (!selected && frame.type === 'connected') {
          if (payload.questionProtocol !== 1) { fail('QUESTION_OBSERVATION_UNSUPPORTED'); return }
          selected = true
          connected.send(JSON.stringify({ type: 'questions_observe', payload: { requestId, scope: 'all' } }))
          return
        }
        if (frame.type === 'questions_observe_result' && payload.requestId === requestId) {
          if (payload.ok !== true || typeof payload.generation !== 'string') {
            fail(typeof payload.error === 'string' ? payload.error : 'QUESTION_OBSERVATION_PROTOCOL'); return
          }
          if (generation !== undefined) { fail('QUESTION_OBSERVATION_PROTOCOL'); return }
          generation = payload.generation
          return
        }
        // Legacy tool-select rows are deliberately ignored; only this request's generation is authoritative.
        if (generation === undefined || payload.generation !== generation) return
        try {
          if (frame.type === 'questions_begin') {
            if (began) { fail('QUESTION_OBSERVATION_PROTOCOL'); return }
            began = true
            listener.begin(generation)
          } else if ((frame.type === 'questions_row' || frame.type === 'questions_close') && began) {
            const question = payload.question
            if (!question || typeof question !== 'object' || Array.isArray(question)) { fail('QUESTION_OBSERVATION_PROTOCOL'); return }
            listener.question(generation, question as Record<string, unknown>)
          } else if (frame.type === 'questions_end' && began && !complete) {
            listener.end(generation)
            complete = true
            clearTimeout(deadline)
            resolve()
          }
        } catch { fail('QUESTION_OBSERVATION_UNAVAILABLE') }
      })
    } catch { fail('QUESTION_OBSERVATION_UNAVAILABLE') }
  })()
  const answer: QuestionObservation['answer'] = async (agentId, questionId, answers, current) => {
    if (closed || !complete || !current()) return false
    if (pending.has(questionId)) { console.warn('[questions] QUESTION_ANSWER_BUSY'); return false }
    const frame = { type: 'question_response', payload: { agentId, requestId: questionId, answers, allowPermissions: false } }
    const release = budget?.reserve(frame)
    if (!release) { console.warn('[questions] QUESTION_ANSWER_BACKPRESSURE'); return false }
    if (closed || !current()) { release(); return false }
    return new Promise<boolean>(resolve => {
      const entry: PendingAnswer = { resolve, release, current, active: true, timer: setTimeout(() => {
        console.warn('[questions] QUESTION_ANSWER_TIMEOUT')
        // Retire the generation before this question id can be used by another attempt.
        fail('QUESTION_ANSWER_TIMEOUT')
      }, 30_000) }
      entry.timer.unref?.()
      pending.set(questionId, entry)
      try { socket!.send(JSON.stringify(frame)) }
      catch { console.warn('[questions] QUESTION_ANSWER_UNAVAILABLE'); fail('QUESTION_OBSERVATION_UNAVAILABLE') }
    })
  }
  return { ready, answer, close: () => fail('QUESTION_OBSERVATION_CLOSED', false) }
}
