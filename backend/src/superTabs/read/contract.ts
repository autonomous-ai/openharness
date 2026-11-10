/**
 * The Swarm read API by parts (docs/design/2026-10-26-swarm-state-parts.md, section 4): the single source of truth for the
 * response shapes. Desktop/web (`desktop/lib/super_tabs`) and the CLI (`cli/src/superTabs`) mirror these by hand; announce
 * any change to the Lead before it merges.
 *
 * Every payload below is the `data` of the usual `{ success, data }` envelope. Times are epoch milliseconds; part `data`
 * keeps today's ISO strings where today's record has them.
 */
import type { Agent, AgentStart, Conversation, Person, SuperTabState, WorkStatus } from '../model.js'
import type { ContributedMachine } from '../machines.js'

export const READ_FORMAT = 2
export type PartKind = 'head' | 'member' | 'agent' | 'group' | 'machine' | 'start' | 'progress'

/** A live part: the reader's view of one stored record. */
export interface LivePart<T> { key: string; version: number; changedAt: number; data: T }
/** A removed part. It never carries data; a reader receives it only if it could read the part's last data. */
export interface Tombstone { key: string; version: number; changedAt: number; deleted: true }
/** A group that left the active set (archived, or finished and idle 24 h). Fetch it whole with `groups/:id`. */
export interface DormantStub { key: string; version: number; changedAt: number; dormant: true }
export type PartChange<T> = LivePart<T> | Tombstone
export type GroupChange = LivePart<GroupView> | Tombstone | DormantStub

/** The head as a reader sees it: no sharing, overlap alerts, retired number or parked groups; projects, rules and
 *  invitations filtered (invitations only for the Swarm owner). `autoJoin`: people at the owner's domain join by themselves
 *  (autoJoin.ts), from the sharing the head holds; who declined is never sent. */
export type HeadView = Pick<SuperTabState, 'version' | 'id' | 'name' | 'project' | 'leadsConversationId' | 'ownerId'
  | 'environment' | 'routingPolicy' | 'rules' | 'paused' | 'invitations' | 'localModels' | 'removedMachines'
  | 'autoJoin'> & {
  /** Fixed columns for the chosen preset (task #3896); an older server omits both, meaning Full. */
  projects?: Array<import('../projects.js').SwarmProject & {
    process: import('../process.js').ProjectProcess; columns: readonly import('../process.js').BoardColumn[]
  }>
}
/** A member's avatar says only `{ kind: 'upload' }` for an upload: its link comes signed in `derived.avatars`. */
export type MemberView = Omit<Person, 'avatar'> & { avatar?: import('../profile.js').AvatarView }
/** The stored agent. Time-based and cross-part values (`downSince`, `limitedUntil`, an awaiting decision, the custom
 *  role) come only in `derived.agents`, so an agent never changes without a new version. */
export type AgentView = Omit<Agent, 'downNamed' | 'downSince' | 'limitedUntil' | 'roleId' | 'avatar'> & { avatar?: import('../profile.js').AvatarView }
/** A private conversation's audience: the people it is shared with. The project's Lead always reads it too. */
export interface Audience { people: Array<{ id: string; generation: string }> }
/** A conversation with its own message counter (`lastMessageSequence` and message sequences compare within one group).
 *  `dormant` is set only on a dormant group fetched on demand; `audience` only on a private conversation. */
export type GroupView = Omit<Conversation, 'talkedAt' | 'messageSeq' | 'reportSeq' | 'dormant' | 'lastActivityAt' | 'audience' | 'ledger'> & {
  /** When it shipped (ms): its first Done; absent until it has. Nothing else of its ledger is sent. */
  shippedAt?: number
  /** Why a held task is held, or `none` for a hold from before reasons; absent when it is not held (heldReason.ts heldView). */
  held?: import('../heldReason.js').HeldView
}
  & { messageSeq: number; dormant?: true; audience?: Audience }
/** A contribution as `state.machines[]` has it, privacy detail only for its contributor, harness ids cut to what the
 *  reader can see. Machines without a contribution are never sent. */
export type MachineView = ContributedMachine
export type StartView = AgentStart
export interface ProgressView {
  since: number
  summarizedFloor: number
  summarized: Record<string, number>
  requestedFloor: number
  requested: Record<string, number>
  requestedAt: number | null
  requestMessageId?: string
}

/** Values that change without a part changing (time, or several parts). Recomputed in full on every response;
 *  clients overlay it on the parts. */
export interface Derived {
  /** Every agent the reader can see. `workDecision` is null when the stored value stands; `roleId` null outside Custom. */
  /** `roleName`: the role it goes by (instructions.ts roleNameOf), its stored one or what it is. */
  /** `kind`: a PM leading a project, or a Regular agent; `chatId`: the chat its person talks to it in, or null
   *  (agentKind.ts, task #4116). Absent from an older backend. */
  /** `myAgent`: whether it is in the reader's My agents (agentKind.ts inMyAgents, task #4192). Absent from an older backend. */
  agents: Record<string, { downSince: string | null; limitedUntil: string | null; workDecision: 'awaiting' | null; roleId: string | null; roleName: string;
    kind: import('../agentKind.js').AgentKind; chatId: string | null; myAgent: boolean
    /** Lead or Member, and its main project when the reader reads that project (agentKind.ts, task #4540). Absent from an older backend. */
    role: import('../agentKind.js').AgentRole; mainProjectId: string | null }>
  /** Every contributed machine the reader can see. */
  /** `clientVersion`: the CLI version its daemon last connected with (routing reads a machine updated since its failed starts). */
  machines: Record<string, { availableSlots: number; clientVersion?: string
    /** Engines suspended there now after failed starts, with why (engineHealth.ts); absent when none. */
    suspendedEngines?: Record<string, string>
    /** Pickup timeout cooldown: applies to every new start, including grid models. */
    machineSuspended?: string }>
  /** A Lead agent only. */
  otherProjectsWork?: OtherProjectWorkView[]
  /** A project agent only: the account each project's PM runs on, a project it may not read named "another project". */
  pmAccounts?: Array<{ machineId: string; engine: string; project: string; pm: string }>
  /** The Swarm's owner only: projects nobody owns, which they may delete but never read (projects.ts ownerlessProjects). */
  ownerlessProjects?: Array<{ id: string; name: string; conversations: number }>
  /** Signed links to uploaded avatars, by `person:<id>` and `agent:<id>` (avatarLinks.ts): fresh with every read, the same
   *  through each half hour, each opening for at most an hour. Absent when nobody visible has one. */
  avatars?: Record<string, string>
  /** A person only: their own read marks (readMarks.ts), the newest message sequence read by conversation. A first load has
   *  every one of the conversations it holds; a changes read only those moved since its cursor, kept by the client as the
   *  higher of the two. Never another person's. */
  readMarks?: Record<string, number>
  /** A person only: those of their `readMarks` whose last move was their own Mark unread (readMarks.ts lowerReadMark), which
   *  a client takes in place of a higher mark it holds, where it keeps the higher of the two for every other mark. Like
   *  `readMarks`: a first load has every one of the conversations it holds, a changes read those moved since its cursor; a read
   *  that raises the mark again ends it. Absent when there are none, and from an older backend. Never another person's. */
  unreadMarks?: Record<string, number>
  /** A person only: their own thread marks (readMarks.ts), the newest message sequence read by thread root, by conversation.
   *  Like `readMarks`: a first load has those of the conversations it holds, a changes read those moved since its cursor.
   *  Absent when there are none, and from an older backend. Never another person's. */
  threadMarks?: Record<string, Record<string, number>>
  /** A person only: their own notification setting by conversation (chatSettings.ts), `all`, `mentions` or `muted`. Like
   *  `readMarks`: a first load has every one of the conversations it holds (a chat with none is at `mentions`), a changes read
   *  those moved since its cursor. Absent when there are none, and from an older backend. Never another person's. */
  chatSettings?: Record<string, 'all' | 'mentions' | 'muted'>
  /** Present, and false, only from a backend that held Harness Team accounts to listed owners' Swarms (2026-10-27 to 11-02):
   *  this Mac's daemon and Desktop then offered no team account for it. No longer sent: every Swarm takes part. */
  teamAccounts?: false
}
export interface OtherProjectWorkView {
  conversationId: string; projectName: string; title: string; owns: string[]; status: WorkStatus; agentName: string; pr: string | null
}

interface ReadMeta {
  format: typeof READ_FORMAT
  /** Opaque: unpadded base64url. Send it back unchanged to `changes`. */
  cursor: string
  serverTime: number
  /** The newest data change of any part of this Swarm (touches do not count); null for a Swarm with no parts yet. */
  lastChangedAt: number | null
  /** The visibility epoch; a change makes `changes` answer `reload`. */
  epoch: number
}

/** GET /api/super-tabs/:tabId/parts[?asAgentId=] */
export interface FirstLoad extends ReadMeta {
  tabId: string
  head: LivePart<HeadView>
  members: LivePart<MemberView>[]
  agents: LivePart<AgentView>[]
  /** The reader's visible active groups, in creation order. */
  groups: LivePart<GroupView>[]
  machines: LivePart<MachineView>[]
  starts: LivePart<StartView>[]
  progress: LivePart<ProgressView>[]
  derived: Derived
  /** Opaque: the reader's summary (`derived` without its marks) as a hash (derivedEtag.ts). Send it back as `derivedEtag` on
   *  the next change read. Absent from an older backend. */
  derivedEtag: string
}

/** The reader's own marks of `derived`, which a change read sends only as they move. */
export type ReaderMarks = Pick<Derived, 'readMarks' | 'unreadMarks' | 'threadMarks' | 'chatSettings'>

/** GET /api/super-tabs/:tabId/changes?cursor=[&asAgentId=][&machines=light][&derivedEtag=] */
export type Changes = ChangesReload | ChangesDelta
/** Drop the store and do a first load: bad or old cursor, another epoch, or older than tombstones are kept. */
export interface ChangesReload { reload: true }
/** A machine's own reading, as one line, for a client that asked (`machines=light`): when it last reported, from which it works out
 *  online or offline as it does from a part. The rest of the reading is read on demand (MachineReadings). */
export interface MachineReading { key: string; version: number; receivedAt: number }
/** GET /api/super-tabs/:tabId/machine-readings[?asAgentId=]: every machine the reader sees, whole, for the route and the machine panel. */
export interface MachineReadings { format: number; serverTime: number; machines: LivePart<MachineView>[] }
export interface ChangesDelta extends ReadMeta {
  reload: false
  head: LivePart<HeadView> | null
  members: PartChange<MemberView>[]
  agents: PartChange<AgentView>[]
  groups: GroupChange[]
  machines: PartChange<MachineView>[]
  /** Only for a client that asked: machines whose reading alone moved, which `machines` then leaves out. */
  machineReadings?: MachineReading[]
  starts: PartChange<StartView>[]
  progress: PartChange<ProgressView>[]
  /** The whole summary, or with `derivedUnchanged` only the reader's moved marks: the client keeps the summary it holds. */
  derived: Derived | ReaderMarks
  /** As a first load's: the summary this reply's reader has now, sent whether or not `derived` carries it. */
  derivedEtag: string
  /** Only when the client sent the `derivedEtag` its summary still hashes to (task #2906): `derived` then holds only the
   *  reader's moved marks. A client that sends no etag, as every released one, always gets the whole summary. */
  derivedUnchanged?: true
}

/** GET /api/super-tabs/:tabId/groups?dormant=1[&projectId=][&before=][&asAgentId=]: newest activity first, 50 a page. */
export interface DormantGroups { groups: LivePart<GroupView>[]; next: string | null }
/** GET /api/super-tabs/:tabId/groups/:conversationId[?asAgentId=]: active or dormant; 404 when unreadable. */
export interface OneGroup { group: LivePart<GroupView> }

/** POST /api/super-tabs/:tabId/commands: the parts the command wrote (never the ones it only touched). */
export interface CommandReply {
  result: Record<string, unknown>
  parts: Array<{ kind: PartKind; key: string; version: number }>
  lastChangedAt: number | null
  /** Only on a replayed receipt from before the migration. */
  legacyRevision?: number
}

/** GET /api/super-tabs/list[?after=][&mentions=1] */
export interface SwarmList {
  tabs: Array<{ id: string; name: string; ownerId: string; paused: boolean; lastChangedAt: number | null
    /** Only on the reader's own Personal Swarm. */
    personal?: true }>
  next: string | null
}

/** GET /api/super-tabs/:tabId/conversations/:conversationId/messages[?after=&afterId= | ?before=&beforeId= | ?messageId=]
 *  (design 4.6). Rows are ordered by (sequence, id); `revision` is gone. With no cursor the page is the newest 100, and
 *  `next` names its oldest row: send it back as `before`/`beforeId` for the page before. Forward pages (`after`) name their
 *  newest row the same way. `next` is null at the end. `after` alone (no `afterId`) means strictly after that sequence,
 *  which is all a poll for new messages needs. */
export interface MessagePageCursor { sequence: number; id: string }
export interface MessagePage<M = Record<string, unknown>> {
  messages: M[]
  next: MessagePageCursor | null
  /** Moves when a message here is edited or deleted (messageEdits.ts): read the page shown again. Named for the reactions it
   *  first counted, which are gone. */
  reactionSeq: number
}

/** GET /api/super-tabs/hosts/:machineId/changes?cursor=[&full=1], or POST to the same path with this body when the host
 *  holds etags (up to 500 Swarms do not fit in a URL). Ask `full` at start and at least every 60 s. */
export interface HostChangesRequest {
  cursor?: string
  full?: boolean
  /** Swarm id → the `etag` of the rows the host holds for it. A Swarm whose rows still hash the same comes back unchanged. */
  held?: Record<string, string>
}
export interface HostChanges {
  format: typeof READ_FORMAT
  full: boolean
  cursor: string
  /** Swarms with a host-relevant change (all of the machine's Swarms when `full`): replace each one's rows, or keep the
   *  rows held for an `unchanged` one. */
  tabs: HostTab[]
  /** Incremental only: Swarms that no longer list this machine. Empty when `full`. */
  removedTabIds: string[]
}
export type HostTab = HostTabRows | HostTabUnchanged
/** The rows still hash to the `etag` the host sent in `held`: keep them (only `lastChangedAt` may have moved). */
export interface HostTabUnchanged { tabId: string; lastChangedAt: number | null; etag: string; unchanged: true }
export interface HostTabRows {
  tabId: string
  lastChangedAt: number | null
  /** Opaque: send it back in `held`. It changes whenever `roster`, `pool` or `assignments` do (not for the host's own
   *  machine reading or the rows' change times), and may change when they do not. */
  etag: string
  unchanged?: never
  /** Today's `GET /hosts/:m` rows for this Swarm, `revision` replaced by `lastChangedAt`. */
  roster: HostRosterRow[]
  /** Today's `GET /hosts/:m/pools` row for this Swarm, or null when this machine is not contributed there by the caller. */
  pool: HostPool | null
  /** Today's `GET /hosts/:m/assignments` rows for this Swarm. */
  assignments: Array<{ tabId: string; assignmentId: string; harnessId: string }>
}
export type HostRosterRow =
  | HostAgentRow
  | { tabId: string; agent: { id: string; harnessId: string; machineId: string }; closeSession: true; active: false }
  | { tabId: string; cleanup: { machineId: string; removalId: string } }
export interface HostAgentRow {
  tabId: string
  tabName: string
  lastChangedAt: number | null
  paused: boolean
  active: boolean
  attention: { assignmentId: string; status: WorkStatus; result: string | null } | null
  /** Always null since Swarm v4 (no task resumes after a usage limit); an older host still reads it. Goes after 2026-12-09. */
  resume: null
  agent: Agent
  joinSwarm: boolean
  skillMode: 'default' | 'orchestration'
  role?: { id: string; name: string; kind: string; version: string; projectId: string } | null
  /** The role it goes by (instructions.ts roleNameOf). */
  roleName: string
  /** Its project's instructions as the state names them: the host reads the text when `revision` moves. Revision 0 (no
   *  `hash`): no document yet, so the built-in template. */
  instructions: { projectId: string; revision: number; hash: string | null; coordinatorName: string } | null
  lead: boolean
  /** v3's restart of a PM that hung on an unanswered message: null since Swarm v4, for a host from before that reads it. */
  owed: { messageId: string; since: number; restartAfterMs: number } | null
  /** New: lets the host decide what it may read without a full Swarm read. */
  leadsConversationId: string | null
  /** The conversation this agent leads, when it is a project's Product Manager. */
  ledConversationId: string | null
  stopRequested: boolean
  observers: Array<{ email: string; userId: string }>
  /** Its session is confidential in some Swarm: the host refuses every share of it, ordinary ones too (Critical 1). */
  confidential: boolean
  /** Confidential, but this Swarm's current Lead: the host lets `observers` watch it through this Swarm's shares while this
   *  row is in force, and nobody else (Ken, 2026-10-28). An older host ignores it and refuses them, which errs closed. */
  membersWatch: boolean
}
export interface HostPool {
  tabId: string
  paused: boolean
  machine: ContributedMachine
  starts: AgentStart[]
  /** Product Managers' starts (leadStart.ts), apart from `starts` for the same reason. */
  leadStarts?: AgentStart[]
  /** Regular agents' starts (commands.ts agent.new, task #4116), apart for the same reason. */
  regularStarts?: AgentStart[]
  projects?: Array<{ id: string; leadConversationId: string; repository?: unknown; conversationIds: string[] }>
  localGrid?: string
  reservations: Array<{ harnessId: string; generation: string }>
  harnessIds: string[]
  removedHarnessIds?: string[]
  /** The host may say what it launches beyond workers in its readings (leadStart.ts). */
  capabilitiesWanted?: true
}

/** HTTP 503 on the new routes while a Swarm is still on the old format; clients retry. */
export const SWARM_MIGRATING = { code: 'SWARM_MIGRATING', status: 503, message: 'This Swarm is being upgraded. Try again in a moment.' } as const

