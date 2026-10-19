/**
 * Shared tabs across accounts (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Trust: the
 * signed roster" and "Messages across accounts"): who is in a tab shared with other accounts, how that changes, and the
 * sealed requests Agent Messages sends another account's machine through the tab (`request`), which the service answers
 * on the other side (`answer`, service.ts) against its own roster.
 *
 * The owner's computer is the only authority over a shared tab (the spec's "Authority"). It builds the roster from
 * its desk's panes and the members the backend says accepted, signs it with its machine key, stores it on the backend
 * and sends it to the tab's other machines. The backend is a mailbox and a relay: it keeps the invitations, the latest
 * signed roster and who accepted, and carries sealed frames between machines without reading them. A member's add or
 * remove is a request, which the owner's computer checks and applies, and which waits while that computer is away.
 *
 * Frames between machines go over the tab's relay (`TabRelay`). In the clear, only what opens a session
 * (`TabKey`, lib/e2ee/tabSession.ts), each with its `kind`:
 *   { kind: 'hello', hello, pub }      the lower machine id starts a session; `pub` is its key, which only the owner's
 *                                      computer may take, for a member's machine the roster does not list yet
 *   { kind: 'welcome', welcome, to }   the answer; `to` names the hello it answers (its ephemeral key), so a late
 *                                      welcome for an older hello is ignored instead of spending the current one
 *   { kind: 'knock', pub }             the higher id asks the lower to start one, or either says it has none
 * Everything else is sealed for the session (`{ __e2e }`), and once opened is one of:
 *   { kind: 'roster', signed }                          the owner's roster (a SignedRoster)
 *   { kind: 'roster_request', id, op, harness }         a member asks to add or remove its harness; `id` is
 *                                                       `<op>:<machineId>/<agentId>`, the same for the same ask
 *   { kind: 'roster_refused', id, error }               the owner's answer to a request it will not apply
 *   { kind: 'agent_messages', rid, action, ... }        an Agent Messages request from any machine of the tab to any
 *                                                       other (`deliver`, `status`, `who`), for its service to answer;
 *                                                       `rid` names it, 24 hex characters (tabDelivery.ts)
 *   { kind: 'agent_messages_result', rid, ... }         the answer, sealed back to the machine that asked: what the
 *                                                       service answered, or `{ error, detail }` for its refusal
 * Each is checked as it arrives: anything else, or anything malformed, is dropped. A result is taken only from the
 * machine its request went to, in the tab it went through.
 *
 * A member's other computers take the tab from the one that accepted it, over the account's paired relay (service.ts
 * `tab_pin`, `tab_pin_changed`): the owner key it pinned and the roster it holds, which they check as their own.
 *
 * The owner stops a tab from any of its computers, and moves its authority to another (`move`): the new computer asks
 * the old one, over the paired relay, to sign its key for the tab (`tab_keychange`), and signs the next roster with that
 * change attached, which members' pins follow (roster.ts `verifyRoster`). With the old computer away there is no change
 * to attach: members cannot verify the new roster and trust its owner again (`retrust`), each computer on its own word.
 */
import { randomBytes } from 'node:crypto'
import type { TabFrame, TabKey, TabLink, TabRelay } from '../core/api.js'
import { b64d, fingerprint, verify } from '../lib/e2ee/core.js'
import { MessageError } from './model.js'
import { NoticeStore } from './noticeStore.js'
import type { QueuedRequest, RequestStore } from './requestStore.js'
import { cleanName, encodeRoster, fitsRoster, keyChangeBytes, parseRoster, ROSTER_LIMITS, verifyRoster, type KeyChange, type Roster, type RosterHarness, type SignedRoster } from './roster.js'
import type { ConsentStore } from './consentStore.js'
import type { RosterStore } from './rosterStore.js'
import { composeCut, harnessRef, judge, peerKey, PUB, record, same, sameRoster, sharedTabIdOf, shareOf, signedOf, UNNAMED, wireHarness, type ShareView } from './sharedTabsRoster.js'
import { fitsRequest, REQUEST_ID_LENGTH, type TabContext } from './tabDelivery.js'

/** How often a member's waiting request is tried again, with the shares read again, while the owner's computer is away. */
export const RETRY_MS = 30_000
/** How long a hello or a knock with no answer is left before another: a hello sent again on every try would replace
 *  the one whose welcome is on its way. */
export const HELLO_RETRY_MS = 10_000
/** How long a member's computer that could not take a tab's pin from another of its account's waits before asking
 *  again: every `desk_changed`, and every 30 s retry, reads the shares, and a computer whose others are asleep would
 *  otherwise ask them all each time. The one that accepts says when to ask at once (`pinChanged`). */
export const PULL_RETRY_MS = 60_000
/** How long a tab's relay waits to be opened again after another socket of this machine took it over (4409): opened
 *  again at once, it would take the tab back from that socket, which would take it back in turn, and so on. Long
 *  enough for a socket that was only replacing this one (a gateway that restarted) to have settled. */
export const RELAY_TAKEOVER_MS = 30_000
/** Taken over more than RELAY_TAKEOVERS times within RELAY_TAKEOVER_WINDOW_MS, the relay is not opened again: something
 *  else of this machine keeps wanting the tab (a second daemon under the same machine id), and the person is told
 *  (`relay_taken`) rather than have the two take it from each other for good. */
export const RELAY_TAKEOVERS = 3
export const RELAY_TAKEOVER_WINDOW_MS = 10 * 60_000
/** After accepting, the shares are read this many times more, ACCEPT_RETRY_MS apart, while they cannot be read or do not
 *  list the tab yet: a backend that blinked once would otherwise have the person leave a tab they just joined. */
export const ACCEPT_RETRIES = 3
export const ACCEPT_RETRY_MS = 1_000
/** The most `roster_request`s the owner takes from one member account in REQUEST_WINDOW_MS (the spec's "Limits", as
 *  for messages): each one may sign and send a roster, which a member's daemon could otherwise ask for without end. */
export const REQUESTS_PER_MEMBER = 30
export const REQUEST_WINDOW_MS = 10 * 60_000

type Wire = Record<string, unknown>
type Me = { machineId: string; accountId: string; email: string }
type Pane = { machineId: string; agentId: string; name: string; engine: string }

export interface SharedTabsDeps {
  key: TabKey
  relay: TabRelay
  store: RosterStore
  backend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  /** This machine and the account signed in on it. */
  self(): Promise<Me>
  /** The owner's own panes in a desk tab, with each harness's name and engine, from the account's directory; null when
   *  the directory cannot be read, so that a roster never loses the owner's harnesses to a failed read. */
  ownPanes(tabId: string): Promise<Pane[] | null>
  /** The leader the account's tab setting names for a desk tab, from its directory: null for none, or one that may lead it
   *  no more. Undefined when it is not known: the directory not read yet (a failed read keeps the last good listing), or
   *  a backend that lists no leaders; the roster then keeps its own. Unset, a roster keeps its own leader too. */
  ownLeader?(tabId: string): Promise<{ machineId: string; agentId: string } | null | undefined>
  /** This account's machines' identity keys, by machine id, each as that machine reports it; null when it cannot be asked. */
  machineKey(machineId: string): Promise<string | null>
  /** An `agent_messages` request to another machine of this account, over the paired relay: its answer;
   *  `{ error: { code, message } }` when it answered with a refusal; null when it could not be asked. */
  askMachine(machineId: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null>
  /** This account's machine ids, from its directory; null when it cannot be read. */
  ownMachines(): Promise<string[] | null>
  /** Where the member's queued requests are kept, so a restart does not drop them; unset, they live in memory only. */
  requests?: RequestStore
  /** The harnesses this account asked to have in a tab, from this machine (consentStore.ts): only those are watched by the
   *  tab's other accounts. Unset, nothing is recorded, and Share grants no member harness here a view. */
  consent?: ConsentStore
  /** What the directory merges in may have changed: a roster taken, a tab left, or the shares read (service.ts
   *  rebuilds the directory, which tells deliveries and notes only of a real change). */
  changed?(): void
  /** An Agent Messages request another machine of the tab sent (`agent_messages`), with the tab and who the relay says
   *  sent it: its answer is sealed back. Unset, every request is answered as an unknown one. */
  answer?(ctx: TabContext, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** A session with a machine of the tab just opened: what waits for that machine can go now (service.ts hands its
   *  outbox over), rather than at its next try. */
  opened?(sharedTabId: string, machineId: string): void
  /** What the windows show changed: a notice, a waiting request, or the invitations or untrusted tabs a refresh read
   *  (service.ts tells them `shared_tabs_changed`). */
  announce?(): void
  /** Where notices are kept until dismissed; unset, they are kept in memory only, and gone with the process. */
  notices?: NoticeStore
  now?(): number
}

/** The owner's email as a notice carries it: control and format characters out, at most 254. */
const ownerEmailOf = (roster: Roster): string => cleanName(roster.owner.email).slice(0, 254)

export interface SharedNotice { id: string; sharedTabId: string; kind: 'refused' | 'removed' | 'relay_taken' | 'full' | 'unsent'; at: string; error?: string; machineId?: string; agentId?: string
  /** The tab owner's email (cleaned, at most 254), for `removed` and `relay_taken`: the roster is gone by the time a window shows them. */
  ownerEmail?: string }
interface Link extends TabLink { userId: string; state: 'hello' | 'knock' | 'open' | 'idle'; at: number; hello?: string }
interface Request { sharedTabId: string; id: string; op: 'add' | 'remove'; harness: RosterHarness; since: number }
const requestId = (op: Request['op'], h: Pick<RosterHarness, 'machineId' | 'agentId'>) => `${op}:${h.machineId}/${h.agentId}`
const requestOf = (q: QueuedRequest): Request => ({ ...q, id: requestId(q.op, q.harness) })

const unavailable = () => new MessageError('SHARES_UNAVAILABLE', 'Harness could not read the shared tabs. Try again in a moment.')
const invalid = () => new MessageError('INVALID_HARNESS', 'Name a harness by its machine, agent, name and engine.')
const rosterInvalid = () => new MessageError('ROSTER_INVALID', 'The shared tab\'s roster could not be verified. Try again in a moment.')
const notOwner = () => new MessageError('NOT_OWNER', 'Only the computer that shares this tab can change it.')
const shareIdMismatch = () => new MessageError('SHARE_ID_MISMATCH', 'The backend named the shared tab otherwise than Harness expects, so this computer did not sign for it.')
const notOwnAccount = () => new MessageError('NOT_OWNER', 'Only the account that shares this tab can stop it or move it.')
const peerAway = () => new MessageError('PEER_AWAY', 'That computer cannot be reached through the shared tab right now.')
const rosterPath = (tabId: string) => `/api/agent-messages/shares/${encodeURIComponent(tabId)}/roster`
const memberPath = (id: string, accountId: string) => `/api/agent-messages/shares/${id}/members/${encodeURIComponent(accountId)}`
const ignore = (): void => {}
const linkOf = (l: Link): TabLink => ({ sharedTabId: l.sharedTabId, machineId: l.machineId, peerPub: l.peerPub })
type Reply = { status: number; body: Record<string, unknown> }
const unsupported = () => new MessageError('SHARED_TABS_UNSUPPORTED', 'Shared tabs need a newer Harness service; nothing was shared.')
/** A route the backend does not have: a backend from before shared tabs answers every one of theirs 404 with Fastify's own
 *  body, no code of ours. A 404 with a code (`NOT_FOUND`, an invitation gone) is the route's answer, told as it said it.
 *  Said as BACKEND_UNAVAILABLE, "try again in a moment" never came true until that backend was updated. */
const missing = (reply: Reply): boolean => reply.status === 404 && typeof record(reply.body.error)?.code !== 'string'
/** What a route answered, or the error it gave, as it said it. */
const dataOf = (reply: Reply): Wire => {
  const data = record(reply.body.data)
  if (reply.status === 200 && reply.body.success === true && data) return data
  if (missing(reply)) throw unsupported()
  const error = record(reply.body.error)
  throw typeof error?.code === 'string' ? new MessageError(error.code, String(error.message))
    : new MessageError('BACKEND_UNAVAILABLE', 'Harness could not reach the backend. Try again in a moment.')
}
/** The version the backend holds, when it refused a roster for not being newer; null for any other answer. */
const staleAt = (reply: Reply): number | null => {
  const error = record(reply.body.error)
  return error?.code === 'STALE_ROSTER' && typeof error.version === 'number' ? error.version : null
}

export class SharedTabs {
  private readonly links = new Map<string, Link>()
  private readonly queue = new Map<string, Request>()
  /** The tabs this computer shares: the desk tab the roster is put under, the version the backend holds, and the old
   *  computer's signed change to this one's key when the tab moved here (`move`), attached to every roster from then on. */
  private readonly owned = new Map<string, { tabId: string; floor: number; keyChange?: KeyChange }>()
  /** The desk tab each of this account's shares is shared from, as the shares list it: on every computer of the account,
   *  not only the one that shares it, whose harnesses in that tab are teammates of the members' too (`deskTab`). */
  private readonly desks = new Map<string, string>()
  private readonly noticed: NoticeStore
  /** The machines `checkOwn` looked at, for the version of each tab it last looked at: a roster is checked once. */
  private readonly checked = new Map<string, { version: number; machines: Set<string> }>()
  /** When this computer last began, or failed, to take each tab's pin from another of its account's (`pull`). */
  private readonly pulled = new Map<string, number>()
  /** When this computer last asked for the key of the computer its account's tab moved to (`follow`). */
  private readonly followed = new Map<string, number>()
  /** Each tab's relay taken over (4409): when, within the last RELAY_TAKEOVER_WINDOW_MS; the wait to open it again; and
   *  whether it is opened no more. While it waits or has stopped, nothing opens it (`openRelay`). */
  private readonly takeovers = new Map<string, { at: number[]; timer: ReturnType<typeof setTimeout> | null; stopped: boolean }>()
  /** When each member account's `roster_request`s came, within the last REQUEST_WINDOW_MS (`apply`). */
  private readonly requestsFrom = new Map<string, number[]>()
  /** The Agent Messages requests this computer sent and waits on (`request`), by their `rid`. */
  private readonly asking = new Map<string, { sharedTabId: string; machineId: string; timer: ReturnType<typeof setTimeout>;
    resolve(reply: Wire): void; reject(error: Error): void }>()
  /** The request file could not be read (`restore`): nothing is written to it until it is, which the next refresh tries
   *  again. Requests made meanwhile wait in memory and join the file's once it reads. */
  private unloaded = false
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private me: Me | null = null
  private pub: string | null = null

  private readonly now: () => number

  constructor(private readonly deps: SharedTabsDeps) {
    this.now = deps.now ?? Date.now
    this.noticed = deps.notices ?? new NoticeStore(null, this.now)
    this.restore()
  }

  /**
   * Takes back the requests a restart interrupted. Resending is safe: the owner applies a request once and answers a
   * repeat with the roster it already published. A tab this computer no longer holds has nothing to ask for. Whose
   * machine each request names is known only once `self` is read, so that check follows: only the harness's own machine
   * sends an add, so an add naming another machine is dropped. A remove may come from any machine of the account
   * (`judge`), so removes stay.
   *
   * A file that cannot be read at all leaves the queue as it is in memory and marks it unloaded (`persist` then writes
   * nothing): writing what is in memory would put an empty or partial queue over the requests the file still holds.
   * Read later (`refresh`), the file's requests join those made meanwhile, which win for the same harness, and the
   * whole is written down.
   */
  private restore(): void {
    const store = this.deps.requests
    if (!store) return
    let loaded: QueuedRequest[]
    try { loaded = store.load() } catch { this.unloaded = true; return }
    const retried = this.unloaded
    this.unloaded = false
    for (const q of loaded) {
      const held = this.deps.store.current(q.sharedTabId)?.roster
      if (!held) continue
      const r = requestOf(q)
      // Already settled: the owner applied it and this computer saved that roster before the queue was written down,
      // and the owner's repeat answer would be that same roster, which `adopt` never sees again. Same test as `adopt`.
      if (held.harnesses.some((h) => same(h, r.harness)) === (r.op === 'add')) continue
      // On a load retried after a failed one, what the person asked since is newer than the file: a request in memory
      // for the same harness, the same op or its opposite, wins, as `enqueue` lets only the latest word stand. Left to
      // both be sent, the order they arrived in would decide, and a remove asked after the add could lose (review of A7).
      const opposite = `${r.sharedTabId}:${requestId(r.op === 'add' ? 'remove' : 'add', r.harness)}`
      if (this.queue.has(`${r.sharedTabId}:${r.id}`) || this.queue.has(opposite)) continue
      this.queue.set(`${r.sharedTabId}:${r.id}`, r)
    }
    if (retried || this.queue.size !== loaded.length) this.persist()
    this.timed()
    void this.self().then((me) => {
      let dropped = false
      for (const [k, r] of this.queue) if (r.op === 'add' && r.harness.machineId !== me.machineId) { this.queue.delete(k); dropped = true }
      if (dropped) { this.persist(); this.timed() }
    }).catch(ignore)
  }

  /** Writes the queue down after every change. A disk that refuses costs only the restart's memory of it. */
  private persist(): void {
    if (this.unloaded) return
    try { this.deps.requests?.save([...this.queue.values()].map(({ sharedTabId, op, harness, since }) => ({ sharedTabId, op, harness, since }))) } catch { /* the queue still works in memory */ }
    this.deps.announce?.()
  }

  /** One thing at a time: two changes that each read the roster and raise its version would put the same version twice. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch(ignore)
    return run
  }
  private async self(): Promise<Me> { return this.me ??= await this.deps.self() }
  private async myPub(): Promise<string> { return this.pub ??= await this.deps.key.publicKey() }
  private async owns(roster: Roster): Promise<boolean> { return roster.owner.machineId === (await this.self()).machineId }

  private async call(method: string, path: string, body?: unknown): Promise<Wire> {
    return dataOf(await this.deps.backend(method, path, body))
  }
  /** The shares as the backend lists them; null when they cannot be read now. A backend without the route says so
   *  (SHARED_TABS_UNSUPPORTED) rather than "cannot be read now", which no wait would change. */
  private async shares(): Promise<ShareView[] | null> {
    const reply = await this.deps.backend('GET', '/api/agent-messages/shares')
    if (missing(reply)) throw unsupported()
    const list = reply.status === 200 && reply.body.success === true ? record(reply.body.data)?.shares : null
    return Array.isArray(list) ? list.flatMap((s) => { const view = shareOf(s); return view ? [view] : [] }) : null
  }
  /** A socket is opened again before each use: a gateway that restarted dropped it without a word (gateway/tabRelay.ts).
   *  Not while a takeover waits or stopped it (`takenOver`): opened at once, it would take the tab back too soon. */
  private async openRelay(id: string): Promise<boolean> {
    const taken = this.takeovers.get(id)
    if (this.closed || taken?.timer || taken?.stopped) return false
    await this.deps.relay.open(id)
    return true
  }

  // ── the owner ─────────────────────────────────────────────────────────────────────────────────────

  /** The backend names the share (`sharedTabId`, from the owner's account and the desk tab): the first roster is put
   *  before the id is known, and the second carries it. The id is derived here too, and one the backend answers
   *  otherwise is refused: every roster from then on would be signed for a tab of the backend's choosing. */
  share(tabId: string, name: string): Promise<{ sharedTabId: string }> {
    return this.serial(async () => {
      const me = await this.self()
      const shares = await this.shares()
      if (!shares) throw unavailable()
      const held = shares.find((s) => s.owner && s.tabId === tabId)
      if (held && held.ownerMachineId !== me.machineId) {
        throw new MessageError('SHARED_ELSEWHERE', 'This tab is already shared from another of your computers. Change it there.')
      }
      if (held && held.sharedTabId !== sharedTabIdOf(me.accountId, tabId)) throw shareIdMismatch()
      if (held) { await this.reread(shares); return { sharedTabId: held.sharedTabId } }
      const own = await this.ownHarnesses(tabId, [])
      const { roster: draft, cut } = composeCut(await this.empty(UNNAMED, name), { own: own ?? [], ...await this.leaderOf(tabId) })
      // Version 1, or past the version a share of this tab stopped at: shared again, it carries on from there.
      const first = await this.put(tabId, draft)
      const sharedTabId = String(first.data.sharedTabId)
      if (sharedTabId !== sharedTabIdOf(me.accountId, tabId)) throw shareIdMismatch()
      this.owned.set(sharedTabId, { tabId, floor: first.roster.version })
      await this.pinSelf(sharedTabId)
      await this.publish({ ...draft, sharedTabId, version: first.roster.version + 1 })
      if (cut) this.full(sharedTabId)
      return { sharedTabId }
    })
  }

  invite(sharedTabId: string, emails: string[], days: 7 | 30 | 90): Promise<{ invited: string[]; refused: { email: string; error: string }[] }> {
    return this.serial(async () => {
      const roster = await this.authority(sharedTabId)
      if (![7, 30, 90].includes(days) || !Array.isArray(emails)) throw new MessageError('USAGE', 'Invite one or more addresses for 7, 30 or 90 days.')
      const room = ROSTER_LIMITS.members - roster.members.length
      const invited: string[] = [], refused: { email: string; error: string }[] = []
      for (const [i, email] of [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].entries()) {
        if (i >= room) { refused.push({ email, error: 'TAB_FULL' }); continue }
        try {
          await this.call('POST', `/api/agent-messages/shares/${sharedTabId}/invites`, { email, days })
          invited.push(email)
        } catch (error) { refused.push({ email, error: (error as MessageError).code }) }
      }
      await this.reread(await this.shares())
      return { invited, refused }
    })
  }

  revoke(inviteId: string): Promise<void> {
    return this.serial(async () => {
      await this.call('DELETE', `/api/agent-messages/invites/${encodeURIComponent(inviteId)}`)
      await this.reread(await this.shares())
    })
  }

  /**
   * The person chose the tab's leader, from any computer of the owner's account: written to the owner's tab setting
   * (`PATCH /api/agent-messages/tabs/<tabId>`), the one source of a tab's leader, shared or not (the spec's "A leader in
   * every tab"). Nothing is signed here: the backend tells every computer of the account (`desk_changed`), and the one
   * that shares the tab signs its next roster with it (`reshare`), at once or when it wakes. 1c let only that computer
   * change the leader, so the owner could not from a laptop while the studio slept. The backend checks that the leader
   * is a harness of the tab on a machine of the account (`INVALID_LEADER`).
   */
  async setLeader(sharedTabId: string, leader: { machineId: string; agentId: string } | null): Promise<void> {
    const wanted = leader && harnessRef(leader)
    if (leader && !wanted) throw new MessageError('INVALID_LEADER', 'Choose a harness in this tab.')
    const shares = await this.shares()
    if (!shares) throw unavailable()
    const share = shares.find((s) => s.sharedTabId === sharedTabId && s.owner)
    if (!share) throw new MessageError('NOT_OWNER', 'Only the account that shares this tab can choose its leader.')
    // A share listed under an id the backend did not derive from the account and the tab names some other desk tab.
    if (sharedTabId !== sharedTabIdOf((await this.self()).accountId, share.tabId)) throw shareIdMismatch()
    await this.call('PATCH', `/api/agent-messages/tabs/${encodeURIComponent(share.tabId)}`, { leader: wanted })
  }

  removeMember(sharedTabId: string, accountId: string): Promise<void> {
    return this.serial(async () => {
      const roster = await this.authority(sharedTabId)
      await this.call('DELETE', memberPath(sharedTabId, accountId))
      await this.change(roster, { members: roster.members.filter((m) => m.accountId !== accountId) })
    })
  }

  /**
   * The owner removes any member's harness at once; a member asks the owner to remove its own. The owner's own
   * harnesses are its desk's panes: one leaves when the person moves it out of the tab.
   *
   * A member's harness on another machine of this account is handed to that machine (`forwarded`), which takes back its
   * consent (consentStore.ts) and asks the owner itself, as an add is. Taking the consent back there, at once, is what
   * keeps the view away: left to the owner, one that never applied the removal would keep watching, and one that applied
   * it and listed the harness again while that machine was away would be seen only listing it, never taking it out
   * (review of C1, round 2). That machine away, the removal is refused, as an add is, and nothing changes: a removal
   * remembered here to hand on later would need a queue and a timer of its own, for a harness nobody can watch while its
   * machine is away anyway. A removal handed on for a harness not on this machine is refused, never handed on again.
   */
  async removeHarness(sharedTabId: string, machineId: string, agentId: string, forwarded = false): Promise<Record<string, unknown>> {
    const me = await this.self()
    if (forwarded && machineId !== me.machineId) throw new MessageError('NOT_THIS_MACHINE', 'That harness is not on this machine: take it out from the machine it runs on.')
    const held = this.held(sharedTabId)
    if (machineId !== me.machineId && !await this.owns(held.roster)) {
      const entry = held.roster.harnesses.find((h) => same(h, { machineId, agentId }))
      if (!entry) throw new MessageError('NOT_IN_TAB', 'That harness is not in the tab.')
      if (entry.accountId !== me.accountId) throw new MessageError('NOT_YOURS', 'Only its own person can take a harness out of the tab.')
      const answer = await this.deps.askMachine(machineId, { action: 'share_remove', sharedTabId, machineId, agentId, forwarded: true })
      if (!answer) throw new MessageError('MACHINE_AWAY', 'That machine could not be asked to take it out. Try again once it is on.')
      const refused = record(answer.error)
      if (refused) throw new MessageError(String(refused.code), String(refused.message))
      return answer
    }
    // On the harness's own machine its consent goes first, whatever the roster held here says: the person asked.
    if (machineId === me.machineId) this.deps.consent?.revoke(sharedTabId, machineId, agentId)
    return this.serial(async () => {
      const held = this.held(sharedTabId)
      const entry = held.roster.harnesses.find((h) => same(h, { machineId, agentId }))
      if (!entry) {
        // Still `Joining…`: its add waits here for the owner's computer. The person withdrew it, so the add goes now
        // (its consent went above), never later: applied once that computer came back, it would share a harness the
        // person took back (final review of 1c, I3).
        if (machineId === me.machineId && this.queue.delete(`${sharedTabId}:${requestId('add', { machineId, agentId })}`)) {
          this.persist()
          this.timed()
          return { ok: true }
        }
        throw new MessageError('NOT_IN_TAB', 'That harness is not in the tab.')
      }
      if (await this.owns(held.roster)) {
        if (entry.accountId === held.roster.owner.accountId) throw new MessageError('OWNER_PANE', 'Move it out of the tab on your desk.')
        const roster = await this.authority(sharedTabId)
        await this.change(roster, { others: roster.harnesses.filter((h) => !same(h, entry)) })
        return { ok: true }
      }
      if (entry.accountId !== me.accountId) throw new MessageError('NOT_YOURS', 'Only its own person can take a harness out of the tab.')
      this.enqueue(sharedTabId, 'remove', entry)
      await this.flush(sharedTabId)
      return { ok: true }
    })
  }

  /** Any computer of the owner's account stops a tab, whichever one shares it: the backend checks the account, and the
   *  computer that shares it hears the relay close (4403). A computer that cannot reach that one still ends the share. */
  stop(sharedTabId: string): Promise<void> {
    return this.serial(async () => {
      const shares = await this.shares()
      if (!shares) throw unavailable()
      if (!shares.some((s) => s.sharedTabId === sharedTabId && s.owner)) throw notOwnAccount()
      await this.call('DELETE', `/api/agent-messages/shares/${sharedTabId}`)
      this.drop(sharedTabId)
    })
  }

  /**
   * Moves a tab this account shares to this computer. First, best effort, the computer whose roster this one holds signs
   * this one's key for the tab (`keyChange`), which lets members' pins follow; it is asked outside the queue, as an away
   * machine costs an 8 s wait (`addHarness`). Then the backend takes this computer as the tab's, and only then does this
   * one pin its own key and sign the next roster, past every version held: a move the backend refuses changes nothing
   * here. The roster carries on from the one held (members' harnesses included); a computer that held none starts from
   * the desk's panes and the members the backend lists, and members add their harnesses again. Moved to where it is,
   * nothing is asked or signed.
   */
  async move(sharedTabId: string): Promise<{ sharedTabId: string; version: number }> {
    const me = await this.self(), pub = await this.myPub()
    const shares = await this.shares()
    if (!shares) throw unavailable()
    const share = shares.find((s) => s.sharedTabId === sharedTabId && s.owner)
    if (!share) throw notOwnAccount()
    if (sharedTabId !== sharedTabIdOf(me.accountId, share.tabId)) throw shareIdMismatch()
    const held = this.deps.store.current(sharedTabId)?.roster
    if (held && held.owner.machineId === me.machineId && held.owner.machinePublicKey === pub && share.ownerMachineId === me.machineId) {
      return { sharedTabId, version: held.version }
    }
    const from = held?.owner ?? null
    const keyChange = from && from.machineId !== me.machineId ? await this.askKeyChange(sharedTabId, from, pub) : undefined
    await this.call('POST', `/api/agent-messages/shares/${sharedTabId}/move`, { machineId: me.machineId })
    return this.serial(async () => {
      // The listing just read may hold a newer roster than this computer's (harnesses members added since it last heard
      // from the old computer): taken first, when it verifies under the pin, or the move would sign them out of the tab
      // (final review of 1b). One that does not verify, or is older, changes nothing.
      const listed = signedOf(share.roster)
      if (listed) this.deps.store.offer(listed)
      const base = this.deps.store.current(sharedTabId)?.roster
      this.owned.set(sharedTabId, { tabId: share.tabId, floor: Math.max(share.version, base?.version ?? 0), ...(keyChange ? { keyChange } : {}) })
      const start = base ?? { ...await this.empty(sharedTabId, parseRoster(signedOf(share.roster)?.body ?? '')?.name ?? ''), version: 0 }
      const own = await this.ownHarnesses(share.tabId, start.harnesses)
      await this.change(start, { members: share.members, invites: share.invites, ...(own ? { own } : {}), ...await this.leaderOf(share.tabId) }, true, true)
      return { sharedTabId, version: this.owned.get(sharedTabId)!.floor }
    })
  }

  /** The old computer's signature over this one's key, kept only when it verifies under the key the held roster names:
   *  anything else would only make members record a roster they cannot verify, which no change does as well. */
  private async askKeyChange(id: string, from: Roster['owner'], nextPub: string): Promise<KeyChange | undefined> {
    const answer = await this.deps.askMachine(from.machineId, { action: 'tab_keychange', sharedTabId: id, nextPub, machineId: (await this.self()).machineId })
    const signature = answer?.signature
    if (answer?.previousPub !== from.machinePublicKey || typeof signature !== 'string') return undefined
    return verify(b64d(from.machinePublicKey), keyChangeBytes(id, nextPub), b64d(signature)) ? { previousPub: from.machinePublicKey, signature } : undefined
  }

  /**
   * Another computer of this account is taking a tab (service.ts `tab_keychange`, only over the paired relay): signed
   * only while this computer is its authority, the roster it holds naming it under the key pinned here, which is its
   * own. A computer that began again with a new key, or holds the tab as another's, has no key members trust to sign.
   * The key must be the one the named machine of this account reports itself (`machineKey`, which reaches only the
   * account's paired machines): the paired relay also carries the owner's apps (a phone, a remote window), and the
   * signature has no version, so a key no machine holds would move every member's pin to it for good (review of A6).
   * Asked before the queue: a machine that cannot be asked costs an 8 s wait.
   */
  async keyChange(sharedTabId: string, nextPub: unknown, machineId: unknown): Promise<{ previousPub: string; signature: string }> {
    if (typeof nextPub !== 'string' || !PUB.test(nextPub)) throw new MessageError('INVALID_KEY', 'Name the key of the computer the tab moves to.')
    if (typeof machineId !== 'string' || !machineId || await this.deps.machineKey(machineId) !== nextPub) {
      throw new MessageError('NOT_OUR_MACHINE', 'That key is not the one a computer of this account reports.')
    }
    return this.serial(async () => {
      const held = this.deps.store.current(sharedTabId), pub = await this.myPub()
      if (!held || !await this.owns(held.roster) || this.deps.store.pinned(sharedTabId) !== pub) throw notOwner()
      return { previousPub: pub, signature: await this.deps.key.signKeyChange(sharedTabId, nextPub) }
    })
  }

  /** Re-read the shares (on wake, on `desk_changed`, and while a request waits): the owner republishes when its members
   *  or its panes changed; a member takes the newest roster the backend holds, if its owner's key signed it. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return
      if (this.unloaded) this.restore()
      // A backend from before shared tabs has nothing to read; the tabs held here still open their relays, which a
      // backend that has them again then carries.
      const shares = await this.shares().catch((error: unknown) => {
        if (error instanceof MessageError && error.code === 'SHARED_TABS_UNSUPPORTED') return null
        throw error
      })
      await this.reread(shares)
      // Every tab held, listed or not: a tab the backend no longer lists for this account is one it was removed from
      // while away, which the relay answers with 4403, and that forgets it here.
      for (const roster of this.deps.store.all()) await this.openRelay(roster.sharedTabId)
      if (shares) await this.announceIfChanged(shares)
      this.deps.changed?.()
    })
  }

  /** The invitations and untrusted tabs as last told, so a refresh that changed neither tells the windows nothing. */
  private told = ''
  private async announceIfChanged(shares: ShareView[]): Promise<void> {
    const invites = await this.invites().catch(() => null)
    if (!invites) return
    const untrusted = this.untrustedOf(shares, await this.self())
    const digest = JSON.stringify([invites.map((i) => i.id).sort(), untrusted.map((u) => u.sharedTabId).sort()])
    if (digest === this.told) return
    this.told = digest
    this.deps.announce?.()
  }

  /** The desk tab a tab of this account's is shared from, for the directory to merge the members' harnesses into; null
   *  for a tab shared with this account, or one whose shares this computer has not read yet. */
  deskTab(sharedTabId: string): string | null {
    return this.owned.get(sharedTabId)?.tabId ?? this.desks.get(sharedTabId) ?? null
  }

  private async reread(shares: ShareView[] | null): Promise<void> {
    if (!shares) return
    const me = await this.self()
    for (const share of shares) {
      // A share of this account under an id the backend did not derive from the account and the tab: signing for it
      // would put this computer's key on a tab of the backend's choosing, which `share` refused (SHARE_ID_MISMATCH).
      if (share.owner && share.sharedTabId !== sharedTabIdOf(me.accountId, share.tabId)) { this.misnamed(share.sharedTabId); continue }
      if (share.owner) this.desks.set(share.sharedTabId, share.tabId)
      if (!share.owner || share.ownerMachineId !== me.machineId) { await this.retake(share); continue }
      // Both fields are the backend's word. A tab held here as another computer's is never taken for this one's: a
      // listing saying otherwise would have this computer sign a roster over the real owner's and pin its own key.
      const held = this.deps.store.current(share.sharedTabId)?.roster
      if (!held || (held.owner.machineId === me.machineId && held.owner.machinePublicKey === await this.myPub())) await this.reshare(share)
    }
    for (const id of new Set([...this.queue.values()].map((r) => r.sharedTabId))) await this.flush(id)
  }

  /** Recorded once for the person (it stays in the alerts across restarts), however often the shares are read. */
  private misnamed(id: string): void {
    if (!this.deps.store.alerts().some((a) => a.sharedTabId === id && a.error === 'share_id_mismatch')) this.deps.store.alert(id, 'share_id_mismatch')
  }

  /** One of this computer's shares, as the backend has it now: members accepted or removed, invitations, and the
   *  desk's panes. A roster this computer lost (a new data folder) is taken back from the backend when its own key
   *  signed it, and otherwise begun again past the backend's version. */
  private async reshare(share: ShareView): Promise<void> {
    const id = share.sharedTabId, had = this.owned.get(id)
    // A restart forgets the old computer's key change; the roster this computer signed with it last still carries it.
    const keyChange = had?.keyChange ?? this.deps.store.current(id)?.signed.keyChange
    this.owned.set(id, { tabId: share.tabId, floor: Math.max(had?.floor ?? 0, share.version), ...(keyChange ? { keyChange } : {}) })
    let held = this.deps.store.current(id)?.roster
    const signed = signedOf(share.roster)
    if (!held) {
      await this.pinSelf(id)
      const offered = signed ? this.deps.store.offer(signed) : null
      held = offered && 'roster' in offered ? offered.roster : undefined
    }
    const base = held ?? { ...await this.empty(id, parseRoster(signed?.body ?? '')?.name ?? ''), version: 0 }
    const own = await this.ownHarnesses(share.tabId, base.harnesses)
    await this.change(base, { members: share.members, invites: share.invites, ...(own ? { own } : {}), ...await this.leaderOf(share.tabId) }, !held)
  }

  /** A share of another computer: a member's, whose owner key was pinned when the person accepted, on this computer or
   *  another of the account's (`pull`), or one this account shares from another of its computers, whose key that
   *  computer reports. */
  private async retake(share: ShareView): Promise<void> {
    if (share.owner && !this.deps.store.current(share.sharedTabId)) {
      const pub = await this.deps.machineKey(share.ownerMachineId)
      if (pub) this.deps.store.pin(share.sharedTabId, pub)
    }
    if (!share.owner && !this.deps.store.pinned(share.sharedTabId)) this.pull(share.sharedTabId)
    const signed = signedOf(share.roster)
    const offered = signed && this.deps.store.offer(signed)
    if (offered && 'roster' in offered) await this.adopt(offered.roster)
    const now = this.deps.store.current(share.sharedTabId)?.roster
    if (share.owner && now && now.owner.machineId !== share.ownerMachineId) this.follow(share)
  }

  /**
   * This account's tab moved to another of its computers with no key change this one could verify (the old computer
   * was away): the owner's computers trust each other's machine keys (`retake`, `tab_pub`), never a fingerprint, so this
   * one takes the new computer's roster under the key that computer reports, never the key the roster names. Only a
   * roster that verifies under it, names that computer under that same key (a key change it signed to some other key
   * would verify too, review of A6) and this account, and is newer than the one held: a backend that
   * named another computer of the account could otherwise steer this one back to an older roster of that computer's.
   * Asked beside the queue, at most once every PULL_RETRY_MS: the new computer may be asleep, and its 8 s wait would
   * hold up every frame on each read of the shares.
   */
  private follow(share: ShareView): void {
    const id = share.sharedTabId, last = this.followed.get(id)
    if (last !== undefined && this.now() - last < PULL_RETRY_MS) return
    this.followed.set(id, this.now())
    void this.deps.machineKey(share.ownerMachineId).then((pub) => pub ? this.serial(async () => {
      const me = await this.self(), held = this.deps.store.current(id)?.roster, signed = signedOf(share.roster)
      const checked = signed && verifyRoster(signed, pub)
      if (!held || !checked || 'error' in checked || checked.roster.sharedTabId !== id || checked.roster.owner.machineId !== share.ownerMachineId
        || checked.roster.owner.machinePublicKey !== pub || checked.roster.owner.accountId !== me.accountId || checked.roster.version <= held.version) return
      this.deps.store.forget(id)
      this.deps.store.pin(id, pub)
      this.deps.store.offer(signed)
      this.followed.delete(id)
      await this.adopt(checked.roster)
      await this.openRelay(id)
    }) : undefined).catch(ignore)
  }

  private async authority(id: string): Promise<Roster> {
    const held = this.deps.store.current(id)
    if (!held || !await this.owns(held.roster)) throw notOwner()
    if (!this.owned.has(id)) await this.reread(await this.shares())
    if (!this.owned.has(id)) throw unavailable()
    return this.deps.store.current(id)!.roster
  }

  private held(id: string): { roster: Roster; signed: SignedRoster } {
    const held = this.deps.store.current(id)
    if (!held) throw new MessageError('NOT_SHARED', 'This computer holds no such shared tab.')
    return held
  }

  private async empty(sharedTabId: string, name: string): Promise<Roster> {
    const me = await this.self()
    return { sharedTabId, version: 1, name: name.slice(0, 200), leader: null, members: [], harnesses: [], invites: [],
      owner: { accountId: me.accountId, email: me.email, machineId: me.machineId, machinePublicKey: await this.myPub() } }
  }

  /** The roster's leader as the owner's tab setting names it (`setLeader`): the setting is the one source, so a roster
   *  this computer signs follows it, a leader that may lead no more included. Nothing while the setting is not known: the
   *  roster keeps its own. `composeCut` drops one the roster does not list. */
  private async leaderOf(tabId: string): Promise<{ leader?: Roster['leader'] }> {
    const leader = await this.deps.ownLeader?.(tabId)
    return leader === undefined ? {} : { leader }
  }

  /** The desk tab's panes as the owner's harnesses, each with its machine's key; a machine that cannot be asked keeps
   *  the key the roster had for it, and one never listed is left out until it can be. */
  private async ownHarnesses(tabId: string, had: RosterHarness[]): Promise<RosterHarness[] | null> {
    const panes = await this.deps.ownPanes(tabId)
    if (!panes) return null
    const me = await this.self(), keys = new Map<string, string | null>()
    const out: RosterHarness[] = []
    for (const pane of panes) {
      if (!keys.has(pane.machineId)) {
        keys.set(pane.machineId, await this.deps.machineKey(pane.machineId)
          ?? had.find((h) => h.machineId === pane.machineId && h.accountId === me.accountId)?.machinePublicKey ?? null)
      }
      const harness = wireHarness({ ...pane, name: String(pane.name).slice(0, 200), engine: String(pane.engine).slice(0, 64),
        accountId: me.accountId, machinePublicKey: keys.get(pane.machineId) })
      if (harness) out.push(harness)
    }
    return out
  }

  /**
   * Sign a roster and store it on the backend. A version only grows (the spec's "Authority"), across a stop and a share
   * again too: a put that is not newer than what the backend holds is refused with the version it holds
   * (`STALE_ROSTER`), and signed once more, past it. A second refusal is told as the backend said it.
   */
  private async put(tabId: string, roster: Roster): Promise<{ data: Wire; roster: Roster; signed: SignedRoster }> {
    const me = await this.self()
    const keyChange = this.owned.get(roster.sharedTabId)?.keyChange
    const once = async (r: Roster) => {
      if (!fitsRoster(r)) throw new MessageError('TAB_FULL', 'The shared tab\'s roster would be too large for its members to take. Take a harness out of it.')
      const signed = { ...await this.sign(r), ...(keyChange ? { keyChange } : {}) }
      return { reply: await this.deps.backend('PUT', rosterPath(tabId), { machineId: me.machineId, version: r.version, roster: signed }), roster: r, signed }
    }
    let tried = await once(roster)
    const held = staleAt(tried.reply)
    if (held !== null) tried = await once({ ...roster, version: Math.max(held, roster.version) + 1 })
    return { data: dataOf(tried.reply), roster: tried.roster, signed: tried.signed }
  }

  private async sign(roster: Roster): Promise<SignedRoster> {
    const body = encodeRoster(roster)
    return { body, signature: await this.deps.key.signRoster(roster.sharedTabId, roster.version, body) }
  }

  /** The owner trusts its own key for its own tabs: a key it no longer has (a new identity) is replaced, not kept. Only
   *  for a tab whose held roster is this computer's, or that holds none: a member's pin is its owner's, and replacing
   *  it would take every real roster for a forgery from then on. */
  private async pinSelf(id: string): Promise<void> {
    const pub = await this.myPub()
    if (this.deps.store.pin(id, pub) === 'pinned') return
    const held = this.deps.store.current(id)
    if (held && !await this.owns(held.roster)) throw new MessageError('NOT_OWNER', 'That tab is shared with this computer by another: it cannot share it.')
    this.deps.store.forget(id)
    this.deps.store.pin(id, pub)
  }

  /** The next roster when it says something new, one version past both what is held here and what the backend has. */
  private async change(roster: Roster, delta: Parameters<typeof composeCut>[1], always = false, takeOver = false): Promise<void> {
    const { roster: next, cut } = composeCut(roster, { owner: { ...(await this.empty(roster.sharedTabId, '')).owner }, ...delta })
    if (!always && sameRoster(roster, next)) return
    await this.publish({ ...next, version: Math.max(roster.version, this.owned.get(roster.sharedTabId)!.floor) + 1 }, takeOver)
    if (cut) this.full(roster.sharedTabId)
  }

  /** A roster just published was cut to the harness limit: the owner's desk has more panes than a tab holds. Told once
   *  for each roster that cut, and not again while the last such notice is unread: a desk that stays too big is cut on
   *  every change, and the person needs telling once. */
  private full(id: string): void {
    if (!this.noticed.unread().some((n) => n.sharedTabId === id && n.kind === 'full')) this.notice({ sharedTabId: id, kind: 'full', error: 'TAB_FULL' })
  }

  /** Sign, store on the backend, keep, and send to every other machine the roster lists: one whose session is not open
   *  yet gets it once it opens (`opened`). A tab moving here (`takeOver`) gives up the roster held under the old
   *  computer's key once the backend took this one's, not before: a put that fails leaves it as it was. */
  private async publish(draft: Roster, takeOver = false): Promise<void> {
    const me = await this.self(), id = draft.sharedTabId
    const { roster: next, signed } = await this.put(this.owned.get(id)!.tabId, draft)
    this.owned.get(id)!.floor = next.version
    if (takeOver) this.deps.store.forget(id)
    await this.pinSelf(id)
    this.deps.store.offer(signed)
    await this.adopt(next)
    await this.openRelay(id)
    const machines = new Map(next.harnesses.filter((h) => h.machineId !== me.machineId).map((h) => [h.machineId, h.accountId]))
    for (const [machineId, accountId] of machines) {
      if (await this.ensure(next, machineId, accountId)) await this.sealTo(next, machineId, { kind: 'roster', signed })
    }
  }

  /** A member's request, from a machine whose session proved the key it has here. Applied only for the sender's own
   *  account, which must be a member; the same request twice changes nothing the second time. The sender always gets
   *  the outcome: a refusal, or the roster, which settles its request even when its machine is not listed in it. */
  private async apply(id: string, from: { machineId: string; userId: string }, link: Link, frame: Wire): Promise<void> {
    let roster: Roster
    try { roster = await this.authority(id) } catch { return }
    const reqId = typeof frame.id === 'string' ? frame.id.slice(0, 400) : null
    if (!reqId || (frame.op !== 'add' && frame.op !== 'remove')) return
    const verdict = judge(roster, from, link.peerPub, frame.op, frame.harness)
    if (typeof verdict === 'string') { await this.sealTo(roster, from.machineId, { kind: 'roster_refused', id: reqId, error: verdict }); return }
    // Only a request that changes the roster counts: a member sends every waiting request again on each retry, refresh
    // and new session, and a repeat already applied (or a remove already done) costs a reply, not a signature.
    if (verdict && !this.admitRequest(from.userId)) { await this.sealTo(roster, from.machineId, { kind: 'roster_refused', id: reqId, error: 'RATE_LIMITED' }); return }
    if (verdict) await this.change(roster, verdict)
    const now = this.held(id)
    if (!verdict || !now.roster.harnesses.some((h) => h.machineId === from.machineId)) await this.sealTo(now.roster, from.machineId, { kind: 'roster', signed: now.signed })
  }

  /** Whether a member account's change is within REQUESTS_PER_MEMBER in REQUEST_WINDOW_MS, counting it if so. One
   *  refused is not counted: a member that asks too often is let in again as its earlier requests age out. */
  private admitRequest(accountId: string): boolean {
    const now = this.now(), recent = (this.requestsFrom.get(accountId) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS)
    const admitted = recent.length < REQUESTS_PER_MEMBER
    this.requestsFrom.set(accountId, admitted ? [...recent, now] : recent)
    return admitted
  }

  // ── a member ──────────────────────────────────────────────────────────────────────────────────────

  async invites(): Promise<Array<{ id: string; sharedTabId: string; ownerEmail: string; ownerMachineId: string; expiresAt: string; tabName: string }>> {
    const data = await this.call('GET', '/api/agent-messages/invites')
    return (Array.isArray(data.invites) ? data.invites : []).flatMap((i) => {
      const r = record(i)
      return r && [r.id, r.sharedTabId, r.ownerEmail, r.ownerMachineId, r.expiresAt].every((v) => typeof v === 'string')
        // The tab's name is the owner's, unverified until the roster is read after Accept: cleaned again here, and '' from a
        // backend that sends none (an older one), so a window says "a tab".
        ? [{ id: r.id as string, sharedTabId: r.sharedTabId as string, ownerEmail: r.ownerEmail as string, ownerMachineId: r.ownerMachineId as string, expiresAt: r.expiresAt as string,
          tabName: typeof r.tabName === 'string' ? cleanName(r.tabName).slice(0, 200) : '' }]
        : []
    })
  }

  /**
   * The invitee cannot see the owner's key before accepting (the backend shows a roster only to members), so trust is
   * on first use: the key of the first roster read after accepting is pinned, and its fingerprint returned for the
   * person to compare. A key the person was shown (`ownerPub`) must be that one. A roster that does not verify, or
   * the wrong key, leaves the tab again at once: a membership whose roster cannot be trusted is only a way in.
   *
   * A roster that cannot be read at all (the backend down, or not listing the tab yet) is not one that failed: the
   * shares are read again (`acceptedShare`), and still unreadable the person stays a member, `pending`, with nothing
   * pinned. The tab is then among the `untrusted`, whose owner the person trusts once its roster can be read.
   */
  accept(inviteId: string, ownerPub?: string): Promise<{ sharedTabId: string; fingerprint: string } | { sharedTabId: string; pending: true }> {
    return this.serial(async () => {
      const me = await this.self()
      const id = String((await this.call('POST', `/api/agent-messages/invites/${encodeURIComponent(inviteId)}/accept`)).sharedTabId)
      const share = await this.acceptedShare(id)
      if (!share) return { sharedTabId: id, pending: true as const }
      const signed = signedOf(share.roster)
      const roster = signed && parseRoster(signed.body)
      const leave = async (code: string, message: string): Promise<never> => {
        await this.deps.backend('DELETE', memberPath(id, me.accountId))
        this.deps.store.forget(id)
        throw new MessageError(code, message)
      }
      if (!signed || !roster || roster.sharedTabId !== id) return leave('ROSTER_INVALID', 'The shared tab\'s roster could not be verified, so you left it again. Ask its owner to invite you again.')
      const pub = roster.owner.machinePublicKey
      if (ownerPub && ownerPub !== pub) return leave('OWNER_KEY_MISMATCH', 'The shared tab is signed by another computer than the one you were shown, so you left it again.')
      if (!await this.trust(id, signed, pub)) return leave('ROSTER_INVALID', 'The shared tab\'s roster could not be verified, so you left it again. Ask its owner to invite you again.')
      return { sharedTabId: id, fingerprint: fingerprint(b64d(pub)) }
    })
  }

  /** The share just accepted as the backend lists it, read again up to ACCEPT_RETRIES times ACCEPT_RETRY_MS apart while
   *  the shares cannot be read or do not list it; null when they never did. In the queue, as the accept is: up to 3 s. */
  private async acceptedShare(id: string): Promise<ShareView | null> {
    for (let tries = 0; ; tries++) {
      const share = (await this.shares().catch(() => null))?.find((s) => s.sharedTabId === id)
      if (share || tries === ACCEPT_RETRIES) return share ?? null
      await new Promise((done) => setTimeout(done, ACCEPT_RETRY_MS))
    }
  }

  /**
   * The first of two steps to trust a tab's owner again without a new invitation (the spec's Errors row "the member is
   * asked to accept again" now means "confirm the new fingerprint"): the key the backend's roster names, which signed
   * it, beside the one pinned here, for the person to compare. Nothing changes here. Refused for this account's own
   * tabs, whose trust is its computers' keys (`retake`), and for a tab the backend lists no membership of.
   */
  retrustOffer(sharedTabId: string): Promise<{ sharedTabId: string; ownerEmail: string; ownerPub: string; fingerprint: string; version: number; pinnedFingerprint: string | null }> {
    return this.serial(async () => {
      const { share, roster } = await this.listed(sharedTabId)
      const pub = roster.owner.machinePublicKey, pinned = this.deps.store.pinned(sharedTabId)
      return { sharedTabId, ownerEmail: share.ownerEmail, ownerPub: pub, fingerprint: fingerprint(b64d(pub)), version: roster.version,
        pinnedFingerprint: pinned && fingerprint(b64d(pinned)) }
    })
  }

  /**
   * The second step: the person confirmed the fingerprint of `ownerPub`, which is pinned in place of whatever was, with
   * the roster it signed. The roster is read again, not taken from the check: a key that changed in between is not the
   * one the person saw (`OWNER_KEY_MISMATCH`, and the old pin stays). A roster older than one that verifies here is
   * refused (`STALE_ROSTER`): a backend serving an old roster under another key would otherwise have the person trade
   * the owner's current key for it.
   */
  retrust(sharedTabId: string, ownerPub: string): Promise<{ sharedTabId: string; fingerprint: string }> {
    return this.serial(async () => {
      const { signed, roster } = await this.listed(sharedTabId)
      if (roster.owner.machinePublicKey !== ownerPub) {
        throw new MessageError('OWNER_KEY_MISMATCH', 'The shared tab is now signed by another computer than the one you were shown. Check its fingerprint again.')
      }
      const held = this.deps.store.current(sharedTabId)?.roster
      if (held && held.version > roster.version) {
        throw new MessageError('STALE_ROSTER', 'This computer holds a newer roster of that tab than the backend serves, so nothing changed. Try again in a moment.')
      }
      // It verified against this key (`listed`), so it is taken.
      await this.trust(sharedTabId, signed, ownerPub)
      return { sharedTabId, fingerprint: fingerprint(b64d(ownerPub)) }
    })
  }

  /**
   * The memberships the backend lists for this account that no roster held here verifies, for the person to trust the
   * owner again (`retrustOffer`): no key pinned here (a new data folder, and none of the account's other computers
   * had one to give, `pull`), or the pinned key cannot verify what the backend serves now (the owner began again with
   * a new key and no change signed by the old, `unpinned_key`). A read only: it pulls nothing and pins nothing.
   */
  private pendingByTab = new Map<string, Array<{ id: string; email: string; expiresAt: string }>>()
  async untrusted(): Promise<Array<{ sharedTabId: string; ownerEmail: string }>> {
    const shares = await this.shares()
    if (!shares) throw unavailable()
    this.pendingByTab = new Map(shares.filter((s) => s.owner).map((s) => [s.sharedTabId, s.pending]))
    return this.untrustedOf(shares, await this.self())
  }

  /** The owner's pending invitations of a tab, with their ids, as the last read of `untrusted()` listed them; none for
   *  a tab not owned here or not read yet. Taken from that read so a `shares` answer costs one backend read. */
  pendingInvites(sharedTabId: string): Array<{ id: string; email: string; expiresAt: string }> {
    return this.pendingByTab.get(sharedTabId) ?? []
  }

  private untrustedOf(shares: ShareView[], me: Me): Array<{ sharedTabId: string; ownerEmail: string }> {
    return shares.filter((s) => {
      // The owner's own tabs, by the backend's word or by the roster's: its computers trust each other's keys (`follow`).
      if (s.owner || parseRoster(signedOf(s.roster)?.body ?? '')?.owner.accountId === me.accountId) return false
      const pin = this.deps.store.pinned(s.sharedTabId), signed = signedOf(s.roster)
      const checked = pin && signed ? verifyRoster(signed, pin) : null
      return !checked || 'error' in checked || checked.roster.sharedTabId !== s.sharedTabId
    }).map((s) => ({ sharedTabId: s.sharedTabId, ownerEmail: s.ownerEmail }))
  }

  /** This account's membership of a tab as the backend lists it, and the roster it serves, verified against the key that
   *  roster names: what the owner's computer signed, if the person trusts that key. */
  private async listed(id: string): Promise<{ share: ShareView; signed: SignedRoster; roster: Roster }> {
    const isOwner = () => new MessageError('IS_OWNER', 'Your account shares this tab: there is no owner to trust again.')
    const held = this.deps.store.current(id)
    if (held && await this.owns(held.roster)) throw isOwner()
    const shares = await this.shares()
    if (!shares) throw unavailable()
    const share = shares.find((s) => s.sharedTabId === id)
    if (share?.owner) throw isOwner()
    if (!share) throw new MessageError('NOT_SHARED', 'Your account is not a member of that shared tab.')
    const signed = signedOf(share.roster), own = signed && parseRoster(signed.body)
    const checked = own && verifyRoster(signed, own.owner.machinePublicKey)
    if (!checked || 'error' in checked || checked.roster.sharedTabId !== id) throw rosterInvalid()
    // A roster of this account's own tab, whatever the backend's owner flag says: a backend that called one of the
    // owner's computers a member would otherwise have it trust a key of the backend's choosing on a fingerprint.
    if (checked.roster.owner.accountId === (await this.self()).accountId) throw isOwner()
    return { share, signed: signed!, roster: checked.roster }
  }

  /**
   * First trust, or trust again: what this computer held for the tab (a pin, a roster of a share since stopped and
   * started again at version 1, a roster under a key the person no longer trusts) gives way to the key the person was
   * shown and the roster it signed. A session with a machine under a key that roster does not list ends (`adopt`).
   * False when the roster does not verify against the key, and then nothing is pinned: a pin that never verified a
   * roster would refuse the real one from then on.
   */
  private async trust(id: string, signed: SignedRoster, pub: string): Promise<boolean> {
    this.deps.store.forget(id)
    this.deps.store.pin(id, pub)
    const offered = this.deps.store.offer(signed)
    if (!('roster' in offered)) { this.deps.store.forget(id); return false }
    await this.adopt(offered.roster)
    await this.openRelay(id)
    // The account's other computers take the pin from here now (`pull`), rather than once their wait is over. Not
    // waited for: one asleep would hold the accept for the 8 s its ask takes to fail.
    void this.tellOthers(id).catch(ignore)
    return true
  }

  /**
   * Asks the owner's computer to add a harness of this account: queued until the owner's roster lists it, which may be
   * once that computer is back. The owner takes an add only from the harness's own machine (`judge`), so a harness on
   * another machine of this account is handed to that machine, which asks for it itself; this one never sends a request
   * naming another machine. That machine's answer is waited for outside the queue: up to 8 s of it would hold up every
   * frame and change here. Its refusal is told as it said it (`NOT_SHARED` there is not a machine away). An add handed
   * on (`forwarded`) for a harness that is not this machine's is refused, never handed on again: two machines that
   * each took the harness for the other's would otherwise pass it back and forth.
   */
  async addHarness(sharedTabId: string, harness: Pane, forwarded = false): Promise<Record<string, unknown>> {
    const held = this.held(sharedTabId)
    if (await this.owns(held.roster)) throw new MessageError('OWNER_PANE', 'Put the pane in the tab on your desk: your own harnesses come from there.')
    const ref = harnessRef(harness)
    if (!ref) throw invalid()
    if (ref.machineId !== (await this.self()).machineId) {
      if (forwarded) throw new MessageError('NOT_THIS_MACHINE', 'That harness is not on this machine: add it from the machine it runs on.')
      const answer = await this.deps.askMachine(ref.machineId, { action: 'share_add', sharedTabId, harness, forwarded: true })
      if (!answer) throw new MessageError('MACHINE_AWAY', 'That machine could not be asked to add it. Try again once it is on.')
      const refused = record(answer.error)
      if (refused) throw new MessageError(String(refused.code), String(refused.message))
      return answer
    }
    return this.serial(async () => {
      const pub = await this.deps.machineKey(ref.machineId)
      if (!pub) throw new MessageError('MACHINE_AWAY', 'That machine could not be asked for its key. Try again once it is on.')
      const full = wireHarness({ ...harness, accountId: (await this.self()).accountId, machinePublicKey: pub })
      if (!full) throw invalid()
      const listed = this.held(sharedTabId).roster.harnesses.some((h) => same(h, full))
      // Asked here, on the harness's own machine: the only word that lets the tab's other accounts watch it.
      this.deps.consent?.grant(sharedTabId, full.machineId, full.agentId, listed)
      if (!listed) {
        this.enqueue(sharedTabId, 'add', full)
        await this.flush(sharedTabId)
      }
      return { queued: true as const }
    })
  }

  /** What another computer of this account takes a tab from (service.ts `tab_pin`): the owner key pinned here and the
   *  roster held, which verified against it. */
  pinOf(sharedTabId: string): { ownerPub: string; signed: SignedRoster } {
    const { signed } = this.held(sharedTabId)
    return { ownerPub: this.deps.store.pinned(sharedTabId)!, signed }
  }

  /** Another computer of this account pinned a tab (service.ts `tab_pin_changed`): it is asked at once, whatever wait an
   *  earlier failed ask left. */
  pinChanged(sharedTabId: string): Promise<void> {
    this.pulled.delete(sharedTabId)
    return this.refresh()
  }

  private async tellOthers(id: string): Promise<void> {
    const me = await this.self()
    for (const machineId of await this.deps.ownMachines() ?? []) {
      if (machineId !== me.machineId) void this.deps.askMachine(machineId, { action: 'tab_pin_changed', sharedTabId: id })
    }
  }

  /**
   * A tab this account is a member of, which this computer holds no pin for: the person accepted on another of its
   * computers. Its pin and roster are taken from the first of the account's other computers whose answer verifies, as
   * this computer checks any roster: the key it names must sign the roster it gives. Trusting a pin because another
   * computer of the same account vouches for it is the trust `tab_pub` and the owner's own `retake` already give the
   * account's machines: the paired relay carries only this account's machines, and a computer that lied could as well
   * have accepted the invitation itself. Asked together and beside the queue: one asleep costs one 8 s wait, and holds
   * up no frame. A computer that could not take it asks again after PULL_RETRY_MS, or when told the pin changed.
   */
  private pull(id: string): void {
    const last = this.pulled.get(id)
    if (last !== undefined && this.now() - last < PULL_RETRY_MS) return
    this.pulled.set(id, this.now())
    void this.pullFrom(id).catch(ignore)
  }

  private async pullFrom(id: string): Promise<void> {
    const me = await this.self()
    const others = (await this.deps.ownMachines() ?? []).filter((m) => m !== me.machineId)
    const taken = await Promise.all(others.map(async (machineId) => {
      const answer = await this.deps.askMachine(machineId, { action: 'tab_pin', sharedTabId: id })
      return !!answer && this.serial(() => this.takePin(id, answer))
    }))
    if (taken.includes(true)) this.pulled.delete(id)
    else this.pulled.set(id, this.now())
  }

  /** One computer's answer: kept only when its roster is this tab's and verifies against the key it names. One that
   *  does not leaves no pin behind: a pin that never verified a roster would refuse the real one from then on. */
  private async takePin(id: string, answer: Wire): Promise<boolean> {
    if (this.deps.store.pinned(id)) return true
    const signed = signedOf(answer.signed)
    if (typeof answer.ownerPub !== 'string' || !signed || parseRoster(signed.body)?.sharedTabId !== id) return false
    // No pin is held here (above), so this one is taken: the roster must then verify against it.
    this.deps.store.pin(id, answer.ownerPub)
    const offered = this.deps.store.offer(signed)
    if (!('roster' in offered)) { this.deps.store.forget(id); return false }
    await this.adopt(offered.roster)
    await this.openRelay(id)
    return true
  }

  leave(sharedTabId: string): Promise<void> {
    return this.serial(async () => {
      const held = this.deps.store.current(sharedTabId)
      if (held && await this.owns(held.roster)) throw new MessageError('IS_OWNER', 'You share this tab: stop sharing it instead.')
      await this.call('DELETE', memberPath(sharedTabId, (await this.self()).accountId))
      this.drop(sharedTabId)
    })
  }

  private enqueue(sharedTabId: string, op: Request['op'], harness: RosterHarness): void {
    const id = requestId(op, harness)
    // The opposite request for the same harness is now stale: only the latest word is worth sending.
    this.queue.delete(`${sharedTabId}:${requestId(op === 'add' ? 'remove' : 'add', harness)}`)
    if (!this.queue.has(`${sharedTabId}:${id}`)) this.queue.set(`${sharedTabId}:${id}`, { sharedTabId, id, op, harness, since: this.now() })
    this.persist()
    this.timed()
  }

  private waiting(id: string): Request[] { return [...this.queue.values()].filter((r) => r.sharedTabId === id) }

  /** Send what waits for the tab's owner, over a session with its computer, or start one: once it opens, `opened` sends. */
  private async flush(id: string): Promise<void> {
    const held = this.deps.store.current(id), waiting = this.waiting(id)
    if (!held || !waiting.length) return
    const owner = held.roster.owner
    if (!await this.ensure(held.roster, owner.machineId, owner.accountId)) return
    for (const r of waiting) await this.sealTo(held.roster, owner.machineId, { kind: 'roster_request', id: r.id, op: r.op, harness: r.harness })
  }

  /** The 30 s retry runs only while something waits. */
  private timed(): void {
    if (this.queue.size && !this.timer && !this.closed) {
      this.timer = setInterval(() => { void this.refresh().catch(ignore) }, RETRY_MS)
      this.timer.unref()
    }
    if (!this.queue.size && this.timer) { clearInterval(this.timer); this.timer = null }
  }

  // ── both ──────────────────────────────────────────────────────────────────────────────────────────

  rosters(): Roster[] { return this.deps.store.all() }

  /** What waits for the owner's computer, for the person to see as `Joining…`. */
  pending(): Array<{ sharedTabId: string; op: Request['op']; machineId: string; agentId: string; name: string; since: string }> {
    return [...this.queue.values()].map((r) => ({ sharedTabId: r.sharedTabId, op: r.op, machineId: r.harness.machineId,
      agentId: r.harness.agentId, name: r.harness.name, since: new Date(r.since).toISOString() }))
  }

  /** What happened that the person has not dismissed: it stays until `dismissNotice`, so a window that was closed or a
   *  restart in between loses nothing. */
  notices(): SharedNotice[] { return this.noticed.unread() }
  /** The person dismissed one: false when it is already gone. */
  dismissNotice(id: string): boolean {
    const gone = this.noticed.dismiss(id)
    if (gone) this.deps.announce?.()
    return gone
  }
  private notice(n: Omit<SharedNotice, 'id' | 'at'>): void {
    if (this.noticed.add(n)) this.deps.announce?.()
  }

  /** Asleep: no socket stays open and no timer runs (service.ts makes a new one on waking). */
  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.takeovers.keys()]) this.untake(id)
    for (const roster of this.deps.store.all()) this.deps.relay.close(roster.sharedTabId)
    for (const [k, link] of this.links) this.forget(k, link)
    this.giveUp(null)
  }

  /** This computer is out of the tab: what it held for it goes. With `keepPin` (a 4403 for a tab another account owns,
   *  `heard`), the owner key pinned stays (rosterStore.ts `release`); leaving and stopping forget it too. The consent
   *  goes either way: a harness is in a tab again only once this machine asks again. */
  private drop(id: string, keepPin = false): void {
    this.deps.consent?.forgetTab(id)
    if (keepPin) this.deps.store.release(id)
    else this.deps.store.forget(id)
    this.deps.relay.close(id)
    this.untake(id)
    this.owned.delete(id)
    this.desks.delete(id)
    this.checked.delete(id)
    for (const [k, link] of this.links) if (link.sharedTabId === id) this.forget(k, link)
    for (const [k, r] of this.queue) if (r.sharedTabId === id) this.queue.delete(k)
    this.giveUp(id)
    this.persist()
    this.timed()
    this.deps.changed?.()
  }

  /** A sealed frame the relay would not take (too big for a frame, or not sent within its wait): the person is told,
   *  once per machine while unread, rather than the frame vanish. A request waiting for it is sent again on its retry. */
  private unsent(id: string, machineId: string): void {
    if (!this.noticed.unread().some((n) => n.sharedTabId === id && n.kind === 'unsent' && n.machineId === machineId)) this.notice({ sharedTabId: id, kind: 'unsent', machineId })
  }

  /**
   * Another socket of this machine took the tab's relay over (4409), and the gateway dialled no more: opened again after
   * RELAY_TAKEOVER_MS, while the tab is still held and Agent Messages awake, unless this is one takeover too many within
   * RELAY_TAKEOVER_WINDOW_MS, which stops it and tells the person once.
   */
  private takenOver(id: string, ownerEmail: string): void {
    const now = this.now(), taken = this.takeovers.get(id) ?? { at: [], timer: null, stopped: false }
    this.takeovers.set(id, taken)
    if (taken.stopped) return
    taken.at = [...taken.at.filter((at) => now - at < RELAY_TAKEOVER_WINDOW_MS), now]
    if (taken.timer) clearTimeout(taken.timer)
    taken.timer = null
    if (taken.at.length > RELAY_TAKEOVERS) {
      taken.stopped = true
      this.notice({ sharedTabId: id, kind: 'relay_taken', ownerEmail })
      return
    }
    taken.timer = setTimeout(() => {
      taken.timer = null
      void this.serial(async () => { if (this.deps.store.current(id)) await this.openRelay(id) })
    }, RELAY_TAKEOVER_MS)
    taken.timer.unref()
  }

  /** What a tab's takeovers left (its wait, its stop) goes with the tab, or as Agent Messages goes to sleep. */
  private untake(id: string): void {
    const timer = this.takeovers.get(id)?.timer
    if (timer) clearTimeout(timer)
    this.takeovers.delete(id)
  }

  private forget(k: string, link: Link): void {
    this.deps.key.drop(linkOf(link))
    this.links.delete(k)
  }

  /** A newer roster is held: a session with a machine that left it, or whose key it changed, never carries on; a
   *  request it now shows settled waits no more; and a member checks what it lists under its own account. */
  private async adopt(roster: Roster): Promise<void> {
    const authority = await this.owns(roster)
    for (const [k, link] of this.links) {
      if (link.sharedTabId === roster.sharedTabId && peerKey(roster, link.machineId, link.userId, link.peerPub, authority) !== link.peerPub) this.forget(k, link)
    }
    let settled = false
    for (const [k, r] of this.queue) {
      if (r.sharedTabId === roster.sharedTabId && roster.harnesses.some((h) => same(h, r.harness)) === (r.op === 'add')) { this.queue.delete(k); settled = true }
    }
    if (settled) this.persist()
    this.timed()
    // Its harnesses are teammates now, in the directory (service.ts), and one that left is one no longer.
    this.deps.changed?.()
    // Off the queue: it only records alerts, and a machine of this account that is asleep would otherwise hold every
    // frame of every tab for the 8 s its key ask takes to fail, on each new version (review of A1, 2026-10-15).
    if (!authority) void this.checkOwn(roster).catch(ignore)
  }

  /**
   * The owner's word, and the backend's, decide what a roster lists under this account; only this account knows its own
   * machines. An entry on a machine its directory does not list (`foreign_machine`), or under another key than that
   * machine reports (`machine_key_mismatch`), is recorded for the person to see, never removed: detect, not block (a
   * member that rewrote what it was given would let a lying backend steer it). A machine that cannot be asked is
   * skipped. Each machine once per version, asked together: an unreachable one costs one wait, not one each. Run
   * beside the queue (`adopt`), never in it.
   */
  private async checkOwn(roster: Roster): Promise<void> {
    const me = await this.self(), id = roster.sharedTabId, last = this.checked.get(id)
    const seen = last?.version === roster.version ? last.machines : new Set<string>()
    this.checked.set(id, { version: roster.version, machines: seen })
    const machines = [...new Set(roster.harnesses.filter((h) => h.accountId === me.accountId && !seen.has(h.machineId)).map((h) => h.machineId))]
    // Entries under another account, by machine, kept apart from this account's in `seen` (a machine can be in both).
    const listed = [...new Set(roster.harnesses.filter((h) => h.accountId !== me.accountId && !seen.has(`listed:${h.machineId}`)).map((h) => h.machineId))]
    if (!machines.length && !listed.length) return
    for (const machineId of machines) seen.add(machineId)
    for (const machineId of listed) seen.add(`listed:${machineId}`)
    const own = await this.deps.ownMachines()
    // One of this account's machines under another account: the directory never takes it as theirs (sharedDirectory.ts),
    // which would hide every pane of it from this account's own tabs, and the person is told (review of B1). With the
    // directory unreadable only this machine is known to be its own; the others are looked at again at the next check.
    for (const machineId of listed) {
      if (machineId === me.machineId || own?.includes(machineId)) this.deps.store.alert(id, 'own_machine_listed')
      else if (!own) seen.delete(`listed:${machineId}`)
    }
    await Promise.all(machines.map(async (machineId) => {
      // This machine is always its own, whatever a directory read says.
      if (own && machineId !== me.machineId && !own.includes(machineId)) return this.deps.store.alert(id, 'foreign_machine')
      const pub = await this.deps.machineKey(machineId)
      if (pub && roster.harnesses.some((h) => h.accountId === me.accountId && h.machineId === machineId && h.machinePublicKey !== pub)) this.deps.store.alert(id, 'machine_key_mismatch')
    }))
  }

  /**
   * A session with a machine of the tab: true when one is open. Otherwise the lower machine id says hello, and the
   * higher knocks for the lower to: two hellos crossing would each end the other's (`TabSessions.accept` drops this
   * side's pending hello). The owner's computer knocks, too, at a member's machine whose key it has not been told.
   */
  private async ensure(roster: Roster, machineId: string, userId: string, claimed?: unknown): Promise<boolean> {
    const id = roster.sharedTabId
    if (!await this.openRelay(id)) return false
    const k = `${id}:${machineId}`, link = this.links.get(k)
    const authority = await this.owns(roster)
    const pub = peerKey(roster, machineId, userId, claimed ?? link?.peerPub, authority)
    if (!pub && !(authority && roster.members.some((m) => m.accountId === userId))) return false
    if (link?.state === 'open' && link.peerPub === pub) return true
    if (link && link.state !== 'open' && link.peerPub === (pub ?? '') && this.now() - link.at < HELLO_RETRY_MS) return false
    if (link) this.forget(k, link)
    const me = await this.self(), at = this.now()
    let frame: Wire
    if (pub && me.machineId < machineId) {
      const hello = await this.deps.key.hello({ sharedTabId: id, machineId, peerPub: pub })
      this.links.set(k, { sharedTabId: id, machineId, peerPub: pub, userId, state: 'hello', at, hello: String(hello.ephemeral) })
      frame = { kind: 'hello', hello, pub: await this.myPub() }
    } else {
      this.links.set(k, { sharedTabId: id, machineId, peerPub: pub ?? '', userId, state: 'knock', at })
      frame = { kind: 'knock', pub: await this.myPub() }
    }
    if (!await this.deps.relay.send(id, machineId, frame)) this.links.delete(k)
    return false
  }

  /** Send a frame sealed for the session with a machine: true once the relay took it. A session the gateway no longer
   *  has is started again, and that frame is not sent. */
  private async sealTo(roster: Roster, machineId: string, frame: Wire): Promise<boolean> {
    const id = roster.sharedTabId, link = this.links.get(`${id}:${machineId}`)
    if (link?.state !== 'open') return false
    const sealed = await this.deps.key.seal(linkOf(link), frame)
    if ('frame' in sealed) {
      if (await this.deps.relay.send(id, machineId, sealed.frame)) return true
      this.unsent(id, machineId)
      return false
    }
    link.state = 'idle'
    link.at = -Infinity
    await this.ensure(roster, machineId, link.userId)
    return false
  }

  /** A session just opened: the owner sends its roster, a member what waits for the owner, and Agent Messages what
   *  waits for that machine (`opened`, which only starts it: it never holds up the frames). */
  private async opened(id: string, machineId: string, held: { roster: Roster; signed: SignedRoster }): Promise<void> {
    this.deps.opened?.(id, machineId)
    if (await this.owns(held.roster)) await this.sealTo(held.roster, machineId, { kind: 'roster', signed: held.signed })
    if (held.roster.owner.machineId !== machineId) return
    for (const r of this.waiting(id)) await this.sealTo(held.roster, machineId, { kind: 'roster_request', id: r.id, op: r.op, harness: r.harness })
  }

  // ── Agent Messages' requests ──────────────────────────────────────────────────────────────────────

  /**
   * An Agent Messages request to another account's machine through the tab (`agent_messages`): its result, or its
   * refusal as `{ error, detail }`, as that machine's service said it. Rejected PEER_AWAY when no session with the
   * machine is open (one is started: the lower machine id says hello) or the relay cannot reach it, RELAY_TAKEN while
   * another socket of this machine holds the tab's relay (4409), TOO_LARGE for a request no frame holds, and
   * UNCONFIRMED when no result came within `timeoutMs`: the request may have been answered, and asked again is answered
   * the same (service.ts takes a message once). Sent in the queue, waited on outside it: the result comes in through
   * `onFrame`, which runs in the queue, and awaited inside it would never arrive.
   */
  request(sharedTabId: string, machineId: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Wire> {
    // Measured before anything is sent: the gateway would refuse it every time, and the person is told now.
    if (!fitsRequest(payload)) return Promise.reject(new MessageError('TOO_LARGE', 'That is too large to send through a shared tab: shorten the message or send to fewer teammates.'))
    const rid = randomBytes(REQUEST_ID_LENGTH / 2).toString('hex')
    const reply = new Promise<Wire>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(rid, new MessageError('UNCONFIRMED', 'That computer did not answer in time.')), timeoutMs)
      timer.unref()
      this.asking.set(rid, { sharedTabId, machineId, timer, resolve, reject })
    })
    void this.serial(async () => {
      if (this.closed) throw peerAway()
      const held = this.held(sharedTabId)
      const taken = this.takeovers.get(sharedTabId)
      // A relay another socket of this machine took (A5) is not opened again for a while, or at all after the fourth time:
      // said so, for the message to wait with a reason rather than be lost in a socket that is not there.
      if (taken?.timer || taken?.stopped) throw new MessageError('RELAY_TAKEN', 'Another Harness on this computer holds the shared tab\'s connection.')
      // Only a machine with a harness in the tab: a message goes to harnesses, and a session only to a machine listed.
      const userId = held.roster.harnesses.find((h) => h.machineId === machineId)?.accountId
      if (!userId) throw new MessageError('NOT_IN_TAB', 'That computer is not in the shared tab.')
      const frame = { ...payload, kind: 'agent_messages', rid }
      if (!await this.ensure(held.roster, machineId, userId) || !await this.sealTo(held.roster, machineId, frame)) throw peerAway()
    }).catch((error: Error) => this.settle(rid, error))
    return reply
  }

  /** A request ends: answered, refused, or given up on. Its result, or its end, counts once. */
  private settle(rid: string, outcome: Wire | Error): void {
    const waiting = this.asking.get(rid)
    if (!waiting) return
    this.asking.delete(rid)
    clearTimeout(waiting.timer)
    if (outcome instanceof Error) waiting.reject(outcome)
    else waiting.resolve(outcome)
  }

  /** What waits on a tab, or on one machine of it, can no longer be answered: given up on at once, not at its timeout. */
  private giveUp(sharedTabId: string | null, machineId?: string): void {
    for (const [rid, p] of [...this.asking]) {
      if ((sharedTabId === null || p.sharedTabId === sharedTabId) && (machineId === undefined || p.machineId === machineId)) this.settle(rid, peerAway())
    }
  }

  /** Another machine's request, answered beside the queue (the service may read the tabs first) and sealed back. A
   *  request with no id that can be its answer's is not answered at all. */
  private answerFrame(id: string, from: TabContext['from'], frame: Wire): void {
    const { kind: _kind, rid, ...payload } = frame
    if (typeof rid !== 'string' || rid.length > 64) return
    const answer = this.deps.answer ?? (async () => { throw new MessageError('UNKNOWN_ACTION', 'Unknown Agent Messages request.') })
    void Promise.resolve().then(() => answer({ sharedTabId: id, from }, payload))
      .catch((error: unknown) => (error instanceof MessageError ? { error: error.code, detail: error.message }
        : { error: 'MESSAGES_UNAVAILABLE', detail: 'Agent Messages are unavailable on that computer right now.' }))
      .then((reply) => this.serial(async () => {
        const held = this.deps.store.current(id)
        // The tab gone, or the tabs asleep, while the answer was made: there is no session to seal it for.
        if (held && !this.closed) await this.sealTo(held.roster, from.machineId, { ...reply, kind: 'agent_messages_result', rid })
      }))
  }

  // ── frames ────────────────────────────────────────────────────────────────────────────────────────

  onFrame(event: TabFrame): Promise<void> {
    return this.serial(async () => { if (!this.closed) await this.heard(event) })
  }

  private async heard(e: TabFrame): Promise<void> {
    const id = e.sharedTabId, held = this.deps.store.current(id)
    if (!held) return
    // 4403: the relay no longer admits this machine to the tab (removed, left elsewhere, or sharing stopped). Only the
    // relay's word: in a tab another account owns, the pin stays (`drop`), and a backend that closed the tab when it was
    // not stopped cannot have the person trust a new key on first use. This account's own tabs trust its machines' keys
    // (`retake`), not a pin, and forget it as before; so does a computer that cannot read its account just now (a
    // restart before the core answers), rather than leave a tab it was removed from running.
    if (e.closed) {
      if (e.closed.code === 4403) {
        this.notice({ sharedTabId: id, kind: 'removed', ownerEmail: ownerEmailOf(held.roster) })
        const me = await this.self().catch(() => null)
        this.drop(id, !!me && held.roster.owner.accountId !== me.accountId)
      }
      else if (e.closed.code === 4409) this.takenOver(id, ownerEmailOf(held.roster))
      return
    }
    if (e.ready) return this.flush(id)
    if (e.undeliverable) {
      // Never reached: the next try may say hello again at once, without waiting for an answer that cannot come; and a
      // request to that machine will get none.
      const link = this.links.get(`${id}:${e.undeliverable}`)
      if (link && link.state !== 'open') this.links.delete(`${id}:${e.undeliverable}`)
      this.giveUp(id, e.undeliverable)
      return
    }
    const from = e.from, payload = record(e.payload)
    if (!from || !payload) return
    const k = `${id}:${from.machineId}`, link = this.links.get(k)
    if (payload.__e2e !== undefined) {
      const opened = link?.state === 'open' && link.userId === from.userId ? await this.deps.key.open(linkOf(link), payload) : { lost: true as const }
      if ('frame' in opened) return this.dispatch(id, from, link!, opened.frame)
      if ('unreadable' in opened) return
      // Sealed with a session this side does not have (its gateway restarted, or it never had one): start another.
      if (link?.state === 'open') { link.state = 'idle'; link.at = -Infinity }
      await this.ensure(held.roster, from.machineId, from.userId)
      return
    }
    const authority = await this.owns(held.roster)
    if (payload.kind === 'hello') {
      // Refused before anything is opened: a machine the roster does not list, under the account the relay stamped.
      const pub = peerKey(held.roster, from.machineId, from.userId, payload.pub, authority), hello = record(payload.hello)
      if (!pub || !hello) return
      const tl = { sharedTabId: id, machineId: from.machineId, peerPub: pub }
      const answer = await this.deps.key.accept(tl, hello)
      if (!('welcome' in answer)) return
      this.links.set(k, { ...tl, userId: from.userId, state: 'open', at: this.now() })
      await this.deps.relay.send(id, from.machineId, { kind: 'welcome', welcome: answer.welcome, to: hello.ephemeral })
      await this.opened(id, from.machineId, held)
    } else if (payload.kind === 'welcome') {
      const welcome = record(payload.welcome)
      if (link?.state !== 'hello' || link.userId !== from.userId || !welcome || payload.to !== link.hello) return
      if (await this.deps.key.welcome(linkOf(link), welcome)) {
        link.state = 'open'
        await this.opened(id, from.machineId, held)
        return
      }
      // The hello is spent (its finish is one-shot): another, once the last is old enough.
      link.state = 'idle'
      await this.ensure(held.roster, from.machineId, from.userId)
    } else if (payload.kind === 'knock') {
      // The sender has no session with this machine: whatever this side has is stale.
      if (link?.state === 'open') this.forget(k, link)
      await this.ensure(held.roster, from.machineId, from.userId, payload.pub)
    }
  }

  private async dispatch(id: string, from: { machineId: string; userId: string }, link: Link, frame: Wire): Promise<void> {
    const held = this.held(id)
    if (frame.kind === 'roster') {
      // Only the owner's account signs a roster and sends it; a member never does. Taken from any session, a member's
      // machine sending a parseable roster with a bad signature 20 times a second had every one recorded as an alert,
      // the file written and Share woken each time (final review of 1b).
      if (from.userId !== held.roster.owner.accountId) return
      const signed = signedOf(frame.signed)
      if (!signed || parseRoster(signed.body)?.sharedTabId !== id) return
      const offered = this.deps.store.offer(signed)
      if ('roster' in offered) await this.adopt(offered.roster)
    } else if (frame.kind === 'roster_request') {
      await this.apply(id, from, link, frame)
    } else if (frame.kind === 'roster_refused') {
      const r = typeof frame.id === 'string' ? this.queue.get(`${id}:${frame.id}`) : undefined
      if (!r || from.machineId !== held.roster.owner.machineId) return
      this.queue.delete(`${id}:${r.id}`)
      this.persist()
      this.notice({ sharedTabId: id, kind: 'refused', error: String(frame.error).slice(0, 64), machineId: r.harness.machineId, agentId: r.harness.agentId })
      this.timed()
    } else if (frame.kind === 'agent_messages') {
      this.answerFrame(id, from, frame)
    } else if (frame.kind === 'agent_messages_result') {
      const waiting = typeof frame.rid === 'string' ? this.asking.get(frame.rid) : undefined
      // Only the machine it was asked of, through the tab it went through, answers a request.
      if (!waiting || waiting.sharedTabId !== id || waiting.machineId !== from.machineId) return
      const { kind: _kind, rid, ...reply } = frame
      this.settle(String(rid), reply)
    }
  }
}
