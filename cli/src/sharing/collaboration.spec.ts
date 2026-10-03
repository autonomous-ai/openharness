import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessCollaborationStore, type CommentAuthor } from './collaboration.js'
import { HarnessGrantStore } from './grants.js'
import { HarnessShareOwner, type ShareOwnerDeps } from './owner.js'
import { b64e, newEphemeral, newIdentity } from '../lib/e2ee/core.js'
import { recipientHandshake, type ObserverCipher } from './crypto.js'
import type { RegisteredSession } from '../lib/registry.js'

const alice: CommentAuthor = { id: 'alice', name: 'Alice', owner: false }
const bob: CommentAuthor = { id: 'bob', name: 'Bob', owner: false }
const ownerAuthor: CommentAuthor = { id: 'owner:m', name: 'Owner', owner: true }
const linkInput = { machineId: 'm', agentId: 'a', name: 'Example', engine: 'codex', ownerPublicKey: b64e(newIdentity().pub), visibility: 'private' as const }
describe('durable link policy and comments', () => {
  let root: string, path: string, store: HarnessCollaborationStore
  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'collaboration-')); path = join(root, 'state.json')
    store = new HarnessCollaborationStore(path)
  })
  afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
  it('persists one stable link, private/public/off changes, publication status and revision fencing', () => {
    expect(store.active('missing', 'm')).toBeUndefined()
    const first = store.set(linkInput)
    expect(first.pending).toBe(true)
    expect(store.active(first.id, 'other')).toBeUndefined()
    store.set({ ...linkInput, agentId: 'b' })
    const second = store.set({ ...linkInput, visibility: 'public' })
    expect(second.id).toBe(first.id)
    store.published(first, null)
    expect(store.link('m', 'a')?.pending).toBe(true)
    store.published(second, 'Denied')
    expect(store.active(first.id, 'm')).toBeUndefined()
    expect(new HarnessCollaborationStore(path).link('m', 'a')?.error).toBe('Denied')
    const retry = store.set({ ...linkInput, visibility: 'public' })
    store.published(retry, null)
    expect(store.active(first.id, 'm')?.pending).toBe(false)
    const copy = store.links(); copy[0].visibility = 'off'
    expect(store.links()[0].visibility).toBe('private')
    store.set({ ...linkInput, visibility: 'off' })
    expect(store.active(first.id, 'm')).toBeUndefined()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    writeFileSync(path, '{bad')
    expect(() => new HarnessCollaborationStore(path)).toThrow('could not be read')
    writeFileSync(path, JSON.stringify({ links: [{ id: 'bad' }], comments: [] }))
    expect(() => new HarnessCollaborationStore(path)).toThrow('could not be read')
  })
  it('authenticates posting, bounds text, deduplicates retries and exposes no private author IDs', () => {
    const id = randomUUID()
    expect(store.post('m', 'a', null, { id, text: 'hello' })).toContain('Sign in')
    for (const input of [{ id: 'bad', text: 'hello' }, { id, text: '' }, { id, text: 'x'.repeat(4001) }]) {
      expect(store.post('m', 'a', alice, input)).toContain('4,000')
    }
    expect(store.post('m', 'a', alice, { id, text: '  Hello 👋\nWorld  ' })).toBeNull()
    expect(store.post('m', 'a', alice, { id, text: 'Hello 👋\nWorld' })).toBeNull()
    for (const [machine, agent, author, text] of [
      ['other', 'a', alice, 'Hello 👋\nWorld'], ['m', 'other', alice, 'Hello 👋\nWorld'],
      ['m', 'a', bob, 'Hello 👋\nWorld'], ['m', 'a', alice, 'different'],
    ] as const) expect(store.post(machine, agent, author, { id, text })).toContain('Try again')
    expect(store.comments('m', 'a', null)).toEqual([{ id, text: 'Hello 👋\nWorld', authorName: 'Alice',
      createdAt: expect.any(String), canDelete: false }])
    expect(store.comments('m', 'a', alice)[0].canDelete).toBe(true)
    expect(store.comments('m', 'a', bob)[0].canDelete).toBe(false)
    expect(store.comments('m', 'a', ownerAuthor)[0].canDelete).toBe(true)
    expect(store.comments('m', 'other', alice)).toEqual([])
    expect(store.comments('other', 'a', alice)).toEqual([])
    expect(new HarnessCollaborationStore(path).comments('m', 'a', alice)).toHaveLength(1)
  })
  it('allows author deletion and owner moderation, scoped to the exact agent, including idempotent retry', () => {
    const id = randomUUID(); store.post('m', 'a', alice, { id, text: 'A' })
    expect(store.remove('m', 'a', null, id)).toContain('own comments')
    expect(store.remove('m', 'a', bob, id)).toContain('own comments')
    expect(store.remove('other', 'a', ownerAuthor, id)).toBeNull()
    expect(store.remove('m', 'other', ownerAuthor, id)).toBeNull()
    expect(store.comments('m', 'a', null)).toHaveLength(1)
    expect(store.remove('m', 'a', alice, id)).toBeNull()
    expect(store.remove('m', 'a', alice, id)).toBeNull()
    store.post('m', 'a', bob, { id: randomUUID(), text: 'B' })
    expect(store.remove('m', 'a', ownerAuthor, store.comments('m', 'a', null)[0].id)).toBeNull()
    expect(store.comments('m', 'a', null)).toEqual([])
  })
  it('limits each account’s posting rate across agents and caps durable thread size', () => {
    for (let i = 0; i < 10; i++) expect(store.post('m', 'a', alice, { id: randomUUID(), text: `${i}` })).toBeNull()
    expect(store.post('m', 'b', alice, { id: randomUUID(), text: 'spam' })).toContain('minute')
    expect(store.post('m', 'a', bob, { id: randomUUID(), text: 'separate' })).toBeNull()
    vi.advanceTimersByTime(60_001)
    expect(store.post('m', 'a', alice, { id: randomUUID(), text: 'allowed again' })).toBeNull()
    const data = JSON.parse(readFileSync(path, 'utf8'))
    data.comments = Array.from({ length: 200 }, () => ({ ...data.comments[0], id: randomUUID() }))
    writeFileSync(path, JSON.stringify(data))
    store = new HarnessCollaborationStore(path, () => Date.now())
    expect(store.post('m', 'a', alice, { id: randomUUID(), text: 'full' })).toContain('thread is full')
    const unicode = { ...data.comments[0], text: '界'.repeat(4000) }
    const count = Math.floor((1024 * 1024 - 100) / (Buffer.byteLength(JSON.stringify(unicode)) + 1))
    data.comments = Array.from({ length: count }, () => ({ ...unicode, id: randomUUID() }))
    writeFileSync(path, JSON.stringify(data)); store = new HarnessCollaborationStore(path)
    expect(count).toBeLessThan(200)
    expect(store.post('m', 'a', alice, { id: randomUUID(), text: unicode.text })).toContain('thread is full')
  })
})

describe('owner link and comment authority', () => {
  let root: string, store: HarnessCollaborationStore, grants: HarnessGrantStore, owner: HarnessShareOwner
  const identity = newIdentity()
  let frames: Array<{ id: string; type: string; payload: any }>
  let deps: ShareOwnerDeps
  beforeEach(() => {
    vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'link-owner-')); frames = []
    store = new HarnessCollaborationStore(join(root, 'collaboration.json'))
    grants = new HarnessGrantStore(join(root, 'grants.json'))
    deps = { machineId: () => 'm', identity, grants, collaboration: store,
      terminals: {} as ShareOwnerDeps['terminals'], now: () => Date.now(),
      resolveAgent: id => ['a', 'b'].includes(id) ? { agentId: id, projectPath: '/tmp/example', engine: 'codex' } as unknown as RegisteredSession : undefined,
      send: vi.fn((id, type, payload) => { frames.push({ id, type, payload }); return true }),
      publish: vi.fn(async () => ({ status: 200, body: {} })),
    }
    owner = new HarnessShareOwner(deps)
  })
  afterEach(async () => { await owner.stop(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
  const manage = (action: string, payload: Record<string, unknown> = {}) => owner.manage(`harness_share_${action}`, { agentId: 'a', ...payload })
  async function connect(options: Record<string, unknown> = {}, agentId = 'a') {
    const link = store.link('m', agentId)!, ephemeral = newEphemeral(), id = `observer:${randomUUID()}`
    await owner.receive(id, 'observer_open', { linkId: link.id, ephemeral: b64e(ephemeral.pub), ...options })
    const welcome = frames.find(f => f.id === id && f.type === 'observer_welcome')
    return { id, cipher: welcome ? recipientHandshake(ephemeral, 'm', link.id, b64e(identity.pub), welcome.payload) : null }
  }
  async function request(client: { id: string; cipher: ObserverCipher | null }, type: string, payload: Record<string, unknown> = {}) {
    await owner.receive(client.id, 'observer_frame', client.cipher!.seal({ type, payload }) as any)
  }
  function read(client: { id: string; cipher: ObserverCipher | null }) {
    const received = frames.filter(f => f.id === client.id && f.type === 'observer_frame')
    frames = frames.filter(f => f.id !== client.id || f.type !== 'observer_frame')
    return received.map(f => client.cipher!.open(f.payload) as any)
  }
  it('creates a pinned private link, admits only invited accounts or the owner, and counts link watchers', async () => {
    expect(await manage('list')).toMatchObject({ link: null, collaboration: true })
    expect(await manage('link', { visibility: 'invalid' })).toMatchObject({ error: 'INVALID_VISIBILITY' })
    const result = await manage('link', { visibility: 'private' })
    const url = new URL((result.link as any).url)
    expect(url.origin).toBe('https://harness.autonomous.ai')
    expect(new URLSearchParams(url.hash.slice(1)).get('key')).toBe(b64e(identity.pub))
    expect((await connect()).cipher).toBeNull()
    expect((await connect({ email: 'stranger@example.com', authorId: 'stranger' })).cipher).toBeNull()
    expect((await connect({ authorId: 'owner', owner: true })).cipher).not.toBeNull()
    await manage('invite', { emails: ['alice@example.com'] })
    const alice = await connect({ email: 'alice@example.com', authorId: 'alice', authorName: 'Alice' })
    expect(alice.cipher).not.toBeNull()
    expect((await manage('list')).shares).toMatchObject([{ watching: 1 }])
    await manage('remove', { id: grants.all()[0].id })
    expect(frames.find(f => f.id === alice.id && f.type === 'observer_closed')).toBeTruthy()
  })
  it('public visitors observe without identity but cannot post, spoof an author, control, or target another agent', async () => {
    await manage('link', { visibility: 'public' })
    const guest = await connect(), alice = await connect({ authorId: 'alice', authorName: 'Alice', email: 'alice@example.com' })
    await request(guest, 'observer_comments')
    expect(read(guest)[0].payload).toMatchObject({ comments: [], canComment: false })
    await request(guest, 'observer_comment_post', { id: randomUUID(), text: 'spoof', authorId: 'owner', owner: true })
    expect(read(guest)[0].payload).toMatchObject({ error: 'COMMENT_REJECTED' })
    for (const type of ['terminal_input', 'terminal_resize', 'agent_delete', 'message']) {
      await request(guest, type, { agentId: 'a', data: 'input' })
      expect(read(guest)[0].payload.code).toBe('VIEW_ONLY')
    }
    await request(alice, 'observer_comment_post', { id: randomUUID(), text: 'wrong target', agentId: 'b' })
    expect(read(alice)[0].payload.code).toBe('VIEW_ONLY')
    const id = randomUUID()
    await request(alice, 'observer_comment_post', { id, text: 'Hello', requestId: 'post', authorId: 'owner' })
    expect(read(alice)[0].payload).toMatchObject({ requestId: 'post', canComment: true, comments: [{ id, authorName: 'Alice', canDelete: true }] })
    expect(read(guest)[0].payload.comments).toMatchObject([{ id, canDelete: false }])
    const bob = await connect({ authorId: 'bob' })
    await request(bob, 'observer_comment_remove', { id })
    expect(read(bob)[0].payload).toMatchObject({ error: 'COMMENT_REJECTED' })
    await request(alice, 'observer_comment_remove', { id })
    expect(read(alice)[0].payload.comments).toEqual([])
    expect((await manage('comment_post', { id: randomUUID(), text: 'Owner reply' })).comments).toMatchObject([{ authorName: 'Owner' }])
    const comments = await manage('comments')
    expect(await manage('comment_remove', { id: (comments.comments as any[])[0].id })).toMatchObject({ comments: [] })
  })
  it('private transition, expiry, and stopping all sharing revoke existing observers immediately', async () => {
    await manage('link', { visibility: 'public' })
    await manage('invite', { emails: ['alice@example.com'], days: 7 })
    const guest = await connect(), alice = await connect({ email: 'alice@example.com', authorId: 'alice' })
    await manage('link', { visibility: 'private' })
    expect(frames.find(f => f.id === guest.id && f.type === 'observer_closed')).toBeTruthy()
    expect(frames.find(f => f.id === alice.id && f.type === 'observer_closed')).toBeUndefined()
    vi.setSystemTime(Date.now() + 8 * 86400_000); await vi.advanceTimersByTimeAsync(1000)
    expect(frames.find(f => f.id === alice.id && f.type === 'observer_closed')).toBeTruthy()
    await manage('link', { visibility: 'public' })
    const next = await connect()
    const result = await manage('link', { visibility: 'off' })
    expect(result).toMatchObject({ shares: [], link: { visibility: 'off', url: null } })
    expect(frames.find(f => f.id === next.id && f.type === 'observer_closed')).toBeTruthy()
    expect((await connect()).cipher).toBeNull()
    expect(grants.all().every(g => g.revoked)).toBe(true)
  })
  it('retries offline publication, fails closed on permanent errors, and scopes sync to this machine', async () => {
    vi.mocked(deps.publish).mockRejectedValueOnce(new Error('offline'))
    expect(await manage('link', { visibility: 'public' })).toMatchObject({ link: { pending: true } })
    store.set({ ...linkInput, machineId: 'other' })
    const guest = await connect()
    vi.mocked(deps.publish).mockResolvedValueOnce({ status: 503, body: {} })
    await owner.sync(); expect(store.link('m', 'a')?.pending).toBe(true)
    vi.mocked(deps.publish).mockResolvedValueOnce({ status: 403, body: {} })
    await owner.sync()
    expect(store.link('m', 'a')?.error).toContain('could not be published')
    expect(frames.find(f => f.id === guest.id && f.type === 'observer_closed')).toBeTruthy()
    await manage('link', { visibility: 'private' })
    expect(store.link('m', 'a')?.error).toBeNull()
    vi.mocked(deps.publish).mockResolvedValueOnce({ status: 404, body: {} })
    await manage('link', { visibility: 'off' })
    expect(store.link('m', 'a')?.pending).toBe(false)
    expect(store.link('other', 'a')?.pending).toBe(true)
  })
  it('retains staged link environment, checks owner comments and safely handles unsupported daemons', async () => {
    deps.webOrigin = 'https://example.com'; deps.autonomousEnv = 'stag'
    const result = await manage('link', { visibility: 'public' })
    expect(new URL((result.link as any).url).searchParams.get('env')).toBe('stag')
    const ownerClient = await connect({ authorId: 'owner', owner: true })
    await request(ownerClient, 'observer_comment_post', { id: randomUUID(), text: 'Owner' })
    expect(read(ownerClient)[0].payload.comments).toMatchObject([{ authorName: 'Owner', canDelete: true }])
    await manage('link', { visibility: 'public', agentId: 'b' })
    const otherAgent = await connect({}, 'b')
    await manage('comment_post', { id: randomUUID(), text: 'Scoped reply' })
    expect(read(otherAgent)).toEqual([])
    expect(await manage('comment_post', { id: 'bad', text: '' })).toMatchObject({ error: 'COMMENT_REJECTED' })
    deps.collaboration = undefined
    expect(await manage('comments')).toMatchObject({ error: 'UNSUPPORTED' })
    expect(await manage('link', { visibility: 'public' })).toMatchObject({ error: 'UNSUPPORTED' })
    expect((await connect()).cipher).toBeNull()
    await request(ownerClient, 'observer_comments')
    expect(frames.find(f => f.id === ownerClient.id && f.type === 'observer_closed')).toBeTruthy()
  })
})
