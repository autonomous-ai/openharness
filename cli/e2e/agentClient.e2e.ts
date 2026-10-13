/**
 * Harness for agents on the real daemon (docs/design/2026-10-11-agent-client.md): an agent, from its own pane, runs
 * the `harness` verbs as it would through its shell tool. It lists the harnesses, starts one with a task, waits for
 * it, reads its answer, messages it without any tab having Agent Messages on, and closes it; it may not close one it
 * did not start. The fake engines answer by echoing (harness/fakeEngine.mjs).
 *
 * Signed in to the fake backend, which answers the account's tabs: none has Agent Messages on.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

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

describe('Harness for agents, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  it('an agent sees, starts, waits for, reads, messages and closes a harness of its own', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }], tabs: [] }
    const d = await IsolatedDaemon.create({ env: {
      BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    signIn(d)
    await d.start()
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
    expect(ps.out).toMatch(/^You are "lead" \(/)
    expect(ps.out).toMatch(/\nlead +Claude Code +\w+ +person \(you\)/)

    // It starts a harness with a task, which reads who sent it.
    const kidDir = join(d.projectsDir, 'kid')
    mkdirSync(kidDir, { recursive: true })
    const started = await run('new', 'claude', kidDir, '--name', 'kid', '--', 'hello kid')
    expect(started.code, started.err).toBe(0)
    expect(started.out).toContain('Created kid on this computer')
    expect(started.out).toContain('Read it: harness show kid · wait for it: harness wait kid')
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(ledger).toEqual([expect.objectContaining({ depth: 1, by: expect.objectContaining({ agentId: lead.id, name: 'lead' }), child: expect.objectContaining({ name: 'kid' }) })])

    // It waits for it, then reads its answer.
    const waited = await run('wait', 'kid', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    expect(waited.out.trim()).toBe('kid: idle · read it: harness show kid')
    const shown = await run('show', 'kid')
    expect(shown.code, shown.err).toBe(0)
    expect(shown.out).toContain('kid · Claude Code · ')
    expect(shown.out).toContain('· idle · started by you')
    expect(shown.out).toContain('asked: [from lead · Claude Code · ')
    expect(shown.out).toContain('the harness that started you. It reads your answer itself; to ask it something while you work: harness send lead "…"]')
    expect(shown.out).toContain('hello kid')
    expect((await run('ps')).out).toMatch(/\nkid +Claude Code +\w+ +you /)

    // No tab has Agent Messages on, and still the two message each other.
    const sent = await run('send', 'kid', 'Also check the footer.')
    expect(sent.code, sent.out + sent.err).toBe(0)
    expect(sent.out).toMatch(/→ kid: (queued|delivered)/)
    const kid = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'kid')!
    const back = await harness(d, String(kid.tmuxPane), ['send', 'lead', 'Footer checked.'])
    expect(back.code, back.out + back.err).toBe(0)

    // It closes what it started, and only that; the harness it started may not close it.
    const own = await run('close', 'lead')
    expect(own.code).toBe(1)
    expect(own.err).toContain('That is your own harness.')
    const fromKid = await harness(d, String(kid.tmuxPane), ['close', 'lead'])
    expect(fromKid.code, fromKid.out).toBe(1)
    expect(fromKid.err).toContain('You did not start lead')
    await run('wait', 'kid', '--timeout', '2m')
    const closed = await run('close', 'kid')
    expect(closed.code, closed.err).toBe(0)
    expect(closed.out.trim()).toBe('Closed kid. Its conversation is kept.')
    const after = await run('ps', '--all', '--json')
    expect(JSON.parse(after.out).harnesses).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'kid', state: 'stopped', startedBy: 'you' })]))
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
  })

  it('an agent outside Harness starts, reads and closes a harness of its own, and may not close the person\'s', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const personDir = join(d.projectsDir, 'person')
    mkdirSync(personDir, { recursive: true })
    const theirs = await client.request('agent_create', { engine: 'claude', cwd: personDir, bypassPermission: true, name: 'theirs' }, 90_000)
    expect(theirs.error, JSON.stringify(theirs)).toBeUndefined()
    // Claude Code in a terminal app: no pane, and the session its shell names.
    const run = (...args: string[]) => harness(d, '', args, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outside-session' })

    const ps = await run('ps')
    expect(ps.code, ps.err).toBe(0)
    expect(ps.out.split('\n')[0]).toBe('You are Claude Code, outside Harness.')
    const dir = join(d.projectsDir, 'helper')
    mkdirSync(dir, { recursive: true })
    const started = await run('new', 'claude', dir, '--name', 'helper', '--', 'check it')
    expect(started.code, started.out + started.err).toBe(0)
    // Nothing can message an agent with no pane: no `send` in what to do next.
    expect(started.out).toContain('Read it: harness show helper · wait for it: harness wait helper')
    expect(started.out).not.toContain('harness send')
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(ledger).toEqual([expect.objectContaining({ depth: 1, by: expect.objectContaining({ agentId: 'claude-code:outside-session', name: 'Claude Code' }), child: expect.objectContaining({ name: 'helper' }) })])

    const waited = await run('wait', 'helper', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    const shown = await run('show', 'helper')
    expect(shown.out).toContain('asked: [from Claude Code outside Harness · ')
    expect(shown.out).toContain('the agent that started you. It reads your answer itself.]')
    expect(shown.out).toContain('check it')

    const person = await run('close', 'theirs')
    expect(person.code).toBe(1)
    expect(person.err).toContain('You did not start theirs')
    // Another session of the same agent did not start it either.
    const other = await harness(d, '', ['close', 'helper'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'another-session' })
    expect(other.code).toBe(1)
    const closed = await run('close', 'helper')
    expect(closed.code, closed.err).toBe(0)
    client.close()
  })

  it('an agent that uses MCP does the same through harness mcp', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
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
    expect(tools).toEqual(['harness_list', 'harness_start', 'harness_wait', 'harness_read', 'harness_close'])

    const dir = join(d.projectsDir, 'mcp-kid')
    mkdirSync(dir, { recursive: true })
    const started = await server.call('harness_start', { task: 'hello from mcp', folder: dir, name: 'mcpkid' })
    expect(started.isError, started.text).toBe(false)
    expect(started.text).toContain('Created mcpkid on this computer')
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(ledger).toEqual([expect.objectContaining({ by: expect.objectContaining({ agentId: expect.stringMatching(/^agent:cursor:mcp-\d+$/), name: 'Cursor' }) })])
    const waited = await server.call('harness_wait', { names: ['mcpkid'], timeout_seconds: 120 })
    expect(waited).toEqual({ text: 'mcpkid: idle · read it: harness show mcpkid', isError: false })
    const read = await server.call('harness_read', { name: 'mcpkid' })
    expect(read.text).toContain('asked: [from Cursor outside Harness · ')
    expect(read.text).toContain('hello from mcp')
    const listed = await server.call('harness_list', {})
    expect(listed.text.split('\n')[0]).toBe('You are Cursor, outside Harness.')
    expect(listed.text).toMatch(/\nmcpkid +Claude Code +\w+ +you /)
    const refused = await server.call('harness_close', { name: 'theirs' })
    expect(refused).toEqual({ text: 'You did not start theirs, so you may not close it. Only the person can.', isError: true })
    const closed = await server.call('harness_close', { name: 'mcpkid' })
    expect(closed).toEqual({ text: 'Closed mcpkid. Its conversation is kept.', isError: false })
    server.close()
    client.close()
  })

  it('an agent may not start a harness once the person turns that off', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const dir = join(d.projectsDir, 'held')
    mkdirSync(dir, { recursive: true })
    // The person, at a terminal; then Claude Code in a terminal app.
    const off = await harness(d, '', ['settings', 'agents-start-agents', 'off'])
    expect(off.out.trim()).toBe('agents-start-agents is off.')
    const refused = await harness(d, '', ['new', 'claude', dir, '--name', 'held', '--', 'hello'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'held-session' })
    expect(refused.code, refused.out).toBe(1)
    expect(refused.err).toContain('The person has turned off agents starting harnesses on this computer')
    const listed = await harness(d, '', ['ps', '--json'])
    expect(JSON.parse(listed.out).harnesses).toEqual([])
    // The setting is the daemon's, as the window reads it.
    const read = await fetch(`http://127.0.0.1:${d.port}/api/agent-settings`)
    expect(await read.json()).toEqual({ agentsStartAgents: false })
  })
})
