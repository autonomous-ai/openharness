/**
 * The dial's usage counts, end to end (docs/plans/2026-11-23-dial-usage-counts-design.md): on the real daemon, signed in
 * to the in-memory backend with sharing on, a fake dial plugged, turned and tapped. The devices count the day into their
 * own dial-usage.json, the gateway reads it at its tick, and the signed-in report carries the dial's names, counts only:
 * no agent, folder, dial or machine in a report or in the file. A daemon restart sends no flag twice.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { DIAL_USAGE_FILE } from '../src/lib/dialUsageContract.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend } from './harness/fakeBackend.js'
import type { FakeDial } from './harness/fakeDial.js'

const SERIAL = 'E2E-A'
const MAC = 'e2:e0:00:00:00:0a'
// The first report waits up to a minute and the next one five (gateway/productUsage.ts), so the dial's own report, which
// travels after the product's, is in by then.
const REPORTED_MS = 420_000
const machine = { machineId: 'd1'.repeat(16), computerId: 'e2e-dial-usage', name: 'PRIVATE_MACHINE_CANARY', token: 'e2e-dial-usage-token' }
const today = (): string => new Date().toISOString().slice(0, 10)

describe('the dial\'s usage counts', () => {
  let backend: FakeBackend, d: IsolatedDaemon, desk: Desk, window: LocalClient | undefined
  let agentId = '', cwd = ''
  beforeAll(async () => {
    backend = await FakeBackend.start()
    backend.productUsage = { enabled: true, revision: 0, reports: [] }
    backend.addMachine(machine)
    d = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl,
      ADAPTER_COMPUTER_ID: machine.computerId, CABLE_DISABLE: 'false' } })
    const dials = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = dials
    desk = new Desk(dials)
    writeFileSync(dials, '[]')
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
      autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
      expiresAt: Date.now() + 86_400_000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
    await d.start()
  }, 120_000)
  afterAll(async () => { window?.close(); await desk?.close(); await d?.close(); await backend?.close() })
  const showLog = (): void => onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })

  /** The day's sum of [metric] over every report the backend took. */
  const sum = (metric: string, day: string): number => backend.productUsage!.reports
    .filter((report) => report.day === day)
    .reduce((n, report) => n + ((report.counters as Record<string, number>)[metric] ?? 0), 0)
  const usageFile = (): string => join(d.dataDir, DIAL_USAGE_FILE)
  /** A window with the agent on a tab, so a tap on the dial is handed to it. */
  const openWindow = async (): Promise<LocalClient> => {
    const client = await LocalClient.connect(d, { machineId: machine.machineId })
    client.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [agentId], panes: 1 }], tiles: [] })
    client.send('app_panes', { agentIds: [agentId], foreground: true })
    return client
  }
  /** Plugged, then a hand on it: a turn to the agent and a tap that opens it. */
  const plugTurnTap = async (client: LocalClient): Promise<FakeDial> => {
    const dial = await desk.plug(SERIAL, MAC)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the agent list')
    dial.send({ t: 'focus', agentId })
    await client.waitFor((f) => f.type === 'dial_focus' && f.payload?.agentId === agentId, 15_000, 'dial_focus')
    const opens = client.frames.filter((f) => f.type === 'dial_open').length
    dial.send({ t: 'agent.open', agentId })
    await until('the tap handed to the window', () => client.frames.filter((f) => f.type === 'dial_open').length > opens || null, 15_000)
    return dial
  }

  it('a dial plugged, turned and tapped reaches the signed-in report as counts only', async () => {
    showLog()
    await until('sharing read', () => backend.seen.includes('GET /api/product-usage/settings') || null, 45_000)
    window = await LocalClient.connect(d, { machineId: machine.machineId })
    cwd = join(d.projectsDir, 'PRIVATE_PROJECT_CANARY')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    agentId = created.agent.id
    await until('the agent to bind its conversation', async () => {
      const rows = (await window!.request('agents_list', { includeStopped: true })).agents as Array<Record<string, unknown>>
      return rows.some((a) => a.id === agentId && a.sessionId && a.status === 'active') || null
    }, 60_000, 500)
    window.close()
    window = await openWindow()
    const day = today()
    await plugTurnTap(window)

    const expected = { dial_connected_installation_days: 1, dial_used_installation_days: 1,
      dial_engine_claude_installation_days: 1, dial_host_harness_installation_days: 1, dial_open_ok: 1 }
    await until('the devices to write the day', () => {
      if (!existsSync(usageFile())) return null
      const counts = (JSON.parse(readFileSync(usageFile(), 'utf8')) as { days: Record<string, Record<string, number>> }).days[day] ?? {}
      return Object.entries(expected).every(([metric, value]) => counts[metric] === value) || null
    }, 30_000, 500)
    await until('a report to carry the dial\'s day', () =>
      Object.entries(expected).every(([metric, value]) => sum(metric, day) === value) || null, REPORTED_MS, 1_000)
    expect(sum('dial_first_use_installations', day)).toBe(1)

    const wire = JSON.stringify(backend.productUsage!.reports)
    const file = readFileSync(usageFile(), 'utf8')
    for (const secret of ['PRIVATE_', cwd, agentId, SERIAL, MAC, machine.name, machine.machineId, machine.computerId, machine.token]) {
      expect(wire).not.toContain(secret)
      expect(file).not.toContain(secret)
    }
  }, 600_000)

  it('a daemon restart sends no flag twice', async () => {
    showLog()
    expect(agentId, 'the first case made the agent').not.toBe('')
    const day = today()
    window?.close()
    window = undefined
    await desk.unplug(SERIAL)
    await d.restart()
    const client = await openWindow()
    window = client
    await until('the agent back after the restart', async () => {
      const rows = (await client.request('agents_list', { includeStopped: true })).agents as Array<Record<string, unknown>>
      return rows.some((a) => a.id === agentId && a.status === 'active') || null
    }, 60_000, 500)
    await plugTurnTap(client)
    // The second tap is the restart's own news: once it is reported, the restarted gateway has sent the day again.
    await until('the restart\'s tap reported', () => sum('dial_open_ok', day) === 2 || null, REPORTED_MS, 1_000)
    for (const flag of ['dial_connected_installation_days', 'dial_used_installation_days', 'dial_first_use_installations',
      'dial_engine_claude_installation_days', 'dial_host_harness_installation_days']) expect(sum(flag, day), flag).toBe(1)
  }, 600_000)
})
