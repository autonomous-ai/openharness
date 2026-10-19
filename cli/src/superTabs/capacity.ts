import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { readMachineResources } from '../lib/machineResources.js'
import { commandAvailableInInteractiveShell } from '../lib/engineLaunch.js'
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

export async function readCapabilities(input: Json, deps = {
  resources: readMachineResources,
  disk: readCapacityDisk,
  tool: commandAvailableInInteractiveShell,
  device: async (path: string) => { await access(path, constants.R_OK | constants.W_OK); return true },
}) {
  const cwd = input.cwd, tools = input.tools ?? [], devices = input.devices ?? []
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)
    || (input.worktree !== undefined && typeof input.worktree !== 'boolean')
    || !Array.isArray(tools) || tools.length > 20 || !tools.every(t => typeof t === 'string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(t))
    || !Array.isArray(devices) || devices.length > 20 || !devices.every(d => typeof d === 'string' && isAbsolute(d) && d.length <= 4096 && !/[\x00-\x1f\x7f]/.test(d))) {
    return { error: 'INVALID_REQUEST', detail: 'Name an absolute project path and up to 20 tools and devices.' }
  }
  const probeTools = async () => {
    const answers: Array<readonly [string, boolean]> = []
    for (let index = 0; index < tools.length; index += 4) {
      answers.push(...await Promise.all(tools.slice(index, index + 4).map(async t => [t, await deps.tool(t).catch(() => false)] as const)))
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
  return { ok: true, sampledAt: Date.now(), resources: { ...resources, projectDiskFreeBytes: disk?.freeBytes ?? null,
    projectDiskVolume: disk?.volume ?? null, projectDiskPath: disk?.path ?? null },
    tools: Object.fromEntries(toolValues), devices: Object.fromEntries(deviceValues),
    // A daemon from before the launch flags leaves this out, and a start then switches the model after it.
    launchModel: launchModelEngines() }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Only measured windows leave the account reader. No credentials, emails or
 * invented token counts; an unreported/custom-profile allowance is unknown. */
export function quotaOf(reply: Json, engine: string, customAccount: boolean) {
  const reading = !customAccount && Array.isArray(reply.providers) ? reply.providers.map(object).find(r => r.provider === engine) : null
  const windows: Array<{ usedPercent: number; resetsAt: unknown }> = []
  if (reading?.outcome === 'answered' && reading.httpStatus === 200) {
    const body = object(reading.body)
    const raw = engine === 'claude' ? [body.five_hour, body.seven_day]
      : engine === 'codex' ? [object(body.rate_limit).primary_window, object(body.rate_limit).secondary_window] : []
    for (const value of raw) {
      const w = object(value), used = w.utilization ?? w.used_percentage ?? w.used_percent
      if (finite(used) && used >= 0 && used <= 100) windows.push({ usedPercent: used, resetsAt: w.resets_at ?? w.reset_at ?? null })
    }
  }
  return { known: windows.length > 0, account: typeof reading?.account === 'string' ? reading.account : null, windows }
}
export function admission(capacity: Json, engine: Json, quota: ReturnType<typeof quotaOf>, requirements: Requirements, customAccount = false) {
  const reasons: string[] = [], unknown: string[] = []
  const resources = object(capacity.resources), tools = object(capacity.tools), devices = object(capacity.devices)
  if (engine.installed !== true) reasons.push('The selected agent engine is not installed on this machine.')
  if (engine.signedIn === false && !customAccount) reasons.push('The selected agent engine is not signed in on this machine.')
  const memory = finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes)
    ? resources.memoryTotalBytes - resources.memoryUsedBytes : null
  for (const [label, value, needed] of [
    ['Available memory', memory, requirements.memoryBytes],
    ['Project disk space', resources.projectDiskFreeBytes, requirements.diskBytes],
  ] as const) {
    if (!finite(value)) { unknown.push(`${label} is unknown.`); if (needed > 0) reasons.push(`${label} could not be verified.`) }
    else if (value < needed) reasons.push(`${label} is ${value} bytes; this work requires ${needed}.`)
  }
  if (!finite(resources.cpuPercent)) {
    unknown.push('CPU use is unknown.')
    if (requirements.maxCpuPercent < 100) reasons.push('CPU headroom could not be verified.')
  } else if (resources.cpuPercent > requirements.maxCpuPercent) reasons.push(`CPU use is ${resources.cpuPercent}%; the requested maximum is ${requirements.maxCpuPercent}%.`)
  if (resources.memoryPressure === 'critical') reasons.push('The machine reports critical memory pressure.')
  for (const t of requirements.tools) if (tools[t] !== true) reasons.push(`Required tool unavailable: ${t}.`)
  for (const d of requirements.devices) if (devices[d] !== true) reasons.push(`Required device unavailable: ${d}.`)
  if (!quota.known) {
    unknown.push('Subscription allowance is unknown for this account.')
    if (requirements.quotaRequired) reasons.push('The requested subscription allowance could not be verified.')
  } else if (quota.windows.some(w => w.usedPercent >= 100)) reasons.push('The subscription has an exhausted usage window. Wait for a fresh allowance reading or choose another account.')
  return { allowed: reasons.length === 0, reasons, unknown }
}
