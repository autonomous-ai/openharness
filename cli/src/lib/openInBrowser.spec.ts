import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake `spawn`: no test here ever starts a browser.
const child = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (actual) => ({ ...await actual<typeof import('node:child_process')>(), spawn: child.spawn }))

import { browserCommand, openInBrowser } from './openInBrowser.js'
import { systemProgram } from './windows/powershell.js'

describe('browserCommand', () => {
  it('opens a URL on Windows through rundll32 with the URL as one argument, so cmd never sees its &', () => {
    expect(browserCommand('https://a/?x=1&y=2', 'win32')).toEqual({
      file: systemProgram('rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', 'https://a/?x=1&y=2'],
    })
  })

  it('passes % and ^ through unchanged', () => {
    expect(browserCommand('https://a/?q=%41^b', 'win32')?.args).toEqual(['url.dll,FileProtocolHandler', 'https://a/?q=%41^b'])
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'https://a/ b', 'https://a/"x', "https://a/'x"])('does not open %s', (url) => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) expect(browserCommand(url, platform)).toBeNull()
  })

  it('opens with open on macOS and xdg-open elsewhere', () => {
    expect(browserCommand('https://a/?x=1&y=2', 'darwin')).toEqual({ file: 'open', args: ['https://a/?x=1&y=2'] })
    expect(browserCommand('https://a/?x=1&y=2', 'linux')).toEqual({ file: 'xdg-open', args: ['https://a/?x=1&y=2'] })
  })

  it("opens in Harness OS's own browser when it has one", () => {
    expect(browserCommand('https://a/', 'linux', '/usr/bin/hn-browser')).toEqual({ file: '/usr/bin/hn-browser', args: ['https://a/'] })
  })

  it("never runs a hn-browser off Linux: on Windows its path is a folder of the working folder's drive, which anyone can make", () => {
    expect(browserCommand('https://a/', 'win32', '/usr/bin/hn-browser')).toEqual({ file: systemProgram('rundll32.exe'), args: ['url.dll,FileProtocolHandler', 'https://a/'] })
    expect(browserCommand('https://a/', 'darwin', '/usr/bin/hn-browser')).toEqual({ file: 'open', args: ['https://a/'] })
  })
})

describe('openInBrowser', () => {
  beforeEach(() => {
    child.spawn.mockReset()
    child.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
  })

  it('starts the browser with no shell, in the env it is given', () => {
    const env = { PATH: '/usr/bin' }
    expect(openInBrowser('https://a/?x=1&y=2', env)).toBe(true)
    expect(child.spawn).toHaveBeenCalledTimes(1)
    const [, args, options] = child.spawn.mock.calls[0]
    expect(args).toContain('https://a/?x=1&y=2')
    expect(options).not.toHaveProperty('shell')
    expect(options).toMatchObject({ stdio: 'ignore', env })
  })

  it('starts nothing for a URL it does not open', () => {
    expect(openInBrowser('file:///etc/passwd')).toBe(false)
    expect(child.spawn).not.toHaveBeenCalled()
  })
})
