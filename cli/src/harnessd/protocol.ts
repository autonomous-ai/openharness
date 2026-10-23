/**
 * What harnessd's master and its core say to each other over the spawn channel (Node IPC).
 *
 * Small on purpose. The core says when it is bound, when it is ready and that it is alive; the master
 * tells it its own status, and when an update is staged, to hand over. The updater, a process the master
 * runs (services/updaterProcess.ts), says when it has staged one. Everything else the daemon does goes
 * through the core's local API, never through here.
 *
 * Messages are only ever added, and a side ignores what it does not know: during an update an older
 * master supervises a newer core, and after a rollback a newer master supervises an older one. Each
 * core states its protocol in `bound`, and the master holds it to what that version can say — a
 * protocol 1 core has no `ready`.
 */
import type { SupervisorStatus } from './supervisor.js'

/** 2: `ready`, the event-loop delay on the heartbeat, and the exit-code contract below. 3: `want`, and the
 *  master's updater: the master tells its core to hand over for a build its updater staged (`harnessd:update`).
 *  4: `want` for the devices' process too, which runs only once there is a device, for models', which runs
 *  only once grid is in use here or a request needs it, and for the gateway's, which runs once this machine is
 *  signed in, has anything paired or needs it; and `want` before `bound` (./services.ts `askedSince`).
 *  5: `want` for the viewers' process (the harness viewers and the Store), which runs once a harness is here, a
 *  request needs it or the release's own harnesses are to be put in place (core/viewersWake.ts).
 *  6: `stop`, the core asking its master to stop everything (`harness stop` on Windows, where the CLI has no signal
 *  to send the master), and `shutdown`, the master asking the core or a service to leave, where a signal cannot:
 *  on Windows Node's `kill` is TerminateProcess, whatever the signal, and nothing would be torn down. */
export const HARNESSD_PROTOCOL = 6

/** The command a bundle's master answers its probe on, and what it answers. */
export const PROBE_COMMAND = '__harnessd-probe'
export const PROBE_ANSWER = 'harnessd-probe ok'
/** Added to the answer by a master that takes a handover (Windows, ./reexec.ts `HandOverDeps`): one from before would
 *  be handed the state, never take the handover, and run beside the master that handed over. */
export const PROBE_HANDOVER = 'takes a handover'
/** How long a probe may take: the updater gives its canary as long. */
export const PROBE_TIMEOUT_MS = 15_000

/**
 * Handed by a master to a core it starts from the lean bundle (./leanBundle.ts): the cli.js that bundle
 * was read from. The core's own file is then the lean bundle's, which runs no command but the daemon's,
 * and everything the core hands on (the hooks it installs, the CLI it writes into agents' panes, a
 * successor it starts on an update) must name the CLI (leanCoreEntry.ts).
 */
export const LEAN_CORE_SCRIPT_ENV = 'HARNESSD_CORE_SCRIPT'

/** The exit code a core uses to be restarted at once on the bundle now on disk (a staged update). */
export const CORE_EXIT_UPDATE = 75

/**
 * The exit code a core uses to stop for good — this computer was removed from its account, or it is
 * connected from another one — so the master stops with it. Any other exit is a crash, 0 included: Node
 * also exits 0 when its event loop runs out of work, and a SIGTERM from outside must not take the daemon
 * down. (Protocol 1 cores stopped for good with 0.)
 */
export const CORE_EXIT_STOP = 78

/**
 * How long a master waits for one more beat once a process's silence has run out, counted from then:
 * a third of the silence, the longest a core or service ever goes between beats
 * (`coreLink.heartbeatInterval`), so one that was only paused along with its master always lands one.
 * Why there is a wait at all: `Supervisor.watchHeartbeat`.
 */
export function heartbeatGraceMs(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 3)
}

export type CoreMessage =
  /** The control port is bound: from here on the daemon answers, though start-up is not done. */
  | { type: 'harnessd:bound'; protocol: number; port: number }
  /** Start-up is done and requests are being served (protocol 2) — or, with `safeMode`, start-up gave
   *  way to safe mode: the updater alone runs, waiting for a fix. */
  | { type: 'harnessd:ready'; safeMode?: string }
  /** Sent every few seconds; a core that stops sending is hung. `loopDelayMs`: the longest the event
   *  loop was held since the last one (protocol 2). */
  | { type: 'harnessd:heartbeat'; rssBytes: number; heapUsedBytes: number; loopDelayMs?: number }
  /** Start the process that runs this service (harnessd/services.ts `onDemand`): an experiment that is on now
   *  (protocol 3), the devices, models or the gateway, now that they are needed (protocol 4, and before
   *  `bound` too), or the viewers (protocol 5). A master from before ignores it, or finds that process already
   *  running, having started it at once. */
  | { type: 'harnessd:want'; service: string }
  /** Stop the services, this core and the master, and stay stopped (protocol 6): `harness stop` asked this core
   *  over its pipe (core/daemonStopRoute.ts). A master from before ignores it; the CLI then ends it. */
  | { type: 'harnessd:stop' }

export type MasterMessage =
  | { type: 'harnessd:status'; status: SupervisorStatus }
  /** The updater staged `version`: hand over for it, as a core whose own updater staged it did (exit 75). */
  | { type: 'harnessd:update'; version: string }
  /** Leave, as on SIGTERM (protocol 6): what the master says where it has no signal to send (Windows). A process
   *  from before ignores it, and is ended once its grace is over, as one that ignored SIGTERM was. */
  | { type: 'harnessd:shutdown' }

/** What the updater says to the master: it staged CLI build `version`, terminal host `ptyVersion` (Windows), or both,
 *  on disk, for one handover. At least one of the two is there. A master from before takes only `version`. */
export type UpdaterMessage = { type: 'harnessd:staged'; version?: string; ptyVersion?: string }

/** What one `harnessd:staged` staged, with each part there only when it was. */
export interface StagedUpdate { version?: string; ptyVersion?: string }

/** `9.9.9`, `terminal host 0.11.0`, or `9.9.9 and terminal host 0.11.0`: what a log line says was staged. */
export function describeStaged(staged: StagedUpdate): string {
  return [staged.version, staged.ptyVersion && `terminal host ${staged.ptyVersion}`].filter(Boolean).join(' and ')
}

/** The exit code a service uses to be started again at once, on the bundle now on disk, without counting
 *  as a crash: the updater, once it has staged a build, so that it next runs as that build. */
export const SERVICE_EXIT_RESTART = 75

export function isUpdaterMessage(value: unknown): value is UpdaterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type !== 'harnessd:staged') return false
  const parts = [message.version, message.ptyVersion]
  return parts.every((part) => part === undefined || typeof part === 'string') && parts.some((part) => typeof part === 'string' && part.length > 0)
}

export function isCoreMessage(value: unknown): value is CoreMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'harnessd:bound':
      return Number.isInteger(message.protocol) && Number.isInteger(message.port)
    case 'harnessd:ready':
      return message.safeMode === undefined || typeof message.safeMode === 'string'
    case 'harnessd:heartbeat':
      return typeof message.rssBytes === 'number' && typeof message.heapUsedBytes === 'number'
        && (message.loopDelayMs === undefined || typeof message.loopDelayMs === 'number')
    case 'harnessd:want':
      return typeof message.service === 'string' && message.service.length > 0
    case 'harnessd:stop':
      return true
    default:
      return false
  }
}

export function isMasterMessage(value: unknown): value is MasterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type === 'harnessd:update') return typeof message.version === 'string' && message.version.length > 0
  if (message.type === 'harnessd:shutdown') return true
  return message.type === 'harnessd:status' && !!message.status && typeof message.status === 'object'
}
