import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { onView, view } from './api'
import { start } from './main'

vi.mock('./api')
vi.mock('@tauri-apps/api/window')

describe('main', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    document.body.innerHTML = '<div id="app"></div>'
    vi.mocked(onView).mockResolvedValue(() => {})
  })

  it('Escape closes the window', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getCurrentWindow).mockReturnValue({ close } as unknown as Window)
    vi.mocked(view).mockResolvedValue({ screen: 'install', phase: 'failed', lines: ['exit 6'] })
    await start(document.getElementById('app')!)

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(close).toHaveBeenCalled()
  })
})
