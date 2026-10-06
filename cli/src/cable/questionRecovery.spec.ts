import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CableFleet } from './cableFleet.js'
import { CableSession, type CableHost, type CablePort } from './cableSession.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DialLog } from './dialLog.js'
import type { DialPort } from './serial.js'

const questions = [{ key: 'scope', q: 'Which scope?', options: ['File', 'Project'], multi: false }]
class Peer implements CablePort {
  isOpen = true
  sent: Record<string, unknown>[] = []
  private decoder = new CableDecoder()
  constructor(readonly path: string, private incoming: (bytes: Buffer) => void,
    private closed: (why: string) => void) {}
  async write(bytes: Uint8Array) { this.decoder.feed(bytes, frame => {
    if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString()))
  }) }
  async close() { if (this.isOpen) { this.isOpen = false; this.closed('unplugged') } }
  say(message: Record<string, unknown>) {
    this.incoming(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message)))))
  }
}

function fixture() {
  let present: DialPort[] = [], serial = 0
  const ports: Peer[] = []
  const host: CableHost = {
    localMachine: () => ({ id: 'local', name: 'Fixture' }),
    listMachines: async () => ({ machines: [], source: 'backend' }),
    selectedMachine: () => 'local', selectMachine: async () => ({ ok: true }),
    listSwarms: () => ({ selected: 'tab', swarms: [], tiles: [] }), listUnread: () => [],
    selectSwarm: vi.fn(), appName: () => 'harness', voiceLang: () => 'en',
    listAgents: async () => [{ id: 'a', name: 'A', engine: 'claude' }], agentTotal: () => 1,
    activeSwarm: () => 'tab', describe: () => ({ name: 'A', engine: 'claude', machine: 'local' }),
    sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(), answer: vi.fn(), focus: vi.fn(),
    openAgent: vi.fn(), forkAgent: async () => ({ ok: true, agentId: 'fork' }), updateAgent: vi.fn(),
    listModels: async () => [], recentSummaries: async () => [],
    transcribe: vi.fn(async () => ''),
    route: async () => ({ agentId: 'a', confidence: 1, reason: 'fixture' }), log: vi.fn(),
    answerReviewed: vi.fn(async () => ({ ok: true as const })),
  }
  const logs = mkdtempSync(join(tmpdir(), 'question-recovery-'))
  const fleet = new CableFleet(CableSession, host, logs, DialLog, {
    discover: async () => present, intervalMs: 60_000, inUse: async () => false,
    open: async (path, incoming, closed) => {
      const port = new Peer(path, incoming, closed); ports.push(port); return port
    },
  })
  async function scan() { await fleet['scan']() }
  async function start() { fleet.start(); await scan() }
  async function attach(waitForState = true) {
    const number = ++serial, count = ports.length
    present.push({ path: `/dev/question-${number}`, serialNumber: `PRO${number}`, vendorId: 0x303a, productId: 0x1001 })
    await scan(); await vi.waitFor(() => expect(ports).toHaveLength(count + 1))
    const port = ports.at(-1)!
    port.say({ t: 'hello', product: 'harness', mac: `02:00:00:00:00:${String(number).padStart(2, '0')}`, fw: 'fixture' })
    await vi.waitFor(() => expect(port.sent.some(m => m.t === (waitForState ? 'notif.replace' : 'welcome'))).toBe(true))
    return port
  }
  async function remove(port: Peer) { present = present.filter(p => p.path !== port.path); await scan() }
  async function command(port: Peer, message: Record<string, unknown>) {
    const requestId = `request-${++serial}`; port.say({ ...message, requestId })
    await vi.waitFor(() => expect(port.sent.some(m => m.requestId === requestId)).toBe(true))
    return port.sent.find(m => m.requestId === requestId)!
  }
  const read = (port: Peer) => command(port, { t: 'question.read', agentId: 'a' })
  async function stop() { await fleet.stop(); rmSync(logs, { recursive: true, force: true }) }
  return { fleet, host, ports, logs, start, attach, remove, read, command, stop }
}

describe('pending questions across USB sessions', () => {
  it('restores a question that arrived without a device, even after its unread mark cleared', async () => {
    const f = fixture()
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      const port = await f.attach(), state = await f.read(port)
      expect(state).toMatchObject({ ok: true, id: 'q1', submitted: false, questions })
      expect(port.sent.filter(m => m.t === 'question')).toEqual([
        expect.objectContaining({ agentId: 'a', id: 'q1', questions }),
      ])
      expect(f.host.answerReviewed).not.toHaveBeenCalled()
      expect(f.host.openAgent).not.toHaveBeenCalled()
    } finally { await f.stop() }
  })

  it('retains one uncertain answer across a second device and USB replacement', async () => {
    const f = fixture()
    vi.mocked(f.host.answerReviewed!).mockResolvedValue({ ok: false, error: 'Check the terminal.' })
    try {
      await f.start(); const original = await f.attach()
      await f.fleet.question('a', 'q1', questions)
      const state = await f.read(original)
      const answer = { t: 'answer.reviewed', agentId: 'a', token: state.token, choices: [1] }
      expect(await f.command(original, answer)).toMatchObject({ ok: false, error: 'Check the terminal.' })
      const second = await f.attach()
      expect(await f.read(second)).toMatchObject({ ok: true, token: state.token, submitted: true })
      expect(await f.command(second, answer)).toMatchObject({ ok: false, error: 'Check the terminal.' })
      await f.remove(original); const replacement = await f.attach()
      expect(await f.read(replacement)).toMatchObject({ ok: true, token: state.token, submitted: true })
      await f.command(replacement, answer)
      expect(f.host.answerReviewed).toHaveBeenCalledTimes(1)
    } finally { await f.stop() }
  })

  it('replays only the current request and lets an exact close resolve it while unplugged', async () => {
    const f = fixture()
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      await f.fleet.question('a', 'q2', [{ ...questions[0], q: 'Which new scope?' }])
      await f.fleet.questionClose('a', 'q1')
      const port = await f.attach()
      expect(await f.read(port)).toMatchObject({ ok: true, id: 'q2' })
      expect(port.sent.filter(m => m.t === 'question').map(m => m.id)).toEqual(['q2'])
      await f.remove(port); await f.fleet.questionClose('a', 'q2')
      const next = await f.attach()
      expect((await f.read(next)).ok).toBe(false)
      expect(next.sent.filter(m => m.t === 'question')).toEqual([])
    } finally { await f.stop() }
  })

  it('does not replay questions closed or replaced while attach history is loading', async () => {
    const f = fixture()
    let release!: () => void
    const history = new Promise<void>(resolve => { release = resolve })
    f.host.recentSummaries = async () => { await history; return [] }
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      const attaching = f.attach()
      await vi.waitFor(() => expect(f.ports).toHaveLength(1))
      await f.fleet.questionClose('a', 'q1')
      await f.fleet.question('a', 'q2', questions)
      release(); const port = await attaching
      expect(await f.read(port)).toMatchObject({ ok: true, id: 'q2' })
      expect(port.sent.filter(m => m.t === 'question').every(m => m.id === 'q2')).toBe(true)
      expect(f.host.answerReviewed).not.toHaveBeenCalled()
    } finally { release(); await f.stop() }
  })

  it('keeps in-flight answers single-use across reconnect and ignores their old-port receipt', async () => {
    const f = fixture()
    let resolveAnswer!: (result: { ok: false; error: string }) => void
    const receipt = new Promise<{ ok: false; error: string }>(resolve => { resolveAnswer = resolve })
    vi.mocked(f.host.answerReviewed!).mockReturnValue(receipt)
    try {
      await f.start(); const original = await f.attach()
      await f.fleet.question('a', 'q1', questions); const state = await f.read(original)
      const answer = { t: 'answer.reviewed', agentId: 'a', token: state.token, choices: [1] }
      original.say({ ...answer, requestId: 'original-send' })
      await vi.waitFor(() => expect(f.host.answerReviewed).toHaveBeenCalledTimes(1))
      await f.remove(original); const next = await f.attach()
      expect(await f.read(next)).toMatchObject({ ok: true, token: state.token, submitted: true })
      const repeated = f.command(next, answer)
      resolveAnswer({ ok: false, error: 'Unconfirmed input.' })
      expect(await repeated).toMatchObject({ ok: false, error: 'Unconfirmed input.' })
      expect(original.sent.some(m => m.requestId === 'original-send')).toBe(false)
      expect(f.host.answerReviewed).toHaveBeenCalledTimes(1)
    } finally { resolveAnswer({ ok: false, error: 'Cleanup' }); await f.stop() }
  })

  it('does not send an old attach replay into a replacement USB connection', async () => {
    const f = fixture()
    let release!: () => void
    const history = new Promise<void>(resolve => { release = resolve })
    f.host.recentSummaries = async () => { await history; return [] }
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      const original = await f.attach(false)
      await f.remove(original)
      await f.fleet.questionClose('a', 'q1'); await f.fleet.question('a', 'q2', questions)
      const next = await f.attach(false)
      release()
      await vi.waitFor(() => expect(next.sent.some(m => m.t === 'question')).toBe(true))
      expect(next.sent.filter(m => m.t === 'question').map(m => m.id)).toEqual(['q2'])
      expect(original.sent.filter(m => m.t === 'question')).toEqual([])
      expect(await f.read(next)).toMatchObject({ ok: true, id: 'q2' })
    } finally { release(); await f.stop() }
  })

  it('clears the catalog at whole-fleet shutdown rather than reopening old work', async () => {
    const f = fixture()
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      await f.fleet.stop(); await f.start()
      const next = await f.attach()
      expect((await f.read(next)).ok).toBe(false)
      expect(next.sent.filter(m => m.t === 'question')).toEqual([])
    } finally { await f.stop() }
  })

  it('revokes a prior host catalog and suppresses its delayed answer receipt', async () => {
    const f = fixture()
    let owner = 'original-host', resolveAnswer!: (value: { ok: true }) => void
    f.host.localMachine = () => ({ id: owner, name: owner })
    const receipt = new Promise<{ ok: true }>(resolve => { resolveAnswer = resolve })
    vi.mocked(f.host.answerReviewed!).mockReturnValue(receipt)
    try {
      await f.start(); const port = await f.attach()
      await f.fleet.question('a', 'q1', questions); const state = await f.read(port)
      port.say({ t: 'answer.reviewed', agentId: 'a', token: state.token, choices: [1], requestId: 'old-owner-answer' })
      await vi.waitFor(() => expect(f.host.answerReviewed).toHaveBeenCalledTimes(1))
      owner = 'new-host'
      expect((await f.read(port)).ok).toBe(false)
      resolveAnswer({ ok: true }); await receipt; await new Promise(resolve => setTimeout(resolve, 0))
      expect(port.sent.some(m => m.requestId === 'old-owner-answer')).toBe(false)
      expect(await f.command(port, { t: 'answer.reviewed', agentId: 'a', token: state.token, choices: [1] }))
        .toMatchObject({ ok: false })
      const next = await f.attach()
      expect(next.sent.filter(m => m.t === 'question')).toEqual([])
      expect(f.host.answerReviewed).toHaveBeenCalledTimes(1)
    } finally { resolveAnswer({ ok: true }); await f.stop() }
  })

  it('drops a delayed attach catalog when its owning host changes', async () => {
    const f = fixture()
    let owner = 'original-host', release!: () => void
    f.host.localMachine = () => ({ id: owner, name: owner })
    const history = new Promise<void>(resolve => { release = resolve })
    f.host.recentSummaries = async () => { await history; return [] }
    try {
      await f.start(); await f.fleet.question('a', 'q1', questions)
      const port = await f.attach(false)
      owner = 'new-host'; release()
      await vi.waitFor(() => expect(port.sent.some(m => m.t === 'notif.replace')).toBe(true))
      expect(port.sent.filter(m => m.t === 'question')).toEqual([])
      expect((await f.read(port)).ok).toBe(false)
      expect(f.host.answerReviewed).not.toHaveBeenCalled()
    } finally { release(); await f.stop() }
  })

  it('retains a standalone catalog on link loss but clears it on explicit session stop', async () => {
    const f = fixture(), ports: Peer[] = []
    const clock = vi.spyOn(Date, 'now')
    const session = new CableSession(f.host, new DialLog(f.logs), async (incoming, closed) => {
      const port = new Peer('/dev/standalone', incoming, closed); ports.push(port); return port
    })
    const greet = async (port: Peer) => {
      port.say({ t: 'hello', product: 'harness', mac: '02:00:00:00:00:77', fw: 'fixture' })
      await vi.waitFor(() => expect(port.sent.some(m => m.t === 'notif.replace')).toBe(true))
    }
    try {
      session.start(); await vi.waitFor(() => expect(ports).toHaveLength(1)); await greet(ports[0])
      await session.question('a', 'q1', questions)
      const state = await f.read(ports[0])
      await ports[0].close()
      clock.mockReturnValue(Date.now() + 2100); await session['tick']()
      await vi.waitFor(() => expect(ports).toHaveLength(2)); await greet(ports[1])
      expect(await f.read(ports[1])).toMatchObject({ ok: true, token: state.token })
      await session.stop()
      clock.mockReturnValue(Date.now() + 2100); session.start()
      await vi.waitFor(() => expect(ports).toHaveLength(3)); await greet(ports[2])
      expect((await f.read(ports[2])).ok).toBe(false)
      expect(ports[2].sent.filter(m => m.t === 'question')).toEqual([])
    } finally { clock.mockRestore(); await session.stop(); await f.stop() }
  })
})
