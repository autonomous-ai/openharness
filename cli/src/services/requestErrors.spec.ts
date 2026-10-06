import { afterEach, describe, expect, it, vi } from 'vitest'
import { internalOnThrow } from './requestErrors.js'

const ASKER = { local: true, owner: true }

describe('a request moved out of the socket\'s switch', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('answers what its handler answers, sync or async, with the payload and asker it was given', async () => {
    const handler = vi.fn((payload: Record<string, unknown>) => ({ echoed: payload.n }))
    expect(await internalOnThrow('t', handler)({ n: 1 }, ASKER)).toEqual({ echoed: 1 })
    expect(handler).toHaveBeenCalledWith({ n: 1 }, ASKER)
    expect(await internalOnThrow('t', async () => ({ later: true }))({}, ASKER)).toEqual({ later: true })
  })

  it('answers a throw or a rejection INTERNAL, as the switch did, and logs it under its type', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('disk full')
    expect(await internalOnThrow('codex_profile_link', () => { throw boom })({}, ASKER)).toEqual({ error: 'INTERNAL' })
    expect(log).toHaveBeenCalledWith('[backend] dispatch codex_profile_link failed:', boom)
    expect(await internalOnThrow('fs_list_dir', async () => { throw boom })({}, ASKER)).toEqual({ error: 'INTERNAL' })
    expect(log).toHaveBeenCalledWith('[backend] dispatch fs_list_dir failed:', boom)
  })
})
