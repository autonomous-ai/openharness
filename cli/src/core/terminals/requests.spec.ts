import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalPaneInfo } from '../../lib/terminalTypes.js'
import { createTerminalRequests, type TerminalRequestDeps } from './requests.js'

/** `terminal_info` and `theme_set`, answered by the core: tmux's word on an agent's pane, read outside
 *  the line, and the desktop's colours, applied whole or not at all. */
const agents = new Map([
  ['a1', { agentId: 'a1', sessionId: 's1', tmuxPane: '%7', runtimes: [{ backend: 'tmux', paneId: '%7' }] }],
  ['pty', { agentId: 'pty', sessionId: 's3', tmuxPane: '%7', runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%7' }] }],
  ['bare', { agentId: 'bare', sessionId: 's2', tmuxPane: '', runtimes: [] }],
]) as unknown as Map<string, RegisteredSession>

function setup(over: Partial<TerminalRequestDeps> = {}) {
  const deps: TerminalRequestDeps = {
    resolve: vi.fn((id: string) => agents.get(id)),
    paneInfo: vi.fn(async () => ({ command: 'zsh', path: '/work/app', pid: 4242, tty: '/dev/ttys004' })),
    applyTheme: vi.fn(),
    ...over,
  }
  const requests = createTerminalRequests(deps)
  const replies: Array<Record<string, unknown>> = []
  const ask = (payload: Record<string, unknown>) => requests.terminalInfo(payload, (result) => { replies.push(result) })
  return { deps, replies, ask, requests }
}

describe('terminal_info', () => {
  it('what an agent\'s pane runs and where, in tmux\'s fields, read outside the connection\'s line', async () => {
    let answer!: (info: TerminalPaneInfo | null) => void
    const { deps, replies, ask } = setup({ paneInfo: vi.fn(() => new Promise<TerminalPaneInfo | null>((resolve) => { answer = resolve })) })
    ask({ agentId: 'a1' })
    expect(deps.paneInfo).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%7' })
    expect(replies).toEqual([])
    answer({ command: 'node', path: '/work/app', pid: 4242, tty: '/dev/ttys004' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toStrictEqual({ command: 'node', path: '/work/app', pid: 4242, tty: '/dev/ttys004' })
    expect(Object.keys(replies[0])).toEqual(['command', 'path', 'pid', 'tty'])
  })

  it('asks a ptyhost row\'s own pane, never a tmux pane of the same id', async () => {
    const { deps, replies, ask } = setup()
    ask({ agentId: 'pty' })
    expect(deps.paneInfo).toHaveBeenCalledExactlyOnceWith({ backend: 'ptyhost', instance: 'p1', paneId: '%7' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
  })

  it('an agent it does not know, or one with no pane, is not found; a pane tmux cannot read is said so', async () => {
    const { deps, replies, ask } = setup({ paneInfo: vi.fn(async () => null) })
    ask({})
    ask({ agentId: 7 })
    ask({ agentId: 'nobody' })
    ask({ agentId: 'bare' })
    expect(deps.resolve).toHaveBeenCalledTimes(2)
    expect(replies).toEqual([{ error: 'AGENT_NOT_FOUND' }, { error: 'AGENT_NOT_FOUND' }, { error: 'AGENT_NOT_FOUND' }, { error: 'AGENT_NOT_FOUND' }])
    ask({ agentId: 'a1' })
    await vi.waitFor(() => expect(replies).toHaveLength(5))
    expect(replies[4]).toStrictEqual({ error: 'PANE_NOT_FOUND' })
  })
})

describe('theme_set', () => {
  it('applies the desktop\'s pair of colours, normalised, and says so', () => {
    const { deps, requests } = setup()
    const reply = requests.themeSet({ requestId: 't-1', background: '#171B29', foreground: '#f5f5f5' })
    expect(reply).toStrictEqual({ applied: true })
    expect(deps.applyTheme).toHaveBeenCalledWith({ background: '#171b29', foreground: '#f5f5f5' })
  })

  it('refuses a malformed pair rather than half-applying it', () => {
    const { deps, requests } = setup()
    expect(requests.themeSet({ background: 'dark' })).toStrictEqual({ error: 'BAD_THEME' })
    expect(deps.applyTheme).not.toHaveBeenCalled()
  })
})
