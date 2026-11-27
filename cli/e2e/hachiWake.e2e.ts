/**
 * Hachi on the real daemon (docs/design/2026-11-12-hachi.md, issue 5): with the account's `hachi` switch on and
 * `agents-start-agents` off, the Hachi harness may start a harness and no other agent may. When that harness is done, the
 * daemon wakes Hachi with one line built from names and states, typed into its pane under the pseudo-tab `hachi`. Turning
 * the switch off closes Hachi, and the harness it started is the person's: it keeps running, and its starter is cleared.
 *
 * The package itself is bundled only in a release build; here a harness of its id is installed from a repository, as
 * the verbs' end-to-end test does (e2e/hachiVerbs.e2e.ts).
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { Ledger, ledgerPath } from '../src/agentClient/ledger.js'
import { HACHI_ID } from '../src/dsh/builtinIds.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c7', name: 'studio', token: 'e2e-token-hachi-wake' }

/** `harness <args>` from [pane], as an agent's shell tool runs it. */
function harness(d: IsolatedDaemon, pane: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

/** A harness package of [id] in a git repository of its own, as `dsh_install` clones it. */
function repository(d: IsolatedDaemon, id: string): string {
  const dir = join(d.root, 'repo-hachi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id, name: 'Hachi', engine: 'claude' }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'hachi')
  return dir
}

describe('Hachi, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  it('starts a harness through the gate, is woken when it is done, and turned off hands it to the person', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }], tabs: [] }
    // Hachi on; agents may not start agents.
    relay.experiments.hachi = true
    const d = await IsolatedDaemon.create({ env: {
      BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
      machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    const settings = () => { try { return JSON.parse(readFileSync(join(d.dataDir, 'agent-settings.json'), 'utf8')) as Record<string, unknown> } catch { return null } }
    await until('the account\'s experiments to be kept', () => settings()?.hachi === true || null, 30_000, 200)

    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    expect(await client.request('dsh_install', { url: repository(d, HACHI_ID) }, 180_000)).toMatchObject({ ok: true, id: HACHI_ID })
    const list = async () => (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
    const create = async (name: string, dsh?: string) => {
      const cwd = join(d.projectsDir, name)
      mkdirSync(cwd, { recursive: true })
      const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, name, ...(dsh ? { dsh } : {}) }, 90_000)
      expect(made.error, JSON.stringify(made)).toBeUndefined()
      return until(`${name} to bind its conversation`, async () => {
        const row = (await list()).find((a) => a.id === made.agent.id)
        return row?.sessionId && row.status === 'active' ? row : null
      }, 60_000, 500)
    }
    const hachi = await create('hachi', HACHI_ID)
    const lead = await create('lead')

    // The switch is the person's yes to Hachi alone: another agent is refused, as every refusal.
    const refused = await harness(d, String(lead.tmuxPane), ['new', 'claude', 'x', '--name', 'x', '--', 'hello'])
    expect(refused.code, refused.out + refused.err).toBe(5)
    expect(refused.err).toContain('agents-start-agents')
    const started = await harness(d, String(hachi.tmuxPane), ['new', 'claude', 'kid', '--name', 'kid', '--', 'hello kid'])
    expect(started.code, started.out + started.err).toBe(0)
    const kid = await until('kid to be listed', async () => (await list()).find((a) => a.name === 'kid') ?? null, 60_000, 500)

    // kid answers and is done: the daemon wakes Hachi with one line of names and states, typed into its pane.
    const woken = await until('Hachi to be woken', async () => {
      const history = await client.request<{ messages?: Array<{ text: string; to: Array<{ agentId: string }>; statuses: Array<{ state: string }> }> }>(
        'agent_messages', { action: 'history', tabId: 'hachi' }, 30_000)
      const line = history.messages?.find((m) => m.statuses.some((s) => s.state === 'delivered'))
      return line ?? null
    }, 120_000, 1_000)
    expect(woken.text).toBe('[harness] kid @studio: done.')
    expect(woken.to).toEqual([expect.objectContaining({ agentId: hachi.id })])

    // Turned off: Hachi is closed with its conversation kept, and kid keeps running as the person's.
    relay.setExperiment('hachi', false)
    await until('Hachi to be closed', async () => ((await list()).some((a) => a.id === hachi.id && a.status === 'active') ? null : true), 90_000, 500)
    const ledger = new Ledger(ledgerPath(d.dataDir))
    await until('kid to be handed to the person', () => ledger.handedAt({ machineId: ME.machineId, agentId: kid.id }) !== null || null, 30_000, 500)
    expect(ledger.parentOf({ machineId: ME.machineId, agentId: kid.id })).toBeNull()
    expect((await list()).find((a) => a.id === kid.id)).toMatchObject({ status: 'active' })
    client.close()
  }, 400_000)
})
