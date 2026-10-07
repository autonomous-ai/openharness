import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerShellQuery } from './shellQueries.js'

describe('the shell service core queries', () => {
  it('accepts only literal bounded argv and an absolute folder before opening a pane', async () => {
    const core = fakeCore({ terminals: { open: vi.fn(async () => ({ ok: true as const, agentId: 'new' })) } })
    const request = { argv: ['/bin/zsh', 'a; b', '$(touch nope)', ''], cwd: '/work' }
    expect(await answerShellQuery(core, 'open', request)).toEqual({ ok: true as const, agentId: 'new' })
    expect(core.terminals.open).toHaveBeenCalledWith(request)
    expect(vi.mocked(core.terminals.open).mock.calls[0]![0].argv).not.toBe(request.argv)
    for (const payload of [{}, { argv: [] }, { argv: [''] }, { argv: [7] }, { argv: ['a\0b'] },
      { argv: Array(257).fill('a') }, { argv: ['a'.repeat(32768)] }, { argv: ['sh'], command: 'unsafe' }]) {
      expect(await answerShellQuery(core, 'open', { cwd: '/work', ...payload })).toEqual({ ok: false, error: 'INVALID_ARGV' })
    }
    for (const cwd of [undefined, 'relative', '/nul\0', '/' + 'x'.repeat(4096)]) {
      expect(await answerShellQuery(core, 'open', { argv: ['sh'], cwd })).toEqual({ ok: false, error: 'INVALID_CWD' })
    }
    expect(core.terminals.open).toHaveBeenCalledTimes(1)
  })
  it('asks the current registry and exact exit probe, refusing malformed or unknown reads', async () => {
    const core = fakeCore({ terminals: { describe: vi.fn(async () => ({ id: 'a' })), visitStatus: vi.fn(async () => ({ exited: true })) } })
    expect(await answerShellQuery(core, 'describe', { agentId: 'a' })).toEqual({ agent: { id: 'a' } })
    expect(await answerShellQuery(core, 'visitStatus', { agentId: 'a' })).toEqual({ exited: true })
    expect(core.terminals.describe).toHaveBeenCalledWith('a')
    expect(core.terminals.visitStatus).toHaveBeenCalledWith('a')
    for (const query of ['describe', 'visitStatus']) for (const agentId of [null, '', 'x'.repeat(257)]) {
      expect(await answerShellQuery(core, query, { agentId })).toEqual({ error: 'BAD_QUERY' })
    }
    expect(await answerShellQuery(core, 'unknown', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})
