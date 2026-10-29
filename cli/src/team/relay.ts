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
import { claudeRelayEnv, codexRelayArgs, codexRelayEnv, isCodexRelayAuth, type SubscriptionRelay } from '../lib/subscriptionRelay.js'
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
  /** Whether the team account signed this engine in itself: in [home], the launch's own Codex home, when it has one. */
  signedIn(engine: 'claude' | 'codex', home?: string): Promise<boolean>
  read(config: TeamConfig): TeamRelayGrant | null
  /** Claude Code that never ran in the team account opens on its first-run screens, which nobody is there to answer:
   *  recorded as done, in the team account's own home, before the first launch on the relay. */
  onboarded(engine: 'claude' | 'codex'): void
  /** Codex's home made ready for the relay before each launch ([prepareCodexHome]): [home], the launch's own, when it has one.
   *  Never throws. */
  codexHome(grant: TeamRelayGrant, home?: string): Promise<void>
}

/** In the team daemon, for an engine it has not signed in itself: the owner's relay, when there is one. [codexHome]: the
 *  launch's own Codex home (a Swarm Product Manager's, superTabs/teamDaemon.ts pmEngineHome), whose sign-in and model list
 *  are its own, not the daemon's (security re-check of #2089: it started signed out, without the owner's models). */
export async function teamRelayLaunch(engine: AgentEngine, deps: TeamRelayLaunchDeps, codexHome?: string): Promise<OwnerRelayLaunch | null> {
  if (engine !== 'claude' && engine !== 'codex') return null
  if (!deps.team()) return null
  const config = deps.config()
  if (!config) return null
  const home = engine === 'codex' ? codexHome : undefined
  if (await (home === undefined ? deps.signedIn(engine) : deps.signedIn(engine, home)).catch(() => false)) return null
  const grant = deps.read(config)
  if (!grant) return null
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
 */
export async function prepareCodexHome(dir: string, grant: TeamRelayGrant, deps: CodexHomeDeps): Promise<void> {
  const auth = join(dir, 'auth.json')
  try { if (isCodexRelayAuth(JSON.parse(readFileSync(auth, 'utf8')))) rmSync(auth, { force: true }) } catch { /* none, or the account's own */ }
  const version = deps.version() ?? CODEX_CLIENT_VERSION_FALLBACK
  try {
    const answer = await deps.fetch(`${grant.url.replace(/\/$/, '')}/codex/models?client_version=${encodeURIComponent(version)}`, {
      headers: { authorization: `Bearer ${grant.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!answer.ok) return
    const models = ((await answer.json()) as { models?: unknown }).models
    if (!Array.isArray(models) || !models.length) return
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'models_cache.json'), next = `${file}.harness-${process.pid}`
    writeFileSync(next, JSON.stringify({ fetched_at: new Date(deps.now()).toISOString(), client_version: version, models }), { mode: 0o600 })
    renameSync(next, file)
  } catch { /* The relay or ChatGPT did not answer: Codex keeps the list it had. */ }
}

/** The version of the Codex the team account installed for itself (team/script.ts TEAM_ENGINES_INSTALL, in ~/.local). */
export function installedCodexVersion(home: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch { return null }
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
