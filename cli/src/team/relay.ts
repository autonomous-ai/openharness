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
 *   a guest's, not any other local user's: the token spends the owner's subscription. On Linux the folder is one setup made
 *   for the owner under /var/lib/harness, and the ACL is setfacl's.
 * - The team daemon reads it at each launch, only when the folder and the file belong to the owner the root-owned team
 *   config names (another local user could otherwise leave a relay of their own there and read teammates' prompts), and
 *   only for an engine the team account has not signed in itself: a sign-in of its own wins.
 *
 * ⚠️ The token is never logged, and lives only in the file and in the launched engine's environment.
 */
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, win32 } from 'node:path'
import { runPowershell } from '../lib/windows/powershell.js'
import { windowsOwnerSidScript, windowsRelayAclCommand } from './windowsTeam.js'
import type { AgentEngine } from '../engines/types.js'
import { recordAcceptanceIn } from '../engines/kit/folderTrust.js'
import { readAuthSession } from '../lib/authSession.js'
import { engineAccount } from '../lib/engineAccount.js'
import { claudeRelayEnv, codexRelayArgs, codexRelayEnv, type SubscriptionRelay } from '../lib/subscriptionRelay.js'
import { readTeamConfig, type TeamConfig } from './config.js'
import { teamLayout } from './layout.js'

/** The owner's folder for the hand-off, per owner so two people's Macs never share one (./layout.ts `relayDir`). On Linux
 *  setup makes it for the owner, under /var/lib/harness, where nobody else can make a folder. A Mac's unless told. */
export const teamRelayDir = (owner: string, platform: NodeJS.Platform = 'darwin') =>
  (teamLayout(platform) ?? teamLayout('darwin')!).relayDir(owner)
export const teamRelayFile = (owner: string, platform: NodeJS.Platform = 'darwin') => join(teamRelayDir(owner, platform), 'relay.json')
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

const execFileAsync = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (error) => error ? reject(error) : resolve())
})

/**
 * Linux: the whole ACL of [path], set at once (`--set`, so each publish leaves exactly these entries): this user, and
 * [user] reading, as the guest helper grants with setfacl. A folder is read and searched (r-x), a file read (r--).
 */
export const setfaclGrant = (exec: (file: string, args: string[]) => Promise<void> = execFileAsync) =>
  async (path: string, user: string, rights: string): Promise<void> => {
    const folder = rights.split(',').includes('search')
    const acl = `u::${folder ? 'rwx' : 'rw-'},g::---,o::---,u:${user}:${folder ? 'r-x' : 'r--'}`
    try { await exec('setfacl', ['--set', acl, path]) } catch { throw new Error(`could not let ${user} read ${path}`) }
  }

/** This system's way to let the team account read the relay. */
const grantFor = (platform: NodeJS.Platform) => platform === 'linux' ? setfaclGrant() : allow

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

// ── Windows ───────────────────────────────────────────────────────────────────────────────────
// Setup makes the folder for the owner in C:\ProgramData\Harness, where only administrators may make one, and gives it to
// them (./windowsScript.ts step 7). Node's lstat names no owner on Windows, so both sides ask Windows for the owner's SID.

export interface WindowsRelayFs {
  lstat(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
  /** The path's owner as a SID, or null when it cannot be read. */
  ownerSid(path: string): string | null
  /** The folder's whole ACL: the owner, SYSTEM and Administrators full, the team account read (./windowsTeam.ts). */
  setAcl(dir: string, ownerSid: string, team: string): Promise<void>
  write(path: string, text: string): void
  rename(from: string, to: string): void
  read(path: string): string
}

/** Owner SIDs a reader looked up lately: the team daemon reads the relay for every launch and machine reading, and each
 *  answer costs a PowerShell. A minute is as stale as a folder's owner gets here. */
const ownerSids = new Map<string, { sid: string | null; at: number }>()
const OWNER_SID_FOR_MS = 60_000

const realWindowsRelayFs: WindowsRelayFs = {
  lstat: (path) => lstatSync(path),
  ownerSid: (path) => {
    const cached = ownerSids.get(path)
    if (cached && Date.now() - cached.at < OWNER_SID_FOR_MS) return cached.sid
    const query = windowsOwnerSidScript(path)
    const result = runPowershell(query.script, query.inputs)
    const sid = result.status === 0 ? result.stdout.trim() : null
    ownerSids.set(path, { sid, at: Date.now() })
    return sid
  },
  setAcl: (dir, ownerSid, team) => {
    const { command, args } = windowsRelayAclCommand({ dir, ownerSid, team })
    return execFileAsync(command, args).catch(() => { throw new Error(`could not let ${team} read ${dir}`) })
  },
  write: (path, text) => writeFileSync(path, text),
  rename: (from, to) => renameSync(from, to),
  read: (path) => readFileSync(path, 'utf8').slice(0, 4096),
}

const plainFolder = (fs: WindowsRelayFs, path: string) => { const s = fs.lstat(path); return s.isDirectory() && !s.isSymbolicLink() }
const plainFile = (fs: WindowsRelayFs, path: string) => { const s = fs.lstat(path); return s.isFile() && !s.isSymbolicLink() }

/** Windows: the grant, in the owner's folder setup made, readable by the team account through the folder's ACL. */
export async function publishWindowsTeamRelay(config: TeamConfig, grant: TeamRelayGrant, fs: WindowsRelayFs = realWindowsRelayFs,
  dir: string = teamRelayDir(config.owner, 'win32')): Promise<void> {
  const mine = (() => { try { return plainFolder(fs, dir) && !!config.ownerSid && fs.ownerSid(dir) === config.ownerSid } catch { return false } })()
  if (!mine) throw new Error(`${dir} is not this account's: harness team setup makes it, and the Harness Team account cannot use this computer's subscriptions until then`)
  await fs.setAcl(dir, config.ownerSid!, config.user)
  // Made in the folder, so it takes the folder's ACL, then renamed over the last one: a reader never sees half of it.
  const next = win32.join(dir, `.relay.${process.pid}.next`)
  fs.write(next, `${JSON.stringify(grant)}\n`)
  fs.rename(next, win32.join(dir, 'relay.json'))
}

/** Windows, in the team daemon: the owner's relay, when the folder and the file are the configured owner's; else null. */
export function readWindowsTeamRelay(config: TeamConfig, fs: WindowsRelayFs = realWindowsRelayFs, dir: string = teamRelayDir(config.owner, 'win32')): TeamRelayGrant | null {
  try {
    const owner = config.ownerSid
    const file = win32.join(dir, 'relay.json')
    if (!owner || !plainFolder(fs, dir) || fs.ownerSid(dir) !== owner || !plainFile(fs, file) || fs.ownerSid(file) !== owner) return null
    const value = JSON.parse(fs.read(file)) as Record<string, unknown>
    if (typeof value.url !== 'string' || !RELAY_URL.test(value.url) || typeof value.token !== 'string' || !TOKEN.test(value.token)) return null
    return { url: value.url, token: value.token }
  } catch {
    return null
  }
}

export function withdrawTeamRelay(owner: string, platform: NodeJS.Platform = 'darwin'): void {
  rmSync(teamRelayFile(owner, platform), { force: true })
}

export const teamRelayPublished = (config: TeamConfig, exists: (path: string) => boolean = (path) => {
  try { lstatSync(path); return true } catch { return false }
}, platform: NodeJS.Platform = 'darwin') => exists(teamRelayFile(config.owner, platform))

export function realTeamRelayPublisher(startRelay: () => Promise<SubscriptionRelay>, config: () => TeamConfig | null,
  team: () => boolean, log: (line: string) => void, afterPass?: (publishedAt: number | null) => Promise<void>): TeamRelayPublisher {
  return new TeamRelayPublisher({
    ...(afterPass ? { afterPass } : {}),
    // Tests inject a publisher: a test never reads this Mac's own team account, starts a relay on the owner's sign-ins,
    // or writes to /Users/Shared (a service spec did, 2026-10-27). Production never has VITEST set.
    config: () => process.env.VITEST ? null : config(),
    team, startRelay, log,
    user: () => userInfo().username,
    publish: (c, grant) => process.platform === 'win32' ? publishWindowsTeamRelay(c, grant)
      : publishTeamRelay(c, grant, process.getuid?.() ?? -1, grantFor(process.platform), teamRelayDir(c.owner, process.platform)),
    published: (c) => teamRelayPublished(c, undefined, process.platform),
    withdraw: (owner) => withdrawTeamRelay(owner, process.platform),
  })
}

// ── The team daemon ───────────────────────────────────────────────────────────────────────────

export interface TeamRelayReadDeps {
  lstat(path: string): { uid: number; mode: number; isDirectory(): boolean; isFile(): boolean }
  /** The owner's uid, from their home folder (the team account may look at it, not into it). */
  ownerUid(home: string): number
  /** The file's text, refusing a link. */
  read(path: string): string
  /** Where the folder is, and how its ACL shows in the mode: a Mac's unless told. */
  platform?: NodeJS.Platform
}

const realReadDeps: TeamRelayReadDeps = {
  platform: process.platform,
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
  // Windows has no uid or mode to check: the owners' SIDs, asked of Windows.
  if (deps === realReadDeps && process.platform === 'win32') return readWindowsTeamRelay(config)
  try {
    const platform = deps.platform ?? 'darwin'
    const owner = deps.ownerUid(config.ownerHome)
    const dir = deps.lstat(teamRelayDir(config.owner, platform))
    if (!dir.isDirectory() || dir.uid !== owner || (dir.mode & 0o022) !== 0) return null
    const file = deps.lstat(teamRelayFile(config.owner, platform))
    // On Linux the group bits of a file with an ACL are its mask, r-- once the team account may read it: the group itself
    // gets nothing (./relay.ts setfaclGrant). Writable or anyone's, it is not the owner's alone.
    const closed = platform === 'linux' ? 0o037 : 0o077
    if (!file.isFile() || file.uid !== owner || (file.mode & closed) !== 0) return null
    const value = JSON.parse(deps.read(teamRelayFile(config.owner, platform))) as Record<string, unknown>
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
  return engine === 'claude'
    ? { env: claudeRelayEnv(grant.url, grant.token), args: [] }
    : { env: codexRelayEnv(grant.token), args: codexRelayArgs(grant.url) }
}

/** The team daemon's own: its sign-in, the root-owned config, its engines' sign-ins in its own home. */
export const realTeamRelayLaunch = (engine: AgentEngine) => teamRelayLaunch(engine, {
  team: () => readAuthSession()?.kind === 'team',
  config: () => readTeamConfig(),
  // Only presence is read, never a secret (lib/engineAccount.ts); the team daemon has no login shell to read.
  signedIn: async (e) => (await engineAccount(e, { home: homedir(), env: process.env, lastUsed: false })).signedIn === true,
  read: (config) => readTeamRelay(config),
  onboarded: (e) => { if (e === 'claude') recordAcceptanceIn(join(homedir(), '.claude.json'), 'hasCompletedOnboarding') },
})

/** In the team daemon: whether the owner's relay is there for its engines (superTabs/machines.ts readiness). */
export const teamRelayed = (): boolean => {
  if (readAuthSession()?.kind !== 'team') return false
  const config = readTeamConfig()
  return !!config && !!readTeamRelay(config)
}
