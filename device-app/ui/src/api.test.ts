import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { act, onView, view, type View } from './api'

vi.mock('@tauri-apps/api/core')
vi.mock('@tauri-apps/api/event')

const signIn: View = { screen: 'sign_in', phase: 'offer', lines: [] }

describe('api', () => {
  beforeEach(() => vi.resetAllMocks())

  it('asks Rust for the view and returns its answer', async () => {
    vi.mocked(invoke).mockResolvedValue(signIn)
    await expect(view()).resolves.toEqual(signIn)
    expect(invoke).toHaveBeenCalledWith('view')
  })

  it('sends an action by its name', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await act('not_now')
    expect(invoke).toHaveBeenCalledWith('act', { action: 'not_now' })
  })

  it('hands each view event its payload and resolves to the unlisten function', async () => {
    const unlisten = vi.fn()
    vi.mocked(listen).mockResolvedValue(unlisten)
    const listener = vi.fn()
    await expect(onView(listener)).resolves.toBe(unlisten)
    expect(listen).toHaveBeenCalledWith('view', expect.any(Function))
    const handler = vi.mocked(listen).mock.calls[0][1]
    handler({ event: 'view', id: 1, payload: signIn })
    handler({ event: 'view', id: 2, payload: null })
    expect(listener.mock.calls).toEqual([[signIn], [null]])
  })
})
