import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Forward every export to the real module. These probes observe evaluation, not
// whether a stubbed backend happened to be called; importing core is the caller.
const evaluated = vi.hoisted(() => new Set<string>())
vi.mock('../lib/ptyHost/launch.js', async (original) => {
  evaluated.add('launch')
  return original<typeof import('../lib/ptyHost/launch.js')>()
})
vi.mock('../lib/ptyHost/drain.js', async (original) => {
  evaluated.add('drain')
  return original<typeof import('../lib/ptyHost/drain.js')>()
})
vi.mock('../lib/hostMove/mover.js', async (original) => {
  evaluated.add('mover')
  return original<typeof import('../lib/hostMove/mover.js')>()
})
vi.mock('../lib/windows/guestHostBackend.js', async (original) => {
  evaluated.add('guest')
  return original<typeof import('../lib/windows/guestHostBackend.js')>()
})

beforeEach(() => {
  vi.resetModules()
  evaluated.clear()
  vi.stubEnv('TERMINAL_BACKENDS', 'tmux')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('platform backend loading', () => {
  it('loads the callable core entry without evaluating an unused PTY host or mover, and observes explicit loading', async () => {
    // The standard Vitest setup isolates home, data and runtime before imports.
    // Do not start a daemon: loading its entry must itself leave this door shut.
    const core = await import('./main.js')
    expect(core.runCoreInForeground).toBeTypeOf('function')
    expect.soft([...evaluated].sort()).toEqual([])
    // Positive control in the same module graph: a reset of Vitest's mock cache
    // must not decide whether the evaluation probes can observe a real load.
    const host = await import('./ptyHost.js')
    expect(host.targetHost).toBeTypeOf('function')
    expect(host.ptyHostBackends).toBeTypeOf('function')
    expect(host.HostMover).toBeTypeOf('function')
    expect(host.createGuestHostBackend).toBeTypeOf('function')
    expect([...evaluated].sort()).toEqual(['drain', 'guest', 'launch', 'mover'])
  })
})
