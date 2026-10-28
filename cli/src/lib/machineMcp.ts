/**
 * Machine MCP servers (#1872): local stdio MCP servers the person attaches to the agents Harness starts on this machine,
 * such as a paired lamp's `lamp-mcp` (autonomous-ai/lampOS `sdk/mcp`). Kept in `<data dir>/mcp-servers.json` on this
 * machine alone: never synced, never sent to the backend or another machine. Only the person changes it through
 * `harness mcp-servers` (agentClient/mcpServers.ts refuses an agent outright: an entry runs a command inside every later
 * agent).
 *
 *     {"servers": {"lamp": {"command": "lamp-mcp", "args": [], "engines": ["claude", "codex"], "projects": []}}}
 *
 * What it does not carry, after harness-reviewer's read: no tool approval (a file the agent's own user can write cannot
 * hold the person's consent, so each engine asks for these tools as for any server), and no environment (only `command`
 * and `args` reach the agent's command line, which other users of the computer can read; a server reads any secret from
 * its own config).
 *
 * Read at every launch, the create and each relaunch (core/agents/create.ts, lib/launchOverrides.ts, beside
 * `agentLaunchArgs`), so a change reaches the next start and a resumed agent keeps its servers. Added beside the
 * person's own servers and a grid's web tools, never in their place. A file that does not parse, or that others could
 * write, adds nothing: it is never half-read.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { env } from '../config/env.js'
import { ENGINES } from '../engines/types.js'

export const MACHINE_MCP_FILE = 'mcp-servers.json'
/** Engines with a launch path for a machine server in this Harness, read off each binary (below). Another engine in a
 *  file is kept and skipped at its launch with a line in the log, so a later Harness's file still reads. Hermes takes
 *  its servers only through the managed-scope overlay a grid launch owns (lib/gridWebMcp.ts): a follow-up. */
export const MACHINE_MCP_ENGINES = ['claude', 'codex'] as const
/** A bare word: Codex's `-c mcp_servers.<name>…` path takes a TOML bare key, and every engine names the tools by it
 *  (`mcp__<name>__…`), so one spelling reads the same everywhere. */
export const MACHINE_MCP_NAME = /^[a-z][a-z0-9_]{0,31}$/
/** The grid's own server is `harness` (lib/gridWebMcp.ts `HARNESS_MCP_SERVER_NAME`): never shadowed. */
const RESERVED = new Set(['harness'])
export const MACHINE_MCP_MOST_SERVERS = 8
export const MACHINE_MCP_MOST_BYTES = 64 * 1024
const MOST_ARGS = 32

export interface MachineMcpServer {
  command: string
  args: string[]
  /** Empty: every engine in [MACHINE_MCP_ENGINES]. */
  engines: string[]
  /** Harness project names (`~/harnesses/<name>`), matched by the launch folder; empty: every folder. */
  projects: string[]
}

export type MachineMcpServers = Record<string, MachineMcpServer>

export const machineMcpPath = (dataDir: string = env.ADAPTER_DATA_DIR): string => join(dataDir, MACHINE_MCP_FILE)

const isStrings = (value: unknown, most: number): value is string[] =>
  Array.isArray(value) && value.length <= most && value.every((each) => typeof each === 'string' && each.length <= 4096)

/** One entry as stored, or why it is not one. Keys this Harness does not know are left out. */
export function machineMcpServer(name: string, raw: unknown): MachineMcpServer | string {
  if (!MACHINE_MCP_NAME.test(name) || RESERVED.has(name)) return `${name}: a name is a-z, then a-z, 0-9 or _, at most 32, and not harness`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${name}: an entry is an object`
  const entry = raw as Record<string, unknown>
  if (typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 4096) return `${name}: command is the program to run`
  const args = entry.args ?? []
  if (!isStrings(args, MOST_ARGS)) return `${name}: args is a list of at most ${MOST_ARGS} strings`
  const engines = entry.engines ?? []
  if (!isStrings(engines, ENGINES.length) || !engines.every((each) => (ENGINES as readonly string[]).includes(each))) {
    return `${name}: engines are Harness's engine names`
  }
  const projects = entry.projects ?? []
  if (!isStrings(projects, 64) || !projects.every((each) => /^[A-Za-z0-9._-]{1,100}$/.test(each) && !each.startsWith('.'))) {
    return `${name}: projects are Harness project names`
  }
  return { command: entry.command, args, engines, projects }
}

/** The servers in [text], or why the file is not read: all of it, or none. */
export function parseMachineMcp(text: string): { ok: true; servers: MachineMcpServers } | { ok: false; why: string } {
  if (Buffer.byteLength(text) > MACHINE_MCP_MOST_BYTES) return { ok: false, why: `${MACHINE_MCP_FILE} is over ${MACHINE_MCP_MOST_BYTES} bytes` }
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { return { ok: false, why: `${MACHINE_MCP_FILE} is not JSON: ${error instanceof Error ? error.message : error}` } }
  const servers = (value as { servers?: unknown } | null)?.servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return { ok: false, why: `${MACHINE_MCP_FILE} is {"servers": {NAME: {...}}}` }
  const names = Object.keys(servers)
  if (names.length > MACHINE_MCP_MOST_SERVERS) return { ok: false, why: `at most ${MACHINE_MCP_MOST_SERVERS} servers` }
  const read: MachineMcpServers = {}
  for (const name of names) {
    const entry = machineMcpServer(name, (servers as Record<string, unknown>)[name])
    if (typeof entry === 'string') return { ok: false, why: entry }
    read[name] = entry
  }
  return { ok: true, servers: read }
}

/** Why a file others could change is not read: on POSIX, group- or world-writable, or another user's. */
function looseFile(file: string): string | null {
  if (process.platform === 'win32') return null
  const stat = lstatSync(file)
  if (!stat.isFile()) return `${file} is not a plain file`
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return `${file} belongs to another user`
  if (stat.mode & 0o022) return `${file} is writable by others (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`
  return null
}

/** This machine's servers: none when there is no file; for a file that is not read, none and why. */
export function readMachineMcp(dataDir: string = env.ADAPTER_DATA_DIR): { servers: MachineMcpServers; why?: string } {
  const file = machineMcpPath(dataDir)
  if (!existsSync(file)) return { servers: {} }
  let text: string
  try {
    const loose = looseFile(file)
    if (loose) return { servers: {}, why: loose }
    text = readFileSync(file, 'utf8')
  } catch (error) { return { servers: {}, why: `${file}: ${error instanceof Error ? error.message : error}` } }
  const parsed = parseMachineMcp(text)
  return parsed.ok ? { servers: parsed.servers } : { servers: {}, why: `${file}: ${parsed.why}` }
}

/** Replaced whole, mode 0600 (a 0600 temporary file renamed over it), so a launch never reads half a change. */
export function writeMachineMcp(servers: MachineMcpServers, dataDir: string = env.ADAPTER_DATA_DIR): void {
  const file = machineMcpPath(dataDir)
  const text = `${JSON.stringify({ servers }, null, 2)}\n`
  const parsed = parseMachineMcp(text)
  if (!parsed.ok) throw new Error(parsed.why)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** Whether [cwd] is in one of [projects]' folders (`~/harnesses/<name>`, as Harness makes them). */
function inProjects(projects: readonly string[], cwd: string | null | undefined, home: string): boolean {
  if (!projects.length) return true
  if (!cwd) return false
  return projects.some((project) => {
    const below = relative(join(home, 'harnesses', project), cwd)
    return below === '' || (!below.startsWith('..') && !isAbsolute(below))
  })
}

/** The servers [engine] gets for a launch in [cwd], and the names of those it would get but has no path for here. */
export function machineMcpFor(servers: MachineMcpServers, engine: string, cwd: string | null | undefined, home: string = homedir()):
  { servers: MachineMcpServers; noPath: string[] } {
  const chosen: MachineMcpServers = {}
  const noPath: string[] = []
  const hasPath = (MACHINE_MCP_ENGINES as readonly string[]).includes(engine)
  for (const [name, server] of Object.entries(servers)) {
    const engines: readonly string[] = server.engines.length ? server.engines : MACHINE_MCP_ENGINES
    if (!engines.includes(engine) || !inProjects(server.projects, cwd, home)) continue
    if (hasPath) chosen[name] = server
    else noPath.push(name)
  }
  return { servers: chosen, noPath }
}

/**
 * The argv that attaches [servers] to [engine]'s launch: `command` and `args` only.
 *
 * Claude Code (2.1.312, 2026-10-28): `--mcp-config <configs...>` takes JSON strings as well as files, and is variadic,
 * so it is given in the one-token `=` form: tried on the binary, `--mcp-config <json> hello` read `hello` as a config
 * file, and `--mcp-config=<json> hello` did not; a server given this way answered a real `claude -p` call. A second
 * `--mcp-config` beside a grid's is taken. Never `--strict-mcp-config`: the person's own servers stay.
 *
 * Codex (codex-cli 0.137.0, 2026-10-28): `-c mcp_servers.<name>.command=<TOML>` and `.args=<TOML array>`, read back by
 * `codex mcp list --json` as a stdio server with the arguments exactly as given.
 */
export function machineMcpArgs(engine: string, servers: MachineMcpServers): string[] {
  const names = Object.keys(servers)
  if (!names.length) return []
  if (engine === 'claude') {
    const mcpServers = Object.fromEntries(names.map((name) => [name, { type: 'stdio', command: servers[name].command, args: servers[name].args }]))
    return [`--mcp-config=${JSON.stringify({ mcpServers })}`]
  }
  if (engine === 'codex') {
    return names.flatMap((name) => [
      '-c', `mcp_servers.${name}.command=${JSON.stringify(servers[name].command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(servers[name].args)}`,
    ])
  }
  return []
}

/** This machine's servers for one launch of [engine] in [cwd], as argv. A file that is not read, and a server the
 *  engine has no path for, are each said in the daemon's log and add nothing. */
export function machineMcpLaunchArgs(engine: string, cwd: string | null | undefined, dataDir: string = env.ADAPTER_DATA_DIR): string[] {
  const { servers, why } = readMachineMcp(dataDir)
  if (why) console.warn(`[agent] machine MCP servers not added · ${why}`)
  const { servers: chosen, noPath } = machineMcpFor(servers, engine, cwd)
  if (noPath.length) console.warn(`[agent] machine MCP servers not added · ${engine} has no machine MCP path in this Harness yet (${noPath.join(', ')})`)
  return machineMcpArgs(engine, chosen)
}
