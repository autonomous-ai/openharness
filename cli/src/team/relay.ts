/**
 * The owner's Claude Code and Codex subscriptions for the Harness Team account, without signing it in.
 *
 * Teammates' agents run in the team account (docs/plans/2026-10-24-swarm-team-account.md), which had to sign Claude Code
 * and Codex in on its own before any of them could start: a step the owner had to take in a terminal on that Mac, and
 * the Lead routed nothing there until they did (superTabs/routeCommand.ts `unreadyPool`). Machine sharing already lets a
 * guest's agent spend the owner's subscription through the owner subscription relay (lib/subscriptionRelay.ts), which
 * holds the owner's sign-ins in the owner's own daemon and hands out only revocable loopback tokens. The team account
 * uses the same relay:
 *
 * - The owner's daemon keeps a relay of its own for the team account while one exists on this Mac, and leaves its address
 *   and token in a folder it owns under /Users/Shared, readable by the team account alone through a macOS ACL. Not
 *   a guest's, not any other local user's: the token spends the owner's subscription.
 * - The team daemon reads it at each launch, only when the folder and the file belong to the owner the root-owned team
 *   config names (another local user could otherwise leave a relay of their own there and read teammates' prompts), and
 *   only for an engine the team account has not signed in itself: a sign-in of its own wins.
 *
 * ⚠️ The token is never logged, and lives only in the file and in the launched engine's environment.
 */
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { recordAcceptanceIn } from '../engines/kit/folderTrust.js'
import { readAuthSession } from '../lib/authSession.js'
import { engineAccount } from '../lib/engineAccount.js'
import { claudeRelayEnv, codexRelayArgs, codexRelayEnv, codexRelayAuth, codexRelaySignInArgs, isCodexRelayAuth, type SubscriptionRelay } from '../lib/subscriptionRelay.js'
import { readTeamConfig, type TeamConfig } from './config.js'

/** The owner's folder for the hand-off, per owner so two people's Macs never share one. */
export const teamRelayDir = (owner: string) => `/Users/Shared/.harness-team-relay-${owner}`
export const teamRelayFile = (owner: string) => join(teamRelayDir(owner), 'relay.json')
/** The name the relay knows the team account's token by, in its logs (a fingerprint of it) and to revoke it. */
export const TEAM_RELAY_GUEST = 'harness-team'

export interface TeamRelayGrant { url: string; token: string }

/** A relay's address as `startSubscriptionRelay` makes it: loopback, a port, nothing else. */
const RELAY_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/

// ── The owner's daemon ────────────────────────────────────────────────────────────────────────

export interface TeamRelayPublisherDeps {
  config(): TeamConfig | null
  /** This daemon's OS user. */
  user(): string
  /** Whether this daemon runs team work only: it never publishes. */
  team(): boolean
  startRelay(): Promise<SubscriptionRelay>
  publish(config: TeamConfig, grant: TeamRelayGrant): Promise<void>
  /** Whether the published file is still there (someone may have removed the folder). */
  published(config: TeamConfig): boolean
  withdraw(owner: string): void
  log(line: string): void
  intervalMs?: number
  now?: () => number
  /** After each look, with when the relay was last published (null before): a team account on a build too old for it
   *  is updated (./refresh.ts). */
  afterPass?: (publishedAt: number | null) => Promise<void>
}

/** How often the owner's daemon looks again: a team account set up later gets its relay within this long. */
export const TEAM_RELAY_CHECK_MS = 60_000

export class TeamRelayPublisher {
  private timer: ReturnType<typeof setInterval> | null = null
  private relay: Promise<SubscriptionRelay> | null = null
  private grant: TeamRelayGrant | null = null
  private owner: string | null = null
  private running: Promise<void> | null = null
  private publishedAt: number | null = null
  constructor(private readonly deps: TeamRelayPublisherDeps) {}

  start(): void {
    if (this.timer || this.deps.team()) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? TEAM_RELAY_CHECK_MS)
    this.timer.unref?.()
  }

  tick(): Promise<void> {
    return this.running ??= this.pass().catch((error: unknown) => {
      this.deps.log(`team relay: ${error instanceof Error ? error.message : String(error)}`)
    }).then(() => this.owner ? this.deps.afterPass?.(this.publishedAt) : undefined).finally(() => { this.running = null })
  }

  private async pass(): Promise<void> {
    if (this.deps.team()) return
    const config = this.deps.config()
    // Only the Mac's owner's daemon holds the owner's sign-ins: another account's daemon on this Mac publishes nothing.
    if (!config || config.owner !== this.deps.user()) { await this.close(); return }
    if (this.grant && this.owner === config.owner && this.deps.published(config)) return
    this.relay ??= this.deps.startRelay()
    // A relay that could not start is started again on the next pass.
    const relay = await this.relay.catch((error: unknown) => { this.relay = null; throw error })
    this.grant ??= { url: relay.url, token: relay.mintToken(TEAM_RELAY_GUEST) }
    await this.deps.publish(config, this.grant)
    this.publishedAt = (this.deps.now ?? Date.now)()
    this.owner = config.owner
    this.deps.log('team relay: the Harness Team account uses this Mac\'s subscriptions')
  }

  private async close(): Promise<void> {
    if (this.owner) this.deps.withdraw(this.owner)
    this.owner = null
    this.grant = null
    this.publishedAt = null
    const relay = await this.relay?.catch(() => null)
    this.relay = null
    await relay?.close()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
    await this.close()
  }
}

/** Grants [user] what macOS calls [rights] on [path], and nobody else beyond the owner (the mode says the rest). */
const allow = (path: string, user: string, rights: string) => new Promise<void>((resolve, reject) => {
  // `-N` first: each publish sets the one entry again rather than adding a copy of it.
  execFile('/bin/chmod', ['-N', path], () => {
    execFile('/bin/chmod', ['+a', `user:${user} allow ${rights}`, path], (error) => error ? reject(new Error(`could not let ${user} read ${path}`)) : resolve())
  })
})

/** Writes the grant where only the team account (and this user) can read it. */
export async function publishTeamRelay(config: TeamConfig, grant: TeamRelayGrant, uid: number = process.getuid?.() ?? -1,
  grantRead: (path: string, user: string, rights: string) => Promise<void> = allow, dir: string = teamRelayDir(config.owner)): Promise<void> {
  try { mkdirSync(dir, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  // /Users/Shared lets anyone make a folder: one this user did not make is someone else's, and is left alone.
  const folder = lstatSync(dir)
  if (!folder.isDirectory() || folder.uid !== uid) throw new Error(`${dir} is not this account's: the Harness Team account cannot use this Mac's subscriptions`)
  chmodSync(dir, 0o700)
  await grantRead(dir, config.user, 'list,search,readattr')
  const next = join(dir, `.relay.${process.pid}.next`)
  writeFileSync(next, `${JSON.stringify(grant)}\n`, { mode: 0o600 })
  await grantRead(next, config.user, 'read,readattr')
  renameSync(next, join(dir, 'relay.json'))
}

export function withdrawTeamRelay(owner: string): void {
  rmSync(teamRelayFile(owner), { force: true })
}

export const teamRelayPublished = (config: TeamConfig, exists: (path: string) => boolean = (path) => {
  try { lstatSync(path); return true } catch { return false }
}) => exists(teamRelayFile(config.owner))

export function realTeamRelayPublisher(startRelay: () => Promise<SubscriptionRelay>, config: () => TeamConfig | null,
  team: () => boolean, log: (line: string) => void, afterPass?: (publishedAt: number | null) => Promise<void>): TeamRelayPublisher {
  return new TeamRelayPublisher({
    ...(afterPass ? { afterPass } : {}),
    // Tests inject a publisher: a test never reads this Mac's own team account, starts a relay on the owner's sign-ins,
    // or writes to /Users/Shared (a service spec did, 2026-10-27). Production never has VITEST set.
    config: () => process.env.VITEST ? null : config(),
    team, startRelay, log,
    user: () => userInfo().username,
    publish: (c, grant) => publishTeamRelay(c, grant),
    published: (c) => teamRelayPublished(c),
    withdraw: withdrawTeamRelay,
  })
}

// ── The team daemon ───────────────────────────────────────────────────────────────────────────

export interface TeamRelayReadDeps {
  lstat(path: string): { uid: number; mode: number; isDirectory(): boolean; isFile(): boolean }
  /** The owner's uid, from their home folder (the team account may look at it, not into it). */
  ownerUid(home: string): number
  /** The file's text, refusing a link. */
  read(path: string): string
}

const realReadDeps: TeamRelayReadDeps = {
  lstat: (path) => lstatSync(path),
  ownerUid: (home) => statSync(home).uid,
  read: (path) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const size = Math.min(fstatSync(fd).size, 4096)
      const buffer = Buffer.alloc(size)
      readSync(fd, buffer, 0, size, 0)
      return buffer.toString('utf8')
    } finally { closeSync(fd) }
  },
}

/** The owner's relay for this team account, when the owner's daemon left one; null otherwise. */
export function readTeamRelay(config: TeamConfig, deps: TeamRelayReadDeps = realReadDeps): TeamRelayGrant | null {
  try {
    const owner = deps.ownerUid(config.ownerHome)
    const dir = deps.lstat(teamRelayDir(config.owner))
    if (!dir.isDirectory() || dir.uid !== owner || (dir.mode & 0o022) !== 0) return null
    const file = deps.lstat(teamRelayFile(config.owner))
    if (!file.isFile() || file.uid !== owner || (file.mode & 0o077) !== 0) return null
    const value = JSON.parse(deps.read(teamRelayFile(config.owner))) as Record<string, unknown>
    if (typeof value.url !== 'string' || !RELAY_URL.test(value.url) || typeof value.token !== 'string' || !TOKEN.test(value.token)) return null
    return { url: value.url, token: value.token }
  } catch {
    return null
  }
}

/** What a Claude Code or Codex launch adds to spend the owner's subscription through the relay. */
export interface OwnerRelayLaunch { env: Record<string, string>; args: string[] }

export interface TeamRelayLaunchDeps {
  /** Whether this daemon runs team work only. */
  team(): boolean
  config(): TeamConfig | null
  /** Whether the team account signed this engine in itself. */
  signedIn(engine: 'claude' | 'codex'): Promise<boolean>
  read(config: TeamConfig): TeamRelayGrant | null
  /** Claude Code that never ran in the team account opens on its first-run screens, which nobody is there to answer:
   *  recorded as done, in the team account's own home, before the first launch on the relay. */
  onboarded(engine: 'claude' | 'codex'): void
  /** Codex's sign-in for the relay (lib/subscriptionRelay.ts codexRelayAuth), in the team account's own Codex home;
   *  false when it could not be written. */
  codexSignIn(token: string): boolean
}

/** In the team daemon, for an engine it has not signed in itself: the owner's relay, when there is one. */
export async function teamRelayLaunch(engine: AgentEngine, deps: TeamRelayLaunchDeps): Promise<OwnerRelayLaunch | null> {
  if (engine !== 'claude' && engine !== 'codex') return null
  if (!deps.team()) return null
  const config = deps.config()
  if (!config) return null
  if (await deps.signedIn(engine).catch(() => false)) return null
  const grant = deps.read(config)
  if (!grant) return null
  try { deps.onboarded(engine) } catch { /* The engine asks on its screen, as it would have. */ }
  if (engine === 'claude') return { env: claudeRelayEnv(grant.url, grant.token), args: [] }
  // As a ChatGPT sign-in, so Codex has the owner's models (codexRelaySignInArgs); as an API key, as before, when the
  // sign-in could not be written.
  let signIn = false
  try { signIn = deps.codexSignIn(grant.token) } catch { signIn = false }
  return { env: codexRelayEnv(grant.token), args: signIn ? codexRelaySignInArgs(grant.url) : codexRelayArgs(grant.url) }
}

/** Writes the relay's sign-in to [dir]/auth.json, unless a sign-in of the account's own is there. Private to the account. */
export function writeCodexRelaySignIn(dir: string, token: string, now: number): boolean {
  const file = join(dir, 'auth.json')
  let existing: unknown = null
  try { existing = JSON.parse(readFileSync(file, 'utf8')) } catch { existing = null }
  if (existing && !isCodexRelayAuth(existing)) return false
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const next = `${file}.harness-relay-${process.pid}`
  writeFileSync(next, codexRelayAuth(token, now), { mode: 0o600 })
  renameSync(next, file)
  return true
}

/** The team daemon's own: its sign-in, the root-owned config, its engines' sign-ins in its own home. */
export const realTeamRelayLaunch = (engine: AgentEngine) => teamRelayLaunch(engine, {
  team: () => readAuthSession()?.kind === 'team',
  config: () => readTeamConfig(),
  // Only presence is read, never a secret (lib/engineAccount.ts); the team daemon has no login shell to read.
  signedIn: async (e) => (await engineAccount(e, { home: homedir(), env: process.env, lastUsed: false })).signedIn === true,
  read: (config) => readTeamRelay(config),
  onboarded: (e) => { if (e === 'claude') recordAcceptanceIn(join(homedir(), '.claude.json'), 'hasCompletedOnboarding') },
  codexSignIn: (token) => writeCodexRelaySignIn(process.env.CODEX_HOME || join(homedir(), '.codex'), token, Date.now()),
})

/** In the team daemon: whether the owner's relay is there for its engines (superTabs/machines.ts readiness). */
export const teamRelayed = (): boolean => {
  if (readAuthSession()?.kind !== 'team') return false
  const config = readTeamConfig()
  return !!config && !!readTeamRelay(config)
}
