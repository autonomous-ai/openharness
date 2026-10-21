import { createHash, randomUUID } from 'node:crypto'
import { readHookCredential } from '../hookAuth.js'
import { outsideCaller } from '../../agentClient/model.js'

const USAGE = 'Usage: harness autonomous-device addon state [--device <id>]'
  + ' | addon propose --act <act> --holds-ms <ms> [--why <why>] [--sure <0..1>] [--params <json>] [--note <text>] [--addon <name>] [--key <key>] [--device <id>]'
  + ' | addon proposal <proposalId> [--json]. To retry a propose that got no answer, pass the same --key, which it prints.'

const VALUE_FLAGS = new Set(['--device', '--act', '--holds-ms', '--why', '--sure', '--params', '--note', '--addon', '--key'])

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
export async function runAddonCommand(argv: string[], dataDir: string, port: number, env: NodeJS.ProcessEnv = process.env): Promise<number> {
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
  const allowed = verb === 'state' ? ['--device'] : verb === 'proposal' ? [] : verb === 'propose' ? [...VALUE_FLAGS] : null
  if (invalid || !allowed || [...flags.keys()].some(f => !allowed.includes(f)) || args.length !== (verb === 'proposal' ? 2 : 1)) return usage()

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
