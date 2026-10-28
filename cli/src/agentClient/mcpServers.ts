/**
 * `harness mcp-servers`: the person's machine MCP servers (lib/machineMcp.ts, #1872), local stdio servers attached to
 * every agent Harness starts on this machine, such as a paired lamp's `lamp-mcp`.
 *
 *     harness mcp-servers                         list them
 *     harness mcp-servers add NAME [--engine E]… [--project P]… -- COMMAND [ARG…]
 *     harness mcp-servers remove NAME
 *
 * Written straight to this machine's data dir, where every launch reads it: nothing is sent anywhere. An agent may not
 * change it, even with the person's yes: an entry runs a command inside every later agent on this machine. No tool
 * approval and no environment are kept (lib/machineMcp.ts): each engine asks for the tools, and only the command and
 * its arguments reach the agent's command line.
 */
import { env } from '../config/env.js'
import { MACHINE_MCP_ENGINES, machineMcpPath, machineMcpServer, MACHINE_MCP_MOST_SERVERS, readMachineMcp, writeMachineMcp } from '../lib/machineMcp.js'
import { outsideCaller } from './model.js'

/** A refusal, as the agent verbs exit (commands.ts `EXIT.refused`): not a failure to retry. */
const REFUSED = 5

export const MCP_SERVERS_USAGE = `Usage: harness mcp-servers [list [--json]]
       harness mcp-servers add NAME [--engine ${MACHINE_MCP_ENGINES.join('|')}]… [--project P]… -- COMMAND [ARG…]
       harness mcp-servers remove NAME

Local MCP servers for the agents Harness starts on this machine (${MACHINE_MCP_ENGINES.join(', ')}), beside their own:
for example a paired lamp's lamp-mcp. Kept in this machine's data dir only, read at each start and relaunch.
  --engine E         only for this engine (repeatable); every one by default
  --project P        only in Harness project P's folder, ~/harnesses/P (repeatable); every folder by default;
                     a renamed project stops matching until you add it again with the new name

Each agent asks you before it uses a server's tools, as for any other server. COMMAND and its arguments are on the
agent's command line, which other users of this computer can read: put no secret there; a server reads one from its own
config or from the environment Harness starts in. Only you change these: an agent is refused, since a server runs a
command inside every later agent.`

export interface McpServersDeps {
  dataDir?: string
  /** Who runs it, by what its shell says (model.ts `outsideCaller`): an agent may list, never change. */
  env?: NodeJS.ProcessEnv
  out?: (line: string) => void
  err?: (line: string) => void
}

export function mcpServersCommand(argv: readonly string[], deps: McpServersDeps = {}): number {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  const dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
  if (argv.includes('--help') || argv.includes('-h')) { out(MCP_SERVERS_USAGE); return 0 }
  const [verb = 'list', ...rest] = argv
  const { servers, why } = readMachineMcp(dataDir)
  if (verb === 'list') {
    if (why) err(`Not read, so no agent gets these: ${why}`)
    if (rest.includes('--json')) { out(JSON.stringify(servers, null, 2)); return why ? 1 : 0 }
    if (rest.length) { err(MCP_SERVERS_USAGE); return 2 }
    const names = Object.keys(servers)
    if (!names.length && !why) out(`No machine MCP servers (${machineMcpPath(dataDir)}).`)
    for (const name of names) {
      const s = servers[name]
      out(`${name}\t${[s.command, ...s.args].join(' ')}\tengines ${(s.engines.length ? s.engines : MACHINE_MCP_ENGINES).join(',')}`
        + `\tprojects ${s.projects.length ? s.projects.join(',') : 'every folder'}`)
    }
    return why ? 1 : 0
  }
  if (verb !== 'add' && verb !== 'remove') { err(MCP_SERVERS_USAGE); return 2 }
  const agent = outsideCaller(deps.env ?? process.env, '')
  if (agent) {
    err(`${agent.name} may not change this machine's MCP servers: a server runs a command inside every later agent here. `
      + 'Tell the person the exact harness mcp-servers command to run themselves.')
    return REFUSED
  }
  if (why) { err(`Fix or remove it first: ${why}`); return 1 }
  if (verb === 'remove') {
    const [name, ...extra] = rest
    if (!name || extra.length) { err(MCP_SERVERS_USAGE); return 2 }
    if (!servers[name]) { err(`No machine MCP server named ${name}.`); return 1 }
    delete servers[name]
    writeMachineMcp(servers, dataDir)
    out(`${name} removed: agents started from now on don't get it.`)
    return 0
  }
  const dash = rest.indexOf('--')
  if (dash < 1 || dash === rest.length - 1) { err(MCP_SERVERS_USAGE); return 2 }
  const [name, ...options] = rest.slice(0, dash)
  const [command, ...args] = rest.slice(dash + 1)
  const engines: string[] = []
  const projects: string[] = []
  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    if ((option === '--engine' || option === '--project') && i + 1 < options.length) (option === '--engine' ? engines : projects).push(options[++i])
    else { err(MCP_SERVERS_USAGE); return 2 }
  }
  const noPath = engines.filter((engine) => !(MACHINE_MCP_ENGINES as readonly string[]).includes(engine))
  if (noPath.length) { err(`${noPath.join(', ')}: this Harness attaches machine MCP servers to ${MACHINE_MCP_ENGINES.join(' and ')} only, so far.`); return 2 }
  const entry = machineMcpServer(name, { command, args, engines, projects })
  if (typeof entry === 'string') { err(entry); return 2 }
  if (!servers[name] && Object.keys(servers).length >= MACHINE_MCP_MOST_SERVERS) { err(`At most ${MACHINE_MCP_MOST_SERVERS} machine MCP servers.`); return 1 }
  const replaced = !!servers[name]
  servers[name] = entry
  writeMachineMcp(servers, dataDir)
  out(`${name} ${replaced ? 'replaced' : 'added'}: agents started from now on get it (${(engines.length ? engines : MACHINE_MCP_ENGINES).join(', ')}).`)
  return 0
}
