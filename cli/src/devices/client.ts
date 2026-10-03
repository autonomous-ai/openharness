/** Devices DSH tools use the same owned-machine bridge as Desktop. No serial or credential access. */
import { randomUUID } from 'node:crypto'
import type { PairSocket } from '../pair/client.js'
import { deviceSettingsPatchSchema } from '../lib/harnessDevices.js'

export interface DevicesClientDeps {
  port: number
  machineId(): Promise<string | null>
  connect(url: string): PairSocket
  fetch?: typeof fetch
  request?: (machineId: string, type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>
  delay?: (ms: number) => Promise<void>
}

export function deviceRequest(deps: DevicesClientDeps, machineId: string, type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = deps.connect(`ws://127.0.0.1:${deps.port}/api/local-ws`)
    const requestId = randomUUID()
    let settled = false, sent = false
    const finish = (error: Error | null, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('This computer did not answer in time.')), 12_000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    socket.on('error', error => finish(error))
    socket.on('close', code => finish(new Error(code === 4404 ? 'Link this computer in Machines first.' : 'The computer disconnected.')))
    socket.on('message', data => {
      let frame: { type?: string; payload?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame.type === 'connected' && !sent) {
        sent = true
        socket.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
      }
      if (frame.type === `${type}_result` && frame.payload?.requestId === requestId) {
        const { requestId: _id, ...reply } = frame.payload
        finish(null, reply)
      }
    })
  })
}

export const DEVICES_USAGE = `harness hardware — your Harness hardware across computers
  list [--json]                                      read owned computers and devices
  set --machine ID --device ID --patch JSON [--json]  change only the supplied settings
Offline computers never receive queued changes. A write is complete only when confirmed.`

interface Host { machineId: string; name: string; online: boolean }
async function ownedHosts(deps: DevicesClientDeps): Promise<Host[]> {
  const localId = await deps.machineId()
  if (!localId) throw new Error('Start Harness on this computer first.')
  const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}/api/machines`, {
    headers: { 'x-adapter-local': '1' }, signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('Could not read the account’s computers. Sign in and try again.')
  const body = await response.json() as { data?: { machines?: Record<string, unknown>[] }; machines?: Record<string, unknown>[] }
  const rows = body.data?.machines ?? body.machines
  if (!Array.isArray(rows)) throw new Error('Harness returned an invalid computer list.')
  const hosts = rows.filter(row => typeof row.machineId === 'string' && !row.isShared).map(row => ({
    machineId: row.machineId as string,
    name: String(row.name || row.hostname || row.machineId),
    online: row.machineId === localId || row.status === 'running',
  }))
  if (!hosts.some(host => host.machineId === localId)) hosts.unshift({ machineId: localId, name: 'This computer', online: true })
  return hosts
}

function observed(reply: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const status = reply.status as { devices?: Record<string, unknown>[]; id?: string } | undefined
  return (status?.devices ?? (status ? [status] : [])).find(device => device.id === id)
}

/** Separate from printing so the exact routing and confirmation path is testable. */
export async function devicesCommand(argv: string[], deps: DevicesClientDeps): Promise<Record<string, unknown>> {
  const words = argv.filter(word => word !== '--json')
  const command = words.shift() ?? 'list'
  if (command === 'help' || command === '--help') return { help: DEVICES_USAGE }
  if (command !== 'list' && command !== 'set') throw new Error(DEVICES_USAGE)
  const options: Record<string, string> = {}
  if (command === 'list' && words.length) throw new Error(DEVICES_USAGE)
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i]!
    if (!['--machine', '--device', '--patch'].includes(key) || !words[i + 1] || key in options) throw new Error(DEVICES_USAGE)
    options[key] = words[i + 1]!
  }
  let patch: Record<string, unknown> | undefined
  if (command === 'set') {
    if (!options['--machine'] || !options['--device'] || !options['--patch']) throw new Error(DEVICES_USAGE)
    patch = deviceSettingsPatchSchema.parse(JSON.parse(options['--patch']))
  }
  const hosts = await ownedHosts(deps)
  const request = deps.request ?? ((id, type, payload) => deviceRequest(deps, id, type, payload))
  if (command === 'list') {
    return { hosts: await Promise.all(hosts.map(async host => {
      if (!host.online) return { ...host, available: false }
      try {
        const reply = await request(host.machineId, 'harness_devices_list')
        return { ...host, available: !reply.error, ...reply }
      } catch (error) { return { ...host, available: false, error: error instanceof Error ? error.message : 'Unavailable' } }
    })) }
  }
  const host = hosts.find(host => host.machineId === options['--machine'])
  if (!host) throw new Error('That computer is not owned by this account.')
  if (!host.online) throw new Error('That computer is offline. No change was sent.')
  const id = options['--device']!
  let reply = await request(host.machineId, 'harness_device_settings', { id, patch })
  if (reply.error || reply.ok !== true) return { ...reply, confirmed: false }
  const delay = deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < 13; attempt++) {
    const device = observed(reply, id)
    const values = device?.settings as Record<string, unknown> | undefined
    if (device?.attached === true && !device.updating && values && Object.entries(patch!).every(([key, value]) => values[key] === value)) {
      return { ok: true, confirmed: true, machineId: host.machineId, id, settings: values }
    }
    if (reply.error || device?.attached === false || device?.updating || attempt === 12) break
    await delay(500)
    reply = await request(host.machineId, 'harness_devices_list')
  }
  return { ok: false, accepted: true, confirmed: false, machineId: host.machineId, id,
    error: 'The device has not confirmed the change. Refresh Devices before trying again.' }
}

export async function runDevicesCommand(argv: string[], deps: DevicesClientDeps): Promise<number> {
  try {
    const result = await devicesCommand(argv, deps)
    console.log(result.help ?? JSON.stringify(result, null, argv.includes('--json') ? undefined : 2))
    return result.error ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Device request failed.', confirmed: false }))
    return 1
  }
}
