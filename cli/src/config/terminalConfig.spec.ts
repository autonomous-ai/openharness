import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_TERMINAL_BACKENDS, parseTerminalBackends } from './terminalConfig.js'

afterEach(() => vi.restoreAllMocks())

describe('terminal backend configuration', () => {
  it('watches tmux, and only tmux, when nothing is configured', () => {
    expect(ALL_TERMINAL_BACKENDS).toEqual(['tmux'])
  })

  it('treats an explicit value as a pin', () => {
    expect(parseTerminalBackends('tmux')).toEqual(['tmux'])
  })

  /**
   * A machine that still names the retired herdr backend must keep running. The daemon SELF-UPDATES:
   * refusing to start on a retired name would take down an unattended computer at the moment it picked
   * up a new build, for a setting the user cannot be there to fix. So it is dropped, loudly, not fatal.
   */
  it('drops the retired herdr backend with a warning instead of refusing to start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseTerminalBackends('tmux,herdr')).toEqual(['tmux'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer a supported backend'))
  })

  it('falls back to tmux when herdr was the only backend named', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseTerminalBackends('herdr')).toEqual(['tmux'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to tmux'))
  })

  it.each(['', ' ', 'tmux,', 'tmux,,tmux', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })
})
