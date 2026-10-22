import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { recordReplacement, replacementObservations } from './replacements.js'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true }) })
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'swarm-replacement-')); roots.push(dataDir)
  const old = { agentId: 'old', cwd: '/repo', engine: 'codex', active: false, registeredAt: 1 }
  const next = { agentId: 'new', cwd: '/repo', engine: 'claude', sessionId: 'native', registeredAt: 2 }
  const core = fakeCore({ dataDir, daemon: { machineId: () => 'machine' }, conversations: { resolve: vi.fn(async id => (id === 'old' ? old : next) as never) },
    agents: { byAgent: vi.fn(id => id === 'new' ? next as never : undefined), stopped: vi.fn(async () => true), terminalAvailable: () => true,
      creationStatus: vi.fn(async creationId => ({ creationId, state: 'created' as const, agentId: 'new' })), runtimeProfile: () => 'runtime-v1:new:claude:sonnet@high' } })
  const payload = { agentId: 'old', replacementId: 'new', changeId: '1234567890abcdef', targetEngine: 'claude' }
  const row = { tabId: 'tab', agent: { id: 'member', harnessId: 'old', machineId: 'machine', projectId: 'project' } }
  return { core, payload, row, old, next }
}

it('durably reports Change agent, and a new host can recover the exact replacement', async () => {
  const f = fixture()
  await recordReplacement(f.core, f.payload)
  await recordReplacement(f.core, f.payload)
  const observations = await replacementObservations(f.core, 'machine', [f.row])
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({ path: '/api/super-tabs/tab/commands', body: { asAgentId: 'member', command: {
    type: 'agent.rebind', agentId: 'member', machineId: 'machine', projectId: 'project', previousHarnessId: 'old', harnessId: 'new',
    configuration: { engine: 'claude', model: 'sonnet', effort: 'high', contextWindow: null, engineVersion: null } } } })
  expect(await replacementObservations(f.core, 'machine', [f.row])).toEqual(observations)
})

it.each(['source-live', 'different-folder', 'different-engine', 'different-receipt', 'not-live', 'foreign-machine', 'stopping'])('holds a replacement with %s', async kind => {
  const f = fixture()
  await recordReplacement(f.core, f.payload)
  if (kind === 'source-live') vi.mocked(f.core.agents.stopped!).mockResolvedValue(false)
  if (kind === 'different-folder') f.next.cwd = '/another'
  if (kind === 'different-engine') f.next.engine = 'codex'
  if (kind === 'different-receipt') vi.mocked(f.core.agents.creationStatus!).mockResolvedValue({ creationId: f.payload.changeId, state: 'created', agentId: 'another' })
  if (kind === 'not-live') vi.mocked(f.core.agents.byAgent).mockReturnValue(undefined)
  if (kind === 'foreign-machine') f.row.agent.machineId = 'another'
  if (kind === 'stopping') Object.assign(f.row, { stopRequested: true })
  expect(await replacementObservations(f.core, 'machine', [f.row])).toEqual([])
})

it('refuses to record unrelated or incomplete native facts', async () => {
  const f = fixture()
  f.next.cwd = '/another'
  await expect(recordReplacement(f.core, f.payload)).rejects.toThrow()
  f.next.cwd = '/repo'; f.old.active = true
  await expect(recordReplacement(f.core, f.payload)).rejects.toThrow()
  await expect(recordReplacement(f.core, { ...f.payload, changeId: '../bad' })).rejects.toThrow()
})
