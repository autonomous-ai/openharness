/** Manual companion for native_device_socket_e2e_test.dart. Real private tmux,
 * cable framing, local WebSocket and terminal streaming; synthetic output and
 * transcripts. Explicit reviewed Carry dispatch ends in private memory, not stdin.
 * node --import tsx scripts/pro-device-native-peer.ts --output <new-directory>
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { isolatedTmux } from '../src/testing/isolatedTmux.js'
import { CableDecoder, CableType, encodeCableFrame } from '../src/cable/cableFrame.js'
import type { CablePort } from '../src/cable/cableSession.js'
import type { SelectionFocus } from '../src/cable/windowSelection.js'
import type { UnreadNotification } from '../src/cable/notificationRead.js'

const option = process.argv.indexOf('--output')
assert(option >= 0 && process.argv[option + 1], '--output is required')
const output = resolve(process.argv[option + 1])
await mkdir(output, { recursive: false })
const root = await mkdtemp(join(tmpdir(), 'pro-app-socket-'))
const tmux = await isolatedTmux()
Object.assign(process.env, { TMUX_TMPDIR: tmux.root,
  ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
  ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'), ADAPTER_COMPUTER_ID: 'pro-app-fixture',
  HARNESS_AUTH_DIR: join(root, 'auth'), HARNESS_LESSONS_DIR: join(root, 'lessons'),
  HARNESS_LOGS_DIR: join(root, 'logs'),
  DSH_DIR: join(root, 'dsh'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
  ZDOTDIR: root,
})
delete process.env.TMUX; delete process.env.TMUX_PANE
// isolatedTmux captured its environment before the fixture paths existed.
// Its child shell must use this fixture's empty startup directory too.
tmux.env.ZDOTDIR = root
const [{ BackendSocket }, { attachLocalWsServer }, { registry }, { TmuxBackend },
  { TerminalStreamManager }, { TerminalBackendCoordinator }, { WindowSelection },
  { DaemonCableHost }, { CableSession }, { DialLog }, { TerminalBinaryKind }, { AgentNotifications }, { WindowVisit }] = await Promise.all([
  import('../src/backendSocket.js'), import('../src/localWsServer.js'), import('../src/lib/registry.js'),
  import('../src/lib/tmuxBackend.js'), import('../src/lib/terminalStreamManager.js'),
  import('../src/lib/terminalBackendCoordinator.js'), import('../src/cable/windowSelection.js'),
  import('../src/cable/cableHost.js'), import('../src/cable/cableSession.js'),
  import('../src/cable/dialLog.js'), import('../src/lib/terminalBinary.js'),
  import('../src/lib/agentNotifications.js'), import('../src/cable/windowVisit.js'),
])
const backend = new BackendSocket('m')
const terminal = new TmuxBackend()
let inputFrames = 0, resizeFrames = 0
const binary = backend.handleLocalBinary.bind(backend)
backend.handleLocalBinary = async (id, frame) => {
  if (frame.kind === TerminalBinaryKind.input) inputFrames++
  return binary(id, frame)
}
const frame = backend.handleLocalFrame.bind(backend)
backend.handleLocalFrame = (id, value) => {
  if (value.type === 'terminal_resize') resizeFrames++
  return frame(id, value)
}
const streams = new TerminalStreamManager({
  terminals: new TerminalBackendCoordinator([terminal], ['tmux']),
  resolveAgent: id => registry.byAgent(id), streamingAvailable: true,
  sendTarget: (id, type, payload) => backend.sendTerminalTo(id, type, payload),
  sendBinaryTarget: (id, value) => backend.sendTerminalBinaryTo(id, value), isLoopback: () => true,
})
backend.setTerminalStreamManager(streams)
let focus: SelectionFocus | undefined
const selection = new WindowSelection({ focus: () => focus,
  send: (id, payload) => local.sendToWindow(id, { type: 'dial_selection', payload }), timeoutMs: 3000 })
const notifications = new AgentNotifications()
const openQuestions = new Map<string, Record<string, unknown>>()
const wireEvents: Record<string, unknown>[] = []
const seenPending: Array<{ agentId: string; readToken?: string }> = []
const appUnreadEvents: Array<{ sequence: number; items: UnreadNotification[] }> = []
const readRequests: Array<{ machineId: string; agentId: string; readToken: string }> = []
const readAttempts: Array<{ agentId: string; readToken: string }> = []
const resultEvents = new Map<string, { agentId: string; sessionId: string; summary: string;
  notification: { id: string; kind: 'done' | 'needsYou' } }>()
const resultCases: Record<string, unknown>[] = []
const latestCases: Record<string, unknown>[] = []
const carryCases: Record<string, unknown>[] = []
const carryDispatches: Array<{ agentId: string; text: string }> = []
let hostDispatchAttempts = 0
const appSelectionReplies: Record<string, unknown>[] = []
const appVisitCommands: Record<string, unknown>[] = []
const appVisitReplies: Record<string, unknown>[] = []
const appSockets = new Set<Socket>()
let resultWireStart: number | undefined
let resultEvidenceBeforeLatest: Record<string, unknown> | undefined
let latestWireStart: number | undefined
let carryWireStart: number | undefined
let findWireStart: number | undefined
let carryEvidenceBeforeFind: Record<string, unknown> | undefined
const findCases: Record<string, unknown>[] = []
const findPhrase = 'cache [ready]'
const findWords = { match: `${findPhrase}.`, missing: 'missing amber receipt.' } as const
const findCarryId = `carry-${randomBytes(8).toString('hex')}`
let foundCarry: Record<string, unknown> | undefined
let findOutputStage = 0
let findNativeEvidence: Record<string, unknown> | undefined
let latestEvidenceBeforeCarry: Record<string, unknown> | undefined
let carryNativeViewport: Record<string, unknown> | undefined
let carriedSource: Record<string, unknown> | undefined
const carryId = `carry-${randomBytes(8).toString('hex')}`
let carryVisitId = `visit-${randomBytes(8).toString('hex')}`
let carrySerial = 0, carrySelectionSerial = 0, voiceSerial = 0, draftSerial = 0
const scriptedWords = {
  initial: 'Compare this passage with your current work.',
  replace: 'Explain this exact passage and suggest one focused improvement.',
} as const
let transcriptRequest: { uploadId: string; purpose: 'carry' | 'find'; kind: string; text: string;
  aborted?: boolean; resolve?: (text: string) => void } | undefined
const transcriptCalls: Record<string, unknown>[] = []
let retainedSummary: Record<string, unknown> | undefined
let retainedSummaryFrame: Record<string, unknown> | undefined
let retainedSummaryJson = ''
let latestNativeViewport: Record<string, unknown> | undefined
const latestVisitId = `visit-${randomBytes(8).toString('hex')}`
let visitSerial = 0
let resultHistory: { recap: string; text: string } | undefined
const repeatedRecap = 'The same unrelated latest recap belongs to a different turn.'
let holdSeen = false, answerAttempts = 0
const checkpoint = (name: string, details: Record<string, unknown> = {}) =>
  wireEvents.push({ event: 'checkpoint', name, ...details })
const visit = new WindowVisit({ focus: () => focus, timeoutMs: 3000,
  send: (id, payload) => {
    appVisitCommands.push({ connection: id, payload: structuredClone(payload) })
    return local.sendToWindow(id, { type: 'dial_visit', payload })
  } })
const host = new DaemonCableHost({ machineName: () => 'Private native fixture', machineId: () => 'm',
  computerId: () => 'pro-app-fixture', sendTurn: (agentId, text) => {
    hostDispatchAttempts++
    assert(carryWireStart !== undefined && carriedSource, 'Only the explicit Carry journey can dispatch')
    assert.equal(agentId, agents[1]?.agentId, 'Only the owned recipient is allowed')
    assert.equal(carryDispatches.length, 0, 'A reviewed draft must dispatch at most once')
    carryDispatches.push({ agentId, text })
    checkpoint('carry-host-dispatched', { agentId, text, terminalInput: false, vendorAcceptance: false })
  },
  stopTurn: () => {}, answer: () => { answerAttempts++; throw Error('This fixture cannot answer questions') },
  answerReviewed: async () => { answerAttempts++; throw Error('This fixture cannot answer questions') },
  notificationRead: (machineId, agentId, readToken) => {
    readRequests.push({ machineId, agentId, readToken })
    backend.sendLocal({ type: 'dial_notification_read', payload: { machineId, agentId, readToken } })
  },
  recent: () => resultHistory ? [resultHistory] : [], recentAsks: () => [], log: () => {},
  selectPassage: command => selection.command(command), clearSelection: () => selection.cancel(),
  visit: command => visit.command(command), rejectVisit: (id, error) => visit.refuse(id, error),
  clearVisit: () => visit.cancel() })
// The production service boundary is the only transcription substitute. No
// microphone, provider, router, or terminal submission is exercised here.
host.transcribe = async (pcm, sampleRate, lang) => {
  assert(transcriptRequest && !transcriptRequest.resolve, 'Only an explicitly requested scripted transcript is allowed')
  assert.equal(pcm.length, 640); assert.equal(sampleRate, 16000); assert.equal(lang, 'en')
  const request = transcriptRequest
  transcriptCalls.push({ uploadId: request.uploadId, purpose: request.purpose,
    kind: request.kind, bytes: pcm.length, sampleRate, lang })
  return new Promise<string>(resolve => { request.resolve = resolve })
}
const readNotification = host.readNotification.bind(host)
host.readNotification = (agentId, readToken) => {
  readNotification(agentId, readToken) // Execute the production guard unchanged.
  readAttempts.push({ agentId, readToken })
}
class Port implements CablePort {
  path = '/dev/pro-native-fixture'; isOpen = true
  messages: Record<string, unknown>[] = []
  decoder = new CableDecoder()
  constructor(readonly incoming: (bytes: Buffer) => void, readonly closed: (reason: string) => void) {}
  async write(bytes: Uint8Array) {
    this.decoder.feed(Buffer.from(bytes), f => {
      if (f.type === CableType.Json) {
        const frame = JSON.parse(Buffer.from(f.payload).toString('utf8'))
        this.messages.push(frame)
        wireEvents.push({ direction: 'host-to-device', frame })
      }
    })
  }
  say(value: Record<string, unknown>) {
    wireEvents.push({ direction: 'device-to-host', frame: value })
    this.incoming(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(value)))))
  }
  pcm() {
    wireEvents.push({ direction: 'device-to-host', type: 'pcm', bytes: 640, syntheticSilence: true })
    this.incoming(Buffer.from(encodeCableFrame(CableType.Pcm, Buffer.alloc(640))))
  }
  async close() { if (this.isOpen) { this.isOpen = false; this.closed('fixture closed') } }
}
let port: Port | undefined
const cable = new CableSession(host, new DialLog(join(root, 'logs')), async (incoming, closed) =>
  port = new Port(incoming, closed))
const cases: Record<string, unknown>[] = []
const agents: { agentId: string; marker: string }[] = []
const outputControls = new Map<string, { path: string; sequence: number }>()
const ownedPids: number[] = []
let finish!: () => void
const finished = new Promise<void>(r => { finish = r })
const waitFor = async (fn: () => boolean, timeout = 4000) => {
  const until = Date.now() + timeout
  while (!fn() && Date.now() < until) await new Promise(r => setTimeout(r, 20))
  assert(fn(), 'fixture deadline reached')
}
const prepareCarry = async (agentId: string, id: string, selectionId: string, revision: number) => {
  const requestId = `carry-${++carrySerial}`
  const command = { t: 'carry.prepare', agentId, carryId: id, requestId, selectionId, revision }
  port!.say(command)
  await waitFor(() => port!.messages.some(m => m.t === 'carry.state' && m.requestId === requestId))
  const result = port!.messages.find(m => m.t === 'carry.state' && m.requestId === requestId)!
  let source: Record<string, unknown> | undefined
  if (result.ok) {
    const pin = [...appSelectionReplies].reverse().find(r => {
      const p = r.payload as Record<string, unknown>
      return p.agentId === agentId && p.selectionId === selectionId && p.ok === true && typeof p.text === 'string'
    })
    assert(pin, 'The full quote must come from the actual app selection reply')
    const payload = pin.payload as Record<string, unknown>
    source = structuredClone({ agentId, selectionId, revision: payload.revision,
      text: payload.text, rows: payload.rows, sourceName: result.sourceName, excerpt: result.excerpt })
  }
  return { command, result, source }
}
const server = createServer((req, res) => { void (async () => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/fixture') { res.end(JSON.stringify({ agents, root })); return }
  if (req.url === '/evidence') {
    res.end(JSON.stringify({ focus, inputFrames, resizeFrames, answerAttempts, cases,
      unread: host.listUnread(), pendingSeen: seenPending, cableFrames: port?.messages,
      appUnreadEvents, readRequests, readAttempts, resultCases, latestCases,
      appVisitCommands, appVisitReplies, retainedSummary, carryCases, carryDispatches,
      carriedSource, transcriptCalls, appSelectionReplies, hostDispatchAttempts,
      findCases, foundCarry })); return
  }
  if (req.url === '/shutdown' && req.method === 'POST') { res.end('{}'); finish(); return }
  if (req.url === '/find' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 8192) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agentId = command.agentId
    assert(agents.some(a => a.agentId === agentId), 'Only fixture agents are allowed')
    if (command.op === 'start') {
      assert(findWireStart === undefined && carryNativeViewport && carryDispatches.length === 1)
      carryEvidenceBeforeFind = structuredClone({ carriedSource, scriptedWords, carryCases,
        carryDispatches, transcriptCalls, carryNativeViewport })
      findWireStart = wireEvents.length
      checkpoint('spoken-find-started', { agentId, phrase: findPhrase, machineId: 'm', hostDispatchAttempts })
      res.end(JSON.stringify({ phrase: findPhrase, transcripts: findWords, carryId: findCarryId })); return
    }
    assert(findWireStart !== undefined, 'Start spoken Find explicitly')
    if (command.op === 'output') {
      assert.equal(agentId, agents[0].agentId)
      const marker = agents[0].marker
      const stages = [
        [`  ${marker} FIND_A cache [ready]`, `    ${marker} CONTEXT_A exact first context`,
          `  ${marker} FIND_B CACHE [READY]`, `    ${marker} CONTEXT_B exact middle context`,
          `  ${marker} FIND_C cache [ready]`, `    ${marker} CONTEXT_C exact last context`],
        [`  ${marker} FIND_D cache [ready]`, `    ${marker} CONTEXT_D newly arrived context`],
        [`  ${marker} FIND_AFTER_PIN later output leaves the carried quote unchanged`],
      ]
      assert.equal(command.stage, findOutputStage)
      assert(findOutputStage < stages.length, 'This journey has exactly three bounded output batches')
      const lines = stages[findOutputStage++], control = outputControls.get(agentId)!
      const sequence = ++control.sequence
      await writeFile(control.path, JSON.stringify({ sequence, lines }))
      checkpoint('spoken-find-owned-output', { agentId, stage: command.stage, lines })
      res.end(JSON.stringify({ lines, marker: lines.at(-1) })); return
    }
    if (command.op === 'record') {
      assert.equal(agentId, agents[0].agentId)
      assert(!transcriptRequest && (command.kind === 'match' || command.kind === 'missing'))
      assert(transcriptCalls.filter(r => r.purpose === 'find').length < 4, 'Four bounded Find transcripts')
      const kind = command.kind as keyof typeof findWords, uploadId = `find-voice-${++voiceSerial}`
      transcriptRequest = { uploadId, purpose: 'find', kind, text: findWords[kind] }
      const frame = { t: 'voice.begin', uploadId, agentId, lang: 'en', sr: 16000,
        searchId: command.selectionId, searchRevision: command.revision }
      port!.say(frame); port!.pcm(); port!.say({ t: 'voice.end', uploadId, review: false })
      await waitFor(() => !!transcriptRequest?.resolve)
      checkpoint('spoken-find-transcription-held', { command: frame, hostDispatchAttempts })
      res.end(JSON.stringify({ uploadId })); return
    }
    if (command.op === 'abort') {
      const pending = transcriptRequest
      assert(pending?.purpose === 'find' && pending.resolve && command.uploadId === pending.uploadId)
      pending.aborted = true
      port!.say({ t: 'voice.abort', uploadId: pending.uploadId })
      await new Promise<void>(r => setImmediate(r))
      checkpoint('spoken-find-aborted-before-transcript', { agentId, uploadId: pending.uploadId })
      res.end(JSON.stringify({ aborted: true })); return
    }
    if (command.op === 'release-transcript') {
      const pending = transcriptRequest
      assert(pending?.purpose === 'find' && pending.resolve && command.uploadId === pending.uploadId)
      transcriptRequest = undefined
      pending.resolve(pending.text)
      if (pending.aborted) {
        // The deterministic service has resolved. The cancelled production path
        // checks its generation before any further I/O; drain that continuation.
        await new Promise<void>(r => setImmediate(r))
        assert(!port!.messages.some(m => m.uploadId === pending.uploadId && String(m.t).startsWith('voice.')))
        const saved = { uploadId: pending.uploadId, suppressed: true, hostDispatchAttempts }
        findCases.push(saved); checkpoint('spoken-find-late-transcript-suppressed', saved)
        res.end(JSON.stringify(saved)); return
      }
      await waitFor(() => port!.messages.some(m => ['voice.search', 'voice.error'].includes(String(m.t)) && m.uploadId === pending.uploadId))
      const result = port!.messages.find(m => ['voice.search', 'voice.error'].includes(String(m.t)) && m.uploadId === pending.uploadId)!
      const saved = { result, hostDispatchAttempts }
      findCases.push(saved); checkpoint('spoken-find-result', saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'focus-checkpoint') {
      assert(['away', 'back'].includes(command.phase))
      assert.equal(focus?.agentId, agentId)
      checkpoint(`spoken-find-focus-${command.phase}`, { agentId, focus })
      res.end(JSON.stringify({ focus })); return
    }
    if (command.op === 'carry') {
      assert.equal(agentId, agents[0].agentId)
      const saved = await prepareCarry(agentId, findCarryId, command.selectionId, command.revision)
      if (saved.source) foundCarry = saved.source
      findCases.push(saved); checkpoint('spoken-find-carried-passage', saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'finish') {
      assert(command.evidence && typeof command.evidence === 'object')
      assert.equal(hostDispatchAttempts, 1); assert.equal(inputFrames, 0); assert.equal(carryDispatches.length, 1)
      const frames = wireEvents.slice(findWireStart).filter(e => e.direction === 'host-to-device')
      assert(!frames.some(e => ['voice.draft', 'voice.transcript'].includes(String((e.frame as Record<string, unknown>).t))))
      findNativeEvidence = structuredClone(command.evidence)
      checkpoint('spoken-find-native-evidence', { evidence: findNativeEvidence, hostDispatchAttempts, inputFrames })
      res.end(JSON.stringify({ recorded: true, hostDispatchAttempts, inputFrames, foundCarry })); return
    }
    assert.fail('Unknown Find fixture operation')
  }
  if (req.url === '/carry' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 8192) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agentId = command.agentId
    assert(agents.some(a => a.agentId === agentId), 'Only fixture agents are allowed')
    if (command.op === 'start') {
      assert(carryWireStart === undefined && latestNativeViewport, 'Start Carry only after the previous journey is complete')
      latestEvidenceBeforeCarry = structuredClone({ latestCases, appVisitCommands, appVisitReplies, latestNativeViewport })
      carryWireStart = wireEvents.length
      checkpoint('carry-journey-started', { agentId, scriptedWords, captureBoundary: 'host service', terminalInput: false })
      res.end(JSON.stringify({ carryId, visitId: carryVisitId, scriptedWords })); return
    }
    assert(carryWireStart !== undefined, 'Start this journey explicitly')
    if (command.op === 'prepare') {
      assert.equal(agentId, agents[0].agentId)
      const prepared = await prepareCarry(agentId, carryId, command.selectionId, command.revision)
      if (prepared.source) carriedSource = prepared.source
      const saved = { ...prepared, source: carriedSource, dispatches: carryDispatches.length }
      carryCases.push(saved); checkpoint(prepared.result.ok ? 'carry-passage-pinned' : 'carry-stale-selection-refused', saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'visit') {
      assert(['latest', 'open', 'back'].includes(command.action))
      if (command.newVisit) carryVisitId = `visit-${randomBytes(8).toString('hex')}`
      const requestId = `visit-${++visitSerial}`
      const frame = { t: 'visit', op: command.action, visitId: carryVisitId, requestId, agentId }
      port!.say(frame)
      await waitFor(() => port!.messages.some(m => m.t === 'visit.state' && m.requestId === requestId))
      const result = port!.messages.find(m => m.t === 'visit.state' && m.requestId === requestId)!
      const saved = { command: frame, result, dispatches: carryDispatches.length }
      carryCases.push(saved); checkpoint(`carry-visit-${command.action}`, saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'output') {
      assert.equal(agentId, agents[0].agentId)
      assert(carriedSource && ['CARRY_SOURCE_AFTER_PIN', 'CARRY_SOURCE_DURING_REVIEW'].includes(command.marker))
      const control = outputControls.get(agentId)!
      assert(control.sequence < 4, 'At most two more source lines in this journey')
      const sequence = ++control.sequence
      await writeFile(control.path, JSON.stringify({ sequence, marker: command.marker }))
      const marker = `${agents[0].marker} ${command.marker} ${sequence}`
      checkpoint('carry-source-output-requested', { agentId, marker })
      res.end(JSON.stringify({ marker })); return
    }
    if (command.op === 'publish-alert') {
      assert.equal(agentId, agents[0].agentId)
      const sessionId = 'fixture-carry-source-update', summary = 'New source output is ready.'
      notifications.started(sessionId)
      const notification = notifications.completed(sessionId, summary, false)
      assert(notification)
      backend.sendLocal({ type: 'turn_summary', agentId, payload: { sessionId, summary, notification } })
      await waitFor(() => host.listUnread().some(n => n.agentId === agentId && n.text === summary))
      const item = host.listUnread().find(n => n.agentId === agentId)!
      await waitFor(() => port!.messages.some(m => m.t === 'notif.replace' && Array.isArray(m.items) &&
        m.items.some(row => row.agentId === agentId && row.readToken === item.readToken)))
      checkpoint('carry-new-source-attention', { agentId, item })
      res.end(JSON.stringify({ item })); return
    }
    if (command.op === 'record') {
      assert.equal(agentId, agents[1].agentId)
      assert(carriedSource && !transcriptRequest && (command.kind === 'initial' || command.kind === 'replace'))
      assert(transcriptCalls.length < 2, 'Exactly the initial direction and one replacement are scripted')
      const kind = command.kind as keyof typeof scriptedWords, uploadId = `carry-voice-${++voiceSerial}`
      transcriptRequest = { uploadId, purpose: 'carry', kind, text: scriptedWords[kind] }
      const frame = { t: 'voice.begin', uploadId, lang: 'en', sr: 16000,
        ...(kind === 'initial' ? { agentId, carryId }
          : { draftId: command.draftId, draftRevision: command.revision, draftOp: 'replace' }) }
      port!.say(frame); port!.pcm()
      // Native start_draft resets review_requested; the draft identity itself
      // keeps this edit in review. Initial carried capture explicitly reviews.
      port!.say({ t: 'voice.end', uploadId, review: kind === 'initial' })
      await waitFor(() => !!transcriptRequest?.resolve)
      checkpoint('carry-transcription-held', { agentId, kind, uploadId, dispatches: carryDispatches.length })
      res.end(JSON.stringify({ uploadId, dispatches: carryDispatches.length })); return
    }
    if (command.op === 'release-transcript') {
      const pending = transcriptRequest
      assert(pending?.resolve && command.uploadId === pending.uploadId)
      transcriptRequest = undefined
      pending.resolve(pending.text)
      await waitFor(() => port!.messages.some(m => ['voice.draft', 'voice.error'].includes(String(m.t)) && m.uploadId === pending.uploadId))
      const result = port!.messages.find(m => ['voice.draft', 'voice.error'].includes(String(m.t)) && m.uploadId === pending.uploadId)!
      const saved = { result, source: carriedSource, dispatches: carryDispatches.length }
      carryCases.push(saved); checkpoint(pending.kind === 'initial' ? 'carry-direction-reviewed' : 'carry-direction-edited', saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'draft') {
      assert(['state', 'send'].includes(command.action))
      const requestId = `draft-${++draftSerial}`
      const frame = { t: 'draft.command', op: command.action, draftId: command.draftId, revision: command.revision, requestId }
      port!.say(frame)
      await waitFor(() => port!.messages.some(m => m.t === 'draft.state' && m.requestId === requestId))
      const result = port!.messages.find(m => m.t === 'draft.state' && m.requestId === requestId)!
      const saved = { command: frame, result, dispatches: structuredClone(carryDispatches) }
      carryCases.push(saved); checkpoint(`carry-draft-${command.action}`, saved)
      res.end(JSON.stringify(saved)); return
    }
    if (command.op === 'viewport-receipt') {
      assert(command.viewport && typeof command.viewport === 'object' && !Array.isArray(command.viewport))
      carryNativeViewport = structuredClone(command.viewport)
      checkpoint('carry-native-viewport', { evidence: carryNativeViewport })
      res.end(JSON.stringify({ recorded: true })); return
    }
    assert.fail('Unknown Carry fixture operation')
  }
  if (req.url === '/visit' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 4096) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agentId = command.agentId
    assert(agents.some(a => a.agentId === agentId), 'Only fixture agents are allowed')
    assert(['retain-summary', 'publish-alert', 'viewport-receipt', 'latest', 'open', 'back', 'cancel'].includes(command.op))
    if (command.op === 'retain-summary') {
      assert(!retainedSummary, 'This journey has one immutable received Summary')
      const matches = (row: Record<string, unknown>) => row.agentId === agentId && row.readToken === command.readToken
      const saved = [...port!.messages].reverse().find(frame => frame.t === 'notif.replace' &&
        Array.isArray(frame.items) && frame.items.some(matches))
      assert(saved, 'Retain only an exact Summary previously delivered on the cable')
      retainedSummaryFrame = structuredClone(saved)
      retainedSummary = structuredClone((saved.items as Record<string, unknown>[]).find(matches)!)
      assert(retainedSummary.readToken && retainedSummary.summary && !retainedSummary.question)
      retainedSummaryJson = JSON.stringify(retainedSummary)
      latestWireStart = wireEvents.length
      resultEvidenceBeforeLatest = structuredClone({ appUnreadEvents, readAttempts, readRequests, resultCases })
      checkpoint('latest-summary-retained', { agentId, summary: retainedSummary, frame: retainedSummaryFrame })
      res.end(JSON.stringify({ summary: retainedSummary, visitId: latestVisitId })); return
    }
    assert(retainedSummary, 'Retain the actual received Summary before navigation')
    if (command.op === 'viewport-receipt') {
      assert(command.viewport && typeof command.viewport === 'object' && !Array.isArray(command.viewport))
      latestNativeViewport = structuredClone(command.viewport)
      checkpoint('latest-native-viewport', { agentId, evidence: latestNativeViewport })
      res.end(JSON.stringify({ recorded: true })); return
    }
    if (command.op === 'publish-alert') {
      assert(agentId !== retainedSummary.agentId, 'The intervening alert belongs to the other owned pane')
      const sessionId = 'fixture-latest-alert-session', summary = 'Another output is ready.'
      notifications.started(sessionId)
      const notification = notifications.completed(sessionId, summary, false)
      assert(notification)
      backend.sendLocal({ type: 'turn_summary', agentId, payload: { sessionId, summary, notification } })
      await waitFor(() => host.listUnread().some(item => item.agentId === agentId && !!item.readToken))
      const item = host.listUnread().find(item => item.agentId === agentId)!
      assert.equal(item.text, summary)
      await waitFor(() => port!.messages.some(frame => frame.t === 'notif.replace' &&
        Array.isArray(frame.items) && frame.items.some(row => row.agentId === agentId && row.readToken === item.readToken)))
      checkpoint('latest-other-alert-published', { agentId, item })
      res.end(JSON.stringify({ item })); return
    }
    const requestId = `visit-${++visitSerial}`
    // Exact existing native shape: Back also names its committed destination.
    const commandFrame = { t: 'visit', op: command.op, visitId: latestVisitId, requestId, agentId }
    const before = appVisitCommands.length
    port!.say(commandFrame)
    await waitFor(() => port!.messages.some(frame => frame.t === 'visit.state' && frame.requestId === requestId))
    const result = port!.messages.find(frame => frame.t === 'visit.state' && frame.requestId === requestId)!
    assert.equal(JSON.stringify(retainedSummary), retainedSummaryJson)
    const saved = { command: commandFrame, result, summary: retainedSummary,
      appCommandsBefore: before, appCommandsAfter: appVisitCommands.length, focus }
    latestCases.push(saved)
    checkpoint(`latest-${command.op}-${result.ok ? 'acknowledged' : 'refused'}`, saved)
    res.end(JSON.stringify(saved)); return
  }
  if (req.url === '/output' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 4096) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agent = agents.find(a => a.agentId === command.agentId), control = outputControls.get(command.agentId)
    assert(agent && control && retainedSummary, 'Append only to this journey\'s owned synthetic emitter')
    assert(['LIVE_TAIL_AFTER_LATEST', 'LIVE_TAIL_AFTER_RETURN'].includes(command.marker))
    assert(control.sequence < 2, 'The emitter is bounded to two extra output lines')
    const sequence = ++control.sequence
    // A separate owned file is output control, never terminal stdin or a model command.
    await writeFile(control.path, JSON.stringify({ sequence, marker: command.marker }))
    const marker = `${agent.marker} ${command.marker} ${sequence}`
    checkpoint('latest-owned-output-requested', { agentId: agent.agentId, marker })
    res.end(JSON.stringify({ marker })); return
  }
  if (req.url === '/result' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 4096) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agentId = command.agentId
    assert(agents.some(a => a.agentId === agentId), 'Only fixture agents are allowed')
    assert(['publish', 'duplicate', 'restore', 'read', 'release-seen', 'stale-read', 'reconnect'].includes(command.op))
    if (resultWireStart === undefined) { resultWireStart = wireEvents.length; checkpoint('result-lifetime-started', { agentId }) }
    const latestRow = () => [...port!.messages].reverse().find(m => m.t === 'notif.replace')?.items as
      Array<Record<string, unknown>> | undefined
    const current = () => host.listUnread().find(n => n.agentId === agentId && !n.question)
    if (command.op === 'publish') {
      assert(['first', 'second'].includes(command.result), 'Only the two synthetic completions are allowed')
      const summary = command.result === 'first' ? 'Alpha approved.' : 'Beta approved.'
      const sessionId = 'fixture-result-session'
      const previous = current()?.readToken
      resultHistory = { recap: repeatedRecap, text: `Unrelated latest body ${command.result}. It must not replace receipt-owned words.` }
      notifications.started(sessionId)
      const notification = notifications.completed(sessionId, summary, false)
      assert(notification, 'Synthetic completed turn must be eligible exactly once')
      const payload = { sessionId, summary, notification }
      resultEvents.set(command.result, { agentId, ...payload })
      checkpoint('result-published', { agentId, ...payload, unrelatedHistory: resultHistory })
      // Commander actually emits summary, sessionId and notification. No recap
      // or text is invented to make Desktop's fallback pass this scenario.
      backend.sendLocal({ type: 'turn_summary', agentId, payload })
      await waitFor(() => !!current()?.readToken && current()!.readToken !== previous)
      const item = current()!
      await waitFor(() => latestRow()?.some(row => row.agentId === agentId && row.readToken === item.readToken) === true)
      const cableItem = latestRow()!.find(row => row.agentId === agentId)!
      assert.equal(item.text, summary); assert.equal(cableItem.summary, summary)
      const result = { op: command.op, agentId, payload, item, cableItem }
      resultCases.push(result); res.end(JSON.stringify(result)); return
    }
    if (command.op === 'duplicate') {
      const saved = resultEvents.get(command.result)
      assert(saved && saved.agentId === agentId, 'Duplicate only an existing synthetic completion')
      const payload = { sessionId: saved.sessionId, notification: saved.notification, summary: 'Wrong duplicate words.' }
      checkpoint('result-duplicate-delivered', { agentId, payload })
      backend.sendLocal({ type: 'turn_summary', agentId, payload })
      res.end(JSON.stringify({ delivered: true, notificationId: saved.notification.id })); return
    }
    if (command.op === 'restore') {
      const item = current(); assert(item?.readToken, 'Restore an exact existing unread occurrence')
      resultHistory = { recap: repeatedRecap, text: 'A newer mutable body arrived before restore. These are not the saved notification words.' }
      await cable.replaceNotifications(host.listUnread())
      const cableItem = latestRow()!.find(row => row.agentId === agentId)!
      assert.equal(cableItem.summary, item.text); assert.equal(cableItem.readToken, item.readToken)
      checkpoint('result-restored-over-newer-history', { agentId, item, cableItem, unrelatedHistory: resultHistory })
      resultCases.push({ op: command.op, item, cableItem }); res.end(JSON.stringify({ item, cableItem })); return
    }
    if (command.op === 'read') {
      const item = current(); assert(item?.readToken && item.readToken === command.readToken)
      holdSeen = true
      port!.say({ t: 'notif.read', agentId, readToken: item.readToken })
      await waitFor(() => seenPending.some(n => n.agentId === agentId && n.readToken === item.readToken))
      await waitFor(() => !current())
      checkpoint('result-read-ack-held', { agentId, item })
      res.end(JSON.stringify({ readToken: item.readToken, pendingSeen: seenPending })); return
    }
    if (command.op === 'release-seen') {
      const pending = seenPending.splice(0)
      assert(pending.length === 1 && pending[0].agentId === agentId && pending[0].readToken === command.readToken)
      holdSeen = false
      await cable.agentSeen(agentId, pending[0].readToken)
      checkpoint('old-result-ack-released', { agentId, readToken: pending[0].readToken, current: current() })
      res.end(JSON.stringify({ released: pending, current: current() })); return
    }
    if (command.op === 'stale-read') {
      const item = structuredClone(current()); assert(item?.readToken && item.readToken !== command.readToken)
      const before = readRequests.length, attempted = readAttempts.length
      port!.say({ t: 'notif.read', agentId, readToken: command.readToken })
      await waitFor(() => readAttempts.length > attempted)
      assert.deepEqual(readAttempts.at(-1), { agentId, readToken: command.readToken })
      // The actual cable host rejects an obsolete occurrence before it can
      // reach Desktop. Waiting for a forwarding callback would be incorrect.
      assert.equal(readRequests.length, before)
      assert.equal(current()?.readToken, item.readToken)
      assert.equal(current()?.text, item.text)
      checkpoint('stale-result-read-rejected-by-host', { agentId, readToken: command.readToken, current: item })
      res.end(JSON.stringify({ forwarded: false })); return
    }
    const item = current(); assert(item?.readToken, 'Reconnect while an exact result is still unread')
    const before = appUnreadEvents.length, oldConnection = focus?.connId
    assert(oldConnection && appSockets.size === 1, 'Drop only this fixture window socket')
    // The app retains the unread occurrence. Clear only the fixture host's
    // ephemeral copy so reconnect must republish it over the real new socket.
    host.setUnread([]); await cable.replaceNotifications([])
    checkpoint('result-app-link-interrupted', { agentId, item, oldConnection })
    for (const socket of appSockets) socket.destroy()
    await waitFor(() => appUnreadEvents.length > before && focus?.connId !== oldConnection && !!focus?.connId &&
      current()?.readToken === item.readToken, 12_000)
    await waitFor(() => latestRow()?.some(row => row.agentId === agentId && row.readToken === item.readToken) === true)
    const restored = current()!, cableItem = latestRow()!.find(row => row.agentId === agentId)!
    assert.equal(restored.text, item.text); assert.equal(cableItem.summary, item.text)
    checkpoint('result-restored-after-app-reconnect', { agentId, item: restored, cableItem, oldConnection, connection: focus?.connId })
    resultCases.push({ op: command.op, item: restored, cableItem, oldConnection, connection: focus?.connId })
    res.end(JSON.stringify({ item: restored, cableItem, oldConnection, connection: focus?.connId })); return
  }
  if (req.url === '/question' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 4096) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const agentId = command.agentId
    assert(agents.some(a => a.agentId === agentId), 'Only fixture agents are allowed')
    assert(['open', 'read', 'release-seen', 'close'].includes(command.op), 'Only question lifecycle operations are allowed')
    if (command.op === 'open') {
      const requestId = command.requestId
      assert(/^fixture-question-[a-z]+$/.test(requestId), 'Only fixture question identities are allowed')
      const questions = [{ key: 'fixture-choice', q: `Keep this synthetic result? (${requestId})`, options: ['Keep', 'Dismiss'], multi: false }]
      const asked = { type: 'commander_question', agentId,
        payload: { requestId, questions, notification: notifications.asked(agentId, requestId) } }
      openQuestions.set(agentId, asked)
      checkpoint('question-opened', { agentId, requestId })
      backend.sendLocal(asked)
      await cable.question(agentId, requestId, questions)
      await waitFor(() => host.listUnread().some(n => n.agentId === agentId && n.question && !!n.readToken))
      res.end(JSON.stringify({ requestId, unread: host.listUnread().find(n => n.agentId === agentId) })); return
    }
    if (command.op === 'read') {
      const unread = host.listUnread().find(n => n.agentId === agentId && n.question)
      assert(unread?.readToken, 'The native app must first publish the exact unread occurrence')
      const requestId = randomUUID()
      port!.say({ t: 'question.read', agentId, requestId })
      await waitFor(() => port!.messages.some(m => m.t === 'question.state' && m.requestId === requestId))
      const question = port!.messages.find(m => m.t === 'question.state' && m.requestId === requestId)!
      assert(question.ok === true, 'The actual host question catalog must be readable')
      holdSeen = true
      port!.say({ t: 'notif.read', agentId, readToken: unread.readToken })
      await waitFor(() => seenPending.some(n => n.agentId === agentId && n.readToken === unread.readToken))
      await waitFor(() => !host.listUnread().some(n => n.agentId === agentId))
      checkpoint('later-before-read-ack', { agentId, requestId: question.id, readToken: unread.readToken })
      res.end(JSON.stringify({ question, readToken: unread.readToken })); return
    }
    if (command.op === 'release-seen') {
      const pending = seenPending.splice(0)
      assert(pending.length === 1 && pending[0].agentId === agentId, 'Release only the exact held read acknowledgement')
      holdSeen = false
      for (const seen of pending) await cable.agentSeen(seen.agentId, seen.readToken)
      checkpoint('read-ack-released', { agentId, readToken: pending[0].readToken })
      res.end(JSON.stringify({ released: pending })); return
    }
    const requestId = command.requestId
    assert(/^fixture-question-[a-z]+$/.test(requestId), 'Only fixture question identities are allowed')
    const current = openQuestions.get(agentId) as { payload?: { requestId?: string } } | undefined
    if (current?.payload?.requestId === requestId) openQuestions.delete(agentId)
    notifications.answered(agentId, requestId)
    backend.sendLocal({ type: 'commander_question_close', agentId, payload: { requestId } })
    await cable.questionClose(agentId, requestId)
    const stillOpen = openQuestions.get(agentId) as { payload?: { requestId?: string } } | undefined
    checkpoint(stillOpen ? 'stale-close-rejected' : 'question-closed', { agentId, requestId,
      ...(stillOpen ? { currentRequestId: stillOpen.payload?.requestId } : {}) })
    res.end(JSON.stringify({ closed: requestId, currentRequestId: stillOpen?.payload?.requestId ?? null })); return
  }
  if (req.url === '/selection' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); assert(Buffer.concat(chunks).length < 4096) }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert(agents.some(a => a.agentId === command.agentId), 'Only fixture agents are allowed')
    assert(['begin', 'step', 'extend', 'cancel', 'match', 'lines'].includes(command.op), 'Only selection operations are allowed')
    const requestId = carryWireStart === undefined ? randomUUID() : `pick-${++carrySelectionSerial}`
    port!.say({ ...command, t: 'selection', requestId,
      ...(carryWireStart !== undefined && command.op === 'begin'
        ? { selectionId: `pick-${randomBytes(8).toString('hex')}` } : {}) })
    await waitFor(() => port!.messages.some(m => m.requestId === requestId))
    const result = port!.messages.find(m => m.requestId === requestId)!
    cases.push({ command, result }); res.end(JSON.stringify(result)); return
  }
  res.statusCode = 404; res.end('{}')
})().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }) })
server.on('upgrade', (request, socket) => {
  if (request.url !== '/api/local-ws') return
  // Observes only this private server's accepted transport. No user socket or
  // process discovery is involved in the reconnect scenario.
  const owned = socket as Socket
  appSockets.add(owned); owned.once('close', () => appSockets.delete(owned))
})
const local = attachLocalWsServer(server, { machineId: 'm', backend,
  openQuestions: () => [...openQuestions.values()],
  onAppUnread: (items: UnreadNotification[]) => {
    const saved = { sequence: appUnreadEvents.length + 1, items: structuredClone(items) }
    appUnreadEvents.push(saved)
    wireEvents.push({ event: 'app-unread-parsed', ...saved })
    host.setUnread(items); void cable.replaceNotifications(items)
  },
  onAgentSeen: (agentId, readToken) => {
    if (holdSeen) seenPending.push({ agentId, readToken })
    else void cable.agentSeen(agentId, readToken)
  },
  onSelectionReply: (id, machineId, payload) => {
    appSelectionReplies.push({ connection: id, machineId, payload: structuredClone(payload) })
    selection.reply(id, machineId, payload)
  },
  onVisitReply: (id, machineId, payload) => {
    appVisitReplies.push({ connection: id, machineId, payload: structuredClone(payload) })
    visit.reply(id, machineId, payload)
  },
  onAppFocusState: (machineId, agentId, connId) => {
    focus = agentId ? { machineId, agentId, connId } : undefined; selection.focusChanged()
  },
  onAppDisconnect: (_machine, id) => { if (focus?.connId === id) focus = undefined; selection.focusChanged() },
  onAppPanes: ids => host.setDesk(ids), onAppSwarms: swarms => host.setSwarms(swarms),
})
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const expiry = setTimeout(finish, 12 * 60_000)
process.once('SIGINT', finish); process.once('SIGTERM', finish)
try {
  const emitter = join(root, 'output.cjs')
  await writeFile(emitter, 'const fs=require("node:fs");let sequence=0;for(let i=0;i<100;i++) process.stdout.write(`  ${process.argv[2]} passage ${i}\\r\\n`); process.stdin.resume(); setInterval(()=>{try{const next=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));if(next.sequence>sequence){sequence=next.sequence;if(Array.isArray(next.lines)){for(const line of next.lines)process.stdout.write(`${line}\\r\\n`)}else process.stdout.write(`  ${process.argv[2]} ${next.marker} ${sequence}\\r\\n`)}}catch{}},30);\n')
  for (let i = 0; i < 2; i++) {
    const marker = `OWNED_TERMINAL_${i}`
    const outputControl = join(root, `output-${i}.json`)
    const paneId = await tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `pro-fixture-${i}`,
      '-x', '100', '-y', '36', [process.execPath, emitter, marker, outputControl].map(quote).join(' '))
    assert(/^%\d+$/.test(paneId), `Invalid owned pane: ${JSON.stringify(paneId)}`)
    ownedPids.push(Number(await tmux.run('display-message', '-p', '-t', paneId, '#{pane_pid}')))
    const row = registry.openPendingAgent({ engine: 'terminal', runtimes: [{ backend: 'tmux', paneId }],
      cwd: root, defaultName: i === 0 ? 'Selected output' : 'Other work' })
    assert(row, `Cannot register owned pane ${paneId}; routes: ${JSON.stringify(registry.list().map(r => r.runtimes))}`)
    registry.setLaunch(row.agentId, { state: 'ready' }); agents.push({ agentId: row.agentId, marker })
    outputControls.set(row.agentId, { path: outputControl, sequence: 0 })
  }
  await host.listAgents(); cable.start(); await waitFor(() => !!port)
  port!.say({ t: 'hello', product: 'harness', mac: '02:00:00:00:00:31', fw: 'native-fixture' })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await writeFile(join(output, 'endpoint.json'), JSON.stringify({ endpoint, root, socket: tmux.socket, agents }))
  console.log(JSON.stringify({ endpoint, output })); await finished
} finally {
  clearTimeout(expiry); process.off('SIGINT', finish); process.off('SIGTERM', finish)
  selection.cancel(); visit.cancel(); await cable.stop(); await local.close(); await streams.stop(); await backend.stop()
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
  await tmux.close(); await rm(root, { recursive: true, force: true })
  const socketRemoved = await access(tmux.socket).then(() => false, () => true)
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  await waitFor(() => ownedPids.every(pid => !alive(pid)))
  await writeFile(join(output, 'peer-result.json'), JSON.stringify({ inputFrames, resizeFrames, cases,
    answerAttempts, resultCases, latestCases, carryCases, carryDispatches, transcriptCalls, appVisitCommands, appVisitReplies,
    hostDispatchAttempts, findCases, foundCarry,
    privateSocketRemoved: socketRemoved, ownedProcessesExited: ownedPids.every(pid => !alive(pid)),
    syntheticOutput: true, physicalDevice: false }, null, 2))
  await writeFile(join(output, 'question-cable-replay.json'), JSON.stringify({ schema: 1,
    kind: 'same-session-question-attention', events: wireEvents.slice(0, resultWireStart),
    limitations: ['synthetic question metadata', 'no terminal answer input', 'no reconnect or physical device'] }, null, 2))
  await writeFile(join(output, 'result-cable-replay.json'), JSON.stringify({ schema: 1,
    kind: 'receipt-owned-result-words', events: resultWireStart === undefined ? [] : wireEvents.slice(resultWireStart, latestWireStart),
    ...(resultEvidenceBeforeLatest ?? { appUnreadEvents, readAttempts, readRequests, resultCases }),
    limitations: ['synthetic completion metadata', 'parsed app_unread callback plus exact cable frames',
      'app transport reconnect, not app restart durability', 'no terminal input or physical device'] }, null, 2))
  await writeFile(join(output, 'latest-cable-replay.json'), JSON.stringify({ schema: 1,
    kind: 'summary-latest-output-return', machineId: 'm', agents,
    events: latestWireStart === undefined ? [] : wireEvents.slice(latestWireStart, carryWireStart),
    retainedSummaryFrame, retainedSummary,
    ...(latestEvidenceBeforeCarry ?? { latestCases, appVisitCommands, appVisitReplies, latestNativeViewport }),
    limitations: ['synthetic completion metadata and output from owned file-controlled emitters',
      'actual native Desktop and local socket; physical serial substituted',
      'Latest is live tail, not the historical terminal position of the Summary'] }, null, 2))
  await writeFile(join(output, 'carry-cable-replay.json'), JSON.stringify({ schema: 1,
    kind: 'selected-passage-reviewed-carry-return', machineId: 'm', agents,
    events: carryWireStart === undefined ? [] : wireEvents.slice(carryWireStart, findWireStart),
    ...(carryEvidenceBeforeFind ?? { carriedSource, scriptedWords, carryCases, carryDispatches, transcriptCalls, carryNativeViewport }),
    limitations: ['synthetic transcript at host.transcribe; no microphone or transcription quality',
      'one explicit host dispatch captured in owned memory; no terminal input or vendor acceptance',
      'owned terminal rows do not establish native agent capture readiness',
      'actual native Desktop and local socket; physical serial substituted'] }, null, 2))
  await writeFile(join(output, 'spoken-find-cable-replay.json'), JSON.stringify({ schema: 1,
    kind: 'spoken-output-find-range-carry', machineId: 'm', agents,
    events: findWireStart === undefined ? [] : wireEvents.slice(findWireStart),
    phrase: findPhrase, transcripts: findWords, findCases, foundCarry, findNativeEvidence,
    hostDispatchAttemptsBefore: 1, hostDispatchAttemptsAfter: hostDispatchAttempts, inputFrames,
    limitations: ['scripted transcript, no microphone or transcription quality',
      'real native app and local socket, physical serial substituted',
      'output search creates no Return bookmark and sends no task'] }, null, 2))
}
