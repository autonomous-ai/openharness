import { afterEach, expect, it, vi } from 'vitest'
import { createHomeAdoptions, type HomeAdoptionDeps } from './homeAdoptions.js'

const controllers: Array<ReturnType<typeof createHomeAdoptions>> = []
function setup(overrides: Partial<HomeAdoptionDeps> = {}) {
  vi.useFakeTimers()
  const deps = {
    read: vi.fn(() => ({ claude: [], codex: [] })),
    confirm: vi.fn(() => ({ claude: null, codex: null })),
    install: vi.fn(), held: vi.fn(), ...overrides,
  }
  const controller = createHomeAdoptions(deps)
  controllers.push(controller)
  return { ...controller, deps }
}
afterEach(() => { controllers.splice(0).forEach(value => value.close()); vi.useRealTimers() })

it('installs fresh saved homes and every confirmed request once, including another writer’s idempotent win', () => {
  const c = setup({ read: vi.fn(() => ({ claude: ['/previous'], codex: [] })),
    confirm: vi.fn(() => ({ claude: '/previous', codex: '/already-committed' })) })
  c.submit({ CODEX_HOME: '/already-committed' })
  c.submit({ CODEX_HOME: '/already-committed' })
  expect(c.deps.read).toHaveBeenCalledTimes(2)
  expect(vi.mocked(c.deps.install).mock.calls).toEqual([['claude', '/previous'], ['codex', '/already-committed']])
  expect(c.deps.held).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('returns while storage is unavailable, reports its reason once, and retries until both confirmations recover', async () => {
  let readable = false, writable = false
  const c = setup({ read: vi.fn(() => {
    if (!readable) throw new Error('catalog unavailable')
    return { claude: ['/saved'], codex: [] }
  }), confirm: vi.fn(() => {
    if (!writable) throw new Error('durability unavailable')
    return { claude: null, codex: '/requested' }
  }) })
  c.submit({ CODEX_HOME: '/requested' })
  expect(c.deps.install).not.toHaveBeenCalled()
  expect(vi.mocked(c.deps.held).mock.calls).toEqual([['durability unavailable']])
  c.submit({ CODEX_HOME: '/requested' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(c.deps.held).toHaveBeenCalledTimes(1)
  readable = true
  await vi.advanceTimersByTimeAsync(1_000)
  expect(c.deps.install).toHaveBeenCalledWith('claude', '/saved')
  expect(c.deps.held).toHaveBeenLastCalledWith('durability unavailable')
  writable = true
  await vi.advanceTimersByTimeAsync(1_000)
  expect(c.deps.install).toHaveBeenLastCalledWith('codex', '/requested')
  expect(c.deps.held).toHaveBeenLastCalledWith(null)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains only declared home variables and snapshots them before retry', async () => {
  const confirm = vi.fn<HomeAdoptionDeps['confirm']>().mockImplementationOnce(() => { throw 'held' })
    .mockReturnValue({ claude: '/c', codex: '/d' })
  const c = setup({ confirm })
  const environment = { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/d', SECRET: 'must not be retained' }
  c.submit(environment)
  environment.CODEX_HOME = '/changed'
  await vi.advanceTimersByTimeAsync(1_000)
  expect(confirm.mock.calls).toEqual([[{ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/d' }], [{ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/d' }]])
  expect(vi.mocked(c.deps.held).mock.calls).toEqual([['held'], [null]])
})

it('retains hook installation independently of adoption, without blocking another home', async () => {
  const install = vi.fn<HomeAdoptionDeps['install']>().mockImplementationOnce(() => { throw new Error('settings unavailable') })
  const c = setup({ confirm: vi.fn(() => ({ claude: '/c', codex: '/d' })), install })
  c.submit({})
  expect(install.mock.calls).toEqual([['claude', '/c'], ['codex', '/d']])
  expect(c.deps.held).toHaveBeenCalledWith('settings unavailable')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(c.deps.confirm).toHaveBeenCalledTimes(1)
  expect(install.mock.calls).toEqual([['claude', '/c'], ['codex', '/d'], ['claude', '/c']])
  expect(c.deps.held).toHaveBeenLastCalledWith(null)
})

it('installs a peer home recovered while confirming a later request', () => {
  const read = vi.fn<HomeAdoptionDeps['read']>()
    .mockReturnValueOnce({ claude: [], codex: ['/saved'] })
    .mockReturnValue({ claude: [], codex: ['/saved', '/peer', '/requested'] })
  const c = setup({ read, confirm: vi.fn(() => ({ claude: null, codex: '/requested' })) })
  c.retry()
  c.submit({ CODEX_HOME: '/requested' })
  expect(vi.mocked(c.deps.install).mock.calls).toEqual([['codex', '/saved'], ['codex', '/requested'], ['codex', '/peer']])
})

it('fences queued retries and late login-shell callbacks when the owning daemon closes', async () => {
  const c = setup({ confirm: vi.fn(() => { throw new Error('held') }) })
  c.submit({ CODEX_HOME: '/old' })
  c.close()
  c.submit({ CODEX_HOME: '/late' }); c.retry()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(c.deps.confirm).toHaveBeenCalledTimes(1)
  expect(c.deps.install).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps an asynchronous install pending, lets a sibling complete, and acknowledges only success', async () => {
  let reject!: (error: Error) => void
  const install = vi.fn<HomeAdoptionDeps['install']>()
    .mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
    .mockResolvedValue(undefined)
  const c = setup({ confirm: vi.fn(() => ({ claude: '/slow', codex: '/ready' })), install })
  c.submit({}); c.retry()
  expect(install).toHaveBeenCalledTimes(2)
  expect(c.deps.held).toHaveBeenLastCalledWith('Waiting for hook installation in an adopted home.')
  await vi.advanceTimersByTimeAsync(0)
  c.retry()
  expect(install).toHaveBeenCalledTimes(2)
  reject(new Error('disk unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(c.deps.held).toHaveBeenLastCalledWith('disk unavailable')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(install.mock.calls).toEqual([['claude', '/slow'], ['codex', '/ready'], ['claude', '/slow']])
  expect(c.deps.held).toHaveBeenLastCalledWith(null)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([true, false])('revokes an in-flight home installation and ignores its late success=%s on shutdown', async succeeds => {
  let finish!: () => void
  const c = setup({ read: () => ({ claude: ['/pending'], codex: [] }), install: () => new Promise<void>((done, reject) => {
    finish = () => succeeds ? done() : reject(new Error('late'))
  }) })
  c.retry()
  expect(c.current()).toBe(true)
  const reports = vi.mocked(c.deps.held).mock.calls.length
  c.close(); finish()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(c.current()).toBe(false)
  expect(c.deps.held).toHaveBeenCalledTimes(reports)
  expect(vi.getTimerCount()).toBe(0)
})
