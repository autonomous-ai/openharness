import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CableFleet } from './cableFleet.js'
import { CableSession, type CableHost } from './cableSession.js'
import { DialLog } from './dialLog.js'
import { SerialLink } from './serial.js'
import { isUsbConsoleUser } from './usbConsoleUser.js'
import { createWindowsDialWatch, windowsPortInUse, windowsSerialCommand, type CommandFor } from './windowsSerial.js'

const FAKE = fileURLToPath(new URL('./__fixtures__/fakeHarnessSerial.mjs', import.meta.url))
const fake: CommandFor = (args) => ({ file: process.execPath, args: [FAKE, ...args] })
afterEach(() => { vi.unstubAllEnvs() })

describe('SerialLink over harness-serial (any OS, the stand-in)', () => {
  it('hands the dial\'s bytes to the session, writes frames whole and in order, and closes once', async () => {
    const received: Buffer[] = []
    const closed = vi.fn()
    const link = await SerialLink.openWindows('COM3', (chunk) => received.push(chunk), closed, fake)
    try {
      expect(link.isOpen).toBe(true)
      await Promise.all([link.write(Buffer.from('one|')), link.write(Buffer.alloc(50_000, 0x41)), link.write(Buffer.from('|two'))])
      await vi.waitFor(() => expect(Buffer.concat(received).length).toBe(4 + 50_000 + 4))
      expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.from('one|'), Buffer.alloc(50_000, 0x41), Buffer.from('|two')]))
      await link.close()
      await link.close()
      expect(closed).toHaveBeenCalledExactlyOnceWith('closed')
      expect(link.isOpen).toBe(false)
    } finally { await link.close() }
  })

  it('tells the session why when the dial is unplugged', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'unplug:100')
    const closed = vi.fn()
    const link = await SerialLink.openWindows('COM3', () => {}, closed, fake)
    try {
      await vi.waitFor(() => expect(closed).toHaveBeenCalledExactlyOnceWith('closed: The device is not connected.'))
    } finally { await link.close() }
  })

  it('refuses a held port as busy, and says when harness-serial is not installed', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'busy')
    await expect(SerialLink.openWindows('COM3', () => {}, () => {}, fake)).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(SerialLink.openWindows('COM3', () => {}, () => {}, () => null)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts the watch while ownership is unknown, then discovers the dial after the console line arrives', async () => {
    // Splitting the first state across writes leaves ownership unknown on the fleet's first scan.
    vi.stubEnv('FAKE_SERIAL_LINES', JSON.stringify([JSON.stringify({ console: true, ports: [{ path: 'COM3' }] })]))
    vi.stubEnv('FAKE_SERIAL_SPLIT', '1')
    const watch = createWindowsDialWatch({ command: fake, log: () => {} })
    const discover = vi.fn(() => watch.ports())
    let opened: SerialLink | undefined
    const open = vi.fn(async (path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => {
      opened = await SerialLink.openWindows(path, onData, onClosed, fake)
      return opened
    })
    const host: CableHost = {
      localMachine: () => ({ id: 'local', name: 'Fixture' }),
      listMachines: async () => ({ machines: [], source: 'backend' }),
      selectedMachine: () => 'local', selectMachine: async () => ({ ok: true }),
      listSwarms: () => ({ selected: 'tab', swarms: [], tiles: [] }), listUnread: () => [],
      selectSwarm: vi.fn(), appName: () => 'harness', voiceLang: () => 'en',
      listAgents: async () => [], agentTotal: () => 0, activeSwarm: () => 'tab', describe: () => undefined,
      sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(), answer: vi.fn(), focus: vi.fn(),
      openAgent: vi.fn(), forkAgent: async () => ({ ok: true, agentId: 'fork' }), updateAgent: vi.fn(),
      listModels: async () => [], recentSummaries: async () => [], transcribe: async () => '',
      route: async () => ({ agentId: '', confidence: 0, reason: 'fixture' }), log: vi.fn(),
    }
    const logs = mkdtempSync(join(tmpdir(), 'windows-fleet-'))
    const fleet = new CableFleet(CableSession, host, logs, DialLog, {
      discover, open, inUse: async () => false, intervalMs: 10,
      canUseUsb: () => isUsbConsoleUser({ platform: 'win32', windowsConsole: () => watch.console() }),
    })
    try {
      fleet.start()
      expect(discover).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith('COM3', expect.any(Function), expect.any(Function)))
      await vi.waitFor(() => expect(opened?.isOpen).toBe(true))
      expect(watch.console()).toBe(true)
    } finally {
      await fleet.stop()
      watch.stop()
      // DialLog's last write can land after stop(): retry the ENOTEMPTY that race leaves, as CI hit once.
      rmSync(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }
  })
})

// Windows runners have the real binary beside the host (windows.yml), and no dial.
describe.runIf(process.platform === 'win32' && !!process.env.HARNESS_SERIAL_BIN)('the real harness-serial.exe', () => {
  it('finds no dial on a runner, and says whether this session is at the screen', async () => {
    const watch = createWindowsDialWatch({ command: windowsSerialCommand, log: () => {} })
    try {
      expect(await watch.ports()).toEqual([])
      expect(typeof watch.console()).toBe('boolean')
    } finally { watch.stop() }
  })

  it('a port that is not there is gone for the link and free for the probe', async () => {
    await expect(SerialLink.openWindows('COM250', () => {}, () => {})).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await windowsPortInUse('COM250')).toBe(false)
  })

  // Review Focus 1: execFile must preserve the executable's path without a shell.
  it('runs from a folder whose name a shell would mangle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'serial-'))
    try {
      const dir = join(root, "Nguyễn Văn A' & 100%")
      mkdirSync(dir)
      const exe = join(dir, 'harness-serial.exe')
      copyFileSync(process.env.HARNESS_SERIAL_BIN!, exe)
      const { stdout } = await promisify(execFile)(exe, ['version'], { windowsHide: true })
      expect(JSON.parse(stdout)).toMatchObject({ protocol: 1 })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
