/** An agent its person attached (Desktop's Attach, Swarm v4) was started outside the Swarm, with no Swarm role: its host tells it
 *  the team's basics once, in its chat. At its first restart it gets its role from the Swarm (superTabs/inCore/adoption.ts) and
 *  relaunches as a Swarm agent: the basics on its command line and the Swarm's engine arguments, and the notice is not sent again.
 *  The real native launch path, private tmux and fake engines, and a loopback server in place of the backend that answers as
 *  the backend does once Desktop's agent.new and agent.add have run (desktop/lib/super_tabs/new_agent.dart swarmAttachAgent). */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { launchContract } from '../src/engines/launches.js'
import { swarmBasics } from '../src/lib/swarmSkills.js'
import { object } from '../src/superTabs/wire.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FAKE_ACCOUNT, FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-attach-restart', name: 'Fixture', token: 'e2e-attach-restart-token' }
const TAB = 'fixture-tab', CHAT = 'chat'
let daemon: IsolatedDaemon | undefined, relay: FakeBackend | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); await relay?.close(); client = undefined; daemon = undefined; relay = undefined })

/** The instructions a launch gives the engine, as it reads them: Claude Code's appended system prompt; Codex's
 *  developer_instructions, a JSON string that TOML reads as the same string. */
function told(engine: string, args: string[]): string | undefined {
  if (engine === 'claude') { const at = args.indexOf('--append-system-prompt'); return at < 0 ? undefined : args[at + 1] }
  const value = args.find(arg => arg.startsWith('developer_instructions='))
  return value === undefined ? undefined : JSON.parse(value.slice('developer_instructions='.length)) as string
}
/** Whether [args] carry the Swarm's engine arguments (lib/swarmEngineArgs.ts): the engine's own, side by side, and Claude
 *  Code's hooks kept on, which its launch merges into the one --settings it passes. */
function swarmArgs(engine: string, args: string[]): boolean {
  const own = launchContract(engine)?.swarmArgs ?? []
  if (!args.some((_, at) => own.every((arg, i) => args[at + i] === arg))) return false
  if (engine !== 'claude') return true
  const at = args.indexOf('--settings')
  return at >= 0 && JSON.parse(args[at + 1]!).disableAllHooks === false
}

it.each(['claude', 'codex'])('an attached %s agent is told the basics once, and relaunches at its restart as a Swarm agent', async engine => {
  const b = await FakeBackend.start(); relay = b; b.addMachine(ME)
  b.me = { id: FAKE_ACCOUNT, email: 'dee@example.test' }
  const d = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: b.wsUrl, WEB_URL: b.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
    // The Swarm is on, whatever the run was started with (`HARNESS_SWARM=off npm run test:e2e`).
    HARNESS_SWARM: '' } }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
    machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-120).join('\n')))
  const agents: Array<Record<string, any>> = []
  /** The basics notices the Swarm took, and how many times the host read its roster. As the backend does, an operation id
   *  already taken answers its receipt again for the same request, and OPERATION_REUSED for another. */
  const notices: Array<Record<string, any>> = []
  const operations = new Map<string, string>()
  let rosterReads = 0
  b.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, b.httpUrl).pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools` || path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) { rosterReads++; return { data: agents.map(agent => ({ tabId: TAB, agent, observers: [] })) } }
    // What agent.new and agent.add leave: the agent, and its 1:1 chat with its person.
    if (path === `/api/super-tabs/${TAB}`) return { data: { revision: 1, state: { id: TAB, agents,
      conversations: [{ id: CHAT, kind: 'agent-chat', agentIds: agents.map(agent => agent.id), archived: false }] } } }
    if (/\/agents\/[^/]+\/deliveries$/.test(path)) return { data: [] }
    if (method === 'POST' && path === `/api/super-tabs/${TAB}/commands` && object(body.command).type === 'message.send') {
      const request = JSON.stringify(body.command), prior = operations.get(body.operationId)
      if (prior !== undefined && prior !== request) return { status: 409, error: { code: 'OPERATION_REUSED', message: 'Use a new operation ID for a different request.' } }
      if (prior === undefined) { operations.set(body.operationId, request); notices.push(body) }
      return { data: { result: {} } }
    }
    return { data: [] }
  })
  await d.start(); const c = await LocalClient.connect(d, { machineId: ME.machineId }); client = c
  const cwd = join(d.projectsDir, 'sandbox'); mkdirSync(cwd)
  const launches = (): Array<{ engine: string; args: string[] }> => {
    try { return readFileSync(join(d.root, 'launch-argv'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] }
  }
  const saved = (id: string) => JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: Record<string, any>) => row.agentId === id)
  const basics = swarmBasics(false).text
  const also = engine === 'codex' ? ` ${launchContract('codex')!.harnessInstructions!.also}` : ''

  // Its person's own session, started outside the Swarm: no role, no basics, none of the Swarm's arguments.
  const created = await c.request('agent_create', { engine, cwd, prompt: 'hello' }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const harnessId = created.agent.id as string
  await until('its session to bind', async () => (await c.request('agents_list', {})).agents
    ?.some((row: Record<string, any>) => row.id === harnessId && row.sessionId && row.status === 'active') || null, 90_000)
  const first = launches().find(row => row.engine === engine)!
  expect(told(engine, first.args) ?? '').not.toContain(basics.split('\n')[0]!)
  expect(swarmArgs(engine, first.args), JSON.stringify(first.args)).toBe(false)
  expect(saved(harnessId).swarmSkill).toBeUndefined()

  // Attached: the Swarm lists it on this machine with its own chat, and its host tells it the basics there, once.
  const memberId = createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)
  agents.push({ id: memberId, machineId: ME.machineId, harnessId, chatId: CHAT, name: 'juno' })
  expect(await c.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  await until('the basics told in its chat', () => notices.length >= 1 || null, 60_000, 100)
  expect(notices).toEqual([{ operationId: expect.stringMatching(/^skill-/), asAgentId: memberId, command: { type: 'message.send',
    conversationId: CHAT, replyTo: null, recipientIds: [memberId], text: basics, agentOnly: true, notice: 'skills' } }])

  // Restarted, it is a Swarm agent: its role saved, the basics on its command line, and the Swarm's engine arguments.
  const before = launches().length
  const restarted = await c.request('agent_restart', { agentId: harnessId }, 90_000)
  expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
  const relaunch = await until('its relaunch', () => launches().slice(before).find(row => row.engine === engine) ?? null, 90_000)
  expect(told(engine, relaunch.args)).toBe(`${basics}${also}`)
  expect(swarmArgs(engine, relaunch.args), JSON.stringify(relaunch.args)).toBe(true)
  expect(saved(harnessId).swarmSkill).toEqual({ role: 'agent', key: harnessId })
  await until('it to run again', async () => (await c.request('agents_list', {})).agents
    ?.some((row: Record<string, any>) => row.id === harnessId && row.sessionId && row.status === 'active') || null, 90_000)

  // Nothing more told, by this daemon or the next one, which no longer remembers telling it: its launch carries the basics.
  const quiet = async () => {
    const reads = rosterReads
    await until('two more roster reads', () => rosterReads >= reads + 2 || null, 60_000, 100)
    expect(notices).toHaveLength(1)
  }
  await quiet()
  c.close(); await d.restart()
  client = await LocalClient.connect(d, { machineId: ME.machineId })
  expect(await client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  await quiet()
}, 600_000)
