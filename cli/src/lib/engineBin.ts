/**
 * Per-engine command labels, explicit binary overrides, and local executable ownership.
 *
 * User-facing labels stay stable, while process discovery and Cursor recap use file identity so the
 * colliding `agent` alias is never assigned from its basename alone.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readlinkSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { access, opendir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { env } from '../config/env.js'
import { ENGINES, PROCESS_ENGINES, type AgentEngine } from '../engines/types.js'
import { engineInstallPaths, engineInstallRecipe } from './engineInstall.js'
import { currentUserShell } from './userShell.js'
import { windowsLaunchCandidates, windowsLaunchCommand } from './binaryOnPath.js'
import { hermesBootFile, hermesRoot } from './windows/hermesLaunch.js'
import { errorKind } from './log.js'

// Keep this historical import surface for callers, but never duplicate the
// catalog here. `engines/types.ts` is the one iterable source of truth.
export { ENGINES, PROCESS_ENGINES }

/** Public vendor command shown to users and matched by the real-binary smoke matrix. */
export const ENGINE_CLI_COMMANDS: Readonly<Record<AgentEngine, string>> = {
  claude: 'claude',
  codex: 'codex',
  // Cursor and Grok both publish `agent`; Cursor's documented, unambiguous command is
  // `cursor-agent`, so creation must use that and keep `agent` for discovery only.
  cursor: 'cursor-agent',
  opencode: 'opencode',
  pi: 'pi',
  omp: 'omp',
  hermes: 'hermes',
  commandcode: 'cmd',
  devin: 'devin',
  muse: 'muse',
  amp: 'amp',
  kilo: 'kilo',
  grok: 'grok',
  agy: 'agy',
  copilot: 'copilot',
  openclaw: 'openclaw',
  // A terminal has no command: the pane runs the user's login shell (engineLaunch.ts). The empty
  // string is what keeps every "is this binary installed" probe honest — nothing to look for.
  terminal: '',
}

export interface ExecutableFileIdentity {
  path: string
  realPath: string
  fileKey: string
}

export type AgentAliasOwner = 'cursor' | 'grok' | 'unknown' | 'conflict'

/**
 * Per-machine evidence used only for the colliding `agent` command.
 *
 * Cursor installs `agent` and `cursor-agent` as aliases of one launcher. Grok Build installs `agent`
 * and `grok` as aliases of one compiled binary. Comparing the resolved file is independent of PATH
 * order, symlink depth, package-manager prefix, and the name retained in `ps`.
 */
export interface AgentCommandOwnershipSnapshot {
  /** Installed command/override identities for every engine, not only the colliding `agent` alias. */
  engineFileKeys?: ReadonlyMap<AgentEngine, ReadonlySet<string>>
  engineCandidates?: ReadonlyMap<AgentEngine, readonly ExecutableFileIdentity[]>
  cursorFileKeys: ReadonlySet<string>
  grokFileKeys: ReadonlySet<string>
  conflictingFileKeys: ReadonlySet<string>
  agentCandidates: readonly ExecutableFileIdentity[]
  cursorAgentCandidates: readonly ExecutableFileIdentity[]
  grokCandidates: readonly ExecutableFileIdentity[]
}

/** Commands whose public aliases can legitimately identify the same engine. */
export const ENGINE_CLI_ALIASES: Readonly<Record<AgentEngine, readonly string[]>> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['agent', 'cursor-agent'],
  opencode: ['opencode'],
  pi: ['pi'],
  omp: ['omp'],
  hermes: ['hermes', 'hermes-agent'],
  commandcode: ['cmd', 'command-code', 'commandcode'],
  devin: ['devin'],
  muse: ['muse'],
  amp: ['amp'],
  kilo: ['kilo', 'kilocode'],
  grok: ['grok', 'agent'],
  agy: ['agy'],
  copilot: ['copilot'],
  openclaw: ['openclaw'],
  terminal: [],
}

/** The code is the error's `code` as well as its words: a log line names a failure by its code (`errorKind`). */
const engineFailure = (code: string): Error => Object.assign(new Error(code), { code })

let interactivePathCache: { shell: string; daemonPath: string; value: string[]; retryAt: number } | null = null
let interactivePathFlight: Promise<string[]> | null = null
let interactivePathFlightKey = ''

/** Match pane startup: bash reads -ic, zsh reads -lic. The one-shot credential capture has a different context. */
function warmInteractivePath(): Promise<string[]> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve([])
  const shell = currentUserShell(), daemonPath = process.env.PATH ?? ''
  if (!shell) return Promise.resolve([])
  const key = `${shell}\0${daemonPath}`
  if (interactivePathFlight) return interactivePathFlightKey === key ? interactivePathFlight : Promise.reject(engineFailure('ENGINE_PATH_CHANGED'))
  if (interactivePathCache?.shell === shell && interactivePathCache.daemonPath === daemonPath && Date.now() < interactivePathCache.retryAt) {
    return Promise.resolve(interactivePathCache.value)
  }
  interactivePathFlightKey = key
  interactivePathFlight = new Promise<string[]>(done => {
    let child: ReturnType<typeof execFile> | undefined, settled = false
    const finish = (value: string[], failure?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) {
        console.error(`[engine] ${failure}: interactive PATH unavailable; using daemon PATH`)
        child?.kill('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy()
      }
      interactivePathCache = { shell, daemonPath, value, retryAt: failure ? Date.now() + 30_000 : Infinity }
      done(value)
    }
    const timer = setTimeout(() => finish([], 'ENGINE_PATH_TIMEOUT'), 5_000)
    const flag = basename(shell).toLowerCase() === 'zsh' ? '-lic' : '-ic'
    const marker = '__HARNESS_ENGINE_PATH__='
    try {
      child = execFile(shell, [flag, `printf '\\n${marker}%s\\n' "$PATH"`], {
        encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout) => {
        if (error) { finish([], 'ENGINE_PATH_FAILED'); return }
        const value = stdout.split('\n').reverse().find(line => line.startsWith(marker))?.slice(marker.length)
        finish(value?.split(delimiter).filter(Boolean) ?? [], value === undefined ? 'ENGINE_PATH_INVALID' : undefined)
      })
      child.stdin?.end()
    } catch { finish([], 'ENGINE_PATH_FAILED') }
  }).finally(() => { interactivePathFlight = null })
  return interactivePathFlight
}

/** Synchronous compatibility readers never start a blocking shell. Async discovery awaits the first capture. */
function interactivePathEntries(): string[] {
  if (process.env.NODE_ENV === 'test') return []
  void warmInteractivePath().catch(() => {})
  return interactivePathCache && interactivePathCache.shell === currentUserShell() && interactivePathCache.daemonPath === (process.env.PATH ?? '')
    ? interactivePathCache.value : []
}

/** Only what a spawned child inherits. A hit here is safe to return as a bare name. */
function processPathEntries(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

function pathEntries(): string[] {
  return [...new Set([
    ...processPathEntries(),
    ...interactivePathEntries(),
  ])]
}

function looksLikePath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\')
}

/** Resolve every visible command candidate, not only the first PATH hit. */
function commandCandidates(command: string): ExecutableFileIdentity[] {
  const paths = looksLikePath(command)
    ? [command]
    : pathEntries().map((entry) => join(entry, command))
  const seen = new Set<string>()
  const result: ExecutableFileIdentity[] = []
  for (const path of paths) {
    try { accessSync(path, constants.X_OK) } catch { continue }
    const identity = executableFileIdentity(path)
    if (!identity || seen.has(identity.path)) continue
    seen.add(identity.path)
    result.push(identity)
  }
  return result
}

/** Stable while a file exists; deliberately local-only and never sent over the wire. */
export function executableFileIdentity(path: string): ExecutableFileIdentity | null {
  try {
    // Stat through the supplied path first. `/proc/<pid>/exe` keeps the running inode reachable even
    // after an auto-updater replaces its pathname; realpath may then end in "(deleted)" and be
    // unstatable despite the process image still being valid.
    // OverlayFS (including a live USB) can assign 64-bit inode numbers above
    // Number.MAX_SAFE_INTEGER. Rounded Numbers made unrelated executables
    // share one owner, so a shell could be promoted to an installed agent.
    const stat = statSync(path, { bigint: true })
    if (!stat.isFile()) return null
    let realPath: string
    try { realPath = realpathSync(path) } catch {
      try { realPath = readlinkSync(path) } catch { realPath = normalize(path) }
    }
    return { path: normalize(path), realPath, fileKey: `${stat.dev}:${BigInt.asUintN(64, stat.ino)}` }
  } catch {
    return null
  }
}

function cursorInstallLayout(path: string): boolean {
  const normalized = path.split(sep).join('/')
  return /\/cursor-agent\/versions\/[^/]+\/cursor-agent$/.test(normalized)
}

function addAll(target: Set<string>, identities: readonly ExecutableFileIdentity[]): void {
  for (const identity of identities) target.add(identity.fileKey)
}

function vendorFallbackCommands(engine: AgentEngine): string[] {
  const recipe = engineInstallRecipe(engine)
  const paths = recipe ? engineInstallPaths(recipe) : []
  switch (engine) {
    case 'cursor': return [...paths, join(homedir(), '.local', 'bin', 'agent')]
    case 'grok': return [join(env.GROK_HOME, 'bin', 'grok'), ...paths]
    default: return paths
  }
}

function uniqueIdentities(identities: readonly ExecutableFileIdentity[]): ExecutableFileIdentity[] {
  const seen = new Set<string>()
  return identities.filter((identity) => {
    const key = `${identity.path}\0${identity.fileKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The file key of the boot module Harness runs in place of Hermes' installer [launcher] (`<root>\bin\hermes.exe`), when
 *  it is that launcher and the module has been written. */
export function hermesBootFileKey(launcher: string): string | null {
  const root = hermesRoot(launcher)
  return root ? executableFileIdentity(hermesBootFile(root))?.fileKey ?? null : null
}

function ownershipInput() {
  const commands = new Map(PROCESS_ENGINES.map(engine => {
    const configured = enginePathOverride(engine)
    return [engine, [...(configured ? [configured] : []), ...ENGINE_CLI_ALIASES[engine], ...vendorFallbackCommands(engine)]]
  }))
  return { commands, cursor: env.CURSOR_PATH, grok: env.GROK_PATH, grokHome: join(env.GROK_HOME, 'bin', 'grok'),
    hermes: enginePathOverride('hermes') || 'hermes', paths: pathEntries() }
}

type OwnershipInput = ReturnType<typeof ownershipInput>
function ownershipSnapshot(input: OwnershipInput, commandCandidates: (command: string) => ExecutableFileIdentity[], hermesBoot: string | null): AgentCommandOwnershipSnapshot {
  const engineCandidates = new Map<AgentEngine, ExecutableFileIdentity[]>()
  const engineFileKeys = new Map<AgentEngine, Set<string>>()
  for (const engine of PROCESS_ENGINES) {
    const commands = input.commands.get(engine)!
    const candidates = uniqueIdentities(commands.flatMap(commandCandidates))
    engineCandidates.set(engine, candidates)
    engineFileKeys.set(engine, new Set(candidates.map((candidate) => candidate.fileKey)))
  }
  // Harness runs Hermes' installer launcher on Windows as `<python> -I <root>\bin\hermes-boot.py`
  // (lib/windows/hermesLaunch.ts), so the pane's Hermes is that file, as surely as the launcher it stands in for.
  // Not a candidate: nothing runs it by name. Without it a Hermes pane was never confirmed (DESKTOP-0TFH0OJ, 2026-11-09).
  // The launcher is found as the launch finds it (lib/windows/launch.ts): `hermes` alone names no file on Windows.
  if (hermesBoot) engineFileKeys.get('hermes')?.add(hermesBoot)

  const agentCandidates = commandCandidates('agent')
  const cursorAgentCandidates = commandCandidates('cursor-agent')
  const grokCandidates = [...commandCandidates('grok')]

  const cursorFileKeys = new Set<string>()
  const grokFileKeys = new Set<string>()
  addAll(cursorFileKeys, cursorAgentCandidates)
  addAll(grokFileKeys, grokCandidates)

  // Existing explicit overrides are ownership declarations, but a declaration that resolves to the
  // other vendor's canonical binary becomes a conflict below instead of silently winning by basename.
  if (input.cursor) addAll(cursorFileKeys, commandCandidates(input.cursor))
  if (input.grok) addAll(grokFileKeys, commandCandidates(input.grok))

  // Grok's own state-root override already describes its standard installer root. This seed keeps
  // discovery correct when the daemon PATH differs from an interactive tmux shell's PATH.
  const grokHomeBin = commandCandidates(input.grokHome)[0]
  if (grokHomeBin) {
    grokFileKeys.add(grokHomeBin.fileKey)
    if (!grokCandidates.some((candidate) => candidate.path === grokHomeBin.path)) grokCandidates.push(grokHomeBin)
  }

  // Cursor's launcher target carries a vendor-specific package layout even when `cursor-agent` itself
  // is absent from the daemon PATH (for example, a pane inherited a newer interactive shell PATH).
  for (const candidate of agentCandidates) {
    if (cursorInstallLayout(candidate.realPath)) cursorFileKeys.add(candidate.fileKey)
  }

  const conflictingFileKeys = new Set(
    [...cursorFileKeys].filter((fileKey) => grokFileKeys.has(fileKey)),
  )
  // `agent` is intentionally present in both public alias lists. Replace the generic sets with the
  // vendor-qualified ownership derived above so one PATH entry never makes both engines match.
  engineFileKeys.set('cursor', cursorFileKeys)
  engineFileKeys.set('grok', grokFileKeys)
  engineCandidates.set('cursor', (engineCandidates.get('cursor') ?? []).filter((candidate) =>
    cursorFileKeys.has(candidate.fileKey) && !conflictingFileKeys.has(candidate.fileKey)))
  engineCandidates.set('grok', (engineCandidates.get('grok') ?? []).filter((candidate) =>
    grokFileKeys.has(candidate.fileKey) && !conflictingFileKeys.has(candidate.fileKey)))
  return {
    engineFileKeys,
    engineCandidates,
    cursorFileKeys,
    grokFileKeys,
    conflictingFileKeys,
    agentCandidates,
    cursorAgentCandidates,
    grokCandidates,
  }
}

/** Compatibility for synchronous callers; live terminal discovery uses the async snapshot below. */
export function engineBinaryOwnershipSnapshot(): AgentCommandOwnershipSnapshot {
  const input = ownershipInput(), memo = new Map<string, ExecutableFileIdentity[]>()
  const lookup = (command: string) => {
    if (!memo.has(command)) memo.set(command, commandCandidates(command))
    return memo.get(command)!
  }
  return ownershipSnapshot(input, lookup, hermesBootFileKey(windowsLaunchCommand(input.hermes)))
}

/** Directory generations cache names only. Chmod, symlink targets and executable replacements are checked per pass. */
const candidateDirectories = new Map<string, { stamp: string; wanted: string; names: Set<string> | null }>()
const directoryStamp = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`

async function candidateNames(directory: string, wanted: Set<string>, wantedKey: string): Promise<Set<string> | null> {
  const key = resolve(directory)
  try {
    const before = await stat(key, { bigint: true }), stamp = directoryStamp(before)
    if (!before.isDirectory()) return new Set()
    const known = candidateDirectories.get(key)
    if (known?.stamp === stamp && known.wanted === wantedKey) return known.names
    let names: Set<string> | null = new Set(), count = 0
    try {
      const entries = await opendir(key)
      for await (const entry of entries) {
        // A huge or unreadable PATH folder falls back to the fixed list of command probes.
        if (++count > 16_384) { names = null; break }
        const name = entry.name.toLowerCase()
        if (wanted.has(name)) names.add(name)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      names = null
    }
    if (directoryStamp(await stat(key, { bigint: true })) !== stamp) return null
    if (candidateDirectories.size >= 128 && !candidateDirectories.has(key)) candidateDirectories.delete(candidateDirectories.keys().next().value!)
    candidateDirectories.set(key, { stamp, wanted: wantedKey, names })
    return names
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Set()
    if (code === 'EACCES') return null
    throw engineFailure('ENGINE_LOOKUP_FAILED')
  }
}

let ownershipFlight: Promise<AgentCommandOwnershipSnapshot> | null = null
let ownershipFlightKey = ''
// No process.cwd(): it throws once the start folder is deleted (the firmware flash's worktree), failing every pass.
// A relative PATH entry still resolves against the working folder at read time.
const ownershipKey = () => JSON.stringify([process.env.PATH, currentUserShell(), homedir(), env.GROK_HOME,
  process.platform, ...PROCESS_ENGINES.map(enginePathOverride)])

const ownershipUnavailable = (error: unknown): Promise<never> => {
  console.error(`[engine] ${errorKind(error)}: executable ownership unavailable`)
  return Promise.reject(error)
}

/** Fresh identities per pass, eight filesystem reads at once, one pass shared by concurrent panes. */
export function agentCommandOwnershipSnapshotAsync(): Promise<AgentCommandOwnershipSnapshot> {
  // Callers chain on the promise: a synchronous throw would escape their catch, and no flight is left set.
  let key: string
  try { key = ownershipKey() } catch (error) { return ownershipUnavailable(error) }
  if (ownershipFlight) return key === ownershipFlightKey ? ownershipFlight : Promise.reject(engineFailure('ENGINE_LOOKUP_CHANGED'))
  ownershipFlightKey = key
  let expired = false
  const work = (async () => {
    await warmInteractivePath()
    if (key !== ownershipKey()) throw engineFailure('ENGINE_LOOKUP_CHANGED')
    const input = ownershipInput()
    if (input.paths.length > 1_024) throw engineFailure('ENGINE_LOOKUP_PATH_LIMIT')
    const windowsCandidates = windowsLaunchCandidates(input.hermes), windowsFiles = new Set(windowsCandidates)
    const commands = new Set([...input.commands.values()].flat().concat(windowsCandidates, ['agent', 'cursor-agent', 'grok', input.grokHome],
      input.cursor ? [input.cursor] : [], input.grok ? [input.grok] : []))
    const wanted = new Set([...commands].filter(command => !looksLikePath(command)).concat(windowsCandidates.map(file => basename(file))).map(command => command.toLowerCase()))
    const wantedKey = [...wanted].sort().join('\0'), names = new Map<string, Set<string> | null>()
    let directoryIndex = 0, directoryFailure: Error | undefined
    await Promise.all(Array.from({ length: Math.min(8, input.paths.length) }, async () => {
      while (!expired && directoryIndex < input.paths.length) {
        const directory = input.paths[directoryIndex++]
        try { names.set(resolve(directory), await candidateNames(directory, wanted, wantedKey)) }
        catch { expired = true; directoryFailure = engineFailure('ENGINE_LOOKUP_FAILED') }
      }
    }))
    if (directoryFailure) throw directoryFailure
    if (expired) throw engineFailure('ENGINE_LOOKUP_TIMEOUT')
    const visible = (directory: string, command: string) => {
      const known = names.get(resolve(directory))
      return !known || /[^\x00-\x7f]/.test(command) || known.has(command.toLowerCase())
    }
    const byCommand = new Map([...commands].map(command => [command,
      looksLikePath(command)
        ? (!windowsFiles.has(command) || visible(dirname(command), basename(command)) ? [command] : [])
        : input.paths.filter(entry => visible(entry, command)).map(entry => join(entry, command))]))
    const paths = [...new Set([...byCommand.values()].flat())]
    if (paths.length > 32_768) throw engineFailure('ENGINE_LOOKUP_PATH_LIMIT')
    const identities = new Map<string, ExecutableFileIdentity>()
    let next = 0
    let failure: Error | undefined
    await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (!expired && next < paths.length) {
        const file = paths[next++]
        try {
          await access(file, windowsFiles.has(file) ? constants.F_OK : constants.X_OK)
          const info = await stat(file, { bigint: true })
          if (!info.isFile()) continue
          let realPath: string
          try { realPath = await realpath(file) } catch {
            try { realPath = await readlink(file) } catch { realPath = normalize(file) }
          }
          identities.set(file, { path: normalize(file), realPath, fileKey: `${info.dev}:${BigInt.asUintN(64, info.ino)}` })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') {
            expired = true; failure = engineFailure('ENGINE_LOOKUP_FAILED')
          }
        }
      }
    }))
    if (failure) throw failure
    if (expired) throw engineFailure('ENGINE_LOOKUP_TIMEOUT')
    if (key !== ownershipKey()) throw engineFailure('ENGINE_LOOKUP_CHANGED')
    return ownershipSnapshot(input, command => (byCommand.get(command) ?? []).flatMap(file => identities.get(file) ?? []),
      hermesBootFileKey(windowsCandidates.find(file => identities.has(file)) ?? input.hermes))
  })()
  // Do not start another pass while a timed-out filesystem read is still outstanding.
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(engineFailure('ENGINE_LOOKUP_TIMEOUT')) }, 10_000)
  })
  const result = Promise.race([work, deadline]).catch(ownershipUnavailable)
  ownershipFlight = result
  void work.finally(() => {
    clearTimeout(timer)
    if (ownershipFlight === result) ownershipFlight = null
  }).catch(() => {})
  return result
}

/** Historical name retained while callers migrate; the snapshot now covers every engine. */
export function agentCommandOwnershipSnapshot(): AgentCommandOwnershipSnapshot {
  return engineBinaryOwnershipSnapshot()
}

/** Engines owning the observed executable image. Multiple results mean the install itself is ambiguous. */
export function engineFileOwners(
  fileKeys: readonly (string | null | undefined)[],
  snapshot: AgentCommandOwnershipSnapshot,
): AgentEngine[] {
  if (!snapshot.engineFileKeys) return []
  return PROCESS_ENGINES.filter((engine) => fileKeys.some((fileKey) => !!fileKey && snapshot.engineFileKeys!.get(engine)?.has(fileKey)))
}

export function agentAliasOwner(
  fileKeys: readonly (string | null | undefined)[],
  snapshot: AgentCommandOwnershipSnapshot,
): AgentAliasOwner {
  let cursor = false
  let grok = false
  for (const fileKey of fileKeys) {
    if (!fileKey) continue
    if (snapshot.conflictingFileKeys.has(fileKey)) return 'conflict'
    if (snapshot.cursorFileKeys.has(fileKey)) cursor = true
    if (snapshot.grokFileKeys.has(fileKey)) grok = true
  }
  if (cursor && grok) return 'conflict'
  if (cursor) return 'cursor'
  if (grok) return 'grok'
  return 'unknown'
}

/**
 * Cursor recap must never spawn Grok merely because Grok won the `agent` name in this daemon's PATH.
 * Return null when the machine offers no verified Cursor command; the worker then fails explicitly.
 */
export function cursorRuntimeBin(snapshot = agentCommandOwnershipSnapshot()): string | null {
  if (env.CURSOR_PATH) {
    const configured = commandCandidates(env.CURSOR_PATH)[0]
    if (!configured) return null
    return agentAliasOwner([configured.fileKey], snapshot) === 'grok'
      || agentAliasOwner([configured.fileKey], snapshot) === 'conflict'
      ? null
      : env.CURSOR_PATH
  }

  const agent = snapshot.agentCandidates[0]
  if (agent && agentAliasOwner([agent.fileKey], snapshot) === 'cursor') return 'agent'
  const cursorAgent = snapshot.cursorAgentCandidates[0]
  if (cursorAgent && agentAliasOwner([cursorAgent.fileKey], snapshot) === 'cursor') return 'cursor-agent'
  return null
}

/** Launch control must not run the synchronous interactive-shell fallback.
 * Resolve one captured environment asynchronously; the version probe then owns
 * and verifies the selected executable before it publishes an answer. */
export async function opencodeBinAsync(): Promise<string> {
  const configured = env.OPENCODE_PATH
  if (configured) return configured
  const snapshot = await agentCommandOwnershipSnapshotAsync()
  return snapshot.engineCandidates?.get('opencode')?.[0]?.path ?? 'opencode'
}

/** Resolve an installed executable for real-engine verification without trusting a colliding alias. */
export function installedEngineBin(
  engine: AgentEngine,
  snapshot = agentCommandOwnershipSnapshot(),
): string | null {
  const installed = snapshot.engineCandidates?.get(engine)
  if (installed?.length && engine !== 'cursor' && engine !== 'grok') return installed[0].path
  const command = engine === 'cursor' ? cursorRuntimeBin(snapshot) : engineBin(engine)
  if (!command) return null
  const candidates = commandCandidates(command)
  if (engine === 'cursor' || engine === 'grok') {
    return candidates.find((candidate) => agentAliasOwner([candidate.fileKey], snapshot) === engine)?.path ?? null
  }
  return candidates[0]?.path ?? null
}

/** Existing env override only; process matching must not treat a default basename as ownership proof. */
export function enginePathOverride(engine: AgentEngine): string | undefined {
  switch (engine) {
    case 'claude': return env.CLAUDE_PATH
    case 'codex': return process.env.CODEX_PATH
    case 'cursor': return env.CURSOR_PATH
    case 'opencode': return env.OPENCODE_PATH
    case 'pi': return env.PI_PATH
    case 'omp': return env.OMP_PATH
    case 'hermes': return env.HERMES_PATH
    case 'commandcode': return env.COMMANDCODE_PATH
    case 'devin': return env.DEVIN_PATH
    case 'muse': return env.MUSE_PATH
    case 'amp': return env.AMP_PATH
    case 'kilo': return env.KILO_PATH
    case 'grok': return env.GROK_PATH
    case 'agy': return env.AGY_PATH
    case 'copilot': return env.COPILOT_PATH
    case 'openclaw': return env.OPENCLAW_PATH
    case 'terminal': return undefined
  }
}

export function engineBin(engine: AgentEngine, platform: NodeJS.Platform = process.platform): string {
  switch (engine) {
    case 'claude': return env.CLAUDE_PATH || ENGINE_CLI_COMMANDS.claude
    case 'codex': return process.env.CODEX_PATH || ENGINE_CLI_COMMANDS.codex
    // `cursor-agent` is the vendor-documented command; `agent` remains a discovery alias only
    // because Grok publishes the same basename.
    case 'cursor': return env.CURSOR_PATH || ENGINE_CLI_COMMANDS.cursor
    case 'opencode': return env.OPENCODE_PATH || ENGINE_CLI_COMMANDS.opencode
    case 'pi': return env.PI_PATH || ENGINE_CLI_COMMANDS.pi
    case 'omp': return env.OMP_PATH || ENGINE_CLI_COMMANDS.omp
    case 'hermes': return env.HERMES_PATH || ENGINE_CLI_COMMANDS.hermes
    // command-code's package `bin` lists `cmd` first and its README uses it. On Windows `cmd` is the command processor,
    // found on PATH before npm's shim (the Windows VM, F7): there it is `command-code`, from the same package.
    case 'commandcode': return env.COMMANDCODE_PATH || (platform === 'win32' ? 'command-code' : ENGINE_CLI_COMMANDS.commandcode)
    case 'devin': return env.DEVIN_PATH || ENGINE_CLI_COMMANDS.devin
    case 'muse': return env.MUSE_PATH || ENGINE_CLI_COMMANDS.muse
    case 'amp': return env.AMP_PATH || ENGINE_CLI_COMMANDS.amp
    case 'kilo': return env.KILO_PATH || ENGINE_CLI_COMMANDS.kilo
    case 'grok': return env.GROK_PATH || ENGINE_CLI_COMMANDS.grok
    case 'agy': return env.AGY_PATH || ENGINE_CLI_COMMANDS.agy
    case 'copilot': return env.COPILOT_PATH || ENGINE_CLI_COMMANDS.copilot
    case 'openclaw': return env.OPENCLAW_PATH || ENGINE_CLI_COMMANDS.openclaw
    // Never launched by name — `buildEngineLaunchArgv` builds the shell argv itself.
    case 'terminal': return ENGINE_CLI_COMMANDS.terminal
  }
}
