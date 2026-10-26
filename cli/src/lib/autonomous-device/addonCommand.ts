import { createHash, randomUUID } from 'node:crypto'
import { readHookCredential } from '../hookAuth.js'
import { outsideCaller } from '../../agentClient/model.js'
import { WebSocket } from 'ws'
import { deviceRequest } from '../../devices/client.js'
import { localCredentialHeaders } from '../localCredential.js'

const USAGE = 'Usage: harness autonomous-device addon state [--device <id>]'
  + ' | addon propose --act <act> --holds-ms <ms> [--why <why>] [--sure <0..1>] [--params <json>] [--note <text>] [--addon <name>] [--key <key>] [--device <id>]'
  + ' | addon proposal <proposalId> [--json]. --machine <name> instead of --device: a device that is one of your Harness machines.'
  + ' To retry a propose that got no answer, pass the same --key, which it prints.'

const VALUE_FLAGS = new Set(['--device', '--machine', '--act', '--holds-ms', '--why', '--sure', '--params', '--note', '--addon', '--key'])

/** Asks another of the owner's machines (`machine_addon`, lib/autonomous-device/machineAddons.ts): its answer, or a throw. */
export type MachineAsk = (machine: string, op: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>

/** The owner's machine `--machine` names, by id or name (case-blind), as this daemon lists the account's machines. */
async function machineIdOf(word: string, dataDir: string, port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/machines`, {
    headers: { 'x-adapter-local': '1', ...localCredentialHeaders(dataDir) }, signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw Object.assign(new Error('Could not read the account\'s machines. Sign in and try again.'), { code: 'MACHINES_UNAVAILABLE' })
  const body = await response.json() as { data?: { machines?: Record<string, unknown>[] }; machines?: Record<string, unknown>[] }
  const rows = (body.data?.machines ?? body.machines ?? []).filter(row => typeof row.machineId === 'string' && !row.isShared)
  const lower = word.toLowerCase()
  const found = rows.find(row => row.machineId === word)
    ?? rows.find(row => [row.name, row.hostname].some(name => typeof name === 'string' && name.toLowerCase() === lower))
  if (!found) throw Object.assign(new Error(`None of your machines is called ${word}.`), { code: 'MACHINE_NOT_FOUND' })
  return found.machineId as string
}

const askMachine = (dataDir: string, port: number): MachineAsk => async (machine, op, input) => {
  const machineId = await machineIdOf(machine, dataDir, port)
  return deviceRequest({ port, dataDir, machineId: async () => null, connect: (url, headers) => new WebSocket(url, { headers }) },
    machineId, 'machine_addon', { op, input })
}

/**
 * The add-on's name a device is told: `--addon`, or the agent whose shell runs this, as its engine and a short
 * hash of how Harness names the outside caller (agentClient/model.ts): one name per session, without the
 * session's own id, which the device has no need of. Said by this computer, not proven to the device: the
 * device rate-limits and judges every proposal whatever it is called (docs/autonomous-device-addons.md).
 */
function addonName(given: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (given) return given
  const caller = outsideCaller(env, '')
  if (!caller) return undefined
  const engine = caller.engine.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'agent'
  return `${engine}-${createHash('sha256').update(caller.agentId).digest('hex').slice(0, 12)}`
}

/** A confidence, 0 to 1, written plainly: no empty value, hex or exponent read as a number. */
const SURE = /^(0(\.\d{1,6})?|1(\.0{1,6})?|\.\d{1,6})$/
const WHOLE = /^\d{1,6}$/

/** `harness autonomous-device addon …`: read what paired devices publish, or propose to one. */
export async function runAddonCommand(argv: string[], dataDir: string, port: number, env: NodeJS.ProcessEnv = process.env,
  ask: MachineAsk = askMachine(dataDir, port)): Promise<number> {
  const json = argv.includes('--json'), args: string[] = [], flags = new Map<string, string>()
  let invalid = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') continue
    if (VALUE_FLAGS.has(a)) {
      if (flags.has(a) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) invalid = true
      else flags.set(a, argv[++i])
    } else if (a.startsWith('--')) invalid = true
    else args.push(a)
  }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, json ? undefined : 2))
  const usage = (message = USAGE) => { print({ error: { code: 'INVALID_ARGUMENT', message } }); return 1 }
  const verb = args[0]
  const allowed = verb === 'state' ? ['--device', '--machine'] : verb === 'proposal' ? ['--machine'] : verb === 'propose' ? [...VALUE_FLAGS] : null
  if (invalid || !allowed || [...flags.keys()].some(f => !allowed.includes(f)) || args.length !== (verb === 'proposal' ? 2 : 1)) return usage()
  if (flags.has('--machine') && flags.has('--device')) return usage('Name a paired device with --device, or a machine with --machine, not both')

  let path: string, method = 'GET', body: Record<string, unknown> | undefined
  if (verb === 'state') {
    const device = flags.get('--device')
    path = `addon/state${device ? `?deviceId=${encodeURIComponent(device)}` : ''}`
  } else if (verb === 'proposal') {
    path = `addon/proposal?proposalId=${encodeURIComponent(args[1])}`
  } else {
    const act = flags.get('--act'), holds = flags.get('--holds-ms')
    if (!act || !holds) return usage('propose needs --act and --holds-ms')
    if (!WHOLE.test(holds)) return usage('--holds-ms is a whole number of milliseconds')
    if (flags.has('--sure') && !SURE.test(flags.get('--sure')!)) return usage('--sure is a number from 0 to 1')
    const addon = addonName(flags.get('--addon'), env)
    if (!addon) return usage('Name the add-on with --addon: no agent is running this shell')
    let params: unknown
    if (flags.has('--params')) {
      try { params = JSON.parse(flags.get('--params')!) } catch { return usage('--params must be a JSON object') }
    }
    const sure = flags.has('--sure') ? Number(flags.get('--sure')) : undefined
    body = { addon, act, holdsMs: Number(holds),
      // A fresh key per invocation: a retry of the same shell command is a new proposal. Pass --key to make it one.
      idempotencyKey: flags.get('--key') ?? randomUUID().replace(/-/g, ''),
      ...(flags.has('--why') ? { why: flags.get('--why') } : {}), ...(sure !== undefined ? { sure } : {}),
      ...(params !== undefined ? { params } : {}), ...(flags.has('--note') ? { note: flags.get('--note') } : {}),
      ...(flags.has('--device') ? { deviceId: flags.get('--device') } : {}) }
    path = 'addon/propose'; method = 'POST'
  }
  const machine = flags.get('--machine')
  if (machine) {
    const input = verb === 'proposal' ? { proposalId: args[1] } : verb === 'state' ? {} : body!
    try {
      const answer = await ask(machine, verb, input)
      const error = answer.error as { code?: unknown } | string | undefined
      if (error !== undefined) {
        // An older machine answers a bare code; this one says what went wrong.
        print({ error: typeof error === 'string' ? { code: error, message: error } : error, ...(body ? { idempotencyKey: body.idempotencyKey } : {}) })
        return 1
      }
      print(answer.result ?? answer)
      return 0
    } catch (error) {
      const code = (error as { code?: unknown }).code
      print({ error: { code: typeof code === 'string' ? code : 'OUTCOME_UNKNOWN', message: error instanceof Error ? error.message : String(error) },
        ...(body ? { idempotencyKey: body.idempotencyKey } : {}) })
      return 1
    }
  }
  const credential = readHookCredential(dataDir)
  if (!credential) { print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Start Harness with harness start first.' } }); return 1 }
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/autonomous-device/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const answer = await result.json() as Record<string, unknown>
    // A propose that failed says the key it used, so a retry can send the same proposal at most once.
    print(!result.ok && body ? { ...answer, idempotencyKey: body.idempotencyKey } : answer)
    return result.ok ? 0 : 1
  } catch {
    print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Could not reach the Harness Autonomous device API. Start or update Harness CLI.' } })
    return 1
  }
}
