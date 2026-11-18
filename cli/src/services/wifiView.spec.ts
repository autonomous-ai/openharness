import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_READ_VIEW_BYTES } from '../core/api.js'
import { snapshotFixture, snapshotRow, snapshotReader, snapshotValue, type SessionSnapshotRow } from '../testing/sessionSnapshot.js'
import * as jsonBudget from '../lib/boundedJsonBytes.js'
import { readWifiView, wifiProjection } from './wifiView.js'
import type { SessionRecordSource } from './sessionSnapshot.js'

describe('Wi-Fi presentation outside core', () => {
  it.each([
    [false, false, null], [null, false, null], ['stored', false, 'stored'],
    [false, 'published', 'published'], [null, 'published', 'published'],
    ['same', true, 'same'], ['', true, ''], ['stored', 'published', 'published'],
  ] as const)('projects compact session package values %j / %j without losing occupancy', async (stored, published, expected) => {
    const read: SessionRecordSource = async (_scope, receive) => {
      const records = [
        { type: 'begin', payload: { count: 2, header: { version: 2,
          machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' }, signedIn: true, environment: 'prod', hasWindow: true } } },
        { type: 'row', payload: { index: 0, value: ['registered', 'visible', 'session', 'claude', 1, null, 0,
          true, null, stored, ['ready'], 'Name', true, 'chosen', true, published] } },
        { type: 'row', payload: { index: 1, value: ['registered', 'hidden', '', 'claude', 2, null, 0,
          false, null, stored, null, 'Hidden', false, null, false, published] } },
        { type: 'end', payload: { count: 2 } },
      ]
      for (const record of records) expect(receive(record, ok => { expect(ok).toBe(true) })).toBe(true)
    }
    const view = await readWifiView(read, 'machine-1')
    expect(view).toEqual({ hasWindow: true,
      agents: [{ agentId: 'visible', name: 'Name', engine: 'claude', packageId: expected, workspace: null, runtime: 'ready', state: 'running' }],
      store: [
        { agentId: 'visible', machineId: 'machine-1', packageId: expected, engine: 'claude', workspace: null, state: 'active', runtime: 'ready' },
        { agentId: 'hidden', machineId: 'machine-1', packageId: expected, engine: 'claude', workspace: null, state: 'inactive', runtime: 'unavailable' },
      ],
    })
  })

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
    projection.row(snapshotValue(row), { remaining: SESSION_READ_VIEW_BYTES, retain: value => { bytes.push(value) } })
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


it('uses fresh native workspace resolution for aliases, missing paths and every repeated row', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wifi-native-path-')))
  const first = join(root, 'first é'), second = join(root, 'second 中'), alias = join(root, 'alias')
  mkdirSync(first); mkdirSync(second); symlinkSync(first, alias)
  const native = vi.spyOn(realpathSync, 'native')
  try {
    const registered = ['one', 'two', 'empty', 'null'].map(id => snapshotRow(id))
    registered[0].session.cwd = registered[1].session.cwd = alias
    registered[2].session.cwd = ''; registered[3].session.cwd = null
    const read = () => readWifiView(snapshotReader(() => snapshotFixture({ registered })), 'machine-1')
    const a = await read()
    expect(a.store.map(row => row.workspace)).toEqual([first, first, null, null])
    expect(a.agents.map(row => row.workspace)).toEqual([first, first, '', null])
    expect(native.mock.calls.map(args => args[0])).toEqual([alias, alias])
    rmSync(alias); symlinkSync(second, alias)
    expect((await read()).store.map(row => row.workspace)).toEqual([second, second, null, null])
    rmSync(alias)
    expect((await read()).store.map(row => row.workspace)).toEqual([alias, alias, null, null])
    expect(native.mock.calls.map(args => args[0])).toEqual(Array(6).fill(alias))
  } finally { native.mockRestore(); rmSync(root, { recursive: true, force: true }) }
})
