/**
 * Harness for agents on the real daemon (docs/design/2026-10-11-agent-client.md): an agent, from its own pane, runs
 * the `harness` verbs as it would through its shell tool. It lists the harnesses, starts one with a task, waits for
 * it, reads its answer, and closes it; it may not close one it did not start. Neither may message the other while
 * they share no tab (owner, 2026-10-11: Agent Messages off means off). The fake engines answer by echoing
 * (harness/fakeEngine.mjs). Agent-started harnesses retain their coordination instructions, without
 * adding Harness attribution to pull requests, even if an older account setting still asks for it.
 *
 * What agents may do is the account's (Settings ▸ Experimental, every switch off by default): signed in to the fake
 * backend, which answers the account's experiments and its tabs (there are none), and turned on where a test needs it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { retainedHarnesses } from '../src/superTabs/retention.js'

const HARNESS_INSTRUCTIONS = 'You are running in Harness, and the person can watch you. You can hand work to other agents (Claude Code, Codex) that run in their own harnesses: `harness new`, `harness wait`, `harness show`, `harness close` (see `harness --help`). Start one only for work that can run in parallel, needs another model, or takes long; do quick work yourself, and close each one once you have its answer. Only use or close harnesses you started.'
const ME: FakeMachine = { machineId: 'b8'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000b8', name: 'studio', token: 'e2e-token-agent-client' }
const signIn = (d: IsolatedDaemon) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
  version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
  machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
}), { mode: 0o600 })

/** `harness <args>` from [pane], as an agent's shell tool runs it: not a terminal, so plain text. */
function harness(d: IsolatedDaemon, pane: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

/** `harness mcp` as an MCP client starts it: requests in on stdin, answers by id from stdout. */
function mcp(d: IsolatedDaemon, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], {
    cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '', ...extra }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map<number, (reply: Record<string, any>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line)
    waiting.get(reply.id)?.(reply)
  })
  let next = 1
  return {
    request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const id = next++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((done) => waiting.set(id, done))
    },
    notify(method: string): void { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) },
    async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const reply = await this.request('tools/call', { name, arguments: args })
      return { text: reply.result.content.map((c: { text: string }) => c.text).join('\n'), isError: reply.result.isError === true }
    },
    close(): void { child.stdin.end() },
  }
}

/** The account's agent experiments as [d] keeps them (lib/agentSettings.ts), once it has read them. */
const kept = (d: IsolatedDaemon, want: (settings: Record<string, unknown>) => boolean = () => true) => until('the account\'s experiments to be kept', () => {
  try {
    const settings = JSON.parse(readFileSync(join(d.dataDir, 'agent-settings.json'), 'utf8')) as Record<string, unknown>
    return want(settings) ? settings : null
  } catch { return null }
}, 30_000, 200)

describe('Harness for agents, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })
  /** A daemon signed in to the fake backend, whose account has [experiments] on, read and kept before the test goes on. */
  const signedIn = async (experiments: Record<string, boolean>, options: { trustPrompt?: boolean; before?: (d: IsolatedDaemon) => void } = {}) => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }], tabs: [] }
    Object.assign(relay.experiments, experiments)
    const d = await IsolatedDaemon.create({ trustPrompt: options.trustPrompt, env: {
      BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    signIn(d)
    options.before?.(d)
    await d.start()
    await kept(d, (settings) => Object.entries(experiments).every(([feature, on]) => settings[{ agents_start_agents: 'agentsStartAgents', agent_pull_request_line: 'pullRequestLine', agent_messages: 'agentMessages' }[feature]!] === on))
    return { relay, d }
  }

  it('an agent sees, starts, waits for, reads and closes a harness of its own, and may not message it outside a shared tab', async () => {
    const { d } = await signedIn({ agents_start_agents: true, agent_messages: true })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })

    const leadDir = join(d.projectsDir, 'lead')
    mkdirSync(leadDir, { recursive: true })
    const made = await client.request('agent_create', { engine: 'claude', cwd: leadDir, bypassPermission: true, name: 'lead' }, 90_000)
    expect(made.error, JSON.stringify(made)).toBeUndefined()
    const lead = await until('lead to bind its conversation', async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.id === made.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    const run = (...args: string[]) => harness(d, String(lead.tmuxPane), args)

    // It sees itself.
    const ps = await run('ps')
    expect(ps.code, ps.err).toBe(0)
    expect(ps.out).toMatch(/^You: Claude Code "lead" \(/)
    expect(ps.out).toMatch(/\nlead +Claude Code +\w+ +person \(you\)/)

    // A terminal is the person's: no verb here lists one, so the agent could never read or close it. Refused, none made.
    const shell = await run('new', 'terminal', '--', 'npm run dev')
    expect(shell.code, shell.out).toBe(1)
    expect(shell.err).toContain('An agent cannot start a terminal')
    expect((await client.request<{ agents: unknown[] }>('agents_list', {}, 30_000)).agents).toHaveLength(1)

    // It starts a harness with a task, which reads who sent it, in a project Harness makes for it.
    const started = await run('new', 'claude', 'kid', '--name', 'kid', '--', 'hello kid')
    expect(started.code, started.err).toBe(0)
    expect(started.out).toContain(`kid on this computer: starting. Claude Code, in ${join(d.env.HOME!, 'harnesses', 'kid')}.`)
    expect(started.out).toContain('Next: harness wait kid  (until it has answered; then read it: harness show kid)')
    expect(started.out).not.toContain('harness send')
    // Started lines: a create the machine answers pending first also writes a pending one (agentClient/ledger.ts).
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.child)
    expect(ledger).toEqual([expect.objectContaining({ depth: 1, by: expect.objectContaining({ agentId: lead.id, name: 'lead' }), child: expect.objectContaining({ name: 'kid' }) })])

    // It waits for it, then reads its answer.
    const waited = await run('wait', 'kid', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    expect(waited.out.trim()).toBe('kid: idle · read it: harness show kid')
    const shown = await run('show', 'kid')
    expect(shown.code, shown.err).toBe(0)
    expect(shown.out).toMatch(/^kid on .+: idle · Claude Code · started by you\n/)
    expect(shown.out).toContain('asked: [from lead · Claude Code · ')
    expect(shown.out).toContain('the harness that started you. It reads your answer itself.]')
    expect(shown.out).not.toContain('harness send')
    expect(shown.out).toContain('hello kid')
    expect((await run('ps')).out).toMatch(/\nkid +Claude Code +\w+ +you /)

    // They share no tab: neither messages the other, either way, as for any two harnesses, though the account has Agent
    // Messages on. Since #1180 the two messaged each other with no tab, and the owner found agents talking before
    // turning Agent Messages on.
    const off = 'No other harness is in this tab. The person puts harnesses in one tab for them to message each other.'
    const sent = await run('send', 'kid', 'Also check the footer.')
    expect(sent.code, sent.out + sent.err).toBe(1)
    expect(sent.err).toContain(off)
    const kid = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'kid')!
    // The windows open it beside the harness that started it, and say so in its header: its frame names that harness,
    // in the list and in the push a window first sees it by (desktop `Agent.parentAgentId`). The person's has none.
    expect(kid.parentAgentId).toBe(lead.id)
    expect(lead.parentAgentId).toBeNull()
    expect(client.frames.some((f) => f.type === 'agent_synced' && f.payload?.agent?.id === kid.id && f.payload.agent.parentAgentId === lead.id)).toBe(true)
    const back = await harness(d, String(kid.tmuxPane), ['send', 'lead', 'Footer checked.'])
    expect(back.code, back.out + back.err).toBe(1)
    expect(back.err).toContain(off)
    // Nor does `harness send` alone name the other.
    const listed = await harness(d, String(kid.tmuxPane), ['send'])
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out.trim()).toBe('No teammates in this tab yet.')

    // It closes what it started, and only that; the harness it started may not close it.
    const own = await run('close', 'lead')
    // Refused, not failed: exit 5.
    expect(own.code).toBe(5)
    expect(own.err).toContain('That is your own harness.')
    const fromKid = await harness(d, String(kid.tmuxPane), ['close', 'lead'])
    expect(fromKid.code, fromKid.out).toBe(5)
    expect(fromKid.err).toContain('You did not start lead')
    await run('wait', 'kid', '--timeout', '2m')
    const closed = await run('close', 'kid')
    expect(closed.code, closed.err).toBe(0)
    expect(closed.out.trim()).toMatch(/^kid on .+: closed\. Its conversation is kept; the person can resume it\.\nNext: nothing; you have 0 open of 4\.$/)
    const after = await run('ps', '--all', '--json')
    expect(JSON.parse(after.out).harnesses).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'kid', state: 'stopped', startedBy: 'you' })]))

    // The same through `harness mcp` run in its pane (`harness_start`), as Claude Code with the plugin does.
    const server = mcp(d, { TMUX_PANE: String(lead.tmuxPane) })
    await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
    server.notify('notifications/initialized')
    const viaMcp = await server.call('harness_start', { task: 'hello from the pane', project: 'pane-kid', name: 'panekid' })
    expect(viaMcp.isError, viaMcp.text).toBe(false)
    const paneKid = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'panekid')
    expect(paneKid?.parentAgentId).toBe(lead.id)
    server.close()
    client.close()
  })

  it('a harness another agent started may not start more, is closed with its starter, and is the person\'s once they type into it', async () => {
    // Owner, October 12: "we need to be very careful about when to start a new agent so we don't waste user token and we
    // need to properly clean up after too". The cleanup runs in its own process here, as it does by default (the edge
    // host): what the core tells it and what it asks back cross the link.
    const { d, relay } = await signedIn({ agents_start_agents: true })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const list = async (includeStopped = false) => (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped }, 30_000)).agents
    const lead = async (name: string) => {
      const dir = join(d.projectsDir, name)
      mkdirSync(dir, { recursive: true })
      const made = await client.request('agent_create', { engine: 'claude', cwd: dir, bypassPermission: true, name }, 90_000)
      expect(made.error, JSON.stringify(made)).toBeUndefined()
      const bound = await until(`${name} to bind its conversation`, async () => {
        const row = (await list()).find((a) => a.id === made.agent.id)
        return row?.sessionId && row.status === 'active' ? row : null
      }, 60_000, 500)
      // One turn of the person's first: a close saves a conversation, and one with nothing in it yet has none to save.
      const from = client.frames.length
      client.send('message', { agentId: bound.id, content: `hello ${name}` })
      const opened = await client.waitFor((f) => f.type === 'turn_started' && f.agentId === bound.id, 60_000, `${name}'s first turn`, from)
      await client.waitFor((f) => f.type === 'turn_ended' && f.agentId === bound.id, 60_000, `${name}'s first turn to end`, client.frames.indexOf(opened) + 1)
      return bound
    }
    const start = async (from: Record<string, any>, name: string) => {
      const started = await harness(d, String(from.tmuxPane), ['new', 'claude', name, '--name', name, '--', `hello ${name}`])
      expect(started.code, started.out + started.err).toBe(0)
      return until(`${name} to run`, async () => (await list()).find((a) => a.name === name && a.status === 'active' && a.tmuxPane) ?? null, 60_000, 500)
    }
    const stateOf = async (agent: Record<string, any>) => (await list(true)).find((a) => a.id === agent.id)?.status

    const first = await lead('lead')
    const kid = await start(first, 'kid')

    // One level down: the harness lead started may not start one itself, and nothing is started.
    const deeper = await harness(d, String(kid.tmuxPane), ['new', 'claude', 'deeper', '--name', 'deeper', '--', 'hello deeper'])
    expect(deeper.code, deeper.out).toBe(5)
    expect(deeper.err.trim()).toBe('A harness another agent started may not start harnesses itself. Do the work yourself, or say in your answer what else is needed.')
    expect((await list(true)).some((a) => a.name === 'deeper')).toBe(false)

    // Lead reads its answer, and is told to close it; `ps` counts what it has open.
    const waited = await harness(d, String(first.tmuxPane), ['wait', 'kid', '--timeout', '2m'])
    expect(waited.code, waited.out + waited.err).toBe(0)
    const shown = await harness(d, String(first.tmuxPane), ['show', 'kid'])
    expect(shown.out.trim().split('\n').at(-1)).toBe('Next: harness close kid  (once you have what you need)')
    const ps = await harness(d, String(first.tmuxPane), ['ps'])
    expect(ps.out.trim().split('\n').at(-1)).toBe('Next: harness show kid  (read its answer, then close it: harness close kid)')

    // A second lead with two: the person types into one of them, from a window.
    const second = await lead('lead2')
    const joined = await start(second, 'joined')
    const left = await start(second, 'left')
    const shared = await start(second, 'shared')
    relay.superTabs = async (_method, raw) => {
      const path = new URL(raw, relay.httpUrl).pathname
      return { data: path === `/api/super-tabs/hosts/${ME.machineId}`
        ? [{ tabId: 'retained-team', agent: { id: 'shared-member', harnessId: shared.id, machineId: ME.machineId }, observers: [] }]
        : [] }
    }
    expect(await client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
    await until('the team host to retain its member', () => retainedHarnesses(d.dataDir).has(shared.id) || null, 10_000, 100)
    client.send('message', { agentId: joined.id, content: 'hello from the person' })

    // The app closes lead, as a pane's close does (`agent_close`): kid closes with it.
    const closed = await client.request('agent_close', { agentId: first.id, sessionId: first.sessionId, createdAt: first.createdAt, mode: 'now' }, 60_000)
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true })
    await until('kid to close with lead', async () => (await stateOf(kid)) === 'stopped' || null, 60_000, 500)
    // A window closing the tab both are in closes kid's pane next, a moment later: closed, not "it changed".
    const again = await client.request('agent_close', { agentId: kid.id, sessionId: kid.sessionId, createdAt: kid.createdAt, mode: 'idle' }, 60_000)
    expect(again, JSON.stringify(again)).toMatchObject({ closed: true })

    // The person closes lead2 from a terminal: the one they typed into stays, the other closes.
    const byPerson = await harness(d, '', ['close', 'lead2', '--now'])
    expect(byPerson.code, byPerson.out + byPerson.err).toBe(0)
    await until('left to close with lead2', async () => (await stateOf(left)) === 'stopped' || null, 60_000, 500)
    expect(await stateOf(joined)).toBe('active')
    expect(await stateOf(shared)).toBe('active')
    // One line for each close.
    expect(d.log()).toMatch(/\[agent-cleanup\] closed kid \(\w+\): the harness that started it was closed\. Its conversation is kept\./)
    expect(d.log()).toMatch(/\[agent-cleanup\] closed left \(\w+\): the harness that started it was closed\./)
    expect(d.log()).not.toMatch(/\[agent-cleanup\] closed joined/)
    expect(d.log()).not.toMatch(/\[agent-cleanup\] closed shared/)
    client.close()
  })

  it('signed out, the person starts, waits for, reads and closes a harness from a terminal', async () => {
    // Never signed in: the daemon runs as this computer (core/main.ts), and the app made harnesses while `harness new`
    // refused with "This computer is not signed in to Harness".
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const dir = join(d.projectsDir, 'solo')
    mkdirSync(dir, { recursive: true })
    const run = (...args: string[]) => harness(d, '', args)

    const started = await run('new', 'claude', dir, '--name', 'solo', '--', 'hello solo')
    expect(started.code, started.out + started.err).toBe(0)
    expect(started.out).toContain('Created solo on this computer')
    const waited = await run('wait', 'solo', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    const shown = await run('show', 'solo')
    expect(shown.code, shown.err).toBe(0)
    expect(shown.out).toContain('hello solo')
    // The person's task, as they typed it: no header.
    expect(shown.out).not.toContain('[from')
    const closed = await run('close', 'solo')
    expect(closed.code, closed.err).toBe(0)
    // What agents may do is the account's: signed out every switch is off, and there is none to turn on.
    const listed = await run('settings')
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out).toMatch(/^agents-start-agents +off /m)
    expect(listed.out).toContain('Signed out: these are experiments of your account. Sign in (harness login) to turn them on.')
    const refused = await run('settings', 'agents-start-agents', 'on')
    expect(refused.code).toBe(1)
    expect(refused.err.trim()).toBe('Sign in to Harness to change this: what agents may do is an experiment of your account (Settings ▸ Experimental).')
  })

  it('an agent outside Harness starts, reads and closes a harness of its own, and may not close the person\'s', async () => {
    const { d } = await signedIn({ agents_start_agents: true })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const personDir = join(d.projectsDir, 'person')
    mkdirSync(personDir, { recursive: true })
    const theirs = await client.request('agent_create', { engine: 'claude', cwd: personDir, bypassPermission: true, name: 'theirs' }, 90_000)
    expect(theirs.error, JSON.stringify(theirs)).toBeUndefined()
    // Claude Code in a terminal app: no pane, and the session its shell names.
    const run = (...args: string[]) => harness(d, '', args, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outside-session' })

    const ps = await run('ps')
    expect(ps.code, ps.err).toBe(0)
    expect(ps.out.split('\n')[0]).toMatch(/^You: Claude Code, outside Harness, on .+\. Nothing can message you here\.$/)
    const started = await run('new', 'claude', 'helper', '--name', 'helper', '--', 'check it')
    expect(started.code, started.out + started.err).toBe(0)
    // Nothing can message an agent with no pane: no `send` in what to do next.
    expect(started.out).toContain('Next: harness wait helper  (until it has answered; then read it: harness show helper)')
    // No pane to open it beside.
    expect(started.out).toContain('The person sees it in Harness.\n')
    expect(started.out).not.toContain('harness send')
    // Started lines: a create the machine answers pending first also writes a pending one (agentClient/ledger.ts).
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.child)
    expect(ledger).toEqual([expect.objectContaining({ depth: 1, by: expect.objectContaining({ agentId: 'claude-code:outside-session', name: 'Claude Code' }), child: expect.objectContaining({ name: 'helper' }) })])
    // No harness started it, so no window has one to open it beside.
    const helper = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'helper')
    expect(helper).toMatchObject({ parentAgentId: null })

    const waited = await run('wait', 'helper', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    const shown = await run('show', 'helper')
    expect(shown.out).toContain('asked: [from Claude Code outside Harness · ')
    expect(shown.out).toContain('the agent that started you. It reads your answer itself.]')
    expect(shown.out).toContain('check it')

    const person = await run('close', 'theirs')
    expect(person.code).toBe(5)
    expect(person.err).toContain('You did not start theirs')
    // Another session of the same agent did not start it either.
    const other = await harness(d, '', ['close', 'helper'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'another-session' })
    expect(other.code).toBe(5)
    const closed = await run('close', 'helper')
    expect(closed.code, closed.err).toBe(0)
    client.close()
  })

  // Codex 0.162.1 in a clean macOS VM (2026-10-12): `harness close <it> --now` a second after `harness new` answered
  // "Conversation identity is held: the native control descriptor type is unavailable." and the harness kept working,
  // because for its first seconds every read of the Codex process was refused. The fake Codex holds such a descriptor
  // for as long, and its first hook is as late: until then nothing could bind its conversation, as there.
  it.each([
    ['binds its conversation a few seconds in', 6_000, /^pong on .+: closed\. Its conversation is kept; the person can resume it\.\nNext: nothing; you have 0 open of 4\.$/],
    ['never binds while the close waits', 120_000, /^pong on .+: closed\. It was still starting, so no conversation was kept\.\nNext: nothing; you have 0 open of 4\.$/],
  ] as const)('an agent closes a Codex it started a second ago, which %s', async (_, unboundMs, said) => {
    const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    const { d } = await signedIn({ agents_start_agents: true }, { before: (d) => {
      const config = { ...d.engineConfig, unreadableDescriptorMs: unboundMs, firstHookDelayMs: unboundMs }
      writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(module)}).then((m) => m.run('codex', ${JSON.stringify(config)}))\n`, { mode: 0o755 })
    } })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const run = (...args: string[]) => harness(d, '', args, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outside-session' })

    const started = await run('new', 'codex', 'pong', '--name', 'pong', '--', 'Reply with pong')
    expect(started.code, started.out + started.err).toBe(0)
    // The same start asked again is the same harness, started "just now", not "1 min ago".
    const again = await run('new', 'codex', 'pong', '--name', 'pong', '--', 'Reply with pong')
    expect(again.out + again.err).toContain('you started it just now')
    const row = async () => ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents).find((a) => a.name === 'pong')
    const live = await until('pong running', async () => { const r = await row(); return r?.status === 'active' && r.tmuxPane ? r : null }, 60_000, 250)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const closed = await run('close', 'pong', '--now')
    expect(closed.err).not.toMatch(/descriptor|identity is held/)
    expect(closed.code, closed.out + closed.err).toBe(0)
    expect(closed.out.trim()).toMatch(said)
    const stopped = await until('pong stopped', async () => { const r = await row(); return !r || r.status === 'stopped' ? r ?? {} : null }, 30_000, 250)
    if (unboundMs < 10_000) expect(stopped.sessionId).toBeTruthy()
    expect(await enginesIn(d, String(live.tmuxPane))).toBe('')
    // It closed it itself: `wait` says so, and is not a failure.
    const waited = await run('wait', 'pong', '--timeout', '30s')
    expect(waited.out.trim()).toBe('pong: closed (you closed it)')
    expect(waited.code, waited.out + waited.err).toBe(0)
    client.close()
  }, 180_000)

  it('an agent that uses MCP does the same through harness mcp', async () => {
    const { d } = await signedIn({ agents_start_agents: true })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const personDir = join(d.projectsDir, 'person')
    mkdirSync(personDir, { recursive: true })
    const theirs = await client.request('agent_create', { engine: 'claude', cwd: personDir, bypassPermission: true, name: 'theirs' }, 90_000)
    expect(theirs.error, JSON.stringify(theirs)).toBeUndefined()
    // An editor's agent: nothing in its environment says whose session it is, so the server does.
    const server = mcp(d)
    const hello = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } })
    expect(hello.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'harness' } })
    expect(hello.result.instructions).toContain('Never give work to, or close, a harness you did not start')
    server.notify('notifications/initialized')
    const tools = (await server.request('tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(tools).toEqual(['harness_whoami', 'harness_list', 'harness_search', 'harness_machines', 'harness_start', 'harness_wait', 'harness_read', 'harness_close'])

    // An empty folder of its own: refused, with the project it can ask for instead.
    const scratch = join(d.root, 'tmp', 'mcp-scratch')
    mkdirSync(scratch, { recursive: true })
    const scratchRefused = await server.call('harness_start', { task: 'hello from mcp', folder: scratch, name: 'mcpkid' })
    expect(scratchRefused).toEqual({ isError: true, text: `Claude Code would ask the person to trust ${scratch} before it starts, and it is empty: `
      + 'for scratch or new work give a project name instead — harness_start (project: "mcpkid", …)  (Harness makes ~/harnesses/mcpkid, '
      + 'which needs no approval). Nothing was started.' })
    const started = await server.call('harness_start', { task: 'hello from mcp', project: 'mcp-kid', name: 'mcpkid' })
    expect(started.isError, started.text).toBe(false)
    expect(started.text).toContain(`mcpkid on this computer: starting. Claude Code, in ${join(d.env.HOME!, 'harnesses', 'mcp-kid')}.`)
    // Its next steps are named as the tools: an MCP client may have no shell to run `harness show` in.
    expect(started.text).toContain('Next: harness_wait (names: "mcpkid")  (until it has answered; then read it: harness_read (name: "mcpkid"))')
    // Started lines: a create the machine answers pending first also writes a pending one (agentClient/ledger.ts).
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.child)
    expect(ledger).toEqual([expect.objectContaining({ by: expect.objectContaining({ agentId: expect.stringMatching(/^agent:cursor:mcp-\d+$/), name: 'Cursor' }) })])
    const waited = await server.call('harness_wait', { names: ['mcpkid'], timeout_seconds: 120 })
    expect(waited).toEqual({ text: 'mcpkid: idle · read it: harness_read (name: "mcpkid")', isError: false })
    const read = await server.call('harness_read', { name: 'mcpkid' })
    expect(read.text).toContain('asked: [from Cursor outside Harness · ')
    expect(read.text).toContain('hello from mcp')
    const listed = await server.call('harness_list', {})
    expect(listed.text.split('\n')[0]).toMatch(/^You: Cursor, outside Harness, on .+\. Nothing can message you here\.$/)
    expect(listed.text).toMatch(/\nmcpkid +Claude Code +\w+ +you /)
    const refused = await server.call('harness_close', { name: 'theirs' })
    // A refusal is an answer, not an error to retry.
    expect(refused).toEqual({ text: 'You did not start theirs, so you may not close it. Only the person can.', isError: false })
    const closed = await server.call('harness_close', { name: 'mcpkid' })
    expect(closed.isError).toBe(false)
    expect(closed.text).toMatch(/^mcpkid on .+: closed\. Its conversation is kept; the person can resume it\.\nNext: nothing; you have 0 open of 4\.$/)
    server.close()
    client.close()
  })

  it('once Harness runs, Claude Code and Codex here run its commands and MCP tools without asking, the person\'s own rules kept', async () => {
    // Owner, 2026-10-12: "no asking. just do. the best ux." Codex asked before every verb (its sandbox cannot reach
    // the daemon), about four times a hand-off. The daemon writes the rules into the person's own settings at start
    // (docs/design/2026-10-11-agent-client.md, No permission prompts); what an agent may do stays Harness's to decide.
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const settings = join(d.env.HOME!, '.claude', 'settings.json'), rules = join(d.env.CODEX_HOME!, 'rules', 'harness.rules')
    mkdirSync(join(d.env.HOME!, '.claude'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(harness close:*)'] } }))
    await d.start()
    await until('Harness to allow its commands in Claude Code and Codex', () => existsSync(rules)
      && readFileSync(settings, 'utf8').includes('mcp__plugin_harness_harness__harness_send'), 30_000)
    const tools = { whoami: 'harness_whoami', ps: 'harness_list', search: 'harness_search', machines: 'harness_machines', show: 'harness_read', wait: 'harness_wait', new: 'harness_start', close: 'harness_close', send: 'harness_send' }
    const verbs = Object.keys(tools) as Array<keyof typeof tools>, launcher = join(d.env.HOME!, '.local', 'bin', 'harness')
    // The person's deny of `harness close` is theirs: no allow for it in either spelling (Claude Code does not count the
    // launcher's path as the same command). Its MCP tool is another tool, and is allowed by name. `harness --help`,
    // which every harness reads as it starts, comes first: it names no verb (#1239, which left this list as it was,
    // so this test failed on main from then on).
    expect(JSON.parse(readFileSync(settings, 'utf8')).permissions).toEqual({
      allow: ['Bash(npm test:*)', 'Bash(harness --help)', 'Bash(harness -h)', `Bash(${launcher} --help)`, ...verbs.flatMap((verb) => [
        ...(verb === 'close' ? [] : [`Bash(harness ${verb}:*)`, `Bash(${launcher} ${verb}:*)`]),
        `mcp__harness__${tools[verb]}`, `mcp__plugin_harness_harness__${tools[verb]}`,
      ])],
      deny: ['Bash(harness close:*)'],
    })
    // Codex: each verb runs outside the sandbox on its first try, by name or by the launcher's path (which Codex reads
    // as `harness` only for that path); a file Harness owns.
    const list = JSON.stringify(verbs).replace(/,/g, ', ')
    const written = readFileSync(rules, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'))
    expect(written).toHaveLength(3)
    expect(written[0]).toBe(`host_executable(name="harness", paths=[${JSON.stringify(launcher)}])`)
    expect(written[1]).toBe(`prefix_rule(pattern=["harness", ${list}], decision="allow")`)
    expect(written[2]).toMatch(new RegExp(`^prefix_rule\\(pattern=\\["[^"]+", "[^"]+/cli\\.js", ${list.replace(/[[\]]/g, '\\$&')}\\], decision="allow"\\)$`))
    expect(statSync(rules).mode & 0o777).toBe(0o600)
  })

  it('an agent is told, not left waiting, when Claude Code or Codex would ask the person to trust its folder', async () => {
    // A Codex harness asked for a second opinion from Claude Code made `mktemp -d /tmp/shell-opinion.XXXX` and started
    // Claude Code there, which stopped on its trust question: the agent could only report that it was waiting (a clean
    // VM, CLI 0.3.75, 2026-10-11). The fake engines ask as the real ones do, of a folder their settings do not trust.
    // Both engines have run here before: their settings exist, which is when Harness adds the folders it makes.
    const { d } = await signedIn({ agents_start_agents: true }, { trustPrompt: true, before: (d) => {
      writeFileSync(join(d.env.HOME!, '.claude.json'), '{}')
      appendFileSync(join(d.env.CODEX_HOME!, 'config.toml'), '')
    } })
    // Codex in a terminal app: no pane, the session its shell names.
    const run = (...args: string[]) => harness(d, '', args, { CODEX_THREAD_ID: 'lead-thread' })

    // An empty folder of its own: refused before anything starts, with what to run instead.
    const scratch = join(d.root, 'tmp', 'shell-opinion.e0ynGN')
    mkdirSync(scratch, { recursive: true })
    const refused = await run('new', 'claude', scratch, '--name', 'opinion', '--', 'a second opinion on the shell script')
    expect(refused.code, refused.out).toBe(1)
    expect(refused.err.trim()).toBe(`Claude Code would ask the person to trust ${scratch} before it starts, and it is empty: for scratch or new work `
      + 'give a project name instead — harness new claude opinion --name opinion -- …  (Harness makes ~/harnesses/opinion, which needs no '
      + 'approval). Nothing was started.')
    expect(JSON.parse((await run('ps', '--json')).out).harnesses).toEqual([])

    // The project it names instead: Harness makes it, answers the question for it, and the work is done with nobody asked.
    const started = await run('new', 'claude', 'opinion', '--name', 'opinion', '--', 'a second opinion on the shell script')
    expect(started.code, started.out + started.err).toBe(0)
    expect(started.out).toContain(`opinion on this computer: starting. Claude Code, in ${join(d.env.HOME!, 'harnesses', 'opinion')}.`)
    expect(started.out).not.toContain('trust')
    const waited = await run('wait', 'opinion', '--timeout', '2m')
    expect(waited.out.trim(), waited.err).toBe('opinion: idle · read it: harness show opinion')
    expect((await run('show', 'opinion')).out).toContain('a second opinion on the shell script')

    // A folder with something in it may be just what the work needs: it starts, and the agent is told it waits for the person.
    const work = join(d.root, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'README.md'), 'the person\'s work\n')
    const asked = await run('new', 'codex', work, '--name', 'checker', '--', 'check the readme')
    expect(asked.code, asked.out + asked.err).toBe(0)
    expect(asked.out).toContain(`Codex will ask the person to trust ${work} before it starts, so it waits for them until they answer `
      + '(harness wait exits 3). For new work, a project name avoids this: harness new codex checker --name checker -- …')
    const held = await run('wait', 'checker', '--timeout', '2m')
    expect(held.code, held.out + held.err).toBe(3)
    expect(held.out.trim()).toMatch(/^checker: needs the person · /)
    expect((await run('close', 'opinion')).code).toBe(0)
  })

  it('an agent may not start a harness until the account turns that on, and is told how; the person turns it on from a terminal', async () => {
    // Every switch off by default (owner, 2026-10-12): signed in, with an account that never turned any on.
    const { relay, d } = await signedIn({})
    expect(await kept(d)).toMatchObject({ agentsStartAgents: false, pullRequestLine: false, agentMessages: false })
    // Claude Code in a terminal app, refused with where the person turns it on.
    const asAgent = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'held-session' }
    const refused = await harness(d, '', ['new', 'claude', 'held', '--name', 'held', '--', 'hello'], asAgent)
    expect(refused.code, refused.out).toBe(5)
    expect(refused.err.trim()).toBe('Agents may not start harnesses: the person turns on "Agents can start other agents" in Harness Settings ▸ Experimental, or runs `harness settings agents-start-agents on`. Until then, do the work yourself.')
    expect(JSON.parse((await harness(d, '', ['ps', '--json'])).out).harnesses).toEqual([])
    // The person, at a terminal: written through this computer's daemon to the account, and kept here at once.
    const on = await harness(d, '', ['settings', 'agents-start-agents', 'on'])
    expect(on.code, on.err).toBe(0)
    expect(on.out.trim()).toBe('agents-start-agents is on for your account.')
    expect(relay.experiments).toEqual({ agents_start_agents: true })
    expect((await harness(d, '', ['settings'])).out).toMatch(/^agents-start-agents +on /m)
    const started = await harness(d, '', ['new', 'claude', 'held', '--name', 'held', '--', 'hello'], asAgent)
    expect(started.code, started.out + started.err).toBe(0)
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const held = await until('held to be up', async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'held')
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    client.close()
    // Its pull request line is the account's other switch, still off: none.
    expect(await commandsIn(d, String(held.tmuxPane))).not.toContain('--settings')
    // Turned off on another computer: this one hears desk_changed, and refuses again.
    relay.setExperiment('agents_start_agents', false)
    await kept(d, (settings) => settings.agentsStartAgents === false)
    const again = await harness(d, '', ['new', 'claude', 'again', '--name', 'again', '--', 'hello'], asAgent)
    expect(again.code, again.out).toBe(5)
    expect(again.err).toContain('Settings ▸ Experimental')
  })

  it('keeps delegation instructions without PR attribution, even with an older account setting', async () => {
    const { d } = await signedIn({ agents_start_agents: true, agent_pull_request_line: true })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const live = (name: string) => until(`${name} to be up`, async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === name)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    const folder = (name: string) => { const dir = join(d.projectsDir, name); mkdirSync(dir, { recursive: true }); return dir }

    // The person's own harness: no line.
    const made = await client.request('agent_create', { engine: 'claude', cwd: folder('lead'), bypassPermission: true, name: 'lead' }, 90_000)
    expect(made.error, JSON.stringify(made)).toBeUndefined()
    const lead = await live('lead')
    expect(await commandsIn(d, String(lead.tmuxPane))).not.toContain('--settings')
    // Every harness is told how to use Harness while the account lets agents start agents, the person's too.
    expect(await commandsIn(d, String(lead.tmuxPane))).toContain(`--append-system-prompt ${HARNESS_INSTRUCTIONS}`)
    const run = (...args: string[]) => harness(d, String(lead.tmuxPane), args)

    // An older account switch must not add attribution to a new Claude harness.
    expect((await run('new', 'claude', 'kid', '--name', 'kid', '--', 'hello kid')).code).toBe(0)
    const kid = await live('kid')
    const kidCommand = await commandsIn(d, String(kid.tmuxPane))
    expect(kidCommand).toContain(HARNESS_INSTRUCTIONS)
    expect(kidCommand).not.toContain('--settings')

    // Codex receives delegation instructions, without an instruction to mark PRs.
    expect((await run('new', 'codex', 'kidx', '--name', 'kidx', '--', 'hello kidx')).code).toBe(0)
    const kidx = await live('kidx')
    const codexCommand = await commandsIn(d, String(kidx.tmuxPane))
    expect(codexCommand).toContain(HARNESS_INSTRUCTIONS)
    expect(codexCommand).not.toContain('When you create or update a pull request')
    expect(codexCommand).not.toContain('Started by another agent')

    // Restarting a saved harness does not restore the removed attribution.
    const restarted = await client.request('agent_restart', { agentId: kid.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    await until('kid to come back with delegation instructions', async () => {
      const row = await live('kid')
      const command = row.tmuxPane ? await commandsIn(d, String(row.tmuxPane)) : ''
      if (!command.includes(HARNESS_INSTRUCTIONS)) return null
      expect(command).not.toContain('--settings')
      return row
    }, 60_000, 500)

    // Turned off by the person: the next one an agent starts has no line.
    const off = await harness(d, '', ['settings', 'pull-request-line', 'off'])
    expect(off.code, off.err).toBe(0)
    expect(off.out.trim()).toBe('pull-request-line is off for your account.')
    expect((await run('new', 'claude', 'quiet', '--name', 'quiet', '--', 'hello quiet')).code).toBe(0)
    const quiet = await live('quiet')
    const command = await commandsIn(d, String(quiet.tmuxPane))
    expect(command).toContain('hello quiet')
    expect(command).not.toContain('--settings')

    // Agents starting agents turned off: a harness is no longer told how.
    expect((await harness(d, '', ['settings', 'agents-start-agents', 'off'])).code).toBe(0)
    const alone = await client.request('agent_create', { engine: 'claude', cwd: folder('alone'), bypassPermission: true, name: 'alone' }, 90_000)
    expect(alone.error, JSON.stringify(alone)).toBeUndefined()
    const aloneRow = await live('alone')
    expect(await commandsIn(d, String(aloneRow.tmuxPane))).not.toContain('You are running in Harness')
    client.close()
  })
})

/** The fake engines still running in [pane]'s process tree, or '' once none is: a pane closed with them has no tree. */
async function enginesIn(d: IsolatedDaemon, pane: string): Promise<string> {
  const panes = await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')
  if (!panes.split('\n').includes(pane)) return ''
  return (await commandsIn(d, pane)).split('\n').filter((line) => /^(?:codex|claude)\s/.test(line)).join('\n')
}

/** The command lines of the processes in [pane], as `ps` prints them: the engine's carries the arguments it was launched
 *  with (the fake engines' process title is their engine's name, then their arguments, as a CLI's is). */
async function commandsIn(d: IsolatedDaemon, pane: string): Promise<string> {
  const panes = (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')).split('\n').map((line) => line.split(' '))
  const root = Number(panes.find(([id]) => id === pane)?.[1])
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
  const tree = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const [, pid, ppid] of table) if (tree.has(Number(ppid)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true }
  }
  return table.filter(([, pid]) => tree.has(Number(pid))).map(([, , , command]) => command).join('\n')
}
