import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { readMachineResources } from '../lib/machineResources.js'
import { commandAvailableInInteractiveShell, type CommandAvailability } from '../lib/engineLaunch.js'
import { launchModelEngines } from '../lib/launchModel.js'
import { object } from './wire.js'
import { readCapacityDisk } from './disk.js'

type Json = Record<string, unknown>
export interface Requirements {
  memoryBytes: number; diskBytes: number; maxCpuPercent: number
  tools: string[]; devices: string[]; quotaRequired: boolean
}
/** What `start` asks of a machine when the Lead has no reason to ask for more: the help's template. */
export const START_REQUIREMENTS: Requirements = { memoryBytes: 2147483648, diskBytes: 10737418240, maxCpuPercent: 85, tools: ['git'], devices: [], quotaRequired: false }
/** The same plus what the task needs. The route admits a pick on exactly this, so the start it suggests is admitted too. */
export const startRequirements = (needs: { tools: string[]; devices: string[] }): Requirements =>
  // CPU use is only a momentary reading: a busy machine would refuse every candidate (seen in the route e2e at 98.7%), so the route does not cap it.
  ({ ...START_REQUIREMENTS, maxCpuPercent: 100, tools: [...new Set([...START_REQUIREMENTS.tools, ...needs.tools])], devices: needs.devices })

/** A missing result is a completed check; an absent value or failed check is only unverified. */
export function requiredToolReason(tool: string, reported: unknown, failure?: unknown): string | null {
  if (reported === true) return null
  if (reported === false) return `Required tool missing: ${tool}.`
  const detail = typeof failure === 'string' && failure ? `${failure} ` : ''
  return `Required tool not verified: ${tool}. ${detail}Ask the machine owner to check it and refresh the machine reading.`
}

export async function readCapabilities(input: Json, deps = {
  resources: readMachineResources,
  disk: readCapacityDisk,
  tool: (name: string): Promise<CommandAvailability> => commandAvailableInInteractiveShell(name, undefined, undefined, true),
  device: async (path: string) => { await access(path, constants.R_OK | constants.W_OK); return true },
}): Promise<Json> {
  const cwd = input.cwd, tools = input.tools ?? [], devices = input.devices ?? []
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)
    || (input.worktree !== undefined && typeof input.worktree !== 'boolean')
    || !Array.isArray(tools) || tools.length > 20 || !tools.every(t => typeof t === 'string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(t))
    || !Array.isArray(devices) || devices.length > 20 || !devices.every(d => typeof d === 'string' && isAbsolute(d) && d.length <= 4096 && !/[\x00-\x1f\x7f]/.test(d))) {
    return { error: 'INVALID_REQUEST', detail: 'Name an absolute project path and up to 20 tools and devices.' }
  }
  const probeTools = async () => {
    const answers: Array<readonly [string, CommandAvailability]> = []
    for (let index = 0; index < tools.length; index += 4) {
      answers.push(...await Promise.all(tools.slice(index, index + 4).map(async t => {
        const result = await deps.tool(t).catch(error => ({ status: 'unverified' as const,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) }))
        return [t, result] as const
      })))
    }
    return answers
  }
  // Requested only before admission. No new polling, command execution or shell
  // interpolation; the tool probe is the same bounded one native launches use.
  const [resources, disk, toolValues, deviceValues] = await Promise.all([
    deps.resources().catch(() => null), deps.disk(cwd, input.worktree === true).catch(() => null),
    probeTools(),
    Promise.all(devices.map(async d => [d, await deps.device(d).catch(() => false)] as const)),
  ])
  const toolProbeErrors = Object.fromEntries(toolValues.filter(([, result]) => result.status === 'unverified')
    .map(([name, result]) => [name, result.detail ?? 'The tool probe did not complete.']))
  return { ok: true, sampledAt: Date.now(), resources: { ...resources, projectDiskFreeBytes: disk?.freeBytes ?? null, projectDiskTotalBytes: disk?.totalBytes ?? null,
    projectDiskVolume: disk?.volume ?? null, projectDiskPath: disk?.path ?? null },
    tools: Object.fromEntries(toolValues.filter(([, result]) => result.status !== 'unverified').map(([name, result]) => [name, result.status === 'available'])),
    ...(Object.keys(toolProbeErrors).length ? { toolProbeErrors } : {}), devices: Object.fromEntries(deviceValues),
    // A daemon from before the launch flags leaves this out, and a start then switches the model after it.
    launchModel: launchModelEngines() }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const GiB = 1024 ** 3
/** One decimal, rounded down, so a refusal never reads "2 GiB free, 2 GiB needed". */
export const gibibytes = (bytes: number) => `${Math.floor(Math.max(0, bytes) / GiB * 10) / 10} GiB`
/** The refusal for memory, the one start-failure reason every Swarm member may read (backend startFailure.ts): it says
 *  only numbers they already see in the Machines view. */
export const memoryShort = (freeBytes: number, neededBytes: number) =>
  `Not enough free memory: ${gibibytes(freeBytes)} free, ${gibibytes(neededBytes)} needed.`
/** The free and needed amounts of a `memoryShort` reason at the start of a host's raw reason, or null for any other. */
export function memoryShortIn(reason: unknown): { free: string; needed: string } | null {
  const match = typeof reason === 'string' ? /^Not enough free memory: (\d+(?:\.\d)? GiB) free, (\d+(?:\.\d)? GiB) needed\./.exec(reason) : null
  return match ? { free: match[1]!, needed: match[2]! } : null
}
/** Only measured windows leave the account reader. No credentials, emails or
 * invented token counts; an unreported/custom-profile allowance is unknown. */
export function quotaOf(reply: Json, engine: string, customAccount: boolean) {
  const reading = !customAccount && Array.isArray(reply.providers) ? reply.providers.map(object).find(r => r.provider === engine) : null
  const windows: Array<{ usedPercent: number; resetsAt: unknown; name: string }> = []
  if (reading?.outcome === 'answered' && reading.httpStatus === 200) {
    const body = object(reading.body)
    const raw = engine === 'claude' ? [body.five_hour, body.seven_day]
      : engine === 'codex' ? [object(body.rate_limit).primary_window, object(body.rate_limit).secondary_window] : []
    // Both engines report the short window first and the weekly one second, so the name is by that position, kept even
    // when one is missing — unless the window says how long it is, as Codex's do (`limit_window_seconds`, the length the
    // Desktop names them by). 2026-10-24: a Codex account reported only its weekly window, first; read as its 5-hour one,
    // the weekly read as missing, and the route never offered Codex while a Claude candidate fit.
    raw.forEach((value, index) => {
      const w = object(value), used = w.utilization ?? w.used_percentage ?? w.used_percent, length = w.limit_window_seconds
      const name = finite(length) && length > 0 ? (length >= 86_400 ? 'weekly' : '5-hour') : index === 0 ? '5-hour' : 'weekly'
      if (finite(used) && used >= 0 && used <= 100 && !windows.some(x => x.name === name)) windows.push({ usedPercent: used, resetsAt: w.resets_at ?? w.reset_at ?? null, name })
    })
  }
  return { known: windows.length > 0, account: typeof reading?.account === 'string' ? reading.account : null, windows }
}
/** Said of an engine in a Harness Team account that spends its owner's subscription through the owner's relay: the
 *  route reads that subscription's allowance from the owner's Mac (routeCommand.ts), matching this exact sentence. */
export const RELAYED_QUOTA = "This account runs on its owner's subscription; its allowance is read on the owner's machine."
const VENDOR: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI' }
/** Why [engine]'s allowance could not be read from the account reader's [reply], or null when it was. Words only: no
 *  account, token or plan. [relayed]: a Harness Team account, whose engines spend the owner's subscription through the
 *  owner's relay, so its own home holds no sign-in to read. */
export function quotaUnknownReason(reply: Json, engine: string, relayed: boolean): string | null {
  if (quotaOf(reply, engine, false).known) return null
  const reading = Array.isArray(reply.providers) ? reply.providers.map(object).find(r => r.provider === engine) : undefined
  const vendor = VENDOR[engine] ?? 'The vendor'
  if (!reading) return 'The allowance reader on this machine did not answer.'
  if (reading.outcome === 'signedOut') {
    if (relayed) return RELAYED_QUOTA
    return typeof reading.message === 'string' && /expired/i.test(reading.message)
      ? 'The stored sign-in has expired; it renews the next time the engine runs here.'
      : 'No subscription sign-in is stored on this machine.'
  }
  if (reading.outcome !== 'answered') return `${vendor} could not be reached.`
  const status = reading.httpStatus
  if (status === 429) return `${vendor} is limiting how often the allowance can be read.`
  if (status === 401 || status === 403) return `${vendor} refused the stored sign-in.`
  if (status === 200) return `${vendor} answered without usage windows.`
  return `${vendor} answered with an error (HTTP ${finite(status) ? status : 'unknown'}).`
}
/** An engine that runs on an API key or a gateway's base URL has no subscription windows to read: it is metered, not unknown.
 * `env` is the machine's own, so the host reads its own and a key never leaves it. */
export function meteredEngine(engine: string, env: NodeJS.ProcessEnv): boolean {
  const names = engine === 'claude' ? ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
    : engine === 'codex' ? ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY'] : []
  return names.some(name => !!env[name]?.trim())
}
export function admission(capacity: Json, engine: Json, quota: ReturnType<typeof quotaOf>, requirements: Requirements, customAccount = false) {
  const reasons: string[] = [], unknown: string[] = []
  const resources = object(capacity.resources), tools = object(capacity.tools), devices = object(capacity.devices), toolProbeErrors = object(capacity.toolProbeErrors)
  if (engine.installed !== true) reasons.push('The selected agent engine is not installed on this machine.')
  const memory = finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes)
    ? resources.memoryTotalBytes - resources.memoryUsedBytes : null
  for (const [label, value, needed] of [
    ['Available memory', memory, requirements.memoryBytes],
    ['Project disk space', resources.projectDiskFreeBytes, requirements.diskBytes],
  ] as const) {
    if (!finite(value)) { unknown.push(`${label} is unknown.`); if (needed > 0) reasons.push(`${label} could not be verified.`) }
    else if (value < needed) reasons.push(label === 'Available memory' ? memoryShort(value, needed) : `${label} is ${value} bytes; this work requires ${needed}.`)
  }
  if (!finite(resources.cpuPercent)) {
    unknown.push('CPU use is unknown.')
    if (requirements.maxCpuPercent < 100) reasons.push('CPU headroom could not be verified.')
  } else if (resources.cpuPercent > requirements.maxCpuPercent) reasons.push(`CPU use is ${resources.cpuPercent}%; the requested maximum is ${requirements.maxCpuPercent}%.`)
  if (resources.memoryPressure === 'critical') reasons.push('The machine reports critical memory pressure.')
  for (const t of requirements.tools) {
    const reason = requiredToolReason(t, tools[t], toolProbeErrors[t])
    if (reason) reasons.push(reason)
  }
  for (const d of requirements.devices) if (devices[d] !== true) reasons.push(`Required device unavailable: ${d}.`)
  if (!quota.known) {
    unknown.push('Subscription allowance is unknown for this account.')
    if (requirements.quotaRequired) reasons.push('The requested subscription allowance could not be verified.')
  } else if (quota.windows.some(w => w.usedPercent >= 100)) reasons.push('The subscription has an exhausted usage window. Wait for a fresh allowance reading or choose another account.')
  return { allowed: reasons.length === 0, reasons, unknown }
}
