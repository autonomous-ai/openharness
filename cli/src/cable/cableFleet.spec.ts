import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CableFleet as SourceFleet } from './cableFleet.js'
import { CableSession, type CableHost, type CablePort } from './cableSession.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DialLog } from './dialLog.js'
import { DialVerdicts } from './dialPortVerdicts.js'
import { parseDarwinDialPorts, portInUse, type DialPort } from './serial.js'

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
  it('names every device on the desk, and changes the settings of ONE of them', async () => {
    /*
     * Before this the fleet picked a row and threw the rest away, so the app drew one robot however
     * many were plugged in — and a preference had nowhere to be addressed to.
     *
     * Every other command here broadcasts ON PURPOSE: both devices show the same desktop. A setting
     * does not, because it belongs to the glass it was set on.
     */
    const f = fixture()
    try {
      await f.start()
      const settings = {
        brightness: 60, character: 0, face: 466, muted: false, quiet: false, straightTitle: false,
        focusFace: false, scrollReversed: false, round: true, voiceLang: 'vi',
      }
      for (const port of f.ports) {
        port.say({ t: 'hello', product: 'harness', mac: port.path, fw: 'fixture', proto: 3, settings })
      }
      await vi.waitFor(() => expect(f.fleet.devices().filter(d => d.settings)).toHaveLength(2))
      expect(f.fleet.devices().map(d => d.id)).toEqual(['AA:01', 'BB:02'])
      expect(f.fleet.devices().map(d => d.mac)).toEqual(['/dev/tim', '/dev/tux'])
      for (const device of f.fleet.devices()) expect(device.settings).toEqual(settings)
      // The whole desk rides on the status a window receives, with one row repeated flat.
      expect(f.host.onDialStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ attached: true, devices: expect.arrayContaining([expect.objectContaining({ id: 'BB:02' })]) }))

      for (const port of f.ports) port.sent.length = 0
      expect(await f.fleet.setSettings('BB:02', { brightness: 20 })).toEqual({ ok: true })
      await vi.waitFor(() => expect(f.ports[1].sent).toContainEqual({ t: 'settings.set', brightness: 20 }))
      expect(f.ports[0].sent).toHaveLength(0)   // the other robot was not touched

      expect(await f.fleet.setSettings('ZZ:99', { muted: true }))
        .toEqual({ ok: false, error: 'That device is not plugged into this computer.' })
    } finally { await f.fleet.stop() }
  })

  it('keeps an unplugged device on the desk, with what it last held', async () => {
    // A pane that emptied the moment a cable was pulled would be a pane nobody could read their own
    // settings out of. Read-only is the app's job; keeping the row is this one's.
    const f = fixture()
    try {
      await f.start()
      const settings = {
        brightness: 40, character: 1, face: 466, muted: true, quiet: true, straightTitle: true,
        focusFace: false, scrollReversed: true, round: false, voiceLang: 'en',
      }
      f.ports[0].say({ t: 'hello', product: 'harness', mac: '/dev/tim', fw: 'fixture', proto: 3, settings })
      await vi.waitFor(() => expect(f.fleet.devices()[0]?.settings).toEqual(settings))
      await f.ports[0].close('unplugged')
      await vi.waitFor(() => expect(f.fleet.devices()[0]?.attached).toBe(false))
      expect(f.fleet.devices()[0]).toMatchObject({ id: 'AA:01', attached: false, settings })
      expect(await f.fleet.setSettings('AA:01', { muted: false }))
        .toEqual({ ok: false, error: 'That device is unplugged.' })
    } finally { await f.fleet.stop() }
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
      expect(f.host.onDialStatus).toHaveBeenLastCalledWith({ attached: false, devices: [] })
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

describe('a board that is not a dial', () => {
  /**
   * Found on a desk with a second ESP32-S3 plugged in for its own work: it shares the dial's USB ids, so
   * the daemon opened it, heard nothing it understood, waited a minute and opened it again, for as long
   * as it ran. That corrupted an esptool flash read twice. A board is looked at once per attachment.
   */
  const scenario = (opts: { inUse?: (path: string) => Promise<boolean>; file?: string } = {}) => {
    const f = fixture()
    const foreign = { ...device('/dev/other', 'CC:03'), session: '100' }
    const dial = { ...device('/dev/tim', 'AA:01'), session: '200' }
    f.setPorts([foreign, dial])
    const options = { ...f.options, verdicts: new DialVerdicts(opts.file), watchEveryMs: 0, ...(opts.inUse ? { inUse: opts.inUse } : { inUse: async () => false }) }
    const fleet = new CableFleet(CableSession, f.host, f.logs, DialLog, options)
    const opens = () => f.options.open.mock.calls.map(c => c[0])
    const scan = async () => { await (fleet as unknown as { scan(): Promise<void> }).scan(); await new Promise(r => setTimeout(r, 5)) }
    return { f, fleet, foreign, dial, options, opens, scan }
  }

  it('is probed once, then left alone, while the dial beside it carries on', async () => {
    const s = scenario()
    try {
      s.fleet.start()
      await vi.waitFor(() => expect(s.f.ports).toHaveLength(2))
      const other = s.f.ports.find(p => p.path === '/dev/other')!
      const tim = s.f.ports.find(p => p.path === '/dev/tim')!
      other.say({ t: 'hello', product: 'grid', mac: 'other', fw: '1', proto: 1 })
      await s.f.greet([tim])
      await vi.waitFor(() => expect(other.isOpen).toBe(false))
      const after = s.opens().filter(p => p === '/dev/other').length
      for (let i = 0; i < 4; i++) await s.scan()
      expect(s.opens().filter(p => p === '/dev/other').length).toBe(after)
      expect(tim.isOpen).toBe(true)
      expect(s.f.host.log).toHaveBeenCalledWith(expect.stringContaining('leaving it alone until it is unplugged or reset'))
    } finally { await s.fleet.stop() }
  })

  it('is looked at again once it has been unplugged and plugged back in', async () => {
    const s = scenario()
    try {
      s.fleet.start()
      await vi.waitFor(() => expect(s.f.ports).toHaveLength(2))
      s.f.ports.find(p => p.path === '/dev/other')!.say({ t: 'hello', product: 'grid', mac: 'other', fw: '1', proto: 1 })
      await vi.waitFor(() => expect(s.f.ports.find(p => p.path === '/dev/other')!.isOpen).toBe(false))
      const before = s.opens().filter(p => p === '/dev/other').length
      // Unplugged and plugged back in: same board, new attachment.
      s.f.setPorts([{ ...s.foreign, session: '101' }, s.dial])
      // Scanning as the interval would: the old entry leaves on a timer of its own, so the first scan
      // may still find it there and the next one starts the new attachment.
      await vi.waitFor(async () => {
        await s.scan()
        expect(s.opens().filter(p => p === '/dev/other').length).toBeGreaterThan(before)
      }, { timeout: 5000 })
    } finally { await s.fleet.stop() }
  })

  it('is looked at again once a program has worked on it and let go, which is what a flash looks like', async () => {
    // A reset or a reflash over USB-Serial/JTAG leaves the attachment as it was (measured with esptool on
    // the desk), so the USB view cannot say a board became a dial. Somebody holding its port for a while,
    // and then not, can: that is esptool or idf.py. The board is looked at once more when they let go.
    let busy = false
    const s = scenario({ inUse: async path => path === '/dev/other' && busy })
    try {
      s.fleet.start()
      await vi.waitFor(() => expect(s.f.ports).toHaveLength(2))
      s.f.ports.find(p => p.path === '/dev/other')!.say({ t: 'hello', product: 'grid', mac: 'other', fw: '1', proto: 1 })
      await vi.waitFor(() => expect(s.f.ports.find(p => p.path === '/dev/other')!.isOpen).toBe(false))
      const before = s.opens().filter(p => p === '/dev/other').length

      // Still ruled out while nothing has touched it, and while it is being worked on.
      for (let i = 0; i < 3; i++) await s.scan()
      busy = true
      for (let i = 0; i < 3; i++) await s.scan()
      expect(s.opens().filter(p => p === '/dev/other').length).toBe(before)

      // They let go: it may be a different board now.
      busy = false
      await vi.waitFor(async () => {
        await s.scan()
        expect(s.opens().filter(p => p === '/dev/other').length).toBeGreaterThan(before)
      }, { timeout: 5000 })
      expect(s.f.host.log).toHaveBeenCalledWith(expect.stringContaining('was in use and is free again'))
    } finally { await s.fleet.stop() }
  })

  it('is not probed again by the next daemon either', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fleet-verdicts-')), 'dial-ports.json')
    const first = scenario({ file })
    try {
      first.fleet.start()
      await vi.waitFor(() => expect(first.f.ports).toHaveLength(2))
      first.f.ports.find(p => p.path === '/dev/other')!.say({ t: 'hello', product: 'grid', mac: 'other', fw: '1', proto: 1 })
      await vi.waitFor(() => expect(first.f.ports.find(p => p.path === '/dev/other')!.isOpen).toBe(false))
    } finally { await first.fleet.stop() }

    const second = scenario({ file })
    try {
      second.fleet.start()
      await vi.waitFor(() => expect(second.opens()).toContain('/dev/tim'))
      for (let i = 0; i < 3; i++) await second.scan()
      expect(second.opens()).not.toContain('/dev/other')
    } finally { await second.fleet.stop() }
  })

  it('is never opened while another program has it, and only then once that program is done', async () => {
    let busy = true
    const s = scenario({ inUse: async path => path === '/dev/other' && busy })
    try {
      s.fleet.start()
      await vi.waitFor(() => expect(s.opens()).toContain('/dev/tim'))
      for (let i = 0; i < 3; i++) await s.scan()
      expect(s.opens()).not.toContain('/dev/other')
      expect(s.f.host.log).toHaveBeenCalledWith(expect.stringContaining('/dev/other is in use by another program'))
      busy = false
      await s.scan()
      await vi.waitFor(() => expect(s.opens()).toContain('/dev/other'))
    } finally { await s.fleet.stop() }
  })

  it('reads a port as held when a process other than this one has it open', async () => {
    // Skipped without lsof; the fleet treats "cannot tell" as free, so there is nothing to prove there.
    const file = join(mkdtempSync(join(tmpdir(), 'held-')), 'tty')
    writeFileSync(file, '')
    const holder = spawn('tail', ['-f', file], { stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 300))
      const held = await portInUse(file)
      const lsofExists = await new Promise<boolean>(r => spawn('lsof', ['-v'], { stdio: 'ignore' }).on('error', () => r(false)).on('exit', () => r(true)))
      if (lsofExists) expect(held).toBe(true)
    } finally {
      holder.kill()
      await new Promise(r => holder.on('exit', r))
    }
    expect(await portInUse(file)).toBe(false)
  })
})

describe('macOS USB inventory', () => {
  it('reads multiple USB-rooted subtrees without leaking IDs into their siblings', () => {
    const dump = `+-o Tim <class IOUSBHostDevice>
  "idVendor" = 12346
  "idProduct" = 4097
  "USB Serial Number" = "AA:01"
  +-o CDC
    +-o serial
      "IOCalloutDevice" = "/dev/tim"
+-o unrelated <class IOUSBHostDevice>
  "idVendor" = 12346
  "idProduct" = 12
  +-o serial
    "IOCalloutDevice" = "/dev/unrelated"
+-o Tux <class IOUSBHostDevice>
  "USB Serial Number" = "BB:02"
  "idProduct" = 4097
  "idVendor" = 12346
  +-o serial
    "IOCalloutDevice" = "/dev/tux"`
    expect(parseDarwinDialPorts(dump)).toEqual([device('/dev/tim', 'AA:01'), device('/dev/tux', 'BB:02')])
    expect(parseDarwinDialPorts('')).toEqual([])
  })

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
    "sessionID" = 14351572441873
    "USB Serial Number" = "BB:02"
    +-o serial
      "sessionID" = 99
      "IOCalloutDevice" = "/dev/tux"
  +-o console
    "IOCalloutDevice" = "/dev/debug-console"`
    // The attachment identity is the USB device's own sessionID, not one from a node below it.
    expect(parseDarwinDialPorts(dump)).toEqual([device('/dev/tim', 'AA:01'), { ...device('/dev/tux', 'BB:02'), session: '14351572441873' }])
  })
})
