import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'
import { teamRpc } from './client.js'
import { TeamError } from './model.js'
import { watchTeam } from './tui.js'

const usage = `Harness team — connect existing agents across engines

  harness team list
  harness team context --agent AGENT_ID
  harness team create --file team.json
  harness team --team ID members|get|pause|resume|archive
  harness team --team ID watch
  harness team --team ID add|edit --file member.json
  harness team --team ID ask NAME 'question' --from MEMBER_ID [--id ID]
  harness team --team ID status|wait|cancel QUESTION_ID
  harness team --team ID inbox [--member MEMBER_ID]
  harness team --team ID reply QUESTION_ID 'answer' [--text-file PATH]

Agent commands include --member-key from the team introduction. They automatically
identify the sender. --machine chooses the team's owning machine; the local daemon
uses its paired encrypted connection. --port selects an isolated local daemon.
Ask is asynchronous. Wait is bounded (default 30 seconds, maximum 60) and returns
incoming questions first. A wait timeout leaves the question active.
Use --json for structured output. Preserve --id when retrying an uncertain ask.
For uncertain create/add results, preserve the returned operationId as id in the JSON file.`

export interface TeamArgs {
  port: number
  machineId: string
  payload: Record<string, unknown>
  json: boolean
  waitSeconds: number | null
  watch: boolean
}

export function parseTeamArgs(argv: readonly string[], defaults: { port: number; machineId: string }): TeamArgs {
  const values = new Map<string, string>(), args: string[] = []
  let json = false
  const allowed = new Set(['--port', '--machine', '--team', '--member-key', '--from', '--member', '--id', '--context', '--seconds', '--ttl', '--file', '--text-file', '--parent', '--evidence', '--agent'])
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--json') { json = true; continue }
    if (value.startsWith('--')) {
      if (!allowed.has(value) || argv[i + 1] === undefined) throw new TeamError('USAGE', usage)
      values.set(value, argv[++i])
    } else args.push(value)
  }
  const port = Number(values.get('--port') ?? defaults.port)
  const machineId = values.get('--machine') ?? defaults.machineId
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !machineId) throw new TeamError('USAGE', 'Choose the team machine with --machine and a running daemon port with --port.')
  const [action, first, ...rest] = args
  const actions = new Set(['context', 'list', 'create', 'get', 'history', 'members', 'ask', 'reply', 'inbox', 'status', 'wait', 'watch', 'add', 'edit', 'cancel', 'pause', 'resume', 'archive'])
  if (!actions.has(action)) throw new TeamError('USAGE', usage)
  const payload: Record<string, unknown> = { action: action === 'wait' ? 'status' : action === 'watch' || action === 'history' ? 'get' : action }
  if (values.has('--team')) payload.teamId = values.get('--team')
  if (action === 'context') payload.agentId = values.get('--agent')
  if (values.has('--member-key')) payload.memberKey = values.get('--member-key')
  if (values.has('--member')) payload.memberId = values.get('--member')
  const readText = (): string => {
    const path = values.get('--text-file')
    if (path) return readFileSync(path, 'utf8')
    return rest.join(' ')
  }
  switch (action) {
    case 'create': {
      const file = values.get('--file')
      if (!file) throw new TeamError('USAGE', 'Create needs --file with {id, name, members:[{machineId, agentId, name, role}]}.')
      const input = JSON.parse(readFileSync(file, 'utf8'))
      Object.assign(payload, input, { action: 'create', id: input.id ?? randomBytes(16).toString('hex') })
      break
    }
    case 'add': case 'edit': {
      const file = values.get('--file')
      if (!file) throw new TeamError('USAGE', 'Membership changes need --file with the member identity, name, and role. Add uses an operation id; edit includes enabled.')
      const member = JSON.parse(readFileSync(file, 'utf8'))
      payload.action = action === 'add' ? 'add_member' : 'member'
      payload.member = action === 'add' ? { ...member, id: member.id ?? randomBytes(16).toString('hex') } : member
      break
    }
    case 'ask':
      Object.assign(payload, { to: first, text: readText(), id: values.get('--id') ?? randomBytes(16).toString('hex') })
      if (values.has('--from')) payload.from = values.get('--from')
      if (values.has('--context')) payload.context = values.get('--context')
      if (values.has('--ttl')) payload.ttlMs = Number(values.get('--ttl')) * 1000
      if (values.has('--parent')) payload.parentId = values.get('--parent')
      break
    case 'reply': Object.assign(payload, { questionId: first, text: readText(), evidence: values.has('--evidence') ? [values.get('--evidence')] : [] }); break
    case 'status': case 'wait': case 'cancel': payload.questionId = first; break
  }
  const seconds = Number(values.get('--seconds') ?? 30)
  if (action === 'wait' && (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)) throw new TeamError('USAGE', 'Wait must be between 1 and 60 seconds.')
  return { port, machineId, payload, json, waitSeconds: action === 'wait' ? seconds : null, watch: action === 'watch' }
}

export type TeamCall = (payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>

/** A wait yields incoming work instead of leaving two agents waiting on each other. */
export async function waitForTeamAnswer(payload: Record<string, unknown>, seconds: number, call: TeamCall, timing = {
  now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}): Promise<Record<string, unknown>> {
  const deadline = timing.now() + seconds * 1000
  do {
    const status = await call({ ...payload, action: 'status' })
    const exchange = status.exchange as Record<string, unknown>
    if (!exchange) throw new TeamError('INVALID_RESPONSE', 'The daemon did not return the question.')
    const inbox = await call({ ...payload, action: 'inbox', ...(!payload.memberKey && !payload.memberId ? { memberId: exchange.from } : {}) })
    if (Array.isArray(inbox.questions) && inbox.questions.length) return { ...status, ...inbox, wait: 'incoming_questions', next: 'Answer these incoming questions before waiting again.' }
    if (exchange.state !== 'pending') return { ...status, wait: exchange.state }
    if (timing.now() >= deadline) return { ...status, wait: 'timeout', next: 'The question is still active. Continue independent work or wait again.' }
    await timing.sleep(Math.min(1500, deadline - timing.now()))
  } while (true)
}

export function formatTeamReply(reply: Record<string, unknown>): string {
  if (Array.isArray(reply.teams)) return reply.teams.length ? reply.teams.map((t: any) => `${t.id}  ${t.name}  ${t.state}  ${t.members} teammates · ${t.pending} waiting`).join('\n') : 'No teams yet. Connect existing harnesses from Team in Harness.'
  // Keep question IDs and evidence intact. Structured, readable text is also useful to terminal agents.
  return JSON.stringify(reply, null, 2)
}

export async function teamCommand(argv: readonly string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(usage); return 0 }
  let parsed: TeamArgs | undefined
  try {
    let localId = env.ADAPTER_COMPUTER_ID ?? ''
    if (!localId) try { localId = readFileSync(env.ADAPTER_COMPUTER_ID_FILE, 'utf8').trim() } catch { /* daemon may not have started */ }
    parsed = parseTeamArgs(argv, { port: env.PORT, machineId: readAuthSession()?.machineId ?? localId })
    const options = parsed
    const call: TeamCall = (payload, request) => teamRpc({ ...options, dataDir: env.ADAPTER_DATA_DIR, signal: request?.signal }, 'team', payload)
    if (options.watch) { await watchTeam(options.payload, call); return 0 }
    const reply = options.waitSeconds ? await waitForTeamAnswer(options.payload, options.waitSeconds, call) : await call(options.payload)
    console.log(options.json ? JSON.stringify(reply) : formatTeamReply(reply))
    return 0
  } catch (error) {
    const result = { error: error instanceof TeamError ? error.code : 'TEAM_FAILED', detail: error instanceof Error ? error.message : 'Team request failed.',
      ...(parsed?.payload.id ? { operationId: parsed.payload.id } : {}),
      ...((parsed?.payload.member as Record<string, unknown> | undefined)?.id ? { operationId: (parsed!.payload.member as Record<string, unknown>).id } : {}) }
    console.error(JSON.stringify(result))
    return 1
  }
}
