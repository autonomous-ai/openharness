import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'
import { TeamError } from './model.js'
import { teamRpc } from './client.js'

const usage = `Harness channel — swarm collaboration

  harness channel list
  harness channel --tab SWARM_ID history|members
  harness channel --tab SWARM_ID consult --from-machine MACHINE_ID --from-agent AGENT_ID [--id OPERATION_ID]

Consult instructs that agent to discover relevant peers in its swarm and continue.
It does not open a picker or choose a recipient for the agent. Members and history
only read the channel. Agents use the scoped team commands in their introduction.
--machine chooses a connected daemon; channel requests route to the swarm's saved host.
Use --json for structured output. Retry an uncertain consult with the same --id.`

export function parseChannelArgs(argv: readonly string[], defaults: { port: number; machineId: string }) {
  const values = new Map<string, string>(), args: string[] = []
  let json = false
  const flags = new Set(['--tab', '--machine', '--port', '--from-machine', '--from-agent', '--id'])
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--json') { json = true; continue }
    if (value.startsWith('--')) {
      if (!flags.has(value) || argv[i + 1] === undefined) throw new TeamError('USAGE', usage)
      values.set(value, argv[++i])
    } else args.push(value)
  }
  const action = args[0]
  if (args.length !== 1 || !['list', 'history', 'members', 'consult'].includes(action)) throw new TeamError('USAGE', usage)
  const port = Number(values.get('--port') ?? defaults.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TeamError('USAGE', 'Choose a valid daemon port.')
  const payload: Record<string, unknown> = { action: action === 'list' ? 'channel_list' : action === 'consult' ? 'channel_consult' : 'channel_get' }
  if (action !== 'list') {
    if (!values.get('--tab')) throw new TeamError('USAGE', 'Choose a channel with --tab. Use channel list to read the saved swarms.')
    payload.tabId = values.get('--tab')
  }
  if (action === 'consult') {
    if (!values.get('--from-machine') || !values.get('--from-agent')) throw new TeamError('USAGE', 'Consult needs the source agent’s --from-machine and --from-agent.')
    payload.id = values.get('--id') ?? randomBytes(16).toString('hex')
    payload.from = { machineId: values.get('--from-machine'), agentId: values.get('--from-agent') }
  }
  return { payload, action, json, port, machineId: values.get('--machine') ?? defaults.machineId }
}

export async function channelCommand(argv: readonly string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(usage); return 0 }
  let parsed: ReturnType<typeof parseChannelArgs> | undefined
  try {
    let localId = env.ADAPTER_COMPUTER_ID ?? ''
    if (!localId) try { localId = readFileSync(env.ADAPTER_COMPUTER_ID_FILE, 'utf8').trim() } catch { /* daemon not started */ }
    parsed = parseChannelArgs(argv, { port: env.PORT, machineId: readAuthSession()?.machineId ?? localId })
    let reply = await teamRpc({ ...parsed, dataDir: env.ADAPTER_DATA_DIR }, 'team', parsed.payload)
    if (parsed.action === 'members') {
      const team = reply.team as Record<string, unknown>
      reply = { tabId: parsed.payload.tabId, name: team.name, members: team.members }
    }
    console.log(JSON.stringify(reply, null, parsed.json ? undefined : 2))
    return 0
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof TeamError ? error.code : 'CHANNEL_UNAVAILABLE',
      detail: error instanceof Error ? error.message : String(error), ...(parsed?.payload.id ? { operationId: parsed.payload.id } : {}) }))
    return 1
  }
}
