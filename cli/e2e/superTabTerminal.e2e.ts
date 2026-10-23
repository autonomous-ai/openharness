/** A Lead reads and types into a worker's terminal (spec/2026-10-23-lead-sees-agent-terminal.md), end to end: the real
 * backend, two isolated daemons of one account (the Lead's machine and the worker's), fake Claude Code engines and the
 * `super-tab screen` and `type` commands an agent runs. The worker sits on a permission prompt; its host alerts the Lead
 * once after 3 minutes, the Lead reads the screen and answers it, and the worker may not read the Lead's.
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts). */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import type { LocalClient } from './harness/client.js'
import { account, signIn, startRealBackend, type RealBackend } from './harness/realBackend.js'

const owner = account('owner')
let backend: RealBackend
interface Side { daemon: IsolatedDaemon; machineId: string; client: LocalClient }
const FIXTURE_KEYS = { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' }
const CONFIG = { engine: 'claude', model: 'sonnet', effort: 'high', contextWindow: null, engineVersion: null }
const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n')

async function create(s: Side, folder: string): Promise<Record<string, any>> {
  const cwd = join(s.daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await s.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: false }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agents = (await s.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
    const agent = agents.find(a => a.id === created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

/** What an agent on `s` runs: `harness super-tab --tab TAB --agent AGENT …`, its printed answer and exit code. */
async function superTab(s: Side, tab: string, agent: string, args: string[]): Promise<{ code: number; out: string }> {
  let out = ''
  const code = await superTabCommand(['--tab', tab, '--agent', agent, ...args],
    { where: () => ({ port: s.daemon.port, dataDir: s.daemon.dataDir, machineId: s.machineId }), print: text => { out = text } })
  return { code, out }
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('a Lead driving a worker\'s terminal, real backend', () => {
  beforeAll(async () => { backend = await startRealBackend([owner], () => {}) }, 180_000)
  afterAll(async () => { await backend?.stop() })

  it('reads the worker\'s screen, is alerted once to its waiting prompt, answers it, and the worker may not read the Lead\'s', async () => {
    const sides: Side[] = []
    for (let i = 0; i < 2; i++) {
      const side = await signIn(backend, owner, FIXTURE_KEYS, daemon => {
        writeFileSync(join(daemon.engineConfig.codexHome, 'models_cache.json'),
          readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
      })
      sides.push(side)
    }
    const [L, W] = sides as [Side, Side]
    onTestFailed(() => {
      for (const [name, s] of [['Lead machine', L], ['worker machine', W]] as const) console.log(`---- ${name}\n${tail(s.daemon.log(), 120)}`)
      console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 80)}`)
    })
    const leadHarness = await create(L, 'lead'), workerHarness = await create(W, 'worker')

    // The person makes the Swarm: its Lead on one machine, a worker in a group on the other.
    const tab = (await backend.api(owner, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Terminal' })).body.data.id as string
    const run = async (command: Record<string, unknown>) => {
      const r = await backend.api(owner, `/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body.data.result as Record<string, any>
    }
    const lead = (await run({ type: 'agent.add', conversationId: 'lead', machineId: L.machineId, harnessId: leadHarness.id, name: 'Lead', configuration: CONFIG, lead: true })).agentId as string
    const group = (await run({ type: 'conversation.create', title: 'Terminal', brief: 'Answer the prompt', checks: [] })).conversationId as string
    const worker = (await run({ type: 'agent.add', conversationId: group, machineId: W.machineId, harnessId: workerHarness.id, name: 'Worker', configuration: CONFIG, lead: false })).agentId as string
    const rows = async () => ((await backend.api(owner, `/api/super-tabs/${tab}/conversations/${group}/messages`)).body.data.messages as Array<Record<string, any>>)
    // Each joins as a launched agent does, which starts its machine's host.
    for (const [s, id] of [[L, lead], [W, worker]] as const) expect((await superTab(s, tab, id, ['status'])).code).toBe(0)

    // The worker asks permission to run a command, and waits on it.
    W.client.send('message', { agentId: workerHarness.id, content: '!permit printf terminal-check' })
    const asked = Date.now()
    let last = ''
    const prompt = await until('the Lead to read the worker\'s prompt', async () => {
      const read = await superTab(L, tab, lead, ['screen', worker])
      last = read.out
      return read.code === 0 && read.out.includes('Do you want to proceed?') ? read.out : null
    }, 60_000, 1_000).catch(error => { throw new Error(`${(error as Error).message}; last read: ${last}`) })
    expect(prompt).toContain('printf terminal-check')
    expect(prompt).not.toMatch(/\x1b\[/)
    const scrolled = await superTab(L, tab, lead, ['screen', worker, '--scrollback', '50'])
    expect(scrolled.code, scrolled.out).toBe(0)
    expect(scrolled.out).toContain('Do you want to proceed?')

    // Only the Lead of the worker's project may: the worker cannot read the Lead's terminal.
    const refused = await superTab(W, tab, worker, ['screen', lead])
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.out)).toMatchObject({ error: 'LEAD_REQUIRED' })

    // After 3 minutes on the prompt, one alert, and no more while it still waits.
    const alerts = async () => (await rows()).filter(m => m.source?.kind === 'terminal-alert')
    const alert = await until('the prompt alert', async () => { const found = await alerts(); return found.length ? found : null }, 5 * 60_000, 5_000)
    expect(Date.now() - asked).toBeGreaterThanOrEqual(3 * 60_000 - 15_000)
    expect(alert).toHaveLength(1)
    expect(alert[0]).toMatchObject({ source: { kind: 'terminal-alert', agentId: worker, alert: 'prompt' } })
    expect(alert[0].text).not.toContain('printf')
    await new Promise(resolve => setTimeout(resolve, 35_000))
    expect(await alerts()).toHaveLength(1)

    // The Lead answers Yes; the worker runs the command and the prompt is gone.
    const typed = await superTab(L, tab, lead, ['type', worker, '--key', '1'])
    expect(typed.code, typed.out).toBe(0)
    expect(JSON.parse(typed.out)).toEqual({ requestId: expect.any(String), ok: true })
    const after = await until('the worker to run the command', async () => {
      const read = await superTab(L, tab, lead, ['screen', worker])
      return read.out.includes('ran printf terminal-check') && !read.out.includes('Do you want to proceed?') ? read.out : null
    }, 30_000, 1_000)
    expect(after).toContain('ran printf terminal-check')
    // The input is logged in the worker's group; the screens never are.
    const history = await rows()
    const inputs = history.filter(m => m.source?.kind === 'terminal-input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].text).toMatch(/typed 1 in .+'s terminal$/)
    expect(history.some(m => String(m.text).includes('Do you want to proceed?'))).toBe(false)
  }, 9 * 60_000)
})
