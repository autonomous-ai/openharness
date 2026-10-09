/**
 * Connected services, given to each agent as an MCP server on the local bridge. Agent configs hold only a
 * 127.0.0.1 address with this user's capability in it; the bridge adds the credential to each request
 * (Grid's design). A renewed token needs no config change, and an agent already running keeps working.
 *
 * Only entries Harness made are changed or removed: their names are recorded in projections.json, so a
 * server the person added by hand keeps its name and contents. A config that is not plain JSON (comments)
 * is left exactly as it is. Configs are replaced through a symlink, as engines/kit/folderTrust.ts does.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { CODE, locked, writePrivate, type Store } from './store.js'
import { transport } from './rest.js'

/** The bridge's fixed address, which every agent entry names. HARNESS_CONNECTIONS_PORT moves it (tests). */
export function bridgePort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.HARNESS_CONNECTIONS_PORT ?? 51793)
  return Number.isInteger(port) && port >= 0 && port < 65536 ? port : 51793
}

/** The capability in every bridge address, so only this user's agents can use it. */
export function bridgeKey(vault: Store): string {
  return locked(vault.root, () => {
    const key = vault.file('bridge.json').key
    if (typeof key === 'string' && key.length >= 32) return key
    const fresh = randomBytes(32).toString('base64url')
    writePrivate(join(vault.root, 'bridge.json'), { key: fresh })
    return fresh
  })
}

export function bridgeUrl(key: string, code: string, port = bridgePort()): string {
  return `http://127.0.0.1:${port}/${key}/${code}/mcp`
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

export interface Agent {
  name: string
  installed(): boolean
  /** Make `wanted` (name → bridge address) the Harness entries; returns the names now Harness's. */
  apply(wanted: Record<string, string>, owned: string[]): string[]
}

class JsonAgent implements Agent {
  constructor(readonly name: string, private readonly binary: string, private readonly path: string,
    private readonly env: NodeJS.ProcessEnv, private readonly key: string, private readonly entry: (url: string) => Record<string, unknown>) {}

  installed(): boolean { return existsSync(this.path) || onPath(this.binary, this.env) }

  apply(wanted: Record<string, string>, owned: string[]): string[] {
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
    for (const [name, url] of Object.entries(wanted)) {
      if (name in servers && !owned.includes(name)) continue // The person's own server with this name.
      servers[name] = this.entry(url)
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
  readonly name = 'codex'
  constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv) {}

  installed(): boolean { return existsSync(this.path) || onPath('codex', this.env) }

  private static header(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|"${escaped}")\\s*(?:\\.[^\\]]*)?\\]\\s*$`)
  }

  apply(wanted: Record<string, string>, owned: string[]): string[] {
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
    for (const [name, url] of Object.entries(wanted).sort(([a], [b]) => a.localeCompare(b))) {
      if (kept.some(line => CodexAgent.header(name).test(line))) continue // The person's own server.
      kept.push('', `[mcp_servers.${name}]`, `url = ${JSON.stringify(url)}`)
      result.push(name)
    }
    while (kept.length && !kept[0].trim()) kept.shift()
    replace(this.path, kept.length ? kept.join('\n') + '\n' : '')
    return result
  }
}

export function agents(env: NodeJS.ProcessEnv = process.env): Agent[] {
  const config = env.XDG_CONFIG_HOME || join(home(env), '.config')
  return [
    new JsonAgent('claude', 'claude', join(env.CLAUDE_CONFIG_DIR || home(env), '.claude.json'), env, 'mcpServers',
      url => ({ type: 'http', url })),
    new CodexAgent(join(env.CODEX_HOME || join(home(env), '.codex'), 'config.toml'), env),
    new JsonAgent('opencode', 'opencode', join(config, 'opencode', 'opencode.json'), env, 'mcp',
      url => ({ type: 'remote', url, enabled: true })),
  ]
}

/** Give every installed agent exactly the connections that have MCP tools (their own, or REST served as MCP). */
export function sync(vault: Store, env: NodeJS.ProcessEnv = process.env, list: Agent[] = agents(env)): Record<string, string[]> {
  const codes = Object.entries(vault.tokens()).filter(([code, token]) => transport(token) !== 'none' && CODE.test(code)).map(([code]) => code)
  const key = codes.length ? bridgeKey(vault) : ''
  const wanted = Object.fromEntries(codes.map(code => [code, bridgeUrl(key, code, bridgePort(env))]))
  return locked(vault.root, () => {
    const record = vault.file('projections.json') as Record<string, unknown>
    const changed: Record<string, string[]> = {}
    for (const agent of list) {
      const raw = record[agent.name]
      const owned = Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string' && CODE.test(name)) : []
      if ((!owned.length && !codes.length) || !agent.installed()) continue
      changed[agent.name] = agent.apply(wanted, owned)
    }
    writePrivate(join(vault.root, 'projections.json'), { ...record, ...changed })
    return changed
  })
}
