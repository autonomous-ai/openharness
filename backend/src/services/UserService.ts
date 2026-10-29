import type { User } from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { ADMIN_EMAILS } from '../config/env.js'
import { hashPassword } from '../lib/password.js'
import { ConflictError, NotFoundError } from '../errors/index.js'
import type { AutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import type { SignInAttribution } from '../lib/signInAttribution.js'

// The Google subject and its check time (lib/googleSubject.ts) are internal: they exist to answer the
// control plane's `GET /api/grid/profile`, and must not reach every client a user is described to.
export type PublicUser = Omit<User, 'passwordHash' | 'googleSub' | 'googleSubCheckedAt'>

function toPublic(u: User): PublicUser {
  const { passwordHash: _hash, googleSub: _sub, googleSubCheckedAt: _checked, ...rest } = u
  return rest
}

function roleForEmail(email: string): string {
  return ADMIN_EMAILS.has(email.toLowerCase()) ? 'admin' : 'user'
}

const PROVISIONAL_EMAIL_DOMAIN = 'pending.harness.invalid'

export function normalizeUserEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function provisionalEmailForExternalId(externalId: string): string {
  return `device-${externalId.trim().toLowerCase()}@${PROVISIONAL_EMAIL_DOMAIN}`
}

export function isProvisionalUserEmail(email: string): boolean {
  return normalizeUserEmail(email).endsWith(`@${PROVISIONAL_EMAIL_DOMAIN}`)
}

interface SsoUserInput {
  externalId: string
  email: string
  autonomousEnv: AutonomousEnvironment
  name?: string
  roles?: string[]
  /** The tags this sign-in arrived with; stored only if it creates the account (or claims a provisional row). */
  signUpAttribution?: SignInAttribution
}

/** How long a user row read by email serves sign-ins on this server (DB optimization roadmap, Phase 2 item 7: every
 *  signed-in request and web-socket upgrade read the same user twice). Every write this service makes forgets the
 *  row at once; a write on another server is seen here within this window. */
export const USER_ROW_TTL_MS = 5_000
/** Rows kept at most; past it the oldest go first. Each is one account signed in within the last few seconds. */
const USER_ROW_MAX = 10_000

interface KeptUserRow {
  at: number
  row: Promise<User | null>
  /** Set once the read answers, so a write by id can forget it. */
  id?: string
}

// Keyed by normalized email. A read in flight is kept too, so requests arriving together share one read.
const userRowsByEmail = new Map<string, KeptUserRow>()

function forgetUserRow(by: { email?: string; id?: string }): void {
  if (by.email) userRowsByEmail.delete(normalizeUserEmail(by.email))
  // A read still in flight has no id yet and may be that account's: forget it too.
  if (by.id) for (const [email, kept] of userRowsByEmail) if (kept.id === by.id || kept.id === undefined) userRowsByEmail.delete(email)
}

function readUserByEmail(email: string): Promise<User | null> {
  const now = Date.now()
  const kept = userRowsByEmail.get(email)
  if (kept && now - kept.at < USER_ROW_TTL_MS) return kept.row
  if (kept) userRowsByEmail.delete(email)
  const entry: KeptUserRow = { at: now, row: prisma.user.findUnique({ where: { email } }) }
  // An account that is not there yet, or a failed read, is not kept: the next sign-in asks again.
  entry.row.then(
    (row) => {
      if (!row) { if (userRowsByEmail.get(email) === entry) userRowsByEmail.delete(email); return }
      entry.id = row.id
    },
    () => { if (userRowsByEmail.get(email) === entry) userRowsByEmail.delete(email) },
  )
  userRowsByEmail.set(email, entry)
  while (userRowsByEmail.size > USER_ROW_MAX) userRowsByEmail.delete(userRowsByEmail.keys().next().value!)
  return entry.row
}

async function mergeProdProvisionalUser(provisional: User, user: User): Promise<void> {
  if (provisional.id === user.id) return
  if (!isProvisionalUserEmail(provisional.email)) {
    throw new Error('Production SSO subject is already assigned to another user')
  }
  forgetUserRow({ id: provisional.id, email: provisional.email })
  await prisma.$transaction([
    prisma.deviceBinding.updateMany({
      where: { userId: provisional.id },
      data: { userId: user.id },
    }),
    prisma.user.delete({ where: { id: provisional.id } }),
  ])
}

export const userService = {
  toPublic,

  /** Production subject lookup used by the prod-only SDS device plane. */
  findByExternal(externalId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { externalId } })
  },

  /** SSO identity lookup. All callers must normalize through this boundary. Served from a row read on this server
   *  within USER_ROW_TTL_MS, so a sign-in reads its user once: for identity checks only, never for fresh data. */
  findByEmail(email: string): Promise<User | null> {
    return readUserByEmail(normalizeUserEmail(email))
  },

  /** Test seam: forget every kept user row. */
  forgetCachedUsers(): void {
    userRowsByEmail.clear()
  },

  /**
   * Mirror an authenticated SSO profile. Email is the account identity; the selected environment
   * decides which SSO subject field is refreshed. Production additionally claims a device-created
   * provisional row whose externalId already equals the authenticated subject.
   */
  async upsertFromSso(input: SsoUserInput): Promise<User> {
    const externalId = input.externalId.trim()
    const em = normalizeUserEmail(input.email)
    if (!externalId || !em) throw new Error('SSO profile is missing its subject or email')
    const signUpAttribution = input.signUpAttribution
      ? { signUpAttribution: { ...input.signUpAttribution, recordedAt: new Date() } }
      : {}
    const wantAdmin = input.roles?.includes('admin') || ADMIN_EMAILS.has(em)
    let existing = await readUserByEmail(em)

    if (!existing && input.autonomousEnv === 'prod') {
      const byExternal = await prisma.user.findUnique({ where: { externalId } })
      if (byExternal && isProvisionalUserEmail(byExternal.email)) existing = byExternal
    }

    if (existing) {
      if (input.autonomousEnv === 'prod' && existing.externalId !== externalId) {
        const currentOwner = await prisma.user.findUnique({ where: { externalId } })
        if (currentOwner && currentOwner.id !== existing.id) {
          await mergeProdProvisionalUser(currentOwner, existing)
        }
      }
      const role = existing.role === 'admin' || wantAdmin ? 'admin' : 'user'
      // Claiming a device's provisional row is this owner's first sign-in: the account starts here.
      const claimsProvisional = isProvisionalUserEmail(existing.email)
      const data = {
        ...(claimsProvisional ? signUpAttribution : {}),
        ...(existing.email !== em ? { email: em } : {}),
        ...(input.name && existing.name !== input.name ? { name: input.name } : {}),
        ...(existing.role !== role ? { role } : {}),
        // A new production subject on this row makes its stored Google subject (lib/googleSubject.ts)
        // somebody else's answer: forget it, so the account is unchecked until a live read of THIS
        // customer's profile — never answered for a QR-signed computer from the previous customer's.
        ...(input.autonomousEnv === 'prod' && existing.externalId !== externalId
          ? { externalId, googleSub: null, googleSubCheckedAt: null }
          : {}),
        ...(input.autonomousEnv === 'stag' && existing.stagExternalId !== externalId
          ? { stagExternalId: externalId }
          : {}),
      }
      // SSO profile auth runs on every control-plane request. Avoid turning that validation into a
      // write-per-request DB hot path when the mirrored user record is already current.
      if (Object.keys(data).length === 0) return existing
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data,
      })
      forgetUserRow({ id: existing.id, email: existing.email })
      forgetUserRow({ email: em })
      return updated
    }

    const data = {
      email: em,
      externalId: input.autonomousEnv === 'prod' ? externalId : `local-prod-${randomUUID()}`,
      ...(input.autonomousEnv === 'stag' ? { stagExternalId: externalId } : {}),
      name: input.name,
      role: wantAdmin ? 'admin' : 'user',
      autonomousEnv: input.autonomousEnv,
      ...signUpAttribution,
    }
    try {
      return await prisma.user.create({ data })
    } catch (err) {
      // REST and web-ws validate the same fresh token concurrently. Unique email/prod-subject indexes
      // elect one creator; the loser re-reads and applies the same idempotent mirror update.
      forgetUserRow({ email: em })
      const racedByEmail = await prisma.user.findUnique({ where: { email: em } })
      if (racedByEmail) return this.upsertFromSso(input)
      if (input.autonomousEnv === 'prod') {
        const racedByExternal = await prisma.user.findUnique({ where: { externalId } })
        if (racedByExternal && isProvisionalUserEmail(racedByExternal.email)) {
          forgetUserRow({ email: racedByExternal.email })
          return this.upsertFromSso(input)
        }
        if (racedByExternal) {
          throw new Error('Production SSO subject is already assigned to another email')
        }
      }
      throw err
    }
  },

  /**
   * Resolve the authoritative identity pair returned by the campaign device API before the owner has
   * necessarily signed in to Machine. Reuse the same email-keyed merge path as production SSO so a later
   * sign-in claims this exact row instead of creating a second user.
   */
  async findOrCreateProdDeviceOwner(externalId: string, email: string): Promise<User> {
    return this.upsertFromSso({
      externalId,
      email,
      autonomousEnv: 'prod',
    })
  },

  /** Prod-only device ownership: create a claimable user before its first SSO login. */
  async findOrCreateProdProvisional(externalId: string): Promise<User> {
    const subject = externalId.trim()
    const existing = await prisma.user.findUnique({ where: { externalId: subject } })
    if (existing) return existing
    try {
      return await prisma.user.create({
        data: {
          externalId: subject,
          email: provisionalEmailForExternalId(subject),
          role: 'user',
          autonomousEnv: 'prod',
        },
      })
    } catch (err) {
      const raced = await prisma.user.findUnique({ where: { externalId: subject } })
      if (raced) return raced
      throw err
    }
  },

  /**
   * Stamp a tagged sign-in as the latest. The acquisition (`signUpAttribution`) is written by
   * `upsertFromSso` when the sign-in creates the account, never here.
   */
  async recordSignInAttribution(userId: string, attribution: SignInAttribution): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { lastAttribution: { ...attribution, recordedAt: new Date() } },
    })
  },

  /**
   * Record what a live read of the Autonomous profile said about the account's Google subject — a
   * subject, or null for "none". Every successful live read overwrites, including to none — unless a
   * read that STARTED later has already been recorded: `readAt` is when this one began, so a slow read
   * never replaces a fresher answer. False when it was not recorded.
   *
   * ⚠️ `googleSubCheckedAt: null` alone does NOT match a row written before the field existed — on
   * MongoDB absent is not null (the trap `routes/grid.ts` documents). `isSet: false` covers those.
   */
  async recordGoogleSubject(userId: string, googleSub: string | null, readAt: Date): Promise<boolean> {
    const { count } = await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [
          { googleSubCheckedAt: null },
          { googleSubCheckedAt: { isSet: false } },
          { googleSubCheckedAt: { lt: readAt } },
        ],
      },
      data: { googleSub, googleSubCheckedAt: readAt },
    })
    if (count === 1) forgetUserRow({ id: userId })
    return count === 1
  },

  get(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } })
  },

  list(): Promise<User[]> {
    return prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
  },

  async create(input: { email: string; password: string; name?: string; role?: string; autonomousEnv?: AutonomousEnvironment }): Promise<User> {
    const email = normalizeUserEmail(input.email)
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new ConflictError('Email already exists')
    }
    return prisma.user.create({
      data: {
        // Locally-created (non-SSO) accounts still need the identity key. Mint a namespaced one so it
        // can never collide with an Autonomous SSO subject, and so two of them can coexist (a MISSING
        // field would collide on Mongo's unique index — absent counts as a value there).
        externalId: `local-${randomUUID()}`,
        email,
        passwordHash: hashPassword(input.password),
        name: input.name,
        role: input.role ?? roleForEmail(email),
        autonomousEnv: input.autonomousEnv ?? 'prod',
      },
    })
  },

  async update(id: string, input: { name?: string; password?: string; role?: string; autonomousEnv?: AutonomousEnvironment }): Promise<User> {
    const current = await prisma.user.findUnique({ where: { id } })
    if (!current) throw new NotFoundError('User')
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.autonomousEnv !== undefined ? { autonomousEnv: input.autonomousEnv } : {}),
        ...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
      },
    })
    forgetUserRow({ id, email: current.email })
    return updated
  },

  async remove(id: string): Promise<void> {
    const current = await prisma.user.findUnique({ where: { id } })
    if (!current) throw new NotFoundError('User')
    await prisma.user.delete({ where: { id } })
    forgetUserRow({ id, email: current.email })
  },
}
