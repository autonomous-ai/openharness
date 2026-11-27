/**
 * Hachi's verbs on the real daemon (docs/design/2026-11-12-hachi.md, "How it acts"): a harness on the autonomous/hachi
 * package, signed in to a fake backend whose account has a second machine that never answers. From its pane it opens a
 * goal (kept by the goals service in the edge host, mode 0600), starts a harness for it, follows everything it started
 * in one stream, reads its work in facts, lists every machine with the silent one as unreachable, and closes the goal:
 * the window here and the owner's apps away (sealed, through the relay) are told it once (`hachi_goal_done`, Hachi 5a).
 * An ordinary agent beside it may not keep goals (exit 5), and a goal with no harness is never done.
 *
 * The package itself is issue 5's (OPENHARNES-5): here a harness of that id is installed from a repository, which is
 * all the goals service reads of it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { WebSocket } from 'ws'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { HACHI_ID } from '../src/dsh/builtinIds.js'

const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c9', name: 'studio', token: 'e2e-token-hachi-verbs' }
const OFFICE: FakeMachine = { machineId: 'c8'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c8', name: 'office', token: 'e2e-token-hachi-office' }

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

describe('Hachi\'s verbs, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  it('Hachi keeps a goal, starts and follows its harness, reads its work and every machine; nobody else keeps goals', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    // Another machine of the account that is never connected: it cannot answer.
    relay.addMachine(OFFICE)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }], tabs: [] }
    relay.experiments.agents_start_agents = true
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
    await until('the account\'s experiments to be kept', () => {
      try { return JSON.parse(readFileSync(join(d.dataDir, 'agent-settings.json'), 'utf8')).agentsStartAgents === true || null } catch { return null }
    }, 30_000, 200)

    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    expect(await client.request('dsh_install', { url: repository(d, HACHI_ID) }, 180_000)).toMatchObject({ ok: true, id: HACHI_ID })
    const create = async (name: string, dsh?: string) => {
      const cwd = join(d.projectsDir, name)
      mkdirSync(cwd, { recursive: true })
      const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, name, ...(dsh ? { dsh } : {}) }, 90_000)
      expect(made.error, JSON.stringify(made)).toBeUndefined()
      return until(`${name} to bind its conversation`, async () => {
        const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.id === made.agent.id)
        return row?.sessionId && row.status === 'active' ? row : null
      }, 60_000, 500)
    }
    const hachi = await create('hachi', HACHI_ID)
    const lead = await create('lead')
    const asHachi = (...args: string[]) => harness(d, String(hachi.tmuxPane), args)

    // Any other agent is refused, as every refusal: exit 5, and nothing is kept.
    const refused = await harness(d, String(lead.tmuxPane), ['goal', 'open', 'not mine', '--json'])
    expect(refused.code, refused.out + refused.err).toBe(5)
    expect(JSON.parse(refused.out)).toMatchObject({ code: 'NOT_HACHI' })
    const notHachi = await harness(d, String(lead.tmuxPane), ['new', 'claude', 'x', '--goal', 'g1', '--', 'hello'])
    expect(notHachi.code, notHachi.out + notHachi.err).toBe(5)

    // Hachi opens a goal; with no harness started for it, it is not done.
    const opened = await asHachi('goal', 'open', 'flaky', 'login', 'test', '--json')
    expect(opened.code, opened.out + opened.err).toBe(0)
    const goal = JSON.parse(opened.out).goal
    expect(goal).toMatchObject({ title: 'flaky login test', harnesses: [], doneAt: null })
    const empty = await asHachi('goal', 'done', goal.id)
    expect(empty.code, empty.out + empty.err).toBe(5)
    expect(empty.err).toContain('No harness was started for that goal')
    const file = join(d.dataDir, 'hachi', 'goals.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // It starts a harness for it, recorded under the goal once made.
    const started = await asHachi('new', 'claude', 'kid', '--name', 'kid', '--goal', goal.id, '--', 'hello kid')
    expect(started.code, started.out + started.err).toBe(0)
    expect(started.err).toBe('')
    const listed = JSON.parse((await asHachi('goal', 'list', '--json')).out).goals
    expect(listed).toEqual([expect.objectContaining({ id: goal.id, harnesses: [expect.objectContaining({ machineId: ME.machineId, agentId: expect.any(String) })] })])

    // One stream for what it started: kid's lines, named with its machine, and nobody else's.
    const watched = await asHachi('watch', '--mine', '--json', '--timeout', '30s')
    expect(watched.code, watched.err).toBe(124)
    const lines = watched.out.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.name === 'kid' && line.machine === 'studio')).toBe(true)
    expect(lines.at(-1).event).toBe('done')

    // Its work, in facts: its folder is no repository, so no branch and no pull request.
    const work = await asHachi('show', 'kid', '--work', '--json')
    expect(work.code, work.err).toBe(0)
    expect(JSON.parse(work.out)).toMatchObject({ name: 'kid', state: 'idle', startedBy: 'you', work: { pullRequest: expect.stringMatching(/^(none|unavailable)$/) } })

    // Every machine at once: office never answers, and is listed as unreachable within its 5 s.
    const began = Date.now()
    const ps = await asHachi('ps', '--machines', '--json')
    expect(ps.code, ps.err).toBe(0)
    const machines = JSON.parse(ps.out).machines
    expect(machines.map((m: Record<string, unknown>) => [m.machine, m.state])).toEqual([['studio', 'ok'], ['office', 'unreachable']])
    expect(machines[0].harnesses.map((h: { name: string }) => h.name).sort()).toEqual(['hachi', 'kid', 'lead'])
    // The CLI's own start, the backend's list, and at most the 5 s wait on office.
    expect(Date.now() - began).toBeLessThan(20_000)

    // An app of the owner's away from this desk, on the relay: it hears the machine's broadcasts, sealed.
    await until('the machine to be connected to the backend', () => relay.nodeUp(ME.machineId) || null, 30_000)
    const away = new WebSocket(`${relay.wsUrl}/api/web-ws?autonomousEnv=prod`, [ME.token])
    await new Promise<void>((resolve, reject) => { away.once('open', () => resolve()); away.once('error', reject) })
    const selected = new Promise<void>((resolve) => away.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type?: string; payload?: { machineId?: string } }
      if (frame.type === 'connected' && frame.payload?.machineId === ME.machineId) resolve()
    }))
    away.send(JSON.stringify({ type: 'machine_select', payload: { machineId: ME.machineId } }))
    await selected
    const relayed = () => [...relay.webReceived.values()].flat().filter((frame) => frame.type === 'hachi_goal_done')

    // Done, once: the second close changes nothing, and tells nobody again.
    const told = client.next((frame) => frame.type === 'hachi_goal_done', 30_000, 'the goal\'s notice')
    const done = await asHachi('goal', 'done', goal.id, '--json')
    expect(done.code, done.out + done.err).toBe(0)
    const doneAt = JSON.parse(done.out).goal.doneAt
    expect(doneAt).toEqual(expect.any(Number))
    expect((await told).payload).toEqual({ agentId: hachi.id, goalId: goal.id, title: 'flaky login test' })
    const away1 = await until('the notice relayed to the app away', () => relayed()[0] ?? null, 30_000, 100)
    // Sealed: the relay carries the person's words only as ciphertext.
    expect(away1.payload).toEqual({ __e2e: expect.any(Object) })
    expect(JSON.stringify(away1)).not.toContain('flaky')
    expect(JSON.parse((await asHachi('goal', 'done', goal.id, '--json')).out).goal.doneAt).toBe(doneAt)
    // The goals tell the core before they answer, on the one link they answer on: once the CLI has its answer, a second
    // notice would already be on its way to the window, ahead of this round trip's reply.
    await client.request('agents_list', {}, 30_000)
    expect(client.frames.filter((frame) => frame.type === 'hachi_goal_done')).toHaveLength(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    away.close()
    client.close()
  }, 300_000)
})
