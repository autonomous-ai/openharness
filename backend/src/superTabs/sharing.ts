import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { decryptMachineCredential, encryptMachineCredential } from '../lib/machineCredential.js'
import { emailDomain, isPublicEmailDomain } from '../lib/publicEmailDomains.js'
import { autoJoinOn } from './autoJoinDomain.js'

export { autoJoinOn }
import { fail, person, type SuperTabState } from './model.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const role = z.enum(['collaborator', 'viewer'])
const domain = z.string().trim().toLowerCase().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Enter a domain such as example.com.')
export const generalAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('invited'), role }).strict(),
  // `autoJoin`: people at the domain join with no link or click, on their own list read (autoJoin.ts). Only at the saving
  // owner's own domain. Left out of a save, the saved value is kept (an older Desktop never turns it off by saving).
  z.object({ mode: z.literal('domain'), role, domain, autoJoin: z.boolean().optional() }).strict(),
  z.object({ mode: z.literal('link'), role }).strict(),
])
export const saveSharingSchema = z.object({ operationId: id, revision: z.number().int().nonnegative().safe(),
  access: generalAccessSchema, rotateLink: z.boolean().optional() }).strict()
  .refine(value => !value.rotateLink || value.access.mode === 'link', 'Only a shared link can be replaced.')
export const previewJoinSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict()
export const joinSwarmSchema = previewJoinSchema.extend({ operationId: id }).strict()
export type GeneralAccess = z.infer<typeof generalAccessSchema>
export type SaveSharing = z.infer<typeof saveSharingSchema>
export type JoinSwarm = z.infer<typeof joinSwarmSchema>

/** Private management state. Never include this in the shared tab snapshot or a command receipt. */
export interface SwarmSharing {
  revision: number
  generation: string
  access: GeneralAccess
  link?: { hash: string; encryptedToken: string }
}

export function requireSharingOwner(state: SuperTabState, userId: string): void {
  person(state, userId)
  if (state.ownerId !== userId) fail('OWNER_REQUIRED', 'Only the Swarm owner can change sharing.', 403)
}

/** Every change fences old join receipts, even if a domain or link is enabled again later. `ownerEmail` is the saving owner's
 *  own account email: a domain anyone can have an address at is refused, and auto-join is only ever at the owner's own domain.
 *  The stored access holds `autoJoin` only while it is on. */
export function configureSharing(previous: SwarmSharing | undefined, input: GeneralAccess, rotateLink = false, ownerEmail?: string): SwarmSharing {
  let access: GeneralAccess = input
  if (input.mode === 'domain') {
    if (isPublicEmailDomain(input.domain)) {
      fail('PUBLIC_DOMAIN', `Anyone can make an address at ${input.domain}. Invite people or share a link instead.`, 400)
    }
    const own = ownerEmail === undefined ? null : emailDomain(ownerEmail)
    if (input.autoJoin === true && input.domain !== own) {
      fail('DOMAIN_NOT_YOURS', `Automatic joins work only at your own email domain${own ? `, ${own}` : ''}.`, 400)
    }
    // Absent keeps the saved value, for the same domain and only while it is still the owner's own.
    const kept = previous?.access.mode === 'domain' && previous.access.domain === input.domain && previous.access.autoJoin === true && input.domain === own
    const { autoJoin: _autoJoin, ...rest } = input
    access = (input.autoJoin ?? kept) ? { ...rest, autoJoin: true } : rest
  }
  let link: SwarmSharing['link']
  if (access.mode === 'link') {
    if (previous?.access.mode === 'link' && previous.link && !rotateLink) link = previous.link
    else {
      const token = randomBytes(32).toString('base64url')
      link = { hash: tokenHash(token), encryptedToken: encryptMachineCredential(token) }
    }
  }
  return { revision: (previous?.revision ?? 0) + 1, generation: randomUUID(), access, ...(link ? { link } : {}) }
}

/** The most people a Swarm takes by auto-join: the most a private project can name (project.sharing). Invitations and links
 *  still work past it. */
export const AUTO_JOIN_CAP = 200


/** The people auto-join never adds again, with `userId` added: someone who left or was removed (spec, Leaving is final). Kept
 *  sorted, so the same people always write the same row. */
export function declinedWith(state: Pick<SuperTabState, 'autoJoinDeclined'>, userId: string): string[] {
  return [...new Set([...state.autoJoinDeclined ?? [], userId])].sort()
}

/** Without `userId`: they came back on purpose, by an invitation or a link. Undefined when nobody is left. */
export function declinedWithout(state: Pick<SuperTabState, 'autoJoinDeclined'>, userId: string): string[] | undefined {
  const rest = (state.autoJoinDeclined ?? []).filter(id => id !== userId)
  return rest.length ? rest : undefined
}

/** What the owner's Share dialog shows. `ownerEmail` is the reading owner's account email. A saved share at a domain anyone can
 *  have an address at, which this release no longer answers, shows as invite-only with the domain it turned off. */
export function sharingDetails(state: SuperTabState, ownerEmail: string) {
  const sharing = state.sharing
  const saved: GeneralAccess = sharing?.access ?? { mode: 'invited', role: 'collaborator' }
  const turnedOff = saved.mode === 'domain' && isPublicEmailDomain(saved.domain) ? saved.domain : undefined
  const access: GeneralAccess = turnedOff ? { mode: 'invited', role: saved.role }
    : saved.mode === 'domain' ? { ...saved, autoJoin: saved.autoJoin === true } : saved
  const path = `harness://swarm/join/${encodeURIComponent(state.id)}`
  const joinUrl = access.mode === 'invited' ? null : access.mode === 'domain' ? path
    : sharing?.link ? `${path}?token=${decryptMachineCredential(sharing.link.encryptedToken)}` : null
  const ownDomain = emailDomain(ownerEmail)
  return { revision: sharing?.revision ?? 0, access, joinUrl, ownDomain, ownDomainPublic: isPublicEmailDomain(ownDomain),
    autoJoinFull: !!autoJoinOn(state) && state.people.length >= AUTO_JOIN_CAP, ...(turnedOff ? { turnedOffDomain: turnedOff } : {}) }
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Email comes only from the authenticated account, never from a join body or an old roster row. */
export function authenticatedEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  if (!z.email().safeParse(normalized).success || normalized.endsWith('@pending.harness.invalid')) return null
  return normalized
}

/** `userId`: the joining person. Someone who left or was removed (autoJoinDeclined) comes back only on purpose, by an
 *  invitation or a shared link's token, never by the domain's own join link, which needs none (spec 2026-11-03, Trust 4). */
export function authorizeSwarmJoin(state: SuperTabState, email: string, token?: string, userId?: string): SwarmSharing {
  const sharing = state.sharing
  const verifiedEmail = authenticatedEmail(email)
  if (!sharing || !verifiedEmail) return fail('JOIN_UNAVAILABLE', 'This Swarm link is unavailable for this account.', 404)
  const access = sharing.access
  // A domain anyone can have an address at lets nobody in, even one saved before this was refused (spec, Trust 2).
  if (access.mode === 'domain' && token === undefined && !isPublicEmailDomain(access.domain) && verifiedEmail.split('@')[1] === access.domain &&
    !(userId !== undefined && state.autoJoinDeclined?.includes(userId))) return sharing
  if (access.mode === 'link' && token && sharing.link && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const expected = Buffer.from(sharing.link.hash, 'hex')
    const actual = Buffer.from(tokenHash(token), 'hex')
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return sharing
  }
  return fail('JOIN_UNAVAILABLE', 'This Swarm link is unavailable for this account.', 404)
}
