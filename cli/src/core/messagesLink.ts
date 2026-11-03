/**
 * Agent Messages in a process of its own, as the core sees it (the process's side is services/messagesProcess.ts). It
 * runs in the edge host since 2026-10-12; a master from before runs it in a process of its own, on demand, which this
 * core asks for as it starts (`askForMessages`).
 *
 * - Which of its typed deliveries may be written now. The core asks in line, as it writes a `team:` delivery into
 *   an idle agent's pane (core/input.ts), and never calls into the process or waits on it for that. The process
 *   tells the core instead (`writable`): each delivery it still wants written, until a deadline a few seconds off,
 *   told again while it may. A process that stops telling, hung or gone, leaves none writable, and a delivery
 *   waits rather than being written against its mailbox's word.
 * - What it may ask of the core, and no more (core/api.ts `MESSAGES_QUERIES`). As an experiment it could ask for
 *   anything an experiment acts on the core through (core/experimentQueries.ts); as a service it is given what it
 *   uses: the agents as the apps are shown them, how this daemon is reached and whether it is signed in, which account
 *   is (`account`), the backend routes of its tabs and shared tabs (`MESSAGES_BACKEND_ROUTES`), its log's change
 *   notice for the windows, and shared tabs' keys, which the
 *   gateway holds and it asks for one use at a time (`tab_key`), and their relay, whose sockets the gateway holds too
 *   (`tab_relay`); and that a shared tab's roster changed here, which the core hands to Share, starting it if it is off,
 *   for the observers it derives (`observers`). Writing turns into agents is core/deliveries.ts's to allow (`TURN_DELIVERERS`).
 * - The account's `desk_changed`, told as the backend announces it: its tabs are read again then.
 * - What a shared tab's relay said (`GatewayEvents.tabFrame`), told as the gateway hears it (`tab_frame`).
 * - That its switch changed here (`MessagesPort.settingsChanged`): the core's sync of the account's experiments tells
 *   it (core/experiments.ts `createAgentSettingsSync`), so that turning it on wakes it.
 */
import { messagesBackendAllowed, MESSAGES_WINDOW_FRAMES, type BackendNotice, type CoreApi, type MessagesPort, type TabFrame } from './api.js'
import { daemonAddress, shownAgents } from './experimentQueries.js'
import { answerTabKey } from '../lib/tabKeyWire.js'
import { answerTabRelay } from '../lib/tabRelayWire.js'

type Payload = Record<string, unknown>

export interface MessagesLinkDeps {
  core: Pick<CoreApi, 'agents' | 'daemon' | 'account' | 'clients'>
  /** Tell the process something (core/serviceLinks.ts `notify`, for `messages`); false when it is not connected. */
  notify(frame: { type: string; payload: Payload }): boolean
  /** Ask Share (core/serviceLinks.ts `call`, for `sharing`, which asks the master for its process while it is off; or
   *  its handler in this process): how a roster change reaches the observers it derives. */
  share?(type: string, payload: Payload): Promise<Payload>
  now?: () => number
}

export function createMessagesLink(deps: MessagesLinkDeps) {
  const now = deps.now ?? Date.now
  const { core } = deps
  /** Each delivery the process says may be written now, and until when. */
  let writable = new Map<string, number>()
  /** Agent Messages' shared tabs listening in the core's process (`onTabFrame`); none while it runs in its own. */
  const tabFrameListeners = new Set<(event: TabFrame) => void>()
  const port: MessagesPort = {
    canWrite: (deliveryId) => (writable.get(deliveryId) ?? 0) > now(),
    // Told, never asked: a process that is down reads the file as it starts anyway.
    settingsChanged: () => { deps.notify({ type: 'service_event', payload: { kind: 'settings' } }) },
  }
  return {
    port,
    /** The core's answers to the process's questions (core/serviceLinks.ts `answer`, for `messages`): those in
     *  `MESSAGES_QUERIES`, each checked, and `UNKNOWN_QUERY` for any other. */
    answer(query: string, payload: Payload): Payload | Promise<Payload> {
      switch (query) {
        case 'writable': {
          const reported = payload.deliveries && typeof payload.deliveries === 'object' ? payload.deliveries as Payload : {}
          writable = new Map(Object.entries(reported).flatMap(([id, until]) => (typeof until === 'number' ? [[id, until] as const] : [])))
          return {}
        }
        case 'shown':
          return shownAgents(core)
        // Signed out, it reads no tabs and runs no timer: there is no account to read them from (messages/service.ts).
        case 'daemon':
          return { ...daemonAddress(core), signedIn: core.account.signedIn() }
        // Shared tabs name their owner and members by account: read by the core, never by the process (`accountIdentity`).
        case 'account':
          return core.account.identity().then((known) => (known ? { ...known } : { error: 'ACCOUNT_UNAVAILABLE' }))
        // Only the routes of MESSAGES_BACKEND_ROUTES, by method and whole path; a body only for the calls that send one.
        case 'backend': {
          const { method, path, body } = payload
          if (!messagesBackendAllowed(method, path)) return { error: 'INVALID_REQUEST' }
          const asked = body === undefined ? core.account.backend(method as string, path as string) : core.account.backend(method as string, path as string, body)
          return asked.then((answer) => ({ ...answer }))
        }
        case 'windows': {
          const frame = payload.frame as Payload | undefined
          // Its log, its shared tabs or their harnesses' work changed, and nothing else: what the windows hear from the core
          // itself is the core's to say.
          if (typeof frame?.type !== 'string' || !MESSAGES_WINDOW_FRAMES.includes(frame.type) || !frame.payload || typeof frame.payload !== 'object') return { error: 'INVALID_FRAME' }
          core.clients.windows({ type: frame.type, payload: frame.payload as Payload })
          return {}
        }
        // A shared tab's roster changed here: Share derives its observers again from the file, read only, and closes a
        // removed member's at once. Only that request, with nothing the process sent: the roster is read where it is kept.
        case 'observers':
          return deps.share?.('harness_share_rosters', {}) ?? { error: 'SERVICE_UNAVAILABLE' }
        // Whether this computer's harnesses in a shared tab are working, for that tab's other accounts (messages/tabActivity.ts),
        // and what they are doing, in a line, when asked.
        case 'activity': {
          const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
          // The one-line summaries only for a caller that asks (an older process asks for neither and reads none).
          return payload.summaries === true
            ? Promise.all([core.agents.activity(ids), core.agents.summaries(ids)]).then(([activity, summaries]) => ({ activity, summaries }))
            : core.agents.activity(ids).then((activity) => ({ activity }))
        }
        // Shared tabs' keys, which the gateway holds: one of the nine `TabKey` methods, and `UNKNOWN_METHOD` for any other.
        case 'tab_key':
          return answerTabKey(core.account.tabKey, payload)
        // Shared tabs' relay, whose sockets the gateway holds: `open`, `send` or `close`, and `UNKNOWN_METHOD` for any other.
        case 'tab_relay':
          return answerTabRelay(core.account.tabRelay, payload)
        default:
          return { error: 'UNKNOWN_QUERY' }
      }
    },
    /** The backend announced a change to the account: the desk's and the machine list's are the ones Agent Messages reads
     *  its tabs again for, which name the account's machines (messages/directory.ts). Its timer reads only every 5 minutes. */
    notice(notice: BackendNotice): void {
      if (notice.type === 'desk_changed' || notice.type === 'machines_changed') deps.notify({ type: 'service_event', payload: { kind: 'notice', notice } })
    },
    /** What a shared tab's relay said: told, never waited on. A process that is down misses it, and its relay
     *  sockets with it, which it opens again as it starts. In the core's process (`HARNESSD_SERVICES=none`) there is
     *  no process to tell, and Agent Messages hears it from here instead (`onTabFrame`). */
    tabFrame(event: TabFrame): void {
      deps.notify({ type: 'service_event', payload: { kind: 'tab_frame', event } })
      for (const listener of [...tabFrameListeners]) listener(event)
    },
    /** Agent Messages in the core's process listening to its tabs' relay, as it would in its own (services/messagesProcess.ts
     *  `onTabFrame`); returns how to stop. Without it, a tab's frames went only to a process that was never there. */
    onTabFrame(listener: (event: TabFrame) => void): () => void {
      tabFrameListeners.add(listener)
      return () => { tabFrameListeners.delete(listener) }
    },
  }
}

/**
 * Ask the master for Agent Messages as the core starts, when it runs out of the core's process. This build's master
 * runs it in the edge host, which is always running, so the ask starts nothing. A master from before runs it in a
 * process of its own that starts only when asked: a core is left under one when that master could not re-execute on
 * the update (harnessd/reexec.ts), and without the ask no agent would get its note, and no waiting message would
 * move, until a request came. Asked whether it is on or off: off, it runs no timer either way (messages/service.ts).
 */
export function askForMessages(outOfProcess: ReadonlySet<string>, want: (service: string) => void): boolean {
  if (!outOfProcess.has('messages')) return false
  want('messages')
  return true
}
