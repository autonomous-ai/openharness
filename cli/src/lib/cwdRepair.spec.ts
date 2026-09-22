import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

let directory = ''
let projects = ''
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-cwd-repair-'))
  projects = join(directory, 'projects')
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', projects)
})
afterEach(() => {
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
  const { repairClaudeCwd } = await import('./cwdRepair.js')
  const store = new StoppedAgentStore(join(directory, 'stopped-agents'))
  const project = join(directory, 'repo')
  mkdirSync(join(project, 'cli'), { recursive: true })
  const open = (id: string, pane: string, cwd: string, extra: Partial<RegisteredSession> = {}): RegisteredSession => {
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: pane }], cwd, defaultName: `Agent ${id}` })!
    Object.assign(row, extra)
    return row
  }
  const bind = (row: RegisteredSession, sessionId: string, cwds: string[], under = project): RegisteredSession => {
    const cwd = row.cwd!
    const path = transcript(under, sessionId, cwds)
    return registry.register({ sessionId, transcriptPath: path, cwd, engine: 'claude', runtimes: row.runtimes, processIdentity: { pid: 100 + Number(row.tmuxPane.slice(1)), executable: 'claude', startMarker: 'm' } })!.entry
  }
  const logs: string[] = []
  return { registry, store, repairClaudeCwd, project, open, bind, logs, log: (m: string) => { logs.push(m) } }
}

describe('repairClaudeCwd', () => {
  it('moves drifted live and archived rows to their transcript folder, leaves the rest alone, and is idempotent', async () => {
    const { registry, store, repairClaudeCwd, project, open, bind, logs, log } = await fixture()
    // Drifted: the row says the subfolder, the transcript lives under the project and names it on line 3.
    const drifted = bind(open('a', '%1', project), 'sess-a', [join(project, 'cli'), project])
    registry.setCwd(drifted.agentId, join(project, 'cli'))     // what the old hook path used to do
    // Right already: a subfolder launch whose transcript lives under that subfolder.
    bind(open('b', '%2', join(project, 'cli')), 'sess-b', [join(project, 'cli')], join(project, 'cli'))
    // Renamed since: no line names the folder the transcript sits in.
    const renamed = bind(open('c', '%3', join(project, 'cli')), 'sess-c', [join(directory, 'old-name')])
    // Archived and drifted, with a name and activity time that must survive.
    const archivedRow = bind(open('d', '%4', project), 'sess-d', [join(project, 'cli'), project])
    registry.setCwd(archivedRow.agentId, join(project, 'cli'))
    store.save({ ...registry.byAgent(archivedRow.agentId)!, defaultName: 'harness Desktop' })
    registry.removeAgent(archivedRow.agentId)
    const archivedBefore = store.get(archivedRow.agentId)!
    // A transcript-less fork of the drifted row, live and archived.
    const forkLive = open('e', '%5', join(project, 'cli'), { forkedFrom: { agentId: drifted.agentId, name: 'a' } })
    const forkSaved = open('f', '%6', join(project, 'cli'), { forkedFrom: { agentId: archivedRow.agentId, name: 'd' } })
    store.save(forkSaved); registry.removeAgent(forkSaved.agentId)
    // A fork of a row that was never drifted keeps its own folder.
    const forkFine = open('g', '%7', join(project, 'cli'), { forkedFrom: { agentId: 'someone-else', name: 'x' } })

    const first = await repairClaudeCwd({ registry, stoppedAgents: store, log })
    expect(first).toEqual({ registry: 2, archived: 2 })
    expect(registry.byAgent(drifted.agentId)?.cwd).toBe(project)
    expect(registry.byAgent(forkLive.agentId)?.cwd).toBe(project)
    expect(registry.byAgent(forkFine.agentId)?.cwd).toBe(join(project, 'cli'))
    expect(registry.byAgent(renamed.agentId)?.cwd).toBe(join(project, 'cli'))
    expect(store.get(archivedRow.agentId)).toEqual({ ...archivedBefore, cwd: project })
    expect(store.get(forkSaved.agentId)?.cwd).toBe(project)
    expect(logs.filter((l) => l.includes("left as is")), logs.join("\n")).toHaveLength(1)
    expect(logs.filter((l) => l.includes('→'))).toHaveLength(4)

    logs.length = 0
    expect(await repairClaudeCwd({ registry, stoppedAgents: store, log })).toEqual({ registry: 0, archived: 0 })
    expect(logs.filter((l) => l.includes('→'))).toHaveLength(0)
    // Persisted, not just in memory.
    vi.resetModules()
    const { registry: reloaded } = await import('./registry.js')
    reloaded.load()
    expect(reloaded.byAgent(drifted.agentId)?.cwd).toBe(project)
  })

  it('does not touch rows without a transcript, of other engines, or whose transcript is gone', async () => {
    const { registry, store, repairClaudeCwd, project, open, bind, log } = await fixture()
    open('a', '%1', join(project, 'cli'))
    const codex = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%2' }], cwd: join(project, 'cli'), defaultName: 'codex' })!
    const gone = bind(open('c', '%3', project), 'sess-c', [project])
    registry.setCwd(gone.agentId, join(project, 'cli'))
    rmSync(gone.transcriptPath!)
    expect(await repairClaudeCwd({ registry, stoppedAgents: store, log })).toEqual({ registry: 0, archived: 0 })
    expect(registry.byAgent(codex.agentId)?.cwd).toBe(join(project, 'cli'))
    expect(registry.byAgent(gone.agentId)?.cwd).toBe(join(project, 'cli'))
  })
})
