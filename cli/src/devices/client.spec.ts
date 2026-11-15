import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateHookCredential } from '../lib/hookAuth.js'
import { DEVICES_USAGE, devicesCommand, deviceRequest, runDialWatch, type DevicesClientDeps, type DialWatchDeps } from './client.js'
import { devicesListenerPath } from './listenerPath.js'

// A folder too long for a socket now has one under the home folder: only a home too long as well is left on the port.
beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

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
const TOO_OLD = '{"error":"The Harness daemon on this computer is older than this command. Run: harness start --restart"}'
type Told = Parameters<NonNullable<DialWatchDeps['tell']>>[0]
function watch(over: Partial<DialWatchDeps> = {}, argv = ['--json']) {
  const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
  const stdin = Object.assign(new EventEmitter(), { resume: vi.fn(), pause: vi.fn() })
  const printed: string[] = [], errors: string[] = []
  const connect = vi.fn((_url: string, _headers?: Record<string, string>) => socket)
  // The devices listener, faked: no test reaches a socket of its own. It takes every message unless a test says otherwise.
  const tell = vi.fn(async (_message: Told) => true)
  // Its stream of selects, faked as one held open, so no test ends the stream of a watch Harness Device runs.
  const selects = vi.fn((_chunk: (data: Buffer) => void, _signal: AbortSignal) => new Promise<boolean>(() => {}))
  const deps: DialWatchDeps = {
    port: 18473, machineId: async () => 'local', connect, stdin, tell, selects,
    print: line => { printed.push(line) }, printError: line => { errors.push(line) }, ...over,
  }
  const done = runDialWatch(argv, deps)
  return { done, socket, stdin, printed, errors, connect, tell: deps.tell! as typeof tell }
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

// What the Harness Device app writes on the watch's stdin, one line each time the app in front changes.
const frontLine = (value: string) => `${JSON.stringify({ front: value })}\n`
const front = (run: ReturnType<typeof watch>, value: string) => run.stdin.emit('data', frontLine(value))
const told = (run: ReturnType<typeof watch>) => run.tell.mock.calls.map(([message]) => message)
const apps = (run: ReturnType<typeof watch>) => told(run).map(message => message.app)
const coreFrames = (run: ReturnType<typeof watch>) => run.socket.send.mock.calls.map(([data]) => JSON.parse(data).type)
// The pause the watch makes after each tell (client.ts): a change that comes in it is told as it ends.
const TELL_GAP_MS = 100
// One turn of the event loop, then the pause: every tell already answered has been seen by the watch, and what came
// since is told.
const turn = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(TELL_GAP_MS)
}
/** A devices listener that answers only when the test says, one tell at a time. */
function heldListener() {
  const answers: ((taken: boolean) => void)[] = []
  const tell = vi.fn((_message: Told) => new Promise<boolean>(resolve => { answers.push(resolve) }))
  return { tell, answer: async (taken: boolean) => { answers.shift()!(taken); await turn() } }
}

describe('harness hardware watch: the app in front', () => {
  // The event loop's turns stay real: only the watch's own timers are the test's.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  it('a front line is told to the devices listener as an app id', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    await turn()
    expect(told(run)).toEqual([{ type: 'front', app: 'ghostty' }])
    front(run, 'Code.exe')
    await turn()
    expect(told(run)).toEqual([{ type: 'front', app: 'ghostty' }, { type: 'front', app: 'vscode' }])
    await stillRunning(run)
  })
  it('an unknown app is told as none', async () => {
    const run = watch()
    front(run, 'com.apple.Safari')
    await turn()
    expect(told(run)).toEqual([{ type: 'front', app: 'none' }])
    await stillRunning(run)
  })
  it('the raw value is never sent or printed', async () => {
    const raw = /mitchellh|code\.exe|safari/i
    // A listener that refuses none, so a tell that fails is read too.
    const tell = vi.fn(async (message: Told) => message.app !== 'none')
    const run = watch({ tell })
    front(run, 'com.mitchellh.ghostty')
    await opened(run.socket)
    connected(run.socket, ['openclaw-local', 'dial-watch'])
    front(run, 'Code.exe')
    await turn()
    front(run, 'com.apple.Safari')
    await turn()
    run.stdin.emit('data', 'com.mitchellh.ghostty\n')
    run.stdin.emit('data', `{"front":"Code.exe","pad":"${'x'.repeat(2000)}"}\n`)
    dial(run.socket, { attached: true, fw: '0.0.95' })
    await turn()
    run.socket.emit('close', 1006, '')
    expect(await run.done).toBe(3)
    const out = [...tell.mock.calls.map(([message]) => JSON.stringify(message)), ...run.socket.send.mock.calls.map(([data]) => String(data)), ...run.printed, ...run.errors]
    expect(out.filter(line => raw.test(line))).toEqual([])
    expect(apps(run)).toEqual(['ghostty', 'vscode', 'none', 'none'])
  })
  it("nothing of the app in front goes on the core's socket", async () => {
    const run = watch()
    front(run, 'com.mitchellh.ghostty')
    await turn()
    await opened(run.socket)
    // A daemon that still names the old door is sent nothing through it.
    connected(run.socket, ['openclaw-local', 'dial-watch', 'dial-front'])
    front(run, 'Code.exe')
    dial(run.socket, { attached: true })
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'vscode', 'vscode'])
    expect(coreFrames(run)).toEqual(['machine_select'])
    await stillRunning(run)
  })
  it('the same app twice is told once; Safari then Finder is one none', async () => {
    const run = watch()
    for (const value of ['com.mitchellh.ghostty', 'ghostty', 'com.apple.Safari', 'com.apple.finder', 'com.mitchellh.ghostty']) {
      front(run, value)
      await turn()
    }
    expect(apps(run)).toEqual(['ghostty', 'none', 'ghostty'])
    await stillRunning(run)
  })
  it('a front line is told at once, before the daemon has answered', async () => {
    const waiting = watch({ machineId: () => new Promise(() => {}) })
    front(waiting, 'com.mitchellh.ghostty')
    expect(told(waiting)).toEqual([{ type: 'front', app: 'ghostty' }])
    await stillRunning(waiting)
    const unanswered = watch()
    await opened(unanswered.socket)
    front(unanswered, 'Code.exe')
    expect(told(unanswered)).toEqual([{ type: 'front', app: 'vscode' }])
    await stillRunning(unanswered)
  })
  it('with no listener the line is ignored, and the next change is told', async () => {
    const answers = [false, true]
    const tell = vi.fn(async (_message: Told) => answers.shift() ?? true)
    const run = watch({ tell })
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    await turn()
    // Not taken, and not tried again by itself.
    expect(apps(run)).toEqual(['ghostty'])
    front(run, 'Code.exe')
    await turn()
    front(run, 'com.mitchellh.ghostty')
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'vscode', 'ghostty'])
    expect(run.printed).toEqual([])
    expect(run.errors).toEqual([])
    await stillRunning(run)
  })
  it('when dial_status says attached the current app is told again, also one the listener took before; with no front line read yet nothing is told', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    dial(run.socket, { attached: true })
    await turn()
    expect(told(run)).toEqual([])
    front(run, 'com.mitchellh.ghostty')
    await turn()
    expect(apps(run)).toEqual(['ghostty'])
    // Gone: nothing for the devices.
    dial(run.socket, { attached: false })
    await turn()
    expect(apps(run)).toEqual(['ghostty'])
    dial(run.socket, { attached: true, fw: '0.0.95' })
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'ghostty'])
    await stillRunning(run)
    // The first status says attached.
    const first = watch()
    front(first, 'Code.exe')
    await turn()
    await opened(first.socket)
    connected(first.socket, ['dial-watch'])
    dial(first.socket, { attached: true })
    await turn()
    expect(apps(first)).toEqual(['vscode', 'vscode'])
    await stillRunning(first)
    // The dial attaches while the same app is being told, perhaps before the devices listen: it is told again after.
    const held = heldListener()
    const during = watch({ tell: held.tell })
    await opened(during.socket)
    connected(during.socket, ['dial-watch'])
    front(during, 'com.mitchellh.ghostty')
    dial(during.socket, { attached: true })
    expect(apps(during)).toEqual(['ghostty'])
    await held.answer(false)
    expect(apps(during)).toEqual(['ghostty', 'ghostty'])
    await held.answer(true)
    expect(apps(during)).toEqual(['ghostty', 'ghostty'])
    during.stdin.emit('end')
    await held.answer(true)
    expect(await during.done).toBe(0)
  })
  it('the same attached status again (a new devices process) tells the app in front again', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    dial(run.socket, { attached: true, fw: '0.0.95' })
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'ghostty'])
    // The devices process restarted under a dial still attached: the core kept its status, and the new one's reads the same.
    dial(run.socket, { attached: true, fw: '0.0.95' })
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'ghostty', 'ghostty'])
    expect(run.printed).toEqual(['{"attached":true,"fw":"0.0.95"}'])
    await stillRunning(run)
  })
  it('two changes while a tell is under way: the newest is told when it ends, the one between is skipped', async () => {
    const held = heldListener()
    const run = watch({ tell: held.tell })
    front(run, 'com.mitchellh.ghostty')
    front(run, 'Code.exe')
    front(run, 'cursor')
    expect(apps(run)).toEqual(['ghostty'])
    await held.answer(true)
    expect(apps(run)).toEqual(['ghostty', 'cursor'])
    // Away and back to the app being told: the listener has it when the tell ends.
    front(run, 'Code.exe')
    front(run, 'cursor')
    await held.answer(true)
    expect(apps(run)).toEqual(['ghostty', 'cursor'])
    run.stdin.emit('end')
    await held.answer(true)
    expect(await run.done).toBe(0)
  })
  it('a change every 10 ms against a listener of ten a second: told at most once each 100 ms, and the newest last', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent: number[] = [], taken: Array<{ app: string; at: number }> = []
    // The listener's rate on one connection: ten in any second.
    const tell = vi.fn(async ({ app }: Told) => {
      const at = Date.now()
      sent.push(at)
      if (taken.length >= 10 && at - taken.at(-10)!.at < 1_000) return false
      taken.push({ app, at })
      return true
    })
    const run = watch({ tell })
    for (let i = 0; i < 12; i++) {
      front(run, ['com.mitchellh.ghostty', 'Code.exe', 'cursor'][i % 3]!)
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(taken.at(-1)!.app).toBe('cursor')
    expect(sent.slice(1).map((at, i) => at - sent[i]!).every(gap => gap >= 100)).toBe(true)
    // Nothing more once the newest is told: one timer, no retry.
    const tells = tell.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tell.mock.calls.length).toBe(tells)
    await stillRunning(run)
  })
  it('after stdin closes only none is told, once the tell under way has ended', async () => {
    const held = heldListener()
    const run = watch({ tell: held.tell })
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    front(run, 'Code.exe')
    run.stdin.emit('end')
    run.stdin.emit('close')
    expect(apps(run)).toEqual(['ghostty'])
    await held.answer(true)
    expect(apps(run)).toEqual(['ghostty', 'none'])
    await held.answer(true)
    expect(await run.done).toBe(0)
    front(run, 'cursor')
    dial(run.socket, { attached: true })
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'none'])
  })
  it('a tell answered after stdin closed leaves no timer', async () => {
    const held = heldListener()
    const run = watch({ tell: held.tell })
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    run.stdin.emit('end')
    await held.answer(true)
    await held.answer(true)
    expect(await run.done).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stdin ending after an app in front tells none once, then exits: the devices stop following an app the Device app no longer sees', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    front(run, 'com.mitchellh.ghostty')
    await turn()
    run.stdin.emit('end')
    run.stdin.emit('close')
    expect(await run.done).toBe(0)
    await turn()
    expect(told(run)).toEqual([{ type: 'front', app: 'ghostty' }, { type: 'front', app: 'none' }])
  })
  it('stdin ending with no app in front ever told tells nothing', async () => {
    const quiet = watch()
    await opened(quiet.socket)
    connected(quiet.socket, ['dial-watch'])
    quiet.stdin.emit('end')
    expect(await quiet.done).toBe(0)
    expect(told(quiet)).toEqual([])
    // Only unlisted apps in front: the devices already have none.
    const unlisted = watch()
    front(unlisted, 'com.apple.Safari')
    await turn()
    unlisted.stdin.emit('end')
    expect(await unlisted.done).toBe(0)
    expect(apps(unlisted)).toEqual(['none'])
  })
  it('a tell under way that outlasts the 2 s holds the exit no longer, and no none follows it after the exit', async () => {
    const held = heldListener()
    const run = watch({ tell: held.tell })
    front(run, 'com.mitchellh.ghostty')
    run.stdin.emit('end')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await run.done).toBe(0)
    await held.answer(true)
    expect(apps(run)).toEqual(['ghostty'])
  })
  it('a listener that never answers the none holds the exit 2 s at most, and the none is not tried again', async () => {
    const held = heldListener()
    const run = watch({ tell: held.tell })
    front(run, 'com.mitchellh.ghostty')
    await held.answer(true)
    let exited = false
    void run.done.then(() => { exited = true })
    run.stdin.emit('end')
    expect(apps(run)).toEqual(['ghostty', 'none'])
    await vi.advanceTimersByTimeAsync(1_999)
    expect(exited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(exited).toBe(true)
    expect(await run.done).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apps(run)).toEqual(['ghostty', 'none'])
  })
  it('a line in two chunks is one line; a 2000-byte line and a line that is not JSON are dropped, and the next line still works', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    run.stdin.emit('data', '{"front":"com.mitch')
    run.stdin.emit('data', 'ellh.ghostty"}\n')
    await turn()
    expect(apps(run)).toEqual(['ghostty'])
    // Each would tell vscode if it were read.
    const long = `{"front":"Code.exe","pad":"${'x'.repeat(2000)}"}\n`
    run.stdin.emit('data', long)
    for (let at = 0; at < long.length; at += 500) run.stdin.emit('data', Buffer.from(long.slice(at, at + 500)))
    for (const line of ['Code.exe\n', '{"front":5}\n', '{}\n', 'null\n', '\n']) run.stdin.emit('data', line)
    await turn()
    expect(apps(run)).toEqual(['ghostty'])
    // 1024 bytes is the longest line read.
    const longest = `{"front":"Code.exe","pad":"${'x'.repeat(1024 - 29)}"}`
    expect(Buffer.byteLength(longest)).toBe(1024)
    const bytes = Buffer.from(`${longest}\n`)
    run.stdin.emit('data', bytes.subarray(0, 700))
    run.stdin.emit('data', bytes.subarray(700))
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'vscode'])
    run.stdin.emit('data', `${frontLine('com.apple.Safari')}${frontLine('com.mitchellh.ghostty')}`)
    await turn()
    expect(apps(run)).toEqual(['ghostty', 'vscode', 'none', 'ghostty'])
    await stillRunning(run)
  })
  it('dial status lines print as before, and stdin closing still exits 0', async () => {
    const run = watch()
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    dial(run.socket, { attached: true, fw: '0.0.95' })
    front(run, 'com.mitchellh.ghostty')
    dial(run.socket, { attached: true, fw: '0.0.95' })
    dial(run.socket, { attached: false })
    expect(run.printed).toEqual(['{"attached":true,"fw":"0.0.95"}', '{"attached":false}'])
    expect(run.errors).toEqual([])
    run.stdin.emit('end')
    expect(await run.done).toBe(0)
    expect(run.socket.close).toHaveBeenCalled()
    expect(run.stdin.pause).toHaveBeenCalled()
  })
})

// What the Harness Device app writes on the watch's stdin each time the selected tab of a tab app in front changes.
const tabLine = (tab: unknown) => `${JSON.stringify({ tab })}\n`
const TAB = { app: 'terminal-app', tty: '/dev/ttys023' }
const SELECT = '{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}'
const RAISE = '{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":true}}'
// A data folder with a listener path, so the watch opens its stream. Nothing in it is touched: the tells and the stream
// are the test's.
const LISTENING = '/tmp/hdw-none'
/** The devices' stream of selects, faked: each open is held until the test ends it, saying whether it had opened. */
function tabStreams() {
  const opens: { chunk: (data: Buffer) => void; signal: AbortSignal; end: (hadOpened: boolean) => void }[] = []
  const selects = vi.fn((chunk: (data: Buffer) => void, signal: AbortSignal) => new Promise<boolean>(end => { opens.push({ chunk, signal, end }) }))
  // Lines on the stream opened last, in one chunk.
  const send = (...lines: string[]) => opens.at(-1)!.chunk(Buffer.from(lines.map(line => `${line}\n`).join('')))
  return { selects, opens, send }
}
/** A watch the daemon has answered, its stream open. */
async function streaming(over: Partial<DialWatchDeps> = {}) {
  const streams = tabStreams()
  const run = watch({ dataDir: LISTENING, selects: streams.selects, ...over })
  await opened(run.socket)
  connected(run.socket, ['dial-watch'])
  return { run, ...streams }
}

describe('harness hardware watch: the selected tab', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  it('a tab line is told to the devices listener as a tab message', async () => {
    const { run } = await streaming()
    run.stdin.emit('data', tabLine(TAB))
    await turn()
    expect(told(run)).toEqual([{ type: 'tab', app: 'terminal-app', tty: '/dev/ttys023' }])
    // Each of the three apps, and only app and tty travel on.
    run.stdin.emit('data', tabLine({ app: 'iterm', tty: '/dev/ttys4', title: 'notes.md' }))
    await turn()
    run.stdin.emit('data', tabLine({ app: 'ghostty', tty: '/dev/ttys9999' }))
    await turn()
    expect(told(run)).toEqual([
      { type: 'tab', app: 'terminal-app', tty: '/dev/ttys023' },
      { type: 'tab', app: 'iterm', tty: '/dev/ttys4' },
      { type: 'tab', app: 'ghostty', tty: '/dev/ttys9999' },
    ])
    await stillRunning(run)
  })
  it('a bad app, a bad tty and a tab that is not an object are dropped, and the next line is told', async () => {
    const { run } = await streaming()
    for (const tab of [
      { app: 'vscode', tty: '/dev/ttys023' }, { app: 'Terminal', tty: '/dev/ttys023' }, { tty: '/dev/ttys023' },
      { app: 'terminal-app', tty: '/dev/ttys12345' }, { app: 'terminal-app', tty: '/dev/tty023' },
      { app: 'terminal-app', tty: '/dev/ttys023\n' }, { app: 'terminal-app' }, 'terminal-app', null, [TAB], 5,
    ]) run.stdin.emit('data', tabLine(tab))
    run.stdin.emit('data', '{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}\n')
    await turn()
    expect(told(run)).toEqual([])
    run.stdin.emit('data', tabLine(TAB))
    await turn()
    expect(told(run)).toEqual([{ type: 'tab', ...TAB }])
    await stillRunning(run)
  })
  it('two tab lines while a tell is under way: the newest is told when it ends, the one between is skipped', async () => {
    const held = heldListener()
    const { run } = await streaming({ tell: held.tell })
    run.stdin.emit('data', tabLine(TAB))
    run.stdin.emit('data', tabLine({ app: 'iterm', tty: '/dev/ttys4' }))
    run.stdin.emit('data', tabLine({ app: 'ghostty', tty: '/dev/ttys5' }))
    expect(told(run)).toEqual([{ type: 'tab', ...TAB }])
    await held.answer(true)
    expect(told(run)).toEqual([{ type: 'tab', ...TAB }, { type: 'tab', app: 'ghostty', tty: '/dev/ttys5' }])
    // Not taken, and not tried again by itself.
    await held.answer(false)
    await turn()
    expect(told(run)).toHaveLength(2)
    await stillRunning(run)
  })
  it('a tab tell does not wait for a front tell under way', async () => {
    // A listener that never answers the app in front.
    const tell = vi.fn((message: Told) => message.type === 'front' ? new Promise<boolean>(() => {}) : Promise.resolve(true))
    const { run } = await streaming({ tell })
    front(run, 'com.mitchellh.ghostty')
    run.stdin.emit('data', tabLine({ app: 'ghostty', tty: '/dev/ttys5' }))
    expect(told(run)).toEqual([{ type: 'front', app: 'ghostty' }, { type: 'tab', app: 'ghostty', tty: '/dev/ttys5' }])
    await turn()
    run.stdin.emit('data', tabLine({ app: 'ghostty', tty: '/dev/ttys6' }))
    expect(told(run)).toEqual([
      { type: 'front', app: 'ghostty' }, { type: 'tab', app: 'ghostty', tty: '/dev/ttys5' }, { type: 'tab', app: 'ghostty', tty: '/dev/ttys6' },
    ])
    // The exit waits on the front tell under way 2 s at most, as before.
    run.stdin.emit('end')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await run.done).toBe(0)
  })
  it("nothing of a tab goes on the core's socket", async () => {
    const run = watch({ dataDir: LISTENING, selects: tabStreams().selects })
    run.stdin.emit('data', tabLine(TAB))
    await opened(run.socket)
    connected(run.socket, ['dial-watch'])
    dial(run.socket, { attached: true })
    run.stdin.emit('data', tabLine({ app: 'iterm', tty: '/dev/ttys4' }))
    await turn()
    expect(told(run)).toEqual([{ type: 'tab', ...TAB }, { type: 'tab', app: 'iterm', tty: '/dev/ttys4' }])
    expect(coreFrames(run)).toEqual(['machine_select'])
    const out = [...run.socket.send.mock.calls.map(([data]) => String(data)), ...run.printed, ...run.errors]
    expect(out.filter(line => line.includes('ttys'))).toEqual([])
    await stillRunning(run)
  })
  it('the stream opens after connected, and each line prints one select line', async () => {
    const streams = tabStreams()
    const run = watch({ dataDir: LISTENING, selects: streams.selects })
    await opened(run.socket)
    expect(streams.selects).not.toHaveBeenCalled()
    connected(run.socket, ['dial-watch'])
    expect(streams.selects).toHaveBeenCalledOnce()
    streams.send('{"app":"terminal-app","tty":"/dev/ttys023"}')
    expect(run.printed).toEqual([SELECT])
    // Two lines in one chunk are two selects; a line in two chunks is one.
    streams.send('{"app":"iterm","tty":"/dev/ttys4"}', '{"app":"ghostty","tty":"/dev/ttys5"}')
    streams.opens[0]!.chunk(Buffer.from('{"app":"terminal-app",'))
    streams.opens[0]!.chunk(Buffer.from('"tty":"/dev/ttys023"}\n'))
    expect(run.printed).toEqual([SELECT, '{"select":{"app":"iterm","tty":"/dev/ttys4"}}', '{"select":{"app":"ghostty","tty":"/dev/ttys5"}}', SELECT])
    await stillRunning(run)
    // A daemon without dial-watch: none is opened.
    const old = tabStreams()
    const older = watch({ dataDir: LISTENING, selects: old.selects })
    await opened(older.socket)
    connected(older.socket, ['openclaw-local'])
    expect(await older.done).toBe(4)
    expect(old.selects).not.toHaveBeenCalled()
  })
  it('a stream line with a bad app or tty, one that is not JSON and one over 96 bytes print nothing', async () => {
    const { run, send } = await streaming()
    const padded = (bytes: number) => {
      const start = '{"app":"terminal-app","tty":"/dev/ttys023","pad":"'
      return `${start}${'x'.repeat(bytes - start.length - 2)}"}`
    }
    expect(Buffer.byteLength(padded(97))).toBe(97)
    send('{"app":"Terminal","tty":"/dev/ttys023"}', '{"app":"terminal-app","tty":"/dev/tty023"}', '{"app":"terminal-app"}',
      '{"app":"terminal-app","tty":"/dev/ttys023"', 'null', '[]', '"terminal-app"', padded(97))
    expect(run.printed).toEqual([])
    // 96 bytes is the longest line read, and its other key is not printed.
    send(padded(96))
    expect(run.printed).toEqual([SELECT])
    await stillRunning(run)
  })
  it('a stream line with "raise":true prints the select with "raise":true, after app and tty', async () => {
    const { run, send } = await streaming()
    send('{"raise":true,"tty":"/dev/ttys023","app":"terminal-app"}')
    expect(run.printed).toEqual([RAISE])
    await stillRunning(run)
  })
  it('a line with no raise, or raise false, prints the select with no raise key; no other key is printed', async () => {
    const { run, send } = await streaming()
    send('{"app":"terminal-app","tty":"/dev/ttys023"}', '{"app":"terminal-app","tty":"/dev/ttys023","raise":false}',
      '{"app":"terminal-app","tty":"/dev/ttys023","title":"notes.md","cwd":"/Users/me"}')
    expect(run.printed).toEqual([SELECT, SELECT, SELECT])
    await stillRunning(run)
  })
  it('a raise that is not a boolean prints nothing ("true", 1, null, {}), and the next line is printed', async () => {
    const { run, send } = await streaming()
    for (const raise of ['"true"', '1', 'null', '{}', '0', '[]']) send(`{"app":"terminal-app","tty":"/dev/ttys023","raise":${raise}}`)
    expect(run.printed).toEqual([])
    send('{"app":"terminal-app","tty":"/dev/ttys023","raise":true}')
    expect(run.printed).toEqual([RAISE])
    await stillRunning(run)
  })
  it('a stream that ends is opened again after 1 s, 2 s, 4 s, then 30 s at most; one that had opened starts again from 1 s', async () => {
    const { run, selects, opens, send } = await streaming()
    // The stream open last ends, and the next is opened [ms] later, not sooner.
    const reopensAfter = async (hadOpened: boolean, ms: number) => {
      const calls = selects.mock.calls.length
      opens.at(-1)!.end(hadOpened)
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(selects).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(selects).toHaveBeenCalledTimes(calls + 1)
    }
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) await reopensAfter(false, ms)
    await reopensAfter(true, 1_000)
    await reopensAfter(false, 2_000)
    // Each open reads lines of its own: the start of a line one stream ended on never joins the next one's.
    opens.at(-1)!.chunk(Buffer.from('{"app":"terminal-app","tty":"/dev/ttys023"'))
    await reopensAfter(true, 1_000)
    send('}')
    expect(run.printed).toEqual([])
    await stillRunning(run)
  })
  it('the dial attaching opens it at once, and opens no second one', async () => {
    const { run, selects, opens } = await streaming()
    // Opening: the dial attaching opens no second one.
    dial(run.socket, { attached: true })
    expect(selects).toHaveBeenCalledOnce()
    opens[0]!.end(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(selects).toHaveBeenCalledTimes(2)
    // The next try would wait 2 s: the dial attaching opens it at once.
    opens[1]!.end(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(selects).toHaveBeenCalledTimes(2)
    dial(run.socket, { attached: true, fw: '0.0.95' })
    expect(selects).toHaveBeenCalledTimes(3)
    // The wait it replaced opens nothing, and a dial gone and attached again opens no second one.
    await vi.advanceTimersByTimeAsync(5_000)
    dial(run.socket, { attached: false })
    dial(run.socket, { attached: true, fw: '0.0.95' })
    expect(selects).toHaveBeenCalledTimes(3)
    // The wait starts again from 1 s.
    opens[2]!.end(false)
    await vi.advanceTimersByTimeAsync(999)
    expect(selects).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(selects).toHaveBeenCalledTimes(4)
    await stillRunning(run)
  })
  it('with no listener path no stream is opened or retried', async () => {
    // A data folder and a home (stubbed above) both too long for a socket: the devices have no listener to reach.
    const dataDir = `/${'d'.repeat(120)}`
    expect(devicesListenerPath(dataDir)).toBeNull()
    const { run, selects } = await streaming({ dataDir })
    dial(run.socket, { attached: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(selects).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await stillRunning(run)
  })
  it('stdin closing ends the stream and leaves no timer', async () => {
    const { run, opens } = await streaming()
    // A tab told, and its gap under way.
    run.stdin.emit('data', tabLine(TAB))
    await new Promise(resolve => setImmediate(resolve))
    run.stdin.emit('end')
    expect(await run.done).toBe(0)
    expect(opens[0]!.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    // Waiting to open again when the daemon goes: the wait is cleared.
    const waiting = await streaming()
    waiting.opens[0]!.end(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    waiting.run.socket.emit('close', 1006, '')
    expect(await waiting.run.done).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(waiting.selects).toHaveBeenCalledOnce()
    // Open when the daemon goes: it is let go.
    const open = await streaming()
    open.run.socket.emit('close', 1006, '')
    expect(await open.run.done).toBe(3)
    expect(open.opens[0]!.signal.aborted).toBe(true)
  })
  it('a select line does not hold back the next status line', async () => {
    const { run, send } = await streaming()
    dial(run.socket, { attached: true, fw: '0.0.95' })
    send('{"app":"terminal-app","tty":"/dev/ttys023"}')
    // A select is no status: the same status again prints nothing, and the next change prints at once.
    dial(run.socket, { attached: true, fw: '0.0.95' })
    dial(run.socket, { attached: false })
    expect(run.printed).toEqual(['{"attached":true,"fw":"0.0.95"}', SELECT, '{"attached":false}'])
    await stillRunning(run)
  })
})
