import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'

let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); await backend?.close() })

it('reports only local counters from a real turn, and the account switch stops them while work continues', async () => {
  backend = await FakeBackend.start()
  backend.productUsage = { enabled: true, revision: 0, reports: [] }
  const machine = { machineId: 'c3'.repeat(16), computerId: 'e2e-product-usage', name: 'fixture', token: 'e2e-product-token' }
  backend.addMachine(machine)
  const d = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: machine.computerId } })
  daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
    autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
    expiresAt: Date.now() + 86400000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-70).join('\n')))
  await d.start()
  await until('sharing preference read', () => backend!.seen.includes('GET /api/product-usage/settings') || null, 45000)
  const settings = `http://127.0.0.1:${d.port}/api/product-usage/settings`
  expect((await (await fetch(settings, { headers: d.localHeaders() })).json())).toMatchObject({ data: { enabled: true } })
  client = await LocalClient.connect(d, { machineId: machine.machineId })
  const cwd = join(d.projectsDir, 'PRIVATE_PROJECT_CANARY'); mkdirSync(cwd, { recursive: true })
  const creationId = 'private-creation-canary'
  const launched = await client.request('agent_create', { creationId, engine: 'claude', cwd, bypassPermission: true }, 90000)
  expect(launched.error).toBeUndefined()
  const created = launched.state === 'created' ? launched : await until('durable launch completes', async () => {
    const reply = await client!.request('agent_create_status', { creationId })
    return reply.state === 'created' ? reply : null
  }, 90000)
  // Retrying the durable request or polling it must not create another launch measurement.
  await client.request('agent_create_status', { creationId })
  const refused = await client.request('agent_create', { creationId: 'synthetic-invalid-creation', engine: 'not-an-engine', cwd })
  expect(refused.error ?? refused.failure).toBeTruthy()
  const agentId = created.agent.id
  const turn = async () => {
    const ended = client!.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 45000)
    client!.send('message', { agentId, content: 'PRIVATE_PROMPT_CANARY: say hello', usageIntent: 'interactive' })
    await ended
  }
  await until('agent ready', async () => {
    const rows = await client!.request('agents_list', { includeStopped: true })
    return rows.agents.some((a: Record<string, unknown>) => a.id === agentId && a.sessionId) || null
  }, 45000)
  await client.request('session_search', { query: 'PRIVATE_SEARCH_CANARY' })
  const missing = await client.request('agent_resume', { agentId: 'PRIVATE_MISSING_AGENT_CANARY' })
  expect(missing.error).toBe('AGENT_NOT_FOUND')
  // The same Desktop-format fixture must pass both the local proxy and the backend route tests.
  const appReport = { ...JSON.parse(readFileSync(new URL('../../tests/fixtures/desktop-product-usage-report.json', import.meta.url), 'utf8')), day: new Date().toISOString().slice(0, 10) }
  const forwarded = await fetch(`http://127.0.0.1:${d.port}/api/product-usage/report`, { method: 'POST', headers: d.localHeaders({ 'content-type': 'application/json', 'x-adapter-local': '1' }), body: JSON.stringify(appReport) })
  expect(forwarded.status).toBe(200)
  expect(backend.productUsage.reports).toContainEqual(appReport)
  await turn()
  await until('a reduced completed turn report', () => backend!.productUsage!.reports.some(r => ((r.counters as Record<string, number>).turns_ended ?? 0) > 0) || null, 75000)
  const sum = (metric: string) => backend!.productUsage!.reports.reduce((n, r) => n + ((r.counters as Record<string, number>)[metric] ?? 0), 0)
  expect(sum('search_requests')).toBe(1)
  expect(sum('search_first_installations')).toBe(1)
  expect(sum('measurement_v2_installation_days')).toBe(1)
  expect(sum('launch_started')).toBe(2)
  expect(sum('launch_created')).toBe(1)
  expect(sum('launch_failed')).toBe(1)
  expect(sum('turns_with_response')).toBeGreaterThan(0)
  expect(sum('health_cli_interactive_work_days')).toBe(1)
  expect(sum('health_cli_first_interactive_work')).toBe(1)
  expect(sum('request_app_message_started')).toBeGreaterThan(0)
  expect(sum('request_app_resume_failed')).toBe(1)
  expect(sum('request_app_resume_reason_saved_state_missing')).toBe(1)
  const wire = JSON.stringify(backend.productUsage.reports)
  for (const privateValue of ['PRIVATE_', creationId, machine.machineId, machine.computerId, machine.token, agentId, cwd, 'userMessage', 'payload']) expect(wire).not.toContain(privateValue)
  expect((await fetch(settings, { method: 'POST', headers: d.localHeaders({ 'content-type': 'application/json', 'x-adapter-local': '1' }), body: '{"enabled":false}' })).status).toBe(200)
  const reportsBefore = backend.productUsage.reports.length
  const checksBefore = backend.seen.filter(x => x === 'GET /api/product-usage/settings').length
  await turn()
  await until('collector observes the off choice', () => backend!.seen.filter(x => x === 'GET /api/product-usage/settings').length > checksBefore || null, 75000)
  expect(backend.productUsage.reports).toHaveLength(reportsBefore)
  expect(d.coresStarted()).toBe(1)
}, 240000)
