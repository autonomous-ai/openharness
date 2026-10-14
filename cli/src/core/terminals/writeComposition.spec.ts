import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { TmuxBackend } from '../../lib/tmuxBackend.js'
import { assumeTmuxVersion, resetTmuxVersionCache } from '../../lib/tmuxVersion.js'
import { inlineSubmission } from '../../testing/inlineSubmission.js'
import { readInlineScreen } from '../../testing/inlineScreen.js'
import { createInput, messageWriter, type InputDeps } from '../input.js'
import { createTerminalControl } from './control.js'
import { createTerminalWriter } from './writer.js'
import { RuntimeProfileController } from '../../lib/runtimeControl.js'
import { encodeRuntimeProfile } from '../../engines/kit/runtime.js'

// These are the only process functions the composed path may use. No fixture
// command can reach a host tmux server, engine home or daemon.
const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<object>(), ...native }))
vi.mock('child_process', async importOriginal => ({ ...await importOriginal<object>(), ...native }))
const held = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const pane = '────────────\n❯\n────────────\n  ? for shortcuts'
const runtime = { backend: 'tmux' as const, paneId: '%1' }
const record = (): RegisteredSession => ({
  schemaVersion: 2, active: true, agentId: 'agent', sessionId: 'session', boundAt: 1, engine: 'claude', transcriptPath: null,
  projectDir: 'work', cwd: '/work', runtimes: [runtime], primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1',
  source: null, title: null, model: null, cliVersion: null,
  processIdentity: { pid: 42, executable: 'claude', startMarker: 'fixture-start' },
  registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
})
beforeEach(() => { vi.useFakeTimers(); assumeTmuxVersion({ major: 3, minor: 7 }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); resetTmuxVersionCache() })

function setup(options: { now?: () => number; native?: boolean } = {}) {
  const row = record(), calls: string[] = [], callbacks = new Map<string, () => void>()
  if (options.native) row.engine = 'cursor'
  let pause = '', onCommand = (_command: string) => {}
  const complete = (command: string, done: () => void) => {
    onCommand(command)
    if (pause === command) callbacks.set(command, done)
    else queueMicrotask(done)
  }
  native.execFile.mockImplementation((file: string, args: string[], _options: unknown, done: (error: null, out: string, err: string) => void) => {
    expect(file).toBe('tmux')
    const command = args[0] === 'send-keys' ? args.at(-1)! : args[0]
    calls.push(command)
    complete(command, () => done(null, '', ''))
    return { kill: vi.fn() }
  })
  native.spawn.mockImplementation((file: string, args: string[]) => {
    expect(file).toBe('tmux'); expect(args[0]).toBe('load-buffer')
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), {
      end: () => complete('load-buffer', () => child.emit('close', 0)),
    }), kill: vi.fn() })
    return child
  })
  const backend = new TmuxBackend()
  // The process/pane readings are fixed; all control, lease routing, paste, key
  // and Enter implementations run unchanged down to execFile/spawn above.
  vi.spyOn(backend, 'validate').mockResolvedValue({ state: 'alive' })
  const capture = vi.spyOn(backend, 'capture').mockResolvedValue({ state: 'succeeded', value: options.native ? '→\n' : pane })
  const coordinator = new TerminalBackendCoordinator([backend], ['tmux'])
  const terminal = createTerminalControl({ resolve: () => row, terminals: coordinator, writer: createTerminalWriter(options) })
  const readScreen = vi.fn(readInlineScreen), promptTyped = vi.fn(), notifications = vi.fn()
  const deps: InputDeps = { resolve: () => row, byAgent: () => row, terminal, readScreen, promptTyped, submission: inlineSubmission,
    ...(options.native ? { native: { owns: () => true, prepare: async () => ({ verify() {} }), blocksControl: () => false, held: vi.fn() } } : {}),
    deliveries: { settled: vi.fn(), canWrite: () => true },
    device: () => ({ delivery: notifications, inputDispatched: vi.fn(), inputStatus: vi.fn(), agentGone: vi.fn() }),
    clients: { send: vi.fn(), sendCommander: vi.fn() }, agentIdFor: () => row.agentId, commandcode: () => undefined, emit: vi.fn() }
  const input = createInput(deps)
  const write = () => input.deviceInput.legacyWrite(row.agentId, ticket => messageWriter(deps)(row.agentId, 'hello', undefined, ticket))
  const cancel = () => input.deviceInput.interruptWrite(row.agentId,
    ticket => terminal.interruptTerminalAction('session', ticket.allowed, ticket))
  return { row, calls, terminal, input, deps, readScreen, promptTyped, capture, write, cancel, notifications,
    pause: (command: string) => { pause = command }, finish: (command: string) => { callbacks.get(command)!(); callbacks.delete(command) },
    onCommand: (callback: typeof onCommand) => { onCommand = callback } }
}

it.each(['literal', 'submit'] as const)('native control revokes %s during real buffer preparation and fences cleanup Escape', async kind => {
  const run = setup({ native: true })
  let valid = true
  run.deps.native!.prepare = async () => ({ verify: () => { if (!valid) throw Error('generation frontier changed') } })
  const release = run.input.acquireTerminalControl('agent', { forAnswer: true })!
  run.pause('load-buffer')
  const effect = kind === 'literal' ? run.terminal.typeTerminal('agent', 'filter') : run.terminal.submitTerminal('agent', '/model next')
  await flush()
  valid = false
  run.finish('load-buffer'); await expect(effect).resolves.toBe(false)
  await expect(run.terminal.keyTerminal('agent', 'Escape')).resolves.toBe(false)
  expect(run.calls).toEqual(['delete-buffer'])
  expect(run.terminal.pinnedControls.has('agent')).toBe(true)
  release(); run.input.nativeInput!.close()
})

it.each(['key', 'submit'] as const)('a caller-supplied %s dispatch cannot bypass the pinned native proof', async kind => {
  const run = setup({ native: true })
  let valid = true
  run.deps.native!.prepare = async () => ({ verify: () => { if (!valid) throw Error('generation frontier changed') } })
  const release = run.input.acquireTerminalControl('agent')!
  const ticket = run.terminal.writer.ticket('agent')
  const write = { allowed: ticket.allowed, dispatch: <T>(effect: () => Promise<T>): Promise<T> => {
    valid = false
    return ticket.dispatch(effect)
  } }
  const result = kind === 'key'
    ? run.terminal.keyTerminalAction('agent', 'Enter', write.allowed, write)
    : run.terminal.submitTerminalAction('agent', '/model next', write)
  await expect(result).resolves.toMatchObject({ dispatch: 'not_started' })
  expect(run.calls).toEqual(kind === 'submit' ? ['delete-buffer'] : [])
  release(); run.input.nativeInput!.close()
})

it.each(['support', 'catalog'] as const)('a model control read cannot adopt a conversation rebound during %s preparation', async phase => {
  const run = setup()
  const target = encodeRuntimeProfile({ sessionId: 'agent', engine: 'claude', model: 'opus', effort: 'high' })
  const rebind = () => { run.row.sessionId = 'replacement'; run.row.boundAt = 2 }
  const apply = vi.fn()
  const controller = new RuntimeProfileController({
    manager: { getState: () => ({}), selectedModel: () => null,
      supportsControl: async () => { if (phase === 'support') rebind(); return true },
      modelsForSession: async () => { if (phase === 'catalog') rebind(); return [{ id: target }] },
    } as never,
    getSession: () => run.row, modelControlFor: () => ({ validate: async () => {}, apply }),
    readScreen: run.deps.readScreen, validateRuntime: run.terminal.validateTerminal, capture: run.terminal.captureTerminal,
    sendText: run.terminal.submitTerminal, sendLiteral: run.terminal.typeTerminal, sendKey: run.terminal.keyTerminal,
    acquireInput: run.input.acquireTerminalControl,
  })
  await expect(controller.setProfile('agent', target)).rejects.toMatchObject({ code: 'BUSY' })
  expect(apply).not.toHaveBeenCalled()
  expect(run.terminal.pinnedControls.has('agent')).toBe(false)
  expect(run.calls).toEqual([])
})

it.each(['unavailable', 'empty'] as const)('holds the real native tmux Enter when its screen becomes %s after paste', async fault => {
  const run = setup({ native: true })
  run.onCommand(command => {
    if (command === 'paste-buffer') run.capture.mockResolvedValue(fault === 'empty'
      ? { state: 'succeeded', value: '' } : { state: 'failed', reason: 'unreadable' })
  })
  run.input.submitAgent('agent', 'only once', 'native-one')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(run.calls).toEqual(['paste-buffer'])
  expect(run.deps.deliveries.settled).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'native-one', state: 'unknown', reason: 'dispatch_ambiguous' })
  run.input.nativeInput!.close()
})

it('sends consecutive native messages through the observed empty composer without a clearing key', async () => {
  const run = setup({ native: true })
  run.input.submitAgent('agent', 'first', 'native-one'); await vi.advanceTimersByTimeAsync(0)
  run.input.submitAgent('agent', 'second', 'native-two'); await vi.advanceTimersByTimeAsync(0)
  expect(run.calls).toEqual(['paste-buffer', 'Enter', 'paste-buffer', 'Enter'])
  expect(run.deps.deliveries.settled).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'native-two', state: 'delivered' })
  run.input.nativeInput!.close()
})

it.each(['before paste', 'before Enter'] as const)('interrupts a message stalled in its worker %s and never resumes its old write', async phase => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  if (phase === 'before paste') run.readScreen.mockImplementationOnce(() => screen.promise)
  else run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  const original = run.write(), cancelled = expect(original).rejects.toThrow('cancelled before completion')
  await flush()
  expect(run.calls).toEqual(phase === 'before paste' ? [] : ['paste-buffer'])
  await expect(run.cancel()).resolves.toMatchObject({ dispatch: 'executed' }); await cancelled
  screen.resolve(await readInlineScreen(run.row, pane)); await flush()
  expect(run.calls).toEqual(phase === 'before paste' ? ['C-c'] : ['paste-buffer', 'C-c'])
  expect(run.promptTyped).toHaveBeenCalledTimes(phase === 'before paste' ? 0 : 1)
})

it('waits for an actual paste to settle before C-c, while revoking its caller immediately', async () => {
  const run = setup(); run.pause('paste-buffer')
  const original = run.write(), cancelled = expect(original).rejects.toThrow('cancelled before completion')
  await flush(); expect(run.calls).toEqual(['paste-buffer'])
  const cancel = run.cancel(); await cancelled; await flush()
  expect(run.calls).toEqual(['paste-buffer'])
  run.finish('paste-buffer'); await cancel; await flush()
  expect(run.calls).toEqual(['paste-buffer', 'C-c'])
})

it('preserves first-conversation binding between paste and Enter, but never grants a later rotation', async () => {
  const run = setup()
  Object.assign(run.row, { sessionId: '', boundAt: null, launch: { state: 'ready' } })
  const ticket = run.terminal.writeTicket('session')
  run.onCommand(command => {
    if (command === 'paste-buffer') Object.assign(run.row, { sessionId: 'first', boundAt: 2, launch: undefined })
  })
  await expect(run.write()).resolves.toMatchObject({ dispatch: 'executed' })
  expect(run.calls).toEqual(['paste-buffer', 'Enter'])
  expect(ticket.allowed()).toBe(true)
  Object.assign(run.row, { sessionId: 'second', boundAt: 3 })
  expect(ticket.allowed()).toBe(false)
  const count = run.calls.length
  await expect(ticket.dispatch(async () => { run.calls.push('stale') })).rejects.toThrow('terminal control revoked')
  expect(run.calls).toHaveLength(count)
})

it.each(['conversation', 'runtime'] as const)('refuses a literal when its %s changes during buffer loading', async change => {
  const run = setup(); run.pause('load-buffer')
  const typed = run.terminal.typeTerminal('agent', 'filter'); await flush()
  if (change === 'conversation') run.row.sessionId = 'replacement'
  else run.row.runtimes = [{ backend: 'tmux', paneId: '%2' }]
  run.finish('load-buffer'); await expect(typed).resolves.toBe(false)
  expect(run.calls).toEqual(['delete-buffer'])
})

it('cannot use or release a replaced pinned scope after its delayed literal resumes', async () => {
  const run = setup(), releaseA = run.terminal.pinTerminalControl('session')!
  run.pause('load-buffer')
  const typed = run.terminal.typeTerminal('agent', 'filter'); await flush()
  releaseA(); const releaseB = run.terminal.pinTerminalControl('agent')!
  run.finish('load-buffer'); await expect(typed).resolves.toBe(false)
  releaseA()
  expect(run.terminal.pinnedControls.has('agent')).toBe(true)
  await expect(run.terminal.keyTerminal('session', 'Enter')).resolves.toBe(true)
  expect(run.calls).toEqual(['delete-buffer', 'Enter'])
  releaseB()
})

it('cannot regain a pinned sequence ticket after Cancel', async () => {
  const run = setup(), release = run.terminal.pinTerminalControl('session')!
  await run.cancel()
  await expect(run.terminal.typeTerminal('agent', 'filter')).resolves.toBe(false)
  await expect(run.terminal.keyTerminal('session', 'Enter')).resolves.toBe(false)
  expect(run.calls).toEqual(['C-c'])
  release()
})

it.each([3, 4])('checks the interrupt deadline after the final native proof immediately before spawn (check %s)', async expireAt => {
  let clock = 0, checks = 0
  const run = setup({ now: () => clock })
  await expect(run.input.deviceInput.interruptWrite('agent', ticket => run.terminal.interruptTerminalAction('session',
    () => { if (++checks === expireAt) clock = 5000; return true }, ticket))).rejects.toThrow('deadline expired')
  expect(checks).toBe(expireAt)
  expect(run.calls).toEqual([])
})

it('retains original authority for echo cleanup on an externally started Cursor turn', async () => {
  const run = setup(), capture = held<{ state: 'succeeded'; value: string }>()
  run.row.engine = 'cursor'
  run.capture.mockImplementationOnce(() => capture.promise)
  run.input.input.onTurnStarted('agent', 'hello'); await flush()
  await run.cancel()
  capture.resolve({ state: 'succeeded', value: '⠰ Working\n\n→ hello\nAuto' }); await flush()
  expect(run.calls).toEqual(['C-c'])
  run.input.input.forget('agent')
})

it('retains a queued message ticket across Cancel instead of obtaining a new one on drain', async () => {
  const run = setup(), release = run.input.input.acquireControl('agent', { forAnswer: true })!
  run.input.input.submit('agent', 'hello')
  await run.cancel(); release(); await flush()
  expect(run.calls).toEqual(['C-c'])
  expect(run.promptTyped).not.toHaveBeenCalled()
  run.input.input.forget('agent')
})

it.each(['cancelDelivery', 'forget'] as const)('revokes a device message during its worker read through %s', async action => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  run.input.deviceInput.submit('agent', 'hello', 'delivery'); await flush()
  expect(run.readScreen).toHaveBeenCalledTimes(2)
  if (action === 'cancelDelivery') expect(run.input.deviceInput.cancelDelivery('delivery')).toBe(true)
  else run.input.deviceInput.forget('agent')
  expect(run.notifications).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'delivery', state: 'rejected' }))
  const count = run.notifications.mock.calls.length
  screen.resolve(await readInlineScreen(run.row, pane)); await flush()
  expect(run.calls).toEqual([])
  expect(run.promptTyped).not.toHaveBeenCalled()
  expect(run.notifications).toHaveBeenCalledTimes(count)
})

it.each(['inactive', 'runtime', 'hold', 'revision', 'unbound', 'first-bind-runtime'] as const)(
  'cannot launder a changed %s through an initial launch while its buffer loads', async change => {
    const run = setup()
    Object.assign(run.row, { sessionId: '', boundAt: null, launch: { state: 'ready' } })
    run.pause('load-buffer')
    const typed = run.write(); await flush()
    if (change === 'inactive') run.row.active = false
    else if (change === 'runtime') run.row.runtimes = [{ backend: 'tmux', paneId: '%2' }]
    else if (change === 'hold') run.row.identityHold = 'fixture hold'
    else if (change === 'revision') run.row.evidenceRevision = 2
    else if (change === 'unbound') run.row.sessionId = 'not-bound'
    else Object.assign(run.row, { sessionId: 'first', boundAt: 2, runtimes: [{ backend: 'tmux', paneId: '%2' }] })
    run.finish('load-buffer')
    // Assert the physical boundary before awaiting the result: deliberately
    // broken authority may enter the later worker retry loop instead of settle.
    await flush()
    expect(run.calls).toEqual(['delete-buffer'])
    await expect(typed).resolves.toMatchObject({ dispatch: 'not_started' })
  },
)

it('releases cancelled preparation that rejects, so subsequent device and legacy input can proceed', async () => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  run.input.deviceInput.submit('agent', 'old', 'old'); await flush()
  expect(run.input.deviceInput.cancelDelivery('old')).toBe(true)
  const count = run.notifications.mock.calls.length
  screen.reject(Error('worker disconnected')); await flush()
  expect(run.calls).toEqual([])
  expect(run.notifications).toHaveBeenCalledTimes(count)
  run.input.deviceInput.submit('agent', 'next', 'next'); await flush()
  expect(run.calls).toEqual(['paste-buffer', 'Enter'])
  run.input.deviceInput.onTurnStarted('agent', 'next')
  await run.input.deviceInput.legacyWrite('agent', ticket => run.terminal.keyTerminalAction('agent', 'Escape', ticket.allowed, ticket))
  expect(run.calls).toEqual(['paste-buffer', 'Enter', 'Escape'])
  run.input.deviceInput.forget('agent')
})
