/**
 * The other engines' worker (`engine-others`, engines/others/): a Pi conversation followed live and its history and last
 * turn read in its process, on demand, never in the core's; the worker killed or frozen while the agent works on, its
 * reads answered at once as unavailable, the core saying so and holding the conversation where it took it, and the turn
 * typed meanwhile arriving once, after the master has the worker back. Explicit inline mode runs them in the core.
 *
 * Pi is a fake of its own here, as eagerRepair.e2e.ts makes one: it takes its preallocated id from its process title,
 * keeps its conversation where Pi does (`PI_HOME/agent/sessions/--<cwd>--/<date>_<id>.jsonl`), writes a turn for each
 * line typed into its pane, and is announced the way Pi's own extension announces it (engines/pi/contract.ts).
 */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'

const PI_ID = 'aaaaaaaa-2222-4333-8444-555555555555'
/** The conversation a Pi in a folder of this name keeps: each its own. */
const PI_IDS: Record<string, string> = { 'pi-one': PI_ID, ...Object.fromEntries([0, 1, 2, 3].map(i => [`pi-${i}`, `bbbbbbb${i}-2222-4333-8444-555555555555`])) }
type Row = { id: string; sessionId?: string | null; status?: string; tmuxPane?: string }

describe('the other engines\' worker', () => {
  let daemon: IsolatedDaemon | undefined
  let client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

  async function fresh(env: Record<string, string> = {}) {
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    onTestFailed(() => console.log(d.log()))
    d.env.PI_HOME = join(d.root, 'pi')
    const bin = join(d.root, 'bin', 'pi')
    d.env.PI_PATH = bin
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('1.0.0'); process.exit(0) }
const cwd = process.cwd(), id = (${JSON.stringify(PI_IDS)})[path.basename(cwd)];
process.title = ('pi --session-id ' + id).padEnd(160);
const folder = '--' + cwd.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--';
const file = path.join(process.env.PI_HOME, 'agent', 'sessions', folder, '2026-11-15_' + id + '.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd }) + '\\n');
fs.writeFileSync(path.join(${JSON.stringify(d.root)}, 'pi-' + path.basename(cwd) + '.json'), JSON.stringify({ pid: process.pid, file }));
let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', (text) => {
  if (!text.trim()) return;
  turn++;
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'u' + turn, parentId: null, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'a' + turn, parentId: 'u' + turn, message: { role: 'assistant', content: [{ type: 'text', text: 'pi says ' + text }], stopReason: 'stop', model: 'fake/pi' } }) + '\\n');
  console.log('pi says ' + text);
});
console.log('fixture-pi-ready'); setInterval(() => {}, 1000);
`, { mode: 0o755 })
    await d.start()
    const c = client = await LocalClient.connect(d)
    return { d, c }
  }

  const worker = (d: IsolatedDaemon) => harnessdProcesses(d).get('engine-others')
  const linked = (d: IsolatedDaemon) => d.log().split('[services] engine-others connected').length - 1
  const rows = async (c: LocalClient) => (await c.request('agents_list', {})).agents as Row[]
  const history = (c: LocalClient, agentId: string) => c.request('session_get', { sessionId: agentId, limit: 10 }, 30_000)

  /** A Pi agent, bound to its preallocated id and announced with its conversation, which already holds `first`. */
  async function pi(d: IsolatedDaemon, c: LocalClient, first: string, folder = 'pi-one') {
    const sessionId = PI_IDS[folder]
    const cwd = join(d.projectsDir, folder); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine: 'pi', cwd }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id = created.agent.id as string
    const row = await until('Pi bound to its preallocated id', async () => (await rows(c)).find(r => r.id === id && r.sessionId === sessionId && r.status === 'active') ?? null, 30_000, 100)
    const pane = String(row.tmuxPane ?? created.agent.terminal?.runtimes?.[0]?.paneId)
    await until('the fake Pi in its pane', async () => (await d.capture(pane)).includes('fixture-pi-ready') || null, 15_000, 100)
    await type(d, pane, first)
    const fake = JSON.parse(readFileSync(join(d.root, `pi-${folder}.json`), 'utf8')) as { pid: number; file: string }
    await until('the first turn on disk', () => readFileSync(fake.file, 'utf8').includes(`pi says ${first}`) || null, 15_000, 100)
    // As Pi's extension does once its first reply is written (engines/pi/contract.ts PI_EXTENSION).
    const hook = await fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
      body: JSON.stringify({ engine: 'pi', sessionId, transcriptPath: fake.file, cwd, tmuxPane: pane, callerPid: fake.pid,
        runtimeHints: [{ backend: 'tmux', paneId: pane }] }) })
    expect(hook.status).toBe(200)
    await until('the conversation on its row', () => readFileSync(join(d.dataDir, 'registry.json'), 'utf8').includes(fake.file) || null, 15_000, 100)
    // A line typed before the tail starts is read as the file's history, not as a live turn.
    await until('the core following the conversation', () => d.log().includes(`[watcher] tail pi ${sessionId.slice(0, 8)}`) || null, 15_000, 100)
    return { id, pane, fake }
  }
  const type = async (d: IsolatedDaemon, pane: string, text: string) => {
    await d.tmux.run('send-keys', '-t', pane, '-l', text)
    await d.tmux.run('send-keys', '-t', pane, 'Enter')
  }
  /** A line typed into Pi's pane, and the turn the core follows live from its transcript. */
  const live = async (d: IsolatedDaemon, c: LocalClient, agent: { id: string; pane: string }, text: string) => {
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id && !frame.replay, 30_000, `turn ${text}`)
    await type(d, agent.pane, text)
    await ended
  }
  const said = (reply: Record<string, any>, text: string) => JSON.stringify(reply.events ?? []).includes(`pi says ${text}`)

  it('starts no worker for an empty core, reads a Pi conversation and its last turn in it, and keeps its requests off the client router', async () => {
    const { d, c } = await fresh()
    expect(worker(d)).toBeUndefined()
    for (const type of ['engine_history_page', 'engine_last_turn', 'engine_reader_part']) {
      const answer = await c.request(type, { version: 1, session: { engine: 'pi', sessionId: PI_ID, transcriptPath: '/etc/passwd', touchedAt: 0 } })
      expect(answer.error).toBe('UNSUPPORTED')
    }
    const agent = await pi(d, c, 'other-cold')
    // Its live conversation is followed in the worker, which its attach started: no read was needed for it.
    await until('the worker following the conversation', () => worker(d) ?? null, 15_000, 100)
    // A read is answered by the worker the attach started: one request, answered.
    const first = await history(c, agent.id)
    expect(first.error, JSON.stringify(first)).toBeUndefined()
    expect(said(first, 'other-cold')).toBe(true)
    const pid = worker(d)!
    expect(alive(pid)).toBe(true)
    expect(d.log()).toContain('[services] engine-others connected')
    // The recap of a live turn reads its last turn in the worker too (core/transcripts/lastTurn.ts).
    const recap = c.next(frame => frame.type === 'turn_summary' && frame.agentId === agent.id && JSON.stringify(frame.payload).includes('pi says other-recap'), 30_000, 'the recap of a live turn')
    await live(d, c, agent, 'other-recap')
    await recap
    const second = await history(c, agent.id)
    expect(second.error, JSON.stringify(second)).toBeUndefined()
    expect(said(second, 'other-recap')).toBe(true)
    // A whole conversation past one frame of the worker's link comes back whole, in parts (engines/others/readerRequests.ts).
    const words = 'x'.repeat(20_000)
    let text = ''
    for (let turn = 0; turn < 300; turn++) {
      text += JSON.stringify({ type: 'message', id: `lu${turn}`, parentId: null, message: { role: 'user', content: [{ type: 'text', text: `long ${turn}` }] } }) + '\n'
      text += JSON.stringify({ type: 'message', id: `la${turn}`, parentId: `lu${turn}`, message: { role: 'assistant', content: [{ type: 'text', text: `pi says ${turn} ${words}` }], stopReason: 'stop' } }) + '\n'
    }
    appendFileSync(agent.fake.file, text)
    const whole = await c.request('session_get', { sessionId: agent.id }, 60_000)
    expect(whole.error, JSON.stringify(whole).slice(0, 300)).toBeUndefined()
    expect(JSON.stringify(whole.events).length).toBeGreaterThan(5 * 1024 * 1024)
    expect(said(whole, `299 ${words}`)).toBe(true)
    expect(worker(d)).toBe(pid)
    expect(d.coresStarted()).toBe(1)
  })

  it('reads them in the core, with no worker, in explicit inline mode', async () => {
    const { d, c } = await fresh({ HARNESSD_SERVICES: 'none' })
    const agent = await pi(d, c, 'other-inline')
    const reply = await until('the history read inline', async () => { const reply = await history(c, agent.id); return said(reply, 'other-inline') ? reply : null }, 30_000, 250)
    expect(reply.error, JSON.stringify(reply)).toBeUndefined()
    await live(d, c, agent, 'other-inline-live')
    expect(worker(d)).toBeUndefined()
    expect(d.log()).not.toContain('[services] engine-others connected')
    expect(d.coresStarted()).toBe(1)
  })

  it('answers at once while the worker is killed or frozen, the agent working on, and reads again once it is back', async () => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
    const agent = await pi(d, c, 'before-the-faults')
    await until('a first read through the worker', async () => said(await history(c, agent.id), 'before-the-faults') || null, 30_000, 250)
    const core = d.corePid()
    const panePid = (await d.tmux.run('display-message', '-p', '-t', agent.pane, '#{pane_pid}')).trim()
    for (const signal of ['SIGKILL', 'SIGSTOP'] as const) {
      const before = worker(d)!
      const connections = linked(d)
      process.kill(before, signal)
      const at = Date.now()
      const pending = history(c, agent.id)
      // The pane goes on while the worker is down; the core holds the conversation where it took it, and the turn typed
      // meanwhile arrives once the worker is back, from that byte, live and once.
      await live(d, c, agent, `during-${signal}`)
      const starts = c.frames.filter((frame) => frame.type === 'turn_started' && frame.agentId === agent.id
        && JSON.stringify(frame.payload ?? {}).includes(`during-${signal}`))
      expect(starts).toHaveLength(1)
      expect(d.log()).toContain("the other engines' worker is gone · 1 conversation(s) held")
      const answer = await pending
      if (answer.error) {
        expect(['ENGINE_UNAVAILABLE', 'ENGINE_STALE_REPLY']).toContain(answer.error)
        expect(answer.retryable).toBe(true)
      }
      expect(Date.now() - at).toBeLessThan(15_000)
      await until('the worker back', () => linked(d) > connections && worker(d) !== before || null, 30_000, 100)
      expect(d.log()).toContain("the other engines' worker is back · following 1 conversation(s) again")
      const recovered = await until('a read once it is back', async () => { const reply = await history(c, agent.id); return said(reply, `during-${signal}`) ? reply : null }, 30_000, 250)
      expect(recovered.error, JSON.stringify(recovered)).toBeUndefined()
      if (signal === 'SIGSTOP') {
        expect(d.log()).toContain('service engine-others sent no heartbeat')
        try { process.kill(before, 'SIGCONT') } catch { /* killed by its master */ }
      }
    }
    expect(alive(agent.fake.pid)).toBe(true)
    expect((await d.tmux.run('display-message', '-p', '-t', agent.pane, '#{pane_pid}')).trim()).toBe(panePid)
    expect((await rows(c)).find(r => r.id === agent.id)).toMatchObject({ sessionId: PI_ID, status: 'active' })
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  // The numbers a change to how the core follows or reads these engines shows, before and after, on this one workload:
  // OTHER_ENGINES_PERF=<report.json> E2E_BUNDLE=1. Four Pi conversations of 500 turns each, attached again as a core starts; the
  // core's CPU at rest with them; and 400 history reads, their latency and the core's CPU over them.
  it.runIf(!!process.env.OTHER_ENGINES_PERF)('measures attach, the core at rest and history reads', async () => {
    const { d, c } = await fresh()
    const TURNS = 500
    const agents = []
    for (let i = 0; i < 4; i++) agents.push(await pi(d, c, `warm-${i}`, `pi-${i}`))
    for (const agent of agents) {
      let text = ''
      for (let turn = 0; turn < TURNS; turn++) {
        const words = `turn ${turn} of a long conversation, with enough words in it to look like one`
        text += JSON.stringify({ type: 'message', id: `pu${turn}`, parentId: null, message: { role: 'user', content: [{ type: 'text', text: words }] } }) + '\n'
        text += JSON.stringify({ type: 'message', id: `pa${turn}`, parentId: `pu${turn}`, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Thinking it over.' }, { type: 'text', text: `pi says ${words}` }], stopReason: 'stop', model: 'fake/pi' } }) + '\n'
      }
      appendFileSync(agent.fake.file, text)
    }
    await until('every conversation followed to its end', async () => {
      const read = await Promise.all(agents.map(agent => history(c, agent.id)))
      return read.every(reply => JSON.stringify(reply.events ?? []).includes(`turn ${TURNS - 1} of`)) || null
    }, 60_000, 500)
    client!.close()
    const from = d.log().length
    await d.restart()
    const c2 = client = await LocalClient.connect(d)
    const log = () => d.log().slice(from)
    const at = (line: string) => Date.parse(line.slice(0, 23).replace(' ', 'T'))
    await until('every conversation attached again', () => agents.every(agent => log().includes(`[agent] ${agent.id.slice(0, 8)} attached · engine=pi`)) || null, 60_000, 100)
    const lines = log().split('\n')
    const bound = at(lines.find(line => line.includes('[harnessd] core bound'))!)
    const attached = agents.map(agent => at(lines.find(line => line.includes(`[agent] ${agent.id.slice(0, 8)} attached · engine=pi`))!) - bound)
    const core = d.corePid()!
    const cpu = () => new Promise<number>((done, fail) => execFile('ps', ['-o', 'time=', '-p', String(core)], (error, out) =>
      error ? fail(error) : done(out.trim().split(':').reverse().reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0))))
    // At rest: nothing typed, nothing read, for half a minute.
    const restFrom = await cpu(), restAt = performance.now()
    await new Promise(done => setTimeout(done, 30_000))
    const rest = 100 * (await cpu() - restFrom) / ((performance.now() - restAt) / 1000)
    const readsFrom = await cpu()
    const latencies: number[] = []
    for (let round = 0; round < 100; round++) {
      for (const agent of agents) {
        const started = performance.now()
        const reply = await history(c2, agent.id)
        latencies.push(performance.now() - started)
        expect(reply.error, JSON.stringify(reply)).toBeUndefined()
      }
    }
    const readsCpu = await cpu() - readsFrom
    latencies.sort((a, b) => a - b)
    writeFileSync(process.env.OTHER_ENGINES_PERF!, JSON.stringify({ attachMs: attached, coreRestCpuPercent: Number(rest.toFixed(3)),
      historyMs: { p50: Number(latencies[199].toFixed(1)), p95: Number(latencies[379].toFixed(1)), max: Number(latencies[399].toFixed(1)) },
      coreCpuSecondsFor400Reads: Number(readsCpu.toFixed(2)), worker: harnessdProcesses(d).has('engine-others') }, null, 1) + '\n')
  }, 300_000)
})
