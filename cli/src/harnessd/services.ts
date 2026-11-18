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

// Full legacy histories exceed 16 KiB; see docs/design/2026-11-16-git-frame-facts.md.
export const FRAME_PART_BYTES = 2 * 1024 * 1024
export const FRAME_PART_VALUES = 16_384
export const FRAME_PART_TOTAL_BYTES = 4 * 1024 * 1024
export const FRAME_PART_ENTRIES = 4096

export type LocalWindowPermissions = Readonly<Partial<Record<'all' | 'first' | 'connection', readonly string[]>>>

export interface ServiceSpec {
  /** The process's name: what the master logs it as, and the hard link it is started through (`harnessd-<name>`,
   *  ./processName.ts). */
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
  /** What happens to agents that this process's services must not miss while it is down, by service: the core holds
   *  each of these for that service from its own start until the service hears it (core/agentLife.ts). */
  hears?: Readonly<Record<string, readonly HeldAgentLife[]>>
  /** Display fields a service may publish, and row fields required while they are shown. */
  frameParts?: Readonly<Record<string, { fields: readonly string[]; having?: readonly string[] }>>
  /** Local app delivery rights, bound to the authenticated service and selection. */
  windows?: Readonly<Record<string, LocalWindowPermissions>>
}

/** The kinds of what happens to an agent that a service in its own process can be held (core/api.ts `AgentLife`): a stop
 *  a person or an agent made, a purge, and a new agent in the pane one ended in. */
export type HeldAgentLife = 'stopped' | 'purged' | 'taken' | 'input'

/** A process the services run in: the services it hosts, and its memory budget. */
export type ServiceHostSpec = Omit<ServiceSpec, 'name'>

/**
 * The processes this build runs its services in, with their memory budgets: every one, unless
 * `HARNESSD_SERVICES` names a subset (`search,viewers`) or `none` (see `servicePlan.ts` `serviceSpecs`). A service that
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
  // Installation journals and executable probes cannot block core or unrelated edge services. Older cores
  // prepare launches inline and never ask; this process costs nothing until its first setup request.
  engineSetup: { services: ['engineSetup'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true, askedSince: 0 },
  // Engine workers have no older-core startup obligation: old cores run these facets inline and never ask.
  // Each holds at most four reads, a 128-entry pager and replies capped at 4 MiB. The heap limit
  // contains transient parsing; RSS additionally bounds file buffers outside V8's heap.
  'engine-claude': { services: ['engine-claude'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  'engine-codex': { services: ['engine-codex'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  // The fourteen other engines in one worker (engines/others/otherEnginesProcess.ts): their conversations read from their
  // transcripts and stores, at most sixteen reads at once with replies capped at 4 MiB, each engine's code loaded
  // only once one of its sessions is read. Started on demand, as theirs are: a computer that runs none never pays.
  'engine-others': { services: ['engine-others'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  // A purged conversation is never left searchable: its purge is held for search while it is down (core/agentLife.ts).
  search: { services: ['search'], heapLimitMiB: 1_024, rssLimitMiB: 2_048, hears: { search: ['purged'] } },
  // Its file watches on every harness's workspace; the viewer servers it starts are processes of their
  // own, outside this budget. The Store beside them: its installs run git and the harnesses' toolchains
  // in their own processes too, and take minutes, which is what it must not spend in the core.
  // Started only once something needs it (core/viewersWake.ts): a harness here, a Store or viewer request, or
  // orphan viewer servers. Bundled consumers prepare on first use outside core. It idled at about 96 MiB on every computer, and few harnesses
  // have a viewer: 1 of 14 on one real machine, 2 of 35 on another (2026-10-12).
  viewers: { services: ['viewers', 'store'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 5,
    frameParts: { viewers: { fields: ['dsh', 'dshName', 'viewerUrl', 'viewerName', 'verdict'], having: ['dsh'] } } },
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
  // The engine probe (services/engineProbe.ts) holds this process's login-shell environment, read once; the shells
  // a probe starts, four at once, are processes of their own, outside this budget.
  // A harness stopped while the host is down still closes the harnesses it started: held for the cleanup.
  edge: { services: ['workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'windowNames', 'shell', 'connectors', 'sharedMachines', 'agentCleanup', 'messages', 'osDevice', 'goals', 'hachi', 'engineProbe'], heapLimitMiB: 384, rssLimitMiB: 768,
    hears: { agentCleanup: ['stopped', 'input'] }, frameParts: { workspaces: { fields: ['project', 'gitContext'] } } },
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
  gateway: { services: ['gateway'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 4, hears: { gateway: ['input', 'purged'] } },
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
  devices: { services: ['devices', 'wifi', 'machineAddons'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 4,
    windows: {
      devices: { all: ['dial_open', 'dial_notification_read', 'dial_forked', 'dial_focus', 'dial_swarm', 'dial_scroll', 'dial_status', 'voice_route_request'],
        connection: ['dial_selection', 'dial_visit', 'dial_form'] },
      wifi: { first: ['device_focus', 'device_prepare_open'] },
    } },
  // The agent browser (services/agentBrowserProcess.ts): its Podman calls, one `podman events` stream, an image build that
  // prints for minutes and a setup that waits on a password dialog. Chrome itself runs in Podman's containers, outside
  // this budget. Started only once a browser is wanted here (the shared stream declaration): a computer that never ticked
  // Browser never pays for it.
  // A purge and a pane's new agent are held for it while it is down: a deleted agent's login, and a pane's logins that go
  // with the pane (decision 19).
  agentBrowser: { services: ['agentBrowser'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 7, hears: { agentBrowser: ['purged', 'taken'] }, frameParts: { agentBrowser: { fields: ['browser'] } } },
}

/** Every service this build can run outside the core's process: what `HARNESSD_SERVICES` names. */
export const KNOWN_SERVICES: readonly string[] = Object.values(SERVICE_HOSTS).flatMap((host) => host.services)

/** What the core holds for each service of [outOfProcess] while it is down (`hears`), by service. A service in the
 *  core's process is told as it happens, and none is held for it. */
export function heldAgentLife(outOfProcess: ReadonlySet<string>, hosts: Readonly<Record<string, ServiceHostSpec>> = SERVICE_HOSTS): Record<string, readonly HeldAgentLife[]> {
  const held: Record<string, readonly HeldAgentLife[]> = {}
  for (const host of Object.values(hosts)) {
    for (const [service, kinds] of Object.entries(host.hears ?? {})) if (outOfProcess.has(service)) held[service] = kinds
  }
  return held
}

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
export const ENGINE_RESUME_REPAIR_ENV = 'HARNESSD_ENGINE_RESUME_REPAIR'
/**
 * What the other engines' worker serves, as a version: `<master pid>:<version>`. 1 is their history and last turn; 2
 * adds their live streams (engines/others/streams.ts), which a core under a master of 1 runs in its own process.
 * 3 adds runtime controls; 4 adds storage inspection and checkpoint export.
 * A version only grows, each one serving what the ones before it did: a core asks the worker only for what the
 * version its master says covers, and reads the rest in its own process, as under a master from before the worker.
 */
export const ENGINE_OTHERS_ENV = 'HARNESSD_ENGINE_OTHERS'
export const ENGINE_OTHERS_VERSION = 4

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
  return { [SERVICE_PROCESSES_ENV]: names, HARNESSD_SERVICES: names || 'none', [ENGINE_LIVE_ENV]: `${masterPid}:1`, [ENGINE_RUNTIME_ENV]: `${masterPid}:1`, [ENGINE_SCREEN_ENV]: `${masterPid}:1`, [ENGINE_MODEL_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_QUESTION_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_SUBMISSION_ENV]: `${masterPid}:1`, [ENGINE_NATIVE_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_BACKGROUND_JOB_ENV]: `${masterPid}:1`, [ENGINE_PROVIDER_MOVE_ENV]: `${masterPid}:1`, [ENGINE_RESUME_REPAIR_ENV]: `${masterPid}:1`, [ENGINE_OTHERS_ENV]: `${masterPid}:${ENGINE_OTHERS_VERSION}` }
}

/**
 * The version of the other engines' worker this core's master runs (`ENGINE_OTHERS_ENV`), 0 for none: a master from
 * before it, no master, or an environment another master left, which names its pid and not this core's parent.
 */
export function otherEnginesVersion(env: NodeJS.ProcessEnv, parentPid: number): number {
  if (env.HARNESSD_SUPERVISED !== '1' || !env.HARNESSD_SERVICE_TOKEN) return 0
  const said = /^(\d+):([1-9]\d{0,5})$/.exec(env[ENGINE_OTHERS_ENV] ?? '')
  return said && said[1] === String(parentPid) ? Number(said[2]) : 0
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

/** Compatibility with masters before 2026-11-15; review inline repair removal on 2026-12-15. */
export function masterRunsEngineResumeRepair(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_RESUME_REPAIR_ENV] === `${parentPid}:1`
}

/** A new core must not send an older worker host a stop its Codex worker cannot speak. */
export function masterRunsEngineNativeControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_NATIVE_CONTROL_ENV] === `${parentPid}:1`
}
