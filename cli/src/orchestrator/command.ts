import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'
import { installedHarnessCatalog, orchestratorEngineSupported } from './catalog.js'
import { checkFlowHarnesses, compileFlow, FlowError, harnessIssueCode, parseFlowSource } from './flow.js'
import { OrchestratorError, StartSpec } from './model.js'
import type { HarnessChoice } from './prompts.js'

export function localOrchestratorRequest(port: number, machineId: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString('hex')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`)
    let settled = false
    const finish = (error?: Error, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('The daemon did not confirm this operation. Check status before retrying.')), timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } })))
    ws.on('error', error => finish(error))
    ws.on('close', () => finish(new Error('The local daemon disconnected. Check status before retrying.')))
    ws.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'connected') ws.send(JSON.stringify({ type: 'orchestrator', payload: { ...payload, requestId } }))
        if (frame.type === 'orchestrator_result' && frame.payload?.requestId === requestId) finish(undefined, frame.payload)
      } catch { finish(new Error('The local daemon returned an invalid response.')) }
    })
  })
}

function daemonTarget(portArg?: number, machineArg?: string): { port: number; machineId: string } {
  const port = portArg ?? env.PORT, machineId = machineArg ?? readAuthSession()?.machineId ?? ''
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !machineId) throw new Error('A running local daemon and machine identity are required (--port, --machine).')
  return { port, machineId }
}

export function parseAnswerArgs(action: 'approve' | 'reject', rest: string[]): { taskId: string; attempt?: number; decision?: string; comment?: string } {
  const [taskId, ...options] = rest
  if (!taskId || taskId.startsWith('--')) throw new Error(`Usage: harness orchestrator ${action} <project> <task> [--attempt N]${action === 'approve' ? ' [--decision ID]' : ''} [--comment TEXT]`)
  const result: { taskId: string; attempt?: number; decision?: string; comment?: string } = { taskId }
  for (let i = 0; i < options.length; i++) {
    const option = options[i], value = options[i + 1]
    if (option !== '--attempt' && option !== '--comment' && !(option === '--decision' && action === 'approve')) throw new Error(action === 'approve' ? 'approve takes --attempt, --decision and --comment.' : 'reject takes --attempt and --comment only.')
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value.`)
    i++
    if (option === '--attempt') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) throw new Error('--attempt takes a whole number from 1.')
      result.attempt = n
    } else if (option === '--comment') result.comment = value
    else result.decision = value
  }
  return result
}

export function parseOrchestratorArgs(argv: readonly string[]): { port: number; machineId: string; payload: Record<string, unknown> } {
  const args: string[] = []
  let portArg: number | undefined, machineArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') portArg = Number(argv[++i])
    else if (argv[i] === '--machine') machineArg = argv[++i] ?? ''
    else args.push(argv[i])
  }
  const { port, machineId } = daemonTarget(portArg, machineArg)
  const [action, id, ...rest] = args
  const payload: Record<string, unknown> = { action, id }
  switch (action) {
    case 'list': case 'catalog': case 'status': case 'resume': break
    case 'plan': payload.tasks = JSON.parse(rest[0] ?? 'null'); break
    case 'retry': case 'cancel': if (rest[0]) payload.taskId = rest[0]; break
    case 'finish': case 'fail':
      Object.assign(payload, { taskId: rest[0], attempt: Number(rest[1]), summary: rest[2], artifacts: rest.slice(3) }); break
    case 'complete': payload.summary = rest[0]; break
    case 'message': Object.assign(payload, { text: rest[0], messageId: rest[1] ?? randomBytes(16).toString('hex') }); break
    case 'steer': Object.assign(payload, { taskId: rest[0], attempt: Number(rest[1]), text: rest[2], messageId: rest[3] ?? randomBytes(16).toString('hex') }); break
    case 'approve': case 'reject': Object.assign(payload, parseAnswerArgs(action, rest)); break
    default: throw new Error('Usage: harness orchestrator [--port N --machine ID] run|list|catalog|status|plan|finish|fail|retry|cancel|resume|complete|message|steer|approve|reject [project-id] [arguments]')
  }
  return { port, machineId, payload }
}
export async function orchestratorCommand(argv: readonly string[], deps: { request?: typeof localOrchestratorRequest } = {}): Promise<number> {
  const request = deps.request ?? localOrchestratorRequest
  const at = argv.findIndex((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--port' && argv[i - 1] !== '--machine')
  if (argv[at] === 'run') return flowRunCommand([...argv.slice(0, at), ...argv.slice(at + 1)], { err: text => console.error(text.trimEnd()) })
  try {
    const { port, machineId, payload } = parseOrchestratorArgs(argv)
    if ((payload.action === 'approve' || payload.action === 'reject') && payload.attempt === undefined) {
      const status = await request(port, machineId, { action: 'status', id: payload.id })
      if (status.error) {
        console.log(JSON.stringify(status, null, 2))
        return 1
      }
      const tasks = (status.project as { tasks?: { id: string; state: string; attempt: number }[] } | undefined)?.tasks ?? []
      const task = tasks.find(t => t.id === payload.taskId)
      if (task?.state !== 'waiting') {
        console.error(`${payload.taskId} is not waiting for a decision (state ${task?.state ?? 'unknown'}).`)
        return 1
      }
      payload.attempt = task.attempt
    }
    const reply = await request(port, machineId, payload)
    console.log(JSON.stringify(summarizeOrchestratorReply(reply), null, 2))
    return reply.error ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Orchestrator request failed.')
    return 1
  }
}

/** Tool output is a work ledger, not a repeated copy of the director's whole
 * conversation and every specialist brief. The UI still receives full state. */
export function summarizeOrchestratorReply(reply: Record<string, unknown>): Record<string, unknown> {
  if (!reply.project || typeof reply.project !== 'object' || Array.isArray(reply.project)) return reply
  const { fingerprint: _fingerprint, messages, tasks, ...project } = reply.project as Record<string, unknown>
  return { ...reply, project: {
    ...project,
    tasks: Array.isArray(tasks) ? tasks.map(({ prompt: _prompt, ...task }) => task) : [],
    deliveries: Array.isArray(messages) ? messages.filter(m => m.delivery).slice(-20).map(m => ({
      id: m.id, targetAgentId: m.targetAgentId, delivery: m.delivery,
      deliveryReason: m.deliveryReason, text: String(m.text).slice(0, 160),
    })) : [],
  } }
}

const FLOW_USAGE = 'Usage: harness orchestrator run <flow> [--input name=value]... [--cwd DIR] [--engine ENGINE] [--parallelism N] [--bypass-permission] [--dry-run] [--port N --machine ID]'
export interface FlowArgs { flow: string; inputs: Record<string, string>; dryRun: boolean; bypassPermission: boolean; cwd?: string; engine?: string; parallelism?: number; port?: number; machine?: string }
export function parseFlowArgs(argv: readonly string[]): FlowArgs {
  const args: FlowArgs = { flow: '', inputs: {}, dryRun: false, bypassPermission: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(arg === '--input' ? 'Pass inputs as --input name=value.' : `${arg} needs a value.`)
      return next
    }
    if (arg === '--input') {
      const pair = value(), at = pair.indexOf('=')
      if (at < 1) throw new Error('Pass inputs as --input name=value.')
      const name = pair.slice(0, at)
      if (Object.hasOwn(args.inputs, name)) throw new Error(`Duplicate input: ${name}`)
      args.inputs[name] = pair.slice(at + 1)
    } else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--bypass-permission') args.bypassPermission = true
    else if (arg === '--cwd') args.cwd = value()
    else if (arg === '--engine') args.engine = value()
    else if (arg === '--parallelism') {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error('--parallelism takes a whole number from 1 to 6.')
      args.parallelism = n
    } else if (arg === '--port') args.port = Number(value())
    else if (arg === '--machine') args.machine = value()
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    else if (!args.flow) args.flow = arg
    else throw new Error(FLOW_USAGE)
  }
  if (!args.flow) throw new Error(FLOW_USAGE)
  return args
}
export function resolveFlowPath(ref: string, cwd: string, home: string, isFile: (path: string) => boolean): { path: string; byName: boolean } {
  const direct = resolve(cwd, ref)
  if (isFile(direct)) return { path: direct, byName: false }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(ref)) throw new OrchestratorError('FLOW_NOT_FOUND', `No flow file at ${ref}.`)
  for (const folder of [join(cwd, '.harness', 'flows'), join(home, '.harness', 'flows')]) {
    const found = ['yaml', 'yml', 'json'].map(ext => join(folder, `${ref}.${ext}`)).filter(isFile)
    if (found.length > 1) throw new OrchestratorError('FLOW_AMBIGUOUS', `${found.join(' and ')} both define ${ref}; keep one.`)
    if (found.length) return { path: found[0], byName: true }
  }
  throw new OrchestratorError('FLOW_NOT_FOUND', `No flow named ${ref} in ${join(cwd, '.harness', 'flows')} or ~/.harness/flows.`)
}

interface FlowIo { cwd: string; home: string; out(text: string): void; err(text: string): void; catalog(): HarnessChoice[]; engineSupported(engine: string): boolean; request: typeof localOrchestratorRequest }
const defaultIo = (): FlowIo => ({
  cwd: process.cwd(), home: homedir(), out: text => { process.stdout.write(text) }, err: text => { process.stderr.write(text) },
  catalog: installedHarnessCatalog, engineSupported: orchestratorEngineSupported, request: localOrchestratorRequest,
})
const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** `run <flow>`: compile and check locally (no daemon for --dry-run), then start it on the local daemon. */
export async function flowRunCommand(argv: readonly string[], overrides: Partial<FlowIo> = {}): Promise<number> {
  const io = { ...defaultIo(), ...overrides }
  try {
    const args = parseFlowArgs(argv)
    const cwd = resolve(io.cwd, args.cwd ?? '.')
    const located = resolveFlowPath(args.flow, cwd, io.home, isFile)
    const source = readFileSync(located.path, 'utf8')
    const parsed = parseFlowSource(source, located.path)
    const compiled = compileFlow(parsed, args.inputs)
    const engine = args.engine ?? compiled.engine ?? 'claude'
    const problems = checkFlowHarnesses(parsed, compiled, engine, io.catalog(), io.engineSupported)
    if (problems.length) throw new FlowError(located.path, problems, harnessIssueCode(problems))
    const warnings = [...compiled.warnings]
    if (located.byName && compiled.name !== basename(located.path, extname(located.path))) warnings.push(`${basename(located.path)} declares name ${compiled.name}.`)
    for (const warning of warnings) io.err(`warning: ${warning}\n`)
    const start = {
      id: randomBytes(16).toString('hex'), engine, cwd, bypassPermission: args.bypassPermission,
      prompt: compiled.description ? `${compiled.name}: ${compiled.description}` : `Flow ${compiled.name}`,
      ...(args.parallelism !== undefined ? { parallelism: args.parallelism } : {}),
      flow: { source, path: located.path }, inputs: args.inputs,
    }
    const checked = StartSpec.safeParse(start)
    if (!checked.success) throw new Error(`The daemon would refuse this run:\n${checked.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')}`)
    if (args.dryRun) {
      io.out(`${JSON.stringify({ flow: { name: compiled.name, path: located.path, sha256: parsed.sha256 }, engine, inputs: compiled.inputs, warnings, tasks: compiled.tasks }, null, 2)}\n`)
      return 0
    }
    const { port, machineId } = daemonTarget(args.port, args.machine)
    const reply = await io.request(port, machineId, { action: 'start', ...start })
    io.out(`${JSON.stringify(summarizeOrchestratorReply(reply), null, 2)}\n`)
    return reply.error ? 1 : 0
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : 'Flow run failed.'}\n`)
    return 1
  }
}
