import type { Identity } from '../lib/e2ee/core.js'
import { b64e } from '../lib/e2ee/core.js'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import type { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import { encodeTerminalLocal } from '../lib/terminalBinary.js'
import { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import { HarnessGrantStore, inviteSchema, type HarnessGrant } from './grants.js'
import { ownerHandshake, signedOwnerHandshake, type ObserverCipher, type OwnerKey } from './crypto.js'
import { HarnessCollaborationStore, linkVisibility, type CommentAuthor } from './collaboration.js'

type Payload = Record<string, unknown>
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
    let ticks = 0
    this.timer = setInterval(() => {
      for (const [id, observer] of this.observers) {
        if (!this.authorized(observer)) this.close(id, 'Sharing ended or invitation expired')
      }
      if (++ticks % 30 === 0) void this.sync()
    }, 1000)
    this.timer.unref()
  }
  private authorized(observer: Observer): boolean {
    if (observer.linkId) {
      const link = this.deps.collaboration?.active(observer.linkId, this.deps.machineId())
      return !!link && !!this.deps.resolveAgent(link.agentId) && (link.visibility === 'public'
        || observer.author?.owner === true || this.invited(link.agentId, observer.grant.recipientEmail))
    }
    return !!this.deps.grants.active(observer.grant.id, observer.grant.recipientEmail, this.deps.machineId())
      && !!this.deps.resolveAgent(observer.grant.agentId)
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
        ? { ...link, recipientEmail: email, createdAt: '', expiresAt: '', revoked: false, publicationError: null }
        : payload.linkId ? null : this.deps.grants.active(String(payload.shareId), email, this.deps.machineId())
      if (!grant || !this.deps.resolveAgent(grant.agentId) || this.observers.size >= 100) {
        this.deps.send(connId, 'observer_closed', { reason: 'Sharing ended or invitation expired' }); return
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
    if (!this.authorized(observer)) { this.close(connId, 'Sharing ended or invitation expired'); return }
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
              ownerPublicKey: grant.ownerPublicKey, expiresAt: grant.expiresAt })
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
