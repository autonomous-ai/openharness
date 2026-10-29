/**
 * `harness computer-use`: Harness OS's tools for an agent to try what it builds as a person would, off until the person
 * turns them on. Two machine MCP servers (lib/machineMcp.ts, #1872), both bundled in the OS:
 *
 * - `playwright`: Playwright's MCP server (os/packaging/playwright-mcp) driving the OS's Chromium, for a website: it
 *   opens pages, clicks, types and reads them and their console. A window of its own, on the screen.
 * - `desktop`: the desktop (os/desktop_mcp.py), for a desktop app: screenshots, and the mouse and keys on them.
 *
 *     harness computer-use            on or off
 *     harness computer-use on         attached to every agent started from now on (Claude Code, Codex, OpenCode)
 *     harness computer-use off        taken off again
 *
 * Turning them on or off writes this machine's mcp-servers.json, read at each Claude Code and Codex start, and
 * OpenCode's own config (below): a harness running already gets them when it restarts. The person's phone does the same (services/osDevice.ts `computer_use`). An agent may
 * not: a server runs inside every later agent.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { MACHINE_MCP_MOST_SERVERS, readMachineMcp, writeMachineMcp, type MachineMcpServer, type MachineMcpServers } from '../lib/machineMcp.js'
import { outsideCaller } from './model.js'

export const PLAYWRIGHT_MCP = '/usr/lib/harness-os/playwright-mcp/node_modules/@playwright/mcp/cli.js'
export const DESKTOP_MCP = '/usr/lib/harness-os/desktop_mcp.py'
export const CHROMIUM = '/usr/bin/chromium'
const NODE = '/usr/bin/node'
const PYTHON = '/usr/bin/python3'
/** The machine MCP servers' names: the agents' tools are `mcp__playwright__…` and `mcp__desktop__…`. */
export const COMPUTER_USE = ['playwright', 'desktop'] as const

/** A refusal, as the agent verbs exit (commands.ts `EXIT.refused`): not a failure to retry. */
const REFUSED = 5

export const COMPUTER_USE_USAGE = `Usage: harness computer-use [on|off]

Tools for the agents Harness starts on this Harness OS computer to try what they build as a person would, off until
you turn them on:
  playwright   a website, in a Chromium window of its own: open it, click, type, read it and its console
  desktop      a desktop app: screenshots of the screen, and the mouse and keyboard on them
On, Claude Code and Codex agents Harness starts from now on get them, and OpenCode (its own config); a harness
running already gets them when you restart it. Each agent asks you before it uses them. Only you turn them on or off:
an agent is refused.`

/** The servers' entries; [home] places Playwright's screenshots and snapshots out of the project's folder. */
export function computerUseServers(home: string = homedir()): Record<(typeof COMPUTER_USE)[number], MachineMcpServer> {
  return {
    playwright: {
      command: NODE,
      args: [PLAYWRIGHT_MCP, '--executable-path', CHROMIUM, '--isolated', '--output-dir', join(home, '.cache', 'harness-os', 'playwright-mcp')],
      engines: [],
      projects: [],
    },
    desktop: { command: PYTHON, args: [DESKTOP_MCP], engines: [], projects: [] },
  }
}

/** Whether this computer carries them: Harness OS from the release that bundles them. */
export const computerUseAvailable = (exists: (path: string) => boolean = existsSync): boolean =>
  [PLAYWRIGHT_MCP, DESKTOP_MCP, CHROMIUM].every((path) => exists(path))

/** On: both attached. */
export const computerUseOn = (servers: MachineMcpServers): boolean => COMPUTER_USE.every((name) => !!servers[name])

/**
 * OpenCode, whose launch takes no MCP server: its own global config, as Connections writes it
 * (lib/connectors/agents.ts), read by its background service on `opencode reload`. OpenCode 2 (Harness OS has
 * 2.0.21) keeps them under `mcp.servers`, a local one as `{ type: 'local', command }`, as `opencode mcp add --global`
 * writes them; OpenCode 1 directly under `mcp`, with `enabled`. Only an entry running one of these servers is
 * Harness's to change: one of the person's under the same name stays.
 */
export interface Opencode {
  /** Its global opencode.json. */
  path: string
  /** Its major version, or null when it is not installed. */
  major: () => number | null
  /** Asks its service to read the config again. */
  reload: () => void
}

export function machineOpencode(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): Opencode {
  return {
    path: join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json'),
    major: () => {
      try {
        const out = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
        const major = /(\d+)\.\d+\.\d+/.exec(out)?.[1]
        return major ? Number(major) : null
      } catch { return null }
    },
    reload: () => {
      // Its service picks the change up now; a failure only leaves it to the next start.
      execFile('opencode', ['reload'], { timeout: 30_000 }, () => {})
    },
  }
}

const ours = (entry: unknown): boolean => {
  const command = (entry as { command?: unknown } | null)?.command
  return Array.isArray(command) && command.some((part) => part === PLAYWRIGHT_MCP || part === DESKTOP_MCP)
}

/** Put the computer-use tools into OpenCode's config, or take them out: what it could not do, in words, or null. */
export function applyOpencode(on: boolean, opencode: Opencode, home: string = homedir()): string | null {
  const major = opencode.major()
  if (major === null) return null
  let data: Record<string, unknown> = {}
  if (existsSync(opencode.path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(opencode.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      data = parsed as Record<string, unknown>
    } catch {
      return `OpenCode's ${opencode.path} is not plain JSON, so it was left as it is: OpenCode does not get them.`
    }
  } else if (!on) return null
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const mcp = record(data.mcp)
  const servers = major >= 2 ? record(mcp.servers) : mcp
  const skipped: string[] = []
  for (const [name, server] of Object.entries(computerUseServers(home))) {
    if (servers[name] !== undefined && !ours(servers[name])) { if (on) skipped.push(name); continue }
    if (!on) { delete servers[name]; continue }
    const command = [server.command, ...server.args]
    servers[name] = major >= 2 ? { type: 'local', command } : { type: 'local', command, enabled: true }
  }
  if (major >= 2) {
    if (Object.keys(servers).length) mcp.servers = servers
    else delete mcp.servers
  }
  if (Object.keys(mcp).length) data.mcp = mcp
  else delete data.mcp
  mkdirSync(dirname(opencode.path), { recursive: true })
  const temporary = `${opencode.path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n')
  renameSync(temporary, opencode.path)
  opencode.reload()
  return skipped.length ? `OpenCode already has its own ${skipped.join(' and ')}, so it was left as it is.` : null
}

/** Turn them on or off in this machine's mcp-servers.json (Claude Code, Codex) and OpenCode's config: whether they
 *  are on afterwards and what OpenCode could not take, or why it could not. */
export function setComputerUse(
  on: boolean, dataDir: string = env.ADAPTER_DATA_DIR, home: string = homedir(), opencode: Opencode = machineOpencode(process.env, home),
): { on: boolean; note?: string } | { error: string } {
  const { servers, why } = readMachineMcp(dataDir)
  if (why) return { error: `Fix or remove it first: ${why}` }
  if (on) {
    const added = COMPUTER_USE.filter((name) => !servers[name]).length
    if (Object.keys(servers).length + added > MACHINE_MCP_MOST_SERVERS) {
      return { error: `At most ${MACHINE_MCP_MOST_SERVERS} machine MCP servers: remove one with harness mcp-servers remove first.` }
    }
    Object.assign(servers, computerUseServers(home))
  } else {
    for (const name of COMPUTER_USE) delete servers[name]
  }
  writeMachineMcp(servers, dataDir)
  const note = applyOpencode(on, opencode, home)
  return note ? { on, note } : { on }
}

export interface ComputerUseDeps {
  dataDir?: string
  home?: string
  exists?: (path: string) => boolean
  opencode?: Opencode
  /** Who runs it, by what its shell says (model.ts `outsideCaller`): an agent may ask, never change. */
  env?: NodeJS.ProcessEnv
  /** Whether it runs in a pane a Harness daemon made (cli.ts, as for `harness mcp-servers`): refused alike. */
  inPane?: boolean
  out?: (line: string) => void
  err?: (line: string) => void
}

export function computerUseCommand(argv: readonly string[], deps: ComputerUseDeps = {}): number {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  const dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
  if (argv.includes('--help') || argv.includes('-h')) { out(COMPUTER_USE_USAGE); return 0 }
  const [verb = 'status', ...rest] = argv
  if (rest.length || !['status', 'on', 'off'].includes(verb)) { err(COMPUTER_USE_USAGE); return 2 }
  if (!computerUseAvailable(deps.exists)) {
    err('Computer use comes with Harness OS (Playwright and the desktop MCP): this computer has no such tools.')
    return 1
  }
  if (verb === 'status') {
    const { servers, why } = readMachineMcp(dataDir)
    if (why) { err(`Not read, so no agent gets them: ${why}`); return 1 }
    out(computerUseOn(servers)
      ? 'Computer use is on: agents Harness starts get playwright and desktop. harness computer-use off takes them off.'
      : 'Computer use is off. harness computer-use on gives the agents Harness starts playwright and desktop.')
    return 0
  }
  const agent = outsideCaller(deps.env ?? process.env, '')
  if (agent || deps.inPane) {
    err(`${agent ? agent.name : 'An agent in a Harness pane'} may not turn computer use on or off: its tools run inside every `
      + 'later agent here. Ask the person to turn them on from their phone (the computer\'s Computer use), or to run '
      + `harness computer-use ${verb} in a terminal outside Harness.`)
    return REFUSED
  }
  const home = deps.home ?? homedir()
  const result = setComputerUse(verb === 'on', dataDir, home, deps.opencode ?? machineOpencode(process.env, home))
  if ('error' in result) { err(result.error); return 1 }
  out(result.on
    ? 'Computer use on: agents started from now on get playwright and desktop. Restart a running harness to give it them.'
    : 'Computer use off: agents started from now on don\'t get them. Restart a running harness to take them away.')
  if (result.note) err(result.note)
  return 0
}
