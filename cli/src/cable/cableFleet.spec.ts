import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CableFleet as SourceFleet } from './cableFleet.js'
import { CableSession, type CableHost, type CablePort } from './cableSession.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DialLog } from './dialLog.js'
import { parseDarwinDialPorts, type DialPort } from './serial.js'

// Run the same two-device scenarios against the staged helper before deployment.
const CableFleet: typeof SourceFleet = process.env.HARNESS_TEST_USB_FLEET
  ? (await import(pathToFileURL(process.env.HARNESS_TEST_USB_FLEET).href)).CableFleet : SourceFleet
const device = (path: string, serialNumber: string): DialPort => ({ path, serialNumber, vendorId: 0x303a, productId: 0x1001 })

class Peer implements CablePort {
  isOpen = true
  sent: Record<string, unknown>[] = []
  private decoder = new CableDecoder()
  constructor(readonly path: string, private onData: (chunk: Buffer) => void, private onClosed: (why: string) => void) {}
  async write(bytes: Uint8Array) { this.decoder.feed(bytes, frame => {
    if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString()))
  }) }
  async close(why = 'disconnected') { if (this.isOpen) { this.isOpen = false; this.onClosed(why) } }
  say(message: Record<string, unknown>) { this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message))))) }
  pcm(value: number) { this.onData(Buffer.from(encodeCableFrame(CableType.Pcm, Buffer.alloc(3200, value)))) }
}

function fixture() {
  let present = [device('/dev/tim', 'AA:01'), device('/dev/tux', 'BB:02')]
  const ports: Peer[] = []
  const host: CableHost = {
    localMachine: () => ({ id: 'local', name: 'Fixture' }),
    listMachines: async () => ({ machines: [], source: 'backend' }),
    selectedMachine: () => 'local', selectMachine: async () => ({ ok: true }),
    listSwarms: () => ({ selected: 'tab', swarms: [], tiles: [] }), listUnread: () => [],
    selectSwarm: vi.fn(), appName: () => 'harness', voiceLang: () => 'en',
    listAgents: async () => [{ id: 'a', name: 'A', engine: 'codex' }], agentTotal: () => 1,
    activeSwarm: () => 'tab', describe: () => ({ name: 'A', engine: 'codex', machine: 'local' }),
    sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(), answer: vi.fn(), focus: vi.fn(),
    openAgent: vi.fn(), forkAgent: async () => ({ ok: true, agentId: 'fork' }), updateAgent: vi.fn(),
    listModels: async () => [], recentSummaries: async () => [],
    transcribe: vi.fn(async pcm => `audio-${pcm[0]}`),
    route: async () => ({ agentId: 'a', confidence: 1, reason: 'fixture' }), log: vi.fn(),
    onDialAttached: vi.fn(), onDialGone: vi.fn(), onDialStatus: vi.fn(),
  }
  const logs = mkdtempSync(join(tmpdir(), 'usb-fleet-'))
  const options = {
    discover: vi.fn(async () => present), intervalMs: 60_000,
    open: vi.fn(async (path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => {
      const port = new Peer(path, onData, onClosed); ports.push(port); return port
    }),
  }
  const fleet = new CableFleet(CableSession, host, logs, DialLog, options)
  async function start() { fleet.start(); await vi.waitFor(() => expect(ports).toHaveLength(2)); await greet(ports) }
  async function greet(peers: Peer[]) {
    for (const p of peers) p.say({ t: 'hello', product: 'harness', mac: p.path, fw: 'fixture', proto: 3 })
    await vi.waitFor(() => { for (const p of peers) expect(p.sent.some(m => m.t === 'agents.end')).toBe(true) })
  }
  return { fleet, host, ports, options, logs, start, greet, setPorts: (p: DialPort[]) => { present = p } }
}

describe('USB dial fleet', () => {
  it('shares companion state across devices and keeps action receipts on the requesting one', async () => {
    const f = fixture()
    let enabled = true
    f.host.companion = () => ({v:1,window:'desktop',epoch:1,revision:1,serial:1,enabled,foreground:true,
      motion:true,phase:'egg',egg:{kind:'first',stage:'p4'},feeling:{emotion:'content',reason:'ready',intensity:1}})
    f.host.companionArt = async () => ({key:'egg:first:p4:reveal',frames:[{rows:'oo',mats:'pp'}],
      frameMs:190,loop:true,palette:Array(8).fill(65535)})
    f.host.companionAction = vi.fn(async () => ({ok:true}))
    try {
      await f.start()
      for (const p of f.ports) p.say({t:'hello',product:'harness',mac:p.path,fw:'fixture',companion:1})
      await vi.waitFor(() => expect(f.ports.every(p=>p.sent.filter(m=>m.t==='welcome').length===2)).toBe(true))
      await f.fleet.syncCompanion()
      for (const p of f.ports) expect(p.sent.some(m=>m.t==='companion.art.end')).toBe(true)
      f.ports[0].say({t:'companion.action',requestId:'tap',action:'hatch'})
      await vi.waitFor(()=>expect(f.ports[0].sent).toContainEqual({t:'companion.action.result',requestId:'tap',ok:true}))
      expect(f.ports[1].sent.some(m=>m.t==='companion.action.result')).toBe(false)
      enabled=false;await f.fleet.syncCompanion()
      for(const p of f.ports)expect(p.sent.at(-1)).toMatchObject({t:'companion.state',enabled:false})
    } finally {await f.fleet.stop()}
  })

  it('connects both dials, broadcasts work, and keeps the remaining dial attached', async () => {
    const f = fixture()
    try {
      await f.start(); f.fleet.start(); await f.fleet['scan']()
      expect(f.options.open).toHaveBeenCalledTimes(2)
      expect(f.host.onDialAttached).toHaveBeenCalledTimes(1)
      await f.fleet.turnStarted('a', 'Working')
      for (const port of f.ports) expect(port.sent).toContainEqual({ t: 'turn.started', agentId: 'a', text: 'Working' })
      f.setPorts([device('/dev/tux', 'BB:02')]); await f.fleet['scan']()
      expect(f.ports[0].isOpen).toBe(false)
      expect(f.ports[1].isOpen).toBe(true)
      expect(f.fleet.isConnected).toBe(true)
      expect(f.host.onDialGone).not.toHaveBeenCalled()
      expect(f.host.onDialStatus).toHaveBeenLastCalledWith(expect.objectContaining({ attached: true }))
      await f.fleet.turnDone('a')
      expect(f.ports[1].sent.some(m => m.t === 'turn.done')).toBe(true)
      await vi.waitFor(() => expect(readdirSync(f.logs).sort()).toEqual(['usb-AA-01', 'usb-BB-02']))
      f.setPorts([]); await f.fleet['scan']()
      expect(f.fleet.isConnected).toBe(false)
      expect(f.host.onDialGone).toHaveBeenCalledTimes(1)
      expect(f.host.onDialStatus).toHaveBeenLastCalledWith({ attached: false })
    } finally { await f.fleet.stop() }
  })

  it('keeps simultaneous voice uploads separate even with the same upload id', async () => {
    const f = fixture()
    try {
      await f.start()
      for (const p of f.ports) p.say({ t: 'voice.begin', uploadId: 'same', agentId: 'a' })
      f.ports[0].pcm(17); f.ports[1].pcm(34)
      for (const p of f.ports) p.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(f.host.sendTurn).toHaveBeenCalledTimes(2))
      const audio = vi.mocked(f.host.transcribe).mock.calls.map(c => c[0])
      expect(audio.map(b => [b.length, b[0]])).toEqual([[3200, 17], [3200, 34]])
      expect(audio.every(b => b.every(v => v === b[0]))).toBe(true)
      for (const [i, p] of f.ports.entries()) {
        expect(p.sent.some(m => m.t === 'voice.transcript' && m.text === `audio-${i ? 34 : 17}`)).toBe(true)
      }
    } finally { await f.fleet.stop() }
  })

  it('does not cancel the other dial while its transcription is pending', async () => {
    const f = fixture(); let finish!: (text: string) => void
    vi.mocked(f.host.transcribe).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    try {
      await f.start()
      f.ports[1].say({ t: 'voice.begin', uploadId: 'pending', agentId: 'a' }); f.ports[1].pcm(42)
      f.ports[1].say({ t: 'voice.end' })
      await vi.waitFor(() => expect(f.host.transcribe).toHaveBeenCalledTimes(1))
      f.setPorts([device('/dev/tux', 'BB:02')]); await f.fleet['scan']()
      finish('keep recording')
      await vi.waitFor(() => expect(f.host.sendTurn).toHaveBeenCalledWith('a', 'keep recording'))
      expect(f.host.onDialGone).not.toHaveBeenCalled()
    } finally { await f.fleet.stop() }
  })

  it('preserves healthy sessions when discovery fails and replaces a moved USB path', async () => {
    const f = fixture()
    try {
      await f.start()
      f.options.discover.mockRejectedValueOnce(new Error('inventory unavailable'))
      await f.fleet['scan'](); expect(f.ports.every(p => p.isOpen)).toBe(true)
      f.setPorts([device('/dev/tim-new', 'AA:01'), device('/dev/tux', 'BB:02')])
      await f.fleet['scan'](); await vi.waitFor(() => expect(f.ports).toHaveLength(3))
      await f.greet([f.ports[2]])
      expect(f.ports[0].isOpen).toBe(false); expect(f.ports[1].isOpen).toBe(true)
      expect(f.ports[2].path).toBe('/dev/tim-new')
      expect(f.host.onDialGone).not.toHaveBeenCalled()
      expect(f.host.onDialAttached).toHaveBeenCalledTimes(1)
    } finally { await f.fleet.stop() }
  })

  it('opens only selected serial numbers', async () => {
    const f = fixture()
    const fleet = new CableFleet(CableSession, f.host, f.logs, DialLog, { ...f.options, serials: ['bb:02'] })
    try {
      fleet.start(); await fleet['scan']()
      await vi.waitFor(() => expect(f.ports).toHaveLength(1))
      expect(f.ports[0].path).toBe('/dev/tux')
    } finally { await fleet.stop() }
  })

  it('closes a port that finishes opening after shutdown', async () => {
    const f = fixture(); let finish!: (port: Peer) => void; let late!: Peer
    f.setPorts([device('/dev/tim', 'AA:01')])
    f.options.open.mockImplementation((path, onData, onClosed) => {
      late = new Peer(path, onData, onClosed)
      return new Promise(resolve => { finish = resolve })
    })
    try {
      f.fleet.start(); await vi.waitFor(() => expect(late).toBeDefined())
      await f.fleet.stop(); finish(late)
      await vi.waitFor(() => expect(late.isOpen).toBe(false))
      expect(f.fleet.isConnected).toBe(false)
      expect(f.host.onDialAttached).not.toHaveBeenCalled()
    } finally { await f.fleet.stop() }
  })
})

describe('macOS USB inventory', () => {
  it('associates each tty with its own matching USB parent and serial in either property order', () => {
    const dump = `+-o root
  +-o Tim
    "USB Serial Number" = "AA:01"
    "idProduct" = 4097
    "idVendor" = 12346
    +-o driver
      +-o serial
        "IOCalloutDevice" = "/dev/tim"
        "IOCalloutDevice" = "/dev/tim"
  +-o unrelated
    "idVendor" = 12346
    "idProduct" = 12
    +-o serial
      "IOCalloutDevice" = "/dev/unrelated"
  +-o Tux
    "idVendor" = 12346
    "idProduct" = 4097
    "USB Serial Number" = "BB:02"
    +-o serial
      "IOCalloutDevice" = "/dev/tux"
  +-o console
    "IOCalloutDevice" = "/dev/debug-console"`
    expect(parseDarwinDialPorts(dump)).toEqual([device('/dev/tim', 'AA:01'), device('/dev/tux', 'BB:02')])
  })
})
