import { expect, it } from 'vitest'
import { appPanesFrom, appSwarmsFrom, appUnreadFrom } from './deviceWindowState.js'
import { createLegacyDeviceWindowState } from './legacyDeviceWindowState.js'

it('preserves old foreground defaults and keeps only nonempty agent identifiers', () => {
  expect(appPanesFrom(undefined)).toEqual({ ids: [], foreground: true })
  expect(appPanesFrom({ agentIds: [null, '', 7, 'agent'], foreground: false })).toEqual({ ids: ['agent'], foreground: false })
  expect(appPanesFrom({ agentIds: 'bad', foreground: 0 })).toEqual({ ids: [], foreground: true })
})

it('preserves unread occurrence identity and refuses incomplete rows without inventing text', () => {
  expect(appUnreadFrom(undefined)).toEqual([])
  expect(appUnreadFrom({ items: [null, {}, { agentId: '' }, { agentId: 'a', machineId: 5 },
    { agentId: 'a', machineId: 'm', question: true, text: 'text', readToken: 'read_1' },
    { agentId: 'b', machineId: 'm', question: 'true', text: 1, readToken: 'bad token' }] })).toEqual([
    { agentId: 'a', machineId: 'm', question: true, text: 'text', readToken: 'read_1' },
    { agentId: 'b', machineId: 'm', question: false, text: '' },
  ])
})

it.each([undefined, null, 1, {}, { swarms: 'bad' }, { swarms: [null, 1, {}, { id: '', name: 'empty' }] }])('ignores unusable old tab rosters %j', payload => {
  expect(appSwarmsFrom(payload)).toBeNull()
})

it('keeps the supported 24 tabs, bounded names and pane defaults from older windows', () => {
  const rows = Array.from({ length: 25 }, (_, n) => ({ id: String(n), name: 'x'.repeat(90), agentIds: ['a', '', 7], panes: n === 0 ? 1001.9 : -1 }))
  const state = appSwarmsFrom({ active: '1', swarms: rows })!
  expect(state.active).toBe('1'); expect(state.swarms).toHaveLength(24)
  expect(state.swarms[0]).toEqual({ id: '0', name: 'x'.repeat(80), agentIds: ['a'], panes: 999 })
  expect(state.swarms[1].panes).toBe(1)
  expect(appSwarmsFrom({ swarms: [{ id: 'a', name: 'A', agentIds: null }] })).toEqual({ active: 'a', swarms: [{ id: 'a', name: 'A', agentIds: [], panes: 0 }], tiles: [] })
})

it('normalizes only drawable tile rectangles and retains the existing 24-tile limit', () => {
  const valid = { x1: 0, y1: 0, x2: 10, y2: 10 }
  const tiles = [null, 7, {}, { ...valid, x1: 'bad' }, { ...valid, y1: null }, { ...valid, x2: NaN },
    { ...valid, y2: Infinity }, { ...valid, x2: -1 }, { ...valid, y2: -1 },
    { x1: -1, y1: 1.6, x2: 2000, y2: 100.4, agentId: 'a' }, ...Array.from({ length: 25 }, () => valid)]
  const state = appSwarmsFrom({ swarms: [{ id: 'a', name: 'A' }], tiles })!
  expect(state.tiles).toHaveLength(24)
  expect(state.tiles![0]).toEqual({ x1: 0, y1: 2, x2: 1000, y2: 100, agentId: 'a' })
  expect(state.tiles![1]).toEqual({ ...valid, agentId: '' })
})

it('keeps optional callbacks optional and ignores unknown compatibility frame names', () => {
  const owner = createLegacyDeviceWindowState({})
  expect(owner.receive('window', 'unknown', undefined)).toBe(false)
  owner.receive('window', 'app_panes', undefined)
  owner.receive('window', 'app_unread', undefined)
  owner.receive('window', 'app_swarms', { swarms: [{ id: 'a', name: 'A' }] })
  owner.receive('window', 'agent_seen', { agentId: 'a', readToken: 'read_1' })
  owner.closed('window')
  expect(owner.snapshot()).toEqual({ desk: [], foreground: false, swarms: null, unread: [] })
})
