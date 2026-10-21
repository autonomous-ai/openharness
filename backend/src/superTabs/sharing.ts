import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { decryptMachineCredential, encryptMachineCredential } from '../lib/machineCredential.js'
import { fail, person, type SuperTabState } from './model.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const role = z.enum(['collaborator', 'viewer'])
const domain = z.string().trim().toLowerCase().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Enter a domain such as example.com.')
export const generalAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('invited'), role }).strict(),
  z.object({ mode: z.literal('domain'), role, domain }).strict(),
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

/** Every change fences old join receipts, even if a domain or link is enabled again later. */
export function configureSharing(previous: SwarmSharing | undefined, access: GeneralAccess, rotateLink = false): SwarmSharing {
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

export function sharingDetails(state: SuperTabState) {
  const sharing = state.sharing
  const access: GeneralAccess = sharing?.access ?? { mode: 'invited', role: 'collaborator' }
  const path = `harness://swarm/join/${encodeURIComponent(state.id)}`
  const joinUrl = access.mode === 'invited' ? null : access.mode === 'domain' ? path
    : sharing?.link ? `${path}?token=${decryptMachineCredential(sharing.link.encryptedToken)}` : null
  return { revision: sharing?.revision ?? 0, access, joinUrl }
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Email comes only from the authenticated account, never from a join body or an old roster row. */
export function authenticatedEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  if (!z.email().safeParse(normalized).success || normalized.endsWith('@pending.harness.invalid')) return null
  return normalized
}

export function authorizeSwarmJoin(state: SuperTabState, email: string, token?: string): SwarmSharing {
  const sharing = state.sharing
  const verifiedEmail = authenticatedEmail(email)
  if (!sharing || !verifiedEmail) return fail('JOIN_UNAVAILABLE', 'This Swarm link is unavailable for this account.', 404)
  const access = sharing.access
  if (access.mode === 'domain' && token === undefined && verifiedEmail.split('@')[1] === access.domain) return sharing
  if (access.mode === 'link' && token && sharing.link && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const expected = Buffer.from(sharing.link.hash, 'hex')
    const actual = Buffer.from(tokenHash(token), 'hex')
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return sharing
  }
  return fail('JOIN_UNAVAILABLE', 'This Swarm link is unavailable for this account.', 404)
}
