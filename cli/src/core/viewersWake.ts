/**
 * When the viewers' process starts (harnessd/services.ts `viewers`: the harness viewers and the Store, on demand since
 * protocol 5). It started with every daemon and idled at about 96 MiB, and few harnesses have a viewer: 1 of 14 on
 * one real machine, 2 of 35 on another (2026-10-12). So it starts once something needs it:
 *
 * - **a harness here**: an agent with a DSH in the registry as the core starts, or attached since (created, forked,
 *   restored, found). Its viewer, its verdict and the name its frame carries are the viewers' (core/viewersLink.ts).
 * - **a request**: the Store's (`dsh_list`, an install, an update, a removal), a harness's create or restore, which
 *   asks the Store for its workspace and launch (core/storeLink.ts), and a client's viewer stream or rendered frame
 *   (core/viewersLink.ts). Each waits for it to start (core/serviceLinks.ts `onDemand`).
 * - **orphan viewers**: stop viewer servers retained in its own ledger after a crash.
 *
 * Package admission wakes Store before reading package facts. Models and Memories prepare
 * their bundled package on their own first use, outside the core.
 *
 * Nothing else in it runs on a timer: the Store's catalog is fetched when it is listed, and the viewers' watches and
 * restarts are each harness's. Once asked for, it is the master's to keep running, as every service is.
 */
import type { RegisteredSession } from '../lib/registry.js'
import { savedRows } from './devicesWake.js'

/** The services in the viewers' process, which a request or a harness wakes. */
export const VIEWERS_ON_DEMAND = ['viewers', 'store'] as const
export type ViewersService = typeof VIEWERS_ON_DEMAND[number]

/** The viewers' ledger of the viewer servers they started, in the data folder (dsh/viewerLedger.ts `VIEWER_LEDGER_FILE`). */
export const VIEWER_LEDGER = 'viewers.json'

export interface ViewersWakeDeps {
  /** Ask the master for the process that runs this service (harnessd/coreLink.ts `want`). */
  want(service: string): void
  /** The services the master runs in their own processes: one in the core's needs no asking. */
  outOfProcess: ReadonlySet<string>
  log?: (line: string) => void
}

export function createViewersWake(deps: ViewersWakeDeps) {
  const log = deps.log ?? ((line: string) => console.log(line))
  const asked = new Set<string>()
  return {
    /** Ask for the process this service runs in, once: a harness is attached on every pass that sees it, and the
     *  master keeps a process it has started. `why` is what the log says. */
    ask(service: ViewersService, why: string): void {
      if (asked.has(service) || !deps.outOfProcess.has(service)) return
      asked.add(service)
      log(`[viewers] ${why}: asking for the viewers' process`)
      deps.want(service)
    },
    /** It connected: the master runs it, whoever asked for it, or it started with the others. */
    connected(service: string): void {
      if ((VIEWERS_ON_DEMAND as readonly string[]).includes(service)) asked.add(service)
    },
  }
}

export type ViewersWake = ReturnType<typeof createViewersWake>

/** At the core's start: the viewers' process asked for when a harness is here or it has something of its own to do. */
export function wakeViewers(deps: {
  wake: Pick<ViewersWake, 'ask'>
  /** The agents the registry kept. */
  agents: () => readonly Pick<RegisteredSession, 'dsh'>[]
  dataDir: string
  read?: (file: string) => string
}): void {
  if (deps.agents().some((agent) => !!agent.dsh)) deps.wake.ask('viewers', 'a harness here')
  else if (savedRows(deps.dataDir, VIEWER_LEDGER, deps.read).length) deps.wake.ask('viewers', 'viewer servers an earlier process left running')
}
