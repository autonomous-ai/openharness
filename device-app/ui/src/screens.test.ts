import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, onView, view, type Phase, type Screen, type View } from './api'
import { start } from './main'

vi.mock('./api')

let push: (view: View | null) => void = () => {}

function at(screen: Screen, phase: Phase, lines: string[] = []): View {
  return { screen, phase, lines }
}

async function mount(first: View | null): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>'
  vi.mocked(view).mockResolvedValue(first)
  vi.mocked(onView).mockImplementation(async (listener) => {
    push = listener
    return () => {}
  })
  await start(document.getElementById('app')!)
}

const page = () => document.getElementById('app')!
const heading = () => page().querySelector('h1')?.textContent ?? null
const text = () => page().textContent ?? ''
const buttons = () => [...page().querySelectorAll('button')].map((b) => b.textContent)
const spinner = () => page().querySelector('[role="status"]')

function click(label: string): void {
  const button = [...page().querySelectorAll('button')].find((b) => b.textContent === label)
  if (!button) throw new Error(`no button ${label}: ${buttons().join(', ')}`)
  button.click()
}

describe('screens', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(act).mockResolvedValue(undefined)
  })

  it('install: progress, then failure, then Retry', async () => {
    await mount(at('install', 'working'))
    expect(heading()).toBe('Setting up Harness')
    expect(spinner()).not.toBeNull()
    expect(buttons()).toEqual([])

    push(at('install', 'failed', ['curl: (6) Could not resolve host', 'exit 6']))
    expect(text()).toContain('curl: (6) Could not resolve host')
    expect(text()).toContain('exit 6')
    expect(spinner()).toBeNull()
    expect(buttons()).toEqual(['Retry'])
    click('Retry')
    expect(act).toHaveBeenCalledWith('retry')

    push(at('install', 'working'))
    expect(spinner()).not.toBeNull()
    expect(buttons()).toEqual([])
  })

  it('install: the step under the spinner', async () => {
    const step = () => page().querySelector('.body.muted')?.textContent ?? null
    await mount(at('install', 'working', ['Installing tmux…']))
    expect(spinner()).not.toBeNull()
    expect(step()).toBe('Installing tmux…')

    push(at('install', 'working', ['Downloading Harness…', 'a second line']))
    expect(step()).toBe('Downloading Harness…')
    expect(text()).not.toContain('a second line')

    push(at('install', 'working'))
    expect(spinner()).not.toBeNull()
    expect(page().querySelectorAll('.content > *')).toHaveLength(2)
  })

  it('install: the spinner is named by the heading and the step', async () => {
    // The text of each element the spinner's aria-labelledby names, as a screen reader reads it.
    const name = () =>
      (spinner()?.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ')
    await mount(at('install', 'working', ['Installing tmux…']))
    expect(name()).toBe('Setting up Harness Installing tmux…')

    push(at('install', 'working'))
    expect(name()).toBe('Setting up Harness')
  })

  it('sign-in: offer, browser, done', async () => {
    await mount(at('sign_in', 'offer'))
    expect(heading()).toBe('Sign in')
    expect(text()).toContain('Add your other computers to your device.')
    expect(buttons()).toEqual(['Later', 'Sign in'])
    click('Sign in')
    expect(act).toHaveBeenCalledWith('sign_in')

    push(at('sign_in', 'working'))
    expect(spinner()).not.toBeNull()
    expect(buttons()).toEqual(['Cancel'])

    push(at('sign_in', 'browser', ['Harness is finishing an update']))
    expect(heading()).toBe('Finish in your browser')
    expect(text()).toContain('Harness is finishing an update')
    expect(buttons()).toEqual(['Cancel'])
    click('Cancel')
    expect(act).toHaveBeenCalledWith('cancel')

    push(null)
    expect(page().childNodes).toHaveLength(0)
  })

  it('sign-in: Later, and a failure', async () => {
    await mount(at('sign_in', 'offer'))
    click('Later')
    expect(act).toHaveBeenCalledWith('later')

    push(at('sign_in', 'failed', ['fetch failed']))
    expect(heading()).toBe('Sign in')
    expect(text()).toContain('fetch failed')
    expect(buttons()).toEqual(['Retry'])
    click('Retry')
    expect(act).toHaveBeenCalledWith('retry')
  })

  it('a screen Rust no longer sends draws nothing', async () => {
    await mount(at('sign_in', 'offer'))
    for (const screen of ['claude', 'codex']) {
      push(at(screen as Screen, 'offer'))
      expect(page().childNodes).toHaveLength(0)
    }
  })

  it('the install shows its last four lines; a note or an error shows its first', async () => {
    await mount(at('install', 'failed', ['1', '2', '3', '4', '5', '6']))
    expect([...page().querySelectorAll('.output .line')].map((line) => line.textContent)).toEqual(['3', '4', '5', '6'])

    push(at('sign_in', 'browser', ['first', 'second']))
    expect(text()).toContain('first')
    expect(text()).not.toContain('second')

    push(at('sign_in', 'failed', ['first', 'second']))
    expect(text()).toContain('first')
    expect(text()).not.toContain('second')
  })

  it('the primary button is the one the contract names', async () => {
    const primary = () => page().querySelector('.primary')?.textContent ?? null
    const table: [Screen, Phase, string | null][] = [
      ['install', 'working', null],
      ['install', 'failed', null],
      ['sign_in', 'offer', 'Sign in'],
      ['sign_in', 'working', null],
      ['sign_in', 'browser', null],
      ['sign_in', 'failed', 'Retry'],
    ]
    await mount(null)
    for (const [screen, phase, label] of table) {
      push(at(screen, phase, ['a line']))
      expect([screen, phase, primary()]).toEqual([screen, phase, label])
    }
  })

  it('outside text is drawn as text', async () => {
    const outside = '<img src=x onerror=alert(1)>'
    await mount(at('install', 'failed', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)

    push(at('sign_in', 'browser', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)

    push(at('sign_in', 'failed', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)

    push(at('install', 'working', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)
  })

  it('a screen reader hears a failure, and what the focused button answers', async () => {
    const alert = () => page().querySelector('[role="alert"]')?.textContent ?? null
    const described = () =>
      (document.activeElement?.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ')

    await mount(at('install', 'failed', ['curl: (6) Could not resolve host', 'exit 6']))
    expect(alert()).toContain('curl: (6) Could not resolve host')
    expect(alert()).toContain('exit 6')

    push(at('sign_in', 'failed', ['Sign-in did not finish.']))
    expect(alert()).toBe('Sign-in did not finish.')
    expect(described()).toBe('Sign-in did not finish.')

    push(at('sign_in', 'offer'))
    expect(alert()).toBeNull()
    expect(described()).toBe('Add your other computers to your device.')
  })

  it('the primary button has the focus on every screen that has one, and no other button', async () => {
    await mount(at('sign_in', 'offer'))
    expect(document.activeElement?.textContent).toBe('Sign in')

    push(at('sign_in', 'failed', ['Sign-in did not finish.']))
    expect(document.activeElement?.textContent).toBe('Retry')

    // The window comes up while the person types in the browser: Return must not cancel the sign-in.
    push(at('sign_in', 'working'))
    expect(document.activeElement?.textContent).not.toBe('Cancel')
    push(at('sign_in', 'browser', ['Harness is finishing an update']))
    expect(document.activeElement?.textContent).not.toBe('Cancel')
  })
})
