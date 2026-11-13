// Where the dial's agents come from with no window: every source's list, one row per real agent.
import { describe, expect, it, vi } from 'vitest'

import { HostRegistry } from './registry.js'
import { capsLetters, type HostAgent, type HostSource } from './types.js'

function agent(over: Partial<HostAgent> & { id: string }): HostAgent {
  return { engine: 'claude', name: 'app', host: 'terminal', state: 'idle', since: 0, lastActivityAt: 0, unseenDone: false, ...over }
}

function source(id: HostSource['id'], agents: HostAgent[]) {
  const listeners = new Set<() => void>()
  const s: HostSource & { emit(): void } = {
    id,
    list: () => agents,
    onChange: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    capabilities: () => ({ status: true, voice: id === 'harness', focus: false, answer: id === 'harness' }),
    emit: () => { for (const l of listeners) l() },
  }
  return s
}

describe('HostRegistry', () => {
  it('harness wins over observed for the same engine+sessionId', () => {
    // A Claude Code session started in Ghostty, then resumed inside a Harness pane: one agent, shown as Harness's.
    const observed = source('observed', [agent({ id: 'obs-1', engine: 'claude', sessionId: 's-1', callerPid: 41, host: 'ghostty' })])
    const harness = source('harness', [agent({ id: 'h-1', engine: 'claude', sessionId: 's-1', host: 'harness' })])
    // Observed is listed first so that order cannot be what decides.
    const registry = new HostRegistry([observed, harness])
    expect(registry.agents().map((a) => a.id)).toEqual(['h-1'])
    expect(registry.source('h-1')).toBe(harness)
    expect(registry.source('obs-1')).toBeUndefined()
  })

  it('keeps the same sessionId under two engines apart', () => {
    const registry = new HostRegistry([
      source('harness', [agent({ id: 'h-1', engine: 'claude', sessionId: 's-1' })]),
      source('observed', [agent({ id: 'obs-1', engine: 'codex', sessionId: 's-1' })]),
    ])
    expect(registry.agents().map((a) => a.id)).toEqual(['h-1', 'obs-1'])
  })

  it('dedupes by callerPid when sessionId is missing', () => {
    const harness = source('harness', [agent({ id: 'h-1', callerPid: 77 })])
    const observed = source('observed', [
      agent({ id: 'obs-1', sessionId: 's-1', callerPid: 77 }),
      agent({ id: 'obs-2', sessionId: 's-2', callerPid: 78 }),
    ])
    const registry = new HostRegistry([observed, harness])
    expect(registry.agents().map((a) => a.id)).toEqual(['h-1', 'obs-2'])
    expect(registry.source('obs-2')).toBe(observed)
  })

  it('keeps two sessions of one process apart when both name their session', () => {
    const registry = new HostRegistry([
      source('harness', [agent({ id: 'h-1', sessionId: 's-1', callerPid: 77 })]),
      source('observed', [agent({ id: 'obs-1', sessionId: 's-2', callerPid: 77 })]),
    ])
    expect(registry.agents().map((a) => a.id)).toEqual(['h-1', 'obs-1'])
  })

  it('onChange fires once per source change', () => {
    const harness = source('harness', [])
    const observed = source('observed', [])
    const registry = new HostRegistry([harness, observed])
    const cb = vi.fn()
    const off = registry.onChange(cb)
    observed.emit()
    expect(cb).toHaveBeenCalledTimes(1)
    harness.emit()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    observed.emit()
    harness.emit()
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('capsLetters({status,voice,answer}) === \'sva\'', () => {
    expect(capsLetters({ status: true, voice: true, focus: false, answer: true })).toBe('sva')
    expect(capsLetters({ status: true, voice: true, focus: true, answer: true })).toBe('svfa')
    expect(capsLetters({ status: true, voice: false, focus: false, answer: false })).toBe('s')
    expect(capsLetters({ status: false, voice: false, focus: false, answer: false })).toBe('')
  })
})
