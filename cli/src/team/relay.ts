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
import { claudeRelayEnv, codexRelayArgs, codexRelayEnv, isCodexRelayAuth, type SubscriptionRelay } from '../lib/subscriptionRelay.js'
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
/** Why a launch in a Codex home of its own (a Swarm Product Manager's) is not made: no sign-in there, and no relay to give it
 *  one. The launch refuses or holds with it, never starting signed out (security re-checks of #2089). */
export interface OwnerRelayRefusal { refused: string }
export const NO_PM_RELAY = 'The owner\'s subscription relay is not available on this machine, so a Codex Product Manager cannot sign in here.'

export interface TeamRelayLaunchDeps {
  /** Whether this daemon runs team work only. */
  team(): boolean
  config(): TeamConfig | null
  /** Whether the team account signed this engine in itself: in [home], the launch's own Codex home, when it has one. */
  signedIn(engine: 'claude' | 'codex', home?: string): Promise<boolean>
  read(config: TeamConfig): TeamRelayGrant | null
  /** Claude Code that never ran in the team account opens on its first-run screens, which nobody is there to answer:
   *  recorded as done, in the team account's own home, before the first launch on the relay. */
  onboarded(engine: 'claude' | 'codex'): void
  /** Codex's home made ready for the relay before each launch ([prepareCodexHome]): [home], the launch's own, when it has one.
   *  Never throws. */
  codexHome(grant: TeamRelayGrant, home?: string): Promise<unknown>
}

/** In the team daemon, for an engine it has not signed in itself: the owner's relay, when there is one. [codexHome]: the
 *  launch's own Codex home (a Swarm Product Manager's, superTabs/teamDaemon.ts pmEngineHome), whose sign-in and model list
 *  are its own, not the daemon's (security re-check of #2089: it started signed out, without the owner's models). */
export async function teamRelayLaunch(engine: AgentEngine, deps: TeamRelayLaunchDeps, codexHome?: string): Promise<OwnerRelayLaunch | OwnerRelayRefusal | null> {
  if (engine !== 'claude' && engine !== 'codex') return null
  if (!deps.team()) return null
  const home = engine === 'codex' ? codexHome : undefined
  // A Codex home of its own holds no sign-in but what it was given: with no relay it is refused, not launched signed out.
  const none = home === undefined ? null : { refused: NO_PM_RELAY }
  const config = deps.config()
  if (!config) return home !== undefined && !await deps.signedIn(engine, home).catch(() => false) ? none : null
  if (await (home === undefined ? deps.signedIn(engine) : deps.signedIn(engine, home)).catch(() => false)) return null
  const grant = deps.read(config)
  if (!grant) return none
  try { deps.onboarded(engine) } catch { /* The engine asks on its screen, as it would have. */ }
  if (engine === 'claude') return { env: claudeRelayEnv(grant.url, grant.token), args: [] }
  await (home === undefined ? deps.codexHome(grant) : deps.codexHome(grant, home)).catch(() => {})
  return { env: codexRelayEnv(grant.token), args: codexRelayArgs(grant.url) }
}

/** The Codex version a model list is asked for when the account's own Codex cannot be read. */
export const CODEX_CLIENT_VERSION_FALLBACK = '0.163.0'

export interface CodexHomeDeps {
  fetch: typeof fetch
  /** The account's own Codex version (the npm package it installed), or null. */
  version(): string | null
  now(): number
}

/**
 * The team account's Codex home made ready for the owner's relay, before each Codex launch.
 *
 * Codex reaches the relay as an API-key provider, and so never reads the account's model list: its /model picker offered
 * only its built-in models, the model a Swarm start asked for (gpt-6.1-sol) could not be chosen, and the agent stayed on
 * gpt-5.5, which ChatGPT does not offer the owner's account ("The 'gpt-5.5' model is not supported when using Codex with
 * a ChatGPT account": every Codex start in a Harness Team account, 2026-10-29). Codex does read a `models_cache.json` in
 * its home whatever the provider, so the owner's list is fetched through the relay and kept there: Codex then starts on
 * the owner's default and its picker offers the owner's models. A list that cannot be fetched leaves the one before.
 *
 * CLI 0.5.1 instead signed Codex in to ChatGPT through the relay, which `codex exec` takes but Codex's own screen does not:
 * it checks the workspace with ChatGPT before it opens and exited ("account/read failed during TUI bootstrap"). Its
 * sign-in is removed here, so a team account it reached starts Codex again.
 *
 * Returns the list it fetched and kept, null when it kept none.
 */
export async function prepareCodexHome(dir: string, grant: TeamRelayGrant, deps: CodexHomeDeps): Promise<unknown[] | null> {
  const auth = join(dir, 'auth.json')
  try { if (isCodexRelayAuth(JSON.parse(readFileSync(auth, 'utf8')))) rmSync(auth, { force: true }) } catch { /* none, or the account's own */ }
  const version = deps.version() ?? CODEX_CLIENT_VERSION_FALLBACK
  try {
    const answer = await deps.fetch(`${grant.url.replace(/\/$/, '')}/codex/models?client_version=${encodeURIComponent(version)}`, {
      headers: { authorization: `Bearer ${grant.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!answer.ok) return null
    const models = ((await answer.json()) as { models?: unknown }).models
    if (!Array.isArray(models) || !models.length) return null
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'models_cache.json'), next = `${file}.harness-${process.pid}`
    writeFileSync(next, JSON.stringify({ fetched_at: new Date(deps.now()).toISOString(), client_version: version, models }), { mode: 0o600 })
    renameSync(next, file)
    dropUnofferedModel(join(dir, 'config.toml'), new Set(models.flatMap(m => typeof (m as { slug?: unknown })?.slug === 'string' ? [(m as { slug: string }).slug] : [])))
    return models
  } catch { /* The relay or ChatGPT did not answer: Codex keeps the list it had. */ }
  return null
}

/** The Codex models the owner's ChatGPT account offers: every slug, and those its /model picker lists, in its order. */
export interface OfferedCodexModels { slugs: string[]; listed: string[] }

export interface OfferedCodexModelsDeps {
  team(): boolean
  config(): TeamConfig | null
  read(config: TeamConfig): TeamRelayGrant | null
  /** [prepareCodexHome] for this account's Codex home: the list it fetched, or null. */
  prepare(grant: TeamRelayGrant): Promise<unknown[] | null>
}

/**
 * In a Harness Team account on its owner's relay: the Codex models the owner's ChatGPT account offers, read fresh through
 * the relay (and kept for the launch that follows, [prepareCodexHome]). Null anywhere else, or when the list cannot be read.
 * A start for a model the owner is not offered launched, then failed every request ("The 'gpt-6.1-sol' model is not
 * supported when using Codex with a ChatGPT account": Mac Auto, whose owner is offered GPT-6-Luna and the GPT-5.6 models,
 * 2026-10-29); with this, the start is refused before it launches, naming what the owner is offered.
 */
export async function offeredCodexModels(deps: OfferedCodexModelsDeps = realOfferedDeps): Promise<OfferedCodexModels | null> {
  if (!deps.team()) return null
  const config = deps.config()
  const grant = config ? deps.read(config) : null
  if (!grant) return null
  const models = await deps.prepare(grant).catch(() => null)
  if (!models) return null
  const rows = models.flatMap(m => m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string' ? [m as { slug: string; visibility?: unknown }] : [])
  if (!rows.length) return null
  return { slugs: rows.map(m => m.slug), listed: rows.filter(m => m.visibility === 'list').map(m => m.slug) }
}

/** Why a start for [model] is refused: the owner's account does not offer it, and what it does offer. */
export const codexModelNotOffered = (model: string, offered: OfferedCodexModels) =>
  `This machine's ChatGPT account (its owner's subscription, used through the owner's relay) does not offer ${model}; `
  + (offered.listed.length ? `it offers ${offered.listed.join(', ')}.` : 'it lists no model to choose.')

/**
 * A default model saved in the team account's Codex config that the owner's account does not offer is taken out, so Codex
 * starts on the owner's default. Codex saves the model a /model switch picks there, and a switch made while the account
 * knew only Codex's built-in models saved gpt-5.5, which ChatGPT refuses for the owner. Codex 0.164 then opens on a
 * "Meet GPT-6 Sol" choice before its session starts, which nobody in a team account answers: every Codex start on Mac
 * Auto's waited 3 minutes and failed (2026-10-29). Only a top-level `model` line is touched, and only against a list that
 * was read; a model the owner is offered stays.
 */
export function dropUnofferedModel(config: string, offered: ReadonlySet<string>): boolean {
  if (!offered.size) return false
  let text: string
  try { text = readFileSync(config, 'utf8') } catch { return false }
  const lines = text.split('\n')
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line))
  const top = firstTable < 0 ? lines.length : firstTable
  const index = lines.slice(0, top).findIndex(line => /^\s*model\s*=/.test(line))
  if (index < 0) return false
  const saved = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(lines[index]!)
  if (saved && offered.has(saved[1] ?? saved[2] ?? '')) return false
  lines.splice(index, 1)
  const next = `${config}.harness-${process.pid}`
  writeFileSync(next, lines.join('\n'), { mode: 0o600 })
  renameSync(next, config)
  return true
}

/** The version of the Codex the team account installed for itself (team/script.ts TEAM_ENGINES_INSTALL, in ~/.local). */
export function installedCodexVersion(home: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch { return null }
}

const realOfferedDeps: OfferedCodexModelsDeps = {
  team: () => readAuthSession()?.kind === 'team',
  config: () => readTeamConfig(),
  read: (config) => readTeamRelay(config),
  prepare: (grant) => prepareCodexHome(process.env.CODEX_HOME || join(homedir(), '.codex'), grant,
    { fetch, version: () => installedCodexVersion(homedir()), now: Date.now }),
}

/** The team daemon's own: its sign-in, the root-owned config, its engines' sign-ins in its own home. */
export const realTeamRelayLaunch = (engine: AgentEngine, codexHome?: string) => teamRelayLaunch(engine, {
  team: () => readAuthSession()?.kind === 'team',
  config: () => readTeamConfig(),
  // Only presence is read, never a secret (lib/engineAccount.ts); the team daemon has no login shell to read.
  signedIn: async (e, home) => (await engineAccount(e, { home: homedir(), env: home ? { ...process.env, CODEX_HOME: home } : process.env, lastUsed: false })).signedIn === true,
  read: (config) => readTeamRelay(config),
  onboarded: (e) => { if (e === 'claude') recordAcceptanceIn(join(homedir(), '.claude.json'), 'hasCompletedOnboarding') },
  codexHome: (grant, home) => prepareCodexHome(home ?? (process.env.CODEX_HOME || join(homedir(), '.codex')), grant,
    { fetch, version: () => installedCodexVersion(homedir()), now: Date.now }),
}, codexHome)

/** In the team daemon: whether the owner's relay is there for its engines (superTabs/machines.ts readiness). */
export const teamRelayed = (): boolean => {
  if (readAuthSession()?.kind !== 'team') return false
  const config = readTeamConfig()
  return !!config && !!readTeamRelay(config)
}
