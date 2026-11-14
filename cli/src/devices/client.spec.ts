import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateHookCredential } from '../lib/hookAuth.js'
import { DEVICES_USAGE, devicesCommand, deviceRequest, runDialWatch, type DevicesClientDeps, type DialWatchDeps } from './client.js'

// A folder too long for a socket now has one under the home folder: only a home too long as well is left on the port.
beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
afterEach(() => { vi.unstubAllEnvs() })

const snapshot = (brightness = 80) => ({ status: { devices: [{ id: 'usb', attached: true, settings: { brightness } }] } })
function fixture() {
  const request = vi.fn(async (_id: string, _type: string, _payload?: Record<string, unknown>) => snapshot() as Record<string, unknown>)
  const deps: DevicesClientDeps = {
    port: 18473, machineId: async () => 'local', connect: () => { throw new Error('No real sockets') }, request,
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: { machines: [
      { machineId: 'local', name: 'Studio', status: 'running' },
      { machineId: 'remote', name: 'Office', status: 'running' },
      { machineId: 'offline', name: 'Workshop', status: 'offline' },
      { machineId: 'shared', isShared: true, status: 'running' },
    ] } }))) as typeof fetch,
    delay: async () => {},
  }
  return { deps, request }
}

describe('Devices DSH commands', () => {
  it('lists owned hosts, keeps offline presence, and reports unreachable hosts without inventing devices', async () => {
    const { deps, request } = fixture()
    request.mockRejectedValueOnce(new Error('unavailable'))
    const result = await devicesCommand(['list', '--json'], deps)
    expect(result.hosts).toMatchObject([
      { machineId: 'local', available: false, error: 'unavailable' },
      { machineId: 'remote', available: true, status: { devices: [{ id: 'usb' }] } },
      { machineId: 'offline', online: false, available: false },
    ])
    expect(request.mock.calls.map(call => call[0])).toEqual(['local', 'remote'])
  })
  it('targets only the selected host and waits for firmware confirmation', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() }).mockResolvedValueOnce(snapshot(35))
    expect(await devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}'], deps))
      .toMatchObject({ confirmed: true, machineId: 'remote', id: 'usb', settings: { brightness: 35 } })
    expect(request.mock.calls).toEqual([
      ['remote', 'harness_device_settings', { id: 'usb', patch: { brightness: 35 } }],
      ['remote', 'harness_devices_list'],
    ])
  })
  it('does not turn acceptance into confirmation and never writes offline or shared hosts', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() })
    const args = ['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}']
    expect(await devicesCommand(args, deps)).toMatchObject({ accepted: true, confirmed: false })
    request.mockClear()
    for (const id of ['offline', 'shared', 'unknown']) {
      await expect(devicesCommand([...args.slice(0, 2), id, ...args.slice(3)], deps)).rejects.toThrow()
    }
    await expect(devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"face":466}'], deps)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('waits for host selection, correlates the reply, and closes the tool socket', async () => {
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
    const { deps } = fixture()
    deps.connect = () => socket
    const reply = deviceRequest(deps, 'remote', 'harness_devices_list')
    socket.emit('open')
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({ type: 'machine_select', payload: { machineId: 'remote', tool: true, localProtocolVersion: 1 } })
    socket.emit('message', JSON.stringify({ type: 'connected' }))
    const call = JSON.parse(socket.send.mock.calls[1]![0])
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: 'wrong', status: 'bad' } }))
    expect(socket.close).not.toHaveBeenCalled()
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: call.payload.requestId, ...snapshot() } }))
    expect(await reply).toEqual(snapshot())
    expect(socket.close).toHaveBeenCalledOnce()
  })
  it('shows the daemon this OS user\'s local credential on its loopback socket and fetches only where no socket can exist', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'devices-cred-')), 'd'.repeat(100))
    mkdirSync(dataDir, { mode: 0o700 })
    try {
      const credential = loadOrCreateHookCredential(dataDir)
      const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
      const { deps } = fixture()
      const connect = vi.fn((_url: string, _headers?: Record<string, string>) => socket)
      Object.assign(deps, { dataDir, connect, request: undefined })
      const reply = deviceRequest(deps, 'remote', 'harness_devices_list')
      expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:18473/api/local-ws', { 'X-Harness-Local': credential })
      socket.emit('close', 1000)
      await expect(reply).rejects.toThrow('The computer disconnected.')
      await devicesCommand(['list', '--json'], { ...deps, request: async () => snapshot() })
      const init = vi.mocked(deps.fetch!).mock.calls[0]![1] as RequestInit
      expect(init.headers).toMatchObject({ 'x-adapter-local': '1', 'X-Harness-Local': credential })
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
})

const NOT_RUNNING = 'Harness is not running on this computer. Run: harness start'
const CLOSED = 'The connection to Harness on this computer closed.'
const TOO_OLD = '{"error":"Harness on this computer is too old for this. Run: harness update"}'
function watch(over: Partial<DialWatchDeps> = {}, argv = ['--json']) {
  const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
  const stdin = Object.assign(new EventEmitter(), { resume: vi.fn(), pause: vi.fn() })
  const printed: string[] = [], errors: string[] = []
  const connect = vi.fn((_url: string, _headers?: Record<string, string>) => socket)
  const deps: DialWatchDeps = {
    port: 18473, machineId: async () => 'local', connect, stdin,
    print: line => { printed.push(line) }, printError: line => { errors.push(line) }, ...over,
  }
  const done = runDialWatch(argv, deps)
  return { done, socket, stdin, printed, errors, connect }
}
// machineId() is awaited before the socket opens: wait until it has.
async function opened(socket: EventEmitter) {
  await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1))
  socket.emit('open')
}
const connected = (socket: EventEmitter, features?: string[]) =>
  socket.emit('message', JSON.stringify({ type: 'connected', payload: { machineId: 'local', ...(features ? { features } : {}) } }))
const dial = (socket: EventEmitter, payload: unknown) => socket.emit('message', JSON.stringify({ type: 'dial_status', payload }))
// Only a stdin end may finish the run here: any earlier exit would have resolved it with another code.
async function stillRunning(run: ReturnType<typeof watch>) {
  run.stdin.emit('end')
  expect(await run.done).toBe(0)
}

describe('harness hardware watch', () => {
  it('exits 3 when no daemon runs', async () => {
    const run = watch({ machineId: async () => null })
    expect(await run.done).toBe(3)
    expect(run.connect).not.toHaveBeenCalled()
  })
  it('exits 3 when the daemon cannot be reached', async () => {
    expect(await watch({ connect: () => { throw new Error('ENOENT') } }).done).toBe(3)
    const errored = watch()
    await opened(errored.socket)
    errored.socket.emit('error', new Error('ECONNREFUSED'))
    expect(await errored.done).toBe(3)
    for (const code of [1006, 4403]) {
      const closed = watch()
      await opened(closed.socket)
      closed.socket.emit('close', code, '')
      expect(await closed.done).toBe(3)
    }
    const later = watch()
    await opened(later.socket)
    connected(later.socket, ['dial-watch'])
    later.socket.emit('close', 1000, '')
    expect(await later.done).toBe(3)
  })
  it('exits 3 when the daemon does not answer in 10 s', async () => {
    vi.useFakeTimers()
    try {
      const silent = watch()
      await opened(silent.socket)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await Promise.race([silent.done, 'waiting'])).toBe(3)
      expect(silent.socket.close).toHaveBeenCalled()
      const answered = watch()
      await opened(answered.socket)
      connected(answered.socket, ['dial-watch'])
      await vi.advanceTimersByTimeAsync(60_000)
      await stillRunning(answered)
    } finally { vi.useRealTimers() }
  })
  it('says on stderr what to do when it exits 3, and keeps stdout for status lines', async () => {
    const runs: [ReturnType<typeof watch>, string][] = []
    for (const over of [{ machineId: async () => null }, { machineId: async () => { throw new Error('EACCES') } }, { connect: () => { throw new Error('ENOENT') } }]) {
      runs.push([watch(over), NOT_RUNNING])
    }
    const refused = watch()
    await opened(refused.socket)
    refused.socket.emit('error', new Error('ECONNREFUSED'))
    runs.push([refused, NOT_RUNNING])
    const closed = watch()
    await opened(closed.socket)
    connected(closed.socket, ['dial-watch'])
    closed.socket.emit('close', 1006, '')
    runs.push([closed, CLOSED])
    for (const [run, line] of runs) {
      expect(await run.done).toBe(3)
      expect(run.errors).toEqual([line])
      expect(run.printed).toEqual([])
    }
    vi.useFakeTimers()
    try {
      const silent = watch()
      await opened(silent.socket)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(silent.errors).toEqual([CLOSED])
    } finally { vi.useRealTimers() }
    const stopped = watch()
    await opened(stopped.socket)
    stopped.stdin.emit('end')
    expect(await stopped.done).toBe(0)
    expect(stopped.errors).toEqual([])
  })
  it('asks for the dial as a tool', async () => {
    const run = watch()
    await opened(run.socket)
    expect(JSON.parse(run.socket.send.mock.calls[0]![0])).toEqual({
      type: 'machine_select', payload: { machineId: 'local', localProtocolVersion: 1, tool: true, watch: ['dial'] },
    })
    await stillRunning(run)
  })
  it('exits 4 on a daemon without dial-watch', async () => {
    for (const features of [['openclaw-local'], undefined]) {
      const run = watch()
      await opened(run.socket)
      connected(run.socket, features)
      expect(await run.done).toBe(4)
      expect(run.printed).toEqual([TOO_OLD])
      expect(run.socket.close).toHaveBeenCalled()
    }
  })
  it('prints one line each time the status changes', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    dial(run.socket, { attached: false, devices: [] })
    dial(run.socket, { attached: false, devices: [] })
    const usb = { attached: true, fw: '0.0.95', hw: 'cst816s', settings: { brightness: 80 }, devices: [{}] }
    dial(run.socket, usb)
    dial(run.socket, { ...usb, settings: { brightness: 20 } })
    dial(run.socket, { ...usb, updating: '0.0.96' })
    dial(run.socket, { attached: false, board: 'pro', problem: 'Not answering — unplug and replug' })
    expect(run.printed).toEqual([
      '{"attached":false}',
      '{"attached":true,"fw":"0.0.95","hw":"cst816s"}',
      '{"attached":true,"fw":"0.0.95","hw":"cst816s","updating":"0.0.96"}',
      '{"attached":false,"board":"pro","problem":"Not answering — unplug and replug"}',
    ])
    await stillRunning(run)
  })
  it('skips what is not a status', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    run.socket.emit('message', 'not json')
    run.socket.emit('message', JSON.stringify({ type: 'agents_list_result' }))
    dial(run.socket, 'attached')
    expect(run.printed).toEqual([])
    await stillRunning(run)
  })
  it('exits 0 when stdin closes', async () => {
    const after = watch()
    expect(after.stdin.resume).toHaveBeenCalled()
    await opened(after.socket)
    connected(after.socket, ['dial-watch'])
    after.stdin.emit('end')
    expect(await after.done).toBe(0)
    expect(after.socket.close).toHaveBeenCalled()
    const before = watch()
    await opened(before.socket)
    before.stdin.emit('close')
    expect(await before.done).toBe(0)
  })
  it('lets go of everything when it ends', async () => {
    const ends: ((run: ReturnType<typeof watch>) => void)[] = [
      run => run.stdin.emit('end'),
      run => run.socket.emit('close', 1000, ''),
      run => run.socket.emit('error', new Error('reset')),
      run => connected(run.socket, []),
    ]
    for (const end of ends) {
      const run = watch()
      await opened(run.socket)
      end(run)
      await run.done
      expect(run.socket.close).toHaveBeenCalled()
      expect(run.stdin.pause).toHaveBeenCalled()
    }
    const none = watch({ machineId: async () => null })
    await none.done
    expect(none.stdin.pause).toHaveBeenCalled()
  })
  it('anything else is its usage and exit 1', async () => {
    const run = watch({}, ['now'])
    expect(await run.done).toBe(1)
    expect(run.printed).toEqual([DEVICES_USAGE])
    expect(run.connect).not.toHaveBeenCalled()
  })
  it('--json is accepted and not needed', async () => {
    const run = watch({}, [])
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    dial(run.socket, { attached: true, fw: '0.0.95' })
    expect(run.printed).toEqual(['{"attached":true,"fw":"0.0.95"}'])
    await stillRunning(run)
  })
  it('the usage names watch', () => {
    expect(DEVICES_USAGE).toContain('watch [--json]')
    expect(DEVICES_USAGE).toContain("one line each time this computer's dial changes")
  })
})
