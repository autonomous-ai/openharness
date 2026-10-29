/**
 * Signing a team daemon in (docs/plans/2026-10-24-swarm-team-account.md, Tasks 1 and 2).
 *
 * The owner's signed-in computer mints a single-use team handoff code (`POST /api/auth/handoff {kind:"team"}`,
 * about 90 seconds); the team daemon redeems it for a team session bound to its own computer id
 * (`POST /api/auth/handoff/redeem {code,label,computerId}`). A team session runs its own computer and the Swarm
 * agents there, and reaches none of the account's other computers: the backend enforces that, not this file.
 *
 * In the Harness Team account the code travels in a file only that account can read (owner the team account, mode
 * 600), written by setup just before the job starts; the daemon reads it, deletes it, then redeems it.
 *
 * A computer used only for agents turns ITSELF into a team machine (`harness team on`): its code is minted for its own
 * computer id, so its Swarm contributions and history survive. Only that computer may ask. A Harness computer sign-in
 * says which computer it is; an Autonomous sign-in names none, so the request carries a proof: this computer's machine
 * key on the account's device key log signs `teamConversionMessage` (the backend's, backend/src/lib/teamSession.ts).
 */
import { constants, fstatSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { b64e, sign, utf8 } from '../lib/e2ee/core.js'
import type { AuthSession } from '../lib/authSession.js'
import { HANDOFF_CODE } from './layout.js'
import { TeamSignInError } from './signInError.js'

export { TeamSignInError }

export type Post = <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<T>
export type Get = <T>(path: string, headers?: Record<string, string>) => Promise<T>
export type Delete = <T>(path: string, headers?: Record<string, string>) => Promise<T>
type SignedIn = { session: AuthSession; headers: Record<string, string> }

/** One wire form for a computer id, as the backend keeps it (`normalizeComputerId`): lowercase, without dashes. */
export const wireComputerId = (raw: string) => raw.trim().toLowerCase().replace(/-/g, '')

/** What a computer signs to turn itself into a team machine: the backend's `teamConversionMessage`, byte for byte.
 *  [at] is milliseconds since the epoch; the backend takes it within 5 minutes of its clock, once. */
export function teamConversionMessage(userId: string, computerId: string, machineId: string, at: number): string {
  return `harness team conversion v1\n${userId}\n${computerId}\n${machineId}\n${at}`
}

export interface ConversionProof { machineId: string; at: number; sig: string }

/** The proof, signed with this computer's machine key (base64 ed25519 over the UTF-8 message). */
export function teamConversionProof(input: { userId: string; computerId: string; machineId: string; at: number; priv: Uint8Array }): ConversionProof {
  const message = teamConversionMessage(input.userId, wireComputerId(input.computerId), input.machineId, input.at)
  return { machineId: input.machineId, at: input.at, sig: b64e(sign(input.priv, utf8(message))) }
}

async function signedIn(auth: () => Promise<SignedIn>): Promise<SignedIn> {
  let answer: SignedIn
  try {
    answer = await auth()
  } catch (error) {
    throw new TeamSignInError(`This computer is not signed in: ${(error as Error).message}`, 'NOT_SIGNED_IN')
  }
  if (answer.session.kind === 'team') {
    throw new TeamSignInError('This computer runs team work only, and a team sign-in cannot hand out another.', 'TEAM_SESSION')
  }
  return answer
}

/** A team handoff code from this computer's own sign-in. Refused for a team sign-in: it may not hand one out. It names this
 *  computer's machine as the Mac the team account lives on, which the backend checks is one of the account's own and the team
 *  machine records, so every list shows this Mac once (docs/plans/2026-10-24-swarm-team-account.md, "One machine"). */
export async function mintTeamHandoff(auth: () => Promise<SignedIn>, post: Post): Promise<{ code: string; expiresIn: number }> {
  const { session, headers } = await signedIn(auth)
  if (session.machineId) {
    try {
      return await requestCode(post, { kind: 'team', hostMachineId: session.machineId }, headers)
    } catch (error) {
      // A machine id the backend no longer takes as this computer's (deleted, stale): the team account still signs in,
      // listed as a machine of its own until a setup names its Mac again.
      if ((error as TeamSignInError).status !== 403) throw error
    }
  }
  return requestCode(post, { kind: 'team' }, headers)
}

export interface ConversionDeps {
  auth: () => Promise<SignedIn>
  post: Post
  get: Get
  /** This computer's machine key, the one the account's device key log holds for it; null when it has none yet.
   *  Never made here: a key made now would be on no log. */
  machineKey: () => { priv: Uint8Array } | null
  now: () => number
}

/**
 * A code that turns THIS computer into a team machine (`harness team on`), keeping its computer id. With a proof whenever
 * one can be made: a Harness computer sign-in from before the backend recorded its computer needs one too. Without one, only
 * a Harness sign-in may still ask (the backend checks the computer it recorded); an Autonomous sign-in is refused here.
 */
export async function mintTeamConversion(deps: ConversionDeps): Promise<{ code: string; expiresIn: number }> {
  const { session, headers } = await signedIn(deps.auth)
  const computerId = wireComputerId(session.computerId)
  let proof: ConversionProof | null = null
  try {
    proof = await conversionProof(deps, session, headers)
  } catch (error) {
    if (!session.accessToken.startsWith('hna_')) throw error
  }
  return requestCode(deps.post, { kind: 'team', computerId, ...(proof ? { proof } : {}) }, headers)
}

async function conversionProof(deps: ConversionDeps, session: AuthSession, headers: Record<string, string>): Promise<ConversionProof> {
  if (!session.machineId) {
    throw new TeamSignInError('This computer has not joined your account\'s machines yet. Start Harness once (harness start), then run this again.', 'NO_PROOF')
  }
  const key = deps.machineKey()
  if (!key) throw new TeamSignInError('This computer has no device key yet. Start Harness once (harness start), then run this again.', 'NO_PROOF')
  let userId: unknown
  try {
    userId = (await deps.get<{ user?: { id?: unknown } }>('/api/auth/me', headers))?.user?.id
  } catch (error) {
    throw new TeamSignInError(`Harness could not say which account this computer is signed in to: ${(error as Error).message}`, 'BACKEND')
  }
  if (typeof userId !== 'string' || !userId) throw new TeamSignInError('Harness did not say which account this computer is signed in to.', 'BACKEND')
  return teamConversionProof({ userId, computerId: session.computerId, machineId: session.machineId, at: deps.now(), priv: key.priv })
}

async function requestCode(post: Post, body: Record<string, unknown>, headers: Record<string, string>): Promise<{ code: string; expiresIn: number }> {
  let minted: { code?: unknown; expiresIn?: unknown }
  try {
    minted = await post('/api/auth/handoff', body, headers)
  } catch (error) {
    throw new TeamSignInError(`Harness would not give a team sign-in code: ${(error as Error).message}`, 'BACKEND', (error as { status?: number }).status)
  }
  if (typeof minted?.code !== 'string' || !HANDOFF_CODE.test(minted.code)) {
    throw new TeamSignInError('Harness answered without a team sign-in code.', 'BACKEND')
  }
  if ((minted as { kind?: unknown }).kind !== undefined && (minted as { kind?: unknown }).kind !== 'team') {
    throw new TeamSignInError('Harness answered with a sign-in code that is not a team one.', 'BACKEND')
  }
  return { code: minted.code, expiresIn: typeof minted.expiresIn === 'number' ? minted.expiresIn : 90 }
}

export interface TeamTokens {
  token: string
  refreshToken?: string
  expiresIn?: number
  autonomousEnv?: 'prod' | 'stag'
  /** What the backend made. Required to be `team`: see `redeemTeamHandoff`. */
  kind?: string
}

export interface RedeemDeps {
  post: Post
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to keep trying a backend that does not answer: the code lives about 90 seconds. */
  retryForMs?: number
}

/**
 * Redeem [code] for a team session for [computerId]. A refused code is final; an unreachable backend is tried
 * again until the code would have run out.
 *
 * Fails closed on what it gets back. A backend from before team sessions ignores `{kind:"team"}` when the code is
 * minted, and redeeming that code makes a phone's session, which reaches every computer on the account: far more
 * than a team session may. So the answer must say it is a team session (`kind: "team"`); anything else is signed
 * out again at once and refused.
 */
export async function redeemTeamHandoff(code: string, label: string, computerId: string, deps: RedeemDeps): Promise<TeamTokens> {
  if (!HANDOFF_CODE.test(code)) throw new TeamSignInError('The team sign-in code is not in the form Harness expects.', 'EXPIRED')
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.retryForMs ?? 60_000)
  for (let attempt = 0; ; attempt++) {
    try {
      const tokens = await deps.post<TeamTokens>('/api/auth/handoff/redeem', { code, label: label.slice(0, 80), computerId })
      if (typeof tokens?.token !== 'string' || !tokens.token) throw new TeamSignInError('Harness answered without a session.', 'BACKEND')
      if (tokens.kind !== 'team') {
        await revokeHarnessRefresh(deps.post, tokens.refreshToken)
        throw new TeamSignInError('This Harness backend does not make team sign-ins yet, so nothing was signed in.', 'NOT_TEAM')
      }
      return tokens
    } catch (error) {
      if (error instanceof TeamSignInError) throw error
      const status = (error as { status?: number }).status
      if (status !== undefined && status >= 400 && status < 500) {
        throw new TeamSignInError(`Harness refused the team sign-in code (${(error as Error).message}).`, 'EXPIRED')
      }
      if (now() >= deadline) throw new TeamSignInError(`Harness could not be reached to sign in: ${(error as Error).message}`, 'BACKEND')
      await sleep(Math.min(10_000, 1_000 * 2 ** attempt))
    }
  }
}

/** The session file for a team sign-in: the same shape `harness login` writes, marked `kind: team`. */
export function teamSession(tokens: TeamTokens, computerId: string, fallbackEnv: 'prod' | 'stag', now: number, extra: Partial<AuthSession> = {}): AuthSession {
  // `kind` is what the session file says, always team here; the backend's word for it is checked on redeem.
  return {
    version: 1,
    accessToken: tokens.token,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresIn ? { expiresAt: now + tokens.expiresIn * 1000 } : {}),
    autonomousEnv: tokens.autonomousEnv ?? fallbackEnv,
    computerId,
    ...extra,
    kind: 'team',
    updatedAt: now,
  }
}

/** Sign a Harness-issued session out on the backend: a computer's or a phone's (`hnr_`), or a team one (`htr_`). Best
 *  effort: an Autonomous sign-in is not ours to revoke. */
export async function revokeHarnessRefresh(post: Post, refreshToken: string | undefined): Promise<boolean> {
  if (!refreshToken?.startsWith('hnr_') && !refreshToken?.startsWith('htr_')) return false
  try {
    await post('/api/auth/revoke', { refreshToken })
    return true
  } catch {
    return false
  }
}

export interface HandoffFileDeps {
  open(path: string): number
  fstat(fd: number): { isFile(): boolean; uid: number; mode: number; size: number }
  read(fd: number, buffer: Buffer): number
  close(fd: number): void
  unlink(path: string): void
  euid(): number
}

export const realHandoffFileDeps: HandoffFileDeps = {
  // Never through a link, and without blocking on a FIFO someone left in its place.
  open: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, 0),
  close: (fd) => closeSync(fd),
  unlink: (path) => unlinkSync(path),
  euid: () => process.geteuid?.() ?? -1,
}

/**
 * The code in [path], read once and deleted, or null when there is none. The file must be this account's own, a
 * plain file, and readable by nobody else; anything else is deleted unread and refused.
 */
export function takeHandoffFile(path: string, deps: HandoffFileDeps = realHandoffFileDeps): string | null {
  let fd: number
  try {
    fd = deps.open(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    try { deps.unlink(path) } catch { /* nothing more to do */ }
    throw new TeamSignInError(`The team sign-in file could not be opened safely (${(error as NodeJS.ErrnoException).code ?? 'error'}); it was deleted.`, 'UNSAFE_FILE')
  }
  let text = ''
  let safe = false
  try {
    const stat = deps.fstat(fd)
    safe = stat.isFile() && stat.uid === deps.euid() && (stat.mode & 0o077) === 0 && stat.size <= 4096
    if (safe) {
      const buffer = Buffer.alloc(4096)
      text = buffer.subarray(0, deps.read(fd, buffer)).toString('utf8').trim()
    }
  } finally {
    deps.close(fd)
    try { deps.unlink(path) } catch { /* already gone */ }
  }
  if (!safe) throw new TeamSignInError('The team sign-in file was not this account\'s private file; it was deleted unread.', 'UNSAFE_FILE')
  if (!HANDOFF_CODE.test(text)) throw new TeamSignInError('The team sign-in file did not hold a sign-in code; it was deleted.', 'UNSAFE_FILE')
  return text
}
