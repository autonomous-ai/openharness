/**
 * The folders where the person's Claude Code and Codex keep their data, when the person has moved them.
 *
 * `CLAUDE_CONFIG_DIR` moves Claude Code's settings (its hooks with them), transcripts and process
 * records; `CODEX_HOME` moves Codex's hooks and rollouts. People set them in their shell profile, to
 * keep a work and a personal account apart, and every engine is launched through that shell, so the
 * engine takes them. The daemon never read the profile: the desktop app or launchd starts it. Measured
 * end to end (`e2e/enginehomes.e2e.ts`): with either one set, no agent ever bound. The engine read no
 * Harness hooks and wrote its transcript where the daemon never looked.
 *
 * So a moved home is adopted once the daemon reads its own or the login shell's environment
 * (`core/engines/hooks.ts`): the daemon's hooks are installed there as well, and a transcript beneath
 * it is the engine's own (`registry.validTranscriptPath`). The defaults stay: a session started without
 * the variable, from another terminal or before the profile set it, still lands in them.
 *
 * Remembered in the data folder (the legacy `engine-homes.json` plus confirmed immutable adoption
 * records), and read before the first transcript check.
 * The login shell is read after start-up begins, never waited on, and the registry checks every saved
 * agent's transcript as it loads: a home known only from this boot's shell was unknown at that check,
 * and every agent bound in it lost its binding at each restart (measured, the same test).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { env } from '../config/env.js'
import type { FolderSetting } from '../engines/facets/hooks.js'
import type { LaunchHome } from '../engines/facets/launch.js'
import { sessionStoreContracts, sessionStoreOf, type SessionStoreEngine } from '../engines/sessionStoreContracts.js'
import type { AgentEngine } from '../engines/types.js'
import { loginShellEnvironment } from './loginShellEnv.js'
import { MAX_CATALOG_HOMES, readHomeCatalog, type HomeCatalog } from '../engines/kit/homeCatalog.js'
import { createHomeAdopter, readAdoptedHomes } from '../engines/kit/homeAdoption.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'

/** The homes each engine's person moved (its session store's `sessions.moved.variable`), by engine, as saved. */
const movedByEngine = Object.fromEntries(Object.keys(sessionStoreContracts).map((engine) => [engine, [] as string[]])) as Record<SessionStoreEngine, string[]>
let loadedStamp = ''
let loadedFile = ''
// Positive facts only: they can require a hold, never supply roots absent from a fresh read.
let nativeCatalogFile = ''
let nativeKnownHomes: HomeCatalog = { claude: [], codex: [] }
let nativeCatalogOverflow = false
let pendingCatalogFile = ''
let pendingHomes: HomeCatalog = { claude: [], codex: [] }
let pendingAdopter: ReturnType<typeof createHomeAdopter> | undefined

const savedFile = (): string => join(env.ADAPTER_DATA_DIR, 'engine-homes.json')
function adopter(file = savedFile()): ReturnType<typeof createHomeAdopter> {
  if (pendingCatalogFile !== file || !pendingAdopter) {
    pendingCatalogFile = file; pendingHomes = { claude: [], codex: [] }; pendingAdopter = createHomeAdopter(file)
  }
  return pendingAdopter
}
function observeCatalog(file: string): void {
  if (loadedFile !== file) {
    loadedFile = file; loadedStamp = ''
    for (const homes of Object.values(movedByEngine)) homes.length = 0
  }
  if (nativeCatalogFile === file) return
  nativeCatalogFile = file; nativeKnownHomes = { claude: [], codex: [] }; nativeCatalogOverflow = false
}

/** Found by QA on a quiet machine: search starts before the core adopts its shell's homes. Read again when that process
 * replaces the small saved file, retaining in-memory homes if a write or read is unavailable. */
function load(): void {
  observeCatalog(savedFile())
  try {
    const saved = readAdoptedHomes(savedFile()).homes
    for (const engine of Object.keys(movedByEngine) as SessionStoreEngine[]) {
      for (const home of saved[engine]) if (!movedByEngine[engine].includes(home)) movedByEngine[engine].push(home)
    }
    return
  } catch { /* Legacy lifecycle readers retain their positive facts; native control uses the strict reader below. */ }
  try {
    const file = savedFile(), stat = statSync(file)
    const stamp = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
    if (stamp === loadedStamp) return
    loadedStamp = stamp
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const take = (list: unknown, into: string[]): void => {
      for (const home of Array.isArray(list) ? list : []) {
        if (typeof home === 'string' && isAbsolute(home) && !into.includes(home)) into.push(home)
      }
    }
    for (const [engine, homes] of Object.entries(movedByEngine)) take(saved[engine], homes)
  } catch { /* none adopted yet, or unreadable: the login shell's are adopted again once it is read */ }
}

/** The homes an environment moved that the daemon did not already use: null where it moved none new. */
export interface MovedHomes {
  claude: string | null
  codex: string | null
}

/** Adopt the homes `environment` moves, beside the daemon's own (`defaults`), and say which are new. */
export function adoptEngineHomes(environment: NodeJS.ProcessEnv, defaults: { claudeHome: string; codexHome: string }): MovedHomes {
  const moved = adoptHomes(environment, { claude: defaults.claudeHome, codex: defaults.codexHome })
  return { claude: moved.claude, codex: moved.codex }
}

/** The daemon's own home for the variable a person moves `engine`'s with (its session store's `sessions.moved`). */
export function ownHomeOf(engine: SessionStoreEngine): string {
  const { own, moved } = sessionStoreContracts[engine].sessions
  return moved.ownHome === 'setting' ? env[own.setting] : dirname(env[own.setting])
}

/**
 * Adopt the homes `environment` moves for every engine that declares a movable home, beside the daemon's own
 * (`own`, by engine: `ownHomeOf` unless given), and say which are new, by engine.
 */
export function adoptHomes(environment: NodeJS.ProcessEnv, own: Partial<Record<SessionStoreEngine, string>> = {}): Record<SessionStoreEngine, string | null> {
  return adopt(environment, own, false)
}

/** Every requested home confirmed durable, including an idempotent retry whose earlier reply was lost. */
export function confirmHomes(environment: NodeJS.ProcessEnv): Record<SessionStoreEngine, string | null> {
  return adopt(environment, {}, true)
}

function adopt(environment: NodeJS.ProcessEnv, own: Partial<Record<SessionStoreEngine, string>>, confirmed: boolean): Record<SessionStoreEngine, string | null> {
  load()
  const file = savedFile()
  observeCatalog(file)
  const writer = adopter(file)
  const requested = (value: string | undefined, home: string): string | null => {
    const dir = value?.trim()
    // A relative or `~` path is not a folder the engine resolves the same way from every directory.
    if (!dir || !isAbsolute(dir)) return null
    const moved = resolve(dir)
    return moved === resolve(home) ? null : moved
  }
  const engines = Object.keys(movedByEngine) as SessionStoreEngine[]
  const wanted = Object.fromEntries(engines.map(engine => [engine,
    requested(environment[sessionStoreContracts[engine].sessions.moved.variable], own[engine] ?? ownHomeOf(engine))])) as Record<SessionStoreEngine, string | null>
  const result = Object.fromEntries(engines.map(engine => [engine, confirmed || !movedByEngine[engine].includes(wanted[engine]!)
    || pendingHomes[engine].includes(wanted[engine]!) ? wanted[engine] : null])) as Record<SessionStoreEngine, string | null>
  for (const engine of engines) {
    const home = wanted[engine]
    if (home && !pendingHomes[engine].includes(home)) {
      if (pendingHomes[engine].length >= MAX_CATALOG_HOMES) {
        nativeCatalogOverflow = true
        throw new IdentityReadUnavailable('the pending session-home limit was reached')
      }
      pendingHomes[engine].push(home)
    }
  }
  if (!Object.values(wanted).some(Boolean)) return result
  const committed = writer.adopt(Object.fromEntries(engines.map(engine => [engine, wanted[engine] ? [wanted[engine]] : []])) as HomeCatalog)
  for (const engine of engines) {
    for (const home of committed[engine]) if (!movedByEngine[engine].includes(home)) movedByEngine[engine].push(home)
    pendingHomes[engine] = pendingHomes[engine].filter(home => home !== wanted[engine])
  }
  return result
}

/** The homes the person moved `engine`'s to, adopted on this boot or an earlier one; none for an engine that
 *  declares no movable home. */
export function movedHomes(engine: AgentEngine | string): string[] {
  load()
  return Object.hasOwn(movedByEngine, engine) ? [...movedByEngine[engine as SessionStoreEngine]] : []
}

/**
 * Every folder `engine`'s sessions may be in: the agent's own profile's alone, for an engine whose sessions follow
 * one; else the daemon's own folder and each moved home's. Empty for an engine that declares no session store.
 */
export function sessionRoots(engine: AgentEngine | string, profile?: string | null, snapshot?: EngineHomeSnapshot): string[] {
  const store = sessionStoreOf(engine)
  if (!store) return []
  const { own, moved, profile: followsProfile } = store.sessions
  const below = (home: string): string => own.folder ? join(home, own.folder) : home
  if (followsProfile && profile) return [below(profile)]
  return [below(env[own.setting]), ...(snapshot ? snapshot.homes[engine as SessionStoreEngine] : movedHomes(engine)).map((home) => join(home, moved.folder))]
}

/** Complete native identity pools cannot use the legacy reader's partial or cached catalog.
 * Legacy lifecycle callers migrate separately, together with their durable hold/retry handling. */
export function nativeSessionRoots(engine: AgentEngine | string, profile?: string | null): string[] {
  const store = sessionStoreOf(engine)
  if (!store) return []
  const { own, moved, profile: followsProfile } = store.sessions
  const below = (home: string): string => own.folder ? join(home, own.folder) : home
  if (followsProfile && profile) return [below(profile)]
  const { read } = readNativeHomes()
  return [below(env[own.setting]), ...read.homes[engine as SessionStoreEngine].map(home => join(home, moved.folder))]
}

function readNativeHomes() {
  const file = savedFile()
  observeCatalog(file)
  const read = readAdoptedHomes(file)
  const observed = pendingCatalogFile === file ? pendingAdopter?.observations() : undefined
  const names = Object.keys(sessionStoreContracts) as SessionStoreEngine[]
  const overflow = (): never => {
    nativeCatalogOverflow = true
    throw new IdentityReadUnavailable('the known session-home limit was reached')
  }
  if (nativeCatalogOverflow || observed?.exhausted) overflow()
  if (observed?.legacyRequired && readHomeCatalog(file).text === null) {
    throw new IdentityReadUnavailable('the saved engine-home catalog lost its observed legacy file')
  }
  for (const name of names) {
    // Adoption predates this boundary and can keep an unsaved home in memory. Bound that
    // legacy list before copying or visiting it; remembering an overflow also prevents forgetting it.
    const legacy = movedByEngine[name]
    if (legacy.length > MAX_CATALOG_HOMES) overflow()
    for (const list of [read.homes[name], legacy, ...(observed ? [observed.homes[name]] : []), ...(pendingCatalogFile === file ? [pendingHomes[name]] : [])]) for (const home of list) {
      if (nativeKnownHomes[name].includes(home)) continue
      if (nativeKnownHomes[name].length === MAX_CATALOG_HOMES) overflow()
      nativeKnownHomes[name].push(home)
    }
  }
  // Even a held read can reveal a competitor. Retain all bounded positive facts before
  // checking omissions, so A -> B (held) -> A cannot forget the observed B.
  for (const name of names) {
    if (nativeKnownHomes[name].some(home => !read.homes[name].includes(home))) {
      throw new IdentityReadUnavailable('the saved engine-home catalog omits a previously observed or unsaved home')
    }
  }
  return { file, read }
}

/** One explicit synchronous bulk operation. Revalidate before publishing any decisions made from it. */
export interface EngineHomeSnapshot {
  readonly homes: HomeCatalog
  verify(): void
}
export function engineHomeSnapshot(): EngineHomeSnapshot {
  const { file, read } = readNativeHomes()
  const homes = { claude: [...read.homes.claude], codex: [...read.homes.codex] }
  Object.freeze(homes.claude); Object.freeze(homes.codex); Object.freeze(homes)
  return {
    homes,
    verify(): void {
      if (savedFile() !== file || readNativeHomes().read.version !== read.version) {
        throw new IdentityReadUnavailable('the saved engine-home catalog changed during the operation')
      }
    },
  }
}

/** Every moved home known: adopted on this boot or an earlier one. */
export function movedEngineHomes(): { claude: string[]; codex: string[] } {
  return { claude: movedHomes('claude'), codex: movedHomes('codex') }
}

/** Fresh complete adopted homes for boot-time hook installation; unavailable storage must be retried. */
export function durableEngineHomes(): HomeCatalog {
  return readAdoptedHomes(savedFile()).homes
}

/** Recover a published adoption after a crash, even if this boot no longer names its home in the shell. */
export function recoverEngineHomes(): HomeCatalog {
  return adopter().adopt({ claude: [], codex: [] })
}

/** Every folder Claude Code's transcripts may be in: `own`, then each moved home's. */
export function claudeProjectsRoots(own: string): string[] {
  return [own, ...movedHomes('claude').map((home) => join(home, sessionStoreContracts.claude.sessions.moved.folder))]
}

/** Every Codex home whose rollouts are Codex's own: `own`, then each moved one. */
export function codexHomeRoots(own: string): string[] {
  return [own, ...movedHomes('codex')]
}

/** Every home a daemon setting names: the daemon's own, then each one the person moved and Harness adopted (the
 *  engines whose movable home is that setting's folder). */
export function homeRoots(setting: FolderSetting, snapshot?: EngineHomeSnapshot): string[] {
  if (!snapshot) load()
  const moved = (Object.keys(movedByEngine) as SessionStoreEngine[]).filter((engine) => {
    const { own, moved: movable } = sessionStoreContracts[engine].sessions
    return own.setting === setting && movable.ownHome === 'setting'
  })
  return [env[setting], ...moved.flatMap((engine) => snapshot ? snapshot.homes[engine] : movedByEngine[engine])]
}

/**
 * The environment an engine launched now starts with, as far as its homes go. Every pane runs the engine
 * through the person's login shell, which reads their profile, so the login shell's variables outrank the
 * daemon's own; before that shell has been read (the first seconds of a start), the daemon's alone.
 */
function launchEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ...loginShellEnvironment() }
}

/** A home an environment moves, absolute; null for none, or for one the engine would not resolve the
 *  same way from every folder (relative, `~`). */
function movedHome(value: string | undefined): string | null {
  const dir = value?.trim()
  return dir && isAbsolute(dir) ? resolve(dir) : null
}

/**
 * The Codex home an agent launched now reads its `config.toml` from: its own profile (the row's
 * `codexHome`, set on its pane as CODEX_HOME), else the CODEX_HOME the person's shell moves, else the
 * daemon's. What has to be in that config before Codex starts (its folder trust, lib/claudeTrust.ts) was
 * written to `~/.codex` alone, so an agent on its own profile, or a person who moved CODEX_HOME, got
 * Codex's trust prompt in a folder Harness had just made.
 */
export function launchCodexHome(codexHome: string | null | undefined, environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return launchHome('CODEX_HOME', codexHome, environment)
}

/** The same, for the home any daemon setting names (an engine's launch contract declares which: engines/launches.ts). */
export function launchHome(setting: FolderSetting, profile: string | null | undefined, environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return profile || movedHome(environment[setting]) || env[setting]
}

/** Found by QA on a quiet machine: activity, close and Monitor looked at another server when the process's
 * environment was unreadable. A bound transcript identifies its adopted home even in a service
 * without the core's shell cache. An explicit profile remains authoritative. */
export function sessionCodexHome(session: { codexHome?: string | null; transcriptPath?: string | null }, snapshot?: EngineHomeSnapshot): string {
  return sessionHomeOf('codex', { profile: session.codexHome, transcriptPath: session.transcriptPath }, snapshot)
}

/**
 * The home a session's file is in, for an engine whose movable home is its setting's folder (its session store's
 * `sessions.moved.ownHome` is `setting`: Codex's): the agent's own profile, else the known home whose sessions
 * (or archived sessions) hold the file, else the home a launch made now would use.
 */
export function sessionHomeOf(engine: SessionStoreEngine, session: { profile?: string | null; transcriptPath?: string | null }, snapshot?: EngineHomeSnapshot): string {
  if (session.profile) return session.profile
  const { own, archived } = sessionStoreContracts[engine].sessions
  const folders = [own.folder, archived].filter((folder): folder is string => !!folder)
  const home = session.transcriptPath && homeRoots(own.setting, snapshot).find(root => {
    const path = relative(root, session.transcriptPath!)
    return folders.some((folder) => path.startsWith(`${folder}${sep}`))
  })
  return home || launchHome(own.setting, null)
}

/** The sessions folder of that home (`sessionHomeOf`): where a session beside the one in that file is. */
export function sessionFolderOf(engine: SessionStoreEngine, session: { profile?: string | null; transcriptPath?: string | null }, snapshot?: EngineHomeSnapshot): string {
  const { own } = sessionStoreContracts[engine].sessions
  const home = sessionHomeOf(engine, session, snapshot)
  return own.folder ? join(home, own.folder) : home
}

/** Found by QA on a quiet machine: Claude's picker and effort read another login's settings.
 * A known transcript keeps its home after the shell changes. Settings default to .claude, unlike
 * the folder-trust .claude.json below, which defaults to the user's home itself. */
export function sessionClaudeHome(session: { transcriptPath?: string | null }): string {
  const projects = session.transcriptPath && claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR).find(root => {
    const path = relative(root, session.transcriptPath!)
    return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  })
  return projects ? dirname(projects) : movedHome(launchEnvironment().CLAUDE_CONFIG_DIR) || dirname(env.CLAUDE_PROJECTS_DIR)
}

/**
 * The folder Claude Code keeps `.claude.json` in for an agent launched now: the CLAUDE_CONFIG_DIR the
 * person's shell sets, else the home folder. Claude Code's own rule (2.1.290:
 * `join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`); its folder trust was read and
 * written in `~/.claude.json` alone, which a moved Claude Code never reads.
 */
export function launchClaudeConfigDir(environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return launchHomeOf({ variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, null, environment)
}

/** The home an engine's launch contract declares (engines/facets/launch.ts `LaunchHome`), for a launch made now. */
export function launchHomeOf(home: LaunchHome, profile: string | null | undefined, environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return 'setting' in home ? launchHome(home.setting, profile, environment) : movedHome(environment[home.variable]) || homedir()
}

/** The environment that runs an agent on its own profile `home`, for an engine whose sessions follow one (its
 *  session store's `sessions.profile`): the variable that moves its home (`CODEX_HOME`). None for another engine. */
export function profileEnvironment(engine: AgentEngine | string, home: string): Record<string, string> | undefined {
  const sessions = sessionStoreOf(engine)?.sessions
  return sessions?.profile ? { [sessions.moved.variable]: home } : undefined
}

/** Test seam: forget every home, and read the data folder's again on next use. */
export function resetEngineHomes(): void {
  for (const homes of Object.values(movedByEngine)) homes.length = 0
  loadedStamp = ''
  loadedFile = ''
  nativeCatalogFile = ''
  nativeKnownHomes = { claude: [], codex: [] }
  nativeCatalogOverflow = false
  pendingCatalogFile = ''
  pendingAdopter = undefined
  pendingHomes = { claude: [], codex: [] }
}
