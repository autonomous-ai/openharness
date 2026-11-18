import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

let directory = ''
let projects = ''
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-cwd-repair-'))
  projects = join(directory, 'projects')
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', projects)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

const mangle = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')
function transcript(project: string, sessionId: string, cwds: string[]): string {
  const dir = join(projects, mangle(project))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, [JSON.stringify({ type: 'mode' }), ...cwds.map((cwd) => JSON.stringify({ type: 'user', cwd }))].join('\n') + '\n')
  return path
}

async function fixture() {
  const { registry } = await import('./registry.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const { repairProjectCwds: repairClaudeCwd } = await import('./cwdRepair.js')
  const store = new StoppedAgentStore(join(directory, 'stopped-agents'))
  const { sessionStorage } = await import('./sessionStorage.js')
  cleanups.push(async () => { await registry.flush(); await store.close(); await sessionStorage.close() })
  const project = join(directory, 'repo')
  mkdirSync(join(project, 'cli'), { recursive: true })
  const open = async (id: string, pane: string, cwd: string, extra: Pick<Partial<RegisteredSession>, 'forkedFrom'> = {}): Promise<RegisteredSession> =>
    (await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: pane }], cwd,
      defaultName: `Agent ${id}`, forkedFrom: extra.forkedFrom }))!
  const bind = async (row: RegisteredSession, sessionId: string, cwds: string[], under = project): Promise<RegisteredSession> => {
    const cwd = row.cwd!
    const path = transcript(under, sessionId, cwds)
    return (await registry.register({ sessionId, transcriptPath: path, cwd, engine: 'claude', runtimes: row.runtimes, processIdentity: { pid: 100 + Number(row.tmuxPane.slice(1)), executable: 'claude', startMarker: 'm' } }))!.entry
  }
  const logs: string[] = []
  return { registry, store, repairClaudeCwd, project, open, bind, logs, log: (m: string) => { logs.push(m) } }
}

describe('repairProjectCwds (Claude Code rows)', () => {
  it.each(['destination replaced', 'destination mutated', 'source replaced'] as const)(
    'does not apply a captured fork folder after %s during archive listing', async change => {
      const { repairProjectCwds } = await import('./cwdRepair.js')
      const project = join(directory, 'repo'), drifted = join(project, 'cli')
      mkdirSync(drifted, { recursive: true })
      const source = { agentId: 'source', engine: 'claude', sessionId: 'source-session', cwd: drifted,
        transcriptPath: transcript(project, 'source-session', [project]) } as RegisteredSession
      const fork = { agentId: 'fork', engine: 'claude', sessionId: 'fork-session', cwd: drifted,
        forkedFrom: { agentId: 'source', name: 'source' } } as RegisteredSession
      const rows = new Map([['source', source], ['fork', fork]])
      const setCwd = vi.fn((id: string, cwd: string) => { rows.get(id)!.cwd = cwd; return true })
      await repairProjectCwds({ registry: { list: () => [...rows.values()], byAgent: id => rows.get(id), setCwd,
        transaction: async apply => apply() }, stoppedAgents: {
        list: async () => {
          if (change === 'destination replaced') rows.set('fork', { ...fork, sessionId: 'replacement', cwd: '/replacement' })
          else if (change === 'destination mutated') fork.cwd = '/replacement'
          else rows.set('source', { ...source, sessionId: 'replacement', cwd: '/replacement' })
          return []
        }, get: async () => null, current: () => false, patch: vi.fn(async () => false),
      }, log: vi.fn() })
      expect(setCwd.mock.calls).toEqual([['source', project]])
      expect(rows.get('fork')?.cwd).toBe(change === 'source replaced' ? drifted : '/replacement')
    })

  it('moves drifted live and archived rows to their transcript folder, leaves the rest alone, and is idempotent', async () => {
    const { registry, store, repairClaudeCwd, project, open, bind, logs, log } = await fixture()
    // Drifted: the row says the subfolder, the transcript lives under the project and names it on line 3.
    const drifted = (await bind((await open('a', '%1', project)), 'sess-a', [join(project, 'cli'), project]))
    registry.setCwd(drifted.agentId, join(project, 'cli'))     // what the old hook path used to do
    // Right already: a subfolder launch whose transcript lives under that subfolder.
    ;(await bind((await open('b', '%2', join(project, 'cli'))), 'sess-b', [join(project, 'cli')], join(project, 'cli')))
    // Renamed since: no line names the folder the transcript sits in.
    const renamed = (await bind((await open('c', '%3', join(project, 'cli'))), 'sess-c', [join(directory, 'old-name')]))
    // Archived and drifted, with a name and activity time that must survive.
    const archivedRow = (await bind((await open('d', '%4', project)), 'sess-d', [join(project, 'cli'), project]))
    registry.setCwd(archivedRow.agentId, join(project, 'cli'))
    await store.save({ ...registry.byAgent(archivedRow.agentId)!, defaultName: 'harness Desktop' })
    ;(await removeRegistryAgent(registry, archivedRow.agentId))
    const archivedBefore = (await store.get(archivedRow.agentId))!
    // A transcript-less fork of the drifted row, live and archived.
    const forkLive = (await open('e', '%5', join(project, 'cli'), { forkedFrom: { agentId: drifted.agentId, name: 'a' } }))
    const forkSaved = (await open('f', '%6', join(project, 'cli'), { forkedFrom: { agentId: archivedRow.agentId, name: 'd' } }))
    await store.save(forkSaved); (await removeRegistryAgent(registry, forkSaved.agentId))
    // A fork of a row that was never drifted keeps its own folder.
    const forkFine = (await open('g', '%7', join(project, 'cli'), { forkedFrom: { agentId: 'someone-else', name: 'x' } }))

    const first = await repairClaudeCwd({ registry, stoppedAgents: store, log })
    expect(first).toEqual({ registry: 2, archived: 2 })
    expect(registry.byAgent(drifted.agentId)?.cwd).toBe(project)
    expect(registry.byAgent(forkLive.agentId)?.cwd).toBe(project)
    expect(registry.byAgent(forkFine.agentId)?.cwd).toBe(join(project, 'cli'))
    expect(registry.byAgent(renamed.agentId)?.cwd).toBe(join(project, 'cli'))
    expect((await store.get(archivedRow.agentId))).toEqual({ ...archivedBefore, cwd: project })
    expect((await store.get(forkSaved.agentId))?.cwd).toBe(project)
    expect(logs.filter((l) => l.includes("left as is")), logs.join("\n")).toHaveLength(1)
    expect(logs.filter((l) => l.includes('→'))).toHaveLength(4)

    logs.length = 0
    expect(await repairClaudeCwd({ registry, stoppedAgents: store, log })).toEqual({ registry: 0, archived: 0 })
    expect(logs.filter((l) => l.includes('→'))).toHaveLength(0)
    // Persisted, not just in memory.
    vi.resetModules()
    const { registry: reloaded } = await import('./registry.js')
    const { sessionStorage } = await import('./sessionStorage.js')
    cleanups.push(async () => { await reloaded.flush(); await sessionStorage.close() })
    await reloaded.load()
    expect(reloaded.byAgent(drifted.agentId)?.cwd).toBe(project)
  })

  it('does not touch rows without a transcript, of other engines, or whose transcript is gone', async () => {
    const { registry, store, repairClaudeCwd, project, open, bind, log } = await fixture()
    ;(await open('a', '%1', join(project, 'cli')))
    const codex = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%2' }], cwd: join(project, 'cli'), defaultName: 'codex' }))!
    const gone = (await bind((await open('c', '%3', project)), 'sess-c', [project]))
    registry.setCwd(gone.agentId, join(project, 'cli'))
    rmSync(gone.transcriptPath!)
    expect(await repairClaudeCwd({ registry, stoppedAgents: store, log })).toEqual({ registry: 0, archived: 0 })
    expect(registry.byAgent(codex.agentId)?.cwd).toBe(join(project, 'cli'))
    expect(registry.byAgent(gone.agentId)?.cwd).toBe(join(project, 'cli'))
  })
})
