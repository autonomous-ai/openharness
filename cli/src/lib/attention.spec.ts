// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it } from 'vitest'
import { AttentionTracker, summarizeAttention } from './attention.js'

const s = (agentId: string, active = true, engine = 'claude') => ({ agentId, sessionId: `s-${agentId}`, engine, active, tmuxPane: '%1', name: agentId })

describe('AttentionTracker', () => {
  it('walks a turn: working, waiting, working, done, then reviewed', () => {
    let t = 1000
    const tr = new AttentionTracker(() => t)
    const seen: string[] = []
    tr.onChange((e, prev) => seen.push(`${prev ?? 'none'}>${e.state}`))
    tr.turnStarted('a', 'fix the login flow')
    t = 2000; tr.question('a', false, 'Which branch?')
    t = 3000; tr.answered('a')
    t = 4000; tr.turnEnded('a')
    t = 5000; tr.seen('a')
    expect(seen).toEqual(['none>working', 'working>waiting', 'waiting>working', 'working>done', 'done>idle'])
    expect(tr.get('a')).toEqual({ agentId: 'a', state: 'idle', since: 5000, detail: 'reviewed' })
  })
  it('keeps `since` when the state repeats and ignores identical sets', () => {
    let t = 10
    const tr = new AttentionTracker(() => t)
    let changes = 0
    tr.onChange(() => changes++)
    tr.turnStarted('a', 'x'); t = 20; tr.turnStarted('a', 'x')
    expect(changes).toBe(1)
    expect(tr.get('a')?.since).toBe(10)
  })
  it('permission is its own state and answered() only clears asking states', () => {
    const tr = new AttentionTracker(() => 1)
    tr.question('a', true, 'Bash: git push')
    expect(tr.get('a')?.state).toBe('permission')
    tr.turnEnded('a')
    tr.answered('a')
    expect(tr.get('a')?.state).toBe('done')
  })
  it('failed and cancelled are distinct from done', () => {
    const tr = new AttentionTracker(() => 1)
    tr.turnEnded('a', { error: 'API 529 overloaded' })
    tr.turnEnded('b', { aborted: true })
    expect(tr.get('a')).toMatchObject({ state: 'failed', detail: 'API 529 overloaded' })
    expect(tr.get('b')).toMatchObject({ state: 'idle', detail: 'cancelled' })
  })
  it('snapshot orders by priority, marks inactive sessions offline, and carries glyph and label', () => {
    let t = 1
    const tr = new AttentionTracker(() => t++)
    tr.turnStarted('w'); tr.question('q', false); tr.question('p', true); tr.turnEnded('d'); tr.failed('f', 'boom')
    const rows = tr.snapshot([s('w'), s('q'), s('p'), s('d'), s('f'), s('o', false), s('n')], 'gus')
    expect(rows.map((r) => `${r.agentId}:${r.state}`)).toEqual(['p:permission', 'q:waiting', 'f:failed', 'd:done', 'w:working', 'n:idle', 'o:offline'])
    expect(rows[0]).toMatchObject({ glyph: '!', label: 'needs permission', machine: 'gus', tmuxPane: '%1' })
    expect(rows.at(-1)).toMatchObject({ glyph: '.', detail: '' })
  })
  it('summarizes a fleet by the most urgent state', () => {
    const tr = new AttentionTracker(() => 1)
    tr.turnStarted('a'); tr.turnStarted('b'); tr.question('c', false)
    const rows = tr.snapshot([s('a'), s('b'), s('c')], 'gus')
    expect(summarizeAttention(rows)).toEqual({ state: 'waiting', count: 1, agentId: 'c' })
    expect(summarizeAttention([])).toEqual({ state: 'offline', count: 0, agentId: null })
  })
})
