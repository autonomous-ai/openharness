/**
 * Agents a service owns: the cloud agents (docs/design/2026-10-11-cloud-agents.md, "The one core change").
 * They have no pane, so they are never registry rows. The cloud service publishes them through `core.cloud`
 * (`doors`); the core keeps the last list, sends each change to the apps and the dial as any agent's frame
 * (`location: 'cloud'`), and puts their questions wherever questions show. What a person does to one comes
 * back here first: a New Harness for a cloud agent, words for it, an answer to its question, a rename and Stop
 * are handed to the service's port, and everything else goes on to the terminal agents' own paths.
 *
 * The dial reads a turn from its cards (lib/commander.ts): working as it starts, its answer as it ends. A cloud
 * harness has no turns to read, so its cards are made here, from what changes between two lists.
 */
import type { CloudCore, CloudPort, CloudResult } from '../api.js'
import { CLOUD_DOWN } from '../api.js'
import { cloudAgentFrame, cloudHarnessIn, isCloudAgent, type CloudAgentFrame, type CloudHarness } from '../../lib/cloudAgents.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import type { QuestionAnswerResult } from '../../lib/questionController.js'
import { deriveTurnSummary } from '../../lib/deviceRecap.js'
import { splitSummary } from '../../lib/recapReads.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface CloudAgentsDeps {
  /** The cloud service's port, or null while it is off. */
  port: () => CloudPort | null
  /** Every client (`send`), the dial (`sendCommander`) and the windows on this computer (`sendLocal`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void; sendLocal(frame: Frame): void }
  /** What is still being asked, by agent, for a window that connects later (core/questions.ts). */
  openQuestions: Map<string, Record<string, unknown>>
  deviceInput: Pick<AutonomousDeviceInput, 'setUserAction'>
  log?: (line: string) => void
}

const DOWN = async (): Promise<typeof CLOUD_DOWN> => CLOUD_DOWN
const busy = (harness: CloudHarness): boolean => harness.state === 'working' || harness.state === 'starting'
/** Its last words as the dial's recap and the text under it, or null when it has said nothing. */
const recapOf = (harness: CloudHarness): { recap: string; text: string } | null => {
  const summary = harness.said ? deriveTurnSummary(harness.said) : null
  if (!summary) return null
  const { recap, body } = splitSummary(summary)
  return { recap, text: body }
}

export function createCloudAgents({ port, clients, openQuestions, deviceInput, log = (line) => console.log(line) }: CloudAgentsDeps) {
  let harnesses = new Map<string, CloudHarness>()
  /** Each open question's agent, by request id: an answer to one of these goes to the service. */
  const asked = new Map<string, string>()
  /** The questions the dial was shown: only those with choices, since its question screen takes no words. */
  const onDial = new Set<string>()
  /** The last words each harness's card told, so a list told again is not told twice. */
  const told = new Map<string, string>()

  const card = (harness: CloudHarness, payload: Record<string, unknown>): void => {
    // The name rides a summary's outer frame, as a terminal agent's does: a notification's second line.
    clients.sendCommander({ type: 'commander_event', agentId: harness.agentId, dbSessionId: harness.agentId, ...(payload.kind === 'summary' ? { name: harness.name } : {}), payload })
  }
  /**
   * Its cards, from one list to the next: working as it starts; once it stops, what it said, or done. First seen
   * (new, or a list told again whole after a restart), what it said is not news: the dial restores its tile by
   * `recent`. Working is, since the tile is idle until told.
   */
  const cards = (before: CloudHarness | undefined, harness: CloudHarness): void => {
    if (!before) told.set(harness.agentId, harness.said ?? '')
    // Stopped, it leaves the dial's wheel (`sync`): there is no tile to tell.
    if (harness.state === 'stopped') return
    if (busy(harness)) {
      if (!before || !busy(before)) card(harness, { kind: 'processing', text: harness.activity ?? 'Working…' })
      return
    }
    if (!before) return
    const recap = recapOf(harness)
    if (recap && harness.said !== told.get(harness.agentId)) {
      told.set(harness.agentId, harness.said!)
      // Waiting on the person, its question rings instead (lib/agentNotifications.ts keeps the same rule).
      card(harness, { kind: 'summary', ...recap, ...(harness.state === 'failed' ? { failed: true } : {}), notification: harness.state === 'needs_input' ? null : { id: `${harness.agentId}:${harness.messages}`, kind: 'done' } })
    } else if (busy(before)) {
      card(harness, harness.state === 'failed' ? { kind: 'error', text: harness.activity ?? 'It stopped with an error.' } : { kind: 'done', text: 'done' })
    }
  }

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

  const doors: CloudCore = {
    publish(list) {
      const next = new Map<string, CloudHarness>()
      for (const raw of Array.isArray(list) ? list : []) {
        const harness = cloudHarnessIn(raw)
        if (harness) next.set(harness.agentId, harness)
      }
      const before = harnesses
      harnesses = next
      for (const [agentId, harness] of next) {
        const prior = before.get(agentId)
        if (JSON.stringify(prior) === JSON.stringify(harness)) continue
        sync(harness)
        cards(prior, harness)
      }
      for (const agentId of before.keys()) if (!next.has(agentId)) { told.delete(agentId); gone(agentId) }
    },
    ask(agentId, requestId, question) {
      if (!harnesses.has(agentId) || typeof requestId !== 'string' || !requestId.startsWith('cloud_q_') || typeof question?.text !== 'string') return
      const choices = (Array.isArray(question.choices) ? question.choices : []).filter((choice): choice is string => typeof choice === 'string' && !!choice).slice(0, 6)
      asked.set(requestId, agentId)
      const frame: Frame = {
        type: 'commander_question', agentId, dbSessionId: agentId,
        // As a terminal agent's question (core/questions.ts): one key, its choices, and free text, which the
        // windows take and the dial does not.
        payload: { requestId, questions: [{ key: 'answer', q: question.text.slice(0, 500), options: choices, multi: false, canText: true }], notification: { id: requestId, kind: 'needsYou' } },
      }
      deviceInput.setUserAction(agentId, true)
      if (choices.length) {
        onDial.add(requestId)
        clients.sendCommander(frame)
      }
      clients.sendLocal(frame)
      openQuestions.set(agentId, frame)
      log(`[cloud] ${agentId} asking the person · req=${requestId}`)
    },
    unask(agentId, requestId) {
      if (asked.get(requestId) !== agentId) return
      asked.delete(requestId)
      const frame: Frame = { type: 'commander_question_close', agentId, dbSessionId: agentId, payload: { requestId } }
      deviceInput.setUserAction(agentId, false)
      if (onDial.delete(requestId)) clients.sendCommander(frame)
      clients.sendLocal(frame)
      openQuestions.delete(agentId)
    },
  }

  const call = async <T>(work: (cloud: CloudPort) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    const cloud = port()
    return cloud ? work(cloud) : fallback()
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
      return call((cloud) => cloud.create(payload), DOWN).then((result) => (result.ok ? { agent: result.agent } : { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }))
    },
    /** Words for a cloud harness; null when it is not one. */
    deliver(agentId: string, text: string): Promise<CloudResult> | null {
      if (!harnesses.has(agentId)) return null
      return call((cloud) => cloud.deliver(agentId, text), DOWN)
    },
    /** `question_response` to a cloud harness's question, answered as a terminal agent's is; null when it is not one. */
    answer(payload: { requestId?: unknown; answers?: unknown }): Promise<QuestionAnswerResult> | null {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const agentId = asked.get(requestId)
      if (!agentId) return null
      const answers = Object.fromEntries(Object.entries(payload.answers && typeof payload.answers === 'object' ? payload.answers : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      return call((cloud) => cloud.answer(agentId, requestId, answers), DOWN)
        .then((result): QuestionAnswerResult => (result.ok ? { ok: true }
          : { ok: false, error: result.error === 'STALE_QUESTION' ? 'STALE_QUESTION' : 'ANSWER_FAILED', detail: result.detail ?? '' }))
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
      return call((cloud) => cloud.rename(agentId, name), DOWN).then((result) => {
        if (!result.ok) return { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
        // As a terminal agent's rename is told; the service's next list says it again, which changes nothing.
        const renamed: Frame = { type: 'agent_renamed', payload: { agentId, name, engine: harness.agent } }
        clients.send(renamed)
        clients.sendCommander(renamed)
        return { agent: cloudAgentFrame({ ...harness, name }) }
      })
    },
    /**
     * Stop Harness for a cloud harness, answered as `agent_delete` is; null when it is not one. The socket waits
     * on this in the connection's line, so a maker slower than a few seconds is answered "stopping" and its
     * harness's frame says when it has: the window's other requests never wait behind a vendor.
     */
    stop(agentId: string, quickMs = 3_000): Promise<Record<string, unknown>> | null {
      if (!harnesses.has(agentId)) return null
      const stopped = call((cloud) => cloud.stopHarness(agentId), DOWN)
        .then((result) => (result.ok ? { deleted: true, ...(result.detail ? { detail: result.detail } : {}) } : { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }))
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
