import { WebSocket } from 'ws'
import { ENGINES } from '../engines/types.js'
import { deviceRequest } from '../devices/client.js'
import { machineIdOf } from './autonomous-device/addonCommand.js'

const USAGE = 'Usage: harness machines engines <machine> [--engine <engine>]… [--json]'
  + ' — which engines another of your machines has, asked of it now (#1788).'

/** An engine probe answers within each engine's login shell (5 s each, engineProbe.ts), so more than the link's usual 12 s. */
const PROBE_WITHIN_MS = 30_000

/** One engine's readiness on a machine, as printed: `null` is unknown, never "not there". */
export interface EngineReadiness {
  machineId: string
  engine: string
  /** `true`, or `null`: the probe reads a missing command, a login shell that timed out and a failed spawn
   *  all as not installed (engineProbe.ts), so only a failed start says an engine is missing. */
  installed: true | null
  /** Read for claude and codex only, and only once installed; `null` for every other engine. */
  signedIn: boolean | null
  installable: boolean | null
  /** Whether that machine's Harness can start the engine with a first prompt; `null` from an older Harness. */
  firstPrompt: boolean | null
}

/** Asks another of the owner's machines one request over the machine link: its answer, or a throw. */
export type MachineProbe = (machine: string, payload: Record<string, unknown>) => Promise<{ machineId: string; reply: Record<string, unknown> }>

const probeMachine = (dataDir: string, port: number): MachineProbe => async (machine, payload) => {
  const machineId = await machineIdOf(machine, dataDir, port)
  const reply = await deviceRequest({
    port, dataDir, machineId: async () => null, timeoutMs: PROBE_WITHIN_MS,
    connect: (url, headers) => new WebSocket(url, { headers }),
  }, machineId, 'engines_probe', payload)
  return { machineId, reply }
}

/** The probe's answer as one row per engine, read as #1743's consumer reads it (superTabs/machines.ts). */
export function readinessRows(machineId: string, reply: Record<string, unknown>): EngineReadiness[] {
  const engines = Array.isArray(reply.engines) ? reply.engines : []
  return engines.flatMap((entry): EngineReadiness[] => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    if (typeof row.engine !== 'string') return []
    const installed = row.installed === true ? true : null
    return [{
      machineId,
      engine: row.engine,
      installed,
      signedIn: installed && typeof row.signedIn === 'boolean' ? row.signedIn : null,
      installable: typeof row.installable === 'boolean' ? row.installable : null,
      firstPrompt: typeof row.firstPrompt === 'boolean' ? row.firstPrompt : null,
    }]
  })
}

const yesNo = (value: boolean | null): string => value === null ? 'unknown' : value ? 'yes' : 'no'

/** `harness machines engines <machine> [--engine E]… [--json]`: each engine's readiness on that machine, on request. */
export async function runMachinesEngines(argv: string[], dataDir: string, port: number,
  probe: MachineProbe = probeMachine(dataDir, port), out: (line: string) => void = console.log): Promise<number> {
  const json = argv.includes('--json'), words: string[] = [], engines: string[] = []
  let invalid = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') continue
    if (a === '--engine') {
      const engine = argv[++i]
      if (!engine || !(ENGINES as readonly string[]).includes(engine)) invalid = true
      else if (!engines.includes(engine)) engines.push(engine)
    } else if (a.startsWith('--')) invalid = true
    else words.push(a)
  }
  if (invalid || words.length !== 1) {
    console.error(`${USAGE}\nEngines: ${ENGINES.join(', ')}.`)
    return 2
  }
  let answer: { machineId: string; reply: Record<string, unknown> }
  try {
    answer = await probe(words[0], engines.length ? { engines } : {})
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
  if (typeof answer.reply.error === 'string') {
    console.error(`That machine could not check its engines (${answer.reply.error}).`)
    return 1
  }
  const rows = readinessRows(answer.machineId, answer.reply)
  if (json) {
    for (const row of rows) out(JSON.stringify(row))
    return 0
  }
  const width = Math.max(6, ...rows.map(row => row.engine.length))
  out('')
  out(`  ${'ENGINE'.padEnd(width)}  INSTALLED  SIGNED IN  FIRST PROMPT`)
  for (const row of rows) {
    out(`  ${row.engine.padEnd(width)}  ${yesNo(row.installed).padEnd(9)}  ${yesNo(row.signedIn).padEnd(9)}  ${yesNo(row.firstPrompt)}`)
  }
  out('')
  return 0
}
