/**
 * Agents a service owns: the cloud agents (docs/design/2026-10-11-cloud-agents.md, "The one core change").
 * They have no pane, so they are never registry rows. The cloud service publishes them through `core.cloud`
 * (`doors`); the core keeps the last list, sends each change to the apps and the dial as any agent's frame
 * (`location: 'cloud'`), and puts their questions wherever questions show. What a person does to one comes
 * back here first: a New Harness for a cloud agent, words for it, an answer to its question, a rename and Stop
 * are handed to the service's port, and everything else goes on to the terminal agents' own paths.
 *
 * The Cloud component prepares its cards. Core admits them against the published owners and forwards them.
 */
import type { CloudCore, CloudPort, CloudResult, CloudQuestionClose, CloudQuestionPresentation, TurnCardFrame } from '../api.js'
import { CLOUD_DOWN, CLOUD_REPLY_DOWN, CLOUD_ANSWER_DOWN } from '../api.js'
import { cloudAgentFrame, cloudFingerprint, cloudHarnessIn, isCloudAgent, type CloudAgentFrame, type CloudHarness } from '../../lib/cloudAgents.js'
import { boundedJsonBytes } from '../../lib/boundedJsonBytes.js'
import type { QuestionAnswerResult } from '../../lib/questionController.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface CloudAgentsDeps {
  /** The cloud service's port, or null while it is off. */
  port: () => CloudPort | null
  /** Existing bounded first-start readiness; capture authority only after the first connection exists. */
  whenStarting?: () => Promise<boolean> | null
  /** Every client (`send`), the dial (`sendCommander`) and the windows on this computer (`sendLocal`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void; sendLocal(frame: Frame): void }
  /** What is still being asked, by agent, for a window that connects later (core/questions.ts). */
  openQuestions: Map<string, Record<string, unknown>>
  log?: (line: string) => void
}

const busy = (harness: CloudHarness): boolean => harness.state === 'working' || harness.state === 'starting'
/** Legacy stored rows are rendered by the component before this private cohort publishes them. */
const recapOf = (harness: CloudHarness) => harness.said ? harness.card ?? null : null

function admittedCards(value: unknown, owners: ReadonlyMap<string, CloudHarness>): value is TurnCardFrame[] {
  if (!Array.isArray(value) || value.length > owners.size) return false
  const seen = new Set<string>()
  return value.every(frame => {
    if (!frame || frame.type !== 'commander_event' || typeof frame.agentId !== 'string'
      || frame.dbSessionId !== frame.agentId || !owners.has(frame.agentId) || seen.has(frame.agentId)
      || frame.name !== undefined && frame.name !== owners.get(frame.agentId)!.name
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) return false
    seen.add(frame.agentId)
    return true
  })
}

const fields = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function admittedClose(value: unknown, agentId: string, requestId: string): value is CloudQuestionClose {
  if (!fields(value, ['type', 'agentId', 'dbSessionId', 'payload']) || value.type !== 'commander_question_close'
    || value.agentId !== agentId || value.dbSessionId !== agentId || !fields(value.payload, ['requestId'])
    || value.payload.requestId !== requestId) return false
  return Buffer.byteLength(JSON.stringify(value)) <= 1024
}
function admittedQuestion(value: unknown, agentId: string, requestId: string): value is CloudQuestionPresentation {
  if (!fields(value, ['frame', 'close', 'dial']) || typeof value.dial !== 'boolean' || !admittedClose(value.close, agentId, requestId)) return false
  const frame = value.frame
  if (!fields(frame, ['type', 'agentId', 'dbSessionId', 'payload']) || frame.type !== 'commander_question'
    || frame.agentId !== agentId || frame.dbSessionId !== agentId || !fields(frame.payload, ['requestId', 'questions', 'notification'])
    || frame.payload.requestId !== requestId || !fields(frame.payload.notification, ['id', 'kind'])
    || frame.payload.notification.id !== requestId || frame.payload.notification.kind !== 'needsYou'
    || !Array.isArray(frame.payload.questions) || frame.payload.questions.length !== 1) return false
  const question = frame.payload.questions[0]
  if (!fields(question, ['key', 'q', 'options', 'multi', 'canText']) || question.key !== 'answer'
    || typeof question.q !== 'string' || question.q.length > 500 || question.multi !== false || question.canText !== true
    || !Array.isArray(question.options) || question.options.length > 6
    || !Array.from(question.options).every(option => typeof option === 'string' && option.length > 0 && option.length <= 500)
    || value.dial && !question.options.length) return false
  return Buffer.byteLength(JSON.stringify(value)) <= 22 * 1024
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refusal = (value: unknown): boolean => record(value) && typeof value.error === 'string' && !!value.error
  && (value.detail === undefined || typeof value.detail === 'string') && Object.keys(value).every(key => key === 'error' || key === 'detail')
const agentReply = (value: unknown): value is CloudAgentFrame => record(value) && typeof value.id === 'string'
  && value.id.startsWith('cloud_') && value.id.length <= 80 && value.sessionId === value.id && isCloudAgent(value.engine)
  && value.location === 'cloud' && typeof value.name === 'string' && value.name.length <= 120 && typeof value.createdAt === 'string'
const answerReply = (value: unknown): boolean => fields(value, ['ok']) && value.ok === true
  || fields(value, ['ok', 'error', 'detail']) && value.ok === false
    && (value.error === 'STALE_QUESTION' || value.error === 'ANSWER_FAILED') && typeof value.detail === 'string'
const stopReply = (value: unknown): boolean => refusal(value) || record(value) && value.deleted === true
  && (value.detail === undefined || typeof value.detail === 'string') && Object.keys(value).every(key => key === 'deleted' || key === 'detail')

export function createCloudAgents({ port, whenStarting, clients, openQuestions, log = (line) => console.log(line) }: CloudAgentsDeps) {
  let harnesses = new Map<string, CloudHarness>()
  /** One accepted request per owner; its original close destination survives reconnects and replacement. */
  const asked = new Map<string, { agentId: string; close: CloudQuestionClose; dial: boolean }>()
  const retire = (requestId: string): void => {
    const prior = asked.get(requestId)!
    asked.delete(requestId)
    if (prior.dial) clients.sendCommander(prior.close)
    clients.sendLocal(prior.close)
    if ((openQuestions.get(prior.agentId)?.payload as { requestId?: unknown } | undefined)?.requestId === requestId) openQuestions.delete(prior.agentId)
  }
  const currentRequest = (agentId: string): string | undefined => (openQuestions.get(agentId)?.payload as { requestId?: string } | undefined)?.requestId
  const invalidQuestion = () => { log('[cloud] CLOUD_QUESTION_INVALID'); return { ok: false, error: 'CLOUD_QUESTION_INVALID' } as const }

  const sync = (harness: CloudHarness): void => {
    const frame: Frame = { type: 'agent_synced', payload: { agent: cloudAgentFrame(harness) } }
    clients.send(frame)
    // The dial lists the harnesses it can drive: a stopped one leaves its wheel.
    clients.sendCommander(harness.state === 'stopped' ? { type: 'agent_deleted', payload: { agentId: harness.agentId } } : frame)
  }
  const gone = (agentId: string): void => {
    const frame: Frame = { type: 'agent_deleted', payload: { agentId } }
    clients.send(frame)
    clients.sendCommander(frame)
  }

  const invalid = () => { log('[cloud] CLOUD_PUBLICATION_INVALID'); return { ok: false, error: 'CLOUD_PUBLICATION_INVALID' } as const }
  const doors: CloudCore = {
    checkpoint: () => cloudFingerprint([...harnesses.values()]),
    publish(list, cards = []) {
      if (!Array.isArray(list)) return invalid()
      const next = new Map<string, CloudHarness>()
      for (const raw of list) {
        const harness = cloudHarnessIn(raw)
        if (!harness || next.has(harness.agentId)) return invalid()
        next.set(harness.agentId, harness)
      }
      if (!admittedCards(cards, next)) return invalid()
      const byOwner = new Map(cards.map(card => [card.agentId, card]))
      const before = harnesses
      harnesses = next
      for (const [agentId, harness] of next) {
        const prior = before.get(agentId)
        if (JSON.stringify(prior) === JSON.stringify(harness)) continue
        sync(harness)
        const frame = byOwner.get(agentId)
        if (frame) clients.sendCommander({ type: frame.type, agentId: frame.agentId,
          dbSessionId: frame.dbSessionId, ...(frame.name !== undefined ? { name: frame.name } : {}), payload: frame.payload })
      }
      for (const agentId of before.keys()) if (!next.has(agentId)) {
        const requestId = currentRequest(agentId)
        if (requestId && asked.has(requestId)) retire(requestId)
        gone(agentId)
      }
      return { ok: true }
    },
    ask(agentId, requestId, question) {
      if (!harnesses.has(agentId) || typeof requestId !== 'string' || !requestId.startsWith('cloud_q_') || requestId.length > 80
        || !admittedQuestion(question, agentId, requestId)) return invalidQuestion()
      const prior = asked.get(requestId)
      if (prior && (prior.agentId !== agentId || question.dial && !prior.dial
        || JSON.stringify(openQuestions.get(agentId)) !== JSON.stringify(question.frame))) return invalidQuestion()
      // Inline callers retain their own objects. Keep only admitted immutable wire bytes, as IPC already does.
      const presentation: CloudQuestionPresentation = JSON.parse(JSON.stringify(question))
      const oldRequest = currentRequest(agentId)
      if (oldRequest && oldRequest !== requestId && asked.has(oldRequest)) retire(oldRequest)
      asked.set(requestId, prior ?? { agentId, close: presentation.close, dial: presentation.dial })
      if (presentation.dial) clients.sendCommander(presentation.frame)
      clients.sendLocal(presentation.frame)
      openQuestions.set(agentId, presentation.frame as unknown as Record<string, unknown>)
      log('[cloud] question accepted')
      return { ok: true }
    },
    unask(agentId, requestId, close) {
      if (typeof agentId !== 'string' || !agentId.startsWith('cloud_') || agentId.length > 80 || typeof requestId !== 'string' || !requestId.startsWith('cloud_q_') || requestId.length > 80
        || !admittedClose(close, agentId, requestId)) return invalidQuestion()
      const prior = asked.get(requestId)
      if (!prior) return { ok: true }
      if (prior.agentId !== agentId || !harnesses.has(agentId)) return invalidQuestion()
      retire(requestId)
      return { ok: true }
    },
  }

  const call = async <T>(work: (cloud: CloudPort) => Promise<T>, fallback: T, admit: (value: unknown) => boolean,
    current = () => true, apply = (_value: T): void => {}): Promise<T> => {
    const starting = whenStarting?.()
    if (starting && !await starting) return fallback
    const cloud = port()
    if (!cloud || !current()) return fallback
    const result = await work(cloud)
    // The final physical-connection and owner check shares the synchronous continuation with its effects.
    if (port() !== cloud || !current()) return fallback
    if (boundedJsonBytes(result, 256 * 1024) === null || !admit(result)) {
      log('[cloud] CLOUD_RESPONSE_INVALID')
      return fallback
    }
    const accepted: T = JSON.parse(JSON.stringify(result))
    apply(accepted)
    return accepted
  }

  return {
    doors,
    /** Every cloud harness's frame, for `agents_list`. */
    frames: (): CloudAgentFrame[] => [...harnesses.values()].map(cloudAgentFrame),
    owns: (agentId: string): boolean => harnesses.has(agentId),
    /** Its last turn as the dial restores a tile (`agent_recent`), what it said; null when it is not one. */
    recent: (agentId: string): Array<{ kind: 'summary'; recap: string; text: string; fullText: string }> | null => {
      const harness = harnesses.get(agentId)
      if (!harness) return null
      const recap = recapOf(harness)
      return recap ? [{ kind: 'summary', ...recap, fullText: harness.said! }] : []
    },
    /** All it said last, for a dial that draws a long recap; undefined when it is not one or said nothing. */
    said: (agentId: string): string | undefined => harnesses.get(agentId)?.said ?? undefined,
    /** The working cards, for a dial attaching mid-turn. */
    liveCards: (): Frame[] => [...harnesses.values()].filter(busy).map((harness) => ({
      type: 'commander_event', agentId: harness.agentId, dbSessionId: harness.agentId, payload: { kind: 'processing', text: harness.activity ?? 'Working…' },
    })),
    /** What a working cloud harness is doing, for the dial's working card; null when it says nothing. */
    activity: (agentId: string): string | null => {
      const harness = harnesses.get(agentId)
      return harness && (harness.state === 'working' || harness.state === 'starting') ? harness.activity : null
    },
    /**
     * The running cloud harnesses as the dial lists agents (services/fleetRouter.ts reads an agent's id, its
     * start, its engine and its name): rows with no pane, no transcript and no process, so nothing that reads a
     * terminal agent's files finds one to read. A stopped one is off the wheel, as a stopped agent is.
     */
    dialRows: (): Array<Record<string, unknown>> => [...harnesses.values()].filter((harness) => harness.state !== 'stopped').map((harness) => ({
      agentId: harness.agentId, sessionId: harness.agentId, engine: harness.agent, displayName: harness.name, defaultName: harness.name, runtimeProfile: null,
      registeredAt: Date.parse(harness.createdAt), lastHookAt: Date.parse(harness.updatedAt), active: true,
      tmuxPane: '', cwd: '', projectDir: '', transcriptPath: null, runtimes: [], primaryRuntimeKey: '',
    })),
    /** `agent_create` for a cloud agent, answered as the socket answers one (`{ agent }`, or the refusal); null for any other engine. */
    create(payload: Record<string, unknown>): Promise<Record<string, unknown>> | null {
      if (!isCloudAgent(payload.engine)) return null
      return call(cloud => cloud.create(payload), CLOUD_REPLY_DOWN, result => refusal(result)
        || fields(result, ['agent']) && agentReply(result.agent) && result.agent.engine === payload.engine)
    },
    /** Words for a cloud harness; null when it is not one. */
    deliver(agentId: string, text: string): Promise<CloudResult> | null {
      if (!harnesses.has(agentId)) return null
      return call(cloud => cloud.deliver(agentId, text), CLOUD_DOWN, result => record(result) && (result.ok === true || result.ok === false && typeof result.error === 'string'))
    },
    /** `question_response` to a cloud harness's question, answered as a terminal agent's is; null when it is not one. */
    answer(payload: { requestId?: unknown; answers?: unknown }): Promise<QuestionAnswerResult> | null {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const agentId = asked.get(requestId)?.agentId
      if (!agentId || !harnesses.has(agentId) || currentRequest(agentId) !== requestId) return null
      const answers = Object.fromEntries(Object.entries(payload.answers && typeof payload.answers === 'object' ? payload.answers : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      return call(cloud => cloud.answer(agentId, requestId, answers), CLOUD_ANSWER_DOWN, answerReply)
    },
    /**
     * `agent_update` for a cloud harness, answered as a terminal agent's is (core/agents/update.ts): its frame
     * after a rename, told to every window and the dial; its frame as it stands for an app opening it, since
     * nothing here keeps a "last used"; null when it is not one. It has no model to move.
     */
    update(payload: Record<string, unknown>): Promise<Record<string, unknown>> | null {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
      const harness = harnesses.get(agentId)
      if (!harness) return null
      if (!Object.prototype.hasOwnProperty.call(payload, 'name')) {
        return Promise.resolve(payload.opened === true ? { agent: cloudAgentFrame(harness) } : { error: 'MISSING_UPDATE' })
      }
      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : ''
      if (!name) return Promise.resolve({ error: 'MISSING_NAME' })
      const current = () => {
        const owner = harnesses.get(agentId)
        return owner?.agent === harness.agent && owner.createdAt === harness.createdAt
      }
      return call(cloud => cloud.rename(agentId, name, JSON.parse(JSON.stringify(harness))), CLOUD_REPLY_DOWN,
        result => refusal(result) || fields(result, ['agent', 'renamed']) && agentReply(result.agent)
          && result.agent.id === agentId && result.agent.engine === harness.agent && result.agent.createdAt === harness.createdAt
          && result.agent.name === name && fields(result.renamed, ['type', 'payload']) && result.renamed.type === 'agent_renamed'
          && fields(result.renamed.payload, ['agentId', 'name', 'engine']) && result.renamed.payload.agentId === agentId
          && result.renamed.payload.name === name && result.renamed.payload.engine === harness.agent,
        current, result => {
          if ('renamed' in result) { clients.send(result.renamed); clients.sendCommander(result.renamed) }
        }).then(result => 'agent' in result ? { agent: result.agent } : result)
    },
    /**
     * Stop Harness for a cloud harness, answered as `agent_delete` is; null when it is not one. The socket waits
     * on this in the connection's line, so a maker slower than a few seconds is answered "stopping" and its
     * harness's frame says when it has: the window's other requests never wait behind a vendor.
     */
    stop(agentId: string, quickMs = 3_000): Promise<Record<string, unknown>> | null {
      if (!harnesses.has(agentId)) return null
      const stopped = call(cloud => cloud.stopHarness(agentId), CLOUD_REPLY_DOWN, stopReply)
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopping = new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => resolve({ deleted: true, detail: 'Stopping. Its pane says when it has.' }), quickMs)
        timer.unref?.()
      })
      return Promise.race([stopped, stopping]).finally(() => clearTimeout(timer))
    },
  }
}

export type CloudAgents = ReturnType<typeof createCloudAgents>
