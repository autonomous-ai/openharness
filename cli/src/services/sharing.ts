/**
 * Share, an experiment: an owner shares a harness with people by email or by link, and they watch its
 * terminal read-only, its viewer, and comment (sharing/owner.ts). Moved out of the core as it was (step 8 of
 * docs/design/2026-10-06-core-boundary-next.md, move only): built on every daemon before, with a 1 s timer and
 * a 30 s publish; now only once it is on (its invitations or links are saved here, or the app asks), in the
 * core's process (`HARNESSD_SERVICES=none`) or in its own (services/sharingProcess.ts).
 *
 * What the core gave it, it gets from the core's API:
 * - its welcomes signed with this machine's identity, which the gateway holds (`core.account.observerKey`):
 *   Share holds no credential;
 * - its observers' terminals, read-only, by the core's stream manager (`core.terminals.watch`), what each is
 *   shown sealed here and sent on through the gateway (`core.clients.observer`);
 * - its invitations and links published through the account (`core.account.backend`);
 * - the agents it shares, and their viewers, which it captures in headless Chrome itself (sharing/viewer.ts).
 * The observers' frames reach it through its port, as the relay hands them over.
 */
import { join } from 'node:path'
import type { CoreApi, CorePorts, ServiceRequests, TerminalWatch } from '../core/api.js'
import { SHARE_REQUESTS } from '../core/api.js'
import { b64d, b64e } from '../lib/e2ee/core.js'
import { HarnessCollaborationStore } from '../sharing/collaboration.js'
import { HarnessGrantStore } from '../sharing/grants.js'
import { HarnessShareOwner, type ObserverStreams } from '../sharing/owner.js'
import { SharedViewerPool } from '../sharing/viewer.js'

/** The requests Share answers, declared in core/api.ts for the core to route. */
export { SHARE_REQUESTS } from '../core/api.js'

export interface SharingOptions {
  /** The pool that captures a shared viewer; swapped in tests for one that starts no browser. */
  viewers?: Pick<SharedViewerPool, 'watch' | 'stop'>
}

/** The core's read-only streams, as the owner's own stream manager was: frames in, what each observer is shown out. */
export function watchStreams(watch: TerminalWatch, targets: { sendTarget(id: string, type: string, payload: Record<string, unknown>): boolean }): ObserverStreams {
  const stopHearing = watch.onOutput((viewer, output) => {
    if ('binary' in output) targets.sendTarget(viewer, 'observer_binary', { bytes: output.binary })
    else targets.sendTarget(viewer, output.type, output.payload)
  })
  return {
    handleFrame: async (viewer, type, payload) => { await watch.frame(viewer, type, payload); return true },
    closeConnection: (viewer) => watch.close(viewer),
    stop: async () => { stopHearing() },
  }
}

/** The page of an agent's viewer, which Share captures for its observers, as the core shows its agents. */
export const viewerPage = (core: Pick<CoreApi, 'agents'>) => (agentId: string): string | null => {
  const agent = core.agents.resolve(agentId)
  return agent ? core.agents.dsh(agent)?.viewerUrl ?? null : null
}

export function startSharing(core: CoreApi, ports: CorePorts, options: SharingOptions = {}): ServiceRequests {
  const viewers = options.viewers ?? new SharedViewerPool(viewerPage(core))
  const owner = new HarnessShareOwner({
    machineId: () => core.daemon.machineId(),
    key: {
      publicKey: async () => b64d(await core.account.observerKey.publicKey()),
      signWelcome: async (machineId, shareId, peer, ephemeral) => b64d(await core.account.observerKey.signWelcome(machineId, shareId, b64e(peer), b64e(ephemeral))),
    },
    grants: new HarnessGrantStore(join(core.dataDir, 'harness-shares.json')),
    collaboration: new HarnessCollaborationStore(join(core.dataDir, 'harness-collaboration.json')),
    // Read as each link is made: in Share's own process the core says it once connected, after this starts.
    get autonomousEnv() { return core.daemon.autonomousEnv },
    resolveAgent: (id) => core.agents.resolve(id),
    send: (id, type, payload) => core.clients.observer(id, type, payload),
    publish: (method, path, body) => core.account.backend(method, path, body),
    watchViewer: (id, send) => viewers.watch(id, send),
    streams: (targets) => watchStreams(core.terminals.watch, targets),
  })
  ports.sharing = {
    observer: (connId, type, payload) => owner.receive(connId, type, payload),
    linkDown: () => owner.closeAll(),
    stop: async () => {
      await owner.stop()
      viewers.stop()
    },
  }
  return Object.fromEntries(SHARE_REQUESTS.map((type) => [type, (payload: Record<string, unknown>) =>
    owner.manage(type, payload).catch(() => ({ error: 'SHARING_UNAVAILABLE', detail: 'Sharing is temporarily unavailable. Try again.' }))]))
}
