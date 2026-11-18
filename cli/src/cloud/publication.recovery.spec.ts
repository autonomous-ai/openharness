import { createQuestionPresentations } from '../core/questions.js'
import { cloudFactory } from '../testing/sessionFactories.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startCloudService } from './service.js'
import { createCloudAgents } from '../core/agents/cloud.js'
import type { CloudCore } from '../core/api.js'
import type { CloudAdapter } from './types.js'

const diskFault = vi.hoisted(() => ({ pending: false, intentRename: false, failWrites: 0, hits: 0, writes: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (String(args[0]).endsWith('.tmp')) {
      diskFault.writes++
      if (diskFault.failWrites > 0) { diskFault.failWrites--; diskFault.hits++; throw new Error('fixture provider write failed') }
    }
    if (diskFault.pending && String(args[0]).endsWith('.tmp') && typeof args[1] === 'string') {
      const saved = JSON.parse(args[1])
      if (saved.publication?.pending?.owners.some((owner: { busy: boolean }) => !owner.busy)) {
        diskFault.pending = false; diskFault.hits++
        throw new Error('fixture intent write failed')
      }
    }
    return actual.writeFileSync(...args)
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (diskFault.intentRename && String(args[0]).endsWith('.tmp')) {
      const saved = JSON.parse(actual.readFileSync(args[0], 'utf8'))
      if (saved.publication?.pending?.owners.some((owner: { busy: boolean }) => !owner.busy)) {
        diskFault.intentRename = false; diskFault.hits++
        throw new Error('fixture intent rename failed')
      }
    }
    return actual.renameSync(...args)
  } }
})

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloud-publication-'))
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  let service: ReturnType<typeof startCloudService>
  const freshCore = () => createCloudAgents({ ownsFactory: cloudFactory, port: () => service?.port ?? null, clients, questions: createQuestionPresentations(), log: () => {} })
  let core = freshCore(), disconnected = false, lostAck = false, publicationCalls = 0, holdAcks = false
  const heldAcks: Array<() => void> = []
  let heldQuestion: 'ask' | 'unask' | null = null
  let beforePublish = () => {}
  let poll: (() => void) | undefined
  const rejected = () => { const result = Promise.reject(new Error('fixture disconnect')); void result.catch(() => {}); return result }
  const doors: CloudCore = {
    checkpoint: () => disconnected ? rejected() : core.doors.checkpoint(),
    publish: (rows, cards) => {
      publicationCalls++
      if (disconnected) return rejected()
      beforePublish()
      const result = core.doors.publish(rows, cards)
      if (holdAcks) return new Promise(resolve => { heldAcks.push(() => resolve(result)) })
      return lostAck ? rejected() : result
    },
    ask: (...args) => {
      const result = core.doors.ask(...args)
      return heldQuestion === 'ask' ? new Promise(resolve => { heldAcks.push(() => resolve(result)) }) : result
    },
    unask: (...args) => {
      const result = core.doors.unask(...args)
      return heldQuestion === 'unask' ? new Promise(resolve => { heldAcks.push(() => resolve(result)) }) : result
    },
  }
  const adapter = { id: 'devin-cloud' as const,
    start: vi.fn(async () => ({ remote: { id: 'fixture' }, links: [] })),
    send: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    poll: vi.fn(async () => ({ state: 'idle' as const, messages: [{ id: 'done', text: 'Finished the requested work.', at: '2026-11-18T00:00:00Z' }] })),
  } satisfies CloudAdapter
  const makeService = () => startCloudService({ dataDir, core: doors, log: () => {},
    now: () => Date.parse('2026-11-18T00:00:00Z'),
    bridge: { connections: async () => [], mcpUrl: () => '', api: async () => ({ status: 200, json: {} }) },
    setTimer: fn => { poll = fn; return fn }, clearTimer: () => {},
    adapters: { 'devin-cloud': adapter },
  })
  service = makeService()
  const completions = () => clients.sendCommander.mock.calls.map(([frame]) => frame)
    .filter(frame => frame.type === 'commander_event' && frame.payload.notification?.kind === 'done')
  return { row: () => JSON.parse(readFileSync(join(dataDir, 'cloud/harnesses.json'), 'utf8')).harnesses[0].harness, dataDir, clients, completions, adapter, publicationCalls: () => publicationCalls, poll: () => poll!(), get core() { return core }, get service() { return service },
    async create() {
      service.republish()
      expect(await service.port.create({ engine: 'devin-cloud', prompt: 'fixture' })).toHaveProperty('agent')
      await vi.waitFor(() => expect(core.frames()[0]?.cloud.state).toBe('working'))
      return core.frames()[0].id
    },
    async complete() {
      poll!()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dataDir, 'cloud/harnesses.json'), 'utf8')).harnesses[0].harness.state).toBe('idle'))
    },
    holdAcks() { holdAcks = true },
    holdQuestion(kind: 'ask' | 'unask') { heldQuestion = kind },
    observePublish(observer: () => void) { beforePublish = observer },
    releaseAck() { const next = heldAcks.shift(); expect(next).toBeDefined(); next!() },
    pendingAcks: () => heldAcks.length,
    releaseAll() { holdAcks = false; heldQuestion = null; for (const release of heldAcks.splice(0)) release() },
    disconnect() { disconnected = true },
    dropAck() { lostAck = true },
    reconnect() { disconnected = lostAck = false; return service.republish() },
    restartComponent() { service.stop(); service = makeService() },
    restartDaemon() { service.stop(); core = freshCore(); service = makeService() },
    replaceCoreImage() { const saved = JSON.parse(readFileSync(join(dataDir, 'cloud/harnesses.json'), 'utf8')); core.doors.publish([{ ...saved.harnesses[0].harness, agentId: 'cloud_other' }]) },
    removeJournal() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); delete saved.publication; writeFileSync(file, JSON.stringify(saved)) },
    damageCheckpoint() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); saved.publication.pending.owners[0].told = 'Damaged checkpoint'; writeFileSync(file, JSON.stringify(saved)) },
    corruptJournal() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); saved.publication = { corrupt: true }; writeFileSync(file, JSON.stringify(saved)) },
    close() { diskFault.pending = diskFault.intentRename = false; diskFault.failWrites = 0; service.stop(); rmSync(dataDir, { recursive: true, force: true }) },
  }
}

it.each(['retained', 'component restarted', 'daemon restarted'] as const)('recovers a missed completion with %s', async recovery => {
  const f = fixture()
  try {
    await f.create(); f.disconnect(); await f.complete()
    expect(f.core.frames()[0].cloud.state).toBe('working')
    if (recovery === 'component restarted') f.restartComponent()
    if (recovery === 'daemon restarted') f.restartDaemon()
    f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0]?.cloud.state).toBe('idle'))
    expect(f.completions()).toHaveLength(recovery === 'daemon restarted' ? 0 : 1)
  } finally { f.close() }
})

it('adopts a completion with a lost acknowledgement before applying a later rename', async () => {
  const f = fixture()
  try {
    const id = await f.create(); f.dropAck(); await f.complete()
    expect(f.completions()).toHaveLength(1)
    await f.service.port.rename(id, 'Renamed', f.row())
    f.restartComponent(); f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0]?.name).toBe('Renamed'))
    expect(f.completions()).toHaveLength(1)
  } finally { f.close() }
})


it.each(['missing', 'corrupt', 'unmatched', 'damaged checkpoint'] as const)('holds an unprovable %s journal until an explicit daemon restart', async broken => {
  const f = fixture()
  try {
    const id = await f.create()
    if (broken === 'missing') f.removeJournal(); else if (broken === 'corrupt') f.corruptJournal(); else if (broken === 'unmatched') f.replaceCoreImage(); else f.damageCheckpoint()
    f.restartComponent(); f.reconnect()
    await vi.waitFor(async () => expect(await f.service.requests.cloud_agents({}, { owner: true, local: true }))
      .toMatchObject({ error: 'CLOUD_PUBLICATION_RECOVERY_REQUIRED' }))
    expect(await f.service.port.rename(id, 'Must not be applied', f.row())).toMatchObject({ error: 'CLOUD_PUBLICATION_RECOVERY_REQUIRED' })
    f.restartComponent(); f.reconnect()
    await vi.waitFor(async () => expect(await f.service.requests.cloud_agents({}, { owner: true, local: true }))
      .toMatchObject({ error: 'CLOUD_PUBLICATION_RECOVERY_REQUIRED' }))
    f.restartDaemon(); f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0]?.id).toBe(id))
    expect(f.completions()).toEqual([])
    expect(JSON.parse(readFileSync(join(f.dataDir, 'cloud/harnesses.json'), 'utf8')).harnesses[0].remote.id).toBe('fixture')
  } finally { f.close() }
})


it.each(['before send', 'after apply'] as const)('keeps optimistic working out of provider state across a crash %s', async crash => {
  const f = fixture()
  try {
    const id = await f.create(); await f.complete()
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    f.adapter.send.mockImplementationOnce(() => new Promise(() => {}))
    if (crash === 'before send') f.disconnect(); else f.dropAck()
    void f.service.port.deliver(id, 'Next work')
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledOnce())
    // A concurrent ordinary save must not make the other operation's optimistic state durable either.
    await f.service.port.rename(id, 'After crash', f.row())
    const file = join(f.dataDir, 'cloud/harnesses.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).harnesses[0].harness.state).toBe('idle')
    f.restartComponent(); f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0]?.cloud.state).toBe('idle'))
    await vi.waitFor(() => expect(f.core.frames()[0]?.name).toBe('After crash'))
    expect(f.completions()).toHaveLength(1)
  } finally { f.close() }
})

it('reserves bounded output before starting or sending provider work', async () => {
  const f = fixture()
  try {
    const id = await f.create()
    let release!: () => void
    const held = new Promise<{ remote: { id: string }; links: [] }>(resolve => { release = () => resolve({ remote: { id: 'later' }, links: [] }) })
    f.adapter.start.mockImplementation(() => held)
    const starting = Array.from({ length: 10 }, () => f.service.port.create({ engine: 'devin-cloud', prompt: 'Queued work' }))
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledTimes(11))
    expect(await f.service.port.create({ engine: 'devin-cloud', prompt: 'Over capacity' })).toMatchObject({ error: 'CLOUD_PUBLICATION_BUSY' })
    expect(await f.service.port.deliver(id, 'Must not send')).toMatchObject({ ok: false, error: 'CLOUD_PUBLICATION_BUSY' })
    expect(await f.service.port.stopHarness(id)).toMatchObject({ error: 'CLOUD_PUBLICATION_BUSY' })
    expect(f.adapter.send).not.toHaveBeenCalled()
    expect(f.adapter.stop).not.toHaveBeenCalled()
    release()
    expect((await Promise.all(starting)).every(result => 'agent' in result)).toBe(true)
  } finally { f.close() }
})

it.each(['broken JSON', 'unknown provider row'] as const)('does not erase %s during presentation recovery', async damage => {
  const f = fixture()
  try {
    await f.create()
    const file = join(f.dataDir, 'cloud/harnesses.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.harnesses.push({ harness: { agentId: 'cloud_unknown', agent: 'unknown-provider' }, remote: { id: 'unknown-session' } })
    const damaged = damage === 'broken JSON' ? '{unfinished provider state' : JSON.stringify(saved)
    writeFileSync(file, damaged)
    f.restartDaemon(); f.reconnect()
    await vi.waitFor(async () => expect(await f.service.requests.cloud_agents({}, { owner: true, local: true })).toMatchObject({ error: 'CLOUD_STATE_UNAVAILABLE' }))
    expect(await f.service.port.create({ engine: 'devin-cloud', prompt: 'No overwrite' })).toMatchObject({ error: 'CLOUD_STATE_UNAVAILABLE' })
    expect(readFileSync(file, 'utf8')).toBe(damaged)
  } finally { f.close() }
})


it('recovers a saved provider completion after its pending-intent write fails before send', async () => {
  const f = fixture()
  try {
    await f.create()
    diskFault.hits = 0; diskFault.pending = true
    await f.complete()
    await vi.waitFor(() => expect(diskFault.hits).toBe(1))
    expect(f.core.frames()[0].cloud.state).toBe('working')
    f.restartComponent(); f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0]?.cloud.state).toBe('idle'))
    expect(f.completions()).toHaveLength(1)
  } finally { diskFault.pending = false; f.close() }
})


it.each(['accepted', 'pending'] as const)('skips redundant writes/publications after an intact %s match, including another restart', async match => {
  const f = fixture()
  try {
    const id = await f.create(), file = join(f.dataDir, 'cloud/harnesses.json')
    if (match === 'accepted') await f.service.port.rename(id, f.core.frames()[0].name, f.row())
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.publication[match].fingerprint).toBe(await f.core.doors.checkpoint())
    if (match === 'accepted') expect(saved.publication.pending).toBeNull()
    else expect(saved.publication.accepted.fingerprint).not.toBe(saved.publication.pending.fingerprint)
    const before = { writes: diskFault.writes, publications: f.publicationCalls(), bytes: readFileSync(file, 'utf8') }
    for (let restart = 0; restart < 2; restart++) {
      f.restartComponent(); await f.reconnect()
      expect(f.publicationCalls()).toBe(before.publications)
      expect(diskFault.writes).toBe(before.writes)
      expect(readFileSync(file, 'utf8')).toBe(before.bytes)
    }
    await f.complete()
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(f.completions()[0].agentId).toBe(id)
  } finally { f.close() }
})

it('replays the current question without republishing its already-proven owner image', async () => {
  const f = fixture()
  try {
    await f.create()
    f.adapter.poll.mockResolvedValueOnce({ state: 'needs_input', messages: [{ id: 'question', text: 'Which branch?', at: 'x' }],
      question: { text: 'Which branch?', choices: ['main', 'dev'] } } as never)
    f.poll()
    await vi.waitFor(() => expect(f.core.frames()[0]?.cloud.state).toBe('needs_input'))
    const question = f.clients.sendLocal.mock.calls.at(-1)![0]
    expect(question.type).toBe('commander_question')
    const before = { writes: diskFault.writes, publications: f.publicationCalls(), questions: f.clients.sendLocal.mock.calls.length }
    f.disconnect(); f.service.disconnected(); await f.reconnect()
    await vi.waitFor(() => expect(f.clients.sendLocal.mock.calls.length).toBe(before.questions + 1))
    expect(f.clients.sendLocal).toHaveBeenLastCalledWith(question)
    expect(f.publicationCalls()).toBe(before.publications)
    expect(diskFault.writes).toBe(before.writes)
  } finally { f.close() }
})

it('reconstructs a question only on the next provider look after a component restart', async () => {
  const f = fixture()
  try {
    const update = { state: 'needs_input', messages: [{ id: 'question', text: 'Which branch?', at: 'x' }],
      question: { text: 'Which branch?', choices: ['main', 'dev'] } }
    await f.create(); f.adapter.poll.mockResolvedValueOnce(update as never); f.poll()
    await vi.waitFor(() => expect(f.core.frames()[0]?.cloud.state).toBe('needs_input'))
    const first = f.clients.sendLocal.mock.calls.at(-1)![0]
    expect(first.type).toBe('commander_question')
    const before = { writes: diskFault.writes, publications: f.publicationCalls(), questions: f.clients.sendLocal.mock.calls.length }
    f.restartComponent(); await f.reconnect()
    expect(f.clients.sendLocal.mock.calls).toHaveLength(before.questions)
    expect(f.publicationCalls()).toBe(before.publications)
    expect(diskFault.writes).toBe(before.writes)
    f.adapter.poll.mockResolvedValueOnce(update as never); f.poll()
    await vi.waitFor(() => expect(f.clients.sendLocal.mock.calls.length).toBe(before.questions + 2))
    const next = f.clients.sendLocal.mock.calls.at(-1)![0]
    expect(next).toMatchObject({ type: 'commander_question', agentId: first.agentId,
      payload: { questions: first.payload.questions, notification: { kind: 'needsYou', id: next.payload.requestId } } })
    expect(next.payload.requestId).not.toBe(first.payload.requestId)
    expect(f.clients.sendLocal.mock.calls.at(-2)![0]).toMatchObject({ type: 'commander_question_close', payload: { requestId: first.payload.requestId } })
    expect(f.completions()).toEqual([])
  } finally { f.close() }
})


it('accepts a real service answer that closes its question before the provider reply', async () => {
  const f = fixture()
  try {
    const id = await f.create()
    f.adapter.poll.mockResolvedValueOnce({ state: 'needs_input', messages: [{ id: 'answer-question', text: 'Which branch?', at: 'x' }], question: { text: 'Which branch?', choices: ['main', 'dev'] } } as never)
    f.poll()
    await vi.waitFor(() => expect(f.clients.sendLocal.mock.calls.at(-1)?.[0].type).toBe('commander_question'))
    const requestId = f.clients.sendLocal.mock.calls.at(-1)![0].payload.requestId
    let finish!: () => void
    f.adapter.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const answering = f.core.answer({ requestId, answers: { answer: 'main' } })
    expect(answering).not.toBeNull()
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.clients.sendLocal).toHaveBeenLastCalledWith({ type: 'commander_question_close', agentId: id, dbSessionId: id, payload: { requestId } }))
    expect(f.core.answer({ requestId, answers: { answer: 'dev' } })).toBeNull()
    finish()
    expect(await answering).toEqual({ ok: true })
    expect(f.adapter.send).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'main')
  } finally { f.close() }
})


it('saves an idle changed rename and its publication intent in one synchronous write', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    const before = diskFault.writes
    expect(await f.service.port.rename(id, 'Combined rename', f.row())).toHaveProperty('agent.name', 'Combined rename')
    expect(diskFault.writes - before).toBe(1)
    expect(f.row().name).toBe('Combined rename')
    expect(f.core.frames()[0].name).toBe('Combined rename')
  } finally { f.close() }
})

it('saves a settled provider completion and its intent in one synchronous write', async () => {
  const f = fixture()
  try {
    await f.create(); await f.reconnect()
    const before = diskFault.writes
    await f.complete()
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(diskFault.writes - before).toBe(1)
    expect(f.row().state).toBe('idle')
  } finally { f.close() }
})

it('keeps queued provider saves before their later intents and combines only the settled rename', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.complete(); await f.reconnect()
    const before = diskFault.writes, publications = f.publicationCalls()
    f.holdAcks()
    expect(await f.service.port.deliver(id, 'Next work')).toEqual({ ok: true })
    expect(f.publicationCalls() - publications).toBe(1)
    expect(f.pendingAcks()).toBe(1)
    expect(diskFault.writes - before).toBe(2) // optimistic intent, then immediate durable provider save
    f.releaseAck()
    await vi.waitFor(() => expect(f.publicationCalls() - publications).toBe(2))
    f.adapter.poll.mockResolvedValueOnce({ state: 'idle', messages: [{ id: 'new-done', text: 'Finished new work.', at: 'x' }] } as never)
    await f.complete()
    expect(diskFault.writes - before).toBe(4) // second intent, then completion saved while its predecessor waits
    expect(f.publicationCalls() - publications).toBe(2)
    f.releaseAck()
    await vi.waitFor(() => expect(f.publicationCalls() - publications).toBe(3))
    expect(diskFault.writes - before).toBe(5)
    f.releaseAll(); await new Promise<void>(resolve => setImmediate(resolve)) // same post-cycle quiesce as the frozen relay workload
    expect(await f.service.port.rename(id, 'Settled rename', f.row())).toHaveProperty('agent.name', 'Settled rename')
    expect(diskFault.writes - before).toBe(6) // six per cycle+rename means96 for the frozen16-cycle workload
    expect(f.publicationCalls() - publications).toBe(4)
  } finally { f.releaseAll(); f.close() }
})

it('commits the provider snapshot and pending intent before the first core effect', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    const before = diskFault.writes, observed: unknown[] = []
    f.observePublish(() => {
      const saved = JSON.parse(readFileSync(join(f.dataDir, 'cloud/harnesses.json'), 'utf8'))
      observed.push({ writes: diskFault.writes - before, provider: saved.harnesses[0], journal: saved.publication })
    })
    await f.service.port.rename(id, 'Durable before send', f.row())
    expect(observed).toEqual([expect.objectContaining({ writes: 1,
      provider: expect.objectContaining({ harness: expect.objectContaining({ name: 'Durable before send' }), remote: { id: 'fixture' } }),
      journal: expect.objectContaining({ pending: expect.objectContaining({ fingerprint: await f.core.doors.checkpoint() }) }),
    })])
  } finally { f.close() }
})

it.each(['temporary write', 'atomic rename'] as const)('saves the completed provider with the exact prior journal after an intent %s failure', async failure => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    // A no-change save materializes the current accepted-only journal; ACK itself performs no write.
    await f.service.port.rename(id, f.row().name, f.row())
    const file = join(f.dataDir, 'cloud/harnesses.json'), prior = JSON.parse(readFileSync(file, 'utf8')).publication
    const before = diskFault.writes, publications = f.publicationCalls(), hits = diskFault.hits
    if (failure === 'temporary write') diskFault.pending = true; else diskFault.intentRename = true
    await f.complete()
    expect(diskFault.hits - hits).toBe(1)
    expect(diskFault.writes - before).toBe(2)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.publication).toEqual(prior)
    expect(saved.harnesses[0]).toMatchObject({ harness: { state: 'idle', said: 'Finished the requested work.' }, remote: { id: 'fixture' } })
    expect(f.publicationCalls()).toBe(publications)
    expect(await f.service.requests.cloud_agents({}, { owner: true, local: true })).toMatchObject({ error: 'CLOUD_PUBLICATION_UNAVAILABLE' })
    f.restartComponent(); await f.reconnect()
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(f.core.frames()[0].cloud.state).toBe('idle')
    expect(f.adapter.start).toHaveBeenCalledOnce()
    expect(f.adapter.send).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('keeps the prior atomic file and reports failure when both the intent and fallback writes fail', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    const file = join(f.dataDir, 'cloud/harnesses.json'), prior = readFileSync(file, 'utf8')
    const before = diskFault.writes, publications = f.publicationCalls()
    diskFault.failWrites = 2
    await expect(f.service.port.rename(id, 'Not durable', f.row())).rejects.toThrow('fixture provider write failed')
    expect(diskFault.writes - before).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe(prior)
    expect(f.publicationCalls()).toBe(publications)
    expect(await f.service.requests.cloud_agents({}, { owner: true, local: true })).toMatchObject({ error: 'CLOUD_PUBLICATION_UNAVAILABLE' })
    f.restartComponent(); await f.reconnect()
    expect(f.core.frames()[0].name).toBe(JSON.parse(prior).harnesses[0].harness.name)
    expect(f.adapter.start).toHaveBeenCalledOnce()
    expect(f.adapter.send).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('does not append a failed provider save behind an in-flight publication', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.complete(); await f.reconnect()
    f.holdAcks()
    expect(await f.service.port.deliver(id, 'Next queued work')).toEqual({ ok: true })
    const publications = f.publicationCalls(), before = diskFault.writes, oldName = f.row().name
    diskFault.failWrites = 1
    await expect(f.service.port.rename(id, 'Never append', f.row())).rejects.toThrow('fixture provider write failed')
    expect(diskFault.writes - before).toBe(1)
    expect(f.row().name).toBe(oldName)
    f.releaseAll(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.publicationCalls() - publications).toBe(1) // Only the previously accepted deliver snapshot remains queued.
    expect(f.core.frames()[0].name).toBe(oldName)
  } finally { f.releaseAll(); f.close() }
})

it.each(['disconnected', 'unavailable'] as const)('saves before append when publication is %s', async state => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    if (state === 'disconnected') { f.disconnect(); f.service.disconnected() }
    else {
      f.dropAck(); await f.service.port.rename(id, 'Lost acknowledgement', f.row())
      await vi.waitFor(async () => expect(await f.service.requests.cloud_agents({}, { owner: true, local: true })).toMatchObject({ error: 'CLOUD_PUBLICATION_UNAVAILABLE' }))
    }
    const publications = f.publicationCalls(), before = diskFault.writes
    expect(await f.service.port.rename(id, 'Saved offline', f.row())).toHaveProperty('agent.name', 'Saved offline')
    expect(diskFault.writes - before).toBe(1)
    expect(f.publicationCalls()).toBe(publications)
    expect(f.row().name).toBe('Saved offline')
    await f.reconnect()
    await vi.waitFor(() => expect(f.core.frames()[0].name).toBe('Saved offline'))
  } finally { f.close() }
})

it('retains a no-change provider save without adding a publication', async () => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    const before = diskFault.writes, publications = f.publicationCalls()
    await f.service.port.rename(id, f.row().name, f.row())
    expect(diskFault.writes - before).toBe(1)
    expect(f.publicationCalls()).toBe(publications)
    expect(JSON.parse(readFileSync(join(f.dataDir, 'cloud/harnesses.json'), 'utf8')).publication.pending).toBeNull()
  } finally { f.close() }
})

it('saves provider output before surfacing an invalid presentation on the idle fast path', async () => {
  const f = fixture()
  try {
    await f.reconnect()
    f.adapter.start.mockResolvedValueOnce({ remote: { id: 'invalid-state' }, links: [], update: { state: 'invalid', messages: [] } } as never)
    const before = diskFault.writes, publications = f.publicationCalls()
    await expect(f.service.port.create({ engine: 'devin-cloud', prompt: 'Invalid provider result' })).rejects.toThrow('CLOUD_PUBLICATION_INVALID')
    expect(diskFault.writes - before).toBe(1)
    expect(f.publicationCalls()).toBe(publications)
    const saved = JSON.parse(readFileSync(join(f.dataDir, 'cloud/harnesses.json'), 'utf8'))
    expect(saved.harnesses[0]).toMatchObject({ harness: { state: 'invalid' }, remote: { id: 'invalid-state' } })
    expect(saved.publication.pending).toBeNull()
    expect(await f.service.requests.cloud_agents({}, { owner: true, local: true })).toMatchObject({ error: 'CLOUD_PUBLICATION_INVALID' })
    expect(f.adapter.start).toHaveBeenCalledOnce()
  } finally { f.close() }
})

it.each(['ask', 'unask'] as const)('does not append a failed provider save behind an in-flight %s', async kind => {
  const f = fixture()
  try {
    const id = await f.create(); await f.reconnect()
    if (kind === 'ask') f.holdQuestion(kind)
    f.adapter.poll.mockResolvedValueOnce({ state: 'needs_input', messages: [{ id: 'held-question', text: 'Which branch?', at: 'x' }], question: { text: 'Which branch?', choices: ['main'] } } as never)
    f.poll()
    await vi.waitFor(() => expect(f.row().state).toBe('needs_input'))
    if (kind === 'unask') {
      await f.reconnect(); await new Promise<void>(resolve => setImmediate(resolve))
      const requestId = f.clients.sendLocal.mock.calls.at(-1)![0].payload.requestId
      f.holdQuestion(kind)
      expect(await f.service.port.answer(id, requestId, { answer: 'main' })).toEqual({ ok: true })
    }
    expect(f.pendingAcks()).toBe(1)
    const before = diskFault.writes, publications = f.publicationCalls(), oldName = f.row().name
    diskFault.failWrites = 1
    await expect(f.service.port.rename(id, 'Failed while question waits', f.row())).rejects.toThrow('fixture provider write failed')
    expect(diskFault.writes - before).toBe(1)
    expect(f.row().name).toBe(oldName)
    f.releaseAll(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.publicationCalls() - publications).toBe(kind === 'ask' ? 1 : 2)
    expect(f.core.frames()[0].name).toBe(oldName)
  } finally { f.releaseAll(); f.close() }
})

it('saves changed provider-only metadata when its public presentation is unchanged', async () => {
  const f = fixture()
  try {
    await f.create(); await f.reconnect()
    const before = diskFault.writes, publications = f.publicationCalls(), file = join(f.dataDir, 'cloud/harnesses.json')
    f.adapter.poll.mockResolvedValueOnce({ state: 'working', messages: [], remote: { run: 'new-provider-run' } } as never)
    f.poll()
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8')).harnesses[0].remote).toEqual({ id: 'fixture', run: 'new-provider-run' }))
    expect(diskFault.writes - before).toBe(1)
    expect(f.publicationCalls()).toBe(publications)
    f.restartComponent(); await f.reconnect()
    expect(JSON.parse(readFileSync(file, 'utf8')).harnesses[0].remote).toEqual({ id: 'fixture', run: 'new-provider-run' })
  } finally { f.close() }
})
