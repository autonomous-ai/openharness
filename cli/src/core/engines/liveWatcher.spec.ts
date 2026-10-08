import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { Watcher } from '../../watcher/watcher.js'
import type { LiveSessionDeps } from './liveSessions.js'
import { createLiveWatcher } from './liveWatcher.js'

const mocks = vi.hoisted(() => ({ factory: vi.fn(), watch: vi.fn() }))
vi.mock('./liveSessions.js', () => ({ createLiveSessions: mocks.factory }))
vi.mock('chokidar', () => ({ default: { watch: mocks.watch } }))

function setup() {
  const local = { on: vi.fn(), start: vi.fn(), stop: vi.fn(async () => {}), addSession: vi.fn(async () => {}),
    removeSession: vi.fn(async () => {}), hold: vi.fn(async () => null), tails: vi.fn(() => false),
    setTail: vi.fn(), pollSession: vi.fn(async () => {}), pollAll: vi.fn(async () => {}) }
  const live = { stop: vi.fn(async () => {}), follow: vi.fn(async () => {}), changed: vi.fn(),
    removeSession: vi.fn(async () => {}), hold: vi.fn(async () => null), tails: vi.fn(() => false),
    setTail: vi.fn(), pollSession: vi.fn(async () => {}), pollAll: vi.fn(async () => {}) }
  const events = new Map<string, (path: string) => void>()
  const signals = { add: vi.fn(), unwatch: vi.fn(async () => {}), close: vi.fn(async () => {}),
    on: vi.fn((name, handler) => { events.set(name, handler); return signals }) }
  const session = { sessionId: 's', engine: 'claude', transcriptPath: '/private/transcript' } as RegisteredSession
  const bySession = vi.fn((): RegisteredSession | undefined => session)
  let deps!: LiveSessionDeps
  mocks.factory.mockImplementation((value: LiveSessionDeps) => { deps = value; return live })
  mocks.watch.mockReturnValue(signals)
  const wrapper = createLiveWatcher(local as unknown as Watcher, {
    handles: engine => engine === 'claude', bySession, transport: {} as LiveSessionDeps['transport'],
    frame: vi.fn(), reattach: vi.fn(),
  })
  return { ...wrapper, local, remote: live, signals, events, session, bySession, deps }
}

afterEach(() => vi.clearAllMocks())

describe('live file signals', () => {
  it('tracks paths before and after starting, forwards file signals and closes both watchers', async () => {
    const p = setup()
    await p.watcher.stop()
    p.deps.watch('/before'); p.deps.watch('/removed'); p.deps.unwatch('/removed')
    p.watcher.start(); p.watcher.start()
    expect(mocks.watch).toHaveBeenCalledExactlyOnceWith(['/before'], { ignoreInitial: true })
    p.deps.watch('/after'); p.deps.unwatch('/before')
    expect(p.signals.add).toHaveBeenCalledWith('/after')
    expect(p.signals.unwatch).toHaveBeenCalledWith('/before')
    for (const name of ['add', 'change', 'unlink']) p.events.get(name)!('/after')
    expect(p.remote.changed.mock.calls).toEqual([['/after'], ['/after'], ['/after']])
    await p.watcher.stop()
    expect(p.signals.close).toHaveBeenCalledOnce()
    expect(p.remote.stop).toHaveBeenCalledTimes(2)
    p.watcher.start()
    expect(mocks.watch).toHaveBeenLastCalledWith(['/after'], { ignoreInitial: true })
    await p.watcher.stop()
  })

  it('routes only the current isolated binding to the worker, preserving legacy tails and event listeners', async () => {
    const p = setup(), options = { fromStart: true }
    const observed = vi.fn()
    p.watcher.on('line', observed)
    expect(p.local.on).toHaveBeenCalledWith('line', observed)
    const legacy = { ...p.session, engine: 'pi' as const, transcriptPath: '/private/legacy' }
    await p.watcher.addSession(legacy, options)
    expect(p.local.addSession).toHaveBeenCalledWith(legacy, options)
    await p.watcher.addSession({ ...p.session, transcriptPath: '/private/transcript' }, options)
    expect(p.local.removeSession).toHaveBeenCalledWith('s')
    expect(p.remote.follow).toHaveBeenCalledExactlyOnceWith(p.session)
    p.bySession.mockReturnValue({ ...p.session, transcriptPath: '/another' })
    await p.watcher.addSession({ ...p.session, transcriptPath: '/private/transcript' })
    p.bySession.mockReturnValue(undefined)
    await p.watcher.addSession({ ...p.session, transcriptPath: '/private/transcript' })
    expect(p.remote.follow).toHaveBeenCalledOnce()
    await p.watcher.removeSession('s')
    expect(p.remote.removeSession).toHaveBeenCalledWith('s')
  })

  it('routes holds by ownership and drains, resets and polls both mechanisms', async () => {
    const p = setup()
    expect(p.watcher.tails('s', '/path')).toBe(false)
    await p.watcher.hold('s', '/path', 100)
    expect(p.local.hold).toHaveBeenCalledWith('s', '/path', 100)
    p.remote.tails.mockReturnValue(true)
    expect(p.watcher.tails('s', '/path')).toBe(true)
    await p.watcher.hold('s', '/path', 200)
    expect(p.remote.hold).toHaveBeenCalledWith('s', '/path', 200)
    p.watcher.setTail('s', 10)
    expect(p.local.setTail).toHaveBeenCalledWith('s', 10)
    expect(p.remote.setTail).toHaveBeenCalledWith('s', 10)
    await p.watcher.pollSession('s'); await p.watcher.pollAll()
    expect(p.local.pollSession).toHaveBeenCalledWith('s')
    expect(p.remote.pollSession).toHaveBeenCalledWith('s')
    expect(p.local.pollAll).toHaveBeenCalledOnce()
    expect(p.remote.pollAll).toHaveBeenCalledOnce()
  })
})
