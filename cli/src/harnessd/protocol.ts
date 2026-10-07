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
 *  4: `want` for the devices' process too, which runs only once there is a device (./services.ts `askedSince`). */
export const HARNESSD_PROTOCOL = 4

/** The command a bundle's master answers its probe on, and what it answers. */
export const PROBE_COMMAND = '__harnessd-probe'
export const PROBE_ANSWER = 'harnessd-probe ok'
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
   *  (protocol 3), or the devices, now that there is one (protocol 4). A master from before ignores it, having
   *  started every service at once. */
  | { type: 'harnessd:want'; service: string }

export type MasterMessage =
  | { type: 'harnessd:status'; status: SupervisorStatus }
  /** The updater staged `version`: hand over for it, as a core whose own updater staged it did (exit 75). */
  | { type: 'harnessd:update'; version: string }

/** What the updater says to the master: it staged `version` on disk. */
export type UpdaterMessage = { type: 'harnessd:staged'; version: string }

/** The exit code a service uses to be started again at once, on the bundle now on disk, without counting
 *  as a crash: the updater, once it has staged a build, so that it next runs as that build. */
export const SERVICE_EXIT_RESTART = 75

export function isUpdaterMessage(value: unknown): value is UpdaterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === 'harnessd:staged' && typeof message.version === 'string' && message.version.length > 0
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
    default:
      return false
  }
}

export function isMasterMessage(value: unknown): value is MasterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type === 'harnessd:update') return typeof message.version === 'string' && message.version.length > 0
  return message.type === 'harnessd:status' && !!message.status && typeof message.status === 'object'
}
