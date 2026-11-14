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

  it('sign-in: offer, browser, done', async () => {
    await mount(at('sign_in', 'offer'))
    expect(heading()).toBe('Sign in')
    expect(text()).toContain('Add your other computers to the dial.')
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

  it('Claude Code: Turn on, Not now, a failure', async () => {
    await mount(at('claude', 'offer'))
    expect(heading()).toBe('Claude Code')
    expect(text()).toContain("The dial speaks Claude Code's answers and asks its approvals.")
    expect(text()).toContain("Harness adds hooks to Claude Code's settings.")
    expect(buttons()).toEqual(['Not now', 'Turn on'])
    click('Turn on')
    expect(act).toHaveBeenCalledWith('turn_on')

    push(at('claude', 'working'))
    expect(spinner()).not.toBeNull()
    expect(buttons()).toEqual([])

    push(at('claude', 'failed', ['Claude Code is too old.']))
    expect(text()).toContain('Claude Code is too old.')
    expect(buttons()).toEqual(['Retry'])
    click('Retry')
    expect(act).toHaveBeenLastCalledWith('retry')

    push(at('claude', 'offer'))
    click('Not now')
    expect(act).toHaveBeenLastCalledWith('not_now')
  })

  it('outside text is drawn as text', async () => {
    const outside = '<img src=x onerror=alert(1)>'
    await mount(at('install', 'failed', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)

    push(at('sign_in', 'browser', [outside]))
    expect(page().querySelector('img')).toBeNull()
    expect(text()).toContain(outside)

    push(at('claude', 'failed', [outside]))
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

    push(at('claude', 'failed', ['Claude Code is too old.']))
    expect(alert()).toBe('Claude Code is too old.')
    expect(described()).toBe('Claude Code is too old.')

    push(at('claude', 'offer'))
    expect(alert()).toBeNull()
    expect(described()).toBe("The dial speaks Claude Code's answers and asks its approvals. Harness adds hooks to Claude Code's settings.")
  })

  it('the primary button has the focus, and no other', async () => {
    await mount(at('sign_in', 'offer'))
    expect(document.activeElement?.textContent).toBe('Sign in')

    push(at('claude', 'offer'))
    expect(document.activeElement?.textContent).toBe('Turn on')

    // The window comes up while the person types in the browser: Return must not cancel the sign-in.
    push(at('sign_in', 'working'))
    expect(document.activeElement?.textContent).not.toBe('Cancel')
    push(at('sign_in', 'browser', ['Harness is finishing an update']))
    expect(document.activeElement?.textContent).not.toBe('Cancel')
  })
})
