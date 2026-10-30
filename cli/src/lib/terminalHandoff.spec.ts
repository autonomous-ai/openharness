import { describe, expect, it } from 'vitest'
import { handoffAgentId, terminalHandoffRequest } from './terminalHandoff.js'

const tmux = (agentId: string, paneId: string) => ({ agentId, runtimes: [{ backend: 'tmux' as const, paneId }] })
const pty = (agentId: string, instance: string, paneId: string) => ({ agentId, runtimes: [{ backend: 'ptyhost' as const, instance, paneId }] })

describe('the tile `harness remote` was typed in', () => {
  it('is the tmux pane a bare `%N` names, never a pty host pane with the same id', () => {
    expect(handoffAgentId([pty('pty', 'p1', '%3'), tmux('tmux', '%3')], '%3')).toBe('tmux')
    expect(handoffAgentId([pty('pty', 'p1', '%3'), tmux('tmux', '%4')], '%3')).toBeNull()
    expect(handoffAgentId([tmux('tmux', '%4')], '%3')).toBeNull()
    expect(handoffAgentId([], '%3')).toBeNull()
  })

  it('is a pty host pane only by its own `<instance>:%N`', () => {
    const rows = [pty('a', 'p1', '%3'), pty('b', 'p2', '%3'), tmux('tmux', '%3')]
    expect(handoffAgentId(rows, 'p1:%3')).toBe('a')
    expect(handoffAgentId(rows, 'p2:%3')).toBe('b')
    expect(handoffAgentId(rows, 'p3:%3')).toBeNull()
    // A versioned host's, beside the legacy one of its protocol.
    const versioned = [...rows, pty('dev', 'p2-0.4.21-dev.win1', '%7'), pty('hashed', 'p2-h0123456789ab', '%7')]
    expect(handoffAgentId(versioned, 'p2-0.4.21-dev.win1:%7')).toBe('dev')
    expect(handoffAgentId(versioned, 'p2-h0123456789ab:%7')).toBe('hashed')
  })

  it('never by the bare primary pane alone: a row without that runtime is not it', () => {
    expect(handoffAgentId([{ agentId: 'other', tmuxPane: '%3', runtimes: [] } as never], '%3')).toBeNull()
  })

  it('accepts either form on the wire, and nothing else', () => {
    expect(terminalHandoffRequest({ tmuxPane: 'p1:%3', machineId: 'm', agentId: 'a' })).toEqual({ tmuxPane: 'p1:%3', machineId: 'm', agentId: 'a' })
    for (const pane of ['p2-0.4.21-dev.win1:%7', 'p2-h0123456789ab:%7']) expect(terminalHandoffRequest({ tmuxPane: pane, machineId: 'm', agentId: 'a' })?.tmuxPane).toBe(pane)
    for (const pane of ['p1:3', 'x1:%3', 'p1:%', ':%3', 'p12345:%3', 'p2-:%3', 'p2-a/b:%3']) expect(terminalHandoffRequest({ tmuxPane: pane, machineId: 'm', agentId: 'a' })).toBeNull()
  })
})
