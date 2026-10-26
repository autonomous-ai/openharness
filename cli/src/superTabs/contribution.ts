import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { parseProjectFolder, prepareProjectFolder } from '../lib/projectFolder.js'
import { readCapabilities, START_REQUIREMENTS } from './capacity.js'
import { backend, identifier, object } from './host.js'
import { mkdir } from 'node:fs/promises'
import { readAuthSession } from '../lib/authSession.js'
import { randomUUID } from 'node:crypto'
import { repairSwarmCloneTrust, swarmCloneRoot, swarmCloneRoots } from './cloneTrust.js'

type Json = Record<string, unknown>

/** Owner-only setup. Reuses the regular checkout preparation and engine probe;
 * it neither launches an agent nor grants the team access to the computer. */
export async function prepareContribution(core: CoreApi, input: Json, deps: {
  backend: typeof backend; open: typeof openDaemon; prepare: typeof prepareProjectFolder; capacity: typeof readCapabilities; team?: () => boolean
} = { backend, open: openDaemon, prepare: prepareProjectFolder, capacity: readCapabilities }): Promise<Json> {
  if (!identifier(input.tabId)) throw new Error('Choose a Super Tab.')
  // A Mac's Harness Team account reads no Swarm as the person (backend lib/teamSession.ts). Its Mac's daemon adds it, as a
  // swarm workspace in its own clone root (host.ts joinTeams), so it needs no read ("One machine" in
  // docs/plans/2026-10-24-swarm-team-account.md).
  const team = (deps.team ?? (() => readAuthSession()?.kind === 'team'))()
  if (team && input.scope !== 'swarm') throw new Error('A Harness Team account joins a Swarm only as a swarm workspace.')
  const answer = team ? {} : object(await deps.backend(core, 'GET', `/api/super-tabs/${input.tabId}`))
  const state = object(answer.state), project = object(state.project)
  const machineId = core.daemon.machineId()
  const existing = (Array.isArray(state.machines) ? state.machines.map(object) : []).find(m => m.machineId === machineId)
  const swarm = input.scope === 'swarm' || Array.isArray(state.projects)
  let cwd = swarm ? swarmCloneRoot(core.dataDir, input.tabId, existing?.cwd) ?? swarmCloneRoots(core.dataDir, input.tabId)[0] : existing?.cwd
  if (swarm) {
    await mkdir(cwd as string, { recursive: true })
    await repairSwarmCloneTrust(core, { tabId: input.tabId, machine: { scope: 'swarm', cwd } })
  }
  if (typeof cwd !== 'string') {
    if (project.machineId === machineId && typeof project.cwd === 'string') cwd = project.cwd
    else {
      if (typeof project.repositoryUrl !== 'string') throw new Error('The lead needs to share a repository before this machine can join.')
      const source = parseProjectFolder({ projectSource: 'remote', repositoryUrl: project.repositoryUrl })
      if (!source) throw new Error('The project repository is unavailable.')
      cwd = await deps.prepare(source)
    }
  }
  const connection = await deps.open({ dataDir: core.dataDir, port: core.daemon.port, machineId })
  try {
    const [probe, capability] = await Promise.all([
      connection.request('engines_probe', { engines: ['claude', 'codex'], accounts: true }, 20_000),
      deps.capacity({ cwd, tools: ['git'], devices: [] }),
    ])
    const engines = (Array.isArray(probe.engines) ? probe.engines.map(object) : [])
      .filter(e => (e.engine === 'claude' || e.engine === 'codex') && e.installed === true)
      .map(e => e.engine as string)
    if (!engines.length) throw new Error('Install Claude Code or Codex on this machine, then try again.')
    const resources = object('resources' in capability ? capability.resources : null)
    if (capability.ok !== true || typeof resources.projectDiskFreeBytes !== 'number') throw new Error('The project folder is unavailable on this machine.')
    const total = typeof resources.memoryTotalBytes === 'number' ? resources.memoryTotalBytes : 0
    // Free memory is checked again for every start. It must not shrink the machine's
    // configured limit just because other work happens to be running during setup.
    const maxAvailableAgents = Math.max(1, Math.min(16, Math.floor(total / START_REQUIREMENTS.memoryBytes)))
    const maxAgents = Math.max(1, Math.min(16, Math.floor(total / (2 * START_REQUIREMENTS.memoryBytes))))
    return { ok: true, state: 'ready', cwd, engines: [...new Set(engines)], maxAgents, maxAvailableAgents, ...(swarm ? { scope: 'swarm' } : {}) }
  } finally { connection.close() }
}

/**
 * This Mac's Harness Team account preparing its own swarm workspace (prepareContribution, in that account's daemon), asked
 * through the relay as Desktop asks a machine it adds: its folder and engines are its own, which this Mac's daemon cannot
 * see. Polls the same receipt while it prepares ("One machine" in docs/plans/2026-10-24-swarm-team-account.md).
 */
export async function prepareTeamContribution(core: CoreApi, input: { tabId: string; machineId: string }, deps = {
  open: openDaemon, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), deadlineMs: 5 * 60_000, now: Date.now,
}): Promise<Json> {
  const connection = await deps.open({ dataDir: core.dataDir, port: core.daemon.port, machineId: core.daemon.machineId() }, input.machineId)
  try {
    const operationId = randomUUID(), deadline = deps.now() + deps.deadlineMs
    for (;;) {
      const answer = object(await connection.request('super_tabs', { action: 'prepareContribution', tabId: input.tabId, scope: 'swarm', operationId }, 30_000))
      if (answer.state === 'ready' && answer.scope === 'swarm' && typeof answer.cwd === 'string') return answer
      if (answer.state !== 'preparing') {
        throw new Error(typeof answer.detail === 'string' ? answer.detail : `The Harness Team account could not prepare its workspace (${String(answer.error ?? 'no answer')}).`)
      }
      if (deps.now() >= deadline) throw new Error('The Harness Team account is still preparing its workspace.')
      await deps.sleep(1_000)
    }
  } finally { connection.close() }
}

/** Cloning can outlive one RPC. Poll the same receipt instead of blocking the
 * core/service request or dispatching another checkout after a timeout. */
export class ContributionPreparations {
  private readonly jobs = new Map<string, { tabId: string; result: Json }>()
  constructor(private readonly prepare: (input: Json) => Promise<Json>) {}
  clear(): void { this.jobs.clear() }
  read(input: Json): Json {
    if (!identifier(input.operationId) || !identifier(input.tabId)) return { error: 'INVALID_REQUEST' }
    const known = this.jobs.get(input.operationId)
    if (known) return known.tabId === input.tabId ? known.result : { error: 'OPERATION_CONFLICT' }
    if (this.jobs.size >= 32) {
      const finished = [...this.jobs].find(([, job]) => job.result.state !== 'preparing')
      if (!finished) return { error: 'SETUP_BUSY', detail: 'Wait for the other machine setup to finish.' }
      this.jobs.delete(finished[0])
    }
    const job = { tabId: input.tabId, result: { ok: true, state: 'preparing' } as Json }
    this.jobs.set(input.operationId, job)
    void this.prepare(input).then(result => { job.result = result }, error => {
      job.result = { error: 'SETUP_FAILED', detail: error instanceof Error ? error.message : 'Could not prepare this machine.' }
    })
    return job.result
  }
}
