/** One ephemeral presentation per declared service session; current native ownership always wins. */
import { errorKind } from '../../lib/log.js'
import type { SessionFactoryOwner } from '../../harnessd/services.js'
import { copySessionValue } from '../../lib/sessionFactValues.js'
import { readSessionFact, retainedSessionFrame, sessionFactsWire, sessionOwnerId, sessionOwnerFactory, sessionOwnerCreatedAt,
  type SessionFrame } from '../../lib/sessionPresentation.js'
import { OWNER_DOWN, OWNER_REPLY_DOWN, OWNER_ANSWER_DOWN, type OwnerQuestion, type OwnerQuestionClose,
  type OwnerResult, type OwnerDelivery, type OwnerCard, type SessionOwnerCore, type SessionOwnerPort, type SessionOwnerLimits,
  type ServiceSessionRow } from '../../lib/sessionOwnerWire.js'
import type { QuestionAnswerResult } from '../../lib/questionController.js'
import { questionClose, type QuestionPresentation, type QuestionPresentations } from '../questions.js'
import { ownerIncarnation, stageSessionOwners, type OwnerAuthority, type Owner } from './sessionOwnerStage.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }
export interface SessionOwnersDeps {
  factoryOwner(factory: unknown): SessionFactoryOwner | undefined
  native(id: string): boolean
  port(service: string): SessionOwnerPort | null
  whenStarting(service: string): Promise<boolean> | null
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void; sendLocal(frame: Frame): void }
  questions: QuestionPresentations
  limits: SessionOwnerLimits
  log?: (line: string) => void
}
const fields = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refusal = (value: unknown): boolean => fields(value, ['error'], ['detail']) && typeof value.error === 'string' && !!value.error
  && (value.detail === undefined || typeof value.detail === 'string')
const answerReply = (value: unknown): boolean => fields(value, ['ok']) && value.ok === true
  || fields(value, ['ok', 'error', 'detail']) && value.ok === false
    && (value.error === 'STALE_QUESTION' || value.error === 'ANSWER_FAILED') && typeof value.detail === 'string'
const stopReply = (value: unknown): boolean => refusal(value) || fields(value, ['deleted'], ['detail']) && value.deleted === true
  && (value.detail === undefined || typeof value.detail === 'string')
const detached = (value: unknown, bytes: number): unknown => copySessionValue(value,
  { bytes, objects: bytes, properties: bytes, slots: bytes, depth: 32 }).value
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80
const admittedClose = (value: unknown, agentId: string, requestId: string): value is OwnerQuestionClose =>
  fields(value, ['type', 'agentId', 'dbSessionId', 'payload']) && value.type === 'commander_question_close'
  && value.agentId === agentId && value.dbSessionId === agentId && fields(value.payload, ['requestId']) && value.payload.requestId === requestId
function admittedQuestion(value: unknown, agentId: string, requestId: string): value is OwnerQuestion {
  if (!fields(value, ['frame', 'close', 'dial']) || typeof value.dial !== 'boolean' || !admittedClose(value.close, agentId, requestId)) return false
  const frame = value.frame
  if (!fields(frame, ['type', 'agentId', 'dbSessionId', 'payload']) || frame.type !== 'commander_question'
    || frame.agentId !== agentId || frame.dbSessionId !== agentId || !fields(frame.payload, ['requestId', 'questions', 'notification'])
    || frame.payload.requestId !== requestId || !fields(frame.payload.notification, ['id', 'kind'])
    || frame.payload.notification.id !== requestId || frame.payload.notification.kind !== 'needsYou'
    || !Array.isArray(frame.payload.questions) || !frame.payload.questions.length) return false
  const keys = new Set<string>()
  for (const question of frame.payload.questions) {
    if (!fields(question, ['key', 'q', 'options', 'multi', 'canText']) || !identifier(question.key) || keys.has(question.key)
      || typeof question.q !== 'string' || typeof question.multi !== 'boolean' || typeof question.canText !== 'boolean'
      || !Array.isArray(question.options) || !question.options.every(option => typeof option === 'string' && !!option)) return false
    keys.add(question.key)
  }
  return !value.dial || frame.payload.questions.some(question => question.options.length > 0)
}

export function createSessionOwners({ factoryOwner, native, port, whenStarting, clients, questions, limits,
  log = line => console.log(line) }: SessionOwnersDeps) {
  let owners = new Map<string, Owner>()
  const questionOwner = {}
  const serviceFor = (factory: unknown): string | undefined => {
    const owner = factoryOwner(factory)
    return owner?.kind === 'service' ? owner.service : undefined
  }
  const current = (owner: Owner): boolean => owners.get(sessionOwnerId(owner))?.[ownerIncarnation] === owner[ownerIncarnation]
    && !owner[ownerIncarnation].revoked && !native(sessionOwnerId(owner))
  const owned = (id: string): Owner | undefined => { const owner = owners.get(id); return owner && current(owner) ? owner : undefined }
  const close = (entry: QuestionPresentation): void => {
    const frame = questionClose(entry.frame)
    if (entry.dial) clients.sendCommander(frame)
    clients.sendLocal(frame)
  }
  const retire = (id: string): void => {
    const prior = questions.current(id)
    if (prior?.owner === questionOwner && questions.remove(questionOwner, prior.key, prior.requestId)) close(prior)
  }
  const nativeEntered = (agentId: string, sessionId: string): void => {
    const first = owners.get(agentId), alias = sessionId !== agentId ? owners.get(sessionId) : undefined
    if (first) first[ownerIncarnation].revoked = true
    if (alias) alias[ownerIncarnation].revoked = true
    for (const owner of [first, alias]) if (owner) {
      try { retire(sessionOwnerId(owner)) }
      catch (caughtFailure) { try { log(('[sessions] question close unavailable') + ' · ' + errorKind(caughtFailure)) } catch { /* both native claims already revoked */ } }
    }
  }
  const gone = (agentId: string): void => {
    const frame: Frame = { type: 'agent_deleted', payload: { agentId } }
    clients.send(frame); clients.sendCommander(frame)
  }
  const staging = stageSessionOwners({ limits, factoryOwner, native, rows: () => owners,
    commit(next, before, cards, service) {
      // The sole Map writer runs only after staging drops; an active stage always owns this exact before image.
      owners = next
      for (const [id, owner] of next) if (serviceFor(sessionOwnerFactory(owner)) === service) {
        const prior = before.get(id)
        if (prior && prior[ownerIncarnation] !== owner[ownerIncarnation]) retire(id)
        if (prior && JSON.stringify(sessionFactsWire(prior)) === JSON.stringify(sessionFactsWire(owner))) continue
        const frame: Frame = { type: 'agent_synced', payload: { agent: retainedSessionFrame(owner) } }
        clients.send(frame)
        clients.sendCommander(readSessionFact(owner, 'status') === 'stopped' ? { type: 'agent_deleted', payload: { agentId: id } } : frame)
        const card = cards.get(id)
        if (card) clients.sendCommander(card)
      }
      for (const [id, prior] of before) if (serviceFor(sessionOwnerFactory(prior)) === service && !next.has(id)) {
        retire(id)
        if (!prior[ownerIncarnation].revoked && !native(id)) gone(id)
      }
    } })
  const invalidQuestion = (): OwnerResult => { log('[sessions] SESSION_OWNER_INVALID'); return { ok: false, error: 'SESSION_OWNER_INVALID' } }
  const questionDoor = (authority: OwnerAuthority, input: unknown, bytes: number, work: (value: unknown) => OwnerResult): OwnerResult => {
    let value: unknown
    try { value = detached(input, bytes) }
    catch { return authority.current() ? invalidQuestion() : { ok: false, error: 'SERVICE_UNAVAILABLE' } }
    // Detached admission cannot call outside code; check authority once before synchronous owner lookup and effects.
    if (!authority.current()) return { ok: false, error: 'SERVICE_UNAVAILABLE' }
    try { return work(value) } catch { return invalidQuestion() }
  }
  const bound = (authority: OwnerAuthority): SessionOwnerCore => ({
    begin: value => staging.begin(authority, value), append: value => staging.append(authority, value),
    end: transfer => staging.end(authority, transfer), cancel: transfer => staging.cancel(authority, transfer),
    checkpoint: factory => staging.checkpoint(authority, factory),
    ask: (agentId, requestId, input) => questionDoor(authority, input, 22 * 1024, presentation => {
      const owner = owned(agentId)
      if (!owner || serviceFor(sessionOwnerFactory(owner)) !== authority.service || !identifier(requestId)) return invalidQuestion()
      if (!admittedQuestion(presentation, agentId, requestId)) return invalidQuestion()
      const prior = questions.request(requestId)
      if (prior && (prior.owner !== questionOwner || prior.key !== agentId || presentation.dial && !prior.dial
        || JSON.stringify(prior.frame) !== JSON.stringify(presentation.frame))) return invalidQuestion()
      const previous = questions.current(agentId), replacing = !!previous && previous.requestId !== requestId
      if (!prior && !questions.set(questionOwner, agentId, presentation.frame, { dial: presentation.dial, remote: false }, replacing)) return invalidQuestion()
      if (replacing) close(previous)
      if (presentation.dial) clients.sendCommander(presentation.frame)
      clients.sendLocal(presentation.frame)
      log('[sessions] question accepted')
      return { ok: true }
    }),
    unask: (agentId, requestId, input) => questionDoor(authority, input, 1024, close => {
      if (!identifier(agentId) || !identifier(requestId) || !admittedClose(close, agentId, requestId)) return invalidQuestion()
      const prior = questions.request(requestId)
      if (!prior) return { ok: true }
      const owner = owned(agentId)
      if (!owner || serviceFor(sessionOwnerFactory(owner)) !== authority.service || prior.owner !== questionOwner || prior.key !== agentId) return invalidQuestion()
      retire(agentId)
      return { ok: true }
    }),
  })
  const call = async <T>(service: string, work: (port: SessionOwnerPort) => Promise<T>, fallback: T,
    admit: (value: unknown) => boolean, stillCurrent: (phase: 'dispatch' | 'result') => boolean = () => true,
    apply = (_value: T): void => {}): Promise<T> => {
    const starting = whenStarting(service)
    if (starting && !await starting) return fallback
    const connection = port(service)
    if (!connection || !stillCurrent('dispatch')) return fallback
    let result: T
    try { result = await work(connection) } catch { return fallback }
    if (port(service) !== connection || !stillCurrent('result')) return fallback
    let accepted: T
    try {
      const candidate = detached(result, 256 * 1024)
      if (!admit(candidate)) throw new Error('SESSION_OWNER_INVALID')
      accepted = candidate as T
    } catch (caughtFailure) { log(('[sessions] SESSION_RESPONSE_INVALID') + ' · ' + errorKind(caughtFailure)); return fallback }
    apply(accepted)
    return accepted
  }
  const agentReply = (value: unknown, service: string): value is SessionFrame => record(value) && identifier(value.id)
    && value.sessionId === value.id && serviceFor(value.engine) === service && typeof value.name === 'string' && value.name.length <= 120
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
  const row = (owner: Owner): ServiceSessionRow => ({
    agentId: sessionOwnerId(owner), sessionId: sessionOwnerId(owner), engine: sessionOwnerFactory(owner),
    displayName: readSessionFact(owner, 'name'), defaultName: readSessionFact(owner, 'name'), runtimeProfile: readSessionFact(owner, 'selectedModel') ?? null,
    registeredAt: Date.parse(sessionOwnerCreatedAt(owner)), lastHookAt: Date.parse(readSessionFact(owner, 'updatedAt')), active: true,
    tmuxPane: '', cwd: '', projectDir: '', transcriptPath: null, runtimes: [], primaryRuntimeKey: '',
  })
  const ids = function* (): IterableIterator<string> {
    for (const owner of owners.values()) if (current(owner) && readSessionFact(owner, 'status') !== 'stopped') yield sessionOwnerId(owner)
  }
  return {
    bound, nativeEntered, stop: staging.stop,
    frames: (): SessionFrame[] => [...owners.values()].filter(current).map(retainedSessionFrame),
    owns: (id: string): boolean => owned(id) !== undefined,
    recent: (id: string): Array<{ kind: 'summary'; recap: string; text: string; fullText: string }> | null => {
      const owner = owned(id)
      if (!owner) return null
      const turn = readSessionFact(owner, 'turn')
      return turn?.card ? [{ kind: 'summary', ...turn.card, fullText: turn.fullText }] : []
    },
    said: (id: string): string | undefined => { const owner = owned(id); return owner ? readSessionFact(owner, 'turn')?.fullText : undefined },
    activity: (id: string): string | null => { const owner = owned(id); return owner ? readSessionFact(owner, 'work')?.text ?? null : null },
    activitySnapshot: (id: string): { text: string; elapsedSeconds?: number } | null => {
      const owner = owned(id), work = owner && readSessionFact(owner, 'work')
      return work && (work.snapshot === true || !!work.text) ? { text: work.text ?? '',
        ...(work.elapsedSeconds === undefined ? {} : { elapsedSeconds: work.elapsedSeconds }) } : null
    },
    liveCards: (): OwnerCard[] => {
      const cards: OwnerCard[] = []
      for (const owner of owners.values()) if (current(owner)) {
        const work = readSessionFact(owner, 'work')
        if (work?.processing) cards.push({ type: 'commander_event', agentId: sessionOwnerId(owner), dbSessionId: sessionOwnerId(owner),
          payload: { kind: 'processing', text: work.processing.text ?? work.text ?? '' } })
      }
      return cards
    },
    rows: (): ServiceSessionRow[] => Array.from(ids(), id => row(owners.get(id)!)), ids,
    row: (id: string): ServiceSessionRow | undefined => {
      const owner = owned(id)
      return owner && readSessionFact(owner, 'status') !== 'stopped' ? row(owner) : undefined
    },
    create(payload: Record<string, unknown>): Promise<Record<string, unknown>> | null {
      const service = serviceFor(payload.engine)
      return !service ? null : call(service, target => target.create(payload), OWNER_REPLY_DOWN, result => refusal(result)
        || fields(result, ['agent']) && agentReply(result.agent, service) && result.agent.engine === payload.engine)
    },
    deliver(id: string, text: string): Promise<OwnerDelivery> | null {
      const owner = owned(id), service = owner && serviceFor(sessionOwnerFactory(owner))
      return !owner || !service ? null : call(service, target => target.deliver(id, text), OWNER_DOWN,
        result => record(result) && (result.ok === true || result.ok === false && typeof result.error === 'string'), () => current(owner))
    },
    answer(payload: { requestId?: unknown; answers?: unknown }): Promise<QuestionAnswerResult> | null {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '', question = questions.request(requestId)
      const id = question?.owner === questionOwner ? question.key : undefined, owner = id ? owned(id) : undefined
      const service = owner && serviceFor(sessionOwnerFactory(owner))
      if (!id || !owner || !service || questions.current(id) !== question) return null
      const answers = Object.fromEntries(Object.entries(payload.answers && typeof payload.answers === 'object' ? payload.answers : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      return call(service, target => target.answer(id, requestId, answers), OWNER_ANSWER_DOWN, answerReply,
        phase => current(owner) && (phase === 'result' || questions.current(id) === question))
    },
    update(payload: Record<string, unknown>): Promise<Record<string, unknown>> | null {
      const id = typeof payload.agentId === 'string' ? payload.agentId : '', owner = owned(id)
      const service = owner && serviceFor(sessionOwnerFactory(owner))
      if (!owner || !service) return null
      if (!Object.hasOwn(payload, 'name')) return Promise.resolve(payload.opened === true ? { agent: retainedSessionFrame(owner) } : { error: 'MISSING_UPDATE' })
      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : ''
      if (!name) return Promise.resolve({ error: 'MISSING_NAME' })
      return call(service, target => target.rename(id, name, detached(sessionFactsWire(owner), 512 * 1024) as ReturnType<typeof sessionFactsWire>), OWNER_REPLY_DOWN,
        result => refusal(result) || fields(result, ['agent', 'renamed']) && agentReply(result.agent, service)
          && result.agent.id === id && result.agent.engine === sessionOwnerFactory(owner) && result.agent.createdAt === sessionOwnerCreatedAt(owner)
          && result.agent.name === name && fields(result.renamed, ['type', 'payload']) && result.renamed.type === 'agent_renamed'
          && fields(result.renamed.payload, ['agentId', 'name', 'engine']) && result.renamed.payload.agentId === id
          && result.renamed.payload.name === name && result.renamed.payload.engine === sessionOwnerFactory(owner),
        () => current(owner), result => {
          if ('renamed' in result) { clients.send(result.renamed); clients.sendCommander(result.renamed) }
        }).then(result => 'agent' in result ? { agent: result.agent } : result)
    },
    stopOwner(id: string, quickMs = 3_000): Promise<Record<string, unknown>> | null {
      const owner = owned(id), service = owner && serviceFor(sessionOwnerFactory(owner))
      if (!owner || !service) return null
      const stopped = call(service, target => target.stopHarness(id), OWNER_REPLY_DOWN, stopReply, () => current(owner))
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopping = new Promise<Record<string, unknown>>(resolve => {
        timer = setTimeout(() => resolve(current(owner)
          ? { deleted: true, detail: 'Stopping. Its pane says when it has.' } : OWNER_REPLY_DOWN), quickMs)
        timer.unref?.()
      })
      return Promise.race([stopped, stopping]).finally(() => clearTimeout(timer))
    },
  }
}
export type SessionOwners = ReturnType<typeof createSessionOwners>
