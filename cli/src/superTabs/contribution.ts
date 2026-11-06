import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { parseProjectFolder, prepareProjectFolder } from '../lib/projectFolder.js'
import { readCapabilities, START_REQUIREMENTS } from './capacity.js'
import { backend, identifier, object, SuperTabHostError } from './host.js'
import { mkdir } from 'node:fs/promises'
import { readAuthSession } from '../lib/authSession.js'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { buildEngineInstallationArgv } from '../lib/engineLaunch.js'
import { engineInstallRecipe } from '../lib/engineInstall.js'
import { firstRunAnswered } from '../engines/launchPrep.js'
import { ownProcessGroup } from '../lib/windows/noWindow.js'
import { repairSwarmCloneTrust, swarmCloneRoot, swarmCloneRoots } from './cloneTrust.js'
import { SwarmReads } from './swarmReads.js'

type Json = Record<string, unknown>

interface ContributionDeps {
  backend: typeof backend; open: typeof openDaemon; prepare: typeof prepareProjectFolder; capacity: typeof readCapabilities; team?: () => boolean
  /** The daemon's Swarm reads (superTabs/swarmReads.ts); a one-off read of its own when none is given. */
  reads?: SwarmReads
  install: typeof installClaudeCode
  /** Whether Claude Code's questions before an agent's first turn are answered here (engines/launchPrep.ts). */
  firstRun: () => boolean | null
}
const CONTRIBUTION_DEPS = { backend, open: openDaemon, prepare: prepareProjectFolder, capacity: readCapabilities, install: installClaudeCode,
  firstRun: () => firstRunAnswered('claude') }

/** How long Claude Code's install may take here before the setup gives up on it: as long as a pane's installer gets
 *  (engines/kit/nativeInstall.ts). Over a slow Wi-Fi it took more than 5 minutes (the Dell, 2026-11-05). */
const INSTALL_FOR_MS = 20 * 60_000

/** The install under way, which a second setup joins: two npm installs into one prefix fight over its files. */
let installing: Promise<void> | undefined

/** Installs Claude Code on this machine with its vendor's own line (lib/engineInstall.ts), in the shell a pane installs it
 *  from. Asked for by the phone setting up a new computer, so its Buddy can start there (owner, 2026-11-05): the OS ships no
 *  Claude Code of its own. Whether it worked is the engine probe's to say, not the installer's exit. */
export function installClaudeCode(run: typeof spawn = spawn): Promise<void> {
  installing ??= runClaudeCodeInstall(run).finally(() => { installing = undefined })
  return installing
}

async function runClaudeCodeInstall(run: typeof spawn): Promise<void> {
  const recipe = engineInstallRecipe('claude')
  if (!recipe || process.platform === 'win32') throw new Error('Install Claude Code on this machine, then try again.')
  const [command, ...args] = buildEngineInstallationArgv('claude', recipe, { HOME: homedir() })
  await new Promise<void>((resolve, reject) => {
    // A group of its own, ended whole at the deadline as the pane's installer is (engines/kit/nativeInstall.ts): the shell
    // alone killed left npm running, and the next try's install fought it over the prefix.
    const child = run(command!, args, { stdio: 'ignore', ...ownProcessGroup() })
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      reject(new Error('Installing Claude Code took too long. Try again.'))
    }, INSTALL_FOR_MS)
    child.on('error', (error) => { clearTimeout(deadline); reject(error) })
    child.on('close', () => { clearTimeout(deadline); resolve() })
  })
}

/** The most agents a machine may offer: one for every 2 GB of total RAM, and 4 whatever its RAM (Ken, 2026-10-28: the cap
 * of 16 held a 192 GB Mac Studio to a sixth of that). 1024 is the most the server accepts (backend superTabs/commands.ts). */
export const machineMaximum = (memoryTotalBytes: number): number =>
  Math.min(1024, Math.max(4, Math.floor(memoryTotalBytes / START_REQUIREMENTS.memoryBytes)))

/** The owner's own request to the server, as Desktop and `harness super-tab set-agents` send it. A server from before 1024
 * (2026-10-28) refuses a machine offered with more than 16 agents; that machine is offered with 16 instead of not at all.
 * The server checks the number before it records the operation, so the second send under the same operation is still
 * the first that counts. `offered16` says it happened. */
export async function ownerRequest(core: CoreApi, method: string, path: string, body: unknown, send: typeof backend = backend): Promise<{ value: unknown; offered16: boolean }> {
  try { return { value: await send(core, method, path, body), offered16: false } } catch (error) {
    const command = object(object(body).command)
    if (method !== 'POST' || !/^\/api\/super-tabs\/[A-Za-z0-9_-]+\/commands$/.test(path) || command.type !== 'machine.contribute'
      || typeof command.maxAgents !== 'number' || command.maxAgents <= 16 || !(error instanceof SuperTabHostError)
      || error.status !== 400 || error.code !== 'VALIDATION_ERROR' || !/^command\.maxAgents: .*\b16\b/.test(error.message)) throw error
    return { value: await send(core, method, path, { ...object(body), command: { ...command, maxAgents: 16 } }), offered16: true }
  }
}

/** `harness super-tab set-agents`: the owner sets how many Swarm agents may run on one of their machines at once, without
 * Desktop. Only the number changes; the machine's name, folder and engines are sent again as the Swarm has them, since
 * the server takes a machine's settings whole. The server checks that the person owns the machine. */
export async function setMachineAgents(core: CoreApi, input: { tabId: string; machineId: string; maxAgents: number },
  deps: { backend: typeof backend; reads?: SwarmReads } = { backend }): Promise<Json> {
  const { state } = await (deps.reads ?? new SwarmReads(core, { backend: deps.backend })).read(input.tabId)
  const machine = (Array.isArray(state.machines) ? state.machines.map(object) : []).find(m => m.machineId === input.machineId)
  if (!machine) return { error: 'MACHINE_NOT_FOUND', detail: 'This machine is not in this Swarm. Add it from Desktop first.' }
  const name = typeof machine.name === 'string' ? machine.name : input.machineId
  // A paused machine stays paused: the server keeps its pause when its settings are sent again (backend superTabs/commands.ts,
  // since #2091). A server from before that resumed it, so this ships after that server.
  const total = object(object(machine.observation).resources).memoryTotalBytes
  if (typeof total !== 'number') return { error: 'MACHINE_MEMORY_UNKNOWN', detail: `${name} has not reported its memory yet. Try again once it is online.` }
  const maximum = machineMaximum(total)
  if (input.maxAgents > maximum) {
    return { error: 'ABOVE_MACHINE_MAXIMUM', detail: `${name} can offer at most ${maximum} agents: one for every 2 GB of its memory, and at least 4.` }
  }
  // A machine added before Swarms ran only Claude Code and Codex still lists every engine it had; the server takes those two.
  const engines = (Array.isArray(machine.engines) ? machine.engines : []).filter(e => e === 'claude' || e === 'codex')
  if (!engines.length) return { error: 'NO_SWARM_ENGINE', detail: `${name} runs neither Claude Code nor Codex. Configure it from Desktop.` }
  const command = { type: 'machine.contribute', machineId: input.machineId, name, cwd: machine.cwd,
    // A number set here is its owner's own At most (backend superTabs/machines.ts agentLimit, #2860).
    ...(machine.scope === 'swarm' ? { scope: 'swarm' } : {}), engines, maxAgents: input.maxAgents, agents: 'atMost' }
  const sent = await ownerRequest(core, 'POST', `/api/super-tabs/${input.tabId}/commands`,
    { operationId: `machine-agents-${randomUUID()}`, command }, deps.backend)
  return { ok: true, machineId: input.machineId, maxAgents: sent.offered16 ? 16 : input.maxAgents, maximum,
    ...(sent.offered16 ? { notice: `This Swarm's server takes at most 16 agents per machine, so ${name} now offers 16. Update the server to offer more.` } : {}) }
}

/** Owner-only setup. Reuses the regular checkout preparation and engine probe;
 * it neither launches an agent nor grants the team access to the computer. */
export async function prepareContribution(core: CoreApi, input: Json, given: Partial<ContributionDeps> = {}): Promise<Json> {
  const deps: ContributionDeps = { ...CONTRIBUTION_DEPS, ...given }
  if (!identifier(input.tabId)) throw new Error('Choose a Super Tab.')
  // A Mac's Harness Team account reads no Swarm as the person (backend lib/teamSession.ts). Its Mac's daemon adds it, as a
  // swarm workspace in its own clone root (host.ts joinTeams), so it needs no read ("One machine" in
  // docs/plans/2026-10-24-swarm-team-account.md).
  const team = (deps.team ?? (() => readAuthSession()?.kind === 'team'))()
  if (team && input.scope !== 'swarm') throw new Error('A Harness Team account joins a Swarm only as a swarm workspace.')
  const state = team ? {} : (await (deps.reads ?? new SwarmReads(core, { backend: deps.backend })).read(input.tabId)).state
  const project = object(state.project)
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
    const probe = () => connection.request('engines_probe', { engines: ['claude', 'codex'], accounts: true }, 20_000)
    const installed = (answer: Json) => (Array.isArray(answer.engines) ? answer.engines.map(object) : [])
      .filter(e => (e.engine === 'claude' || e.engine === 'codex') && e.installed === true)
      .map(e => e.engine as string)
    const [first, capability] = await Promise.all([probe(), deps.capacity({ cwd, tools: ['git'], devices: [] })])
    let answer = first, engines = installed(answer)
    // The phone setting up a new computer (`installEngine`): with neither engine here, Claude Code is installed now, so the
    // Buddy it starts next is admitted (capacity.ts admission). Anyone else is told to install one.
    if (!engines.length && input.installEngine === 'claude') {
      await deps.install()
      answer = await probe()
      engines = installed(answer)
    }
    // Which of them are signed in, so that phone asks for Claude's sign-in before the Buddy waits on it.
    const signedIn = (Array.isArray(answer.engines) ? answer.engines.map(object) : [])
      .filter(e => engines.includes(e.engine as string) && e.signedIn === true).map(e => e.engine as string)
    if (!engines.length) throw new Error('Install Claude Code or Codex on this machine, then try again.')
    const resources = object('resources' in capability ? capability.resources : null)
    if (capability.ok !== true || typeof resources.projectDiskFreeBytes !== 'number') throw new Error('The project folder is unavailable on this machine.')
    const total = typeof resources.memoryTotalBytes === 'number' ? resources.memoryTotalBytes : 0
    // Free memory is checked again for every start. It must not shrink the machine's
    // configured limit just because other work happens to be running during setup.
    // The suggestion keeps its 16, so a machine that joins by itself still sends what a server from before 1024 accepts.
    const maxAvailableAgents = machineMaximum(total)
    const maxAgents = Math.max(1, Math.min(16, Math.floor(total / (2 * START_REQUIREMENTS.memoryBytes))))
    // Claude Code here with its first-run screens still to answer: the phone answers them, then `claudeFirstRun` records them,
    // rather than its first Buddy waiting on its screen with nobody there (owner, 2026-11-06).
    const firstRun = engines.includes('claude') && deps.firstRun() === false ? { firstRun: ['claude'] } : {}
    return { ok: true, state: 'ready', cwd, engines: [...new Set(engines)], signedIn: [...new Set(signedIn)], ...firstRun, maxAgents, maxAvailableAgents,
      ...(swarm ? { scope: 'swarm' } : {}) }
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
