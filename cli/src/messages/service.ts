/**
 * Agent Messages (docs/design/2026-10-10-agent-messages.md): harnesses in one tab message each other with `harness
 * send`, while the account has Agent Messages on (Settings ▸ Experimental, off by default). This is the whole service,
 * on the core's API, in the core's process or in its own (services/messages.ts, services/messagesProcess.ts):
 * - `send`: from `harness send` in an agent's pane, over this machine's socket. The pane names the sender.
 * - `deliver`, `status`, `who`: from the owner's other machines, over the paired relay; and from another account's
 *   machine in a tab shared with this one, through the tab's relay (sharedTabs.ts `request`, answered by `answerTab`),
 *   each checked against the tab's roster this computer holds (tabDelivery.ts).
 * - `history`: the windows' log of a tab.
 * - `started`: another machine's record of a harness it started here, for the agent client's limits and depth
 *   (agentClient/ledger.ts). It lets no one message anyone: only sharing a tab does.
 * - `shares` and `share_*`: tabs shared with other accounts (sharedTabs.ts), from the owner's windows, only while it is
 *   awake; `tab_pub`, this machine's key for a shared tab's roster, from the owner's other machines; `tab_pin`, a
 *   shared tab's owner key and roster as this machine holds them, and `tab_pin_changed`, that another machine took one,
 *   from the owner's other machines, only while it is awake; `tab_keychange`, this machine's signature over another's
 *   key for a tab it shares, which that machine is taking (`share_move`), from the owner's other machines only.
 * Deliveries to this machine's agents are the mailbox's (mailbox.ts); a message for another machine's agent is
 * handed to that machine's daemon, which owns its delivery and is asked what became of it: a machine of this account
 * over the paired relay, another account's through the shared tab they are in (`route`).
 *
 * Off costs nothing. It runs in the edge host on every computer, and only while this computer is signed in and has
 * Agent Messages on does it read the account's tabs (every 15 s), look at its deliveries (every 2 s) and at its notes,
 * its outbox and other machines' deliveries (every 5 s). Turned off, it withdraws the notes, holds what waits here out
 * of the hook's reach and fails it once it has waited HELD_OUTSIDE_MS, as while on, and then runs nothing until it is
 * turned on again: the core tells it when its copy of the account's switch changes (`settingsChanged`, from
 * core/experiments.ts `createAgentSettingsSync`), and a watch on the setting's file hears the same write
 * (settingWatch.ts); what this computer sent that waits for another machine is
 * handed over once it is on again. Signed out it runs nothing: there is no account to read tabs from, and signing in
 * starts a new core, which it reconnects to (`reconnected`). Its requests are answered either way, and read the switch
 * again as they come.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { SHARED_ACTIVITY_WINDOW_FRAME, SHARED_TABS_WINDOW_FRAME, type CoreApi, type ServiceRequests, type TabFrame, type TurnDelivery } from '../core/api.js'
import { env } from '../config/env.js'
import { agentProject } from '../lib/agentProject.js'
import { agentSettingsPath, askThePersonFirst, readAgentSettings } from '../lib/agentSettings.js'
import type { RegisteredSession } from '../lib/registry.js'
import { primaryRuntime, sessionForPaneId, terminalRouteKey } from '../lib/terminalRuntime.js'
import { type DirectoryTab, MessageDirectory, type Member } from './directory.js'
import { PaneInbox } from './inbox.js'
import { Mailbox, type MailboxAgent } from './mailbox.js'
import { type DeliveryStatus, LIMITS, LONG_TEXT, longAdvice, type Message, MessageError, messageId, note, parseMessage, type Recipient, rendered, type TabNote, type Teammate } from './model.js'
import { TOLD_TAB, tellRefusal, toldText } from './tell.js'
import { PERSON_AGENT_ID, REPLIED_TAB, replyRefusal } from './replyLocal.js'
import { messagesRpc, RefusedError, type Rpc } from './rpc.js'
import { RequestStore } from './requestStore.js'
import { cleanName, type Roster } from './roster.js'
import { consentKey, ConsentStore } from './consentStore.js'
import { NoticeStore } from './noticeStore.js'
import { RosterStore } from './rosterStore.js'
import { accountsIn, markerLabel, markerName, markerNameWithId, sharedTabsFor } from './sharedDirectory.js'
import { sharedTabIdOf } from './sharedTabsRoster.js'
import { SharedTabs } from './sharedTabs.js'
import { carries, checkHandedOver, cleanText, fitsRequest, RateCounter, statusCode, wireMessage, type TabContext } from './tabDelivery.js'
import { Ledger, ledgerPath, parseStarted } from '../agentClient/ledger.js'
import { watchSettingFile } from './settingWatch.js'
import { ActivityIn, ActivityOut, type ActivityNow, type ActivityState } from './tabActivity.js'
import { cleanSummary } from '../lib/activitySummary.js'
import { VERSION } from '../version.js'
import { createTaskReader, type TaskReader, type TaskResult } from './tasks.js'
import { MessageStore, type Entry, type LocalDelivery, type Outgoing } from './store.js'
import { PTY_HOST_INSTANCE_SOURCE } from '../lib/ptyHost/instance.js'

export interface MessagesOptions {
  /** Where its history and waiting deliveries are kept; an isolated fixture's own. */
  stateDir?: string
  /** The pane inboxes the messages hook reads (env.HARNESS_AGENT_MESSAGES_DIR); an isolated fixture's own. */
  inboxRoot?: string
  rpc?: Rpc
  /** The local socket's folder (`ADAPTER_DATA_DIR`) the other machines are reached through. */
  dataDir?: string
  /** Who started which harness (agentClient/ledger.ts), where another machine's `started` is kept; an isolated
   *  fixture's own. */
  ledgerFile?: string
  /** Something that decides whether a typed delivery may be written changed: the process tells the core. */
  changed?: () => void
  /** How it hears the setting's file change while Agent Messages are off (settingWatch.ts); a test's own. */
  watchSetting?: (path: string, changed: () => void) => () => void
  /** What shared tabs' relay said (`GatewayEvents.tabFrame`), for its shared tabs to listen to while they run: the
   *  process it runs in hands each on (services/messagesProcess.ts). Returns how to stop listening. */
  onTabFrame?: (listener: (event: TabFrame) => void) => () => void
  /** Its shared tabs' file was saved (a pin, a roster, a tab forgotten): Share derives the observers each tab wants for
   *  this computer's harnesses again (core/messagesLink.ts `observers`). Told, never waited on. */
  observers?: () => void
  /** The branch a folder is on (lib/agentProject.ts, which runs Git); a test's own. */
  project?: (cwd: string) => Promise<{ branch: string | null } | null>
  /** The shared tabs' tasks (tasks.ts, which runs `gh`); a test's own, so no test starts the real one. */
  tasks?: TaskReader
  now?: () => number
}

export interface AgentMessages {
  requests: ServiceRequests
  /** Whether the core may write a typed delivery now: the mailbox's word, in line. */
  canWrite(deliveryId: string): boolean
  /** The service reached a core again, perhaps a new one: typed attempts in flight go back to the hook, and what
   *  runs follows whether this computer is signed in now. */
  reconnected?(): void
  /** The core's copy of the account's switch changed: it is read again, and it wakes if it is on now. */
  settingsChanged(): void
  start(): void
  stop(): void
}

/** How often the service looks at its notes, its outbox and other machines' deliveries. */
export const TICK_MS = 5_000
/** How often a tab id this desk does not list may make the desk be read again (`tabActivity`). */
export const MISSED_TAB_READ_MS = 15_000
/** How often a message waiting on another machine is asked about. */
export const REMOTE_STATUS_MS = 15_000
/** How long another machine's names for its agents are kept. */
export const WHO_MS = 60_000
/** How old an inbox file nothing here waits on must be before a start sweeps it away. */
export const SWEEP_AFTER_MS = 10 * 60_000
/** How long a delivery no tab carries (Agent Messages turned off, or the tab left) is held, given to no one, before
 *  it fails. */
export const HELD_OUTSIDE_MS = 5 * 60_000
export const HELD_OFF_REASON = 'Agent Messages are off on its computer: it waits 5 minutes for them to be on again, then fails'
export const HELD_LEFT_REASON = 'it is not in a tab with the sender: it waits 5 minutes for that to change, then fails'
/** Why a message for another account's harness failed once it had waited HELD_OUTSIDE_MS outside every shared tab. */
export const LEFT_TAB_REASON = 'it is no longer in a shared tab with the sender'
/** Why a message already handed over to another account's harness failed once that harness had been outside every
 *  shared tab for HELD_OUTSIDE_MS: its computer can no longer be asked what became of it. */
export const LEFT_AFTER_HANDOVER_REASON = 'no longer in a shared tab with the sender; whether it was read is not known'
/** What `harness send` says of a message too large for a shared tab's frame (tabDelivery.ts `fitsRequest`). */
export const TOO_LARGE_TEXT = 'This message is too large to send to another account\'s harness: shorten the message or send to fewer teammates.'
/** How long the Agent Messages setting, as this computer keeps it, is taken as read: the mailbox's pump asks
 *  every 2 s (mailbox.ts PUMP_MS), and a send or a hand-over asks too. */
export const SETTING_FRESH_MS = 2_000
/** How long another machine's key, as it reported it for a shared tab's roster, is taken as read. */
export const MACHINE_KEY_MS = 10 * 60_000
/** The requests about tabs shared with other accounts: answered only while it is awake. */
const ACTIVITY_STATES = new Set<ActivityState>(['working', 'idle', 'unknown'])
const SHARE_ACTIONS = ['shares', 'share_tab', 'share_invite', 'share_revoke', 'share_accept', 'share_add', 'share_remove',
  'share_leader', 'share_remove_member', 'share_leave', 'share_stop', 'share_retrust_check', 'share_retrust', 'share_move', 'share_tasks', 'share_who', 'share_notice_dismiss']
/** How long People waits for a machine of the tab to say its harnesses' repo and branch. */
export const WHO_WAIT_MS = 4_000
/** How long `harness send` alone waits for the tasks before it gives the roster without them. */
export const TASKS_WAIT_MS = 4_000
/** What `harness send` says while this computer has Agent Messages off: where the person turns them on again. */
export const MESSAGES_OFF_TEXT = `Agent Messages are off. ${askThePersonFirst('agent-messages', 'work on without messaging your teammates.')}`

/** How long the windows' `shared_tabs_changed` waits for more of the same change. */
export const SHARES_COALESCE_MS = 250
/** `harness send`'s pane: `$TMUX_PANE` (`%N`, a tmux pane only) or a pty host pane's `<instance>:%N` (`$HARNESS_PANE`). */
const PANE = new RegExp(`^(?:${PTY_HOST_INSTANCE_SOURCE}:)?%\\d{1,9}$`)
/** The most messages `harness send` alone gives an agent at once, unread ones first. */
const UNREAD_MAX = 20
/** Whether `wanted` is the whole of a name the engine cut short: Codex titles its terminal with the folder cut to fit
 *  ("claude-code-2026-10-1..."), and an agent that wrote the folder out in full was told no teammate had that name
 *  (a fresh Mac, 2026-10-12). Both arguments in lower case. */
const cutShort = (name: string, wanted: string): boolean => {
  const stem = name.replace(/\s*(?:\.{3}|…)$/u, '')
  return stem !== name && stem.length >= 3 && wanted.startsWith(stem)
}
const key = (m: Member): string => `${m.machineId}/${m.agentId}`
/** The start of an id, as a name or a suffix shows it. A shared tab's roster is another account's word, and its ids may
 *  hold any character: `\x1b[2J\x1b[H` fits in eight and would clear the terminal it is shown in (review of B1). */
const idStart = (id: string): string => cleanName(id).slice(0, 8) || '?'

export function startAgentMessages(core: CoreApi, options: MessagesOptions = {}): AgentMessages {
  const now = options.now ?? Date.now
  const rpc = options.rpc ?? messagesRpc
  const self = (): string => core.daemon.machineId()
  const at = (machineId: string) => ({ port: core.daemon.port, machineId, dataDir: options.dataDir ?? core.dataDir })
  const stateDir = options.stateDir ?? join(core.dataDir, 'agent-messages')
  const store = new MessageStore(stateDir)
  // Who started which harness is the agent client's (limits, depth, who may close what), never a way to message: a
  // harness started by another reaches it only through a tab they share, like any teammate (owner, 2026-10-11, on
  // finding agents messaging each other with no tab turned on). The one use beyond that is `harness tell` (tell.ts):
  // one way, from the starter, behind a switch of its own the person turns on.
  const lineage = new Ledger(options.ledgerFile ?? ledgerPath(core.dataDir))
  const inbox = new PaneInbox(options.inboxRoot ?? env.HARNESS_AGENT_MESSAGES_DIR)
  /** Other machines' names for their agents, with when they were asked; a branch only for a harness in a shared tab. */
  const who = new Map<string, { name: string; engine: string; project?: string; branch?: string; at: number }>()
  /**
   * The branch each folder here is on, with when it was read, kept WHO_MS as another machine's answer is. Read only for a
   * harness in a tab shared with other accounts, the one note that shows a branch: no Git runs for any other tab.
   */
  const branches = new Map<string, { at: number; read: Promise<void>; branch?: string }>()
  const project = options.project ?? agentProject
  const tasks = options.tasks ?? createTaskReader(undefined, now)
  /** When each other machine was last asked for names, answering or not. */
  const asked = new Map<string, number>()
  /** When each sender sent, for the rate limit. */
  const sent = new Map<string, number[]>()
  /** The shared tabs' limits (the spec's "Limits"): what this computer sent into each tab, and what it took from each
   *  tab and from each sender in one, through the tabs' relay. */
  const tabSent = new RateCounter()
  const tabTaken = new RateCounter()
  /** A shared tab's working state across accounts: what was last sent each tab's machines, and what they last said (tabActivity.ts). */
  const activityOut = new ActivityOut(), activityIn = new ActivityIn()
  const senderTaken = new RateCounter()
  /** Hand-overs under way: one a tick, an opened session and a send all reach is handed over once at a time. */
  const handing = new Set<Outgoing>()
  /** When the shared tabs stopped carrying each hand-over to another account's machine (`messageId machineId`). */
  const outboxOutside = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastRemoteStatus = -Infinity
  /**
   * What runs (`wake`): everything while this computer is signed in and has Agent Messages on (`awake`); while they are
   * off, only the mailbox's look until what waited has settled, and the watch on the setting's file; signed out,
   * nothing. Null before it starts and once it stops.
   */
  let mode: 'awake' | 'off' | 'signedOut' | null = null
  const asleep = (): boolean => mode === 'off' || mode === 'signedOut'
  let running = false
  let unwatch: (() => void) | null = null
  const settingsFile = agentSettingsPath(options.dataDir ?? core.dataDir)

  // The account's experiment, kept by the core in the data folder (lib/agentSettings.ts) as it changes: a small file,
  // read again at most every SETTING_FRESH_MS, so a switch turned off takes effect at the next look; while off,
  // nothing looks, and the core's word (`settingsChanged`) or the file's watch wakes it (settingWatch.ts).
  let setting = { on: true, hide: false, at: -Infinity }
  const readSetting = (): boolean => {
    const saved = readAgentSettings(options.dataDir ?? core.dataDir)
    setting = { on: saved.agentMessages, hide: saved.agentMessagesHideSummary, at: now() }
    return setting.on
  }
  const messagingOn = (): boolean => {
    if (now() - setting.at >= SETTING_FRESH_MS) {
      const was = setting.on
      // Turned on or off since the last look: what runs follows, once whatever asked has its answer.
      if (readSetting() !== was) later()
    }
    return setting.on
  }
  /** Whether the account keeps the one-line summary from other accounts (Settings ▸ Experimental), read as `messagingOn` is. */
  const summaryHidden = (): boolean => { messagingOn(); return setting.hide }
  /** Whether a harness's starter may tell it more work (`agents-tell-agents`): read at each use, as few as they are, so
   *  a switch turned off stops what still waits at the mailbox's next look. */
  const tellOn = (): boolean => readAgentSettings(options.dataDir ?? core.dataDir).agentsTellAgents
  /** Whether a program acting for the person may reply to a harness here (`programs-reply`): read at each use, as `tellOn`. */
  const replyOn = (): boolean => readAgentSettings(options.dataDir ?? core.dataDir).programsReply
  let waking = false
  const later = (): void => {
    if (waking) return
    waking = true
    queueMicrotask(() => { waking = false; wake() })
  }

  const directory = new MessageDirectory({
    on: messagingOn,
    read: async () => {
      const response = await core.account.backend('GET', '/api/agent-messages')
      if (response.status !== 200 || response.body.success !== true) throw new Error('directory unavailable')
      return response.body.data
    },
    changed: () => { mailbox.refuseAll(); notesPump(); followLeaders(); options.changed?.() },
    // The shared tabs this computer holds, once it knows its account: which rosters are its own depends on it, and which
    // machines are its own, this one always (as sharedTabs.ts `checkOwn` takes them). This machine's harnesses are in
    // another account's tab only as it asked (`consent`).
    extra: (desk, machines) => (rosters && account
      ? sharedTabsFor(rosters.all(), { accountId: account.accountId, machineId: self(), machineIds: new Set([self(), ...machines.keys()]), consent: consent?.keys() ?? new Set() },
        (id) => shared?.deskTab(id) ?? null, desk)
      : desk),
    now,
  })

  const live = (): RegisteredSession[] => core.agents.live().filter((s) => s.engine !== ('terminal' as string))
  /** Where a harness's inbox is: its pane by route key (inbox.ts), so equal `%N` ids on two backends never share
   *  one. None while it has no pane. */
  const inboxPane = (session: RegisteredSession): string => session.runtimes.length ? terminalRouteKey(primaryRuntime(session)) : ''
  const localAgent = (agentId: string): RegisteredSession | undefined => live().find((s) => s.agentId === agentId)
  const machineName = (machineId: string): string => directory.machineName(machineId) ?? (machineId === self() ? hostname().replace(/\.local$/, '') : idStart(machineId))

  const mailbox: Mailbox = new Mailbox({
    store, inbox, now,
    agent: (agentId): MailboxAgent | null => {
      const session = localAgent(agentId)
      if (!session) return null
      // The hook delivers only to this conversation: a Codex sub-agent runs its hooks from its parent's pane, and
      // a pane number tmux gives out again is another's. A Claude Code sub-agent says so itself (`agent_id`).
      return { pane: inboxPane(session), session: session.sessionId ?? '', available: session.active && core.agents.terminalAvailable(agentId) }
    },
    deliver: (agentId, text, deliveryId) => { core.turns.deliver(agentId, text, deliveryId); options.changed?.() },
    refused: (delivery) => { const v = verdict(delivery); return v && 'refused' in v ? v.refused : null },
    held: (delivery) => { const v = verdict(delivery); return v && 'held' in v ? v.held : null },
    forbidden: (delivery) => forbidden(delivery),
    // Off, no tab carries a message, whatever the tabs say: known without reading them.
    ready: () => directory.current() !== null || !directory.on(),
    asleep,
    text: (delivery, message) => {
      // More work from its starter: no tab, so no roster note, which would invite it to message its teammates.
      if (message.tabId === TOLD_TAB) return toldText(message)
      // The person's words, as they would type them: no header, as `harness reply` to a cloud harness sends them.
      if (message.tabId === REPLIED_TAB) return message.text
      const roster = rosterOf(delivery.agentId)
      const text = rendered(message, account?.accountId)
      return roster && store.state.noted[delivery.agentId] !== roster.signature ? `${roster.text}\n\n${text}` : text
    },
    changed: (status, delivery) => localChanged(status, delivery),
    writable: () => options.changed?.(),
  })

  /**
   * Why a local delivery may never be made, whatever the tabs say, or null. Before 2026-10-11 a harness and one it
   * started messaged each other with no tab on, logged under `started`; only a tab carries a message, so what an
   * older version left waiting there is never delivered, even to two that share a tab now. Asked before
   * the directory is read too: the hook takes what waits in a pane's inbox without asking, and a directory that
   * cannot be read (signed out, the backend down) would otherwise leave it there to be taken.
   */
  function forbidden(delivery: LocalDelivery): string | null {
    return store.entry(delivery.messageId)?.message.tabId === 'started' ? 'it was sent outside any tab' : null
  }

  /** When the tabs stopped carrying each local delivery (`messageId agentId`), while they do not. */
  const outsideSince = new Map<string, number>()

  /**
   * Whether a local delivery may be made: null; held, given to no one, while no tab carries it (Agent Messages are
   * off here, or the two no longer share a tab), for HELD_OUTSIDE_MS; refused after that, or at once when it may never
   * be made. Only what may never be made is refused before the directory is read. A tab's switch turned off by a slip
   * of the mouse and on again a minute later failed the message waiting in it (owner, 2026-10-12): held, it goes on
   * once it is carried again.
   */
  function verdict(delivery: LocalDelivery): { refused: string } | { held: string } | null {
    const entry = store.entry(delivery.messageId)
    if (!entry) return { refused: 'the message is no longer kept' }
    const never = forbidden(delivery)
    if (never) return { refused: never }
    // Told by its starter: no tab carries it, so the tabs say nothing. The switch, and who started it as this machine
    // records it, are looked at again at each look: turned off meanwhile, it is refused at once. Whether the harness
    // runs was asked as it was told; a harness away for a moment (a restart) waits as a teammate's message does.
    if (entry.message.tabId === TOLD_TAB) {
      const refusal = tellRefusal({ on: tellOn(), lineage, self: self(), live: () => true }, entry.message.from, delivery.agentId)
      return refusal ? { refused: refusal.message } : null
    }
    // A program's reply for the person: the switch is looked at again at each look, as a tell's is.
    if (entry.message.tabId === REPLIED_TAB) return replyOn() ? null : { refused: 'programs-reply was turned off' }
    if (!directory.current() && directory.on()) return null
    const key = `${delivery.messageId} ${delivery.agentId}`
    const recipient = { machineId: self(), agentId: delivery.agentId }
    // Only a tab the two share carries a message, and none while Agent Messages are off here.
    if (directory.shared(entry.message.from, recipient)) { outsideSince.delete(key); return null }
    const off = !directory.on()
    const since = outsideSince.get(key) ?? now()
    if (now() - since < HELD_OUTSIDE_MS) {
      outsideSince.set(key, since)
      return { held: off ? HELD_OFF_REASON : HELD_LEFT_REASON }
    }
    outsideSince.delete(key)
    return { refused: off ? 'Agent Messages were turned off on its computer' : 'it is no longer in a tab with the sender' }
  }

  function localChanged(status: DeliveryStatus, delivery: LocalDelivery): void {
    const full = { ...status, machineId: self() }
    if (status.state === 'delivered') {
      const roster = rosterOf(delivery.agentId)
      // The note rode with this message: the agent has it.
      if (roster) { store.state.noted[delivery.agentId] = roster.signature; withdrawNote(delivery.agentId) }
    }
    if (store.status(full)) tellWindows(full.messageId)
    options.changed?.()
  }

  function tellWindows(id: string): void {
    const entry = store.entry(id)
    if (!entry) return
    core.clients.windows({ type: 'messages_changed', payload: {
      tabId: entry.message.tabId, messageId: id, at: entry.message.at,
      from: { machineId: entry.message.from.machineId, agentId: entry.message.from.agentId },
      to: entry.message.to.map((r) => {
        const status = entry.statuses.find((s) => s.machineId === r.machineId && s.agentId === r.agentId)
        return { machineId: r.machineId, agentId: r.agentId, state: status?.state ?? 'queued' }
      }),
    } })
  }

  // ── names and the roster note ────────────────────────────────────────────────────────────────────

  /** Whether a harness is another account's, in a tab shared with it: named by the tab's roster, and never asked about
   *  over this account's relay, which reaches only this account's machines. */
  const foreign = (member: Member): boolean => !!member.accountId && member.accountId !== account?.accountId

  /** A teammate as the note and the roster show them: from this machine's registry, another machine's word, or for
   *  another account's harness, its tab's roster (sharedDirectory.ts, which takes out what could redraw a terminal). */
  function teammate(member: Member): Teammate & { member: Member; known: boolean } {
    if (member.machineId === self()) {
      const session = localAgent(member.agentId)
      const branch = session?.cwd ? branches.get(session.cwd)?.branch : undefined
      return { member, known: !!session, name: session ? core.agents.displayName(session) || idStart(member.agentId) : idStart(member.agentId),
        engine: session?.engine ?? 'agent', machine: machineName(member.machineId), ...(session?.cwd ? { where: basename(session.cwd) } : {}), ...(branch ? { branch } : {}) }
    }
    if (foreign(member)) {
      // Named by its tab's roster; where it works, by its machine's answer (`learnNames`), which names nothing.
      const { project, branch } = who.get(key(member)) ?? {}
      return { member, known: true, name: member.name || idStart(member.agentId), engine: member.engine || 'agent', machine: machineName(member.machineId),
        ...(project ? { where: project } : {}), ...(branch ? { branch } : {}) }
    }
    const known = who.get(key(member))
    return { member, known: !!known, name: known?.name || idStart(member.agentId), engine: known?.engine ?? 'agent', machine: machineName(member.machineId),
      ...(known?.project ? { where: known.project } : {}), ...(known?.branch ? { branch: known.branch } : {}) }
  }

  /**
   * Teammates each with a name it can be told apart by, from `me`'s side. A name is a session's title, and two can
   * share one: two Codex agents in a tab both titled themselves after the task one gave the other, so the roster
   * named the teammate as the agent itself (a fresh Mac, 2026-10-12). In a tab shared across accounts, a name another
   * account's harness shares with a harness of any other account, this one's included, takes its account's prefix
   * (`bob/api`, the spec's "Messages across accounts"); a name still shared with anyone here, the sender included,
   * gets the start of its id, which `harness send` takes on its own. `qualified` and `bare`: another account's harness
   * by its name with its account's prefix and without, for a sender that writes one or the other. `harness`: the name
   * without the account's prefix, and `marker`: its account's label in a task marker, which `tabNote` names it by.
   */
  function distinct(me: Member, members: Member[]): Array<ReturnType<typeof teammate> & { qualified?: string; bare?: string; harness: string; marker?: string }> {
    const mates = members.map((m) => { const mate = teammate(m); return { ...mate, harness: mate.name } })
    const accounts = accountsIn(rosters?.all() ?? [])
    const accountOf = (m: Member): string => (foreign(m) ? m.accountId! : '')
    const holders = new Map<string, Set<string>>()
    for (const [name, holder] of [[teammate(me).name, ''], ...mates.map((m) => [m.name, accountOf(m.member)])]) {
      holders.set(name.toLowerCase(), (holders.get(name.toLowerCase()) ?? new Set<string>()).add(holder))
    }
    const prefixed = mates.map((m) => {
      if (!foreign(m.member)) return m
      const named = accounts.get(m.member.accountId!)
      const qualified = `${named?.label ?? idStart(m.member.accountId!)}/${m.name}`
      // A shared tab's note names its account (`Bob's account`), as a message's header does.
      return { ...m, name: holders.get(m.name.toLowerCase())!.size > 1 ? qualified : m.name, qualified: qualified.toLowerCase(), bare: m.name.toLowerCase(),
        account: named?.name ?? idStart(m.member.accountId!), marker: named?.marker ?? markerLabel(idStart(m.member.accountId!)) }
    })
    const counts = new Map<string, number>()
    for (const name of [teammate(me).name, ...prefixed.map((m) => m.name)]) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1)
    return prefixed.map((m) => (counts.get(m.name.toLowerCase()) ?? 0) > 1
      ? { ...m, name: `${m.name} (${idStart(m.member.agentId)})`, harness: `${m.harness} (${idStart(m.member.agentId)})` } : m)
  }

  /** This harness's own name as its teammates see it: with the start of its id when one of them shares it. Another
   *  account's harness of the same name is told apart by its account's prefix instead (`distinct`). */
  function ownName(me: Member, members: Member[]): string {
    const name = teammate(me).name
    return members.some((m) => !foreign(m) && teammate(m).name.toLowerCase() === name.toLowerCase()) ? `${name} (${idStart(me.agentId)})` : name
  }

  /**
   * Ask other machines for their agents' names, those not known or too old; a machine asked lately, answering or
   * not, is not asked again yet. The notes are looked at again only when a name changed: looked at on every
   * answer, a teammate no machine can name (a stopped harness here) asked again at once, without end.
   */
  async function learnNames(members: Member[], wait: boolean): Promise<void> {
    const byMachine = new Map<string, { agentIds: string[]; tab: string | null }>()
    for (const m of members) {
      if (m.machineId === self()) continue
      const known = who.get(key(m))
      if (known && now() - known.at < WHO_MS) continue
      // Another account's computer is never waited for: it may be away for hours, and its roster already names it.
      const theirs = foreign(m)
      if (now() - (asked.get(m.machineId) ?? -Infinity) < WHO_MS && (!wait || theirs)) continue
      const tab = theirs ? tabOf(m.machineId) : null
      if (theirs && !tab) continue
      byMachine.set(m.machineId, { agentIds: [...(byMachine.get(m.machineId)?.agentIds ?? []), m.agentId], tab })
    }
    if (!byMachine.size) return
    let learned = false
    const asks = [...byMachine].map(([machineId, { agentIds, tab }]) => ({ tab, asked: (async () => {
      asked.set(machineId, now())
      try {
        const payload = { action: 'who', agentIds }
        const answer = tab ? await askTab(tab, machineId, payload, 8_000) : await rpc(at(machineId), payload, 8_000)
        for (const a of Array.isArray(answer.agents) ? answer.agents as Record<string, unknown>[] : []) {
          if (typeof a.agentId !== 'string' || typeof a.name !== 'string' || (tab && !agentIds.includes(a.agentId))) continue
          const before = who.get(`${machineId}/${a.agentId}`)
          // Another account's word only for where its harness works, cleaned: its name and engine are its roster's.
          const project = tab ? cleanText(a.project, 200) || undefined : typeof a.project === 'string' ? a.project : undefined
          const branch = tab ? cleanText(a.branch, 200) || undefined : typeof a.branch === 'string' ? a.branch : undefined
          const next = { name: tab ? '' : a.name, engine: tab ? '' : typeof a.engine === 'string' ? a.engine : 'agent', ...(project ? { project } : {}),
            ...(branch ? { branch } : {}), at: now() }
          // A branch alone is no reason to look at the notes again: it is left out of their signature (`rosterOf`).
          if (!before || before.name !== next.name || before.engine !== next.engine || before.project !== next.project) learned = true
          who.set(`${machineId}/${a.agentId}`, next)
        }
      } catch { /* that machine is away: its agents keep the names they had */ }
    })() }))
    // The notes are looked at once this account's machines answered, and again once other accounts' did.
    const settled = (tab: boolean) => Promise.all(asks.filter((a) => !!a.tab === tab).map((a) => a.asked)).then(() => { if (learned) { learned = false; notesPump() } })
    const own = settled(false)
    void settled(true)
    if (wait) await own
  }

  /** The note a local agent should have read, or null when it shares no tab with a teammate, or Agent Messages are
   *  off here. */
  function rosterOf(agentId: string): { text: string; signature: string } | null {
    const me = { machineId: self(), agentId }
    const peers = directory.peers(me)
    if (!peers.length) return null
    const mates = distinct(me, peers)
    const tabs = directory.tabsOf(me)
    const about = tabNote(me, tabs, mates)
    const text = note(tabs, mates, about)
    // The signature, which decides whether the agent is given the note again, leaves the branches out: an agent switches
    // branches many times in a task, and each switch would otherwise put the whole note in every teammate's context
    // again. `harness send` alone prints the branches as they are now.
    const signed = about.sharedTabId ? note(tabs, mates.map(({ branch: _branch, ...mate }) => mate), about) : text
    return { text, signature: createHash('sha256').update(signed).digest('hex').slice(0, 12) }
  }

  /**
   * What a harness's note says of its tab: who leads it, by the name the harness reaches it by, and for a tab shared with
   * other accounts its id. A harness in a shared tab is told of the first one, as before tab leaders; any other of its
   * first tab. The leader is the account's tab setting, as the directory lists it, for every tab of this account's desk,
   * the one it shares included: that setting is the one source, and the roster only follows it. In a tab another account
   * shares, which lists no setting, it is the roster's. A leader the tab does not list (an owner's roster may name any
   * harness) is no one to defer to, and is not named.
   */
  function tabNote(me: Member, tabs: DirectoryTab[], mates: ReturnType<typeof distinct>): TabNote {
    const tab = tabs.find((t) => t.sharedTabId) ?? tabs[0]
    const sharedTabId = tab.sharedTabId
    // A backend from before tab leaders lists no setting for this account's tabs either: a shared one's roster names it.
    const lead = tab.leader !== undefined ? tab.leader : sharedTabId ? rosters?.current(sharedTabId)?.roster.leader ?? null : null
    const youLead = !!lead && lead.machineId === me.machineId && lead.agentId === me.agentId
    const leader = lead && mates.find((m) => m.member.machineId === lead.machineId && m.member.agentId === lead.agentId)?.name
    // An unshared tab's tasks carry the id it would get if shared (`tabKey`), so a task made before sharing stays the tab's.
    // Unknown until the account is (`signedInAs`), and the note then changes once.
    const tabKey = !sharedTabId && account ? sharedTabIdOf(account.accountId, tab.id) : undefined
    const label = account ? markerLabel(account.email) : undefined
    // Each harness by what the marker takes (final review I2): its name as said, made marker-safe, under its account's label.
    // Two harnesses of one account whose marker names are the same (titles that differ only in what a marker drops, or
    // that have no letter) would be one assignee, and the desktop would give the task to the first: each gets the start
    // of its id, where the marker name collides in the tab, not only where the display names do.
    const entries = label ? [{ account: label, display: ownName(me, mates.map((m) => m.member)), agentId: me.agentId, name: '', you: true },
      ...mates.map((m) => ({ account: m.marker ?? label, display: m.harness, agentId: m.member.agentId, name: m.name, you: false }))] : []
    const taken = new Map<string, number>()
    for (const e of entries) taken.set(`${e.account}/${markerName(e.display)}`, (taken.get(`${e.account}/${markerName(e.display)}`) ?? 0) + 1)
    const assignees = entries.map((e) => ({ name: e.name, marker: `${e.account}/${(taken.get(`${e.account}/${markerName(e.display)}`) ?? 0) > 1
      ? markerNameWithId(e.display, e.agentId) : markerName(e.display)}`, ...(e.you ? { you: true } : {}) }))
    return { ...(sharedTabId ? { sharedTabId } : tabKey ? { tabKey } : {}), ...(label ? { account: label, assignees } : {}), youLead, ...(leader ? { leader } : {}) }
  }

  /** A tab's tasks for a request or a note, only for a roster this computer holds: `gh` is never run for any other id. */
  function tasksOf(sharedTabId: string): Promise<TaskResult> {
    if (!/^[a-f0-9]{24}$/.test(sharedTabId) || !rosters?.current(sharedTabId)) return Promise.reject(new MessageError('NOT_SHARED', 'This computer holds no such shared tab.'))
    return tasks(sharedTabId)
  }

  /** The tasks of one of this account's desk tabs, shared or not, by the key shared tabs use (sharedTabs `sharedTabIdOf`):
   *  `gh` runs for it without a roster, since the key is derived and nothing another account sent is in it. A tab of another
   *  account's shared tab is not on this desk, and is refused. */
  async function tasksOfTab(tabId: string): Promise<TaskResult> {
    const me = await signedInAs()
    const key = sharedTabIdOf(me.accountId, tabId)
    // A tab of another account's has its share id for id, which is never the key derived from this account.
    const onDesk = (): boolean => !!directory.current()?.tabs.some((t) => t.id === tabId && (!t.sharedTabId || t.sharedTabId === key))
    // The listing at hand answers for a tab it has; only a tab it lacks may be new, and asks the backend again.
    if (!onDesk()) await directory.refresh()
    const tab = onDesk()
    if (!tab) throw new MessageError('NOT_A_TAB', 'That tab is not on your desk.')
    return tasks(key)
  }

  /** What `harness send` alone adds: its tab's tasks, or the reason they cannot be read now (no `gh`, signed out): the
   *  roster is still given whole. In a tab shared with other accounts, from its held roster; in any other, from the key
   *  the tab would be shared with. */
  async function tasksSection(me: Member): Promise<TaskResult | { error: string; detail: string } | null> {
    const tabs = directory.tabsOf(me)
    const tab = tabs.find((t) => t.sharedTabId) ?? tabs[0]
    if (!tab || mode !== 'awake') return null
    const sharedTabId = tab.sharedTabId
    // The roster and the messages are never held back for GitHub: gh may take 8 s a run and several runs a refresh, and the
    // client waits 30 s in all. A slow refresh goes on and fills the cache for the next look.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<{ error: string; detail: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: 'LOADING', detail: 'still loading: ask again in a moment' }), TASKS_WAIT_MS)
      timer.unref?.()
    })
    return Promise.race([sharedTabId ? tasksOf(sharedTabId) : tasksOfTab(tab.id), late]).finally(() => clearTimeout(timer)).catch((error: unknown) => error instanceof MessageError
      ? { error: error.code, detail: error.message }
      : { error: 'TASKS_UNAVAILABLE', detail: 'The tasks could not be read right now.' })
  }

  /** Read again the branches of the folders here not read in WHO_MS: a read under way is waited for, not repeated. */
  function readBranches(cwds: readonly string[]): Promise<void> {
    return Promise.all([...new Set(cwds)].map((cwd) => {
      const known = branches.get(cwd)
      if (known && now() - known.at < WHO_MS) return known.read
      // The branch read before is kept until the new one is in.
      const entry: { at: number; read: Promise<void>; branch?: string } = { at: now(), read: Promise.resolve(), ...(known?.branch ? { branch: known.branch } : {}) }
      entry.read = project(cwd).then((found) => {
        if (found?.branch) entry.branch = found.branch
        else delete entry.branch
      }, () => { /* the folder cannot be read now: no branch is shown */ })
      branches.set(cwd, entry)
      return entry.read
    })).then(() => {})
  }

  const inSharedTab = (member: Member): boolean => directory.tabsOf(member).some((t) => !!t.sharedTabId)

  /** The branches of a harness here and its teammates here, for its note, when it is in a shared tab. */
  function branchesFor(me: Member): Promise<void> {
    if (!inSharedTab(me)) return Promise.resolve()
    const cwds = [me, ...directory.peers(me)].filter((m) => m.machineId === self()).map((m) => localAgent(m.agentId)?.cwd)
    return readBranches(cwds.filter((cwd): cwd is string => !!cwd))
  }

  /**
   * Another of the owner's machines started a harness here for one of its agents (`harness new --machine <this machine>`): kept
   * in this machine's record too, so the new harness's depth and this machine's limits count it.
   */
  function started(payload: Record<string, unknown>): Record<string, unknown> {
    const row = parseStarted(JSON.stringify(payload.row ?? null))
    if (!row || row.child.machineId !== self() || row.by.machineId === self()) throw new MessageError('INVALID_RECORD', 'That is not a harness another machine started here.')
    if (!core.agents.live().some((s) => s.agentId === row.child.agentId)) throw new MessageError('UNKNOWN_HARNESS', 'No such harness on this machine.')
    lineage.append(row)
    return { recorded: true }
  }

  /** When each starter told, for the rate limit: the same 30 in 10 minutes a `harness send` sender has. */
  const toldAt = new Map<string, number[]>()

  /**
   * `harness tell` (tell.ts): more work for a harness here from the harness that started it. From a pane on this
   * machine the starter is the pane's harness, never what the request says; from another of the owner's machines,
   * over the relay, it is that machine's word, as a hand-over's sender is (`deliver`). Either way this machine's own
   * record must say that starter started it. Queued in the mailbox, which types it once the harness's composer is
   * free, or gives it at its next tool call while it works.
   */
  async function tell(payload: Record<string, unknown>, local: boolean): Promise<Record<string, unknown>> {
    let from: Member
    if (local) {
      const pane = typeof payload.pane === 'string' ? payload.pane : ''
      const session = PANE.test(pane) ? sessionForPaneId(live(), pane) : undefined
      if (!session) throw new MessageError('NOT_A_HARNESS', 'Run harness tell from the pane of the harness that started it.')
      from = { machineId: self(), agentId: session.agentId }
    } else {
      const claimed = payload.from as Record<string, unknown> | null | undefined
      if (typeof claimed?.machineId !== 'string' || !claimed.machineId || typeof claimed.agentId !== 'string' || !claimed.agentId) {
        throw new MessageError('INVALID_REQUEST', 'Say which harness tells it.')
      }
      // This machine's own harnesses tell from their pane.
      if (claimed.machineId === self()) throw new MessageError('NOT_FROM_THERE', 'A harness on this machine tells from its pane, not over the relay.')
      from = { machineId: claimed.machineId, agentId: claimed.agentId }
    }
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!agentId) throw new MessageError('USAGE', 'Name the harness to tell.')
    if (!text.trim()) throw new MessageError('USAGE', 'Say what to do: harness tell <name> -- <work>')
    if (text.length > LIMITS.text) throw new MessageError('TOO_LONG', `A message holds at most ${LIMITS.text} characters.`)
    const refusal = tellRefusal({ on: tellOn(), lineage, self: self(), live: (id) => !!localAgent(id) }, from, agentId)
    if (refusal) throw new MessageError(refusal.code, refusal.message)
    const key = `${from.machineId}/${from.agentId}`
    const times = (toldAt.get(key) ?? []).filter((t) => now() - t < LIMITS.window)
    if (times.length >= LIMITS.perSender) throw new MessageError('RATE_LIMITED', `You told your harnesses ${LIMITS.perSender} times in 10 minutes. Wait for their answers first.`)
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on that machine. Try again once some are delivered.')
    }
    // Named as it was started: who started it is this machine's record, not the request's.
    const started = lineage.parentOf({ machineId: self(), agentId })!
    // The machine's name as the starter's CLI reads it (`machine-name`), as a start's header names it: Agent Messages'
    // directory knows names only while it is on, and without it this one was headed with the host's name
    // ("Macbooks-MacBook-Pro-5" for "Mac Auto", 2026-10-26).
    const machine = typeof payload.machine === 'string' && payload.machine.trim() ? payload.machine.trim().slice(0, 200) : machineName(from.machineId)
    const message: Message = {
      id: messageId(), tabId: TOLD_TAB, text, at: now(),
      to: [{ machineId: self(), agentId, name: started.child.name || agentId.slice(0, 8) }],
      from: { ...from, name: started.by.name || from.agentId.slice(0, 8), engine: started.by.engine || 'claude', machine },
    }
    toldAt.set(key, [...times, now()])
    store.record(message)
    store.status({ messageId: message.id, machineId: self(), agentId, state: 'queued', at: now() })
    mailbox.accept(message, agentId)
    // Asleep (Agent Messages off), the mailbox looks only while something waits: this does now.
    mailbox.resume()
    saveQuietly()
    const status = store.entry(message.id)?.statuses.find((s) => s.machineId === self() && s.agentId === agentId)
    return { id: message.id, state: status?.state ?? 'queued', ...(status?.reason ? { reason: status.reason } : {}) }
  }

  /** When programs replied to harnesses here, for the rate limit: the same 30 in 10 minutes a `tell` has. */
  const repliedAt: number[] = []

  /**
   * `harness reply` to a harness in a pane here (replyLocal.ts), from a program acting for the person: a process of the
   * owner's on this machine, or another of the owner's machines over the relay. Only an idle harness, only with the
   * person's switch on; queued in the mailbox, which types it once the composer is free.
   */
  async function replyLocal(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!agentId) throw new MessageError('USAGE', 'Name the harness to reply to.')
    if (!text.trim()) throw new MessageError('USAGE', 'Give the words: harness reply <name> -- <words>')
    if (text.length > LIMITS.text) throw new MessageError('TOO_LONG', `A message holds at most ${LIMITS.text} characters.`)
    const session = localAgent(agentId)
    const activity = session ? (await core.agents.activity([agentId]))[agentId] ?? 'unknown' : 'unknown'
    const refusal = replyRefusal({ on: replyOn(), live: !!session, activity })
    if (refusal) throw new MessageError(refusal.code, refusal.message)
    while (repliedAt.length && now() - repliedAt[0] >= LIMITS.window) repliedAt.shift()
    if (repliedAt.length >= LIMITS.perSender) throw new MessageError('RATE_LIMITED', `Programs replied to your harnesses ${LIMITS.perSender} times in 10 minutes. Wait for their answers first.`)
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on that machine. Try again once some are delivered.')
    }
    const machine = typeof payload.machine === 'string' && payload.machine.trim() ? payload.machine.trim().slice(0, 200) : machineName(self())
    const message: Message = {
      id: messageId(), tabId: REPLIED_TAB, text, at: now(),
      to: [{ machineId: self(), agentId, name: core.agents.displayName(session!) || agentId.slice(0, 8) }],
      from: { machineId: self(), agentId: PERSON_AGENT_ID, name: 'the person', engine: '', machine },
    }
    repliedAt.push(now())
    store.record(message)
    store.status({ messageId: message.id, machineId: self(), agentId, state: 'queued', at: now() })
    mailbox.accept(message, agentId)
    mailbox.resume()
    saveQuietly()
    const status = store.entry(message.id)?.statuses.find((s) => s.machineId === self() && s.agentId === agentId)
    return { id: message.id, state: status?.state ?? 'queued', ...(status?.reason ? { reason: status.reason } : {}) }
  }

  function withdrawNote(agentId: string): void {
    const pending = store.state.notes[agentId]
    if (!pending) return
    inbox.withdraw(pending.pane, pending.key)
    delete store.state.notes[agentId]
    saveQuietly()
  }

  /** Give each local agent the roster note it has not read: through its hook only, never typed. Off, take each back. */
  function notesPump(): void {
    if (!directory.current() && directory.on()) return
    const unknown: Member[] = []
    const alive = new Set(live().map((s) => s.agentId))
    // A note for a harness that is gone or stopped is withdrawn: its pane number may be another's next.
    for (const agentId of Object.keys(store.state.notes)) if (!alive.has(agentId)) withdrawNote(agentId)
    for (const session of live()) {
      const pending = store.state.notes[session.agentId]
      if (pending && inbox.claimed(pending.pane, pending.key)) {
        store.state.noted[session.agentId] = pending.signature
        delete store.state.notes[session.agentId]
        saveQuietly()
      }
      const roster = rosterOf(session.agentId)
      if (!roster) { withdrawNote(session.agentId); continue }
      // Read for the next look and for `harness send` alone: a branch never changes the note's signature.
      void branchesFor({ machineId: self(), agentId: session.agentId })
      // Only another machine can name its agents: a teammate here with no harness is stopped, and has no name to ask.
      unknown.push(...directory.peers({ machineId: self(), agentId: session.agentId }).filter((m) => m.machineId !== self() && !teammate(m).known))
      if (store.state.noted[session.agentId] === roster.signature) { withdrawNote(session.agentId); continue }
      const current = store.state.notes[session.agentId]
      const pane = inboxPane(session)
      if (current?.signature === roster.signature && current.pane === pane && inbox.waiting(current.pane, current.key)) continue
      withdrawNote(session.agentId)
      const noteKey = `0note-${roster.signature}`
      try {
        inbox.put(pane, noteKey, { session: session.sessionId ?? '', text: roster.text })
        store.state.notes[session.agentId] = { pane, key: noteKey, signature: roster.signature }
        saveQuietly()
      } catch { /* the next look puts it */ }
    }
    if (unknown.length) void learnNames(unknown, false)
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────────────

  async function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pane = typeof payload.pane === 'string' ? payload.pane : ''
    if (!PANE.test(pane)) throw new MessageError('NOT_A_HARNESS', 'Run harness send from a harness pane.')
    // A bare `%N` is `$TMUX_PANE`, a tmux pane only (`sessionForPaneId`).
    const session = sessionForPaneId(live(), pane)
    if (!session) throw new MessageError('NOT_A_HARNESS', 'This pane is not a harness Harness knows. Run harness send from an agent\'s pane.')
    // Off is the person's word, answered before the tabs are read: a backend that cannot be reached is not the reason.
    if (!directory.on()) throw new MessageError('MESSAGES_OFF', MESSAGES_OFF_TEXT)
    if (!await directory.refresh()) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness could not read who is in which tab. Try again in a moment.')
    const me = { machineId: self(), agentId: session.agentId }
    const peers = directory.peers(me)
    await learnNames(peers, true)
    const mates = distinct(me, peers)
    const names = (Array.isArray(payload.to) ? payload.to : typeof payload.to === 'string' ? payload.to.split(',') : [])
      .map((n) => String(n).trim()).filter(Boolean)
    const text = typeof payload.text === 'string' ? payload.text : ''
    // No recipient and no text: who is here, the rules, and this agent's last messages. An agent whose context
    // was compacted asks this to learn again what it was told: seen on a real team, one rebuilt it from its team
    // history in five commands.
    if (!names.length && !text) {
      await branchesFor(me)
      const roster = rosterOf(session.agentId)?.text ?? 'No teammates in this tab yet.'
      const section = await tasksSection(me)
      return { roster, recent: recentFor(me), ...(section ? { tasks: section } : {}) }
    }
    // Alone in its tab, or in none: a name it gives can be no one's, and the person is the one who can change that.
    if (!peers.length) throw new MessageError('NO_TEAMMATES', 'No other harness is in this tab. The person puts harnesses in one tab for them to message each other.')
    if (!names.length) throw new MessageError('USAGE', 'Name who to message: harness send <name> "text"')
    if (!text.trim()) throw new MessageError('USAGE', 'Write the message: harness send <name> "text"')
    if (text.length > LIMITS.text) throw new MessageError('TOO_LONG', `A message holds at most ${LIMITS.text} characters.`)
    const recipients: Recipient[] = []
    for (const name of names) {
      const wanted = name.toLowerCase()
      // The name as listed first; then another account's harness by its name with its account's prefix (`bob/web` for
      // a `web` no one else has); then the start of a name as listed or of another account's harness's own name, together:
      // a bare `api` taken whole before the start of the others picked Bob's `api` over this account's `api (abcd1234)`,
      // where the sender meant either (review of B1), so a name both could be is AMBIGUOUS. Last, the start of a name
      // with its account's prefix (`carol/w`).
      const starts = (n: string | undefined): boolean => n !== undefined && (n.startsWith(wanted) || cutShort(n, wanted))
      const exact = mates.filter((m) => m.name.toLowerCase() === wanted)
      const qualified = exact.length ? exact : mates.filter((m) => m.qualified === wanted)
      const listed = qualified.length ? qualified : mates.filter((m) => starts(m.name.toLowerCase()) || starts(m.bare))
      const prefix = listed.length ? listed : mates.filter((m) => starts(m.qualified))
      // Or the start of its id: a name is the session's title until someone names it, and a title can hold a comma,
      // which the recipient list splits on.
      const found = prefix.length || wanted.length < 6 ? prefix : mates.filter((m) => m.member.agentId.toLowerCase().startsWith(wanted))
      const list = mates.map((m) => m.name).join(', ') || 'nobody yet'
      if (!found.length) throw new MessageError('UNKNOWN_RECIPIENT', `No teammate named "${name}" in this tab. Teammates: ${list}.`)
      if (found.length > 1) throw new MessageError('AMBIGUOUS_RECIPIENT', `"${name}" could be ${found.map((m) => m.name).join(' or ')}. Use more of the name.`)
      if (!recipients.some((r) => r.machineId === found[0].member.machineId && r.agentId === found[0].member.agentId)) {
        recipients.push({ ...found[0].member, name: found[0].name })
      }
    }
    if (recipients.length > LIMITS.recipients) throw new MessageError('TOO_MANY_RECIPIENTS', `A message goes to at most ${LIMITS.recipients} teammates.`)
    // The first recipient's tab names the message's log. The directory and the setting can change while other
    // machines are asked for names: Agent Messages turned off, or the tab left, meanwhile leaves none, and nothing is
    // sent.
    const tab = directory.shared(me, recipients[0])
    if (!tab && !directory.on()) throw new MessageError('MESSAGES_OFF', `${MESSAGES_OFF_TEXT} Nothing was sent.`)
    if (!tab) throw new MessageError('NOT_IN_TAB', `${recipients[0].name} is no longer in a tab with you. Nothing was sent.`)
    const times = (sent.get(session.agentId) ?? []).filter((t) => now() - t < LIMITS.window)
    if (times.length >= LIMITS.perSender) {
      core.clients.windows({ type: 'messages_changed', payload: { limited: { machineId: self(), agentId: session.agentId } } })
      throw new MessageError('RATE_LIMITED', `This harness sent ${LIMITS.perSender} messages in 10 minutes. Wait, or work on without its teammates for now.`)
    }
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on this machine. Try again once some are delivered.')
    }
    const message: Message = {
      id: messageId(), tabId: tab.id, to: recipients, text, at: now(), ...(payload.fyi === true ? { fyi: true as const } : {}),
      from: { ...me, name: ownName(me, peers), engine: session.engine, machine: machineName(self()) },
    }
    // How each other machine is reached, decided now and kept with its hand-over: another account's machine only
    // through a shared tab whose roster carries the message, in one frame, within the tab's limit.
    const ways = new Map<string, string | undefined>()
    for (const machineId of new Set(recipients.filter((r) => r.machineId !== self()).map((r) => r.machineId))) {
      const way = route(machineId, message)
      if (way === null || way === 'relay') { ways.set(machineId, undefined); continue }
      const roster = way.tab ? rosters?.current(way.tab)?.roster : undefined
      if (!roster || !carries(roster, message, machineId, account!.accountId)) {
        throw new MessageError('NOT_IN_TAB', `${recipients.find((r) => r.machineId === machineId)!.name} is no longer in a tab with you. Nothing was sent.`)
      }
      if (!fitsRequest({ action: 'deliver', message: wireMessage(message, roster.sharedTabId) })) throw new MessageError('TOO_LARGE', `${TOO_LARGE_TEXT} Nothing was sent.`)
      ways.set(machineId, roster.sharedTabId)
    }
    const tabs = new Set([...ways.values()].filter((id): id is string => !!id))
    for (const id of tabs) {
      if (tabSent.room(id, LIMITS.perTab, LIMITS.window, now())) continue
      core.clients.windows({ type: 'messages_changed', payload: { limited: { machineId: self(), agentId: session.agentId, sharedTabId: id } } })
      throw new MessageError('RATE_LIMITED', `This computer sent ${LIMITS.perTab} messages into that shared tab in 10 minutes. Wait, or work on without those teammates for now.`)
    }
    sent.set(session.agentId, [...times, now()])
    for (const id of tabs) tabSent.take(id, LIMITS.perTab, LIMITS.window, now())
    store.record(message)
    for (const r of recipients) store.status({ messageId: message.id, machineId: r.machineId, agentId: r.agentId, state: 'queued', at: now() })
    for (const r of recipients.filter((r) => r.machineId === self())) mailbox.accept(message, r.agentId)
    for (const [machineId, sharedTabId] of ways) {
      store.state.outbox.push({ messageId: message.id, machineId, nextTryAt: now(), tries: 0, ...(sharedTabId ? { sharedTabId } : {}) })
    }
    saveQuietly()
    await handOver(message.id)
    tellWindows(message.id)
    const entry = store.entry(message.id)!
    return {
      id: message.id, tab: tab.name,
      recipients: recipients.map((r) => {
        const status = entry.statuses.find((s) => s.machineId === r.machineId && s.agentId === r.agentId)
        return { name: r.name, state: status?.state ?? 'queued', ...(status?.via ? { via: status.via } : {}), ...(status?.reason ? { reason: status.reason } : {}),
          ...(status?.code ? { code: status.code } : {}) }
      }),
      ...(text.length > LONG_TEXT ? { advice: longAdvice(text.length) } : {}),
    }
  }

  /**
   * What `harness send` alone gives an agent besides the roster: every message still waiting for it, which it has
   * now read, then its last few. An agent whose engine started before Agent Messages never runs the hook and, always
   * working, is never typed to: it read its messages this way, but only the last five, each still "queued", and a
   * restart would have given it all of them again (a Codex lead, 2026-10-12).
   */
  function recentFor(me: Member, count = 5): Array<Record<string, unknown>> {
    const mine = (m: Member) => m.machineId === me.machineId && m.agentId === me.agentId
    const involving = store.state.history.filter((e) => mine(e.message.from) || e.message.to.some(mine))
    const waiting = involving.filter((e) => !mine(e.message.from) && e.statuses.find((s) => mine(s))?.state === 'queued').slice(-UNREAD_MAX)
    const read = new Set(mailbox.read(me.agentId, waiting.map((e) => e.message.id)))
    const shown = [...new Set([...waiting, ...involving.slice(-count)])].sort((a, b) => a.message.at - b.message.at)
    return shown.map((e) => {
      const sent = mine(e.message.from)
      const status = sent ? e.statuses.find((s) => s.state !== 'delivered') ?? e.statuses[0] : e.statuses.find((s) => mine(s))
      return { id: e.message.id, at: e.message.at, ...(sent ? { to: e.message.to.map((r) => r.name) } : { from: e.message.from.name }),
        text: e.message.text, state: read.has(e.message.id) ? 'delivered' : status?.state ?? 'queued', ...(read.has(e.message.id) ? { unread: true } : {}) }
    })
  }

  // ── routes ───────────────────────────────────────────────────────────────────────────────────────

  /** Whether a machine is this account's: this one, or one its directory lists (the backend lists all of the account's). */
  const ownMachine = (machineId: string): boolean => machineId === self() || !!directory.current()?.machines.has(machineId)

  /** The held tabs that list a harness of another account's on a machine; none for a machine of this account's, which a
   *  roster of another account's may list under its own (sharedDirectory.ts takes it out the same way). */
  function tabsWith(machineId: string): Roster[] {
    const mine = account?.accountId
    if (!mine || ownMachine(machineId)) return []
    return (rosters?.all() ?? []).filter((r) => r.harnesses.some((h) => h.machineId === machineId && h.accountId !== mine))
  }
  const tabOf = (machineId: string): string | null => tabsWith(machineId)[0]?.sharedTabId ?? null

  /**
   * How a message reaches another machine: `'relay'`, this account's paired relay, as before shared tabs; `{ tab }`, the
   * shared tab whose relay carries it to another account's machine (one whose roster carries the message, when one
   * does), or `{ tab: null }` for another account's machine no held tab lists any more; null while it cannot be told
   * (the directory not read yet). `stored`: the tab chosen when it was sent, which stands. A message queued for another
   * account's harness before routes were kept (step 1b's B1) went to this account's relay, which only ever answered
   * that the machine was not paired, and was tried again for good: it goes through its tab now (review of B1).
   */
  function route(machineId: string, message: Message, stored?: string): 'relay' | { tab: string | null } | null {
    // Which machines are this account's is the directory's word: unread, nothing is decided, and nothing is sent.
    if (!directory.current()) return null
    // One of this account's machines goes over its own relay, whatever route was kept: a roster of another account's
    // listing it cannot pin it to a tab.
    if (ownMachine(machineId)) return 'relay'
    if (stored) return { tab: stored }
    const held = rosters?.all() ?? []
    if (held.length && !account) return null
    const tabs = tabsWith(machineId)
    if (tabs.length) return { tab: (tabs.find((r) => carries(r, message, machineId, account!.accountId)) ?? tabs[0]).sharedTabId }
    // Not one of the account's machines, nor in a held tab: another account's machine that left, or one a message was
    // queued for before routes were kept. Held, then failed, never tried for good over this account's relay.
    return { tab: null }
  }

  /** An Agent Messages request to another account's machine through a shared tab (sharedTabs.ts `request`): its answer;
   *  its refusal as a RefusedError, its words cleaned (they are another account's); a MessageError when it could not be
   *  asked. */
  async function askTab(sharedTabId: string, machineId: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!shared) throw new MessageError('PEER_AWAY', 'Shared tabs are not running on this computer right now.')
    const answer = await shared.request(sharedTabId, machineId, payload, timeoutMs)
    if (answer.error !== undefined) throw new RefusedError(statusCode(answer.error) ?? 'REFUSED', cleanText(answer.detail, 300) || 'refused')
    return answer
  }

  let missedTabAt = -Infinity
  /** An answer within `ms`, or null: a machine that did not answer, or refused, is not waited for longer. */
  async function within(asking: Promise<Record<string, unknown>>, ms: number): Promise<Record<string, unknown> | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), ms); timer.unref?.() })
    return Promise.race([asking.catch(() => null), late]).finally(() => clearTimeout(timer))
  }

  /**
   * Each harness of a held tab with its repo and branch, asked of its machine as a tab's note does (`who`). A machine is
   * asked only for the roster's harnesses on it, and only the answers for those are kept, so People never names more than
   * `who` already does; a machine that does not answer within WHO_WAIT_MS is left out, not waited for.
   */
  async function sharedWho(sharedTabId: string): Promise<Record<string, unknown>> {
    const roster = rosters?.current(sharedTabId)?.roster
    if (!roster) throw new MessageError('NOT_SHARED', 'This computer holds no shared tab with that id.')
    const me = await signedInAs()
    const byMachine = new Map<string, string[]>()
    for (const h of roster.harnesses) byMachine.set(h.machineId, [...(byMachine.get(h.machineId) ?? []), h.agentId])
    const answers = await Promise.all([...byMachine].map(async ([machineId, agentIds]) => {
      const payload = { action: 'who', agentIds }
      const own = roster.harnesses.some((h) => h.machineId === machineId && h.accountId === me.accountId)
      const asking = machineId === self() ? whoAre(payload, undefined, false) : own ? rpc(at(machineId), payload, WHO_WAIT_MS) : askTab(sharedTabId, machineId, payload, WHO_WAIT_MS)
      const answer = await within(asking, WHO_WAIT_MS)
      const agents = Array.isArray(answer?.agents) ? answer.agents as Record<string, unknown>[] : []
      return agents.filter((a) => typeof a.agentId === 'string' && agentIds.includes(a.agentId)).map((a) => ({ machineId, agentId: a.agentId as string,
        ...(typeof a.project === 'string' ? { project: cleanText(a.project, 120) } : {}), ...(typeof a.branch === 'string' ? { branch: cleanText(a.branch, 200) } : {}) }))
    }))
    return { harnesses: answers.flat() }
  }

  /** The name of the account another account's machine is in, as the rosters held here name it (`Bob`). */
  function accountName(machineId: string): string {
    const all = rosters?.all() ?? []
    const accountId = all.flatMap((r) => r.harnesses).find((h) => h.machineId === machineId && h.accountId !== account?.accountId)?.accountId
    return (accountId && accountsIn(all).get(accountId)?.name) || 'Its owner'
  }

  /** Why a hand-over through a shared tab waits, as the person reads it. */
  function tabReason(error: unknown, sharedTabId: string, machineId: string): string {
    if (error instanceof RefusedError) return `${accountName(machineId)}'s computer did not take it: ${error.message}. It is handed over again later`
    if (error instanceof MessageError && error.code === 'RELAY_TAKEN') {
      const roster = rosters?.current(sharedTabId)?.roster
      const owner = (roster && accountsIn([roster]).get(roster.owner.accountId)?.name) || 'The shared'
      return `${owner}'s tab is connected elsewhere on this computer: it is handed over once this computer has the tab again`
    }
    return `${accountName(machineId)}'s computer is away: handed over once it is back`
  }

  function setStatuses(entry: Entry, machineId: string, status: Pick<DeliveryStatus, 'state' | 'reason' | 'code'>): void {
    for (const r of entry.message.to.filter((r) => r.machineId === machineId)) {
      if (store.status({ messageId: entry.message.id, machineId, agentId: r.agentId, ...status, at: now() })) tellWindows(entry.message.id)
    }
  }

  /**
   * Whether a hand-over to another account's machine may go now: the shared tab's roster, as this computer holds it,
   * still carries it. One it no longer carries waits HELD_OUTSIDE_MS, as a delivery here does when its tab stops
   * carrying it (`verdict`), and then fails NOT_IN_TAB, never lingering: a member removed while a message to them waited
   * (the plan's Review Focus 2). False while this computer's account is not known: nothing is decided then.
   */
  function carriedNow(outgoing: Outgoing, entry: Entry, sharedTabId: string | null): boolean {
    if (sharedTabId && !account) return false
    const k = `${outgoing.messageId} ${outgoing.machineId}`
    const roster = sharedTabId ? rosters?.current(sharedTabId)?.roster : undefined
    if (roster && carries(roster, entry.message, outgoing.machineId, account!.accountId)) { outboxOutside.delete(k); return true }
    const since = outboxOutside.get(k) ?? now()
    if (now() - since < HELD_OUTSIDE_MS) {
      outboxOutside.set(k, since)
      outgoing.reason = HELD_LEFT_REASON
      setStatuses(entry, outgoing.machineId, { state: 'queued', reason: HELD_LEFT_REASON })
      return false
    }
    outboxOutside.delete(k)
    store.state.outbox = store.state.outbox.filter((o) => o !== outgoing)
    setStatuses(entry, outgoing.machineId, { state: 'failed', code: 'NOT_IN_TAB', reason: LEFT_TAB_REASON })
    saveQuietly()
    return false
  }

  /** Hand what waits in the outbox to its machines: now for one message (`onlyId`, as it is sent) or every one for one
   *  machine (`toMachine`, as a session with it opens), or else every one that is due. */
  async function handOver(onlyId?: string, toMachine?: string): Promise<void> {
    const forced = onlyId !== undefined || toMachine !== undefined
    const looked = store.state.outbox.filter((o) => !handing.has(o) && (onlyId ? o.messageId === onlyId : !toMachine || o.machineId === toMachine))
    let changed = false
    await Promise.all(looked.map(async (outgoing) => {
      const entry = store.entry(outgoing.messageId)
      if (!entry) { store.state.outbox = store.state.outbox.filter((o) => o !== outgoing); changed = true; return }
      const way = route(outgoing.machineId, entry.message, outgoing.sharedTabId)
      if (!way) return
      if (way !== 'relay') {
        if (way.tab && outgoing.sharedTabId !== way.tab) { outgoing.sharedTabId = way.tab; changed = true }
        if (!carriedNow(outgoing, entry, way.tab)) return
      }
      if (!forced && now() < outgoing.nextTryAt) return
      changed = true
      handing.add(outgoing)
      try {
        const answer = way === 'relay'
          ? await rpc(at(outgoing.machineId), { action: 'deliver', message: entry.message }, 10_000)
          : await askTab(way.tab!, outgoing.machineId, { action: 'deliver', message: wireMessage(entry.message, way.tab!) }, 10_000)
        store.state.outbox = store.state.outbox.filter((o) => o !== outgoing)
        applyRemote(outgoing.machineId, answer.statuses)
      } catch (error) {
        // A frame no relay carries is never sent again: it fails, as `harness send` refuses one now.
        if (error instanceof MessageError && error.code === 'TOO_LARGE') {
          store.state.outbox = store.state.outbox.filter((o) => o !== outgoing)
          setStatuses(entry, outgoing.machineId, { state: 'failed', code: 'TOO_LARGE', reason: TOO_LARGE_TEXT })
          return
        }
        outgoing.tries += 1
        outgoing.nextTryAt = now() + Math.min(5 * 60_000, 5_000 * 2 ** Math.min(outgoing.tries, 6))
        outgoing.reason = way !== 'relay' ? tabReason(error, way.tab!, outgoing.machineId)
          : error instanceof MessageError && error.code === 'NO_PEER_LINK' ? 'that machine is not paired with this one' : 'that machine is away: it is handed over once it is back'
        setStatuses(entry, outgoing.machineId, { state: 'queued', reason: outgoing.reason })
      } finally { handing.delete(outgoing) }
    }))
    if (changed) saveQuietly()
  }

  /**
   * What another machine said became of its agents' deliveries. Every way one arrives is kept: a message an agent
   * read with `harness send` came back as a bare "delivered" to the machine that sent it, so its sender never saw
   * that it was read (two machines, 2026-10-12). Only for a recipient of that message on that machine, and its words
   * cleaned: another account's machine answers through a shared tab, and a reason is shown to the person.
   */
  function applyRemote(machineId: string, statuses: unknown): void {
    for (const s of Array.isArray(statuses) ? statuses as Record<string, unknown>[] : []) {
      if (typeof s.messageId !== 'string' || typeof s.agentId !== 'string' || !['queued', 'delivered', 'failed'].includes(String(s.state))) continue
      if (!store.entry(s.messageId)?.message.to.some((r) => r.machineId === machineId && r.agentId === s.agentId)) continue
      const reason = cleanText(s.reason, 300), code = statusCode(s.code)
      const status: DeliveryStatus = { messageId: s.messageId, machineId, agentId: s.agentId, state: s.state as DeliveryStatus['state'],
        ...(s.via === 'hook' || s.via === 'prompt' || s.via === 'read' ? { via: s.via } : {}), ...(reason ? { reason } : {}), ...(code ? { code } : {}), at: now() }
      if (store.status(status)) tellWindows(status.messageId)
    }
  }

  /**
   * Ask other machines what became of this machine's messages still waiting there, each by its route. One waiting on
   * another account's machine that no held tab lists any more cannot be asked: once it has been so for
   * HELD_OUTSIDE_MS it fails NOT_IN_TAB, saying what is not known, rather than wait for good (review of B2).
   */
  async function remoteStatus(): Promise<void> {
    const waiting = new Map<string, { machineId: string; tab?: string; ids: string[] }>()
    let changed = false
    for (const entry of store.state.history) {
      if (entry.message.from.machineId !== self()) continue
      for (const s of [...entry.statuses]) {
        if (s.machineId === self() || s.state !== 'queued' || store.state.outbox.some((o) => o.messageId === entry.message.id && o.machineId === s.machineId)) continue
        const way = route(s.machineId, entry.message)
        if (!way) continue
        // The same key as the outbox's hold: a message is in the outbox or handed over, never both.
        const held = `${entry.message.id} ${s.machineId}`
        if (way !== 'relay' && !way.tab) {
          const since = outboxOutside.get(held) ?? now()
          if (now() - since < HELD_OUTSIDE_MS) { outboxOutside.set(held, since); continue }
          outboxOutside.delete(held)
          if (store.status({ ...s, state: 'failed', code: 'NOT_IN_TAB', reason: LEFT_AFTER_HANDOVER_REASON, at: now() })) { tellWindows(entry.message.id); changed = true }
          continue
        }
        outboxOutside.delete(held)
        const tab = way === 'relay' ? undefined : way.tab!
        const k = `${s.machineId} ${tab ?? ''}`
        const ask = waiting.get(k) ?? { machineId: s.machineId, ...(tab ? { tab } : {}), ids: [] }
        if (!ask.ids.includes(entry.message.id)) ask.ids.push(entry.message.id)
        waiting.set(k, ask)
      }
    }
    await Promise.all([...waiting.values()].map(async ({ machineId, tab, ids }) => {
      const payload = { action: 'status', ids: ids.slice(-200) }
      try { applyRemote(machineId, (tab ? await askTab(tab, machineId, payload, 10_000) : await rpc(at(machineId), payload, 10_000)).statuses) } catch { /* asked again later */ }
    }))
    if (waiting.size || changed) saveQuietly()
  }

  // ── another machine's requests ───────────────────────────────────────────────────────────────────

  /** A hand-over from another of the owner's machines, over the paired relay. */
  async function deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = parseMessage(payload.message)
    if (!parsed) throw new MessageError('INVALID_MESSAGE', 'That is not a message.')
    // This machine's own harnesses send through `send`, which names them by their pane: never as another's.
    if (parsed.from.machineId === self()) throw new MessageError('NOT_FROM_THERE', 'A message from this machine is sent here, not handed over.')
    // Another account's harness speaks only through its shared tab, where the roster says whose it is: over this
    // account's relay it would pass for one of this account's, its header naming whatever account it wrote.
    if (tabsWith(parsed.from.machineId).length) throw new MessageError('NOT_FROM_THERE', 'A message from another account\'s harness comes through its shared tab.')
    const { accountId: _id, account: _name, ...from } = parsed.from
    const message = { ...parsed, from }
    // Off here, it fails below whatever the tabs say: they are not read for it.
    if (directory.on() && !await directory.refresh()) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness could not read who is in which tab. It is handed over again later.')
    return acceptHandedOver(message)
  }

  /**
   * A message another machine handed over, for this machine's agents, once its sender is known to be who it says
   * (`deliver`, `deliverFromTab`): each recipient here gets it once, while a tab carries it from the sender (`account`:
   * listed under that account, for another account's sender) and Agent Messages are on here; otherwise it fails at once.
   * Taken again after a lost reply, it is the same delivery, never a second.
   */
  function acceptHandedOver(message: Message, account?: string): Record<string, unknown> {
    if (store.state.local.filter((d) => d.state === 'queued').length >= LIMITS.waiting) {
      throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on that machine. It is handed over again later.')
    }
    const known = store.entry(message.id)
    if (!known) store.record(message)
    const statuses: DeliveryStatus[] = []
    for (const r of message.to.filter((r) => r.machineId === self())) {
      if (!known && !store.state.local.some((d) => d.messageId === message.id && d.agentId === r.agentId)) {
        // Off here, a hand-over fails at once, as one to an agent outside the sender's tabs does: only what already
        // waits here is held through a switch turned off and on again.
        if (!directory.shared(message.from, r, account)) {
          store.status({ messageId: message.id, machineId: self(), agentId: r.agentId, state: 'failed', reason: directory.on() ? 'it is not in a tab with the sender' : 'Agent Messages are off on its computer', at: now() })
        } else {
          store.status({ messageId: message.id, machineId: self(), agentId: r.agentId, state: 'queued', at: now() })
          mailbox.accept(message, r.agentId)
        }
      }
      const s = store.entry(message.id)!.statuses.find((x) => x.machineId === self() && x.agentId === r.agentId)
      if (s) statuses.push(s)
    }
    saveQuietly()
    tellWindows(message.id)
    return { statuses }
  }

  /**
   * Another account's machine's request, through a tab shared with this account (sharedTabs.ts `answer`): only
   * `deliver`, `status` and `who`, each against the tab's roster as this computer holds it and the relay's stamp.
   */
  async function answerTab(ctx: TabContext, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const roster = rosters?.current(ctx.sharedTabId)?.roster
    if (!roster) throw new MessageError('NOT_SHARED', 'This computer holds no such shared tab.')
    const me = await signedInAs()
    switch (payload.action) {
      case 'deliver': return deliverFromTab(ctx, roster, me.accountId, payload)
      // Only what that machine sent: what became of anyone else's messages is not its to know.
      case 'status': return statusOf(payload, ctx.from.machineId)
      // Only this machine's harnesses the tab lists under this account, and in another account's tab only those this
      // machine asked for (consentStore.ts): an unshared one, or one taken out, is never named to another account.
      // Another account's machine says its harnesses work, to the windows (tabActivity.ts): not a message, so never counted
      // toward the limits, and bounded by the pace `take` keeps.
      case 'activity': {
        const listed = (agentId: string) => roster.harnesses.some((h) => h.machineId === ctx.from.machineId && h.agentId === agentId)
        for (const a of activityIn.take(ctx.sharedTabId, ctx.from.machineId, payload.agents, listed, now())) {
          core.clients.windows({ type: SHARED_ACTIVITY_WINDOW_FRAME, payload: { ...a } })
        }
        return { ok: true }
      }
      case 'who': return whoAre(payload, (agentId) => roster.harnesses.some((h) => h.machineId === self() && h.agentId === agentId && h.accountId === me.accountId)
        && (roster.owner.accountId === me.accountId || consented(ctx.sharedTabId, agentId)), false)
      default: throw new MessageError('UNKNOWN_ACTION', 'Unknown Agent Messages request.')
    }
  }

  /**
   * A message another account's harness handed over through a shared tab. Refused before anything reaches a pane when
   * the roster does not list its sender under the account the relay stamped, or lists a recipient here under another
   * account (tabDelivery.ts `checkHandedOver`, the plan's Review Focus 3); over the tab's limits, failed RATE_LIMITED.
   * On the account that shares the tab, logged under the desk tab it is shared from, as its windows show it.
   */
  async function deliverFromTab(ctx: TabContext, roster: Roster, accountId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = parseMessage(payload.message)
    if (!parsed) throw new MessageError('INVALID_MESSAGE', 'That is not a message.')
    const checked = checkHandedOver(roster, ctx, parsed, { accountId, machineId: self(), machineName, consented: (agentId) => consented(ctx.sharedTabId, agentId) })
    // A recipient this machine never put in the tab, or took out of it, is failed for good: the sender's roster may list
    // it for as long as the owner does, and tried again it would be refused every time.
    if ('refused' in checked) {
      if (checked.code) return failAll(parsed, checked.code, checked.refused)
      throw new MessageError('REFUSED', checked.refused)
    }
    let message = checked.message
    if (roster.owner.accountId === accountId) {
      const desk = shared?.deskTab(ctx.sharedTabId)
      if (!desk) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness has not read which tab this is shared from yet. It is handed over again later.')
      message = { ...message, tabId: desk }
    }
    const known = store.entry(message.id)
    // An id another sender's message holds here is not this one's: answering would tell what became of that message.
    if (known && (known.message.from.machineId !== message.from.machineId || known.message.from.agentId !== message.from.agentId)) {
      throw new MessageError('REFUSED', 'that message id is another message\'s')
    }
    if (directory.on() && !await directory.refresh()) throw new MessageError('DIRECTORY_UNAVAILABLE', 'Harness could not read who is in which tab. It is handed over again later.')
    // Counted once per message, after the last wait: a hand-over repeated after a lost reply is not another message.
    if (!store.entry(message.id)) {
      const limited = overTabLimit(ctx, message)
      if (limited) return failAll(message, 'RATE_LIMITED', limited)
    }
    return acceptHandedOver(message, ctx.from.userId)
  }

  /** Why a message through a shared tab is over the tab's limits on this side, or null, counting it when it is not. */
  function overTabLimit(ctx: TabContext, message: Message): string | null {
    const sender = `${ctx.sharedTabId} ${message.from.machineId}/${message.from.agentId}`
    if (!senderTaken.room(sender, LIMITS.perSender, LIMITS.window, now())) return `its sender sent ${LIMITS.perSender} messages in 10 minutes`
    if (!tabTaken.room(ctx.sharedTabId, LIMITS.perTab, LIMITS.window, now())) return `its shared tab carried ${LIMITS.perTab} messages in 10 minutes`
    senderTaken.take(sender, LIMITS.perSender, LIMITS.window, now())
    tabTaken.take(ctx.sharedTabId, LIMITS.perTab, LIMITS.window, now())
    return null
  }

  /**
   * Every recipient here failed, as the answer, with nothing kept: a message over a limit is never written to the log
   * or the disk, or a listed member flooding the tab would push this computer's real history out of it (review of B2).
   * Handed over again, it is checked again.
   */
  function failAll(message: Message, code: string, reason: string): Record<string, unknown> {
    return { statuses: message.to.filter((r) => r.machineId === self()).map((r) => ({ messageId: message.id, machineId: self(), agentId: r.agentId, state: 'failed', code, reason, at: now() })) }
  }

  /** What became of messages here, for the machine that asks: with `from`, only the messages that machine sent. */
  function statusOf(payload: Record<string, unknown>, from?: string): Record<string, unknown> {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : []
    return { statuses: ids.flatMap((id) => {
      const entry = store.entry(id)
      return entry && (!from || entry.message.from.machineId === from) ? entry.statuses.filter((s) => s.machineId === self()) : []
    }) }
  }

  /** This machine's agents' names, for the machine that asks (`ownMachine`: one of the account's own, which is also told each
   *  harness's state and summary; another account's never is, it has `activity` for what it may know): with `listed`, only those it may name. A harness in a
   *  shared tab's branch too, for that tab's note on the asking machine; no Git runs for any other. */
  async function whoAre(payload: Record<string, unknown>, listed: (agentId: string) => boolean = () => true, ownMachine = true): Promise<Record<string, unknown>> {
    const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
    const sessions = ids.filter(listed).flatMap((agentId) => { const session = localAgent(agentId); return session ? [session] : [] })
    const shared = new Set(sessions.filter((s) => s.cwd && inSharedTab({ machineId: self(), agentId: s.agentId })).map((s) => s.cwd!))
    const [, now] = await Promise.all([readBranches([...shared]), ownMachine ? activityNow(sessions.map((s) => s.agentId), true) : Promise.resolve<Record<string, ActivityNow>>({})])
    return { agents: sessions.map((session) => {
      const branch = session.cwd && shared.has(session.cwd) ? branches.get(session.cwd)?.branch : undefined
      return { agentId: session.agentId, name: core.agents.displayName(session) || session.agentId.slice(0, 8), engine: session.engine,
        ...(session.cwd ? { project: basename(session.cwd) } : {}), ...(branch ? { branch } : {}), ...(ownMachine ? now[session.agentId] ?? { state: 'unknown' } : {}) }
    }) }
  }

  /** What this machine's harnesses are doing now, as its core says: their state and, unless it is to be kept back, one
   *  line on what each does: only for the agents the core reports (it reports none that is not live). */
  async function activityNow(agentIds: string[], withSummary: boolean): Promise<Record<string, ActivityNow>> {
    if (!agentIds.length) return {}
    const [states, lines] = await Promise.all([core.agents.activity(agentIds), withSummary ? core.agents.summaries(agentIds) : Promise.resolve<Record<string, string>>({})])
    return Object.fromEntries(Object.entries(states).map(([agentId, state]) => [agentId, { state, ...(lines[agentId] ? { summary: lines[agentId] } : {}) }]))
  }

  /**
   * Every harness of one of this account's desk tabs, shared or not, with what it does now (`tab_activity`, the sidebar's
   * rows): this machine's from the core; the account's other machines' by `who`, which they answer with state and summary,
   * `away` for one that does not answer within WHO_WAIT_MS; other accounts' from what their machines told
   * (tabActivity.ts), for a tab shared with them. Nothing here needs shared tabs to be running.
   */
  async function tabActivity(tabId: string): Promise<Record<string, unknown>> {
    if (!messagingOn()) throw new MessageError('MESSAGES_OFF', MESSAGES_OFF_TEXT)
    const me = await signedInAs()
    const onDesk = (): DirectoryTab | undefined => directory.current()?.tabs.find((t) => t.id === tabId)
    // A tab it does not know may be new: the desk is read again for it, but not more than once in MISSED_TAB_READ_MS, so ids a window
    // makes up cannot drive reads of the backend.
    if (!onDesk() && now() - missedTabAt >= MISSED_TAB_READ_MS) { missedTabAt = now(); await directory.refresh() }
    const tab = onDesk()
    if (!tab) throw new MessageError('NOT_A_TAB', 'That tab is not on your desk.')
    const foreign = (m: Member): boolean => !!m.accountId && m.accountId !== me.accountId
    const byMachine = new Map<string, string[]>()
    for (const m of tab.panes.filter((p) => !foreign(p))) byMachine.set(m.machineId, [...(byMachine.get(m.machineId) ?? []), m.agentId])
    const known = new Map<string, ActivityNow & { away?: true }>()
    await Promise.all([...byMachine].map(async ([machineId, agentIds]) => {
      if (machineId === self()) {
        const now = await activityNow(agentIds, true)
        for (const agentId of agentIds) known.set(`${machineId} ${agentId}`, now[agentId] ?? { state: 'unknown' })
        return
      }
      const answer = await within(rpc(at(machineId), { action: 'who', agentIds }, WHO_WAIT_MS), WHO_WAIT_MS)
      // An answer that names no state is a daemon from before them: its harnesses are not away, only not known.
      const heard = new Map((Array.isArray(answer?.agents) ? answer.agents as Record<string, unknown>[] : []).map((a) => [a.agentId, a]))
      for (const agentId of agentIds) {
        const a = heard.get(agentId)
        const summary = cleanSummary(a?.summary)
        known.set(`${machineId} ${agentId}`, { state: ACTIVITY_STATES.has(a?.state as ActivityState) ? a!.state as ActivityState : 'unknown',
          ...(summary ? { summary } : {}), ...(answer ? {} : { away: true as const }) })
      }
    }))
    return { harnesses: tab.panes.map((m) => ({ machineId: m.machineId, agentId: m.agentId,
      ...(foreign(m) ? (tab.sharedTabId ? activityIn.of(tab.sharedTabId, m.machineId, m.agentId, now()) : undefined) ?? { state: 'unknown' }
        : known.get(`${m.machineId} ${m.agentId}`)) })) }
  }

  function history(payload: Record<string, unknown>): Record<string, unknown> {
    const tabId = typeof payload.tabId === 'string' ? payload.tabId : null
    const limit = typeof payload.limit === 'number' && payload.limit > 0 ? Math.min(payload.limit, LIMITS.history) : 200
    const entries = store.state.history.filter((e) => !tabId || e.message.tabId === tabId)
    return { messages: entries.slice(-limit).map((e) => ({ ...e.message, statuses: e.statuses })) }
  }

  /**
   * Inbox files nothing here is waiting to deliver, from a service that stopped or a daemon long gone (the inboxes
   * are every daemon's on this computer): removed once they are old enough not to be another live daemon's
   * delivery in the making, which that daemon puts back anyway.
   */
  function sweep(): void {
    const ours = new Set([
      ...store.state.local.filter((d) => d.state === 'queued' && d.pane).map((d) => `${d.pane}/${d.key}`),
      ...Object.values(store.state.notes).map((n) => `${n.pane}/${n.key}`),
    ])
    for (const entry of inbox.entries()) {
      if (!ours.has(`${entry.pane}/${entry.key}`) && now() - entry.at > SWEEP_AFTER_MS) inbox.withdraw(entry.pane, entry.key)
    }
  }

  function saveQuietly(): void {
    try { store.save() } catch { /* kept in memory; the next change saves again */ }
  }

  // ── tabs shared with other accounts ──────────────────────────────────────────────────────────────

  /** The shared tabs this computer holds, read from its file once it first wakes; null until then, or when the file
   *  cannot be read, which leaves shared tabs unavailable and Agent Messages as they were. */
  let rosters: RosterStore | null = null
  /** The harnesses this account asked to have in a shared tab, from this machine (consentStore.ts), which Share reads. */
  let consent: ConsentStore | null = null
  /** The notices the person has not dismissed (noticeStore.ts), kept across sleep with the same writer. */
  let notices: NoticeStore | null = null
  /** Whether this machine asked for one of its harnesses in a tab (consentStore.ts). */
  const consented = (sharedTabId: string, agentId: string): boolean => !!consent?.keys().has(consentKey(sharedTabId, self(), agentId))
  /** Shared tabs, while awake only: asleep, no relay socket stays open and nothing about them runs. */
  let shared: SharedTabs | null = null
  let sharesRev = 0
  let sharesTimer: ReturnType<typeof setTimeout> | null = null
  let stopFrames: (() => void) | null = null
  let account: { accountId: string; email: string } | null = null
  const machineKeys = new Map<string, { pub: string; at: number }>()

  /** The account signed in here, as the core says it (`core.account.identity`): a sign-in to another account starts a
   *  new daemon, so it is asked once. Never read from the backend here: in its process this service may call only the
   *  routes the core allows it (core/api.ts `MESSAGES_BACKEND_ROUTES`). */
  async function signedInAs(): Promise<{ machineId: string; accountId: string; email: string }> {
    account ??= await core.account.identity()
    if (!account) throw new MessageError('ACCOUNT_UNAVAILABLE', 'Harness could not read which account this computer is signed in to. Try again in a moment.')
    return { machineId: self(), accountId: account.accountId, email: account.email }
  }

  /** An `agent_messages` request to another machine of this account, over the paired relay (an authenticated
   *  channel): its answer; its refusal as `{ error: { code, message } }`, for the person to be told what that machine
   *  said; null when it cannot be asked. A forwarded add that machine refused was told as a machine away (review of
   *  A1, 2026-10-15). */
  async function askMachine(machineId: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try { return await rpc(at(machineId), payload, 8_000) } catch (error) {
      return error instanceof RefusedError ? { error: { code: error.code, message: error.message } } : null
    }
  }

  /** A machine of this account's key for a shared tab's roster: this one's from the gateway, another's as that machine
   *  reports it (`tab_pub`); null when it cannot be asked. */
  async function machineKey(machineId: string): Promise<string | null> {
    if (machineId === self()) return core.account.tabKey.publicKey().catch(() => null)
    const known = machineKeys.get(machineId)
    if (known && now() - known.at < MACHINE_KEY_MS) return known.pub
    const answer = await askMachine(machineId, { action: 'tab_pub' })
    if (typeof answer?.pub !== 'string') return null
    machineKeys.set(machineId, { pub: answer.pub, at: now() })
    return answer.pub
  }

  /** This account's machines, as its directory lists them; null while it cannot be read. */
  async function ownMachines(): Promise<string[] | null> {
    const read = await directory.refresh()
    return read && [...read.machines.keys()]
  }

  /** The leader the account's tab setting names for a desk tab, as the directory lists it (null for none, or one that may
   *  lead it no more). Undefined before the tabs were first read (a failed read keeps the last good listing), from a
   *  backend that lists no setting, or for a tab the listing does not have: the roster this computer signs then keeps its
   *  own leader (sharedTabs.ts `ownLeader`). */
  async function ownLeader(tabId: string): Promise<{ machineId: string; agentId: string } | null | undefined> {
    return (await directory.refresh())?.tabs.find((t) => t.id === tabId)?.leader
  }

  /**
   * The directory changed: when it lists, for a tab this computer shares, another leader than the roster it holds names,
   * the shares are read again, and that signs the setting's leader (sharedTabs.ts `reshare`). The `desk_changed` the
   * setting's change causes does this already; this catches one this computer missed (its socket was down as it was
   * sent), at the next read of the tabs, so the members are not left with the old leader until something else changes.
   */
  function followLeaders(): void {
    if (!shared || !rosters) return
    const held = rosters
    const behind = (directory.current()?.tabs ?? []).some((t) => {
      const roster = t.sharedTabId && t.leader !== undefined ? held.current(t.sharedTabId)?.roster : undefined
      return !!roster && roster.owner.machineId === self()
        && (roster.leader?.machineId !== t.leader?.machineId || roster.leader?.agentId !== t.leader?.agentId)
    })
    if (behind) void shared.refresh().catch(() => {})
  }

  /** The owner's panes in a desk tab, named as its teammates see them; null while the tabs cannot be read. */
  async function ownPanes(tabId: string): Promise<Array<{ machineId: string; agentId: string; name: string; engine: string }> | null> {
    const tabs = await directory.refresh()
    if (!tabs) return null
    // Only the desk's own panes: the members' harnesses merged into the tab (sharedDirectory.ts) are theirs to add.
    const panes = (tabs.tabs.find((t) => t.id === tabId)?.panes ?? []).filter((p) => !p.accountId)
    await learnNames(panes, true)
    return panes.map((m) => { const t = teammate(m); return { machineId: m.machineId, agentId: m.agentId, name: t.name, engine: t.engine } })
  }

  /**
   * This computer's harnesses in each held tab, as working or not, to the tab's machines of other accounts; a peer
   * that does not know `activity` (a 1b daemon) is left alone for a while (tabActivity.ts).
   */
  async function shareActivity(): Promise<void> {
    if (!shared || !rosters) return
    const held = rosters.all()
    if (!held.length) return
    const me = await signedInAs().catch(() => null)
    if (!me) return
    for (const roster of held) {
      // The same harnesses `who` names: this account's here, and in another account's tab only those this machine asked for.
      const mine = roster.harnesses.filter((h) => h.machineId === self() && h.accountId === me.accountId
        && (roster.owner.accountId === me.accountId || consented(roster.sharedTabId, h.agentId)))
      const peers = [...new Set([...roster.harnesses.filter((h) => h.accountId !== me.accountId).map((h) => h.machineId),
        ...(roster.owner.accountId !== me.accountId ? [roster.owner.machineId] : [])])]
      if (!mine.length || !peers.length) continue
      // The account may keep the summary from other accounts: then it is not even read, and one sent before is replaced.
      const agents = activityOut.due(roster.sharedTabId, now(), await activityNow(mine.map((h) => h.agentId), !summaryHidden()))
      if (!agents.length) continue
      await Promise.all(peers.filter((m) => !activityOut.refusing(roster.sharedTabId, m, now())).map(async (machineId) => {
        try { await askTab(roster.sharedTabId, machineId, { action: 'activity', sharedTabId: roster.sharedTabId, agents }, 5_000) }
        catch (error) { if (error instanceof RefusedError && error.code === 'UNKNOWN_ACTION') activityOut.refused(roster.sharedTabId, machineId, now()) }
      }))
    }
  }

  /** The windows' `shared_tabs_changed`, once for a burst of changes: a refresh that takes a roster, alerts and announces
   *  sends one frame, not three. */
  function tellShares(): void {
    // Nothing is told while shared tabs are down: the rosters file outlives sleep, but the windows read `shares` as it wakes.
    if (!shared || sharesTimer) return
    sharesTimer = setTimeout(() => {
      sharesTimer = null
      core.clients.windows({ type: SHARED_TABS_WINDOW_FRAME, payload: { rev: ++sharesRev } })
    }, SHARES_COALESCE_MS)
    sharesTimer.unref?.()
  }

  function sharedUp(): void {
    if (shared) return
    // Each roster saved: the consent follows what the rosters list (a harness the owner took out needs asking again),
    // and Share derives its observers again from both. The consent changed, the directory is merged again: a harness
    // taken out leaves another account's tab here at once (sharedDirectory.ts), its note and its deliveries with it.
    try {
      // One writer for the file, kept across sleep: a closed SharedTabs that still adds a notice must not write a stale list over the new one's.
      notices ??= new NoticeStore(join(stateDir, 'shared-tabs-notices.json'), now)
      consent ??= new ConsentStore(join(stateDir, 'shared-tabs-consent.json'), now, () => { options.observers?.(); directory.rebuild() })
      rosters ??= new RosterStore(join(stateDir, 'shared-tabs.json'), now, (kind) => {
        if (kind === 'tabs') {
          if (rosters) consent?.reconcile((id) => rosters?.current(id)?.roster ?? null)
          // A tab left, removed or revoked takes what was sent and heard for it.
          const held = new Set((rosters?.all() ?? []).map((r) => r.sharedTabId))
          activityOut.prune(held)
          activityIn.prune(held)
          options.observers?.()
        }
        tellShares()
      })
    } catch { return }
    const tabs = new SharedTabs({ key: core.account.tabKey, relay: core.account.tabRelay, store: rosters,
      backend: (method, path, body) => core.account.backend(method, path, body), self: signedInAs, ownPanes, ownLeader, machineKey, askMachine, ownMachines, consent,
      requests: new RequestStore(join(stateDir, 'shared-tabs-requests.json'), now), changed: () => directory.rebuild(),
      ...(notices ? { notices } : {}), announce: tellShares, answer: answerTab,
      // A session with another account's machine opened: what waits for it goes now, not at its next try.
      opened: (_id, machineId) => { void handOver(undefined, machineId) }, now })
    shared = tabs
    stopFrames = options.onTabFrame?.((event) => { void tabs.onFrame(event).catch(() => {}) }) ?? null
    // Read once as it wakes, even holding no tab: a computer that was away when the person accepted a tab on another of
    // their computers missed that one's word (`tab_pin_changed`), and would otherwise take the pin only at the next
    // unrelated `desk_changed` (review of A2, 2026-10-15). One read, and no timer while nothing is held.
    void tabs.refresh().catch(() => {})
  }

  /** Read the shares again and open every held tab's relay, for a new core while awake. A computer that holds no tab
   *  reads nothing more for them: the next `desk_changed` would tell it. */
  function refreshShared(): void {
    if (shared && rosters?.all().length) void shared.refresh().catch(() => {})
  }

  function sharedDown(): void {
    // Down first: closing saves the rosters, and a save while asleep must not arm the windows' timer again.
    const tabs = shared
    shared = null
    if (sharesTimer) clearTimeout(sharesTimer)
    sharesTimer = null
    stopFrames?.()
    stopFrames = null
    tabs?.close()
  }

  /** Shared tabs, for a request: only while awake, and with their file read. */
  function awakeShares(): { shared: SharedTabs; rosters: RosterStore } {
    if (!messagingOn() || mode !== 'awake') throw new MessageError('MESSAGES_OFF', MESSAGES_OFF_TEXT)
    if (!shared || !rosters) throw new MessageError('SHARES_UNAVAILABLE', 'The shared tabs file on this computer could not be read.')
    return { shared, rosters }
  }

  async function shareAction(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { shared, rosters } = awakeShares()
    // The account first, for every action: each one acts as it, or reads what only it may (sharedTabs.ts `self`). Asked
    // first, a core from before shared tabs is told as the restart it needs (services/messagesProcess.ts), not as the
    // backend or a route that core refuses, which differ from one action to the next.
    await signedInAs()
    switch (payload.action) {
      case 'share_tab': return shared.share(String(payload.tabId), String(payload.name ?? ''))
      case 'share_invite': return shared.invite(String(payload.sharedTabId), payload.emails as string[], payload.days as 7 | 30 | 90)
      case 'share_revoke': return shared.revoke(String(payload.inviteId)).then(() => ({ ok: true }))
      case 'share_accept': return shared.accept(String(payload.inviteId), typeof payload.ownerPub === 'string' ? payload.ownerPub : undefined)
      case 'share_add': return shared.addHarness(String(payload.sharedTabId), payload.harness as { machineId: string; agentId: string; name: string; engine: string }, payload.forwarded === true)
      case 'share_remove': return shared.removeHarness(String(payload.sharedTabId), String(payload.machineId), String(payload.agentId), payload.forwarded === true)
      // Written to the owner's tab setting, from any computer of the account; the computer that shares the tab signs it.
      case 'share_leader': return shared.setLeader(String(payload.sharedTabId), (payload.leader ?? null) as { machineId: string; agentId: string } | null).then(() => ({ ok: true }))
      case 'share_remove_member': return shared.removeMember(String(payload.sharedTabId), String(payload.accountId)).then(() => ({ ok: true }))
      case 'share_notice_dismiss': {
        const id = String(payload.id ?? '')
        if (shared.dismissNotice(id) || rosters.dismiss(id)) return { ok: true }
        throw new MessageError('NOT_FOUND', 'That notice is already gone.')
      }
      case 'share_leave': return shared.leave(String(payload.sharedTabId)).then(() => ({ ok: true }))
      case 'share_stop': return shared.stop(String(payload.sharedTabId)).then(() => ({ ok: true }))
      // The tab's authority moves to this computer, with a key change the old one signs when it can be asked.
      case 'share_move': return shared.move(String(payload.sharedTabId))
      // Trust a tab's owner again without a new invitation: the check shows the fingerprint, the confirm pins that key.
      case 'share_retrust_check': return shared.retrustOffer(String(payload.sharedTabId))
      // The tasks of a tab this computer holds, found with this computer's own `gh` login (tasks.ts).
      // `tabId`: a desk tab of this account, shared or not (`tasksOfTab`); `sharedTabId`: a held one. Both: the shared tab's own
      // id wins, as the one a roster names; a desk id beside it is only the window's hint.
      case 'share_tasks': return (payload.sharedTabId === undefined && typeof payload.tabId === 'string' ? tasksOfTab(payload.tabId) : tasksOf(String(payload.sharedTabId))).then((result) => ({ ...result }))
      // Each harness of a held tab with its repo and branch, for People (sharedWho).
      case 'share_who': return sharedWho(String(payload.sharedTabId))
      case 'share_retrust': return shared.retrust(String(payload.sharedTabId), typeof payload.ownerPub === 'string' ? payload.ownerPub : '')
      default: /* shares */ {
        const me = await signedInAs()
        // `api: 2` tells a window this daemon sends `shared_tabs_changed`; `tabId` is the desk tab of a roster this account owns.
        const invites = await shared.invites(), untrusted = await shared.untrusted()
        // `pendingInvites` carries the ids that revoke an invitation, which only the owner's shares list.
        return { api: 2, version: VERSION, me: { accountId: me.accountId, email: me.email, machineId: me.machineId },
          rosters: shared.rosters().map((r) => {
            const own = r.owner.accountId === me.accountId
            return { ...r, tabId: own ? shared.deskTab(r.sharedTabId) : null, pendingInvites: own ? shared.pendingInvites(r.sharedTabId) : [] }
          }),
          invites, alerts: rosters.alerts(), pending: shared.pending(), notices: shared.notices(), untrusted, activity: activityIn.snapshot(now()) }
      }
    }
  }

  const stopHearing = core.turns.onDelivery((event: TurnDelivery) => mailbox.observe(event))
  // Asleep, a changed desk is read when it wakes, not now. Shared tabs read theirs after the desk, whose panes they take.
  // A machine created, renamed or deleted changes the panes and names the directory lists, as a changed desk does.
  const stopNotices = core.account.onNotice((notice) => {
    if ((notice.type === 'desk_changed' || notice.type === 'machines_changed') && !asleep()) {
      void directory.refresh(true).then(() => shared?.refresh()).catch(() => {})
    }
  })

  // Started only as it wakes, when it is stopped: never twice.
  const startTick = (): void => {
    timer = setInterval(() => {
      notesPump()
      void shareActivity().catch(() => {})
      void handOver()
      if (now() - lastRemoteStatus >= REMOTE_STATUS_MS) { lastRemoteStatus = now(); void remoteStatus() }
    }, TICK_MS)
    timer.unref?.()
  }
  const stopTick = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }

  /**
   * Run what this computer calls for now: everything while it is signed in with Agent Messages on; while they are off,
   * the notes withdrawn, what waits held and then failed by the mailbox's look, which stops once nothing waits, and
   * a watch on the setting's file to wake it; signed out, nothing. Every computer runs this service: one with it off,
   * or never signed in, paid a read of the account's tabs every 15 s and three timers for messages it could never
   * carry (2026-10-12).
   */
  function wake(): void {
    if (!running) return
    const next = !core.account.signedIn() ? 'signedOut' : readSetting() ? 'awake' : 'off'
    if (next === mode) return
    // The switch turned on or off here while this computer holds a shared tab: Share grants or takes back the tabs'
    // views at once (it reads the same switch), not at its next 30 s look. Never at start, nor without a tab: that
    // would start Share's process on every computer.
    const flipped = (mode === 'awake' && next === 'off') || (mode === 'off' && next === 'awake')
    const tellShare = (): void => { if (flipped && rosters?.all().length) options.observers?.() }
    mode = next
    if (next === 'awake') {
      unwatch?.()
      unwatch = null
      directory.start()
      // The account names an unshared tab's key in its agents' notes: they are looked at again once it is known.
      void signedInAs().then(() => notesPump(), () => {})
      mailbox.resume()
      startTick()
      sharedUp()
      tellShare()
      return
    }
    directory.stop()
    stopTick()
    sharedDown()
    tellShare()
    if (next === 'signedOut') {
      unwatch?.()
      unwatch = null
      mailbox.pause()
      return
    }
    // Never watching yet: it was awake, signed out or not running, and none of those watches.
    unwatch = (options.watchSetting ?? watchSettingFile)(settingsFile, later)
    mailbox.refuseAll()
    notesPump()
    // The mailbox looks on only while something here waits to be held and then failed; it stops itself after.
    if (mailbox.waiting()) mailbox.resume()
    else mailbox.pause()
  }

  return {
    requests: {
      agent_messages: (payload, asker) => Promise.resolve().then(async () => {
        if (!asker.owner) throw new MessageError('OWNER_REQUIRED', 'Agent Messages answer only the owner.')
        // A pane is only this machine's to name; a hand-over, its status and its names are another machine's
        // daemon's to ask, over the relay, never a process here's.
        const fromHere = ['send'].includes(String(payload.action))
        if (['send', 'deliver', 'status', 'who', 'started', 'tab_pub', 'tab_pin', 'tab_pin_changed', 'tab_keychange'].includes(String(payload.action)) && asker.local !== fromHere) {
          throw new MessageError(fromHere ? 'LOCAL_ONLY' : 'REMOTE_ONLY', fromHere ? 'harness send runs in a pane on this machine.' : 'Only another of your machines hands messages over.')
        }
        // The person's own windows, here or over the relay, manage shared tabs; another of the owner's machines asks
        // only `share_add` and `share_remove`, for a harness of this one, marked `forwarded` (sharedTabs.ts `addHarness`,
        // `removeHarness`).
        if (SHARE_ACTIONS.includes(String(payload.action))) return shareAction(payload)
        switch (payload.action) {
          case 'send': return send(payload)
          case 'deliver': return deliver(payload)
          case 'status': return statusOf(payload)
          case 'who': return whoAre(payload)
          case 'started': return started(payload)
          // From a pane here, or another of the owner's machines over the relay: `tell` tells them apart.
          case 'tell': return tell(payload, asker.local)
          // A program acting for the person, here or on another of the owner's machines (replyLocal.ts).
          case 'reply_local': return replyLocal(payload)
          case 'history': return history(payload)
          // The windows' sidebar: every harness of a desk tab, shared or not, with its state and one line on what it does.
          case 'tab_activity': return tabActivity(String(payload.tabId))
          case 'tab_pub': return { pub: await core.account.tabKey.publicKey() }
          // Only another machine of this account: the same trust as `tab_pub` (sharedTabs.ts `pull`).
          case 'tab_pin': return awakeShares().shared.pinOf(String(payload.sharedTabId))
          case 'tab_pin_changed': return awakeShares().shared.pinChanged(String(payload.sharedTabId)).then(() => ({ ok: true }))
          // Only another machine of this account, and answered only by the computer the tab is shared from: a window or a
          // process here never has this machine sign a key over to another (sharedTabs.ts `keyChange`).
          case 'tab_keychange': return awakeShares().shared.keyChange(String(payload.sharedTabId), payload.nextPub, payload.machineId)
          default: throw new MessageError('UNKNOWN_ACTION', 'Unknown Agent Messages request.')
        }
      }).catch((error: unknown) => (error instanceof MessageError
        ? { error: error.code, detail: error.message }
        : { error: 'MESSAGES_UNAVAILABLE', detail: 'Agent Messages are unavailable right now. Nothing was sent.' })),
    },
    canWrite: (deliveryId) => mailbox.canWrite(deliveryId),
    reconnected: () => {
      mailbox.takeBackAttempts()
      const was = mode
      wake()
      // The relay sockets were the old core's gateway's: a new one has none, and waking again (the mode unchanged)
      // would not open them. Waking from asleep has just done so.
      if (was === 'awake' && mode === 'awake') refreshShared()
    },
    settingsChanged: later,
    start: () => {
      running = true
      mailbox.start()
      sweep()
      wake()
    },
    stop: () => {
      running = false
      mode = null
      unwatch?.()
      unwatch = null
      stopTick()
      stopHearing()
      stopNotices()
      sharedDown()
      mailbox.stop()
      directory.stop()
    },
  }
}
