/**
 * The devices' process on demand (core/devicesWake.ts, harnessd/services.ts `devices`), on the real daemon with
 * fake dials on pseudo-terminals: a computer with no device runs no devices' process, about 72 MiB it never
 * pays, and the first device or the first request for one starts it.
 * - A dial plugged in: its port is seen where the dial's own scan would look (here the suite's list, as
 *   cable/cableFleet.ts reads it), the process is started, and the dial is welcomed; it stays for the next.
 * - The Devices tab and ⌘K: their first request starts it, waits for it and is answered by it.
 * - Named in `HARNESSD_SERVICES` (tests, support), it starts with the daemon, as before.
 * - A Wi-Fi device's session starts it too, and nothing it sends meanwhile is lost: e2e/wifiDevice.e2e.ts.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { devicesPids, SETTINGS } from './harness/desk.js'
import { FakeDial } from './harness/fakeDial.js'

const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service devices started/g)].length
const connections = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => line.includes('[services] devices connected')).length
/** ⌘K's pick for a typed task: `route_task` answers as `route_result`, under the asker's request id. */
async function routeTask(client: LocalClient, text: string): Promise<Record<string, any>> {
  const requestId = `route-${Math.random().toString(36).slice(2)}`
  const answered = client.next((frame) => frame.type === 'route_result' && frame.payload?.requestId === requestId, 40_000, 'route_result')
  client.send('route_task', { requestId, text })
  return (await answered).payload as Record<string, any>
}

describe('the devices\' process, once there is a device', () => {
  let daemon: IsolatedDaemon | undefined
  const dials: FakeDial[] = []
  afterEach(async () => {
    for (const dial of dials.splice(0)) await dial.close()
    await daemon?.close()
    daemon = undefined
  })
  const fresh = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
    daemon = d
    const file = join(d.root, 'dials.json')
    writeFileSync(file, '[]')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    // The other services are up, and the core has looked for a dial a few times.
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    return { d, file }
  }
  /** A dial on the desk's list, and how long from that write to its welcome. */
  const plug = async (file: string, serial: string, mac: string): Promise<{ dial: FakeDial; welcomedMs: number }> => {
    const dial = await FakeDial.open({ mac, settings: SETTINGS })
    dials.push(dial)
    const at = Date.now()
    writeFileSync(file, JSON.stringify([{ serial, path: dial.path }]))
    dial.keepGreeting()
    const welcome = await dial.next((m) => m.t === 'welcome', 60_000, 'a welcome')
    return { dial, welcomedMs: dial.arrivedAt[dial.messages.indexOf(welcome)] - at }
  }

  it('runs no devices\' process with no device; a dial plugged in starts it and is welcomed, and it stays for the next', async () => {
    const { d, file } = await fresh()
    expect(starts(d), 'a devices\' process with no device').toBe(0)
    expect(devicesPids(d)).toEqual([])
    const window = await LocalClient.connect(d)
    // What a window says on every change goes on with no one to hear it: kept, and told once they start.
    window.send('app_panes', { agentIds: [], foreground: true })
    const first = await plug(file, 'E2E-A', 'e2:e0:00:00:00:0a')
    expect(d.log()).toContain('[devices] a dial\'s port is there: asking for the devices\' process')
    expect(starts(d)).toBe(1)
    await first.dial.next((m) => m.t === 'agents.end', 30_000, 'the agent list')
    // Unplugged and plugged in again: the same process, which a dial no longer there does not stop.
    writeFileSync(file, '[]')
    await first.dial.close()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const again = await plug(file, 'E2E-A', 'e2:e0:00:00:00:0a')
    expect(starts(d)).toBe(1)
    expect(connections(d)).toBe(1)
    // `E2E_MEASURE=<file>`: what the pull request reports, kept. The dial greets every two seconds until
    // welcomed, and the core and the devices each look every two seconds.
    if (process.env.E2E_MEASURE) appendFileSync(process.env.E2E_MEASURE, `plug-in to welcome: first ${first.welcomedMs} ms (the process started), again ${again.welcomedMs} ms\n`)
    expect(first.welcomedMs).toBeLessThan(15_000)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('the Devices tab\'s first request starts it, waits for it and is answered by it', async () => {
    const { d } = await fresh()
    const window = await LocalClient.connect(d)
    expect(starts(d)).toBe(0)
    expect(await window.request('harness_devices_list', {}, 30_000)).toMatchObject({ protocol: 1, status: { attached: false } })
    expect(starts(d)).toBe(1)
    expect(d.log()).toContain('[services] devices connected')
    window.close()
  })

  it('⌘K\'s first task starts it and is answered by the fleet\'s router, not refused', async () => {
    const { d } = await fresh()
    const window = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'on-demand')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    expect(starts(d)).toBe(0)
    const routed = await routeTask(window, 'fix the parser')
    expect(routed.reason).not.toBe('the devices service is unavailable')
    expect(starts(d)).toBe(1)
    window.close()
  })

  it('named in HARNESSD_SERVICES, it starts with the daemon, with no device', async () => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICES: 'devices' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    await until('the devices to connect', () => connections(d) >= 1 || null, 30_000, 200)
    expect(d.log()).not.toContain('asking for the devices\' process')
  })
})
