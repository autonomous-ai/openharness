import type { Identity } from '../lib/e2ee/core.js'
import { b64e } from '../lib/e2ee/core.js'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import type { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import { encodeTerminalLocal } from '../lib/terminalBinary.js'
import { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import { HarnessGrantStore, inviteSchema, type HarnessGrant, type DerivedGrant } from './grants.js'
import { ownerHandshake, signedOwnerHandshake, type ObserverCipher, type OwnerKey } from './crypto.js'
import { HarnessCollaborationStore, linkVisibility, type CommentAuthor } from './collaboration.js'
import { rosterGrants } from './rosterGrants.js'
import type { Roster } from '../messages/roster.js'

type Payload = Record<string, unknown>
const DAY = 86400_000, HOUR = 3600_000
/** What a derivation or a publish that nobody waits on may fail with: it is tried again at the next nudge or tick. */
const ignore = (): void => {}
/** A derived grant's rolling expiry, and how close to it the next derivation publishes it again. */
export const DERIVED_DAYS = 30, RENEW_DAYS = 7
interface Observer { grant: HarnessGrant; cipher: ObserverCipher; linkId?: string; author: CommentAuthor | null }
/** What reads an observer's terminal: the owner's own read-only stream manager, or the core's (`streams`). */
export type ObserverStreams = Pick<TerminalStreamManager, 'handleFrame' | 'closeConnection' | 'stop'>

export interface ShareOwnerDeps {
  machineId: () => string
  /** This machine's E2EE identity, which the owner signs its welcome with, or the key where it is held
   *  (`key`): a Share in a process of its own holds no credential. One of the two. */
  identity?: Identity
  key?: OwnerKey
  grants: HarnessGrantStore
  collaboration?: HarnessCollaborationStore
  webOrigin?: string
  autonomousEnv?: string
  /** The terminals the owner's own read-only stream manager reads; or the core reads them (`streams`). */
  terminals?: TerminalBackendCoordinator
  streams?: (targets: { sendTarget(id: string, type: string, payload: Payload): boolean }) => ObserverStreams
  resolveAgent: (id: string) => RegisteredSession | undefined
  send: (connId: string, type: string, payload: Payload) => boolean
  publish: (method: 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  watchViewer?: (agentId: string, send: (payload: Payload) => void) => (() => void)
  /** The shared tabs' rosters this computer verified against their pins, and the account signed in here, which the
   *  observers each tab wants are derived from (`harness_share_rosters`); null when either cannot be read. */
  rosters?: () => Promise<{ accountId: string; rosters: Roster[]; consent: ReadonlySet<string> } | null>
  /** The Swarm observers this machine's host wants, or null while no roster of its is in force (superTabs/observers.ts
   *  `known`): their invitations are then kept as they are, neither withdrawn nor sent again. */
  derivedGrants?: () => Array<Omit<DerivedGrant, 'ownerPublicKey'>> | null
  allowsGrant?: (grant: HarnessGrant) => boolean
  /** Whether a grant `allowsGrant` refuses is only waiting for the Swarm's next roster (superTabs/observers.ts `paused`):
   *  its viewer is then told to retry. Without it every refusal is final. */
  pausedGrant?: (grant: HarnessGrant) => boolean
  now?: () => number
}

/** This is the complete observer dispatch surface. It never calls the ordinary daemon RPC switch. */
export class HarnessShareOwner {
  private readonly observers = new Map<string, Observer>()
  private readonly viewers = new Map<string, () => void>()
  private readonly streams: ObserverStreams
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private syncing: Promise<void> | null = null
  private mutation: Promise<unknown> = Promise.resolve()
  /** Derivations run one after another, apart from the owner's own controls: each reads the rosters afresh, so a later
   *  one never applies what an earlier read saw over what a later read saw. */
  private deriving: Promise<unknown> = Promise.resolve()
  private derivesQueued = 0
  constructor(private readonly deps: ShareOwnerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.streams = deps.streams?.({ sendTarget: (id, type, payload) => this.send(id, { type, payload }) }) ?? new TerminalStreamManager({ readOnly: true, terminals: deps.terminals!,
      resolveAgent: deps.resolveAgent, streamingAvailable: true,
      sendTarget: (id, type, payload) => this.send(id, { type, payload }),
      sendBinaryTarget: (id, frame) => {
        const bytes = encodeTerminalLocal(frame)
        return bytes !== null && this.send(id, { type: 'observer_binary',
          payload: { bytes: Buffer.from(bytes).toString('base64') } })
      },
    })
    let derivedSignature = ''
    let ticks = 0
    this.timer = setInterval(() => {
      for (const [id, observer] of this.observers) {
        if (!this.authorized(observer)) this.close(id, 'Sharing ended or invitation expired', this.paused(observer.grant))
      }
      // Derived again every 30 s: the renewals fall due, and a roster change whose nudge never came is caught here. A
      // refused grant is tried again at most hourly from here: up to 256 of them every 30 s would hammer the backend.
      // One already waiting to run makes another pointless; it publishes what waits as it ends.
      // A roster no longer in force is no change of membership: deriving from it withdrew every Swarm invitation and
      // sent it again a moment later (superTabs/observers.ts `OBSERVER_VALID_MS`).
      const derived = this.deps.derivedGrants?.()
      const signature = derived === null ? derivedSignature : JSON.stringify(derived ?? [])
      const changed = signature !== derivedSignature
      derivedSignature = signature
      if ((++ticks % 30 === 0 || changed) && this.derivesQueued === 0) void this.derive(this.now() - HOUR).catch(ignore)
    }, 1000)
    this.timer.unref()
    // Once as it starts: a member removed while Share was off loses the view now, and a refused grant is tried again.
    void this.derive(this.now()).catch(ignore)
  }
  private authorized(observer: Observer): boolean {
    if (observer.linkId) {
      const link = this.deps.collaboration?.active(observer.linkId, this.deps.machineId())
      // A session that turns confidential closes its links' viewers too, as it refuses them at open (`receive`).
      return !!link && !!this.deps.resolveAgent(link.agentId) && (link.visibility === 'public'
        || observer.author?.owner === true || this.invited(link.agentId, observer.grant.recipientEmail))
        && (this.deps.allowsGrant?.(observer.grant) ?? true)
    }
    return !!this.deps.grants.active(observer.grant.id, observer.grant.recipientEmail, this.deps.machineId())
      && (this.deps.allowsGrant?.(observer.grant) ?? true)
      && !!this.deps.resolveAgent(observer.grant.agentId)
  }
  /** A view refused only until the Swarm host's next roster: after a restart a viewer reconnects within a second or two,
   *  before that roster, and a final refusal there left their pane closed for good (Ken, 2026-10-28). */
  private paused(grant: HarnessGrant): boolean {
    return !!this.deps.grants.active(grant.id, grant.recipientEmail, this.deps.machineId()) && (this.deps.pausedGrant?.(grant) ?? false)
  }
  private invited(agentId: string, email: string): boolean {
    return this.deps.grants.list(this.deps.machineId(), agentId)
      .some(g => !!this.deps.grants.active(g.id, email, this.deps.machineId()))
  }
  private recheck(): void {
    for (const [id, observer] of this.observers) if (!this.authorized(observer)) this.close(id, 'Access removed')
  }
  private send(connId: string, frame: Payload): boolean {
    const observer = this.observers.get(connId)
    if (!observer || !this.authorized(observer)) return false
    return this.deps.send(connId, 'observer_frame', observer.cipher.seal(frame) as unknown as Payload)
  }
  close(connId: string, reason = 'Observation ended', retry = false): void {
    if (!this.observers.delete(connId)) return
    this.viewers.get(connId)?.()
    this.viewers.delete(connId)
    void this.streams.closeConnection(connId)
    this.deps.send(connId, 'observer_closed', { reason, retry })
  }
  closeAll(): void { for (const id of this.observers.keys()) this.close(id, 'Owner disconnected', true) }
  async stop(): Promise<void> { clearInterval(this.timer); this.closeAll(); await this.streams.stop() }

  async receive(connId: string, type: string, payload: Payload): Promise<void> {
    if (!connId.startsWith('observer:')) return
    if (type === 'observer_close') { this.close(connId); return }
    if (type === 'observer_open') {
      if (this.observers.has(connId)) { this.close(connId, 'Invalid observer handshake'); return }
      const link = typeof payload.linkId === 'string'
        ? this.deps.collaboration?.active(payload.linkId, this.deps.machineId()) : undefined
      const email = typeof payload.email === 'string' ? payload.email : ''
      // Identity comes from the authenticated observer relay, never from an encrypted client frame.
      const author = typeof payload.authorId === 'string' && payload.authorId.length > 0 ? {
        id: payload.owner === true ? `owner:${this.deps.machineId()}` : payload.authorId,
        name: payload.owner === true ? 'Owner' : String(payload.authorName || 'Harness user').slice(0, 80),
        owner: payload.owner === true,
      } : null
      const grant: HarnessGrant | null = link && (link.visibility === 'public' || author?.owner || this.invited(link.agentId, email))
        ? { ...link, recipientEmail: email, createdAt: '', expiresAt: '', revoked: false, publicationError: null, tab: null, failedAt: null }
        : payload.linkId ? null : this.deps.grants.active(String(payload.shareId), email, this.deps.machineId())
      if (!grant || !(this.deps.allowsGrant?.(grant) ?? true) || !this.deps.resolveAgent(grant.agentId) || this.observers.size >= 100) {
        this.deps.send(connId, 'observer_closed', { reason: 'Sharing ended or invitation expired',
          retry: !!grant && !!this.deps.resolveAgent(grant.agentId) && this.paused(grant) }); return
      }
      try {
        const { cipher, welcome } = this.deps.key
          ? await signedOwnerHandshake(this.deps.key, grant.machineId, grant.id, String(payload.ephemeral))
          : ownerHandshake(this.deps.identity!, grant.machineId, grant.id, String(payload.ephemeral))
        this.observers.set(connId, { grant, cipher, author, ...(link ? { linkId: link.id } : {}) })
        if (!this.deps.send(connId, 'observer_welcome', welcome)) this.close(connId)
      } catch { this.deps.send(connId, 'observer_closed', { reason: 'Invalid observer handshake' }) }
      return
    }
    const observer = this.observers.get(connId)
    if (!observer) return
    if (!this.authorized(observer)) { this.close(connId, 'Sharing ended or invitation expired', this.paused(observer.grant)); return }
    const frame = type === 'observer_frame' ? observer.cipher.open(payload) : null
    if (!frame || typeof frame.type !== 'string' || !frame.payload || typeof frame.payload !== 'object') {
      this.close(connId, 'Invalid observer message'); return
    }
    const p = frame.payload as Payload
    const allowed = ['terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack',
      'terminal_resync', 'terminal_close', 'observer_viewer', 'observer_comments', 'observer_comment_post', 'observer_comment_remove']
    if (!allowed.includes(frame.type) || (p.agentId !== undefined && p.agentId !== observer.grant.agentId)
      || (frame.type === 'terminal_open' && p.agentId !== observer.grant.agentId)) {
      this.send(connId, { type: 'terminal_error', payload: { requestId: p.requestId, code: 'VIEW_ONLY' } })
      return
    }
    if (frame.type.startsWith('observer_comment')) {
      const result = this.comments(frame.type.replace('observer_', ''), observer.grant.agentId, observer.author, p)
      this.send(connId, { type: 'observer_comments', payload: { ...result, requestId: p.requestId } })
      if (!result.error && frame.type !== 'observer_comments') this.broadcastComments(observer.grant.agentId)
      return
    }
    if (frame.type === 'observer_viewer') {
      if (!this.viewers.has(connId) && this.deps.watchViewer) {
        this.viewers.set(connId, this.deps.watchViewer(observer.grant.agentId,
          data => { this.send(connId, { type: 'observer_viewer', payload: data }) }))
      }
      return
    }
    await this.streams.handleFrame(connId, frame.type, p)
  }

  /** Owner controls are serialized so a delayed publish cannot undo a subsequent removal. */
  manage(type: string, payload: Payload): Promise<Payload> {
    // Not behind the controls' queue: a removal from the tab must not wait for an invitation's publish to finish.
    // Every refused grant is tried again on a roster change.
    if (type === 'harness_share_rosters') return this.derive(this.now())
    const work = this.mutation.then(() => this.manageOne(type, payload))
    this.mutation = work.catch(() => {})
    return work
  }
  private async manageOne(type: string, payload: Payload): Promise<Payload> {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const session = this.deps.resolveAgent(agentId)
    if (!session) return { error: 'HARNESS_NOT_FOUND', detail: 'This harness is no longer available.' }
    const machineId = this.deps.machineId()
    if (type.startsWith('harness_share_comment')) {
      const result = this.comments(type.replace('harness_share_', ''), agentId,
        { id: `owner:${machineId}`, name: 'Owner', owner: true }, payload)
      if (!result.error && type !== 'harness_share_comments') this.broadcastComments(agentId)
      return result
    }
    if (type === 'harness_share_link') {
      const visibility = linkVisibility.safeParse(payload.visibility)
      if (!this.deps.collaboration) return { error: 'UNSUPPORTED' }
      if (!visibility.success) return { error: 'INVALID_VISIBILITY', detail: 'Choose Public or Private.' }
      this.deps.collaboration.set({ machineId, agentId, visibility: visibility.data,
        name: projectDisplayName(session), engine: session.engine, ownerPublicKey: await this.ownerPublicKey() })
      if (visibility.data === 'off') {
        for (const grant of this.deps.grants.list(machineId, agentId)) this.deps.grants.revoke(grant.id, machineId, agentId)
      }
      this.recheck()
      await this.syncing
      await this.sync()
    } else if (type === 'harness_share_invite') {
      const parsed = inviteSchema.safeParse(payload)
      if (!parsed.success) return { error: 'INVALID_INVITATION', detail: 'Enter valid email addresses and choose an expiry.' }
      for (const email of new Set(parsed.data.emails)) {
        this.deps.grants.invite({ machineId, agentId, recipientEmail: email,
          name: projectDisplayName(session), engine: session.engine,
          ownerPublicKey: await this.ownerPublicKey(),
          expiresAt: new Date(this.now() + parsed.data.days * 86400_000).toISOString() })
      }
      await this.syncing
      await this.sync()
    } else if (type === 'harness_share_remove') {
      if (typeof payload.id !== 'string' || !this.deps.grants.revoke(payload.id, machineId, agentId)) {
        return { error: 'INVITATION_NOT_FOUND', detail: 'This invitation is no longer available.' }
      }
      for (const [id, observer] of this.observers) if (observer.grant.id === payload.id) this.close(id, 'Access removed')
      this.recheck()
      await this.syncing
      await this.sync()
    } else if (type !== 'harness_share_list') return { error: 'UNSUPPORTED' }
    const link = this.deps.collaboration?.link(machineId, agentId)
    let url: string | null = null
    if (link && link.visibility !== 'off') {
      const address = new URL(`/s/${link.id}`, this.deps.webOrigin ?? 'https://harness.autonomous.ai')
      if (this.deps.autonomousEnv && this.deps.autonomousEnv !== 'prod') address.searchParams.set('env', this.deps.autonomousEnv)
      address.hash = new URLSearchParams({ key: link.ownerPublicKey }).toString()
      url = address.toString()
    }
    return { ...(this.deps.collaboration ? { link: link ? { id: link.id, visibility: link.visibility,
      pending: link.pending, error: link.error, url } : null, collaboration: true } : {}),
      shares: this.deps.grants.list(machineId, agentId).map(grant => ({
      id: grant.id, email: grant.recipientEmail, expiresAt: grant.expiresAt,
      expired: Date.parse(grant.expiresAt) <= this.now(), pending: grant.pending, error: grant.publicationError,
      watching: [...this.observers.values()].filter(o => o.grant.agentId === agentId && o.grant.recipientEmail === grant.recipientEmail).length,
    })) }
  }
  /**
   * The observers the shared tabs want for this machine's harnesses, as ordinary grants tagged by tab: invited,
   * renewed, and revoked once a member leaves the roster, whose observer is closed at once (`recheck`). Asked by Agent
   * Messages as a roster changes (core/messagesLink.ts `observers`), as Share starts, and every 30 s here.
   */
  private derive(retryFailedBefore: number): Promise<Payload> {
    this.derivesQueued++
    const run = this.deriving.then(() => this.deriveRosters(retryFailedBefore)).finally(() => { this.derivesQueued-- })
    this.deriving = run.catch(() => {})
    return run
  }
  private async deriveRosters(retryFailedBefore: number): Promise<Payload> {
    try { return await this.deriveLocally(retryFailedBefore) } finally {
      // Published after, never waited on: what changed here, a revocation above all, is already in force locally.
      void (async () => { await this.syncing; await this.sync() })().catch(ignore)
    }
  }
  private async deriveLocally(retryFailedBefore: number): Promise<Payload> {
    // A roster file that cannot be read, or an account that cannot be said, revokes nothing: a passing read error
    // would otherwise take every member's view away and give it back a moment later.
    const source = await this.deps.rosters?.().catch(() => null)
    if (!source && !this.deps.derivedGrants) return { invited: 0, revoked: 0 }
    const machineId = this.deps.machineId()
    // What is held of one kind, kept as it is when what decides that kind cannot be read now.
    const kept = (swarm: boolean) => this.deps.grants.all()
      .filter(g => g.machineId === machineId && g.tab && g.tab.startsWith('super:') === swarm && !g.revoked)
      .map(g => ({ agentId: g.agentId, email: g.recipientEmail, tab: g.tab!, name: g.name, engine: g.engine }))
    const legacy = source ? rosterGrants(source.rosters, { machineId, accountId: source.accountId }, source.consent) : kept(false)
    const derived = this.deps.derivedGrants?.()
    const wanted = [...legacy, ...derived === null ? kept(true) : derived ?? []]
    // Asked only when there is something to grant: in Share's own process each ask goes to the gateway.
    const key = wanted.length ? await this.ownerPublicKey().catch(() => null) : ''
    // Without this machine's key (its gateway is down) nothing new can be published, but a member who left must still
    // lose their view: the derived grants still wanted are kept exactly as they are, and every other one is revoked.
    const held = this.deps.grants.all().filter(g => g.machineId === machineId && g.tab !== null && !g.revoked)
    const want = key !== null ? wanted.map(w => ({ ...w, ownerPublicKey: key }))
      : held.filter(g => wanted.some(w => w.agentId === g.agentId && w.email.trim().toLowerCase() === g.recipientEmail))
        .map(g => ({ agentId: g.agentId, email: g.recipientEmail, tab: g.tab!, name: g.name, engine: g.engine, ownerPublicKey: g.ownerPublicKey }))
    const { invited, revoked } = this.deps.grants.derive(machineId, want,
      new Date(this.now() + DERIVED_DAYS * DAY).toISOString(), key !== null ? RENEW_DAYS * DAY : -Infinity,
      key !== null ? retryFailedBefore : -Infinity)
    this.recheck()
    return { invited: invited.length, revoked: revoked.length }
  }
  private async ownerPublicKey(): Promise<string> {
    return b64e(this.deps.key ? await this.deps.key.publicKey() : this.deps.identity!.pub)
  }
  private comments(action: string, agentId: string, author: CommentAuthor | null, payload: Payload): Payload {
    const store = this.deps.collaboration
    if (!store) return { error: 'UNSUPPORTED', detail: 'Update Harness on the owner machine to use comments.' }
    const machineId = this.deps.machineId()
    const error = action === 'comment_post' ? store.post(machineId, agentId, author, payload)
      : action === 'comment_remove' ? store.remove(machineId, agentId, author, payload.id) : null
    return error ? { error: 'COMMENT_REJECTED', detail: error }
      : { comments: store.comments(machineId, agentId, author), canComment: author !== null }
  }
  private broadcastComments(agentId: string): void {
    for (const [id, observer] of this.observers) if (observer.grant.agentId === agentId) {
      this.send(id, { type: 'observer_comments', payload: this.comments('comments', agentId, observer.author, {}) })
    }
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing
    const run = async () => {
      for (const grant of this.deps.grants.all().filter(g => g.pending && g.machineId === this.deps.machineId())) {
        try {
          const result = await this.deps.publish(grant.revoked ? 'DELETE' : 'PUT', `/api/harness-shares/${grant.id}`,
            grant.revoked ? undefined : { machineId: grant.machineId, agentId: grant.agentId,
              recipientEmail: grant.recipientEmail, name: grant.name, engine: grant.engine,
              ownerPublicKey: grant.ownerPublicKey, expiresAt: grant.expiresAt,
              ...(grant.tab?.startsWith('super:') ? { superTabId: grant.tab.slice(6) } : {}) })
          if (result.status >= 200 && result.status < 300 || grant.revoked && result.status === 404) {
            // A revoke may have happened while this network request was in flight.
            const current = this.deps.grants.all().find(g => g.id === grant.id)
            if (current?.revoked === grant.revoked && current.expiresAt === grant.expiresAt) this.deps.grants.synced(grant.id)
          } else if (!grant.revoked && [400, 403, 409, 422].includes(result.status)) {
            const body = result.body as { error?: { message?: string }; message?: string }
            const current = this.deps.grants.all().find(g => g.id === grant.id)
            if (current && !current.revoked && current.expiresAt === grant.expiresAt) {
              this.deps.grants.failed(grant.id, body.error?.message || body.message || 'This invitation could not be shared. Remove it or add the email again to retry.')
            }
          }
        } catch { /* Persisted pending change is retried, including after daemon restart. */ }
      }
      const store = this.deps.collaboration
      for (const link of store?.links().filter(l => l.pending && l.machineId === this.deps.machineId()) ?? []) {
        try {
          const result = await this.deps.publish(link.visibility === 'off' ? 'DELETE' : 'PUT', `/api/harness-links/${link.id}`,
            link.visibility === 'off' ? undefined : { machineId: link.machineId, agentId: link.agentId,
              name: link.name, engine: link.engine, ownerPublicKey: link.ownerPublicKey, visibility: link.visibility })
          if (result.status >= 200 && result.status < 300 || link.visibility === 'off' && result.status === 404) store!.published(link, null)
          else if (link.visibility !== 'off' && [400, 403, 409, 422].includes(result.status)) {
            store!.published(link, 'The link could not be published. Try saving its access setting again.')
            this.recheck()
          }
        } catch { /* Owner policy is already durable. Retry metadata publication after reconnect. */ }
      }
    }
    this.syncing = run().finally(() => { this.syncing = null })
    return this.syncing
  }
}
