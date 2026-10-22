import { expect, it, vi } from 'vitest'
import type { TerminalBackend } from './terminalBackend.js'
import { createTerminalBackendRecovery } from './terminalBackendRecovery.js'

function setup() {
  const prepare = vi.fn<TerminalBackend['prepare']>().mockResolvedValue({ state: 'ready' })
  const backend = { name: 'tmux', prepare } as unknown as TerminalBackend
  const deps = { backend: backend as TerminalBackend | null, available: vi.fn(() => true),
    ownedPanes: vi.fn(() => new Map()), recovered: vi.fn() }
  return { deps, backend, prepare }
}

it('does no preparation without a configured backend or a newly discoverable executable', async () => {
  const { deps, prepare } = setup()
  deps.backend = null
  expect(await createTerminalBackendRecovery(deps)()).toBeNull()
  expect(deps.available).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  const fixture = setup()
  fixture.deps.available.mockReturnValue(false)
  expect(await createTerminalBackendRecovery(fixture.deps)()).toBeNull()
  expect(fixture.prepare).not.toHaveBeenCalled()
})

it('shares one recovery, registers before returning, and reuses the recovered backend', async () => {
  const { deps, prepare, backend } = setup()
  let finish!: (value: { state: 'ready' }) => void
  prepare.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const recover = createTerminalBackendRecovery(deps)
  const first = recover(), second = recover()
  expect(second).toBe(first)
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ ownedPanes: deps.ownedPanes.mock.results[0].value })
  expect(deps.recovered).not.toHaveBeenCalled()
  finish({ state: 'ready' })
  expect(await first).toBe(backend)
  expect(deps.recovered).toHaveBeenCalledExactlyOnceWith(backend)
  expect(await recover()).toBe(backend)
  expect(prepare).toHaveBeenCalledOnce()
  expect(deps.available).toHaveBeenCalledOnce()
})

it('tries again after an unavailable result instead of caching another absence', async () => {
  const { deps, prepare, backend } = setup()
  prepare.mockResolvedValueOnce({ state: 'unavailable', code: 'TMUX_UNAVAILABLE', reason: 'not ready' })
  const recover = createTerminalBackendRecovery(deps)
  expect(await recover()).toBeNull()
  expect(deps.recovered).not.toHaveBeenCalled()
  expect(await recover()).toBe(backend)
})

it.each([new Error('not ready'), 'not ready'])('contains a preparation exception and permits a later retry: %s', async error => {
  const { deps, prepare, backend } = setup()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  prepare.mockRejectedValueOnce(error)
  try {
    const recover = createTerminalBackendRecovery(deps)
    expect(await recover()).toBeNull()
    expect(log).toHaveBeenCalledWith('[terminal] tmux recovery failed: not ready')
    expect(await recover()).toBe(backend)
  } finally { log.mockRestore() }
})
