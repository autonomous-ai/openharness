import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentView } from '../../core/api.js'
import { createDeviceEvidence, DeviceEvidencePool, EVIDENCE_BYTES, EVIDENCE_CAPTURES, type DeviceEvidenceReader } from './evidenceReader.js'

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})

const homes: string[] = [], readers: DeviceEvidenceReader[] = []
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.useRealTimers(); vi.restoreAllMocks()
})

function fixture(pool = new DeviceEvidencePool()) {
  const home = mkdtempSync(join(tmpdir(), 'device-evidence-')); homes.push(home)
  const file = join(home, 'session.jsonl'); writeFileSync(file, '')
  const agent = { agentId: 'agent', sessionId: 'session', engine: 'claude', active: true, transcriptPath: file,
    boundAt: 500, evidenceRevision: 1, processIdentity: { pid: 42, executable: 'claude', startMarker: 'birth' },
  } as AgentView
  const observed = vi.fn(), gap = vi.fn(), failed = vi.fn(), resolve = vi.fn(async (_id: string): Promise<AgentView | null> => agent), needed = vi.fn(() => true)
  const reader = createDeviceEvidence({ pool, observe: observed, resolve, gap, failed, needed }); readers.push(reader)
  const input = (agentId = agent.agentId, deliveryId = 'delivery') => reader.input({ agentId, deliveryId, when: 'composer', phase: 'dispatching', sessionId: agent.sessionId, content: 'hello' })
  return { home, file, agent, observed, gap, failed, resolve, needed, reader, pool, input }
}

describe('the devices process owns raw evidence reads', () => {
  it('includes a boundary arriving after the active read captured its end in the same bounded operation', async () => {
    const f = fixture(), original = vi.mocked(open).getMockImplementation()!
    await f.reader.arm(f.agent, 'delivery')
    const first = JSON.stringify({ value: 'x'.repeat(2_048) })
    appendFileSync(f.file, first + '\n')
    let release!: () => void, entered!: () => void, held = false
    const reading = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await original(...args)
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (!held && length > 1_024) { held = true; entered(); await new Promise<void>(resolve => { release = resolve }) }
          return handle.read(buffer, offset, length, position)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      f.input(); await reading
      appendFileSync(f.file, '{"last":true}\n')
      const boundary = f.reader.flush('agent')
      expect(f.pool.active).toBe(1)
      release(); await boundary
      expect(f.observed.mock.calls.map(call => call[3])).toEqual([first, '{"last":true}'])
      expect(f.pool.active).toBe(0)
    } finally { release?.(); vi.mocked(open).mockImplementation(original) }
  })
  it('retains the handle and physical slot when close rejects, including a bounded stop after logical failure', async () => {
    const f = fixture(), original = vi.mocked(open).getMockImplementation()!
    let retained: Awaited<ReturnType<typeof open>> | undefined
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = retained = await original(...args)
      return new Proxy(handle, { get(target, property) {
        if (property === 'close') return async () => { throw new Error('uncertain close') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      await expect(f.reader.arm(f.agent, 'delivery')).rejects.toThrow('EVIDENCE_UNAVAILABLE')
      expect(f.failed).toHaveBeenCalledWith('EVIDENCE_CLOSE_FAILED')
      expect(f.pool.active).toBe(1)
      expect(f.pool.captures.size).toBe(1)
      vi.useFakeTimers()
      const stopping = f.reader.stop()
      await vi.advanceTimersByTimeAsync(2_000); await stopping
      expect(f.failed).toHaveBeenCalledWith('EVIDENCE_DRAIN_PENDING')
      expect(f.pool.active).toBe(1)
    } finally {
      readers.splice(readers.indexOf(f.reader), 1)
      await retained?.close() // Fixture cleanup alone knows this injected failure did not attempt close.
      vi.mocked(open).mockImplementation(original); vi.useRealTimers()
    }
  })

  it('keeps bytes written before dispatch in the file and preserves complete record order', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    appendFileSync(f.file, '{"first":1}\n{"second":2}\n{"partial":')
    await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    f.input(); await f.reader.flush('agent')
    expect(f.observed.mock.calls.map(call => call[3])).toEqual(['{"first":1}', '{"second":2}'])
    appendFileSync(f.file, '3}\n')
    await f.reader.flush('agent')
    expect(f.observed.mock.calls.map(call => call[3])).toEqual(['{"first":1}', '{"second":2}', '{"partial":3}'])
    expect(f.pool.bytes).toBe(0)
  })

  it.each(['replacement', 'truncation', 'rewrite'] as const)('refuses %s before publishing any appended record', async change => {
    const f = fixture()
    writeFileSync(f.file, '{"old":"record"}\n')
    await f.reader.arm(f.agent, 'delivery')
    if (change === 'replacement') { const other = join(f.home, 'other'); writeFileSync(other, '{"old":"record"}\n{"new":1}\n'); renameSync(other, f.file) }
    else if (change === 'truncation') truncateSync(f.file, 0)
    else writeFileSync(f.file, '{"new":"record"}\n{"new":1}\n')
    f.input(); await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    expect(f.gap).toHaveBeenCalledExactlyOnceWith('agent', 'EVIDENCE_GAP')
    expect(f.pool.captures.size).toBe(0)
  })

  it.each(['birth', 'binding', 'held', 'deleted'] as const)('uses an immutable captured identity and refuses a later %s change', async change => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    appendFileSync(f.file, '{"new":1}\n')
    if (change === 'birth') f.agent.processIdentity!.startMarker = 'replacement'
    if (change === 'binding') f.agent.evidenceRevision = 2
    if (change === 'held') f.agent.identityHold = 'held'
    if (change === 'deleted') f.resolve.mockResolvedValue(null as never)
    f.input(); await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    expect(f.gap).toHaveBeenCalledExactlyOnceWith('agent', 'EVIDENCE_BINDING_LOST')
  })

  it.each(['rotation', 'birth', 'held'] as const)('does not mistake an unbound process followed by %s for its first binding', async change => {
    const f = fixture()
    f.agent.sessionId = ''; f.agent.transcriptPath = null; f.agent.boundAt = null
    await f.reader.arm(f.agent, 'delivery')
    writeFileSync(f.file, '{"first":1}\n')
    f.agent.sessionId = 'session'; f.agent.transcriptPath = f.file; f.agent.boundAt = 1_000; f.agent.evidenceRevision = 7
    if (change === 'rotation') f.agent.earlierSessionIds = ['missed-session']
    if (change === 'birth') f.agent.processIdentity!.startMarker = 'replacement'
    if (change === 'held') f.agent.interpretationHold = 'held'
    f.input(); await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    expect(f.gap).toHaveBeenCalledExactlyOnceWith('agent', 'EVIDENCE_BINDING_LOST')
  })

  it('refuses an oversized catch-up without reading or truncating it into evidence', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    truncateSync(f.file, EVIDENCE_BYTES + 1)
    f.input(); await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    expect(f.gap).toHaveBeenCalledExactlyOnceWith('agent', 'EVIDENCE_TOO_LARGE')
    expect(f.pool.bytes).toBe(0)
  })

  it('refuses oversized captured metadata before installing an original-process capture', async () => {
    const f = fixture()
    const agent = { ...f.agent, sessionId: '', transcriptPath: 'x'.repeat(64 * 1024), boundAt: null }
    await expect(f.reader.arm(agent, 'delivery')).rejects.toThrow('EVIDENCE_BACKPRESSURE')
    expect(f.pool.captures.size).toBe(0)
    expect(f.failed).toHaveBeenCalledWith('EVIDENCE_BACKPRESSURE')
  })

  it('bounds aggregate selected identity bytes before the capture-count ceiling', async () => {
    const f = fixture()
    const earlierSessionIds = Array.from({ length: 32 }, (_, index) => `${index}`.padEnd(256, 'x'))
    let accepted = 0, code: string | undefined
    for (let index = 0; index < 512; index++) {
      try { await f.reader.arm({ ...f.agent, agentId: `agent-${index}`, sessionId: '', transcriptPath: null, earlierSessionIds }, `delivery-${index}`); accepted++ }
      catch (error) { code = (error as Error).message; break }
    }
    expect(accepted).toBeGreaterThan(400)
    expect(accepted).toBeLessThan(512)
    expect(code).toBe('EVIDENCE_BACKPRESSURE')
  })

  it('bounds replacement metadata before comparing or retaining another delivery on an existing capture', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    const bytes = f.pool.metadataBytes
    await expect(f.reader.arm({ ...f.agent, transcriptPath: 'x'.repeat(64 * 1024) }, 'second')).rejects.toThrow('EVIDENCE_BACKPRESSURE')
    expect(f.pool.deliveries).toBe(1)
    expect(f.pool.metadataBytes).toBe(bytes)
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('EVIDENCE_BACKPRESSURE')
  })

  it('rejects invalid UTF-8 in a complete record rather than manufacturing replacement-character evidence', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    appendFileSync(f.file, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]))
    f.input(); await f.reader.flush('agent')
    expect(f.observed).not.toHaveBeenCalled()
    expect(f.gap).toHaveBeenCalledWith('agent', 'EVIDENCE_GAP')
  })

  it('does not publish a raw window rewritten in place after its read but before final verification', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    const before = JSON.stringify({ value: 'before', padding: 'x'.repeat(2_048) }) + '\n'
    const after = before.replace('before', 'after!')
    appendFileSync(f.file, before)
    const original = vi.mocked(open).getMockImplementation()!
    let rewritten = false
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await original(...args)
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await handle.read(buffer, offset, length, position)
          if (!rewritten && length > 1_024) {
            rewritten = true; writeFileSync(f.file, after)
          }
          return result
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      f.input(); await f.reader.flush('agent')
      expect(rewritten).toBe(true)
      expect(f.observed).not.toHaveBeenCalled()
      expect(f.gap).toHaveBeenCalledExactlyOnceWith('agent', 'EVIDENCE_GAP')
    } finally { vi.mocked(open).mockImplementation(original) }
  })

  it('bounds pending original-process captures and delivery reservations across component constructions', async () => {
    const pool = new DeviceEvidencePool(), f = fixture(pool), other = fixture(pool)
    for (let index = 0; index < EVIDENCE_CAPTURES; index++) {
      await f.reader.arm({ ...f.agent, agentId: `agent-${index}`, sessionId: '', transcriptPath: null, boundAt: null }, `delivery-${index}`)
    }
    expect(pool.captures.size).toBe(EVIDENCE_CAPTURES)
    expect(pool.deliveries).toBe(EVIDENCE_CAPTURES)
    await expect(other.reader.arm({ ...other.agent, sessionId: '', transcriptPath: null }, 'overflow')).rejects.toThrow('EVIDENCE_BACKPRESSURE')
    await f.reader.stop()
    expect(pool.captures.size).toBe(0)
    expect(pool.deliveries).toBe(0)
    await other.reader.arm(other.agent, 'available')
  })

  it('retains real read, buffer and descriptor custody across stop and a replacement component', async () => {
    const pool = new DeviceEvidencePool(), f = fixture(pool), replacement = fixture(pool)
    const agents = Array.from({ length: 4 }, (_, index) => ({ ...f.agent, agentId: `agent-${index}`, transcriptPath: join(f.home, `${index}.jsonl`) }))
    f.resolve.mockImplementation(async id => agents.find(agent => agent.agentId === id)!)
    for (const agent of agents) { writeFileSync(agent.transcriptPath!, ''); await f.reader.arm(agent, agent.agentId) }
    const original = vi.mocked(open).getMockImplementation()!
    const releases: Array<() => void> = [], closed = vi.fn()
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await original(...args)
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (length > 1_024) await new Promise<void>(resolve => releases.push(resolve))
          return handle.read(buffer, offset, length, position)
        }
        if (property === 'close') return async () => { await handle.close(); closed() }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      for (const agent of agents) {
        appendFileSync(agent.transcriptPath!, JSON.stringify({ text: 'x'.repeat(2_048) }) + '\n')
        f.input(agent.agentId, agent.agentId)
      }
      await vi.waitFor(() => expect(releases).toHaveLength(4))
      const retained = pool.bytes
      expect(retained).toBeGreaterThan(8_192)
      expect(pool.active).toBe(4)
      vi.useFakeTimers()
      const stopping = f.reader.stop()
      await vi.advanceTimersByTimeAsync(2_000)
      await stopping
      expect(f.failed).toHaveBeenCalledWith('EVIDENCE_DRAIN_PENDING')
      expect(pool.active).toBe(4)
      expect(pool.bytes).toBe(retained)
      expect(closed).not.toHaveBeenCalled()
      await expect(replacement.reader.arm(replacement.agent, 'replacement')).rejects.toThrow('EVIDENCE_BACKPRESSURE')
      vi.useRealTimers()
      for (const release of releases.splice(0)) release()
      await vi.waitFor(() => expect(pool.active).toBe(0))
      expect(pool.bytes).toBe(0)
      expect(closed).toHaveBeenCalledTimes(4)
      expect(f.observed).not.toHaveBeenCalled()
      await replacement.reader.arm(replacement.agent, 'replacement')
    } finally { vi.useRealTimers(); for (const release of releases.splice(0)) release(); vi.mocked(open).mockImplementation(original) }
  })

  it('cannot revive an old in-flight read when a replacement core reauthorizes the capture', async () => {
    const f = fixture()
    await f.reader.arm(f.agent, 'delivery')
    appendFileSync(f.file, JSON.stringify({ text: 'x'.repeat(2_048) }) + '\n')
    const original = vi.mocked(open).getMockImplementation()!
    let release: (() => void) | undefined, opens = 0
    const observedBy: number[] = []
    f.observed.mockImplementation(() => observedBy.push(opens))
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await original(...args), owner = ++opens
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (owner === 1 && length > 1_024) await new Promise<void>(resolve => { release = resolve })
          return handle.read(buffer, offset, length, position)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      f.input()
      await vi.waitFor(() => expect(release).toBeDefined())
      const charged = f.pool.bytes
      f.reader.disconnected(); f.agent.evidenceRevision = 0; f.reader.connected()
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(f.pool.active).toBe(1)
      expect(f.pool.bytes).toBe(charged)
      expect(opens).toBe(1)
      expect(f.observed).not.toHaveBeenCalled()
      expect(f.gap).not.toHaveBeenCalled()
      vi.useRealTimers()
      release!()
      await vi.waitFor(() => expect(f.pool.active).toBe(0))
      expect(observedBy).toEqual([2])
      expect(f.pool.bytes).toBe(0)
      expect(f.gap).not.toHaveBeenCalled()
    } finally { vi.useRealTimers(); release?.(); vi.mocked(open).mockImplementation(original) }
  })
})
