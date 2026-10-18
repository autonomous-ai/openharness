import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const emailSchema = z.string().trim().toLowerCase().email().max(254)
export const inviteSchema = z.object({
  emails: z.array(emailSchema).min(1).max(20),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
})
const grantSchema = z.object({
  id: z.string().uuid(), machineId: z.string().min(1), agentId: z.string().min(1),
  recipientEmail: emailSchema, name: z.string(), engine: z.string().nullable(),
  ownerPublicKey: z.string(), expiresAt: z.string().datetime(), createdAt: z.string().datetime(),
  revoked: z.boolean().default(false), pending: z.boolean().default(false),
  publicationError: z.string().nullable().default(null),
  // The shared tab a derived grant came from (sharing/rosterGrants.ts); null for one a person made in the Share
  // dialog, and for every grant saved before shared tabs.
  tab: z.string().nullable().default(null),
  // When the backend last refused it: a derived grant is tried again from then on (`derive`'s `retryFailedBefore`).
  failedAt: z.number().nullable().default(null),
})
export type HarnessGrant = z.infer<typeof grantSchema>
/** An observer a shared tab's roster wants for one of this machine's harnesses (`derive`). */
export interface DerivedGrant { agentId: string; email: string; tab: string; name: string; engine: string | null; ownerPublicKey: string }
/** The backend's bounds on a share's name (backend/src/routes/harnessShares.ts): a roster allows 200 characters, and
 *  an empty one once its control characters are taken out. */
const shareName = (name: string): string => name.trim().slice(0, 160) || 'Harness'

/** Durable owner-side authority. Revocation is saved before it can close observers or call a relay. */
export class HarnessGrantStore {
  private grants: HarnessGrant[]
  constructor(private readonly path: string, private readonly now = () => Date.now()) {
    try { this.grants = z.array(grantSchema).parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The harness sharing permissions file could not be read.')
      this.grants = []
    }
  }
  private save(next: HarnessGrant[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.path)
    this.grants = next
  }
  all(): HarnessGrant[] { return this.grants.map(g => ({ ...g })) }
  active(id: string, email: string, machineId: string): HarnessGrant | null {
    const grant = this.grants.find(g => g.id === id && g.machineId === machineId
      && g.recipientEmail === email && !g.revoked && !g.publicationError && Date.parse(g.expiresAt) > this.now())
    return grant ? { ...grant } : null
  }
  /** The live grants a person made for a harness: the Share dialog's list, what a private link counts as invited and
   *  what turning a link off takes back. A shared tab's derived grants are the tab's, and never among them. */
  list(machineId: string, agentId: string): HarnessGrant[] {
    return this.all().filter(g => g.machineId === machineId && g.agentId === agentId && !g.revoked && g.tab === null)
  }
  invite(input: Omit<HarnessGrant, 'id' | 'createdAt' | 'pending' | 'revoked' | 'publicationError' | 'tab' | 'failedAt'>): HarnessGrant {
    const previous = this.grants.find(g => g.machineId === input.machineId && g.agentId === input.agentId
      && g.recipientEmail === input.recipientEmail)
    const grant = grantSchema.parse({ ...input, id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(), pending: true, revoked: false, publicationError: null })
    this.save([...this.grants.filter(g => g.id !== grant.id), grant])
    return { ...grant }
  }
  synced(id: string): void {
    this.save(this.grants.map(g => g.id === id ? { ...g, pending: false } : g))
  }
  failed(id: string, publicationError: string): void {
    this.save(this.grants.map(g => g.id === id ? { ...g, pending: false, publicationError, failedAt: this.now() } : g))
  }
  /** A person's removal: a derived grant is refused, the tab's roster decides it (`derive`). */
  revoke(id: string, machineId: string, agentId: string): boolean {
    const found = this.grants.some(g => g.id === id && g.machineId === machineId && g.agentId === agentId && g.tab === null)
    if (found) this.save(this.grants.map(g => g.id === id ? { ...g, revoked: true, pending: true } : g))
    return found
  }
  /**
   * Bring this machine's derived grants to what the rosters want: invite each one missing, publish again one renamed
   * or within `renewBefore` of its expiry, and revoke each derived grant no longer wanted, all in one save. A live grant a
   * person made wins for the same harness and email and is never touched; a revoked one may be taken over. Each
   * (machine, harness, email) keeps one id for good, so a member removed and added again is the same share to the
   * backend and to their inventory. One email in several tabs is granted once, under the first tab that lists it.
   * A derived grant the backend refused at or before `retryFailedBefore` is published again: the person never sees it
   * in the Share list to retry it, and a refusal that has passed (a machine available again) must not last until renewal.
   */
  derive(machineId: string, want: DerivedGrant[], expiresAt: string, renewBefore: number, retryFailedBefore = -Infinity): { invited: HarnessGrant[]; revoked: HarnessGrant[] } {
    const wanted = new Map<string, DerivedGrant>()
    for (const w of want) {
      // A roster's email is the owner's word, up to 254 characters of anything: one the backend would refuse is left out.
      const email = emailSchema.safeParse(w.email)
      if (!email.success) continue
      const key = `${w.agentId}\n${email.data}`
      if (!wanted.has(key)) wanted.set(key, { ...w, email: email.data, name: shareName(w.name) })
    }
    const invited: HarnessGrant[] = [], revoked: HarnessGrant[] = []
    let next = this.grants.map(g => {
      if (g.machineId !== machineId || g.tab === null || g.revoked || wanted.has(`${g.agentId}\n${g.recipientEmail}`)) return g
      const gone = { ...g, revoked: true, pending: true }
      revoked.push(gone)
      return gone
    })
    for (const w of wanted.values()) {
      const previous = next.find(g => g.machineId === machineId && g.agentId === w.agentId && g.recipientEmail === w.email)
      if (previous && !previous.revoked && (previous.tab === null || (previous.tab === w.tab && previous.name === w.name
        && previous.engine === w.engine && Date.parse(previous.expiresAt) - this.now() > renewBefore
        && !(previous.publicationError !== null && (previous.failedAt ?? 0) <= retryFailedBefore)))) continue
      const grant = grantSchema.parse({ id: previous?.id ?? randomUUID(), machineId, agentId: w.agentId, recipientEmail: w.email,
        name: w.name, engine: w.engine, ownerPublicKey: w.ownerPublicKey, expiresAt,
        createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(), pending: true, revoked: false, publicationError: null, tab: w.tab })
      next = [...next.filter(g => g.id !== grant.id), grant]
      invited.push({ ...grant })
    }
    if (invited.length || revoked.length) this.save(next)
    return { invited, revoked }
  }
}
