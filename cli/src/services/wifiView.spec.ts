import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_READ_VIEW_BYTES, type SessionSnapshotRow } from '../core/api.js'
import { snapshotFixture, snapshotRow, snapshotReader } from '../testing/sessionSnapshot.js'
import * as jsonBudget from '../lib/boundedJsonBytes.js'
import { readWifiView, wifiProjection } from './wifiView.js'

describe('Wi-Fi presentation outside core', () => {
  it('sizes its closed projections without repeating unknown-object validation', async () => {
    const checked = vi.spyOn(jsonBudget, 'boundedJsonBytes')
    try {
      const view = await readWifiView(snapshotReader(() => snapshotFixture({ registered: [snapshotRow()] })), 'machine-1')
      expect(view.store).toHaveLength(1); expect(view.agents).toHaveLength(1)
      expect(checked.mock.calls.filter(([value]) => value === view.store[0] || value === view.agents[0])).toHaveLength(0)
      expect(checked.mock.calls.filter(([value]) => ['begin', 'row', 'end'].includes((value as { type?: string })?.type ?? ''))).toHaveLength(3)
    } finally { checked.mockRestore() }
  })
  it.each(['plain', 'quote"slash\\control\n\t\u0000', 'Tiếng Việt 😀', '\ud800', '\udfff', ''])('preserves exact UTF-8 projection sizes for %j', async text => {
    const row = snapshotRow('agent')
    row.session.cwd = null
    row.session.dsh = text
    row.session.launch = { state: 'failed', error: 'failure', detail: text }
    row.facts.displayName = text
    const header = snapshotFixture(), bytes: Array<number | null> = []
    const projection = wifiProjection(header)
    projection.row({ source: 'registered', row }, { remaining: SESSION_READ_VIEW_BYTES, retain: value => { bytes.push(value) } })
    const expected = projection.value()
    const actual = await readWifiView(snapshotReader(() => snapshotFixture({ registered: [row] })), header.machine.id)
    expect(actual).toEqual(expected)
    expect(bytes).toEqual([...actual.store, ...actual.agents].map(value => jsonBudget.boundedJsonBytes(value, SESSION_READ_VIEW_BYTES)))
    expect(actual.store[0]).toMatchObject({ packageId: text, workspace: null, error: text })
  })
  it.each(['membership', 'aggregate bytes'])('preserves complete Wi-Fi output beyond the former %s limit', async kind => {
    const registered = Array.from({ length: kind === 'membership' ? 4097 : 1600 }, (_, i) => snapshotRow(`a-${i}`))
    if (kind === 'aggregate bytes') for (const i of [8, 9]) registered[i].session.dsh = registered[i].facts.parts.dsh = 'p'.repeat(1_600_000)
    const view = await readWifiView(snapshotReader(() => snapshotFixture({ registered })), 'machine-1')
    expect(view.store.map(row => row.agentId)).toEqual(registered.map(row => row.session.agentId))
    expect(view.agents.map(row => row.agentId)).toEqual(registered.map(row => row.session.agentId))
    if (kind === 'aggregate bytes') for (const i of [8, 9]) {
      expect(view.store[i].packageId).toBe(registered[i].facts.parts.dsh)
      expect(view.agents[i].packageId).toBe(registered[i].facts.parts.dsh)
    }
  })
  it('preserves all registered workspace evidence and only advertises terminal membership', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wifi-view-')))
    try {
      const work = join(root, 'work'); mkdirSync(work)
      const alias = join(root, 'alias'); symlinkSync(work, alias)
      const make = (id: string, session: Partial<SessionSnapshotRow['session']> = {}, available = true, parts: { dsh?: string } = {}) => {
        const row = snapshotRow(id)
        return { ...row, session: { ...row.session, cwd: '/absent-workspace', ...session },
          facts: { displayName: `Name ${id}`, terminalAvailable: available, parts }, turnRunning: id === 'ready' }
      }
      const registered = [
        make('ready', { cwd: alias, dsh: 'retained', launch: { state: 'ready' } }, true, { dsh: 'published' }),
        make('fallback', { dsh: 'retained' }), make('starting', { launch: { state: 'starting' } }),
        make('failed', { launch: { state: 'failed', error: 'FAILED' } }),
        make('detail', { launch: { state: 'failed', error: 'FAILED', detail: 'detail' } }),
        make('hidden', {}, false), make('inactive', { active: false }), make('terminal', { engine: 'terminal', sessionId: '' }),
        make('unbound', { sessionId: '', cwd: null }), make('empty', { cwd: '' }), make('held', { sessionId: '', launch: { state: 'held', service: 'engine', detail: 'wait' } }),
      ]
      delete registered[5].session.dsh
      const read = vi.fn(snapshotReader(() => snapshotFixture({ registered, cloud: [{ agentId: 'cloud', sessionId: 'c', engine: 'fo', registeredAt: 0, lastHookAt: 0,
        transcriptPath: null, displayName: 'Cloud', selectedModel: null }] })))
      const view = await readWifiView(read, 'machine-1')
      expect(read).toHaveBeenCalledWith('registered', expect.any(Function), undefined)
      expect(view.hasWindow).toBe(true)
      expect(view.store).toHaveLength(11)
      expect(view.agents.map(row => row.agentId)).not.toContain('hidden')
      expect(view.agents.map(row => row.agentId)).not.toContain('cloud')
      const by = (id: string) => view.store.find(row => row.agentId === id)!
      expect(by('ready')).toEqual({ agentId: 'ready', machineId: 'machine-1', packageId: 'published', engine: 'claude', workspace: work, state: 'active', runtime: 'ready' })
      expect(by('fallback').packageId).toBe('retained')
      expect(by('starting').runtime).toBe('starting')
      expect(by('failed')).toMatchObject({ runtime: 'unavailable', error: 'FAILED' })
      expect(by('detail').error).toBe('detail')
      expect(by('hidden')).toMatchObject({ packageId: null, runtime: 'unavailable' })
      expect(by('inactive')).toMatchObject({ state: 'inactive', runtime: 'unavailable' })
      expect(by('terminal').runtime).toBe('ready')
      expect(by('unbound')).toMatchObject({ workspace: null, runtime: 'starting' })
      expect(by('held').runtime).toBe('starting')
      expect(by('empty').workspace).toBeNull()
      expect(view.agents.find(row => row.agentId === 'empty')?.workspace).toBe('')
      expect(view.agents[0]).toMatchObject({ name: 'Name ready', workspace: work, state: 'running' })
      expect(view.agents[1]).toMatchObject({ name: 'Name fallback', state: 'idle' })
      expect(await readWifiView(snapshotReader(() => snapshotFixture({ hasWindow: false })), 'machine-1')).toEqual({ agents: [], store: [], hasWindow: false })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
