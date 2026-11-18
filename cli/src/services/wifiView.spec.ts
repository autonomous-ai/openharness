import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionSnapshotRow } from '../core/api.js'
import { snapshotFixture, snapshotRow, snapshotReader } from '../testing/sessionSnapshot.js'
import { readWifiView } from './wifiView.js'

describe('Wi-Fi presentation outside core', () => {
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
      const view = await readWifiView(snapshotReader(() => snapshotFixture({ registered, cloud: [{ agentId: 'cloud', sessionId: 'c', engine: 'fo', registeredAt: 0, lastHookAt: 0,
        transcriptPath: null, displayName: 'Cloud', selectedModel: null }] })), 'machine-1')
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
