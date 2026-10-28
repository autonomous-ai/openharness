/**
 * Cloud agents (docs/design/2026-10-11-cloud-agents.md): harnesses that run on their maker's servers. This
 * service owns them. It starts one through its adapter, keeps its conversation, looks at the maker while it
 * works, and tells the core every change (`core.cloud`), which lists them with the terminal agents and puts
 * their questions in front of the person.
 *
 * - Its harnesses and their makers' ids are in `<data>/cloud/harnesses.json`, and each conversation in
 *   `<data>/cloud/<agentId>.jsonl`: the core's experiment start finds the first and wakes this service.
 * - It looks every 10 s while one works, 30 s while it waits on the person, and not at all once it is idle,
 *   stopped or failed, until the person writes to it. Fo's reply is a long wait of its own (`waited`).
 * - Nothing here holds a credential: each call goes through the Connections bridge (cloud/bridge.ts).
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CloudCore, CloudPort, CloudResult, ServiceRequests } from '../core/api.js'
import { CLOUD_AGENT_IDS, CLOUD_AGENTS, SAID_MAX, cloudAgentFrame, cloudRequestRefusal, isCloudAgent, repositoryOf, type CloudAgentId, type CloudHarness } from '../lib/cloudAgents.js'
import { connectionFor, connectionsBridge, type Bridge } from './bridge.js'
import { cursorAdapter } from './cursor.js'
import { devinAdapter } from './devin.js'
import { foAdapter } from './fo.js'
import { McpClient } from './mcp.js'
import { CloudError, type CloudAdapter, type CloudUpdate, type Remote } from './types.js'

interface Entry {
  harness: CloudHarness
  remote: Remote
  question: { requestId: string; text: string; choices: string[] } | null
  /** When it last changed: one unchanged for a day is no longer looked at. */
  changedAt: number
  failures: number
  /** Whether the agent has said anything since the person last wrote: until it has, a maker still reporting
   *  "waiting for you" is reporting the wait the person just answered (core rule 6, evidence newer than state). */
  heard: boolean
  /** The New Harness that made it (`creationId`): a retry of the same one gets this harness, never a second. */
  creationId?: string
}

export interface TranscriptMessage { id: string; from: 'agent' | 'person'; text: string; at: string }

export interface CloudServiceOptions {
  dataDir: string
  core: CloudCore
  bridge?: Bridge
  /** Swapped in tests for fakes of the makers. */
  adapters?: Partial<Record<CloudAgentId, CloudAdapter>>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  log?: (line: string) => void
}

const WORKING_MS = 10_000
const WAITING_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60_000
const QUIET_MS = 24 * 60 * 60_000
/** The least time between looks, even for a maker that waits for news itself: one that answers at once must
 *  never be asked again at once, for a day. */
const LOOK_MIN_MS = 5_000
const TRANSCRIPT_MAX = 500

/** A harness's name from its task: its first line, short. */
export function nameFor(task: string, agent: CloudAgentId): string {
  const line = task.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line ? (line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line) : CLOUD_AGENTS[agent].name
}

export function startCloudService(options: CloudServiceOptions) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const log = options.log ?? ((line: string) => console.log(line))
  const bridge = options.bridge ?? connectionsBridge()
  const dir = join(options.dataDir, 'cloud')
  const stateFile = join(dir, 'harnesses.json')
  const entries = new Map<string, Entry>()
  const timers = new Map<string, unknown>()
  /** One thing at a time per harness: a look and a message never cross. */
  const queues = new Map<string, Promise<unknown>>()
  /** The look in flight, by harness: the person's words cut short a long wait (Fo's reply waits 40 s) rather
   *  than queue behind it. */
  const looking = new Map<string, AbortController>()
  const interrupt = (agentId: string): void => { looking.get(agentId)?.abort() }
  let stopped = false

  // Each maker's connection, found by where it points, for a minute at a time; a refusal finds it again.
  const codes = new Map<CloudAgentId, { code: string; at: number }>()
  const codeFor = (agent: CloudAgentId) => async (): Promise<string> => {
    const known = codes.get(agent)
    if (known && now() - known.at < 60_000) return known.code
    const { code } = await connectionFor(bridge, agent)
    codes.set(agent, { code, at: now() })
    return code
  }
  const mcpClients = new Map<string, McpClient>()
  const adapters: Record<CloudAgentId, CloudAdapter> = {
    fo: options.adapters?.fo ?? foAdapter(async () => {
      const url = bridge.mcpUrl(await codeFor('fo')())
      let client = mcpClients.get(url)
      if (!client) { client = new McpClient(url, CLOUD_AGENTS.fo.name); mcpClients.set(url, client) }
      return client
    }),
    'devin-cloud': options.adapters?.['devin-cloud'] ?? devinAdapter(bridge, codeFor('devin-cloud')),
    'cursor-cloud': options.adapters?.['cursor-cloud'] ?? cursorAdapter(bridge, codeFor('cursor-cloud')),
  }

  const transcriptFile = (agentId: string): string => join(dir, `${agentId}.jsonl`)
  const save = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ harnesses: [...entries.values()].map(({ harness, remote, question, changedAt, creationId }) => ({ harness, remote, question, changedAt, creationId })) }), { mode: 0o600 })
    renameSync(temp, stateFile)
  }
  const transcript = (agentId: string): TranscriptMessage[] => {
    try {
      return readFileSync(transcriptFile(agentId), 'utf8').split('\n').flatMap((line) => {
        try { return line ? [JSON.parse(line) as TranscriptMessage] : [] } catch { return [] }
      })
    } catch { return [] }
  }
  const record = (entry: Entry, message: TranscriptMessage): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(transcriptFile(entry.harness.agentId), `${JSON.stringify(message)}\n`, { mode: 0o600 })
    entry.harness.messages += 1
    if (message.from === 'agent') entry.harness.said = message.text.slice(0, SAID_MAX)
  }

  const publish = (): void => {
    if (stopped) return
    options.core.publish([...entries.values()].map((entry) => ({ ...entry.harness, links: [...entry.harness.links] })))
  }
  const touched = (entry: Entry): void => {
    entry.harness.updatedAt = new Date(now()).toISOString()
    entry.changedAt = now()
    save()
    publish()
  }
  const serial = <T>(agentId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(agentId) ?? Promise.resolve()).catch(() => {}).then(work)
    queues.set(agentId, run)
    return run
  }

  const ask = (entry: Entry, question: { text: string; choices: string[] } | null): void => {
    const asked = entry.question
    if (asked && question && asked.text === question.text && asked.choices.join('\n') === question.choices.join('\n')) return
    if (asked) { options.core.unask(entry.harness.agentId, asked.requestId); entry.question = null }
    if (!question) return
    entry.question = { requestId: `cloud_q_${randomBytes(6).toString('hex')}`, ...question }
    options.core.ask(entry.harness.agentId, entry.question.requestId, question)
  }

  /** What one look found, applied: new messages recorded, where it is now, and its question. */
  const apply = (entry: Entry, update: CloudUpdate): boolean => {
    const before = JSON.stringify([entry.harness, entry.remote, entry.question?.text])
    const seen = new Set(transcript(entry.harness.agentId).slice(-TRANSCRIPT_MAX).map((message) => message.id))
    for (const message of update.messages) {
      if (seen.has(message.id)) continue
      record(entry, { ...message, from: 'agent' })
      entry.heard = true
    }
    // "Waiting for you" with nothing said since the person wrote is the wait they just answered: not a new one.
    if (update.state === 'needs_input' && !entry.heard) update = { ...update, state: undefined, question: undefined }
    if (update.state) entry.harness.state = update.state
    if (update.activity !== undefined) entry.harness.activity = update.activity
    // Refreshed even when this look brought no messages, and when its "waiting" was the wait just answered.
    // A null detail replaces the old one: the maker no longer reports it.
    if (update.providerStatus) entry.harness.providerStatus = { status: update.providerStatus.status, detail: update.providerStatus.detail }
    if (update.branch !== undefined) entry.harness.branch = update.branch
    if (update.links) entry.harness.links = update.links
    if (update.remote) entry.remote = { ...entry.remote, ...update.remote }
    if (entry.harness.state !== 'needs_input') ask(entry, null)
    else if (update.question) ask(entry, update.question)
    // Waiting, with nothing new said and nothing asked yet (a restart): it asks what it last said.
    else if (!entry.question) {
      const said = transcript(entry.harness.agentId).filter((message) => message.from === 'agent').at(-1)?.text
      ask(entry, { text: (said ?? `${CLOUD_AGENTS[entry.harness.agent].name} is waiting for you.`).slice(0, 500), choices: [] })
    }
    return JSON.stringify([entry.harness, entry.remote, entry.question?.text]) !== before
  }

  const schedule = (agentId: string, ms: number): void => {
    clearTimer(timers.get(agentId))
    timers.delete(agentId)
    if (stopped) return
    timers.set(agentId, setTimer(() => { timers.delete(agentId); void look(agentId) }, ms))
  }
  const watching = (entry: Entry): boolean => ['starting', 'working', 'needs_input'].includes(entry.harness.state) && now() - entry.changedAt < QUIET_MS

  const look = (agentId: string): Promise<void> => serial(agentId, async () => {
    const entry = entries.get(agentId)
    if (!entry || stopped || !watching(entry)) return
    let update: CloudUpdate
    const controller = new AbortController()
    looking.set(agentId, controller)
    const started = now()
    try {
      update = await adapters[entry.harness.agent].poll(entry.remote, controller.signal)
      entry.failures = 0
    } catch (error) {
      // Cut short by the person's words: they are next in line, and look again after.
      if (controller.signal.aborted) return
    
      entry.failures += 1
      const said = error instanceof CloudError ? error.message : `${CLOUD_AGENTS[entry.harness.agent].name} could not be reached.`
      log(`[cloud] ${agentId} look failed (${entry.failures}): ${error instanceof Error ? error.name : 'error'}`)
      if (entry.harness.activity !== said) { entry.harness.activity = said; touched(entry) }
      schedule(agentId, Math.min(BACKOFF_MAX_MS, WORKING_MS * 2 ** entry.failures))
      return
    }
    finally {
      if (looking.get(agentId) === controller) looking.delete(agentId)
    }
    if (apply(entry, update)) touched(entry)
    const waitedLong = update.waited && now() - started >= LOOK_MIN_MS
    if (watching(entry)) schedule(agentId, waitedLong ? 0 : update.waited ? LOOK_MIN_MS : entry.harness.state === 'needs_input' ? WAITING_MS : WORKING_MS)
  })

  const refused = (error: unknown, agent?: CloudAgentId): { ok: false; error: string; detail: string } => error instanceof CloudError
    ? { ok: false, error: error.code, detail: error.message }
    : { ok: false, error: 'CLOUD_FAILED', detail: `${agent ? CLOUD_AGENTS[agent].name : 'The cloud agent'} could not be reached. Try again.` }

  /** New Harnesses still starting at their maker, by `creationId`: a retry while one starts gets its answer. */
  const creating = new Map<string, ReturnType<CloudPort['create']>>()

  const create: CloudPort['create'] = (request) => {
    // The same New Harness asked again (a window that timed out waiting): the harness it made, not a second.
    const creationId = typeof request.creationId === 'string' && request.creationId ? request.creationId.slice(0, 120) : undefined
    if (!creationId) return createNew(request, undefined)
    const made = [...entries.values()].find((entry) => entry.creationId === creationId)
    if (made) return Promise.resolve({ ok: true, agent: cloudAgentFrame(made.harness) })
    const pending = creating.get(creationId) ?? createNew(request, creationId).finally(() => creating.delete(creationId))
    creating.set(creationId, pending)
    return pending
  }

  const createNew = async (request: Record<string, unknown>, creationId: string | undefined): ReturnType<CloudPort['create']> => {
    const agent = request.engine
    if (!isCloudAgent(agent)) return { ok: false, error: 'INVALID_ENGINE', detail: 'That is not a cloud agent.' }
    const task = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    const refusal = cloudRequestRefusal(agent, task, [request.repositoryUrl, request.repository])
    if (refusal) return { ok: false, error: 'INVALID_REQUEST', detail: refusal }
    const repository = repositoryOf(request.repositoryUrl) ?? repositoryOf(request.repository)
    const acuLimit = typeof request.acuLimit === 'number' && Number.isInteger(request.acuLimit) && request.acuLimit > 0 && request.acuLimit <= 1000 ? request.acuLimit : undefined
    const model = typeof request.model === 'string' && request.model ? request.model.slice(0, 120) : undefined
    let started: Awaited<ReturnType<CloudAdapter['start']>>
    try {
      started = await adapters[agent].start({ task, repository, options: { acuLimit, model } })
    } catch (error) {
      codes.delete(agent)
      return refused(error, agent)
    }
    const at = new Date(now()).toISOString()
    const entry: Entry = {
      harness: {
        agentId: `cloud_${randomBytes(8).toString('hex')}`, agent,
        name: typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 120) : nameFor(task, agent),
        state: 'starting', activity: null, repository, branch: null, links: started.links, messages: 0, createdAt: at, updatedAt: at,
      },
      remote: started.remote,
      question: null,
      changedAt: now(),
      failures: 0,
      heard: false,
      ...(creationId ? { creationId } : {}),
    }
    entries.set(entry.harness.agentId, entry)
    record(entry, { id: `person-${now()}`, from: 'person', text: task, at })
    if (started.update) apply(entry, started.update)
    if (entry.harness.state === 'starting' && !started.update?.state) entry.harness.state = 'working'
    touched(entry)
    log(`[cloud] ${entry.harness.agentId} started on ${agent}`)
    schedule(entry.harness.agentId, started.update?.waited || adapters[agent].answered?.(entry.remote) ? 0 : 2_000)
    return { ok: true, agent: cloudAgentFrame(entry.harness) }
  }

  const deliver = (agentId: string, text: string): Promise<CloudResult> => { interrupt(agentId); return serial(agentId, async () => {
    const entry = entries.get(agentId)
    if (!entry) return { ok: false, error: 'UNKNOWN_AGENT', detail: 'That cloud harness is gone.' }
    const words = text.trim()
    if (!words) return { ok: false, error: 'INVALID_REQUEST', detail: 'Write something to send.' }
    // Working from the moment the words go, as a terminal agent's turn starts with its prompt: Fo answers
    // `ask_fo` with its whole reply, 15 s later, and the dial sat on the last recap all that time (2026-10-11).
    // Told, not saved: refused, it is back where it was.
    const was = { state: entry.harness.state, activity: entry.harness.activity, providerStatus: entry.harness.providerStatus }
    entry.harness.state = 'working'
    entry.harness.activity = null
    // The status from before these words is not this turn's. It stands again when the next look says so;
    // a refused send puts the old one back, because the maker never took the words.
    delete entry.harness.providerStatus
    publish()
    const adapter = adapters[entry.harness.agent]
    try {
      const moved = await adapter.send(entry.remote, words)
      if (moved) entry.remote = { ...entry.remote, ...moved }
    } catch (error) {
      Object.assign(entry.harness, was)
      if (!was.providerStatus) delete entry.harness.providerStatus
      publish()
      return refused(error, entry.harness.agent)
    }
    record(entry, { id: `person-${now()}`, from: 'person', text: words, at: new Date(now()).toISOString() })
    entry.heard = false
    ask(entry, null)
    touched(entry)
    // Its reply already here: read now, not after the wait a maker that is only starting needs.
    schedule(agentId, adapter.answered?.(entry.remote) ? 0 : 2_000)
    return { ok: true }
  }) }

  const answer = async (agentId: string, requestId: string, answers: Record<string, string>): Promise<CloudResult> => {
    const entry = entries.get(agentId)
    const question = entry?.question
    if (!entry || !question || question.requestId !== requestId) return { ok: false, error: 'STALE_QUESTION', detail: 'That question was already answered.' }
    const words = Object.values(answers).filter((value) => typeof value === 'string' && value.trim()).join('\n')
    // Taken at once, before anything waits: a second answer (the dial and the window both) finds it answered.
    entry.question = null
    options.core.unask(agentId, question.requestId)
    const result = await deliver(agentId, words)
    // Not taken: the question stands, asked again.
    if (!result.ok && !entry.question && entry.harness.state === 'needs_input') ask(entry, { text: question.text, choices: question.choices })
    return result
  }

  /** Only the name Harness shows: nothing is asked of the maker, and its activity time stands. */
  const rename = async (agentId: string, name: string): Promise<CloudResult> => {
    const entry = entries.get(agentId)
    if (!entry) return { ok: false, error: 'UNKNOWN_AGENT', detail: 'That cloud harness is gone.' }
    const trimmed = name.trim().slice(0, 120)
    if (!trimmed) return { ok: false, error: 'MISSING_NAME', detail: 'A harness needs a name.' }
    entry.harness.name = trimmed
    save()
    publish()
    return { ok: true }
  }

  const stopHarness = (agentId: string): Promise<CloudResult> => { interrupt(agentId); return serial(agentId, async () => {
    const entry = entries.get(agentId)
    if (!entry) return { ok: false, error: 'UNKNOWN_AGENT', detail: 'That cloud harness is gone.' }
    const adapter = adapters[entry.harness.agent]
    try { await adapter.stop?.(entry.remote) } catch (error) { return refused(error, entry.harness.agent) }
    clearTimer(timers.get(agentId))
    timers.delete(agentId)
    entry.harness.state = 'stopped'
    entry.harness.activity = adapter.stop ? null : `${CLOUD_AGENTS[entry.harness.agent].name} keeps working on its own.`
    // A local stop is not the maker's last report. Showing that report would call a finished session current.
    delete entry.harness.providerStatus
    ask(entry, null)
    touched(entry)
    return adapter.stop ? { ok: true } : { ok: true, detail: `${CLOUD_AGENTS[entry.harness.agent].name} keeps working on its own.` }
  }) }

  const requests: ServiceRequests = {
    cloud_transcript: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
      if (!entries.has(agentId)) return { error: 'UNKNOWN_AGENT' }
      const all = transcript(agentId)
      const after = typeof payload.after === 'number' && payload.after > 0 ? Math.floor(payload.after) : 0
      return { messages: all.slice(Math.max(after, all.length - TRANSCRIPT_MAX)), total: all.length }
    },
    // The chat pane's prompt: answered, so the pane can say why words were not taken ("still working").
    cloud_send: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      return deliver(typeof payload.agentId === 'string' ? payload.agentId : '', typeof payload.text === 'string' ? payload.text : '')
        .then((result) => (result.ok ? { ok: true } : { error: result.error, detail: result.detail ?? '' }))
    },
    cloud_agents: async (_payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const agents = await Promise.all(CLOUD_AGENT_IDS.map(async (id) => {
        const info = CLOUD_AGENTS[id]
        const connected = await connectionFor(bridge, id).then(() => true, () => false)
        return { id, name: info.name, place: info.place, kind: info.kind, connected, ...(connected ? {} : { connect: info.connect }) }
      }))
      return { agents }
    },
  }

  // The harnesses from before this start: told to the core again, and looked at where one was working.
  try {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { harnesses?: Array<Omit<Entry, 'failures'>> }
    for (const raw of saved.harnesses ?? []) {
      if (!raw?.harness?.agentId || !isCloudAgent(raw.harness.agent) || !raw.remote?.id) continue
      // A harness saved before it kept its last words finds them in its conversation.
      if (typeof raw.harness.said !== 'string') raw.harness.said = transcript(raw.harness.agentId).filter((message) => message.from === 'agent').at(-1)?.text.slice(0, SAID_MAX) ?? null
      entries.set(raw.harness.agentId, { harness: raw.harness, remote: raw.remote, question: null, changedAt: raw.changedAt ?? now(), failures: 0, heard: true,
        ...(typeof raw.creationId === 'string' ? { creationId: raw.creationId } : {}) })
    }
  } catch { /* None yet. */ }
  for (const entry of entries.values()) if (watching(entry)) schedule(entry.harness.agentId, 1_000)

  return {
    requests,
    port: { create, deliver, answer, rename, stopHarness } satisfies CloudPort,
    /** The core connected again (its restart): it is told every harness, and asked every open question, again. */
    republish(): void {
      publish()
      for (const entry of entries.values()) if (entry.question) options.core.ask(entry.harness.agentId, entry.question.requestId, { text: entry.question.text, choices: entry.question.choices })
    },
    transcript,
    stop(): void {
      stopped = true
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
    },
  }
}

export type CloudService = ReturnType<typeof startCloudService>
