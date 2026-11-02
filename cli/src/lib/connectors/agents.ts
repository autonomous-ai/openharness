/**
 * Connected services, given to each agent as an MCP server on the local bridge. Agent configs hold only the command of a stdio
 * shim to the bridge's 0600 socket (mcpShimSource.ts), or where no socket can be (Windows, a folder too long for one) a 127.0.0.1
 * address with this user's capability in it; the bridge adds the credential to each request (Grid's design). A renewed token
 * needs no config change, and an agent already running keeps working.
 *
 * Only entries Harness made are changed or removed: their names are recorded in projections.json, so a
 * server the person added by hand keeps its name and contents. A config that is not plain JSON (comments)
 * is left exactly as it is. Configs are replaced through a symlink, as engines/kit/folderTrust.ts does.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { defaultCodexHome, listCodexProfiles } from '../codexProfiles.js'
import { managedNodePath } from '../nodeRuntime.js'
import { MCP_SHIM_SOURCE } from './mcpShimSource.js'
import { CODE, locked, writePrivate, type Store } from './store.js'
import { transport } from './rest.js'

const validPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 0 && port < 65536

/**
 * The bridge's address, which every agent entry names: 51793, or the port [vault] saved because another account held
 * that one (saveBridgePort). HARNESS_CONNECTIONS_PORT fixes it (tests).
 */
export function bridgePort(env: NodeJS.ProcessEnv = process.env, vault?: Store): number {
  if (env.HARNESS_CONNECTIONS_PORT !== undefined) {
    const port = Number(env.HARNESS_CONNECTIONS_PORT)
    return validPort(port) ? port : 51793
  }
  const saved = vault?.file('bridge.json').port
  return validPort(saved) && saved > 0 ? saved : 51793
}

/**
 * Remember the port the bridge moved to. A Team account's daemon starts at boot and this user's only at login, so that
 * account can hold 51793 before this bridge ever starts (audit H1), and it then would hear every agent's tool calls.
 */
export function saveBridgePort(vault: Store, port: number): void {
  locked(vault.root, () => { writePrivate(join(vault.root, 'bridge.json'), { ...vault.file('bridge.json'), port }) })
}

/** The capability in every bridge address, so only this user's agents can use it. */
export function bridgeKey(vault: Store): string {
  return locked(vault.root, () => {
    const key = vault.file('bridge.json').key
    if (typeof key === 'string' && key.length >= 32) return key
    const fresh = randomBytes(32).toString('base64url')
    writePrivate(join(vault.root, 'bridge.json'), { ...vault.file('bridge.json'), key: fresh })
    return fresh
  })
}

/**
 * The capability for Harness's own calls through the bridge (its cloud agents, services/cloud.ts): a second key,
 * in `harness-key.json`, never written into an agent's configuration. The bridge's key is in every agent's MCP
 * entry, so an agent (one a page talked into it) could otherwise list the connections and spend a Devin or
 * Cursor key through the `/api/` route.
 */
export function harnessKey(vault: Store): string {
  return locked(vault.root, () => {
    const key = vault.file('harness-key.json').key
    if (typeof key === 'string' && key.length >= 32) return key
    const fresh = randomBytes(32).toString('base64url')
    writePrivate(join(vault.root, 'harness-key.json'), { key: fresh })
    return fresh
  })
}

export function bridgeUrl(key: string, code: string, port = bridgePort()): string {
  return `http://127.0.0.1:${port}/${key}/${code}/mcp`
}

/** sockaddr_un has 104 bytes on macOS and the socket is staged under a name no longer (lib/localSocket.ts). */
const MAX_SOCKET_PATH_BYTES = 96

/** The bridge's 0600 socket for MCP clients, in the vault's private folder, or null where there is none. */
export function bridgeSocketPath(vault: Store, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  const path = join(vault.root, 'bridge.sock')
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES ? path : null
}

/** How an MCP client reaches one connection. */
export type McpEntry = { url: string } | { command: string; args: string[] }

/**
 * The shim, written fresh into the vault's private folder (mcpShimSource.ts). Its node is Harness's managed one, as an agent started
 * outside Harness may have neither `harness` nor a node on its PATH. That path names a version, or this process's node where no runtime
 * is recorded: the daemon's next start writes the entries again.
 */
function writeShim(vault: Store): string {
  const path = join(vault.root, 'mcp-shim.mjs')
  mkdirSync(vault.root, { recursive: true, mode: 0o700 })
  if (!existsSync(path) || readFileSync(path, 'utf8') !== MCP_SHIM_SOURCE) {
    const staged = `${path}.${process.pid}.tmp`
    writeFileSync(staged, MCP_SHIM_SOURCE, { mode: 0o600 })
    renameSync(staged, path)
  }
  return path
}

function home(env: NodeJS.ProcessEnv): string { return env.HOME || homedir() }

function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  const names = process.platform === 'win32' ? [binary + '.cmd', binary + '.exe', binary] : [binary]
  return (env.PATH ?? '').split(delimiter).some(dir => dir && names.some(name => existsSync(join(dir, name))))
}

/** Replace a config atomically, through a symlink, keeping its permissions. */
function replace(file: string, text: string): void {
  if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true })
  const target = existsSync(file) ? realpathSync(file) : file
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
  const tmp = `${target}.harness-${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, target)
}

/** The real path of [path], or its absolute form where it does not exist yet. */
function real(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/**
 * Whether the config [file] is inside the profile [folder] once symlinks are followed. A person's dotfiles in the default home
 * may be links elsewhere; a profile home is only that profile's own, and a link out of it is not written through.
 */
function within(folder: string, file: string): boolean {
  const root = real(folder)
  const target = existsSync(file) ? real(file) : join(real(dirname(file)), file.slice(dirname(file).length + 1))
  return target.startsWith(root + sep)
}

export interface Agent {
  name: string
  installed(): boolean
  /** Make `wanted` (name → how to reach it) the Harness entries; returns the names now Harness's. */
  apply(wanted: Record<string, McpEntry>, owned: string[]): string[]
}

class JsonAgent implements Agent {
  constructor(readonly name: string, private readonly binary: string, private readonly path: string,
    private readonly env: NodeJS.ProcessEnv, private readonly key: string, private readonly entry: (reach: McpEntry) => Record<string, unknown>,
    private readonly profile: string | null = null) {}

  installed(): boolean { return !!this.profile || existsSync(this.path) || onPath(this.binary, this.env) }

  apply(wanted: Record<string, McpEntry>, owned: string[]): string[] {
    if (this.profile && !within(this.profile, this.path)) return owned
    let data: Record<string, unknown> = {}
    if (existsSync(this.path)) {
      try { data = JSON.parse(readFileSync(this.path, 'utf8')) } catch { return owned }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return owned
    }
    const current = data[this.key]
    if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) return owned
    const servers = { ...(current as Record<string, unknown> | undefined) }
    for (const name of owned) if (!(name in wanted)) delete servers[name]
    const result: string[] = []
    for (const [name, reach] of Object.entries(wanted)) {
      if (name in servers && !owned.includes(name)) continue // The person's own server with this name.
      servers[name] = this.entry(reach)
      result.push(name)
    }
    if (Object.keys(servers).length) data[this.key] = servers
    else delete data[this.key]
    replace(this.path, JSON.stringify(data, null, 2) + '\n')
    return result.sort()
  }
}

/** Codex's config.toml, edited as text: Harness's tables are removed whole and written again at the end. */
class CodexAgent implements Agent {
  constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv, readonly name = 'codex', private readonly profile: string | null = null) {}

  installed(): boolean { return !!this.profile || existsSync(this.path) || onPath('codex', this.env) }

  private static header(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|"${escaped}")\\s*(?:\\.[^\\]]*)?\\]\\s*$`)
  }

  apply(wanted: Record<string, McpEntry>, owned: string[]): string[] {
    if (this.profile && !within(this.profile, this.path)) return owned
    let lines: string[] = []
    if (existsSync(this.path)) {
      try { lines = readFileSync(this.path, 'utf8').split('\n') } catch { return owned }
      if (lines.at(-1) === '') lines.pop()
    }
    const kept: string[] = []
    let skipping = false
    for (const line of lines) {
      if (line.trimStart().startsWith('[')) skipping = owned.some(name => CodexAgent.header(name).test(line))
      if (!skipping) kept.push(line)
    }
    while (kept.length && !kept.at(-1)!.trim()) kept.pop()
    const result: string[] = []
    for (const [name, reach] of Object.entries(wanted).sort(([a], [b]) => a.localeCompare(b))) {
      if (kept.some(line => CodexAgent.header(name).test(line))) continue // The person's own server.
      // JSON's strings and arrays of them are TOML's too.
      kept.push('', `[mcp_servers.${name}]`, ...'url' in reach ? [`url = ${JSON.stringify(reach.url)}`]
        : [`command = ${JSON.stringify(reach.command)}`, `args = ${JSON.stringify(reach.args)}`])
      result.push(name)
    }
    while (kept.length && !kept[0].trim()) kept.shift()
    replace(this.path, kept.length ? kept.join('\n') + '\n' : '')
    return result
  }
}

const claudeEntry = (reach: McpEntry): Record<string, unknown> =>
  'url' in reach ? { type: 'http', url: reach.url } : { type: 'stdio', command: reach.command, args: reach.args }

const claudeFile = (env: NodeJS.ProcessEnv): string => join(env.CLAUDE_CONFIG_DIR || home(env), '.claude.json')
const codexFile = (env: NodeJS.ProcessEnv): string => join(env.CODEX_HOME || join(home(env), '.codex'), 'config.toml')

export function agents(env: NodeJS.ProcessEnv = process.env): Agent[] {
  const config = env.XDG_CONFIG_HOME || join(home(env), '.config')
  return [
    new JsonAgent('claude', 'claude', claudeFile(env), env, 'mcpServers', claudeEntry),
    new CodexAgent(codexFile(env), env),
    new JsonAgent('opencode', 'opencode', join(config, 'opencode', 'opencode.json'), env, 'mcp',
      reach => 'url' in reach ? { type: 'remote', url: reach.url, enabled: true } : { type: 'local', command: [reach.command, ...reach.args], enabled: true }),
  ]
}

let listedCodex: { key: string; at: number; folders: Set<string> } | null = null

/** The Codex profiles this machine lists (the real paths), read at most every 30 s: discovery reads shell startup files. */
function codexProfileFolders(env: NodeJS.ProcessEnv): Set<string> {
  const key = `${home(env)}\0${env.CODEX_HOME ?? ''}`
  if (!listedCodex || listedCodex.key !== key || Date.now() - listedCodex.at > 30_000) {
    const environment = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    listedCodex = { key, at: Date.now(), folders: new Set(listCodexProfiles([], { home: home(env), environment }).map(profile => profile.path)) }
  }
  return listedCodex.folders
}

/** Test seam: forget the Codex profiles read so far. */
export function resetProfileCache(): void { listedCodex = null }

/**
 * The agent for a Claude profile (CLAUDE_CONFIG_DIR) or Codex profile (CODEX_HOME) folder: the default homes' entries, in the
 * profile's own files. Its name carries the folder, so projections.json records what Harness wrote there apart from the default
 * home; an agent runs under the folder, so the engine counts as installed. It never writes through a link that leaves the folder.
 * Null for the default home (the default agent has it, wherever a link leads), for a folder that is not an absolute path and, with
 * [listed], for a Codex folder this machine does not list as a profile (a Claude folder is checked where the launch is asked for,
 * core/agents/launches.ts).
 */
function profileAgent(engine: 'claude' | 'codex', folder: string, env: NodeJS.ProcessEnv, listed = true): Agent | null {
  if (!isAbsolute(folder)) return null
  const name = `${engine}:${folder}`
  if (engine === 'claude') {
    if (real(folder) === real(dirname(claudeFile(env)))) return null
    return new JsonAgent(name, 'claude', join(folder, '.claude.json'), env, 'mcpServers', claudeEntry, folder)
  }
  if (real(folder) === defaultCodexHome(home(env), env)) return null
  if (listed && !codexProfileFolders(env).has(real(folder))) return null
  return new CodexAgent(join(folder, 'config.toml'), env, name, folder)
}

/**
 * The profile homes Harness has written entries into, from projections.json. A folder that is gone took its entries with it; one
 * that is no longer a profile of this machine has them taken out (`release`). Both are forgotten.
 */
function recordedProfiles(record: Record<string, unknown>, env: NodeJS.ProcessEnv): { gone: string[]; agents: Agent[]; release: Agent[] } {
  const found: { gone: string[]; agents: Agent[]; release: Agent[] } = { gone: [], agents: [], release: [] }
  for (const key of Object.keys(record)) {
    const match = /^(claude|codex):(.+)$/.exec(key)
    if (!match) continue
    const engine = match[1] as 'claude' | 'codex'
    const agent = existsSync(match[2]) ? profileAgent(engine, match[2], env) : null
    if (agent) { found.agents.push(agent); continue }
    const unlisted = existsSync(match[2]) ? profileAgent(engine, match[2], env, false) : null
    if (unlisted) found.release.push(unlisted)
    found.gone.push(key)
  }
  return found
}

type Targets = { agents: Agent[]; gone?: string[]; release?: Agent[]; remember?: string[] }

/** Give the agents in [list] exactly the connections that have MCP tools (their own, or REST served as MCP). */
function project(vault: Store, env: NodeJS.ProcessEnv, list: (record: Record<string, unknown>) => Targets, waitMs?: number): Record<string, string[]> {
  const codes = Object.entries(vault.tokens()).filter(([code, token]) => transport(token) !== 'none' && CODE.test(code)).map(([code]) => code)
  const socket = bridgeSocketPath(vault)
  const shim = codes.length && socket ? writeShim(vault) : ''
  const key = codes.length && !socket ? bridgeKey(vault) : ''
  const wanted = Object.fromEntries(codes.map((code): [string, McpEntry] => [code, socket
    ? { command: managedNodePath(), args: [shim, '--socket', socket, code] }
    : { url: bridgeUrl(key, code, bridgePort(env, vault)) }]))
  return locked(vault.root, () => {
    const record = vault.file('projections.json') as Record<string, unknown>
    const { agents: targets, gone = [], release = [], remember = [] } = list(record)
    const ownedBy = (agent: Agent): string[] => {
      const raw = record[agent.name]
      return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string' && CODE.test(name)) : []
    }
    // One agent whose config cannot be written (a read-only home) leaves the others, and what was recorded, as they are.
    const attempt = (agent: Agent, work: () => void): void => {
      try { work() } catch (error) { console.warn(`[connections] could not update ${agent.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const changed: Record<string, string[]> = {}
    for (const agent of targets) {
      const owned = ownedBy(agent)
      if ((!owned.length && !codes.length) || !agent.installed()) continue
      attempt(agent, () => { changed[agent.name] = agent.apply(wanted, owned) })
    }
    for (const agent of release) if (ownedBy(agent).length) attempt(agent, () => { agent.apply({}, ownedBy(agent)) })
    const kept = Object.fromEntries(Object.entries(record).filter(([name]) => !gone.includes(name)))
    // A profile home with nothing to write yet is still recorded, so a connection made later reaches it.
    for (const name of remember) if (!(name in changed) && !(name in kept)) kept[name] = []
    writePrivate(join(vault.root, 'projections.json'), { ...kept, ...changed })
    return changed
  }, waitMs)
}

/**
 * Give every installed agent exactly the connections that have MCP tools, in its default home and in each profile home an agent
 * was launched under (syncProfileHome), so a connection made or removed later reaches a running profile's config too.
 */
export function sync(vault: Store, env: NodeJS.ProcessEnv = process.env, list?: Agent[]): Record<string, string[]> {
  return project(vault, env, record => {
    if (list) return { agents: list }
    const profiles = recordedProfiles(record, env)
    return { agents: [...agents(env), ...profiles.agents], gone: profiles.gone, release: profiles.release }
  })
}

/**
 * Give the agent about to run under [folder] (its Claude profile or Codex profile) the same entries the default home has. The
 * default home, a Codex folder this machine does not list as a profile and a link out of the folder change nothing. Called as an
 * agent launches, so it waits for the vault's lock for seconds, not the half minute a connection change may.
 */
export function syncProfileHome(vault: Store, engine: 'claude' | 'codex', folder: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const agent = profileAgent(engine, folder, env)
  if (!agent) return []
  // Desktop's "Add Claude account" names the folder before Claude Code makes it.
  if (engine === 'claude') mkdirSync(folder, { recursive: true, mode: 0o700 })
  return project(vault, env, () => ({ agents: [agent], remember: [agent.name] }), 3_000)[agent.name] ?? []
}
