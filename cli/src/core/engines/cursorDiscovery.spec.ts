import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { engineNow, loadEngine } from '../../engines/inProcess.js'
import { createCursorDiscovery } from './cursorDiscovery.js'

const made = vi.hoisted(() => ({ discoveries: [] as unknown[] }))
vi.mock('../../engines/cursor/discovery.js', () => ({
  CursorTranscriptDiscovery: class {
    readonly args: unknown[]
    start = vi.fn(async () => {})
    add = vi.fn(async () => {})
    remove = vi.fn()
    stop = vi.fn(async () => {})
    constructor(...args: unknown[]) { this.args = args; made.discoveries.push(this) }
  },
  findCursorTranscript: vi.fn(),
}))
// Cursor's code is loaded by its session's attach before that attach hands the session here; a test may say it
// could not be, or that it is not loaded at all.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, engineNow: vi.fn(actual.engineNow) }
})
beforeAll(async () => { await loadEngine('cursor') })

type Discovery = { args: unknown[]; start: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
const built = () => made.discoveries as Discovery[]

describe('Cursor\'s transcript discovery', () => {
  afterEach(() => { made.discoveries.length = 0; vi.clearAllMocks() })

  it('builds nothing, and loads nothing, until an attach hands it a Cursor session', async () => {
    const discovery = createCursorDiscovery('/cursor/data', vi.fn())
    await discovery.start()
    discovery.remove('s1')
    await discovery.stop()
    expect(built()).toEqual([])
    expect(engineNow).not.toHaveBeenCalled()
  })

  it('looks in the data folder named at the start, with the core\'s callback, once loaded', async () => {
    const onFound = vi.fn()
    const discovery = createCursorDiscovery('/cursor/data', onFound)
    await discovery.start()
    await discovery.add('s1')
    const [one] = built()
    expect(one.args).toEqual(['/cursor/data', onFound])
    // Started as the core started it, before the session it was built for.
    expect(one.start).toHaveBeenCalledOnce()
    expect(one.start.mock.invocationCallOrder[0]).toBeLessThan(one.add.mock.invocationCallOrder[0])
    expect(one.add).toHaveBeenCalledWith('s1')
    await discovery.add('s2')
    discovery.remove('s1')
    await discovery.stop()
    expect(built()).toHaveLength(1)
    expect(one.add).toHaveBeenLastCalledWith('s2')
    expect(one.remove).toHaveBeenCalledWith('s1')
    expect(one.stop).toHaveBeenCalledOnce()
  })

  it('builds stopped when the core has not started it, and starts with the core', async () => {
    const discovery = createCursorDiscovery('/cursor/data', vi.fn())
    await discovery.add('s1')
    const [one] = built()
    expect(one.start).not.toHaveBeenCalled()
    await discovery.start()
    expect(one.start).toHaveBeenCalledOnce()
    // A stop, then a session: built already, so nothing is started again until the core does.
    await discovery.stop()
    await discovery.add('s2')
    expect(one.start).toHaveBeenCalledOnce()
  })

  it('looks for nothing when Cursor\'s code could not be loaded', async () => {
    vi.mocked(engineNow).mockReturnValueOnce(null)
    const discovery = createCursorDiscovery('/cursor/data', vi.fn())
    await discovery.start()
    await expect(discovery.add('s1')).resolves.toBeUndefined()
    expect(built()).toEqual([])
    expect(engineNow).toHaveBeenCalledWith('cursor', 'a session\'s transcript was looked for')
  })
})
