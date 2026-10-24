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
 */
import { constants, fstatSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import type { AuthSession } from '../lib/authSession.js'
import { HANDOFF_CODE } from './layout.js'

export type Post = <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<T>

export class TeamSignInError extends Error {
  constructor(message: string, readonly code: 'NOT_SIGNED_IN' | 'TEAM_SESSION' | 'EXPIRED' | 'BACKEND' | 'UNSAFE_FILE') {
    super(message)
    this.name = 'TeamSignInError'
  }
}

/** A team handoff code from this computer's own sign-in. Refused for a team sign-in: it may not hand one out. */
export async function mintTeamHandoff(
  auth: () => Promise<{ session: AuthSession; headers: Record<string, string> }>, post: Post,
): Promise<{ code: string; expiresIn: number }> {
  let signedIn: { session: AuthSession; headers: Record<string, string> }
  try {
    signedIn = await auth()
  } catch (error) {
    throw new TeamSignInError(`This computer is not signed in: ${(error as Error).message}`, 'NOT_SIGNED_IN')
  }
  if (signedIn.session.kind === 'team') {
    throw new TeamSignInError('This computer runs team work only, and a team sign-in cannot hand out another.', 'TEAM_SESSION')
  }
  let minted: { code?: unknown; expiresIn?: unknown }
  try {
    minted = await post('/api/auth/handoff', { kind: 'team' }, signedIn.headers)
  } catch (error) {
    throw new TeamSignInError(`Harness would not give a team sign-in code: ${(error as Error).message}`, 'BACKEND')
  }
  if (typeof minted?.code !== 'string' || !HANDOFF_CODE.test(minted.code)) {
    throw new TeamSignInError('Harness answered without a team sign-in code.', 'BACKEND')
  }
  return { code: minted.code, expiresIn: typeof minted.expiresIn === 'number' ? minted.expiresIn : 90 }
}

export interface TeamTokens {
  token: string
  refreshToken?: string
  expiresIn?: number
  autonomousEnv?: 'prod' | 'stag'
}

export interface RedeemDeps {
  post: Post
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to keep trying a backend that does not answer: the code lives about 90 seconds. */
  retryForMs?: number
}

/** Redeem [code] for a team session for [computerId]. A refused code is final; an unreachable backend is tried
 *  again until the code would have run out. */
export async function redeemTeamHandoff(code: string, label: string, computerId: string, deps: RedeemDeps): Promise<TeamTokens> {
  if (!HANDOFF_CODE.test(code)) throw new TeamSignInError('The team sign-in code is not in the form Harness expects.', 'EXPIRED')
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.retryForMs ?? 60_000)
  for (let attempt = 0; ; attempt++) {
    try {
      const tokens = await deps.post<TeamTokens>('/api/auth/handoff/redeem', { code, label: label.slice(0, 80), computerId })
      if (typeof tokens?.token !== 'string' || !tokens.token) throw new TeamSignInError('Harness answered without a session.', 'BACKEND')
      return tokens
    } catch (error) {
      if (error instanceof TeamSignInError) throw error
      const status = (error as { status?: number }).status
      if (status !== undefined && status >= 400 && status < 500) {
        throw new TeamSignInError(`The team sign-in code was refused (${(error as Error).message}). Run \`harness team setup\` again for a new one.`, 'EXPIRED')
      }
      if (now() >= deadline) throw new TeamSignInError(`Harness could not be reached to sign in: ${(error as Error).message}`, 'BACKEND')
      await sleep(Math.min(10_000, 1_000 * 2 ** attempt))
    }
  }
}

/** The session file for a team sign-in: the same shape `harness login` writes, marked `kind: team`. */
export function teamSession(tokens: TeamTokens, computerId: string, fallbackEnv: 'prod' | 'stag', now: number, extra: Partial<AuthSession> = {}): AuthSession {
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

/** Sign a Harness-issued session out on the backend. Best effort: an Autonomous sign-in is not ours to revoke. */
export async function revokeHarnessRefresh(post: Post, refreshToken: string | undefined): Promise<boolean> {
  if (!refreshToken?.startsWith('hnr_')) return false
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
