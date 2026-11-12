/** A start the Swarm queued for a machine, whose engine refuses an option Harness starts it with and quits at launch (the
 * rehearsal's Codex builders Nova and Vesper, 2026-11-11, whose Swarm read only "has since stopped"). Its host fails the start
 * saying how the engine left, in fixed words read on the pane its machine kept (superTabs/engineExit.ts), with real native
 * receipts, a private tmux and the fake Codex. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { overOldRoutes } from './harness/swarmReads.js'

let relay: FakeBackend | undefined
const daemons: IsolatedDaemon[] = [], clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(c => c.close())
  await Promise.allSettled(daemons.splice(0).map(d => d.close()))
  await relay?.close(); relay = undefined
})

/** A Codex release that does not have the options a Swarm start gives it, refusing them as clap does (e2e/harness/fakeEngine.mjs). */
function codexWithout(d: IsolatedDaemon, without: string[]): void {
  const wrapper = join(d.root, 'bin', 'codex'), module = pathToFileURL(join(CLI_ROOT, 'e2e/harness/fakeEngine.mjs')).href
  writeFileSync(`${wrapper}.new`, `#!${process.execPath}\nimport(${JSON.stringify(module)}).then((m) => m.run('codex', ${JSON.stringify({ ...d.engineConfig, without })}))\n`, { mode: 0o755 })
  renameSync(`${wrapper}.new`, wrapper)
}

it('fails a start whose engine refused an option at launch, saying so', async () => {
  const backend = await FakeBackend.start(); relay = backend
  const specs = [
    { machineId: 'e1'.repeat(16), computerId: 'exit-lead-fixture', name: 'Lead fixture', token: 'fixture-lead-token', account: 'lead', email: 'lead@example.com' },
    { machineId: 'e2'.repeat(16), computerId: 'exit-member-fixture', name: 'Member fixture', token: 'fixture-member-token', account: 'member', email: 'member@example.com' },
  ]
  for (const spec of specs) {
    backend.addMachine(spec)
    const d = await signedInDaemon(backend, spec, { ANTHROPIC_API_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-only' })
    daemons.push(d)
    writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  }
  const [a, b] = daemons, [leadMachine, memberMachine] = specs
  // Every Codex start carries these (engines/codex/launch.ts), and a Swarm start the first.
  codexWithout(b, ['check_for_update_on_startup=false', 'tui.fullscreen_transcript=false'])
  const project = join(b.projectsDir, 'contributed'); mkdirSync(project, { recursive: true })
  const agents: Array<Record<string, any>> = [], starts = new Map<string, Record<string, any>>()
  let observations = 0
  const pool = { machineId: memberMachine.machineId, generation: 'grant-1', cwd: project, engines: ['codex'], maxAgents: 2, paused: false }
  const id = (machine: string, harness: string) => createHash('sha256').update(JSON.stringify([machine, harness])).digest('hex').slice(0, 24)
  backend.superTabs = overOldRoutes(async (method, raw, body, caller) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/pools')) {
      return { data: caller.machineId === memberMachine.machineId ? [{ tabId: 'exit-tab', machine: pool,
        starts: [...starts.values()].filter(s => !s.harnessId || !s.poolSettled), harnessIds: agents.filter(a => a.machineId === caller.machineId).map(a => a.harnessId) }] : [] }
    }
    if (path.includes('/hosts/') && path.includes('/starts/')) {
      const start = starts.get(path.split('/').at(-1)!)!
      if (method === 'GET') return { data: start }
      const c = body.command
      if (c.type === 'agent.startDispatch') start.dispatched = true
      else if (c.type === 'agent.startWaiting') start.waiting = c.reason
      else if (c.type === 'agent.startFailed') start.error ??= c.error
      else throw new Error(`Unexpected host operation ${c.type}`)
      return { data: { result: {} } }
    }
    if (path.endsWith('/readings')) {
      observations += body.readings.length
      return { data: { results: body.readings.map((reading: Record<string, any>) => ({ tabId: reading.tabId, ok: true })) } }
    }
    if (path.endsWith('/terminal')) return { data: [] }
    if (path.includes('/hosts/')) return { data: path.endsWith('/assignments') ? [] : agents.filter(a => a.machineId === caller.machineId).map(agent => ({ tabId: 'exit-tab', agent, observers: [] })) }
    if (path.includes('/machines/')) { observations++; return { data: { revision: observations } } }
    if (path === '/api/super-tabs/exit-tab') return { data: { state: { id: 'exit-tab', agents, project: { machineId: memberMachine.machineId, cwd: project, repositoryUrl: null } }, revision: observations } }
    if (path.includes('/starts/')) return { data: starts.get(path.split('/').at(-1)!) }
    if (path.endsWith('/commands') && body.command.type === 'agent.configuration') return { data: { result: {} } }
    if (path.endsWith('/deliveries')) return { data: [] }
    throw new Error(`Unexpected pool request ${path}`)
  })
  onTestFailed(() => daemons.forEach(d => console.log(d.log().split('\n').slice(-75).join('\n'))))
  await Promise.all(daemons.map(d => d.start()))
  await until('both fixture accounts connected', () => backend.nodeUp(leadMachine.machineId) && backend.nodeUp(memberMachine.machineId), 30000)
  const onA = await LocalClient.connect(a, { machineId: leadMachine.machineId }), onB = await LocalClient.connect(b, { machineId: memberMachine.machineId }); clients.push(onA, onB)
  const setup = { action: 'prepareContribution', tabId: 'exit-tab', operationId: 'fixture-setup' }
  await until('the machine prepared for the Swarm', async () => (await onB.request('super_tabs', setup, 30000)).state === 'ready' || null, 45000, 250)
  const lead = await onA.request('agent_create', { engine: 'claude', cwd: a.projectsDir }, 90000)
  expect(lead.error, JSON.stringify(lead)).toBeUndefined()
  agents.push({ id: id(leadMachine.machineId, lead.agent.id), machineId: leadMachine.machineId, harnessId: lead.agent.id })
  await onB.request('super_tabs', { action: 'wake' }, 30000)
  await until('owner reports contributed capacity', () => observations > 0, 45000)
  const request = { conversationId: 'lead', machineId: memberMachine.machineId, engine: 'codex', name: 'Pool builder', cwd: project, worktree: false,
    requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
  const startId = 'start-refused-option'
  starts.set(startId, { id: startId, poolGeneration: pool.generation, creationId: `super-${startId}`, request, dispatched: false, harnessId: null })
  // Its host runs it on a pass of its own (superTabs/machines.ts): Codex refuses the option and quits, and the start fails, once.
  const error = await until('the start fails', () => starts.get(startId)!.error ?? null, 120000, 500)
  expect(error).toBe('Codex exited at launch with status 2: it did not accept an option Harness started it with. Create a new start request to continue.')
  expect(starts.get(startId)!.harnessId).toBeNull()
  // None of the pane's words left the machine: they stay on its own pane.
  expect(error).not.toContain('check_for_update_on_startup')
})
