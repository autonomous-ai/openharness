import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { parseProjectFolder, prepareProjectFolder } from '../lib/projectFolder.js'
import { readCapabilities, START_REQUIREMENTS } from './capacity.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'
import { mkdir } from 'node:fs/promises'
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
  backend: typeof backend; open: typeof openDaemon; prepare: typeof prepareProjectFolder; capacity: typeof readCapabilities
  /** The daemon's Swarm reads (superTabs/swarmReads.ts); a one-off read of its own when none is given. */
  reads?: SwarmReads
  install: typeof installEngine
  /** Whether Claude Code's questions before an agent's first turn are answered here (engines/launchPrep.ts). */
  firstRun: () => boolean | null
}
const CONTRIBUTION_DEPS = { backend, open: openDaemon, prepare: prepareProjectFolder, capacity: readCapabilities, install: installEngine,
  firstRun: () => firstRunAnswered('claude') }

/** The engines the phone may ask installed as it sets a computer up (owner, 2026-11-06: Codex as well as Claude Code). */
type SetupEngine = 'claude' | 'codex'
const ENGINE_NAME: Record<SetupEngine, string> = { claude: 'Claude Code', codex: 'Codex' }

/** How long an engine's install may take here before the setup gives up on it: as long as a pane's installer gets
 *  (engines/kit/nativeInstall.ts). Over a slow Wi-Fi it took more than 5 minutes (the Dell, 2026-11-05). */
const INSTALL_FOR_MS = 20 * 60_000

/** Each engine's install under way, which a second setup asking for it joins. */
const installing = new Map<SetupEngine, Promise<void>>()
/** The last install, which the next one waits for: two npm installs into one prefix fight over its files. */
let lastInstall: Promise<unknown> = Promise.resolve()

/** Installs [engine] on this machine with its vendor's own line (lib/engineInstall.ts), in the shell a pane installs it
 *  from. Asked for by the phone setting up a new computer, so an agent can start there (owner, 2026-11-05): the OS ships no
 *  engine of its own. Whether it worked is the engine probe's to say, not the installer's exit. */
export function installEngine(engine: SetupEngine = 'claude', run: typeof spawn = spawn): Promise<void> {
  const under = installing.get(engine)
  if (under) return under
  const next = lastInstall.catch(() => {}).then(() => runEngineInstall(engine, run)).finally(() => { installing.delete(engine) })
  installing.set(engine, next)
  lastInstall = next
  return next
}

async function runEngineInstall(engine: SetupEngine, run: typeof spawn): Promise<void> {
  const recipe = engineInstallRecipe(engine)
  if (!recipe || process.platform === 'win32') throw new Error(`Install ${ENGINE_NAME[engine]} on this machine, then try again.`)
  const [command, ...args] = buildEngineInstallationArgv(engine, recipe, { HOME: homedir() })
  await new Promise<void>((resolve, reject) => {
    // A group of its own, ended whole at the deadline as the pane's installer is (engines/kit/nativeInstall.ts): the shell
    // alone killed left npm running, and the next try's install fought it over the prefix.
    const child = run(command!, args, { stdio: 'ignore', ...ownProcessGroup() })
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      reject(new Error(`Installing ${ENGINE_NAME[engine]} took too long. Try again.`))
    }, INSTALL_FOR_MS)
    child.on('error', (error) => { clearTimeout(deadline); reject(error) })
    child.on('close', () => { clearTimeout(deadline); resolve() })
  })
}

/** The most agents a machine may offer: one for every 2 GB of total RAM, and 4 whatever its RAM (Ken, 2026-10-28: the cap
 * of 16 held a 192 GB Mac Studio to a sixth of that). 1024 is the most the server accepts (backend superTabs/commands.ts). */
export const machineMaximum = (memoryTotalBytes: number): number =>
  Math.min(1024, Math.max(4, Math.floor(memoryTotalBytes / START_REQUIREMENTS.memoryBytes)))

/** The owner's own request to the server, as Desktop sends it. A server from before 1024
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

/** Owner-only setup. Reuses the regular checkout preparation and engine probe;
 * it neither launches an agent nor grants the team access to the computer. */
export async function prepareContribution(core: CoreApi, input: Json, given: Partial<ContributionDeps> = {}): Promise<Json> {
  const deps: ContributionDeps = { ...CONTRIBUTION_DEPS, ...given }
  if (!identifier(input.tabId)) throw new Error('Choose a Super Tab.')
  const state = (await (deps.reads ?? new SwarmReads(core, { backend: deps.backend })).read(input.tabId)).state
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
    // The phone setting up a new computer (`installEngine`): the engine the person picked, Claude Code or Codex, is
    // installed now when it is not here, so the agent it starts next is admitted (capacity.ts admission); one here
    // already is not installed again (owner, 2026-11-06). Anyone else is told to install one.
    const wanted = input.installEngine === 'claude' || input.installEngine === 'codex' ? input.installEngine : null
    if (wanted && !engines.includes(wanted)) {
      await deps.install(wanted)
      answer = await probe()
      engines = installed(answer)
    }
    // Which of them are signed in, so that phone asks for the sign-in before an agent waits on it.
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
    // rather than its first agent waiting on its screen with nobody there (owner, 2026-11-06).
    const firstRun = engines.includes('claude') && deps.firstRun() === false ? { firstRun: ['claude'] } : {}
    return { ok: true, state: 'ready', cwd, engines: [...new Set(engines)], signedIn: [...new Set(signedIn)], ...firstRun, maxAgents, maxAvailableAgents,
      ...(swarm ? { scope: 'swarm' } : {}) }
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
