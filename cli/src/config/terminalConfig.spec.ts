import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_TERMINAL_BACKENDS, parseTerminalBackends } from './terminalConfig.js'

afterEach(() => vi.restoreAllMocks())

describe('terminal backend configuration', () => {
  it('watches tmux and herdr when nothing is configured', () => {
    expect(ALL_TERMINAL_BACKENDS).toEqual(['tmux', 'herdr'])
  })

  it('treats an explicit value as a pin', () => {
    expect(parseTerminalBackends('tmux')).toEqual(['tmux'])
    expect(parseTerminalBackends('herdr')).toEqual(['herdr'])
    expect(parseTerminalBackends('tmux,herdr')).toEqual(['tmux', 'herdr'])
  })

  it.each(['', ' ', 'tmux,', 'tmux,,tmux', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })
})
