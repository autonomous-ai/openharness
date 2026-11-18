import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startCloudService } from './service.js'
import { createCloudAgents } from '../core/agents/cloud.js'
import type { CloudCore } from '../core/api.js'
import type { CloudAdapter } from './types.js'

const diskFault = vi.hoisted(() => ({ pending: false, hits: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (diskFault.pending && String(args[0]).endsWith('.tmp') && typeof args[1] === 'string') {
      const saved = JSON.parse(args[1])
      if (saved.publication?.pending?.owners.some((owner: { busy: boolean }) => !owner.busy)) {
        diskFault.pending = false; diskFault.hits++
        throw new Error('fixture intent write failed')
      }
    }
    return actual.writeFileSync(...args)
  } }
})

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloud-publication-'))
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  const freshCore = () => createCloudAgents({ port: () => null, clients, openQuestions: new Map(), log: () => {} })
  let core = freshCore(), disconnected = false, lostAck = false
  let poll: (() => void) | undefined
  const rejected = () => { const result = Promise.reject(new Error('fixture disconnect')); void result.catch(() => {}); return result }
  const doors: CloudCore = {
    checkpoint: () => disconnected ? rejected() : core.doors.checkpoint(),
    publish: (rows, cards) => {
      if (disconnected) return rejected()
      const result = core.doors.publish(rows, cards)
      return lostAck ? rejected() : result
    },
    ask: (...args) => core.doors.ask(...args), unask: (...args) => core.doors.unask(...args),
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
  let service = makeService()
  const completions = () => clients.sendCommander.mock.calls.map(([frame]) => frame)
    .filter(frame => frame.type === 'commander_event' && frame.payload.notification?.kind === 'done')
  return { dataDir, clients, completions, adapter, get core() { return core }, get service() { return service },
    async create() {
      service.republish()
      expect((await service.port.create({ engine: 'devin-cloud', prompt: 'fixture' })).ok).toBe(true)
      await vi.waitFor(() => expect(core.frames()[0]?.cloud.state).toBe('working'))
      return core.frames()[0].id
    },
    async complete() {
      poll!()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dataDir, 'cloud/harnesses.json'), 'utf8')).harnesses[0].harness.state).toBe('idle'))
    },
    disconnect() { disconnected = true },
    dropAck() { lostAck = true },
    reconnect() { disconnected = lostAck = false; service.republish() },
    restartComponent() { service.stop(); service = makeService() },
    restartDaemon() { service.stop(); core = freshCore(); service = makeService() },
    replaceCoreImage() { const saved = JSON.parse(readFileSync(join(dataDir, 'cloud/harnesses.json'), 'utf8')); core.doors.publish([{ ...saved.harnesses[0].harness, agentId: 'cloud_other' }]) },
    removeJournal() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); delete saved.publication; writeFileSync(file, JSON.stringify(saved)) },
    damageCheckpoint() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); saved.publication.pending.owners[0].told = 'Damaged checkpoint'; writeFileSync(file, JSON.stringify(saved)) },
    corruptJournal() { const file = join(dataDir, 'cloud/harnesses.json'); const saved = JSON.parse(readFileSync(file, 'utf8')); saved.publication = { corrupt: true }; writeFileSync(file, JSON.stringify(saved)) },
    close() { service.stop(); rmSync(dataDir, { recursive: true, force: true }) },
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
    await f.service.port.rename(id, 'Renamed')
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
    expect(await f.service.port.rename(id, 'Must not be applied')).toMatchObject({ ok: false, error: 'CLOUD_PUBLICATION_RECOVERY_REQUIRED' })
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
    await f.service.port.rename(id, 'After crash')
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
    expect(await f.service.port.create({ engine: 'devin-cloud', prompt: 'Over capacity' })).toMatchObject({ ok: false, error: 'CLOUD_PUBLICATION_BUSY' })
    expect(await f.service.port.deliver(id, 'Must not send')).toMatchObject({ ok: false, error: 'CLOUD_PUBLICATION_BUSY' })
    expect(await f.service.port.stopHarness(id)).toMatchObject({ ok: false, error: 'CLOUD_PUBLICATION_BUSY' })
    expect(f.adapter.send).not.toHaveBeenCalled()
    expect(f.adapter.stop).not.toHaveBeenCalled()
    release()
    expect((await Promise.all(starting)).every(result => result.ok)).toBe(true)
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
    expect(await f.service.port.create({ engine: 'devin-cloud', prompt: 'No overwrite' })).toMatchObject({ ok: false, error: 'CLOUD_STATE_UNAVAILABLE' })
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
