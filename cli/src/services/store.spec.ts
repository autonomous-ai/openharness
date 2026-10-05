import { describe, expect, it, vi } from 'vitest'
import type { DshInstallProgress } from '../dsh/install.js'
import { fakeCore } from '../testing/fakeCore.js'
import { STORE_REQUESTS, startStore, type StoreDeps } from './store.js'

const ASKER = { local: true, owner: true }

function setup(over: Partial<StoreDeps> = {}) {
  const deps: StoreDeps = {
    refresh: vi.fn(async () => [{ id: 'acme/thing' }] as never),
    rows: vi.fn((_installed, catalog) => (catalog ?? []).map((entry: { id: string }) => ({ id: entry.id, installed: false }))),
    remove: vi.fn(() => ({ ok: true as const })),
    mutate: vi.fn(async ({ id }: { id?: string }) => ({ ok: true as const, id: id ?? 'acme/from-url' })),
    ...over,
  }
  const core = fakeCore()
  return { core, deps, requests: startStore(core, deps) }
}

describe('the store service', () => {
  it('answers exactly the requests it declares', () => {
    expect(Object.keys(setup().requests).sort()).toEqual([...STORE_REQUESTS].sort())
    // Started as the daemon starts it, with the real catalog and installs behind it.
    expect(Object.keys(startStore(fakeCore())).sort()).toEqual([...STORE_REQUESTS].sort())
  })

  it('dsh_list: the rows for the catalog it refreshed, or what went wrong reading it', async () => {
    const { requests, deps } = setup()
    expect(await requests.dsh_list({}, ASKER)).toEqual({ dsh: [{ id: 'acme/thing', installed: false }] })
    expect(deps.rows).toHaveBeenCalledWith(undefined, [{ id: 'acme/thing' }])
    vi.mocked(deps.refresh).mockRejectedValueOnce(new Error('registry unreadable'))
    expect(await requests.dsh_list({}, ASKER)).toEqual({ error: 'INTERNAL', detail: 'registry unreadable' })
    vi.mocked(deps.refresh).mockRejectedValueOnce('offline')
    expect(await requests.dsh_list({}, ASKER)).toEqual({ error: 'INTERNAL', detail: 'offline' })
  })

  it('dsh_remove: uninstalls a well-formed id and says what happened; refuses any other before removing anything', async () => {
    const { requests, deps } = setup()
    expect(await requests.dsh_remove({ id: 'acme/thing' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    vi.mocked(deps.remove).mockReturnValueOnce({ ok: false, error: 'NOT_INSTALLED', detail: 'acme/none is not installed' })
    expect(await requests.dsh_remove({ id: 'acme/none' }, ASKER)).toEqual({ error: 'NOT_INSTALLED', detail: 'acme/none is not installed' })
    expect(await requests.dsh_remove({ id: '../../etc' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_remove needs an id' })
    expect(await requests.dsh_remove({}, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_remove needs an id' })
    expect(deps.remove).toHaveBeenCalledTimes(2)
  })

  it('dsh_update: updates a well-formed id, pushing its progress under that id, and says how it ended', async () => {
    const progressed: DshInstallProgress[] = [{ id: null, phase: 'clone' } as DshInstallProgress, { id: 'acme/thing', phase: 'done' } as DshInstallProgress]
    const { requests, deps, core } = setup({
      mutate: vi.fn(async (_input, progress) => { for (const p of progressed) progress(p); return { ok: true as const, id: 'acme/thing' } }),
    })
    expect(await requests.dsh_update({ id: 'acme/thing', url: 'ignored' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    expect(deps.mutate).toHaveBeenCalledWith({ id: 'acme/thing', update: true }, expect.any(Function))
    expect(vi.mocked(core.clients.dshInstallStatus).mock.calls).toEqual([[{ id: 'acme/thing', phase: 'clone' }], [{ id: 'acme/thing', phase: 'done' }]])
    vi.mocked(deps.mutate).mockResolvedValueOnce({ ok: false, error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    expect(await requests.dsh_update({ id: 'acme/thing' }, ASKER)).toEqual({ error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    vi.mocked(deps.mutate).mockRejectedValueOnce(new Error('disk full'))
    expect(await requests.dsh_update({ id: 'acme/thing' }, ASKER)).toEqual({ error: 'INTERNAL', detail: 'disk full' })
    expect(await requests.dsh_update({ id: '../../etc' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_update needs an id' })
    expect(deps.mutate).toHaveBeenCalledTimes(3)
  })

  it('dsh_install: installs what a usable id or url names, pushing each phase under the id asked for', async () => {
    const { requests, deps, core } = setup({
      mutate: vi.fn(async (_input, progress) => { progress({ id: null, phase: 'clone', detail: 'cloning' } as DshInstallProgress); return { ok: true as const, id: 'acme/thing' } }),
    })
    expect(await requests.dsh_install({ id: 'acme/thing', ref: 'v2' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    expect(deps.mutate).toHaveBeenCalledWith({ id: 'acme/thing', url: undefined, ref: 'v2' }, expect.any(Function))
    expect(core.clients.dshInstallStatus).toHaveBeenCalledWith({ id: 'acme/thing', phase: 'clone', detail: 'cloning' })
    vi.mocked(deps.mutate).mockResolvedValueOnce({ ok: false, error: 'SETUP_FAILED', detail: 'setup exited 1' })
    expect(await requests.dsh_install({ url: 'https://example.com/thing.git' }, ASKER)).toEqual({ error: 'SETUP_FAILED', detail: 'setup exited 1' })
    vi.mocked(deps.mutate).mockRejectedValueOnce('not an Error')
    expect(await requests.dsh_install({ url: 'https://example.com/thing.git' }, ASKER)).toEqual({ error: 'INTERNAL', detail: 'not an Error' })
    expect(await requests.dsh_install({ id: '../../etc', url: 'https://example.com/\n' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_install needs an id or a url' })
    expect(deps.mutate).toHaveBeenCalledTimes(3)
  })
})
