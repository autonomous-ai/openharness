import type { MachineShare } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'

export type ShareVia = 'email' | 'domain'

/** The shared policy decision, usable inside a transaction without opening Redis connections. */
export function sharedVia(share: Pick<MachineShare, 'emails' | 'domain'>, email: string): ShareVia | null {
  const address = email.trim().toLowerCase()
  if (share.emails.includes(address)) return 'email'
  const domain = emailDomain(address)
  return share.domain && domain === share.domain && !isPublicEmailDomain(domain) ? 'domain' : null
}

type GrantPolicy = Pick<MachineShare, 'id' | 'emails' | 'domain' | 'grantVersions'>
const versionsOf = (share: GrantPolicy) => share.grantVersions && typeof share.grantVersions === 'object' && !Array.isArray(share.grantVersions)
  ? share.grantVersions as Record<string, unknown> : {}
const grantVersion = (share: GrantPolicy, key: string) => {
  const existing = versionsOf(share)[key]
  return typeof existing === 'string' ? existing : `${share.id}:${key}`
}
export function machineShareGrant(share: GrantPolicy, email: string): string | null {
  const via = sharedVia(share, email)
  return via ? grantVersion(share, via === 'email' ? `email:${email.trim().toLowerCase()}` : `domain:${share.domain}`) : null
}
/** Unchanged grants keep their version, including policies saved before this field existed. */
export function nextMachineShareGrants(before: GrantPolicy | null, emails: string[], domain: string | null): Record<string, string> {
  return Object.fromEntries([
    ...emails.map(email => [`email:${email}`, before?.emails.includes(email) ? grantVersion(before, `email:${email}`) : randomUUID()]),
    ...(domain ? [[`domain:${domain}`, before?.domain === domain ? grantVersion(before, `domain:${domain}`) : randomUUID()]] : []),
  ])
}
