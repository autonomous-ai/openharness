/**
 * harnessd's services: the processes they run in, and what a master tells the core it runs.
 *
 * A service is a feature the core can run without (search, devices, models, …). In the core's process a
 * service's exception is caught (core/serviceHost.ts), but a native crash, a hung event loop or a leak
 * would still take the core with it. Out in a process of its own a service can only take that process down,
 * and the services that share it (`SERVICE_HOSTS`).
 *
 * The master and the core both read this file, so it holds no supervision: what keeps these processes
 * running is ./serviceSupervisor.ts, the master's alone. The core's process loaded that, and the core's
 * supervisor with it, for the table below (the audit of 2026-11-12).
 */
import { SWARM_ENV, swarmOn } from './swarmSwitch.js'

export interface ServiceSpec {
  /** The process's name: what the master logs it as and the process is titled (`harnessd <name>`). */
  name: string
  /** The services it runs, as `harness __service <a>,<b>` names them, each on its own link to the core. */
  services: readonly string[]
  /** The V8 heap limit it runs with, MiB; its budget is a share of it. */
  heapLimitMiB: number
  /** Resident memory past which it is restarted, MiB; 0: off. */
  rssLimitMiB: number
  /** A process on demand (an experiment's, the devices', the viewers'): not started with the others, only once
   *  the core asks for one of its services (`want`), and then kept running like any other. */
  onDemand?: boolean
  /** The core protocol (./protocol.ts) from which a core asks for this process on demand; 3, the experiments',
   *  when unset. A core that speaks an older one never asks for it, and it is started as that core binds. */
  askedSince?: number
}

/** A process the services run in: the services it hosts, and its memory budget. */
export type ServiceHostSpec = Omit<ServiceSpec, 'name'>

/**
 * The processes this build runs its services in, with their memory budgets: every one, unless
 * `HARNESSD_SERVICES` names a subset (`search,viewers`) or `none` (see `serviceSpecs`). A service that
 * is not out here runs inside the core's process, behind the service host's guard, as before.
 *
 * A process per risk, not per feature (docs/design/2026-10-06-core-boundary-next.md, "The target
 * shape"): native code (search's `node:sqlite`), memory and child-process herds (the viewers' servers)
 * each get their own, so one feature cannot take another down. The light services are pure JavaScript
 * answering requests, and share one: a fault in one can cost the others in the edge host, never the
 * core, and the master restarts the host. Each is one process of about 60 MiB at idle; apart, they
 * would cost that four times.
 */
export const SERVICE_HOSTS: Readonly<Record<string, ServiceHostSpec>> = {
  // Engine workers have no older-core startup obligation: old cores run these facets inline and never ask.
  // Each holds at most four reads, a 128-entry pager and replies capped at 4 MiB. The heap limit
  // contains transient parsing; RSS additionally bounds file buffers outside V8's heap.
  'engine-claude': { services: ['engine-claude'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  'engine-codex': { services: ['engine-codex'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  search: { services: ['search'], heapLimitMiB: 1_024, rssLimitMiB: 2_048 },
  // Its file watches on every harness's workspace; the viewer servers it starts are processes of their
  // own, outside this budget. The Store beside them: its installs run git and the harnesses' toolchains
  // in their own processes too, and take minutes, which is what it must not spend in the core.
  // Started only once something needs it (core/viewersWake.ts): a harness here, a Store or viewer request, or
  // the release's own harnesses to put in place. It idled at about 96 MiB on every computer, and few harnesses
  // have a viewer: 1 of 14 on one real machine, 2 of 35 on another (2026-10-12).
  viewers: { services: ['viewers', 'store'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 5 },
  // The git work (workspaces, the project readers) runs in git's own processes, and the monitor's
  // samples in ps's and ioreg's; what it holds is the agents the core sent it and one parsed sample.
  // The monitor parses up to 8 MB of ioreg output per Monitor poll on a Mac with a GPU, hence more
  // than workspaces alone had. The recaps hold each session's last three recaps, answers (8 KiB each at
  // most) and asks, as the core did while they ran in it, and a few timers per open turn. The window
  // names hold at most 400 short names; their model runs in its own process (lib/oneshot.ts). The agent cleanup
  // holds the harnesses the person joined (a thousand ids at most) and looks at the live ones once a minute.
  // Agent Messages (services/messagesProcess.ts) holds its mailbox, the last 2,000 messages of each tab and the
  // account's tabs, and runs no timer while it is off here or this computer is signed out. It had a process of its
  // own as an experiment, 62 MiB resident at idle on every computer it was on, nearly all of it a second Node and
  // the bundle rather than messaging: here it costs the edge host about 1 MiB on, and 0.4 MiB off
  // (e2e/footprint.e2e.ts, 2026-10-12). The Harness OS computer's management (services/osDevice.ts) holds one
  // timestamp and runs its commands bounded, or detached when they must outlive this process.
  edge: { services: ['workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'windowNames', 'shell', 'connectors', 'sharedMachines', 'agentCleanup', 'messages', 'osDevice', 'goals', 'hachi'], heapLimitMiB: 384, rssLimitMiB: 768 },
  // The orchestrator (services/orchestratorProcess.ts), an experiment: started only once it is on, for a
  // saved project or a request (core/api.ts `EXPERIMENTS`). Its projects' files and the frames of their
  // Directors; the agents it runs are the core's.
  orchestrator: { services: ['orchestrator'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true },
  // Memories (services/memoryProcess.ts), an experiment: started at its first request, another machine's
  // Memories pane asking. It runs the Memories package's own command: writes one at a time, snapshots
  // asked together as one read, each answer at most 8 MB.
  memory: { services: ['memory'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true },
  // The router (services/routerProcess.ts), an experiment: started at its first request. A few decisions in
  // flight, each one bounded Jev answer.
  router: { services: ['router'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true },
  superTabs: { services: ['superTabs'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true },
  // Cloud agents (services/cloudProcess.ts), an experiment: started once one is on, for a saved harness or a
  // request. A timer and a bounded look per working harness, and each conversation read a file at a time.
  cloud: { services: ['cloud'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true },
  // Share, an experiment (services/sharingProcess.ts): its invitations, its observers' sessions and their
  // ciphers; the headless Chrome it captures a shared viewer in is a process of its own, outside this budget.
  sharing: { services: ['sharing'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true },
  // The relay and its E2EE (gateway/gatewayProcess.ts): the backend link, every remote client's session,
  // the terminals' WebRTC channels and their queues. Network, crypto and pure-JS WebRTC, the attack surface,
  // where a fault costs the remote clients and nothing else (docs/design/2026-10-06-core-boundary-next.md).
  // Started as the core starts when it is signed in or anything is paired here, and otherwise by the first
  // thing that needs it (core/gatewayWake.ts): about 75 MiB at idle a computer signed out with nothing
  // paired never pays.
  gateway: { services: ['gateway'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 4 },
  // Grid's pictures, the Model Manager's catalog and the models found on this machine. Its downloads, model
  // servers and `grid` commands run in processes of their own, outside this budget. Started only once grid is
  // in use here or a request needs it (core/modelsWake.ts): about 70 MiB at idle, which a computer that uses
  // no grid never pays.
  models: { services: ['models'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 4 },
  // The devices (services/devicesProcess.ts): the dials on USB (pure-JS serial, a frame decoder whose buffer
  // is bounded per dial), the window bridges, the fleet's router and its lane, the voice router's engine
  // worker (a process of its own, outside this budget). Hardware that speaks whatever its firmware says:
  // what it costs, it costs here, never a session. The Wi-Fi device beside them (services/wifiProcess.ts),
  // on a link of its own: its receipts, its streams and its Store preparations. Started only once there is
  // a device, or a request for one (core/devicesWake.ts): about 72 MiB at idle, which a computer with none
  // never pays.
  devices: { services: ['devices', 'wifi', 'machineAddons'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 4 },
  // The agent browser (services/agentBrowserProcess.ts): its Podman calls, one `podman events` stream, an image build that
  // prints for minutes and a setup that waits on a password dialog. Chrome itself runs in Podman's containers, outside
  // this budget. Started only once a browser is wanted here (core/agentBrowserLink.ts): a computer that never ticked
  // Browser never pays for it.
  agentBrowser: { services: ['agentBrowser'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 7 },
}

/** Every service this build can run outside the core's process: what `HARNESSD_SERVICES` names. */
export const KNOWN_SERVICES: readonly string[] = Object.values(SERVICE_HOSTS).flatMap((host) => host.services)

/**
 * The updater's process (services/updaterProcess.ts): checks for a newer build of the CLI and of hn, and
 * downloads, verifies, canaries and stages it, then tells the master, which has the core hand over. Its own
 * process and never the core's: the core never downloads a build, and a core that cannot start (safe mode)
 * or a host whose services keep crashing must not stop the fix from arriving. Not one of `SERVICE_HOSTS`:
 * the core neither routes to it nor runs it, and `HARNESSD_SERVICES` does not turn it off; the master runs
 * it when it runs the installed copy with updates on (masterProcess.ts). It holds one download at a time.
 */
export const UPDATER_HOST: ServiceHostSpec = { services: ['updater'], heapLimitMiB: 256, rssLimitMiB: 512 }
export const UPDATER_PROCESS = 'updater' // the name the master runs it under: the one whose staged build counts

/** How a master tells the core it starts which services it runs in their own processes. */
export const SERVICE_PROCESSES_ENV = 'HARNESSD_SERVICE_PROCESSES'
/** Version of the live engine methods hosted by this master, independent of reader-only hosts. */
export const ENGINE_LIVE_ENV = 'HARNESSD_ENGINE_LIVE'
/** Runtime profile methods, negotiated independently from live transcript parsing. */
export const ENGINE_RUNTIME_ENV = 'HARNESSD_ENGINE_RUNTIME'
export const ENGINE_SCREEN_ENV = 'HARNESSD_ENGINE_SCREEN'
export const ENGINE_MODEL_CONTROL_ENV = 'HARNESSD_ENGINE_MODEL_CONTROL'
export const ENGINE_QUESTION_CONTROL_ENV = 'HARNESSD_ENGINE_QUESTION_CONTROL'
export const ENGINE_SUBMISSION_ENV = 'HARNESSD_ENGINE_SUBMISSION'
export const ENGINE_NATIVE_CONTROL_ENV = 'HARNESSD_ENGINE_NATIVE_CONTROL'
export const ENGINE_BACKGROUND_JOB_ENV = 'HARNESSD_ENGINE_BACKGROUND_JOB'
export const ENGINE_PROVIDER_MOVE_ENV = 'HARNESSD_ENGINE_PROVIDER_MOVE'

/**
 * What a master puts in its core's environment about the services it runs in their own processes: the
 * list, and `HARNESSD_SERVICES` set to the same (`none` for none), so that a core from before the list,
 * one this master finds back on disk after a rollback, reads the same answer for the services it knows
 * and runs none of them a second time.
 */
export function serviceProcessesEnv(specs: readonly ServiceSpec[], masterPid: number): Record<string, string> {
  // The services, not the processes: a core knows what it routes by service, and one from before the
  // edge host still finds the services it knows here (workspaces) and runs the rest itself.
  const names = specs.flatMap((spec) => spec.services).join(',')
  return { [SERVICE_PROCESSES_ENV]: names, HARNESSD_SERVICES: names || 'none', [ENGINE_LIVE_ENV]: `${masterPid}:1`, [ENGINE_RUNTIME_ENV]: `${masterPid}:1`, [ENGINE_SCREEN_ENV]: `${masterPid}:1`, [ENGINE_MODEL_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_QUESTION_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_SUBMISSION_ENV]: `${masterPid}:1`, [ENGINE_NATIVE_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_BACKGROUND_JOB_ENV]: `${masterPid}:1`, [ENGINE_PROVIDER_MOVE_ENV]: `${masterPid}:1` }
}

/** An older master may inherit a newer master's environment after rollback. Trust only this parent. */
export function masterRunsLiveEngines(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return env.HARNESSD_SUPERVISED === '1' && !!env.HARNESSD_SERVICE_TOKEN
    && env[ENGINE_LIVE_ENV] === `${parentPid}:1`
}

export function masterRunsEngineRuntime(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return env.HARNESSD_SUPERVISED === '1' && !!env.HARNESSD_SERVICE_TOKEN
    && env[ENGINE_RUNTIME_ENV] === `${parentPid}:1`
}

/**
 * The services the core's master runs in their own processes, which the core routes to and does not
 * run itself: what the master says it runs (`serviceProcessesEnv`), never what this build would choose.
 * A master too old to say runs exactly the services `HARNESSD_SERVICES` names, as every master did; a
 * core that worked it out from its own default instead took every service for out of process under a
 * released master that ran none, and answered search, the viewers, workspaces and the experiments
 * SERVICE_UNAVAILABLE until the master restarted (e2e/releaseRehearsal.e2e.ts). None without a master.
 */
export function servicesTheMasterRuns(env: NodeJS.ProcessEnv, known: readonly string[]): Set<string> {
  if (env.HARNESSD_SUPERVISED !== '1' || !env.HARNESSD_SERVICE_TOKEN) return new Set()
  const said = env[SERVICE_PROCESSES_ENV] ?? env.HARNESSD_SERVICES ?? ''
  return new Set(said.split(',').map((name) => name.trim()).filter((name) => known.includes(name)))
}

/** The Swarm switch (harnessd/swarmSwitch.ts): off, the Swarm's service is left out of every process the master starts. */
export { SWARM_ENV, swarmOn }
const SWARM_SERVICES: ReadonlySet<string> = new Set(['superTabs'])

/** The services of `known` that run on this computer, wherever they run: all of them, but the Swarm's while it is off. */
export function servicesOn(env: NodeJS.ProcessEnv, known: readonly string[]): string[] {
  return swarmOn(env) ? [...known] : known.filter((name) => !SWARM_SERVICES.has(name))
}

/**
 * The processes to run the services in: every service this build knows, unless `HARNESSD_SERVICES`
 * names a subset, by service (`search,workspaces`) or by process (`edge`, every service it hosts); `none`
 * (or empty) runs them all inside the core's process, for debugging or a quick way back. Isolation is
 * the point of the split (one service failing costs only its process), so it is the default, not an
 * opt-in. Each process hosts the services named of its own, and is not started for none. A process
 * named as one of its services is named whole: `viewers` runs the viewers' process, the Store beside
 * them, as it ran the viewers' before the Store joined it. `HARNESSD_SERVICE_HEAP_LIMIT_MIB` gives every
 * one the same heap limit instead (tests, support). A process on demand (`onDemand`: an experiment's, the
 * devices', the viewers') waits for the core to ask for it; named in `HARNESSD_SERVICES`, it starts with the others.
 */
export function serviceSpecs(env: NodeJS.ProcessEnv, hosts: Readonly<Record<string, ServiceHostSpec>>): ServiceSpec[] {
  const named = env.HARNESSD_SERVICES === undefined ? null
    : new Set(env.HARNESSD_SERVICES.split(',').map((name) => name.trim()).filter((name) => name && name !== 'none'))
  const heap = Number(env.HARNESSD_SERVICE_HEAP_LIMIT_MIB)
  const on = new Set(servicesOn(env, Object.values(hosts).flatMap((host) => host.services)))
  return Object.entries(hosts).flatMap(([name, host]) => {
    const services = host.services.filter((service) => on.has(service) && (!named || named.has(service) || named.has(name)))
    // A process on demand named outright runs from the start, as every service named does (a test, support).
    const onDemand = host.onDemand && !named ? { onDemand: true } : {}
    const { onDemand: _given, ...rest } = host
    return services.length ? [{ name, ...rest, services, ...onDemand, ...(Number.isInteger(heap) && heap > 0 ? { heapLimitMiB: heap } : {}) }] : []
  })
}

export function masterRunsEngineScreen(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_SCREEN_ENV] === `${parentPid}:1`
}

/** A new core must not route controls through an older worker host. */
export function masterRunsEngineModelControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_MODEL_CONTROL_ENV] === `${parentPid}:1`
}

export function masterRunsEngineQuestionControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_QUESTION_CONTROL_ENV] === `${parentPid}:1`
}

/** A new core must not ask an older worker host for submission readings it does not serve. */
export function masterRunsEngineSubmission(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_SUBMISSION_ENV] === `${parentPid}:1`
}

/** A new core must not ask an older worker host to stop a Claude Code background job its worker does not serve. */
export function masterRunsEngineBackgroundJob(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_BACKGROUND_JOB_ENV] === `${parentPid}:1`
}

/** A new core must not ask an older worker host for a provider move its Codex worker does not serve. */
export function masterRunsEngineProviderMove(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_PROVIDER_MOVE_ENV] === `${parentPid}:1`
}

/** A new core must not send an older worker host a stop its Codex worker cannot speak. */
export function masterRunsEngineNativeControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_NATIVE_CONTROL_ENV] === `${parentPid}:1`
}
