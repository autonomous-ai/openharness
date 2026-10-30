import { describe, expect, it } from 'vitest'
import { createSuperTab, visibleState } from './model.js'
import { authenticatedEmail, authorizeSwarmJoin, configureSharing, generalAccessSchema,
  joinSwarmSchema, requireSharingOwner, saveSharingSchema, sharingDetails } from './sharing.js'
import { shouldSkipAuth } from '../middlewares/authMiddleware.js'

const owner = { id: 'owner', email: 'owner@example.com' }
const tab = () => createSuperTab('tab', 'Fixture Swarm', owner, 'prod')
const linkToken = (state: ReturnType<typeof tab>) => new URL(sharingDetails(state).joinUrl!).searchParams.get('token')!

describe('Swarm sharing policy', () => {
  it('defaults to invited people and keeps every sharing endpoint authenticated', () => {
    expect(sharingDetails(tab())).toEqual({ revision: 0, access: { mode: 'invited', role: 'collaborator' }, joinUrl: null })
    expect(() => authorizeSwarmJoin(tab(), owner.email)).toThrow('unavailable')
    for (const path of ['sharing', 'join', 'join/preview']) expect(shouldSkipAuth(`/api/super-tabs/tab/${path}`)).toBe(false)
  })

  it('accepts an exact normalized email domain, not a subdomain, suffix, address, or caller metadata', () => {
    const state = tab()
    const access = generalAccessSchema.parse({ mode: 'domain', domain: '  Example.COM ', role: 'collaborator' })
    expect(access).toEqual({ mode: 'domain', domain: 'example.com', role: 'collaborator' })
    state.sharing = configureSharing(undefined, access)
    expect(authorizeSwarmJoin(state, '  Person+test@EXAMPLE.COM  ')).toBe(state.sharing)
    for (const email of ['person@sub.example.com', 'person@notexample.com', 'person@example.com.evil',
      'person@example.com@evil.test', 'person@example.com\nother@evil.test', 'Person <person@example.com>', '', 'not-an-email']) {
      expect(() => authorizeSwarmJoin(state, email)).toThrow('unavailable')
    }
    expect(() => authorizeSwarmJoin(state, owner.email, 'A'.repeat(43))).toThrow('unavailable')
    for (const invalid of ['*.example.com', '@example.com', 'example.com/path', 'example.com.', 'localhost', 'a..example.com']) {
      expect(generalAccessSchema.safeParse({ mode: 'domain', domain: invalid, role: 'viewer' }).success).toBe(false)
    }
    expect(joinSwarmSchema.safeParse({ operationId: 'join', email: 'owner@example.com' }).success).toBe(false)
    expect(authenticatedEmail('device-fixture@pending.harness.invalid')).toBeNull()
  })

  it('restricts grants to viewer or collaborator and link rotation to link access', () => {
    for (const mode of ['invited', 'domain', 'link']) {
      expect(generalAccessSchema.safeParse({ mode, domain: 'example.com', role: 'owner' }).success).toBe(false)
    }
    expect(saveSharingSchema.safeParse({ operationId: 'save', revision: 0,
      access: { mode: 'invited', role: 'viewer' }, rotateLink: true }).success).toBe(false)
    const state = tab()
    state.people.push({ id: 'peer', email: 'peer@example.com', generation: 'peer', role: 'collaborator' })
    expect(() => requireSharingOwner(state, 'peer')).toThrow('Only the Swarm owner')
    expect(() => requireSharingOwner(state, 'stranger')).toThrow('no longer have access')
    expect(() => requireSharingOwner(state, owner.id)).not.toThrow()
  })

  it('encrypts a strong token for owner retrieval and removes secrets from every shared snapshot', () => {
    const state = tab()
    state.sharing = configureSharing(undefined, { mode: 'link', role: 'viewer' })
    const token = linkToken(state)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(state.sharing)).not.toContain(token)
    expect(state.sharing.link?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(authorizeSwarmJoin(state, 'person@example.com', token)).toBe(state.sharing)
    expect(() => authorizeSwarmJoin(state, 'device@pending.harness.invalid', token)).toThrow('unavailable')
    for (const bad of [undefined, 'A', `${token}x`, 'A'.repeat(43)]) {
      expect(() => authorizeSwarmJoin(state, owner.email, bad)).toThrow('unavailable')
    }
    expect(visibleState(state, { kind: 'person', userId: owner.id, email: owner.email }).sharing).toBeUndefined()
    state.people.push({ id: 'peer', email: 'peer@example.com', generation: 'peer', role: 'viewer' })
    expect(visibleState(state, { kind: 'person', userId: 'peer', email: 'peer@example.com' }).sharing).toBeUndefined()
    expect(sharingDetails(state).joinUrl).toBe(`harness://swarm/join/tab?token=${token}`)
  })

  it('keeps a copied link through a role edit, replaces it explicitly, and erases it when access is closed', () => {
    const state = tab()
    state.sharing = configureSharing(undefined, { mode: 'link', role: 'viewer' })
    const first = state.sharing, token = linkToken(state)
    state.sharing = configureSharing(first, { mode: 'link', role: 'collaborator' })
    expect(linkToken(state)).toBe(token)
    expect(state.sharing.generation).not.toBe(first.generation)
    state.sharing = configureSharing(state.sharing, { mode: 'link', role: 'collaborator' }, true)
    expect(linkToken(state)).not.toBe(token)
    expect(() => authorizeSwarmJoin(state, owner.email, token)).toThrow('unavailable')
    state.sharing = configureSharing(state.sharing, { mode: 'domain', domain: 'example.com', role: 'viewer' })
    expect(state.sharing.link).toBeUndefined()
    expect(sharingDetails(state).joinUrl).toBe('harness://swarm/join/tab')
    state.sharing = configureSharing(state.sharing, { mode: 'invited', role: 'viewer' })
    expect(state.sharing.revision).toBe(5)
    expect(sharingDetails(state).joinUrl).toBeNull()
    expect(() => authorizeSwarmJoin(state, owner.email)).toThrow('unavailable')
  })
})
