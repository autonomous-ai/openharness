import type { MachineShare } from '@prisma/client'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'

export type ShareVia = 'email' | 'domain'

/** The shared policy decision, usable inside a transaction without opening Redis connections. */
export function sharedVia(share: Pick<MachineShare, 'emails' | 'domain'>, email: string): ShareVia | null {
  const address = email.trim().toLowerCase()
  if (share.emails.includes(address)) return 'email'
  const domain = emailDomain(address)
  return share.domain && domain === share.domain && !isPublicEmailDomain(domain) ? 'domain' : null
}
