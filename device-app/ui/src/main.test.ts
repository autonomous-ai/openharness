import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { onView, view, type View } from './api'
import { start } from './main'

vi.mock('./api')
vi.mock('@tauri-apps/api/window')

describe('main', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    document.body.innerHTML = '<div id="app"></div>'
    vi.mocked(onView).mockResolvedValue(() => {})
  })

  it('a view event that comes before view() answers wins over the answer', async () => {
    let push: (next: View | null) => void = () => {}
    vi.mocked(onView).mockImplementation(async (listener) => {
      push = listener
      return () => {}
    })
    let answer: (older: View | null) => void = () => {}
    vi.mocked(view).mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const started = start(document.getElementById('app')!)
    await vi.waitFor(() => expect(view).toHaveBeenCalled())

    push({ screen: 'sign_in', phase: 'browser', lines: [] })
    answer({ screen: 'sign_in', phase: 'offer', lines: [] })
    await started
    expect(document.querySelector('h1')?.textContent).toBe('Finish in your browser')
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
