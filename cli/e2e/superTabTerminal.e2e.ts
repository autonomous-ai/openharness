/** A PM reads and types into its project's agent's terminal (spec/2026-10-23-lead-sees-agent-terminal.md, Swarm v4), end to end:
 * the real backend, two isolated daemons of one account (the PM's computer and the agent's), fake Claude Code engines and the
 * `super-tab screen` and `type` commands an agent runs. The agent sits on a permission prompt; its host marks it waiting after
 * 3 minutes, the PM reads the screen and answers it, and the agent may not read the PM's. Swarm v4 writes no chat row for any
 * of it (backend superTabs/terminal.ts).
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

/** What an agent on `s` runs: `harness super-tab --tab TAB --agent AGENT …`, its printed answer and exit code. Never the pane of
 *  the runner's own terminal (a run started in tmux): the agent is named by --agent, as from its own pane. */
async function superTab(s: Side, tab: string, agent: string, args: string[]): Promise<{ code: number; out: string }> {
  let out = ''
  const code = await superTabCommand(['--tab', tab, '--agent', agent, ...args],
    { where: () => ({ port: s.daemon.port, dataDir: s.daemon.dataDir, machineId: s.machineId }), pane: undefined, print: text => { out = text } })
  return { code, out }
}

/** The agent with this id in an `agents` list of the Swarm's first load, wherever the read puts that list. */
function agentIn(value: unknown, id: string): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, any>
  const listed = Array.isArray(row.agents) ? row.agents.find((agent: Record<string, any>) => agent?.id === id) : undefined
  if (listed) return listed
  for (const child of Object.values(row)) { const found = agentIn(child, id); if (found) return found }
  return null
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('a PM driving its agent\'s terminal, real backend', () => {
  beforeAll(async () => { backend = await startRealBackend([owner], () => {}) }, 180_000)
  afterAll(async () => { await backend?.stop() })

  it('reads its agent\'s screen, sees it marked waiting on its prompt, answers it, and the agent may not read the PM\'s', async () => {
    const sides: Side[] = []
    for (let i = 0; i < 2; i++) {
      const side = await signIn(backend, owner, FIXTURE_KEYS, daemon => {
        writeFileSync(join(daemon.engineConfig.codexHome, 'models_cache.json'),
          readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
      })
      sides.push(side)
    }
    const [P, A] = sides as [Side, Side]
    onTestFailed(() => {
      for (const [name, s] of [['PM computer', P], ['agent computer', A]] as const) console.log(`---- ${name}\n${tail(s.daemon.log(), 120)}`)
      console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 80)}`)
    })
    const pmHarness = await create(P, 'pm'), agentHarness = await create(A, 'pip')

    // The person makes a project: its PM on one computer, an agent of the project on the other.
    const tab = (await backend.api(owner, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Terminal' })).body.data.id as string
    const run = async (command: Record<string, unknown>) => {
      const r = await backend.api(owner, `/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body.data.result as Record<string, any>
    }
    const channel = (await run({ type: 'project.create', name: 'Terminal', visibility: 'public', brief: 'Answer the prompt.' })).conversationId as string
    const pm = (await run({ type: 'agent.add', conversationId: channel, machineId: P.machineId, harnessId: pmHarness.id, name: 'Faye', configuration: CONFIG, lead: true })).agentId as string
    const pip = (await run({ type: 'agent.add', conversationId: channel, machineId: A.machineId, harnessId: agentHarness.id, name: 'Pip', configuration: CONFIG, lead: false })).agentId as string
    for (const s of [P, A]) expect(await s.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
    const agentNow = async (id: string) => {
      const read = await backend.api(owner, `/api/super-tabs/${tab}/parts`)
      expect(read.status, JSON.stringify(read.body)).toBe(200)
      const row = agentIn(read.body, id)
      expect(row, `${id} in the Swarm's read`).toBeTruthy()
      return row!
    }

    // The agent asks permission to run a command, and waits on it.
    A.client.send('message', { agentId: agentHarness.id, content: '!permit printf terminal-check' })
    const asked = Date.now()
    let last = ''
    const prompt = await until('the PM to read the agent\'s prompt', async () => {
      const read = await superTab(P, tab, pm, ['screen', pip])
      last = read.out
      return read.code === 0 && read.out.includes('Do you want to proceed?') ? read.out : null
    }, 60_000, 1_000).catch(error => { throw new Error(`${(error as Error).message}; last read: ${last}`) })
    expect(prompt).toContain('printf terminal-check')
    expect(prompt).not.toMatch(/\x1b\[/)
    const scrolled = await superTab(P, tab, pm, ['screen', pip, '--scrollback', '50'])
    expect(scrolled.code, scrolled.out).toBe(0)
    expect(scrolled.out).toContain('Do you want to proceed?')

    // A Product Manager's terminal is its person's: the agent cannot read the PM's.
    const refused = await superTab(A, tab, pip, ['screen', pm])
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.out)).toMatchObject({ error: 'TERMINAL_PRIVATE' })

    // After 3 minutes on the prompt, its host marks it waiting on its person.
    const marked = await until('the agent marked waiting on its prompt', async () => {
      const row = await agentNow(pip)
      return row.alerting?.includes('prompt') ? row : null
    }, 5 * 60_000, 10_000)
    expect(Date.now() - asked).toBeGreaterThanOrEqual(3 * 60_000 - 15_000)
    expect(marked.alerting).toEqual(['prompt'])
    // Read again while the prompt still waits: still marked, once.
    expect((await superTab(P, tab, pm, ['screen', pip])).out).toContain('Do you want to proceed?')
    expect((await agentNow(pip)).alerting).toEqual(['prompt'])

    // The PM answers Yes, on its person's own login; the agent runs the command, the prompt is gone and so is the mark.
    const typed = await superTab(P, tab, pm, ['type', pip, '--key', '1'])
    expect(typed.code, typed.out).toBe(0)
    expect(JSON.parse(typed.out)).toEqual({ requestId: expect.any(String), ok: true })
    const after = await until('the agent to run the command', async () => {
      const read = await superTab(P, tab, pm, ['screen', pip])
      return read.out.includes('ran printf terminal-check') && !read.out.includes('Do you want to proceed?') ? read.out : null
    }, 30_000, 1_000)
    expect(after).toContain('ran printf terminal-check')
    await until('the waiting mark to clear', async () => ((await agentNow(pip)).alerting ?? []).includes('prompt') ? null : true, 60_000, 2_000)
    // Neither the screens, the keys nor the mark write a row where people read the team talk, nor in the PM's or the agent's chat.
    const pmRow = await agentNow(pm), pipRow = await agentNow(pip)
    const conversations = [...new Set([channel, pmRow.chatId, pipRow.chatId].filter((id): id is string => typeof id === 'string'))]
    for (const conversation of conversations) {
      const read = await backend.api(owner, `/api/super-tabs/${tab}/conversations/${conversation}/messages`)
      expect(read.status, JSON.stringify(read.body)).toBe(200)
      const rows = read.body.data.messages as Array<Record<string, any>>
      expect(rows.filter(m => String(m.source?.kind ?? '').startsWith('terminal')), conversation).toEqual([])
      expect(rows.some(m => String(m.text).includes('Do you want to proceed?')), conversation).toBe(false)
    }
  }, 9 * 60_000)
})
