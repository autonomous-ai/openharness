import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessGrantStore, inviteSchema } from './grants.js'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-share-grants-')); roots.push(root)
  const path = join(root, 'permissions.json')
  let now = Date.now()
  const store = new HarnessGrantStore(path, () => now)
  const input = { machineId: 'machine', agentId: 'agent', recipientEmail: 'ken@example.test',
    name: 'CAD prototype', engine: 'codex', ownerPublicKey: 'public', expiresAt: new Date(now + 1000).toISOString() }
  return { store, path, input, advance: () => { now += 1001 } }
}
describe('durable harness sharing permissions', () => {
  it('normalizes emails and constrains invitation batches and expiry', () => {
    expect(inviteSchema.parse({ emails: ['  Ken@Example.Test '] })).toEqual({ emails: ['ken@example.test'], days: 30 })
    for (const invalid of [{ emails: [] }, { emails: ['bad'] }, { emails: ['a@example.test'], days: 365 },
      { emails: Array(21).fill('a@example.test') }]) expect(inviteSchema.safeParse(invalid).success).toBe(false)
  })
  it('persists private grants and admits only the matching recipient, machine and live grant', () => {
    const f = fixture(); expect(f.store.all()).toEqual([])
    const grant = f.store.invite(f.input)
    expect(statSync(f.path).mode & 0o777).toBe(0o600)
    expect(new HarnessGrantStore(f.path).list('machine', 'agent')).toEqual([grant])
    expect(f.store.active(grant.id, 'ken@example.test', 'machine')).toEqual(grant)
    expect(f.store.active(grant.id, 'diego@example.test', 'machine')).toBeNull()
    expect(f.store.active(grant.id, 'ken@example.test', 'another-machine')).toBeNull()
    expect(f.store.active('missing', 'ken@example.test', 'machine')).toBeNull()
    expect(f.store.list('machine', 'another-agent')).toEqual([])
    f.advance(); expect(f.store.active(grant.id, 'ken@example.test', 'machine')).toBeNull()
  })
  it('renews idempotently, isolates permissions, and durably revokes before sync', () => {
    const f = fixture(), ken = f.store.invite(f.input)
    const diego = f.store.invite({ ...f.input, recipientEmail: 'diego@example.test' })
    f.store.synced(ken.id); expect(f.store.all().find(g => g.id === ken.id)?.pending).toBe(false)
    const renewed = f.store.invite({ ...f.input, name: 'Renamed' })
    expect(renewed.id).toBe(ken.id); expect(f.store.all()).toHaveLength(2)
    expect(f.store.revoke(ken.id, 'another-machine', 'agent')).toBe(false)
    expect(f.store.revoke(ken.id, 'machine', 'another-agent')).toBe(false)
    expect(f.store.revoke(ken.id, 'machine', 'agent')).toBe(true)
    expect(f.store.active(ken.id, ken.recipientEmail, 'machine')).toBeNull()
    expect(new HarnessGrantStore(f.path).list('machine', 'agent')).toEqual([diego])
    expect(JSON.parse(readFileSync(f.path, 'utf8')).find((g: { id: string }) => g.id === ken.id)).toMatchObject({ revoked: true, pending: true })
    const copy = f.store.all(); copy[0].name = 'tampered'
    expect(f.store.all()[0].name).not.toBe('tampered')
  })
  it('reads a permissions file from before shared tabs as hand-made grants', () => {
    const f = fixture(), grant = f.store.invite(f.input)
    const { tab: _tab, ...old } = grant
    writeFileSync(f.path, JSON.stringify([old]))
    expect(new HarnessGrantStore(f.path).list('machine', 'agent')).toEqual([{ ...grant, tab: null }])
  })
  it('fails closed on corrupt state instead of silently forgetting permissions', () => {
    const f = fixture(); writeFileSync(f.path, '{broken')
    expect(() => new HarnessGrantStore(f.path)).toThrow('permissions file could not be read')
  })
})

describe('observer grants derived from shared tabs', () => {
  const DAY = 86400_000, TAB = 'a'.repeat(24)
  function derived() {
    const root = mkdtempSync(join(tmpdir(), 'harness-share-derive-')); roots.push(root)
    const path = join(root, 'permissions.json')
    let now = Date.parse('2026-10-16T00:00:00.000Z')
    const store = new HarnessGrantStore(path, () => now)
    const want = (email: string, over: Record<string, string> = {}) => ({ agentId: 'api', email, tab: TAB, name: 'api', engine: 'codex', ownerPublicKey: 'public', ...over })
    const expiry = () => new Date(now + 30 * DAY).toISOString()
    return { store, path, want, expiry, advance: (ms: number) => { now += ms } }
  }

  it('invites every wanted observer, tagged by its tab, and hides them from the person\'s own list', () => {
    const f = derived()
    const { invited, revoked } = f.store.derive('machine', [f.want('Alice@Example.com'), f.want('carol@example.com')], f.expiry(), 7 * DAY)
    expect(revoked).toEqual([])
    expect(invited.map(g => [g.recipientEmail, g.tab, g.pending, g.name, g.engine])).toEqual([
      ['alice@example.com', TAB, true, 'api', 'codex'], ['carol@example.com', TAB, true, 'api', 'codex']])
    expect(f.store.active(invited[0].id, 'alice@example.com', 'machine')).toMatchObject({ tab: TAB })
    // The Share dialog lists only the grants a person made; derived ones are the tab's.
    expect(f.store.list('machine', 'api')).toEqual([])
    // Nothing changes when nothing is due: no save, nothing to publish.
    expect(f.store.derive('machine', [f.want('alice@example.com'), f.want('carol@example.com')], f.expiry(), 7 * DAY)).toEqual({ invited: [], revoked: [] })
    expect(new HarnessGrantStore(f.path).all()).toHaveLength(2)
  })

  it('renews a derived grant only once it is within the renewal window, keeping its id', () => {
    const f = derived()
    const [first] = f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited
    f.store.synced(first.id)
    f.advance(22 * DAY)
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited).toEqual([])
    f.advance(2 * DAY)
    const [renewed] = f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited
    expect(renewed).toMatchObject({ id: first.id, createdAt: first.createdAt, pending: true, expiresAt: f.expiry() })
    // A renamed harness is published again under the same id.
    const [renamed] = f.store.derive('machine', [f.want('alice@example.com', { name: 'api v2' })], f.expiry(), 7 * DAY).invited
    expect(renamed).toMatchObject({ id: first.id, name: 'api v2' })
    expect(f.store.derive('machine', [f.want('alice@example.com', { name: 'api v2', engine: 'claude' })], f.expiry(), 7 * DAY).invited).toHaveLength(1)
  })

  it('revokes a derived grant no longer wanted, and the same id comes back when the member is added again', () => {
    const f = derived()
    const [alice, carol] = f.store.derive('machine', [f.want('alice@example.com'), f.want('carol@example.com')], f.expiry(), 7 * DAY).invited
    const { invited, revoked } = f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY)
    expect(invited).toEqual([])
    expect(revoked).toEqual([expect.objectContaining({ id: carol.id, revoked: true, pending: true })])
    expect(f.store.active(carol.id, 'carol@example.com', 'machine')).toBeNull()
    expect(f.store.active(alice.id, 'alice@example.com', 'machine')).not.toBeNull()
    // Revoked once is enough: a second pass has nothing to do.
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY)).toEqual({ invited: [], revoked: [] })
    const [again] = f.store.derive('machine', [f.want('alice@example.com'), f.want('carol@example.com')], f.expiry(), 7 * DAY).invited
    expect(again).toMatchObject({ id: carol.id, revoked: false, pending: true })
    // A grant of another machine is never this machine's to revoke.
    const other = derived()
    other.store.derive('elsewhere', [other.want('alice@example.com')], other.expiry(), 7 * DAY)
    expect(other.store.derive('machine', [], other.expiry(), 7 * DAY).revoked).toEqual([])
  })

  it('never touches a live hand-made grant, which wins for the same harness and email', () => {
    const f = derived()
    const manual = f.store.invite({ machineId: 'machine', agentId: 'api', recipientEmail: 'alice@example.com', name: 'CAD',
      engine: 'codex', ownerPublicKey: 'public', expiresAt: new Date(Date.parse(f.expiry()) + DAY).toISOString() })
    expect(manual.tab).toBeNull()
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY)).toEqual({ invited: [], revoked: [] })
    expect(f.store.derive('machine', [], f.expiry(), 7 * DAY)).toEqual({ invited: [], revoked: [] })
    expect(f.store.list('machine', 'api')).toEqual([manual])
    // Inviting by hand an email the tab already grants makes the grant the person's: the tab no longer revokes it.
    const [carol] = f.store.derive('machine', [f.want('carol@example.com')], f.expiry(), 7 * DAY).invited
    const taken = f.store.invite({ machineId: 'machine', agentId: 'api', recipientEmail: 'carol@example.com', name: 'CAD',
      engine: 'codex', ownerPublicKey: 'public', expiresAt: f.expiry() })
    expect(taken).toMatchObject({ id: carol.id, tab: null })
    expect(f.store.derive('machine', [], f.expiry(), 7 * DAY).revoked).toEqual([])
    // Once the person removes theirs, the tab may grant it again, under the same id.
    f.store.revoke(manual.id, 'machine', 'api')
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited).toEqual([expect.objectContaining({ id: manual.id, tab: TAB })])
  })

  it('refuses to remove a derived grant by hand, and grants one email once however many tabs list it', () => {
    const f = derived()
    const { invited } = f.store.derive('machine', [f.want('alice@example.com'), f.want('alice@example.com', { tab: 'b'.repeat(24) }),
      f.want('not an email')], f.expiry(), 7 * DAY)
    expect(invited).toEqual([expect.objectContaining({ recipientEmail: 'alice@example.com', tab: TAB })])
    expect(f.store.revoke(invited[0].id, 'machine', 'api')).toBe(false)
    expect(f.store.active(invited[0].id, 'alice@example.com', 'machine')).not.toBeNull()
  })

  it('publishes a refused derived grant again once its refusal is old enough, and keeps it waiting before then', () => {
    const f = derived()
    const [alice] = f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited
    f.store.failed(alice.id, 'This machine is not available to share.')
    const failedAt = f.store.all()[0].failedAt!
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY).invited).toEqual([])
    expect(f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY, failedAt - 1).invited).toEqual([])
    const [retried] = f.store.derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY, failedAt).invited
    expect(retried).toMatchObject({ id: alice.id, pending: true, publicationError: null, failedAt: null })
    // A refusal saved before it had a time is as old as can be.
    f.store.failed(alice.id, 'refused')
    writeFileSync(f.path, JSON.stringify(f.store.all().map(({ failedAt: _f, ...g }) => g)))
    expect(new HarnessGrantStore(f.path).derive('machine', [f.want('alice@example.com')], f.expiry(), 7 * DAY, 0).invited).toHaveLength(1)
  })

  it('names a harness the roster leaves unnamed, within what the backend accepts', () => {
    const f = derived()
    const { invited } = f.store.derive('machine', [f.want('alice@example.com', { name: '   ' }),
      f.want('bob@example.com', { agentId: 'web', name: 'x'.repeat(200) })], f.expiry(), 7 * DAY)
    expect(invited.map(g => g.name)).toEqual(['Harness', 'x'.repeat(160)])
  })
})
